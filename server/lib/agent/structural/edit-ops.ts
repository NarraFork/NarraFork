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

/** Do two inclusive line ranges share any line? */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
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

/**
 * Validate a range against the text, with a message naming the actual bounds.
 *
 * Line 1 of an EMPTY file is accepted: `splitLines("")` is legitimately zero lines,
 * but "line 1" of nothing is the only way to name where content goes, and every
 * operation handles it coherently (a slice of an empty array inserts at the start).
 * Rejecting it made an empty file — including a file being created — impossible to
 * write into at all, while reporting the misleading "past the end of the file".
 */
function assertRange(range: LineRange, total: number): void {
	if (range.startLine < 1 || range.endLine < range.startLine) {
		throw new EditOpError(
			`Invalid line range ${range.startLine}-${range.endLine}: start must be >= 1 and end >= start.`,
		);
	}
	if (total === 0 && range.startLine === 1) return;
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

/** Where a same-file copy/move puts the block, relative to an anchor range. */
export type MovePlacement = "before" | "after";

export interface MoveOptions {
	/** Anchor to place the block at. Omit to append at end of file. */
	anchor?: LineRange;
	placement?: MovePlacement;
	/** Remove the source range (a move); false copies it. */
	removeSource: boolean;
}

/**
 * Copy or move a line range to another position in the SAME file.
 *
 * Computed as ONE pass over the original lines, never as "insert then delete by the old
 * line numbers": inserting shifts every line below it, so a subsequent delete addressed
 * against the pre-insert numbering removes the wrong lines. That failure is silent —
 * plausible-looking output with a neighbouring function truncated — which is why the
 * source and destination are resolved together here rather than composed from the
 * single-range helpers.
 *
 * An anchor inside the source range is rejected: "move these lines to somewhere between
 * these lines" has no meaningful result, and picking one would be a guess.
 */
export function relocateRange(text: string, source: LineRange, options: MoveOptions): string {
	const { lines, trailingNewline } = splitLines(text);
	assertRange(source, lines.length);
	const sourceEnd = Math.min(source.endLine, lines.length);
	const block = lines.slice(source.startLine - 1, sourceEnd);
	if (block.length === 0) {
		throw new EditOpError(`Source range ${source.startLine}-${source.endLine} selected no lines.`);
	}

	const anchor = options.anchor;
	if (anchor) {
		assertRange(anchor, lines.length);
		const anchorEnd = Math.min(anchor.endLine, lines.length);
		// Overlap in either direction is ambiguous, not just anchor-inside-source.
		const overlaps = anchor.startLine <= sourceEnd && source.startLine <= anchorEnd;
		if (overlaps) {
			throw new EditOpError(
				`Destination ${anchor.startLine}-${anchorEnd} overlaps the source ${source.startLine}-${sourceEnd}; ` +
					"pick a destination outside the range being moved.",
			);
		}
	}

	// The insertion point in ORIGINAL line numbering (0-based index to insert before).
	const insertAt = anchor
		? options.placement === "after"
			? Math.min(anchor.endLine, lines.length)
			: anchor.startLine - 1
		: lines.length;

	// Indent the block to its destination, so a method moved into a deeper scope lands
	// correctly rather than keeping the source's indentation.
	const anchorIndent = anchor
		? indentOf(lines[anchor.startLine - 1])
		: indentOf(lines[insertAt - 1]);
	const placed = splitLines(reindentBlock(joinLines(block, false), anchorIndent)).lines;

	const out: string[] = [];
	for (let i = 0; i <= lines.length; i++) {
		if (i === insertAt) out.push(...placed);
		if (i === lines.length) break;
		// Skipping the source here is what makes this one pass: the destination index was
		// computed against the original numbering and is honoured above regardless.
		const inSource = i >= source.startLine - 1 && i < sourceEnd;
		if (options.removeSource && inSource) continue;
		const line = lines[i];
		if (line !== undefined) out.push(line);
	}

	if (out.length === 0) return "";
	return joinLines(out, trailingNewline);
}

/**
 * The block a cross-file copy/move sends to another file, indented at column 0.
 *
 * Returned separately from the destination write because the two files are two distinct
 * authorized writes; this is just the payload.
 */
export function extractBlock(text: string, source: LineRange): string {
	const { lines } = splitLines(text);
	assertRange(source, lines.length);
	const end = Math.min(source.endLine, lines.length);
	const block = lines.slice(source.startLine - 1, end);
	if (block.length === 0) {
		throw new EditOpError(`Source range ${source.startLine}-${source.endLine} selected no lines.`);
	}
	// Rebased to column 0: the destination decides the final indent, and carrying the
	// source's leading whitespace would nest the block by however deep it used to be.
	return reindentBlock(joinLines(block, false), "");
}

export interface SubstituteOptions {
	/** Regex flags; `g` and `i` are honoured, others rejected. */
	flags?: string;
	maxMatches?: number;
	timeoutMs?: number;
}

/**
 * How many capture groups a pattern declares, and the names of the named ones.
 *
 * Derived by compiling `(?:pattern)|` and matching its empty alternative: the result
 * array has one slot per group and `.groups` carries every declared name. That works for
 * backreferences and lookaround without re-implementing a regex parser — counting `(` in
 * the source text would have to reason about escapes, character classes and the whole
 * `(?:` / `(?=` / `(?<=` family, and would eventually get one of them wrong.
 *
 * Returns null when the probe itself will not compile. Group checking is then skipped
 * rather than the substitution refused: this is a best-effort reading of the pattern, and
 * rejecting a pattern that compiles perfectly well on its own would be the worse error.
 */
function describeCaptureGroups(pattern: string): { count: number; names: Set<string> } | null {
	try {
		const probe = new RegExp(`(?:${pattern})|`).exec("");
		if (!probe) return null;
		return { count: probe.length - 1, names: new Set(Object.keys(probe.groups ?? {})) };
	} catch {
		return null;
	}
}

/**
 * Reject a replacement template that references a capture group the pattern does not have.
 *
 * Both ways this can go wrong are silent, and they corrupt in OPPOSITE directions — which
 * is why "it behaves like sed" is not a safe assumption to carry over:
 *
 *   - `"foo".replace(/foo/, "[$1]")` → `"[$1]"`. With no group to resolve, JS writes the
 *     reference through as LITERAL TEXT. A typo becomes `$1` sitting in the source file.
 *   - `"foo".replace(/(?<a>f)/, "[$<b>]")` → `"[]oo"`. A group that exists but was not
 *     matched, or an unknown NAME among known names, expands to the EMPTY STRING — the
 *     edit quietly deletes a span instead.
 *
 * Neither raises anything, so without this check the only evidence is the damaged file.
 *
 * What is deliberately NOT rejected, because it is well-defined in JS and someone may
 * mean it: a trailing lone `$` (a literal dollar sign — unlike some engines, this is not
 * an error here), `$&` / `` $` `` / `$'`, and `$10` against a one-group pattern, which the
 * spec resolves as group 1 followed by a literal `0`.
 */
export function validateReplacementTemplate(pattern: string, replacement: string): void {
	const groups = describeCaptureGroups(pattern);
	if (!groups) return;

	for (let i = 0; i < replacement.length; i++) {
		if (replacement[i] !== "$") continue;
		const next = replacement[i + 1];
		// A lone `$` at the very end is a literal dollar sign.
		if (next === undefined) break;
		if (next === "$" || next === "&" || next === "`" || next === "'") {
			i++;
			continue;
		}

		if (next === "<") {
			// `$<…>` is only a group reference when the pattern declares named groups at
			// all; otherwise the spec makes the whole thing literal text.
			if (groups.names.size === 0) {
				throw new EditOpError(
					`Replacement references \`$<…>\` but the pattern declares no named groups, ` +
						`so JS would write \`$<…>\` into the file as literal text. ` +
						`Use \`$1\` for a positional group, or declare \`(?<name>…)\` in the pattern.`,
				);
			}
			const close = replacement.indexOf(">", i + 2);
			if (close === -1) {
				throw new EditOpError("Replacement has an unterminated `$<` group reference.");
			}
			const name = replacement.slice(i + 2, close);
			if (!groups.names.has(name)) {
				throw new EditOpError(
					`Replacement references the named group \`$<${name}>\`, which the pattern does ` +
						`not declare. JS expands an unknown name to the EMPTY STRING, so this would ` +
						`silently delete that span. Declared names: ${[...groups.names].join(", ")}.`,
				);
			}
			i = close;
			continue;
		}

		if (next >= "0" && next <= "9") {
			// The spec prefers the two-digit reading, then falls back to one digit; only
			// when neither names a real group is the text written through literally.
			const pair = replacement.slice(i + 1, i + 3);
			const two = /^\d\d$/.test(pair) ? Number(pair) : Number.NaN;
			if (two >= 1 && two <= groups.count) {
				i += 2;
				continue;
			}
			const one = Number(next);
			if (one >= 1 && one <= groups.count) {
				i += 1;
				continue;
			}
			throw new EditOpError(
				groups.count === 0
					? `Replacement references \`$${next}\` but the pattern declares no capture ` +
							`groups, so JS would write \`$${next}\` into the file as literal text. ` +
							`Use \`$&\` for the whole match, or add a group to the pattern.`
					: `Replacement references \`$${next}\` but the pattern declares only ` +
							`${groups.count} capture group(s), so JS would write it into the file as ` +
							`literal text.`,
			);
		}
	}
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
 * pattern is bounded per line instead of against the whole block. A useful side effect is
 * that `^` and `$` anchor to each line for free, with no `m` flag involved.
 *
 * ── Either the whole range is substituted, or not one byte changes ──────────────────
 * The scan runs to completion BEFORE anything is rewritten. Every reason to refuse —
 * the match cap, the timeout, a zero-width pattern, a bad replacement template — is
 * therefore raised while the original text is still intact, and the caller gets an error
 * instead of a file that was half-processed. A half-substituted file is worse than an
 * untouched one: it looks finished, and the reader has no way to tell which half is which.
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
			`Unsupported substitute flags: "${unsupported}". Only "g" and "i" are supported. ` +
				`"m" and "s" are not missing features: the substitution already runs one line at a ` +
				`time, so "^" and "$" anchor per line, and no pattern here can span a line break.`,
		);
	}
	const global = rawFlags.includes("g");
	const flags = global ? (rawFlags.includes("i") ? "gi" : "g") : rawFlags;

	let regex: RegExp;
	try {
		// A fresh regex per line would be wasteful, but a shared `g` regex carries
		// `lastIndex` between lines; `String.match`/`String.replace` reset it, so sharing
		// is safe here.
		regex = new RegExp(pattern, flags);
	} catch (error) {
		throw new EditOpError(
			`Invalid substitute pattern: ${error instanceof Error ? error.message : String(error)}. ` +
				`This is the JS engine, so backreferences (\\1) and lookaround ((?=) (?!) (?<=) ` +
				`(?<!)) ARE available; what it does not have is a linear-time guarantee, so deeply ` +
				`nested quantifiers can backtrack catastrophically and hit the timeout below.`,
		);
	}

	// Raised before the scan: this one is a property of the two inputs alone.
	validateReplacementTemplate(pattern, replacement);

	const started = Date.now();
	const end = Math.min(range.endLine, lines.length);

	// ── Pass 1: scan. Nothing is rewritten here. ─────────────────────────────────────
	const hits: number[] = [];
	let replacements = 0;
	for (let i = range.startLine - 1; i < end; i++) {
		if (Date.now() - started > timeoutMs) {
			throw new EditOpError(
				`Substitute exceeded ${timeoutMs}ms and was abandoned; no lines were changed. ` +
					`Narrow the range, or simplify a pattern whose nested quantifiers are backtracking.`,
			);
		}
		const line = lines[i];
		if (line === undefined) continue;
		const matches = line.match(regex);
		if (!matches) continue;
		const found = global ? matches.length : 1;

		// Zero-width matches are the one failure that looks like success. `/x*/g` and
		// `/\b/g` match BETWEEN characters, so `replace` inserts the replacement text at
		// every such position: "abc" becomes "|a|b|c|".
		//
		// Two things make this worth a dedicated check rather than a note in the docs:
		//
		//   - Asking whether the pattern can match the empty string is NOT sufficient.
		//     `/\b/.test("")` is FALSE — an empty string contains no word boundary — yet
		//     `\b` produces four zero-width hits on "ab cd". Only looking at the matches
		//     actually found answers the question.
		//   - More than one zero-width hit on a single line is the discriminator. Exactly
		//     one is what a deliberate `s/^/prefix/` or `s/$/;/` produces, and those are
		//     ordinary sed idioms worth keeping; a second one on the same line means the
		//     text is being injected into the middle of it.
		const zeroWidth = global
			? matches.reduce((n, m) => (m === "" ? n + 1 : n), 0)
			: matches[0] === ""
				? 1
				: 0;
		if (zeroWidth > 1) {
			throw new EditOpError(
				`Pattern /${pattern}/ produces ZERO-WIDTH matches (it can match between two ` +
					`characters — "x*", "\\b", "(?:)" and friends), ${zeroWidth} of them on line ` +
					`${i + 1} alone. Replacing them would insert the replacement text between ` +
					`characters and scramble the line, so nothing was changed. Rewrite it to match ` +
					`at least one character (e.g. "\\w+" instead of "\\w*", or the real characters ` +
					`around a "\\b").`,
			);
		}

		if (replacements + found > maxMatches) {
			throw new EditOpError(
				`Substitute would exceed ${maxMatches} replacements; nothing was changed. ` +
					`Narrow the range.`,
			);
		}
		hits.push(i);
		replacements += found;
	}

	if (hits.length === 0) return { text, replacements: 0 };

	// ── Pass 2: apply. Every reason to refuse has already been raised. ───────────────
	const next = [...lines];
	for (const i of hits) {
		const line = next[i];
		if (line === undefined) continue;
		next[i] = line.replace(regex, replacement);
	}

	return { text: joinLines(next, trailingNewline), replacements };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch application.
// ─────────────────────────────────────────────────────────────────────────────

/** One already-addressed operation in a batch. */
export interface BatchOperation {
	/** Resolved source range, in ORIGINAL file line numbers. */
	range: LineRange;
	apply: (text: string, range: LineRange) => string;
	/** For error messages: which operation this was, 1-based as the caller listed it. */
	index: number;
	/** For error messages: what it does, e.g. `delete` or `replace`. */
	label: string;
}

/**
 * Apply several operations to one text as a single unit.
 *
 * ── Why every address is relative to the ORIGINAL file ───────────────────────────────
 * Applying in the caller's order makes each operation's address depend on how much the
 * previous ones shifted the file — the model would have to predict the intermediate state
 * to write the second address, which is not something it can do reliably. So operations are
 * applied from the BOTTOM UP: a change below never moves the lines above it, so every
 * address means what it meant when the batch was written. This is the only predictable
 * semantics, and it is what the tool documents.
 *
 * ── Why overlaps are rejected outright ───────────────────────────────────────────────
 * Two operations touching the same line have no defined combined result: whichever runs
 * second sees text the first rewrote, so the outcome depends on ordering the caller did not
 * choose. Rejecting the whole batch is the honest answer; picking an order would produce a
 * plausible file that nobody asked for.
 *
 * Atomicity is structural rather than transactional: this returns ONE final string, so a
 * failure part-way through throws and no intermediate state is ever written to disk.
 */
export function applyBatch(text: string, operations: readonly BatchOperation[]): string {
	if (operations.length === 0) throw new EditOpError("A batch needs at least one operation.");

	const { lines } = splitLines(text);
	for (const op of operations) assertRange(op.range, lines.length);

	// Sorted by start line so overlap detection only has to compare neighbours.
	const ordered = [...operations].sort((a, b) => a.range.startLine - b.range.startLine);
	for (let i = 1; i < ordered.length; i++) {
		const previous = ordered[i - 1];
		const current = ordered[i];
		if (!previous || !current) continue;
		if (rangesOverlap(previous.range, current.range)) {
			throw new EditOpError(
				`Operations ${previous.index} (${previous.label}, L${previous.range.startLine}-${previous.range.endLine}) and ` +
					`${current.index} (${current.label}, L${current.range.startLine}-${current.range.endLine}) overlap. ` +
					"Every address in a batch is relative to the original file, so overlapping ranges have no defined result — split them into separate calls.",
			);
		}
	}

	let result = text;
	// Bottom-up: this is what keeps the remaining addresses valid.
	for (let i = ordered.length - 1; i >= 0; i--) {
		const op = ordered[i];
		if (!op) continue;
		try {
			result = op.apply(result, op.range);
		} catch (error) {
			throw new EditOpError(
				`Operation ${op.index} (${op.label}) failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return result;
}
