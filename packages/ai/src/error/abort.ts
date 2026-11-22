import type { Api } from "../types";
import { attach, classify, create, Flag, isClassified, status } from "./flags";

/**
 * A request was cancelled — by the caller's `AbortSignal` or a provider-local
 * watchdog. Carries the {@link Flag.Abort} classification structurally so retry
 * logic does not have to regex the message text.
 *
 * The default message is kept byte-identical to the historical
 * `"Request was aborted"` string so any remaining text-based matchers keep
 * working through the migration.
 */
export class AbortError extends Error {
	constructor(message = "Request was aborted", options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AbortError";
		attach(this, create(Flag.Abort));
	}
}

const BARE_ABORT_REASON: unknown = (() => {
	const controller = new AbortController();
	controller.abort();
	return controller.signal.reason;
})();

function isRuntimeDefaultAbortReason(reason: unknown): boolean {
	if (
		reason instanceof AbortError ||
		!(BARE_ABORT_REASON instanceof Error) ||
		!(reason instanceof DOMException) ||
		status(reason) !== undefined ||
		classify(reason) !== 0
	) {
		return false;
	}
	return reason.name === BARE_ABORT_REASON.name && reason.message === BARE_ABORT_REASON.message;
}

/**
 * Whether an `AbortSignal.reason` came from a bare `abort()` call (no reason
 * supplied) rather than an explicit caller-supplied cancellation reason.
 */
export function isBareAbortReason(reason: unknown): boolean {
	return reason === undefined || isRuntimeDefaultAbortReason(reason);
}

/**
 * The custom cancellation text a caller gave `AbortController.abort(reason)`
 * (a non-empty string, an `Error` other than the runtime's bare-abort default,
 * or an object with a `message` string); `undefined` for a bare `abort()` or
 * empty reason text.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string") return reason.trim().length > 0 ? reason : undefined;
	if (reason instanceof Error) {
		if (isRuntimeDefaultAbortReason(reason)) return undefined;
		return reason.message.trim().length > 0 ? reason.message : undefined;
	}
	if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string") {
		return reason.message.trim().length > 0 ? reason.message : undefined;
	}
	return undefined;
}

/**
 * Classify an aborted caller signal into display text, `errorId`, and HTTP
 * `errorStatus`. Only a bare `abort()` gets {@link Flag.Abort} alone; any
 * caller-supplied reason records {@link Flag.CallerAbort} or its known HTTP
 * status / error flags so turn recovery preserves caller intent and statuses.
 */
export function classifyCallerAbort(
	signal: AbortSignal | undefined,
	api?: Api,
): { errorMessage: string; errorId: number; errorStatus: number | undefined } {
	const reason = signal?.reason;
	const errorMessage = callerAbortReason(signal) ?? "Request was aborted";
	if (isBareAbortReason(reason)) {
		return {
			errorMessage,
			errorId: create(Flag.Abort),
			errorStatus: undefined,
		};
	}
	const errorStatus = status(reason);
	const classified = classify(reason, api);
	const errorId =
		classified === 0
			? create(Flag.CallerAbort)
			: isClassified(classified)
				? classified | Flag.CallerAbort
				: classified;
	return { errorMessage, errorId, errorStatus };
}
