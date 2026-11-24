/**
 * Concurrent `commitCreate` calls must not share `.git/COMMIT_EDITMSG`.
 *
 * The `commit-msg` hook runs after the message is written and before it is
 * read back. Replacing `COMMIT_EDITMSG` in that window is another call's
 * write. Each call has to commit its own subject and body, including the
 * hook's edit of the file it was given, and remove that file on every exit.
 * A legacy hook that ignores that path and reads `COMMIT_EDITMSG` must
 * likewise still see its own call's message while another call overlaps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-msg-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	// A global `core.hooksPath` would hide the fixture hook from gix.
	await git(root, "config", "core.hooksPath", ".git/hooks");
	await git(root, "config", "commit.gpgsign", "false");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

async function installHook(root: string, script: string): Promise<void> {
	const hooks = path.join(root, ".git", "hooks");
	await fs.mkdir(hooks, { recursive: true });
	const hook = path.join(hooks, "commit-msg");
	await Bun.write(hook, script);
	await fs.chmod(hook, 0o755);
}

const EDITMSG_LOCK = ".omp-commit-editmsg.lock";

/** Try taking the shared-message flock from outside; returns whether it succeeded. */
function tryExternalFlock(lockPath: string): boolean {
	const busyCode = 11;
	const result = Bun.which("flock")
		? Bun.spawnSync(["flock", "-n", "-E", String(busyCode), lockPath, "true"], { stderr: "pipe" })
		: Bun.which("python3")
			? Bun.spawnSync(
					[
						"python3",
						"-c",
						[
							"import errno, fcntl, sys",
							"try:",
							"    with open(sys.argv[1], 'rb') as f:",
							"        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)",
							"except OSError as err:",
							`    if err.errno in (errno.EACCES, errno.EAGAIN): sys.exit(${busyCode})`,
							"    raise",
						].join("\n"),
						lockPath,
					],
					{ stderr: "pipe" },
				)
			: (() => {
					throw new Error("need flock or python3 to probe the shared-message lock");
				})();
	if (result.exitCode === 0) return true;
	if (result.exitCode === busyCode) return false;
	throw new Error(`external lock probe failed (${result.exitCode}): ${result.stderr.toString()}`);
}

/** Poll `check` until it passes or the wall-clock deadline passes. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(10);
	}
	return true;
}

function settled(promise: Promise<string>): Promise<{ sha: string } | { error: unknown }> {
	return promise.then(
		sha => ({ sha }),
		error => ({ error }),
	);
}

describe("commitCreate message isolation", () => {
	test("keeps its subject and body when another call replaces COMMIT_EDITMSG", async () => {
		const root = await repository();
		await installHook(
			root,
			[
				"#!/bin/sh",
				'printf \'%s\' "$1" > "$GIT_DIR/seen-msg-path"',
				"printf '\\nHook-Trailer: kept\\n' >> \"$1\"",
				"printf '%s\\n\\n%s\\n' 'stolen subject' 'stolen body' > \"$GIT_DIR/COMMIT_EDITMSG\"",
				"",
			].join("\n"),
		);
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await Bun.write(shared, "preexisting\n");
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("mine subject\n\nmine body\n", { allowEmpty: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		const committed = await git(root, "log", "-1", "--format=%B");
		expect(committed).toContain("mine subject");
		expect(committed).toContain("mine body");
		expect(committed).toContain("Hook-Trailer: kept");
		expect(committed).not.toContain("stolen subject");
		const seen = (await Bun.file(path.join(root, ".git", "seen-msg-path")).text()).trim();
		expect(path.basename(seen)).not.toBe("COMMIT_EDITMSG");
		expect(await Bun.file(seen).exists()).toBe(false);
		expect(await Bun.file(shared).text()).toBe("stolen subject\n\nstolen body\n");
	});

	test("leaves no message file behind when noVerify skips the hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		const before = new Set(await fs.readdir(gitDir));
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("private message\n", { allowEmpty: true, noVerify: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("private message");
		const added = (await fs.readdir(gitDir)).filter(name => !before.has(name));
		// Only the COMMIT_EDITMSG lock file persists, by design; the private
		// message file is gone.
		expect(added).toEqual([EDITMSG_LOCK]);
	});

	test("removes the message file when commit-msg rejects the commit", async () => {
		const root = await repository();
		await installHook(root, ["#!/bin/sh", 'printf \'%s\' "$1" > "$GIT_DIR/seen-msg-path"', "exit 1", ""].join("\n"));
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await Bun.write(shared, "preexisting\n");
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("will not land\n", { allowEmpty: true })).rejects.toThrow();

		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		const seen = (await Bun.file(path.join(root, ".git", "seen-msg-path")).text()).trim();
		expect(path.basename(seen)).not.toBe("COMMIT_EDITMSG");
		expect(await Bun.file(seen).exists()).toBe(false);
		// Hooks that ignore `$1` and read COMMIT_EDITMSG see this call's message.
		expect(await Bun.file(shared).text()).toBe("will not land\n");
	});

	test.skipIf(process.platform === "win32")(
		"a legacy hook reading COMMIT_EDITMSG sees its own message during a concurrent commit",
		async () => {
			const root = await repository();
			const gitDir = path.join(root, ".git");
			// The validator under test reads the shared file, not `$1`; `$1`
			// only tells this fixture which invocation is running and what the
			// shared file must contain. The first invocation parks inside the
			// hook until the test releases it, so the second call reaches its
			// shared-file write while the first hook is still running. Each
			// invocation records what the shared file held when it looked.
			await installHook(
				root,
				[
					"#!/bin/sh",
					'msg=$(cat "$1")',
					"label=other",
					'case "$msg" in',
					"first*)",
					"	label=first",
					'	: > "$GIT_DIR/first-entered"',
					'	while [ ! -e "$GIT_DIR/release-first" ]; do sleep 0.02; done',
					"	;;",
					"second*)",
					"	label=second",
					'	: > "$GIT_DIR/second-entered"',
					"	;;",
					"esac",
					'shared=$(cat "$GIT_DIR/COMMIT_EDITMSG")',
					'printf \'%s\' "$shared" > "$GIT_DIR/seen-$label"',
					'if [ "$shared" != "$msg" ]; then echo "legacy hook saw: $shared" >&2; exit 1; fi',
					"",
				].join("\n"),
			);
			const repo = vcsGitDiscover(root)!;
			const first = settled(repo.commitCreate("first subject\n", { allowEmpty: true }));
			let second: Promise<{ sha: string } | { error: unknown }> | undefined;
			try {
				if (!(await waitFor(() => Bun.file(path.join(gitDir, "first-entered")).exists()))) {
					throw new Error("first commit-msg hook never entered");
				}
				second = settled(repo.commitCreate("second subject\n", { allowEmpty: true }));
				// The second call is at its shared-file write once its private
				// message file exists next to the first call's.
				const bothMessaged = await waitFor(
					async () => (await fs.readdir(gitDir)).filter(name => name.startsWith(".omp-commit-msg-")).length >= 2,
				);
				if (!bothMessaged) throw new Error("second call never wrote its message file");
				// Before releasing the first hook, prove the lock is actually
				// held: a separate attempt to take it cannot succeed, and the
				// second hook has not entered yet.
				const lockPath = path.join(gitDir, EDITMSG_LOCK);
				expect(await Bun.file(lockPath).exists()).toBe(true);
				expect(tryExternalFlock(lockPath)).toBe(false);
				expect(await Bun.file(path.join(gitDir, "second-entered")).exists()).toBe(false);
			} finally {
				// Release the parked hook and wait for both commits, so the
				// fixture is not torn down while a commit is still running.
				await Bun.write(path.join(gitDir, "release-first"), "");
				await first;
				if (second) await second;
			}
			const firstResult = await first;
			const secondResult = await second!;
			// Each hook saw the message of its own call, not the other one's.
			expect(await Bun.file(path.join(gitDir, "seen-first")).text()).toBe("first subject");
			expect(await Bun.file(path.join(gitDir, "seen-second")).text()).toBe("second subject");
			// Both calls read the same HEAD before either landed, so exactly
			// one of them updates the branch: which one is a race of its own.
			const landed = [firstResult, secondResult].filter(result => "sha" in result);
			expect(landed).toHaveLength(1);
			const winner = landed[0] as { sha: string };
			const winnerMessage = winner === firstResult ? "first subject" : "second subject";
			expect(await git(root, "rev-parse", "HEAD")).toBe(winner.sha);
			expect(await git(root, "log", "-1", "--format=%B")).toBe(winnerMessage);
			expect(await git(root, "rev-list", "--count", "HEAD")).toBe("2");
		},
		60_000,
	);

	test.skipIf(process.platform === "win32" || !Bun.which("ssh-keygen"))(
		"a concurrent commit reaches its commit-msg hook while the first commit is still signing",
		async () => {
			const root = await repository();
			const gitDir = path.join(root, ".git");
			await installHook(
				root,
				[
					"#!/bin/sh",
					'msg=$(cat "$1")',
					"label=other",
					'case "$msg" in',
					"first*)",
					"	label=first",
					'	: > "$GIT_DIR/first-entered"',
					"	;;",
					"second*)",
					"	label=second",
					'	: > "$GIT_DIR/second-entered"',
					"	;;",
					"esac",
					'shared=$(cat "$GIT_DIR/COMMIT_EDITMSG")',
					'printf \'%s\' "$shared" > "$GIT_DIR/seen-$label"',
					'if [ "$shared" != "$msg" ]; then echo "legacy hook saw: $shared" >&2; exit 1; fi',
					"",
				].join("\n"),
			);
			// Signing runs after the commit-msg hook and can take arbitrarily
			// long (an agent prompt), here until the test releases it. The
			// COMMIT_EDITMSG lock exists for the hook, so it must be released
			// before signing: while the first commit is parked in its signer,
			// the second commit's hook has to be able to run.
			const key = path.join(root, "signing-key");
			const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], {
				stderr: "pipe",
				stdout: "pipe",
			});
			const [keygenStderr, keygenExit] = await Promise.all([new Response(keygen.stderr).text(), keygen.exited]);
			if (keygenExit !== 0) throw new Error(keygenStderr);
			const signer = path.join(root, "signer.sh");
			await Bun.write(
				signer,
				[
					"#!/bin/sh",
					`if mkdir "${path.join(gitDir, "first-sign-hold")}" 2>/dev/null; then`,
					`	: > "${path.join(gitDir, "sign-entered")}"`,
					`	while [ ! -e "${path.join(gitDir, "release-sign")}" ]; do sleep 0.02; done`,
					"fi",
					'exec ssh-keygen "$@"',
					"",
				].join("\n"),
			);
			await fs.chmod(signer, 0o755);
			await git(root, "config", "gpg.format", "ssh");
			await git(root, "config", "gpg.ssh.program", signer);
			await git(root, "config", "user.signingkey", key);
			await git(root, "config", "commit.gpgsign", "true");
			const repo = vcsGitDiscover(root)!;
			const first = settled(repo.commitCreate("first subject\n", { allowEmpty: true }));
			let second: Promise<{ sha: string } | { error: unknown }> | undefined;
			try {
				if (!(await waitFor(() => Bun.file(path.join(gitDir, "sign-entered")).exists()))) {
					throw new Error("first commit never reached its signer");
				}
				second = settled(repo.commitCreate("second subject\n", { allowEmpty: true }));
				if (!(await waitFor(() => Bun.file(path.join(gitDir, "second-entered")).exists()))) {
					throw new Error("second commit-msg hook never ran while the first commit was signing");
				}
				await second;
			} finally {
				// Release the parked signer and wait for both commits, so the
				// fixture is not torn down while a commit is still running.
				await Bun.write(path.join(gitDir, "release-sign"), "");
				await first;
				if (second) await second;
			}
			const firstResult = await first;
			const secondResult = await second!;
			// Each hook saw the message of its own call, not the other one's.
			expect(await Bun.file(path.join(gitDir, "seen-first")).text()).toBe("first subject");
			expect(await Bun.file(path.join(gitDir, "seen-second")).text()).toBe("second subject");
			// Both calls read the same HEAD before either landed, so exactly
			// one of them updates the branch: which one is a race of its own.
			const landed = [firstResult, secondResult].filter(result => "sha" in result);
			expect(landed).toHaveLength(1);
			const winner = landed[0] as { sha: string };
			expect(await git(root, "rev-parse", "HEAD")).toBe(winner.sha);
			const winnerMessage = winner === firstResult ? "first subject" : "second subject";
			expect(await git(root, "log", "-1", "--format=%B")).toBe(winnerMessage);
			// Signing really ran: the parked signer was this path, not a
			// fallback that skipped it.
			expect(await git(root, "cat-file", "commit", "HEAD")).toContain("\ngpgsig ");
			expect(await git(root, "rev-list", "--count", "HEAD")).toBe("2");
		},
		60_000,
	);

	test("a COMMIT_EDITMSG write failure aborts only when a commit-msg hook may read it", async () => {
		const root = await repository();
		await installHook(root, "#!/bin/sh\nexit 0\n");
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await fs.rm(shared, { force: true });
		await fs.mkdir(shared);
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("hooked\n", { allowEmpty: true })).rejects.toThrow();
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);

		const sha = await repo.commitCreate("unverified\n", { allowEmpty: true, noVerify: true });
		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("unverified");
	});

	test.skipIf(process.platform === "win32")(
		"an unusable COMMIT_EDITMSG lock aborts only when a commit-msg hook may read the shared file",
		async () => {
			const root = await repository();
			const lock = path.join(root, ".git", EDITMSG_LOCK);
			await fs.symlink(path.join(root, "no-such-dir", "lock"), lock);
			const repo = vcsGitDiscover(root)!;

			// No hook reads the shared file, so the commit lands without it.
			const unhooked = await repo.commitCreate("no hook\n", { allowEmpty: true });
			expect(unhooked).toBe(await git(root, "rev-parse", "HEAD"));

			await installHook(root, "#!/bin/sh\nexit 0\n");
			const head = await git(root, "rev-parse", "HEAD");
			await expect(repo.commitCreate("hooked\n", { allowEmpty: true })).rejects.toThrow();
			expect(await git(root, "rev-parse", "HEAD")).toBe(head);

			// A lock file another user left read-only still locks when opened
			// read-only, so the hooked commit proceeds.
			await fs.unlink(lock);
			await Bun.write(lock, "");
			await fs.chmod(lock, 0o444);
			const hooked = await repo.commitCreate("read-only lock\n", { allowEmpty: true });
			expect(hooked).toBe(await git(root, "rev-parse", "HEAD"));
			expect(await git(root, "log", "-1", "--format=%B")).toBe("read-only lock");
		},
	);
});
