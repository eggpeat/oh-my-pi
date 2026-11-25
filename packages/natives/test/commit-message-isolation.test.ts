/**
 * Concurrent `commitCreate` calls must not share `.git/COMMIT_EDITMSG`.
 *
 * The `commit-msg` hook runs after the message is written and before it is
 * read back. Replacing `COMMIT_EDITMSG` in that window is another call's
 * write. Each call has to commit its own subject and body, including the
 * hook's edit of the file it was given, and remove that file on every exit.
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

	test("serializes the shared COMMIT_EDITMSG through the commit-msg hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		// Legacy hooks ignore $1 and read the documented COMMIT_EDITMSG path. The
		// hook parks after recording which call it is (its private file's name);
		// only once released does it record the shared file it actually saw.
		await installHook(
			root,
			[
				"#!/bin/bash",
				'name=$(basename "$1")',
				'echo "$name" >> "$GIT_DIR/hook-ran"',
				"end=$((SECONDS + 60))",
				'while [ ! -f "$GIT_DIR/release-all" ] && [ $SECONDS -lt $end ]; do :; done',
				'cat "$GIT_DIR/COMMIT_EDITMSG" > "$GIT_DIR/seen-$name"',
				"",
			].join("\n"),
		);
		const repo = vcsGitDiscover(root)!;

		const hookRuns = async (): Promise<string[]> => {
			try {
				return (await Bun.file(path.join(gitDir, "hook-ran")).text()).split("\n").filter(line => line.length > 0);
			} catch {
				return [];
			}
		};
		// Bounded by a clock deadline, not a loop count, so a slow runner has the
		// full budget to spawn the next hook.
		const waitForHookCount = async (count: number): Promise<string[]> => {
			const deadline = Date.now() + 10_000;
			let runs = await hookRuns();
			while (runs.length < count && Date.now() < deadline) {
				await Bun.sleep(25);
				runs = await hookRuns();
			}
			return runs;
		};

		const first = repo.commitCreate("first subject\n\nfirst body\n", { allowEmpty: true });
		// If an assertion below fails first, the commits settle after the repo is
		// cleaned up; keep their rejections from leaking into other tests.
		first.catch(() => {});
		const runs1 = await waitForHookCount(1);
		expect(runs1).toHaveLength(1);
		// While the first hook is parked, a second call must not reach the shared
		// file or its own hook: without serialization it does, and the first hook
		// then validates the second call's message.
		const second = repo.commitCreate("second subject\n\nsecond body\n", { allowEmpty: true });
		second.catch(() => {});
		const runs2 = await waitForHookCount(2);
		try {
			expect(runs2).toHaveLength(1);
		} finally {
			await Bun.write(path.join(gitDir, "release-all"), "");
		}
		const [firstResult, secondResult] = await Promise.allSettled([first, second]);
		expect(firstResult.status).toBe("fulfilled");

		const seenFirst = (await Bun.file(path.join(gitDir, `seen-${runs1[0]}`)).text()).trim();
		expect(seenFirst).toBe("first subject\n\nfirst body");
		// The second call may fail the ref update once the first commit lands;
		// either way its hook must never observe the first call's message.
		if (secondResult.status === "fulfilled") {
			expect(secondResult.value).toBe(await git(root, "rev-parse", "HEAD"));
			const seenSecond = (await Bun.file(path.join(gitDir, `seen-${runs2[0]}`)).text()).trim();
			expect(seenSecond).toBe("second subject\n\nsecond body");
		} else {
			expect(secondResult.reason.message).toContain("HEAD moved");
		}
	}, 60_000);

	test("leaves no message file behind when noVerify skips the hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		const before = new Set(await fs.readdir(gitDir));
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("private message\n", { allowEmpty: true, noVerify: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("private message");
		const added = (await fs.readdir(gitDir)).filter(name => !before.has(name));
		expect(added).toEqual([]);
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
});
