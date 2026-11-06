import { describe, expect, it, spyOn } from "bun:test";
import { watch as fsWatch } from "node:fs";
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

	it.skipIf(process.platform === "win32")(
		"keeps output open during graceful shutdown on abort and then cuts off leftover child output",
		async () => {
			// Closing stdout immediately on abort kills a SIGTERM cleanup handler
			// with SIGPIPE when it prints. In the direct-signal fallback, the
			// background child also survives SIGTERM to the shell, so readers must
			// be cut off once the shell's graceful stop finishes.
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-cleanup-"));
			const pidFile = path.join(dir, "pid");
			const marker = path.join(dir, "cleaned");
			const ready = Promise.withResolvers<void>();
			const checkReady = async () => {
				const text = await Bun.file(pidFile)
					.text()
					.catch(() => "");
				if (Number.parseInt(text.trim(), 10) > 0) ready.resolve();
			};
			const watcher = fsWatch(dir, () => {
				void checkReady();
			});
			const fromPidSpy = spyOn(Process, "fromPid").mockReturnValue(null);
			let orphanPid: number | undefined;
			try {
				const controller = new AbortController();
				const child = spawn(
					[
						"/bin/sh",
						"-c",
						`trap 'echo cleanup-stdout; echo cleaned > ${JSON.stringify(marker)}; exit 0' TERM; sleep 30 & echo $! > ${JSON.stringify(`${pidFile}.tmp`)} && mv ${JSON.stringify(`${pidFile}.tmp`)} ${JSON.stringify(pidFile)}; wait`,
					],
					{ signal: controller.signal },
				);
				const pending = child.wait({ allowAbort: true, allowNonZero: true });
				await checkReady();
				await ready.promise;
				orphanPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				expect(orphanPid).toBeGreaterThan(0);

				controller.abort(new Error("graceful stop"));
				const result = await pending;

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(result.stdout).toBe("cleanup-stdout\n");
				expect(await Bun.file(marker).text()).toBe("cleaned\n");
				expect(child.proc.signalCode).toBeNull();
			} finally {
				watcher.close();
				fromPidSpy.mockRestore();
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps output open when collection starts after abort and root exit while child shutdown is still in flight",
		async () => {
			// The root shell exits on SIGTERM while a child subshell is still
			// running its SIGTERM cleanup. Starting wait() after root exit must
			// keep stdout open until the ongoing termination finishes, then cut
			// off any leftover pipe holder.
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-late-collect-"));
			const pidFile = path.join(dir, "pid");
			const orphanFile = path.join(dir, "orphan");
			const marker = path.join(dir, "cleaned");
			const gate = path.join(dir, "gate");
			await Bun.spawn(["mkfifo", gate]).exited;
			const ready = Promise.withResolvers<void>();
			const checkReady = async () => {
				const text = await Bun.file(pidFile)
					.text()
					.catch(() => "");
				if (Number.parseInt(text.trim(), 10) > 0) ready.resolve();
			};
			const watcher = fsWatch(dir, () => {
				void checkReady();
			});
			let subshellSleepPid: number | undefined;
			let orphanPid: number | undefined;
			try {
				const controller = new AbortController();
				const script = `
(
	trap 'read _ < ${JSON.stringify(gate)}; sleep 30 & echo $! > ${JSON.stringify(orphanFile)}; echo cleanup-stdout; echo cleaned > ${JSON.stringify(marker)}; exit 0' TERM
	sleep 30 &
	echo $! > ${JSON.stringify(`${pidFile}.tmp`)} && mv ${JSON.stringify(`${pidFile}.tmp`)} ${JSON.stringify(pidFile)}
	wait
) &
trap 'exit 0' TERM
wait
`;
				const child = spawn(["/bin/sh", "-c", script], { signal: controller.signal });
				await checkReady();
				await ready.promise;
				subshellSleepPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				expect(subshellSleepPid).toBeGreaterThan(0);

				controller.abort(new Error("late collection"));
				await child.proc.exited;
				expect(child.proc.exitCode).toBe(0);

				const pending = child.wait({ allowAbort: true, allowNonZero: true });
				await Bun.write(gate, "go\n");
				const result = await pending;

				orphanPid = Number.parseInt(
					(
						await Bun.file(orphanFile)
							.text()
							.catch(() => "")
					).trim(),
					10,
				);
				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(result.stdout).toBe("cleanup-stdout\n");
				expect(await Bun.file(marker).text()).toBe("cleaned\n");
			} finally {
				watcher.close();
				if (subshellSleepPid) Process.fromPid(subshellSleepPid)?.killTree(9);
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	for (const source of ["first", "second"] as const) {
		it.skipIf(process.platform === "win32")(
			`aborts collection from the ${source} signal when attachSignal is called twice`,
			async () => {
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-multi-"));
				const pidFile = path.join(dir, "pid");
				const first = new AbortController();
				const second = new AbortController();
				const child = spawn(["/bin/sh", "-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; echo token`], {
					detached: true,
					signal: first.signal,
				});
				const pending = child.wait({ allowAbort: true, allowNonZero: true });
				child.attachSignal(second.signal);
				let orphanPid: number | undefined;
				try {
					await child.exited;
					expect(child.exitCode).toBe(0);
					orphanPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
					expect(orphanPid).toBeGreaterThan(0);
					await nextTurn();
					const reason = new Error(`stop-${source}`);
					if (source === "first") first.abort(reason);
					else second.abort(reason);

					const result = await pending;

					expect(result.exitError).toBeInstanceOf(AbortError);
					expect((result.exitError as AbortError).reason).toBe(reason);
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
	}
});
