//! The shared `.git/COMMIT_EDITMSG` lock must never make a commit wait for
//! a hook that is not running.
//!
//! A `commit-msg` hook holds the lock while it runs, so a hook that commits
//! itself would wait for the lock its own parent holds. A commit that skips
//! the hook (`no_verify`) has no reason to take the lock at all: it must
//! finish while another call holds it.

use std::{
	fs::{File, OpenOptions},
	path::{Path, PathBuf},
	process::Command,
	sync::mpsc,
	time::Duration,
};

use omp_vcs::{git::GitRepo, types::CommitOptions};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
	let output = Command::new("git")
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout)
		.unwrap()
		.trim_end()
		.to_owned()
}

fn fixture() -> (TempDir, PathBuf) {
	let temp = tempfile::tempdir().unwrap();
	let root = temp.path().to_path_buf();
	git(&root, &["init", "-q", "-b", "main"]);
	git(&root, &["config", "user.name", "Test"]);
	git(&root, &["config", "user.email", "test@example.com"]);
	git(&root, &["config", "core.hooksPath", ".git/hooks"]);
	git(&root, &["config", "commit.gpgsign", "false"]);
	(temp, root)
}

/// Hold the shared-message lock the way a running `commit-msg` hook does.
fn hold_lock(git_dir: &Path) -> File {
	let path = git_dir.join(".omp-commit-editmsg.lock");
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.open(&path)
		.unwrap();
	file.lock().unwrap();
	file
}

#[test]
fn commit_without_a_hook_does_not_wait_for_the_shared_message_lock() {
	let (_temp, root) = fixture();
	let git_dir = root.join(".git");
	let _holder = hold_lock(&git_dir);
	std::fs::write(git_dir.join("COMMIT_EDITMSG"), "hook commit message\n").unwrap();

	let (tx, rx) = mpsc::channel();
	let worker = root.clone();
	std::thread::spawn(move || {
		let repo = GitRepo::require(&worker).unwrap();
		let result = repo.commit_create("nested commit\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..Default::default()
		});
		tx.send(result).ok();
	});

	let outcome = rx.recv_timeout(Duration::from_secs(30));
	assert!(
		outcome.is_ok(),
		"a commit that skips the commit-msg hook must not wait for the shared-message lock",
	);
	let id = outcome.unwrap().unwrap();
	assert_eq!(git(&root, &["rev-parse", "HEAD"]), id);
	assert_eq!(
		std::fs::read_to_string(git_dir.join("COMMIT_EDITMSG")).unwrap(),
		"hook commit message\n",
		"a commit that skips the lock when busy must not overwrite COMMIT_EDITMSG",
	);
}
