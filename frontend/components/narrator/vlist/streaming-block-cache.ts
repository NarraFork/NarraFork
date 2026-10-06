/**
 * streaming-block-cache.ts — Incremental preparation of a LIVE streaming markdown
 * body, using the LEXER's own block boundaries.
 *
 * Why the boundaries must come from the lexer
 * ------------------------------------------
 * The first version of this module guessed them: it froze the prepared blocks of
 * everything before the last blank line and re-parsed only the tail. A blank line is
 * not a markdown block boundary, so that was wrong in several common shapes —
 * decisively inside a fenced code block, where a blank line is ordinary content. The
 * freeze tore one code block into several PERMANENTLY, and the reader watched earlier
 * output change and disappear as the stream continued.
 *
 * No smarter guess works either: a fence-aware, list-aware scan still diverged on 725
 * of the prefixes tested, because whether an earlier construct is closed can depend on
 * text that has not arrived yet (a blank line between list items makes the whole list
 * loose, retroactively re-spacing items already emitted).
 *
 * `parseMarkdownUnits` removes the guessing. `marked.lexer` decides where top-level
 * blocks begin and end — correct by definition — and reports each one's source slice.
 * A growing body changes only its final token(s), so every earlier unit is
 * byte-identical frame to frame and its prepared blocks are reused verbatim.
 *
 * Two layers of reuse
 * -------------------
 * 1. **Preparation** — the dominant cost, since pretext pre-measures every inline
 *    fragment — is memoised per unit, keyed on `(isFirst, raw)`.
 * 2. **Lexing** resumes from a settled token boundary: tokens before the last two are
 *    closed, so only the live remainder is re-lexed.
 *
 * The result is exact (never an approximation of the current text) and roughly ten
 * times cheaper than re-preparing the whole body every frame.
 */

import { parseMarkdownUnits } from "@shared/pretext-layout/parse-markdown";
import type { PreparedBlock } from "@shared/pretext-layout/prepared-block";
import { getKatexRevision } from "./katex-runtime";
import { markdownMathSupport } from "./measure/math-support";

/**
 * Tokens kept live at the tail, i.e. NOT treated as settled.
 *
 * The final token is obviously still growing. The one before it is held back too
 * because arriving text can still merge into it — a blank line plus another list item
 * turns the preceding list loose; a closing fence turns preceding lines into one code
 * block. Two is the smallest window that covers those.
 */
const LIVE_TAIL_TOKENS = 2;

/**
 * Cap on memoised units per row. A long turn produces many blocks and only the current
 * body's units are ever needed, so passing the cap clears the memo wholesale: the next
 * frame re-prepares once and repopulates. Bounded memory, amortised cost.
 */
const MAX_UNITS_PER_ROW = 512;

interface StreamingEntry {
	/** Prepared blocks by `(isFirst, raw)` — the memo that skips pretext work. */
	memo: Map<string, PreparedBlock[]>;
	/** Source prefix whose tokens are closed; the lexing resume point. */
	settledText: string;
	/** Prepared blocks of `settledText`, in order. */
	settledBlocks: PreparedBlock[];
	/**
	 * KaTeX revision the entry's blocks were prepared under.
	 *
	 * This cache is a SECOND, independent memo layer: it keeps its own settled blocks
	 * rather than going through `prepared-markdown-cache` (whose key already carries
	 * the revision). So the revision has to be tracked here too — otherwise a body
	 * that settled BEFORE the runtime arrived keeps serving blocks in which the
	 * formula is literal text, forever. That is the streaming half of the "formulas
	 * only render after a page reload" bug: bumping the revision invalidated every
	 * other layer and this one silently held the stale answer.
	 */
	mathRevision: number;
}

const entries = new Map<string, StreamingEntry>();

function unitKey(raw: string, isFirst: boolean): string {
	return `${isFirst ? "F" : "M"}:${raw}`;
}

function freshEntry(mathRevision: number): StreamingEntry {
	return { memo: new Map(), settledText: "", settledBlocks: [], mathRevision };
}

/**
 * Prepared blocks for a streaming markdown body.
 *
 * Always a complete, internally consistent preparation of exactly `text` — never a
 * concatenation of independently guessed spans — so earlier content can never be torn
 * or dropped. Cost is proportional to the part of the body still changing.
 */
export function getStreamingPreparedBlocks(key: string, text: string): PreparedBlock[] {
	if (text.length === 0) {
		entries.delete(key);
		return [];
	}
	const mathRevision = getKatexRevision();
	const existing = entries.get(key);
	// Reuse requires append-only growth AND the same math support. A rewritten body
	// (a retry, or the front-truncation `appendStreamingTextPreview` applies past its
	// 120k cap) shares no prefix, so the settled boundary is void; a revision change
	// means the settled blocks were prepared without KaTeX and must be redone.
	let entry: StreamingEntry;
	if (existing && existing.mathRevision === mathRevision && text.startsWith(existing.settledText)) {
		entry = existing;
	} else {
		entry = freshEntry(mathRevision);
		entries.set(key, entry);
	}
	if (entry.memo.size > MAX_UNITS_PER_ROW) entry.memo.clear();

	const settledLength = entry.settledText.length;
	// Lex and prepare ONLY the live remainder. Units whose `raw` is unchanged come back
	// from the memo without touching pretext.
	const liveUnits = parseMarkdownUnits(text.slice(settledLength), markdownMathSupport(), {
		// Anything settled before it makes the live slice a continuation, so its first
		// unit keeps its contextual top margin instead of the document-start zero.
		continuation: settledLength > 0,
		reuse: (raw, isFirst) => entry.memo.get(unitKey(raw, isFirst)),
	});

	const blocks = [...entry.settledBlocks];
	for (const unit of liveUnits) {
		entry.memo.set(unitKey(unit.raw, unit.isFirst), unit.blocks);
		blocks.push(...unit.blocks);
	}

	// Advance the settled boundary over units that can no longer change. `consumedLength`
	// includes the inter-block whitespace (which lives in separate `space` tokens), so
	// slicing at it lands exactly where the next unit begins.
	const settleUpTo = liveUnits.length - LIVE_TAIL_TOKENS;
	if (settleUpTo > 0) {
		const boundary = liveUnits[settleUpTo - 1]?.consumedLength ?? 0;
		if (boundary > 0) {
			entry.settledText = text.slice(0, settledLength + boundary);
			entry.settledBlocks = blocks.slice(
				0,
				entry.settledBlocks.length +
					liveUnits.slice(0, settleUpTo).reduce((sum, unit) => sum + unit.blocks.length, 0),
			);
		}
	}
	return blocks;
}

/**
 * Drop cached units. Called with a key when one streaming row retires, and with no
 * argument on narrator switch / teardown.
 */
export function resetStreamingBlockCache(key?: string): void {
	if (key === undefined) entries.clear();
	else entries.delete(key);
}

/** Number of cached streaming rows (diagnostics + leak assertions in tests). */
export function streamingBlockCacheSize(): number {
	return entries.size;
}
