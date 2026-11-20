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
	/// Which arguments and environment belong to `omp` and stay literal.
	owned:    OmpOwned,
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

/// Arguments `omp` itself reads, and whether the environment reaches `omp`.
pub(super) struct OmpOwned {
	/// `args[i]` is a word `omp` reads (an argument passed to `omp`, or an
	/// assignment a wrapper puts in `omp`'s environment). Empty when no
	/// argument had a URL candidate.
	args: Vec<bool>,
	/// The spawned environment is handed to `omp`, so its URLs stay as written.
	env:  bool,
}

impl OmpOwned {
	fn arg(&self, index: usize) -> bool {
		self.args.get(index).copied().unwrap_or(false)
	}
}

/// Plan URL resolution for `spec`, returning `None` (with no allocation or
/// launcher walk when no candidate URL is present) when `spec` can spawn as-is.
pub(super) fn plan(spec: &SpawnSpec<'_>) -> Option<OmpOwned> {
	let path_or_cwd_url = is_url(spec.path) || is_url(spec.cwd);
	let arg_has_url = spec.argv.iter().skip(1).any(|arg| arg.contains_str("://"));
	let env_has_url = spec.env.iter().any(|(name, value)| env_url(name, value));
	if !path_or_cwd_url && !arg_has_url && !env_has_url {
		return None;
	}
	if !arg_has_url && !env_has_url {
		return Some(OmpOwned { args: Vec::new(), env: true });
	}
	let owned = omp_owned(spec.argv);
	let needs_arg = arg_has_url
		&& spec
			.argv
			.iter()
			.enumerate()
			.skip(1)
			.any(|(index, arg)| !owned.arg(index) && arg.contains_str("://"));
	let needs_env = env_has_url && !owned.env;
	if !path_or_cwd_url && !needs_arg && !needs_env {
		return None;
	}
	Some(owned)
}

/// Take `spec` apart for a spawn that waits on the provider, carrying `owned`
/// forward so [`resolve`] does not walk `argv` a second time.
pub(super) fn split(spec: SpawnSpec<'_>, owned: OmpOwned) -> (Names, Rest) {
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

/// `omp` as the program, or as the command a known wrapper runs. An argument
/// merely spelled `omp` (`grep omp local://out.txt`, `ls ./omp local://dir`)
/// does not count. The same walk the client terminal applies
/// (`bash-host-urls.ts`).
fn omp_owned(argv: &[BString]) -> OmpOwned {
	let mut args = vec![false; argv.len()];
	if argv.is_empty() {
		return OmpOwned { args, env: false };
	}
	let vwords: Vec<VWord<'_>> = argv
		.iter()
		.enumerate()
		.map(|(origin, word)| VWord { text: Cow::Borrowed(word.as_slice()), origin })
		.collect();
	let launch = launch_of(vwords);
	if launch.aborted || launch.at >= launch.words.len() {
		return OmpOwned { args, env: false };
	}
	let cmd = launch.words[launch.at].text.as_ref();
	if program_is(cmd, b"ssh") {
		mark_ssh(&mut args, &launch.words[launch.at..]);
		return OmpOwned { args, env: false };
	}
	if program_is(cmd, b"find") {
		let env = mark_find(&mut args, &launch.words[launch.at..]);
		if env {
			for &passed in &launch.passed {
				if passed < args.len() {
					args[passed] = true;
				}
			}
		}
		return OmpOwned { args, env };
	}
	if !is_omp(cmd) {
		return OmpOwned { args, env: false };
	}
	mark_omp_args(&mut args, &launch.words, launch.at, &launch.passed, false);
	OmpOwned { args, env: true }
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
		let host = if i == 0 || names.owned.arg(i) {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !names.owned.env {
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
	Ok(Names { path, argv, env, cwd, owned: OmpOwned { args: Vec::new(), env: names.owned.env } })
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

/// One logical word in a command walk, and the `argv` slot it came from.
#[derive(Clone)]
struct VWord<'a> {
	text:   Cow<'a, [u8]>,
	origin: usize,
}

/// Result of walking past launchers (`env`, `sudo`, `npx`, `uv run`, …).
struct Launch<'a> {
	words:   Vec<VWord<'a>>,
	at:      usize,
	passed:  Vec<usize>,
	aborted: bool,
}

/// Options a launcher takes before the command it runs. Shared 1-for-1 with
/// `bash-host-urls.ts`.
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

fn ident_assignment(word: &[u8]) -> bool {
	let Some(eq) = word.iter().position(|byte| *byte == b'=') else {
		return false;
	};
	let Some((&first, rest)) = word[..eq].split_first() else {
		return false;
	};
	(first.is_ascii_alphabetic() || first == b'_')
		&& rest
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
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
	args: &mut [bool],
	words: &[VWord<'_>],
	omp_at: usize,
	passed: &[usize],
	include_exec: bool,
) {
	let from = if include_exec { omp_at } else { omp_at + 1 };
	for word in words.iter().skip(from) {
		if word.origin < args.len() {
			args[word.origin] = true;
		}
	}
	for &origin in passed {
		if origin < args.len() {
			args[origin] = true;
		}
	}
}

/// Iterative walk past launchers (`while` loop: constant stack depth).
fn launch_of(mut words: Vec<VWord<'_>>) -> Launch<'_> {
	let mut at = 0;
	let mut passed = Vec::new();
	let mut splits = 0usize;
	while at < words.len() {
		let word = words[at].text.as_ref();
		if program_is(word, b"env") {
			let Some(next) = step_env(&mut words, at, &mut passed, &mut splits) else {
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
				passed.push(words[next].origin);
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

/// Step past `env` at `env_at`, expanding `-S` / `--split-string` in place.
fn step_env(
	words: &mut Vec<VWord<'_>>,
	env_at: usize,
	passed: &mut Vec<usize>,
	splits: &mut usize,
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
					let origin = words[at].origin;
					let extra = split_env_s(raw, origin);
					words.splice(at..=at, extra);
				} else if at + 1 < words.len() {
					let origin = words[at + 1].origin;
					let extra = split_env_s(words[at + 1].text.as_ref(), origin);
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
					let origin = words[at].origin;
					let extra = split_env_s(&letters[offset + 1..], origin);
					words.splice(at..=at, extra);
				} else if at + 1 < words.len() {
					let origin = words[at + 1].origin;
					let extra = split_env_s(words[at + 1].text.as_ref(), origin);
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
		passed.push(words[at].origin);
		at += 1;
	}
	Some(at)
}

/// Split an `env -S` string into words (`'…'`, `"…"`, `\` escapes, `#`
/// comments).
fn split_env_s(raw: &[u8], origin: usize) -> Vec<VWord<'static>> {
	let mut out = Vec::new();
	let mut current = Vec::new();
	let mut in_word = false;
	let mut quote = 0u8;
	let mut i = 0;
	while i < raw.len() {
		let ch = raw[i];
		if quote == b'\'' {
			if ch == b'\\' && i + 1 < raw.len() && matches!(raw[i + 1], b'\'' | b'\\') {
				current.push(raw[i + 1]);
				i += 2;
				continue;
			}
			if ch == b'\'' {
				quote = 0;
			} else {
				current.push(ch);
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
				current.push(unescape_env_s(esc));
				i += 2;
				continue;
			}
			if ch == b'"' {
				quote = 0;
			} else {
				current.push(ch);
			}
			i += 1;
			continue;
		}
		if ch.is_ascii_whitespace() {
			if in_word {
				out.push(VWord { text: Cow::Owned(std::mem::take(&mut current)), origin });
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
			quote = ch;
			in_word = true;
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
					out.push(VWord { text: Cow::Owned(std::mem::take(&mut current)), origin });
					in_word = false;
				}
				i += 2;
				continue;
			}
			in_word = true;
			current.push(unescape_env_s(esc));
			i += 2;
			continue;
		}
		in_word = true;
		current.push(ch);
		i += 1;
	}
	if in_word {
		out.push(VWord { text: Cow::Owned(current), origin });
	}
	out
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

enum RemoteTok {
	Sep,
	Redir { has_target: bool },
	Word(VWord<'static>),
}

/// Separate local `SSH` options and destination from the remote shell command,
/// then protect remote `omp` (and ambiguous) simple commands.
fn mark_ssh(args: &mut [bool], ssh_words: &[VWord<'_>]) {
	let Some(host) = skip_opts(ssh_words, 1, &SSH) else {
		return;
	};
	let remote = host + 1;
	if remote >= ssh_words.len() {
		return;
	}
	let Some(tokens) = lex_remote(&ssh_words[remote..]) else {
		for word in &ssh_words[remote..] {
			if word.origin < args.len() {
				args[word.origin] = true;
			}
		}
		return;
	};
	let mut i = 0;
	while i < tokens.len() {
		if matches!(tokens[i], RemoteTok::Sep) {
			i += 1;
			continue;
		}
		let mut cmd_words: Vec<VWord<'_>> = Vec::new();
		let mut all_origins: Vec<usize> = Vec::new();
		while i < tokens.len() && !matches!(tokens[i], RemoteTok::Sep) {
			match &tokens[i] {
				RemoteTok::Sep => break,
				RemoteTok::Redir { has_target } => {
					i += 1;
					if !has_target && let Some(RemoteTok::Word(target)) = tokens.get(i) {
						all_origins.push(target.origin);
						i += 1;
					}
				},
				RemoteTok::Word(word) => {
					all_origins.push(word.origin);
					cmd_words.push(word.clone());
					i += 1;
				},
			}
		}
		let mut start = 0;
		while start < cmd_words.len() && shell_keyword(cmd_words[start].text.as_ref()) {
			start += 1;
		}
		let mut lead_assigns = Vec::new();
		while start < cmd_words.len() && ident_assignment(cmd_words[start].text.as_ref()) {
			lead_assigns.push(cmd_words[start].origin);
			start += 1;
		}
		if start >= cmd_words.len() {
			continue;
		}
		let launch = launch_of(cmd_words[start..].to_vec());
		if launch.aborted || launch.at >= launch.words.len() {
			continue;
		}
		let cmd = launch.words[launch.at].text.as_ref();
		if is_omp(cmd) {
			mark_omp_args(args, &launch.words, launch.at, &launch.passed, true);
			for origin in lead_assigns {
				if origin < args.len() {
					args[origin] = true;
				}
			}
		} else if ambiguous_remote_cmd(&launch.words[launch.at..]) {
			for origin in all_origins {
				if origin < args.len() {
					args[origin] = true;
				}
			}
		}
	}
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
/// Returns `None` if quoting is unclosed/ambiguous across arguments.
fn lex_remote(remote_words: &[VWord<'_>]) -> Option<Vec<RemoteTok>> {
	let mut out = Vec::new();
	for item in remote_words {
		let bytes = item.text.as_ref();
		let origin = item.origin;
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
			out.push(RemoteTok::Word(VWord { text: Cow::Owned(word), origin }));
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
		value.push(ch);
		i += 1;
	}
	Some((value, i))
}

fn mark_find(args: &mut [bool], find_words: &[VWord<'_>]) -> bool {
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
				let launch = launch_of(find_words[start..end].to_vec());
				if !launch.aborted
					&& launch.at < launch.words.len()
					&& is_omp(launch.words[launch.at].text.as_ref())
				{
					reaches = true;
					mark_omp_args(args, &launch.words, launch.at, &launch.passed, false);
				}
			}
			index = end + 1;
			continue;
		}
		index += 1;
	}
	reaches
}

// ── Launcher option tables (identical to
// packages/coding-agent/src/tools/bash-host-urls.ts) ──

const ENV: OptSet = OptSet {
	short_val:  b"CPafu",
	long_val:   &["argv0", "chdir", "env0-from", "file", "unset"],
	stop_short: b"0",
	stop_long:  &["help", "list-signal-handling", "null", "version"],
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

	use super::omp_owned;

	fn owned(words: &[&str]) -> (Vec<usize>, bool) {
		let argv: Vec<BString> = words.iter().copied().map(BString::from).collect();
		let owned = omp_owned(&argv);
		let indexes = owned
			.args
			.iter()
			.enumerate()
			.filter(|(_, keep)| **keep)
			.map(|(index, _)| index)
			.collect();
		(indexes, owned.env)
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
		// `env local://bin/omp`: index 1 is resolved for `env`; `read` and
		// `local://doc` stay omp's.
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
	fn env_settings_split_strings_and_attached_only_flags_work() {
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
		assert_eq!(owned(&["env", "-S", "omp read", "local://in"]), (vec![2, 3], true));
		assert_eq!(
			owned(&["env", "-S", "local://bin/omp", "read", "local://in"]),
			(vec![3, 4], true)
		);
		assert_eq!(
			owned(&["env", "--default-signal", "omp", "read", "local://x"]),
			(vec![3, 4], true)
		);
		assert_eq!(
			owned(&["env", "--default-signal=PIPE", "omp", "read", "local://x"]),
			(vec![3, 4], true)
		);
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
			owned(&["uv", "run", "--with", "requests", "omp", "read", "local://book"]),
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
		assert_eq!(
			owned(&["ssh", "host", "LANG=C", "omp", "read", "local://in"]),
			(vec![2, 3, 4, 5], false)
		);
		assert_eq!(owned(&["ssh", "host", "LANG=C omp read", "local://in"]), (vec![2, 3], false));
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
