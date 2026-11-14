import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
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
