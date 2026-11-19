//! `commit-msg` hooks that read `.git/COMMIT_EDITMSG` must see the message of
//! the commit that invoked them, even when another `commit_create` is running.

use std::{
	fs,
	path::{Path, PathBuf},
	process::Command,
	thread::JoinHandle,
};

use omp_vcs::{Error, git::GitRepo, types::CommitOptions};
use tempfile::TempDir;

fn git<const N: usize>(dir: &Path, args: &[&str; N]) -> String {
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

fn fixture() -> (TempDir, GitRepo) {
	let temp = tempfile::tempdir().unwrap();
	git(temp.path(), &["init", "-q", "-b", "main"]);
	for (key, value) in [
		("user.name", "Test"),
		("user.email", "test@example.com"),
		("commit.gpgsign", "false"),
		("core.autocrlf", "false"),
		("core.hooksPath", ".git/hooks"),
	] {
		git(temp.path(), &["config", key, value]);
	}
	fs::write(temp.path().join("a"), "one\n").unwrap();
	git(temp.path(), &["add", "."]);
	git(temp.path(), &["commit", "-qm", "base"]);
	let repo = GitRepo::require(temp.path()).unwrap();
	(temp, repo)
}

fn write_hook(path: &Path, body: &str) {
	fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let mut perms = fs::metadata(path).unwrap().permissions();
		perms.set_mode(0o755);
		fs::set_permissions(path, perms).unwrap();
	}
}

fn unwritable_editmsg(git_dir: &Path) {
	let shared = git_dir.join("COMMIT_EDITMSG");
	if shared.symlink_metadata().is_ok() {
		fs::remove_file(&shared).unwrap();
	}
	fs::create_dir(&shared).unwrap();
}

/// Replacing `COMMIT_EDITMSG` with a directory makes the shared-message write
/// fail. A commit that may run `commit-msg` must stop before the hook, and
/// must leave HEAD where it was. Ignoring the error lets the hook judge a
/// stale message.
#[test]
fn commit_editmsg_write_failure_rejects_when_a_hook_may_read_it() {
	let (temp, repo) = fixture();
	let git_dir = temp.path().join(".git");
	unwritable_editmsg(&git_dir);
	write_hook(&git_dir.join("hooks/commit-msg"), "printf x > \"$GIT_DIR/hook-ran\"");
	let head = git(temp.path(), &["rev-parse", "HEAD"]);
	let err = repo
		.commit_create("cannot land\n", &CommitOptions {
			allow_empty: true,
			..CommitOptions::default()
		})
		.unwrap_err();
	assert!(
		matches!(err, Error::Backend { context: "git commit write COMMIT_EDITMSG", .. }),
		"{err:?}"
	);
	assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head);
	assert!(!git_dir.join("hook-ran").exists(), "hook ran after the shared write failed");

	let (configured_temp, _) = fixture();
	let configured_git_dir = configured_temp.path().join(".git");
	git(configured_temp.path(), &["config", "hook.check.event", "commit-msg"]);
	git(configured_temp.path(), &[
		"config",
		"hook.check.command",
		"printf x > \"$GIT_DIR/hook-ran\"",
	]);
	unwritable_editmsg(&configured_git_dir);
	let configured_head = git(configured_temp.path(), &["rev-parse", "HEAD"]);
	let configured_repo = GitRepo::require(configured_temp.path()).unwrap();
	let err = configured_repo
		.commit_create("cannot land\n", &CommitOptions {
			allow_empty: true,
			..CommitOptions::default()
		})
		.unwrap_err();
	assert!(
		matches!(err, Error::Backend { context: "git commit write COMMIT_EDITMSG", .. }),
		"{err:?}"
	);
	assert_eq!(git(configured_temp.path(), &["rev-parse", "HEAD"]), configured_head);
	assert!(
		!configured_git_dir.join("hook-ran").exists(),
		"configured hook ran after the shared write failed"
	);
}

/// `--no-verify` does not run the hook, so a failed shared-file write must
/// not reject the commit.
#[test]
fn commit_editmsg_write_failure_is_ignored_when_no_verify_skips_the_hook() {
	let (temp, repo) = fixture();
	let git_dir = temp.path().join(".git");
	unwritable_editmsg(&git_dir);
	write_hook(&git_dir.join("hooks/commit-msg"), "printf x > \"$GIT_DIR/hook-ran\"\nexit 1");
	let id = repo
		.commit_create("lands\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap();
	assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), id);
	assert_eq!(git(temp.path(), &["log", "-1", "--format=%B"]), "lands");
	assert!(!git_dir.join("hook-ran").exists());
}

/// With no executable `commit-msg` hook, nothing reads the shared file, so a
/// failed write must not reject the commit.
#[test]
fn commit_editmsg_write_failure_is_ignored_when_no_hook_is_installed() {
	let (temp, repo) = fixture();
	unwritable_editmsg(&temp.path().join(".git"));
	let id = repo
		.commit_create("lands\n", &CommitOptions { allow_empty: true, ..CommitOptions::default() })
		.unwrap();
	assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), id);
	assert_eq!(git(temp.path(), &["log", "-1", "--format=%B"]), "lands");
}

/// The hook reads `.git/COMMIT_EDITMSG` and also checks that this process
/// still holds the repository lock. A hook that runs unlocked can validate
/// whatever message a concurrent commit stored there.
#[cfg(target_os = "linux")]
#[test]
fn commit_editmsg_hook_reads_its_message_under_the_repository_lock() {
	let (temp, repo) = fixture();
	let message = "owned subject\n\nowned body\n";
	write_hook(
		&temp.path().join(".git/hooks/commit-msg"),
		"cat \"$GIT_DIR/COMMIT_EDITMSG\" > \"$GIT_DIR/hook-saw\"\nif flock -n \
		 \"$GIT_DIR/omp-commit-msg.lock\" true; then\nprintf 'lock-not-held\\n' >> \
		 \"$GIT_DIR/hook-saw\"\nexit 1\nfi",
	);
	repo
		.commit_create(message, &CommitOptions { allow_empty: true, ..CommitOptions::default() })
		.unwrap();
	assert_eq!(fs::read_to_string(temp.path().join(".git/hook-saw")).unwrap(), message);
	assert_eq!(git(temp.path(), &["log", "-1", "--format=%B"]), "owned subject\n\nowned body");
}

#[cfg(target_os = "linux")]
fn lock_is_blocked(git_dir: &Path) -> bool {
	use std::os::unix::fs::MetadataExt;
	let Ok(meta) = fs::metadata(git_dir.join("omp-commit-msg.lock")) else {
		return false;
	};
	let dev = meta.dev();
	// Linux dev_t, same split `/proc/locks` prints (`major:minor:ino`).
	let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff_u64);
	let minor = (dev & 0xff) | ((dev >> 12) & !0xff_u64);
	let token = format!("{major:02x}:{minor:02x}:{}", meta.ino());
	let Ok(text) = fs::read_to_string("/proc/locks") else {
		return false;
	};
	// The inode is its own field. A short inode is a substring of other rows,
	// which would look like our waiter before the other commit is waiting.
	text.lines().any(|line| {
		let fields = line.split_whitespace();
		fields.clone().any(|field| field == "->") && fields.clone().any(|field| field == token)
	})
}

/// While one commit's `commit-msg` hook is still running, another
/// `commit_create` must not replace `.git/COMMIT_EDITMSG`. The hook would
/// otherwise accept or reject this commit using the other call's text.
#[cfg(target_os = "linux")]
#[test]
fn commit_editmsg_stays_put_until_the_commit_msg_hook_returns() {
	let (temp, _repo) = fixture();
	let root = temp.path().to_owned();
	let git_dir = root.join(".git");
	let alpha = "ALPHA\n\nalpha body\n";
	let beta = "BETA\n\nbeta body\n";
	write_hook(
		&git_dir.join("hooks/commit-msg"),
		"id=$(head -n 1 \"$1\")\nif [ \"$id\" = \"ALPHA\" ]; then\nprintf x > \
		 \"$GIT_DIR/alpha-ready\"\nwhile [ ! -f \"$GIT_DIR/alpha-release\" ]; do\n:\ndone\ncat \
		 \"$GIT_DIR/COMMIT_EDITMSG\" > \"$GIT_DIR/alpha-saw\"\nfi",
	);

	// Release the hook and join both commits on every exit, including a
	// failed assertion, so a spinning hook cannot hang the process.
	struct Finish {
		release: PathBuf,
		alpha:   Option<JoinHandle<omp_vcs::Result<String>>>,
		beta:    Option<JoinHandle<omp_vcs::Result<String>>>,
	}
	impl Drop for Finish {
		fn drop(&mut self) {
			let _ = fs::write(&self.release, b"x");
			if let Some(handle) = self.alpha.take() {
				let _ = handle.join();
			}
			if let Some(handle) = self.beta.take() {
				let _ = handle.join();
			}
		}
	}

	let release = git_dir.join("alpha-release");
	let mut finish = Finish {
		release: release.clone(),
		alpha:   Some(std::thread::spawn({
			let root = root.clone();
			move || {
				GitRepo::require(&root)
					.unwrap()
					.commit_create(alpha, &CommitOptions {
						allow_empty: true,
						..CommitOptions::default()
					})
			}
		})),
		beta:    None,
	};
	for _ in 0..200_000 {
		if git_dir.join("alpha-ready").exists() {
			break;
		}
		std::thread::yield_now();
	}
	assert!(git_dir.join("alpha-ready").exists(), "commit-msg hook did not start");
	let shared = git_dir.join("COMMIT_EDITMSG");
	assert_eq!(fs::read_to_string(&shared).unwrap(), alpha);
	finish.beta = Some(std::thread::spawn({
		let root = root.clone();
		move || {
			GitRepo::require(&root)
				.unwrap()
				.commit_create(beta, &CommitOptions {
					allow_empty: true,
					no_verify: true,
					..CommitOptions::default()
				})
		}
	}));
	let mut blocked = false;
	let mut overwritten = false;
	for _ in 0..200_000 {
		if fs::read_to_string(&shared).ok().as_deref() == Some(beta) {
			overwritten = true;
			break;
		}
		if lock_is_blocked(&git_dir) {
			blocked = true;
			break;
		}
		std::thread::yield_now();
	}
	assert!(
		blocked && !overwritten,
		"concurrent commit did not wait for the hook\noverwritten={overwritten}\n{}\n{}",
		fs::read_to_string(&shared).unwrap_or_default(),
		fs::read_to_string("/proc/locks").unwrap_or_default(),
	);
	assert_eq!(fs::read_to_string(&shared).unwrap(), alpha);
	fs::write(&release, b"x").unwrap();
	let alpha_res = finish.alpha.take().unwrap().join().expect("alpha thread");
	let beta_res = finish.beta.take().unwrap().join().expect("beta thread");
	assert_eq!(fs::read_to_string(git_dir.join("alpha-saw")).unwrap(), alpha);
	let mut landed = 0;
	for result in [alpha_res, beta_res] {
		match result {
			Ok(_) => landed += 1,
			// The message lock ends before the ref update, and that update checks
			// the old id before locking the ref file, so both commits can land.
			Err(err) if err.to_string().contains("should have content") => {},
			Err(err) => panic!("{err:?}"),
		}
	}
	assert!(landed >= 1, "both commits failed");
	match git(&root, &["log", "-1", "--format=%s"]).as_str() {
		"ALPHA" => assert_eq!(git(&root, &["log", "-1", "--format=%b"]), "alpha body"),
		"BETA" => assert_eq!(git(&root, &["log", "-1", "--format=%b"]), "beta body"),
		other => panic!("unexpected subject {other}"),
	}
}

fn open_shared(init_shared: Option<&str>, config: Option<&str>) -> (TempDir, GitRepo) {
	open_shared_line(init_shared, config, None)
}

fn open_shared_line(
	init_shared: Option<&str>,
	config: Option<&str>,
	raw_line: Option<&str>,
) -> (TempDir, GitRepo) {
	let temp = tempfile::tempdir().unwrap();
	if let Some(shared) = init_shared {
		let arg = format!("--shared={shared}");
		git(temp.path(), &["init", "-q", &arg, "-b", "main"]);
	} else {
		git(temp.path(), &["init", "-q", "-b", "main"]);
	}
	for (key, value) in [
		("user.name", "Test"),
		("user.email", "test@example.com"),
		("commit.gpgsign", "false"),
		("core.autocrlf", "false"),
	] {
		git(temp.path(), &["config", key, value]);
	}
	fs::write(temp.path().join("a"), "one\n").unwrap();
	git(temp.path(), &["add", "."]);
	git(temp.path(), &["commit", "-qm", "base"]);
	// After the setup commit: a value Git rejects makes `git add` itself fail,
	// and the repository is opened only once the value is on disk.
	if let Some(value) = config {
		git(temp.path(), &["config", "core.sharedRepository", value]);
	}
	if let Some(line) = raw_line {
		use std::io::Write;
		let mut file = fs::OpenOptions::new()
			.append(true)
			.open(temp.path().join(".git/config"))
			.unwrap();
		writeln!(file, "\n[core]\n\t{line}").unwrap();
	}
	let repo = GitRepo::require(temp.path()).unwrap();
	(temp, repo)
}

/// A value Git does not accept must not be ignored. Ignoring it would leave
/// the lock at the creator's umask and still publish the commit.
#[test]
fn bad_shared_repository_rejects_the_commit() {
	let (temp, repo) = open_shared(None, Some("nope"));
	let head = git(temp.path(), &["rev-parse", "HEAD"]);
	let err = repo
		.commit_create("nope\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap_err();
	assert!(
		matches!(err, Error::Backend { context: "git commit read core.sharedRepository", .. }),
		"{err:?}"
	);
	assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head);
}

#[cfg(unix)]
fn file_mode(path: &Path) -> u32 {
	use std::os::unix::fs::PermissionsExt;
	fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: u32) {
	use std::os::unix::fs::PermissionsExt;
	let mut perms = fs::metadata(path).unwrap().permissions();
	perms.set_mode(mode);
	fs::set_permissions(path, perms).unwrap();
}

/// The permanent lock has to be openable by the next person who commits, not
/// only by whoever created it. This machine cannot switch user ids, so each
/// case plants the mode a creator's umask would leave and checks the mode a
/// non-owner needs in order to open the file for writing.
#[cfg(unix)]
#[test]
fn commit_editmsg_lock_follows_core_shared_repository() {
	struct Case {
		label:  &'static str,
		init:   Option<&'static str>,
		config: Option<&'static str>,
		preset: u32,
		expect: u32,
	}
	// `git init --shared=group` stores `1`, not the word `group`. `all` is
	// stored as `2`. A plain `0644` lock is what umask 022 creates; without
	// an update, someone else in the group cannot open it.
	let cases = [
		Case {
			label:  "init --shared=group",
			init:   Some("group"),
			config: None,
			preset: 0o644,
			expect: 0o664,
		},
		Case { label: "group", init: None, config: Some("group"), preset: 0o600, expect: 0o660 },
		Case { label: "true", init: None, config: Some("true"), preset: 0o600, expect: 0o660 },
		Case { label: "all", init: None, config: Some("all"), preset: 0o600, expect: 0o664 },
		Case { label: "2", init: None, config: Some("2"), preset: 0o600, expect: 0o664 },
		Case { label: "0660", init: None, config: Some("0660"), preset: 0o644, expect: 0o660 },
		Case { label: "0777", init: None, config: Some("0777"), preset: 0o644, expect: 0o666 },
		Case { label: "false", init: None, config: Some("false"), preset: 0o600, expect: 0o600 },
		Case { label: "unset", init: None, config: None, preset: 0o600, expect: 0o600 },
	];
	for case in cases {
		let (temp, repo) = open_shared(case.init, case.config);
		let lock = temp.path().join(".git/omp-commit-msg.lock");
		fs::write(&lock, b"").unwrap();
		set_file_mode(&lock, case.preset);
		repo
			.commit_create(case.label, &CommitOptions {
				allow_empty: true,
				no_verify: true,
				..CommitOptions::default()
			})
			.unwrap_or_else(|err| panic!("{}: {err}", case.label));
		assert_eq!(file_mode(&lock), case.expect, "{}", case.label);
	}
}

/// A `sharedRepository` key with no `=` is boolean true, so the lock must be
/// group-writable. `sharedRepository =` is an empty value and must stay
/// private. Reading both as "no value" leaves the first lock owner-only.
#[cfg(unix)]
#[test]
fn valueless_shared_repository_grants_group_and_empty_does_not() {
	let (temp, repo) = open_shared_line(None, None, Some("sharedRepository"));
	let lock = temp.path().join(".git/omp-commit-msg.lock");
	fs::write(&lock, b"").unwrap();
	set_file_mode(&lock, 0o644);
	repo
		.commit_create("bare\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap();
	assert_eq!(file_mode(&lock), 0o664, "a key with no value is group sharing");

	// A later key with no value overrides an earlier `false`. The text lookup
	// skips the later key and would keep the private mode.
	let (temp, repo) = open_shared_line(None, Some("false"), Some("sharedRepository"));
	let lock = temp.path().join(".git/omp-commit-msg.lock");
	fs::write(&lock, b"").unwrap();
	set_file_mode(&lock, 0o600);
	repo
		.commit_create("override\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap();
	assert_eq!(file_mode(&lock), 0o660, "the later key with no value wins");

	let (temp, repo) = open_shared_line(None, None, Some("sharedRepository ="));
	let lock = temp.path().join(".git/omp-commit-msg.lock");
	fs::write(&lock, b"").unwrap();
	set_file_mode(&lock, 0o644);
	repo
		.commit_create("empty\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap();
	assert_eq!(file_mode(&lock), 0o644, "an empty value is not group sharing");

	let (temp, repo) = open_shared_line(None, None, Some("sharedRepository "));
	let lock = temp.path().join(".git/omp-commit-msg.lock");
	fs::write(&lock, b"").unwrap();
	set_file_mode(&lock, 0o644);
	repo
		.commit_create("spaced\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap();
	assert_eq!(file_mode(&lock), 0o664, "spaces after a key with no value are still group sharing");

	let (temp, repo) = open_shared_line(None, None, Some("sharedRepository = "));
	let lock = temp.path().join(".git/omp-commit-msg.lock");
	fs::write(&lock, b"").unwrap();
	set_file_mode(&lock, 0o644);
	repo
		.commit_create("empty-spaced\n", &CommitOptions {
			allow_empty: true,
			no_verify: true,
			..CommitOptions::default()
		})
		.unwrap();
	assert_eq!(file_mode(&lock), 0o644, "an equals sign with an empty value stays private");
}
