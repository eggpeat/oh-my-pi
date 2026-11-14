import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft, type Draft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

	it("commits modes, executable deletions, symlinks, and non-UTF-8 files exactly as in the worktree", async () => {
		const { root, journal, write } = await emptyRepo();
		const latin1 = (text: string) => Buffer.from(text, "latin1");
		await Bun.write(path.join(root, "run.sh"), "#!/bin/sh\necho run\n");
		await Bun.write(path.join(root, "tool.sh"), "#!/bin/sh\necho tool\n");
		await Bun.write(path.join(root, "plain.txt"), "plain\n");
		await Bun.write(path.join(root, "latin1.txt"), latin1("caf\xe9\n"));
		await fs.chmod(path.join(root, "run.sh"), 0o755);
		await fs.chmod(path.join(root, "tool.sh"), 0o755);
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);

		await fs.chmod(path.join(root, "run.sh"), 0o644);
		await fs.rm(path.join(root, "tool.sh"));
		await write("Main", undefined, "plain.txt", "plain\nmore\n");
		await fs.chmod(path.join(root, "plain.txt"), 0o755);
		await Bun.write(path.join(root, "latin1.txt"), latin1("caf\xe9\nna\xefve\n"));
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
		expect(modes).toEqual({ "latin1.txt": "100644", link: "120000", "plain.txt": "100755", "run.sh": "100644" });
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
});

async function initRepo(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selective-whole-"));
	tempDirs.push(root);
	await git(root, ["init", "-q", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "commit.gpgSign", "false"]);
	await git(root, ["config", "core.filemode", "true"]);
	await Bun.write(path.join(root, "README.md"), "seed\n");
	await git(root, ["add", "README.md"]);
	await git(root, ["commit", "-q", "-m", "seed"]);
	return root;
}

/** Blob id of `bytes`, matching `git hash-object --stdin`. */
async function blobId(bytes: Uint8Array): Promise<string> {
	const proc = Bun.spawn(["git", "hash-object", "--stdin"], {
		stdin: bytes,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git hash-object failed (${code}): ${err}`);
	return out.trim();
}

/** Incompressible bytes so a binary patch spans more than one base85 line. */
function pattern(length: number, seed: number): Uint8Array {
	const out = new Uint8Array(length);
	let state = seed >>> 0;
	for (let index = 0; index < length; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out[index] = state & 0xff;
	}
	out[0] = 0;
	return out;
}

function wholeChange(draft: Draft, filePath: string) {
	const change = draft.selection().find(entry => entry.path === filePath);
	if (change?.kind !== "whole") throw new Error(`expected a whole-file selection for ${filePath}`);
	return change;
}

describe("selective commit of whole files", () => {
	it("commits a tracked binary file as captured, including its mode and a non-ASCII name", async () => {
		const root = await initRepo();
		const name = "café.bin";
		const file = path.join(root, name);
		const captured = Uint8Array.of(0, 1, 2, 255, 10);
		await fs.writeFile(file, captured);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		const edited = Uint8Array.of(0, 1, 2, 255, 11);
		await fs.writeFile(file, edited);
		await fs.chmod(file, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const later = Uint8Array.of(9, 9, 9);
		await fs.writeFile(file, later);
		await fs.chmod(file, 0o644);

		const change = wholeChange(draft, name);
		expect(change.before !== null && Buffer.from(change.before).equals(captured)).toBe(true);
		expect(change.mode).toBe("100755");
		expect(change.content !== null && Buffer.from(change.content).equals(edited)).toBe(true);
		await commitSelection(draft, { subject: "fix: freeze binary" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(edited));
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100755 blob ")).toBe(true);
		expect(Buffer.from(await fs.readFile(file)).equals(later)).toBe(true);
		expect((await git(root, ["diff", "--cached", "--name-only"])).trim()).toBe("");
	});

	it("commits an untracked non-UTF-8 file as captured when it is rewritten later", async () => {
		const root = await initRepo();
		const name = "notes.dat";
		const file = path.join(root, name);
		const captured = Uint8Array.of(0xff, 0xfe, 0xfd);
		await fs.writeFile(file, captured);
		await fs.chmod(file, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const later = Uint8Array.of(1, 2, 3, 4);
		await fs.writeFile(file, later);
		await fs.chmod(file, 0o644);

		const change = wholeChange(draft, name);
		expect(change.before).toBeNull();
		expect(change.mode).toBe("100755");
		expect(change.content !== null && Buffer.from(change.content).equals(captured)).toBe(true);
		await commitSelection(draft, { subject: "fix: freeze bytes" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(captured));
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100755 blob ")).toBe(true);
		expect(Buffer.from(await fs.readFile(file)).equals(later)).toBe(true);
	});

	it("commits a binary deletion captured at draft time when the file is recreated later", async () => {
		const root = await initRepo();
		const name = "gone.bin";
		const file = path.join(root, name);
		await fs.writeFile(file, Uint8Array.of(0, 2, 4));
		await fs.chmod(file, 0o755);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		await fs.rm(file);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const later = Uint8Array.of(5, 6, 7);
		await fs.writeFile(file, later);

		expect(wholeChange(draft, name).content).toBeNull();
		await commitSelection(draft, { subject: "fix: keep deletion" }, { journal: null, agent: { agent: "Main" } });

		await expect(git(root, ["cat-file", "-e", `HEAD:${name}`])).rejects.toThrow(/cat-file/);
		expect(Buffer.from(await fs.readFile(file)).equals(later)).toBe(true);
		expect(await git(root, ["status", "--porcelain", "--", name])).toBe(`?? ${name}\n`);
	});

	it("commits a mode-only change captured at draft time when the mode is changed again later", async () => {
		const root = await initRepo();
		const name = "tool.bin";
		const file = path.join(root, name);
		const bytes = Uint8Array.of(0, 7, 0);
		await fs.writeFile(file, bytes);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		await fs.chmod(file, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		await fs.chmod(file, 0o644);

		const change = wholeChange(draft, name);
		expect(change.mode).toBe("100755");
		expect(change.content !== null && Buffer.from(change.content).equals(bytes)).toBe(true);
		await commitSelection(draft, { subject: "fix: freeze mode" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(bytes));
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100755 blob ")).toBe(true);
	});

	it("commits a same-mode binary edit from the bytes captured with the draft", async () => {
		const root = await initRepo();
		const name = "same.bin";
		const file = path.join(root, name);
		await fs.writeFile(file, pattern(32, 1));
		await fs.chmod(file, 0o755);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		const edited = pattern(200, 2);
		await fs.writeFile(file, edited);
		await fs.chmod(file, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		await fs.writeFile(file, pattern(8, 3));
		await fs.chmod(file, 0o644);

		const change = wholeChange(draft, name);
		expect(change.mode).toBe("100755");
		expect(change.content !== null && Buffer.from(change.content).equals(edited)).toBe(true);
		await commitSelection(draft, { subject: "fix: freeze same mode" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(edited));
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100755 blob ")).toBe(true);
	});

	it("commits an oversized text file as captured when it is rewritten later", async () => {
		const root = await initRepo();
		const name = "big.txt";
		const file = path.join(root, name);
		// One byte past the draft's whole-file cap, so this stays a whole-file selection.
		const captured = new Uint8Array(4 * 1024 * 1024 + 1);
		captured.fill("a".charCodeAt(0));
		captured[captured.length - 1] = "b".charCodeAt(0);
		await fs.writeFile(file, captured);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const later = new Uint8Array(captured);
		later[0] = "c".charCodeAt(0);
		await fs.writeFile(file, later);

		const change = wholeChange(draft, name);
		expect(change.content !== null && Buffer.from(change.content).equals(captured)).toBe(true);
		await commitSelection(draft, { subject: "fix: freeze large file" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(captured));
		expect(Buffer.from(await fs.readFile(file)).equals(later)).toBe(true);
	});

	it("refuses a binary edit when a later commit changes the file mode", async () => {
		const root = await initRepo();
		const name = "race.bin";
		const file = path.join(root, name);
		await fs.writeFile(file, Uint8Array.of(0, 1, 2));
		await fs.chmod(file, 0o755);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		const edited = Uint8Array.of(0, 1, 3);
		await fs.writeFile(file, edited);
		await fs.chmod(file, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		await git(root, ["update-index", "--chmod=-x", "--", name]);
		await git(root, ["commit", "-q", "-m", "drop mode"]);
		const moved = (await git(root, ["rev-parse", "HEAD"])).trim();

		const change = wholeChange(draft, name);
		expect(change.mode).toBe("100755");
		expect(change.content !== null && Buffer.from(change.content).equals(edited)).toBe(true);
		await expect(
			commitSelection(draft, { subject: "fix: should conflict" }, { journal: null, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved/);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(moved);
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100644 blob ")).toBe(true);
		expect(Buffer.from(await fs.readFile(file)).equals(edited)).toBe(true);
	});

	it("commits a binary file whose name contains spaces from the saved bytes", async () => {
		const root = await initRepo();
		const name = "release notes.txt";
		const file = path.join(root, name);
		const captured = Uint8Array.of(0, 1, 2, 255);
		await fs.writeFile(file, captured);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		const edited = Uint8Array.of(0, 1, 2, 254);
		await fs.writeFile(file, edited);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const later = Uint8Array.of(8, 8, 8);
		await fs.writeFile(file, later);
		await commitSelection(draft, { subject: "fix: freeze spaced name" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(edited));
		expect(Buffer.from(await fs.readFile(file)).equals(later)).toBe(true);
	});

	it("commits a text file whose name contains spaces without taking a later edit", async () => {
		const root = await initRepo();
		const name = "my notes.txt";
		const file = path.join(root, name);
		await Bun.write(file, "one\n");
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "notes"]);
		await Bun.write(file, "two\n");

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		await Bun.write(file, "three\n");
		await commitSelection(draft, { subject: "fix: freeze spaced text" }, { journal: null, agent: { agent: "Main" } });

		expect(await git(root, ["show", `HEAD:${name}`])).toBe("two\n");
		expect(await Bun.file(file).text()).toBe("three\n");
	});

	it("applies a git patch whose paths have spaces or non-ASCII names", async () => {
		const root = await initRepo();
		const notes = "release notes.txt";
		const cafe = "café.txt";
		await Bun.write(path.join(root, notes), "one\n");
		await Bun.write(path.join(root, cafe), "cafe\n");
		await git(root, ["add", "--", notes, cafe]);
		await git(root, ["commit", "-q", "-m", "names"]);
		await Bun.write(path.join(root, notes), "two\n");
		await Bun.write(path.join(root, cafe), "té\n");
		const patch = await git(root, ["diff", "--", notes, cafe]);
		await git(root, ["checkout", "-q", "--", notes, cafe]);

		await vcs.requireGit(root).applyPatch(patch, { cached: false });

		expect(await Bun.file(path.join(root, notes)).text()).toBe("two\n");
		expect(await Bun.file(path.join(root, cafe)).text()).toBe("té\n");
	});

	it("keeps the recorded executable mark when git is not tracking permissions", async () => {
		const root = await initRepo();
		const name = "tool.bin";
		const file = path.join(root, name);
		const original = Uint8Array.of(0, 4, 0);
		await fs.writeFile(file, original);
		await fs.chmod(file, 0o755);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		await git(root, ["config", "core.filemode", "false"]);
		await fs.chmod(file, 0o644);
		const edited = Uint8Array.of(0, 4, 1);
		await fs.writeFile(file, edited);
		const freshName = "fresh.bin";
		const fresh = path.join(root, freshName);
		const freshBytes = Uint8Array.of(0, 5, 0);
		await fs.writeFile(fresh, freshBytes);
		await fs.chmod(fresh, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		draft.take({ path: freshName });
		await commitSelection(draft, { subject: "fix: keep recorded mode" }, { journal: null, agent: { agent: "Main" } });

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(edited));
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100755 blob ")).toBe(true);
		expect((await git(root, ["rev-parse", `HEAD:${freshName}`])).trim()).toBe(await blobId(freshBytes));
		expect((await git(root, ["ls-tree", "HEAD", "--", freshName])).startsWith("100644 blob ")).toBe(true);
	});

	it("refuses a binary edit when a later commit changes the bytes but not the mode", async () => {
		const root = await initRepo();
		const name = "race.bin";
		const file = path.join(root, name);
		await fs.writeFile(file, Uint8Array.of(1, 1, 1));
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		const edited = Uint8Array.of(1, 1, 2);
		await fs.writeFile(file, edited);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const other = Uint8Array.of(7, 7, 7);
		await fs.writeFile(file, other);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "other"]);
		const moved = (await git(root, ["rev-parse", "HEAD"])).trim();

		await expect(
			commitSelection(draft, { subject: "fix: should conflict" }, { journal: null, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved/);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(moved);
		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(other));
	});

	it("refuses a mode-only binary change when a later commit changes the bytes", async () => {
		const root = await initRepo();
		const name = "mode.bin";
		const file = path.join(root, name);
		const original = Uint8Array.of(2, 2, 2);
		await fs.writeFile(file, original);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		await fs.chmod(file, 0o755);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const other = Uint8Array.of(3, 3, 3);
		await fs.writeFile(file, other);
		await fs.chmod(file, 0o644);
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "other bytes"]);
		const moved = (await git(root, ["rev-parse", "HEAD"])).trim();

		await expect(
			commitSelection(draft, { subject: "fix: should conflict" }, { journal: null, agent: { agent: "Main" } }),
		).rejects.toThrow(/HEAD moved/);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(moved);
		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(other));
		expect((await git(root, ["ls-tree", "HEAD", "--", name])).startsWith("100644 blob ")).toBe(true);
	});

	it("leaves a different staged copy of a binary file in place", async () => {
		const root = await initRepo();
		const name = "staged.bin";
		const file = path.join(root, name);
		await fs.writeFile(file, Uint8Array.of(4, 4, 4));
		await git(root, ["add", "--", name]);
		await git(root, ["commit", "-q", "-m", "binary"]);
		const edited = Uint8Array.of(4, 4, 5);
		await fs.writeFile(file, edited);

		const draft = await createDraft({ cwd: root, journal: null, caller: "Main" });
		draft.take({ path: name });
		const staged = Uint8Array.of(9, 9, 9);
		await fs.writeFile(file, staged);
		await git(root, ["add", "--", name]);

		const outcome = await commitSelection(
			draft,
			{ subject: "fix: keep staged" },
			{ journal: null, agent: { agent: "Main" } },
		);

		expect((await git(root, ["rev-parse", `HEAD:${name}`])).trim()).toBe(await blobId(edited));
		expect((await git(root, ["rev-parse", `:${name}`])).trim()).toBe(await blobId(staged));
		expect(outcome.indexNotes.some(note => note.includes(name))).toBe(true);
	});
});
