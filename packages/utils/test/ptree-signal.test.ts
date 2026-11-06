import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { AbortError, exec, spawn } from "@oh-my-pi/pi-utils/ptree";

async function nextTurn(): Promise<void> {
	// Root-exit cleanup removes an abort listener in a microtask. A macrotask
	// boundary is the earliest point where that removal has definitely run.
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

async function orphanStopped(pid: number): Promise<boolean> {
	const deadline = Date.now() + 500;
	let status = Process.fromPid(pid)?.status();
	while (status === ProcessStatus.Running && Date.now() < deadline) {
		await Bun.sleep(10);
		status = Process.fromPid(pid)?.status();
	}
	return status !== ProcessStatus.Running;
}

describe("ptree signal abort handling", () => {
	it("does not trigger unhandledRejection when spawned with a pre-aborted signal", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const signal = AbortSignal.abort(new Error("pre-aborted"));
			using child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { signal });
			await child.nothrow().text();
			await child.proc.exited;

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not trigger unhandledRejection when exec is called with an aborted signal and allowAbort", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const signal = AbortSignal.abort(new Error("pre-aborted"));
			const result = await exec(["bun", "-e", "setInterval(() => {}, 1000)"], {
				signal,
				allowAbort: true,
			});

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(result.ok).toBe(false);
			expect(result.exitError).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not trigger unhandledRejection when signal aborts mid-execution", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const controller = new AbortController();
			using child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
				signal: controller.signal,
			});
			controller.abort(new Error("aborted mid-run"));
			await child.nothrow().text();
			await child.proc.exited;

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it.skipIf(process.platform === "win32")(
		"aborts collection after the detached root exits while a descendant holds its pipes",
		async () => {
			// The root exits after printing its child's pid. The child keeps the
			// group and the pipes alive, so an abort that was dropped at root exit
			// would leave wait() blocked until the child's inherited EOF.
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-orphan-"));
			const pidFile = path.join(dir, "pid");
			const controller = new AbortController();
			const child = spawn(["/bin/sh", "-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; echo token`], {
				detached: true,
				signal: controller.signal,
			});
			const pending = child.wait({ allowAbort: true, allowNonZero: true });
			let orphanPid: number | undefined;
			try {
				await child.exited;
				expect(child.exitCode).toBe(0);
				orphanPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				expect(orphanPid).toBeGreaterThan(0);
				await nextTurn();
				controller.abort(new Error("stop after exit"));

				const result = await pending;

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(await orphanStopped(orphanPid)).toBe(true);
			} finally {
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"aborts collection started after the detached root has already exited",
		async () => {
			// Root exit drops an idle abort listener. Collection that starts
			// afterwards must still see an abort that happened in between, and
			// must stop the pipe-holding descendant rather than wait for EOF.
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-orphan-"));
			const pidFile = path.join(dir, "pid");
			const controller = new AbortController();
			const child = spawn(["/bin/sh", "-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; echo token`], {
				detached: true,
				signal: controller.signal,
			});
			let orphanPid: number | undefined;
			try {
				await child.exited;
				expect(child.exitCode).toBe(0);
				orphanPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				expect(orphanPid).toBeGreaterThan(0);
				await nextTurn();
				controller.abort(new Error("stop before wait"));

				const result = await child.wait({ allowAbort: true, allowNonZero: true });

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(await orphanStopped(orphanPid)).toBe(true);
			} finally {
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"aborts collection after the root exits when a descendant holds a pipe outside the process group",
		async () => {
			// Hooks and custom tools cancel through exec() with no process group
			// and no deadline. After the root exits, only reader cutoff can end
			// the wait; signalling the dead pid is not identity-safe.
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-orphan-"));
			const pidFile = path.join(dir, "pid");
			const controller = new AbortController();
			const child = spawn(["/bin/sh", "-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; echo token`], {
				signal: controller.signal,
			});
			const pending = child.wait({ allowAbort: true, allowNonZero: true });
			let orphanPid: number | undefined;
			try {
				await child.exited;
				expect(child.exitCode).toBe(0);
				orphanPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				expect(orphanPid).toBeGreaterThan(0);
				await nextTurn();
				controller.abort(new Error("stop after exit"));

				const result = await pending;

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(Process.fromPid(orphanPid)?.status()).toBe(ProcessStatus.Running);
			} finally {
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "win32")(
		"aborts collection after the Windows root exits while a descendant holds its pipes",
		async () => {
			// Windows has no process groups. The probe exits after starting a
			// child that inherits stdout, so the retained root handle must anchor
			// the Toolhelp walk when abort arrives after that exit.
			const probe = `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`;
			const controller = new AbortController();
			const child = spawn([process.execPath, probe], { signal: controller.signal });
			const pending = child.wait({ allowAbort: true, allowNonZero: true });
			let descendantPid: number | undefined;
			try {
				await child.exited;
				expect(child.exitCode).toBe(0);
				await nextTurn();
				controller.abort(new Error("stop after exit"));

				const result = await pending;

				expect(result.exitError).toBeInstanceOf(AbortError);
				descendantPid = Number.parseInt(result.stdout.trim(), 10);
				expect(descendantPid).toBeGreaterThan(0);
				expect(await orphanStopped(descendantPid)).toBe(true);
			} finally {
				if (descendantPid) Process.fromPid(descendantPid)?.killTree(9);
			}
		},
	);

	for (const method of ["text", "bytes"] as const) {
		it.skipIf(process.platform === "win32")(
			`rejects ${method} when aborted after the detached root exits while a descendant holds stdout`,
			async () => {
				const controller = new AbortController();
				const child = spawn(["/bin/sh", "-c", "sleep 30 & echo token"], {
					detached: true,
					signal: controller.signal,
				});
				const pending = child[method]();
				try {
					await child.exited;
					expect(child.exitCode).toBe(0);
					await nextTurn();
					controller.abort(new Error("stop after exit"));

					let threw: unknown;
					try {
						await pending;
					} catch (error) {
						threw = error;
					}
					expect(threw).toBeInstanceOf(AbortError);
				} finally {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}
			},
		);
	}
});
