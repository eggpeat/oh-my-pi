/**
 * Built-in status-line presets, rather than the raw custom-segment defaults,
 * determine which facts and timers the interactive status model maintains.
 */
import * as os from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CUSTOM_STATUS_LINE_DEFAULTS } from "@oh-my-pi/pi-coding-agent/config/status-line-schema";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { cfgGitEnabled, cfgStatusLinePreset } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { PromptCacheStatus } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/host";
import type { VcsGitRepo, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { disposeStatusLines, flushStatus, statusLine, statusSession } from "./helpers/session-status-line";

const rawCustomDefaults = {
	leftSegments: [...CUSTOM_STATUS_LINE_DEFAULTS.left],
	rightSegments: [...CUSTOM_STATUS_LINE_DEFAULTS.right],
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	cfgStatusLinePreset.clearOverride(Settings.instance);
	cfgGitEnabled.clearOverride(Settings.instance);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("status line built-in preset segments", () => {
	it("collects hostname and prompt-cache facts shown by the full preset", () => {
		const promptCache: PromptCacheStatus = {
			state: "warm",
			inferred: false,
			tier: "short",
			touchedAt: 1_000,
			cachedTokens: 42,
			nextTokens: 60,
		};
		const line = statusLine(statusSession({ getPromptCacheStatus: () => promptCache }), {
			...rawCustomDefaults,
			preset: "full",
		});
		line.setCheckoutHomed(true);

		expect(line.facts().hostname).toBe(os.hostname().split(".")[0]);
		expect(line.facts().promptCache).toEqual(promptCache);
	});

	it("advances the full preset's wall clock from startup without a settings change", () => {
		vi.useFakeTimers({ now: 1_000_000_000 });
		cfgStatusLinePreset.override(Settings.instance, "full");
		const line = statusLine(statusSession());
		line.setCheckoutHomed(true);
		const initial = line.facts().now;

		vi.advanceTimersByTime(2_000);

		expect(line.facts().now).toBe(initial + 2_000);
	});

	it("does not look up pull requests omitted by the minimal preset", async () => {
		cfgGitEnabled.override(Settings.instance, true);
		const statusSummary = vi.fn(async () => ({ staged: 0, unstaged: 0, untracked: 0 }));
		const git = {
			headSync: () => ({
				kind: "ref",
				branch: "feature/preset",
				refName: "refs/heads/feature/preset",
			}),
			linkedWorktree: () => null,
		} as unknown as VcsGitRepo;
		const repository = {
			asGit: () => git,
			statusSummary,
		} as unknown as VcsRepo;
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(repository);
		vi.spyOn(vcs, "repo").mockReturnValue(repository);
		vi.spyOn(vcs, "git").mockReturnValue(null);
		const lookup = vi.spyOn(statusLineHost, "lookupPullRequest").mockResolvedValue({ exitCode: 1, stdout: "" });
		const line = statusLine(statusSession(), { ...rawCustomDefaults, preset: "minimal" });

		line.facts();
		await flushStatus();

		expect(statusSummary).toHaveBeenCalled();
		expect(line.facts().git?.branch).toBe("feature/preset");
		expect(lookup).not.toHaveBeenCalled();
	});
});
