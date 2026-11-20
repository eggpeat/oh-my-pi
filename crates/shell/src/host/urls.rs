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
//! selectors: `omp read skill://x:1-20`), so the arguments and environment
//! of a command that runs `omp` stay as written. A word spelled `omp` is
//! not enough: only the program, or the command a known wrapper (`nice omp`,
//! `npx --loglevel warn omp`, `env -u NAME - omp`) is given, counts. That
//! wrapper's own file arguments — and an `omp` executable path handed to a
//! wrapper (`env local://bin/omp …`) — are still rewritten.
//!
//! A spawn that names a URL is taken apart ([`split`]) into the [`Names`] to
//! resolve and the [`Rest`] it moves untouched; the provider is awaited
//! with only the names, so the future [`Host::spawn`](crate::bash::Host::spawn)
//! returns owns everything it needs and is `Send`.

use std::{
	borrow::Cow,
	io,
	path::{Path, PathBuf},
};

use bstr::{BStr, BString, ByteSlice};

use crate::bash::{
	ChildRedirs, CmdTag, EnvView, Lineage, OsHandle, PgroupSpec, Rlimit, SigSet, SpawnSpec,
	StdioSpec, Vpid,
};

/// One word inside an `env -S` / `--split-string` argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvSplitWord {
	/// Decoded (unexpanded) word text for URL detection and resolution.
	pub text:  String,
	/// Byte range `[start, end)` inside [`EnvSplitPlan::raw`].
	pub start: usize,
	pub end:   usize,
	/// True when this word belongs to `omp` (or an unknown command) and stays
	/// literal.
	pub keep:  bool,
}

/// Word-level URL rewrite plan for one `env -S` / `--split-string` argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvSplitPlan {
	/// Index of this argument in `argv`.
	pub index:  usize,
	/// Prefix before the split string (`""`, `"--split-string="`, `"-iS"`, …).
	pub prefix: String,
	/// Raw split string (the slice of `argv[index]` after `prefix`).
	pub raw:    String,
	/// Parsed words within `raw`, in source order.
	pub words:  Vec<EnvSplitWord>,
}

/// URL rewrite ownership for one external command's `argv`, shared between the
/// embedded shell and the client-terminal rewriter (`bash-host-urls.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlArgPlan {
	/// `keep[i]` is `true` when `argv[i]` must not be URL-rewritten. Empty when
	/// no argument had a URL candidate.
	pub keep:       Vec<bool>,
	/// True when the child's environment belongs to `omp` (or an unknown
	/// program).
	pub keep_env:   bool,
	/// Per-word rewrite plans for `env -S` / `--split-string` arguments.
	pub env_splits: Vec<EnvSplitPlan>,
}

impl UrlArgPlan {
	fn keep_arg(&self, index: usize) -> bool {
		self.keep.get(index).copied().unwrap_or(false)
	}

	fn env_split_at(&self, index: usize) -> Option<&EnvSplitPlan> {
		self.env_splits.iter().find(|plan| plan.index == index)
	}
}

/// Classify a command's `argv` for internal URL rewriting using the embedded
/// shell's canonical launcher, `env -S`, `find`, and `ssh` rules.
///
/// When `env_complete` is `false` (client-terminal rewriting where inherited
/// environment variables are not all visible), an unexpanded `${VAR}` at
/// command position inside `env -S` conservatively preserves following
/// arguments.
pub fn classify_url_args(
	argv: &[String],
	env: Option<&[(String, String)]>,
	env_complete: bool,
) -> UrlArgPlan {
	let vwords: Vec<VWord<'_>> = argv
		.iter()
		.enumerate()
		.map(|(origin, word)| VWord::plain(word.as_bytes(), origin))
		.collect();
	let base = match env {
		Some(pairs) => EnvBase::Pairs(pairs),
		None => EnvBase::None,
	};
	classify_vwords(argv.len(), vwords, EnvContext::new(base, env_complete))
}

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
	/// Ownership plan computed once by [`plan`] and reused by [`resolve`].
	owned:    UrlArgPlan,
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

/// Plan URL resolution for `spec`, returning `None` (with no allocation or
/// launcher walk when no candidate URL is present) when `spec` can spawn as-is.
pub(super) fn plan(spec: &SpawnSpec<'_>) -> Option<UrlArgPlan> {
	let path_or_cwd_url = is_url(spec.path) || is_url(spec.cwd);
	let arg_has_url = spec.argv.iter().skip(1).any(|arg| arg.contains_str("://"));
	let env_has_url = spec.env.iter().any(|(name, value)| env_url(name, value));
	if !path_or_cwd_url && !arg_has_url && !env_has_url {
		return None;
	}
	if !arg_has_url && !env_has_url {
		return Some(UrlArgPlan { keep: Vec::new(), keep_env: true, env_splits: Vec::new() });
	}
	let owned = omp_owned(spec.argv, Some(spec.env));
	let needs_arg = arg_has_url
		&& spec.argv.iter().enumerate().skip(1).any(|(index, arg)| {
			if let Some(split) = owned.env_split_at(index) {
				split
					.words
					.iter()
					.any(|word| !word.keep && word.text.contains("://"))
			} else {
				!owned.keep_arg(index) && arg.contains_str("://")
			}
		});
	let needs_env = env_has_url && !owned.keep_env;
	if !path_or_cwd_url && !needs_arg && !needs_env {
		return None;
	}
	Some(owned)
}

/// Take `spec` apart for a spawn that waits on the provider, carrying `owned`
/// forward so [`resolve`] does not walk `argv` a second time.
pub(super) fn split(spec: SpawnSpec<'_>, owned: UrlArgPlan) -> (Names, Rest) {
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
		env: env.clone(),
		cwd: BString::from(cwd.as_bytes()),
		owned,
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

fn omp_owned(argv: &[BString], env: Option<&EnvView>) -> UrlArgPlan {
	let vwords: Vec<VWord<'_>> = argv
		.iter()
		.enumerate()
		.map(|(origin, word)| VWord::plain(word.as_slice(), origin))
		.collect();
	let (base, complete) = match env {
		Some(view) => (EnvBase::View(view), true),
		None => (EnvBase::None, false),
	};
	classify_vwords(argv.len(), vwords, EnvContext::new(base, complete))
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	let name = word
		.rsplit(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
		.next()
		.unwrap_or(word);
	name == b"omp" || (cfg!(windows) && name.eq_ignore_ascii_case(b"omp.exe"))
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
	let mut argv = Vec::with_capacity(names.argv.len());
	for (i, arg) in names.argv.iter().enumerate() {
		let host = if i == 0 {
			None
		} else if let Some(split) = names.owned.env_split_at(i) {
			resolve_env_split(fs, split).await
		} else if names.owned.keep_arg(i) {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !names.owned.keep_env {
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
	Ok(Names {
		path,
		argv,
		env,
		cwd,
		owned: UrlArgPlan {
			keep:       Vec::new(),
			keep_env:   names.owned.keep_env,
			env_splits: Vec::new(),
		},
	})
}

/// Resolve unprotected URL words inside one `env -S` / `--split-string` string,
/// quoting each replacement for `env -S` and preserving untouched spans
/// verbatim.
async fn resolve_env_split(fs: &omp_vfs::Fs, split: &EnvSplitPlan) -> Option<BString> {
	let raw = split.raw.as_bytes();
	let mut out = Vec::with_capacity(split.prefix.len() + raw.len());
	out.extend_from_slice(split.prefix.as_bytes());
	let mut cursor = 0usize;
	let mut changed = false;
	for word in &split.words {
		if word.keep || !word.text.contains("://") {
			continue;
		}
		if let Some(host) = host_arg(fs, BStr::new(word.text.as_bytes())).await {
			out.extend_from_slice(&raw[cursor..word.start]);
			append_env_s_word(&mut out, host.as_slice());
			cursor = word.end;
			changed = true;
		}
	}
	if !changed {
		return None;
	}
	out.extend_from_slice(&raw[cursor..]);
	Some(BString::from(out))
}

/// Append `word` encoded as one literal word for `env -S`.
fn append_env_s_word(out: &mut Vec<u8>, word: &[u8]) {
	let safe = !word.is_empty()
		&& word
			.iter()
			.all(|&b| (0x21..=0x7e).contains(&b) && !matches!(b, b'\'' | b'"' | b'\\' | b'#' | b'$'));
	if safe {
		out.extend_from_slice(word);
		return;
	}
	out.push(b'\'');
	for &b in word {
		if b == b'\'' || b == b'\\' {
			out.push(b'\\');
		}
		out.push(b);
	}
	out.push(b'\'');
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

// ── Shared launcher, `env -S`, `find`, and `ssh` classification ──

/// Where a logical word came from: an `argv` slot, or one word inside an
/// `env -S` split plan.
#[derive(Clone, Copy)]
struct SourceRef {
	origin: usize,
	split:  Option<(usize, usize)>,
}

/// One logical word in a command walk.
struct VWord<'a> {
	text:            Cow<'a, [u8]>,
	src:             SourceRef,
	has_unknown_var: bool,
}

impl<'a> VWord<'a> {
	const fn plain(text: &'a [u8], origin: usize) -> Self {
		Self {
			text:            Cow::Borrowed(text),
			src:             SourceRef { origin, split: None },
			has_unknown_var: false,
		}
	}
}

enum EnvBase<'a> {
	None,
	View(&'a EnvView),
	Pairs(&'a [(String, String)]),
}

struct EnvContext<'a> {
	base:      EnvBase<'a>,
	complete:  bool,
	overrides: Vec<(Vec<u8>, Vec<u8>)>,
}

impl<'a> EnvContext<'a> {
	const fn new(base: EnvBase<'a>, complete: bool) -> Self {
		Self { base, complete, overrides: Vec::new() }
	}

	fn get(&self, name: &[u8]) -> Option<&[u8]> {
		for (k, v) in self.overrides.iter().rev() {
			if k.as_slice() == name {
				return Some(v.as_slice());
			}
		}
		match self.base {
			EnvBase::None => None,
			EnvBase::View(view) => {
				let mut found = None;
				for (k, v) in view.iter() {
					if k.as_bytes() == name {
						found = Some(v.as_bytes());
					}
				}
				found
			},
			EnvBase::Pairs(pairs) => pairs
				.iter()
				.rev()
				.find(|(k, _)| k.as_bytes() == name)
				.map(|(_, v)| v.as_bytes()),
		}
	}

	fn record_assignment(&mut self, word: &[u8]) {
		if let Some((name, Some(val))) = Some(split_eq(word))
			&& !name.is_empty()
		{
			self.overrides.push((name.to_vec(), val.to_vec()));
		}
	}
}

/// Result of walking past launchers (`env`, `sudo`, `npx`, `uv run`, …).
struct Launch<'a> {
	words:   Vec<VWord<'a>>,
	at:      usize,
	passed:  Vec<SourceRef>,
	aborted: bool,
}

/// Options a launcher takes before the command it runs.
struct OptSet {
	/// Short letters whose value is the next word when last in a cluster.
	short_val:  &'static [u8],
	/// Long names (without `--`) whose value is the next word when not `=`.
	long_val:   &'static [&'static str],
	/// Short letters that select a non-exec mode (lookup, edit, module, …).
	stop_short: &'static [u8],
	/// Long names that select a non-exec mode.
	stop_long:  &'static [&'static str],
}

enum ShortStep {
	One,
	Next,
	Stop,
}

const MAX_ENV_SPLITS: usize = 64;

fn classify_vwords(argc: usize, vwords: Vec<VWord<'_>>, mut env: EnvContext<'_>) -> UrlArgPlan {
	let mut keep = vec![false; argc];
	let mut env_splits = Vec::new();
	if argc == 0 {
		return UrlArgPlan { keep, keep_env: false, env_splits };
	}
	let launch = launch_of_from(vwords, 0, &mut env, &mut env_splits);
	if launch.aborted || launch.at >= launch.words.len() {
		return UrlArgPlan { keep, keep_env: false, env_splits };
	}
	let first = &launch.words[launch.at];
	let cmd = first.text.as_ref();
	if program_is(cmd, b"ssh") {
		mark_ssh(&mut keep, &mut env_splits, &launch.words[launch.at..], &mut env);
		return UrlArgPlan { keep, keep_env: false, env_splits };
	}
	if program_is(cmd, b"find") {
		let keep_env = mark_find(&mut keep, &mut env_splits, &launch.words[launch.at..], &mut env);
		if keep_env {
			for &src in &launch.passed {
				mark_source(&mut keep, &mut env_splits, src);
			}
		}
		return UrlArgPlan { keep, keep_env, env_splits };
	}
	if is_omp(cmd) || first.has_unknown_var {
		mark_omp_args(&mut keep, &mut env_splits, &launch.words, launch.at, &launch.passed, false);
		return UrlArgPlan { keep, keep_env: true, env_splits };
	}
	UrlArgPlan { keep, keep_env: false, env_splits }
}

fn mark_source(keep: &mut [bool], env_splits: &mut [EnvSplitPlan], src: SourceRef) {
	if let Some((group, word)) = src.split {
		if let Some(slot) = env_splits
			.get_mut(group)
			.and_then(|g| g.words.get_mut(word))
		{
			slot.keep = true;
		}
	} else if src.origin < keep.len() {
		keep[src.origin] = true;
	}
}

fn program_name(word: &[u8]) -> &[u8] {
	let name = word
		.rsplit(|&byte| byte == b'/' || (cfg!(windows) && byte == b'\\'))
		.next()
		.unwrap_or(word);
	#[cfg(windows)]
	if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(b".exe") {
		return &name[..name.len() - 4];
	}
	name
}

fn program_is(word: &[u8], expect: &[u8]) -> bool {
	let name = program_name(word);
	if cfg!(windows) {
		name.eq_ignore_ascii_case(expect)
	} else {
		name == expect
	}
}

const fn shell_keyword(word: &[u8]) -> bool {
	matches!(
		word,
		b"if" | b"then" | b"elif" | b"else" | b"while" | b"until" | b"do" | b"{" | b"}" | b"!"
	)
}

fn is_ident(name: &[u8]) -> bool {
	let Some((&first, rest)) = name.split_first() else {
		return false;
	};
	(first.is_ascii_alphabetic() || first == b'_')
		&& rest
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// `NAME=VALUE` (as accepted by `sudo`).
fn ident_assignment(word: &[u8]) -> bool {
	word
		.iter()
		.position(|byte| *byte == b'=')
		.is_some_and(|eq| is_ident(&word[..eq]))
}

/// `NAME=VALUE` or `NAME+=VALUE` (as accepted by Bash/sh before a command).
fn shell_assignment(word: &[u8]) -> bool {
	let Some(eq) = word.iter().position(|byte| *byte == b'=') else {
		return false;
	};
	let name = word[..eq].strip_suffix(b"+").unwrap_or(&word[..eq]);
	is_ident(name)
}

fn split_eq(word: &[u8]) -> (&[u8], Option<&[u8]>) {
	match word.iter().position(|byte| *byte == b'=') {
		Some(at) => (&word[..at], Some(&word[at + 1..])),
		None => (word, None),
	}
}

fn listed(name: &[u8], names: &[&str]) -> bool {
	names.iter().any(|item| item.as_bytes() == name)
}

/// Mark arguments passed to `omp` (and `passed` environment settings). Local
/// spawns resolve the executable at `omp_at` itself (`env local://bin/omp …`);
/// remote SSH commands keep the whole `omp` command untouched.
fn mark_omp_args(
	keep: &mut [bool],
	env_splits: &mut [EnvSplitPlan],
	words: &[VWord<'_>],
	omp_at: usize,
	passed: &[SourceRef],
	include_exec: bool,
) {
	let from = if include_exec { omp_at } else { omp_at + 1 };
	for word in words.iter().skip(from) {
		mark_source(keep, env_splits, word.src);
	}
	for &src in passed {
		mark_source(keep, env_splits, src);
	}
}

/// Iterative walk past launchers starting at `start` (`while` loop: constant
/// stack depth).
fn launch_of_from<'a>(
	mut words: Vec<VWord<'a>>,
	start: usize,
	env: &mut EnvContext<'_>,
	env_splits: &mut Vec<EnvSplitPlan>,
) -> Launch<'a> {
	let mut at = start;
	let mut passed = Vec::new();
	let mut splits = 0usize;
	while at < words.len() {
		let word = words[at].text.as_ref();
		if program_is(word, b"env") {
			let Some(next) = step_env(&mut words, at, &mut passed, &mut splits, env, env_splits)
			else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"sudo") {
			let Some(mut next) = skip_opts(&words, at + 1, &SUDO) else {
				return Launch { words, at, passed, aborted: true };
			};
			while next < words.len() && ident_assignment(words[next].text.as_ref()) {
				env.record_assignment(words[next].text.as_ref());
				passed.push(words[next].src);
				next += 1;
			}
			at = next;
			continue;
		}
		if program_is(word, b"doas") {
			let Some(next) = skip_opts(&words, at + 1, &DOAS) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"nice") {
			let Some(next) = skip_opts(&words, at + 1, &NICE) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"nohup") {
			let Some(next) = skip_opts(&words, at + 1, &NOHUP) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"time") {
			let Some(next) = skip_opts(&words, at + 1, &TIME) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"timeout") || program_is(word, b"gtimeout") {
			let Some(duration) = skip_opts(&words, at + 1, &TIMEOUT) else {
				return Launch { words, at, passed, aborted: true };
			};
			if duration >= words.len() {
				return Launch { words, at: duration, passed, aborted: true };
			}
			at = duration + 1;
			continue;
		}
		if program_is(word, b"stdbuf") {
			let Some(next) = skip_opts(&words, at + 1, &STDBUF) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"setsid") {
			let Some(next) = skip_opts(&words, at + 1, &SETSID) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"ifne") {
			let Some(next) = skip_opts(&words, at + 1, &IFNE) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"xargs") {
			let Some(next) = skip_opts(&words, at + 1, &XARGS) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"exec") {
			let Some(next) = skip_opts(&words, at + 1, &EXEC) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"command") {
			let Some(next) = skip_opts(&words, at + 1, &COMMAND) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"builtin") {
			let mut next = at + 1;
			if next < words.len() && words[next].text.as_ref() == b"--" {
				next += 1;
			}
			if next < words.len()
				&& matches!(words[next].text.as_ref(), b"command" | b"exec" | b"builtin")
			{
				at = next;
				continue;
			}
			break;
		}
		if program_is(word, b"npx") {
			let Some(next) = skip_opts(&words, at + 1, &NPX) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"npm") {
			let Some(sub) = skip_opts(&words, at + 1, &NPM) else {
				return Launch { words, at, passed, aborted: true };
			};
			if sub >= words.len() || !matches!(words[sub].text.as_ref(), b"exec" | b"x") {
				break;
			}
			let Some(next) = skip_opts(&words, sub + 1, &NPM) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"bunx") {
			let Some(next) = skip_opts(&words, at + 1, &BUNX) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"bun") {
			let Some(sub) = skip_opts(&words, at + 1, &BUN_GLOBAL) else {
				return Launch { words, at, passed, aborted: true };
			};
			if sub >= words.len() || words[sub].text.as_ref() != b"x" {
				break;
			}
			let Some(next) = skip_opts(&words, sub + 1, &BUNX) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"uvx") {
			let Some(next) = skip_opts(&words, at + 1, &UVX) else {
				return Launch { words, at, passed, aborted: true };
			};
			at = next;
			continue;
		}
		if program_is(word, b"uv") {
			let Some(sub) = skip_opts(&words, at + 1, &UV_GLOBAL) else {
				return Launch { words, at, passed, aborted: true };
			};
			if sub < words.len() && words[sub].text.as_ref() == b"run" {
				let Some(next) = skip_opts(&words, sub + 1, &UV_RUN) else {
					return Launch { words, at, passed, aborted: true };
				};
				at = next;
				continue;
			}
			if sub + 1 < words.len()
				&& words[sub].text.as_ref() == b"tool"
				&& words[sub + 1].text.as_ref() == b"run"
			{
				let Some(next) = skip_opts(&words, sub + 2, &UVX) else {
					return Launch { words, at, passed, aborted: true };
				};
				at = next;
				continue;
			}
			break;
		}
		break;
	}
	Launch { words, at, passed, aborted: false }
}

/// Step past `env` at `env_at`, expanding `-S` / `--split-string` in place and
/// recording word-level split plans so individual URLs inside `-S` can resolve.
fn step_env(
	words: &mut Vec<VWord<'_>>,
	env_at: usize,
	passed: &mut Vec<SourceRef>,
	splits: &mut usize,
	env: &mut EnvContext<'_>,
	env_splits: &mut Vec<EnvSplitPlan>,
) -> Option<usize> {
	let mut at = env_at + 1;
	while at < words.len() {
		let word = words[at].text.as_ref();
		if word == b"-" || !word.starts_with(b"-") {
			break;
		}
		if word == b"--" {
			at += 1;
			break;
		}
		if let Some(body) = word.strip_prefix(b"--") {
			let (name, attached) = split_eq(body);
			if listed(name, ENV.stop_long) {
				return None;
			}
			if name == b"split-string" {
				if *splits >= MAX_ENV_SPLITS {
					return None;
				}
				*splits += 1;
				if let Some(raw) = attached {
					let src = words[at].src;
					let prefix = &words[at].text[..words[at].text.len() - raw.len()];
					let extra = expand_env_s(src, prefix, raw, env, env_splits);
					words.splice(at..=at, extra);
				} else if at + 1 < words.len() {
					let src = words[at + 1].src;
					let raw = words[at + 1].text.as_ref();
					let extra = expand_env_s(src, b"", raw, env, env_splits);
					words.splice(at..=at + 1, extra);
				} else {
					return None;
				}
				continue;
			}
			if attached.is_some() {
				at += 1;
				continue;
			}
			at += if listed(name, ENV.long_val) && at + 1 < words.len() {
				2
			} else {
				1
			};
			continue;
		}
		// Short option cluster `-...`: check `-0`, `-S`, and value-taking flags.
		let letters = &word[1..];
		let mut split_at = None;
		for (offset, &letter) in letters.iter().enumerate() {
			if ENV.stop_short.contains(&letter) {
				return None;
			}
			if letter == b'S' {
				split_at = Some(offset);
				break;
			}
			if ENV.short_val.contains(&letter) {
				at += if offset + 1 == letters.len() && at + 1 < words.len() {
					2
				} else {
					1
				};
				split_at = Some(usize::MAX);
				break;
			}
		}
		match split_at {
			None => at += 1,
			Some(usize::MAX) => {},
			Some(offset) => {
				if *splits >= MAX_ENV_SPLITS {
					return None;
				}
				*splits += 1;
				if offset + 1 < letters.len() {
					let src = words[at].src;
					let split_pos = 1 + offset + 1;
					let prefix = &words[at].text[..split_pos];
					let raw = &words[at].text[split_pos..];
					let extra = expand_env_s(src, prefix, raw, env, env_splits);
					words.splice(at..=at, extra);
				} else if at + 1 < words.len() {
					let src = words[at + 1].src;
					let raw = words[at + 1].text.as_ref();
					let extra = expand_env_s(src, b"", raw, env, env_splits);
					words.splice(at..=at + 1, extra);
				} else {
					return None;
				}
			},
		}
	}
	if at < words.len() && words[at].text.as_ref() == b"-" {
		at += 1;
	}
	while at < words.len() && words[at].text.contains(&b'=') {
		env.record_assignment(words[at].text.as_ref());
		passed.push(words[at].src);
		at += 1;
	}
	Some(at)
}

fn expand_env_s(
	src: SourceRef,
	prefix: &[u8],
	raw: &[u8],
	env: &EnvContext<'_>,
	env_splits: &mut Vec<EnvSplitPlan>,
) -> Vec<VWord<'static>> {
	let track_plan = src.split.is_none()
		&& !env_splits.iter().any(|plan| plan.index == src.origin)
		&& std::str::from_utf8(prefix).is_ok()
		&& std::str::from_utf8(raw).is_ok();
	let group_idx = track_plan.then_some(env_splits.len());
	let (vwords, plan_words) = split_env_s(raw, src, group_idx, env);
	if track_plan {
		env_splits.push(EnvSplitPlan {
			index:  src.origin,
			prefix: String::from_utf8_lossy(prefix).into_owned(),
			raw:    String::from_utf8_lossy(raw).into_owned(),
			words:  plan_words,
		});
	}
	vwords
}

/// Split an `env -S` string into words (`'…'`, `"…"`, `\` escapes, `#`
/// comments, `${VAR}` / `$VAR` expansions) and record each word's byte span in
/// `raw`.
fn split_env_s(
	raw: &[u8],
	base_src: SourceRef,
	group_idx: Option<usize>,
	env: &EnvContext<'_>,
) -> (Vec<VWord<'static>>, Vec<EnvSplitWord>) {
	let mut vwords = Vec::new();
	let mut plan_words = Vec::new();
	let mut expanded = Vec::new();
	let mut decoded = Vec::new();
	let mut has_unknown_var = false;
	let mut in_word = false;
	let mut word_start = 0usize;
	let mut quote = 0u8;
	let mut i = 0usize;

	let finish_word = |vwords: &mut Vec<VWord<'static>>,
	                   plan_words: &mut Vec<EnvSplitWord>,
	                   expanded: &mut Vec<u8>,
	                   decoded: &mut Vec<u8>,
	                   has_unknown_var: &mut bool,
	                   start: usize,
	                   end: usize| {
		let word_idx = plan_words.len();
		let src = match group_idx {
			Some(group) => SourceRef { origin: base_src.origin, split: Some((group, word_idx)) },
			None => base_src,
		};
		let raw_text = String::from_utf8_lossy(decoded).into_owned();
		decoded.clear();
		plan_words.push(EnvSplitWord { text: raw_text, start, end, keep: false });
		vwords.push(VWord {
			text: Cow::Owned(std::mem::take(expanded)),
			src,
			has_unknown_var: *has_unknown_var,
		});
		*has_unknown_var = false;
	};

	while i < raw.len() {
		let ch = raw[i];
		if quote == b'\'' {
			if ch == b'\\' && i + 1 < raw.len() && matches!(raw[i + 1], b'\'' | b'\\') {
				expanded.push(raw[i + 1]);
				decoded.push(raw[i + 1]);
				i += 2;
				continue;
			}
			if ch == b'\'' {
				quote = 0;
			} else {
				expanded.push(ch);
				decoded.push(ch);
			}
			i += 1;
			continue;
		}
		if quote == b'"' {
			if ch == b'\\' && i + 1 < raw.len() {
				let esc = raw[i + 1];
				if esc == b'c' {
					break;
				}
				let b = unescape_env_s(esc);
				expanded.push(b);
				decoded.push(b);
				i += 2;
				continue;
			}
			if ch == b'$' {
				i = expand_env_s_var(raw, i, env, &mut expanded, &mut decoded, &mut has_unknown_var);
				continue;
			}
			if ch == b'"' {
				quote = 0;
			} else {
				expanded.push(ch);
				decoded.push(ch);
			}
			i += 1;
			continue;
		}
		if ch.is_ascii_whitespace() {
			if in_word {
				finish_word(
					&mut vwords,
					&mut plan_words,
					&mut expanded,
					&mut decoded,
					&mut has_unknown_var,
					word_start,
					i,
				);
				in_word = false;
			}
			i += 1;
			continue;
		}
		if ch == b'#' && !in_word {
			while i < raw.len() && raw[i] != b'\n' {
				i += 1;
			}
			continue;
		}
		if ch == b'\'' || ch == b'"' {
			if !in_word {
				in_word = true;
				word_start = i;
			}
			quote = ch;
			i += 1;
			continue;
		}
		if ch == b'\\' && i + 1 < raw.len() {
			let esc = raw[i + 1];
			if esc == b'c' {
				break;
			}
			if esc == b'_' {
				if in_word {
					finish_word(
						&mut vwords,
						&mut plan_words,
						&mut expanded,
						&mut decoded,
						&mut has_unknown_var,
						word_start,
						i,
					);
					in_word = false;
				}
				i += 2;
				continue;
			}
			if !in_word {
				in_word = true;
				word_start = i;
			}
			let b = unescape_env_s(esc);
			expanded.push(b);
			decoded.push(b);
			i += 2;
			continue;
		}
		if ch == b'$' {
			if !in_word {
				in_word = true;
				word_start = i;
			}
			i = expand_env_s_var(raw, i, env, &mut expanded, &mut decoded, &mut has_unknown_var);
			continue;
		}
		if !in_word {
			in_word = true;
			word_start = i;
		}
		expanded.push(ch);
		decoded.push(ch);
		i += 1;
	}
	if in_word {
		finish_word(
			&mut vwords,
			&mut plan_words,
			&mut expanded,
			&mut decoded,
			&mut has_unknown_var,
			word_start,
			i,
		);
	}
	(vwords, plan_words)
}

/// Expand `${VAR}` (GNU/uutils/BSD) or `$VAR` (BSD) inside `env -S` at `start`.
fn expand_env_s_var(
	raw: &[u8],
	start: usize,
	env: &EnvContext<'_>,
	expanded: &mut Vec<u8>,
	decoded: &mut Vec<u8>,
	has_unknown_var: &mut bool,
) -> usize {
	if raw.get(start + 1) == Some(&b'{') {
		if let Some(rel) = raw[start + 2..].iter().position(|&b| b == b'}') {
			let close = start + 2 + rel;
			let name = &raw[start + 2..close];
			let token = &raw[start..=close];
			decoded.extend_from_slice(token);
			if is_ident(name) {
				if let Some(val) = env.get(name) {
					expanded.extend_from_slice(val);
				} else if !env.complete {
					*has_unknown_var = true;
					expanded.extend_from_slice(token);
				}
			} else {
				if !env.complete {
					*has_unknown_var = true;
				}
				expanded.extend_from_slice(token);
			}
			return close + 1;
		}
		if !env.complete {
			*has_unknown_var = true;
		}
		expanded.push(b'$');
		decoded.push(b'$');
		return start + 1;
	}
	if let Some(&first) = raw.get(start + 1)
		&& (first.is_ascii_alphabetic() || first == b'_')
	{
		let mut end = start + 2;
		while end < raw.len() && (raw[end].is_ascii_alphanumeric() || raw[end] == b'_') {
			end += 1;
		}
		let name = &raw[start + 1..end];
		let token = &raw[start..end];
		decoded.extend_from_slice(token);
		if let Some(val) = env.get(name) {
			expanded.extend_from_slice(val);
		} else if !env.complete {
			*has_unknown_var = true;
			expanded.extend_from_slice(token);
		}
		return end;
	}
	expanded.push(b'$');
	decoded.push(b'$');
	start + 1
}

const fn unescape_env_s(byte: u8) -> u8 {
	match byte {
		b'n' => b'\n',
		b't' => b'\t',
		b'r' => b'\r',
		b'f' => 0x0c,
		b'v' => 0x0b,
		b'_' => b' ',
		other => other,
	}
}

/// Skip options from `index`; returns `None` when a stop/non-exec option hits.
fn skip_opts(words: &[VWord<'_>], mut index: usize, opts: &OptSet) -> Option<usize> {
	while index < words.len() {
		let word = words[index].text.as_ref();
		if word == b"-" || !word.starts_with(b"-") {
			break;
		}
		if word == b"--" {
			return Some(index + 1);
		}
		if let Some(body) = word.strip_prefix(b"--") {
			let (name, attached) = split_eq(body);
			if listed(name, opts.stop_long) {
				return None;
			}
			if attached.is_some() {
				index += 1;
				continue;
			}
			index += if listed(name, opts.long_val) && index + 1 < words.len() {
				2
			} else {
				1
			};
			continue;
		}
		match short_step(&word[1..], opts) {
			ShortStep::Stop => return None,
			ShortStep::Next => index += if index + 1 < words.len() { 2 } else { 1 },
			ShortStep::One => index += 1,
		}
	}
	Some(index)
}

fn short_step(letters: &[u8], opts: &OptSet) -> ShortStep {
	for (offset, &letter) in letters.iter().enumerate() {
		if opts.stop_short.contains(&letter) {
			return ShortStep::Stop;
		}
		if opts.short_val.contains(&letter) {
			return if offset + 1 == letters.len() {
				ShortStep::Next
			} else {
				ShortStep::One
			};
		}
	}
	ShortStep::One
}

/// Find the start of the remote command in `ssh_words` (where `ssh_words[0]` is
/// `ssh`). OpenSSH accepts options before the destination and also after the
/// destination until the first remote command word (unless `--` preceded the
/// destination).
fn ssh_remote_start(ssh_words: &[VWord<'_>]) -> Option<usize> {
	let mut at = 1;
	while at < ssh_words.len() {
		let word = ssh_words[at].text.as_ref();
		if word == b"--" {
			let remote = at + 2;
			return (remote < ssh_words.len()).then_some(remote);
		}
		if word == b"-" || !word.starts_with(b"-") {
			break;
		}
		match short_step(&word[1..], &SSH) {
			ShortStep::Stop => return None,
			ShortStep::Next => at += if at + 1 < ssh_words.len() { 2 } else { 1 },
			ShortStep::One => at += 1,
		}
	}
	if at >= ssh_words.len() {
		return None;
	}
	// `ssh_words[at]` is the destination; consume any post-destination SSH
	// options.
	let remote = skip_opts(ssh_words, at + 1, &SSH)?;
	(remote < ssh_words.len()).then_some(remote)
}

enum RemoteTok {
	Sep,
	Redir { has_target: bool },
	Word(VWord<'static>),
}

/// Separate local `SSH` options and destination from the remote shell command,
/// then protect remote `omp` (and ambiguous) simple commands.
fn mark_ssh(
	keep: &mut [bool],
	env_splits: &mut Vec<EnvSplitPlan>,
	ssh_words: &[VWord<'_>],
	env: &mut EnvContext<'_>,
) {
	let Some(remote) = ssh_remote_start(ssh_words) else {
		return;
	};
	// Skip lexing the remote script altogether when only local options carry
	// URLs.
	if !ssh_words[remote..]
		.iter()
		.any(|word| word.text.contains_str("://"))
	{
		return;
	}
	let Some(tokens) = lex_remote(&ssh_words[remote..]) else {
		for word in &ssh_words[remote..] {
			mark_source(keep, env_splits, word.src);
		}
		return;
	};
	let mut iter = tokens.into_iter().peekable();
	while let Some(tok) = iter.next() {
		if matches!(tok, RemoteTok::Sep) {
			continue;
		}
		let mut cmd_words: Vec<VWord<'static>> = Vec::new();
		let mut all_sources: Vec<SourceRef> = Vec::new();
		let mut current = Some(tok);
		while let Some(item) = current {
			match item {
				RemoteTok::Sep => break,
				RemoteTok::Redir { has_target } => {
					if !has_target && let Some(RemoteTok::Word(target)) = iter.next() {
						all_sources.push(target.src);
					}
				},
				RemoteTok::Word(word) => {
					all_sources.push(word.src);
					cmd_words.push(word);
				},
			}
			current = match iter.peek() {
				Some(RemoteTok::Sep) | None => None,
				Some(_) => iter.next(),
			};
		}
		let mut start = skip_remote_prefix(&cmd_words);
		let mut lead_assigns = Vec::new();
		while start < cmd_words.len() && shell_assignment(cmd_words[start].text.as_ref()) {
			lead_assigns.push(cmd_words[start].src);
			start += 1;
		}
		if start >= cmd_words.len() {
			continue;
		}
		let launch = launch_of_from(cmd_words, start, env, env_splits);
		if launch.aborted || launch.at >= launch.words.len() {
			continue;
		}
		let first = &launch.words[launch.at];
		let cmd = first.text.as_ref();
		if is_omp(cmd) {
			mark_omp_args(keep, env_splits, &launch.words, launch.at, &launch.passed, true);
			for src in lead_assigns {
				mark_source(keep, env_splits, src);
			}
		} else if first.has_unknown_var || ambiguous_remote_cmd(&launch.words[launch.at..]) {
			for src in all_sources {
				mark_source(keep, env_splits, src);
			}
		}
	}
}

/// Skip shell keywords and Bash's `time [-p] [--]` prefix before assignments in
/// a remote command.
fn skip_remote_prefix(words: &[VWord<'_>]) -> usize {
	let mut i = 0;
	while i < words.len() {
		let w = words[i].text.as_ref();
		if shell_keyword(w) {
			i += 1;
			continue;
		}
		if w == b"time" {
			let mut next = i + 1;
			if next < words.len() && words[next].text.as_ref() == b"-p" {
				next += 1;
			}
			if next < words.len() && words[next].text.as_ref() == b"--" {
				next += 1;
			}
			if next >= words.len() || !words[next].text.starts_with(b"-") {
				i = next;
				continue;
			}
		}
		break;
	}
	i
}

fn ambiguous_remote_cmd(words: &[VWord<'_>]) -> bool {
	let Some(first) = words.first() else {
		return false;
	};
	let cmd = first.text.as_ref();
	if cmd
		.iter()
		.any(|byte| matches!(byte, b'$' | b'`' | b'*' | b'?' | b'['))
	{
		return true;
	}
	let base = program_name(cmd);
	if matches!(base, b"eval" | b"." | b"source") {
		return true;
	}
	if matches!(base, b"sh" | b"bash" | b"zsh" | b"dash" | b"ksh") {
		return words[1..]
			.iter()
			.take_while(|w| w.text.starts_with(b"-") && w.text.as_ref() != b"--")
			.any(|w| !w.text.starts_with(b"--") && w.text[1..].contains(&b'c'));
	}
	false
}

/// Tokenize the remote command arguments `ssh` joins for the remote shell.
/// Returns `None` if quoting or a command substitution is unclosed across
/// arguments.
fn lex_remote(remote_words: &[VWord<'_>]) -> Option<Vec<RemoteTok>> {
	let mut out = Vec::new();
	for item in remote_words {
		let bytes = item.text.as_ref();
		let src = item.src;
		let mut i = 0;
		while i < bytes.len() {
			let ch = bytes[i];
			if ch == b' ' || ch == b'\t' {
				i += 1;
				continue;
			}
			if ch == b'#' {
				while i < bytes.len() && bytes[i] != b'\n' {
					i += 1;
				}
				continue;
			}
			if ch == b'&' && bytes.get(i + 1) == Some(&b'>') {
				i += if bytes.get(i + 2) == Some(&b'>') {
					3
				} else {
					2
				};
				let has_target = if i < bytes.len() && !is_remote_meta(bytes[i]) {
					let (_, next) = read_remote_word(bytes, i)?;
					i = next;
					true
				} else {
					false
				};
				out.push(RemoteTok::Redir { has_target });
				continue;
			}
			if matches!(ch, b'\n' | b';' | b'|' | b'&' | b'(' | b')') {
				i += remote_op_len(&bytes[i..]);
				out.push(RemoteTok::Sep);
				continue;
			}
			if let Some((op_end, _)) = remote_redir_at(bytes, i) {
				i = op_end;
				let has_target = if i < bytes.len() && !is_remote_meta(bytes[i]) {
					let (_, next) = read_remote_word(bytes, i)?;
					i = next;
					true
				} else {
					false
				};
				out.push(RemoteTok::Redir { has_target });
				continue;
			}
			let (word, next) = read_remote_word(bytes, i)?;
			out.push(RemoteTok::Word(VWord { text: Cow::Owned(word), src, has_unknown_var: false }));
			i = next;
		}
	}
	Some(out)
}

const fn is_remote_meta(ch: u8) -> bool {
	matches!(ch, b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>')
}

fn remote_op_len(rest: &[u8]) -> usize {
	if rest.starts_with(b";;&") {
		3
	} else if rest.starts_with(b"||")
		|| rest.starts_with(b"|&")
		|| rest.starts_with(b"&&")
		|| rest.starts_with(b";;")
		|| rest.starts_with(b";&")
	{
		2
	} else {
		1
	}
}

fn remote_redir_at(bytes: &[u8], start: usize) -> Option<(usize, u8)> {
	let mut j = start;
	while j < bytes.len() && bytes[j].is_ascii_digit() {
		j += 1;
	}
	let first = *bytes.get(j)?;
	if first != b'<' && first != b'>' {
		return None;
	}
	let rest = &bytes[j..];
	let len = if rest.starts_with(b"<<<") || rest.starts_with(b"<<-") {
		3
	} else if rest.starts_with(b"<<")
		|| rest.starts_with(b"<>")
		|| rest.starts_with(b"<&")
		|| rest.starts_with(b">>")
		|| rest.starts_with(b">|")
		|| rest.starts_with(b">&")
	{
		2
	} else {
		1
	};
	Some((j + len, first))
}

/// Find the closing `)` of `$(` opened just before `start`, respecting quotes
/// and nested parentheses.
fn remote_subst_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut depth = 1usize;
	let mut quote = 0u8;
	let mut i = start;
	while i < bytes.len() {
		let ch = bytes[i];
		if quote == b'\'' {
			if ch == b'\'' {
				quote = 0;
			}
			i += 1;
			continue;
		}
		if ch == b'\\' {
			i += 2;
			continue;
		}
		if quote == b'"' {
			if ch == b'"' {
				quote = 0;
				i += 1;
				continue;
			}
			if ch == b'$' && bytes.get(i + 1) == Some(&b'(') {
				i = remote_subst_end(bytes, i + 2)? + 1;
				continue;
			}
			if ch == b'`' {
				i = remote_backtick_end(bytes, i + 1)? + 1;
				continue;
			}
			i += 1;
			continue;
		}
		if ch == b'\'' || ch == b'"' {
			quote = ch;
			i += 1;
			continue;
		}
		if ch == b'`' {
			i = remote_backtick_end(bytes, i + 1)? + 1;
			continue;
		}
		if ch == b'(' {
			depth += 1;
		} else if ch == b')' {
			depth -= 1;
			if depth == 0 {
				return Some(i);
			}
		}
		i += 1;
	}
	None
}

const fn remote_backtick_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut i = start;
	while i < bytes.len() {
		if bytes[i] == b'\\' {
			i += 2;
			continue;
		}
		if bytes[i] == b'`' {
			return Some(i);
		}
		i += 1;
	}
	None
}

const fn remote_brace_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut depth = 1usize;
	let mut quote = 0u8;
	let mut i = start;
	while i < bytes.len() {
		let ch = bytes[i];
		if quote == b'\'' {
			if ch == b'\'' {
				quote = 0;
			}
			i += 1;
			continue;
		}
		if ch == b'\\' {
			i += 2;
			continue;
		}
		if quote == b'"' {
			if ch == b'"' {
				quote = 0;
			}
			i += 1;
			continue;
		}
		if ch == b'\'' || ch == b'"' {
			quote = ch;
			i += 1;
			continue;
		}
		if ch == b'{' {
			depth += 1;
		} else if ch == b'}' {
			depth -= 1;
			if depth == 0 {
				return Some(i);
			}
		}
		i += 1;
	}
	None
}

fn read_remote_word(bytes: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
	let mut value = Vec::new();
	let mut i = start;
	while i < bytes.len() && !is_remote_meta(bytes[i]) {
		let ch = bytes[i];
		if ch == b'\'' {
			i += 1;
			while i < bytes.len() && bytes[i] != b'\'' {
				value.push(bytes[i]);
				i += 1;
			}
			if i >= bytes.len() {
				return None;
			}
			i += 1;
			continue;
		}
		if ch == b'"' {
			i += 1;
			while i < bytes.len() && bytes[i] != b'"' {
				if bytes[i] == b'\\'
					&& i + 1 < bytes.len()
					&& matches!(bytes[i + 1], b'"' | b'\\' | b'$' | b'`')
				{
					value.push(bytes[i + 1]);
					i += 2;
					continue;
				}
				if bytes[i] == b'$' && bytes.get(i + 1) == Some(&b'(') {
					let end = remote_subst_end(bytes, i + 2)?;
					value.extend_from_slice(&bytes[i..=end]);
					i = end + 1;
					continue;
				}
				if bytes[i] == b'$' && bytes.get(i + 1) == Some(&b'{') {
					let end = remote_brace_end(bytes, i + 2)?;
					value.extend_from_slice(&bytes[i..=end]);
					i = end + 1;
					continue;
				}
				if bytes[i] == b'`' {
					let end = remote_backtick_end(bytes, i + 1)?;
					value.extend_from_slice(&bytes[i..=end]);
					i = end + 1;
					continue;
				}
				value.push(bytes[i]);
				i += 1;
			}
			if i >= bytes.len() {
				return None;
			}
			i += 1;
			continue;
		}
		if ch == b'\\' {
			if i + 1 >= bytes.len() {
				return None;
			}
			value.push(bytes[i + 1]);
			i += 2;
			continue;
		}
		if ch == b'$' && bytes.get(i + 1) == Some(&b'(') {
			let end = remote_subst_end(bytes, i + 2)?;
			value.extend_from_slice(&bytes[i..=end]);
			i = end + 1;
			continue;
		}
		if ch == b'$' && bytes.get(i + 1) == Some(&b'{') {
			let end = remote_brace_end(bytes, i + 2)?;
			value.extend_from_slice(&bytes[i..=end]);
			i = end + 1;
			continue;
		}
		if ch == b'`' {
			let end = remote_backtick_end(bytes, i + 1)?;
			value.extend_from_slice(&bytes[i..=end]);
			i = end + 1;
			continue;
		}
		value.push(ch);
		i += 1;
	}
	Some((value, i))
}

fn mark_find(
	keep: &mut [bool],
	env_splits: &mut Vec<EnvSplitPlan>,
	find_words: &[VWord<'_>],
	env: &mut EnvContext<'_>,
) -> bool {
	let mut index = 1;
	let mut reaches = false;
	while index < find_words.len() {
		let word = find_words[index].text.as_ref();
		if matches!(word, b"-exec" | b"-execdir" | b"-ok" | b"-okdir") {
			let start = index + 1;
			let mut end = start;
			while end < find_words.len() && !matches!(find_words[end].text.as_ref(), b";" | b"+") {
				end += 1;
			}
			if start < end {
				let slice: Vec<VWord<'_>> = find_words[start..end]
					.iter()
					.map(|w| VWord {
						text:            Cow::Borrowed(w.text.as_ref()),
						src:             w.src,
						has_unknown_var: w.has_unknown_var,
					})
					.collect();
				let launch = launch_of_from(slice, 0, env, env_splits);
				if !launch.aborted && launch.at < launch.words.len() {
					let first = &launch.words[launch.at];
					if is_omp(first.text.as_ref()) || first.has_unknown_var {
						reaches = true;
						mark_omp_args(keep, env_splits, &launch.words, launch.at, &launch.passed, false);
					}
				}
			}
			index = end + 1;
			continue;
		}
		index += 1;
	}
	reaches
}

// ── Canonical launcher option tables (shared with client via
// `classify_url_args`) ──

const ENV: OptSet = OptSet {
	short_val:  b"CPafu",
	long_val:   &["argv0", "chdir", "env0-from", "file", "unset"],
	stop_short: b"0",
	stop_long:  &["help", "null", "version"],
};

const SUDO: OptSet = OptSet {
	short_val:  b"CDRTUghprtu",
	long_val:   &[
		"chdir",
		"chroot",
		"close-from",
		"command-timeout",
		"group",
		"host",
		"other-user",
		"prompt",
		"role",
		"type",
		"user",
	],
	stop_short: b"KVevl",
	stop_long:  &["edit", "help", "list", "remove-timestamp", "validate", "version"],
};

const DOAS: OptSet =
	OptSet { short_val: b"au", long_val: &[], stop_short: b"CL", stop_long: &[] };

const NICE: OptSet = OptSet {
	short_val:  b"n",
	long_val:   &["adjustment"],
	stop_short: b"",
	stop_long:  &["help", "version"],
};

const NOHUP: OptSet =
	OptSet { short_val: b"", long_val: &[], stop_short: b"", stop_long: &["help", "version"] };

const TIME: OptSet = OptSet {
	short_val:  b"fo",
	long_val:   &["format", "output"],
	stop_short: b"",
	stop_long:  &["help", "version"],
};

const TIMEOUT: OptSet = OptSet {
	short_val:  b"ks",
	long_val:   &["kill-after", "signal"],
	stop_short: b"",
	stop_long:  &["help", "version"],
};

const STDBUF: OptSet = OptSet {
	short_val:  b"eio",
	long_val:   &["error", "input", "output"],
	stop_short: b"",
	stop_long:  &["help", "version"],
};

const SETSID: OptSet =
	OptSet { short_val: b"", long_val: &[], stop_short: b"Vh", stop_long: &["help", "version"] };

const IFNE: OptSet =
	OptSet { short_val: b"", long_val: &[], stop_short: b"h", stop_long: &["help", "version"] };

const XARGS: OptSet = OptSet {
	short_val:  b"EILPadns",
	long_val:   &[
		"arg-file",
		"delimiter",
		"max-args",
		"max-chars",
		"max-lines",
		"max-procs",
		"process-slot-var",
	],
	stop_short: b"",
	stop_long:  &["help", "version"],
};

const EXEC: OptSet =
	OptSet { short_val: b"a", long_val: &[], stop_short: b"", stop_long: &["help"] };

const COMMAND: OptSet =
	OptSet { short_val: b"", long_val: &[], stop_short: b"Vv", stop_long: &["help"] };

const NPM_VAL: &[&str] = &[
	"_auth",
	"access",
	"allow-directory",
	"allow-file",
	"allow-git",
	"allow-remote",
	"allow-scripts",
	"also",
	"audit-level",
	"auth-type",
	"before",
	"ca",
	"cache",
	"cache-max",
	"cache-min",
	"cafile",
	"cert",
	"cidr",
	"cpu",
	"depth",
	"diff",
	"diff-dst-prefix",
	"diff-src-prefix",
	"diff-unified",
	"editor",
	"expect-result-count",
	"expires",
	"fetch-retries",
	"fetch-retry-factor",
	"fetch-retry-maxtimeout",
	"fetch-retry-mintimeout",
	"fetch-timeout",
	"git",
	"globalconfig",
	"heading",
	"https-proxy",
	"include",
	"init-author-email",
	"init-author-name",
	"init-author-url",
	"init-license",
	"init-module",
	"init-type",
	"init-version",
	"init.author.email",
	"init.author.name",
	"init.author.url",
	"init.license",
	"init.module",
	"init.version",
	"install-strategy",
	"key",
	"libc",
	"local-address",
	"location",
	"lockfile-version",
	"loglevel",
	"logs-dir",
	"logs-max",
	"maxsockets",
	"message",
	"min-release-age",
	"name",
	"node-arg",
	"node-gyp",
	"node-options",
	"noproxy",
	"omit",
	"only",
	"orgs",
	"orgs-permission",
	"os",
	"otp",
	"pack-destination",
	"package",
	"packages",
	"packages-and-scopes-permission",
	"password",
	"prefix",
	"preid",
	"provenance-file",
	"proxy",
	"registry",
	"replace-registry-host",
	"save-prefix",
	"sbom-format",
	"sbom-type",
	"scope",
	"scopes",
	"script-shell",
	"searchexclude",
	"searchlimit",
	"searchopts",
	"searchstaleness",
	"shell",
	"tag",
	"tag-version-prefix",
	"token-description",
	"umask",
	"user-agent",
	"userconfig",
	"viewer",
	"which",
	"workspace",
];

const NPM: OptSet = OptSet {
	short_val:  b"CLmw",
	long_val:   NPM_VAL,
	stop_short: b"H?chv",
	stop_long:  &["call", "help", "usage", "version", "versions"],
};

const NPX: OptSet = OptSet {
	short_val:  b"CLmpw",
	long_val:   NPM_VAL,
	stop_short: b"H?chv",
	stop_long:  &["call", "help", "usage", "version", "versions"],
};

const BUN_GLOBAL: OptSet = OptSet {
	short_val:  b"Fcr",
	long_val:   &[
		"ca",
		"cafile",
		"conditions",
		"config",
		"cpu-prof-dir",
		"cpu-prof-interval",
		"cpu-prof-name",
		"cwd",
		"dns-result-order",
		"elide-lines",
		"env-file",
		"fetch-preconnect",
		"filter",
		"heap-prof-dir",
		"heap-prof-interval",
		"heap-prof-name",
		"import",
		"install",
		"max-http-header-size",
		"minimum-release-age",
		"port",
		"preload",
		"redirect-warnings",
		"registry",
		"require",
		"shell",
		"watch-kill-signal",
	],
	stop_short: b"epv",
	stop_long:  &["eval", "help", "print", "revision", "version"],
};

const BUNX: OptSet = OptSet {
	short_val:  b"p",
	long_val:   &[
		"ca",
		"cafile",
		"config",
		"cwd",
		"env-file",
		"minimum-release-age",
		"package",
		"registry",
	],
	stop_short: b"v",
	stop_long:  &["help", "version"],
};

const UV_VAL: &[&str] = &[
	"allow-insecure-host",
	"build-constraints",
	"cache-dir",
	"color",
	"config-file",
	"config-setting",
	"config-settings-package",
	"constraints",
	"default-index",
	"directory",
	"env-file",
	"exclude-newer",
	"exclude-newer-package",
	"extra",
	"extra-index-url",
	"find-links",
	"fork-strategy",
	"from",
	"group",
	"index",
	"index-strategy",
	"index-url",
	"keyring-provider",
	"link-mode",
	"no-binary-package",
	"no-build-isolation-package",
	"no-build-package",
	"no-editable-package",
	"no-extra",
	"no-group",
	"no-sources-package",
	"only-group",
	"overrides",
	"package",
	"prerelease",
	"prerelease-package",
	"project",
	"python",
	"python-platform",
	"refresh-package",
	"reinstall-package",
	"resolution",
	"torch-backend",
	"upgrade-group",
	"upgrade-package",
	"with",
	"with-editable",
	"with-requirements",
];

const UV_GLOBAL: OptSet = OptSet {
	short_val:  b"CPfipw",
	long_val:   UV_VAL,
	stop_short: b"Vh",
	stop_long:  &["help", "version"],
};

const UV_RUN: OptSet = OptSet {
	short_val:  b"CPfipw",
	long_val:   UV_VAL,
	stop_short: b"Vhms",
	stop_long:  &["gui-script", "help", "module", "script", "version"],
};

const UVX: OptSet = OptSet {
	short_val:  b"CPbcfipw",
	long_val:   UV_VAL,
	stop_short: b"Vh",
	stop_long:  &["help", "version"],
};

const SSH: OptSet = OptSet {
	// OpenSSH options whose argument is the next word: -B -b -c -D -E -e -F
	// -I -i -J -L -l -m -O -o -p -Q -R -S -W -w.
	short_val:  b"BbcDEeFIJiLlmOopQRWSw",
	long_val:   &[],
	stop_short: b"GNV",
	stop_long:  &[],
};

#[cfg(test)]
mod tests {
	use bstr::BString;

	use super::{EnvSplitPlan, UrlArgPlan, classify_url_args, omp_owned};

	fn owned(words: &[&str]) -> (Vec<usize>, bool) {
		let argv: Vec<BString> = words.iter().copied().map(BString::from).collect();
		let plan = omp_owned(&argv, None);
		let indexes = plan
			.keep
			.iter()
			.enumerate()
			.filter(|(_, keep)| **keep)
			.map(|(index, _)| index)
			.collect();
		(indexes, plan.keep_env)
	}

	fn classify_with_env(words: &[&str], env: &[(&str, &str)], complete: bool) -> UrlArgPlan {
		let argv: Vec<String> = words.iter().copied().map(str::to_owned).collect();
		let pairs: Vec<(String, String)> = env
			.iter()
			.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
			.collect();
		classify_url_args(&argv, Some(&pairs), complete)
	}

	fn is_omp_word(word: &[u8]) -> bool {
		super::is_omp(word)
	}

	#[test]
	fn an_argument_spelled_omp_is_not_an_omp_command() {
		assert_eq!(owned(&["grep", "omp", "local://out.txt"]), (vec![], false));
		assert_eq!(owned(&["ls", "./omp", "local://dir"]), (vec![], false));
		assert_eq!(owned(&["rg", "-n", "omp", "skill://x/SKILL.md"]), (vec![], false));
		assert!(is_omp_word(b"./omp") && is_omp_word(b"/opt/omp"));
	}

	#[test]
	fn omp_protects_its_arguments_and_resolves_launcher_executables() {
		assert_eq!(owned(&["omp", "read", "local://x"]), (vec![1, 2], true));
		assert_eq!(owned(&["/usr/local/bin/omp", "read", "local://x"]), (vec![1, 2], true));
		assert_eq!(owned(&["nice", "omp", "read", "local://x"]), (vec![2, 3], true));
		assert_eq!(owned(&["env", "local://bin/omp", "read", "local://doc"]), (vec![2, 3], true));
		assert_eq!(owned(&["/usr/bin/env", "-", "omp", "read", "local://x"]), (vec![3, 4], true));
		assert_eq!(owned(&["env", "-u", "FOO", "-", "omp", "read", "local://x"]), (vec![5, 6], true));
		assert_eq!(
			owned(&["sudo", "-u", "root", "F=local://x", "omp", "read", "local://y"]),
			(vec![3, 5, 6], true)
		);
		assert_eq!(
			owned(&["sudo", "env", "-u", "FOO", "nice", "omp", "read", "local://x"]),
			(vec![6, 7], true)
		);
	}

	#[test]
	fn env_settings_split_strings_and_variable_expansion_work() {
		assert_eq!(
			owned(&["env", "--", "-flag=/opt/omp", "grep", "x", "local://file"]),
			(vec![], false)
		);
		assert_eq!(
			owned(&["env", "tool.name=/opt/omp", "grep", "x", "local://file"]),
			(vec![], false)
		);
		assert_eq!(
			owned(&["env", "-C", "local://dir", "omp", "read", "local://x"]),
			(vec![4, 5], true)
		);
		assert_eq!(
			owned(&["env", "FILE=local://in", "omp", "read", "local://x"]),
			(vec![1, 3, 4], true)
		);
		assert_eq!(owned(&["env", "-", "-u", "FOO", "omp"]), (vec![], false));
		assert_eq!(owned(&["env", "-S", "cat", "omp", "local://in"]), (vec![], false));
		assert_eq!(owned(&["env", "-S", "omp", "read", "local://in"]), (vec![3, 4], true));
		assert_eq!(
			owned(&["env", "--default-signal", "omp", "read", "local://x"]),
			(vec![3, 4], true)
		);
		assert_eq!(
			owned(&["env", "--default-signal=PIPE", "omp", "read", "local://x"]),
			(vec![3, 4], true)
		);
		assert_eq!(
			owned(&["env", "--list-signal-handling", "omp", "read", "local://x"]),
			(vec![3, 4], true)
		);

		// Per-word split plan: executable inside `-S` stays rewritable while
		// `read` and outer file are kept.
		let split_plan =
			classify_with_env(&["env", "-S", "local://bin/omp read", "local://file"], &[], false);
		assert_eq!(split_plan.keep, vec![false, false, false, true]);
		assert!(split_plan.keep_env);
		assert_eq!(split_plan.env_splits.len(), 1);
		let EnvSplitPlan { index, words, .. } = &split_plan.env_splits[0];
		assert_eq!(*index, 2);
		assert!(!words[0].keep && words[0].text == "local://bin/omp");
		assert!(words[1].keep && words[1].text == "read");

		// `${RUN}` expands from known env, and preserves arguments when unknown.
		let known_omp =
			classify_with_env(&["env", "-S", "${RUN}", "read", "local://in"], &[("RUN", "omp")], true);
		assert_eq!(known_omp.keep, vec![false, false, false, true, true]);
		assert!(known_omp.keep_env);

		let known_cat =
			classify_with_env(&["env", "-S", "${RUN}", "omp", "local://in"], &[("RUN", "cat")], true);
		assert_eq!(known_cat.keep, vec![false, false, false, false, false]);
		assert!(!known_cat.keep_env);

		let unknown_var =
			classify_with_env(&["env", "-S", "${RUN}", "read", "local://in"], &[], false);
		assert_eq!(unknown_var.keep, vec![false, false, false, true, true]);
		assert!(unknown_var.keep_env);
	}

	#[test]
	fn package_runners_and_non_exec_modes_match_client() {
		assert_eq!(
			owned(&["npx", "--loglevel", "warn", "omp", "read", "local://x"]),
			(vec![4, 5], true)
		);
		assert_eq!(owned(&["npx", "--no-audit", "omp", "read", "local://x"]), (vec![3, 4], true));
		assert_eq!(owned(&["npx", "--cache", "omp", "eslint", "local://app.ts"]), (vec![], false));
		assert_eq!(owned(&["npx", "-p", "eslint", "local://app.ts"]), (vec![], false));
		assert_eq!(owned(&["npx", "-c", "omp", "local://app.ts"]), (vec![], false));
		assert_eq!(owned(&["npm", "exec", "-p", "omp", "read", "local://x"]), (vec![4, 5], true));
		assert_eq!(
			owned(&["npm", "--prefix", "local://tools", "exec", "--", "omp", "read", "local://book"]),
			(vec![6, 7], true)
		);
		assert_eq!(owned(&["npm", "install", "local://pkg"]), (vec![], false));
		assert_eq!(
			owned(&["bunx", "--minimum-release-age", "86400", "omp", "read", "local://book"]),
			(vec![4, 5], true)
		);
		assert_eq!(
			owned(&["bunx", "--registry", "https://example", "omp", "read", "local://book"]),
			(vec![4, 5], true)
		);
		assert_eq!(
			owned(&["uv", "run", "-w", "requests", "omp", "read", "local://book"]),
			(vec![5, 6], true)
		);
		assert_eq!(
			owned(&["uv", "run", "--resolution", "lowest", "omp", "read", "local://book"]),
			(vec![5, 6], true)
		);
		// Lookup, module, script and edit modes do not run the `omp` binary.
		assert_eq!(owned(&["command", "-v", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["command", "-V", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["command", "-p", "omp", "read", "local://x"]), (vec![3, 4], true));
		assert_eq!(owned(&["builtin", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["builtin", "command", "omp", "read", "local://x"]), (vec![3, 4], true));
		assert_eq!(owned(&["builtin", "exec", "omp", "read", "local://x"]), (vec![3, 4], true));
		assert_eq!(owned(&["uv", "run", "--module", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["uv", "run", "-m", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["uv", "run", "--script", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["sudo", "-e", "omp", "local://file"]), (vec![], false));
		assert_eq!(owned(&["sudo", "-l", "omp", "local://file"]), (vec![], false));
	}

	#[test]
	fn launchers_and_deep_chains_stay_iterative() {
		assert_eq!(owned(&["setsid", "omp", "read", "local://x"]), (vec![2, 3], true));
		assert_eq!(owned(&["setsid", "grep", "omp", "local://x"]), (vec![], false));
		assert_eq!(owned(&["xargs", "omp", "read", "local://x"]), (vec![2, 3], true));
		assert_eq!(owned(&["xargs", "--replace", "omp", "read", "local://x"]), (vec![3, 4], true));
		assert_eq!(owned(&["xargs", "-a", "local://list", "omp", "read"]), (vec![4], true));
		assert_eq!(owned(&["ifne", "-n", "grep", "local://x"]), (vec![], false));
		assert_eq!(owned(&["ifne", "omp", "read", "local://x"]), (vec![2, 3], true));
		assert_eq!(
			owned(&["timeout", "-k", "5", "30", "omp", "read", "local://x"]),
			(vec![5, 6], true)
		);
		assert_eq!(owned(&["stdbuf", "-o", "L", "omp", "read", "local://x"]), (vec![4, 5], true));

		let mut chain = vec!["nice"; 5_000];
		chain.extend(["omp", "read", "local://x"]);
		assert_eq!(owned(&chain), (vec![5_001, 5_002], true));
	}

	#[test]
	fn ssh_separates_local_options_from_remote_commands() {
		assert_eq!(
			owned(&["ssh", "-F", "local://config", "server", "omp", "read", "skill://x"]),
			(vec![4, 5, 6], false)
		);
		// OpenSSH accepts options such as `-p` after the destination.
		assert_eq!(
			owned(&["ssh", "host", "-p", "2223", "omp", "read", "local://x"]),
			(vec![4, 5, 6], false)
		);
		assert_eq!(
			owned(&["ssh", "host", "-F", "local://cfg", "omp", "read", "local://x"]),
			(vec![4, 5, 6], false)
		);
		assert_eq!(
			owned(&["ssh", "host", "LANG=C", "omp", "read", "local://in"]),
			(vec![2, 3, 4, 5], false)
		);
		assert_eq!(
			owned(&["ssh", "host", "time", "FOO=x", "omp", "read", "local://in"]),
			(vec![3, 4, 5, 6], false)
		);
		assert_eq!(
			owned(&["ssh", "host", "TAG+=extra", "omp", "read", "local://in"]),
			(vec![2, 3, 4, 5], false)
		);
		assert_eq!(owned(&["ssh", "host", "LANG=C omp read", "local://in"]), (vec![2, 3], false));
		assert_eq!(owned(&["ssh", "host", "$(command -v omp)", "local://in"]), (vec![2, 3], false));
		assert_eq!(owned(&["ssh", "host", "cat \"$HOME/note\"", "local://in"]), (vec![], false));
		assert_eq!(owned(&["ssh", "host", "$RUNNER", "local://in"]), (vec![2, 3], false));
		assert_eq!(
			owned(&["ssh", "server", "omp", "read", "local://book", "|", "cat", "local://other"]),
			(vec![2, 3, 4], false)
		);
		assert_eq!(
			owned(&["ssh", "server", "omp", "read", "local://book", "2>&1"]),
			(vec![2, 3, 4], false)
		);
		assert_eq!(
			owned(&["ssh", "server", "cat", "local://file", "|", "omp", "read", "local://book"]),
			(vec![5, 6, 7], false)
		);
		assert_eq!(
			owned(&["sudo", "ssh", "server", "omp", "read", "local://x"]),
			(vec![3, 4, 5], false)
		);
	}

	#[test]
	fn find_exec_preserves_outer_settings_without_blocking_launcher_files() {
		assert_eq!(
			owned(&["find", "local://docs", "-exec", "omp", "read", "local://x", ";"]),
			(vec![4, 5], true)
		);
		assert_eq!(
			owned(&[
				"env",
				"-C",
				"local://dir",
				"FOO=local://var",
				"find",
				"local://docs",
				"-exec",
				"local://bin/omp",
				"read",
				"local://doc",
				";",
			]),
			(vec![3, 8, 9], true)
		);
		assert_eq!(
			owned(&["find", "local://docs", "-name", "a.txt", "-exec", "probe", "{}", ";"]),
			(vec![], false)
		);
	}
}
