import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function git(cwd: string, args: string[], indexFile?: string): Promise<string> {
	const env = {
		...process.env,
		HOME: cwd,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
	};
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return out;
}

/** Run a repair command in a shell, so word splitting and globs are real. */
async function shell(cwd: string, command: string): Promise<string> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["sh", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`sh -c ${command} failed (${code}): ${err}`);
	return out;
}

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed an old bug\n";

/** Repository without commits, and a writer that edits files the way agent edit tools do: journaled. */
async function emptyRepo() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-"));
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-artifacts-"));
	tempDirs.push(root, artifacts);
	await git(root, ["init", "-q", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "commit.gpgSign", "false"]);
	const journal = ChangeJournal.at(artifacts);
	const write = async (agent: string, parent: string | undefined, file: string, after: string) => {
		const absolute = path.join(root, file);
		const before = await Bun.file(absolute)
			.text()
			.catch(() => null);
		await Bun.write(absolute, after);
		journal.recordChange({ agent, parent, tool: "edit", path: absolute, before, after });
	};
	return { root, journal, write };
}

/**
 * Shared workspace: the user staged a fix in `b.ts` and added a changelog bullet; agent Main
 * edited `a.ts` and added its own bullet; its subagent ParserFix created `parser.ts`.
 */
async function sharedWorkspace() {
	const { root, journal, write } = await emptyRepo();
	await Bun.write(path.join(root, "CHANGELOG.md"), CHANGELOG);
	await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(root, "b.ts"), "export const b = 1;\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-q", "-m", "seed"]);
	const head = (await git(root, ["rev-parse", "HEAD"])).trim();

	// The user's work, unrecorded: a staged fix and a changelog bullet.
	await Bun.write(path.join(root, "b.ts"), "export const b = 2;\n");
	await git(root, ["add", "b.ts"]);
	const userChangelog = CHANGELOG.replace("### Fixed\n\n", "### Fixed\n\n- Fixed the theme flicker\n");
	await Bun.write(path.join(root, "CHANGELOG.md"), userChangelog);

	await write("Main", undefined, "a.ts", "export const a = 2;\n");
	await write(
		"Main",
		undefined,
		"CHANGELOG.md",
		userChangelog.replace("### Fixed\n\n", "### Fixed\n\n- Fixed /commit\n"),
	);
	await write("ParserFix", "Main", "parser.ts", "export function parse() {}\n");
	await journal.flush();
	return { root, journal, head };
}

describe("selective commit flow", () => {
	it("commits the agent tree's lines and leaves the user's staged and unstaged work alone", async () => {
		const { root, journal, head } = await sharedWorkspace();
		const worktreeBefore = await git(root, ["diff", "HEAD"]);

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(
			draft,
			{ subject: "fix(parser): added parse", body: ["- Added the parser."], fixes: 7 },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.parent).toBe(head);
		expect(outcome.paths.sort()).toEqual(["CHANGELOG.md", "a.ts", "parser.ts"]);
		expect(await git(root, ["show", "HEAD:CHANGELOG.md"])).toBe(
			CHANGELOG.replace("### Fixed\n\n", "### Fixed\n\n- Fixed /commit\n"),
		);
		expect(await git(root, ["show", "HEAD:b.ts"])).toBe("export const b = 1;\n");
		expect(await git(root, ["log", "-1", "--format=%B"])).toBe(
			"fix(parser): added parse\n\n- Added the parser.\n\nFixes #7\n\n",
		);
		// The user's staged fix is still exactly what is staged; committed paths show no staged reversal.
		expect((await git(root, ["diff", "--cached", "--name-only"])).trim()).toBe("b.ts");
		// The worktree is untouched: HEAD moved, so only the user's lines remain as changes.
		expect(await git(root, ["diff", "--name-only"])).toBe("CHANGELOG.md\n");
		expect(worktreeBefore).toContain("Fixed the theme flicker");
		expect(await Bun.file(path.join(root, "CHANGELOG.md")).text()).toContain("- Fixed the theme flicker");
	});

	it("syncs the shared index once another git process lets go of its lock", async () => {
		const { root, journal } = await sharedWorkspace();
		// A `git status` elsewhere holds `index.lock` while the commit is made. The lock is a real
		// file the native index writer refuses to take, so only a real delay releases it mid-commit.
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		const released = Bun.sleep(250).then(() => fs.rm(lock));

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(draft, { subject: "fix: locked" }, { journal, agent: { agent: "Main" } });
		await released;

		expect(outcome.indexNotes).toEqual([]);
		expect((await git(root, ["diff", "--cached", "--name-only"])).trim()).toBe("b.ts");
	});

	it("seeds a root commit's shared index once another git process lets go of its lock", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		// The retry asks to sleep before the next attempt. Release the lock there so the
		// next attempt is what writes the index, with no dependence on the clock.
		const delays: number[] = [];
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			if (typeof ms !== "number") throw new Error(`expected milliseconds, got ${String(ms)}`);
			delays.push(ms);
			await fs.rm(lock, { force: true });
		});

		const outcome = await commitSelection(draft, { subject: "feat: first" }, { journal, agent: { agent: "Main" } });

		expect(delays).toEqual([40]);
		expect(outcome.parent).toBeNull();
		expect(outcome.indexNotes).toEqual([]);
		expect(outcome.paths).toEqual(["first.txt"]);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(outcome.sha);
		expect(await git(root, ["status", "--porcelain"])).toBe("");
		expect(await Bun.file(path.join(root, "first.txt")).text()).toBe("first\n");
		expect((await fs.readdir(path.join(root, ".git"))).filter(name => name.includes("omp-seed"))).toEqual([]);
		const records = await journal.read();
		expect(records).toContainEqual(
			expect.objectContaining({ type: "commit", sha: outcome.sha, paths: ["first.txt"] }),
		);
	});

	it("keeps files another command staged when that command creates the index during the wait", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "ours.txt", "ours\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		await Bun.write(path.join(root, "theirs.txt"), "theirs\n");
		const foreign = path.join(root, ".git", "theirs.index");
		const delays: number[] = [];
		let published = false;
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			if (typeof ms !== "number") throw new Error(`expected milliseconds, got ${String(ms)}`);
			delays.push(ms);
			if (published) return;
			published = true;
			await git(root, ["add", "--", "theirs.txt"], foreign);
			await fs.rename(foreign, index);
			await fs.rm(lock, { force: true });
		});

		const outcome = await commitSelection(draft, { subject: "feat: ours" }, { journal, agent: { agent: "Main" } });

		expect(delays).toEqual([40]);
		expect(outcome.parent).toBeNull();
		expect(outcome.indexNotes).toEqual([]);
		expect(outcome.paths).toEqual(["ours.txt"]);
		expect(await git(root, ["ls-files"])).toBe("ours.txt\ntheirs.txt\n");
		expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("theirs.txt\n");
	});

	it("holds index.lock from the missing-index check through writing the root index", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "ours.txt", "ours\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		await Bun.write(path.join(root, "theirs.txt"), "theirs\n");
		const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		let blocked = 0;
		let stagedDuringSeed = false;
		const tryStageTheirs = async () => {
			const proc = Bun.spawn(["git", "-C", root, "add", "--", "theirs.txt"], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
			if (code === 0) {
				stagedDuringSeed = true;
				return;
			}
			expect(err).toContain("index.lock");
			blocked++;
		};
		const indexFile = Bun.file(index);
		const realExists = indexFile.exists.bind(indexFile);
		vi.spyOn(indexFile, "exists").mockImplementation(async () => {
			const present = await realExists();
			if (!present) await tryStageTheirs();
			return present;
		});
		const realFile = Bun.file.bind(Bun);
		vi.spyOn(Bun, "file").mockImplementation((source, options) => {
			if (source === index) return indexFile;
			return realFile(source as string, options);
		});
		const realReadTree = VcsGitRepo.prototype.readTree;
		vi.spyOn(VcsGitRepo.prototype, "readTree").mockImplementation(async function (
			this: VcsGitRepo,
			treeish: string,
			indexPath?: string | null,
			readSignal?: unknown,
		) {
			await tryStageTheirs();
			return realReadTree.call(this, treeish, indexPath, readSignal);
		});

		const outcome = await commitSelection(draft, { subject: "feat: ours" }, { journal, agent: { agent: "Main" } });
		if (!stagedDuringSeed) await git(root, ["add", "--", "theirs.txt"]);

		expect(await git(root, ["ls-files"])).toBe("ours.txt\ntheirs.txt\n");
		expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("theirs.txt\n");
		expect(stagedDuringSeed).toBe(false);
		expect(blocked).toBe(2);
		expect(outcome.parent).toBeNull();
		expect(outcome.indexNotes).toEqual([]);
		expect(outcome.paths).toEqual(["ours.txt"]);
	});

	it("returns the root commit when the shared index stays locked", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await write("Main", undefined, "second.txt", "second\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		const delays: number[] = [];
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			if (typeof ms !== "number") throw new Error(`expected milliseconds, got ${String(ms)}`);
			delays.push(ms);
		});

		const outcome = await commitSelection(draft, { subject: "feat: first" }, { journal, agent: { agent: "Main" } });

		expect(delays).toEqual([40, 80, 160, 320]);
		expect(outcome.parent).toBeNull();
		expect(outcome.paths).toEqual(["first.txt", "second.txt"]);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(outcome.sha);
		expect(await git(root, ["ls-tree", "--name-only", "HEAD"])).toBe("first.txt\nsecond.txt\n");
		expect(await Bun.file(index).exists()).toBe(false);
		const records = await journal.read();
		expect(records).toContainEqual(
			expect.objectContaining({ type: "commit", sha: outcome.sha, paths: ["first.txt", "second.txt"] }),
		);
		await fs.rm(lock);
		expect(await git(root, ["status", "--porcelain"])).toBe(
			"D  first.txt\nD  second.txt\n?? first.txt\n?? second.txt\n",
		);
		expect((await git(root, ["diff", "--cached", "--name-only"])).trim().split("\n").sort()).toEqual([
			"first.txt",
			"second.txt",
		]);
		expect(outcome.indexNotes).toHaveLength(2);
		const failure = outcome.indexNotes[0]?.match(/could not be written \((.*)\); /)?.[1];
		expect(failure).toContain("index.lock");
		expect(outcome.indexNotes).toEqual([
			`first.txt: the shared index could not be written (${failure}); \`git diff --cached\` there shows this commit reverted until \`git --literal-pathspecs reset -q -- 'first.txt'\`.`,
			`second.txt: the shared index could not be written (${failure}); \`git diff --cached\` there shows this commit reverted until \`git --literal-pathspecs reset -q -- 'second.txt'\`.`,
		]);
		for (const note of outcome.indexNotes) {
			const command = note.match(/until `([^`]+)`\.$/)?.[1];
			if (command === undefined) throw new Error(`note has no repair command: ${note}`);
			await shell(root, command);
		}
		expect(await git(root, ["status", "--porcelain"])).toBe("");
		expect(await git(root, ["diff", "HEAD"])).toBe("");
	});

	it("repairs a spaced wildcard filename through a shell without unstaging another file", async () => {
		const { root, journal, write } = await emptyRepo();
		const target = "first file*.txt";
		const decoy = "first fileY.txt";
		await write("Main", undefined, target, "target\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			if (typeof ms !== "number") throw new Error(`expected milliseconds, got ${String(ms)}`);
		});

		const outcome = await commitSelection(draft, { subject: "feat: spaced" }, { journal, agent: { agent: "Main" } });

		expect(outcome.paths).toEqual([target]);
		expect(outcome.indexNotes).toHaveLength(1);
		const command = outcome.indexNotes[0]?.match(/until `([^`]+)`\.$/)?.[1];
		if (command === undefined) throw new Error(`note has no repair command: ${outcome.indexNotes[0]}`);
		await fs.rm(lock);
		await Bun.write(path.join(root, decoy), "decoy\n");
		await git(root, ["add", "--", decoy]);
		await shell(root, command);
		expect(await git(root, ["--literal-pathspecs", "ls-files", "--", target])).toBe(`${target}\n`);
		expect(await git(root, ["--literal-pathspecs", "diff", "--cached", "--name-only", "--", target])).toBe("");
		expect(await git(root, ["--literal-pathspecs", "diff", "--cached", "--name-only", "--", decoy])).toBe(
			`${decoy}\n`,
		);
	});

	it("stops seeding a root commit's shared index when the caller aborts", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		const lock = path.join(root, ".git", "index.lock");
		await Bun.write(lock, "");
		const controller = new AbortController();
		const realReadTree = VcsGitRepo.prototype.readTree;
		let seeds = 0;
		vi.spyOn(VcsGitRepo.prototype, "readTree").mockImplementation(function (
			this: VcsGitRepo,
			treeish: string,
			indexPath?: string | null,
			readSignal?: unknown,
		) {
			seeds++;
			return realReadTree.call(this, treeish, indexPath, readSignal);
		});
		let pauses = 0;
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			pauses++;
			await fs.rm(lock, { force: true });
			controller.abort();
		});

		await expect(
			commitSelection(
				draft,
				{ subject: "feat: first" },
				{ journal, agent: { agent: "Main" }, signal: controller.signal },
			),
		).rejects.toThrow(/aborted/i);
		expect(pauses).toBe(1);
		expect(seeds).toBe(0);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toMatch(/^[0-9a-f]{40}$/);
		expect(await git(root, ["ls-tree", "--name-only", "HEAD"])).toBe("first.txt\n");
		expect(await Bun.file(index).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "first.txt")).text()).toBe("first\n");
	});

	it("does not record a commit note when seeding the root index is aborted", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const index = path.join(root, ".git", "index");
		await fs.rm(index, { force: true });
		const lock = path.join(root, ".git", "index.lock");
		const controller = new AbortController();
		const realReadTree = VcsGitRepo.prototype.readTree;
		let seeds = 0;
		vi.spyOn(VcsGitRepo.prototype, "readTree").mockImplementation(function (
			this: VcsGitRepo,
			treeish: string,
			indexPath?: string | null,
			readSignal?: unknown,
		) {
			seeds++;
			controller.abort();
			return realReadTree.call(this, treeish, indexPath, readSignal);
		});
		const pauses: number[] = [];
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			if (typeof ms !== "number") throw new Error(`expected milliseconds, got ${String(ms)}`);
			pauses.push(ms);
		});

		await expect(
			commitSelection(
				draft,
				{ subject: "feat: first" },
				{ journal, agent: { agent: "Main" }, signal: controller.signal },
			),
		).rejects.toThrow(/aborted/i);
		expect(seeds).toBe(1);
		expect(pauses).toEqual([]);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toMatch(/^[0-9a-f]{40}$/);
		expect(await git(root, ["ls-tree", "--name-only", "HEAD"])).toBe("first.txt\n");
		expect(await Bun.file(index).exists()).toBe(false);
		expect(await Bun.file(lock).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "first.txt")).text()).toBe("first\n");
	});

	it("commits only one subagent's changes when scoped to it", async () => {
		const { root, journal } = await sharedWorkspace();

		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "ParserFix" });
		const outcome = await commitSelection(
			draft,
			{ subject: "feat: added parser" },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.paths).toEqual(["parser.ts"]);
		expect((await git(root, ["show", "--name-only", "--format=", "HEAD"])).trim()).toBe("parser.ts");
	});

	it("commits modes, executable deletions, symlinks, BOMs, and non-UTF-8 files exactly as in the worktree", async () => {
		const { root, journal, write } = await emptyRepo();
		const latin1 = (text: string) => Buffer.from(text, "latin1");
		await Bun.write(path.join(root, "run.sh"), "#!/bin/sh\necho run\n");
		await Bun.write(path.join(root, "tool.sh"), "#!/bin/sh\necho tool\n");
		await Bun.write(path.join(root, "plain.txt"), "plain\n");
		await Bun.write(path.join(root, "latin1.txt"), latin1("caf\xe9\n"));
		await Bun.write(path.join(root, "bom.ass"), "placeholder\n");
		await fs.chmod(path.join(root, "run.sh"), 0o755);
		await fs.chmod(path.join(root, "tool.sh"), 0o755);
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);

		await fs.chmod(path.join(root, "run.sh"), 0o644);
		await fs.rm(path.join(root, "tool.sh"));
		await write("Main", undefined, "plain.txt", "plain\nmore\n");
		await fs.chmod(path.join(root, "plain.txt"), 0o755);
		await Bun.write(path.join(root, "latin1.txt"), latin1("caf\xe9\nna\xefve\n"));
		await Bun.write(path.join(root, "bom.ass"), "\uFEFF[Script Info]\r\nTitle: d\r\n");
		await fs.symlink("plain.txt", path.join(root, "link"));
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "**" });
		await commitSelection(draft, { subject: "chore: committed everything" }, { journal, agent: { agent: "Main" } });

		// Index and worktree both match the commit, byte for byte and mode for mode.
		expect(await git(root, ["status", "--porcelain"])).toBe("");
		const modes = Object.fromEntries(
			(await git(root, ["ls-tree", "HEAD"]))
				.trim()
				.split("\n")
				.map(line => {
					const [meta, file] = line.split("\t");
					return [file, meta.split(" ")[0]];
				}),
		);
		expect(modes).toEqual({
			"bom.ass": "100644",
			"latin1.txt": "100644",
			link: "120000",
			"plain.txt": "100755",
			"run.sh": "100644",
		});
	});

	it("makes the first commit of a repository without commits", async () => {
		const { root, journal, write } = await emptyRepo();
		await write("Main", undefined, "first.txt", "first\n");
		await write("Main", undefined, "second.txt", "second\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("✓ first.txt  +1  [Main]");
		draft.only(["first.txt"]);
		const outcome = await commitSelection(draft, { subject: "feat: first" }, { journal, agent: { agent: "Main" } });

		expect(outcome.parent).toBeNull();
		expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
		expect(await git(root, ["ls-tree", "--name-only", "HEAD"])).toBe("first.txt\n");
		expect(await git(root, ["status", "--porcelain"])).toBe("?? second.txt\n");
	});

	it("attributes edits journaled through a symlinked directory", async () => {
		const { root, journal } = await emptyRepo();
		const alias = `${root}-alias`;
		tempDirs.push(alias);
		await fs.symlink(root, alias);
		const file = path.join(alias, "notes.md");
		await Bun.write(file, "hello\n");
		journal.recordChange({ agent: "Main", tool: "write", path: file, before: null, after: "hello\n" });
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("✓ notes.md  +1  [Main]");
	});

	it("refuses to commit on a HEAD that moved onto the same lines", async () => {
		const { root, journal } = await sharedWorkspace();
		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		// Someone else commits a conflicting a.ts meanwhile.
		await git(root, ["commit", "-q", "-m", "other", "--only", "b.ts"]);
		await Bun.write(path.join(root, "a.ts"), "export const a = 3;\n");
		await git(root, ["commit", "-q", "-m", "conflict", "--only", "a.ts"]);

		await expect(
			commitSelection(draft, { subject: "fix: a" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved .* changed a\.ts/);
	});

	it("rejects an unknown hunk unit id without changing the selection", async () => {
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
		await Bun.write(path.join(root, "b.ts"), "export const b = 1;\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		await write("Main", undefined, "a.ts", "export const a = 2;\nexport const extra = 3;\n");
		await write(
			"Other",
			undefined,
			"a.ts",
			"export const a = 2;\nexport const extra = 3;\nexport const foreign = 4;\n",
		);
		await write("Main", undefined, "b.ts", "export const b = 2;\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const selected = draft.diff();
		expect(selected).toContain("export const a = 2");
		expect(selected).not.toContain("foreign");

		expect(() => draft.take({ path: "a.ts", units: ["1z"] })).toThrow(/a\.ts has no unit "1z"/);
		expect(() => draft.drop({ path: "a.ts", units: ["1z"] })).toThrow(/a\.ts has no unit "1z"/);
		// b.ts has hunk 1 but no unit 1b; the call must fail before a.ts's 1b is selected.
		expect(() => draft.take({ path: "*.ts", units: ["1b"] })).toThrow(/has no unit "1b"/);
		expect(() => draft.take({ path: "a.ts", units: ["1b", "1z"] })).toThrow(/a\.ts has no unit "1z"/);
		expect(draft.diff()).toBe(selected);

		expect(draft.take({ path: "a.ts", units: ["1b"] })).toBe("Selected 1 change line(s).");
		expect(draft.diff()).toContain("+export const foreign = 4;");
		expect(draft.drop({ path: "a.ts", units: ["1a"] })).toBe("Deselected 3 change line(s).");
		expect(draft.diff()).not.toContain("export const extra = 3");

		const byHunk = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(byHunk.take({ path: "a.ts", units: ["1"] })).toBe("Selected 1 change line(s).");
		expect(byHunk.diff()).toContain("+export const foreign = 4;");
		expect(byHunk.diff()).toContain("export const a = 2");
	});

	it.skipIf(process.platform === "win32")("commits a filename that requires a quoted diff header", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-quoted-"));
		const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-artifacts-"));
		tempDirs.push(root, artifacts);
		await git(root, ["init", "-q", "-b", "main"]);
		await git(root, ["config", "user.email", "test@example.com"]);
		await git(root, ["config", "user.name", "Test"]);
		await git(root, ["config", "commit.gpgSign", "false"]);
		const filename = 'has"quote.txt';
		const file = path.join(root, filename);
		await Bun.write(file, "before\n");
		await git(root, ["add", "--", filename]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		await Bun.write(file, "after\n");
		const journal = ChangeJournal.at(artifacts);
		journal.recordChange({
			agent: "Main",
			tool: "edit",
			path: file,
			before: "before\n",
			after: "after\n",
		});
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const outcome = await commitSelection(
			draft,
			{ subject: "fix: quoted filename" },
			{ journal, agent: { agent: "Main" } },
		);

		expect(outcome.paths).toEqual([filename]);
		expect(await git(root, ["show", `HEAD:${filename}`])).toBe("after\n");
	});
});
