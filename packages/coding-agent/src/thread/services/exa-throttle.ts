/**
 * Exa search pacing bridge between the main thread and subagent workers.
 *
 * Exa rate limits apply per account across the whole process. A subagent
 * worker's Exa searches reserve their send slot on main through this service so
 * main and worker sessions sharing an account pace against the same schedule
 * while honoring each caller's configured delay.
 */
import {
	type ExaSlotReservation,
	type ExaThrottleCoordinator,
	releaseExaSearchSlot,
	reserveExaSearchSlot,
	setExaThrottleCoordinator,
} from "../../web/search/providers/exa-throttle";
import type { WorkerThreadLink } from "../protocol";
import type { RemoteObject, RpcMethod } from "../rpc";
import type { ThreadService } from "../services";

/** Exported-class kind of the main thread's Exa throttle coordinator. */
export const EXA_THROTTLE_KIND = "exa-throttle";

/** Methods of the main thread's Exa throttle coordinator. */
export type ExaThrottleProtocol = {
	reserve: RpcMethod<[limitKey: string, delayMs: number], ExaSlotReservation>;
	release: RpcMethod<[limitKey: string, id: number], void>;
};

/** Boot globals of {@link exaThrottleThreadService}. */
export interface ExaThrottleServiceGlobals {
	/** Main thread's Exa throttle coordinator (a {@link RemoteExaThrottle} on the worker). */
	readonly throttle: MainExaThrottle;
}

/** Main-thread Exa throttle coordinator; crosses to workers by reference. */
export class MainExaThrottle {
	reserve(limitKey: string, delayMs: number): ExaSlotReservation {
		return reserveExaSearchSlot(limitKey, delayMs);
	}

	release(limitKey: string, id: number): void {
		releaseExaSearchSlot(limitKey, id);
	}
}

const mainExaThrottle = new MainExaThrottle();

/** Worker-side proxy of the main thread's {@link MainExaThrottle}. */
export class RemoteExaThrottle implements ExaThrottleCoordinator {
	readonly #remote: RemoteObject<ExaThrottleProtocol>;

	constructor(remote: RemoteObject<ExaThrottleProtocol>) {
		this.#remote = remote;
	}

	reserve(limitKey: string, delayMs: number): Promise<ExaSlotReservation> {
		return this.#remote.call("reserve", limitKey, delayMs);
	}

	release(limitKey: string, id: number): void {
		void this.#remote.call("release", limitKey, id).catch(() => {});
	}
}

function isExaThrottleGlobals(value: unknown): value is { throttle: unknown } {
	return typeof value === "object" && value !== null && "throttle" in value;
}

/** Shares Exa request slot reservations across main and subagent workers. */
export const exaThrottleThreadService: ThreadService = {
	name: "exa-throttle",

	installMain(peer): void {
		peer.link.exportClass<MainExaThrottle, ExaThrottleProtocol>(
			EXA_THROTTLE_KIND,
			(value): value is MainExaThrottle => value instanceof MainExaThrottle,
			{
				reserve: (throttle, limitKey, delayMs) => throttle.reserve(limitKey, delayMs),
				release: (throttle, limitKey, id) => throttle.release(limitKey, id),
			},
		);
	},

	globals(): ExaThrottleServiceGlobals {
		return { throttle: mainExaThrottle };
	},

	installWorker(link: WorkerThreadLink): void {
		link.importClass<RemoteExaThrottle, ExaThrottleProtocol>(
			EXA_THROTTLE_KIND,
			remote => new RemoteExaThrottle(remote),
		);
	},

	boot(globals: unknown): void {
		if (!isExaThrottleGlobals(globals) || !(globals.throttle instanceof RemoteExaThrottle)) {
			throw new Error("exa-throttle service: boot globals lack the main thread's coordinator");
		}
		setExaThrottleCoordinator(globals.throttle);
	},
};
