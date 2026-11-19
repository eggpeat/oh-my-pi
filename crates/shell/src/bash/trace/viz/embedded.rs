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

fn operand<W: AsRef<[u8]>>(words: &[W], from: usize, takes_value: impl Fn(&[u8]) -> bool) -> usize {
	let mut i = from;
	while let Some(word) = words.get(i).map(AsRef::as_ref) {
		if word == b"--" {
			return i + 1;
		}
		if !word.starts_with(b"-") || word == b"-" {
			break;
		}
		i += if takes_value(word) { 2 } else { 1 };
	}
	i
}

/// Words a launcher at the start of `words` takes before the command it runs
/// (`timeout 5 cmd` → 2), and whether that command runs on an `ssh` host.
fn launcher<W: AsRef<[u8]>>(words: &[W]) -> Option<(usize, bool)> {
	let skip = match basename(words.first()?.as_ref()) {
		b"env"
			if words
				.iter()
				.skip(1)
				.any(|w| matches!(w.as_ref(), b"-S" | b"--split-string")) =>
		{
			return None;
		},
		b"env" => {
			let at = operand(words, 1, |w| {
				matches!(w, b"-u" | b"--unset" | b"-C" | b"--chdir" | b"-S" | b"--split-string" | b"-P")
			});
			at + words
				.iter()
				.skip(at)
				.take_while(|w| assignment(w.as_ref()))
				.count()
		},
		b"sudo" | b"doas"
			if words
				.iter()
				.skip(1)
				.any(|w| matches!(w.as_ref(), b"-e" | b"-C" | b"-L")) =>
		{
			return None;
		},
		b"sudo" | b"doas" => {
			let at = operand(words, 1, |w| {
				matches!(
					w,
					b"-u"
						| b"-g"
						| b"-C"
						| b"-D"
						| b"-h"
						| b"-p"
						| b"-R"
						| b"-r"
						| b"-T"
						| b"-t"
						| b"-U"
						| b"--user"
						| b"--group"
						| b"--close-from"
						| b"--chdir"
						| b"--host"
						| b"--prompt"
						| b"--chroot"
						| b"--role"
						| b"--command-timeout"
						| b"--type"
						| b"--other-user"
				)
			});
			at + words
				.iter()
				.skip(at)
				.take_while(|w| assignment(w.as_ref()))
				.count()
		},
		// The first operand is the duration.
		b"timeout" | b"gtimeout" => {
			operand(words, 1, |w| matches!(w, b"-s" | b"--signal" | b"-k" | b"--kill-after")) + 1
		},
		b"nice" => operand(words, 1, |w| matches!(w, b"-n" | b"--adjustment")),
		b"nohup" | b"time" => {
			operand(words, 1, |w| matches!(w, b"-o" | b"--output" | b"-f" | b"--format"))
		},
		b"stdbuf" => operand(words, 1, |w| {
			matches!(w, b"-i" | b"-o" | b"-e" | b"--input" | b"--output" | b"--error")
		}),
		b"exec" => operand(words, 1, |w| w == b"-a"),
		b"uv" if words.get(1).is_some_and(|w| w.as_ref() == b"run") => operand(words, 2, |w| {
			matches!(
				w,
				b"--with"
					| b"--with-editable"
					| b"--with-requirements"
					| b"-p"
					| b"--python"
					| b"--package"
					| b"--project"
					| b"--directory"
					| b"--env-file"
					| b"--extra"
					| b"--group"
					| b"--only-group"
					| b"--no-group"
					| b"--index"
					| b"--default-index"
					| b"-i"
					| b"--index-url"
					| b"--extra-index-url"
					| b"-f"
					| b"--find-links"
					| b"--config-file"
					| b"--cache-dir"
			)
		}),
		b"npx" | b"bunx" => operand(words, 1, |w| {
			matches!(w, b"-p" | b"--package" | b"-w" | b"--workspace" | b"--cwd" | b"--config")
		}),
		b"bun" if words.get(1).is_some_and(|w| w.as_ref() == b"x") => {
			operand(words, 2, |w| matches!(w, b"-p" | b"--package" | b"--cwd" | b"--config"))
		},
		b"pnpm" | b"yarn"
			if words
				.get(1)
				.is_some_and(|w| matches!(w.as_ref(), b"dlx" | b"exec")) =>
		{
			operand(words, 2, |w| matches!(w, b"-p" | b"--package" | b"-w" | b"--workspace"))
		},
		b"npm"
			if words
				.get(1)
				.is_some_and(|w| matches!(w.as_ref(), b"exec" | b"x")) =>
		{
			operand(words, 2, |w| matches!(w, b"-p" | b"--package" | b"-w" | b"--workspace"))
		},
		b"ssh" => {
			let host = operand(words, 1, |w| w.len() == 2 && b"pilojFSLRDWbcEemOQw".contains(&w[1]));
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

pub(crate) fn launch<W: AsRef<[u8]>>(words: &[W]) -> Launch {
	let mut launch = Launch { at: 0, remote: false };
	while let Some((skip, remote)) = launcher(&words[launch.at..]) {
		launch.at = (launch.at + skip).min(words.len());
		launch.remote |= remote;
	}
	launch
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
}
