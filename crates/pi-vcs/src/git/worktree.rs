//! Filesystem materialization for blobs destined for a worktree.

use std::{fs, path::Path};

use gix::index::entry::Mode;

use super::filter::WorktreeFilter;
use crate::error::Result;

/// Write `bytes` at repo-relative `path` according to its Git mode. Symlink
/// blobs are raw target names, never filtered content. Replacing a symlink
/// with a regular file must unlink it first so the write cannot reach its
/// target, including one outside the repository.
pub(crate) fn materialize(
	root: &Path,
	path: &str,
	mode: Mode,
	bytes: Vec<u8>,
	filter: &mut WorktreeFilter<'_>,
) -> Result<()> {
	let absolute = root.join(path);
	if let Some(parent) = absolute.parent() {
		fs::create_dir_all(parent)?;
	}
	if mode == Mode::SYMLINK {
		remove_file(&absolute)?;
		write_symlink(&absolute, &bytes)?;
		return Ok(());
	}

	let bytes = filter.git_to_worktree(path, bytes)?;
	remove_symlink(&absolute)?;
	fs::write(&absolute, bytes)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let permissions = fs::Permissions::from_mode(if mode == Mode::FILE_EXECUTABLE {
			0o755
		} else {
			0o644
		});
		fs::set_permissions(&absolute, permissions)?;
	}
	Ok(())
}

/// Remove a file or symlink, but never recursively remove a directory.
fn remove_file(path: &Path) -> Result<()> {
	match fs::remove_file(path) {
		Ok(()) => {},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

fn remove_symlink(path: &Path) -> Result<()> {
	match fs::symlink_metadata(path) {
		Ok(metadata) if metadata.file_type().is_symlink() => fs::remove_file(path)?,
		Ok(_) => {},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

#[cfg(unix)]
fn write_symlink(path: &Path, target: &[u8]) -> Result<()> {
	use std::os::unix::{ffi::OsStrExt, fs::symlink};
	symlink(std::ffi::OsStr::from_bytes(target), path)?;
	Ok(())
}

/// On platforms without Unix symlinks, match `core.symlinks=false`: the link
/// target is stored as plain file content.
#[cfg(not(unix))]
fn write_symlink(path: &Path, target: &[u8]) -> Result<()> {
	fs::write(path, target)?;
	Ok(())
}
