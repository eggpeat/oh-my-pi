import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock } from "@oh-my-pi/pi-natives";
import * as utils from "@oh-my-pi/pi-utils";
import { probeDaemon } from "../../src/daemon/client";
import { daemonLockPath } from "../../src/daemon/paths";
import {
	DAEMON_DIR_ENV,
	DAEMON_IDLE_EXIT_GRACE_MS,
	DAEMON_RESUME_ENV,
	DAEMON_RESUME_LEASE_GRACE_ENV,
	DAEMON_RESUME_LEASE_GRACE_MS,
	DAEMON_TCP_ENV,
	type DaemonClient,
	GLOBAL_SCOPE,
} from "../../src/daemon/protocol";
import { startDaemonFromEnvironment } from "../../src/daemon/server";
import { shProc } from "../fixtures/daemon-proc-harness";

const IDLE_GRACE_ENV = "OMP_DAEMON_IDLE_GRACE_MS";
const TEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let tempDir: string | undefined;
let previousDir: string | undefined;
let previousTcp: string | undefined;
let previousGrace: string | undefined;
let previousLeaseGrace: string | undefined;
let previousResume: string | undefined;
let activeDaemon: { run: Promise<void>; settled: boolean } | undefined;

async function startTestDaemon(
	graceValue: string | undefined,
	leaseGraceValue?: string,
): Promise<{
	run: Promise<void>;
	waitStartupIdleArmed: () => Promise<void>;
	disconnect: (client: DaemonClient) => Promise<void>;
	idleSignal: () => AbortSignal | undefined;
}> {
	if (graceValue === undefined) delete process.env[IDLE_GRACE_ENV];
	else process.env[IDLE_GRACE_ENV] = graceValue;
	if (leaseGraceValue === undefined) delete process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
	else process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = leaseGraceValue;

	vi.useFakeTimers();
	const fakeSetTimeout = globalThis.setTimeout;
	let timerCount = 0;
	const waiters = new Set<() => void>();
	const noteArmed = (): void => {
		timerCount++;
		const pending = [...waiters];
		waiters.clear();
		for (const wake of pending) wake();
	};
	// Idle exit waits through `scheduler.wait` (`sleepLong`). Lease and unit timers still use `setTimeout`.
	// Counting either one only tells the test that the wait was armed; it is not an assertion.
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((
		fn: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		const handle = fakeSetTimeout(fn, delay, ...args);
		noteArmed();
		return handle;
	}) as typeof setTimeout);
	const realWait = scheduler.wait.bind(scheduler);
	let pendingIdleSignal: AbortSignal | undefined;
	vi.spyOn(scheduler, "wait").mockImplementation((delayMs, options) => {
		if (options?.signal) pendingIdleSignal = options.signal;
		noteArmed();
		return realWait(delayMs, options);
	});

	const waitUntil = async (ready: () => boolean): Promise<void> => {
		if (ready()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => {
			if (ready()) resolve();
			else waiters.add(wake);
		};
		waiters.add(wake);
		await promise;
	};

	const baselineAtStart = timerCount;
	const state = { run: Promise.resolve(), settled: false };
	const run = startDaemonFromEnvironment().finally(() => {
		state.settled = true;
		noteArmed();
	});
	state.run = run;
	activeDaemon = state;

	return {
		run,
		waitStartupIdleArmed: async (): Promise<void> => {
			await waitUntil(() => timerCount > baselineAtStart);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);
		},
		disconnect: async (client: DaemonClient): Promise<void> => {
			const beforeClose = timerCount;
			client.close();
			// A zero grace arms no timer: `sleepLong(0)` resolves on a microtask and the daemon exits.
			await waitUntil(() => timerCount > beforeClose || state.settled);
		},
		idleSignal: () => pendingIdleSignal,
	};
}

async function connectClient(): Promise<DaemonClient> {
	const client = await probeDaemon();
	if (!client) throw new Error("Expected test daemon to accept connection");
	return client;
}

async function expectDaemonExited(run: Promise<void>): Promise<void> {
	await run;
	expect(FileLock.isHeld(daemonLockPath())).toBe(false);
}

/** Whether `run` settled within a bounded number of event-loop turns. Does not advance fake timers. */
async function settlesWithin(run: Promise<void>, turns = 2_000): Promise<boolean> {
	let settled = false;
	void run.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; i < turns && !settled; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	return settled;
}

beforeEach(async () => {
	previousDir = process.env[DAEMON_DIR_ENV];
	previousTcp = process.env[DAEMON_TCP_ENV];
	previousGrace = process.env[IDLE_GRACE_ENV];
	previousLeaseGrace = process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
	previousResume = process.env[DAEMON_RESUME_ENV];
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-idle-grace-"));
	process.env[DAEMON_DIR_ENV] = tempDir;
	delete process.env[DAEMON_TCP_ENV];
	delete process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
	delete process.env[DAEMON_RESUME_ENV];
	// The daemon's OS process rename is outside this contract and must not rename the test runner.
	vi.spyOn(utils, "setProcessName").mockImplementation(() => {});
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (activeDaemon && !activeDaemon.settled) {
		const client = await probeDaemon();
		if (client) {
			try {
				await client.request({ op: "shutdown" });
			} catch {
				// Daemon may already be shutting down.
			} finally {
				client.close();
			}
		}
		await activeDaemon.run.catch(() => undefined);
	}
	activeDaemon = undefined;
	if (previousDir === undefined) delete process.env[DAEMON_DIR_ENV];
	else process.env[DAEMON_DIR_ENV] = previousDir;
	if (previousTcp === undefined) delete process.env[DAEMON_TCP_ENV];
	else process.env[DAEMON_TCP_ENV] = previousTcp;
	if (previousGrace === undefined) delete process.env[IDLE_GRACE_ENV];
	else process.env[IDLE_GRACE_ENV] = previousGrace;
	if (previousLeaseGrace === undefined) delete process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
	else process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = previousLeaseGrace;
	if (previousResume === undefined) delete process.env[DAEMON_RESUME_ENV];
	else process.env[DAEMON_RESUME_ENV] = previousResume;
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("OMP_DAEMON_IDLE_GRACE_MS", () => {
	it(
		"waits the configured grace, resets on reconnect ping before deadline, and exits cleanly with released lock",
		async () => {
			const { run, waitStartupIdleArmed, disconnect, idleSignal } = await startTestDaemon("600");
			await waitStartupIdleArmed();

			const first = await connectClient();
			expect((await first.request({ op: "ping" })).pid).toBe(process.pid);
			await disconnect(first);
			const grace = idleSignal();
			expect(grace).toBeDefined();
			expect(grace!.aborted).toBe(false);

			vi.advanceTimersByTime(599);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);

			const second = await connectClient();
			expect(grace!.aborted).toBe(true);
			expect((await second.request({ op: "ping" })).pid).toBe(process.pid);
			await disconnect(second);

			vi.advanceTimersByTime(599);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);

			vi.advanceTimersByTime(1);
			await expectDaemonExited(run);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"ignores a backward wall-clock jump while the idle wait runs",
		async () => {
			const { run, waitStartupIdleArmed, disconnect } = await startTestDaemon("600");
			await waitStartupIdleArmed();

			const client = await connectClient();
			expect((await client.request({ op: "ping" })).pid).toBe(process.pid);
			await disconnect(client);

			vi.advanceTimersByTime(100);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);

			// bun:test has no setSystemTime. Move Date.now back an hour without touching the monotonic clock.
			const clock = Date.now.bind(Date);
			Date.now = () => clock() - 3_600_000;
			try {
				expect(FileLock.isHeld(daemonLockPath())).toBe(true);
				vi.advanceTimersByTime(499);
				expect(FileLock.isHeld(daemonLockPath())).toBe(true);
				vi.advanceTimersByTime(1);
				expect(await settlesWithin(run)).toBe(true);
				expect(FileLock.isHeld(daemonLockPath())).toBe(false);
			} finally {
				Date.now = clock;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"with value 0, stays up for the initial client dial and shuts down immediately after disconnect",
		async () => {
			const { run, waitStartupIdleArmed, disconnect } = await startTestDaemon("0");
			await waitStartupIdleArmed();

			vi.advanceTimersByTime(50);
			const client = await probeDaemon();
			expect(client).toBeDefined();
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);
			expect((await client!.request({ op: "ping" })).pid).toBe(process.pid);
			await disconnect(client!);

			vi.advanceTimersByTime(0);
			await expectDaemonExited(run);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"splits a grace above the 32-bit timer limit and cancels it on reconnect",
		async () => {
			const { run, waitStartupIdleArmed, disconnect } = await startTestDaemon(String(MAX_TIMER_DELAY_MS + 5_000));
			await waitStartupIdleArmed();

			const first = await connectClient();
			await disconnect(first);
			vi.advanceTimersByTime(1);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);

			const second = await connectClient();
			expect((await second.request({ op: "ping" })).pid).toBe(process.pid);
			await disconnect(second);

			vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);
			vi.advanceTimersByTime(4_999);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);

			const third = await connectClient();
			expect((await third.request({ op: "ping" })).pid).toBe(process.pid);
			await disconnect(third);

			vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
			expect(FileLock.isHeld(daemonLockPath())).toBe(true);
			vi.advanceTimersByTime(5_000);
			await expectDaemonExited(run);
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"keeps the default reconnect lease grace when its separate variable is 0",
		async () => {
			const { waitStartupIdleArmed, disconnect } = await startTestDaemon("60000", "0");
			await waitStartupIdleArmed();

			const holder = await connectClient();
			const observer = await connectClient();
			const opened = await holder.open({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "zero-lease-grace",
				proc: shProc("exec sleep 60", tempDir!),
				policy: { idleMs: 0 },
			});
			expect(opened.lease).toBeDefined();

			const closedAt = Date.now();
			await disconnect(holder);
			const { unit } = await observer.request({ op: "describe", unit: "zero-lease-grace" });
			expect(unit.leases).toBe(0);
			expect(unit.idleAt).toBeGreaterThanOrEqual(closedAt + DAEMON_RESUME_LEASE_GRACE_MS);
			observer.close();
		},
		TEST_TIMEOUT_MS,
	);

	for (const { raw, expectedMs } of [
		{ raw: "5s", expectedMs: 5 },
		{ raw: "2.5", expectedMs: 2 },
	]) {
		it(
			`parses ${JSON.stringify(raw)} as base-10 parseInt prefix (${expectedMs}ms)`,
			async () => {
				const { run, waitStartupIdleArmed, disconnect } = await startTestDaemon(raw);
				await waitStartupIdleArmed();

				const first = await connectClient();
				await disconnect(first);

				vi.advanceTimersByTime(expectedMs - 1);
				expect(FileLock.isHeld(daemonLockPath())).toBe(true);

				const second = await connectClient();
				expect((await second.request({ op: "ping" })).pid).toBe(process.pid);
				await disconnect(second);

				vi.advanceTimersByTime(expectedMs);
				await expectDaemonExited(run);
			},
			TEST_TIMEOUT_MS,
		);
	}

	for (const raw of [undefined, "", "-1", "abc"]) {
		it(
			`falls back to ${DAEMON_IDLE_EXIT_GRACE_MS}ms when ${JSON.stringify(raw)}`,
			async () => {
				const { run, waitStartupIdleArmed, disconnect } = await startTestDaemon(raw);
				await waitStartupIdleArmed();

				const first = await connectClient();
				await disconnect(first);

				vi.advanceTimersByTime(DAEMON_IDLE_EXIT_GRACE_MS - 1);
				expect(FileLock.isHeld(daemonLockPath())).toBe(true);

				const second = await connectClient();
				expect((await second.request({ op: "ping" })).pid).toBe(process.pid);
				await disconnect(second);

				vi.advanceTimersByTime(DAEMON_IDLE_EXIT_GRACE_MS);
				await expectDaemonExited(run);
			},
			TEST_TIMEOUT_MS,
		);
	}
});
