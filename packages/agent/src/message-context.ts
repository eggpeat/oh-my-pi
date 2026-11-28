import type { AgentMessage } from "./types";

/**
 * Whether `message` is kept out of model context: drawn and saved, never sent (a `!!` bash run, a
 * custom row sent with `excludeFromContext`).
 */
export function isExcludedFromContext(message: AgentMessage): boolean {
	return "excludeFromContext" in message && message.excludeFromContext === true;
}
