//! Filesystem materialization for blobs destined for a worktree.

use std::{fs, io::Write, path::Path};

use gix::index::entry::Mode;

use super::filter::WorktreeFilter;
use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug)]
pub(crate) struct WorktreeOptions {
	pub(crate) symlinks:       bool,
	/// `core.fileMode`: governs worktree change detection, not checkout modes.
	pub(crate) executable_bit: bool,
}

impl WorktreeOptions {
	pub(crate) fn for_repo(repo: &gix::Repository, op: &'static str) -> Result<Self> {
		let caps = repo
			.filesystem_options()
			.map_err(|err| Error::backend(op, err))?;
		Ok(Self { symlinks: cfg!(unix) && caps.symlink, executable_bit: caps.executable_bit })
	}
}

/// Write `bytes` at repo-relative `path` according to its Git mode and
/// repository filesystem capabilities. Symlink blobs are raw target names,
/// never filtered content; with `core.symlinks=false` (or off Unix) they are
/// materialized as plain files. Replacing a symlink with a regular file unlinks
/// the link first so the write cannot reach its target, including one outside
/// the repository.
pub(crate) fn materialize(
	root: &Path,
	path: &str,
	mode: Mode,
	bytes: Vec<u8>,
	filter: &mut WorktreeFilter<'_>,
	options: WorktreeOptions,
) -> Result<()> {
	let absolute = root.join(path);
	if let Some(parent) = absolute.parent() {
		fs::create_dir_all(parent)?;
	}
	if mode == Mode::SYMLINK {
		#[cfg(unix)]
		if options.symlinks {
			return write_symlink(&absolute, &bytes);
		}
		#[cfg(not(unix))]
		let _ = options;
		return write_regular_file(&absolute, &bytes, false);
	}

	let bytes = filter.git_to_worktree(path, bytes)?;
	write_regular_file(&absolute, &bytes, mode == Mode::FILE_EXECUTABLE)
}

fn write_regular_file(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
	match open_new_regular_file(path, executable) {
		Ok(mut file) => {
			file.write_all(bytes)?;
			return Ok(());
		},
		Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
		Err(err) => return Err(err.into()),
	}

	let metadata = fs::symlink_metadata(path)?;
	if !metadata.is_file() && !metadata.is_dir() {
		fs::remove_file(path)?;
		let mut file = open_new_regular_file(path, executable)?;
		file.write_all(bytes)?;
		return Ok(());
	}

	let mut file = open_existing_regular_file(path)?;
	file.write_all(bytes)?;
	#[cfg(unix)]
	sync_executable_bit(&file, executable)?;
	Ok(())
}

fn open_new_regular_file(path: &Path, executable: bool) -> std::io::Result<fs::File> {
	let mut options = fs::OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(if executable { 0o777 } else { 0o666 });
	}
	#[cfg(not(unix))]
	let _ = executable;
	options.open(path)
}

fn open_existing_regular_file(path: &Path) -> std::io::Result<fs::File> {
	let mut options = fs::OpenOptions::new();
	options.write(true).truncate(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.custom_flags(libc::O_NOFOLLOW);
	}
	options.open(path)
}

/// Preserve existing read/write restrictions (such as `0600`) while updating
/// executable bits: `Mode::FILE_EXECUTABLE` grants execute where read is
/// already permitted (plus owner execute), and `Mode::FILE` clears execute.
#[cfg(unix)]
fn sync_executable_bit(file: &fs::File, executable: bool) -> std::io::Result<()> {
	use std::os::unix::fs::{MetadataExt, PermissionsExt};

	let current = file.metadata()?.mode() & 0o7777;
	let desired = if executable {
		let exec_bits = ((current & 0o444) >> 2) | 0o100;
		(current & 0o777) | exec_bits
	} else {
		(current & 0o777) & !0o111
	};
	if desired != current {
		file.set_permissions(fs::Permissions::from_mode(desired))?;
	}
	Ok(())
}

/// Create or atomically replace a symlink without unlinking an existing entry
/// until a replacement symlink has been created.
#[cfg(unix)]
fn write_symlink(path: &Path, target: &[u8]) -> Result<()> {
	use std::{
		ffi::OsStr,
		os::unix::{ffi::OsStrExt, fs::symlink},
	};

	let target = OsStr::from_bytes(target);
	match symlink(target, path) {
		Ok(()) => return Ok(()),
		Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
		Err(err) => return Err(err.into()),
	}
	if fs::symlink_metadata(path)?.is_dir() {
		return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
	}
	let parent = path.parent().unwrap_or_else(|| Path::new("."));
	let temp = create_temp_symlink(parent, target)?;
	if let Err(err) = fs::rename(&temp, path) {
		let _ = fs::remove_file(&temp);
		return Err(err.into());
	}
	Ok(())
}

#[cfg(unix)]
fn create_temp_symlink(
	parent: &Path,
	target: &std::ffi::OsStr,
) -> std::io::Result<std::path::PathBuf> {
	use std::{
		os::unix::fs::symlink,
		sync::atomic::{AtomicU64, Ordering},
	};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
	let pid = std::process::id();
	for _ in 0..64 {
		let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
		let candidate = parent.join(format!(".omp-tmp-link-{pid}-{id}"));
		match symlink(target, &candidate) {
			Ok(()) => return Ok(candidate),
			Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
		}
	}
	Err(std::io::Error::new(
		std::io::ErrorKind::AlreadyExists,
		"failed to allocate temporary symlink name",
	))
}
