//! Embedded-language inference and portable semantic tokens (never ANSI/HTML).
use std::path::Path;

use super::model::{Layers, NodeKey, Segment};

/// Shells whose `-c` operand, or stdin, is a shell script.
const SHELLS: [&[u8]; 5] = [b"sh", b"bash", b"zsh", b"dash", b"ksh"];

fn basename_str(s: &str) -> &str {
	s.rsplit('/').next().unwrap_or(s)
}

fn basename(s: &[u8]) -> &[u8] {
	s.rsplit(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
		.next()
		.unwrap_or(s)
}

/// A short-option cluster that sets `flag` (`-euc` sets `c`).
fn sets(word: &[u8], flag: u8) -> bool {
	word
		.strip_prefix(b"-")
		.is_some_and(|flags| !flags.starts_with(b"-") && flags.contains(&flag))
}

/// `NAME=VALUE`, as `env` and `sudo` take before the command they run.
fn assignment(word: &[u8]) -> bool {
	word.split_once(|&b| b == b'=').is_some_and(|(name, _)| {
		name
			.first()
			.is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
			&& name.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
	})
}

/// Program name of `word` for launcher matching: on Unix, the exact filename
/// after `/`; on Windows, the filename after `/` or `\`, without `.exe` or
/// `.cmd`, in ASCII lowercase.
fn program_key<'a>(word: &'a [u8], windows: bool, scratch: &'a mut [u8; 16]) -> &'a [u8] {
	if !windows {
		return word.rsplit(|&b| b == b'/').next().unwrap_or(word);
	}
	let base = word
		.rsplit(|&b| b == b'/' || b == b'\\')
		.next()
		.unwrap_or(word);
	let stem = if base.len() > 4 {
		let ext = &base[base.len() - 4..];
		if ext.eq_ignore_ascii_case(b".exe") || ext.eq_ignore_ascii_case(b".cmd") {
			&base[..base.len() - 4]
		} else {
			base
		}
	} else {
		base
	};
	if stem.len() <= scratch.len() {
		for (dst, &src) in scratch.iter_mut().zip(stem) {
			*dst = src.to_ascii_lowercase();
		}
		&scratch[..stem.len()]
	} else {
		stem
	}
}

fn is_env_setting(word: &[u8]) -> bool {
	!word.starts_with(b"-")
		&& word
			.iter()
			.position(|&b| b == b'=')
			.is_some_and(|eq| eq > 0)
}

const HELP_VERSION_STOP: &[&[u8]] = &[b"help", b"version"];
const SUDO_LONG_VAL: &[&[u8]] = &[
	b"auth-type",
	b"class",
	b"close-from",
	b"chdir",
	b"group",
	b"host",
	b"prompt",
	b"chroot",
	b"role",
	b"command-timeout",
	b"type",
	b"other-user",
	b"user",
];
const SUDO_LONG_STOP: &[&[u8]] =
	&[b"edit", b"list", b"validate", b"version", b"help", b"remove-timestamp"];
const UV_LONG_VAL: &[&[u8]] = &[
	b"with",
	b"with-editable",
	b"with-requirements",
	b"python",
	b"package",
	b"project",
	b"directory",
	b"env-file",
	b"extra",
	b"group",
	b"only-group",
	b"no-group",
	b"index",
	b"default-index",
	b"index-url",
	b"extra-index-url",
	b"find-links",
	b"config-file",
	b"cache-dir",
	b"color",
	b"python-preference",
];
const NPX_LONG_VAL: &[&[u8]] = &[
	b"package",
	b"workspace",
	b"cache",
	b"userconfig",
	b"registry",
	b"shell",
	b"script-shell",
	b"node-options",
	b"node-arg",
	b"prefix",
];
const NPX_LONG_STOP: &[&[u8]] = &[b"call", b"help", b"version"];
const BUNX_LONG_VAL: &[&[u8]] = &[b"package", b"cwd", b"config", b"env-file"];

fn step_option<W: AsRef<[u8]>>(
	words: &[W],
	i: usize,
	short_val: &[u8],
	short_stop: &[u8],
	long_val: &[&[u8]],
	long_stop: &[&[u8]],
) -> Option<usize> {
	let word = words.get(i)?.as_ref();
	if let Some(rest) = word.strip_prefix(b"--") {
		let (name, inline) = match rest.iter().position(|&b| b == b'=') {
			Some(eq) => (&rest[..eq], true),
			None => (rest, false),
		};
		if long_stop.contains(&name) {
			return None;
		}
		let step = if !inline && long_val.contains(&name) {
			2
		} else {
			1
		};
		return (i + step <= words.len()).then_some(i + step);
	}
	let flags = word.strip_prefix(b"-").filter(|f| !f.is_empty())?;
	let mut step = 1;
	for (idx, &flag) in flags.iter().enumerate() {
		if short_stop.contains(&flag) {
			return None;
		}
		if short_val.contains(&flag) {
			if idx + 1 == flags.len() {
				step = 2;
			}
			break;
		}
	}
	(i + step <= words.len()).then_some(i + step)
}

fn skip_options<W: AsRef<[u8]>>(
	words: &[W],
	mut i: usize,
	short_val: &[u8],
	short_stop: &[u8],
	long_val: &[&[u8]],
	long_stop: &[&[u8]],
) -> Option<usize> {
	while let Some(word) = words.get(i).map(AsRef::as_ref) {
		if word == b"--" {
			return Some(i + 1);
		}
		if word.len() <= 1 || word[0] != b'-' {
			break;
		}
		i = step_option(words, i, short_val, short_stop, long_val, long_stop)?;
	}
	Some(i)
}

fn skip_env<W: AsRef<[u8]>>(words: &[W], mut i: usize) -> Option<usize> {
	while let Some(word) = words.get(i).map(AsRef::as_ref) {
		if word == b"--" {
			i += 1;
			while let Some(next) = words.get(i).map(AsRef::as_ref) {
				if next.starts_with(b"=") {
					return None;
				}
				if !is_env_setting(next) {
					break;
				}
				i += 1;
			}
			return Some(i);
		}
		if word == b"-" {
			i += 1;
			continue;
		}
		if word.starts_with(b"=") {
			return None;
		}
		if is_env_setting(word) {
			i += 1;
			continue;
		}
		if word.starts_with(b"-") {
			i = step_option(
				words,
				i,
				b"uCPa",
				b"S0",
				&[b"unset", b"chdir", b"default-path", b"argv0"],
				&[b"split-string", b"null", b"help", b"version"],
			)?;
			continue;
		}
		break;
	}
	Some(i)
}

fn skip_sudo<W: AsRef<[u8]>>(words: &[W], mut i: usize) -> Option<usize> {
	while let Some(word) = words.get(i).map(AsRef::as_ref) {
		if word == b"--" {
			i += 1;
			while words.get(i).is_some_and(|w| assignment(w.as_ref())) {
				i += 1;
			}
			return Some(i);
		}
		if assignment(word) {
			i += 1;
			continue;
		}
		if word.len() > 1 && word.starts_with(b"-") {
			i = step_option(words, i, b"ugCDhpRrTtUac", b"eVvlK", SUDO_LONG_VAL, SUDO_LONG_STOP)?;
			continue;
		}
		break;
	}
	Some(i)
}

fn skip_npx<W: AsRef<[u8]>>(words: &[W], i: usize) -> Option<usize> {
	skip_options(words, i, b"pw", b"cvh", NPX_LONG_VAL, NPX_LONG_STOP)
}

fn skip_bunx<W: AsRef<[u8]>>(words: &[W], i: usize) -> Option<usize> {
	skip_options(words, i, b"p", b"vh", BUNX_LONG_VAL, HELP_VERSION_STOP)
}

/// Words a launcher at the start of `words` takes before the command it runs
/// (`timeout 5 cmd` → 2), and whether that command runs on an `ssh` host.
fn launcher_for<W: AsRef<[u8]>>(words: &[W], windows: bool) -> Option<(usize, bool)> {
	let mut scratch = [0u8; 16];
	let skip = match program_key(words.first()?.as_ref(), windows, &mut scratch) {
		b"env" => skip_env(words, 1)?,
		b"sudo" => skip_sudo(words, 1)?,
		b"doas" => skip_options(words, 1, b"ua", b"CL", &[], HELP_VERSION_STOP)?,
		// The first operand is the duration.
		b"timeout" | b"gtimeout" => {
			let dur =
				skip_options(words, 1, b"sk", b"", &[b"signal", b"kill-after"], HELP_VERSION_STOP)?;
			if dur >= words.len() {
				return None;
			}
			dur + 1
		},
		b"nice" => skip_options(words, 1, b"n", b"", &[b"adjustment"], HELP_VERSION_STOP)?,
		b"nohup" => match words.get(1).map(AsRef::as_ref) {
			Some(b"--") => 2,
			Some(w) if w.starts_with(b"-") => return None,
			_ => 1,
		},
		b"time" => skip_options(words, 1, b"fo", b"V", &[b"format", b"output"], HELP_VERSION_STOP)?,
		b"stdbuf" => {
			skip_options(words, 1, b"ioe", b"", &[b"input", b"output", b"error"], HELP_VERSION_STOP)?
		},
		b"exec" => skip_options(words, 1, b"a", b"", &[], HELP_VERSION_STOP)?,
		b"uv" => {
			let sub =
				skip_options(words, 1, b"pif", b"Vhm", UV_LONG_VAL, &[b"module", b"help", b"version"])?;
			if words.get(sub).map(AsRef::as_ref) != Some(b"run") {
				return None;
			}
			skip_options(words, sub + 1, b"pif", b"Vhms", UV_LONG_VAL, &[
				b"module", b"script", b"help", b"version",
			])?
		},
		b"npx" => skip_npx(words, 1)?,
		b"bunx" => skip_bunx(words, 1)?,
		b"bun" => {
			let sub = skip_options(
				words,
				1,
				b"Ccr",
				b"vhep",
				&[b"cwd", b"config", b"env-file", b"preload"],
				&[b"eval", b"print", b"help", b"version"],
			)?;
			if words.get(sub).map(AsRef::as_ref) != Some(b"x") {
				return None;
			}
			skip_bunx(words, sub + 1)?
		},
		b"pnpm" | b"yarn" => {
			let sub = skip_options(
				words,
				1,
				b"CFp",
				b"vh",
				&[b"dir", b"filter", b"package", b"workspace-root", b"cwd"],
				HELP_VERSION_STOP,
			)?;
			if !matches!(words.get(sub).map(AsRef::as_ref), Some(b"dlx" | b"exec")) {
				return None;
			}
			skip_npx(words, sub + 1)?
		},
		b"npm" => {
			let sub = skip_options(
				words,
				1,
				b"Cw",
				b"vh",
				&[b"prefix", b"workspace", b"userconfig", b"registry", b"cache"],
				HELP_VERSION_STOP,
			)?;
			if !matches!(words.get(sub).map(AsRef::as_ref), Some(b"exec" | b"x")) {
				return None;
			}
			skip_npx(words, sub + 1)?
		},
		b"ssh" => {
			let host = skip_options(words, 1, b"pilojFSLRDWbcEemOQw", b"", &[], &[])?;
			return (host < words.len()).then_some((host + 1, true));
		},
		_ => return None,
	};
	Some((skip, false))
}

/// A command line past its launchers (`env`, `timeout`, `sudo`, `uv run`,
/// `ssh host`, …).
pub(crate) struct Launch {
	/// Index of the word naming the program; for `ssh`, of its first remote
	/// word, if any (none: the remote login shell runs stdin).
	pub(crate) at:     usize,
	/// The program runs on an `ssh` host.
	pub(crate) remote: bool,
}

fn launch_for<W: AsRef<[u8]>>(words: &[W], windows: bool) -> Launch {
	let mut launch = Launch { at: 0, remote: false };
	while let Some((skip, remote)) = launcher_for(&words[launch.at..], windows) {
		if skip == 0 {
			break;
		}
		launch.at = (launch.at + skip).min(words.len());
		launch.remote |= remote;
	}
	launch
}

pub(crate) fn launch<W: AsRef<[u8]>>(words: &[W]) -> Launch {
	launch_for(words, cfg!(windows))
}

/// The word holding a shell script the command line runs, and whether it runs
/// on an `ssh` host: `ssh host SCRIPT`, or a shell's `-c` operand anywhere in
/// the line (`docker run img sh -c SCRIPT`, `xargs sh -c SCRIPT`).
pub fn shell_script(words: &[String]) -> Option<(usize, bool)> {
	let launch = launch(words);
	if launch.remote && launch.at + 1 == words.len() {
		return Some((launch.at, true));
	}
	let at = words.iter().enumerate().find_map(|(i, word)| {
		if !SHELLS.contains(&basename(word.as_bytes())) {
			return None;
		}
		let flag = words[i + 1..]
			.iter()
			.take_while(|w| w.starts_with('-'))
			.position(|w| sets(w.as_bytes(), b'c'))?;
		Some(i + flag + 2)
	})?;
	(at < words.len()).then_some((at, launch.remote))
}

/// Language of the program `words[index]` holds (`python -c CODE`,
/// `jq FILTER`, `sh -c SCRIPT`, `ssh host SCRIPT`), behind any launchers.
pub fn argument_language(words: &[String], index: usize) -> Option<&'static str> {
	if shell_script(words).is_some_and(|(at, _)| at == index) {
		return Some("bash");
	}
	let at = launch(words).at;
	let (args, index) = (&words[at..], index.checked_sub(at)?);
	let command = basename(args.first()?.as_bytes());
	let previous = index
		.checked_sub(1)
		.and_then(|i| args.get(i))
		.map(|s| s.as_bytes());
	if command.starts_with(b"python") && previous == Some(b"-c") {
		return Some("py");
	}
	if matches!(command, b"node" | b"bun" | b"deno") && matches!(previous, Some(b"-e" | b"--eval")) {
		return Some("js");
	}
	if command == b"gh" && matches!(previous, Some(b"--jq" | b"-q")) {
		return Some("jq");
	}
	if command == b"curl"
		&& matches!(previous, Some(b"-d" | b"--data" | b"--data-raw" | b"--data-binary" | b"--json"))
	{
		return Some("json");
	}
	if matches!(command, b"docker" | b"podman") && previous == Some(b"--format") {
		return Some("gotmpl");
	}
	if !matches!(command, b"jq" | b"awk" | b"gawk" | b"grep" | b"egrep" | b"rg") {
		return None;
	}
	let language = match command {
		b"jq" => "jq",
		b"awk" | b"gawk" => "awk",
		_ => "regex",
	};
	let mut i = 1;
	while i < args.len() {
		let arg = args[i].as_str();
		if matches!(arg, "--arg" | "--argjson") {
			i += 3;
			continue;
		}
		if matches!(arg, "-e" | "--regexp") && language == "regex" {
			return (index == i + 1).then_some(language);
		}
		if matches!(
			arg,
			"-F"
				| "-f"
				| "-m"
				| "-A"
				| "-B"
				| "-C"
				| "--file"
				| "--argfile"
				| "--slurpfile"
				| "--rawfile"
		) {
			i += if matches!(arg, "--argfile" | "--slurpfile" | "--rawfile") {
				3
			} else {
				2
			};
			continue;
		}
		if arg == "--" {
			i += 1;
			return (index == i).then_some(language);
		}
		if arg.starts_with('-') {
			i += 1;
			continue;
		}
		return (index == i).then_some(language);
	}
	None
}

/// Language of a heredoc's body: what the program reading it runs it as
/// (`python3 - <<EOF`; `ssh host <<EOF` → the remote shell), else its `#!`
/// line, else a file the command names (`cat > lib.rs <<EOF`), else its
/// delimiter (`<<SQL`). `targets` are the command's output redirections.
pub fn heredoc_language(
	words: &[String],
	targets: &[String],
	delim: &str,
	body: &str,
) -> &'static str {
	stdin_language(words)
		.or_else(|| shebang(body))
		.or_else(|| words.iter().chain(targets).find_map(|w| extension(w)))
		.unwrap_or_else(|| delimiter(delim))
}

/// Language the command line's program reads its stdin as.
fn stdin_language(words: &[String]) -> Option<&'static str> {
	let launch = launch(words);
	match &words[launch.at..] {
		[] => launch.remote.then_some("bash"),
		// `ssh` joins its remote words into one command line (`'bash -s'`).
		[line] if launch.remote => stdin_language(
			&line
				.split_ascii_whitespace()
				.map(str::to_owned)
				.collect::<Vec<_>>(),
		),
		[program, ..] => interpreter(program),
	}
}

/// Language `program` runs a script or message in (`python3` → `py`, `git` →
/// `commit`).
fn interpreter(program: &str) -> Option<&'static str> {
	let name = basename_str(program);
	Some(match name {
		_ if name.starts_with("python") => "py",
		"node" | "bun" | "deno" => "js",
		"git" => "commit",
		"psql" | "mysql" | "sqlite3" | "duckdb" => "sql",
		_ if SHELLS.contains(&name.as_bytes()) => "bash",
		_ => return None,
	})
}

/// Language a `#!` line names (`#!/usr/bin/env python3` → `py`).
fn shebang(body: &str) -> Option<&'static str> {
	let line = body.strip_prefix("#!")?.lines().next()?;
	let mut words = line.split_ascii_whitespace();
	let program = words.next()?;
	if basename_str(program) == "env" {
		return interpreter(words.find(|w| !w.starts_with('-') && !assignment(w.as_bytes()))?);
	}
	interpreter(program)
}

/// Language of a file by its extension (`src/lib.rs` → `rust`).
fn extension(path: &str) -> Option<&'static str> {
	Some(match Path::new(path).extension()?.to_str()? {
		"py" | "pyi" => "py",
		"js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" => "js",
		"json" => "json",
		"toml" => "toml",
		"sh" | "bash" | "zsh" => "bash",
		"sql" => "sql",
		"yml" | "yaml" => "yaml",
		"rs" => "rust",
		"go" => "go",
		"c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "cu" | "cuh" | "m" | "mm" => "c",
		"swift" => "swift",
		"css" => "css",
		"html" | "htm" => "html",
		_ => return None,
	})
}

/// Language a heredoc delimiter names (`<<SQL`).
fn delimiter(delim: &str) -> &'static str {
	match delim.to_ascii_uppercase().as_str() {
		"PY" | "PYTHON" => "py",
		"JS" | "JAVASCRIPT" | "TS" => "js",
		"JSON" => "json",
		"TOML" => "toml",
		"SH" | "BASH" | "SHELL" => "bash",
		"SQL" => "sql",
		"YAML" | "YML" => "yaml",
		"AWK" => "awk",
		"JQ" => "jq",
		"HTML" => "html",
		"CSS" => "css",
		_ => "text",
	}
}

fn keyword(language: &str, s: &str) -> bool {
	let words = match language {
		"py" => {
			"import from as for in if elif else while def return with break continue pass not and or \
			 is None True False lambda class try except finally raise yield async await"
		},
		"js" | "ts" => {
			"import from export const let var function return if else for of in new await async true \
			 false null undefined typeof class throw try catch"
		},
		"jq" => {
			"if then elif else end select map keys length join and or not as def reduce empty test \
			 split tostring tonumber"
		},
		"awk" => "BEGIN END print printf if else for while in int length split substr NR NF",
		"json" | "toml" | "yaml" => "true false null",
		"gotmpl" => "range end if else with json join printf define template block",
		"bash" | "sh" => {
			"if then elif else fi for in do done while until case esac function select local export \
			 return"
		},
		"sql" => {
			"select from where insert into values update set delete create table join on as and or \
			 not null true false group by order having limit union distinct"
		},
		"rust" => {
			"as async await break const continue crate dyn else enum extern false fn for if impl in \
			 let loop match mod move mut pub ref return self Self static struct super trait true type \
			 unsafe use where while"
		},
		"go" => {
			"break case chan const continue default defer else fallthrough for func go goto if import \
			 interface map package range return select struct switch type var nil true false"
		},
		"c" => {
			"auto break case char const continue default do double else enum extern float for goto if \
			 inline int long register return short signed sizeof static struct switch typedef union \
			 unsigned void volatile while bool true false NULL nullptr class namespace template \
			 typename public private protected virtual new delete this using"
		},
		"swift" => {
			"import func let var if else guard return struct class enum protocol extension for in \
			 while repeat switch case default break continue true false nil self Self init throws \
			 throw try catch async await public private internal fileprivate static override final \
			 mutating weak defer where is as"
		},
		_ => "",
	};
	words.split_ascii_whitespace().any(|w| {
		if language == "sql" {
			w.eq_ignore_ascii_case(s)
		} else {
			w == s
		}
	})
}
/// Whether a Rust `'` followed by `rest` opens a lifetime (`'a`), not a char
/// literal (`'a'`, `'\n'`).
fn lifetime(rest: &str) -> bool {
	let mut chars = rest.chars();
	!matches!((chars.next(), chars.next()), (Some('\\'), _) | (Some(_), Some('\'')))
}
pub fn highlight(
	text: &str,
	language: &str,
	node: NodeKey,
	range: Option<[u32; 2]>,
	layers: Layers,
) -> Vec<Segment> {
	let mut result: Vec<Segment> = Vec::new();
	let mut i = 0;
	let b = text.as_bytes();
	while i < b.len() {
		let start = i;
		let mut style = "";
		let hash_comment =
			matches!(language, "py" | "toml" | "yaml" | "bash" | "sh" | "awk" | "commit");
		let c_comments = matches!(language, "js" | "ts" | "rust" | "go" | "c" | "swift");
		if (hash_comment && b[i] == b'#')
			|| ((c_comments || language == "jsonc") && text[i..].starts_with("//"))
			|| (language == "sql" && text[i..].starts_with("--"))
		{
			while i < b.len() && b[i] != b'\n' {
				i += 1;
			}
			style = "comment";
		} else if (c_comments || language == "css") && text[i..].starts_with("/*") {
			i += 2;
			while i < b.len() && !text[i..].starts_with("*/") {
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			if i < b.len() {
				i += 2;
			}
			style = "comment";
		} else if matches!(b[i], b'\'' | b'"' | b'`')
			&& language != "regex"
			&& !(language == "rust" && lifetime(&text[i + 1..]))
		{
			let q = b[i];
			let triple = language == "py" && b.get(i + 1) == Some(&q) && b.get(i + 2) == Some(&q);
			i += if triple { 3 } else { 1 };
			while i < b.len() {
				if b[i] == b'\\' {
					i += 1;
					if i < b.len() {
						i += text[i..].chars().next().unwrap().len_utf8();
					}
					continue;
				}
				if b[i] == q && (!triple || (b.get(i + 1) == Some(&q) && b.get(i + 2) == Some(&q))) {
					i += if triple { 3 } else { 1 };
					break;
				}
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			style = if language == "json" && text[i..].trim_start().starts_with(':') {
				"key"
			} else {
				"str"
			};
		} else if language == "regex" && b[i] == b'\\' {
			i += 1;
			if i < b.len() {
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			style = "field";
		} else if language == "regex" && b[i] == b'[' {
			i += 1;
			while i < b.len() {
				if b[i] == b'\\' {
					i += 1;
					if i < b.len() {
						i += text[i..].chars().next().unwrap().len_utf8();
					}
					continue;
				}
				if b[i] == b']' {
					i += 1;
					break;
				}
				i += text[i..].chars().next().unwrap().len_utf8();
			}
			style = "section";
		} else if b[i].is_ascii_digit() {
			i += 1;
			while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.' || b[i] == b'_') {
				i += 1;
			}
			style = "num";
		} else if b[i].is_ascii_alphabetic() || matches!(b[i], b'_' | b'$') {
			i += 1;
			while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'$')) {
				i += 1;
			}
			let word = &text[start..i];
			if keyword(language, word) {
				style = "kw";
			} else if text[i..].trim_start().starts_with('(') {
				style = "fn";
			} else if word.starts_with('$') {
				style = "var";
			} else if matches!(language, "toml" | "yaml")
				&& (text[i..].trim_start().starts_with('=') || text[i..].trim_start().starts_with(':'))
			{
				style = "key";
			}
		} else {
			let c = text[i..].chars().next().unwrap();
			i += c.len_utf8();
			if language == "regex" && "^$".contains(c) {
				style = "kw";
			} else if language == "regex" && "*+?{}".contains(c) {
				style = "num";
			} else if "{}[]()|=+*/<>!:,;.".contains(c) {
				style = "op";
			}
			if c == '.' && matches!(language, "jq" | "gotmpl") {
				while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
					i += 1;
				}
				style = "field";
			}
		}
		let style = if layers.color && !style.is_empty() {
			Some(style.to_owned())
		} else {
			None
		};
		if let Some(last) = result.last_mut()
			&& last.style == style
		{
			last.text.push_str(&text[start..i]);
			continue;
		}
		result.push(Segment {
			text: text[start..i].to_owned(),
			style,
			node: Some(node),
			range,
			language: Some(language.to_owned()),
			..Segment::default()
		});
	}
	result
}
#[cfg(test)]
mod tests {
	use super::*;
	fn owned(words: &[&str]) -> Vec<String> {
		words.iter().map(|w| (*w).to_owned()).collect()
	}
	fn heredoc(words: &[&str], target: &str, body: &str) -> &'static str {
		heredoc_language(&owned(words), &owned(&[target]), "EOF", body)
	}
	fn argument(words: &[&str], index: usize) -> Option<&'static str> {
		argument_language(&owned(words), index)
	}
	#[test]
	fn option_operands_are_not_programs() {
		let a = ["jq", "--arg", "name", "value", ".name"];
		assert_eq!(argument(&a, 3), None);
		assert_eq!(argument(&a, 4), Some("jq"));
	}
	#[test]
	fn heredocs_are_read_by_the_program_behind_launchers() {
		assert_eq!(heredoc(&["uv", "run", "--with", "numpy", "python", "-"], "", ""), "py");
		assert_eq!(heredoc(&["timeout", "-k", "5", "60", "python3", "-"], "", ""), "py");
		assert_eq!(heredoc(&["sudo", "-u", "root", "env", "A=1", "bash"], "", ""), "bash");
		// No remote command: the remote login shell reads the script.
		assert_eq!(heredoc(&["ssh", "-o", "BatchMode=yes", "host"], "", ""), "bash");
		assert_eq!(heredoc(&["ssh", "host", "sudo bash -s"], "", ""), "bash");
		assert_eq!(heredoc(&["ssh", "host", "python3", "-"], "", ""), "py");
		assert_eq!(heredoc(&["ssh", "host", "uptime"], "", ""), "text");
	}
	#[test]
	fn heredoc_without_a_reader_is_named_by_shebang_then_target() {
		assert_eq!(heredoc(&["cat"], "/tmp/run", "#!/usr/bin/env -S python3 -u\nimport os"), "py");
		assert_eq!(heredoc(&["cat"], "x.json", "#!/bin/sh\necho"), "bash");
		assert_eq!(heredoc(&["cat"], "/src/lib.rs", ""), "rust");
		// A bare word is no file extension.
		assert_eq!(heredoc(&["cat"], "py", ""), "text");
	}
	#[test]
	fn inline_programs_are_found_behind_launchers() {
		assert_eq!(argument(&["uv", "run", "python", "-c", "code"], 4), Some("py"));
		assert_eq!(argument(&["env", "-i", "A=1", "bun", "-e", "code"], 5), Some("js"));
		assert_eq!(argument(&["docker", "run", "--rm", "img", "bash", "-euc", "s"], 6), Some("bash"));
		assert_eq!(argument(&["ssh", "-p", "22", "host", "script"], 4), Some("bash"));
		assert_eq!(argument(&["ssh", "host", "ls", "-la"], 2), None);
		assert_eq!(shell_script(&owned(&["ssh", "host", "bash", "-c", "s"])), Some((4, true)));
		assert_eq!(shell_script(&owned(&["bash", "--rcfile", "x", "-c", "s"])), None);
	}
	#[test]
	fn rust_lifetimes_do_not_open_strings() {
		let s = highlight(
			"fn f<'a>(s: &'a str) -> char { 'x' }",
			"rust",
			NodeKey::engine(0, crate::bash::syntax::NodeId::default()),
			None,
			Layers::default(),
		);
		let strings: Vec<&str> = s
			.iter()
			.filter(|s| s.style.as_deref() == Some("str"))
			.map(|s| s.text.as_str())
			.collect();
		assert_eq!(strings, ["'x'"]);
	}
	#[test]
	fn tokenization_preserves_unicode_and_rows() {
		let t = "print('λ')\n# comment\n";
		let s = highlight(
			t,
			"py",
			NodeKey::engine(0, crate::bash::syntax::NodeId::default()),
			None,
			Layers::default(),
		);
		assert_eq!(s.iter().map(|s| s.text.as_str()).collect::<String>(), t);
		assert!(s.iter().any(|s| s.style.as_deref() == Some("comment")));
	}
	#[test]
	fn windows_launchers_match_case_insensitively_without_affecting_unix() {
		assert_eq!(launch_for(&["C:\\Tools\\BUN.EXE", "x", "omp", "read"], true).at, 2);
		assert_eq!(launch_for(&["NPX.CMD", "-y", "omp", "read"], true).at, 2);
		assert_eq!(launch_for(&["bun.exe", "x", "omp", "read"], false).at, 0);
		assert_eq!(launch_for(&["npx.cmd", "-y", "omp", "read"], false).at, 0);
	}
}
