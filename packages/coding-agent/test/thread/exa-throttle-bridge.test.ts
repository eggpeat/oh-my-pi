import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MainThreadLink, WorkerThreadLink } from "@oh-my-pi/pi-coding-agent/thread/protocol";
import { type RpcEndpoint, type RpcFrame, RpcLink } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import type { WorkerPeer } from "@oh-my-pi/pi-coding-agent/thread/services";
import { exaThrottleThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/exa-throttle";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import {
	resetExaSearchThrottleForTest,
	setExaThrottleCoordinator,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/exa-throttle";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function portEndpoint(port: MessagePort): RpcEndpoint {
	return {
		send: frame => port.postMessage(frame),
		listen: handler => {
			const listener = (frame: RpcFrame): void => handler(frame);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
	};
}

function exaResponse(): Response {
	return new Response(JSON.stringify({ results: [{ title: "t", url: "https://example.com/a", summary: "s" }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

let savedExaKey: string | undefined;

beforeEach(() => {
	savedExaKey = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	delete Bun.env.EXA_API_KEY;
	setExaThrottleCoordinator(undefined);
	resetSettingsForTest();
	resetExaSearchThrottleForTest();
});

afterEach(() => {
	setExaThrottleCoordinator(undefined);
	resetSettingsForTest();
	resetExaSearchThrottleForTest();
	if (savedExaKey === undefined) {
		delete process.env.EXA_API_KEY;
		delete Bun.env.EXA_API_KEY;
	} else {
		process.env.EXA_API_KEY = savedExaKey;
		Bun.env.EXA_API_KEY = savedExaKey;
	}
});

describe("exa throttle thread service", () => {
	it("reserves worker Exa slots against the main thread's schedule for the same account", async () => {
		const channel = new MessageChannel();
		const mainLink: MainThreadLink = new RpcLink(portEndpoint(channel.port1), { name: "main↔worker" });
		const workerLink: WorkerThreadLink = new RpcLink(portEndpoint(channel.port2), { name: "worker↔main" });
		const peer: WorkerPeer = { threadId: "w1", link: mainLink };
		exaThrottleThreadService.installMain?.(peer);
		exaThrottleThreadService.installWorker?.(workerLink);

		let bootedGlobals: unknown;
		workerLink.handle("boot", (globals: unknown) => {
			bootedGlobals = globals;
		});

		const originalNow = Date.now;
		const originalTimeout = globalThis.setTimeout;
		const originalFetch = globalThis.fetch;
		const delays: number[] = [];
		const now = 1_700_000_000_000;
		Date.now = () => now;
		globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
			delays.push(timeout ?? 0);
			return originalTimeout(handler, 0);
		}) as typeof setTimeout;
		globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => exaResponse()) as typeof fetch;

		const authStorage = createInMemoryAuthStorage();
		try {
			process.env.EXA_API_KEY = "shared-thread-key";
			Bun.env.EXA_API_KEY = "shared-thread-key";

			const mainSession = Settings.isolated({ "exa.searchDelayMs": 1_500 });
			const mainResult = await runSearchQuery(
				{ query: "from-main", model: "web/exa" },
				{ authStorage, settings: mainSession },
			);
			expect(mainResult.details.error).toBeUndefined();
			expect(delays).toEqual([]);

			await mainLink.call("boot", { [exaThrottleThreadService.name]: exaThrottleThreadService.globals?.(peer) });
			await exaThrottleThreadService.boot?.(
				(bootedGlobals as Record<string, unknown>)[exaThrottleThreadService.name],
				workerLink,
			);

			const workerSession = Settings.isolated({ "exa.searchDelayMs": 1_500 });
			const workerResult = await runSearchQuery(
				{ query: "from-worker", model: "web/exa" },
				{ authStorage, settings: workerSession },
			);
			expect(workerResult.details.error).toBeUndefined();
			expect(delays).toContain(1_500);
		} finally {
			setExaThrottleCoordinator(undefined);
			Date.now = originalNow;
			globalThis.setTimeout = originalTimeout;
			globalThis.fetch = originalFetch;
			authStorage.close();
			mainLink.close("test end");
			workerLink.close("test end");
			channel.port1.close();
			channel.port2.close();
		}
	});
});
