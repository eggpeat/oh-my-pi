/**
 * Task tool renderer export.
 *
 * Separated from render.ts to avoid circular dependency issues with
 * tools/renderers.ts. This module has no side effects and can be safely
 * imported without triggering the subprocessToolRegistry registration.
 */
import { renderCall, renderResult } from "./render";

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function hasTimeBasedProgress(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "running") {
		if (isRecord(value.retryState)) return true;
		if (typeof value.currentTool === "string" && typeof value.currentToolStartMs === "number") return true;
	}
	// Nested `task` snapshots inherit their own time-based rows: a running child
	// with a retry countdown or elapsed current tool must keep the parent's
	// repaint timer alive even when the parent row itself is quiescent.
	const nested = isRecord(value.extractedToolData) ? value.extractedToolData.task : undefined;
	if (Array.isArray(nested) && nested.some(hasTimeBasedTaskDetails)) return true;
	if (hasTimeBasedTaskDetails(value.inflightTaskDetails)) return true;
	return false;
}

function hasTimeBasedTaskDetails(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.progress)) return false;
	return value.progress.some(hasTimeBasedProgress);
}

function timeBasedPartialResult(_args: unknown, result: { details?: unknown }): boolean {
	return hasTimeBasedTaskDetails(result.details);
}

export const taskToolRenderer = {
	renderCall,
	renderResult,
	mergeCallAndResult: true,
	timeBasedPartialResult,
} as const;
