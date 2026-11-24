import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CliConfig,
	type CommandCtor,
	type CommandMetadata,
	renderCommandHelp,
	renderRootHelp,
} from "@oh-my-pi/pi-utils/cli";
import { OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS, VALUELESS_FLAGS } from "../src/cli/flag-tables";
import { getExtraHelpText } from "../src/cli/help-extra";
import { commands } from "../src/cli-commands";
import { generateLiveCompletion } from "../src/commands/completions";
import { launchHelp } from "../src/commands/launch-help";

function captureStdout(render: () => void): string {
	const chunks: string[] = [];
	const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		chunks.push(String(chunk));
		return true;
	});
	try {
		render();
	} finally {
		stdoutSpy.mockRestore();
	}
	return chunks.join("");
}

function bashQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Source the generated script and read COMPREPLY. Does not depend on the script's indentation. */
function completeWithBash(script: string, words: string[], cwd: string, binDir: string): string[] {
	const scriptPath = path.join(binDir, "completion.bash");
	fs.writeFileSync(scriptPath, script);
	const env: Record<string, string | undefined> = {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
	};
	delete env.BASH_ENV;
	const harness = [
		"set +e",
		`source ${bashQuote(scriptPath)}`,
		`COMP_WORDS=(${words.map(bashQuote).join(" ")})`,
		`COMP_CWORD=${words.length - 1}`,
		"_omp",
		"printf '%s\\n' \"${COMPREPLY[@]}\"",
	].join("\n");
	const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-c", harness], { cwd, env });
	if (result.exitCode !== 0) {
		throw new Error(
			`bash completion for ${JSON.stringify(words)} exited ${result.exitCode}: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().split("\n").filter(line => line.length > 0);
}

function fishFlagLine(script: string, flag: string): string {
	const line = script.split("\n").find(entry => entry.includes(`-l ${flag} `));
	if (!line) throw new Error(`fish completion has no -l ${flag} line`);
	return line;
}

describe("CLI command help metadata", () => {
	it("renders the same root help as the loaded command classes", async () => {
		const metadata = new Map<string, CommandMetadata>();
		const constructors = new Map<string, CommandCtor>();
		for (const entry of commands) {
			expect(entry.help, `${entry.name} must provide static help metadata`).toBeDefined();
			if (!entry.help) continue;
			metadata.set(entry.name, entry.help);
			constructors.set(entry.name, await entry.load());
		}

		const base = { bin: "omp", version: "test" };
		const metadataConfig: CliConfig<CommandMetadata> = { ...base, commands: metadata };
		const constructorConfig: CliConfig = { ...base, commands: constructors };
		const metadataRoot = captureStdout(() => renderRootHelp(metadataConfig));
		const constructorRoot = captureStdout(() => renderRootHelp(constructorConfig));
		expect(metadataRoot).toBe(constructorRoot);

		const visibleNames = commands.filter(entry => !entry.help?.hidden).map(entry => entry.name);
		const maxNameLength = Math.max(...visibleNames.map(name => name.length));
		for (const name of visibleNames) {
			const Command = constructors.get(name);
			if (!Command) throw new Error(`Missing loaded command: ${name}`);
			const commandOutput = captureStdout(() => renderCommandHelp("omp", name, Command));
			const description = commandOutput.split("\n", 1)[0];
			expect(metadataRoot).toContain(`  ${name.padEnd(maxNameLength + 2)}${description}`);
		}
	});

	it("declares every launch flag in launchHelp, root help, and live shell completions", async () => {
		const flagsByToken = new Map<string, (typeof launchHelp.flags)[keyof typeof launchHelp.flags]>();
		for (const [name, desc] of Object.entries(launchHelp.flags)) {
			flagsByToken.set(`--${name}`, desc);
			if ("char" in desc && typeof desc.char === "string") {
				flagsByToken.set(`-${desc.char}`, desc);
			}
			if ("aliases" in desc && Array.isArray(desc.aliases)) {
				for (const alias of desc.aliases) {
					flagsByToken.set(`--${alias}`, desc);
				}
			}
		}

		for (const flag of [...STRING_VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS]) {
			expect(flagsByToken.get(flag)?.kind, `${flag} must be declared as a string flag in launchHelp`).toBe("string");
		}
		for (const flag of VALUELESS_FLAGS) {
			if (flag === "--help" || flag === "--version") continue;
			expect(flagsByToken.get(flag)?.kind, `${flag} must be declared as a boolean flag in launchHelp`).toBe(
				"boolean",
			);
		}

		const metadata = new Map<string, CommandMetadata>();
		for (const entry of commands) {
			if (entry.help) metadata.set(entry.name, entry.help);
		}
		const rootHelp = captureStdout(() => renderRootHelp({ bin: "omp", version: "test", commands: metadata }));
		for (const flag of [
			"--fork=<value>",
			"--session=<value>",
			"--plugin-dir=<value>",
			"--trusted-extension=<value>",
			"--provider-session-id=<value>",
			"--prompt-cache-key=<value>",
		]) {
			expect(rootHelp).toContain(flag);
		}

		const extraHelp = getExtraHelpText();
		const combinedHelp = `${rootHelp}\n${extraHelp}`.replace(/\x1b\[[0-9;]*m/g, "");
		// Count the listing. A second `--plugin-dir` (the old extra-help note) fails this;
		// a heading with no second listing does not.
		expect(combinedHelp.match(/--plugin-dir\b/g) ?? []).toHaveLength(1);

		const [bash, zsh, fish] = await Promise.all([
			generateLiveCompletion("bash"),
			generateLiveCompletion("zsh"),
			generateLiveCompletion("fish"),
		]);

		expect(zsh).toMatch(/--session\[[^\]]*\]::session:_omp_call sessions/);
		expect(zsh).toMatch(/\{-r,--resume\}'\[[^\]]*\]::session:_omp_call sessions/);
		expect(zsh).toMatch(/--restore\[[^\]]*\]::session:_omp_call sessions/);
		expect(zsh).toMatch(/--fork\[[^\]]*\]:session:_omp_call sessions/);
		expect(zsh).not.toMatch(/--fork\[[^\]]*\]::session:/);
		expect(zsh).toMatch(/--trusted-extension\[[^\]]*\]:file:_omp_absolute_files/);
		expect(zsh).not.toMatch(/--trusted-extension\[[^\]]*\]:file:_files'/);
		expect(zsh).toMatch(/--provider-session-id\[[^\]]*\]:value:/);
		expect(zsh).toMatch(/--prompt-cache-key\[[^\]]*\]:value:/);
		expect(zsh).not.toMatch(/--provider-session-id\[[^\]]*\]:file:/);
		expect(zsh).not.toMatch(/--prompt-cache-key\[[^\]]*\]:file:/);
		expect(zsh).toMatch(/--plugin-dir\[[^\]]*\]:dir:_files/);

		expect(fish).toContain("function __omp_absolute_files");
		expect(fishFlagLine(fish, "trusted-extension")).toContain("__omp_absolute_files");
		expect(fishFlagLine(fish, "trusted-extension")).not.toContain("-F");
		expect(fishFlagLine(fish, "provider-session-id")).not.toContain("-F");
		expect(fishFlagLine(fish, "provider-session-id")).not.toContain("-a ");
		expect(fishFlagLine(fish, "prompt-cache-key")).not.toContain("-F");
		expect(fishFlagLine(fish, "prompt-cache-key")).not.toContain("-a ");
		expect(fishFlagLine(fish, "session")).toContain("__complete sessions");
		expect(fishFlagLine(fish, "fork")).toContain("__complete sessions");
		expect(fishFlagLine(fish, "plugin-dir")).toContain("__fish_complete_directories");

		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compl-cwd-"));
		const absDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compl-abs-"));
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compl-bin-"));
		try {
			fs.writeFileSync(path.join(cwd, "relative.ts"), "export {}\n");
			fs.mkdirSync(path.join(cwd, "subdir"));
			fs.writeFileSync(path.join(absDir, "policy.ts"), "export {}\n");
			const stub = path.join(binDir, "omp");
			fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' 'abc123' 'session-two'\n", { mode: 0o755 });
			fs.chmodSync(stub, 0o755);
			const offer = (words: string[]) => completeWithBash(bash, words, cwd, binDir);

			const sessionDash = offer(["omp", "--session", "--mod"]);
			expect(sessionDash).toContain("--model");
			expect(sessionDash).not.toContain("abc123");
			const sessionId = offer(["omp", "--session", "abc"]);
			expect(sessionId).toContain("abc123");
			expect(sessionId).not.toContain("--model");
			const sessionEmpty = offer(["omp", "--session", ""]);
			expect(sessionEmpty).toContain("abc123");
			expect(sessionEmpty).toContain("session-two");

			expect(offer(["omp", "--resume", "--mod"])).toContain("--model");
			expect(offer(["omp", "-r", "--mod"])).toContain("--model");
			expect(offer(["omp", "--restore", "--mod"])).toContain("--model");
			expect(offer(["omp", "--resume", "--mod"])).not.toContain("abc123");

			const forkId = offer(["omp", "--fork", "abc"]);
			expect(forkId).toContain("abc123");
			const forkDash = offer(["omp", "--fork", "--mod"]);
			expect(forkDash).not.toContain("--model");
			expect(forkDash).not.toContain("abc123");

			expect(offer(["omp", "--trusted-extension", "rel"])).not.toContain("relative.ts");
			const emptyTrusted = offer(["omp", "--trusted-extension", ""]);
			expect(emptyTrusted).not.toContain("relative.ts");
			expect(emptyTrusted).not.toContain("subdir");
			const absTrusted = offer(["omp", "--trusted-extension", `${absDir}/`]);
			expect(absTrusted.some(reply => reply.startsWith("/") && reply.endsWith("/policy.ts"))).toBe(true);
			expect(absTrusted.every(reply => reply.startsWith("/") || /^[A-Za-z]:[/\\]/.test(reply))).toBe(true);

			expect(offer(["omp", "--provider-session-id", "rel"])).not.toContain("relative.ts");
			const cacheKey = offer(["omp", "--prompt-cache-key", ""]);
			expect(cacheKey).not.toContain("relative.ts");
			expect(cacheKey).not.toContain("subdir");

			const pluginDir = offer(["omp", "--plugin-dir", "sub"]);
			expect(pluginDir.some(reply => reply === "subdir" || reply === "subdir/")).toBe(true);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
			fs.rmSync(absDir, { recursive: true, force: true });
			fs.rmSync(binDir, { recursive: true, force: true });
		}
	}, 30_000);
});
