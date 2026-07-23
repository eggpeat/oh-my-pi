import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";

import { concreteThinkingLevel } from "../thinking";
import { formatModelSelectorValue, formatModelString, parseModelString } from "./model-resolver";

export type RetryFallbackChains = Record<string, string[]>;

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	hasProvider(provider: string): boolean;
}

export interface RetryFallbackResolutionContext {
	chains: RetryFallbackChains;
	getModelRole(role: string): string | undefined;
	modelLookup: RetryFallbackModelLookup;
}

/** Apply the configured default chain to roles without their own chain. */
export function expandDefaultRetryFallbackChains(
	configuredChains: RetryFallbackChains,
	roleNames: readonly string[],
): RetryFallbackChains {
	const chains: RetryFallbackChains = { ...configuredChains };
	const defaultChain = chains.default;
	if (!Array.isArray(defaultChain)) return chains;
	for (const role of roleNames) {
		if (role !== "default" && chains[role] === undefined) chains[role] = defaultChain;
	}
	return chains;
}

export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: Pick<RetryFallbackModelLookup, "find">,
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/** Role names never contain a slash; model-selector chain keys always do. */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/** Matches provider wildcards and namespaced provider/id wildcards. */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

export function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

function getRetryFallbackPrimarySelector(
	context: RetryFallbackResolutionContext,
	chainKey: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(chainKey)) return undefined;
	if (isRetryFallbackModelKey(chainKey)) return parseRetryFallbackSelector(chainKey, context.modelLookup);
	const configuredSelector = context.getModelRole(chainKey);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, context.modelLookup) : undefined;
}

function selectorMatchesCurrent(
	primary: RetryFallbackSelector | undefined,
	currentSelector: string,
	currentBaseSelector: string,
	currentPlainSelector: string | undefined,
	currentPlainBaseSelector: string | undefined,
): boolean {
	if (!primary) return false;
	if (primary.raw === currentSelector || (currentPlainSelector && primary.raw === currentPlainSelector)) return true;
	const base = formatRetryFallbackBaseSelector(primary);
	return base === currentBaseSelector || (!!currentPlainBaseSelector && base === currentPlainBaseSelector);
}

/**
 * Resolve the chain key for a concrete selector by specificity: exact model,
 * longest matching wildcard, hinted/configured role, then default.
 */
export function resolveRetryFallbackChainKey(
	context: RetryFallbackResolutionContext,
	currentSelector: string,
	currentModel?: Model | null,
	roleHint?: string,
): string | undefined {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) {
		if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
		return undefined;
	}
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;

	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key) && !isRetryFallbackWildcardKey(key)) {
			if (
				selectorMatchesCurrent(
					getRetryFallbackPrimarySelector(context, key),
					currentSelector,
					currentBaseSelector,
					currentPlainSelector,
					currentPlainBaseSelector,
				)
			) {
				return key;
			}
		}
	}

	let wildcardMatch: string | undefined;
	let wildcardPrefixLength = -1;
	for (const key in context.chains) {
		if (!isRetryFallbackWildcardKey(key) || !Array.isArray(context.chains[key])) continue;
		const { provider, idPrefix } = parseRetryFallbackWildcard(key, provider =>
			context.modelLookup.hasProvider(provider),
		);
		if (provider !== parsedCurrent.provider) continue;
		if (idPrefix !== undefined && !parsedCurrent.id.startsWith(`${idPrefix}/`)) continue;
		const prefixLength = idPrefix?.length ?? 0;
		if (prefixLength > wildcardPrefixLength) {
			wildcardMatch = key;
			wildcardPrefixLength = prefixLength;
		}
	}
	if (wildcardMatch) return wildcardMatch;

	if (roleHint && Array.isArray(context.chains[roleHint])) return roleHint;
	for (const key in context.chains) {
		if (isRetryFallbackModelKey(key)) continue;
		if (
			selectorMatchesCurrent(
				getRetryFallbackPrimarySelector(context, key),
				currentSelector,
				currentBaseSelector,
				currentPlainSelector,
				currentPlainBaseSelector,
			)
		) {
			return key;
		}
	}

	const defaultChain = context.chains.default;
	if (
		Array.isArray(defaultChain) &&
		defaultChain.length > 0 &&
		getRetryFallbackPrimarySelector(context, "default") === undefined
	) {
		return "default";
	}
	return undefined;
}

function parseRetryFallbackChainEntry(
	context: RetryFallbackResolutionContext,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (!isRetryFallbackWildcardKey(entry)) return parseRetryFallbackSelector(entry, context.modelLookup);
	if (!current) return undefined;
	const { provider, idPrefix } = parseRetryFallbackWildcard(entry, candidate =>
		context.modelLookup.hasProvider(candidate),
	);
	const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
	let id: string;
	if (idPrefix !== undefined) {
		id = `${idPrefix}/${bareId}`;
	} else if (
		bareId !== current.id &&
		!context.modelLookup.find(provider, current.id) &&
		context.modelLookup.find(provider, bareId)
	) {
		id = bareId;
	} else {
		id = current.id;
	}
	return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
}

function getRetryFallbackEffectiveChain(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel: Model | null | undefined,
	allowMissingPrimary: boolean,
): RetryFallbackSelector[] {
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const parsedCurrent =
		parsedConfigured ??
		(currentModel
			? parseRetryFallbackSelector(
					formatModelSelectorValue(formatModelString(currentModel), undefined),
					context.modelLookup,
				)
			: undefined);
	const seen = new Set<string>();
	const chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(chainKey)) {
		if (parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		}
	} else {
		const primarySelector = getRetryFallbackPrimarySelector(context, chainKey);
		if (primarySelector) {
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		} else if ((chainKey === "default" || allowMissingPrimary) && parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		} else if (!allowMissingPrimary) {
			return [];
		}
	}
	for (const selector of context.chains[chainKey] ?? []) {
		const parsed = parseRetryFallbackChainEntry(context, selector, parsedCurrent);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/** Return the candidates after the current selector in an effective chain. */
export function findRetryFallbackCandidates(
	context: RetryFallbackResolutionContext,
	chainKey: string,
	currentSelector: string,
	currentModel?: Model | null,
	options?: { allowMissingPrimary?: boolean },
): RetryFallbackSelector[] {
	const chain = getRetryFallbackEffectiveChain(
		context,
		chainKey,
		currentSelector,
		currentModel,
		options?.allowMissingPrimary === true,
	);
	const parsedConfigured = parseRetryFallbackSelector(currentSelector, context.modelLookup);
	const currentPlainSelector = currentModel
		? formatModelSelectorValue(formatModelString(currentModel), parsedConfigured?.thinkingLevel)
		: undefined;
	const parsedCurrent =
		parsedConfigured ??
		(currentPlainSelector ? parseRetryFallbackSelector(currentPlainSelector, context.modelLookup) : undefined);
	if (!parsedCurrent) return chain;
	if (chain.length <= 1) return [];
	const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
	const currentPlainBaseSelector =
		parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
			? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
			: undefined;
	const exactIndex = chain.findIndex(
		selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
	);
	if (exactIndex >= 0) return chain.slice(exactIndex + 1);
	const baseIndex = currentBaseSelector
		? chain.findIndex(selector => {
				const selectorBase = formatRetryFallbackBaseSelector(selector);
				return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
			})
		: -1;
	if (baseIndex >= 0) return chain.slice(baseIndex + 1);
	return chain.slice(1);
}
