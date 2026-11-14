import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function git(cwd: string, args: string[]): Promise<string> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return out;
}

async function gitBytes(cwd: string, args: string[]): Promise<Uint8Array> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [bytes, err, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return new Uint8Array(bytes);
}

/** Empty repo with a seed commit, so a draft has a HEAD to freeze against. */
async function trackedRepo() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-"));
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-artifacts-"));
	tempDirs.push(root, artifacts);
	await git(root, ["init", "-q", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "commit.gpgSign", "false"]);
	await git(root, ["config", "core.autocrlf", "false"]);
	await git(root, ["config", "core.safecrlf", "false"]);
	await Bun.write(path.join(root, "README.md"), "seed\n");
	await git(root, ["add", "README.md"]);
	await git(root, ["commit", "-qm", "seed"]);
	return { root, artifacts, journal: ChangeJournal.at(artifacts) };
}

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed an old bug\n";

/**
 * Shared workspace: the user staged a fix in `b.ts` and added a changelog bullet; agent Main
 * edited `a.ts` and added its own bullet; its subagent ParserFix created `parser.ts`.
 */
async function sharedWorkspace() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-"));
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-artifacts-"));
	tempDirs.push(root, artifacts);
	await git(root, ["init", "-q", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "commit.gpgSign", "false"]);
	await Bun.write(path.join(root, "CHANGELOG.md"), CHANGELOG);
	await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(root, "b.ts"), "export const b = 1;\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-q", "-m", "seed"]);
	const head = (await git(root, ["rev-parse", "HEAD"])).trim();

	const journal = ChangeJournal.at(artifacts);
	const write = async (agent: string, parent: string | undefined, file: string, after: string) => {
		const absolute = path.join(root, file);
		const before = await Bun.file(absolute)
			.text()
			.catch(() => null);
		await Bun.write(absolute, after);
		journal.recordChange({ agent, parent, tool: "edit", path: absolute, before, after });
	};

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

	it("commits whole-file changes as the draft captured them, not later worktree edits", async () => {
		const { root, journal } = await sharedWorkspace();
		const seedBytes = new Uint8Array([0, 159, 146, 150, 255, 0, 11]);
		const agentBytes = new Uint8Array([0, 159, 146, 150, 255, 0, 11, 42]);
		const addedBytes = new Uint8Array([7, 0, 255, 254, 1]);
		const goneBytes = new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6, 0]);
		await Bun.write(path.join(root, "tracked.bin"), seedBytes);
		await Bun.write(path.join(root, "deleted.bin"), goneBytes);
		await git(root, ["add", "tracked.bin", "deleted.bin"]);
		await git(root, ["commit", "-qm", "add binaries"]);

		// Main's writes: modify the tracked binary, add an untracked one, delete another.
		const record = (file: string, before: string | null, after: string | null) =>
			journal.recordChange({
				agent: "Main",
				parent: undefined,
				tool: "edit",
				path: path.join(root, file),
				before,
				after,
			});
		await Bun.write(path.join(root, "tracked.bin"), agentBytes);
		record("tracked.bin", "old", "new");
		await Bun.write(path.join(root, "added.bin"), addedBytes);
		record("added.bin", null, "new");
		await fs.rm(path.join(root, "deleted.bin"));
		record("deleted.bin", "old", null);
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.only(["*.bin"]);
		draft.take({ path: "*.bin" });

		// Another process rewrites all three paths before the commit lands.
		const lateBytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
		await Bun.write(path.join(root, "tracked.bin"), lateBytes);
		await Bun.write(path.join(root, "added.bin"), new Uint8Array([1, 2, 3]));
		await Bun.write(path.join(root, "deleted.bin"), new Uint8Array([9, 9, 9, 9]));

		const outcome = await commitSelection(
			draft,
			{ subject: "chore: binaries" },
			{ journal, agent: { agent: "Main" } },
		);
		expect(outcome.paths.sort()).toEqual(["added.bin", "deleted.bin", "tracked.bin"]);

		const showBytes = async (file: string) => {
			const proc = Bun.spawn(["git", "-C", root, "show", `HEAD:${file}`], { stdout: "pipe", stderr: "pipe" });
			const [bytes, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
			if (code !== 0) throw new Error(`git show HEAD:${file} failed (${code})`);
			return new Uint8Array(bytes);
		};
		expect(await showBytes("tracked.bin")).toEqual(agentBytes);
		expect(await showBytes("added.bin")).toEqual(addedBytes);
		expect(await git(root, ["ls-tree", "--name-only", "HEAD", "--", "deleted.bin"])).toBe("");
		// The worktree keeps the later bytes; only the commit froze the draft's.
		expect(new Uint8Array(await Bun.file(path.join(root, "tracked.bin")).arrayBuffer())).toEqual(lateBytes);
	});

	it("commits non-UTF-8 whole files as captured, even when Git would diff them as text", async () => {
		const { root, journal } = await trackedRepo();
		// No NUL byte: Git's binary sniff treats this as text, and a text patch
		// would replace these bytes with U+FFFD or refuse to apply.
		const seed = new Uint8Array([0xff, 0xfe, 0x80, 0x41, 0xc3, 0x28, 0x0a]);
		const agent = new Uint8Array([0xff, 0xfe, 0x80, 0x41, 0xc3, 0x28, 0x42, 0x0a]);
		const added = new Uint8Array([0xfe, 0xff, 0x80, 0x7f, 0xc0, 0x41]);
		await Bun.write(path.join(root, "latin.bin"), seed);
		await git(root, ["add", "latin.bin"]);
		await git(root, ["commit", "-qm", "add latin"]);
		await Bun.write(path.join(root, "latin.bin"), agent);
		await Bun.write(path.join(root, "added.bin"), added);
		journal.recordChange({
			agent: "Main",
			parent: undefined,
			tool: "edit",
			path: path.join(root, "latin.bin"),
			before: "old",
			after: "new",
		});
		journal.recordChange({
			agent: "Main",
			parent: undefined,
			tool: "edit",
			path: path.join(root, "added.bin"),
			before: null,
			after: "new",
		});
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.take({ path: "*.bin" });
		const outcome = await commitSelection(draft, { subject: "chore: latin" }, { journal, agent: { agent: "Main" } });
		expect(outcome.paths.sort()).toEqual(["added.bin", "latin.bin"]);
		expect(await gitBytes(root, ["cat-file", "blob", "HEAD:latin.bin"])).toEqual(agent);
		expect(await gitBytes(root, ["cat-file", "blob", "HEAD:added.bin"])).toEqual(added);
	});

	it("commits whole-file bytes after clean filters, not the raw worktree bytes", async () => {
		const { root, artifacts, journal } = await trackedRepo();
		const script = path.join(artifacts, "clean-filter.js");
		await Bun.write(
			script,
			[
				"#!/usr/bin/env bun",
				"const input = Buffer.from(await Bun.stdin.bytes());",
				"const from = Buffer.from('WORKTREE');",
				"const to = Buffer.from('STORED');",
				"const parts = [];",
				"let i = 0;",
				"while (i < input.length) {",
				"  const at = input.indexOf(from, i);",
				"  if (at < 0) { parts.push(input.subarray(i)); break; }",
				"  parts.push(input.subarray(i, at), to);",
				"  i = at + from.length;",
				"}",
				"await Bun.write(Bun.stdout, Buffer.concat(parts));",
				"",
			].join("\n"),
		);
		await fs.chmod(script, 0o755);
		await git(root, ["config", "filter.pointer.clean", script]);
		await git(root, ["config", "filter.pointer.required", "true"]);
		await Bun.write(path.join(root, ".gitattributes"), "*.lfs filter=pointer\n*.crlf text eol=lf\n");
		await git(root, ["add", ".gitattributes"]);
		await git(root, ["commit", "-qm", "attributes"]);

		const rawLfs = new Uint8Array([0, ...Buffer.from("prefix WORKTREE suffix")]);
		const rawCrlf = new Uint8Array([0, 0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a]);
		await Bun.write(path.join(root, "asset.lfs"), rawLfs);
		await Bun.write(path.join(root, "line.crlf"), rawCrlf);
		for (const file of ["asset.lfs", "line.crlf"]) {
			journal.recordChange({
				agent: "Main",
				parent: undefined,
				tool: "edit",
				path: path.join(root, file),
				before: null,
				after: "new",
			});
		}
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.take({ path: "asset.lfs" });
		draft.take({ path: "line.crlf" });
		await commitSelection(draft, { subject: "chore: filtered" }, { journal, agent: { agent: "Main" } });

		const storedLfs = Buffer.from(await gitBytes(root, ["cat-file", "blob", "HEAD:asset.lfs"]));
		expect(storedLfs.includes(Buffer.from("STORED"))).toBe(true);
		expect(storedLfs.includes(Buffer.from("WORKTREE"))).toBe(false);
		expect(await gitBytes(root, ["cat-file", "blob", "HEAD:line.crlf"])).toEqual(
			new Uint8Array([0, 0x41, 0x0a, 0x42, 0x0a]),
		);
	});

	it("refuses a whole-file commit when HEAD moved onto that binary", async () => {
		const { root, journal } = await trackedRepo();
		const seed = new Uint8Array([0, 1, 2, 3, 4]);
		const agent = new Uint8Array([0, 1, 2, 3, 4, 9]);
		const newer = new Uint8Array([0, 9, 9, 9, 9, 9]);
		await Bun.write(path.join(root, "tracked.bin"), seed);
		await git(root, ["add", "tracked.bin"]);
		await git(root, ["commit", "-qm", "add binary"]);
		await Bun.write(path.join(root, "tracked.bin"), agent);
		journal.recordChange({
			agent: "Main",
			parent: undefined,
			tool: "edit",
			path: path.join(root, "tracked.bin"),
			before: "old",
			after: "new",
		});
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.take({ path: "tracked.bin" });

		await Bun.write(path.join(root, "tracked.bin"), newer);
		await git(root, ["add", "tracked.bin"]);
		await git(root, ["commit", "-qm", "newer", "--only", "tracked.bin"]);

		await expect(
			commitSelection(draft, { subject: "chore: binary" }, { journal, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved .* changed tracked\.bin/);
		expect(await gitBytes(root, ["cat-file", "blob", "HEAD:tracked.bin"])).toEqual(newer);
	});

	it("leaves someone else's staged binary in the shared index", async () => {
		const { root, journal } = await trackedRepo();
		const seed = new Uint8Array([0, 1, 2, 3, 4]);
		const agent = new Uint8Array([0, 1, 2, 3, 4, 9]);
		const staged = new Uint8Array([0, 7, 7, 7, 7, 7]);
		await Bun.write(path.join(root, "tracked.bin"), seed);
		await git(root, ["add", "tracked.bin"]);
		await git(root, ["commit", "-qm", "add binary"]);
		await Bun.write(path.join(root, "tracked.bin"), agent);
		journal.recordChange({
			agent: "Main",
			parent: undefined,
			tool: "edit",
			path: path.join(root, "tracked.bin"),
			before: "old",
			after: "new",
		});
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.take({ path: "tracked.bin" });

		await Bun.write(path.join(root, "tracked.bin"), staged);
		await git(root, ["add", "tracked.bin"]);

		const outcome = await commitSelection(draft, { subject: "chore: binary" }, { journal, agent: { agent: "Main" } });
		expect(outcome.indexNotes.join("\n")).toContain("tracked.bin");
		expect(await gitBytes(root, ["cat-file", "blob", "HEAD:tracked.bin"])).toEqual(agent);
		expect(await gitBytes(root, ["cat-file", "blob", ":tracked.bin"])).toEqual(staged);
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

	it("commits a new whole file whose name contains a space under that name", async () => {
		const { root, journal } = await trackedRepo();
		const name = "my file.bin";
		const bytes = new Uint8Array([0, 1, 2, 3, 4]);
		await Bun.write(path.join(root, name), bytes);
		journal.recordChange({
			agent: "Main",
			parent: undefined,
			tool: "edit",
			path: path.join(root, name),
			before: null,
			after: "new",
		});
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.take({ path: name });
		const outcome = await commitSelection(draft, { subject: "chore: spaced" }, { journal, agent: { agent: "Main" } });
		expect(outcome.paths).toEqual([name]);
		expect(await gitBytes(root, ["cat-file", "blob", `HEAD:${name}`])).toEqual(bytes);
		expect(await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(`${name}\n`);
	});

	it("commits an existing whole file whose name contains a space", async () => {
		const { root, journal } = await trackedRepo();
		const name = "my file.bin";
		const seed = new Uint8Array([0, 1, 2, 3]);
		const agent = new Uint8Array([0, 1, 2, 9]);
		await Bun.write(path.join(root, name), seed);
		await git(root, ["add", name]);
		await git(root, ["commit", "-qm", "add spaced"]);
		await Bun.write(path.join(root, name), agent);
		journal.recordChange({
			agent: "Main",
			parent: undefined,
			tool: "edit",
			path: path.join(root, name),
			before: "old",
			after: "new",
		});
		await journal.flush();
		const draft = await createDraft({ cwd: root, journal, caller: "Main", agents: "self" });
		draft.take({ path: name });
		await commitSelection(draft, { subject: "chore: spaced" }, { journal, agent: { agent: "Main" } });
		expect(await gitBytes(root, ["cat-file", "blob", `HEAD:${name}`])).toEqual(agent);
	});

	it("reapplies an already-present binary edit when three-way is on, and rejects a conflicting one", async () => {
		const { root } = await trackedRepo();
		const seed = new Uint8Array([0, 1, 2, 3]);
		const edited = new Uint8Array([0, 1, 2, 9]);
		const other = new Uint8Array([0, 7, 7, 7]);
		await Bun.write(path.join(root, "data.bin"), seed);
		await git(root, ["add", "data.bin"]);
		await git(root, ["commit", "-qm", "seed bin"]);
		await Bun.write(path.join(root, "data.bin"), edited);
		const patch = await git(root, ["diff", "--binary", "--no-ext-diff"]);
		await git(root, ["checkout", "-q", "--", "data.bin"]);
		const repo = vcs.requireGit(root);
		await repo.applyPatch(patch, { threeWay: true });
		expect(new Uint8Array(await Bun.file(path.join(root, "data.bin")).arrayBuffer())).toEqual(edited);
		// Already present: a plain apply refuses, a three-way apply keeps the result.
		await expect(repo.applyPatch(patch, {})).rejects.toThrow();
		await repo.applyPatch(patch, { threeWay: true });
		expect(new Uint8Array(await Bun.file(path.join(root, "data.bin")).arrayBuffer())).toEqual(edited);
		await Bun.write(path.join(root, "data.bin"), other);
		await expect(repo.applyPatch(patch, { threeWay: true })).rejects.toThrow();
		expect(new Uint8Array(await Bun.file(path.join(root, "data.bin")).arrayBuffer())).toEqual(other);
	});
});
