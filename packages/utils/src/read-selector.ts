/**
 * Pure filesystem read-selector grammar and path splitter shared by the read
 * tool / TUI renderers and compaction file-operation / supersede-prune passes.
 */

/** Shared line-range grammar for selector recognition and parsing. */
export const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;

// Parsing also recognizes incomplete counts to explain their errors; path splitting
// only peels complete selectors (not a trailing `+` or `L`).
const RANGE_SELECTOR_CHUNK = `${LINE_RANGE_CHUNK_SOURCE}(?<=[\\d.-])`;
// A tail selector: `-N` reads the last N lines. Keep in sync with TAIL_SELECTOR_RE.
const TAIL_CHUNK_SRC = String.raw`-\d+`;
// A comma list may mix ranges and tails (`1-12,-15`); a lone tail is a one-chunk list.
const LIST_CHUNK_SRC = `(?:${RANGE_SELECTOR_CHUNK}|${TAIL_CHUNK_SRC})`;
export const READ_RANGE_LIST_SOURCE = `${LIST_CHUNK_SRC}(?:,${LIST_CHUNK_SRC})*`;
export const READ_RANGE_ONLY_RE = new RegExp(`^(?:${READ_RANGE_LIST_SOURCE})$`, "i");
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${READ_RANGE_LIST_SOURCE}|raw|conflicts|img)$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;
const READ_ALTERNATE_FORM_RE = /^(?:raw|conflicts|img)$/i;

const BARE_LINE_RE = /^\d+$/;
// A comma list whose chunks carry their own `raw` (`:1-32:raw,48-50:raw`, `:raw:5,raw:9-12`).
const RAW_CHUNK_SRC = `(?:raw:)?${LIST_CHUNK_SRC}(?::raw)?`;
const PER_CHUNK_RAW_LIST_RE = new RegExp(`:(${RAW_CHUNK_SRC}(?:,${RAW_CHUNK_SRC})+)$`, "i");

/** Rewrite a list with per-chunk `raw` to its one-raw form: `a:1-3:raw,9:raw` → `a:1-3,9:raw`. */
export function hoistChunkRaw(rawPath: string): string {
	const match = PER_CHUNK_RAW_LIST_RE.exec(rawPath);
	if (!match || !/raw/i.test(match[1])) return rawPath;
	const chunks = match[1].split(",").map(chunk => chunk.replace(/^raw:|:raw$/gi, ""));
	return `${rawPath.slice(0, match.index)}:${chunks.join(",")}:raw`;
}

/**
 * Fold the list chunks split off by a colon inside one comma list into the `list`
 * that follows them. Two shapes put a colon there: the selector colon repeated
 * after a comma (`a:1-30,:-30` reads as `a:1-30,-30`) and a colon written as the
 * range dash (`a:20:40,85:100` reads as `a:20-40,85-100`). The dash shape folds
 * only into a list that has a comma, so `clip.mp4:1:30` (a timestamp) and
 * `a.ts:12:5` (line:column) keep their colons. Only colons at or after
 * `minColon` count. Each chunk is tested once.
 */
export function foldListColons(basePath: string, list: string, minColon: number): { basePath: string; list: string } {
	// Comma chunks, last first: the list's first chunk is always `chunks.at(-1)`.
	const chunks = list.split(",").reverse();
	let base = basePath;
	let dashed = false;
	while (true) {
		const colon = base.lastIndexOf(":");
		if (colon < minColon) break;
		const head = base.slice(colon + 1);
		if (head.endsWith(",")) {
			const repeated = head.slice(0, -1);
			if (!READ_RANGE_ONLY_RE.test(repeated)) break;
			chunks.push(...repeated.split(",").reverse());
		} else {
			const headChunks = head.split(",");
			const start = headChunks.pop()!;
			const end = chunks.at(-1)!;
			if (!BARE_LINE_RE.test(start) || !BARE_LINE_RE.test(end)) break;
			if (headChunks.length > 0 && !READ_RANGE_ONLY_RE.test(headChunks.join(","))) break;
			chunks[chunks.length - 1] = `${start}-${end}`;
			chunks.push(...headChunks.reverse());
			dashed = true;
		}
		base = base.slice(0, colon);
	}
	if (dashed && chunks.length === 1) return { basePath, list };
	return { basePath: base, list: chunks.reverse().join(",") };
}

/**
 * Split a filesystem path from its trailing read selector. `foldListColons: false`
 * keeps a colon inside a list as part of the path (`a:1-30,:-30` peels only
 * `:-30`, `a:20:40,85:100` only `:100`), for callers checking whether that
 * shorter split names a real file.
 */
export function splitPathAndSel(
	rawPath: string,
	options?: { foldListColons?: boolean },
): { path: string; sel?: string } {
	rawPath = hoistChunkRaw(rawPath);
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	// Allow a compound trailing selector: `path:1-50:raw`, `path:raw:1-50`, or
	// `path:raw:-60`. The two chunks must be one line list (ranges and tails)
	// plus one `raw`, in either order.
	let list: string | undefined;
	let rawSuffix = "";
	if (READ_RANGE_ONLY_RE.test(candidate)) {
		list = candidate;
	} else if (FILE_RAW_ONLY_RE.test(candidate)) {
		const innerColon = basePath.lastIndexOf(":");
		const innerCandidate = basePath.slice(innerColon + 1);
		if (innerColon > 0 && READ_RANGE_ONLY_RE.test(innerCandidate)) {
			list = innerCandidate;
			rawSuffix = `:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}
	if (list === undefined) return { path: basePath, sel: candidate };

	if (options?.foldListColons !== false) ({ basePath, list } = foldListColons(basePath, list, 1));
	if (!rawSuffix) {
		const innerColon = basePath.lastIndexOf(":");
		const innerCandidate = basePath.slice(innerColon + 1);
		if (innerColon > 0 && FILE_RAW_ONLY_RE.test(innerCandidate)) {
			return { path: basePath.slice(0, innerColon), sel: `${innerCandidate}:${list}` };
		}
	}
	return { path: basePath, sel: `${list}${rawSuffix}` };
}

/**
 * Whether a selector from {@link splitPathAndSel} shows the file in a form other
 * than its plain lines: verbatim `raw` bytes, the merge `conflicts` view, or a
 * rasterized SVG `img`.
 */
export function isAlternateFormReadSelector(sel: string): boolean {
	return sel.split(":").some(part => READ_ALTERNATE_FORM_RE.test(part));
}
