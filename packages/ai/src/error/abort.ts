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

const GENERIC_ABORT_MESSAGES = new Set([
	"Request was aborted",
	"Request was aborted.",
	"The operation was aborted",
	"The operation was aborted.",
	"This operation was aborted",
	"This operation was aborted.",
]);

/**
 * Whether an error message is one of the default runtime or transport abort
 * sentinels emitted when `AbortController.abort()` is called without a custom reason.
 */
export function isGenericAbortMessage(message: string | undefined): boolean {
	return message !== undefined && GENERIC_ABORT_MESSAGES.has(message.trim());
}

/**
 * The explicit text a caller gave `AbortController.abort(reason)`; `undefined`
 * for a bare `abort()` or an `AbortError` carrying only a default abort sentinel.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string") {
		return reason.trim().length > 0 ? reason : undefined;
	}
	if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string") {
		const trimmed = reason.message.trim();
		if (trimmed.length === 0) return undefined;
		if ("name" in reason && reason.name === "AbortError" && isGenericAbortMessage(trimmed)) {
			return undefined;
		}
		return reason.message;
	}
	return undefined;
}
