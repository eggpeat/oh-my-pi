import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgReadLineNumbers } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createSession(cwd: string, sourcePath: string): ToolSession {
	const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false }),
		getImageAttachments: () => [{ label: "Image #1", uri: "attachment://1", image, sourcePath }],
	};
}

describe("read attachment URLs", () => {
	let testDir: string;
	let imagePath: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-attachment-"));
		imagePath = path.join(testDir, "original.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("decodes attachment URLs through the underlying image file path", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));
		const attachmentResult = await tool.execute("read-attachment", { path: "attachment://1" });
		const fileResult = await tool.execute("read-file", { path: imagePath });

		expect(attachmentResult.content).toEqual(fileResult.content);
		expect(attachmentResult.content).toContainEqual({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("reports unknown attachment URLs with the available URIs", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));

		await expect(tool.execute("read-missing-attachment", { path: "attachment://2" })).rejects.toThrow(
			"Could not resolve image attachment 'attachment://2'. Available attachment URIs: attachment://1.",
		);
	});
});

describe("read tool description display-mode gating", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "read-description-mode-"));
		await Bun.write(path.join(testDir, "example.py"), "x = 1\n");
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	function readText(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n");
	}

	function rawBullet(description: string): string {
		const line = description.split("\n").find(candidate => candidate.startsWith("- :raw "));
		if (!line) throw new Error("read description has no :raw bullet");
		return line;
	}

	it("gates :raw anchor and line-prefix wording on the active file display mode", async () => {
		const readOnlySession: ToolSession = {
			cwd: testDir,
			hasUI: false,
			hasEditTool: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "edit.mode": "hashline" }),
		};
		const readOnlyTool = new ReadTool(readOnlySession);
		const readOnlyResult = await readOnlyTool.execute("read-plain", { path: "example.py" });
		expect(readText(readOnlyResult)).toBe("x = 1");
		expect(readOnlyResult.details?.rowPrefixes).toBe(false);
		const readOnlyRaw = rawBullet(readOnlyTool.description);
		expect(readOnlyRaw).not.toContain("anchor");
		expect(readOnlyRaw).not.toContain("prefix");

		const settings = Settings.isolated({ "edit.mode": "hashline" });
		const mutableSession: ToolSession = {
			cwd: testDir,
			hasUI: false,
			hasEditTool: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		const tool = new ReadTool(mutableSession);

		const hashlineResult = await tool.execute("read-hashline", { path: "example.py" });
		expect(readText(hashlineResult)).toMatch(/^\[example\.py#[0-9A-F]{4}\]\n1:x = 1$/);
		expect(hashlineResult.details?.rowPrefixes).toBe(true);
		const hashlineRaw = rawBullet(tool.description);
		expect(hashlineRaw).toContain("anchors/prefixes");

		cfgEditMode.override(settings, "replace");
		const replacePlainResult = await tool.execute("read-replace-plain", { path: "example.py" });
		expect(readText(replacePlainResult)).toBe("x = 1");
		expect(replacePlainResult.details?.rowPrefixes).toBe(false);
		const replaceRaw = rawBullet(tool.description);
		expect(replaceRaw).not.toContain("anchor");
		expect(replaceRaw).not.toContain("prefix");

		cfgReadLineNumbers.override(settings, true);
		const numberedResult = await tool.execute("read-numbered", { path: "example.py" });
		expect(readText(numberedResult)).toBe("1|x = 1");
		expect(numberedResult.details?.rowPrefixes).toBe(true);
		const numberedRaw = rawBullet(tool.description);
		expect(numberedRaw).toContain("line prefixes");
		expect(numberedRaw).not.toContain("anchor");
	});
});
