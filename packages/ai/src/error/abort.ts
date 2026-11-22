import { attach, create, Flag } from "./flags";

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

const DEFAULT_ABORT_ERROR_MESSAGES = new Set([
	"The operation was aborted",
	"The operation was aborted.",
	"This operation was aborted",
	"This operation was aborted.",
	"Request was aborted",
	"Request was aborted.",
	"AbortError",
	"Aborted",
	"aborted",
]);

/**
 * Whether an `AbortSignal.reason` represents a bare, reasonless `abort()` call
 * rather than a caller-supplied cancellation message or typed error.
 */
export function isBareAbortReason(reason: unknown): boolean {
	if (reason === undefined || reason === null) return true;
	if (typeof reason === "string") return reason.trim().length === 0;
	if (reason instanceof Error) {
		if (reason.name !== "AbortError") return false;
		const trimmed = reason.message.trim();
		return trimmed.length === 0 || DEFAULT_ABORT_ERROR_MESSAGES.has(trimmed);
	}
	return false;
}

/**
 * The custom cancellation text a caller gave `AbortController.abort(reason)`
 * (a non-empty string, an `Error` with a message, or a labelled `AbortError`);
 * `undefined` for a bare `abort()`.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error) {
		const trimmed = reason.message.trim();
		if (trimmed.length === 0) return undefined;
		if (reason.name === "AbortError" && DEFAULT_ABORT_ERROR_MESSAGES.has(trimmed)) return undefined;
		return reason.message;
	}
	return undefined;
}
