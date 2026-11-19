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
	is_url(spec.path)
		|| is_url(spec.cwd)
		|| (!runs_omp(spec.path, spec.argv)
			&& (spec.argv.iter().skip(1).any(|arg| arg.contains_str("://"))
				|| spec.env.iter().any(|(name, value)| env_url(name, value))))
}

/// Whether a spawn runs `omp`: directly (`path` or `argv[0]`), or as the
/// command word after leading `NAME=value` assignments and command-launching
/// wrappers (`nice omp …`, `npx omp …`, `sudo -u root omp …`).
fn runs_omp(path: &BStr, argv: &[BString]) -> bool {
	is_omp(path) || runs_omp_argv(argv)
}

fn runs_omp_argv(argv: &[BString]) -> bool {
	let mut i = 0;
	loop {
		i = skip_assignments(argv, i);
		let Some(word) = argv.get(i) else {
			return false;
		};
		let Some(next) = unwrap_wrapper(argv, i) else {
			return is_omp(word);
		};
		if next <= i {
			return false;
		}
		i = next;
	}
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	if is_assignment(word) {
		return false;
	}
	let name = basename(word);
	name == b"omp" || (cfg!(windows) && name.eq_ignore_ascii_case(b"omp.exe"))
}

fn basename(word: &[u8]) -> &[u8] {
	word
		.rsplit(|&b| b == b'/' || (cfg!(windows) && b == b'\\'))
		.next()
		.unwrap_or(word)
}

fn strip_win_ext(name: &[u8]) -> &[u8] {
	if cfg!(windows) && name.len() > 4 {
		let ext = &name[name.len() - 4..];
		if ext.eq_ignore_ascii_case(b".exe") || ext.eq_ignore_ascii_case(b".cmd") {
			return &name[..name.len() - 4];
		}
	}
	name
}

fn wrapper_key<'a>(word: &'a [u8], scratch: &'a mut [u8; 16]) -> &'a [u8] {
	let name = strip_win_ext(basename(word));
	if cfg!(windows) && name.len() <= scratch.len() {
		for (dst, &src) in scratch.iter_mut().zip(name) {
			*dst = src.to_ascii_lowercase();
		}
		&scratch[..name.len()]
	} else {
		name
	}
}

fn is_assignment(word: &[u8]) -> bool {
	let Some(eq) = word.iter().position(|&b| b == b'=') else {
		return false;
	};
	let name = word[..eq].strip_suffix(b"+").unwrap_or(&word[..eq]);
	let Some((&first, rest)) = name.split_first() else {
		return false;
	};
	(first.is_ascii_alphabetic() || first == b'_')
		&& rest.iter().all(|&b| b.is_ascii_alphanumeric() || b == b'_')
}

fn skip_assignments(argv: &[BString], mut i: usize) -> usize {
	while argv.get(i).is_some_and(|w| is_assignment(w)) {
		i += 1;
	}
	i
}

/// If `argv[i]` is a command-launching wrapper, returns the index where its
/// target command begins; returns `None` when `argv[i]` is not a wrapper or its
/// flags mean no command word follows.
fn unwrap_wrapper(argv: &[BString], i: usize) -> Option<usize> {
	let mut scratch = [0u8; 16];
	match wrapper_key(argv.get(i)?.as_slice(), &mut scratch) {
		b"env" => skip_env(argv, i + 1),
		b"sudo" => skip_sudo(argv, i + 1),
		b"doas" => skip_options(argv, i + 1, b"ua", b"CL", &[], &[b"help", b"version"]),
		b"nice" => skip_options(argv, i + 1, b"n", b"", &[b"adjustment"], &[b"help", b"version"]),
		b"nohup" => match argv.get(i + 1).map(AsRef::<[u8]>::as_ref) {
			Some(b"--") => Some(i + 2),
			Some(w) if w.starts_with(b"-") => None,
			_ => Some(i + 1),
		},
		b"time" => {
			skip_options(argv, i + 1, b"fo", b"V", &[b"format", b"output"], &[b"help", b"version"])
		},
		b"timeout" | b"gtimeout" => {
			let duration = skip_options(argv, i + 1, b"sk", b"", &[b"signal", b"kill-after"], &[
				b"help", b"version",
			])?;
			(duration < argv.len()).then_some(duration + 1)
		},
		b"stdbuf" => skip_options(argv, i + 1, b"ioe", b"", &[b"input", b"output", b"error"], &[
			b"help", b"version",
		]),
		b"setsid" => skip_options(argv, i + 1, b"", b"Vh", &[], &[b"help", b"version"]),
		b"ifne" => skip_options(argv, i + 1, b"", b"", &[], &[b"help", b"version"]),
		b"xargs" => skip_options(
			argv,
			i + 1,
			b"IJLnPsdaESR",
			b"",
			&[b"arg-file", b"delimiter", b"max-args", b"max-procs", b"max-chars", b"process-slot-var"],
			&[b"help", b"version"],
		),
		b"command" => skip_command_builtin(argv, i + 1),
		b"exec" => skip_exec_builtin(argv, i + 1),
		b"noglob" | b"nocorrect" => Some(i + 1),
		b"npx" => skip_npx(argv, i + 1),
		b"bunx" => skip_bunx(argv, i + 1),
		b"bun" => {
			let sub = skip_options(
				argv,
				i + 1,
				b"Ccr",
				b"vhep",
				&[b"cwd", b"config", b"env-file", b"preload"],
				&[b"eval", b"print", b"help", b"version"],
			)?;
			(argv.get(sub).is_some_and(|w| w == "x")).then(|| skip_bunx(argv, sub + 1))?
		},
		b"pnpm" | b"yarn" => {
			let sub = skip_options(
				argv,
				i + 1,
				b"CFp",
				b"vh",
				&[b"dir", b"filter", b"package", b"workspace-root", b"cwd"],
				&[b"help", b"version"],
			)?;
			let subcmd: &[u8] = argv.get(sub)?.as_ref();
			matches!(subcmd, b"dlx" | b"exec").then(|| skip_npx(argv, sub + 1))?
		},
		b"npm" => {
			let sub = skip_options(
				argv,
				i + 1,
				b"Cw",
				b"vh",
				&[b"prefix", b"workspace", b"userconfig", b"registry", b"cache"],
				&[b"help", b"version"],
			)?;
			let subcmd: &[u8] = argv.get(sub)?.as_ref();
			matches!(subcmd, b"exec" | b"x").then(|| skip_npx(argv, sub + 1))?
		},
		_ => None,
	}
}

fn is_env_var(word: &[u8]) -> bool {
	!word.starts_with(b"-") && word.get(1..).is_some_and(|rest| rest.contains(&b'='))
}

fn skip_env(argv: &[BString], mut i: usize) -> Option<usize> {
	while let Some(word) = argv.get(i).map(AsRef::<[u8]>::as_ref) {
		if word == b"--" {
			i += 1;
			while argv.get(i).is_some_and(|w| is_env_var(w)) {
				i += 1;
			}
			return Some(i);
		}
		if word == b"-" || is_env_var(word) {
			i += 1;
			continue;
		}
		if word.starts_with(b"-") {
			i = skip_one_option(
				argv,
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

fn skip_sudo(argv: &[BString], mut i: usize) -> Option<usize> {
	while let Some(word) = argv.get(i).map(AsRef::<[u8]>::as_ref) {
		if word == b"--" {
			i += 1;
			return Some(skip_assignments(argv, i));
		}
		if is_assignment(word) {
			i += 1;
			continue;
		}
		if word.len() > 1 && word[0] == b'-' {
			i = skip_one_option(
				argv,
				i,
				b"ugCDhpRrTtUac",
				b"eVvlK",
				&[
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
				],
				&[b"edit", b"list", b"validate", b"version", b"help", b"remove-timestamp"],
			)?;
			continue;
		}
		break;
	}
	Some(i)
}

fn skip_npx(argv: &[BString], i: usize) -> Option<usize> {
	skip_options(
		argv,
		i,
		b"pw",
		b"cvh",
		&[
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
		],
		&[b"call", b"help", b"version"],
	)
}

fn skip_bunx(argv: &[BString], i: usize) -> Option<usize> {
	skip_options(argv, i, b"p", b"vh", &[b"package", b"cwd", b"config", b"env-file"], &[
		b"help", b"version",
	])
}

fn skip_command_builtin(argv: &[BString], mut i: usize) -> Option<usize> {
	while let Some(word) = argv.get(i).map(AsRef::<[u8]>::as_ref) {
		if word == b"--" {
			return Some(i + 1);
		}
		if let Some(flags) = word.strip_prefix(b"-").filter(|f| !f.is_empty()) {
			if flags.iter().all(|&b| b == b'p') {
				i += 1;
				continue;
			}
			return None;
		}
		break;
	}
	Some(i)
}

fn skip_exec_builtin(argv: &[BString], mut i: usize) -> Option<usize> {
	while let Some(word) = argv.get(i).map(AsRef::<[u8]>::as_ref) {
		if word == b"--" {
			return Some(i + 1);
		}
		if let Some(flags) = word.strip_prefix(b"-").filter(|f| !f.is_empty()) {
			let mut step = 1;
			for (idx, &b) in flags.iter().enumerate() {
				match b {
					b'c' | b'l' => {},
					b'a' => {
						if idx + 1 == flags.len() {
							step = 2;
						}
						break;
					},
					_ => return None,
				}
			}
			i += step;
			if i > argv.len() {
				return None;
			}
			continue;
		}
		break;
	}
	Some(i)
}

fn skip_options(
	argv: &[BString],
	mut i: usize,
	short_values: &[u8],
	short_abort: &[u8],
	long_values: &[&[u8]],
	long_abort: &[&[u8]],
) -> Option<usize> {
	while let Some(word) = argv.get(i).map(AsRef::<[u8]>::as_ref) {
		if word == b"--" {
			return Some(i + 1);
		}
		if word.len() <= 1 || word[0] != b'-' {
			break;
		}
		i = skip_one_option(argv, i, short_values, short_abort, long_values, long_abort)?;
	}
	Some(i)
}

fn skip_one_option(
	argv: &[BString],
	i: usize,
	short_values: &[u8],
	short_abort: &[u8],
	long_values: &[&[u8]],
	long_abort: &[&[u8]],
) -> Option<usize> {
	let word = argv.get(i)?.as_slice();
	if let Some(rest) = word.strip_prefix(b"--") {
		let (name, inline) = match rest.iter().position(|&b| b == b'=') {
			Some(eq) => (&rest[..eq], true),
			None => (rest, false),
		};
		if long_abort.contains(&name) {
			return None;
		}
		let step = if !inline && long_values.contains(&name) {
			2
		} else {
			1
		};
		return (i + step <= argv.len()).then_some(i + step);
	}
	let flags = word.strip_prefix(b"-").filter(|f| !f.is_empty())?;
	let mut step = 1;
	for (idx, &flag) in flags.iter().enumerate() {
		if short_abort.contains(&flag) {
			return None;
		}
		if short_values.contains(&flag) {
			if idx + 1 == flags.len() {
				step = 2;
			}
			break;
		}
	}
	(i + step <= argv.len()).then_some(i + step)
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
	let literal = runs_omp(names.path.as_bstr(), &names.argv);
	let mut argv = Vec::with_capacity(names.argv.len());
	for (i, arg) in names.argv.iter().enumerate() {
		let host = if i == 0 || literal {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !literal {
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
	use super::*;

	fn runs(argv: &[&str]) -> bool {
		let words: Vec<BString> = argv.iter().copied().map(BString::from).collect();
		let path = words.first().map_or_else(|| BStr::new(""), |w| w.as_bstr());
		runs_omp(path, &words)
	}

	#[test]
	fn detects_omp_directly_and_through_wrappers() {
		for argv in [
			&["omp", "read", "local://x:1-5"][..],
			&["/usr/local/bin/omp", "read", "local://x"],
			&["FOO=1", "omp", "read", "local://x"],
			&["nice", "-n", "10", "omp", "read", "local://x"],
			&["nice", "-10", "omp", "read", "local://x"],
			&["nohup", "omp", "read", "local://x"],
			&["nohup", "--", "omp", "read", "local://x"],
			&["env", "-", "-u", "DEBUG", "A=1", "omp", "read", "local://x"],
			&["sudo", "-E", "-u", "root", "FOO=bar", "/usr/local/bin/omp", "read", "local://x"],
			&["doas", "-u", "root", "omp", "read", "local://x"],
			&["time", "-p", "omp", "read", "local://x"],
			&["timeout", "-k", "5s", "-s", "INT", "30", "omp", "read", "local://x"],
			&["stdbuf", "-oL", "omp", "read", "local://x"],
			&["command", "-p", "omp", "read", "local://x"],
			&["exec", "-ca", "worker", "omp", "read", "local://x"],
			&["npx", "-y", "-p", "@oh-my-pi/pi-coding-agent", "omp", "read", "local://x"],
			&["bunx", "--bun", "omp", "read", "local://x"],
			&["bun", "x", "omp", "read", "local://x"],
			&["pnpm", "dlx", "omp", "read", "local://x"],
			&["npm", "exec", "--", "omp", "read", "local://x"],
		] {
			assert!(runs(argv), "{argv:?}");
		}
		// `exec -a` may replace `argv[0]` while `path` still names `omp`.
		let argv = vec![BString::from("worker"), BString::from("read"), BString::from("local://x")];
		assert!(runs_omp(BStr::new("/usr/local/bin/omp"), &argv));
	}

	#[test]
	fn ignores_omp_when_given_as_an_argument_or_option_value() {
		for argv in [
			&["grep", "omp", "local://out.txt"][..],
			&["rg", "-n", "omp", "skill://x/SKILL.md"],
			&["ls", "./omp", "local://dir"],
			&["sudo", "-u", "omp", "grep", "needle", "local://out.txt"],
			&["OMP_BIN=/usr/local/bin/omp", "python3", "local://run.py"],
			&["env", "BIN=/usr/local/bin/omp", "python3", "local://run.py"],
			&["env", "-S", "python3 s.py", "omp", "local://run.py"],
			&["command", "-v", "omp"],
			&["sudo", "-e", "omp", "local://out.txt"],
			&["npx", "-c", "grep omp", "local://out.txt"],
			&["npx", "eslint", "omp", "local://app.ts"],
			&["bun", "script.ts", "omp", "local://out.txt"],
			&["npm", "run", "omp", "local://out.txt"],
			&["timeout", "omp"],
		] {
			assert!(!runs(argv), "{argv:?}");
		}
	}
}
