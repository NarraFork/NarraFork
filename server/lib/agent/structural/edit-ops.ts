/**
 * edit-ops.ts — The five StructSed mutations, as pure text functions.
 *
 * Everything here takes text plus a 1-based inclusive line range and returns new text.
 * No IO, no provider, no tool context: the address (structural or sed-style) has already
 * been resolved to lines by the caller. That split is what makes these testable in
 * isolation, and it is also what makes the operations REPLAYABLE — the rebuild path
 * re-applies them from a recorded line range without needing tree-sitter to be installed.
 *
 * Line granularity throughout. `locate` reports line-bounded ranges, and a sub-line
 * delete would leave a stray blank line with half an indent behind; whole-line semantics
 * mean "delete this function" removes exactly the function's lines.
 *
 * All functions operate on LF-normalized text. The caller restores the file's original
 * ending via `applyLineEnding`, matching how Edit and Write already work.
 */

/** Raised when an operation cannot be applied to the given text. */
export class EditOpError extends Error {}

/** Cap on substitute matches, so one call cannot rewrite an entire large file silently. */
export const MAX_SUBSTITUTE_MATCHES = 1000;

/** Wall-clock budget for a substitute scan, guarding against catastrophic backtracking. */
export const SUBSTITUTE_TIMEOUT_MS = 2000;

export interface LineRange {
	/** 1-based inclusive. */
	startLine: number;
	endLine: number;
}

/**
 * Split into lines, remembering whether the text ended with a newline.
 *
 * The flag matters: joining `["a", "b"]` cannot distinguish `"a\nb"` from `"a\nb\n"`, and
 * silently adding or dropping a trailing newline shows up as a spurious diff line on
 * every subsequent edit.
 */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
	if (text === "") return { lines: [], trailingNewline: false };
	const trailingNewline = text.endsWith("\n");
	const body = trailingNewline ? text.slice(0, -1) : text;
	return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: readonly string[], trailingNewline: boolean): string {
	if (lines.length === 0) return "";
	return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Validate a range against the text, with a message naming the actual bounds. */
function assertRange(range: LineRange, total: number): void {
	if (range.startLine < 1 || range.endLine < range.startLine) {
		throw new EditOpError(
			`Invalid line range ${range.startLine}-${range.endLine}: start must be >= 1 and end >= start.`,
		);
	}
	if (range.startLine > total) {
		throw new EditOpError(`Line ${range.startLine} is past the end of the file (${total} lines).`);
	}
}

/** Leading whitespace of a line, i.e. the indent an insertion should align to. */
function indentOf(line: string | undefined): string {
	if (!line) return "";
	const match = /^[ \t]*/.exec(line);
	return match ? match[0] : "";
}

/**
 * Re-indent a block to sit at `anchorIndent`.
 *
 * The block's OWN first-line indent is treated as its baseline and subtracted, so internal
 * structure is preserved: a method whose body is indented one level deeper than its
 * signature keeps that relationship wherever it lands.
 *
 * This exists because misplaced indentation is the quietest failure mode of string-based
 * editing — the code is correct, the diff looks plausible, and the file no longer parses.
 * The anchor indent is a by-product of the resolved range, so aligning costs nothing.
 *
 * Blank lines are left empty rather than filled with the anchor indent: trailing
 * whitespace on an otherwise empty line is what most formatters strip on save, which
 * would show up as an unrelated diff on the next write.
 */
export function reindentBlock(content: string, anchorIndent: string): string {
	const { lines, trailingNewline } = splitLines(content);
	if (lines.length === 0) return content;
	const baseline = indentOf(lines[0]);
	const adjusted = lines.map((line) => {
		if (line.trim() === "") return "";
		const stripped = line.startsWith(baseline) ? line.slice(baseline.length) : line.trimStart();
		return anchorIndent + stripped;
	});
	return joinLines(adjusted, trailingNewline);
}

/** Replace the range's lines with `content`, aligned to the range's own indent. */
export function replaceRange(text: string, range: LineRange, content: string): string {
	const { lines, trailingNewline } = splitLines(text);
	assertRange(range, lines.length);
	const end = Math.min(range.endLine, lines.length);
	const anchorIndent = indentOf(lines[range.startLine - 1]);
	const replacement = splitLines(reindentBlock(content, anchorIndent)).lines;
	const next = [...lines.slice(0, range.startLine - 1), ...replacement, ...lines.slice(end)];
	return joinLines(next, trailingNewline);
}

/**
 * Delete the range's lines entirely.
 *
 * Deleting every line of a file yields an empty file, not a file containing one blank
 * line — hence dropping the trailing-newline flag when nothing is left.
 */
export function deleteRange(text: string, range: LineRange): string {
	const { lines, trailingNewline } = splitLines(text);
	assertRange(range, lines.length);
	const end = Math.min(range.endLine, lines.length);
	const next = [...lines.slice(0, range.startLine - 1), ...lines.slice(end)];
	if (next.length === 0) return "";
	return joinLines(next, trailingNewline);
}

/** Insert `content` immediately before the range, aligned to the range's indent. */
export function insertBefore(text: string, range: LineRange, content: string): string {
	const { lines, trailingNewline } = splitLines(text);
	assertRange(range, lines.length);
	const anchorIndent = indentOf(lines[range.startLine - 1]);
	const block = splitLines(reindentBlock(content, anchorIndent)).lines;
	const next = [
		...lines.slice(0, range.startLine - 1),
		...block,
		...lines.slice(range.startLine - 1),
	];
	return joinLines(next, trailingNewline);
}

/**
 * Insert `content` immediately after the range.
 *
 * The anchor indent comes from the range's FIRST line, not its last: the last line of a
 * function is usually its closing brace, which sits at the declaration's indent anyway,
 * but for a range ending inside a nested block the first line is the one that describes
 * where this construct lives.
 */
export function appendAfter(text: string, range: LineRange, content: string): string {
	const { lines, trailingNewline } = splitLines(text);
	assertRange(range, lines.length);
	const end = Math.min(range.endLine, lines.length);
	const anchorIndent = indentOf(lines[range.startLine - 1]);
	const block = splitLines(reindentBlock(content, anchorIndent)).lines;
	const next = [...lines.slice(0, end), ...block, ...lines.slice(end)];
	return joinLines(next, trailingNewline);
}

export interface SubstituteOptions {
	/** Regex flags; `g` and `i` are honoured, others rejected. */
	flags?: string;
	maxMatches?: number;
	timeoutMs?: number;
}

export interface SubstituteResult {
	text: string;
	/** How many replacements were made, for the tool's report. */
	replacements: number;
}

/**
 * Regex-replace inside the range only.
 *
 * Applied line by line rather than to the joined block, for two reasons: a `g` flag then
 * means "every match on every line in range" (what sed means by it), and a pathological
 * pattern is bounded per line instead of against the whole block.
 *
 * The timeout is checked between lines. It cannot interrupt a single catastrophic match —
 * that would need a separate process — but it does stop a pattern that is merely slow
 * from running across thousands of lines.
 */
export function substituteInRange(
	text: string,
	range: LineRange,
	pattern: string,
	replacement: string,
	options: SubstituteOptions = {},
): SubstituteResult {
	const { lines, trailingNewline } = splitLines(text);
	assertRange(range, lines.length);
	const maxMatches = options.maxMatches ?? MAX_SUBSTITUTE_MATCHES;
	const timeoutMs = options.timeoutMs ?? SUBSTITUTE_TIMEOUT_MS;

	const rawFlags = options.flags ?? "";
	const unsupported = rawFlags.replace(/[gi]/g, "");
	if (unsupported) {
		throw new EditOpError(
			`Unsupported substitute flags: "${unsupported}". Only "g" and "i" are supported.`,
		);
	}
	const global = rawFlags.includes("g");

	let regex: RegExp;
	try {
		// A fresh regex per line would be wasteful, but a shared `g` regex carries
		// `lastIndex` between lines; `String.replace` resets it, so sharing is safe here.
		regex = new RegExp(pattern, global ? `g${rawFlags.includes("i") ? "i" : ""}` : rawFlags);
	} catch (error) {
		throw new EditOpError(
			`Invalid substitute pattern: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const started = Date.now();
	const end = Math.min(range.endLine, lines.length);
	const next = [...lines];
	let replacements = 0;

	for (let i = range.startLine - 1; i < end; i++) {
		if (Date.now() - started > timeoutMs) {
			throw new EditOpError(
				`Substitute exceeded ${timeoutMs}ms; narrow the range or simplify the pattern.`,
			);
		}
		const line = next[i];
		if (line === undefined) continue;
		// Count first, so the cap is enforced before mutating anything.
		const matches = line.match(regex);
		const found = matches ? (global ? matches.length : 1) : 0;
		if (found === 0) continue;
		if (replacements + found > maxMatches) {
			throw new EditOpError(
				`Substitute would exceed ${maxMatches} replacements; narrow the range.`,
			);
		}
		next[i] = line.replace(regex, replacement);
		replacements += found;
	}

	return { text: joinLines(next, trailingNewline), replacements };
}
