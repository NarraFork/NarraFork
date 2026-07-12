/**
 * Structured reasoning-summary parsing.
 *
 * gpt-5.6 / codex-style models stream their reasoning summary as several
 * "parts", each shaped like:
 *
 *     **Short title**
 *
 *     <body>
 *
 * The body is frequently the empty placeholder `<!-- -->`, meaning the part is
 * a status header with no substantive content. Upstream (openai-provider) joins
 * successive parts with a blank line (`\n\n`) as their `summary_index` advances,
 * so the persisted `reasoning` block text is a single string of blank-line
 * separated paragraphs.
 *
 * This module splits that text back into titled steps so the UI can render a
 * compact trace (title always visible, body expandable on demand). The rules
 * mirror codex's `split_reasoning_summary_parts`:
 *
 * - A paragraph whose first line is exactly `**Title**` (closing `**` followed
 *   by a newline or end-of-paragraph, not more text on the same line) starts a
 *   new step and contributes its title.
 * - `**Result:** keep going` is NOT a pure title (text follows the closing
 *   `**`), so it is treated as body of the current step.
 * - A step whose body trims to empty or to exactly `<!-- -->` is marked empty
 *   (title-only, not expandable).
 * - A literal inline `<!-- -->` inside real prose (e.g. `` Use `<!-- -->` ``)
 *   is preserved — only a body that is *exactly* the placeholder is dropped.
 */

export interface ReasoningSegment {
	/** Extracted step title, or null for content before the first title. */
	title: string | null;
	/** Renderable body markdown (may be empty). */
	body: string;
	/** True when the body has no substantive content (empty or `<!-- -->`). */
	isEmpty: boolean;
}

const EMPTY_PLACEHOLDER = "<!-- -->";

/**
 * If `paragraph` is a pure bold title (`**Title**` optionally followed by more
 * lines), return `{ title, rest }` where `rest` is the paragraph content after
 * the title line. Returns null when the paragraph is not a pure title.
 *
 * "Pure" means: starts with `**`, has a closing `**`, the title text between is
 * non-empty, and the character immediately after the closing `**` is a line
 * break or the end of the paragraph. `**Result:** more` (space after close)
 * does not qualify.
 */
function splitBoldTitle(paragraph: string): { title: string; rest: string } | null {
	if (!paragraph.startsWith("**")) return null;
	const closeRel = paragraph.slice(2).indexOf("**");
	if (closeRel <= 0) return null;
	const title = paragraph.slice(2, 2 + closeRel).trim();
	if (title.length === 0) return null;
	const afterCloseIdx = 2 + closeRel + 2;
	const after = paragraph.slice(afterCloseIdx);
	// Pure title only when nothing (or only a line break) follows on the line.
	if (after.length === 0 || after.startsWith("\n") || after.startsWith("\r")) {
		return { title, rest: after.replace(/^\r?\n/, "") };
	}
	return null;
}

/** True when a step body carries no substantive content. */
function bodyIsEmpty(body: string): boolean {
	const trimmed = body.trim();
	return trimmed.length === 0 || trimmed === EMPTY_PLACEHOLDER;
}

/**
 * Parse reasoning-summary text into titled steps. Blank-line separated
 * paragraphs are grouped under the most recent bold title.
 *
 * A standalone `<!-- -->` paragraph acts as an end-of-part placeholder: it
 * seals the current step (leaving its body empty when nothing real preceded)
 * so that any following prose starts a fresh step instead of being absorbed
 * into a title-only header. This mirrors the way codex treats each streamed
 * part independently, reconstructed from the joined string persisted here.
 */
export function parseReasoningSegments(text: string): ReasoningSegment[] {
	if (!text) return [];
	// Split on blank lines (two-or-more consecutive newlines, tolerating CRLF
	// and trailing spaces on the blank line).
	const paragraphs = text
		.split(/\n[ \t]*\r?\n+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	const segments: ReasoningSegment[] = [];
	// Accumulates body paragraphs for the current (possibly untitled) step.
	let currentTitle: string | null = null;
	let currentBody: string[] = [];
	let started = false;
	// True once a standalone `<!-- -->` placeholder sealed the current step.
	let sealed = false;

	const flush = () => {
		// Only emit a step once we have opened one (a title or leading body).
		if (!started) return;
		const body = currentBody.join("\n\n");
		segments.push({ title: currentTitle, body, isEmpty: bodyIsEmpty(body) });
	};

	const openStep = (title: string | null, body: string[]) => {
		currentTitle = title;
		currentBody = body;
		started = true;
		sealed = false;
	};

	for (const paragraph of paragraphs) {
		const titleSplit = splitBoldTitle(paragraph);
		if (titleSplit) {
			flush();
			const rest = titleSplit.rest.trim();
			openStep(titleSplit.title, rest.length > 0 ? [rest] : []);
			continue;
		}
		if (paragraph === EMPTY_PLACEHOLDER) {
			// Standalone placeholder: seal an open step, ignore when leading.
			if (started) sealed = true;
			continue;
		}
		// Real content paragraph.
		if (!started) {
			openStep(null, []);
		} else if (sealed) {
			// The previous step was sealed by a placeholder — begin a new
			// untitled step rather than appending to a title-only header.
			flush();
			openStep(null, []);
		}
		currentBody.push(paragraph);
	}
	flush();

	return segments;
}

/**
 * True when parsing produced at least one titled step — the signal that this
 * reasoning is codex-style structured content worth rendering as a trace.
 */
export function hasStructuredReasoning(segments: ReasoningSegment[]): boolean {
	return segments.some((s) => s.title != null);
}
