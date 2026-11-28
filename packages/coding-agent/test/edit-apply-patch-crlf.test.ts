import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated({}),
	} as unknown as ToolSession;
}

/** Every entry name in `dir`, so a stray `b.txt\r` shows up as its own file. */
async function entries(dir: string): Promise<string[]> {
	return (await fs.readdir(dir)).sort();
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-crlf-apply-patch-"));
});

afterEach(async () => {
	await removeWithRetries(tempDir);
});

// A payload authored on Windows (or emitted by a model) separates its rows with
// `\r\n`. Parsed as-is, the `\r` lands inside paths and added file content.
describe("edit payloads with CRLF row separators", () => {
	test("apply_patch creates a file without carriage returns in its content", async () => {
		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("crlf-add", {
			input: "*** Begin Patch\r\n*** Add File: added.txt\r\n+hello\r\n+world\r\n*** End Patch\r\n",
		});

		expect(result.isError).not.toBe(true);
		expect(await entries(tempDir)).toEqual(["added.txt"]);
		expect(await Bun.file(path.join(tempDir, "added.txt")).text()).toBe("hello\nworld\n");
	});

	test("apply_patch moves to the destination without a trailing carriage return", async () => {
		await Bun.write(path.join(tempDir, "a.txt"), "old\n");

		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("crlf-move", {
			input: "*** Begin Patch\r\n*** Update File: a.txt\r\n*** Move to: b.txt\r\n@@\r\n-old\r\n+moved\r\n*** End Patch\r\n",
		});

		expect(result.isError).not.toBe(true);
		expect(await entries(tempDir)).toEqual(["b.txt"]);
		expect(await Bun.file(path.join(tempDir, "b.txt")).text()).toBe("moved\n");
	});

	test("apply_patch applies a CRLF update hunk without writing carriage returns", async () => {
		await Bun.write(path.join(tempDir, "lines.txt"), "one\ntwo\n");

		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("crlf-update", {
			input: "*** Begin Patch\r\n*** Update File: lines.txt\r\n@@\r\n-one\r\n+ONE\r\n*** End Patch\r\n",
		});

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(tempDir, "lines.txt")).text()).toBe("ONE\ntwo\n");
	});

	test("patch mode applies a CRLF diff without writing carriage returns", async () => {
		await Bun.write(path.join(tempDir, "patched.txt"), "one\ntwo\n");

		const result = await new EditTool(makeSession(tempDir), "patch").execute("crlf-patch", {
			path: "patched.txt",
			edits: [{ op: "update", diff: "@@\r\n-two\r\n+2\r\n" }],
		});

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(tempDir, "patched.txt")).text()).toBe("one\n2\n");
	});

	test("patch mode creates a file without carriage returns in its content", async () => {
		const result = await new EditTool(makeSession(tempDir), "patch").execute("crlf-create", {
			path: "created.txt",
			edits: [{ op: "create", diff: "alpha\r\nbeta\r\n" }],
		});

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(tempDir, "created.txt")).text()).toBe("alpha\nbeta\n");
	});

	test("the matcher digest of a CRLF patch describes the lines the file gets", () => {
		const tool = new EditTool(makeSession(tempDir), "patch");
		const args = { path: "digest.txt", edits: [{ op: "update", diff: "@@\r\n-old\r\n+new\r\n" }] };

		expect(tool.matcherEntries(args)).toEqual([{ path: "digest.txt", digest: "new" }]);
	});
});
