/**
 * diff-word-tokens.ts — Make word-level diff tints and syntax colours coexist.
 *
 * THE DEFECT THIS FIXES
 *
 * Both diff renderers picked ONE of the two, in this order:
 *
 *     line.wordChanges ? <word tints> : tokens ? <syntax colours> : <plain>
 *
 * So the rows that matter most — a modified line, the only kind that carries
 * `wordChanges` — were the only rows rendered WITHOUT syntax colouring. Measured
 * on a two-hunk patch: 8 of 10 rows had syntax colour, and the 2 that lost it
 * were exactly the modification pair, each holding 5 usable Shiki tokens.
 *
 * The two are not alternatives. A word chunk and a Shiki token are two different
 * partitions of the SAME line of text: chunks say "this range changed", tokens say
 * "this range is a keyword". Intersecting them gives both.
 *
 * WHY IT LIVES HERE
 *
 * `vlist-token-lines.ts` already cuts a token stream at character boundaries to
 * land tokens on pretext's visual lines. This is the same operation with a
 * different boundary source (chunk lengths instead of line lengths), so the
 * algorithm is not new — only the boundaries are. It sits in the shared core
 * because BOTH render paths need it and neither may own it.
 *
 * PURE: no React, no Mantine, no DOM, no frontend imports — enforced by the
 * enumerating `shared-core.guard.test.ts` in this directory.
 *
 * SAFETY RULE (inherited from TokenText): if the token run does not cover the
 * chunk text exactly, return null and let the caller render the uncoloured
 * chunks. Mis-aligned colours are worse than absent colours.
 */

import type { DiffWordChange } from "./diff-core";

/**
 * Minimal structural shape of a highlight token.
 *
 * Declared locally rather than imported so this module keeps no dependency on the
 * frontend token cache or on `shiki`. Both `ShikiToken` and shiki's `ThemedToken`
 * satisfy it structurally.
 */
export interface DiffHighlightToken {
	content: string;
	color?: string;
}

/** One word chunk plus the tokens covering exactly its text. */
export interface WordChunkTokens<T extends DiffHighlightToken = DiffHighlightToken> {
	chunk: DiffWordChange;
	tokens: T[];
}

function totalLength(tokens: readonly DiffHighlightToken[]): number {
	let length = 0;
	for (const token of tokens) length += token.content.length;
	return length;
}

function chunksLength(chunks: readonly DiffWordChange[]): number {
	let length = 0;
	for (const chunk of chunks) length += chunk.value.length;
	return length;
}

/**
 * Cut `tokens` into one run per word chunk.
 *
 * @returns one entry per chunk, in order, each carrying the tokens covering
 *   exactly `chunk.value`; or `null` when the token run and the chunk run describe
 *   different text (nothing to align against, so the caller must fall back).
 */
export function sliceTokensByWordChanges<T extends DiffHighlightToken>(
	tokens: readonly T[] | null | undefined,
	wordChanges: readonly DiffWordChange[] | null | undefined,
): WordChunkTokens<T>[] | null {
	if (!tokens || tokens.length === 0) return null;
	if (!wordChanges || wordChanges.length === 0) return null;
	// The two partitions must describe the same string. A mismatch means the
	// highlight is for a different revision of the line (or line endings differ),
	// and slicing anyway would shift every colour.
	if (totalLength(tokens) !== chunksLength(wordChanges)) return null;

	const result: WordChunkTokens<T>[] = [];
	let tokenIndex = 0;
	let tokenOffset = 0;

	for (const chunk of wordChanges) {
		const taken: T[] = [];
		let remaining = chunk.value.length;

		while (remaining > 0 && tokenIndex < tokens.length) {
			const token = tokens[tokenIndex];
			if (!token) break;
			const available = token.content.length - tokenOffset;
			const take = Math.min(remaining, available);
			const content = token.content.slice(tokenOffset, tokenOffset + take);
			if (content) {
				// A token straddling a chunk boundary is split, keeping its colour on
				// both sides — the character sequence is preserved exactly.
				taken.push({ ...token, content });
			}
			tokenOffset += take;
			remaining -= take;
			if (tokenOffset >= token.content.length) {
				tokenIndex++;
				tokenOffset = 0;
			}
		}

		// A zero-length chunk is legitimate (diff libraries can emit one); an
		// under-filled non-empty chunk is desync and must not be rendered.
		if (remaining > 0) return null;
		result.push({ chunk, tokens: taken });
	}

	return result;
}
