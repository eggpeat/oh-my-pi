import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, isVcsError } from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trimEnd();
}

async function repository(commit: boolean): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-head-race-"));
	roots.push(root);
	await run(root, "init", "-q", "-b", "main");
	await run(root, "config", "user.name", "Head Race");
	await run(root, "config", "user.email", "head-race@example.test");
	// The developer's global `core.hooksPath` would redirect hook lookup.
	await run(root, "config", "core.hooksPath", ".git/hooks");
	await run(root, "config", "commit.gpgSign", "false");
	await writeFile(join(root, "tracked.txt"), "one\n");
	if (commit) {
		await run(root, "add", "tracked.txt");
		await run(root, "commit", "-q", "-m", "base");
	}
	return root;
}

/** `commit-msg` runs after the expected-HEAD check and before the swap that updates HEAD. */
async function moveHeadOnCommitMsg(root: string, target: string): Promise<void> {
	const dir = join(root, ".git", "hooks");
	await mkdir(dir, { recursive: true });
	const hook = join(dir, "commit-msg");
	await writeFile(hook, `#!/bin/sh\ngit update-ref refs/heads/main ${target}\n`);
	await chmod(hook, 0o755);
}

describe("commit compare-and-swap", () => {
	test.skipIf(process.platform === "win32")("reports a HEAD move inside the hook window as HeadMoved", async () => {
		const root = await repository(true);
		const repo = git(root)!;
		const base = await run(root, "rev-parse", "HEAD");
		// A concurrent commit with the same tree: no worktree or index change.
		const moved = await run(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "concurrent");
		await moveHeadOnCommitMsg(root, moved);
		await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
		await repo.stageFiles(["tracked.txt"]);

		const error = await repo.commitCreate("raced", { expectedHead: base }).catch((err: unknown) => err);

		expect(isVcsError(error)).toBe(true);
		if (!isVcsError(error)) throw error;
		expect(error.code).toBe("HeadMoved");
		expect(error.message).toContain(base);
		expect(error.message).toContain(moved);
		expect(await run(root, "rev-parse", "HEAD")).toBe(moved);
	});

	test.skipIf(process.platform === "win32")(
		"reports a concurrent first commit as HeadMoved for an unborn HEAD",
		async () => {
			const root = await repository(false);
			const repo = git(root)!;
			await run(root, "add", "tracked.txt");
			const tree = await run(root, "write-tree");
			const concurrent = await run(root, "commit-tree", tree, "-m", "concurrent");
			await moveHeadOnCommitMsg(root, concurrent);

			const error = await repo.commitCreate("first", {}).catch((err: unknown) => err);

			expect(isVcsError(error)).toBe(true);
			if (!isVcsError(error)) throw error;
			expect(error.code).toBe("HeadMoved");
			expect(error.message).toContain("expected unborn HEAD");
			expect(error.message).toContain(concurrent);
			expect(await run(root, "rev-parse", "HEAD")).toBe(concurrent);
		},
	);
});
