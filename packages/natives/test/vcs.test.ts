import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vcsDiscover, vcsGitClone, vcsGitDiscover, vcsGitRepoInfo } from "../native/index.js";
import * as vcs from "../native/vcs.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	// Neutralize any ambient diff driver / textconv (e.g. a user's `diff.external`
	// like difftastic) so raw unified-diff assertions stay stable regardless of the
	// host's global git config. `--no-ext-diff` is the reliable switch here; setting
	// `diff.external=` to empty makes git execute "" as the driver and fail.
	if (args[0] === "diff") args = ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)];
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository() {
	const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	// Assertions compare exact LF bytes; Git for Windows' system
	// `core.autocrlf=true` would check files out as CRLF.
	await git(root, "config", "core.autocrlf", "false");
	await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

describe("in-process VCS bindings", () => {
	test("detects staged, unstaged, and untracked working-tree changes", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;

		expect(await repo.isDirty()).toBe(false);

		await writeFile(join(root, "tracked.txt"), "one\nchanged\n");
		expect(await repo.isDirty()).toBe(true);

		await git(root, "restore", "tracked.txt");
		expect(await repo.isDirty()).toBe(false);

		await writeFile(join(root, "untracked.txt"), "new\n");
		expect(await repo.isDirty()).toBe(true);

		await git(root, "add", "untracked.txt");
		expect(await repo.isDirty()).toBe(true);
	});

	test("discovers, diffs, applies, stages, and commits", async () => {
		const root = await repository();
		const nested = join(root, "nested");
		await mkdir(nested);
		await writeFile(join(nested, "untracked.txt"), "new\n");
		await writeFile(join(root, "tracked.txt"), "one\nchanged\n");

		const repo = vcsGitDiscover(nested);
		expect(repo).not.toBeNull();
		const info = vcsGitRepoInfo(nested);
		expect(info?.repoRoot).toBe(root);
		expect(repo!.info().repoRoot).toBe(root);
		expect(repo!.headSync()).toMatchObject({ kind: "ref", branch: "main" });
		expect(await repo!.statusSummary()).toEqual({ staged: 0, unstaged: 1, untracked: 1 });

		const nativePatch = await repo!.diffText({});
		const cliPatch = await git(root, "diff");
		expect(nativePatch.trimEnd()).toBe(cliPatch);
		expect(nativePatch).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect(nativePatch).toContain("@@");

		await git(root, "restore", "tracked.txt");
		expect(await repo!.canApplyPatch(nativePatch, {})).toBe(true);
		await repo!.applyPatch(nativePatch, {});
		expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("one\nchanged\n");

		await repo!.stageFiles(["tracked.txt"]);
		const sha = await repo!.commitCreate("native commit", {});
		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
	});

	test("throws rich VcsError objects", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const sha = await git(root, "rev-parse", "HEAD");
		try {
			await repo.cherryPick(sha);
			throw new Error("expected cherry-pick to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ name: "VcsError", code: "EmptyCherryPick" });
			expect((error as Error).message).toContain(sha);
		}
	});
	test("applies cached patches to an alternate index", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		await writeFile(join(root, "tracked.txt"), "one\nsynthetic\n");
		const patch = await repo.diffText({});
		const indexPath = join(root, "synthetic.index");
		await repo.readTree("HEAD", indexPath);
		await repo.applyPatch(patch, { cached: true, indexPath });

		const headTree = await git(root, "rev-parse", "HEAD^{tree}");
		expect(await git(root, "write-tree")).toBe(headTree);
		expect(await repo.writeTree(indexPath)).not.toBe(headTree);
		expect(await git(root, "diff", "--cached")).toBe("");
	});

	test.skipIf(process.platform === "win32")("restore recreates symlinks without touching targets", async () => {
		const root = await repository();
		const link = join(root, "link");
		await writeFile(join(root, ".gitattributes"), "link ident\n");
		await symlink("$Id$", link);
		await git(root, "add", "link", ".gitattributes");
		await git(root, "commit", "-m", "add symlink");

		const outsideRoot = await mkdtemp(join(tmpdir(), "pi-natives-vcs-outside-"));
		roots.push(outsideRoot);
		const outside = join(outsideRoot, "outside.txt");
		await writeFile(outside, "outside\n");
		await rm(link);
		await symlink(outside, link);

		await vcsGitDiscover(root)!.restore({ files: ["link"], worktree: true });

		expect(await Bun.file(outside).text()).toBe("outside\n");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readlink(link)).toBe("$Id$");
	});

	test.skipIf(process.platform === "win32")("restore replaces links with files safely", async () => {
		const root = await repository();
		const tracked = join(root, "tracked.txt");
		const outsideRoot = await mkdtemp(join(tmpdir(), "pi-natives-vcs-outside-"));
		roots.push(outsideRoot);
		const outside = join(outsideRoot, "outside.txt");
		await writeFile(outside, "outside\n");
		await rm(tracked);
		await symlink(outside, tracked);

		await vcsGitDiscover(root)!.restore({ files: ["tracked.txt"], worktree: true });

		expect(await Bun.file(outside).text()).toBe("outside\n");
		expect((await lstat(tracked)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(tracked).text()).toBe("one\ntwo\n");
	});

	test.skipIf(process.platform === "win32")("cherry-pick replaces links with files safely", async () => {
		const root = await repository();
		const link = join(root, "link");
		const outsideRoot = await mkdtemp(join(tmpdir(), "pi-natives-vcs-outside-"));
		roots.push(outsideRoot);
		const outside = join(outsideRoot, "outside.txt");
		await writeFile(outside, "outside\n");
		await symlink(outside, link);
		await git(root, "add", "link");
		await git(root, "commit", "-m", "add symlink");

		await git(root, "checkout", "-b", "topic");
		await rm(link);
		await writeFile(link, "regular\n");
		await git(root, "add", "link");
		await git(root, "commit", "-m", "replace symlink with file");
		const topic = await git(root, "rev-parse", "HEAD");
		await git(root, "checkout", "main");

		await vcsGitDiscover(root)!.cherryPick(topic);

		expect(await Bun.file(outside).text()).toBe("outside\n");
		expect((await lstat(link)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(link).text()).toBe("regular\n");
	});

	test.skipIf(process.platform === "win32")(
		"restore preserves private permissions and umask while restoring executable bits",
		async () => {
			const root = await repository();
			const privateTxt = join(root, "private.txt");
			const strayExec = join(root, "stray-exec.txt");
			const privateSh = join(root, "private.sh");
			await writeFile(privateTxt, "secret\n");
			await writeFile(strayExec, "plain\n");
			await writeFile(privateSh, "#!/bin/sh\necho ok\n");
			await chmod(privateTxt, 0o600);
			await chmod(strayExec, 0o600);
			await chmod(privateSh, 0o700);
			await git(root, "add", "private.txt", "stray-exec.txt", "private.sh");
			await git(root, "commit", "-m", "add private files");

			await writeFile(privateTxt, "dirty\n");
			await writeFile(strayExec, "dirty\n");
			await chmod(strayExec, 0o700);
			await writeFile(privateSh, "#!/bin/sh\ndirty\n");
			await chmod(privateSh, 0o600);

			const repo = vcsGitDiscover(root)!;
			await repo.restore({ files: ["private.txt", "stray-exec.txt", "private.sh"], worktree: true });

			expect(await Bun.file(privateTxt).text()).toBe("secret\n");
			expect((await lstat(privateTxt)).mode & 0o777).toBe(0o600);
			expect(await Bun.file(strayExec).text()).toBe("plain\n");
			expect((await lstat(strayExec)).mode & 0o777).toBe(0o600);
			expect(await Bun.file(privateSh).text()).toBe("#!/bin/sh\necho ok\n");
			expect((await lstat(privateSh)).mode & 0o777).toBe(0o700);

			await rm(privateTxt);
			await rm(privateSh);
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { vcsGitDiscover } from "./native/index.js";
					process.umask(0o077);
					await vcsGitDiscover(${JSON.stringify(root)})!.restore({ files: ["private.txt", "private.sh"], worktree: true });`,
				],
				{ cwd: join(import.meta.dir, ".."), stderr: "pipe", stdout: "pipe" },
			);
			const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			expect((await lstat(privateTxt)).mode & 0o777).toBe(0o600);
			expect((await lstat(privateSh)).mode & 0o777).toBe(0o700);
		},
	);

	test.skipIf(process.platform === "win32")(
		"restore honors core.symlinks=false and keeps existing files when link creation fails",
		async () => {
			const root = await repository();
			const plainLink = join(root, "plain-link");
			const safeLink = join(root, "safe-link");
			await writeFile(join(root, ".gitattributes"), "plain-link ident\nsafe-link ident\n");
			await symlink("$Id$", plainLink);
			await symlink("$Id$", safeLink);
			await git(root, "add", ".gitattributes", "plain-link", "safe-link");
			await git(root, "commit", "-m", "add symlinks");

			const repo = vcsGitDiscover(root)!;
			expect(await repo.isDirty()).toBe(false);
			await git(root, "config", "core.symlinks", "false");

			const outsideRoot = await mkdtemp(join(tmpdir(), "pi-natives-vcs-outside-"));
			roots.push(outsideRoot);
			const outside = join(outsideRoot, "outside.txt");
			await writeFile(outside, "outside\n");

			await rm(plainLink);
			await writeFile(plainLink, "edited-target");
			await chmod(plainLink, 0o600);
			await rm(safeLink);
			await symlink(outside, safeLink);

			await repo.restore({ files: ["plain-link", "safe-link"], worktree: true });

			expect(await Bun.file(outside).text()).toBe("outside\n");
			const plainStat = await lstat(plainLink);
			expect(plainStat.isSymbolicLink()).toBe(false);
			expect(plainStat.isFile()).toBe(true);
			expect(plainStat.mode & 0o777).toBe(0o600);
			expect(await Bun.file(plainLink).text()).toBe("$Id$");
			const safeStat = await lstat(safeLink);
			expect(safeStat.isSymbolicLink()).toBe(false);
			expect(safeStat.isFile()).toBe(true);
			expect(await Bun.file(safeLink).text()).toBe("$Id$");

			await git(root, "config", "core.symlinks", "true");
			const hashProc = Bun.spawn(["git", "hash-object", "-w", "--stdin"], {
				cwd: root,
				stdin: new TextEncoder().encode("a".repeat(70_000)),
				stderr: "pipe",
				stdout: "pipe",
			});
			const [badOidRaw, hashErr, hashExit] = await Promise.all([
				new Response(hashProc.stdout).text(),
				new Response(hashProc.stderr).text(),
				hashProc.exited,
			]);
			expect({ hashExit, hashErr }).toEqual({ hashExit: 0, hashErr: "" });
			await git(root, "update-index", "--cacheinfo", `120000,${badOidRaw.trim()},plain-link`);
			await writeFile(plainLink, "keep-on-failure\n");

			await expect(repo.restore({ files: ["plain-link"], worktree: true })).rejects.toMatchObject({
				name: "VcsError",
			});
			expect(await Bun.file(plainLink).text()).toBe("keep-on-failure\n");
		},
	);

	test("aborts clone promptly", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-clone-"));
		roots.push(root);
		const target = join(root, "clone");
		const controller = new AbortController();
		controller.abort();
		const started = performance.now();
		try {
			await vcsGitClone("https://10.255.255.1/never.git", target, { timeoutMs: 60_000 }, controller.signal);
			throw new Error("expected clone to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError" });
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			expect(["Canceled", "Cli", "CliTimeout"]).toContain(String(code));
			expect(performance.now() - started).toBeLessThan(2_000);
		}
	});

	test("cancels a task-backed repository operation without replacing an aborted signal handler", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const controller = new AbortController();
		const onAbort = () => {};
		controller.signal.onabort = onAbort;
		controller.abort();

		await expect(repo.head(controller.signal)).rejects.toMatchObject({ name: "VcsError", code: "Canceled" });
		expect(controller.signal.onabort).toBe(onAbort);
	});

	test("keeps the VcsError shape when an AbortSignal fires before task settlement", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		const controller = new AbortController();
		const pending = repo.head(controller.signal);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "VcsError", code: "Canceled" });
	});
});

describe("VcsRepo", () => {
	test("dispatches portable Git operations", async () => {
		const root = await repository();
		await writeFile(join(root, "tracked.txt"), "one\nunstaged\n");
		await writeFile(join(root, "staged.txt"), "staged\n");
		await git(root, "add", "staged.txt");

		const repo = vcsDiscover(root);
		expect(repo?.kind()).toBe("git");
		expect(repo?.root()).toBe(root);
		expect(repo?.supports("stagedDiff")).toBe(true);
		expect(repo?.asGit()).not.toBeNull();
		expect(repo?.asJj()).toBeNull();
		expect((await repo?.uncommittedDiff([]))?.trimEnd()).toBe(await git(root, "diff", "HEAD"));

		const required = vcs.require(root, "stagedDiff");
		expect(required.kind()).toBe("git");
		expect(required.supports("revDiff")).toBe(true);
	});

	test("discovers Jujutsu and rejects unsupported features", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-natives-vcs-jj-"));
		roots.push(root);
		await mkdir(join(root, ".jj", "repo"), { recursive: true });

		const repo = vcsDiscover(root);
		expect(repo?.kind()).toBe("jj");
		expect(repo?.supports("stagedDiff")).toBe(false);
		expect(repo?.asGit()).toBeNull();
		expect(repo?.asJj()).not.toBeNull();

		try {
			vcs.require(root, "stagedDiff");
			throw new Error("expected capability assertion to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError", code: "Unsupported" });
		}

		try {
			repo?.supports("unknown");
			throw new Error("expected unknown feature to reject");
		} catch (error) {
			expect(error).toMatchObject({ name: "VcsError", code: "Backend" });
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw error;
			expect(error.message).toContain("valid: stagedDiff, revDiff");
		}
	});
});
