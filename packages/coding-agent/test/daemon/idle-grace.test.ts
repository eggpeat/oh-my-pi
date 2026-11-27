/**
 * The daemon's idle-exit grace (`OMP_DAEMON_IDLE_GRACE_MS`): how long the daemon waits after its
 * last client disconnects before it shuts down. The wait only starts once nothing holds the daemon
 * open, so a supervised service that keeps it alive is never stopped by this timer. Read once when
 * the daemon starts, with the base-10 `parseInt` prefix; `0` exits at once, negative values and
 * values without leading digits use the default (3 s).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { TestDaemon } from "../fixtures/daemon-proc-harness";

/** The documented idle-grace variable (`docs/environment-variables.md`). */
const IDLE_GRACE_ENV = "OMP_DAEMON_IDLE_GRACE_MS";

const TEST_TIMEOUT_MS = 30_000;
/** The default grace (3 s) the daemon falls back to; long enough to tell it apart from `0`. */
const DEFAULT_GRACE_MS = 3_000;

let daemon: TestDaemon | undefined;

afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

/** A daemon with the given idle grace, whose only client has already disconnected. */
async function startedDaemon(grace: string): Promise<TestDaemon> {
	const started = await TestDaemon.start({ env: { [IDLE_GRACE_ENV]: grace } });
	daemon = started.daemon;
	await started.conn.close();
	return started.daemon;
}

/** Whether the daemon is gone within `timeoutMs`, with its exit code. */
async function exitCodeWithin(daemon: TestDaemon, timeoutMs: number): Promise<number | undefined> {
	return await Promise.race([daemon.exited, Bun.sleep(timeoutMs).then(() => undefined)]);
}

describe.skipIf(process.platform === "win32")("daemon idle grace", () => {
	it(
		"shuts down as soon as the last client disconnects when the grace is 0",
		async () => {
			const daemon = await startedDaemon("0");

			expect(await exitCodeWithin(daemon, DEFAULT_GRACE_MS / 2)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps running past the default grace and shuts down after a longer grace",
		async () => {
			// A numeric prefix: only the leading digits count.
			const daemon = await startedDaemon("6000ms");

			await Bun.sleep(DEFAULT_GRACE_MS + 500);
			expect(daemon.running).toBe(true);
			expect(await exitCodeWithin(daemon, 10_000)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"falls back to the default grace when the value has no leading digits",
		async () => {
			const daemon = await startedDaemon("abc");

			await Bun.sleep(DEFAULT_GRACE_MS / 2);
			expect(daemon.running).toBe(true);
			expect(await exitCodeWithin(daemon, DEFAULT_GRACE_MS * 2)).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"caps a grace that overflows instead of falling back to the default",
		async () => {
			const daemon = await startedDaemon("9".repeat(320));

			await Bun.sleep(DEFAULT_GRACE_MS + 500);
			expect(daemon.running).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});
