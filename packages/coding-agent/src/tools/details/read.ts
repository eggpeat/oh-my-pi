import type { SummaryResult } from "@oh-my-pi/pi-natives";
import { FILE_LINE_RANGE_ONLY_RE, foldListColons, hoistChunkRaw, RANGE_LIST_SRC } from "@oh-my-pi/pi-utils";
import { formatNumberedLine } from "../hashline-format";
import { parseLineRanges } from "../line-ranges";
import type { OutputMeta } from "../output-meta-format";
import type { TruncationResult } from "../streaming-output";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import type { CfgReadDetails } from "./cfg-render";
import type { ProcReadDetails } from "./proc-render";

/**
 * The file a read actually read, as the executing tool resolved it. Recorded
 * so compaction file lists and stale-read pruning name the resolved target
 * instead of re-parsing the call's `path` argument — a literal `notes.txt:-60`
 * file, a suffix-glob match, an archive member (`test.zip:inner/file`), or a
 * PDF page member (`doc.pdf:p2-img0.png`) all read a file the argument grammar
 * cannot describe exactly.
 */
export interface ReadFileTarget {
	/** Resolved file identity as a display path; member specs ride inside it. */
	path: string;
	/** Selector applied to `path` (`50-200`, `-60`, `raw`, `img`, a video frame); absent for whole reads. */
	sel?: string;
	/** `range` for line-range slices; `alt` for raw/conflicts/img/other-form reads. Guides supersede bucketing. */
	kind?: "range" | "alt";
	/** `?q=` image question this read answered — part of the result's identity, not the file's. */
	question?: string;
}

/** Read result metadata retains truncation statistics, not a second copy of the body. */
export type ReadTruncationStats = Omit<TruncationResult, "content">;

/** Display metadata for file and URL reads. */
export interface ReadToolDetails {
	kind?: "file" | "url";
	proc?: ProcReadDetails;
	cfg?: CfgReadDetails;
	/** Filesystem hyperlink target resolved by the executing tool. */
	displayTarget?: string;
	truncation?: ReadTruncationStats;
	isDirectory?: boolean;
	resolvedPath?: string;
	/**
	 * Absolute path of the disk file whose image this read returned. A native TSP host that
	 * supports `media` shows the file by path instead of the uploaded image bytes. Unset for
	 * screenshots, URL reads and other images not backed by a file. Display-only.
	 */
	mediaPath?: string;
	suffixResolution?: { from: string; to: string; raw?: boolean };
	/** Raw source output keeps descriptive diagnostics in details, not in the body. */
	raw?: boolean;
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Full on-disk byte size recorded before applying a file range. */
	fileSize?: number;
	/** Full source line count when the read reached EOF and the count is exact. */
	totalLines?: number;
	/**
	 * Whether the text's rows carry line-number prefixes (`N:` hashline, `N|` line numbers). Set where a
	 * file read is formatted; a raw read sets `false`. Snapcompact reads it to tell a `12:` prefix from content.
	 */
	rowPrefixes?: boolean;
	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: {
		text: string;
		startLine: number;
		lineNumbers?: Array<number | null>;
	};
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	/** Number of unresolved git conflicts surfaced by this read (TUI uses for inline `⚠ N` badge). */
	conflictCount?: number;
	/**
	 * Paths recovered from a delimited read argument. The TUI renders one call as multiple read rows; snapcompact
	 * keeps such a composite result as text.
	 */
	displayReadTargets?: string[];
	/** What this read actually read, recorded by the executing tool (see {@link ReadFileTarget}). */
	readTarget?: ReadFileTarget;
	/**
	 * Resolved filesystem link target for each {@link displayReadTargets} entry, aligned by index; `null` when a
	 * delimited part has no linkable fs path. Lets the TUI hyperlink each grouped row the same way a standalone read row is.
	 */
	displayReadTargetLinks?: Array<string | null>;
}

export { splitPathAndSel } from "@oh-my-pi/pi-utils";

// Permissive selector chunk for internal URLs — accepts well-formed selectors
// plus common malformed shapes (e.g. `:-N-M`) so the read tool peels the entire
// selector chain off before dispatching to a protocol handler.
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|img|${RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);

/** Selector facts of an internal URL scheme ({@link splitInternalUrlSel}). */
export interface InternalUrlSelectorSpec {
	/** `lines`: a trailing `:<selector>` chain is a read selector; `none`/`opaque`: never peel. */
	readonly selectors: "lines" | "none" | "opaque";
	/** A trailing `:N` with no path after the authority is a port, not a selector (ssh://host:2222). */
	readonly portAuthority?: boolean;
}

/**
 * Split an internal URL from its trailing read selector chain. Only schemes
 * whose spec (`specOf`) declares `selectors: "lines"` peel; others pass through
 * verbatim. Falls back to the input unchanged when nothing matches.
 */
export function splitInternalUrlSel(
	rawPath: string,
	specOf: (scheme: string) => InternalUrlSelectorSpec | undefined,
): { path: string; sel?: string } {
	const url = splitUrlScheme(rawPath);
	if (!url) return { path: rawPath };
	const spec = specOf(url.scheme);
	if (spec?.selectors !== "lines") return { path: rawPath };
	// With no `/path` after the authority, a trailing `:N` is the port
	// (ssh://host:2222), not a read selector.
	if (spec.portAuthority && !url.rest.includes("/")) return { path: rawPath };

	const schemeEnd = rawPath.length - url.rest.length;
	rawPath = hoistChunkRaw(rawPath);
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		// Stop before crossing into the scheme separator `://`.
		if (colon < schemeEnd) break;
		// `local://7.log:1-30,:-30`, `local://7.log:20:40,85:100`: chunks split off
		// by a colon inside one list join the list peeled after them.
		if (chunks.length > 0 && FILE_LINE_RANGE_ONLY_RE.test(chunks[0])) {
			const folded = foldListColons(path, chunks[0], schemeEnd);
			if (folded.basePath !== path) {
				chunks[0] = folded.list;
				path = folded.basePath;
				continue;
			}
		}
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

/** Recognize HTTP URLs and www-prefixed external read targets. */
export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

/** Return the first selected line when every range has valid one-based bounds. */
export function readSelectorRangeStart(selector: string): number | undefined {
	try {
		const start = parseLineRanges(selector)?.[0].startLine;
		return start !== undefined && Number.isFinite(start) ? start : undefined;
	} catch {
		return undefined;
	}
}

/** Inclusive line range describing one elided span in a structural summary. */
export interface ElidedRange {
	start: number;
	end: number;
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

/** Format one summary line with the selected line-prefix mode. */
export function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

/** Format the boundary lines around an elided brace-pair body. */
export function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddHashLines) {
		return { model: `${startLine}-${endLine}:${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

/** Format a structural summary using the supplied file-display preferences. */
export function formatReadSummary(
	displayMode: { hashLines: boolean; lineNumbers: boolean },
	summary: SummaryResult,
): {
	text: string;
	displayText: string;
	elidedRanges: ElidedRange[];
	elidedLines: number;
} {
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

	// Flatten segments into per-line units so we can merge a kept-head /
	// elided / kept-tail sandwich into a single brace-pair line when the
	// boundary lines look like `… {` and `}` (or matching variants).
	type Unit =
		| { kind: "line"; line: number; text: string }
		| { kind: "elided"; startLine: number; endLine: number }
		| {
				kind: "merged";
				startLine: number;
				endLine: number;
				headText: string;
				tailText: string;
		  };

	const raw: Unit[] = [];
	for (const segment of summary.segments) {
		if (segment.kind === "elided") {
			raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
			continue;
		}
		const text = segment.text ?? "";
		if (text.length === 0) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
		}
	}

	const units: Unit[] = [];
	let i = 0;
	while (i < raw.length) {
		const cur = raw[i];
		if (cur.kind === "elided") {
			const prev = units.length > 0 ? units[units.length - 1] : null;
			const next = i + 1 < raw.length ? raw[i + 1] : null;
			if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
				units.pop();
				units.push({
					kind: "merged",
					startLine: prev.line,
					endLine: next.line,
					headText: prev.text,
					tailText: next.text,
				});
				i += 2;
				continue;
			}
		}
		units.push(cur);
		i++;
	}

	const modelParts: string[] = [];
	const displayParts: string[] = [];
	const elidedRanges: ElidedRange[] = [];
	let elidedLines = 0;
	for (const unit of units) {
		if (unit.kind === "elided") {
			modelParts.push("…");
			displayParts.push("…");
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += unit.endLine - unit.startLine + 1;
			continue;
		}
		if (unit.kind === "merged") {
			const formatted = formatMergedBraceLine(
				unit.startLine,
				unit.endLine,
				unit.headText,
				unit.tailText,
				shouldAddHashLines,
				shouldAddLineNumbers,
			);
			modelParts.push(formatted.model);
			displayParts.push(formatted.display);
			// Suggest the full brace range so re-reading shows both braces
			// plus the elided body in one shot.
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			// Merged brace pair encloses (start+1)..(end-1) as elided.
			elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
			continue;
		}
		modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
		displayParts.push(unit.text);
	}

	return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedRanges, elidedLines };
}
