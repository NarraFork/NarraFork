/**
 * message-math-text.ts — Collect the text of a message that COULD carry a formula.
 *
 * Why this is not just `contentText`
 * ----------------------------------
 * The coordinator's original KaTeX pre-pass read `message.contentText` only. That is
 * fine for a fetched page (the loader fills it), but the two paths that matter for
 * live output do not have it:
 *
 *   - the STREAMING row is built by `buildStreamingMsg`, which sets
 *     `contentText: null` outright and carries its text in `contentJson` blocks;
 *   - an APPENDED broadcast message carries the same block shape.
 *
 * So a scan keyed on `contentText` reports "no math" for exactly the messages whose
 * math the reader is watching arrive. This walks the blocks instead, which is also
 * what the measure layer reads, so detection and rendering agree on the same text.
 *
 * Reasoning bodies are included: an expanded reasoning block is measured as markdown
 * (`measureStreamingElement`'s `reasoning` branch), so a formula inside it needs the
 * runtime just as much as one in the answer.
 *
 * PURITY: no DOM, no React — unit-testable and safe to call during a layout build.
 */

import type { TreeMessage } from "@frontend/lib/api/types";

/**
 * Text fields on a content block that reach a markdown measure.
 *
 * `translatedText` is included because the reasoning translation toggle can display
 * it instead of `text`, and the reader can flip that toggle without any fetch — the
 * exact situation this module exists to cover.
 */
const TEXT_KEYS = ["text", "thinking", "translatedText"] as const;

/** One markdown-bearing string of a message, with a key stable across frames. */
interface CandidateText {
	/** `${messageId}#${ordinal}` — stable while the body only grows. */
	key: string;
	text: string;
}

/** Every markdown-bearing string of a message, in a stable order. */
function collectFromMessage(message: TreeMessage, out: CandidateText[]): void {
	const id = typeof message.id === "string" ? message.id : "?";
	let ordinal = 0;
	const push = (text: string) => {
		out.push({ key: `${id}#${ordinal++}`, text });
	};
	// `contentText` first: for a fetched message it is the whole visible body, so the
	// common case usually finds its math on the first string tested.
	if (message.contentText) push(message.contentText);
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	for (const block of blocks) {
		if (block == null || typeof block !== "object") continue;
		for (const key of TEXT_KEYS) {
			const value = (block as Record<string, unknown>)[key];
			if (typeof value === "string" && value.length > 0) push(value);
		}
	}
}

function collectCandidates(messages: readonly (TreeMessage | null | undefined)[]): CandidateText[] {
	const out: CandidateText[] = [];
	for (const message of messages) {
		if (!message) continue;
		collectFromMessage(message, out);
	}
	return out;
}

/**
 * Every markdown string of `messages` that a formula could live in.
 *
 * Tool inputs/outputs are deliberately NOT scanned: they render as code or
 * structured detail, never as markdown math, and a shell command full of `$VAR`
 * would load a 584KB bundle for nothing.
 */
export function collectMathCandidateTexts(
	messages: readonly (TreeMessage | null | undefined)[],
): string[] {
	return collectCandidates(messages).map((candidate) => candidate.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental scanning for the per-frame path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closing delimiters of everything `hasMarkdownMath` recognizes.
 *
 * The whole incremental gate rests on one fact: a formula becomes DETECTABLE only
 * when its closing delimiter arrives. So if the text appended since the last scan
 * contains none of these, no pair can have completed that a previous scan already
 * missed, and the (comparatively expensive) four-pattern scan can be skipped.
 *
 * `$` covers both `$…$` and `$$…$$`. The two-character forms are matched as pairs
 * rather than by their bare `)` / `]`, which appear in ordinary prose and code often
 * enough to defeat the point of the gate.
 */
const CLOSING_DELIMITERS = ["$", "\\)", "\\]"] as const;

/**
 * Characters of overlap re-examined at the boundary.
 *
 * A two-character closer can be split across frames (`\` lands in one delta, `)` in
 * the next). Re-reading one character before the previous end makes the gate immune
 * to where the chunk boundary happens to fall.
 */
const BOUNDARY_OVERLAP = 2;

/**
 * Length of the head fingerprint used to notice a REWRITTEN body.
 *
 * The streaming text is normally append-only, but a retry replaces it and
 * `appendStreamingTextPreview` front-truncates past its 120k cap. Both produce a
 * body whose head differs, and an incremental scan of the tail alone could miss a
 * formula in the middle of the new text. Comparing a bounded head keeps the check
 * O(1), where a full prefix comparison would reintroduce the per-frame linear cost
 * this exists to remove.
 *
 * The stored head is compared with `startsWith`, NOT for equality: while a body is
 * still shorter than this bound, appending changes its head, and an equality test
 * would call every early frame a rewrite — re-scanning in full exactly during the
 * frames that arrive fastest.
 */
const HEAD_FINGERPRINT_LENGTH = 32;

/**
 * Cap on tracked strings, so a long session cannot grow this without bound.
 *
 * Reached only in the pathological case; a bulk clear just means the next frame
 * re-scans in full, which is correct — never wrong, only slower once.
 */
const MAX_TRACKED_TEXTS = 512;

interface ScannedText {
	length: number;
	head: string;
}

/**
 * Per-string scan progress. Opaque to callers: create one, hand it back on every
 * call for the same document, and drop it when the document goes away.
 */
export interface MathScanCursor {
	scanned: Map<string, ScannedText>;
}

export function createMathScanCursor(): MathScanCursor {
	return { scanned: new Map() };
}

function headOf(text: string): string {
	return text.length <= HEAD_FINGERPRINT_LENGTH ? text : text.slice(0, HEAD_FINGERPRINT_LENGTH);
}

function containsClosingDelimiter(segment: string): boolean {
	for (const delimiter of CLOSING_DELIMITERS) {
		if (segment.includes(delimiter)) return true;
	}
	return false;
}

/**
 * The strings worth handing to `ensureKatexLoaded` on a PER-FRAME path.
 *
 * The full `collectMathCandidateTexts` is correct but O(body) per call, and the
 * streaming row publishes on every render version — so running four regexes over a
 * body that grows to hundreds of KB turns the scan into O(n²) over a turn, on every
 * session including the overwhelming majority that never contain a formula.
 *
 * This returns the WHOLE string (not the delta) whenever the delta could have
 * completed a formula, because `ensureKatexLoaded` performs the authoritative check
 * and a delta alone would split pairs. The gate is therefore cheap and conservative:
 * it may pass a string that turns out to have no math, but it never withholds one
 * that does.
 *
 * A string is re-scanned in full when its head fingerprint changes or it shrinks —
 * i.e. when the body was rewritten rather than appended to.
 */
export function collectNewMathCandidateTexts(
	messages: readonly (TreeMessage | null | undefined)[],
	cursor: MathScanCursor,
): string[] {
	const candidates = collectCandidates(messages);
	if (cursor.scanned.size > MAX_TRACKED_TEXTS) cursor.scanned.clear();
	const out: string[] = [];
	for (const { key, text } of candidates) {
		if (text.length === 0) continue;
		const previous = cursor.scanned.get(key);
		const head = headOf(text);
		// `startsWith`, not equality: a body under HEAD_FINGERPRINT_LENGTH grows its own
		// head, and that is an append, not a rewrite. Comparing in this direction (new
		// head extends old head) is what makes a short opening body cheap.
		const grewInPlace =
			previous !== undefined && text.length >= previous.length && head.startsWith(previous.head);
		cursor.scanned.set(key, { length: text.length, head });
		if (!grewInPlace) {
			// First sight of this string, or a rewrite: nothing about it has been ruled
			// out, so it goes to the authoritative check as a whole.
			out.push(text);
			continue;
		}
		if (text.length === previous.length) continue;
		const tail = text.slice(Math.max(0, previous.length - BOUNDARY_OVERLAP));
		if (containsClosingDelimiter(tail)) out.push(text);
	}
	return out;
}
