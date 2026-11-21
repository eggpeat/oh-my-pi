import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const agentDir = path.join(import.meta.dir, "..", "agent");
const pythonPath = Bun.which("python3") ?? Bun.which("python") ?? "python3";

// omp_local.py imports harbor at module load and patches two harbor classes.
// Stub exactly those names so the real agent module imports outside a harbor
// install; the provider-key collection under test is omp_local's own code.
const HARNESS = `
import json
import os
import sys
import types


def _mod(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


class _Stub:
    pass


_mod("harbor")
_mod("harbor.agents")
_mod("harbor.agents.installed")
_mod(
    "harbor.agents.installed.base",
    BaseInstalledAgent=_Stub,
    with_prompt_template=lambda fn: fn,
)
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-local-keys-"));
	try {
		const scriptPath = path.join(dir, "collect.py");
		await Bun.write(scriptPath, HARNESS);
		const proc = Bun.spawn([pythonPath, scriptPath, provider], {
			stdout: "pipe",
			stderr: "pipe",
			// Isolated env: only the vars under test can be collected.
			env: { PATH: process.env.PATH ?? "", OMP_LOCAL_AGENT_DIR: agentDir, ...env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(`omp_local harness failed (${exitCode}): ${stderr}`);
		return JSON.parse(stdout.trim()) as Record<string, string>;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("omp_local direct-auth provider keys", () => {
	it("forwards COPILOT_GITHUB_TOKEN for github-copilot, not the generic GITHUB_TOKEN omp rejects", async () => {
		const keys = await collectProviderKeys("github-copilot", {
			COPILOT_GITHUB_TOKEN: "copilot-token",
			GITHUB_TOKEN: "generic-token",
		});
		expect(keys).toEqual({ COPILOT_GITHUB_TOKEN: "copilot-token" });
	});

	it("forwards the primary HUGGINGFACE_HUB_TOKEN for huggingface, not only the HF_TOKEN fallback", async () => {
		const keys = await collectProviderKeys("huggingface", {
			HUGGINGFACE_HUB_TOKEN: "hub-token",
			HF_TOKEN: "hf-token",
		});
		expect(keys).toEqual({ HF_TOKEN: "hf-token", HUGGINGFACE_HUB_TOKEN: "hub-token" });
	});
});
