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
	pub path: BString,
	/// The argument vector (`argv[0]` as written).
	pub argv: Vec<BString>,
	/// The environment, `PWD` naming the host working directory.
	pub env:  EnvView,
	/// The working directory.
	pub cwd:  BString,
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

/// Whether `spec` names a URL (program, working directory, an argument
/// containing `://`, or an environment value that is one): then it resolves
/// first, else it spawns as it is. A URL `omp` resolves itself is left for
/// it, but a wrapper's own arguments (`npx --cache local://dir omp …`) still
/// resolve.
pub(super) fn names_url(spec: &SpawnSpec<'_>) -> bool {
	let owned = ownership(spec.path, spec.argv);
	is_url(spec.path)
		|| is_url(spec.cwd)
		|| spec
			.argv
			.iter()
			.enumerate()
			.skip(1)
			.any(|(i, arg)| arg.contains_str("://") && !owned.literal[i])
		|| (!owned.omp && spec.env.iter().any(|(name, value)| env_url(name, value)))
}

/// Which arguments of a spawn stay as written: the arguments and inherited
/// settings of an `omp` run itself. Its own command word (`nice
/// local://bin/omp …` still needs the executable) and a wrapper's own file
/// arguments (`npx --cache local://dir omp …`) still resolve, as does its
/// environment when the command is not `omp` at all.
struct Ownership {
	/// Per-`argv` index: `true` for the arguments and inherited settings of
	/// an `omp` run itself.
	literal: Vec<bool>,
	/// `true` when the command line's program is `omp`.
	omp:     bool,
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
	let word: &BStr = if at == 0 {
		program
	} else {
		words[at].as_bstr()
	};
	match wrapper_command(word, &words[at..]) {
		Some(mut next) => {
			if let Some(command) = &mut next.command {
				command.index += at;
			}
			for setting in &mut next.settings {
				*setting += at;
			}
			settings.extend(next.settings);
			CommandParse { command: next.command, settings }
		},
		None => CommandParse {
			command: Some(CommandWord { index: at, word: BString::from(word_at(at)) }),
			settings,
		},
	}
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	launcher_name(word) == b"omp"
}

/// A launcher's name: the last path segment, lowercased, without a Windows
/// script suffix (`npx.cmd`, `NPX.CMD`).
fn launcher_name(word: &[u8]) -> BString {
	let name = program_name(word);
	let mut name = name.to_ascii_lowercase();
	for suffix in [".exe", ".cmd", ".bat", ".ps1"] {
		if name.ends_with(suffix.as_bytes()) {
			name.truncate(name.len() - suffix.len());
			break;
		}
	}
	BString::from(name)
}

/// The last path segment of `word`: the program's name.
fn program_name(word: &[u8]) -> &[u8] {
	word
		.rsplit(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
		.next()
		.unwrap_or(word)
}

/// `NAME=value`, as `env` and `sudo` take before the command they run.
fn is_assignment(word: &[u8]) -> bool {
	word.split_once_str("=").is_some_and(|(name, _)| {
		name
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
	long:  &["package", "registry", "cache-dir", "minimum-release-age", "cwd", "env-file"],
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
/// a known wrapper or names no command.
fn wrapper_command(program: &BStr, words: &[BString]) -> Option<CommandParse> {
	let name = launcher_name(program);
	let after = |values: OptionValues, dash: bool| after_options(words, 1, values, dash);
	let command_at = |next: usize| -> Option<CommandParse> {
		if next == 0 || next >= words.len() {
			return None;
		}
		let mut parse = command_word(words[next].as_bstr(), &words[next..]);
		if let Some(command) = &mut parse.command {
			command.index += next;
		}
		for setting in &mut parse.settings {
			*setting += next;
		}
		Some(parse)
	};
	match name.as_slice() {
		b"nice" => command_at(after(NICE, false)),
		b"nohup" => command_at(after(NOHUP, false)),
		b"time" => command_at(after(TIME, false)),
		b"env" => Some(env_command(words)),
		b"sudo" => Some(settings_command(words, after(SUDO, false))),
		b"doas" => Some(settings_command(words, after(DOAS, false))),
		b"timeout" | b"gtimeout" => command_at(after(TIMEOUT, false) + 1),
		b"stdbuf" => command_at(after(STDBUF, false)),
		b"setsid" => command_at(after(SETSID, false)),
		b"xargs" => command_at(after(XARGS, false)),
		b"ifne" => command_at(after(IFNE, false)),
		b"npx" => command_at(after(NPX, false)),
		b"bunx" => command_at(after(BUNX, false)),
		b"bun" => {
			let sub = after(BUN_GLOBAL, false);
			if words.get(sub).is_none_or(|word| word.as_bytes() != b"x") {
				return None;
			}
			command_at(after_options(words, sub + 1, BUNX, false))
		},
		b"npm" => {
			let sub = after(NPM_GLOBAL, false);
			if words
				.get(sub)
				.is_none_or(|word| word.as_bytes() != b"exec" && word.as_bytes() != b"x")
			{
				return None;
			}
			command_at(after_options(words, sub + 1, NPM_EXEC, false))
		},
		b"pnpm" => {
			let sub = after(PNPM, false);
			if words.get(sub).is_none_or(|word| word.as_bytes() != b"exec") {
				return None;
			}
			command_at(after_options(words, sub + 1, PNPM, false))
		},
		b"uv" => uv_command(words),
		b"ssh" => {
			let host = after(SSH, false);
			if host >= words.len() {
				return None;
			}
			command_at(after_options(words, host + 1, SSH, false))
		},
		b"command" => {
			let next = after(COMMAND, false);
			let names_only = next <= words.len()
				&& words[1..next].iter().any(|word| {
					let word = word.as_bytes();
					word.starts_with(b"-") && word[1..].iter().any(|&b| b == b'v' || b == b'V')
				});
			if names_only { None } else { command_at(next) }
		},
		b"exec" => command_at(after(EXEC, false)),
		_ => None,
	}
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
/// stay its own.
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
	let mut parse = command_word(words[i].as_bstr(), &words[i..]);
	if let Some(command) = &mut parse.command {
		command.index += i;
	}
	for setting in &mut parse.settings {
		*setting += i;
	}
	settings.extend(parse.settings);
	CommandParse { command: parse.command, settings }
}

/// `env [options] [NAME=value…] command`: options come first, then the
/// settings the command inherits, then the command. `-S`/`--split-string`
/// names the command inside its value instead.
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
		if word == b"-S" || word == b"--split-string" {
			let value = words.get(i + 1);
			return split_string_command(value.map(|w| w.as_bstr()), i, settings);
		}
		if let Some(value) = word.strip_prefix(b"--split-string=") {
			return split_string_command(Some(value.as_bstr()), i, settings);
		}
		if word.starts_with(b"-S") && word.len() > 2 {
			return split_string_command(Some(word[2..].as_bstr()), i, settings);
		}
		if word.starts_with(b"-") {
			i += option_words(word, ENV);
			continue;
		}
		break;
	}
	// `env` takes `NAME=value` settings after its options; coreutils does not
	// validate the name, and a lone `-` is a setting too.
	while i < words.len() && (words[i].as_bytes() == b"-" || words[i].as_bytes().contains_str("=")) {
		if words[i].as_bytes() != b"-" {
			settings.push(i);
		}
		i += 1;
	}
	if i >= words.len() {
		return CommandParse { command: None, settings };
	}
	let mut parse = command_word(words[i].as_bstr(), &words[i..]);
	if let Some(command) = &mut parse.command {
		command.index += i;
	}
	for setting in &mut parse.settings {
		*setting += i;
	}
	settings.extend(parse.settings);
	CommandParse { command: parse.command, settings }
}

/// The command inside `env -S`'s `value`: split like the shell does, then
/// parsed as its own command line. `option` stands in for every word inside
/// the string.
fn split_string_command(
	value: Option<&BStr>,
	option: usize,
	mut settings: Vec<usize>,
) -> CommandParse {
	let Some(value) = value else {
		return CommandParse { command: None, settings };
	};
	let argv = split_string_words(value.as_bytes());
	if argv.is_empty() {
		return CommandParse { command: None, settings };
	}
	let mut parse = command_word(argv[0].as_bstr(), &argv);
	if let Some(command) = &mut parse.command {
		command.index = option;
	}
	if !parse.settings.is_empty() {
		settings.push(option);
	}
	parse.settings.clear();
	CommandParse { command: parse.command, settings }
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

/// `uv [options] run [options] command`: `-m`/`--module` runs a module, not
/// an executable.
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
		if word == b"-m" || word == b"--module" || word.starts_with(b"--module=") {
			return None;
		}
		i += option_words(word, UV_RUN);
	}
	if i >= words.len() {
		return None;
	}
	let mut parse = command_word(words[i].as_bstr(), &words[i..]);
	if let Some(command) = &mut parse.command {
		command.index += i;
	}
	for setting in &mut parse.settings {
		*setting += i;
	}
	Some(parse)
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
			while end < argv.len() && argv[end].as_bytes() != b";" && argv[end].as_bytes() != b"+" {
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
	if launcher_name(command.word.as_slice()) == b"find" {
		for (start, end) in find_actions(argv, command.index + 1) {
			if start >= end {
				continue;
			}
			let mut action = command_word(argv[start].as_bstr(), &argv[start..end]);
			for setting in &mut action.settings {
				*setting += start;
			}
			let Some(ac) = action.command else {
				continue;
			};
			if !is_omp(ac.word.as_slice()) {
				continue;
			}
			for setting in action.settings {
				literal[setting] = true;
			}
			literal[start + ac.index + 1..end].fill(true);
		}
		return Ownership { literal, omp: false };
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
pub(super) fn split(spec: SpawnSpec<'_>) -> (Names, Rest) {
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
		path: BString::from(path.as_bytes()),
		argv: argv.to_vec(),
		env:  env.clone(),
		cwd:  BString::from(cwd.as_bytes()),
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
pub(super) async fn resolve(fs: &omp_vfs::Fs, names: &Names) -> io::Result<Names> {
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
	let owned = ownership(names.path.as_bstr(), &names.argv);
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
	Ok(Names { path, argv, env, cwd })
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
