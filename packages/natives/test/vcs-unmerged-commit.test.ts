import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr || stdout);
	return stdout.trimEnd();
}

async function expectUnmerged(run: () => Promise<unknown>, path: string, context: string): Promise<void> {
	let error: unknown;
	try {
		await run();
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ name: "VcsError", code: "Backend" });
	const message = error instanceof Error ? error.message : String(error);
	expect(message.startsWith(context)).toBe(true);
	expect(message).toContain("unmerged entries");
	expect(message).toContain(path);
}

/** Content conflict on `conflicted.txt` (stages 1-3, no stage 0) plus a staged `extra.txt`. */
async function conflictedCheckout(): Promise<{ root: string; head: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-unmerged-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	await git(root, "config", "core.hooksPath", ".git/hooks");
	await writeFile(join(root, "conflicted.txt"), "base\n");
	await writeFile(join(root, "kept.txt"), "kept\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "base");
	await git(root, "checkout", "-b", "side");
	await writeFile(join(root, "conflicted.txt"), "side\n");
	await git(root, "commit", "-am", "side");
	await git(root, "checkout", "main");
	await writeFile(join(root, "conflicted.txt"), "main\n");
	await git(root, "commit", "-am", "main");
	const head = await git(root, "rev-parse", "HEAD");
	const merge = Bun.spawn(["git", "merge", "side"], { cwd: root, stderr: "pipe", stdout: "pipe" });
	const mergeCode = await merge.exited;
	if (mergeCode === 0) throw new Error("expected a content conflict");
	const stages = await git(root, "ls-files", "-s", "--", "conflicted.txt");
	if (!stages.split("\n").some(line => line.split(/\s+/)[2] === "1")) {
		throw new Error(`conflict must keep stage 1: ${stages}`);
	}
	if (stages.split("\n").some(line => line.split(/\s+/)[2] === "0")) {
		throw new Error(`deletion bug requires no stage 0: ${stages}`);
	}
	await writeFile(join(root, "extra.txt"), "extra\n");
	await git(root, "add", "extra.txt");
	const unmerged = await git(root, "ls-files", "-u", "--", "conflicted.txt");
	if (!unmerged.includes("conflicted.txt")) throw new Error("staging extra resolved the conflict");
	return { root, head };
}

async function installHook(root: string, body: string): Promise<void> {
	const path = join(root, ".git/hooks/pre-commit");
	await mkdir(join(root, ".git/hooks"), { recursive: true });
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
}

describe("unresolved index commits", () => {
	test("refuses to commit an unresolved index and leaves the conflicted file in HEAD", async () => {
		const { root, head } = await conflictedCheckout();
		await installHook(root, "echo ran > hook-ran\nexit 0");
		const repo = vcsGitDiscover(root)!;
		const treeBefore = await git(root, "rev-parse", "HEAD^{tree}");

		await expectUnmerged(() => repo.commitCreate("should refuse", {}), "conflicted.txt", "git commit:");
		expect(await Bun.file(join(root, "hook-ran")).exists()).toBe(false);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "rev-parse", "HEAD^{tree}")).toBe(treeBefore);
		expect(await git(root, "rev-parse", "HEAD:conflicted.txt")).not.toBe("");
		expect(await git(root, "ls-files", "-u", "--", "conflicted.txt")).toContain("conflicted.txt");

		await expectUnmerged(() => repo.commitCreate("empty", { allowEmpty: true }), "conflicted.txt", "git commit:");
		await expectUnmerged(() => repo.commitCreate("amend", { amend: true }), "conflicted.txt", "git commit:");
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");
	});

	test("refuses to write a tree from an unresolved index", async () => {
		const { root, head } = await conflictedCheckout();
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(() => repo.writeTree(), "conflicted.txt", "git write-tree:");
		const alternate = join(root, "conflicted.index");
		await copyFile(join(root, ".git/index"), alternate);
		await expectUnmerged(() => repo.writeTree(alternate), "conflicted.txt", "git write-tree:");
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-files", "-u", "--", "conflicted.txt")).toContain("conflicted.txt");
	});

	test("refuses a pathspec commit when another index entry is unresolved", async () => {
		const { root, head } = await conflictedCheckout();
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(
			() => repo.commitCreate("partial", { files: ["extra.txt"] }),
			"conflicted.txt",
			"git commit:",
		);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");
		expect(await git(root, "rev-parse", "HEAD:conflicted.txt")).not.toBe("");
		expect(await git(root, "ls-files", "-u", "--", "conflicted.txt")).toContain("conflicted.txt");
	});

	test("refuses a pathspec commit when a pre-commit hook leaves unresolved stages", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-unmerged-hook-"));
		roots.push(root);
		await git(root, "init", "-b", "main");
		await git(root, "config", "user.name", "Native Test");
		await git(root, "config", "user.email", "native@example.test");
		await git(root, "config", "core.autocrlf", "false");
		await git(root, "config", "core.hooksPath", ".git/hooks");
		await writeFile(join(root, "tracked.txt"), "base\n");
		await git(root, "add", "tracked.txt");
		await git(root, "commit", "-m", "base");
		await writeFile(join(root, "extra.txt"), "extra\n");
		await git(root, "add", "extra.txt");
		const head = await git(root, "rev-parse", "HEAD");
		await installHook(
			root,
			[
				"set -e",
				"base=$(git rev-parse HEAD:tracked.txt)",
				"ours=$(printf 'ours\\n' | git hash-object -w --stdin)",
				"git update-index --force-remove tracked.txt",
				'printf \'100644 %s 1\\ttracked.txt\\n100644 %s 2\\ttracked.txt\\n\' "$base" "$ours" | git update-index --index-info',
				"echo ran > hook-ran",
			].join("\n"),
		);
		const repo = vcsGitDiscover(root)!;
		await expectUnmerged(() => repo.commitCreate("partial", { files: ["extra.txt"] }), "tracked.txt", "git commit:");
		expect(await Bun.file(join(root, "hook-ran")).exists()).toBe(true);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("extra.txt");
		expect(await git(root, "ls-files", "-u", "--", "tracked.txt")).toContain("tracked.txt");
	});
});
