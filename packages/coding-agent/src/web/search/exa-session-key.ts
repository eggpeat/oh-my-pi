/**
 * Session-scoped Exa API keys borrowed from folded Exa MCP servers.
 *
 * A keyed Exa MCP server folds into native web search only for the session
 * that discovered it. The key used to be written to process-wide EXA_API_KEY,
 * so a later session could search under another project's account. The key
 * now lives here, keyed by the owning session id. The Exa provider consults
 * it after a stored credential and before the real environment.
 *
 * Subagents share the parent's MCP manager, not its session id. The manager
 * object is therefore a second lookup key.
 */

/** Borrowed key by owning session id (`SessionManager.getSessionId()`). */
const sessionKeys = new Map<string, string>();

/** Borrowed key by owning MCP manager, for callers without the session id. */
const managerKeys = new WeakMap<object, string>();

/** Store, or clear with `undefined`, the Exa key borrowed by `sessionId`. */
export function setSessionExaApiKey(sessionId: string | undefined, key: string | undefined): void {
	if (!sessionId) return;
	if (key === undefined) sessionKeys.delete(sessionId);
	else sessionKeys.set(sessionId, key);
}

/** Associate the borrowed key with the manager object itself. */
export function setManagerExaApiKey(manager: object | undefined, key: string | undefined): void {
	if (!manager) return;
	if (key === undefined) managerKeys.delete(manager);
	else managerKeys.set(manager, key);
}

/**
 * Borrowed Exa key visible to this session. The session entry wins; `keyOwner`
 * supplies the value a subagent sees through the shared manager.
 */
export function getSessionExaApiKey(sessionId: string | undefined, keyOwner?: object): string | undefined {
	if (sessionId) {
		const key = sessionKeys.get(sessionId);
		if (key !== undefined) return key;
	}
	return keyOwner ? managerKeys.get(keyOwner) : undefined;
}

/** Drop the borrowed key at session end. Safe to call more than once. */
export function clearSessionExaApiKey(sessionId: string | undefined, keyOwner?: object): void {
	if (sessionId) sessionKeys.delete(sessionId);
	if (keyOwner) managerKeys.delete(keyOwner);
}
