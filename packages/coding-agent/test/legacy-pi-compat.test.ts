import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface LoadedFixtureModule {
	loaded: number;
}

function isLoadedFixtureModule(value: unknown): value is LoadedFixtureModule {
	return typeof value === "object" && value !== null && "loaded" in value && typeof value.loaded === "number";
}

interface LazyFixtureModule {
	loadChild: () => Promise<number>;
}

function isLazyFixtureModule(value: unknown): value is LazyFixtureModule {
	return typeof value === "object" && value !== null && "loadChild" in value && typeof value.loadChild === "function";
}

describe("legacy Pi extension source graph", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("serves collected source to the rewrite hook once per module", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-pi-source-graph-test-"));
		tempDirs.push(root);
		const entry = path.join(root, "entry.ts");
		const child = path.join(root, "child.ts");
		await Bun.write(entry, `import { value } from "./child";\nexport const loaded = value + 1;\n`);
		await Bun.write(child, `export const value = 41;\n`);

		const tracked = new Set([entry, child]);
		const readCounts = new Map<string, number>();
		const originalFile = Bun.file;
		const fileSpy = spyOn(Bun, "file").mockImplementation((input, options) => {
			if (typeof input === "string" && tracked.has(input)) {
				readCounts.set(input, (readCounts.get(input) ?? 0) + 1);
			}
			if (typeof input === "number") {
				return originalFile(input, options);
			}
			if (typeof input === "string" || input instanceof URL) {
				return originalFile(input, options);
			}
			return originalFile(input, options);
		});

		try {
			const first = await loadLegacyPiModule(entry);
			if (!isLoadedFixtureModule(first)) {
				throw new Error("Legacy Pi fixture did not export a numeric loaded value");
			}
			expect(first.loaded).toBe(42);
			expect(readCounts.get(entry)).toBe(1);
			expect(readCounts.get(child)).toBe(1);
		} finally {
			fileSpy.mockRestore();
		}
	});

	it("re-reads lazily imported modules edited after startup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-pi-lazy-import-test-"));
		tempDirs.push(root);
		const entry = path.join(root, "entry.ts");
		const child = path.join(root, "child.ts");
		await Bun.write(
			entry,
			`export async function loadChild() {\n\tconst mod = await import("./child");\n\treturn (mod as { value: number }).value;\n}\n`,
		);
		await Bun.write(child, `export const value = 1;\n`);

		const loaded = await loadLegacyPiModule(entry);
		if (!isLazyFixtureModule(loaded)) {
			throw new Error("Legacy Pi fixture did not export loadChild");
		}

		// Simulate an update between the entry's initial load and the eventual
		// dynamic import: the hook must see the edited source, not the copy
		// buffered during the startup graph walk.
		await Bun.write(child, `export const value = 2;\n`);
		expect(await loaded.loadChild()).toBe(2);
	});
});
