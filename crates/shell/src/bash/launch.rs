//! The program a command line runs after its launchers and their options.
//!
//! The host URL resolver and trace highlighting both need the same answer:
//! an option's value is not the program, and a wrapper's own file arguments
//! belong to the wrapper rather than to the program it eventually runs.

use std::borrow::Cow;

use smallvec::SmallVec;

/// A command line past its launchers (`env`, `timeout`, `sudo`, `uv run`,
/// `ssh host`, …).
pub(crate) struct Launch {
	/// Index of the word naming the program; for `ssh`, of its first remote
	/// word, if any (none: the remote login shell runs stdin).
	pub(crate) at:     usize,
	/// The program runs on an `ssh` host.
	pub(crate) remote: bool,
}

/// Where `omp` starts in a command line, plus any inherited environment
/// assignments (`env SOURCE=…`, `sudo SOURCE=…`, leading shell assignments)
/// that belong to `omp` rather than to the launcher itself.
pub(crate) struct OmpLaunch {
	/// Argument indices at or after this position are `omp`'s own arguments.
	literal_from: usize,
	/// Original argument indices holding environment assignments inherited by
	/// `omp`.
	env_indices:  SmallVec<[usize; 4]>,
}

impl OmpLaunch {
	pub(crate) fn is_literal(&self, index: usize) -> bool {
		index >= self.literal_from || self.env_indices.contains(&index)
	}
}

#[derive(Clone, Copy)]
enum Origin {
	/// Directly from `words[index]`.
	Arg(usize),
	/// Produced by splitting `env -S` from `words[index]`.
	Split { index: usize, sole_word: bool },
}

impl Origin {
	const fn index(self) -> usize {
		match self {
			Self::Arg(i) | Self::Split { index: i, .. } => i,
		}
	}
}

struct LaunchWord<'a> {
	text:   Cow<'a, str>,
	bytes:  Option<&'a [u8]>,
	origin: Origin,
}

trait WordSlice {
	fn len(&self) -> usize;
	fn text(&self, index: usize) -> &str;
	fn bytes(&self, index: usize) -> &[u8];
	fn origin(&self, index: usize) -> Origin;
}

impl<T: AsRef<[u8]>> WordSlice for [T] {
	fn len(&self) -> usize {
		<[T]>::len(self)
	}

	fn text(&self, index: usize) -> &str {
		std::str::from_utf8(self[index].as_ref()).unwrap_or("")
	}

	fn bytes(&self, index: usize) -> &[u8] {
		self[index].as_ref()
	}

	fn origin(&self, index: usize) -> Origin {
		Origin::Arg(index)
	}
}

impl WordSlice for [LaunchWord<'_>] {
	fn len(&self) -> usize {
		<[LaunchWord<'_>]>::len(self)
	}

	fn text(&self, index: usize) -> &str {
		&self[index].text
	}

	fn bytes(&self, index: usize) -> &[u8] {
		self[index]
			.bytes
			.unwrap_or_else(|| self[index].text.as_bytes())
	}

	fn origin(&self, index: usize) -> Origin {
		self[index].origin
	}
}

/// Normalized launcher command name (path stripped; on Windows also
/// case-folded with `.exe`/`.cmd`/`.bat`/`.com` stripped) without heap
/// allocation.
fn launcher_name<'a>(word: &'a str, windows: bool, buf: &'a mut [u8; 16]) -> &'a str {
	let base = word
		.rsplit(|c| c == '/' || (windows && c == '\\'))
		.next()
		.unwrap_or(word);
	if !windows {
		return base;
	}
	let stripped = if let Some((stem, ext)) = base.rsplit_once('.')
		&& (ext.eq_ignore_ascii_case("exe")
			|| ext.eq_ignore_ascii_case("cmd")
			|| ext.eq_ignore_ascii_case("bat")
			|| ext.eq_ignore_ascii_case("com"))
	{
		stem
	} else {
		base
	};
	if stripped.len() > buf.len() || !stripped.is_ascii() {
		return "";
	}
	for (dst, &src) in buf.iter_mut().zip(stripped.as_bytes()) {
		*dst = src.to_ascii_lowercase();
	}
	std::str::from_utf8(&buf[..stripped.len()]).unwrap_or("")
}

/// Whether `word` names the `omp` program, by any path.
pub(crate) fn is_omp(word: &[u8], windows: bool) -> bool {
	let name = word
		.rsplit(|&b| b == b'/' || (windows && b == b'\\'))
		.next()
		.unwrap_or(word);
	if !windows {
		return name == b"omp";
	}
	name.eq_ignore_ascii_case(b"omp")
		|| name.eq_ignore_ascii_case(b"omp.exe")
		|| name.eq_ignore_ascii_case(b"omp.cmd")
		|| name.eq_ignore_ascii_case(b"omp.bat")
		|| name.eq_ignore_ascii_case(b"omp.com")
}

/// `NAME=VALUE`, as `sudo` takes before the command it runs.
fn plain_assignment(word: &str) -> bool {
	word.split_once('=').is_some_and(|(name, _)| {
		name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
			&& name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
	})
}

/// Shell variable assignment (`NAME=VALUE`, `NAME+=VALUE`, `NAME[idx]=VALUE`).
pub(crate) fn assignment(word: &str) -> bool {
	word.split_once('=').is_some_and(|(lhs, _)| {
		let lhs = lhs.strip_suffix('+').unwrap_or(lhs);
		let name = lhs
			.split_once('[')
			.map_or(lhs, |(n, rest)| if rest.ends_with(']') { n } else { "" });
		name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
			&& name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
	})
}

/// `env` accepts names a shell assignment would reject (`tool.name=value`).
fn env_assignment(word: &str) -> bool {
	word
		.split_once('=')
		.is_some_and(|(name, _)| !name.is_empty())
}

/// Option grammar for a launcher.
struct OptionSpec {
	/// Long options (`--foo`) whose value is the next word when written without
	/// `=`.
	long_value:     &'static [&'static str],
	/// Short option letters whose value is either attached or the next word.
	short_value:    &'static str,
	/// Short option letters with an optional attached value (stop cluster scan,
	/// never take next word).
	short_optional: &'static str,
	/// Long options that switch the launcher to a non-executing mode (edit,
	/// script, module, lookup).
	long_abort:     &'static [&'static str],
	/// Short option letters that switch the launcher to a non-executing mode.
	short_abort:    &'static str,
}

impl OptionSpec {
	const EMPTY: Self = Self {
		long_value:     &[],
		short_value:    "",
		short_optional: "",
		long_abort:     &[],
		short_abort:    "",
	};
}

enum ScanOutcome {
	Operand { at: usize, after_double_dash: bool },
	Abort,
}

/// Scan options starting at `from`, handling grouped short flags, attached
/// values, optional attached values, `--`, and non-executing mode flags.
fn scan_options<W: WordSlice + ?Sized>(words: &W, from: usize, spec: &OptionSpec) -> ScanOutcome {
	let mut i = from;
	while i < words.len() {
		let w = words.text(i);
		if w == "--" {
			return ScanOutcome::Operand { at: i + 1, after_double_dash: true };
		}
		if !w.starts_with('-') || w == "-" {
			return ScanOutcome::Operand { at: i, after_double_dash: false };
		}
		if w.starts_with("--") {
			let name = w.split_once('=').map_or(w, |(n, _)| n);
			if spec.long_abort.contains(&name) {
				return ScanOutcome::Abort;
			}
			let takes_next = !w.contains('=') && spec.long_value.contains(&w);
			i += if takes_next { 2 } else { 1 };
		} else {
			let mut takes_next = false;
			let mut chars = w[1..].chars();
			while let Some(c) = chars.next() {
				if spec.short_abort.contains(c) {
					return ScanOutcome::Abort;
				}
				if spec.short_value.contains(c) {
					takes_next = chars.as_str().is_empty();
					break;
				}
				if spec.short_optional.contains(c) {
					break;
				}
			}
			i += if takes_next { 2 } else { 1 };
		}
	}
	ScanOutcome::Operand { at: i, after_double_dash: false }
}

const SUDO_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--user",
		"--group",
		"--close-from",
		"--chdir",
		"--host",
		"--prompt",
		"--chroot",
		"--role",
		"--command-timeout",
		"--type",
		"--other-user",
	],
	short_value: "ugCDhpRrTtU",
	long_abort: &["--edit", "--list", "--version", "--help"],
	short_abort: "elV",
	..OptionSpec::EMPTY
};

const DOAS_SPEC: OptionSpec =
	OptionSpec { short_value: "ua", short_abort: "C", ..OptionSpec::EMPTY };

const TIMEOUT_SPEC: OptionSpec =
	OptionSpec { long_value: &["--signal", "--kill-after"], short_value: "sk", ..OptionSpec::EMPTY };

const NICE_SPEC: OptionSpec =
	OptionSpec { long_value: &["--adjustment"], short_value: "n", ..OptionSpec::EMPTY };

const TIME_SPEC: OptionSpec =
	OptionSpec { long_value: &["--output", "--format"], short_value: "of", ..OptionSpec::EMPTY };

const STDBUF_SPEC: OptionSpec = OptionSpec {
	long_value: &["--input", "--output", "--error"],
	short_value: "ioe",
	..OptionSpec::EMPTY
};

const EXEC_SPEC: OptionSpec = OptionSpec { short_value: "a", ..OptionSpec::EMPTY };

const COMMAND_SPEC: OptionSpec = OptionSpec { short_abort: "vV", ..OptionSpec::EMPTY };

const XARGS_SPEC: OptionSpec = OptionSpec {
	// `--replace`, `--eof`, and `--max-lines` take optional attached `=VALUE` in
	// GNU xargs, so they never consume a separate next word.
	long_value: &[
		"--arg-file",
		"--delimiter",
		"--max-args",
		"--max-procs",
		"--max-chars",
		"--process-slot-var",
	],
	short_value: "adEILnPs",
	short_optional: "iel",
	..OptionSpec::EMPTY
};

const NPM_GLOBAL_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--prefix",
		"--cache",
		"--registry",
		"--loglevel",
		"--userconfig",
		"--globalconfig",
		"--workspace",
		"--node-options",
		"--location",
		"--otp",
	],
	short_value: "w",
	..OptionSpec::EMPTY
};

const NPX_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--prefix",
		"--cache",
		"--registry",
		"--loglevel",
		"--userconfig",
		"--globalconfig",
		"--workspace",
		"--node-options",
		"--location",
		"--otp",
		"--package",
		"--npm",
	],
	short_value: "wp",
	long_abort: &["--call"],
	short_abort: "c",
	..OptionSpec::EMPTY
};

const NPM_EXEC_SPEC: OptionSpec = OptionSpec {
	// Unlike npx, npm's `-p` means parseable output, not a package.
	long_value: &[
		"--prefix",
		"--cache",
		"--registry",
		"--loglevel",
		"--userconfig",
		"--globalconfig",
		"--workspace",
		"--node-options",
		"--location",
		"--otp",
		"--package",
	],
	short_value: "w",
	long_abort: &["--call"],
	short_abort: "c",
	..OptionSpec::EMPTY
};

const BUNX_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--package",
		"--cwd",
		"--env-file",
		"--minimum-release-age",
		"--registry",
		"--ca",
		"--cafile",
		"--cache-dir",
		"--backend",
		"--linker",
		"--filter",
		"--config",
	],
	short_value: "pcF",
	..OptionSpec::EMPTY
};

const BUN_GLOBAL_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--cwd",
		"--env-file",
		"--config",
		"--filter",
		"--shell",
		"--preload",
		"--require",
		"--import",
		"--port",
		"--conditions",
		"--extension-order",
		"--tsconfig-override",
		"--define",
		"--drop",
		"--feature",
		"--loader",
		"--jsx-factory",
		"--jsx-fragment",
		"--jsx-import-source",
		"--jsx-runtime",
		"--install",
		"--elide-lines",
		"--console-depth",
		"--user-agent",
		"--main-fields",
		"--unhandled-rejections",
		"--dns-result-order",
		"--max-http-header-size",
		"--redirect-warnings",
		"--disable-warning",
		"--title",
		"--cpu-prof-name",
		"--cpu-prof-dir",
		"--cpu-prof-interval",
		"--heap-prof-name",
		"--heap-prof-dir",
		"--heap-prof-interval",
		"--fetch-preconnect",
		"--cron-title",
		"--cron-period",
	],
	short_value: "Frcdl",
	long_abort: &["--eval", "--print"],
	short_abort: "ep",
	..OptionSpec::EMPTY
};

const UV_GLOBAL_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--directory",
		"--project",
		"--config-file",
		"--cache-dir",
		"--color",
		"--allow-insecure-host",
		"--python-preference",
		"--python-fetch",
	],
	..OptionSpec::EMPTY
};

const UV_RUN_SPEC: OptionSpec = OptionSpec {
	long_value: &[
		"--with",
		"--with-editable",
		"--with-requirements",
		"--python",
		"--package",
		"--project",
		"--directory",
		"--env-file",
		"--extra",
		"--no-extra",
		"--group",
		"--only-group",
		"--no-group",
		"--no-editable-package",
		"--python-platform",
		"--index",
		"--default-index",
		"--index-url",
		"--extra-index-url",
		"--find-links",
		"--config-file",
		"--cache-dir",
	],
	short_value: "wpif",
	long_abort: &["--module", "--script", "--gui-script"],
	short_abort: "ms",
	..OptionSpec::EMPTY
};

const SSH_SPEC: OptionSpec =
	OptionSpec { short_value: "BbcDEeFIiJLlmOopQRSWw", short_abort: "GV", ..OptionSpec::EMPTY };

/// Split the operand of `env -S` / `--split-string` into words.
fn split_env_string(input: &str) -> Vec<String> {
	let mut words = Vec::new();
	let mut current = String::new();
	let mut in_word = false;
	let mut quote: Option<char> = None;
	let mut chars = input.chars().peekable();
	while let Some(ch) = chars.next() {
		if let Some(q) = quote {
			if ch == '\\'
				&& let Some(&next) = chars.peek()
				&& (next == q || next == '\\')
			{
				current.push(next);
				chars.next();
			} else if ch == q {
				quote = None;
			} else {
				current.push(ch);
			}
			continue;
		}
		if ch.is_ascii_whitespace() {
			if in_word {
				words.push(std::mem::take(&mut current));
				in_word = false;
			}
			continue;
		}
		if ch == '#' && !in_word {
			break;
		}
		in_word = true;
		match ch {
			'\'' | '"' => quote = Some(ch),
			'\\' => {
				if let Some(next) = chars.next() {
					match next {
						'_' => current.push(' '),
						't' => current.push('\t'),
						'n' => current.push('\n'),
						'r' => current.push('\r'),
						'c' => break,
						_ => current.push(next),
					}
				}
			},
			_ => current.push(ch),
		}
	}
	if in_word {
		words.push(current);
	}
	words
}

const ENV_LONG_VALUE: &[&str] = &["--unset", "--chdir", "--file", "--argv0"];
const ENV_SHORT_VALUE: &str = "uCfPa";

enum EnvStep<'a> {
	Done(usize),
	Splice(Vec<LaunchWord<'a>>),
}

/// Advance past `env`'s options, optional `-`, and `NAME=VALUE` settings.
/// If `-S` / `--split-string` is encountered (and splits remain), returns a
/// spliced word list so the caller re-runs `env` parsing on the expanded args.
fn step_env<'a, W: WordSlice + ?Sized>(
	words: &'a W,
	from: usize,
	splits_remaining: usize,
	env_indices: &mut SmallVec<[usize; 4]>,
) -> EnvStep<'a> {
	let mut i = from;
	while i < words.len() {
		let w = words.text(i);
		if w == "--" {
			i += 1;
			break;
		}
		if !w.starts_with('-') || w == "-" {
			break;
		}
		if w.starts_with("--") {
			if splits_remaining > 0 {
				if w == "--split-string" {
					let Some((split_text, src, rest_from)) = (i + 1 < words.len())
						.then(|| (words.text(i + 1), words.origin(i + 1).index(), i + 2))
					else {
						return EnvStep::Done(words.len());
					};
					return EnvStep::Splice(build_env_splice(words, split_text, src, true, rest_from));
				}
				if let Some(split_text) = w.strip_prefix("--split-string=") {
					let src = words.origin(i).index();
					return EnvStep::Splice(build_env_splice(words, split_text, src, false, i + 1));
				}
			} else if w == "--split-string" {
				i += 2;
				continue;
			}
			let takes_next = !w.contains('=') && ENV_LONG_VALUE.contains(&w);
			i += if takes_next { 2 } else { 1 };
		} else {
			let mut takes_next = false;
			let mut chars = w[1..].chars();
			while let Some(c) = chars.next() {
				if c == 'S' {
					let rest = chars.as_str();
					if splits_remaining > 0 {
						if !rest.is_empty() {
							let src = words.origin(i).index();
							return EnvStep::Splice(build_env_splice(words, rest, src, false, i + 1));
						}
						let Some((split_text, src, rest_from)) = (i + 1 < words.len())
							.then(|| (words.text(i + 1), words.origin(i + 1).index(), i + 2))
						else {
							return EnvStep::Done(words.len());
						};
						return EnvStep::Splice(build_env_splice(
							words, split_text, src, true, rest_from,
						));
					}
					takes_next = rest.is_empty();
					break;
				}
				if ENV_SHORT_VALUE.contains(c) {
					takes_next = chars.as_str().is_empty();
					break;
				}
			}
			i += if takes_next { 2 } else { 1 };
		}
	}
	if i < words.len() && words.text(i) == "-" {
		i += 1;
	}
	while i < words.len() && env_assignment(words.text(i)) {
		record_env_origin(words.origin(i), env_indices);
		i += 1;
	}
	EnvStep::Done(i)
}

fn build_env_splice<'a, W: WordSlice + ?Sized>(
	words: &'a W,
	split_text: &str,
	src_index: usize,
	separate_word: bool,
	rest_from: usize,
) -> Vec<LaunchWord<'a>> {
	let pieces = split_env_string(split_text);
	let sole_word = separate_word && pieces.len() == 1;
	let mut spliced = Vec::with_capacity(pieces.len() + words.len().saturating_sub(rest_from));
	for piece in pieces {
		spliced.push(LaunchWord {
			text:   Cow::Owned(piece),
			bytes:  None,
			origin: Origin::Split { index: src_index, sole_word },
		});
	}
	for j in rest_from..words.len() {
		spliced.push(LaunchWord {
			text:   Cow::Borrowed(words.text(j)),
			bytes:  Some(words.bytes(j)),
			origin: words.origin(j),
		});
	}
	spliced
}

fn record_env_origin(origin: Origin, env_indices: &mut SmallVec<[usize; 4]>) {
	match origin {
		Origin::Arg(idx) | Origin::Split { index: idx, sole_word: true } => {
			if !env_indices.contains(&idx) {
				env_indices.push(idx);
			}
		},
		Origin::Split { sole_word: false, .. } => {},
	}
}

enum StepResult<'a> {
	Advance { at: usize, remote: bool },
	SpliceEnv(Vec<LaunchWord<'a>>),
	Stop,
}

/// Advance past one launcher at `from`, recording inherited environment
/// assignments into `env_indices`.
fn step_launcher<'a, W: WordSlice + ?Sized>(
	words: &'a W,
	from: usize,
	windows: bool,
	splits_remaining: usize,
	env_indices: &mut SmallVec<[usize; 4]>,
) -> StepResult<'a> {
	let raw = words.text(from);
	let mut buf = [0u8; 16];
	let program = launcher_name(raw, windows, &mut buf);
	match program {
		"env" => match step_env(words, from + 1, splits_remaining, env_indices) {
			EnvStep::Done(at) => StepResult::Advance { at, remote: false },
			EnvStep::Splice(spliced) => StepResult::SpliceEnv(spliced),
		},
		"sudo" => match scan_options(words, from + 1, &SUDO_SPEC) {
			ScanOutcome::Operand { mut at, .. } => {
				while at < words.len() && plain_assignment(words.text(at)) {
					record_env_origin(words.origin(at), env_indices);
					at += 1;
				}
				StepResult::Advance { at, remote: false }
			},
			ScanOutcome::Abort => StepResult::Stop,
		},
		"doas" => match scan_options(words, from + 1, &DOAS_SPEC) {
			ScanOutcome::Operand { mut at, .. } => {
				while at < words.len() && plain_assignment(words.text(at)) {
					record_env_origin(words.origin(at), env_indices);
					at += 1;
				}
				StepResult::Advance { at, remote: false }
			},
			ScanOutcome::Abort => StepResult::Stop,
		},
		"timeout" | "gtimeout" => match scan_options(words, from + 1, &TIMEOUT_SPEC) {
			// The first operand is the duration.
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at: at + 1, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"nice" => match scan_options(words, from + 1, &NICE_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"nohup" | "setsid" | "ifne" => match scan_options(words, from + 1, &OptionSpec::EMPTY) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"command" => match scan_options(words, from + 1, &COMMAND_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"time" => match scan_options(words, from + 1, &TIME_SPEC) {
			ScanOutcome::Operand { mut at, .. } => {
				// Bare `time` is a shell reserved word, so assignments after it
				// precede the command.
				if raw == "time" {
					while at < words.len() && assignment(words.text(at)) {
						record_env_origin(words.origin(at), env_indices);
						at += 1;
					}
				}
				StepResult::Advance { at, remote: false }
			},
			ScanOutcome::Abort => StepResult::Stop,
		},
		"stdbuf" => match scan_options(words, from + 1, &STDBUF_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"exec" => match scan_options(words, from + 1, &EXEC_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"xargs" => match scan_options(words, from + 1, &XARGS_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"npx" => match scan_options(words, from + 1, &NPX_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"bunx" => match scan_options(words, from + 1, &BUNX_SPEC) {
			ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
			ScanOutcome::Abort => StepResult::Stop,
		},
		"npm" => match scan_options(words, from + 1, &NPM_GLOBAL_SPEC) {
			ScanOutcome::Operand { at, after_double_dash: false }
				if at < words.len() && words.text(at) == "exec" =>
			{
				match scan_options(words, at + 1, &NPM_EXEC_SPEC) {
					ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
					ScanOutcome::Abort => StepResult::Stop,
				}
			},
			_ => StepResult::Stop,
		},
		"bun" => match scan_options(words, from + 1, &BUN_GLOBAL_SPEC) {
			ScanOutcome::Operand { at, after_double_dash: false }
				if at < words.len() && words.text(at) == "x" =>
			{
				match scan_options(words, at + 1, &BUNX_SPEC) {
					ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
					ScanOutcome::Abort => StepResult::Stop,
				}
			},
			_ => StepResult::Stop,
		},
		"uv" => match scan_options(words, from + 1, &UV_GLOBAL_SPEC) {
			ScanOutcome::Operand { at, after_double_dash: false }
				if at < words.len() && words.text(at) == "run" =>
			{
				match scan_options(words, at + 1, &UV_RUN_SPEC) {
					ScanOutcome::Operand { at, .. } => StepResult::Advance { at, remote: false },
					ScanOutcome::Abort => StepResult::Stop,
				}
			},
			_ => StepResult::Stop,
		},
		"ssh" => match scan_options(words, from + 1, &SSH_SPEC) {
			ScanOutcome::Operand { at: host, .. } if host < words.len() => {
				StepResult::Advance { at: host + 1, remote: true }
			},
			_ => StepResult::Stop,
		},
		_ => StepResult::Stop,
	}
}

struct Resolved {
	at:     usize,
	remote: bool,
	omp:    Option<OmpLaunch>,
}

fn resolve_slice<W: WordSlice + ?Sized>(
	words: &W,
	mut at: usize,
	orig_len: usize,
	windows: bool,
	mut remote: bool,
	splits_remaining: usize,
	env_indices: &mut SmallVec<[usize; 4]>,
	in_env: bool,
) -> Resolved {
	if in_env {
		match step_env(words, at, splits_remaining, env_indices) {
			EnvStep::Done(next) => at = next.min(words.len()),
			EnvStep::Splice(spliced) => {
				return resolve_slice(
					spliced.as_slice(),
					0,
					orig_len,
					windows,
					remote,
					splits_remaining.saturating_sub(1),
					env_indices,
					true,
				);
			},
		}
	}
	while at < words.len() {
		match step_launcher(words, at, windows, splits_remaining, env_indices) {
			StepResult::Advance { at: next, remote: is_remote } => {
				at = next.min(words.len());
				remote |= is_remote;
			},
			StepResult::SpliceEnv(spliced) => {
				return resolve_slice(
					spliced.as_slice(),
					0,
					orig_len,
					windows,
					remote,
					splits_remaining.saturating_sub(1),
					env_indices,
					true,
				);
			},
			StepResult::Stop => break,
		}
	}
	let orig_at = if at < words.len() {
		words.origin(at).index()
	} else {
		orig_len
	};
	let omp = (at < words.len() && is_omp(words.bytes(at), windows)).then(|| {
		let literal_from = ((at + 1)..words.len())
			.find_map(|j| match words.origin(j) {
				Origin::Arg(i) => Some(i),
				Origin::Split { .. } => None,
			})
			.unwrap_or(orig_len);
		OmpLaunch { literal_from, env_indices: std::mem::take(env_indices) }
	});
	Resolved { at: orig_at, remote, omp }
}

fn resolve_launch<T: AsRef<[u8]>>(words: &[T], windows: bool) -> Resolved {
	let mut env_indices = SmallVec::new();
	let mut at = 0;
	while at < words.len() && assignment(words.text(at)) {
		env_indices.push(at);
		at += 1;
	}
	resolve_slice(words, at, words.len(), windows, false, 4, &mut env_indices, false)
}

pub(crate) fn launch<T: AsRef<[u8]>>(words: &[T]) -> Launch {
	let resolved = resolve_launch(words, cfg!(windows));
	Launch { at: resolved.at, remote: resolved.remote }
}

/// If `words` invokes `omp` (directly, behind launchers, or remotely via
/// `ssh`), returns which argument positions belong to `omp` and must stay
/// literal.
pub(crate) fn omp_launch<T: AsRef<[u8]>>(words: &[T]) -> Option<OmpLaunch> {
	resolve_launch(words, cfg!(windows)).omp
}

#[cfg(test)]
mod tests {
	use super::*;

	fn omp(words: &[&str]) -> Option<OmpLaunch> {
		let words = words
			.iter()
			.map(|word| (*word).to_owned())
			.collect::<Vec<_>>();
		resolve_launch(&words, false).omp
	}

	fn omp_win(words: &[&str]) -> Option<OmpLaunch> {
		let words = words
			.iter()
			.map(|word| (*word).to_owned())
			.collect::<Vec<_>>();
		resolve_launch(&words, true).omp
	}

	#[test]
	fn finds_only_the_program_behind_launcher_options() {
		assert!(omp(&["grep", "omp", "local://out.txt"]).is_none());
		assert!(omp(&["npx", "--cache", "omp", "eslint", "local://app.ts"]).is_none());
		assert_eq!(
			omp(&["npx", "--loglevel", "warn", "omp", "read"]).map(|o| o.literal_from),
			Some(4)
		);
		assert_eq!(
			omp(&["npm", "--prefix", "tools", "exec", "--", "omp", "read"]).map(|o| o.literal_from),
			Some(6)
		);
		assert_eq!(omp(&["npm", "exec", "-p", "omp", "read"]).map(|o| o.literal_from), Some(4));
		assert_eq!(
			omp(&["bunx", "--minimum-release-age", "86400", "omp", "read"]).map(|o| o.literal_from),
			Some(4)
		);
		assert_eq!(
			omp(&["bunx", "-p", "@oh-my-pi/pi-coding-agent", "omp", "read"]).map(|o| o.literal_from),
			Some(4)
		);
		assert!(omp(&["bunx", "--package", "omp", "prettier", "local://file"]).is_none());
		assert_eq!(
			omp(&["bun", "x", "-p", "@oh-my-pi/pi-coding-agent", "omp", "read"])
				.map(|o| o.literal_from),
			Some(5)
		);
		assert!(omp(&["bun", "x", "--package", "omp", "prettier", "local://file"]).is_none());
		assert_eq!(
			omp(&["uv", "run", "-w", "requests", "omp", "read"]).map(|o| o.literal_from),
			Some(5)
		);
		assert!(omp(&["env", "--", "-flag=/opt/omp", "grep", "local://file"]).is_none());
		assert_eq!(
			omp(&["env", "-", "tool.name=/opt/omp", "omp", "read"]).map(|o| o.literal_from),
			Some(4)
		);
		assert_eq!(omp(&["setsid", "omp", "read"]).map(|o| o.literal_from), Some(2));
		assert_eq!(omp(&["xargs", "-n", "2", "omp", "read"]).map(|o| o.literal_from), Some(4));
		assert_eq!(omp(&["xargs", "-0n", "1", "omp", "read"]).map(|o| o.literal_from), Some(4));
		assert!(omp(&["xargs", "--replace", "grep", "omp", "local://file"]).is_none());
		assert_eq!(omp(&["ifne", "-n", "omp", "read"]).map(|o| o.literal_from), Some(3));
		assert_eq!(omp(&["command", "-p", "omp", "read"]).map(|o| o.literal_from), Some(3));
		assert!(omp(&["command", "-v", "omp", "local://file"]).is_none());
		assert!(omp(&["command", "-pv", "omp", "local://file"]).is_none());
	}

	#[test]
	fn handles_env_split_string_and_inherited_settings() {
		assert!(omp(&["env", "-S", "grep", "omp", "local://file"]).is_none());
		assert!(omp(&["env", "-iS", "grep", "omp", "local://file"]).is_none());
		assert!(omp(&["env", "--split-string=grep", "omp", "local://file"]).is_none());
		let split_omp = omp(&["env", "-C", "local://dir", "-S", "omp read", "local://file"])
			.expect("env -S running omp");
		assert!(!split_omp.is_literal(2));
		assert!(split_omp.is_literal(5));

		let inherited = omp(&[
			"/usr/bin/env",
			"-C",
			"local://dir",
			"SOURCE=local://in",
			"omp",
			"read",
			"local://arg",
		])
		.expect("env running omp");
		assert!(!inherited.is_literal(2));
		assert!(inherited.is_literal(3));
		assert!(inherited.is_literal(6));
	}

	#[test]
	fn excludes_non_executing_modes_and_preserves_remote_ssh_omp() {
		assert!(omp(&["sudo", "-e", "omp", "local://file"]).is_none());
		assert!(omp(&["sudo", "-He", "omp", "local://file"]).is_none());
		assert!(omp(&["sudo", "--edit", "omp", "local://file"]).is_none());
		assert!(omp(&["uv", "run", "-m", "omp", "local://file"]).is_none());
		assert!(omp(&["uv", "run", "--script", "omp", "local://file"]).is_none());
		assert!(omp(&["uv", "run", "--gui-script", "omp", "local://file"]).is_none());
		assert!(omp(&["npx", "-c", "echo hi", "omp", "local://file"]).is_none());
		assert!(omp(&["doas", "-C", "conf", "omp", "local://file"]).is_none());

		let remote =
			omp(&["ssh", "-F", "local://cfg", "server", "omp", "read", "skill://demo/SKILL.md"])
				.expect("remote ssh omp");
		assert!(!remote.is_literal(2));
		assert!(remote.is_literal(6));
	}

	#[test]
	fn recognizes_windows_launcher_paths_and_suffixes() {
		assert_eq!(
			omp_win(&["npx.cmd", "omp", "read", "local://file"]).map(|o| o.literal_from),
			Some(2)
		);
		assert_eq!(
			omp_win(&[
				r"C:\Program Files\nodejs\NPX.CMD",
				"--loglevel",
				"warn",
				r"C:\bin\omp.exe",
				"read"
			])
			.map(|o| o.literal_from),
			Some(4)
		);
		assert_eq!(
			omp_win(&["bunx.exe", "-p", "pkg", "omp.cmd", "read"]).map(|o| o.literal_from),
			Some(4)
		);
		assert!(
			omp_win(&[r"C:\tools\npx.cmd", "--cache", "omp", "eslint", "local://file"]).is_none()
		);
	}
}
