/**
 * markdown-emphasis-compat.ts — Relax CommonMark emphasis flanking for `*`/`**`/`***`.
 *
 * Both markdown pipelines (react-markdown + marked) follow CommonMark's
 * left/right-flanking delimiter rules. Those rules refuse pairs that humans
 * still mean as bold/italic when a PUNCTUATION character sits against the
 * delimiter and ordinary text sits outside it:
 *
 *   `**注意：**说明`   closing `**` follows `：` and precedes `说` → not right-flanking
 *   `字**：粗**`       opening `**` follows `字` and precedes `：` → not left-flanking
 *   `**\`code\`**文字` closing `**` follows the codespan's `` ` `` → not right-flanking
 *
 * Chinese AI output uses `**注意：**…` / `**结果：**…` constantly, so the
 * product cannot treat that as "literal asterisks".
 *
 * Strategy: before lexing, find intentional emphasis pairs that would fail
 * flanking and insert a zero-width Private Use sentinel (U+E002) on the failing
 * side of the delimiter. U+E002 is neither whitespace nor punctuation, so the
 * delimiter becomes flanking-legal and the pair parses. Every text pipeline
 * must then strip the sentinel (`stripEmphasisSentinel`) before measuring,
 * copying, slugging, or painting.
 *
 * U+E000/U+E001 are already taken by the math-sentinel protocol in
 * pretext-layout/parse-markdown.ts — do not reuse them here.
 *
 * Already-legal pairs are left byte-identical so streaming diffs stay quiet.
 * `_` / `__` are intentionally NOT relaxed (snake_case collateral damage).
 */

/** Zero-width flank fixer. Private Use, not whitespace, not punctuation. */
export const EMPHASIS_FLANK_SENTINEL = "\uE002";

const SENTINEL_RE = /\uE002/g;

/** Idempotent. Call on every text node / piece before measure, paint, copy, slug. */
export function stripEmphasisSentinel(text: string): string {
	if (!text.includes(EMPHASIS_FLANK_SENTINEL)) return text;
	return text.replace(SENTINEL_RE, "");
}

/**
 * True when the character is a CommonMark "punctuation character"
 * (ASCII punctuation, or Unicode Pc/Pd/Pe/Pf/Pi/Po/Ps).
 */
const PUNCTUATION_RE = /[!-/:-@[-`{-~\p{Pc}\p{Pd}\p{Pe}\p{Pf}\p{Pi}\p{Po}\p{Ps}]/u;

function isPunctuation(ch: string): boolean {
	return PUNCTUATION_RE.test(ch);
}

function isWhitespaceChar(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || /\s/u.test(ch);
}

/**
 * Character used for flanking when the index is outside the string.
 * CommonMark: the beginning and end of a line count as Unicode whitespace.
 */
function edgeChar(text: string, index: number): string {
	if (index < 0 || index >= text.length) return "\n";
	return text[index] as string;
}

function isLeftFlanking(text: string, start: number, end: number): boolean {
	const before = edgeChar(text, start - 1);
	const after = edgeChar(text, end);
	if (isWhitespaceChar(after)) return false;
	if (!isPunctuation(after)) return true;
	return isWhitespaceChar(before) || isPunctuation(before);
}

function isRightFlanking(text: string, start: number, end: number): boolean {
	const before = edgeChar(text, start - 1);
	const after = edgeChar(text, end);
	if (isWhitespaceChar(before)) return false;
	if (!isPunctuation(before)) return true;
	return isWhitespaceChar(after) || isPunctuation(after);
}

type Range = { start: number; end: number };

/** Sorted, disjoint intervals; lookup does not rescan every earlier code span. */
function rangeAt(ranges: readonly Range[], index: number): Range | undefined {
	let lo = 0;
	let hi = ranges.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const range = ranges[mid] as Range;
		if (index < range.start) hi = mid;
		else if (index >= range.end) lo = mid + 1;
		else return range;
	}
	return undefined;
}

function inRanges(ranges: readonly Range[], index: number): boolean {
	return rangeAt(ranges, index) !== undefined;
}

function rangeEndAt(ranges: readonly Range[], index: number): number {
	return rangeAt(ranges, index)?.end ?? index + 1;
}

/**
 * Scan blocks once, then pair equal-length backtick runs with a next-run index.
 * Unmatched backticks are literal; unmatched fences protect through EOF. The
 * index avoids quadratic rescans on inputs containing many unmatched run sizes.
 */
function findCodeRanges(source: string): Range[] {
	const blocks: Range[] = [];
	let fence:
		| { start: number; marker: string; length: number; quotes: number; indent: number }
		| undefined;
	const lines = /[^\n]*(?:\n|$)/g;
	for (const match of source.matchAll(lines)) {
		if (!match[0]) continue;
		const line = match[0].replace(/\r?\n$/, "");
		// Container prefixes are syntax, not part of the fence indentation.
		const quotePrefix = /^(?: {0,3}>[ \t]?)*/.exec(line)?.[0] ?? "";
		const quotes = quotePrefix.split(">").length - 1;
		const unquoted = line.slice(quotePrefix.length);
		if (
			fence &&
			(quotes < fence.quotes ||
				(fence.indent > 0 && unquoted.trim() && !unquoted.startsWith(" ".repeat(fence.indent))))
		) {
			blocks.push({ start: fence.start, end: match.index });
			fence = undefined;
		}
		const listPrefix = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.exec(unquoted)?.[0] ?? "";
		const content = fence ? unquoted.slice(fence.indent) : unquoted.slice(listPrefix.length);
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
		if (fence) {
			if (
				marker &&
				marker[1]?.[0] === fence.marker &&
				marker[1].length >= fence.length &&
				!marker[2]?.trim()
			) {
				blocks.push({ start: fence.start, end: match.index + match[0].length });
				fence = undefined;
			}
			continue;
		}
		if (marker && !(marker[1]?.[0] === "`" && marker[2]?.includes("`"))) {
			fence = {
				start: match.index,
				marker: marker[1]?.[0] ?? "`",
				length: marker[1]?.length ?? 3,
				quotes,
				indent: listPrefix.length,
			};
		} else if (/^(?: {4}|\t)/.test(content)) {
			blocks.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	if (fence) blocks.push({ start: fence.start, end: source.length });

	const ticks: Range[] = [];
	for (const match of source.matchAll(/`+/g)) {
		if (!inRanges(blocks, match.index))
			ticks.push({ start: match.index, end: match.index + match[0].length });
	}
	const next = new Map<number, number>();
	const closes = new Map<number, number>();
	for (let i = ticks.length - 1; i >= 0; i--) {
		const run = ticks[i] as Range;
		const length = run.end - run.start;
		const close = next.get(length);
		if (close !== undefined) closes.set(i, close);
		next.set(length, i);
	}
	const ranges = [...blocks];
	const barriers = mergeRanges([
		...blocks,
		...Array.from(source.matchAll(/\n[ \t]*\r?\n/g), (match) => ({
			start: match.index,
			end: match.index + match[0].length,
		})),
	]);
	let blockIndex = 0;
	for (let i = 0; i < ticks.length; i++) {
		const open = ticks[i] as Range;
		while ((barriers[blockIndex]?.end ?? Infinity) <= open.start) blockIndex++;
		// An escaped opener is literal, but a backslash INSIDE a span is code.
		let escapes = 0;
		for (let p = open.start - 1; p >= 0 && source[p] === "\\"; p--) escapes++;
		if (escapes % 2) continue;
		const closeIndex = closes.get(i);
		const close = closeIndex === undefined ? undefined : ticks[closeIndex];
		if (!close || close.start >= (barriers[blockIndex]?.start ?? Infinity)) continue;
		ranges.push({ start: open.start, end: close.end });
		i = closeIndex as number;
	}
	return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Math spans are protected the same way code is: `$a*b*c$` must not become
 * emphasis. Matches the delimiter forms `splitMathSegments` accepts.
 */
function findMathRanges(source: string, codeRanges: readonly Range[]): Range[] {
	const ranges: Range[] = [];
	const nextClosers = new Map<string, number>();
	let i = 0;
	while (i < source.length) {
		if (inRanges(codeRanges, i)) {
			i = rangeEndAt(codeRanges, i);
			continue;
		}
		const ch = source[i] as string;
		if (ch === "\\" && (source[i + 1] === "(" || source[i + 1] === "[")) {
			const closer = source[i + 1] === "(" ? "\\)" : "\\]";
			let end = nextClosers.get(closer);
			if (end === undefined || (end >= 0 && end < i + 2)) end = source.indexOf(closer, i + 2);
			nextClosers.set(closer, end);
			if (end >= 0 && !spansCode(codeRanges, i, end + 2)) {
				ranges.push({ start: i, end: end + 2 });
				i = end + 2;
				continue;
			}
		}
		if (ch === "$") {
			const isDisplay = source[i + 1] === "$";
			const openLen = isDisplay ? 2 : 1;
			const closeAt = findClosingDollar(source, i + openLen, isDisplay, codeRanges);
			if (closeAt >= 0) {
				ranges.push({ start: i, end: closeAt + openLen });
				i = closeAt + openLen;
				continue;
			}
		}
		i += 1;
	}
	return ranges;
}

function spansCode(codeRanges: readonly Range[], start: number, end: number): boolean {
	let lo = 0;
	let hi = codeRanges.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((codeRanges[mid]?.end ?? 0) <= start) lo = mid + 1;
		else hi = mid;
	}
	return (codeRanges[lo]?.start ?? Infinity) < end;
}

function findClosingDollar(
	text: string,
	from: number,
	isDisplay: boolean,
	codeRanges: readonly Range[],
): number {
	for (let i = from; i < text.length; i++) {
		if (inRanges(codeRanges, i)) {
			i = rangeEndAt(codeRanges, i) - 1;
			continue;
		}
		const char = text[i] as string;
		if (char === "\\") {
			i += 1;
			continue;
		}
		if (char === "\n") {
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

/** Merge before binary-searching: metadata can contain a code/math-looking span. */
function mergeRanges(ranges: Range[]): Range[] {
	ranges.sort((a, b) => a.start - b.start);
	const merged: Range[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function referenceKey(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** End of a definition's destination and optional (possibly multiline) title. */
function referenceEnd(source: string, from: number): number {
	const lineEnd = source.indexOf("\n", from);
	const fallback = lineEnd < 0 ? source.length : lineEnd;
	const skipSpace = (start: number): number => {
		let i = start;
		let newlines = 0;
		while (i < source.length && /\s/u.test(source[i] as string)) {
			if (source[i] === "\n" && ++newlines > 1) return start;
			i++;
		}
		return i;
	};
	let i = skipSpace(from);
	if (source[i] === "<") {
		while (++i < source.length && source[i] !== ">" && source[i] !== "\n") {
			if (source[i] === "\\") i++;
		}
		if (source[i] !== ">") return fallback;
		i++;
	} else {
		let depth = 0;
		for (; i < source.length && !/\s/u.test(source[i] as string); i++) {
			if (source[i] === "\\") i++;
			else if (source[i] === "(") depth++;
			else if (source[i] === ")" && --depth < 0) break;
		}
	}
	const destinationEnd = Math.max(fallback, i);
	i = skipSpace(i);
	const opener = source[i];
	if (opener !== '"' && opener !== "'" && opener !== "(") return destinationEnd;
	const closer = opener === "(" ? ")" : opener;
	for (i++; i < source.length; i++) {
		if (source[i] === "\\") {
			i++;
			continue;
		}
		if (source[i] === closer) return Math.max(destinationEnd, i + 1);
		if (source[i] === "\n") {
			let next = i + 1;
			while (source[next] === " " || source[next] === "\t" || source[next] === "\r") next++;
			if (source[next] === "\n") break;
		}
	}
	// An unfinished title is protected to its paragraph boundary while streaming.
	return Math.max(destinationEnd, i);
}

/**
 * Link destinations, titles and reference identifiers are data, not visible
 * inline text. This is a forward scanner (no extra Markdown AST/lexer pass).
 * Incomplete destinations are protected too, so streaming never corrupts a URL.
 */
function findLinkRanges(source: string, protectedRanges: readonly Range[]): Range[] {
	const ranges: Range[] = [];
	const references = new Set<string>();
	const definitions = /^(?: {0,3}>[ \t]?)* {0,3}\[((?:\\.|[^\]\\\n])+)\]:/gm;
	for (const match of source.matchAll(definitions)) {
		if (
			inRanges(protectedRanges, match.index) ||
			(ranges[ranges.length - 1]?.end ?? 0) > match.index
		)
			continue;
		references.add(referenceKey(match[1] ?? ""));
		ranges.push({ start: match.index, end: referenceEnd(source, match.index + match[0].length) });
	}
	const excluded = mergeRanges([...protectedRanges, ...ranges]);
	const brackets: number[] = [];
	let failedAngleEnd = -1;
	for (let i = 0; i < source.length; i++) {
		const protectedRange = rangeAt(excluded, i);
		if (protectedRange) {
			i = protectedRange.end - 1;
			continue;
		}
		if (source[i] === "\\") {
			i++;
			continue;
		}
		if (source[i] === "<" && i >= failedAngleEnd) {
			let end = i + 1;
			let quote = "";
			for (; end < source.length; end++) {
				const ch = source[end];
				if (quote) {
					if (ch === quote) quote = "";
				} else if (ch === '"' || ch === "'") quote = ch;
				else if (ch === ">" || ch === "\n") break;
			}
			if (source[end] === ">") {
				ranges.push({ start: i, end: end + 1 });
				i = end;
			} else failedAngleEnd = end;
			continue;
		}
		if (
			source.startsWith("https://", i) ||
			source.startsWith("http://", i) ||
			source.startsWith("www.", i)
		) {
			const start = i;
			while (i < source.length && !/[\s<>]/u.test(source[i] as string)) i++;
			ranges.push({ start, end: i });
			i--;
			continue;
		}
		if (source[i] === "[") {
			brackets.push(i);
			continue;
		}
		if (source[i] !== "]") continue;
		const open = brackets.pop();
		if (open === undefined) continue;
		const usesLabelAsReference =
			source[i + 1] !== "(" && (source[i + 1] !== "[" || source[i + 2] === "]");
		if (
			usesLabelAsReference &&
			references.size > 0 &&
			i - open <= 1000 &&
			references.has(referenceKey(source.slice(open + 1, i)))
		)
			ranges.push({ start: open, end: i + 1 });
		if (source[i + 1] === "[") {
			const start = i + 1;
			let end = start + 1;
			for (; end < source.length && source[end] !== "]" && source[end] !== "\n"; end++) {
				if (source[end] === "\\") end++;
			}
			ranges.push({ start, end: Math.min(end + 1, source.length) });
			i = end;
		} else if (source[i + 1] === "(") {
			const start = i + 1;
			let depth = 1;
			let quote = "";
			let end = start + 1;
			for (; end < source.length; end++) {
				const ch = source[end];
				if (ch === "\\") {
					end++;
					continue;
				}
				if (ch === "\n" && source[end + 1] === "\n") break;
				if (quote) {
					if (ch === quote) quote = "";
					continue;
				}
				if (ch === "<" && depth === 1) quote = ">";
				else if ((ch === '"' || ch === "'") && /\s/.test(source[end - 1] ?? "")) quote = ch;
				else if (ch === "(") depth++;
				else if (ch === ")" && --depth === 0) {
					end++;
					break;
				}
			}
			ranges.push({ start, end: Math.min(end, source.length) });
			i = end - 1;
		}
	}
	return ranges;
}

function findProtectedRanges(source: string): Range[] {
	const codeRanges = findCodeRanges(source);
	const mathRanges = findMathRanges(source, codeRanges);
	const protectedRanges = mergeRanges([...codeRanges, ...mathRanges]);
	return mergeRanges([...protectedRanges, ...findLinkRanges(source, protectedRanges)]);
}

interface StarRun {
	start: number;
	end: number;
	length: number;
}

function findStarRuns(source: string, protectedRanges: readonly Range[]): StarRun[] {
	const runs: StarRun[] = [];
	let i = 0;
	while (i < source.length) {
		if (inRanges(protectedRanges, i)) {
			i = rangeEndAt(protectedRanges, i);
			continue;
		}
		const ch = source[i] as string;
		if (ch === "\\" && i + 1 < source.length) {
			i += 2;
			continue;
		}
		if (ch !== "*") {
			i += 1;
			continue;
		}
		const start = i;
		while (i < source.length && source[i] === "*" && !inRanges(protectedRanges, i)) {
			i += 1;
		}
		const length = i - start;
		// Only 1–3 stars form em/strong/strong-em. Longer runs stay literal.
		if (length >= 1 && length <= 3) {
			runs.push({ start, end: i, length });
		}
	}
	return runs;
}

/**
 * Rewrite intentional-but-illegal `*`/`**`/`***` pairs so both marked and
 * micromark parse them as emphasis. Identity when nothing needs fixing.
 */
export function prepareMarkdownEmphasis(
	source: string,
	onInsert?: (sourceOffset: number) => void,
): string {
	if (!source.includes("*")) return source;
	const protectedRanges = findProtectedRanges(source);
	const runs = findStarRuns(source, protectedRanges);
	if (runs.length < 2) return source;

	const inserts = new Set<number>();
	const used = new Set<number>();

	// Preserve the greedy equal-length pairing, but index eligible closers rather
	// than rescanning all later runs for every whitespace-adjacent opener.
	const closers: number[][] = [[], [], [], []];
	const cursors = [0, 0, 0, 0];
	for (let index = 0; index < runs.length; index++) {
		const run = runs[index] as StarRun;
		if (!isWhitespaceChar(edgeChar(source, run.start - 1))) closers[run.length]?.push(index);
	}
	for (let a = 0; a < runs.length; a++) {
		if (used.has(a)) continue;
		const open = runs[a] as StarRun;
		// `* foo*` / `*foo *` are not intentional emphasis.
		if (isWhitespaceChar(edgeChar(source, open.end))) continue;
		const candidates = closers[open.length] as number[];
		let cursor = cursors[open.length] ?? 0;
		while (
			cursor < candidates.length &&
			((candidates[cursor] as number) <= a || used.has(candidates[cursor] as number))
		)
			cursor++;
		cursors[open.length] = cursor;
		const b = candidates[cursor];
		if (b === undefined) continue;
		const close = runs[b] as StarRun;
		used.add(a);
		used.add(b);
		if (!isLeftFlanking(source, open.start, open.end)) inserts.add(open.end);
		if (!isRightFlanking(source, close.start, close.end)) inserts.add(close.start);
	}

	if (inserts.size === 0) return source;

	const ordered = [...inserts].sort((x, y) => x - y);
	const chunks: string[] = [];
	let from = 0;
	for (const index of ordered) {
		chunks.push(source.slice(from, index), EMPHASIS_FLANK_SENTINEL);
		onInsert?.(index);
		from = index;
	}
	chunks.push(source.slice(from));
	return chunks.join("");
}

/**
 * remark plugin: drop flank sentinels from every text node so they never reach
 * the DOM, copy text, or heading slugs.
 */
export function remarkStripEmphasisSentinel(): (tree: {
	type?: string;
	value?: unknown;
	children?: unknown[];
}) => void {
	return (tree) => {
		walkMdast(tree);
	};
}

function walkMdast(node: { type?: string; value?: unknown; children?: unknown[] }): void {
	if (
		node.type === "text" &&
		typeof node.value === "string" &&
		node.value.includes(EMPHASIS_FLANK_SENTINEL)
	) {
		node.value = stripEmphasisSentinel(node.value);
	}
	if (Array.isArray(node.children)) {
		for (const child of node.children) {
			if (child && typeof child === "object") {
				walkMdast(child as { type?: string; value?: unknown; children?: unknown[] });
			}
		}
	}
}
