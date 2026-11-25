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
//! selectors: `omp read skill://x:1-20`), so its arguments and environment
//! are never rewritten.
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
/// first, else it spawns as it is.
pub(super) fn names_url(spec: &SpawnSpec<'_>) -> bool {
	if is_url(spec.path) || is_url(spec.cwd) {
		return true;
	}
	let plan = ArgPlan::analyze(spec.path.as_bytes(), spec.argv);
	let arg_url = spec
		.argv
		.iter()
		.enumerate()
		.skip(1)
		.any(|(i, arg)| !plan.is_literal(i) && arg.contains_str("://"));
	arg_url || (!plan.env_literal && spec.env.iter().any(|(name, value)| env_url(name, value)))
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	let name = basename_bytes(word);
	name == b"omp" || (cfg!(windows) && name.eq_ignore_ascii_case(b"omp.exe"))
}

fn basename_bytes(word: &[u8]) -> &[u8] {
	word
		.rsplit(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
		.next()
		.unwrap_or(word)
}

fn wrapper_name(word: &[u8]) -> Option<&str> {
	let mut name = basename_bytes(word);
	if cfg!(windows) && name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(b".exe") {
		name = &name[..name.len() - 4];
	}
	std::str::from_utf8(name).ok()
}

fn is_shell_assignment(word: &[u8]) -> bool {
	let Some(eq) = word.iter().position(|&b| b == b'=') else {
		return false;
	};
	let name = word[..eq].strip_suffix(b"+").unwrap_or(&word[..eq]);
	!name.is_empty()
		&& (name[0].is_ascii_alphabetic() || name[0] == b'_')
		&& name[1..]
			.iter()
			.all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn is_wrapper(name: &str) -> bool {
	matches!(
		name,
		"env"
			| "sudo"
			| "doas"
			| "nice"
			| "ionice"
			| "nohup"
			| "setsid"
			| "time"
			| "gtime"
			| "timeout"
			| "gtimeout"
			| "stdbuf"
			| "chrt"
			| "command"
			| "exec"
			| "xargs"
			| "ifne"
			| "npx"
			| "npm"
			| "bunx"
			| "bun"
			| "pnpx"
			| "pnpm"
			| "yarn"
			| "uv"
			| "ssh"
			| "find"
	)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArgMode {
	NoneLiteral,
	AllLiteral,
	Custom,
}

#[derive(Clone, Copy)]
enum WordOrigin {
	Argv(usize),
	Split { split_id: usize, word_idx: usize },
}

#[derive(Clone)]
struct PlanWord {
	bytes:  BString,
	origin: WordOrigin,
}

struct SplitEntry {
	argv_idx: usize,
	prefix:   BString,
	words:    Vec<SplitItem>,
}

enum SplitItem {
	Word { bytes: BString, literal: bool },
	Child { split_id: usize },
}

struct ArgPlan {
	mode:        ArgMode,
	literal:     Vec<bool>,
	env_literal: bool,
	splits:      Vec<SplitEntry>,
	root_splits: Vec<usize>,
}

impl ArgPlan {
	fn analyze(path: &[u8], argv: &[BString]) -> Self {
		if is_omp(path) || argv.first().is_some_and(|arg| is_omp(arg)) {
			return Self {
				mode:        ArgMode::AllLiteral,
				literal:     Vec::new(),
				env_literal: true,
				splits:      Vec::new(),
				root_splits: Vec::new(),
			};
		}
		let Some(first) = argv.first().and_then(|arg| wrapper_name(arg)) else {
			return Self {
				mode:        ArgMode::NoneLiteral,
				literal:     Vec::new(),
				env_literal: false,
				splits:      Vec::new(),
				root_splits: Vec::new(),
			};
		};
		if !is_wrapper(first) {
			return Self {
				mode:        ArgMode::NoneLiteral,
				literal:     Vec::new(),
				env_literal: false,
				splits:      Vec::new(),
				root_splits: Vec::new(),
			};
		}
		let mut plan = Self {
			mode:        ArgMode::Custom,
			literal:     vec![false; argv.len()],
			env_literal: false,
			splits:      Vec::new(),
			root_splits: Vec::new(),
		};
		let mut words: Vec<PlanWord> = argv
			.iter()
			.enumerate()
			.map(|(i, arg)| PlanWord { bytes: arg.clone(), origin: WordOrigin::Argv(i) })
			.collect();
		let mut inherited_origins: Vec<WordOrigin> = Vec::new();
		plan.env_literal = plan.walk(&mut words, 0, &mut inherited_origins, true);
		plan
	}

	fn is_literal(&self, index: usize) -> bool {
		match self.mode {
			ArgMode::NoneLiteral => false,
			ArgMode::AllLiteral => index > 0,
			ArgMode::Custom => self.literal.get(index).copied().unwrap_or(false),
		}
	}

	fn mark_literal(&mut self, origin: WordOrigin) {
		match origin {
			WordOrigin::Argv(idx) => {
				if let Some(slot) = self.literal.get_mut(idx) {
					*slot = true;
				}
			},
			WordOrigin::Split { split_id, word_idx } => {
				if let Some(entry) = self.splits.get_mut(split_id)
					&& let Some(SplitItem::Word { literal, .. }) = entry.words.get_mut(word_idx)
				{
					*literal = true;
				}
			},
		}
	}

	fn mark_command_word(&mut self, word: &PlanWord, allow_url_exec: bool) {
		if allow_url_exec && as_path(&word.bytes).is_some_and(omp_vfs::is_virtual_path) {
			return;
		}
		self.mark_literal(word.origin);
	}

	fn walk(
		&mut self,
		words: &mut Vec<PlanWord>,
		mut idx: usize,
		inherited: &mut Vec<WordOrigin>,
		allow_url_exec: bool,
	) -> bool {
		while idx < words.len() {
			if is_omp(&words[idx].bytes) {
				self.mark_command_word(&words[idx], allow_url_exec);
				for word in &words[idx + 1..] {
					self.mark_literal(word.origin);
				}
				for origin in inherited.drain(..) {
					self.mark_literal(origin);
				}
				return true;
			}
			let Some(name) = wrapper_name(&words[idx].bytes) else {
				return false;
			};
			match name {
				"env" => {
					idx = self.advance_env(words, idx + 1, inherited);
				},
				"sudo" => {
					let mut i = skip_opts(
						words,
						idx + 1,
						b"ugCDhRrTtUac",
						&[
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
						false,
					);
					while i < words.len() && is_shell_assignment(&words[i].bytes) {
						inherited.push(words[i].origin);
						i += 1;
					}
					idx = i;
				},
				"doas" => {
					let mut i = skip_opts(words, idx + 1, b"Cu", &[], false);
					while i < words.len() && is_shell_assignment(&words[i].bytes) {
						inherited.push(words[i].origin);
						i += 1;
					}
					idx = i;
				},
				"nice" => {
					idx = skip_opts(words, idx + 1, b"n", &["--adjustment"], true);
				},
				"ionice" => {
					let (i, pid_mode) = skip_opts_flag(
						words,
						idx + 1,
						b"cnpPu",
						&["--class", "--classdata", "--pid", "--pgid", "--uid"],
						b"pPu",
						&["--pid", "--pgid", "--uid"],
					);
					if pid_mode {
						return false;
					}
					idx = i;
				},
				"nohup" | "setsid" | "ifne" => {
					idx = skip_opts(words, idx + 1, b"", &[], false);
				},
				"time" | "gtime" => {
					idx = skip_opts(words, idx + 1, b"of", &["--output", "--format"], false);
				},
				"timeout" | "gtimeout" => {
					let i = skip_opts(words, idx + 1, b"sk", &["--signal", "--kill-after"], false);
					idx = (i + 1).min(words.len());
				},
				"stdbuf" => {
					idx = skip_opts(words, idx + 1, b"ioe", &["--input", "--output", "--error"], false);
				},
				"chrt" => {
					let (i, pid_mode) = skip_opts_flag(words, idx + 1, b"", &[], b"p", &["--pid"]);
					if pid_mode {
						return false;
					}
					idx = (i + 1).min(words.len());
				},
				"command" => {
					let (i, query) = skip_opts_flag(words, idx + 1, b"", &[], b"vV", &[]);
					if query {
						return false;
					}
					idx = i;
				},
				"exec" => {
					idx = skip_opts(words, idx + 1, b"a", &[], false);
				},
				"xargs" => {
					idx = skip_opts(
						words,
						idx + 1,
						b"adEILnPs",
						&[
							"--arg-file",
							"--delimiter",
							"--max-args",
							"--max-procs",
							"--max-chars",
							"--process-slot-var",
						],
						false,
					);
				},
				"npx" => {
					let (i, call_mode) = skip_opts_flag(
						words,
						idx + 1,
						b"pcw",
						&[
							"--package",
							"--call",
							"--cache",
							"--userconfig",
							"--prefix",
							"--loglevel",
							"--workspace",
							"--shell",
							"--registry",
							"--node-options",
						],
						b"c",
						&["--call"],
					);
					if call_mode {
						return false;
					}
					idx = i;
				},
				"npm" => {
					let i = skip_opts(
						words,
						idx + 1,
						b"Cw",
						&[
							"--prefix",
							"--cache",
							"--userconfig",
							"--globalconfig",
							"--loglevel",
							"--workspace",
							"--registry",
							"--shell",
							"--script-shell",
							"--node-options",
						],
						false,
					);
					if !words
						.get(i)
						.is_some_and(|w| matches!(w.bytes.as_slice(), b"exec" | b"x"))
					{
						return false;
					}
					let (j, call_mode) = skip_opts_flag(
						words,
						i + 1,
						b"Cwc",
						&[
							"--package",
							"--call",
							"--prefix",
							"--cache",
							"--userconfig",
							"--globalconfig",
							"--loglevel",
							"--workspace",
							"--registry",
							"--shell",
							"--script-shell",
							"--node-options",
						],
						b"c",
						&["--call"],
					);
					if call_mode {
						return false;
					}
					idx = j;
				},
				"bunx" => {
					let (i, call_mode) = skip_opts_flag(
						words,
						idx + 1,
						b"pc",
						&[
							"--package",
							"--shell",
							"--registry",
							"--minimum-release-age",
							"--cwd",
							"--config",
						],
						b"c",
						&[],
					);
					if call_mode {
						return false;
					}
					idx = i;
				},
				"bun" => {
					let i = skip_opts(
						words,
						idx + 1,
						b"cr",
						&["--cwd", "--config", "--env-file", "--preload"],
						false,
					);
					if words.get(i).is_none_or(|w| w.bytes != b"x") {
						return false;
					}
					let (j, call_mode) = skip_opts_flag(
						words,
						i + 1,
						b"pc",
						&[
							"--package",
							"--shell",
							"--registry",
							"--minimum-release-age",
							"--cwd",
							"--config",
						],
						b"c",
						&[],
					);
					if call_mode {
						return false;
					}
					idx = j;
				},
				"pnpx" => {
					let (i, call_mode) = skip_opts_flag(
						words,
						idx + 1,
						b"cC",
						&["--package", "--dir", "--filter", "--loglevel", "--registry", "--store-dir"],
						b"c",
						&[],
					);
					if call_mode {
						return false;
					}
					idx = i;
				},
				"pnpm" => {
					let i = skip_opts(
						words,
						idx + 1,
						b"C",
						&["--dir", "--filter", "--loglevel", "--registry", "--store-dir"],
						false,
					);
					if !words
						.get(i)
						.is_some_and(|w| matches!(w.bytes.as_slice(), b"dlx" | b"exec"))
					{
						return false;
					}
					let (j, call_mode) = skip_opts_flag(
						words,
						i + 1,
						b"cC",
						&["--package", "--dir", "--filter", "--loglevel", "--registry", "--store-dir"],
						b"c",
						&[],
					);
					if call_mode {
						return false;
					}
					idx = j;
				},
				"yarn" => {
					let i = skip_opts(words, idx + 1, b"", &["--cwd"], false);
					if !words
						.get(i)
						.is_some_and(|w| matches!(w.bytes.as_slice(), b"dlx" | b"exec"))
					{
						return false;
					}
					idx = skip_opts(words, i + 1, b"p", &["--package", "--cwd"], false);
				},
				"uv" => {
					let i = skip_opts(
						words,
						idx + 1,
						b"C",
						&[
							"--directory",
							"--project",
							"--config-file",
							"--cache-dir",
							"--color",
							"--python-preference",
							"--python-fetch",
						],
						false,
					);
					if words.get(i).is_none_or(|w| w.bytes != b"run") {
						return false;
					}
					let (j, non_cmd) = skip_opts_flag(
						words,
						i + 1,
						b"wpifPCm",
						&[
							"--with",
							"--with-editable",
							"--with-requirements",
							"--python",
							"--package",
							"--project",
							"--directory",
							"--env-file",
							"--extra",
							"--group",
							"--only-group",
							"--no-group",
							"--index",
							"--default-index",
							"--index-url",
							"--extra-index-url",
							"--find-links",
							"--config-file",
							"--cache-dir",
							"--color",
							"--python-preference",
							"--python-fetch",
							"--refresh-package",
							"--reinstall-package",
							"--upgrade-package",
							"--resolution",
							"--prerelease",
							"--index-strategy",
							"--keyring-provider",
							"--link-mode",
							"--exclude-newer",
							"--max-concurrent-downloads",
							"--max-concurrent-builds",
							"--max-concurrent-installs",
							"--module",
							"--script",
							"--gui-script",
						],
						b"m",
						&["--module", "--script", "--gui-script"],
					);
					if non_cmd {
						return false;
					}
					idx = j;
				},
				"ssh" => {
					let i = skip_opts(words, idx + 1, b"BbcDEeFIiJLlmOopQRSWw", &[], false);
					if i + 1 >= words.len() {
						return false;
					}
					self.walk_ssh_remote(&words[i + 1..]);
					return false;
				},
				"find" => {
					self.walk_find(&words[idx + 1..]);
					return false;
				},
				_ => return false,
			}
		}
		false
	}

	fn advance_env(
		&mut self,
		words: &mut Vec<PlanWord>,
		mut i: usize,
		inherited: &mut Vec<WordOrigin>,
	) -> usize {
		while i < words.len() {
			let w = words[i].bytes.as_slice();
			if w == b"--" {
				i += 1;
				break;
			}
			if !w.starts_with(b"-") || w == b"-" {
				break;
			}
			if w.starts_with(b"--") {
				if let Some(val) = w.strip_prefix(b"--split-string=") {
					let val = val.to_vec();
					let origin = words[i].origin;
					if self.splice_env_split(words, i, 1, origin, b"--split-string=", &val) {
						continue;
					}
					i += 1;
					continue;
				}
				if w == b"--split-string" {
					if let Some(next) = words.get(i + 1) {
						let val = next.bytes.clone();
						let origin = next.origin;
						if self.splice_env_split(words, i, 2, origin, b"", &val) {
							continue;
						}
					}
					i = (i + 2).min(words.len());
					continue;
				}
				if w.contains(&b'=') {
					i += 1;
					continue;
				}
				if matches!(w, b"--unset" | b"--chdir" | b"--argv0" | b"--env0-from") {
					i = (i + 2).min(words.len());
				} else {
					i += 1;
				}
				continue;
			}
			let mut consumed = false;
			let mut spliced = false;
			for k in 1..w.len() {
				if w[k] == b'S' {
					if k + 1 < w.len() {
						let prefix = w[..=k].to_vec();
						let val = w[k + 1..].to_vec();
						let origin = words[i].origin;
						if self.splice_env_split(words, i, 1, origin, &prefix, &val) {
							spliced = true;
							break;
						}
						consumed = true;
						i += 1;
						break;
					}
					if let Some(next) = words.get(i + 1) {
						let val = next.bytes.clone();
						let origin = next.origin;
						if self.splice_env_split(words, i, 2, origin, b"", &val) {
							spliced = true;
							break;
						}
					}
					consumed = true;
					i = (i + 2).min(words.len());
					break;
				}
				if matches!(w[k], b'u' | b'C' | b'a' | b'P') {
					if k + 1 < w.len() {
						i += 1;
					} else {
						i = (i + 2).min(words.len());
					}
					consumed = true;
					break;
				}
			}
			if !consumed && !spliced {
				i += 1;
			}
		}
		if words.get(i).is_some_and(|w| w.bytes == b"-") {
			i += 1;
		}
		while words.get(i).is_some_and(|w| w.bytes.contains(&b'=')) {
			inherited.push(words[i].origin);
			i += 1;
		}
		i
	}

	fn splice_env_split(
		&mut self,
		words: &mut Vec<PlanWord>,
		at: usize,
		remove_count: usize,
		target_origin: WordOrigin,
		prefix: &[u8],
		raw_val: &[u8],
	) -> bool {
		let Some(parts) = split_env_s(raw_val) else {
			return false;
		};
		let split_id = self.splits.len();
		let argv_idx = match target_origin {
			WordOrigin::Argv(idx) => {
				self.root_splits.push(split_id);
				idx
			},
			WordOrigin::Split { split_id: parent_id, word_idx } => {
				if let Some(parent) = self.splits.get_mut(parent_id)
					&& let Some(slot) = parent.words.get_mut(word_idx)
				{
					*slot = SplitItem::Child { split_id };
				}
				parent_id
			},
		};
		let items = parts
			.iter()
			.map(|b| SplitItem::Word { bytes: b.clone(), literal: false })
			.collect();
		self
			.splits
			.push(SplitEntry { argv_idx, prefix: BString::from(prefix), words: items });
		let replacement: Vec<PlanWord> = parts
			.into_iter()
			.enumerate()
			.map(|(word_idx, bytes)| PlanWord {
				bytes,
				origin: WordOrigin::Split { split_id, word_idx },
			})
			.collect();
		words.splice(at..at + remove_count, replacement);
		true
	}

	fn walk_ssh_remote(&mut self, remote: &[PlanWord]) {
		let mut start = 0;
		while start < remote.len() {
			let end = remote[start..]
				.iter()
				.position(|w| matches!(w.bytes.as_slice(), b";" | b"|" | b"||" | b"&&" | b"&" | b"\n"))
				.map_or(remote.len(), |pos| start + pos);
			let mut seg = remote[start..end].to_vec();
			// Strip leading redirections / trailing redirections and leading
			// assignments in this segment.
			let mut clean = Vec::with_capacity(seg.len());
			let mut i = 0;
			while i < seg.len() {
				let w = seg[i].bytes.as_slice();
				if is_ssh_standalone_redir(w) {
					i += 2;
					continue;
				}
				if is_ssh_attached_redir(w) {
					i += 1;
					continue;
				}
				clean.push(seg[i].clone());
				i += 1;
			}
			seg = clean;
			let mut cmd_at = 0;
			let mut inherited = Vec::new();
			while cmd_at < seg.len() && is_shell_assignment(&seg[cmd_at].bytes) {
				inherited.push(seg[cmd_at].origin);
				cmd_at += 1;
			}
			if cmd_at < seg.len() {
				let mut sub: Vec<PlanWord> = seg[cmd_at..].to_vec();
				let _ = self.walk(&mut sub, 0, &mut inherited, false);
			}
			start = end + 1;
		}
	}

	fn walk_find(&mut self, args: &[PlanWord]) {
		let mut i = 0;
		while i < args.len() {
			if matches!(args[i].bytes.as_slice(), b"-exec" | b"-execdir" | b"-ok" | b"-okdir") {
				let start = i + 1;
				let end = args[start..]
					.iter()
					.position(|w| matches!(w.bytes.as_slice(), b";" | b"+"))
					.map_or(args.len(), |pos| start + pos);
				if start < end {
					let mut action = args[start..end].to_vec();
					let mut inherited = Vec::new();
					let _ = self.walk(&mut action, 0, &mut inherited, true);
				}
				i = end + 1;
			} else {
				i += 1;
			}
		}
	}
}

fn strip_leading_digits(word: &[u8]) -> &[u8] {
	let at = word
		.iter()
		.position(|b| !b.is_ascii_digit())
		.unwrap_or(word.len());
	&word[at..]
}

fn is_ssh_standalone_redir(word: &[u8]) -> bool {
	let rest = strip_leading_digits(word);
	matches!(rest, b"<" | b">" | b">>" | b">|" | b"<>" | b"&>" | b"&>>" | b"<<" | b"<<-" | b"<<<")
}

fn is_ssh_attached_redir(word: &[u8]) -> bool {
	let rest = strip_leading_digits(word);
	rest.len() > 1 && (rest.starts_with(b">") || rest.starts_with(b"<") || rest.starts_with(b"&>"))
}

fn skip_opts(
	words: &[PlanWord],
	from: usize,
	short_vals: &[u8],
	long_vals: &[&str],
	allow_numeric_short: bool,
) -> usize {
	let mut i = from;
	while i < words.len() {
		let w = words[i].bytes.as_slice();
		if w == b"--" {
			return i + 1;
		}
		if !w.starts_with(b"-") || w == b"-" {
			break;
		}
		if w.starts_with(b"--") {
			if w.contains(&b'=') {
				i += 1;
				continue;
			}
			if long_vals.iter().any(|&opt| w == opt.as_bytes()) {
				i = (i + 2).min(words.len());
			} else {
				i += 1;
			}
			continue;
		}
		if allow_numeric_short && w[1..].iter().all(u8::is_ascii_digit) {
			i += 1;
			continue;
		}
		let mut consumed = false;
		for k in 1..w.len() {
			if short_vals.contains(&w[k]) {
				if k + 1 < w.len() {
					i += 1;
				} else {
					i = (i + 2).min(words.len());
				}
				consumed = true;
				break;
			}
		}
		if !consumed {
			i += 1;
		}
	}
	i
}

fn skip_opts_flag(
	words: &[PlanWord],
	from: usize,
	short_vals: &[u8],
	long_vals: &[&str],
	flag_shorts: &[u8],
	flag_longs: &[&str],
) -> (usize, bool) {
	let mut i = from;
	let mut flagged = false;
	while i < words.len() {
		let w = words[i].bytes.as_slice();
		if w == b"--" {
			return (i + 1, flagged);
		}
		if !w.starts_with(b"-") || w == b"-" {
			break;
		}
		if w.starts_with(b"--") {
			let opt_name = w.split_once_str("=").map_or(w, |(name, _)| name);
			if flag_longs.iter().any(|&opt| opt_name == opt.as_bytes()) {
				flagged = true;
			}
			if w.contains(&b'=') {
				i += 1;
				continue;
			}
			if long_vals.iter().any(|&opt| w == opt.as_bytes()) {
				i = (i + 2).min(words.len());
			} else {
				i += 1;
			}
			continue;
		}
		let mut consumed = false;
		for k in 1..w.len() {
			if flag_shorts.contains(&w[k]) {
				flagged = true;
			}
			if short_vals.contains(&w[k]) {
				if k + 1 < w.len() {
					i += 1;
				} else {
					i = (i + 2).min(words.len());
				}
				consumed = true;
				break;
			}
		}
		if !consumed {
			i += 1;
		}
	}
	(i, flagged)
}

fn split_env_s(input: &[u8]) -> Option<Vec<BString>> {
	let mut args: Vec<Vec<u8>> = Vec::new();
	let (mut dq, mut sq, mut sep) = (false, false, true);
	let mut i = 0;
	let push_byte = |args: &mut Vec<Vec<u8>>, sep: &mut bool, byte: u8| {
		if *sep {
			*sep = false;
			args.push(Vec::new());
		}
		args.last_mut().expect("started").push(byte);
	};
	let start_empty = |args: &mut Vec<Vec<u8>>, sep: &mut bool| {
		if *sep {
			*sep = false;
			args.push(Vec::new());
		}
	};
	while i < input.len() {
		let ch = input[i];
		match ch {
			b'\'' if !dq => {
				sq = !sq;
				start_empty(&mut args, &mut sep);
				i += 1;
			},
			b'"' if !sq => {
				dq = !dq;
				start_empty(&mut args, &mut sep);
				i += 1;
			},
			b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r' if !(sq || dq) => {
				sep = true;
				while input
					.get(i)
					.is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
				{
					i += 1;
				}
			},
			b'#' if sep => return Some(args.into_iter().map(BString::from).collect()),
			b'\\' if !sq || matches!(input.get(i + 1), Some(b'\\' | b'\'')) => {
				i += 1;
				let &escaped = input.get(i)?;
				let mapped = match escaped {
					b'"' | b'#' | b'$' | b'\'' | b'\\' => escaped,
					b'_' if !dq => {
						i += 1;
						sep = true;
						continue;
					},
					b'_' => b' ',
					b'c' if dq => return None,
					b'c' => return Some(args.into_iter().map(BString::from).collect()),
					b'f' => 0x0c,
					b'n' => b'\n',
					b'r' => b'\r',
					b't' => b'\t',
					b'v' => 0x0b,
					_ => return None,
				};
				push_byte(&mut args, &mut sep, mapped);
				i += 1;
			},
			_ => {
				push_byte(&mut args, &mut sep, ch);
				i += 1;
			},
		}
	}
	if sq || dq {
		return None;
	}
	Some(args.into_iter().map(BString::from).collect())
}

fn quote_env_s_word(word: &[u8]) -> BString {
	let needs_quote = word.is_empty()
		|| word.iter().any(|&b| {
			matches!(
				b,
				b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b'\'' | b'"' | b'\\' | b'#' | b'$'
			)
		});
	if !needs_quote {
		return BString::from(word);
	}
	let mut out = Vec::with_capacity(word.len() + 4);
	out.push(b'\'');
	for &b in word {
		if b == b'\'' || b == b'\\' {
			out.push(b'\\');
		}
		out.push(b);
	}
	out.push(b'\'');
	BString::from(out)
}

async fn resolve_splits(fs: &omp_vfs::Fs, splits: &[SplitEntry]) -> Vec<Option<BString>> {
	let mut resolved: Vec<Option<BString>> = vec![None; splits.len()];
	for split_id in (0..splits.len()).rev() {
		let entry = &splits[split_id];
		let mut changed = false;
		let mut parts = Vec::with_capacity(entry.words.len());
		for item in &entry.words {
			match item {
				SplitItem::Word { bytes, literal } => {
					if !*literal && let Some(host) = host_arg(fs, bytes.as_bstr()).await {
						changed = true;
						parts.push(host);
						continue;
					}
					parts.push(bytes.clone());
				},
				SplitItem::Child { split_id: child_id } => {
					if let Some(rebuilt) = &resolved[*child_id] {
						changed = true;
						parts.push(rebuilt.clone());
					} else {
						parts.push(join_split_raw(splits, *child_id));
					}
				},
			}
		}
		if changed {
			let mut out = entry.prefix.clone();
			for (idx, part) in parts.iter().enumerate() {
				if idx > 0 {
					out.push(b' ');
				}
				out.extend_from_slice(&quote_env_s_word(part));
			}
			resolved[split_id] = Some(out);
		}
	}
	resolved
}

fn join_split_raw(splits: &[SplitEntry], split_id: usize) -> BString {
	let entry = &splits[split_id];
	let mut out = entry.prefix.clone();
	for (idx, item) in entry.words.iter().enumerate() {
		if idx > 0 {
			out.push(b' ');
		}
		match item {
			SplitItem::Word { bytes, .. } => out.extend_from_slice(&quote_env_s_word(bytes)),
			SplitItem::Child { split_id: child_id } => {
				out.extend_from_slice(&quote_env_s_word(&join_split_raw(splits, *child_id)));
			},
		}
	}
	out
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
	let plan = ArgPlan::analyze(&names.path, &names.argv);
	let mut argv = names.argv.clone();
	if !plan.splits.is_empty() {
		let mut resolved_splits = resolve_splits(fs, &plan.splits).await;
		for &split_id in &plan.root_splits {
			let argv_idx = plan.splits[split_id].argv_idx;
			if let Some(rebuilt) = resolved_splits[split_id].take() {
				argv[argv_idx] = rebuilt;
			}
		}
	}
	for (i, arg) in argv.iter_mut().enumerate() {
		if i == 0
			|| plan.is_literal(i)
			|| plan
				.root_splits
				.iter()
				.any(|&id| plan.splits[id].argv_idx == i)
		{
			continue;
		}
		if let Some(host) = host_arg(fs, arg.as_bstr()).await {
			*arg = host;
		}
	}
	// What the child's environment says differently from the shell's.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !plan.env_literal {
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

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;

	#[derive(Debug)]
	struct MapFs {
		root: PathBuf,
	}

	#[async_trait::async_trait]
	impl omp_vfs::FileSystem for MapFs {
		fn is_native_local(&self, path: &Path) -> bool {
			!omp_vfs::is_virtual_path(path)
		}

		async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
			let Some(rel) = path.to_str().and_then(|s| s.strip_prefix("local://")) else {
				return Ok(None);
			};
			Ok(Some(self.root.join(rel)))
		}

		async fn open(
			&self,
			_path: &Path,
			_options: &omp_vfs::OpenOptions,
		) -> io::Result<omp_vfs::File> {
			Err(io::Error::from(io::ErrorKind::Unsupported))
		}

		async fn metadata(&self, _path: &Path) -> io::Result<omp_vfs::Metadata> {
			Err(io::Error::from(io::ErrorKind::Unsupported))
		}

		async fn read_dir(&self, _path: &Path) -> io::Result<omp_vfs::ReadDir> {
			Err(io::Error::from(io::ErrorKind::Unsupported))
		}
	}

	fn bvec(items: &[&str]) -> Vec<BString> {
		items.iter().map(|s| BString::from(*s)).collect()
	}

	fn make_names(argv: &[&str], env: &[(&str, &str)]) -> Names {
		let pairs = env
			.iter()
			.map(|(k, v)| (BString::from(*k), BString::from(*v)))
			.collect();
		Names {
			path: BString::from(argv.first().copied().unwrap_or("")),
			argv: bvec(argv),
			env:  EnvView::new(pairs),
			cwd:  BString::from("/tmp"),
		}
	}

	async fn resolved_argv(
		argv: &[&str],
		env: &[(&str, &str)],
	) -> (Vec<String>, Vec<(String, String)>) {
		let dir = tempfile::tempdir().expect("tempdir");
		let fs = omp_vfs::Fs::new(Arc::new(MapFs { root: dir.path().to_path_buf() }));
		let names = make_names(argv, env);
		let out = resolve(&fs, &names).await.expect("resolve");
		let root = dir.path().to_string_lossy().into_owned();
		let norm = |b: &BStr| b.to_str_lossy().replace(&root, "/HOST");
		let out_argv = out.argv.iter().map(|a| norm(a.as_bstr())).collect();
		let out_env = out
			.env
			.iter()
			.map(|(k, v)| (k.to_str_lossy().into_owned(), norm(v)))
			.collect();
		(out_argv, out_env)
	}

	#[test]
	fn non_omp_commands_with_omp_arguments_do_not_skip_urls() {
		for argv in [
			&["grep", "omp", "local://out.txt"][..],
			&["rg", "-n", "omp", "skill://x/SKILL.md"][..],
			&["ls", "./omp", "local://dir"][..],
			&["nice", "-n", "5", "grep", "omp", "local://out.txt"][..],
			&["npx", "--cache", "omp", "eslint", "local://app.ts"][..],
			&["npx", "-p", "omp", "eslint", "local://app.ts"][..],
			&["env", "-u", "omp", "grep", "x", "local://out.txt"][..],
			&["env", "--", "-flag=/opt/omp", "grep", "x", "local://out.txt"][..],
			&["env", "-", "tool.name=/opt/omp", "grep", "x", "local://out.txt"][..],
			&["env", "-S", "grep omp", "local://out.txt"][..],
			&["uv", "run", "-m", "omp", "local://out.txt"][..],
			&["setsid", "grep", "omp", "local://out.txt"][..],
		] {
			let args = bvec(argv);
			let plan = ArgPlan::analyze(args[0].as_bytes(), &args);
			assert!(
				!plan.is_literal(args.len() - 1),
				"expected trailing URL to be resolved for {argv:?}"
			);
			assert!(!plan.env_literal, "expected env not literal for {argv:?}");
		}
	}

	#[tokio::test]
	async fn wrapper_options_resolve_while_omp_arguments_stay_literal() {
		let (argv, env) = resolved_argv(
			&["npm", "--prefix", "local://tools", "exec", "--", "omp", "read", "local://book:1"],
			&[("REF", "local://env")],
		)
		.await;
		assert_eq!(argv, [
			"npm",
			"--prefix",
			"/HOST/tools",
			"exec",
			"--",
			"omp",
			"read",
			"local://book:1"
		]);
		assert_eq!(env, [("REF".to_owned(), "local://env".to_owned())]);

		let (argv, _) =
			resolved_argv(&["npm", "exec", "-p", "omp", "read", "local://book:1"], &[]).await;
		assert_eq!(argv, ["npm", "exec", "-p", "omp", "read", "local://book:1"]);

		let (argv, _) =
			resolved_argv(&["npx", "--loglevel", "warn", "omp", "read", "local://book:1"], &[]).await;
		assert_eq!(argv, ["npx", "--loglevel", "warn", "omp", "read", "local://book:1"]);

		let (argv, _) = resolved_argv(
			&[
				"bunx",
				"--minimum-release-age",
				"86400",
				"--registry",
				"https://r.test",
				"omp",
				"read",
				"local://book:1",
			],
			&[],
		)
		.await;
		assert_eq!(argv, [
			"bunx",
			"--minimum-release-age",
			"86400",
			"--registry",
			"https://r.test",
			"omp",
			"read",
			"local://book:1"
		]);

		let (argv, _) =
			resolved_argv(&["uv", "run", "-w", "requests", "omp", "read", "local://book:1"], &[])
				.await;
		assert_eq!(argv, ["uv", "run", "-w", "requests", "omp", "read", "local://book:1"]);
	}

	#[tokio::test]
	async fn env_split_string_ssh_and_find_scope_omp_arguments_per_command() {
		let (argv, _) =
			resolved_argv(&["/usr/bin/env", "-", "omp", "read", "local://book:1"], &[]).await;
		assert_eq!(argv, ["/usr/bin/env", "-", "omp", "read", "local://book:1"]);

		let (argv, _) =
			resolved_argv(&["nice", "/usr/bin/env", "-S", "omp read", "local://book:1"], &[]).await;
		assert_eq!(argv, ["nice", "/usr/bin/env", "-S", "omp read", "local://book:1"]);

		let (argv, _) = resolved_argv(
			&["/usr/bin/env", "-S", "env -S 'local://bin/omp read'", "local://book:1"],
			&[],
		)
		.await;
		assert_eq!(argv, ["/usr/bin/env", "-S", "env -S '/HOST/bin/omp read'", "local://book:1"]);

		let (argv, _) = resolved_argv(
			&[
				"ssh",
				"-F",
				"local://cfg",
				"host",
				"LANG=C",
				"omp",
				"read",
				"local://book",
				"|",
				"cat",
				"local://other",
			],
			&[],
		)
		.await;
		assert_eq!(argv, [
			"ssh",
			"-F",
			"/HOST/cfg",
			"host",
			"LANG=C",
			"omp",
			"read",
			"local://book",
			"|",
			"cat",
			"/HOST/other"
		]);

		let (argv, _) = resolved_argv(
			&[
				"find",
				"local://dir",
				"-exec",
				"omp",
				"read",
				"local://x",
				";",
				"-exec",
				"cat",
				"local://y",
				";",
			],
			&[],
		)
		.await;
		assert_eq!(argv, [
			"find",
			"/HOST/dir",
			"-exec",
			"omp",
			"read",
			"local://x",
			";",
			"-exec",
			"cat",
			"/HOST/y",
			";"
		]);
	}
}
