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
import type { DaemonClockCommand, DaemonClockEvent } from "../fixtures/daemon-clock-preload";
import { DaemonConn } from "../fixtures/daemon-proc-harness";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "src", "cli.ts");
const CLOCK_PRELOAD = path.resolve(import.meta.dir, "..", "fixtures", "daemon-clock-preload.ts");
const PRELOAD_ACTIVE_ENV = "OMP_TEST_CLOCK_PRELOAD";
const IDLE_GRACE_ENV = "OMP_DAEMON_IDLE_GRACE_MS";
const MAX_I32_TIMEOUT_MS = 0x7fff_ffff;
const TEST_TIMEOUT_MS = 30_000;

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
	#refedTimers = 0;
	#nextReqId = 1;

	constructor(
		root: string,
		dir: string,
		proc: Bun.Subprocess,
		onReady: { register: (fn: (msg: DaemonClockEvent) => void) => void },
	) {
		this.root = root;
		this.dir = dir;
		this.endpoint = ipcEndpoint(dir, "daemon");
		this.lockPath = path.join(dir, "daemon.lock");
		this.#proc = proc;
		onReady.register(msg => this.#onMessage(msg));
		void proc.exited.then(() => {
			this.#refedTimers = 0;
			for (const waiter of this.#armedWaiters) waiter();
			this.#armedWaiters.clear();
			for (const resolve of this.#acks.values()) resolve();
			this.#acks.clear();
		});
	}

	static async spawn(
		idleGrace: string | undefined,
		track: (daemon: ControlledDaemon) => void,
	): Promise<ControlledDaemon> {
		const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dig-"));
		let root = rawRoot;
		try {
			root = await fs.realpath(rawRoot);
		} catch (error) {
			await fs.rm(rawRoot, { recursive: true, force: true });
			throw error;
		}
		const dir = path.join(root, "daemon");

		const env: Record<string, string> = {};
		for (const name in process.env) {
			const value = process.env[name];
			if (typeof value === "string") env[name] = value;
		}
		delete env[DAEMON_TCP_ENV];
		delete env[DAEMON_RESUME_ENV];
		env[DAEMON_DIR_ENV] = dir;
		env[PRELOAD_ACTIVE_ENV] = "1";
		env.PI_TEST_RUNTIME = "1";
		env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		if (idleGrace === undefined) delete env[IDLE_GRACE_ENV];
		else env[IDLE_GRACE_ENV] = idleGrace;

		let handler: ((msg: DaemonClockEvent) => void) | undefined;
		const buffered: DaemonClockEvent[] = [];
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn([process.execPath, "--preload", CLOCK_PRELOAD, CLI_ENTRY, DAEMON_WORKER_ARG], {
				cwd: PACKAGE_ROOT,
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: Bun.file(path.join(root, "daemon.stderr")),
				ipc(message) {
					const msg = message as DaemonClockEvent;
					if (handler) handler(msg);
					else buffered.push(msg);
				},
			});
		} catch (error) {
			await fs.rm(root, { recursive: true, force: true });
			throw error;
		}
		const instance = new ControlledDaemon(root, dir, proc, {
			register(fn) {
				handler = fn;
				for (const msg of buffered) fn(msg);
				buffered.length = 0;
			},
		});
		track(instance);
		try {
			await instance.waitForIdleOrExit(0);
			if (!instance.running) {
				const stderr = await Bun.file(path.join(root, "daemon.stderr"))
					.text()
					.catch(() => "");
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

	get refedTimers(): number {
		return this.#refedTimers;
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
		const token = (await Bun.file(path.join(this.dir, "token")).text()).trim();
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
		await this.#sendCommand(id => ({ type: "advance", id, ms }));
	}

	async fireNextLate(elapsedMs: number): Promise<void> {
		await this.#sendCommand(id => ({ type: "fireNextLate", id, elapsedMs }));
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

	async #sendCommand(build: (id: number) => DaemonClockCommand): Promise<void> {
		if (!this.running) return;
		const id = this.#nextReqId++;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#acks.set(id, resolve);
		this.#proc.send(build(id));
		await promise;
	}

	#onMessage(msg: DaemonClockEvent): void {
		this.#refedTimers = msg.refedTimers;
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

async function runAllCases<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
	const results = await Promise.allSettled(items.map(item => run(item)));
	const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;
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

			expect(daemon.refedTimers).toBe(0);
			expect(await daemon.exited).toBe(0);
			expect(daemon.lockHeld).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"parses the base-10 parseInt prefix for unit-suffixed and fractional values",
		async () => {
			await runAllCases(
				[
					["5s", 5],
					["2.5", 2],
				] as const,
				async ([raw, expectedMs]) => {
					const daemon = await startControlledDaemon(raw);
					const conn = await daemon.connect();
					await conn.request({ op: "ping" });
					const epochBeforeClose = daemon.armedEpoch;
					await conn.close();
					await daemon.waitForIdleOrExit(epochBeforeClose);

					await daemon.advance(expectedMs - 1);
					expect(daemon.refedTimers).toBe(1);
					expect(daemon.running).toBe(true);
					expect(daemon.lockHeld).toBe(true);

					await daemon.advance(1);
					expect(daemon.refedTimers).toBe(0);
					expect(await daemon.exited).toBe(0);
					expect(daemon.lockHeld).toBe(false);
				},
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"falls back to the 3000ms default for empty, negative, or non-numeric values",
		async () => {
			await runAllCases(["", "-1", "ms"], async invalid => {
				const daemon = await startControlledDaemon(invalid);
				const conn = await daemon.connect();
				await conn.request({ op: "ping" });
				const epochBeforeClose = daemon.armedEpoch;
				await conn.close();
				await daemon.waitForIdleOrExit(epochBeforeClose);

				await daemon.advance(2_999);
				expect(daemon.refedTimers).toBe(1);
				expect(daemon.running).toBe(true);
				expect(daemon.lockHeld).toBe(true);

				await daemon.advance(1);
				expect(daemon.refedTimers).toBe(0);
				expect(await daemon.exited).toBe(0);
				expect(daemon.lockHeld).toBe(false);
			});
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
			expect(daemon.refedTimers).toBe(1);
			expect(daemon.running).toBe(true);
			expect(daemon.lockHeld).toBe(true);

			// A returning client cancels the in-flight sleepLong; disconnecting starts a fresh grace window.
			const second = await daemon.connect();
			await second.request({ op: "ping" });
			const epochAfterSecond = daemon.armedEpoch;
			await second.close();
			await daemon.waitForIdleOrExit(epochAfterSecond);

			await daemon.advance(graceMs - 1);
			expect(daemon.refedTimers).toBe(1);
			expect(daemon.running).toBe(true);
			expect(daemon.lockHeld).toBe(true);

			// Re-arm once more and simulate the first 32-bit timer chunk waking after the full deadline already elapsed.
			const third = await daemon.connect();
			await third.request({ op: "ping" });
			const epochAfterThird = daemon.armedEpoch;
			await third.close();
			await daemon.waitForIdleOrExit(epochAfterThird);

			await daemon.fireNextLate(graceMs);
			expect(daemon.refedTimers).toBe(0);
			expect(await daemon.exited).toBe(0);
			expect(daemon.lockHeld).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
