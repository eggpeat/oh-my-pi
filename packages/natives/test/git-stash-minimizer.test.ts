import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell, type ShellRunResult } from "../native/index.js";

// Enough untracked names that `git status` / `git stash pop` exceed the
// minimizer's 1,000-character gate. Shorter output is left unchanged, so it
// cannot show the false untracked count.
const FILE_COUNT = 80;

const sessionEnv = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	HOME: os.homedir(),
	LANG: "C",
	LC_ALL: "C",
};

async function run(
	cwd: string,
	command: string,
): Promise<{ exitCode: number | undefined; raw: string; minimized: string | undefined }> {
	let raw = "";
	const result: ShellRunResult = await executeShell(
		{ command, cwd, minimizer: { enabled: true }, sessionEnv, timeoutMs: 30_000 },
		(_error, chunk) => {
			raw += chunk;
		},
	);
	return { exitCode: result.exitCode, raw, minimized: result.minimized?.text };
}

async function gitOk(cwd: string, command: string): Promise<{ raw: string; minimized: string | undefined }> {
	const result = await run(cwd, command);
	expect(result.exitCode, result.raw).toBe(0);
	return result;
}

function minimizedOrFail(result: { raw: string; minimized: string | undefined }): string {
	expect(result.minimized, `minimizer left ${result.raw.length} chars unchanged:\n${result.raw}`).toBeString();
	return result.minimized ?? "";
}

function assertUntracked(text: string, count: number): void {
	const match = text.match(/^staged \d+, unstaged \d+, untracked (\d+)$/m);
	expect(match?.[1], text).toBe(String(count));
	expect(text, text).not.toContain("?? no changes added");
	expect(text, text).not.toContain("?? nothing added");
	expect(text, text).not.toContain("?? Dropped");
	expect(text, text).toContain("?? file-00.txt");
}

async function initRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-min-"));
	await gitOk(dir, "git init -q -b main");
	await gitOk(dir, "git config user.email test@example.com");
	await gitOk(dir, "git config user.name test");
	await gitOk(dir, "git config advice.statusHints true");
	await gitOk(dir, "git config color.ui false");
	await fs.writeFile(path.join(dir, "tracked.txt"), "a\n");
	await gitOk(dir, "git add tracked.txt");
	await gitOk(dir, "git commit -qm init");
	return dir;
}

async function writeUntracked(dir: string): Promise<void> {
	await Promise.all(
		Array.from({ length: FILE_COUNT }, (_, index) =>
			fs.writeFile(path.join(dir, `file-${String(index).padStart(2, "0")}.txt`), "x\n"),
		),
	);
}

test("stash pop and status do not count closing lines as untracked files", async () => {
	const dirty = await initRepo();
	try {
		await fs.writeFile(path.join(dirty, "tracked.txt"), "b\n");
		await writeUntracked(dirty);
		await gitOk(dirty, "git stash push -u -q");
		const popped = await gitOk(dirty, "git stash pop");
		const text = minimizedOrFail(popped);
		assertUntracked(text, FILE_COUNT);
		expect(text, text).toContain("unstaged 1");
		expect(text, text).toMatch(/^Dropped refs\/stash@\{0\} \([0-9a-f]+\)$/m);
	} finally {
		await fs.rm(dirty, { recursive: true, force: true });
	}

	const named = await initRepo();
	try {
		await writeUntracked(named);
		await gitOk(named, "git stash push -u -q");
		// Quoting keeps bash from brace-expanding. Git then prints
		// `Dropped stash@{0}`, not `Dropped refs/stash@{0}`.
		const popped = await gitOk(named, "git stash pop 'stash@{0}'");
		const text = minimizedOrFail(popped);
		assertUntracked(text, FILE_COUNT);
		expect(text, text).toMatch(/^Dropped stash@\{0\} \([0-9a-f]+\)$/m);
		expect(text, text).not.toContain("refs/stash");
	} finally {
		await fs.rm(named, { recursive: true, force: true });
	}

	const statusDir = await initRepo();
	try {
		await writeUntracked(statusDir);
		const status = await gitOk(statusDir, "git status");
		const text = minimizedOrFail(status);
		assertUntracked(text, FILE_COUNT);
		expect(text, text).not.toContain("nothing added to commit");
	} finally {
		await fs.rm(statusDir, { recursive: true, force: true });
	}
}, 60_000);
