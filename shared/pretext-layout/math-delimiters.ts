/**
 * math-delimiters.ts — LaTeX delimiter detection, normalization and splitting.
 *
 * Two renderers consume this: the react-markdown path (`MarkdownContent.tsx`,
 * via remark-math) and the pretext vlist path (`parse-markdown.ts`, via
 * `katex-geometry.ts`). Keeping detection here means both agree on what counts
 * as math — previously only the react-markdown path knew about math at all.
 *
 * Delimiters recognized:
 *   - `$...$`     inline  (remark-math's native syntax)
 *   - `$$...$$`   display
 *   - `\(...\)`   inline  (emitted by GPT-family and some Gemini models)
 *   - `\[...\]`   display
 *
 * The backslash forms are normalized to the dollar forms so a single downstream
 * parser handles both. Code regions are always left verbatim: real code
 * containing `\(` must never be rewritten.
 *
 * PURITY: no DOM, no React — safe for the shared core and unit-testable.
 */

const DISPLAY_MATH_PATTERN = /(^|\n)\s*\$\$[\s\S]*?\$\$/;
const INLINE_MATH_PATTERN = /(^|[^\\$])\$[^\s$](?:[^\n$]*[^\s$])?\$/;
const PAREN_MATH_PATTERN = /\\\([\s\S]*?\\\)/;
const BRACKET_MATH_PATTERN = /\\\[[\s\S]*?\\\]/;

/** True when the text contains any recognized math delimiter pair. */
export function hasMarkdownMath(text: string): boolean {
	return (
		DISPLAY_MATH_PATTERN.test(text) ||
		INLINE_MATH_PATTERN.test(text) ||
		PAREN_MATH_PATTERN.test(text) ||
		BRACKET_MATH_PATTERN.test(text)
	);
}

/**
 * Matches fenced code blocks (``` / ~~~), indented code blocks, and inline code
 * spans (`...`). Used to split text so we never rewrite math delimiters inside
 * code regions. The capturing group puts code segments at odd indices after
 * String.split().
 */
const CODE_SEGMENT_PATTERN =
	/(```[\s\S]*?```|~~~[\s\S]*?~~~|(?:^|\n)(?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*|`[^`\n]*`)/g;

/**
 * Normalize LaTeX delimiters that `remark-math` does not understand.
 *
 * Many LLMs (GPT family, some Gemini variants) emit `\(...\)` for inline math
 * and `\[...\]` for display math instead of the `$...$` / `$$...$$` syntax that
 * remark-math parses. Without this conversion those formulas render as literal
 * backslash-parens. We rewrite them to dollar-delimited math while skipping
 * code blocks and inline code so real code containing `\(` is left untouched.
 *
 * Optional `sourceOffsets` maps UTF-16 boundaries to original-source boundaries
 * (initially 0..text.length). It is updated in place for incremental consumers;
 * ordinary renderers pay no per-character mapping cost.
 */
export function normalizeMathDelimiters(text: string, sourceOffsets?: number[]): string {
	if (!text.includes("\\(") && !text.includes("\\[")) return text;

	let consumed = 0;
	const mapped: number[] = [];
	const result = text
		.split(CODE_SEGMENT_PATTERN)
		.map((segment, index) => {
			const offsets = sourceOffsets?.slice(consumed, consumed + segment.length + 1);
			consumed += segment.length;
			// Odd indices are captured code segments — leave them verbatim.
			const normalized =
				index % 2 === 1
					? segment
					: replaceMathDelimiters(
							replaceMathDelimiters(segment, /\\\[([\s\S]+?)\\\]/g, "$$", offsets),
							/\\\(([\s\S]+?)\\\)/g,
							"$",
							offsets,
						);
			if (offsets) for (let i = 0; i < offsets.length - 1; i++) mapped.push(offsets[i] as number);
			return normalized;
		})
		.join("");
	if (sourceOffsets) {
		mapped.push(sourceOffsets[text.length] as number);
		sourceOffsets.length = 0;
		for (const offset of mapped) sourceOffsets.push(offset);
	}
	return result;
}

/** Carry UTF-16 source boundaries through delimiter rewriting, only on request. */
function replaceMathDelimiters(
	text: string,
	pattern: RegExp,
	delimiter: string,
	offsets?: number[],
): string {
	const mapped: number[] = [];
	let consumed = 0;
	const result = text.replace(pattern, (match: string, body: string, start: number) => {
		if (offsets) {
			for (let i = consumed; i < start; i++) mapped.push(offsets[i] as number);
			for (let i = 0; i < delimiter.length; i++) mapped.push(offsets[start + i] as number);
			for (let i = 0; i < body.length; i++) mapped.push(offsets[start + 2 + i] as number);
			for (let i = 0; i < delimiter.length; i++)
				mapped.push(offsets[start + match.length - 2 + i] as number);
		}
		consumed = start + match.length;
		return `${delimiter}${body}${delimiter}`;
	});
	if (offsets) {
		for (let i = consumed; i <= text.length; i++) mapped.push(offsets[i] as number);
		offsets.length = 0;
		for (const offset of mapped) offsets.push(offset);
	}
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Splitting — for the vlist path, which must build prepared blocks per segment
// ─────────────────────────────────────────────────────────────────────────────

export type MathSegment =
	| { kind: "text"; text: string }
	/** `$...$` — flows inline with surrounding text. */
	| { kind: "inline-math"; latex: string }
	/** `$$...$$` — its own centered block. */
	| { kind: "display-math"; latex: string };

/** A segment's untrimmed UTF-16 source range, before any formula replacement. */
type MathSegmentVisitor = (segment: MathSegment, start: number, end: number) => void;

/**
 * Split text into literal and math segments.
 *
 * Expects delimiters already normalized (call `normalizeMathDelimiters` first)
 * but tolerates the backslash forms too. Display math is matched before inline
 * so `$$…$$` is never mistaken for two empty `$…$` pairs.
 *
 * Unterminated math (a `$` with no closing partner — common mid-stream) stays
 * literal text, so a half-written formula never renders as broken math.
 */
export function splitMathSegments(text: string, visit?: MathSegmentVisitor): MathSegment[] {
	const segments: MathSegment[] = [];
	let literal = "";
	let index = 0;

	const flushLiteral = () => {
		if (literal.length > 0) {
			const segment: MathSegment = { kind: "text", text: literal };
			segments.push(segment);
			visit?.(segment, index - literal.length, index);
			literal = "";
		}
	};

	while (index < text.length) {
		const char = text[index];

		// Escaped dollar: `\$` is a literal dollar sign, not a delimiter.
		if (char === "\\" && text[index + 1] === "$") {
			literal += "\\$";
			index += 2;
			continue;
		}

		if (char === "$") {
			const isDisplay = text[index + 1] === "$";
			const open = isDisplay ? "$$" : "$";
			const close = findClosingDollar(text, index + open.length, isDisplay);
			if (close >= 0) {
				const latex = text.slice(index + open.length, close).trim();
				if (latex.length > 0) {
					flushLiteral();
					const segment: MathSegment = isDisplay
						? { kind: "display-math", latex }
						: { kind: "inline-math", latex };
					segments.push(segment);
					visit?.(segment, index, close + open.length);
					index = close + open.length;
					continue;
				}
			}
			// Unterminated or empty — treat the delimiter as literal text.
			literal += char;
			index += 1;
			continue;
		}

		literal += char;
		index += 1;
	}

	flushLiteral();
	return segments;
}

/**
 * Split text into literal and math segments, never treating code as math.
 *
 * Code regions (fenced, indented, inline spans) are emitted as literal text so a
 * shell script containing `$VAR` or a regex containing `\(` is left alone. This
 * is the entry point the markdown parsers should use.
 */
export function splitMathOutsideCode(text: string, visit?: MathSegmentVisitor): MathSegment[] {
	const segments: MathSegment[] = [];
	const parts = text.split(CODE_SEGMENT_PATTERN);
	let consumed = 0;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined || part.length === 0) continue;
		const start = consumed;
		consumed += part.length;
		// Odd indices are captured code segments — always literal.
		if (i % 2 === 1) {
			const segment: MathSegment = { kind: "text", text: part };
			segments.push(segment);
			visit?.(segment, start, consumed);
			continue;
		}
		for (const segment of splitMathSegments(
			part,
			visit ? (segment, from, to) => visit(segment, start + from, start + to) : undefined,
		))
			segments.push(segment);
	}
	return segments;
}

/**
 * Index of the closing `$`/`$$` for math opened at `from`, or -1 when absent.
 *
 * Inline math must not span a newline at all. This is what keeps a table full of
 * `$price` cells from being torn apart: the opening `$` of one row's `$0.0192/秒`
 * would otherwise pair with the next `$` on a LATER row, swallowing the rows in
 * between — including the `|---|` delimiter — into a fake "formula" and erasing
 * the table before marked ever sees it. remark-math (the chunked path) follows
 * CommonMark, where inline math cannot cross a line break, so this also keeps the
 * two renderers in agreement.
 *
 * Display math may span single newlines (a multi-line `$$…$$` block is normal),
 * but a BLANK line still ends the search: an unmatched `$$` in prose must not
 * swallow the rest of the document.
 */
function findClosingDollar(text: string, from: number, isDisplay: boolean): number {
	for (let i = from; i < text.length; i++) {
		const char = text[i];
		if (char === "\\") {
			i++; // skip the escaped character
			continue;
		}
		if (char === "\n") {
			// Inline math stops at any newline; display math stops only at a blank line.
			if (!isDisplay) return -1;
			if (text[i + 1] === "\n") return -1;
			continue;
		}
		if (char !== "$") continue;
		if (isDisplay) {
			if (text[i + 1] === "$") return i;
			continue;
		}
		return i;
	}
	return -1;
}

/**
 * True when the text ends inside an unclosed math delimiter.
 *
 * The streaming split path uses this the same way `hasUnclosedFence` is used:
 * a tail whose formula is still being written must not be handed to KaTeX (it
 * would flash a parse error), and the stable/tail cut must not land mid-formula.
 *
 * Code regions are skipped, exactly like `splitMathOutsideCode` does. Without
 * that, a single shell variable in prose or code (`` `echo $HOME` ``, a fenced
 * block containing `$PATH`) reads as "unclosed formula" and permanently disables
 * the streaming split for that message — an 80KB document collapsed from a
 * 80,275-char stable prefix down to 9, re-parsing the whole body every frame.
 *
 * Math is not allowed to span a code region, matching `splitMathOutsideCode`:
 * each non-code part is scanned independently.
 */
export function hasUnclosedMath(text: string): boolean {
	const parts = text.split(CODE_SEGMENT_PATTERN);
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined || part.length === 0) continue;
		// Odd indices are captured code segments — never math.
		if (i % 2 === 1) continue;
		if (hasUnclosedMathInProse(part)) return true;
	}
	return false;
}

/**
 * True when the text ends inside an unclosed DISPLAY formula (`$$…$$`/`\[…\]`).
 *
 * Narrower than `hasUnclosedMath` on purpose, for the streaming stable/tail cut.
 * Only display math can straddle a cut point, because a cut always lands on a
 * blank line and inline `$…$` may not span even a single newline
 * (see `findClosingDollar`). Meanwhile an isolated `$` in prose ("it costs $5")
 * is indistinguishable from an inline formula mid-stream, and counting it as
 * unclosed would disable the split for the whole message. Restricting the check
 * to display math removes that false positive entirely while still protecting
 * every formula that could actually be cut in half.
 *
 * Code regions are skipped, as in `hasUnclosedMath`.
 */
export function hasUnclosedDisplayMath(text: string): boolean {
	const parts = text.split(CODE_SEGMENT_PATTERN);
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined || part.length === 0) continue;
		if (i % 2 === 1) continue;
		if (hasUnclosedDisplayMathInProse(part)) return true;
	}
	return false;
}

/** `hasUnclosedDisplayMath` for a single non-code region. */
function hasUnclosedDisplayMathInProse(text: string): boolean {
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			// `\[` opens display math; `\(` is inline and therefore out of scope.
			if (text[index + 1] === "[") {
				const close = text.indexOf("\\]", index + 2);
				if (close < 0) return true;
				index = close + 2;
				continue;
			}
			index += 2;
			continue;
		}
		if (char === "$" && text[index + 1] === "$") {
			const close = findClosingDollar(text, index + 2, true);
			// A trailing bare `$$` with nothing after it is not yet a formula.
			if (close < 0) return index + 2 < text.length;
			index = close + 2;
			continue;
		}
		index += 1;
	}
	return false;
}

/** `hasUnclosedMath` for a single non-code region. */
function hasUnclosedMathInProse(text: string): boolean {
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			// `\(` and `\[` open math; any other escape is literal.
			const next = text[index + 1];
			if (next === "(" || next === "[") {
				const close = text.indexOf(next === "(" ? "\\)" : "\\]", index + 2);
				if (close < 0) return true;
				index = close + 2;
				continue;
			}
			index += 2;
			continue;
		}
		if (char === "$") {
			const isDisplay = text[index + 1] === "$";
			const open = isDisplay ? 2 : 1;
			const close = findClosingDollar(text, index + open, isDisplay);
			if (close < 0) {
				// A lone trailing `$` with nothing after it is more likely a literal
				// dollar sign than the start of a formula; only treat it as unclosed
				// when some content follows it.
				return index + open < text.length;
			}
			index = close + open;
			continue;
		}
		index += 1;
	}
	return false;
}
