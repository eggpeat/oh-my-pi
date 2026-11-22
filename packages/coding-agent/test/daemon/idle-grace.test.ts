import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { DAEMON_DIR_ENV, DAEMON_RESUME_ENV, DAEMON_TCP_ENV } from "../../src/daemon/protocol";
import { startDaemonFromEnvironment } from "../../src/daemon/server";
import { DaemonConn } from "../fixtures/daemon-proc-harness";

const IDLE_GRACE_ENV = "OMP_DAEMON_IDLE_GRACE_MS";
const MAX_I32_TIMEOUT_MS = 0x7fff_ffff;

/** Yield one real libuv I/O turn (`vi.useFakeTimers()` pauses JS timer/immediate queues and clocks). */
async function nextIoTurn(probePath: string): Promise<void> {
	await fs.stat(probePath);
}

async function flushIoTurns(probePath: string, count = 10): Promise<void> {
	for (let i = 0; i < count; i++) await nextIoTurn(probePath);
}

async function waitForCondition(
	probePath: string,
	predicate: () => boolean,
	what: string,
	maxTurns = 2_000,
): Promise<void> {
	for (let turn = 0; turn < maxTurns; turn++) {
		if (predicate()) return;
		await nextIoTurn(probePath);
	}
	if (!predicate()) throw new Error(`Daemon did not reach expected state: ${what}`);
}

async function withDaemon(
	idleGrace: string | undefined,
	fn: (daemon: {
		dir: string;
		running: Promise<void>;
		isExited: () => boolean;
		connect: () => Promise<DaemonConn>;
		waitForIdleTimer: () => Promise<void>;
		flush: () => Promise<void>;
		waitForExit: (what: string) => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dig-"));
	const saved = {
		dir: process.env[DAEMON_DIR_ENV],
		tcp: process.env[DAEMON_TCP_ENV],
		resume: process.env[DAEMON_RESUME_ENV],
		grace: process.env[IDLE_GRACE_ENV],
	};
	process.env[DAEMON_DIR_ENV] = dir;
	delete process.env[DAEMON_TCP_ENV];
	delete process.env[DAEMON_RESUME_ENV];
	if (idleGrace === undefined) delete process.env[IDLE_GRACE_ENV];
	else process.env[IDLE_GRACE_ENV] = idleGrace;

	const conns = new Set<DaemonConn>();
	let exited = false;
	let connectedTimers = 0;
	vi.useFakeTimers();
	const baselineTimers = vi.getTimerCount();
	const running = startDaemonFromEnvironment().finally(() => {
		exited = true;
	});
	try {
		await waitForCondition(dir, () => exited || vi.getTimerCount() > baselineTimers, "daemon startup idle timer");
		await flushIoTurns(dir, 2);
		await fn({
			dir,
			running,
			isExited: () => exited,
			connect: async () => {
				const token = (await fs.readFile(path.join(dir, "token"), "utf8")).trim();
				const conn = await DaemonConn.connect(ipcEndpoint(dir, "daemon"), token, () => {});
				conns.add(conn);
				void conn.closed.then(() => conns.delete(conn));
				connectedTimers = vi.getTimerCount();
				return conn;
			},
			waitForIdleTimer: () =>
				waitForCondition(
					dir,
					() => exited || vi.getTimerCount() > connectedTimers,
					"daemon post-disconnect idle timer",
				),
			flush: () => flushIoTurns(dir),
			waitForExit: what => waitForCondition(dir, () => exited, what, 100),
		});
	} finally {
		await Promise.all([...conns].map(conn => conn.close()));
		if (!exited) {
			await waitForCondition(dir, () => exited || vi.getTimerCount() >= 1, "daemon teardown timer");
			for (let i = 0; i < 4 && !exited; i++) {
				vi.advanceTimersByTime(MAX_I32_TIMEOUT_MS);
				await flushIoTurns(dir);
			}
		}
		vi.useRealTimers();
		await running;
		if (saved.dir === undefined) delete process.env[DAEMON_DIR_ENV];
		else process.env[DAEMON_DIR_ENV] = saved.dir;
		if (saved.tcp === undefined) delete process.env[DAEMON_TCP_ENV];
		else process.env[DAEMON_TCP_ENV] = saved.tcp;
		if (saved.resume === undefined) delete process.env[DAEMON_RESUME_ENV];
		else process.env[DAEMON_RESUME_ENV] = saved.resume;
		if (saved.grace === undefined) delete process.env[IDLE_GRACE_ENV];
		else process.env[IDLE_GRACE_ENV] = saved.grace;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("daemon OMP_DAEMON_IDLE_GRACE_MS", () => {
	it("waits for the first client when set to 0, then exits as soon as the last client disconnects", async () => {
		await withDaemon("0", async ({ dir, running, isExited, connect, waitForIdleTimer, flush, waitForExit }) => {
			// Spawning clients retry dialing on a 50ms cadence: `0` must not shut a fresh daemon down before its first client connects.
			vi.advanceTimersByTime(2_999);
			await flush();
			expect(isExited()).toBe(false);

			const conn = await connect();
			const pong = await conn.request({ op: "ping" });
			expect(pong.pid).toBe(process.pid);
			await conn.close();
			await waitForIdleTimer();

			vi.advanceTimersByTime(0);
			await waitForExit("immediate idle exit");
			await running;
			expect(FileLock.isHeld(path.join(dir, "daemon.lock"))).toBe(false);
		});
	});

	it("parses the base-10 parseInt prefix for unit-suffixed and fractional values", async () => {
		for (const [raw, expectedMs] of [
			["5s", 5],
			["2.5", 2],
		] as const) {
			await withDaemon(raw, async ({ running, isExited, connect, waitForIdleTimer, flush, waitForExit }) => {
				const conn = await connect();
				await conn.request({ op: "ping" });
				await conn.close();
				await waitForIdleTimer();

				vi.advanceTimersByTime(expectedMs - 1);
				await flush();
				expect(isExited()).toBe(false);

				vi.advanceTimersByTime(1);
				await waitForExit(`idle exit after ${expectedMs}ms`);
				await running;
			});
		}
	});

	it("falls back to the 3000ms default for empty, negative, or non-numeric values", async () => {
		for (const invalid of ["", "-1", "ms"]) {
			await withDaemon(invalid, async ({ running, isExited, connect, waitForIdleTimer, flush, waitForExit }) => {
				const conn = await connect();
				await conn.request({ op: "ping" });
				await conn.close();
				await waitForIdleTimer();

				vi.advanceTimersByTime(2_999);
				await flush();
				expect(isExited()).toBe(false);

				vi.advanceTimersByTime(1);
				await waitForExit("default 3000ms idle exit");
				await running;
			});
		}
	});

	it("chains timers above the 32-bit signed-integer limit instead of overflowing to an immediate exit", async () => {
		const graceMs = 3_000_000_000;
		await withDaemon(
			String(graceMs),
			async ({ running, isExited, connect, waitForIdleTimer, flush, waitForExit }) => {
				const conn = await connect();
				await conn.request({ op: "ping" });
				await conn.close();
				await waitForIdleTimer();

				vi.advanceTimersByTime(MAX_I32_TIMEOUT_MS);
				await flush();
				expect(isExited()).toBe(false);

				vi.advanceTimersByTime(graceMs - MAX_I32_TIMEOUT_MS - 1);
				await flush();
				expect(isExited()).toBe(false);

				vi.advanceTimersByTime(1);
				await waitForExit("chained idle exit");
				await running;
			},
		);
	});
});
