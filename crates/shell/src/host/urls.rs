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
	let omp = omp_command(spec.argv);
	is_url(spec.path)
		|| is_url(spec.cwd)
		|| spec
			.argv
			.iter()
			.enumerate()
			.skip(1)
			.any(|(i, arg)| arg.contains_str("://") && omp.is_none_or(|at| i < at))
		|| (omp.is_none() && spec.env.iter().any(|(name, value)| env_url(name, value)))
}

/// The index of the word naming `omp` in `argv`: the program itself, or the
/// command a wrapper (`nice omp …`, `npx omp …`) runs after its options and
/// assignments. A word spelled `omp` anywhere else (`grep omp …`, `ls ./omp
/// …`) is an argument, not the program.
fn omp_command(argv: &[BString]) -> Option<usize> {
	let mut at = 0;
	loop {
		while argv.get(at).is_some_and(|word| is_assignment(word)) {
			at += 1;
		}
		let word = argv.get(at)?;
		if is_omp(word) {
			return Some(at);
		}
		at = wrapper_command(argv, at)?;
	}
}

/// Whether `word` names the `omp` program, by any path.
fn is_omp(word: &[u8]) -> bool {
	let name = program_name(word);
	name == b"omp" || (cfg!(windows) && name.eq_ignore_ascii_case(b"omp.exe"))
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
	short: b"pc",
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
const NPM_EXEC: OptionValues =
	OptionValues { short: b"cw", long: &["package", "call", "workspace", "prefix"] };
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

/// The index of the command word `argv[at]` runs as a wrapper, or `None`
/// when it is not a known wrapper or names no command.
fn wrapper_command(argv: &[BString], at: usize) -> Option<usize> {
	let name = program_name(argv.get(at)?.as_bytes());
	let next = match name {
		b"nice" => after_options(argv, at + 1, NICE, false),
		b"nohup" => after_options(argv, at + 1, NOHUP, false),
		b"time" => after_options(argv, at + 1, TIME, false),
		b"env" => {
			let options = after_options(argv, at + 1, ENV, true);
			// `env` takes `NAME=value` settings after its options; coreutils
			// does not validate the name, and a lone `-` is a setting too.
			skip_words(argv, options, |word| word == b"-".as_slice() || word.contains_str("="))
		},
		b"sudo" => {
			let options = after_options(argv, at + 1, SUDO, false);
			skip_words(argv, options, is_assignment)
		},
		b"doas" => {
			let options = after_options(argv, at + 1, DOAS, false);
			skip_words(argv, options, is_assignment)
		},
		b"timeout" | b"gtimeout" => after_options(argv, at + 1, TIMEOUT, false) + 1,
		b"stdbuf" => after_options(argv, at + 1, STDBUF, false),
		b"setsid" => after_options(argv, at + 1, SETSID, false),
		b"xargs" => after_options(argv, at + 1, XARGS, false),
		b"ifne" => after_options(argv, at + 1, IFNE, false),
		b"npx" => after_options(argv, at + 1, NPX, false),
		b"bunx" => after_options(argv, at + 1, BUNX, false),
		b"npm" => npm_command(argv, at)?,
		b"uv" => uv_command(argv, at)?,
		b"ssh" => after_options(argv, at + 1, SSH, false) + 1,
		b"command" => command_builtin(argv, at)?,
		b"exec" => after_options(argv, at + 1, EXEC, false),
		b"find" => find_command(argv, at + 1)?,
		_ => return None,
	};
	(next > at && next < argv.len()).then_some(next)
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

/// The first word from `from` on that `skip` rejects.
fn skip_words(argv: &[BString], mut at: usize, mut skip: impl FnMut(&[u8]) -> bool) -> usize {
	while argv.get(at).is_some_and(|word| skip(word.as_bytes())) {
		at += 1;
	}
	at
}

/// `npm [options] exec [options] command`: only `exec`/`x` run a command.
fn npm_command(argv: &[BString], at: usize) -> Option<usize> {
	let sub = after_options(argv, at + 1, NPM_GLOBAL, false);
	let word = argv.get(sub)?.as_bytes();
	if word != b"exec" && word != b"x" {
		return None;
	}
	Some(after_options(argv, sub + 1, NPM_EXEC, false))
}

/// `uv [options] run [options] command`.
fn uv_command(argv: &[BString], at: usize) -> Option<usize> {
	let sub = after_options(argv, at + 1, UV_GLOBAL, false);
	if argv.get(sub)?.as_bytes() != b"run" {
		return None;
	}
	Some(after_options(argv, sub + 1, UV_RUN, false))
}

/// `command [-p] [-v|-V] command`: `-v`/`-V` name a command instead of
/// running it, so nothing is executed.
fn command_builtin(argv: &[BString], at: usize) -> Option<usize> {
	let next = after_options(argv, at + 1, COMMAND, false);
	let names_only = argv.get(at + 1..next)?.iter().any(|word| {
		let word = word.as_bytes();
		word.starts_with(b"-") && word[1..].iter().any(|&b| b == b'v' || b == b'V')
	});
	(!names_only).then_some(next)
}

/// `find … -exec command …`: the first `-exec`/`-execdir`/`-ok`/`-okdir`
/// names the command find runs.
fn find_command(argv: &[BString], from: usize) -> Option<usize> {
	argv
		.iter()
		.enumerate()
		.skip(from)
		.find(|(_, word)| matches!(word.as_bytes(), b"-exec" | b"-execdir" | b"-ok" | b"-okdir"))
		.map(|(i, _)| i + 1)
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
	let omp = omp_command(&names.argv);
	let mut argv = Vec::with_capacity(names.argv.len());
	for (i, arg) in names.argv.iter().enumerate() {
		// The program is resolved above; `omp` resolves the arguments it is
		// given itself, while a wrapper's own arguments are still ours.
		let host = if i == 0 || omp.is_some_and(|at| i >= at) {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's. `omp`
	// resolves the URLs in its own environment.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if omp.is_none() {
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
