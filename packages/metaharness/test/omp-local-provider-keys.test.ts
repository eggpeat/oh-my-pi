import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { $whichAll } from "@oh-my-pi/pi-utils";

const agentDir = path.join(import.meta.dir, "..", "agent");

// omp_local.py uses typing.override (Python 3.12+); enumerate every PATH match
// for each Python name so an older shim/install earlier on PATH cannot hide a
// working 3.12+ interpreter, and return sys.executable so running under an
// isolated env does not depend on version-manager shims (e.g. PYENV_VERSION).
function findPython312(): string | null {
	const explicit = Bun.env.PYTHON?.trim();
	const explicitBins = explicit
		? path.isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\")
			? [
					explicit.startsWith("~/") || explicit.startsWith("~\\")
						? path.join(os.homedir(), explicit.slice(2))
						: explicit,
				]
			: $whichAll(explicit)
		: [];
	const candidates = [
		...explicitBins,
		...["python3.16", "python3.15", "python3.14", "python3.13", "python3.12", "python3", "python"].flatMap(name =>
			$whichAll(name),
		),
	];
	const seen = new Set<string>();
	for (const bin of candidates) {
		const key = process.platform === "win32" ? bin.toLowerCase() : bin;
		if (!bin || seen.has(key)) continue;
		seen.add(key);
		try {
			const probe = Bun.spawnSync(
				[
					bin,
					"-B",
					"-c",
					"import sys\nif sys.version_info < (3, 12):\n    raise SystemExit(1)\nsys.stdout.buffer.write(sys.executable.encode('utf-8'))",
				],
				{ stdout: "pipe", stderr: "ignore" },
			);
			if (probe.exitCode === 0) {
				return Buffer.from(probe.stdout).toString("utf8") || bin;
			}
		} catch {
			// Candidate path is missing or not executable; try the next match.
		}
	}
	return null;
}

const pythonPath = findPython312();

// omp_local.py imports harbor at module load and patches two harbor classes.
// Stub those names and run OmpLocal.run() in --no-gateway mode so tests assert
// the final task environment passed to exec_as_agent after --env overrides.
const HARNESS = `
import asyncio, json, os, sys, types

def _mod(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m

class _Stub:
    captured_env = None

    async def exec_as_agent(self, environment, *, command, env=None):
        self.captured_env = env

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
agent.model_name = f"{sys.argv[1]}/test-model"
asyncio.run(agent.run("check", _Stub(), _Stub()))
run_env = {
    k: v
    for k, v in (agent.captured_env or {}).items()
    if k != "OMP_DAEMON_IDLE_GRACE_MS"
}
print(json.dumps(run_env, sort_keys=True))
`;

async function collectTaskEnv(
	provider: string,
	hostEnv: Record<string, string>,
	forwardEnv?: Record<string, string>,
): Promise<Record<string, string>> {
	if (!pythonPath) throw new Error("Python 3.12+ is required to import omp_local.py");
	const proc = Bun.spawn([pythonPath, "-B", "-c", HARNESS, provider], {
		stdout: "pipe",
		stderr: "pipe",
		// Isolated env: only the host vars and --env payload under test exist.
		env: {
			PATH: process.env.PATH ?? "",
			...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
			PYTHONDONTWRITEBYTECODE: "1",
			OMP_LOCAL_AGENT_DIR: agentDir,
			OMP_BENCH_GATEWAY: "0",
			...hostEnv,
			...(forwardEnv ? { OMP_BENCH_FORWARD_ENV: JSON.stringify(forwardEnv) } : {}),
		},
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
		const keys = await collectTaskEnv("github-copilot", {
			COPILOT_GITHUB_TOKEN: "copilot-token",
			GITHUB_TOKEN: "generic-token",
		});
		expect(keys).toEqual({ COPILOT_GITHUB_TOKEN: "copilot-token" });
	}, 15_000);

	it("forwards only HUGGINGFACE_HUB_TOKEN for huggingface when nonblank", async () => {
		const keys = await collectTaskEnv("huggingface", {
			HUGGINGFACE_HUB_TOKEN: "hub-token",
			HF_TOKEN: "hf-token",
		});
		expect(keys).toEqual({ HUGGINGFACE_HUB_TOKEN: "hub-token" });
	}, 15_000);

	it("falls back to HF_TOKEN for huggingface when HUGGINGFACE_HUB_TOKEN is unset or blank", async () => {
		expect(await collectTaskEnv("huggingface", { HF_TOKEN: "hf-token" })).toEqual({
			HF_TOKEN: "hf-token",
		});
		expect(
			await collectTaskEnv("huggingface", {
				HUGGINGFACE_HUB_TOKEN: "   ",
				HF_TOKEN: "hf-token",
			}),
		).toEqual({
			HF_TOKEN: "hf-token",
		});
	}, 15_000);

	it("applies --env overrides before selecting the host Hugging Face token", async () => {
		expect(
			await collectTaskEnv("huggingface", { HF_TOKEN: "host-hf" }, { HUGGINGFACE_HUB_TOKEN: "explicit-hub" }),
		).toEqual({
			HUGGINGFACE_HUB_TOKEN: "explicit-hub",
		});
		expect(
			await collectTaskEnv(
				"huggingface",
				{ HUGGINGFACE_HUB_TOKEN: "host-hub", HF_TOKEN: "host-hf" },
				{ HUGGINGFACE_HUB_TOKEN: "" },
			),
		).toEqual({
			HF_TOKEN: "host-hf",
			HUGGINGFACE_HUB_TOKEN: "",
		});
	}, 15_000);
});
