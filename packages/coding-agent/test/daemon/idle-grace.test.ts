import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock, IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import {
	DAEMON_DIR_ENV,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_RESUME_ENV,
	DAEMON_TCP_ENV,
	DAEMON_WORKER_ARG,
} from "../../src/daemon/protocol";
import { DaemonConn } from "../fixtures/daemon-proc-harness";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "src", "cli.ts");
const IDLE_GRACE_ENV = "OMP_DAEMON_IDLE_GRACE_MS";
const MAX_I32_TIMEOUT_MS = 0x7fff_ffff;
const TEST_TIMEOUT_MS = 30_000;

/**
 * Preloaded only inside the spawned daemon child process so the test runner's
 * own process name, environment, and timers are never touched.
 *
 * Hooks `performance.now`, `Date.now`, `node:timers/promises` `scheduler.wait`,
 * and `setTimeout`/`clearTimeout` onto one IPC-driven monotonic clock while
 * reproducing the 32-bit signed-integer timer ceiling (`> 0x7fffffff` clamps to
 * `1` ms). Unref'd background timers (such as file-logger batching) do not emit
 * `armed` events.
 */
const CHILD_CLOCK_PRELOAD = `
import * as fs from "node:fs/promises";
import { scheduler } from "node:timers/promises";

const MAX_I32 = 0x7fffffff;
const epochBase = Date.now();
let now = 1_000;
let nextId = 1;
let armedEpoch = 0;
const timers = new Map();

function clampWait(delayMs) {
	const numeric = delayMs === undefined ? 0 : Number(delayMs);
	if (!Number.isFinite(numeric) || numeric > MAX_I32) return 1;
	return numeric < 0 ? 0 : Math.trunc(numeric);
}

function notifyIfStillRefed(id, waitMs) {
	queueMicrotask(() => {
		const entry = timers.get(id);
		if (entry && entry.refed) {
			armedEpoch++;
			process.send?.({ type: "armed", epoch: armedEpoch, waitMs });
		}
	});
}

performance.now = () => now;
Date.now = () => epochBase + now;

scheduler.wait = (delayMs, options) => {
	options?.signal?.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers();
	const id = nextId++;
	const waitMs = clampWait(delayMs);
	const onAbort = () => {
		timers.delete(id);
		reject(options?.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
	};
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	timers.set(id, {
		id,
		dueAt: now + waitMs,
		refed: true,
		fire: () => {
			options?.signal?.removeEventListener("abort", onAbort);
			resolve();
		},
	});
	notifyIfStillRefed(id, waitMs);
	return promise;
};

globalThis.setTimeout = (callback, delayMs, ...args) => {
	const id = nextId++;
	const waitMs = clampWait(delayMs);
	const entry = {
		id,
		dueAt: now + waitMs,
		refed: true,
		fire: () => callback(...args),
	};
	timers.set(id, entry);
	notifyIfStillRefed(id, waitMs);
	const handle = {
		[Symbol.toPrimitive]: () => id,
		ref: () => {
			entry.refed = true;
			return handle;
		},
		unref: () => {
			entry.refed = false;
			return handle;
		},
		hasRef: () => entry.refed,
		refresh: () => {
			entry.dueAt = now + waitMs;
			return handle;
		},
		close: () => {
			timers.delete(id);
		},
	};
	return handle;
};

globalThis.clearTimeout = handle => {
	if (handle === undefined || handle === null) return;
	const id = typeof handle === "number" ? handle : Number(handle);
	timers.delete(id);
};

async function flushMicrotasks() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function flushIo() {
	const dir = process.env.OMP_DAEMON_DIR;
	if (!dir) return;
	for (let i = 0; i < 20; i++) {
		try {
			await fs.stat(dir);
		} catch {
			break;
		}
	}
}

function nextDueTimer(maxDueAt) {
	let chosen;
	for (const entry of timers.values()) {
		if (maxDueAt !== undefined && entry.dueAt > maxDueAt) continue;
		if (!chosen || entry.dueAt < chosen.dueAt || (entry.dueAt === chosen.dueAt && entry.id < chosen.id)) {
			chosen = entry;
		}
	}
	return chosen;
}

let queue = Promise.resolve();
process.on("message", msg => {
	queue = queue.then(async () => {
		if (msg.type === "advance") {
			const target = now + msg.ms;
			for (;;) {
				const entry = nextDueTimer(target);
				if (!entry) break;
				timers.delete(entry.id);
				now = entry.dueAt;
				entry.fire();
				await flushMicrotasks();
			}
			now = target;
			await flushMicrotasks();
			await flushIo();
			process.send?.({ type: "ack", id: msg.id });
		} else if (msg.type === "fireNextLate") {
			let chosen;
			for (const entry of timers.values()) {
				if (!entry.refed) continue;
				if (!chosen || entry.dueAt < chosen.dueAt || (entry.dueAt === chosen.dueAt && entry.id < chosen.id)) {
					chosen = entry;
				}
			}
			if (chosen) {
				timers.delete(chosen.id);
				now += msg.elapsedMs;
				chosen.fire();
			}
			await flushMicrotasks();
			await flushIo();
			process.send?.({ type: "ack", id: msg.id });
		}
	});
});
process.channel?.unref?.();
`;

type ChildMessage = { type: "armed"; epoch: number; waitMs: number } | { type: "ack"; id: number };

class ControlledDaemon {
	readonly root: string;
	readonly dir: string;
	readonly endpoint: string;
	readonly lockPath: string;
	readonly #proc: Bun.Subprocess;
	readonly #conns = new Set<DaemonConn>();
	readonly #acks = new Map<number, () => void>();
	readonly #armedWaiters = new Set<() => void>();
	#armedEpoch = 0;
	#nextReqId = 1;

	constructor(
		root: string,
		dir: string,
		proc: Bun.Subprocess,
		onReady: { register: (fn: (msg: ChildMessage) => void) => void },
	) {
		this.root = root;
		this.dir = dir;
		this.endpoint = ipcEndpoint(dir, "daemon");
		this.lockPath = path.join(dir, "daemon.lock");
		this.#proc = proc;
		onReady.register(msg => this.#onMessage(msg));
		void proc.exited.then(() => {
			for (const waiter of this.#armedWaiters) waiter();
			this.#armedWaiters.clear();
			for (const resolve of this.#acks.values()) resolve();
			this.#acks.clear();
		});
	}

	static async spawn(
		idleGrace: string | undefined,
		track?: (daemon: ControlledDaemon) => void,
	): Promise<ControlledDaemon> {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-dig-")));
		const dir = path.join(root, "daemon");
		const preloadPath = path.join(root, "clock-preload.mjs");
		await fs.writeFile(preloadPath, CHILD_CLOCK_PRELOAD, "utf8");

		const env: Record<string, string> = {};
		for (const name in process.env) {
			const value = process.env[name];
			if (typeof value === "string") env[name] = value;
		}
		delete env[DAEMON_TCP_ENV];
		delete env[DAEMON_RESUME_ENV];
		env[DAEMON_DIR_ENV] = dir;
		env.PI_TEST_RUNTIME = "1";
		env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		if (idleGrace === undefined) delete env[IDLE_GRACE_ENV];
		else env[IDLE_GRACE_ENV] = idleGrace;

		let handler: ((msg: ChildMessage) => void) | undefined;
		const buffered: ChildMessage[] = [];
		const proc = Bun.spawn([process.execPath, "--preload", preloadPath, CLI_ENTRY, DAEMON_WORKER_ARG], {
			cwd: PACKAGE_ROOT,
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: Bun.file(path.join(root, "daemon.stderr")),
			ipc(message) {
				const msg = message as ChildMessage;
				if (handler) handler(msg);
				else buffered.push(msg);
			},
		});
		const instance = new ControlledDaemon(root, dir, proc, {
			register(fn) {
				handler = fn;
				for (const msg of buffered) fn(msg);
				buffered.length = 0;
			},
		});
		track?.(instance);
		try {
			await instance.waitForIdleOrExit(0);
			if (!instance.running) {
				const stderr = await fs.readFile(path.join(root, "daemon.stderr"), "utf8").catch(() => "");
				throw new Error(`Daemon exited during startup (${proc.exitCode ?? proc.signalCode}): ${stderr}`);
			}
			return instance;
		} catch (error) {
			await instance.dispose();
			throw error;
		}
	}

	get pid(): number {
		return this.#proc.pid;
	}

	get armedEpoch(): number {
		return this.#armedEpoch;
	}

	get running(): boolean {
		return this.#proc.exitCode === null && this.#proc.signalCode === null;
	}

	get lockHeld(): boolean {
		return FileLock.isHeld(this.lockPath);
	}

	get exited(): Promise<number> {
		return this.#proc.exited;
	}

	async connect(): Promise<DaemonConn> {
		const token = (await fs.readFile(path.join(this.dir, "token"), "utf8")).trim();
		const conn = await DaemonConn.connect(this.endpoint, token, () => {});
		this.#conns.add(conn);
		void conn.closed.then(() => this.#conns.delete(conn));
		return conn;
	}

	async waitForIdleOrExit(afterEpoch: number): Promise<void> {
		while (this.running && this.#armedEpoch <= afterEpoch) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#armedWaiters.add(resolve);
			await promise;
		}
	}

	async advance(ms: number): Promise<void> {
		if (!this.running) return;
		const id = this.#nextReqId++;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#acks.set(id, resolve);
		this.#proc.send({ type: "advance", id, ms });
		await promise;
	}

	async fireNextLate(elapsedMs: number): Promise<void> {
		if (!this.running) return;
		const id = this.#nextReqId++;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#acks.set(id, resolve);
		this.#proc.send({ type: "fireNextLate", id, elapsedMs });
		await promise;
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.#conns].map(conn => conn.close().catch(() => undefined)));
		this.#conns.clear();
		if (this.running) {
			this.#proc.kill("SIGKILL");
			await this.#proc.exited;
		}
		await fs.rm(this.root, { recursive: true, force: true });
	}

	#onMessage(msg: ChildMessage): void {
		if (msg.type === "armed") {
			this.#armedEpoch = Math.max(this.#armedEpoch, msg.epoch);
			for (const waiter of this.#armedWaiters) waiter();
			this.#armedWaiters.clear();
		} else if (msg.type === "ack") {
			const resolve = this.#acks.get(msg.id);
			if (resolve) {
				this.#acks.delete(msg.id);
				resolve();
			}
		}
	}
}

const activeDaemons = new Set<ControlledDaemon>();

function startControlledDaemon(idleGrace: string | undefined): Promise<ControlledDaemon> {
	return ControlledDaemon.spawn(idleGrace, instance => {
		activeDaemons.add(instance);
	});
}

afterEach(async () => {
	const daemons = [...activeDaemons];
	activeDaemons.clear();
	await Promise.all(daemons.map(daemon => daemon.dispose()));
});

async function openAndCloseRawProbe(endpoint: string, line?: string): Promise<void> {
	const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 1_000 });
	const closed = Promise.withResolvers<void>();
	conn.start(
		() => {},
		() => closed.resolve(),
	);
	if (line !== undefined) {
		conn.send(line);
		conn.end();
	} else {
		conn.destroy();
	}
	await closed.promise;
}

describe("daemon OMP_DAEMON_IDLE_GRACE_MS", () => {
	it(
		"ignores pre-hello socket probes when set to 0, then exits at once after a signed-in client disconnects",
		async () => {
			const daemon = await startControlledDaemon("0");
			await daemon.advance(2_999);
			expect(daemon.running).toBe(true);

			// A raw readiness probe (open + close without hello) must not flip the daemon out of its startup grace.
			const epochBeforeRawProbe = daemon.armedEpoch;
			await openAndCloseRawProbe(daemon.endpoint);
			await daemon.waitForIdleOrExit(epochBeforeRawProbe);
			await daemon.advance(2_999);
			expect(daemon.running).toBe(true);

			// A connection whose hello is rejected also never signed in as a client.
			const epochBeforeBadHello = daemon.armedEpoch;
			await openAndCloseRawProbe(
				daemon.endpoint,
				JSON.stringify({
					v: DAEMON_PROTOCOL_VERSION,
					token: "wrong-token",
					client: { pid: process.pid, build: "0.0.0", exe: [] },
				}),
			);
			await daemon.waitForIdleOrExit(epochBeforeBadHello);
			await daemon.advance(2_999);
			expect(daemon.running).toBe(true);

			const conn = await daemon.connect();
			const pong = await conn.request({ op: "ping" });
			expect(pong.pid).toBe(daemon.pid);
			expect(pong.pid).not.toBe(process.pid);

			const epochBeforeClose = daemon.armedEpoch;
			await conn.close();
			await daemon.waitForIdleOrExit(epochBeforeClose);
			await daemon.advance(0);

			expect(daemon.lockHeld).toBe(false);
			expect(await daemon.exited).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"parses the base-10 parseInt prefix for unit-suffixed and fractional values",
		async () => {
			await Promise.all(
				(
					[
						["5s", 5],
						["2.5", 2],
					] as const
				).map(async ([raw, expectedMs]) => {
					const daemon = await startControlledDaemon(raw);
					const conn = await daemon.connect();
					await conn.request({ op: "ping" });
					const epochBeforeClose = daemon.armedEpoch;
					await conn.close();
					await daemon.waitForIdleOrExit(epochBeforeClose);

					await daemon.advance(expectedMs - 1);
					expect(daemon.lockHeld).toBe(true);
					expect(daemon.running).toBe(true);

					await daemon.advance(1);
					expect(daemon.lockHeld).toBe(false);
					expect(await daemon.exited).toBe(0);
				}),
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"falls back to the 3000ms default for empty, negative, or non-numeric values",
		async () => {
			await Promise.all(
				["", "-1", "ms"].map(async invalid => {
					const daemon = await startControlledDaemon(invalid);
					const conn = await daemon.connect();
					await conn.request({ op: "ping" });
					const epochBeforeClose = daemon.armedEpoch;
					await conn.close();
					await daemon.waitForIdleOrExit(epochBeforeClose);

					await daemon.advance(2_999);
					expect(daemon.lockHeld).toBe(true);
					expect(daemon.running).toBe(true);

					await daemon.advance(1);
					expect(daemon.lockHeld).toBe(false);
					expect(await daemon.exited).toBe(0);
				}),
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"waits past the 32-bit timer ceiling, cancels on reconnect, and exits without extra chunks after a late timer",
		async () => {
			const graceMs = 3_000_000_000;
			const daemon = await startControlledDaemon(String(graceMs));

			const first = await daemon.connect();
			await first.request({ op: "ping" });
			const epochAfterFirst = daemon.armedEpoch;
			await first.close();
			await daemon.waitForIdleOrExit(epochAfterFirst);

			await daemon.advance(MAX_I32_TIMEOUT_MS);
			expect(daemon.lockHeld).toBe(true);
			expect(daemon.running).toBe(true);

			// A returning client cancels the in-flight sleepLong; disconnecting starts a fresh grace window.
			const second = await daemon.connect();
			await second.request({ op: "ping" });
			const epochAfterSecond = daemon.armedEpoch;
			await second.close();
			await daemon.waitForIdleOrExit(epochAfterSecond);

			await daemon.advance(graceMs - 1);
			expect(daemon.lockHeld).toBe(true);
			expect(daemon.running).toBe(true);

			// Re-arm once more and simulate the first 32-bit timer chunk waking after the full deadline already elapsed.
			const third = await daemon.connect();
			await third.request({ op: "ping" });
			const epochAfterThird = daemon.armedEpoch;
			await third.close();
			await daemon.waitForIdleOrExit(epochAfterThird);

			await daemon.fireNextLate(graceMs);
			expect(daemon.lockHeld).toBe(false);
			expect(await daemon.exited).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
