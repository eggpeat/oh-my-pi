import * as fs from "node:fs/promises";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	commitTodoEdit,
	getLatestSlashTodoPhases,
	planTodoAppend,
	planTodoMutation,
	planTodoStart,
	type TodoCommandMutationResult,
	type TodoCommitHost,
	type TodoMutationVerb,
} from "../../slash-commands/helpers/todo";
import { markdownToPhases, phasesToMarkdown, resolveTodoMarkdownPath } from "../../tools/todo";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in $EDITOR",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo expand                       Show every phase and task in the HUD",
	"  /todo collapse                     Restore the bounded HUD preview",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /todo start  <task>                Mark task in_progress (fuzzy content match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

export class TodoCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	/**
	 * True latest todo state for the user-facing /todo verbs. Reads from session
	 * entries or falls back to the active session state.
	 */
	#currentPhases(): TodoPhase[] {
		return getLatestSlashTodoPhases(this.ctx.sessionManager, this.ctx.session);
	}

	#commitHost(): TodoCommitHost {
		return {
			session: this.ctx.session,
			agent: this.ctx.agent,
			sessionManager: this.ctx.sessionManager,
			onCommit: phases => this.ctx.setTodos(phases),
		};
	}

	async handleTodoCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "expand":
				this.ctx.setTodoExpanded(true);
				return;
			case "collapse":
				if (this.ctx.todoExpanded) this.ctx.toggleTodoExpansion();
				return;
			case "edit":
				await this.#editInExternalEditor();
				return;
			case "copy":
				this.#copyMarkdown();
				return;
			case "export":
				await this.#exportToFile(rest);
				return;
			case "import":
				await this.#importFromFile(rest);
				return;
			case "help":
			case "?":
				this.ctx.showStatus(USAGE);
				return;
			case "append":
				this.#applyPlanned(planTodoAppend(this.#currentPhases(), rest));
				return;
			case "start":
				this.#applyPlanned(planTodoStart(this.#currentPhases(), rest));
				return;
			case "done":
				this.#mutate("done", rest);
				return;
			case "drop":
				this.#mutate("drop", rest);
				return;
			case "rm":
				this.#mutate("rm", rest);
				return;
			default:
				this.ctx.showError(`Unknown /todo verb "${verb}".\n${USAGE}`);
		}
	}

	#showCurrent(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("No todos. Use /todo append <task> to start one.");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No todos to copy.");
			return;
		}
		try {
			copyToClipboard(phasesToMarkdown(phases));
			this.ctx.showStatus("Copied todos as Markdown to clipboard.");
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	#resolveTodoPath(rest: string): string {
		return resolveTodoMarkdownPath(rest, this.ctx.sessionManager.getCwd());
	}

	async #exportToFile(rest: string): Promise<void> {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No todos to export.");
			return;
		}
		try {
			const target = this.#resolveTodoPath(rest);
			await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
			this.ctx.showStatus(`Wrote todos to ${target}`);
		} catch (error) {
			this.ctx.showError(`Failed to write todos: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #importFromFile(rest: string): Promise<void> {
		let source = "";
		let content: string;
		try {
			source = this.#resolveTodoPath(rest);
			content = await fs.readFile(source, "utf8");
		} catch (error) {
			this.ctx.showError(`Failed to read todos: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			this.ctx.showError(`Could not parse ${source}:\n  ${errors.join("\n  ")}`);
			return;
		}
		this.#commit(phases, `/todo import ${source}`);
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		this.ctx.showStatus(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`);
	}

	// ------------------------------------------------------------- editor

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const current = this.#currentPhases();
		const initialMarkdown =
			current.length > 0 ? phasesToMarkdown(current) : "# Todos\n- [ ] (replace this with your tasks)\n";

		this.ctx.ui.stop();
		try {
			const result = await openInEditor(editorCmd, initialMarkdown, { extension: ".todo.md" });
			if (result === null) {
				this.ctx.showWarning("Editor exited without saving; todos unchanged.");
				return;
			}
			const { phases: parsed, errors } = markdownToPhases(result);
			if (errors.length > 0) {
				this.ctx.showError(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
				return;
			}
			this.#commit(parsed, "/todo edit");
			const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
			this.ctx.showStatus(`Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`);
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	#mutate(verb: TodoMutationVerb, rest: string): void {
		this.#applyPlanned(planTodoMutation(this.#currentPhases(), verb, rest));
	}

	#applyPlanned(result: TodoCommandMutationResult): void {
		if (!result.ok) {
			this.ctx.showError(result.error);
			return;
		}
		this.#commit(result.nextPhases, result.action, { removed: result.removed });
		this.ctx.showStatus(result.status);
	}

	#commit(nextPhases: TodoPhase[], action: string, opts?: { removed?: boolean }): void {
		commitTodoEdit(this.#commitHost(), nextPhases, action, opts);
	}
}
