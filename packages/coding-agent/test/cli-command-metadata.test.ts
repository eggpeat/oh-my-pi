import { describe, expect, it, spyOn } from "bun:test";
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
		expect(extraHelp).not.toContain("--plugin-dir");
		expect(extraHelp).not.toContain("Plugin Options:");

		const [bash, zsh, fish] = await Promise.all([
			generateLiveCompletion("bash"),
			generateLiveCompletion("zsh"),
			generateLiveCompletion("fish"),
		]);

		expect(zsh).toMatch(/'--fork\[[^\]]+\]:session:_omp_call sessions'/);
		expect(zsh).toMatch(/'--session\[[^\]]+\]:session:_omp_call sessions'/);
		expect(zsh).toMatch(/'\*--plugin-dir\[[^\]]+\]:dir:_files -\/'/);
		expect(zsh).toMatch(/'\*--trusted-extension\[[^\]]+\]:file:_files'/);
		expect(zsh).toContain("'--provider-session-id[");
		expect(zsh).toContain("'--prompt-cache-key[");

		expect(bash).toContain('--fork)\n\t\t\tCOMPREPLY=( $(compgen -W "$(command omp __complete sessions -- "$cur"');
		expect(bash).toContain('--session)\n\t\t\tCOMPREPLY=( $(compgen -W "$(command omp __complete sessions -- "$cur"');
		expect(bash).toContain(
			'--plugin-dir)\n\t\t\tCOMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames; return 0',
		);
		expect(bash).toContain(
			'--trusted-extension)\n\t\t\tCOMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames; return 0',
		);
		expect(bash).toContain("--provider-session-id)");
		expect(bash).toContain("--prompt-cache-key)");

		expect(fish).toMatch(/-l fork -d '[^']+' -x -a '\(command omp __complete sessions -- \(commandline -ct\)\)'/);
		expect(fish).toMatch(/-l session -d '[^']+' -x -a '\(command omp __complete sessions -- \(commandline -ct\)\)'/);
		expect(fish).toMatch(/-l plugin-dir -d '[^']+' -x -a '\(__fish_complete_directories \(commandline -ct\)\)'/);
		expect(fish).toMatch(/-l trusted-extension -d '[^']+' -r -F/);
		expect(fish).toMatch(/-l provider-session-id -d '[^']+' -r -F/);
		expect(fish).toMatch(/-l prompt-cache-key -d '[^']+' -r -F/);
	}, 30_000);
});
