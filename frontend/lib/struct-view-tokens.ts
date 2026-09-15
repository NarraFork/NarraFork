/**
 * struct-view-tokens.ts — Colour StructView's report bodies by their OWN grammar.
 *
 * StructView emits structured reports, not code, so highlighting them with a language
 * grammar produces confidently wrong colours. Verified against the real Shiki tokenizer
 * on `outline` output:
 *
 *   - `exported` / `refs:3` / `decl` were painted with the FUNCTION-NAME colour. They
 *     are our own annotations, not identifiers.
 *   - `variable flat` came out completely uncoloured (`variable` is not a TS keyword),
 *     while `refs` on the same row was coloured. The single most useful token on the
 *     line — which kind of declaration this is — was the grey one.
 *   - `L13-27` was split into `L13` + `-` + `27`, the hyphen painted as an arithmetic
 *     operator. A line range read as a subtraction.
 *
 * So this tokenizer assigns colour by INFORMATION ROLE (line number, kind, symbol name,
 * signature, metadata, heading, prose) rather than by programming-language token class.
 *
 * `extract` and `print` deliberately do NOT come here: their bodies are real source of
 * the target file, where a language grammar is exactly right.
 *
 * ── Contract with the render layer ───────────────────────────────────────────────────
 * Output is `ShikiToken[][]` (one array per physical line), consumed by `TokenFlowText`,
 * which asserts that the token characters plus one `\n` per line boundary reproduce the
 * input EXACTLY, and falls back to plain text otherwise. Every function here is
 * therefore written to be character-preserving: tokens only ever partition the line,
 * never rewrite it. The tests lock this invariant per mode, because a drift makes
 * highlighting silently vanish rather than fail loudly.
 *
 * Synchronous and dependency-free by design: unlike Shiki (WASM + grammar fetch) this is
 * string matching, so it needs no async cache — which would only add an invalidation
 * surface.
 */

import type { ShikiToken } from "@frontend/lib/shiki-token-cache";

/** Colour roles, named for what the text MEANS in a StructView report. */
export interface StructTokenTheme {
	/** `L13-27`, `L48` — a location. One token; never split on the hyphen. */
	line: string;
	/** `function`, `variable`, `class`, `call` — the declaration kind. */
	kind: string;
	/** The declared symbol's own name. */
	symbol: string;
	/** Parameter lists, type annotations, initialisers. */
	signature: string;
	/** `· exported`, `refs:3`, `= useRef(…)` — our annotations. */
	meta: string;
	/** `refs:1 ⚠` — a dead-code signal, which should not be quiet. */
	warn: string;
	/** `STRUCTURE`, `TOP CALLS` — section headings. */
	heading: string;
	/** Occurrence counts in refs/calls tables. */
	count: string;
	/** JSX component names in `tree` output. */
	component: string;
	/** `{ternary}`, `{map}` — conditional-render markers. */
	conditional: string;
	/** Explanatory sentences. Deliberately quiet; never syntax-coloured. */
	prose: string;
	/** The file path in a body's header line. */
	path: string;
}

/**
 * GitHub-dark-adjacent, matching the Shiki themes the rest of the app uses.
 *
 * Every role gets a DISTINCT value. Sharing a hex between two roles compiles and passes a
 * naive test, but then "location" and "annotation" are the same grey on screen — the
 * separation this tokenizer exists to create would be lost in the theme instead of in the
 * grammar. A test asserts the values stay unique.
 */
export const STRUCT_THEME_DARK: StructTokenTheme = {
	line: "#79B8FF",
	kind: "#F97583",
	symbol: "#B392F0",
	signature: "#9ECBFF",
	meta: "#6A737D",
	warn: "#FFAB70",
	heading: "#FFEA7F",
	count: "#56D4DD",
	component: "#7EE787",
	conditional: "#D2A8FF",
	prose: "#8B949E",
	path: "#A5D6FF",
};

export const STRUCT_THEME_LIGHT: StructTokenTheme = {
	line: "#0550AE",
	kind: "#CF222E",
	symbol: "#8250DF",
	signature: "#0A3069",
	meta: "#6E7781",
	warn: "#BC4C00",
	heading: "#7D4E00",
	count: "#1B7C83",
	component: "#116329",
	conditional: "#A040C0",
	prose: "#57606A",
	path: "#0969DA",
};

/**
 * Declaration kinds the outline emitters produce.
 *
 * Kept as an explicit list rather than "first word on the line": an unrecognised leading
 * word must stay uncoloured, because guessing is precisely what the language grammar did
 * wrong.
 */
const KINDS = new Set([
	"function",
	"method",
	"class",
	"interface",
	"type",
	"enum",
	"variable",
	"property",
	"constructor",
	"getter",
	"setter",
	"namespace",
	"module",
	"struct",
	"trait",
	"impl",
	"call",
	"macro",
	"union",
	"constant",
	"field",
	"protocol",
	"extension",
	"object",
	"record",
	"annotation",
	"delegate",
	"event",
	"operator",
	"subroutine",
]);

/** A body larger than this is left as plain text, mirroring the Shiki path's ceiling. */
export const MAX_STRUCT_HIGHLIGHT_CHARS = 400_000;

/** Push a token, skipping empties so the output carries no zero-length spans. */
function push(out: ShikiToken[], content: string, color?: string): void {
	if (content) out.push(color ? { content, color } : { content });
}

/**
 * Split leading whitespace off, since indentation carries the nesting depth and must
 * survive verbatim for the columns to stay aligned.
 */
function splitIndent(line: string): [string, string] {
	const match = /^[ \t]*/.exec(line);
	const indent = match ? match[0] : "";
	return [indent, line.slice(indent.length)];
}

/**
 * The trailing annotation run (`· exported refs:1 ⚠`, `= useRef(…) refs:5`).
 *
 * `refs:1` gets the warning colour because it means "defined and never referenced in
 * this file" — the whole reason the column exists. Higher counts stay quiet.
 */
function pushMeta(out: ShikiToken[], text: string, theme: StructTokenTheme): void {
	// Split on the refs token so only it can take the warning colour.
	const pattern = /refs:(\d+)(\s*⚠)?/g;
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		push(out, text.slice(cursor, start), theme.meta);
		const isDead = match[1] === "1" || Boolean(match[2]);
		push(out, match[0], isDead ? theme.warn : theme.meta);
		cursor = start + match[0].length;
	}
	push(out, text.slice(cursor), theme.meta);
}

/** `L13-27` / `L48` / `L2557` at the start of a row, as ONE token. */
const LINE_REF = /^(L\d+(?:-\d+)?)(\s+)/;

/** A `kind name` pair after the line reference. */
const KIND_NAME = /^([a-z_]+)(\s+)(\S+)/;

/**
 * `L13-27  function foo (args) : T  · exported` — the outline/api/report row.
 *
 * Returns null when the line does not start with a line reference, so callers can try
 * the other shapes.
 */
function tokenizeDeclarationRow(line: string, theme: StructTokenTheme): ShikiToken[] | null {
	const [indent, rest] = splitIndent(line);
	const lineMatch = LINE_REF.exec(rest);
	if (!lineMatch) return null;

	const out: ShikiToken[] = [];
	push(out, indent);
	push(out, lineMatch[1], theme.line);
	push(out, lineMatch[2]);
	let tail = rest.slice(lineMatch[0].length);

	// `tree` rows carry a JSX element (optionally behind a `{ternary}` marker) rather
	// than a declaration.
	const conditional = /^(\{(?:and|or|map|ternary)\})(\s*)/.exec(tail);
	if (conditional) {
		push(out, conditional[1], theme.conditional);
		push(out, conditional[2]);
		tail = tail.slice(conditional[0].length);
	}
	if (tail.startsWith("<")) {
		push(out, tail, theme.component);
		return out;
	}

	const kindMatch = KIND_NAME.exec(tail);
	if (kindMatch && KINDS.has(kindMatch[1])) {
		push(out, kindMatch[1], theme.kind);
		push(out, kindMatch[2]);
		push(out, kindMatch[3], theme.symbol);
		tail = tail.slice(kindMatch[0].length);
	}

	// Everything up to the annotation separator is signature; the rest is metadata.
	// A `·` inside a default value would mis-split, but the emitters never place one
	// there, and a mis-split only shifts a colour boundary — it cannot drop characters.
	const separator = tail.indexOf("  · ");
	if (separator >= 0) {
		push(out, tail.slice(0, separator), theme.signature);
		pushMeta(out, tail.slice(separator), theme);
	} else {
		push(out, tail, theme.signature);
	}
	return out;
}

/** `   1  L29     function locateInOutline` — the refs table row. */
const REFS_ROW = /^(\s*)(\d+)(\s+)(L\d+)(\s+)(.*)$/;

/** `    4  flat.filter` — the calls table row. */
const CALLS_ROW = /^(\s*)(\d+)(\s+)(\S.*)$/;

/** `  L10  @mantine/core` — the imports table row. */
const IMPORT_ROW = /^(\s*)(L\d+)(\s+)(\S.*)$/;

/** `→ function enclosingInOutline  (L79-103)` — the enclosing answer. */
const ENCLOSING_ROW = /^(→\s*)([a-z_]+)(\s+)(\S+)(\s*)(\(L[\d-]+\))?\s*$/;

/** `Imports (97):` / `Calls:` / `STRUCTURE (top level, …)` — a section heading. */
const HEADING = /^([A-Z][A-Za-z]*(?:[ -][A-Za-z]+)*)(\s*\(.*?\))?(:)?(\s*(?:—|-)\s.*)?$/;

/** `path  [tsx, via tree-sitter]  3480 lines · 133 KB` — the body header. */
const HEADER = /^(\S.*?)(\s+\[[^\]]+\])(\s+.*)?$/;

function tokenizeRow(line: string, theme: StructTokenTheme): ShikiToken[] {
	if (!line) return [];

	const declaration = tokenizeDeclarationRow(line, theme);
	if (declaration) return declaration;

	const out: ShikiToken[] = [];

	const refs = REFS_ROW.exec(line);
	if (refs) {
		push(out, refs[1]);
		push(out, refs[2], theme.count);
		push(out, refs[3]);
		push(out, refs[4], theme.line);
		push(out, refs[5]);
		pushKindAndName(out, refs[6], theme);
		return out;
	}

	const enclosing = ENCLOSING_ROW.exec(line);
	if (enclosing) {
		push(out, enclosing[1], theme.meta);
		push(out, enclosing[2], KINDS.has(enclosing[2]) ? theme.kind : undefined);
		push(out, enclosing[3]);
		push(out, enclosing[4], theme.symbol);
		push(out, enclosing[5]);
		push(out, enclosing[6] ?? "", theme.line);
		// The regex trims trailing space via `\s*$`, so restore any remainder.
		const consumed = enclosing.slice(1).reduce((n, part) => n + (part?.length ?? 0), 0);
		push(out, line.slice(consumed));
		return out;
	}

	const importRow = IMPORT_ROW.exec(line);
	if (importRow) {
		push(out, importRow[1]);
		push(out, importRow[2], theme.line);
		push(out, importRow[3]);
		push(out, importRow[4], theme.signature);
		return out;
	}

	// Calls rows start with a count; a leading digit is what distinguishes them from
	// prose, which the emitters always start with a letter.
	const calls = CALLS_ROW.exec(line);
	if (calls) {
		push(out, calls[1]);
		push(out, calls[2], theme.count);
		push(out, calls[3]);
		push(out, calls[4], theme.symbol);
		return out;
	}

	const header = HEADER.exec(line);
	if (header?.[2]) {
		push(out, header[1], theme.path);
		push(out, header[2], theme.meta);
		push(out, header[3] ?? "", theme.meta);
		return out;
	}

	const heading = HEADING.exec(line);
	if (heading) {
		push(out, heading[1], theme.heading);
		push(out, heading[2] ?? "", theme.meta);
		push(out, heading[3] ?? "", theme.heading);
		// The em-dash clause is an explanation, so it reads as prose.
		push(out, heading[4] ?? "", theme.prose);
		return out;
	}

	// Unrecognised: one uncoloured token. Prose and anything the emitters add later land
	// here, which is the safe outcome — no colour beats a wrong colour.
	push(out, line, /^[A-Za-z]/.test(line.trimStart()) ? theme.prose : undefined);
	return out;
}

/** `function locateInOutline` at the tail of a refs row. */
function pushKindAndName(out: ShikiToken[], text: string, theme: StructTokenTheme): void {
	const match = KIND_NAME.exec(text);
	if (match && KINDS.has(match[1])) {
		push(out, match[1], theme.kind);
		push(out, match[2]);
		push(out, match[3], theme.symbol);
		push(out, text.slice(match[0].length), theme.meta);
		return;
	}
	push(out, text, theme.symbol);
}

/**
 * Tokenize a StructView report body.
 *
 * Line endings are preserved by splitting on `\n` only: a `\r` stays inside its line's
 * tokens, so a CRLF body still satisfies the render layer's length check (Shiki
 * normalizes them, which is why that path needs the check as a guard).
 */
export function tokenizeStructViewBody(
	text: string,
	theme: StructTokenTheme,
): ShikiToken[][] | null {
	if (!text || text.length > MAX_STRUCT_HIGHLIGHT_CHARS) return null;
	return text.split("\n").map((line) => tokenizeRow(line, theme));
}
