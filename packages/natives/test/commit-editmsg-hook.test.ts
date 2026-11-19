/**
 * A `commit-msg` hook that reads `.git/COMMIT_EDITMSG` instead of `$1` must
 * see the message of the commit that invoked it. Concurrent `commitCreate`
 * calls used to overwrite that shared file before the hook read it, and a
 * failed write was ignored, so the hook could approve a stale message.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-editmsg-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
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

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Linux `dev_t` major/minor, matching `/proc/locks`. */
function deviceToken(file: string): string {
	const { dev, ino } = statSync(file);
	const id = BigInt(dev);
	const major = ((id >> 8n) & 0xfffn) | ((id >> 32n) & ~0xfffn);
	const minor = (id & 0xffn) | ((id >> 12n) & ~0xffn);
	const hex = (value: bigint) => value.toString(16).padStart(2, "0");
	return `${hex(major)}:${hex(minor)}:${ino}`;
}

function lockIsBlocked(lockFile: string): boolean {
	if (!existsSync(lockFile)) return false;
	const token = deviceToken(lockFile);
	// The inode is matched as its own field. A short inode is a substring of
	// other rows in `/proc/locks`, and treating that as our waiter releases
	// the hook before the other commit is actually waiting.
	return readFileSync("/proc/locks", "utf8")
		.split("\n")
		.some(line => {
			const fields = line.split(/\s+/);
			return fields.includes("->") && fields.includes(token);
		});
}

function spinUntil(label: string, ready: () => boolean): void {
	for (let i = 0; i < 200_000; i++) {
		if (ready()) return;
	}
	throw new Error(`${label} was not reached\n${readText("/proc/locks") ?? ""}`);
}

describe("commitCreate shared COMMIT_EDITMSG", () => {
	test("rejects the commit when COMMIT_EDITMSG cannot be written for the hook", async () => {
		const root = await repository();
		await installHook(root, ["#!/bin/sh", 'printf x > "$GIT_DIR/hook-ran"', "exit 0", ""].join("\n"));
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await fs.rm(shared);
		await fs.mkdir(shared);
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("cannot land\n", { allowEmpty: true })).rejects.toThrow(/COMMIT_EDITMSG/);

		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(path.join(root, ".git", "hook-ran"))).toBe(false);

		const configured = await repository();
		await git(configured, "config", "hook.check.event", "commit-msg");
		await git(configured, "config", "hook.check.command", 'printf x > "$GIT_DIR/hook-ran"');
		const configuredShared = path.join(configured, ".git", "COMMIT_EDITMSG");
		await fs.rm(configuredShared);
		await fs.mkdir(configuredShared);
		const configuredHead = await git(configured, "rev-parse", "HEAD");
		const configuredRepo = vcsGitDiscover(configured)!;

		await expect(configuredRepo.commitCreate("cannot land\n", { allowEmpty: true })).rejects.toThrow(
			/COMMIT_EDITMSG/,
		);

		expect(await git(configured, "rev-parse", "HEAD")).toBe(configuredHead);
		expect(existsSync(path.join(configured, ".git", "hook-ran"))).toBe(false);
	});

	test("noVerify still commits when COMMIT_EDITMSG cannot be written", async () => {
		const root = await repository();
		await installHook(root, ["#!/bin/sh", 'printf x > "$GIT_DIR/hook-ran"', "exit 1", ""].join("\n"));
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await fs.rm(shared);
		await fs.mkdir(shared);
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("lands anyway\n", { allowEmpty: true, noVerify: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("lands anyway");
		expect(existsSync(path.join(root, ".git", "hook-ran"))).toBe(false);
	});

	test("still commits when COMMIT_EDITMSG cannot be written and no hook is installed", async () => {
		const root = await repository();
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await fs.rm(shared);
		await fs.mkdir(shared);
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("lands anyway\n", { allowEmpty: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("lands anyway");
	});

	test.skipIf(process.platform !== "linux")(
		"commit-msg hook reads COMMIT_EDITMSG while the repository lock is held",
		async () => {
			const root = await repository();
			const message = "owned subject\n\nowned body\n";
			await installHook(
				root,
				[
					"#!/bin/sh",
					'cat "$GIT_DIR/COMMIT_EDITMSG" > "$GIT_DIR/hook-saw"',
					'if flock -n "$GIT_DIR/omp-commit-msg.lock" true; then',
					"  printf 'lock-not-held\\n' >> \"$GIT_DIR/hook-saw\"",
					"  exit 1",
					"fi",
					"",
				].join("\n"),
			);
			const repo = vcsGitDiscover(root)!;

			const sha = await repo.commitCreate(message, { allowEmpty: true });

			expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
			expect(readFileSync(path.join(root, ".git", "hook-saw"), "utf8")).toBe(message);
			expect(await git(root, "log", "-1", "--format=%B")).toBe("owned subject\n\nowned body");
		},
	);

	test.skipIf(process.platform !== "linux")(
		"keeps COMMIT_EDITMSG unchanged while another commit waits on the hook",
		async () => {
			const root = await repository();
			const gitDir = path.join(root, ".git");
			const alpha = "ALPHA\n\nalpha body\n";
			const beta = "BETA\n\nbeta body\n";
			await installHook(
				root,
				[
					"#!/bin/sh",
					'id=$(head -n 1 "$1")',
					'if [ "$id" = "ALPHA" ]; then',
					'  printf x > "$GIT_DIR/alpha-ready"',
					'  while [ ! -f "$GIT_DIR/alpha-release" ]; do',
					"    :",
					"  done",
					'  cat "$GIT_DIR/COMMIT_EDITMSG" > "$GIT_DIR/alpha-saw"',
					"fi",
					"",
				].join("\n"),
			);
			const repo = vcsGitDiscover(root)!;
			const release = path.join(gitDir, "alpha-release");
			const shared = path.join(gitDir, "COMMIT_EDITMSG");
			const alphaCommit = repo.commitCreate(alpha, { allowEmpty: true });
			let betaCommit: Promise<string> | undefined;
			try {
				spinUntil("commit-msg hook", () => existsSync(path.join(gitDir, "alpha-ready")));
				expect(readText(shared)).toBe(alpha);
				betaCommit = repo.commitCreate(beta, { allowEmpty: true, noVerify: true });
				let blocked = false;
				let overwritten = false;
				spinUntil("concurrent commit to reach the shared message", () => {
					if (readText(shared) === beta) {
						overwritten = true;
						return true;
					}
					if (lockIsBlocked(path.join(gitDir, "omp-commit-msg.lock"))) {
						blocked = true;
						return true;
					}
					return false;
				});
				expect(overwritten).toBe(false);
				expect(blocked).toBe(true);
				expect(readText(shared)).toBe(alpha);
			} finally {
				writeFileSync(release, "x");
				await Promise.allSettled([alphaCommit, betaCommit].filter(commit => commit !== undefined));
			}
			if (betaCommit === undefined) throw new Error("second commit did not start");
			expect(readText(path.join(gitDir, "alpha-saw"))).toBe(alpha);
			const [alphaResult, betaResult] = await Promise.allSettled([alphaCommit, betaCommit]);
			const fulfilled = [alphaResult, betaResult].filter(result => result.status === "fulfilled");
			// The shared-message lock ends before HEAD is updated, and the ref
			// check happens before the ref file itself is locked. Both commits can
			// therefore land. A rejected one must be that race, not a mixed message.
			expect(fulfilled.length).toBeGreaterThan(0);
			for (const result of [alphaResult, betaResult]) {
				if (result?.status === "rejected") {
					const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
					expect(message).toMatch(/should have content/);
				}
			}
			const subject = await git(root, "log", "-1", "--format=%s");
			const body = await git(root, "log", "-1", "--format=%b");
			if (subject === "ALPHA") expect(body).toBe("alpha body");
			else if (subject === "BETA") expect(body).toBe("beta body");
			else throw new Error(`unexpected subject ${subject}`);
		},
	);
});

function permissionBits(file: string): number {
	return statSync(file).mode & 0o777;
}

async function sharedRepository(options: { initShared?: string; shared?: string }): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-editmsg-"));
	roots.push(root);
	if (options.initShared) {
		await git(root, "init", `--shared=${options.initShared}`, "-b", "main");
	} else {
		await git(root, "init", "-b", "main");
	}
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	await git(root, "config", "commit.gpgsign", "false");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	// A value Git rejects makes `git add` fail, so set it after the setup commit.
	if (options.shared !== undefined) {
		await git(root, "config", "core.sharedRepository", options.shared);
	}
	return root;
}

describe("commitCreate lock permissions", () => {
	// A lock left at mode 0644 is what the usual umask 022 creates. Another
	// person in a group-shared checkout then cannot open it, so they cannot
	// commit, even with noVerify. This machine cannot log in as that person;
	// the mode below is the one that lets them open the file.
	test.skipIf(process.platform === "win32")(
		"gives the commit lock the permissions core.sharedRepository asks for",
		async () => {
			const cases = [
				{ label: "init --shared=group", initShared: "group", preset: 0o644, expectMode: 0o664 },
				{ label: "group", shared: "group", preset: 0o600, expectMode: 0o660 },
				{ label: "true", shared: "true", preset: 0o600, expectMode: 0o660 },
				{ label: "all", shared: "all", preset: 0o600, expectMode: 0o664 },
				{ label: "2", shared: "2", preset: 0o600, expectMode: 0o664 },
				{ label: "0660", shared: "0660", preset: 0o644, expectMode: 0o660 },
				{ label: "0777", shared: "0777", preset: 0o644, expectMode: 0o666 },
				{ label: "false", shared: "false", preset: 0o600, expectMode: 0o600 },
				{ label: "unset", preset: 0o600, expectMode: 0o600 },
			];
			for (const entry of cases) {
				const root = await sharedRepository(entry);
				const lock = path.join(root, ".git", "omp-commit-msg.lock");
				await Bun.write(lock, "");
				await fs.chmod(lock, entry.preset);
				const repo = vcsGitDiscover(root)!;
				const sha = await repo.commitCreate(`${entry.label}\n`, { allowEmpty: true, noVerify: true });
				expect({ label: entry.label, head: await git(root, "rev-parse", "HEAD") }).toEqual({
					label: entry.label,
					head: sha,
				});
				expect({
					label: entry.label,
					mode: permissionBits(lock).toString(8),
				}).toEqual({
					label: entry.label,
					mode: entry.expectMode.toString(8),
				});
			}
		},
	);

	test("rejects a core.sharedRepository value Git does not understand", async () => {
		const root = await sharedRepository({ shared: "nope" });
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;
		await expect(repo.commitCreate("nope\n", { allowEmpty: true, noVerify: true })).rejects.toThrow(
			/sharedRepository/,
		);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
	});

	test.skipIf(process.platform === "win32")(
		"treats a sharedRepository key with no value as group sharing",
		async () => {
			const bare = await sharedRepository({});
			await fs.appendFile(path.join(bare, ".git", "config"), "\n[core]\n\tsharedRepository\n");
			const bareLock = path.join(bare, ".git", "omp-commit-msg.lock");
			await Bun.write(bareLock, "");
			await fs.chmod(bareLock, 0o644);
			const bareRepo = vcsGitDiscover(bare)!;
			await bareRepo.commitCreate("bare\n", { allowEmpty: true, noVerify: true });
			expect(permissionBits(bareLock)).toBe(0o664);

			const overridden = await sharedRepository({ shared: "false" });
			await fs.appendFile(path.join(overridden, ".git", "config"), "\n[core]\n\tsharedRepository\n");
			const overriddenLock = path.join(overridden, ".git", "omp-commit-msg.lock");
			await Bun.write(overriddenLock, "");
			await fs.chmod(overriddenLock, 0o600);
			const overriddenRepo = vcsGitDiscover(overridden)!;
			await overriddenRepo.commitCreate("override\n", { allowEmpty: true, noVerify: true });
			expect(permissionBits(overriddenLock)).toBe(0o660);

			const empty = await sharedRepository({});
			await fs.appendFile(path.join(empty, ".git", "config"), "\n[core]\n\tsharedRepository =\n");
			const emptyLock = path.join(empty, ".git", "omp-commit-msg.lock");
			await Bun.write(emptyLock, "");
			await fs.chmod(emptyLock, 0o644);
			const emptyRepo = vcsGitDiscover(empty)!;
			await emptyRepo.commitCreate("empty\n", { allowEmpty: true, noVerify: true });
			expect(permissionBits(emptyLock)).toBe(0o644);

			const spaced = await sharedRepository({});
			await fs.appendFile(path.join(spaced, ".git", "config"), "\n[core]\n\tsharedRepository \n");
			const spacedLock = path.join(spaced, ".git", "omp-commit-msg.lock");
			await Bun.write(spacedLock, "");
			await fs.chmod(spacedLock, 0o644);
			const spacedRepo = vcsGitDiscover(spaced)!;
			await spacedRepo.commitCreate("spaced\n", { allowEmpty: true, noVerify: true });
			expect(permissionBits(spacedLock)).toBe(0o664);

			const emptySpaced = await sharedRepository({});
			await fs.appendFile(path.join(emptySpaced, ".git", "config"), "\n[core]\n\tsharedRepository = \n");
			const emptySpacedLock = path.join(emptySpaced, ".git", "omp-commit-msg.lock");
			await Bun.write(emptySpacedLock, "");
			await fs.chmod(emptySpacedLock, 0o644);
			const emptySpacedRepo = vcsGitDiscover(emptySpaced)!;
			await emptySpacedRepo.commitCreate("empty spaced\n", { allowEmpty: true, noVerify: true });
			expect(permissionBits(emptySpacedLock)).toBe(0o644);
		},
	);
});
