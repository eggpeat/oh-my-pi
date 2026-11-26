/**
 * MCP configuration loader.
 *
 * Uses the capability system to load MCP servers from multiple sources.
 */

import { type Api, type AuthStorage, type Model, getEnvApiKey } from "@oh-my-pi/pi-ai";
import { $env, $envExact, getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { mcpCapability } from "../capability/mcp";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import { cfgOffline } from "../config/auxiliary-model-policy";
import { getRoleInfo } from "../config/model-roles";
import { resolveRoleChain } from "../config/model-resolver";
import { isCommandConfigValue } from "../config/resolve-config-value";
import { type Settings, settings } from "../config/settings";
import type { MCPServer } from "../discovery";
import { loadCapability } from "../discovery";
import { cfgProvidersWebKeyless } from "../session/settings";
import { cfgWebSearchEnabled } from "../tools/settings";
import { cfgExaEnabled } from "../web/settings";
import { readMCPConfigFile } from "./config-writer";
import { builtinDropFor, type MCPDroppedServer, type MCPTransformContext } from "./transforms";
import type { MCPConfigFile, MCPServerConfig, MCPStdioServerConfig } from "./types";

/** Options for loading MCP configs */
export interface LoadMCPConfigsOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when the built-in browser capability is enabled (default: false) */
	filterBrowser?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
	/**
	 * What the session offers natively, so built-in transforms (`./transforms`) can drop
	 * the servers it makes redundant. Omitted: no built-in transform applies.
	 */
	builtinTransforms?: MCPTransformContext;
	/**
	 * Settings scope for the Exa fold (`exa.enabled`, `web_search.enabled`,
	 * `models.offline`, `providers.webKeyless`, and the web role chain all read
	 * it; default: the global settings). Pass the session's settings so a
	 * session-scoped opt-out is honored the way `web_search` sees it.
	 */
	settings?: Settings;
	/**
	 * Credential store consulted for a stored `exa` key when the Exa fold asks
	 * whether native search can run keyed. Omitted: only `EXA_API_KEY` in the
	 * environment counts.
	 */
	authStorage?: AuthStorage;
	/**
	 * Registry the `web` role chain resolves against. Omitted: the chain cannot
	 * be verified, so Exa servers stay mounted.
	 */
	modelRegistry?: ExaFoldRegistry;
	/**
	 * Whether the session currently exposes `web_search` natively. A function
	 * is evaluated per load, so deferred discovery sees the same answer startup
	 * does. Omitted: assumed active.
	 */
	webSearchActive?: boolean | (() => boolean);
	/**
	 * Receives the Exa key this load installs for the session's native search —
	 * `undefined` when the load installs nothing, so callers can revoke a key a
	 * previous load installed. Omitted: keys are only reported on `exaApiKeys`.
	 */
	installExaApiKey?: (key: string | undefined) => void;
}

/** Result of loading MCP configs */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any were filtered) */
	exaApiKeys: string[];
	/** Source metadata for each server */
	sources: Record<string, SourceMeta>;
	/** Servers a built-in transform dropped, by name; absent when there are none. */
	dropped?: Record<string, MCPDroppedServer>;
}

/**
 * Convert canonical MCPServer to legacy MCPServerConfig.
 */
function convertToLegacyConfig(server: MCPServer): MCPServerConfig {
	// Determine transport type
	const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
	const shared = {
		enabled: server.enabled,
		timeout: server.timeout,
		requestIdFormat: server.requestIdFormat,
		instructions: server.instructions,
		auth: server.auth,
		oauth: server.oauth,
	};

	if (transport === "stdio") {
		const config: MCPServerConfig = {
			...shared,
			type: "stdio" as const,
			command: server.command ?? "",
		};
		if (server.args) config.args = server.args;
		if (server.env) config.env = server.env;
		if (server.envPolicy) config.envPolicy = server.envPolicy;
		if (server.envLiteralKeys) config.envLiteralKeys = server.envLiteralKeys;
		if (server.cwd) config.cwd = server.cwd;
		return config;
	}

	if (transport === "http") {
		const config: MCPServerConfig = {
			...shared,
			type: "http" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	if (transport === "sse") {
		const config: MCPServerConfig = {
			...shared,
			type: "sse" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	// Fallback to stdio
	return {
		...shared,
		type: "stdio" as const,
		command: server.command ?? "",
	};
}

/**
 * Load all MCP server configs from standard locations.
 * Uses the capability system for multi-source discovery.
 *
 * @param cwd Working directory (project root)
 * @param options Load options
 */
export async function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const filterExa = options?.filterExa ?? true;
	const filterBrowser = options?.filterBrowser ?? false;

	// Load user-level disable/force-enable lists. The denylist always wins; the
	// allowlist overrides a non-writable source config's `enabled: false`.
	// A malformed or unreadable user mcp.json must not take down the whole MCP
	// stack (docs/mcp-config.md: the file simply contributes no entries): its
	// servers are already skipped by the mcp-json provider with a warning, so
	// the lists degrade to empty here instead of rejecting every source.
	const userPath = getMCPConfigPath("user", cwd);
	let userConfig: MCPConfigFile;
	try {
		const config: unknown = await readMCPConfigFile(userPath);
		// JSON.parse also accepts bare `null`, numbers, strings, and arrays;
		// only an object carries the server map and the lists read below.
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			throw new Error("user MCP config must be a JSON object");
		}
		userConfig = config as MCPConfigFile;
	} catch (error) {
		logger.warn("Ignoring unreadable user MCP config for server lists", { path: userPath, error: String(error) });
		userConfig = { mcpServers: {} };
	}
	const disabledServers = new Set(Array.isArray(userConfig.disabledServers) ? userConfig.disabledServers : []);
	const forcedEnabled = new Set(Array.isArray(userConfig.enabledServers) ? userConfig.enabledServers : []);

	// Scope exclusions drop entries entirely BEFORE deduplication: with project
	// config disabled, a project entry must not shadow anything.
	const includeServer = (server: MCPServer & { _source: SourceMeta }): boolean =>
		enableProjectConfig || server._source.level !== "project";

	// Disabled servers are suppressed rather than dropped: they still own their
	// name at key-level dedupe (a disabled project `foo` keeps a same-named,
	// lower-priority user `foo` disabled), but never equivalence-shadow a
	// differently-named enabled server — otherwise the disabled alias would be
	// removed downstream and starve the surviving connection.
	//
	// A built-in drop suppresses the same way, as if the entry said
	// `enabled: false`, except that an explicit enable outranks it. Items arrive
	// highest priority first, so only the first entry of a name is the one that
	// would have connected; a drop of a later one is not worth reporting.
	const transformContext = options?.builtinTransforms;
	const claimed = new Set<string>();
	let dropped: Record<string, MCPDroppedServer> | undefined;
	const suppressServer = (server: MCPServer & { _source: SourceMeta }): boolean => {
		const owner = !claimed.has(server.name);
		claimed.add(server.name);
		if (disabledServers.has(server.name)) return true;
		const forced = forcedEnabled.has(server.name);
		if (server.enabled === false && !forced) return true;
		if (!transformContext || forced || server.enabled === true) return false;
		const drop = builtinDropFor(server, transformContext);
		if (!drop) return false;
		if (owner) {
			dropped ??= {};
			dropped[server.name] = { reason: drop.reason, source: server._source };
			logger.debug("Built-in MCP transform dropped a server", { server: server.name, transform: drop.id });
		}
		return true;
	};

	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		extensionRoots: options?.extensionRoots,
		filter: includeServer,
		suppress: suppressServer,
	});

	// Discovery warnings (e.g. a Claude plugin manifest timeout below Claude
	// Code's 1000ms minimum) must reach the user, not vanish with the
	// CapabilityResult.
	for (const warning of result.warnings) logger.warn(warning);

	// Convert to legacy format and preserve source metadata.
	let configs: Record<string, MCPServerConfig> = {};
	let sources: Record<string, SourceMeta> = {};
	for (const server of result.items) {
		configs[server.name] = convertToLegacyConfig(server);
		sources[server.name] = server._source;
	}

	let exaApiKeys: string[] = [];

	if (filterExa) {
		const exaResult = filterExaMCPServers(configs, sources, resolveNativeExaCoverage(options));
		configs = exaResult.configs;
		sources = exaResult.sources;
		exaApiKeys = exaResult.exaApiKeys;
		options?.installExaApiKey?.(exaApiKeys[0]);
	}

	if (filterBrowser) {
		const browserResult = filterBrowserMCPServers(configs, sources);
		configs = browserResult.configs;
		sources = browserResult.sources;
	}

	const loaded: LoadMCPConfigsResult = { configs, exaApiKeys, sources };
	if (dropped) loaded.dropped = dropped;
	return loaded;
}

/** Pattern to match Exa MCP servers */
const EXA_MCP_URL_PATTERN = /mcp\.exa\.ai/i;
const EXA_API_KEY_PATTERN = /exaApiKey=([^&\s]+)/i;

/**
 * Check if a server config is an Exa MCP server.
 */
export function isExaMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (name.toLowerCase() === "exa") {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && EXA_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by args for stdio servers (e.g., mcp-remote to exa)
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args?.some(arg => EXA_MCP_URL_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/**
 * Catalog surface the Exa fold needs. Kept local so discovery does not import
 * the model-browser module, whose path differs across releases.
 */
interface ExaFoldRegistry {
	getAvailable(kind: "all"): readonly Model<Api>[];
}

/**
 * How an Exa API key reference in an MCP server config classifies.
 *
 * - `none`: no key configured.
 * - `literal`: the config carries the key itself.
 * - `unresolved`: the value needs MCP connect-time resolution — a `!command`,
 *   a bare environment-variable name, or a dollar-brace placeholder. None of
 *   these may be passed to native `web_search` as a key, so the server stays.
 */
export interface ExaApiKeyInspection {
	kind: "none" | "literal" | "unresolved";
	/** Present when `kind` is `literal`. */
	key?: string;
}

function classifyExaApiKeyValue(raw: string | undefined, connectResolved: boolean): ExaApiKeyInspection {
	if (raw === undefined) return { kind: "none" };
	const trimmed = raw.trim();
	if (trimmed === "") return { kind: "none" };
	if (trimmed.includes("${")) return { kind: "unresolved" };
	if (connectResolved && (isCommandConfigValue(trimmed) || $envExact(trimmed) !== undefined)) {
		return { kind: "unresolved" };
	}
	return { kind: "literal", key: trimmed };
}

function inspectExaApiKey(config: MCPServerConfig): ExaApiKeyInspection {
	if (config.type === "http" || config.type === "sse") {
		const match = EXA_API_KEY_PATTERN.exec(config.url);
		if (match) return classifyExaApiKeyValue(match[1], false);
	}
	if (!config.type || config.type === "stdio") {
		for (const arg of config.args ?? []) {
			const match = EXA_API_KEY_PATTERN.exec(arg);
			if (match) return classifyExaApiKeyValue(match[1], false);
		}
	}
	if ("env" in config && config.env?.EXA_API_KEY !== undefined) {
		const stdio = config as MCPStdioServerConfig;
		const literalKeys = new Set(stdio.envLiteralKeys);
		const resolvedAtConnect = stdio.envPolicy !== "literal" && !literalKeys.has("EXA_API_KEY");
		return classifyExaApiKeyValue(config.env.EXA_API_KEY, resolvedAtConnect);
	}
	return { kind: "none" };
}

/** Exa MCP tools already covered by the native Exa integration. */
const NATIVE_EXA_MCP_TOOLS: Record<string, true> = { web_search_exa: true };

/**
 * Parse the comma-separated `tools` restriction from an Exa MCP config.
 * Returns `null` when the config does not restrict its tool set.
 */
function getRequestedExaMcpTools(config: MCPServerConfig): string[] | null {
	const raw = (() => {
		if (config.type === "http" || config.type === "sse") {
			const httpConfig = config as { url?: string };
			if (!httpConfig.url) return undefined;
			try {
				return new URL(httpConfig.url).searchParams.get("tools") ?? undefined;
			} catch {
				return undefined;
			}
		}
		if (!config.type || config.type === "stdio") {
			const stdioConfig = config as { args?: string[] };
			const args = stdioConfig.args ?? [];
			for (let i = 0; i < args.length; i++) {
				if (/^--?tools$/i.test(args[i])) return args[i + 1];
				const match = args[i].match(/(?:^|[\s?&])tools=([^&\s]+)/i) ?? args[i].match(/--?tools[=\s]([^\s]+)/i);
				if (match) return match[1];
			}
		}
		return undefined;
	})();
	if (!raw) return null;
	const tools = raw
		.split(",")
		.map(tool => tool.trim())
		.filter(tool => tool.length > 0);
	return tools.length > 0 ? tools : null;
}

/** Result of filtering Exa MCP servers */
export interface ExaFilterResult {
	/** Configs with Exa servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any) */
	exaApiKeys: string[];
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/** What the native Exa search integration can serve for this fold. */
export interface ExaFilterOptions {
	/** Native `web/exa` may answer `web_search` for this session at all. */
	nativeEnabled?: boolean;
	/** Native search reaches the keyless endpoint or a configured credential. */
	keylessCovered?: boolean;
	/** Native search already has its own Exa credential. */
	hasNativeCredential?: boolean;
	/** This load hands extracted keys to the session. True preserves direct calls. */
	installsExaApiKeys?: boolean;
}

function nativeExaCredential(authStorage: AuthStorage | undefined): boolean {
	try {
		if (authStorage?.keys.source("exa") !== undefined) return true;
	} catch {
		// Storage unavailable: fall back to the environment check below.
	}
	return Boolean(getEnvApiKey("exa") ?? $env.EXA_API_KEY?.trim());
}

function nativeExaSearchOffered(scope: Settings | undefined, options: LoadMCPConfigsOptions | undefined): boolean {
	const active = options?.webSearchActive;
	if (typeof active === "function" ? !active() : active === false) return false;
	try {
		if (cfgExaEnabled.get(scope ?? settings) === false) return false;
		if (cfgWebSearchEnabled.get(scope ?? settings) === false) return false;
		if (cfgOffline.get(scope ?? settings) === true) return false;
	} catch {
		// Uninitialized settings read as defaults: both toggles on, online.
	}
	const registry = options?.modelRegistry;
	if (!registry) return false;
	try {
		const activeSettings = scope ?? settings;
		const pool = [...registry.getAvailable("all")].filter(getRoleInfo("web", activeSettings).accepts);
		const chain = resolveRoleChain("web", activeSettings, pool);
		return chain.some(candidate => candidate.model.provider === "web" && candidate.model.id === "exa");
	} catch {
		return false;
	}
}

function resolveNativeExaCoverage(options: LoadMCPConfigsOptions | undefined): Required<ExaFilterOptions> {
	const scope = options?.settings;
	const hasNativeCredential = nativeExaCredential(options?.authStorage);
	let keylessCovered = hasNativeCredential;
	if (!keylessCovered) {
		try {
			keylessCovered = cfgProvidersWebKeyless.get(scope ?? settings);
		} catch {
			keylessCovered = true;
		}
	}
	return {
		nativeEnabled: nativeExaSearchOffered(scope, options),
		keylessCovered,
		hasNativeCredential,
		installsExaApiKeys: typeof options?.installExaApiKey === "function",
	};
}

/**
 * Filter out Exa MCP servers native search can actually serve, and collect the
 * literal keys this load can lend to that session.
 */
export function filterExaMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
	options?: ExaFilterOptions,
): ExaFilterResult {
	const nativeEnabled = options?.nativeEnabled ?? true;
	const keylessCovered = options?.keylessCovered ?? true;
	const hasNativeCredential = options?.hasNativeCredential ?? false;
	const installsExaApiKeys = options?.installsExaApiKeys ?? true;
	const inspections = new Map<string, { inspection: ExaApiKeyInspection; hasExtraTools: boolean }>();
	const exaApiKeys: string[] = [];
	if (nativeEnabled) {
		for (const [name, config] of Object.entries(configs)) {
			if (!isExaMCPServer(name, config)) continue;
			const inspection = inspectExaApiKey(config);
			if (inspection.kind === "literal" && inspection.key !== undefined) exaApiKeys.push(inspection.key);
			const requested = getRequestedExaMcpTools(config);
			const hasExtraTools = requested?.some(tool => !NATIVE_EXA_MCP_TOOLS[tool.toLowerCase()]) ?? false;
			inspections.set(name, { inspection, hasExtraTools });
		}
	}
	const installedKey = installsExaApiKeys ? exaApiKeys[0] : undefined;
	const willInstall = installsExaApiKeys && exaApiKeys.length > 0;
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};
	for (const [name, config] of Object.entries(configs)) {
		const exa = inspections.get(name);
		if (exa && !exa.hasExtraTools) {
			const { inspection } = exa;
			const fold =
				inspection.kind === "literal"
					? inspection.key === installedKey || hasNativeCredential
					: inspection.kind === "none"
						? willInstall || keylessCovered
						: false;
			if (fold) continue;
		}
		filtered[name] = config;
		if (sources[name]) filteredSources[name] = sources[name];
	}
	return { configs: filtered, exaApiKeys, sources: filteredSources };
}

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// Check for conflicting transport fields
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}

export interface BrowserMCPPreludeFilterOptions {
	restrictToolNames: boolean;
	browserEnabled: boolean;
	evalRegistered: boolean;
	evalActive: boolean;
}

/** Browser MCP filtering is valid only when the built-in prelude is callable. */
export function shouldFilterBrowserMCPForPrelude(options: BrowserMCPPreludeFilterOptions): boolean {
	return !options.restrictToolNames && options.browserEnabled && options.evalRegistered && options.evalActive;
}

/** Known browser automation MCP server names (lowercase) */
const BROWSER_MCP_NAMES = new Set([
	"puppeteer",
	"playwright",
	"browserbase",
	"browser-tools",
	"browser-use",
	"browser",
]);

/** Patterns matching browser MCP package names in command/args */
const BROWSER_MCP_PKG_PATTERN =
	// Official packages
	// - @modelcontextprotocol/server-puppeteer
	// - @playwright/mcp
	// - @browserbasehq/mcp-server-browserbase
	// - @agentdeskai/browser-tools-mcp
	// - @agent-infra/mcp-server-browser
	// Community packages: puppeteer-mcp-server, playwright-mcp, pptr-mcp, etc.
	/(?:@modelcontextprotocol\/server-puppeteer|@playwright\/mcp|@browserbasehq\/mcp-server-browserbase|@agentdeskai\/browser-tools-mcp|@agent-infra\/mcp-server-browser|puppeteer-mcp|playwright-mcp|pptr-mcp|browser-use-mcp|mcp-browser-use)/i;

/** URL patterns for hosted browser MCP services */
const BROWSER_MCP_URL_PATTERN = /browserbase\.com|browser-use\.com/i;

/**
 * Check if a server config is a browser automation MCP server.
 */
export function isBrowserMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (BROWSER_MCP_NAMES.has(name.toLowerCase())) {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && BROWSER_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by command/args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { command?: string; args?: string[] };
		if (stdioConfig.command && BROWSER_MCP_PKG_PATTERN.test(stdioConfig.command)) {
			return true;
		}
		if (stdioConfig.args?.some(arg => BROWSER_MCP_PKG_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/** Result of filtering browser MCP servers */
export interface BrowserFilterResult {
	/** Configs with browser servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out browser automation MCP servers.
 * Since we have a native browser capability, we don't need these MCP servers.
 */
export function filterBrowserMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): BrowserFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};

	for (const [name, config] of Object.entries(configs)) {
		if (!isBrowserMCPServer(name, config)) {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, sources: filteredSources };
}
