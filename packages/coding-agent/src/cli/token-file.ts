/**
 * Bearer-token file helpers shared by the auth broker and auth gateway CLIs.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger } from "@oh-my-pi/pi-utils";

/**
 * Read a token file; `null` when it is missing or blank. Whoever can read the file holds the
 * server's bearer, so on POSIX it must be a regular file owned by the current user (a symlink is
 * refused, not followed), and group/other access is removed before the token is trusted.
 */
export async function readTokenFile(file: string): Promise<string | null> {
	const posix = process.platform !== "win32";
	// O_NONBLOCK: opening a FIFO planted at the path must not hang the CLI.
	const flags = fs.constants.O_RDONLY | (posix ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, flags);
	} catch (err) {
		if (isEnoent(err)) return null;
		if (hasFsCode(err, "ELOOP")) throw new Error(`Token file ${file} is a symlink; refusing to follow it`);
		throw err;
	}
	try {
		if (posix) {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error(`Token file ${file} is not a regular file`);
			if (stat.uid !== process.getuid?.()) throw new Error(`Token file ${file} is not owned by the current user`);
			if ((stat.mode & 0o077) !== 0) {
				await handle.chmod(0o600);
				logger.warn("Token file was readable by other users; restricted it to its owner", {
					path: file,
					mode: (stat.mode & 0o777).toString(8),
				});
			}
		}
		const trimmed = (await handle.readFile("utf8")).trim();
		return trimmed.length > 0 ? trimmed : null;
	} finally {
		await handle.close();
	}
}

/** Write a token file readable only by the current user. */
export async function writeTokenFile(file: string, token: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/** Generate a random URL-safe bearer token. */
export function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}
