//! The host files behind the URL paths an external is spawned with
//! ([`PiHost::spawn`](super::PiHost)).
//!
//! An external has no view of the shell's virtual filesystem, so a
//! `scheme://` path handed to one means nothing there. File-backed schemes
//! (`skill://`, `local://`, `attachment://`, …) alias a real file and resolve
//! to it; rendered ones and schemes no provider serves alias nothing and keep
//! their spelling. So does anything the provider cannot resolve in an
//! argument or an environment value: a program is as often handed a URL as
//! an identifier or as part of a message (`bm read memory://notes/x`,
//! `log.sh 'agent://A; agent://B'`) as it is handed a path. Only a program
//! or working directory the provider rejects fails the spawn, since nothing
//! could run there. `omp` resolves the URLs it is given itself (with their
//! selectors: `omp read skill://x:1-20`), so the arguments it is given are
//! never rewritten; a wrapper's own arguments (`npx --cache local://dir omp
//! …`) still are.
//!
//! A spawn that names a URL is taken apart ([`split`]) into the [`Names`] to
//! resolve and the [`Rest`] it moves untouched; the provider is awaited
//! with only the names, so the future [`Host::spawn`](crate::bash::Host::spawn)
//! returns owns everything it needs and is `Send`.

use std::{
	io,
	path::{Path, PathBuf},
};

use bstr::{BStr, BString, ByteSlice};

use crate::bash::{
	ChildRedirs, CmdTag, EnvView, Lineage, OsHandle, PgroupSpec, Rlimit, SigSet, SpawnSpec,
	StdioSpec, Vpid,
};

/// What a spawn hands the OS in place of the URLs it names; before
/// [`resolve`], what the command wrote.
pub(super) struct Names {
	/// The program.
	pub path:  BString,
	/// The argument vector (`argv[0]` as written).
	pub argv:  Vec<BString>,
	/// The environment, `PWD` naming the host working directory.
	pub env:   EnvView,
	/// The working directory.
	pub cwd:   BString,
	/// Which arguments stay as written. Reused by [`resolve`].
	pub owned: Ownership,
}

/// The parts of a [`SpawnSpec`] URL resolution does not touch, owned.
pub(super) struct Rest {
	stdio:       [StdioSpec; 3],
	extra_fds:   Vec<(i32, StdioSpec)>,
	pgroup:      PgroupSpec,
	tag:         CmdTag,
	vpid:        Vpid,
	umask:       u32,
	sigmask_ign: SigSet,
	rlimits:     Vec<(Rlimit, Option<u64>, Option<u64>)>,
	lineage:     Lineage,
	redirs:      Option<ChildRedirs>,
	ctty:        Option<OsHandle>,
}

impl Rest {
	/// Hand `launch` the spawn with the (resolved) `names` in place of the
	/// ones it was split from. Synchronous: nothing of the spec outlives the
	/// call, so no borrow of it crosses an await.
	pub(super) fn launch<R>(self, names: &Names, launch: impl FnOnce(SpawnSpec<'_>) -> R) -> R {
		let Self {
			stdio,
			extra_fds,
			pgroup,
			tag,
			vpid,
			umask,
			sigmask_ign,
			rlimits,
			lineage,
			redirs,
			ctty,
		} = self;
		launch(SpawnSpec {
			path: names.path.as_bstr(),
			argv: &names.argv,
			env: &names.env,
			cwd: names.cwd.as_bstr(),
			stdio,
			extra_fds,
			pgroup,
			tag,
			vpid,
			umask,
			sigmask_ign,
			rlimits: &rlimits,
			lineage,
			redirs,
			ctty,
		})
	}
}

/// The spawn `spec` resolves before it runs, or `None` when it names no
/// URL its caller owes a file for. A URL `omp` resolves itself is left for
/// it, but a wrapper's own arguments (`npx --cache local://dir omp …`)
/// still resolve. Computed once and reused by [`resolve`].
pub(super) fn plan(spec: &SpawnSpec<'_>) -> Option<Plan> {
	// Nothing to ask the provider about: do not build flags or copy names.
	if !is_url(spec.path)
		&& !is_url(spec.cwd)
		&& !spec.argv.iter().skip(1).any(|arg| arg.contains_str("://"))
		&& !spec.env.iter().any(|(name, value)| env_url(name, value))
	{
		return None;
	}
	// `env -S` puts the words of its split string in the argument list.
	let expanded = expand_env_split(spec.path, spec.argv);
	let argv: &[BString] = match &expanded {
		Some((argv, _)) => argv,
		None => spec.argv,
	};
	let owned = ownership(spec.path, argv);
	let resolves = is_url(spec.path)
		|| is_url(spec.cwd)
		|| argv
			.iter()
			.enumerate()
			.skip(1)
			.any(|(i, arg)| arg.contains_str("://") && !owned.literal[i])
		|| (!owned.omp && spec.env.iter().any(|(name, value)| env_url(name, value)));
	if !resolves {
		return None;
	}
	Some(Plan { argv: expanded.map(|(argv, _)| argv), owned })
}

/// A spawn's arguments, and which of them stay as written.
pub(super) struct Plan {
	/// The arguments the spawn runs, when `env -S` put other words in their
	/// place; the spawn's own arguments otherwise.
	pub argv:  Option<Vec<BString>>,
	/// Which arguments stay as written.
	pub owned: Ownership,
}

/// Which arguments of a spawn stay as written: the arguments and inherited
/// settings of an `omp` run itself. Its own command word (`nice
/// local://bin/omp …` still needs the executable) and a wrapper's own file
/// arguments (`npx --cache local://dir omp …`) still resolve, as does its
/// environment when the command is not `omp` at all.
pub(super) struct Ownership {
	/// Per-`argv` index: `true` for the arguments and inherited settings of
	/// an `omp` run itself.
	pub literal: Vec<bool>,
	/// `true` when the command line's program is `omp`, or a `find` whose
	/// actions run one (it hands them its environment).
	pub omp:     bool,
}

/// The program the command line runs, after any wrappers. `None` when there
/// is no command (`env` alone, a lone assignment).
struct CommandParse {
	command:  Option<CommandWord>,
	/// The `NAME=value` words the command inherits.
	settings: Vec<usize>,
}

struct CommandWord {
	/// The command word's index in `argv`.
	index: usize,
	/// The command word itself; for `env -S`, the first word of the split
	/// string.
	word:  BString,
}

/// The command word a simple command runs and the settings it inherits: the
/// program itself, or the command a wrapper (`nice omp …`, `npx omp …`) runs
/// after its options and assignments. A word spelled `omp` anywhere else
/// (`grep omp …`, `ls ./omp …`) is an argument, not the program.
fn command_word(program: &BStr, words: &[BString]) -> CommandParse {
	let word_at = |at: usize| -> &[u8] {
		if at == 0 {
			program.as_bytes()
		} else {
			words[at].as_bytes()
		}
	};
	let mut settings = Vec::new();
	let mut at = 0;
	while at < words.len() && is_assignment(word_at(at)) {
		settings.push(at);
		at += 1;
	}
	if at >= words.len() {
		return CommandParse { command: None, settings };
	}
	let mut command = CommandWord { index: at, word: BString::from(word_at(at)) };
	// A wrapper chain is a loop, not a stack frame per wrapper.
	while let Some(mut next) = wrapper_command(command.word.as_bstr(), &words[command.index..]) {
		let Some(mut next_command) = next.command.take() else {
			return CommandParse { command: None, settings };
		};
		next_command.index += command.index;
		for setting in &mut next.settings {
			*setting += command.index;
		}
		settings.extend(next.settings);
		// The command a wrapper runs may be preceded by assignments it inherits.
		let mut at = next_command.index;
		while at < words.len() && is_assignment(words[at].as_bytes()) {
			settings.push(at);
			at += 1;
		}
		if at >= words.len() {
			return CommandParse { command: None, settings };
		}
		command = CommandWord { index: at, word: BString::from(words[at].as_bytes()) };
	}
	CommandParse { command: Some(command), settings }
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	launcher_is(word, "omp", cfg!(windows))
}

/// Whether `word` names the launcher `name`. Windows reads program names
/// without regard to case and splits paths on `\`; other platforms do neither.
/// A Windows script suffix (`.exe`, `.cmd`, `.bat`, `.ps1`) never counts.
fn launcher_is(word: &[u8], name: &str, windows: bool) -> bool {
	let word = strip_launcher_suffix(program_name(word, windows));
	if windows {
		word.eq_ignore_ascii_case(name.as_bytes())
	} else {
		word == name.as_bytes()
	}
}

/// `word` without a Windows script suffix, without allocating.
fn strip_launcher_suffix(word: &[u8]) -> &[u8] {
	for suffix in [b".exe".as_slice(), b".cmd", b".bat", b".ps1"] {
		if word.len() >= suffix.len()
			&& word[word.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
		{
			return &word[..word.len() - suffix.len()];
		}
	}
	word
}

/// The last path segment of `word`: the program's name.
fn program_name(word: &[u8], windows: bool) -> &[u8] {
	word
		.rsplit(|&b| b == b'/' || (windows && b == b'\\'))
		.next()
		.unwrap_or(word)
}

/// `NAME=value` or `NAME+=value`, as a simple command or a wrapper takes
/// before the command.
fn is_assignment(word: &[u8]) -> bool {
	word.split_once_str("=").is_some_and(|(name, _)| {
		let name = name.strip_suffix(b"+").unwrap_or(name);
		!name.is_empty()
			&& name
				.first()
				.is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
			&& name.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
	})
}

/// Options that take the next word as their value: short option letters and
/// long option names. An attached value (`-n5`, `--name=value`) needs no
/// separate word.
#[derive(Clone, Copy)]
struct OptionValues {
	short: &'static [u8],
	long:  &'static [&'static str],
}

const NICE: OptionValues = OptionValues { short: b"n", long: &["adjustment"] };
const NOHUP: OptionValues = OptionValues { short: b"", long: &[] };
const TIME: OptionValues = OptionValues { short: b"of", long: &["output", "format"] };
const ENV: OptionValues =
	OptionValues { short: b"uCS", long: &["unset", "chdir", "split-string"] };
const SUDO: OptionValues = OptionValues {
	short: b"ugCDhpRrTtUa",
	long:  &[
		"user",
		"group",
		"close-from",
		"chdir",
		"host",
		"prompt",
		"chroot",
		"role",
		"type",
		"command-timeout",
		"other-user",
		"auth-type",
	],
};
const DOAS: OptionValues = OptionValues { short: b"uC", long: &["user", "config"] };
const TIMEOUT: OptionValues = OptionValues { short: b"sk", long: &["signal", "kill-after"] };
const STDBUF: OptionValues = OptionValues { short: b"ioe", long: &["input", "output", "error"] };
const SETSID: OptionValues = OptionValues { short: b"", long: &[] };
const XARGS: OptionValues = OptionValues {
	short: b"nILPsdEa",
	long:  &[
		"max-args",
		"replace",
		"max-lines",
		"max-procs",
		"max-chars",
		"delimiter",
		"eof",
		"arg-file",
		"process-slot-var",
	],
};
const IFNE: OptionValues = OptionValues { short: b"", long: &[] };
const NPX: OptionValues = OptionValues {
	short: b"pcw",
	long:  &[
		"cache",
		"prefix",
		"registry",
		"userconfig",
		"package",
		"call",
		"node-options",
		"shell",
		"loglevel",
		"log-level",
		"npm",
		"workspace",
	],
};
const BUNX: OptionValues = OptionValues {
	short: b"p",
	long:  &[
		"package",
		"registry",
		"cache-dir",
		"minimum-release-age",
		"cwd",
		"env-file",
		"cafile",
		"ca",
	],
};
const BUN_GLOBAL: OptionValues = OptionValues {
	short: b"",
	long:  &[
		"cwd",
		"env-file",
		"preload",
		"require",
		"import",
		"define",
		"loader",
		"conditions",
		"main-fields",
		"tsconfig",
		"port",
		"config",
	],
};
const NPM_GLOBAL: OptionValues = OptionValues {
	short: b"w",
	long:  &[
		"prefix",
		"registry",
		"userconfig",
		"cache",
		"loglevel",
		"log-level",
		"workspace",
		"location",
		"tag",
		"otp",
		"before",
		"script-shell",
	],
};
const NPM_EXEC: OptionValues = OptionValues {
	short: b"cw",
	long:  &[
		"package",
		"call",
		"workspace",
		"prefix",
		"cache",
		"registry",
		"userconfig",
		"loglevel",
		"log-level",
		"location",
		"tag",
		"otp",
		"before",
		"script-shell",
	],
};
const PNPM: OptionValues = OptionValues { short: b"C", long: &["dir", "filter"] };
const UV_GLOBAL: OptionValues =
	OptionValues { short: b"", long: &["directory", "project", "config-file", "cache-dir"] };
const UV_RUN: OptionValues = OptionValues {
	short: b"wpif",
	long:  &[
		"with",
		"with-editable",
		"with-requirements",
		"python",
		"package",
		"project",
		"directory",
		"env-file",
		"extra",
		"group",
		"only-group",
		"no-group",
		"index",
		"default-index",
		"index-url",
		"extra-index-url",
		"find-links",
		"config-file",
		"cache-dir",
	],
};
const SSH: OptionValues = OptionValues { short: b"BbcDEeFIiJLlmOoPpQRSWw", long: &[] };
const COMMAND: OptionValues = OptionValues { short: b"", long: &[] };
const EXEC: OptionValues = OptionValues { short: b"a", long: &[] };

/// The command a wrapper at `program`/`words` runs, or `None` when it is not
/// a known wrapper or names no command. The index is relative to `words`,
/// whose first word is the wrapper. Does not look inside that command.
fn wrapper_command(program: &BStr, words: &[BString]) -> Option<CommandParse> {
	let windows = cfg!(windows);
	let after = |values: OptionValues, dash: bool| after_options(words, 1, values, dash);
	let command_at = |next: usize| -> Option<CommandParse> {
		if next == 0 || next >= words.len() {
			return None;
		}
		Some(CommandParse {
			command:  Some(CommandWord { index: next, word: words[next].clone() }),
			settings: Vec::new(),
		})
	};
	if launcher_is(program, "nice", windows) {
		return command_at(after(NICE, false));
	}
	if launcher_is(program, "nohup", windows) {
		return command_at(after(NOHUP, false));
	}
	if launcher_is(program, "time", windows) {
		return command_at(after(TIME, false));
	}
	if launcher_is(program, "env", windows) {
		return Some(env_command(words));
	}
	if launcher_is(program, "sudo", windows) {
		return Some(settings_command(words, after(SUDO, false)));
	}
	if launcher_is(program, "doas", windows) {
		return Some(settings_command(words, after(DOAS, false)));
	}
	if launcher_is(program, "timeout", windows) || launcher_is(program, "gtimeout", windows) {
		return command_at(after(TIMEOUT, false) + 1);
	}
	if launcher_is(program, "stdbuf", windows) {
		return command_at(after(STDBUF, false));
	}
	if launcher_is(program, "setsid", windows) {
		return command_at(after(SETSID, false));
	}
	if launcher_is(program, "xargs", windows) {
		return command_at(after(XARGS, false));
	}
	if launcher_is(program, "ifne", windows) {
		return command_at(after(IFNE, false));
	}
	if launcher_is(program, "npx", windows) {
		return command_at(after(NPX, false));
	}
	if launcher_is(program, "bunx", windows) {
		return command_at(after(BUNX, false));
	}
	if launcher_is(program, "bun", windows) {
		let sub = after(BUN_GLOBAL, false);
		if words.get(sub).is_none_or(|word| word.as_bytes() != b"x") {
			return None;
		}
		return command_at(after_options(words, sub + 1, BUNX, false));
	}
	if launcher_is(program, "npm", windows) {
		let sub = after(NPM_GLOBAL, false);
		if words
			.get(sub)
			.is_none_or(|word| word.as_bytes() != b"exec" && word.as_bytes() != b"x")
		{
			return None;
		}
		return command_at(after_options(words, sub + 1, NPM_EXEC, false));
	}
	if launcher_is(program, "pnpm", windows) {
		let sub = after(PNPM, false);
		if words.get(sub).is_none_or(|word| word.as_bytes() != b"exec") {
			return None;
		}
		return command_at(after_options(words, sub + 1, PNPM, false));
	}
	if launcher_is(program, "uv", windows) {
		return uv_command(words);
	}
	if launcher_is(program, "ssh", windows) {
		let host = after(SSH, false);
		if host >= words.len() {
			return None;
		}
		return command_at(after_options(words, host + 1, SSH, false));
	}
	if launcher_is(program, "command", windows) {
		let next = after(COMMAND, false);
		let names_only = next <= words.len()
			&& words[1..next].iter().any(|word| {
				let word = word.as_bytes();
				word.starts_with(b"-") && word[1..].iter().any(|&b| b == b'v' || b == b'V')
			});
		return if names_only { None } else { command_at(next) };
	}
	if launcher_is(program, "exec", windows) {
		return command_at(after(EXEC, false));
	}
	None
}

/// The first word from `from` on that is not an option (`--` ends them); a
/// value-taking option also skips the word after it. With `dash`, a lone `-`
/// is an option rather than a command (`env - omp …`).
fn after_options(argv: &[BString], mut at: usize, values: OptionValues, dash: bool) -> usize {
	while let Some(word) = argv.get(at) {
		let word = word.as_bytes();
		if word == b"--" {
			return at + 1;
		}
		if word == b"-" {
			if dash {
				at += 1;
				continue;
			}
			return at;
		}
		if !word.starts_with(b"-") {
			return at;
		}
		at += option_words(word, values);
	}
	at
}

/// The words one option occupies: its own, plus the next when its value is
/// not attached (`-n 5`, `--name value`).
fn option_words(word: &[u8], values: OptionValues) -> usize {
	if let Some(long) = word.strip_prefix(b"--") {
		if long.contains(&b'=') {
			return 1;
		}
		return if values.long.iter().any(|name| name.as_bytes() == long) {
			2
		} else {
			1
		};
	}
	for (i, &letter) in word.iter().enumerate().skip(1) {
		if values.short.contains(&letter) {
			return if i + 1 < word.len() { 1 } else { 2 };
		}
	}
	1
}

/// `sudo`/`doas`: the command after options and `NAME=value` settings, which
/// stay its own. The index is relative to `words`.
fn settings_command(words: &[BString], options: usize) -> CommandParse {
	let mut settings = Vec::new();
	let mut i = options;
	while i < words.len() && is_assignment(words[i].as_bytes()) {
		settings.push(i);
		i += 1;
	}
	if i >= words.len() {
		return CommandParse { command: None, settings };
	}
	CommandParse { command: Some(CommandWord { index: i, word: words[i].clone() }), settings }
}

/// `env [options] [NAME=value…] command`: options come first, then the
/// settings the command inherits, then the command. A `-S` value is already
/// words in the argument list ([`expand_env_split`]).
fn env_command(words: &[BString]) -> CommandParse {
	let mut settings = Vec::new();
	let mut i = 1;
	while i < words.len() {
		let word = words[i].as_bytes();
		if word == b"--" {
			i += 1;
			break;
		}
		if word == b"-" {
			i += 1;
			continue;
		}
		if word.starts_with(b"-") {
			i += option_words(word, ENV);
			continue;
		}
		break;
	}
	// `env` takes settings after its options; coreutils does not validate the
	// name, and a lone `-` is a setting too.
	while i < words.len() && (words[i].as_bytes() == b"-" || words[i].as_bytes().contains_str("=")) {
		if words[i].as_bytes() != b"-" {
			settings.push(i);
		}
		i += 1;
	}
	if i >= words.len() {
		return CommandParse { command: None, settings };
	}
	CommandParse { command: Some(CommandWord { index: i, word: words[i].clone() }), settings }
}

/// The arguments `env -S` runs: the split string's words in place of the
/// option, as `env` puts them. Each word names the argument it came from.
/// `None` when `program` is not `env` or carries no `-S`.
fn expand_env_split(program: &BStr, argv: &[BString]) -> Option<(Vec<BString>, Vec<usize>)> {
	if argv.is_empty() || !launcher_is(program, "env", cfg!(windows)) {
		return None;
	}
	let mut out = Vec::with_capacity(argv.len());
	let mut origin = Vec::with_capacity(argv.len());
	out.push(argv[0].clone());
	origin.push(0);
	let mut split = false;
	let mut i = 1;
	while i < argv.len() {
		let word = argv[i].as_bytes();
		let value: Option<(&[u8], usize)> = if word == b"-S" || word == b"--split-string" {
			i += 1;
			if i >= argv.len() {
				break;
			}
			Some((argv[i].as_bytes(), i))
		} else if let Some(value) = word.strip_prefix(b"--split-string=") {
			Some((value, i))
		} else if word.starts_with(b"-S") && word.len() > 2 {
			Some((&word[2..], i))
		} else {
			None
		};
		if let Some((text, at)) = value {
			for word in split_string_words(text) {
				out.push(word);
				origin.push(at);
			}
			split = true;
			i = at + 1;
		} else {
			out.push(argv[i].clone());
			origin.push(i);
			i += 1;
		}
	}
	split.then_some((out, origin))
}

/// `text` split into words the way `env -S` splits it: whitespace, with
/// quotes and `\`.
fn split_string_words(text: &[u8]) -> Vec<BString> {
	let mut words = Vec::new();
	let mut word = Vec::new();
	let mut quote = 0u8;
	let mut i = 0;
	while i < text.len() {
		let ch = text[i];
		if quote == b'\'' {
			if ch == b'\'' {
				quote = 0;
			} else {
				word.push(ch);
			}
			i += 1;
			continue;
		}
		if ch == b'\\' {
			if i + 1 < text.len() {
				word.push(text[i + 1]);
				i += 1;
			}
			i += 1;
			continue;
		}
		if quote != 0 {
			if ch == quote {
				quote = 0;
			} else {
				word.push(ch);
			}
			i += 1;
			continue;
		}
		if ch == b'\'' || ch == b'"' {
			quote = ch;
			i += 1;
			continue;
		}
		if ch.is_ascii_whitespace() {
			if !word.is_empty() {
				words.push(BString::from(std::mem::take(&mut word)));
			}
			i += 1;
			continue;
		}
		word.push(ch);
		i += 1;
	}
	if !word.is_empty() {
		words.push(BString::from(word));
	}
	words
}

/// `uv [options] run [options] command`. `-m`/`--module` runs a Python
/// module and `-s`/`--script` a Python script; neither is the `omp`
/// executable, so this is not a wrapper then.
fn uv_command(words: &[BString]) -> Option<CommandParse> {
	let sub = after_options(words, 1, UV_GLOBAL, false);
	if words.get(sub)?.as_bytes() != b"run" {
		return None;
	}
	let mut i = sub + 1;
	while i < words.len() {
		let word = words[i].as_bytes();
		if word == b"--" {
			i += 1;
			break;
		}
		if word == b"-" || !word.starts_with(b"-") {
			break;
		}
		if word == b"-m"
			|| word == b"--module"
			|| word.starts_with(b"--module=")
			|| word == b"-s"
			|| word == b"--script"
			|| word.starts_with(b"--script=")
		{
			return None;
		}
		i += option_words(word, UV_RUN);
	}
	if i >= words.len() {
		return None;
	}
	Some(CommandParse {
		command:  Some(CommandWord { index: i, word: words[i].clone() }),
		settings: Vec::new(),
	})
}

/// `find … -exec cmd \; -exec cmd +`: the word range each action's command
/// occupies.
fn find_actions(argv: &[BString], from: usize) -> Vec<(usize, usize)> {
	let mut actions = Vec::new();
	let mut i = from;
	while i < argv.len() {
		if matches!(argv[i].as_bytes(), b"-exec" | b"-execdir" | b"-ok" | b"-okdir")
			&& argv
				.get(i + 1)
				.is_some_and(|word| word.as_bytes() != b";" && word.as_bytes() != b"+")
		{
			let start = i + 1;
			let mut end = start;
			while end < argv.len() {
				let word = argv[end].as_bytes();
				if word == b";" {
					break;
				}
				// `find` ends a batch only at `{} +`; any other `+` is an argument.
				if word == b"+" && end > start && argv[end - 1].as_bytes() == b"{}" {
					break;
				}
				end += 1;
			}
			actions.push((start, end));
			i = end + 1;
		} else {
			i += 1;
		}
	}
	actions
}

/// Which arguments of `program`/`argv` stay as written: the arguments and
/// inherited settings of an `omp` run itself. Its own command word still
/// resolves (`nice local://bin/omp …` needs the executable).
fn ownership(program: &BStr, argv: &[BString]) -> Ownership {
	let mut literal = vec![false; argv.len()];
	let parse = command_word(program, argv);
	let Some(command) = parse.command else {
		return Ownership { literal, omp: false };
	};
	if launcher_is(command.word.as_slice(), "find", cfg!(windows)) {
		// `find` passes its settings to the commands it runs, so a setting an
		// `omp` action inherits stays as written, arguments and environment.
		let mut inherited = false;
		for (start, end) in find_actions(argv, command.index + 1) {
			if start >= end {
				continue;
			}
			let slice = &argv[start..end];
			let (words, origin) = match expand_env_split(slice[0].as_bstr(), slice) {
				Some(expanded) => expanded,
				None => (slice.to_vec(), (0..slice.len()).collect()),
			};
			let action = command_word(words[0].as_bstr(), &words);
			let Some(ac) = action.command else {
				continue;
			};
			if !is_omp(ac.word.as_slice()) {
				continue;
			}
			inherited = true;
			for setting in action.settings {
				literal[start + origin[setting]] = true;
			}
			for index in ac.index + 1..words.len() {
				literal[start + origin[index]] = true;
			}
		}
		if inherited {
			for setting in parse.settings {
				literal[setting] = true;
			}
		}
		return Ownership { literal, omp: inherited };
	}
	if !is_omp(command.word.as_slice()) {
		return Ownership { literal, omp: false };
	}
	for setting in parse.settings {
		literal[setting] = true;
	}
	literal[command.index + 1..].fill(true);
	Ownership { literal, omp: true }
}

/// Whether the environment variable `name` holds a URL to resolve. `PWD`
/// follows the working directory instead, and a web address aliases no file,
/// so the provider is not asked about one on every spawn.
fn env_url(name: &BStr, value: &BStr) -> bool {
	name != "PWD"
		&& as_path(value)
			.and_then(omp_vfs::url_scheme)
			.is_some_and(|scheme| !matches!(scheme, "http" | "https"))
}

/// Take `spec` apart for a spawn that waits on the provider: the names as
/// written (copied) and the rest (moved, its borrowed slice copied).
pub(super) fn split(spec: SpawnSpec<'_>, plan: Plan) -> (Names, Rest) {
	let SpawnSpec {
		path,
		argv,
		env,
		cwd,
		stdio,
		extra_fds,
		pgroup,
		tag,
		vpid,
		umask,
		sigmask_ign,
		rlimits,
		lineage,
		redirs,
		ctty,
	} = spec;
	let names = Names {
		path:  BString::from(path.as_bytes()),
		argv:  plan.argv.unwrap_or_else(|| argv.to_vec()),
		env:   env.clone(),
		cwd:   BString::from(cwd.as_bytes()),
		owned: plan.owned,
	};
	let rest = Rest {
		stdio,
		extra_fds,
		pgroup,
		tag,
		vpid,
		umask,
		sigmask_ign,
		rlimits: rlimits.to_vec(),
		lineage,
		redirs,
		ctty,
	};
	(names, rest)
}

fn is_url(path: &BStr) -> bool {
	as_path(path).is_some_and(omp_vfs::is_virtual_path)
}

/// `bytes` as a path (`None` for bytes that are not one on this platform).
fn as_path(bytes: &[u8]) -> Option<&Path> {
	bytes.to_path().ok()
}

fn path_bytes(path: &Path) -> BString {
	BString::from(path.as_os_str().as_encoded_bytes())
}

/// The host spelling of `names`: every URL the filesystem backs replaced by
/// its file.
pub(super) async fn resolve(fs: &omp_vfs::Fs, names: Names) -> io::Result<Names> {
	let name = names
		.argv
		.first()
		.map_or_else(|| names.path.to_str_lossy(), |arg| arg.to_str_lossy())
		.into_owned();
	let cwd_bytes: &[u8] = &names.cwd;
	let spawn_dir = match as_path(cwd_bytes) {
		Some(cwd) => match host_path(fs, cwd).await? {
			// A child may write anywhere under its working directory, so it must
			// not start in one the shell itself refuses to change (`skill://`,
			// a read-only `local://`). Arguments still translate: those name
			// single files the program was asked to use.
			Some(backing) => match fs.access(cwd, false, true, false).await {
				Ok(()) => Some(backing),
				Err(err) if err.kind() == io::ErrorKind::ReadOnlyFilesystem => {
					return Err(io::Error::other(format!(
						"cannot run external command '{name}' in read-only working directory {}",
						cwd.display()
					)));
				},
				Err(err) => return Err(unresolved(cwd, &err)),
			},
			None if omp_vfs::is_virtual_path(cwd) && !fs.is_native_local(cwd) => {
				return Err(io::Error::other(format!(
					"cannot run external command '{name}' in virtual working directory {}",
					cwd.display()
				)));
			},
			None => None,
		},
		None => None,
	};
	let path = match as_path(&names.path) {
		Some(program) if omp_vfs::is_virtual_path(program) && !fs.is_native_local(program) => {
			let backing = host_path(fs, program).await?.ok_or_else(|| {
				io::Error::other(format!(
					"{} is a virtual file: an external command cannot run it",
					program.display()
				))
			})?;
			path_bytes(&backing)
		},
		_ => names.path.clone(),
	};
	let owned = names.owned;
	let mut argv = Vec::with_capacity(names.argv.len());
	for (i, arg) in names.argv.iter().enumerate() {
		// The program is resolved above; `omp` resolves the arguments it is
		// given itself, while a wrapper's own arguments are still ours.
		let host = if i == 0 || owned.literal[i] {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's. `omp`
	// resolves the URLs in its own environment.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !owned.omp {
		for (name, value) in names.env.iter() {
			if env_url(name, value)
				&& let Some(host) = host_arg(fs, value).await
			{
				hosted.push((BString::from(name.as_bytes()), host));
			}
		}
	}
	let cwd = match spawn_dir {
		// The shell's `$PWD` keeps the URL spelling; only the child is told
		// the directory it actually starts in, so what it reads from `PWD`
		// agrees with its own `getcwd()`.
		Some(dir) => {
			let dir = path_bytes(&dir);
			hosted.push((BString::from("PWD"), dir.clone()));
			dir
		},
		None => names.cwd.clone(),
	};
	let env = if hosted.is_empty() {
		names.env.clone()
	} else {
		let mut pairs: Vec<(BString, BString)> = names
			.env
			.iter()
			.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
			.collect();
		pairs.append(&mut hosted);
		EnvView::new(pairs)
	};
	Ok(Names { path, argv, env, cwd, owned })
}

/// The host path `path` aliases, if it is a URL the filesystem backs.
async fn host_path(fs: &omp_vfs::Fs, path: &Path) -> io::Result<Option<PathBuf>> {
	if fs.is_native() || !omp_vfs::is_virtual_path(path) {
		return Ok(None);
	}
	fs.backing_path(path)
		.await
		.map_err(|err| unresolved(path, &err))
}

/// A URL the provider could not resolve; `Other`, so the engine prints the
/// reason rather than a bare "No such file".
fn unresolved(path: &Path, err: &io::Error) -> io::Error {
	io::Error::other(format!("cannot resolve {} for an external command: {err}", path.display()))
}

/// `arg` rewritten to the host path it names, if it names one.
///
/// The URL may be the whole argument (`skill://example-skill/tool.py`) or
/// follow a lead that attaches it ([`url_start`]). Anything the filesystem
/// does not route to a backing file, or cannot resolve, is left exactly as
/// it was written, so `https://…`, `s3://…`, an identifier that only looks
/// like one of the provider's URLs, and ordinary words reach the child
/// untouched. A bare scheme root (`local://`), or one followed by words
/// (`skill:// external command`), is far likelier a search pattern or message
/// text than a path, so it stays literal too, as does a URL with words after
/// it (`local://12.log shows the failure`) unless a file has exactly that name.
async fn host_arg(fs: &omp_vfs::Fs, arg: &BStr) -> Option<BString> {
	let text = arg.to_str().ok()?;
	let (lead, url) = text.split_at(url_start(text)?);
	if names_nothing(url) {
		return None;
	}
	let host = host_path(fs, Path::new(url)).await.ok()??;
	if url.contains(char::is_whitespace) && std::fs::symlink_metadata(&host).is_err() {
		return None;
	}
	let mut rewritten = BString::from(lead);
	rewritten.extend_from_slice(&path_bytes(&host));
	Some(rewritten)
}

/// Where the URL `text` hands a program starts: at its beginning, or after
/// what attaches it to an option: a name and `=` (`--index=skill://x/data`,
/// `if=local://in`), a short option letter (`-olocal://out`), and then an `@`
/// that says "the contents of" (`@local://body.json`, `body=@local://b.md`,
/// `-d@local://b.json`).
///
/// Only an option name may carry an attached URL. A URL of its own that
/// happens to embed one in a query string (`https://host/cb?next=local://x`)
/// is one opaque string to the program receiving it.
fn url_start(text: &str) -> Option<usize> {
	if !text.contains("://") {
		return None;
	}
	let url_at = |at: usize| omp_vfs::is_virtual_path(Path::new(&text[at..]));
	if url_at(0) {
		return Some(0);
	}
	let bytes = text.as_bytes();
	let mut at = match text.split_once('=') {
		Some((name, _)) if !name.contains("://") => name.len() + 1,
		_ if bytes.first() == Some(&b'-') && bytes.get(1).is_some_and(u8::is_ascii_alphabetic) => 2,
		_ => 0,
	};
	if bytes.get(at) == Some(&b'@') {
		at += 1;
	}
	url_at(at).then_some(at)
}

/// Whether `text` is a URL naming nothing below its scheme: a bare root
/// (`local://`) or a root followed by whitespace (`skill:// some words`).
fn names_nothing(text: &str) -> bool {
	omp_vfs::url_scheme(Path::new(text)).is_some_and(|scheme| {
		let rest = text[scheme.len() + 3..].trim_start_matches('/');
		rest.trim_end_matches('/').is_empty() || rest.starts_with(char::is_whitespace)
	})
}
