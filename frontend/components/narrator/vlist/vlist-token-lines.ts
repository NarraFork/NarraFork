/**
 * vlist-token-lines.ts — Re-slice Shiki tokens onto pretext's VISUAL lines.
 *
 * Shiki tokenizes by PHYSICAL line (split on `\n`). pretext decides where lines
 * actually break at the rendered width, so a long physical line becomes several
 * visual lines (soft wraps). The vlist paints one absolutely-positioned row per
 * VISUAL line, so the token stream has to be cut the same way.
 *
 * This is the pure core of pixi-message-draw's splitTokensByPretextLines, lifted
 * into its own module so it can be unit-tested in isolation. The algorithm:
 *
 *   1. Flatten Shiki's per-physical-line tokens into one stream, inserting an
 *      explicit `\n` token between physical lines.
 *   2. For each visual line: first consume any pending `\n` (a HARD break — it
 *      exists in the token stream but not in pretext's materialized line text),
 *      then take exactly `line.text.length` characters. A SOFT wrap has no `\n`,
 *      so the stream simply keeps flowing into the next visual line.
 *   3. If a line could not be filled to its exact length, that line falls back to
 *      `[]` — the render layer then paints it as plain text. Mis-coloured output
 *      is worse than uncoloured output, so any desync degrades safely.
 *
 * ZERO GEOMETRY: this only decides which characters get which colour. Line count,
 * line text and line height all come from pretext and are never touched here, so
 * the zero-DOM-measure height contract is unaffected.
 */

import type { ShikiToken } from "@frontend/lib/shiki-token-cache";

/** The shape of a pretext visual line (LayoutLine, narrowed to what we read). */
export interface VisualLineText {
	text: string;
}

/**
 * Per-`tokens` memo of already-computed splits, keyed by the visual-line shape.
 * WeakMap so a token array evicted from the highlight cache takes its splits with
 * it; the inner Map is bounded because one code block can be laid out at several
 * widths while the user resizes.
 */
const splitCache = new WeakMap<ShikiToken[][], Map<string, ShikiToken[][]>>();
const MAX_SPLITS_PER_TOKENS = 80;

function visualLinesKey(visualLines: readonly VisualLineText[]): string {
	let key = `${visualLines.length}`;
	for (const line of visualLines) key += `\u0000${line.text}`;
	return key;
}

function flatten(lines: ShikiToken[][]): ShikiToken[] {
	const out: ShikiToken[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) out.push({ content: "\n" });
		const line = lines[i];
		if (line) out.push(...line);
	}
	return out;
}

function totalLength(tokens: readonly ShikiToken[]): number {
	let length = 0;
	for (const token of tokens) length += token.content.length;
	return length;
}

/**
 * Cut `tokens` (grouped by physical line) into one token list per VISUAL line.
 *
 * @param tokens Shiki tokens, or null when highlighting is unavailable
 * @param visualLines pretext's materialized visual lines (authoritative)
 * @returns one token list per visual line (parallel to `visualLines`), an empty
 *   list for any line that could not be aligned, or null when `tokens` is null
 */
export function splitTokensByVisualLines(
	tokens: ShikiToken[][] | null,
	visualLines: readonly VisualLineText[],
): ShikiToken[][] | null {
	if (!tokens) return null;

	const key = visualLinesKey(visualLines);
	const perTokens = splitCache.get(tokens);
	const cached = perTokens?.get(key);
	if (cached) return cached;

	const flat = flatten(tokens);
	const result: ShikiToken[][] = [];
	let tokenIndex = 0;
	let tokenOffset = 0;

	const peekChar = (): string | undefined => flat[tokenIndex]?.content[tokenOffset];

	const consume = (count: number): ShikiToken[] => {
		const chunks: ShikiToken[] = [];
		let remaining = count;
		while (remaining > 0 && tokenIndex < flat.length) {
			const token = flat[tokenIndex];
			if (!token) break;
			const available = token.content.length - tokenOffset;
			const take = Math.min(remaining, available);
			const content = token.content.slice(tokenOffset, tokenOffset + take);
			if (content) {
				chunks.push(token.color === undefined ? { content } : { content, color: token.color });
			}
			tokenOffset += take;
			remaining -= take;
			if (tokenOffset >= token.content.length) {
				tokenIndex++;
				tokenOffset = 0;
			}
		}
		return chunks;
	};

	for (const line of visualLines) {
		// Hard breaks live in the token stream but not in pretext's line text, so
		// they are consumed BETWEEN physical lines. Soft wraps have no `\n`, which
		// is exactly why the stream keeps flowing across them.
		while (peekChar() === "\n") consume(1);
		const wanted = line.text.length;
		const chunks = consume(wanted);
		// Exact-length match or nothing: a partial fill means the streams drifted,
		// and colouring the wrong characters is worse than not colouring them.
		result.push(totalLength(chunks) === wanted ? chunks : []);
	}

	let store = perTokens;
	if (!store) {
		store = new Map<string, ShikiToken[][]>();
		splitCache.set(tokens, store);
	}
	store.set(key, result);
	if (store.size > MAX_SPLITS_PER_TOKENS) {
		const oldest = store.keys().next().value;
		if (oldest !== undefined) store.delete(oldest);
	}
	return result;
}
