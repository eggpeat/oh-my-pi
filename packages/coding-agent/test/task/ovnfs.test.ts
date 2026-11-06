import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { forgetDaemon } from "@oh-my-pi/pi-coding-agent/ovnfs/daemon";
import { ISOLATION_OWNER_FILE } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { OVNFS_CHECKOUT_FILE, ovnfsWorkspace } from "@oh-my-pi/pi-coding-agent/task/ovnfs";
import { taskIsolationBaseDir } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

function frame(value: object): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

/** A fake daemon keeps the recovery tests on the real ovnfs socket client. */
describe("ovnfs checkout recovery records", () => {
	let root: string;
	let repo: string;
	let worktrees: string;
	let command: string;
	let server: net.Server;
	let savedWorktreeDir: string | undefined;
	let requests: Record<string, unknown>[];
	let onRequest: (request: Record<string, unknown>, conn: net.Socket) => void;
	const conns = new Set<net.Socket>();

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-ovnfs-recovery-")));
		repo = path.join(root, "repo");
		worktrees = path.join(root, "worktrees");
		const mount = path.join(root, "mount");
		await fs.mkdir(repo, { recursive: true });
		await fs.mkdir(mount, { recursive: true });
		savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(worktrees);
		requests = [];
		onRequest = (request, conn) => {
			if (request.new) {
				const args = request.new as { name: string };
				conn.write(
					frame({
						id: request.id,
						ok: { checkout: { name: args.name, path: path.join(mount, args.name) } },
					}),
				);
			} else {
				conn.write(frame({ id: request.id, ok: {} }));
			}
		};

		const socket = path.join(root, "admin.sock");
		server = net.createServer(conn => {
			conns.add(conn);
			let buffered = Buffer.alloc(0);
			conn.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
					const length = buffered.readUInt32LE(0);
					const request = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
					buffered = buffered.subarray(4 + length);
					if (request.hello) {
						conn.write(frame({ welcome: { version: 5, ops: ["new", "rm"] } }));
						continue;
					}
					requests.push(request);
					onRequest(request, conn);
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.listen(socket, listening.resolve);
		await listening.promise;

		command = path.join(root, "ovnfs");
		const status = JSON.stringify({ version: 5, pid: 1, socket, mount });
		await Bun.write(command, `#!/bin/sh\nprintf '%s\\n' '${status}'\n`);
		await fs.chmod(command, 0o755);
	});

	afterEach(async () => {
		for (const conn of conns) conn.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
		forgetDaemon(command);
		setWorktreesDir(undefined);
		if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
		await removeWithRetries(root);
	});

	it("moves a slot aside when its previous checkout cannot be removed so reuse preserves the record", async () => {
		onRequest = (request, conn) => {
			if (request.new) {
				const args = request.new as { name: string };
				conn.write(
					frame({
						id: request.id,
						ok: { checkout: { name: args.name, path: path.join(root, "mount", args.name) } },
					}),
				);
			} else {
				conn.write(frame({ id: request.id, error: { code: "busy", message: "checkout is busy" } }));
			}
		};
		const open = ovnfsWorkspace(command);
		const first = await open(repo, "ReuseSlot");
		await first.cleanup();
		const baseDir = taskIsolationBaseDir(repo, "ReuseSlot");
		const recordPath = path.join(baseDir, OVNFS_CHECKOUT_FILE);
		const firstRecord = (await Bun.file(recordPath).json()) as { checkout: string };

		const second = await open(repo, "ReuseSlot");

		const secondRecord = (await Bun.file(recordPath).json()) as { checkout: string };
		expect(second.dir).toBe(path.join(root, "mount", secondRecord.checkout));
		expect(secondRecord.checkout).not.toBe(firstRecord.checkout);
		const entries = await fs.readdir(worktrees);
		const retainedName = entries.find(entry => entry.startsWith(`${path.basename(baseDir)}.retained-`));
		expect(retainedName).toBeDefined();
		const retainedDir = path.join(worktrees, retainedName!);
		expect(await Bun.file(path.join(retainedDir, OVNFS_CHECKOUT_FILE)).json()).toEqual(firstRecord);
		expect(await Bun.file(path.join(retainedDir, ISOLATION_OWNER_FILE)).exists()).toBe(true);
		expect(requests.filter(request => request.new)).toHaveLength(2);
		expect(requests.filter(request => request.rm)).toHaveLength(2);
	});

	it("stops setup and keeps the recovery record when a busy slot cannot be moved aside", async () => {
		onRequest = (request, conn) => {
			if (request.new) {
				const args = request.new as { name: string };
				conn.write(
					frame({
						id: request.id,
						ok: { checkout: { name: args.name, path: path.join(root, "mount", args.name) } },
					}),
				);
			} else {
				conn.write(frame({ id: request.id, error: { code: "busy", message: "checkout is busy" } }));
			}
		};
		const open = ovnfsWorkspace(command);
		const first = await open(repo, "PinnedSlot");
		await first.cleanup();
		const baseDir = taskIsolationBaseDir(repo, "PinnedSlot");
		const recordPath = path.join(baseDir, OVNFS_CHECKOUT_FILE);
		const firstRecord = await Bun.file(recordPath).json();
		await fs.chmod(worktrees, 0o555);
		try {
			await expect(open(repo, "PinnedSlot")).rejects.toThrow("checkout is busy");
		} finally {
			await fs.chmod(worktrees, 0o755);
		}

		expect(await Bun.file(recordPath).json()).toEqual(firstRecord);
		expect(await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).exists()).toBe(true);
		expect(requests.filter(request => request.new)).toHaveLength(1);
		expect(requests.filter(request => request.rm)).toHaveLength(2);
	});

	it("keeps a lost creation reply's record when checkout removal also fails", async () => {
		onRequest = (request, conn) => {
			if (request.new) {
				conn.destroy();
			} else {
				conn.write(frame({ id: request.id, error: { code: "busy", message: "checkout is busy" } }));
			}
		};

		await expect(ovnfsWorkspace(command)(repo, "LostReply")).rejects.toThrow("closed the connection");

		const baseDir = taskIsolationBaseDir(repo, "LostReply");
		const record = (await Bun.file(path.join(baseDir, OVNFS_CHECKOUT_FILE)).json()) as { checkout: string };
		const newArgs = requests[0]?.new as { name: string };
		expect(record.checkout).toBe(newArgs.name);
		expect(requests[1]?.rm).toEqual({ checkout: record.checkout });
		expect(await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).exists()).toBe(true);
	});

	it("deletes a failed creation slot only after confirming checkout removal", async () => {
		onRequest = (request, conn) => {
			if (request.new) conn.destroy();
			else conn.write(frame({ id: request.id, ok: {} }));
		};

		await expect(ovnfsWorkspace(command)(repo, "ConfirmedCleanup")).rejects.toThrow("closed the connection");

		const newArgs = requests[0]?.new as { name: string };
		expect(requests[1]?.rm).toEqual({ checkout: newArgs.name });
		const baseDir = taskIsolationBaseDir(repo, "ConfirmedCleanup");
		expect(await Bun.file(path.join(baseDir, OVNFS_CHECKOUT_FILE)).exists()).toBe(false);
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("clears the slot without leaving a recovery record when the daemon cannot start", async () => {
		const status = JSON.stringify({
			version: 4,
			pid: 1,
			socket: path.join(root, "admin.sock"),
			mount: path.join(root, "mount"),
		});
		await Bun.write(command, `#!/bin/sh\nprintf '%s\\n' '${status}'\n`);

		await expect(ovnfsWorkspace(command)(repo, "OldDaemon")).rejects.toThrow("speaks admin protocol 4");

		const baseDir = taskIsolationBaseDir(repo, "OldDaemon");
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(requests).toHaveLength(0);
	});
});
