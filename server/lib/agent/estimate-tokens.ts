/**
 * Estimate token count for a string using character-based heuristics.
 * - ASCII / Latin characters: ~0.3 tokens per character
 * - CJK / wide characters: ~0.6 tokens per character
 *
 * This is intentionally conservative (over-estimates) so we stay within budget.
 */
export function estimateTokens(text: string): number {
	let tokens = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// CJK Unified Ideographs, CJK Extension A, Hangul, Kana, fullwidth forms, etc.
		if (
			(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, ideographs
			(code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
			(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
			(code >= 0xff00 && code <= 0xffef) || // Fullwidth forms
			(code >= 0x3000 && code <= 0x303f) || // CJK symbols and punctuation
			(code >= 0x3040 && code <= 0x30ff) // Hiragana + Katakana
		) {
			tokens += 0.6;
		} else {
			tokens += 0.3;
		}
	}
	return Math.ceil(tokens);
}
