import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "../../tools/todo";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

export type TodoMutationVerb = "done" | "drop" | "rm";

interface TodoTaskMatch {
	task: TodoItem;
	phase: TodoPhase;
}

export interface TodoCommitHost {
	session: Pick<AgentSession, "commitTodoPhases">;
	agent: Pick<Agent, "appendMessage">;
	sessionManager: Pick<SessionManager, "appendMessage">;
	onCommit?: (phases: TodoPhase[]) => void;
}

export type TodoCommandMutationResult =
	| { ok: true; nextPhases: TodoPhase[]; action: string; status: string; removed?: boolean }
	| { ok: false; error: string };
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			current += input[++index];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	const exact = phases.find(phase => phase.name.toLowerCase() === normalizedQuery);
	if (exact) return exact;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(normalizedQuery));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(normalizedQuery));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): TodoTaskMatch | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === normalizedQuery) return { task, phase };
		}
	}
	const matches: TodoTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(normalizedQuery)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const active = matches.filter(match => match.task.status === "in_progress" || match.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

export function getLatestSlashTodoPhases(
	sessionManager: Pick<SessionManager, "getBranch">,
	session: Pick<AgentSession, "getTodoPhases">,
): TodoPhase[] {
	const fromEntries = getLatestTodoPhasesFromEntries(sessionManager.getBranch());
	return fromEntries.length > 0 ? fromEntries : session.getTodoPhases();
}

function buildTodoSystemReminder(action: string, phases: TodoPhase[], removed = false): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `The user manually modified the todo list (${action}).`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current todo list:", "", md, "</system-reminder>");
	return lines.join("\n");
}

export function commitTodoEdit(
	host: TodoCommitHost,
	nextPhases: TodoPhase[],
	action: string,
	opts?: { removed?: boolean },
): void {
	// Commit first so HUD visibility binds to the new canonical source.
	host.session.commitTodoPhases(nextPhases);
	host.onCommit?.(nextPhases);

	// Inject system reminder so the agent learns about the change next turn.
	// Removals carry explicit intent so the agent does not rebuild the
	// cleared/removed items on its next turn (issue #5258).
	const reminderText = buildTodoSystemReminder(action, nextPhases, opts?.removed ?? false);
	const message = {
		role: "developer" as const,
		content: [{ type: "text" as const, text: reminderText }],
		attribution: "user" as const,
		timestamp: Date.now(),
	};
	host.agent.appendMessage(message);
	host.sessionManager.appendMessage(message);
}

function currentPhases(runtime: SlashCommandRuntime): TodoPhase[] {
	return getLatestSlashTodoPhases(runtime.sessionManager, runtime.session);
}

function commitHost(runtime: SlashCommandRuntime): TodoCommitHost {
	return {
		session: runtime.session,
		agent: runtime.session.agent,
		sessionManager: runtime.sessionManager,
	};
}

export function planTodoAppend(current: TodoPhase[], restArgs: string): TodoCommandMutationResult {
	const tokens = tokenize(restArgs);
	if (tokens.length === 0) return { ok: false, error: "Usage: /todo append [<phase>] <task...>" };

	const phaseName = tokens.length === 1 ? undefined : tokens[0];
	const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
	const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
	let targetPhase: TodoPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCaseWords(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1]!;
	} else {
		targetPhase = { name: "Todos", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });
	return {
		ok: true,
		nextPhases: next,
		action: `/todo append → ${targetPhase.name}`,
		status: `Appended to ${targetPhase.name}: ${finalContent}`,
	};
}

export function planTodoStart(current: TodoPhase[], restArgs: string): TodoCommandMutationResult {
	const trimmed = restArgs.trim();
	if (!trimmed) return { ok: false, error: "Usage: /todo start <task>" };
	const query = tokenize(trimmed).join(" ") || trimmed;
	const hit = findTaskFuzzy(current, query);
	if (!hit) return { ok: false, error: `No task matched "${trimmed}". Use /todo to list current tasks.` };
	const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
	if (errors.length > 0) return { ok: false, error: errors.join("; ") };
	return {
		ok: true,
		nextPhases: phases,
		action: `/todo start ${hit.task.content}`,
		status: `Started: ${hit.task.content}`,
	};
}

export function planTodoMutation(
	current: TodoPhase[],
	verb: TodoMutationVerb,
	restArgs: string,
): TodoCommandMutationResult {
	const trimmed = restArgs.trim();
	const isRemove = verb === "rm";
	if (!trimmed) {
		if (isRemove) {
			return {
				ok: true,
				nextPhases: [],
				action: "/todo rm (all)",
				status: "Cleared all todos.",
				removed: true,
			};
		}
		// no-arg: apply to all. The tool refuses a bare done/drop, so every task is named.
		const all = current.flatMap(phase => phase.tasks.map(task => task.content));
		const { phases, errors } =
			all.length > 0 ? applyOpsToPhases(current, [{ op: verb, task: all }]) : { phases: current, errors: [] };
		if (errors.length > 0) return { ok: false, error: errors.join("; ") };
		return {
			ok: true,
			nextPhases: phases,
			action: `/todo ${verb} (all)`,
			status: verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned.",
		};
	}

	const taskHit = findTaskFuzzy(current, trimmed);
	if (taskHit) {
		const { phases, errors } = applyOpsToPhases(current, [{ op: verb, task: taskHit.task.content }]);
		if (errors.length > 0) return { ok: false, error: errors.join("; ") };
		const label = verb === "done" ? "Marked completed" : verb === "drop" ? "Marked abandoned" : "Removed";
		return {
			ok: true,
			nextPhases: phases,
			action: `/todo ${verb} ${taskHit.task.content}`,
			status: `${label}: ${taskHit.task.content}`,
			removed: isRemove,
		};
	}

	const phaseHit = findPhaseFuzzy(current, trimmed);
	if (phaseHit) {
		const { phases, errors } = applyOpsToPhases(current, [{ op: verb, phase: phaseHit.name }]);
		if (errors.length > 0) return { ok: false, error: errors.join("; ") };
		const status =
			verb === "done"
				? `Marked phase ${phaseHit.name} completed.`
				: verb === "drop"
					? `Marked phase ${phaseHit.name} abandoned.`
					: `Removed phase: ${phaseHit.name}`;
		return {
			ok: true,
			nextPhases: phases,
			action: `/todo ${verb} ${phaseHit.name}`,
			status,
			removed: isRemove,
		};
	}

	return { ok: false, error: `No task or phase matched "${trimmed}".` };
}

const TODO_HELP_TEXT = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         (TUI only) open in $EDITOR",
	"  /todo copy                         Print todos as Markdown",
	"  /todo expand                       (TUI only) expand the sticky HUD",
	"  /todo collapse                     (TUI only) collapse the sticky HUD",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task",
	"  /todo start  <task>                Mark task in_progress (fuzzy match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

async function handleTodoCopyCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	await runtime.output(`Copy not available in ACP mode; printing instead:\n\n${markdown || "No todos."}`);
	return commandConsumed();
}

async function handleTodoExportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	if (phases.length === 0) {
		await runtime.output("No todos to export.");
		return commandConsumed();
	}
	let target: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		await Bun.write(target, phasesToMarkdown(phases));
	} catch (err) {
		return usage(`Failed to write todos: ${errorMessage(err)}`, runtime);
	}
	await runtime.output(`Wrote todos to ${target}`);
	return commandConsumed();
}

async function handleTodoImportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	let target: string;
	let content: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		content = await Bun.file(target).text();
	} catch (err) {
		return usage(`Failed to read todos: ${errorMessage(err)}`, runtime);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) return usage(`Could not parse ${target}:\n  ${errors.join("\n  ")}`, runtime);
	commitTodoEdit(commitHost(runtime), phases, `/todo import ${target}`);
	const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	await runtime.output(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${target}.`);
	return commandConsumed();
}

async function applyPlannedMutation(
	result: TodoCommandMutationResult,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!result.ok) return usage(result.error, runtime);
	commitTodoEdit(commitHost(runtime), result.nextPhases, result.action, { removed: result.removed });
	await runtime.output(result.status);
	return commandConsumed();
}

async function handleTodoAppendCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	return await applyPlannedMutation(planTodoAppend(currentPhases(runtime), restArgs), runtime);
}

async function handleTodoStartCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	return await applyPlannedMutation(planTodoStart(currentPhases(runtime), restArgs), runtime);
}

async function handleTodoMutationCommand(
	verb: TodoMutationVerb,
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	return await applyPlannedMutation(planTodoMutation(currentPhases(runtime), verb, restArgs), runtime);
}

/** ACP/text-mode `/todo` handler. Shared by both dispatchers via the spec. */
export async function handleTodoAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const trimmed = command.args.trim();
	if (!trimmed) {
		const phases = currentPhases(runtime);
		await runtime.output(
			phases.length === 0 ? "No todos. Use /todo append <task> to start one." : phasesToMarkdown(phases).trimEnd(),
		);
		return commandConsumed();
	}

	const { verb, rest } = parseSubcommand(trimmed);
	switch (verb) {
		case "copy":
			return await handleTodoCopyCommand(runtime);
		case "export":
			return await handleTodoExportCommand(rest, runtime);
		case "import":
			return await handleTodoImportCommand(rest, runtime);
		case "append":
			return await handleTodoAppendCommand(rest, runtime);
		case "start":
			return await handleTodoStartCommand(rest, runtime);
		case "done":
		case "drop":
		case "rm":
			return await handleTodoMutationCommand(verb, rest, runtime);
		case "edit":
			return usage(
				"/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.",
				runtime,
			);
		case "expand":
		case "collapse":
			return usage(`/todo ${verb} controls the interactive HUD and is unavailable in this mode.`, runtime);
		case "help":
		case "?":
			await runtime.output(TODO_HELP_TEXT);
			return commandConsumed();
		default:
			return usage("Unknown /todo subcommand. Use append, start, done, drop, rm, copy, export, import.", runtime);
	}
}
