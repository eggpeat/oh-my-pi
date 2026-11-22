/**
 * Preloaded into an isolated `__omp_worker_daemon` child process by
 * `test/daemon/idle-grace.test.ts` so tests drive the daemon's idle clock over
 * Bun IPC without sleeping or touching the test runner process.
 *
 * Hooks `performance.now`, `Date.now`, `node:timers/promises` `scheduler.wait`,
 * and `setTimeout`/`clearTimeout` onto one monotonic queue while reproducing
 * the 32-bit signed-integer timer ceiling (`> 0x7fffffff` clamps to `1` ms).
 * Unref'd background timers (such as file-logger batching) do not count as
 * daemon idle timers.
 */
import { scheduler } from "node:timers/promises";

export type DaemonClockEvent =
	| { type: "armed"; epoch: number; waitMs: number; refedTimers: number }
	| { type: "ack"; id: number; refedTimers: number };

export type DaemonClockCommand =
	| { type: "advance"; id: number; ms: number }
	| { type: "fireNextLate"; id: number; elapsedMs: number };

interface ScheduledTimer {
	id: number;
	dueAt: number;
	refed: boolean;
	fire: () => void;
}

const PRELOAD_ACTIVE_ENV = "OMP_TEST_CLOCK_PRELOAD";
const MAX_I32_TIMEOUT_MS = 0x7fff_ffff;

function clampWait(delayMs: unknown): number {
	const numeric = delayMs === undefined ? 0 : Number(delayMs);
	if (!Number.isFinite(numeric) || numeric > MAX_I32_TIMEOUT_MS) return 1;
	return numeric < 0 ? 0 : Math.trunc(numeric);
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function installDaemonClockPreload(): void {
	const epochBase = Date.now();
	let now = 1_000;
	let nextId = 1;
	let armedEpoch = 0;
	const timers = new Map<number, ScheduledTimer>();

	const countRefedTimers = (): number => {
		let count = 0;
		for (const entry of timers.values()) {
			if (entry.refed) count++;
		}
		return count;
	};

	const send = (event: DaemonClockEvent): void => {
		process.send?.(event);
	};

	const notifyIfStillRefed = (id: number, waitMs: number): void => {
		queueMicrotask(() => {
			const entry = timers.get(id);
			if (entry?.refed) {
				armedEpoch++;
				send({ type: "armed", epoch: armedEpoch, waitMs, refedTimers: countRefedTimers() });
			}
		});
	};

	const nextDueTimer = (maxDueAt: number): ScheduledTimer | undefined => {
		let chosen: ScheduledTimer | undefined;
		for (const entry of timers.values()) {
			if (entry.dueAt > maxDueAt) continue;
			if (!chosen || entry.dueAt < chosen.dueAt || (entry.dueAt === chosen.dueAt && entry.id < chosen.id)) {
				chosen = entry;
			}
		}
		return chosen;
	};

	performance.now = () => now;
	Date.now = () => epochBase + now;

	scheduler.wait = ((delayMs: number, options?: { signal?: AbortSignal }): Promise<void> => {
		options?.signal?.throwIfAborted();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const id = nextId++;
		const waitMs = clampWait(delayMs);
		const onAbort = (): void => {
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
	}) as typeof scheduler.wait;

	globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
		const id = nextId++;
		const waitMs = clampWait(delayMs);
		const entry: ScheduledTimer = {
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
		return handle as unknown as NodeJS.Timeout;
	}) as unknown as typeof setTimeout;

	globalThis.clearTimeout = ((handle?: NodeJS.Timeout) => {
		if (handle === undefined || handle === null) return;
		const id = typeof handle === "number" ? handle : Number(handle);
		timers.delete(id);
	}) as typeof clearTimeout;

	let queue = Promise.resolve();
	process.on("message", (raw: unknown) => {
		const msg = raw as DaemonClockCommand;
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
				send({ type: "ack", id: msg.id, refedTimers: countRefedTimers() });
			} else if (msg.type === "fireNextLate") {
				let chosen: ScheduledTimer | undefined;
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
				send({ type: "ack", id: msg.id, refedTimers: countRefedTimers() });
			}
		});
	});
	(process as NodeJS.Process & { channel?: { unref?: () => void } }).channel?.unref?.();
}

if (process.env[PRELOAD_ACTIVE_ENV] === "1") {
	delete process.env[PRELOAD_ACTIVE_ENV];
	installDaemonClockPreload();
}
