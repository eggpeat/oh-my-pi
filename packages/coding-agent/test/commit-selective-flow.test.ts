import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
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

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return Buffer.from(out);
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

	it("commits whole files as the draft captured them, not as edited afterwards", async () => {
		const { root, journal } = await emptyRepo();
		const bigBefore = Buffer.concat([Buffer.alloc(4 * 1024 * 1024 + 1, "x"), Buffer.from("\n")]);
		await Bun.write(path.join(root, "big.txt"), bigBefore);
		await Bun.write(path.join(root, "café.bin"), Buffer.from([0x00, 0x01]));
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);

		const newBefore = Buffer.from([0x02, 0x00, 0xff]);
		await Bun.write(path.join(root, "café.bin"), Buffer.from([0x00, 0x02]));
		await Bun.write(path.join(root, "new.bin"), newBefore);
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "**" });

		// Another agent or process rewrites every selected path before commit.
		await Bun.write(path.join(root, "big.txt"), "later\n");
		await Bun.write(path.join(root, "café.bin"), Buffer.from([0x00, 0x03]));
		await Bun.write(path.join(root, "new.bin"), Buffer.from([0x99]));
		await commitSelection(draft, { subject: "chore: freeze" }, { journal, agent: { agent: "Main" } });

		expect(await gitBytes(root, ["show", "HEAD:big.txt"])).toEqual(bigBefore);
		expect(await gitBytes(root, ["show", "HEAD:café.bin"])).toEqual(Buffer.from([0x00, 0x02]));
		expect(await gitBytes(root, ["show", "HEAD:new.bin"])).toEqual(newBefore);
	});

	it("commits a whole file's clean-filtered bytes, like git add does", async () => {
		if (process.platform === "win32") return; // needs `tr` as a clean command
		const { root, journal } = await emptyRepo();
		await Bun.write(path.join(root, ".gitattributes"), "*.bin filter=upcase\n");
		await git(root, ["config", "filter.upcase.clean", "tr a-z A-Z"]);
		await Bun.write(path.join(root, "payload.bin"), Buffer.from("\x00tracked"));
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);

		await Bun.write(path.join(root, "payload.bin"), Buffer.from("\x00changed"));
		await Bun.write(path.join(root, "fresh.bin"), Buffer.from("\x00fresh"));
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "**" });
		await commitSelection(draft, { subject: "chore: filtered" }, { journal, agent: { agent: "Main" } });

		// Staging raw bytes would commit the payload, not the filter's output.
		expect(await gitBytes(root, ["show", "HEAD:payload.bin"])).toEqual(Buffer.from("\x00CHANGED"));
		expect(await gitBytes(root, ["show", "HEAD:fresh.bin"])).toEqual(Buffer.from("\x00FRESH"));
	});

	it("commits a symlink's draft-time target", async () => {
		if (process.platform === "win32") return; // symlinks need privileges git for windows may not grant
		const { root, journal } = await emptyRepo();
		await fs.symlink("first.txt", path.join(root, "link"));
		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "**" });

		await fs.rm(path.join(root, "link"));
		await fs.symlink("second.txt", path.join(root, "link"));
		await commitSelection(draft, { subject: "chore: link" }, { journal, agent: { agent: "Main" } });

		expect(await git(root, ["show", "HEAD:link"])).toBe("first.txt");
		expect((await git(root, ["ls-tree", "HEAD", "link"])).trim().split(" ")[0]).toBe("120000");
	});

	it("commits a binary edit inside a directory named b without moving the file", async () => {
		const { root, journal } = await emptyRepo();
		await fs.mkdir(path.join(root, "b"));
		await Bun.write(path.join(root, "b/photo.bin"), Buffer.from([0x00, 0x01]));
		await Bun.write(path.join(root, "photo.bin"), Buffer.from("keep"));
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		await Bun.write(path.join(root, "b/photo.bin"), Buffer.from([0x00, 0x02]));

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		draft.take({ path: "**" });
		await commitSelection(draft, { subject: "chore: b" }, { journal, agent: { agent: "Main" } });

		expect(await gitBytes(root, ["show", "HEAD:b/photo.bin"])).toEqual(Buffer.from([0x00, 0x02]));
		expect(await gitBytes(root, ["show", "HEAD:photo.bin"])).toEqual(Buffer.from("keep"));
	});

	it("applies a rename whose name contains a space to that name", async () => {
		const { root } = await emptyRepo();
		await Bun.write(path.join(root, "old name.txt"), "kept\n");
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "seed"]);
		await git(root, ["mv", "old name.txt", "new name.txt"]);
		const repo = vcs.requireGit(root);
		const patch = await repo.diffText({ cached: true });
		expect(patch).toBe(await git(root, ["diff", "--no-ext-diff", "--cached", "--find-renames"]));
		expect(patch).toContain("rename from old name.txt\n");
		await git(root, ["reset", "--hard", "-q"]);
		const tabbed = patch
			.replace("rename from old name.txt\n", "rename from old name.txt\t\n")
			.replace("rename to new name.txt\n", "rename to new name.txt\t\n");
		await repo.applyPatch(tabbed, { cached: true });
		expect(await git(root, ["ls-files"])).toBe("new name.txt\n");
	});

	it("selects an agent's CRLF write as their own lines", async () => {
		const { root, journal, write } = await emptyRepo();
		await git(root, ["config", "core.autocrlf", "true"]);
		await write("Main", undefined, "a.ts", "export const a = 1;\r\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("✓ a.ts  +1  [Main]");
		const outcome = await commitSelection(draft, { subject: "feat: a" }, { journal, agent: { agent: "Main" } });
		expect(outcome.paths).toEqual(["a.ts"]);
		expect(await gitBytes(root, ["show", "HEAD:a.ts"])).toEqual(Buffer.from("export const a = 1;\n"));
	});

	it("selects an agent's text edit after a clean filter rewrites it", async () => {
		if (process.platform === "win32") return; // needs `tr` as a clean command
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, ".gitattributes"), "notes.txt filter=upcase\n");
		await git(root, ["add", ".gitattributes"]);
		await git(root, ["commit", "-q", "-m", "attrs"]);
		await git(root, ["config", "filter.upcase.clean", "tr a-z A-Z"]);
		await write("Main", undefined, "notes.txt", "hello\n");
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		expect(draft.summary()).toContain("✓ notes.txt  +1  [Main]");
		await commitSelection(draft, { subject: "docs: notes" }, { journal, agent: { agent: "Main" } });
		expect(await git(root, ["show", "HEAD:notes.txt"])).toBe("HELLO\n");
	});

	it("still drafts other files when a required filter rejects an old saved edit", async () => {
		if (process.platform === "win32") return; // the filter command is python3
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, ".gitattributes"), "*.json filter=jsoncheck\n");
		await git(root, ["add", ".gitattributes"]);
		await git(root, ["commit", "-q", "-m", "attrs"]);
		await git(root, [
			"config",
			"filter.jsoncheck.clean",
			'python3 -c "import json,sys; d=sys.stdin.read(); json.loads(d); sys.stdout.write(d)"',
		]);
		await git(root, ["config", "filter.jsoncheck.required", "true"]);
		const start = Date.now() - 5_000;
		// The journal still holds the invalid write. The file on disk is already fixed.
		await write("Main", undefined, "broken.json", "{");
		await Bun.write(path.join(root, "broken.json"), '{"ok":true}\n');
		await write("Main", undefined, "ok.ts", "export const ok = 1;\n");
		journal.recordCall({ agent: "Main", tool: "bash", start, end: Date.now() + 5_000, label: "fix json" });
		await journal.flush();

		const draft = await createDraft({ cwd: root, journal, caller: "Main" });
		const summary = draft.summary();
		expect(summary).toContain("✓ ok.ts");
		expect(summary).not.toContain("✓ broken.json");
		expect(summary).toContain("? broken.json");
		expect(summary).toContain("no edit record");
		const outcome = await commitSelection(draft, { subject: "feat: ok" }, { journal, agent: { agent: "Main" } });
		expect(outcome.paths).toEqual(["ok.ts"]);
	});

	it("still fails the draft when the current file is rejected by a required filter", async () => {
		if (process.platform === "win32") return; // the filter command is python3
		const { root, journal, write } = await emptyRepo();
		await Bun.write(path.join(root, ".gitattributes"), "*.json filter=jsoncheck\n");
		await git(root, ["add", ".gitattributes"]);
		await git(root, ["commit", "-q", "-m", "attrs"]);
		await git(root, [
			"config",
			"filter.jsoncheck.clean",
			'python3 -c "import json,sys; d=sys.stdin.read(); json.loads(d); sys.stdout.write(d)"',
		]);
		await git(root, ["config", "filter.jsoncheck.required", "true"]);
		await write("Main", undefined, "broken.json", "{");
		await journal.flush();

		await expect(createDraft({ cwd: root, journal, caller: "Main" })).rejects.toThrow(/filter|failed/i);
	});
});
