import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport, UsageStatus } from "../src/usage";

async function drainMicrotasks(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

describe("AuthStorage getModelUsageHealth", () => {
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;
	let usageProvider: UsageProvider;
	let codexUsageProvider: UsageProvider;
	const usageReports = new Map<string, UsageReport | null>();
	const codexReports = new Map<string, UsageReport | null>();

	function makeLimit(args: {
		id: string;
		windowId: "5h" | "7d";
		usedFraction: number;
		tier?: "fable" | "mythos";
		resetsAt?: number;
		durationMs?: number;
		status?: UsageStatus;
	}): UsageLimit {
		const used = args.usedFraction * 100;
		return {
			id: args.id,
			label: args.tier ? `Claude 7 Day (${args.tier})` : `Claude ${args.windowId === "5h" ? "5 Hour" : "7 Day"}`,
			scope: {
				provider: "anthropic",
				windowId: args.windowId,
				...(args.tier ? { tier: args.tier } : { shared: true }),
			},
			window: {
				id: args.windowId,
				label: args.windowId === "5h" ? "5 Hour" : "7 Day",
				...(args.resetsAt !== undefined ? { resetsAt: args.resetsAt } : {}),
				...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
			},
			amount: {
				used,
				limit: 100,
				remaining: 100 - used,
				usedFraction: args.usedFraction,
				remainingFraction: 1 - args.usedFraction,
				unit: "percent",
			},
			status: args.status ?? (args.usedFraction >= 1 ? "exhausted" : "ok"),
		};
	}

	beforeEach(async () => {
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		usageProvider = {
			id: "anthropic",
			async fetchUsage(params) {
				const email = params.credential.email;
				if (!email) return null;
				return usageReports.get(email) ?? null;
			},
		};
		codexUsageProvider = {
			id: "openai-codex",
			async fetchUsage(params) {
				const email = params.credential.email;
				if (!email) return null;
				return codexReports.get(email) ?? null;
			},
		};
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => {
				if (provider === "anthropic") return usageProvider;
				if (provider === "openai-codex") return codexUsageProvider;
				return undefined;
			},
			usageRequestTimeoutMs: 100,
		});
		await authStorage.reload();
		usageReports.clear();
		codexReports.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		db.close();
	});

	it("depletes account when 5-hour limit is exhausted", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 1.0 }),
				makeLimit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.2 }),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});
		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts[0].state).toBe("depleted");
	});

	it("depletes account when weekly limit is exhausted", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 }),
				makeLimit({ id: "anthropic:7d", windowId: "7d", usedFraction: 1.0 }),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});
		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts[0].state).toBe("depleted");
	});

	it("keeps account eligible when both limits are healthy", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 }),
				makeLimit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.2 }),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});
		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("eligible");
		expect(health.accounts[0].state).toBe("eligible");
	});

	it("verifies window summaries, labels, status, account fetchedAt, and usedFraction > 1", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const fetchedAtTime = 123456789;
		const resetsAtTime = 123457890;
		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: fetchedAtTime,
			limits: [
				makeLimit({
					id: "anthropic:5h",
					windowId: "5h",
					usedFraction: 1.5, // usedFraction > 1 preserved
					resetsAt: resetsAtTime,
					durationMs: 5 * 3600 * 1000,
					status: "exhausted",
				}),
				makeLimit({
					id: "anthropic:7d",
					windowId: "7d",
					usedFraction: Number.NaN, // non-finite omitted
					resetsAt: Number.POSITIVE_INFINITY, // non-finite omitted
					durationMs: Number.NEGATIVE_INFINITY, // non-finite omitted
					status: "ok",
				}),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		const acc = health.accounts[0];

		// Check primary summary
		expect(acc.primary).toBeDefined();
		expect(acc.primary?.id).toBe("anthropic:5h");
		expect(acc.primary?.label).toBe("Claude 5 Hour");
		expect(acc.primary?.status).toBe("exhausted");
		expect(acc.primary?.usedFraction).toBe(1.5);
		expect(acc.primary?.resetsAt).toBe(resetsAtTime);
		expect(acc.primary?.durationMs).toBe(5 * 3600 * 1000);

		// Check secondary summary (non-finite fields omitted)
		expect(acc.secondary).toBeDefined();
		expect(acc.secondary?.id).toBe("anthropic:7d");
		expect(acc.secondary?.label).toBe("Claude 7 Day");
		expect(acc.secondary?.status).toBe("ok");
		expect(acc.secondary?.usedFraction).toBeUndefined();
		expect(acc.secondary?.resetsAt).toBeUndefined();
		expect(acc.secondary?.durationMs).toBeUndefined();

		// Check fetchedAt
		expect(acc.fetchedAt).toBe(fetchedAtTime);
	});

	it("omits fetchedAt from account when report fetchedAt is non-finite", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Number.NaN, // non-finite
			limits: [makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 })],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.accounts[0].fetchedAt).toBeUndefined();
	});

	it("aggregates states correctly when there is an eligible sibling", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
			{
				type: "oauth",
				access: "access-token-2",
				refresh: "refresh-token-2",
				expires: Date.now() + 3600000,
				accountId: "account-2",
				email: "two@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 1.0 })],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		usageReports.set("two@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 })],
			metadata: { email: "two@example.com", accountId: "account-2" },
		});

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("eligible");
		expect(health.accounts[0].state).toBe("depleted");
		expect(health.accounts[1].state).toBe("eligible");
	});

	for (const limitSpec of [
		{ name: "5-hour", id: "anthropic:5h", windowId: "5h" as const },
		{ name: "weekly", id: "anthropic:7d", windowId: "7d" as const },
	]) {
		it(`resolves stale elapsed-reset reports as unknown for ${limitSpec.name} limit`, async () => {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "access-token-1",
					refresh: "refresh-token-1",
					expires: Date.now() + 3600000,
					accountId: "account-1",
					email: "one@example.com",
				},
			]);

			const now = Date.now();
			const resetsAt = now - 5000;

			usageReports.set("one@example.com", {
				provider: "anthropic",
				fetchedAt: resetsAt - 1000,
				limits: [makeLimit({ id: limitSpec.id, windowId: limitSpec.windowId, usedFraction: 1.0, resetsAt })],
				metadata: { email: "one@example.com", accountId: "account-1" },
			});

			const health = await authStorage.getModelUsageHealth("anthropic", {
				modelId: "claude-sonnet-4-5",
			});
			expect(health.accounts[0].state).toBe("unknown");
		});

		it(`resolves post-reset exhausted reports as depleted for ${limitSpec.name} limit`, async () => {
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "access-token-1",
					refresh: "refresh-token-1",
					expires: Date.now() + 3600000,
					accountId: "account-1",
					email: "one@example.com",
				},
			]);

			const now = Date.now();
			const resetsAt = now - 5000;

			usageReports.set("one@example.com", {
				provider: "anthropic",
				fetchedAt: resetsAt + 1000,
				limits: [makeLimit({ id: limitSpec.id, windowId: limitSpec.windowId, usedFraction: 1.0, resetsAt })],
				metadata: { email: "one@example.com", accountId: "account-1" },
			});

			const health = await authStorage.getModelUsageHealth("anthropic", {
				modelId: "claude-sonnet-4-5",
			});
			expect(health.accounts[0].state).toBe("depleted");
		});
	}

	it("handles Fable future-reset weekly depletion without leaking to Sonnet", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const futureReset = Date.now() + 600000;
		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 }),
				makeLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: 1.0,
					tier: "fable",
					resetsAt: futureReset,
				}),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		// Query Fable kind
		const fableHealth = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-fable-5",
		});
		expect(fableHealth.accounts[0].state).toBe("depleted");
		expect(fableHealth.accounts[0].secondary).toBeDefined();
		expect(fableHealth.accounts[0].secondary?.id).toBe("anthropic:7d:fable");

		// Query Sonnet kind (must not leak)
		const sonnetHealth = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(sonnetHealth.accounts[0].state).toBe("eligible");
		expect(sonnetHealth.accounts[0].secondary).toBeUndefined();
	});

	it("marks Fable weekly exhaustion with missing resets as unknown", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 }),
				makeLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: 1.0,
					tier: "fable",
					resetsAt: undefined,
				}),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-fable-5",
		});
		expect(health.accounts[0].state).toBe("unknown");
	});

	it("marks Fable weekly exhaustion with elapsed resets as unknown", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const pastReset = Date.now() - 5000;
		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.1 }),
				makeLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: 1.0,
					tier: "fable",
					resetsAt: pastReset,
				}),
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-fable-5",
		});
		expect(health.accounts[0].state).toBe("unknown");
	});

	it("aggregates to depleted when all accounts are depleted", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
			{
				type: "oauth",
				access: "access-token-2",
				refresh: "refresh-token-2",
				expires: Date.now() + 3600000,
				accountId: "account-2",
				email: "two@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 1.0 })],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});
		usageReports.set("two@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 1.0 })],
			metadata: { email: "two@example.com", accountId: "account-2" },
		});

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("depleted");
	});

	it("aggregates to unknown when one is depleted and another is null", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
			{
				type: "oauth",
				access: "access-token-2",
				refresh: "refresh-token-2",
				expires: Date.now() + 3600000,
				accountId: "account-2",
				email: "two@example.com",
			},
		]);

		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [makeLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 1.0 })],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});
		usageReports.set("two@example.com", null);

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("unknown");
	});

	it("keeps blocked Codex depleted when refresh returns null", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-token-codex",
				refresh: "refresh-token-codex",
				expires: Date.now() + 3600000,
				accountId: "account-codex",
				email: "codex@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("openai-codex")[0];
		authStorage.upsertCredentialBlock({
			credentialId: summary.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 3600000,
		});

		codexReports.set("codex@example.com", null);

		const health = await authStorage.getModelUsageHealth("openai-codex", { modelId: "gpt-5" });
		expect(health.accounts[0].state).toBe("depleted");
	});

	it("resolves as unknown when the fetch hangs past the aggregate timeout bound", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const { promise: hangPromise } = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockReturnValue(hangPromise);

		vi.useFakeTimers();
		const healthPromise = authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});

		// Small timeout (100ms) leads to Math.max(5000, 100 * 1.5) = 5000ms aggregate timeout
		vi.advanceTimersByTime(5000);
		await drainMicrotasks(10);

		const health = await healthPromise;
		expect(health.accounts[0].state).toBe("unknown");
		vi.useRealTimers();
	});

	it("survives active block for Codex when refresh/fetch returns null", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-token-codex",
				refresh: "refresh-token-codex",
				expires: Date.now() + 3600000,
				accountId: "account-codex",
				email: "codex@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("openai-codex")[0];
		authStorage.upsertCredentialBlock({
			credentialId: summary.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 3600000,
		});

		const spy = vi.spyOn(codexUsageProvider, "fetchUsage").mockResolvedValue(null);

		const health = await authStorage.getModelUsageHealth("openai-codex", { modelId: "gpt-5" });
		expect(health.accounts[0].state).toBe("depleted");
		expect(spy).toHaveBeenCalled();
	});

	it("survives active block for Codex when refresh/fetch rejects", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-token-codex",
				refresh: "refresh-token-codex",
				expires: Date.now() + 3600000,
				accountId: "account-codex",
				email: "codex@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("openai-codex")[0];
		authStorage.upsertCredentialBlock({
			credentialId: summary.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 3600000,
		});

		const spy = vi.spyOn(codexUsageProvider, "fetchUsage").mockRejectedValue(new Error("network failure"));

		const health = await authStorage.getModelUsageHealth("openai-codex", { modelId: "gpt-5" });
		expect(health.accounts[0].state).toBe("depleted");
		expect(spy).toHaveBeenCalled();
	});

	it("survives active block for Codex when refresh/fetch times out", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-token-codex",
				refresh: "refresh-token-codex",
				expires: Date.now() + 3600000,
				accountId: "account-codex",
				email: "codex@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("openai-codex")[0];
		authStorage.upsertCredentialBlock({
			credentialId: summary.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 3600000,
		});

		const { promise: hangPromise } = Promise.withResolvers<UsageReport | null>();
		const spy = vi.spyOn(codexUsageProvider, "fetchUsage").mockReturnValue(hangPromise);

		vi.useFakeTimers();
		const healthPromise = authStorage.getModelUsageHealth("openai-codex", { modelId: "gpt-5" });
		vi.advanceTimersByTime(5000);
		await drainMicrotasks(10);

		const health = await healthPromise;
		expect(health.accounts[0].state).toBe("depleted");
		expect(spy).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("does not fetch usage for pre-blocked Anthropic account", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("anthropic")[0];
		authStorage.upsertCredentialBlock({
			credentialId: summary.credentialId,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 3600000,
		});

		const spy = vi.spyOn(usageProvider, "fetchUsage");

		const health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.accounts[0].state).toBe("depleted");
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects immediately if already aborted, or later during probe", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		// Scenario A: already aborted
		const controller1 = new AbortController();
		controller1.abort();
		await expect(
			authStorage.getModelUsageHealth("anthropic", {
				modelId: "claude-sonnet-4-5",
				signal: controller1.signal,
			}),
		).rejects.toThrow("aborted");

		// Scenario B: aborted later in flight
		const controller2 = new AbortController();
		const { promise: hangPromise } = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockReturnValue(hangPromise);

		const promise = authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
			signal: controller2.signal,
		});

		await drainMicrotasks(5);
		controller2.abort();

		await expect(promise).rejects.toThrow("aborted");
	});

	it("never attributes another row block when stable credential ID is removed/disabled during probe", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
			{
				type: "oauth",
				access: "access-token-2",
				refresh: "refresh-token-2",
				expires: Date.now() + 3600000,
				accountId: "account-2",
				email: "two@example.com",
			},
		]);

		const summaries = authStorage.listOAuthAccounts("anthropic");
		const id1 = summaries[0].credentialId;
		const id2 = summaries[1].credentialId;

		// Add block to credential 2. Initially at index 1.
		authStorage.upsertCredentialBlock({
			credentialId: id2,
			providerKey: "anthropic:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + 3600000,
		});

		// Hook fetchUsage to disable credential 1 during its fetch
		const { promise: fetchPromise, resolve: resolveFetch } = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockImplementation(async params => {
			if (params.credential.email === "one@example.com") {
				// While in flight, disable credential 1
				authStorage.disableCredentialById(id1, "disabled in test");
				return fetchPromise;
			}
			return null;
		});

		const healthPromise = authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});

		await drainMicrotasks(10);
		resolveFetch(null);

		const health = await healthPromise;
		// Since credential 1 (id1) was deleted/disabled, it should report unknown (not depleted from credential 2's block)
		const targetAcc = health.accounts.find(a => a.credentialId === id1);
		expect(targetAcc).toBeDefined();
		expect(targetAcc?.state).toBe("unknown");
	});
	it("resolves expired snapshot block with no current block as unknown", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("anthropic")[0];
		const spy = vi.spyOn(usageProvider, "fetchUsage");

		let currentTime = 1000000;
		const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		const originalGet = store.getCredentialBlock.bind(store);
		const storeSpy = vi
			.spyOn(store, "getCredentialBlock")
			.mockImplementation((credentialId, providerKey, blockScope) => {
				const res = originalGet(credentialId, providerKey, blockScope);
				currentTime = 1002000;
				return res;
			});

		try {
			const blockTime = 1001000; // Expired by evaluation (1002000)
			authStorage.upsertCredentialBlock({
				credentialId: summary.credentialId,
				providerKey: "anthropic:oauth",
				blockScope: "",
				blockedUntilMs: blockTime,
			});

			const health = await authStorage.getModelUsageHealth("anthropic", {
				modelId: "claude-sonnet-4-5",
			});

			expect(health.accounts[0].state).toBe("unknown");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			dateSpy.mockRestore();
			storeSpy.mockRestore();
		}
	});

	it("resolves still-active snapshot block as depleted", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		const summary = authStorage.listOAuthAccounts("anthropic")[0];
		const spy = vi.spyOn(usageProvider, "fetchUsage");

		let currentTime = 1000000;
		const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		const originalGet = store.getCredentialBlock.bind(store);
		const storeSpy = vi
			.spyOn(store, "getCredentialBlock")
			.mockImplementation((credentialId, providerKey, blockScope) => {
				const res = originalGet(credentialId, providerKey, blockScope);
				currentTime = 1002000;
				return res;
			});

		try {
			const blockTime = 1100000; // Still active during evaluation (1100000 > 1002000)
			authStorage.upsertCredentialBlock({
				credentialId: summary.credentialId,
				providerKey: "anthropic:oauth",
				blockScope: "",
				blockedUntilMs: blockTime,
			});

			const health = await authStorage.getModelUsageHealth("anthropic", {
				modelId: "claude-sonnet-4-5",
			});

			expect(health.accounts[0].state).toBe("depleted");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			dateSpy.mockRestore();
			storeSpy.mockRestore();
		}
	});
	it("rejects with abort error on already-aborted signal even with no credentials or overrides", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			authStorage.getModelUsageHealth("anthropic", {
				modelId: "claude-sonnet-4-5",
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
	});
	it("handles non-finite limits (usedFraction=Infinity, remainingFraction=Infinity, limit=Infinity) without depleting or resolving to usedFraction 0", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600000,
				accountId: "account-1",
				email: "one@example.com",
			},
		]);

		// Scenario A: status='ok' usedFraction=Infinity must not cause depletion, and usedFraction is omitted
		usageReports.set("one@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: {
						used: 10,
						limit: 100,
						usedFraction: Number.POSITIVE_INFINITY,
						remainingFraction: -Number.POSITIVE_INFINITY,
						unit: "percent",
					},
					status: "ok",
				},
			],
			metadata: { email: "one@example.com", accountId: "account-1" },
		});

		let health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.state).toBe("eligible");
		expect(health.accounts[0].state).toBe("eligible");
		expect(health.accounts[0].primary?.usedFraction).toBeUndefined();

		// Scenario B: remainingFraction=Infinity must not become summary usedFraction 0 (should be omitted)
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-2",
				refresh: "refresh-token-2",
				expires: Date.now() + 3600000,
				accountId: "account-2",
				email: "two@example.com",
			},
		]);
		usageReports.set("two@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: {
						remainingFraction: Number.POSITIVE_INFINITY,
						unit: "percent",
					},
					status: "ok",
				},
			],
			metadata: { email: "two@example.com", accountId: "account-2" },
		});

		health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.accounts[0].primary?.usedFraction).toBeUndefined();

		// Scenario C: finite-used/infinite-limit must not become summary usedFraction 0 (should be omitted)
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token-3",
				refresh: "refresh-token-3",
				expires: Date.now() + 3600000,
				accountId: "account-3",
				email: "three@example.com",
			},
		]);
		usageReports.set("three@example.com", {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: {
						used: 10,
						limit: Number.POSITIVE_INFINITY,
						unit: "percent",
					},
					status: "ok",
				},
			],
			metadata: { email: "three@example.com", accountId: "account-3" },
		});

		health = await authStorage.getModelUsageHealth("anthropic", {
			modelId: "claude-sonnet-4-5",
		});
		expect(health.accounts[0].primary?.usedFraction).toBeUndefined();
	});
});
