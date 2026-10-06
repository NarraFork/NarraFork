/**
 * Structural landmarks: the boundaries an author drew by hand.
 *
 * `outline` reports what a file DECLARES. It cannot report where the author thought the
 * seams were — and in a long file that is usually written down, as `// --- Scroll state ---`
 * banners, `#region` blocks, or a trail of TODOs clustered in one area. A real session's
 * report on a 3500-line component put it plainly: one regex over section comments surfaced
 * 17 module boundaries that outline could not see, and that was the most useful single call
 * in the whole investigation.
 *
 * This module exists so that insight is a first-class mode rather than something each
 * caller has to think to write a regex for.
 *
 * Deliberately TEXT-ONLY: no parser, no grammar. Landmarks are a comment convention, so the
 * scan works the same on a config file, a log, a shell script, or a language whose parser
 * is not installed — the cases where structural help is needed most.
 */

/** What kind of boundary a landmark represents. */
export type LandmarkKind =
	/** A banner comment: `// --- Scroll state ---`, `# ===== setup =====`. */
	| "section"
	/** An explicit editor-folding region: `#region name` / `#pragma region`. */
	| "region"
	/** A deliberate marker: TODO, FIXME, XXX, HACK, NOTE, WARNING, BUG, DEPRECATED. */
	| "marker";

export interface Landmark {
	/** 1-based line. */
	line: number;
	kind: LandmarkKind;
	/**
	 * The banner's own text, with comment syntax and decoration stripped. Empty when the
	 * line is pure decoration (`// ─────────`), which still marks a boundary.
	 */
	label: string;
	/** For `marker`, the tag itself (`TODO`), so callers can group by it. */
	tag?: string;
}

/**
 * Marker tags worth reporting.
 *
 * Restricted to a fixed list rather than "any all-caps word followed by a colon": the loose
 * version matches `HTTP:`, `NOTE this`, license headers and prose, and a landmark list that
 * is mostly noise is one nobody reads.
 */
const MARKER_TAGS = ["TODO", "FIXME", "XXX", "HACK", "NOTE", "WARNING", "BUG", "DEPRECATED"];

/**
 * Comment openers, longest-first so `///` is stripped before `//`.
 *
 * Covers the line-comment syntax of the languages with parsers plus the shell/config family
 * that has none. Block-comment bodies are handled by `*` appearing in the leader.
 */
const COMMENT_LEADERS = ["///", "//!", "//", "--", "#", ";;", ";", "%", "*", "<!--"];

/** Characters used as banner rules. `─`/`━` are the box-drawing forms this repo uses. */
const DECORATION_CHARS = "-=~*_#─━┄╌+<>";

const MARKER_PATTERN = new RegExp(`\\b(${MARKER_TAGS.join("|")})\\b[:\\s]`, "i");
const REGION_PATTERN = /^(?:#pragma\s+region|#region|# region|<editor-fold)\b\s*(.*)$/i;
const REGION_END_PATTERN = /^(?:#pragma\s+endregion|#endregion|# endregion|<\/editor-fold)\b/i;

/** Strip the comment opener from an already-trimmed line, if it has one. */
function stripCommentLeader(trimmed: string): { body: string; isComment: boolean } {
	for (const leader of COMMENT_LEADERS) {
		if (trimmed.startsWith(leader)) {
			return { body: trimmed.slice(leader.length).trim(), isComment: true };
		}
	}
	return { body: trimmed, isComment: false };
}

/** Remove leading/trailing rule characters and the closer of an HTML/block comment. */
function stripDecoration(body: string): string {
	let text = body.replace(/-->$/, "").replace(/\*\/$/, "").trim();
	let start = 0;
	let end = text.length;
	while (start < end && DECORATION_CHARS.includes(text[start] ?? "")) start++;
	while (end > start && DECORATION_CHARS.includes(text[end - 1] ?? "")) end--;
	text = text.slice(start, end).trim();
	return text;
}

/** How many of a string's characters are decoration. */
function decorationRun(text: string): number {
	let count = 0;
	for (const char of text) if (DECORATION_CHARS.includes(char)) count++;
	return count;
}

/**
 * Whether a comment body reads as a section banner.
 *
 * The test is a RUN of at least two decoration characters, not merely containing them:
 * `// a-b` and `// x = 1` contain dashes and equals but are ordinary comments, and treating
 * them as boundaries would bury the real banners.
 */
function looksLikeBanner(body: string): boolean {
	return /[-=~_#─━┄╌*]{2,}/.test(body);
}

export interface ScanLandmarksOptions {
	/** Stop after this many landmarks. Defaults to 200. */
	limit?: number;
	/** Restrict to these kinds. Defaults to all. */
	kinds?: readonly LandmarkKind[];
}

/**
 * Scan text for landmarks.
 *
 * Single pass, line by line, with no lookahead: this runs on files that may be megabytes
 * and must stay proportional to their size.
 */
export function scanLandmarks(text: string, options: ScanLandmarksOptions = {}): Landmark[] {
	const limit = options.limit ?? 200;
	const wanted = options.kinds ? new Set(options.kinds) : null;
	const allow = (kind: LandmarkKind): boolean => !wanted || wanted.has(kind);

	const found: Landmark[] = [];
	const lines = text.split("\n");

	for (let i = 0; i < lines.length && found.length < limit; i++) {
		const raw = lines[i] ?? "";
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;

		const { body, isComment } = stripCommentLeader(trimmed);
		if (!isComment) continue;
		const line = i + 1;

		// Regions first: `#region` is itself a comment leader in some languages, and its
		// name would otherwise be read as a banner label.
		const regionMatch = REGION_PATTERN.exec(body) ?? REGION_PATTERN.exec(trimmed);
		if (regionMatch) {
			if (allow("region")) {
				found.push({ line, kind: "region", label: stripDecoration(regionMatch[1] ?? "") });
			}
			continue;
		}
		if (REGION_END_PATTERN.test(body) || REGION_END_PATTERN.test(trimmed)) continue;

		// A marker takes precedence over a banner: `// --- TODO: fix this ---` is more
		// useful filed as the TODO it is.
		const markerMatch = MARKER_PATTERN.exec(body);
		if (markerMatch) {
			if (allow("marker")) {
				found.push({
					line,
					kind: "marker",
					tag: (markerMatch[1] ?? "").toUpperCase(),
					label: stripDecoration(body),
				});
			}
			continue;
		}

		if (looksLikeBanner(body) && allow("section")) {
			const label = stripDecoration(body);
			// Pure decoration counts: a bare rule is still where the author split things.
			// A body that is mostly text with a stray `--` is not.
			if (label.length > 0 || decorationRun(body) >= 3) {
				found.push({ line, kind: "section", label });
			}
		}
	}

	return found;
}

/** Group landmarks by marker tag, for a summary line. */
export function countByTag(landmarks: readonly Landmark[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const mark of landmarks) {
		if (!mark.tag) continue;
		counts.set(mark.tag, (counts.get(mark.tag) ?? 0) + 1);
	}
	return counts;
}
