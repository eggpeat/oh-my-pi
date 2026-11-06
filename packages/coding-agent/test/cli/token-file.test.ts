import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTokenFile } from "@oh-my-pi/pi-coding-agent/cli/token-file";

describe.skipIf(process.platform === "win32")("readTokenFile", () => {
	let dir = "";

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-token-file-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("restricts a token file other users could read before trusting it", async () => {
		const file = path.join(dir, "auth-broker.token");
		await fs.writeFile(file, "secret-token\n", { mode: 0o644 });
		await fs.chmod(file, 0o644);

		expect(await readTokenFile(file)).toBe("secret-token");
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});

	it("refuses a symlinked token file instead of following it", async () => {
		const target = path.join(dir, "elsewhere");
		await fs.writeFile(target, "planted-token", { mode: 0o600 });
		const file = path.join(dir, "auth-broker.token");
		await fs.symlink(target, file);

		await expect(readTokenFile(file)).rejects.toThrow(/symlink/);
	});

	it("refuses a token path that is not a regular file without blocking on it", async () => {
		const file = path.join(dir, "auth-broker.token");
		await fs.mkdir(file);

		await expect(readTokenFile(file)).rejects.toThrow(/not a regular file/);
	});
});
