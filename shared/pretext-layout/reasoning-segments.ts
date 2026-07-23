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

// ---------------------------------------------------------------------------
// Adjacent reasoning-block grouping
//
// gpt-5.6 interleaved reasoning emits one `{type:"reasoning"}` block per
// reasoning item, so a single assistant message can carry several adjacent
// reasoning blocks. We merge *adjacent* reasoning/thinking blocks into one
// trace (reasoning separated by a tool call or text block stays split, which
// matches the interleaved semantics). We also compute whether a run is the
// message's last renderable content, so the live "thinking" shimmer stops once
// real output (text / tool call / …) follows the reasoning.
// ---------------------------------------------------------------------------

/** Minimal shape of a content block needed for grouping. */
export interface ContentBlockLike {
	type?: string;
	text?: string;
	thinking?: string;
	providerMetadata?: unknown;
}

export type ReasoningEncryptionState = "none" | "only" | "partial";

export function hasEncryptedReasoningMetadata(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const providerMetadata = (block as Record<string, unknown>).providerMetadata;
	if (!providerMetadata || typeof providerMetadata !== "object") return false;

	return Object.values(providerMetadata as Record<string, unknown>).some((metadata) => {
		if (!metadata || typeof metadata !== "object") return false;
		const encrypted = (metadata as Record<string, unknown>).reasoningEncryptedContent;
		return typeof encrypted === "string" && encrypted.length > 0;
	});
}

export function getReasoningEncryptionState(blocks: ContentBlockLike[]): ReasoningEncryptionState {
	const hasVisibleText = blocks.some((block) => (block.text || block.thinking || "").length > 0);
	const hasEncryptedOnlyBlock = blocks.some(
		(block) => !(block.text || block.thinking || "").length && hasEncryptedReasoningMetadata(block),
	);
	if (!hasEncryptedOnlyBlock) return "none";
	return hasVisibleText ? "partial" : "only";
}

/** True for reasoning / thinking blocks. */
export function isReasoningBlock(block: ContentBlockLike): boolean {
	return block.type === "reasoning" || block.type === "thinking";
}

/**
 * True when a block renders visible, non-reasoning content. Empty text blocks
 * (which `MessageBubble` skips) do not count, so trailing empty text after
 * reasoning still leaves the run as the "last content".
 */
export function isRenderableContentBlock(block: ContentBlockLike): boolean {
	switch (block.type) {
		case "text":
			return typeof block.text === "string" && block.text.trim().length > 0;
		case "tool_use":
		case "web_search":
		case "image":
		case "image_generation":
		case "text_file":
			return true;
		default:
			return false;
	}
}

/** A contiguous span of reasoning blocks. */
export interface ReasoningRun {
	/** Index of the first reasoning block in the run. */
	startIndex: number;
	/** Index of the last reasoning block in the run (inclusive). */
	endIndex: number;
	/** All reasoning block indices in the run (contiguous). */
	indices: number[];
	/** True when no later visible content or separate reasoning run follows. */
	isLastContent: boolean;
}

export interface ReasoningGrouping {
	runs: ReasoningRun[];
	/** Block indices that a run absorbed (all but its start) — skip when rendering. */
	skip: Set<number>;
}

export interface ReasoningRunActionIndices {
	anchorIndex: number | undefined;
	rollbackIndex: number | undefined;
	deleteIndices: number[];
}

export function resolveReasoningRunActionIndices(indices: number[]): ReasoningRunActionIndices {
	const ordered = [...new Set(indices)].sort((a, b) => a - b);
	return {
		anchorIndex: ordered[0],
		rollbackIndex: ordered[ordered.length - 1],
		deleteIndices: [...ordered].reverse(),
	};
}

export interface ReasoningGroupingOptions {
	/** Maps each local block index back to its index in `allBlocks`. */
	originalIndices?: number[];
	/** Complete unfiltered message blocks, used to detect content in later render segments. */
	allBlocks?: ContentBlockLike[];
}

/**
 * Scan `blocks` and merge each contiguous span of reasoning/thinking blocks
 * into a single run. Returns the runs plus the set of absorbed indices to skip
 * during rendering (every reasoning block in a run except its start).
 *
 * Renderers may pass a filtered content segment. In that case `originalIndices`
 * preserves true adjacency and `allBlocks` keeps terminal/shimmer detection based
 * on the complete message rather than only the currently rendered segment.
 */
export function groupReasoningRuns(
	blocks: ContentBlockLike[],
	opts: ReasoningGroupingOptions = {},
): ReasoningGrouping {
	const runs: ReasoningRun[] = [];
	const skip = new Set<number>();
	const originalIndices =
		opts.originalIndices?.length === blocks.length ? opts.originalIndices : undefined;
	const allBlocks = opts.allBlocks ?? blocks;

	for (let i = 0; i < blocks.length; i++) {
		if (!isReasoningBlock(blocks[i])) continue;
		const startIndex = i;
		const indices: number[] = [i];
		let j = i + 1;
		while (
			j < blocks.length &&
			isReasoningBlock(blocks[j]) &&
			(!originalIndices || originalIndices[j] === originalIndices[j - 1] + 1)
		) {
			indices.push(j);
			skip.add(j);
			j++;
		}
		const endIndex = j - 1;
		const originalEndIndex = originalIndices?.[endIndex] ?? endIndex;
		// Any later visible content — including a separate reasoning run — means
		// this is not the message's latest active reasoning trace.
		let isLastContent = true;
		for (let k = originalEndIndex + 1; k < allBlocks.length; k++) {
			if (isReasoningBlock(allBlocks[k]) || isRenderableContentBlock(allBlocks[k])) {
				isLastContent = false;
				break;
			}
		}
		runs.push({ startIndex, endIndex, indices, isLastContent });
		i = endIndex; // continue after the run
	}

	return { runs, skip };
}
