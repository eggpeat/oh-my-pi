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
//! wrapper's own file arguments are still rewritten.
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
	let owned = omp_owned(spec.argv);
	spec
		.argv
		.iter()
		.enumerate()
		.skip(1)
		.any(|(index, arg)| !owned.args[index] && arg.contains_str("://"))
		|| (!owned.env && spec.env.iter().any(|(name, value)| env_url(name, value)))
}

/// Arguments `omp` itself reads, and whether the environment reaches `omp`.
struct OmpOwned {
	/// `args[i]` is a word `omp` reads (its name, an argument, or an
	/// assignment a wrapper puts in `omp`'s environment).
	args: Vec<bool>,
	/// The spawned environment is handed to `omp`, so its URLs stay as written.
	env:  bool,
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
	let scan = Scan { argv, remote: false, end: argv.len() };
	if program_is(argv[0].as_slice(), b"ssh") {
		mark_ssh_at(&mut args, &scan, 0);
		return OmpOwned { args, env: false };
	}
	if program_is(argv[0].as_slice(), b"find") {
		let env = mark_find_at(&mut args, &scan, 0);
		return OmpOwned { args, env };
	}
	let launch = launch_of(&scan, 0);
	if launch.at < argv.len() && program_is(argv[launch.at].as_slice(), b"ssh") {
		mark_ssh_at(&mut args, &scan, launch.at);
		return OmpOwned { args, env: false };
	}
	if launch.at < argv.len() && program_is(argv[launch.at].as_slice(), b"find") {
		let env = mark_find_at(&mut args, &scan, launch.at);
		return OmpOwned { args, env };
	}
	apply_omp(&mut args, &scan, &launch, argv.len());
	let env = launch.at < argv.len() && is_omp(argv[launch.at].as_slice());
	OmpOwned { args, env }
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
	let owned = omp_owned(&names.argv);
	let mut argv = Vec::with_capacity(names.argv.len());
	for (i, arg) in names.argv.iter().enumerate() {
		let host = if i == 0 || owned.args[i] {
			None
		} else {
			host_arg(fs, arg.as_bstr()).await
		};
		argv.push(host.unwrap_or_else(|| arg.clone()));
	}
	// What the child's environment says differently from the shell's.
	let mut hosted: Vec<(BString, BString)> = Vec::new();
	if !owned.env {
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

/// A view of `argv` a launcher walk may not read past, and whether a remote
/// command separator (`|`, `&&`, …) ends the command being identified.
struct Scan<'a> {
	argv:   &'a [BString],
	remote: bool,
	end:    usize,
}

impl Scan<'_> {
	fn get(&self, index: usize) -> Option<&[u8]> {
		if index >= self.end {
			return None;
		}
		self.argv.get(index).map(|arg| arg.as_slice())
	}

	fn at_stop(&self, index: usize) -> bool {
		index >= self.end || self.remote && self.get(index).is_some_and(remote_sep)
	}
}

/// Where a wrapper's command sits, and which earlier words it copies into
/// that command's environment (`env NAME=value`, `sudo NAME=value`).
struct Launch {
	at:     usize,
	passed: Vec<usize>,
}

/// Options a launcher takes before the command it runs.
struct OptSet {
	/// Short letters whose value is the next word when it is not attached.
	short_val: &'static [u8],
	/// Long names (without `--`) that always take a value.
	long_val:  &'static [&'static str],
	/// Long names that are flags. With `open`, any other long name takes a
	/// following word that does not itself look like an option.
	long_bool: &'static [&'static str],
	open:      bool,
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

const fn remote_sep(word: &[u8]) -> bool {
	matches!(word, b"|" | b"||" | b"&" | b"&&" | b";" | b";;" | b";&" | b";;&" | b"\n")
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

fn apply_omp(args: &mut [bool], scan: &Scan<'_>, launch: &Launch, end: usize) {
	if launch.at >= end || scan.at_stop(launch.at) || !is_omp(scan.argv[launch.at].as_slice()) {
		return;
	}
	for slot in args.iter_mut().take(end).skip(launch.at) {
		*slot = true;
	}
	for &passed in &launch.passed {
		if passed < end {
			args[passed] = true;
		}
	}
}

fn launch_of(scan: &Scan<'_>, index: usize) -> Launch {
	let Some(word) = scan.get(index) else {
		return Launch { at: index, passed: Vec::new() };
	};
	if scan.at_stop(index) {
		return Launch { at: index, passed: Vec::new() };
	}
	if program_is(word, b"env") {
		return env_launch(scan, index);
	}
	if program_is(word, b"sudo") {
		return assignment_launch(scan, index, &SUDO);
	}
	if program_is(word, b"doas") {
		return follow(scan, skip_opts(scan, index + 1, &DOAS), Vec::new());
	}
	if program_is(word, b"nice") {
		return follow(scan, skip_opts(scan, index + 1, &NICE), Vec::new());
	}
	if program_is(word, b"nohup") {
		return follow(scan, skip_opts(scan, index + 1, &NOHUP), Vec::new());
	}
	if program_is(word, b"time") {
		return follow(scan, skip_opts(scan, index + 1, &TIME), Vec::new());
	}
	if program_is(word, b"timeout") || program_is(word, b"gtimeout") {
		return timeout_launch(scan, index);
	}
	if program_is(word, b"stdbuf") {
		return follow(scan, skip_opts(scan, index + 1, &STDBUF), Vec::new());
	}
	if program_is(word, b"setsid") {
		return follow(scan, skip_opts(scan, index + 1, &SETSID), Vec::new());
	}
	if program_is(word, b"ifne") {
		return follow(scan, skip_opts(scan, index + 1, &IFNE), Vec::new());
	}
	if program_is(word, b"xargs") {
		return follow(scan, skip_opts(scan, index + 1, &XARGS), Vec::new());
	}
	if program_is(word, b"exec") {
		return follow(scan, skip_opts(scan, index + 1, &EXEC), Vec::new());
	}
	if program_is(word, b"command") || program_is(word, b"builtin") {
		return follow(scan, skip_opts(scan, index + 1, &COMMAND), Vec::new());
	}
	if program_is(word, b"npx") {
		return follow(scan, skip_opts(scan, index + 1, &NPX), Vec::new());
	}
	if program_is(word, b"npm") {
		return npm_launch(scan, index);
	}
	if program_is(word, b"bunx") || program_is(word, b"bun") {
		return bun_launch(scan, index);
	}
	if program_is(word, b"uv") || program_is(word, b"uvx") {
		return uv_launch(scan, index);
	}
	Launch { at: index, passed: Vec::new() }
}

fn follow(scan: &Scan<'_>, at: usize, mut passed: Vec<usize>) -> Launch {
	if scan.get(at).is_none() || scan.at_stop(at) {
		return Launch { at, passed };
	}
	let inner = launch_of(scan, at);
	passed.extend(inner.passed);
	Launch { at: inner.at, passed }
}

fn env_launch(scan: &Scan<'_>, index: usize) -> Launch {
	let mut at = skip_opts(scan, index + 1, &ENV);
	let mut passed = Vec::new();
	if scan.get(at) == Some(b"-") {
		at += 1;
	}
	while !scan.at_stop(at) && scan.get(at).is_some_and(|word| word.contains(&b'=')) {
		passed.push(at);
		at += 1;
	}
	follow(scan, at, passed)
}

fn assignment_launch(scan: &Scan<'_>, index: usize, opts: &OptSet) -> Launch {
	let mut at = skip_opts(scan, index + 1, opts);
	let mut passed = Vec::new();
	while !scan.at_stop(at) && scan.get(at).is_some_and(ident_assignment) {
		passed.push(at);
		at += 1;
	}
	follow(scan, at, passed)
}

fn timeout_launch(scan: &Scan<'_>, index: usize) -> Launch {
	let duration = skip_opts(scan, index + 1, &TIMEOUT);
	let command = if scan.get(duration).is_some() && !scan.at_stop(duration) {
		duration + 1
	} else {
		duration
	};
	follow(scan, command, Vec::new())
}

fn npm_launch(scan: &Scan<'_>, index: usize) -> Launch {
	let sub = skip_opts(scan, index + 1, &NPM);
	if scan.at_stop(sub)
		|| !scan
			.get(sub)
			.is_some_and(|word| word == b"exec" || word == b"x")
	{
		return Launch { at: index, passed: Vec::new() };
	}
	follow(scan, skip_opts(scan, sub + 1, &NPM), Vec::new())
}

fn bun_launch(scan: &Scan<'_>, index: usize) -> Launch {
	if program_is(scan.argv[index].as_slice(), b"bunx") {
		return follow(scan, skip_opts(scan, index + 1, &BUNX), Vec::new());
	}
	let sub = skip_opts(scan, index + 1, &BUNX);
	if scan.get(sub) == Some(b"x") {
		return follow(scan, skip_opts(scan, sub + 1, &BUNX), Vec::new());
	}
	Launch { at: index, passed: Vec::new() }
}

fn uv_launch(scan: &Scan<'_>, index: usize) -> Launch {
	if program_is(scan.argv[index].as_slice(), b"uvx") {
		return follow(scan, skip_opts(scan, index + 1, &UV), Vec::new());
	}
	let sub = skip_opts(scan, index + 1, &UV);
	if scan.get(sub) == Some(b"run") {
		return follow(scan, skip_opts(scan, sub + 1, &UV), Vec::new());
	}
	if scan.get(sub) == Some(b"tool") && scan.get(sub + 1) == Some(b"run") {
		return follow(scan, skip_opts(scan, sub + 2, &UV), Vec::new());
	}
	Launch { at: index, passed: Vec::new() }
}

fn skip_opts(scan: &Scan<'_>, mut index: usize, opts: &OptSet) -> usize {
	while !scan.at_stop(index) {
		let Some(word) = scan.get(index) else {
			break;
		};
		if word == b"-" || !word.starts_with(b"-") {
			break;
		}
		if word == b"--" {
			return index + 1;
		}
		if let Some(name) = word.strip_prefix(b"--") {
			let (name, attached) = split_eq(name);
			if attached.is_some() {
				index += 1;
				continue;
			}
			let next = scan.get(index + 1).filter(|_| !scan.at_stop(index + 1));
			index += if long_takes(name, next, opts) { 2 } else { 1 };
			continue;
		}
		index += if short_takes_next(&word[1..], opts.short_val) && !scan.at_stop(index + 1) {
			2
		} else {
			1
		};
	}
	index
}

fn long_takes(name: &[u8], next: Option<&[u8]>, opts: &OptSet) -> bool {
	if listed(name, opts.long_bool) {
		return false;
	}
	if listed(name, opts.long_val) {
		return next.is_some();
	}
	opts.open && next.is_some_and(|word| !word.starts_with(b"-"))
}

fn short_takes_next(letters: &[u8], short_val: &[u8]) -> bool {
	for (offset, &letter) in letters.iter().enumerate() {
		if short_val.contains(&letter) {
			return letters[offset + 1..].is_empty();
		}
	}
	false
}

fn mark_ssh_at(args: &mut [bool], scan: &Scan<'_>, ssh_at: usize) {
	let host = skip_opts(scan, ssh_at + 1, &SSH);
	let remote = host + 1;
	if remote >= scan.end {
		return;
	}
	let remote_scan = Scan { argv: scan.argv, remote: true, end: scan.end };
	let mut index = remote;
	while index < remote_scan.end {
		if remote_scan.get(index).is_some_and(remote_sep) {
			index += 1;
			continue;
		}
		let launch = launch_of(&remote_scan, index);
		if launch.at >= remote_scan.end {
			break;
		}
		if remote_scan.at_stop(launch.at) {
			index = launch.at;
			continue;
		}
		let mut end = launch.at;
		while end < remote_scan.end && !remote_sep(remote_scan.argv[end].as_slice()) {
			end += 1;
		}
		apply_omp(args, &remote_scan, &launch, end);
		index = end;
	}
}

fn mark_find_at(args: &mut [bool], scan: &Scan<'_>, find_at: usize) -> bool {
	let mut index = find_at + 1;
	let mut reaches = false;
	while index < scan.end {
		let word = scan.argv[index].as_slice();
		if matches!(word, b"-exec" | b"-execdir" | b"-ok" | b"-okdir") {
			let start = index + 1;
			let mut end = start;
			while end < scan.end && !matches!(scan.argv[end].as_slice(), b";" | b"+") {
				end += 1;
			}
			if start < end {
				let limited = Scan { argv: scan.argv, remote: false, end };
				let launch = launch_of(&limited, start);
				if launch.at < end && is_omp(scan.argv[launch.at].as_slice()) {
					reaches = true;
				}
				apply_omp(args, &limited, &launch, end);
			}
			index = end + 1;
			continue;
		}
		index += 1;
	}
	reaches
}

const ENV: OptSet = OptSet {
	short_val: b"uCSafP",
	long_val:  &[
		"unset",
		"chdir",
		"split-string",
		"argv0",
		"file",
		"env0-from",
		"block-signal",
		"default-signal",
		"ignore-signal",
	],
	long_bool: &["ignore-environment", "null", "debug", "list-signal-handling", "help", "version"],
	open:      false,
};

const SUDO: OptSet = OptSet {
	short_val: b"ugCDhpRrTtU",
	long_val:  &[
		"user",
		"group",
		"close-from",
		"chdir",
		"host",
		"prompt",
		"chroot",
		"role",
		"command-timeout",
		"type",
		"other-user",
	],
	long_bool: &["help", "version"],
	open:      false,
};

const DOAS: OptSet = OptSet { short_val: b"aCu", long_val: &[], long_bool: &[], open: false };

const NICE: OptSet = OptSet {
	short_val: b"n",
	long_val:  &["adjustment"],
	long_bool: &["help", "version"],
	open:      false,
};

const NOHUP: OptSet =
	OptSet { short_val: b"", long_val: &[], long_bool: &["help", "version"], open: false };

const TIME: OptSet = OptSet {
	short_val: b"of",
	long_val:  &["output", "format"],
	long_bool: &["help", "version", "portability", "verbose", "append"],
	open:      false,
};

const TIMEOUT: OptSet = OptSet {
	short_val: b"sk",
	long_val:  &["signal", "kill-after"],
	long_bool: &["preserve-status", "foreground", "verbose", "help", "version"],
	open:      false,
};

const STDBUF: OptSet = OptSet {
	short_val: b"ioe",
	long_val:  &["input", "output", "error"],
	long_bool: &["help", "version"],
	open:      false,
};

const SETSID: OptSet = OptSet {
	short_val: b"",
	long_val:  &[],
	long_bool: &["ctty", "fork", "wait", "help", "version"],
	open:      false,
};

const IFNE: OptSet =
	OptSet { short_val: b"", long_val: &[], long_bool: &["help"], open: false };

const XARGS: OptSet = OptSet {
	short_val: b"adnLPsIE",
	long_val:  &[
		"arg-file",
		"delimiter",
		"max-args",
		"max-lines",
		"max-procs",
		"max-chars",
		"replace",
		"eof",
	],
	long_bool: &["exit", "interactive", "no-run-if-empty", "null", "verbose", "help", "version"],
	open:      false,
};

const EXEC: OptSet = OptSet { short_val: b"a", long_val: &[], long_bool: &[], open: false };

const COMMAND: OptSet = OptSet { short_val: b"", long_val: &[], long_bool: &[], open: false };

const NPM_BOOL: &[&str] = &[
	"all",
	"allow-same-version",
	"allow-scripts-pending",
	"allow-scripts-pin",
	"audit",
	"bin-links",
	"bypass-2fa",
	"color",
	"commit-hooks",
	"dangerously-allow-all-scripts",
	"description",
	"dev",
	"diff-ignore-all-space",
	"diff-name-only",
	"diff-no-prefix",
	"diff-text",
	"dry-run",
	"engine-strict",
	"expect-results",
	"force",
	"foreground-scripts",
	"format-package-lock",
	"fund",
	"git-tag-version",
	"global",
	"global-style",
	"help",
	"if-present",
	"ignore-scripts",
	"include-attestations",
	"include-staged",
	"include-workspace-root",
	"init-private",
	"install-links",
	"json",
	"legacy-bundling",
	"legacy-peer-deps",
	"link",
	"long",
	"no-install",
	"offline",
	"omit-lockfile-registry-resolved",
	"optional",
	"package-lock",
	"package-lock-only",
	"packages-all",
	"parseable",
	"prefer-dedupe",
	"prefer-offline",
	"prefer-online",
	"production",
	"progress",
	"provenance",
	"quiet",
	"read-only",
	"rebuild-bundle",
	"save",
	"save-bundle",
	"save-dev",
	"save-exact",
	"save-optional",
	"save-peer",
	"save-prod",
	"shrinkwrap",
	"sign-git-commit",
	"sign-git-tag",
	"silent",
	"strict-allow-scripts",
	"strict-peer-deps",
	"strict-ssl",
	"timing",
	"unicode",
	"update-notifier",
	"usage",
	"verbose",
	"version",
	"versions",
	"workspaces",
	"workspaces-update",
	"yes",
];

const NPM_VAL: &[&str] = &[
	"allow-scripts",
	"auth-type",
	"before",
	"cache",
	"cache-max",
	"cache-min",
	"cafile",
	"call",
	"cert",
	"cidr",
	"cpu",
	"depth",
	"diff",
	"editor",
	"fetch-retries",
	"fetch-timeout",
	"git",
	"globalconfig",
	"heading",
	"https-proxy",
	"include",
	"key",
	"libc",
	"local-address",
	"location",
	"lockfile-version",
	"loglevel",
	"logs-max",
	"message",
	"min-release-age",
	"node-options",
	"noproxy",
	"omit",
	"os",
	"otp",
	"package",
	"pack-destination",
	"prefix",
	"proxy",
	"registry",
	"save-prefix",
	"scope",
	"script-shell",
	"searchlimit",
	"shell",
	"tag",
	"umask",
	"user-agent",
	"userconfig",
	"viewer",
	"which",
	"workspace",
];

const NPM: OptSet =
	OptSet { short_val: b"cCwmL", long_val: NPM_VAL, long_bool: NPM_BOOL, open: true };

const NPX: OptSet =
	OptSet { short_val: b"pcCwmL", long_val: NPM_VAL, long_bool: NPM_BOOL, open: true };

const BUNX: OptSet = OptSet {
	short_val: b"p",
	long_val:  &["package", "cwd", "env-file", "minimum-release-age", "registry", "ca", "cafile"],
	long_bool: &[
		"bun",
		"no-install",
		"trust",
		"ignore-scripts",
		"verbose",
		"silent",
		"help",
		"version",
	],
	open:      false,
};

const UV: OptSet = OptSet {
	short_val: b"wpifPC",
	long_val:  &[
		"allow-insecure-host",
		"cache-dir",
		"color",
		"config-file",
		"config-setting",
		"config-settings-package",
		"default-index",
		"directory",
		"env-file",
		"exclude-newer",
		"exclude-newer-package",
		"extra",
		"extra-index-url",
		"find-links",
		"fork-strategy",
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
		"package",
		"prerelease",
		"prerelease-package",
		"project",
		"python",
		"python-platform",
		"refresh-package",
		"reinstall-package",
		"resolution",
		"upgrade-group",
		"upgrade-package",
		"with",
		"with-editable",
		"with-requirements",
	],
	long_bool: &[
		"active",
		"all-extras",
		"all-groups",
		"all-packages",
		"compile-bytecode",
		"exact",
		"frozen",
		"gui-script",
		"help",
		"isolated",
		"locked",
		"managed-python",
		"module",
		"no-binary",
		"no-build",
		"no-build-isolation",
		"no-cache",
		"no-config",
		"no-dev",
		"no-default-groups",
		"no-editable",
		"no-env-file",
		"no-index",
		"no-managed-python",
		"no-progress",
		"no-project",
		"no-python-downloads",
		"no-sources",
		"no-sync",
		"offline",
		"only-dev",
		"quiet",
		"refresh",
		"reinstall",
		"script",
		"system-certs",
		"upgrade",
		"verbose",
		"version",
	],
	open:      false,
};

const SSH: OptSet = OptSet {
	// OpenSSH options whose argument is the next word: -B -b -c -D -E -e -F
	// -I -i -J -L -l -m -O -o -p -Q -R -S -W -w.
	short_val: b"BbcDEeFIJiLlmOopQRWSw",
	long_val:  &[],
	long_bool: &[],
	open:      false,
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
	fn omp_keeps_its_arguments_and_environment() {
		assert_eq!(owned(&["omp", "read", "local://x"]), (vec![0, 1, 2], true));
		assert_eq!(owned(&["/usr/local/bin/omp", "read", "local://x"]), (vec![0, 1, 2], true));
		assert_eq!(owned(&["nice", "omp", "read", "local://x"]), (vec![1, 2, 3], true));
		assert_eq!(owned(&["/usr/bin/env", "-", "omp", "read", "local://x"]), (vec![2, 3, 4], true));
		assert_eq!(
			owned(&["env", "-u", "FOO", "-", "omp", "read", "local://x"]),
			(vec![4, 5, 6], true)
		);
		assert_eq!(
			owned(&["sudo", "-u", "root", "F=local://x", "omp", "read", "local://y"]),
			(vec![3, 4, 5, 6], true)
		);
		assert_eq!(
			owned(&["sudo", "env", "-u", "FOO", "nice", "omp", "read", "local://x"]),
			(vec![5, 6, 7], true)
		);
	}

	#[test]
	fn env_settings_are_not_the_program() {
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
			(vec![3, 4, 5], true)
		);
		assert_eq!(
			owned(&["env", "FILE=local://in", "omp", "read", "local://x"]),
			(vec![1, 2, 3, 4], true)
		);
		// A dash after settings is the command: real env tries to run `-u`.
		assert_eq!(owned(&["env", "-", "-u", "FOO", "omp"]), (vec![], false));
	}

	#[test]
	fn package_runners_consume_option_values_before_the_program() {
		assert_eq!(
			owned(&["npx", "--loglevel", "warn", "omp", "read", "local://x"]),
			(vec![3, 4, 5], true)
		);
		assert_eq!(owned(&["npx", "--cache", "omp", "eslint", "local://app.ts"]), (vec![], false));
		assert_eq!(owned(&["npx", "-p", "eslint", "local://app.ts"]), (vec![], false));
		assert_eq!(owned(&["npm", "exec", "-p", "omp", "read", "local://x"]), (vec![3, 4, 5], true));
		assert_eq!(
			owned(&["npm", "--prefix", "local://tools", "exec", "--", "omp", "read", "local://book",]),
			(vec![5, 6, 7], true)
		);
		assert_eq!(owned(&["npm", "install", "local://pkg"]), (vec![], false));
		assert_eq!(
			owned(&["bunx", "--minimum-release-age", "86400", "omp", "read", "local://book"]),
			(vec![3, 4, 5], true)
		);
		assert_eq!(
			owned(&["bunx", "--registry", "https://example", "omp", "read", "local://book"]),
			(vec![3, 4, 5], true)
		);
		assert_eq!(
			owned(&["uv", "run", "-w", "requests", "omp", "read", "local://book"]),
			(vec![4, 5, 6], true)
		);
		assert_eq!(
			owned(&["uv", "run", "--with", "requests", "omp", "read", "local://book"]),
			(vec![4, 5, 6], true)
		);
	}

	#[test]
	fn launchers_that_exec_their_command_are_wrappers() {
		assert_eq!(owned(&["setsid", "omp", "read", "local://x"]), (vec![1, 2, 3], true));
		assert_eq!(owned(&["setsid", "grep", "omp", "local://x"]), (vec![], false));
		assert_eq!(owned(&["xargs", "omp", "read", "local://x"]), (vec![1, 2, 3], true));
		assert_eq!(owned(&["xargs", "-a", "local://list", "omp", "read"]), (vec![3, 4], true));
		assert_eq!(owned(&["ifne", "-n", "grep", "local://x"]), (vec![], false));
		assert_eq!(owned(&["ifne", "omp", "read", "local://x"]), (vec![1, 2, 3], true));
		assert_eq!(
			owned(&["timeout", "-k", "5", "30", "omp", "read", "local://x"]),
			(vec![4, 5, 6], true)
		);
		assert_eq!(owned(&["stdbuf", "-o", "L", "omp", "read", "local://x"]), (vec![3, 4, 5], true));
	}

	#[test]
	fn ssh_keeps_each_remote_commands_omp_arguments_literal() {
		assert_eq!(
			owned(&["ssh", "-F", "local://config", "server", "omp", "read", "skill://x"]),
			(vec![4, 5, 6], false)
		);
		assert_eq!(
			owned(&["ssh", "server", "omp", "read", "local://book", "|", "cat", "local://other"]),
			(vec![2, 3, 4], false)
		);
		assert_eq!(
			owned(&["ssh", "server", "omp", "read", "local://book", "2>&1"]),
			(vec![2, 3, 4, 5], false)
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
	fn find_exec_owns_only_the_command_it_runs() {
		assert_eq!(
			owned(&["find", "local://docs", "-exec", "omp", "read", "local://x", ";"]),
			(vec![3, 4, 5], true)
		);
		assert_eq!(
			owned(&["find", "local://docs", "-name", "a.txt", "-exec", "probe", "{}", ";"]),
			(vec![], false)
		);
	}
}
