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

const DEFAULT_ABORT_ERROR_MESSAGES: ReadonlySet<string> = new Set([
	"Aborted",
	"Request was aborted",
	"Request was aborted.",
	"The operation was aborted",
	"The operation was aborted.",
	"This operation was aborted",
	"This operation was aborted.",
]);

/**
 * The text a caller gave `AbortController.abort(reason)`. Strings, custom
 * `Error`/`DOMException` messages, and tool-scoped abort objects are preserved;
 * `undefined` means a bare `abort()` or a runtime's default `AbortError`.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.message.trim().length > 0) {
		const isDefaultAbort = reason.name === "AbortError" && DEFAULT_ABORT_ERROR_MESSAGES.has(reason.message);
		if (!isDefaultAbort) return reason.message;
	}
	if (reason !== null && typeof reason === "object" && Reflect.get(reason, "kind") === "tool-scoped-abort") {
		const message = Reflect.get(reason, "message");
		if (typeof message === "string" && message.trim().length > 0) return message;
	}
	return undefined;
}
