import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const agentDir = path.join(import.meta.dir, "..", "agent");

// omp_local.py uses typing.override (Python 3.12+); select the first installed
// Python 3.12+ interpreter so hosts where python3 is 3.10/3.11 do not fail on
// import before the provider-key assertions run.
function findPython312(): string | null {
	const candidates = [
		Bun.env.PYTHON,
		"python3.16",
		"python3.15",
		"python3.14",
		"python3.13",
		"python3.12",
		"python3",
		"python",
	];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate) continue;
		const bin = candidate.includes("/") || candidate.includes("\\") ? candidate : Bun.which(candidate);
		if (!bin || seen.has(bin)) continue;
		seen.add(bin);
		try {
			const probe = Bun.spawnSync(
				[bin, "-B", "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"],
				{ stdout: "ignore", stderr: "ignore" },
			);
			if (probe.exitCode === 0) return bin;
		} catch {
			// Candidate path is missing or not executable; try the next one.
		}
	}
	return null;
}

const pythonPath = findPython312();

// omp_local.py imports harbor at module load and patches two harbor classes.
// Stub exactly those names so the real agent module imports outside a harbor
// install; the provider-key collection under test is omp_local's own code.
const HARNESS = `
import json, os, sys, types

def _mod(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m

class _Stub:
    pass

_mod("harbor")
_mod("harbor.agents")
_mod("harbor.agents.installed")
_mod("harbor.agents.installed.base", BaseInstalledAgent=_Stub, with_prompt_template=lambda fn: fn)
_mod("harbor.environments")
_mod("harbor.environments.base", BaseEnvironment=_Stub)
_mod("harbor.environments.apple_container", AppleContainerEnvironment=_Stub)
_mod("harbor.models")
_mod("harbor.models.agent")
_mod("harbor.models.agent.context", AgentContext=_Stub)
_mod("harbor.trial")
_mod("harbor.trial.trial", Trial=type("Trial", (), {}))

sys.path.insert(0, os.environ["OMP_LOCAL_AGENT_DIR"])
import omp_local

agent = omp_local.OmpLocal()
print(json.dumps(agent._collect_provider_keys(sys.argv[1]), sort_keys=True))
`;

async function collectProviderKeys(provider: string, env: Record<string, string>): Promise<Record<string, string>> {
	if (!pythonPath) throw new Error("Python 3.12+ is required to import omp_local.py");
	const proc = Bun.spawn([pythonPath, "-B", "-c", HARNESS, provider], {
		stdout: "pipe",
		stderr: "pipe",
		// Isolated env: only the vars under test can be collected.
		env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1", OMP_LOCAL_AGENT_DIR: agentDir, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`omp_local harness failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Record<string, string>;
}

describe.skipIf(pythonPath === null)("omp_local direct-auth provider keys", () => {
	it("forwards COPILOT_GITHUB_TOKEN for github-copilot, not the generic GITHUB_TOKEN omp rejects", async () => {
		const keys = await collectProviderKeys("github-copilot", {
			COPILOT_GITHUB_TOKEN: "copilot-token",
			GITHUB_TOKEN: "generic-token",
		});
		expect(keys).toEqual({ COPILOT_GITHUB_TOKEN: "copilot-token" });
	}, 15_000);

	it("forwards only HUGGINGFACE_HUB_TOKEN for huggingface when nonblank", async () => {
		const keys = await collectProviderKeys("huggingface", {
			HUGGINGFACE_HUB_TOKEN: "hub-token",
			HF_TOKEN: "hf-token",
		});
		expect(keys).toEqual({ HUGGINGFACE_HUB_TOKEN: "hub-token" });
	}, 15_000);

	it("falls back to HF_TOKEN for huggingface when HUGGINGFACE_HUB_TOKEN is unset or blank", async () => {
		expect(await collectProviderKeys("huggingface", { HF_TOKEN: "hf-token" })).toEqual({
			HF_TOKEN: "hf-token",
		});
		expect(
			await collectProviderKeys("huggingface", {
				HUGGINGFACE_HUB_TOKEN: "   ",
				HF_TOKEN: "hf-token",
			}),
		).toEqual({
			HF_TOKEN: "hf-token",
		});
	}, 15_000);
});
