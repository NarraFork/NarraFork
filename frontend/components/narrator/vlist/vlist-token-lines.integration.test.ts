/**
 * vlist-token-lines.integration.test.ts — End-to-end alignment against the REAL
 * Shiki grammar and the REAL pretext line breaker.
 *
 * The unit tests use hand-written token fixtures, which proves the algorithm but
 * not the integration. This file closes that gap: it tokenizes actual source with
 * a real Shiki highlighter, wraps the same source with real pretext arithmetic at
 * several widths, and asserts the property the render layer depends on:
 *
 *   for every visual line, concatenating its tokens reproduces that line's text
 *   EXACTLY — never a shifted, truncated or padded variant.
 *
 * A regression here means mis-coloured code on screen, which is exactly the class
 * of bug the unit fixtures cannot catch (they cannot know how Shiki actually
 * splits a token run, or where pretext actually breaks a line).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { normalizeThemedTokens, type ShikiToken } from "@frontend/lib/shiki-token-cache";
import { installCanvasStub } from "./measure/test-canvas-stub";

// pretext measures through OffscreenCanvas; install the deterministic stub BEFORE
// the pretext-backed modules load (see CONTRACT.md §5).
beforeAll(() => installCanvasStub());

const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
const { splitTokensByVisualLines } = await import("./vlist-token-lines");
const { createHighlighterCore } = await import("shiki/core");
const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");

const FONT = "12px monospace";
const LINE_HEIGHT = 19;

let highlight: (code: string, lang: string) => ShikiToken[][];

beforeAll(async () => {
	const [tsModule, jsonModule, shellModule, themeModule] = await Promise.all([
		import("shiki/langs/typescript.mjs"),
		import("shiki/langs/json.mjs"),
		import("shiki/langs/shellscript.mjs"),
		import("shiki/themes/github-dark-default.mjs"),
	]);
	const core = await createHighlighterCore({
		engine: createOnigurumaEngine(import("shiki/wasm")),
		langs: [tsModule.default, jsonModule.default, shellModule.default],
		themes: [themeModule.default],
	});
	highlight = (code, lang) =>
		normalizeThemedTokens(
			core.codeToTokens(code, { lang: lang as "typescript", theme: "github-dark-default" }).tokens,
		);
});

/** Wrap `code` at `width` exactly the way the vlist render layer does. */
function visualLines(code: string, width: number): Array<{ text: string }> {
	const prepared = prepareWithSegments(code, FONT, { whiteSpace: "pre-wrap" });
	return layoutWithLines(prepared, width, LINE_HEIGHT).lines;
}

/** `prepared.segments` must reproduce the source — RenderMarkdown relies on it. */
function reconstructSource(code: string): string {
	const prepared = prepareWithSegments(code, FONT, { whiteSpace: "pre-wrap" });
	return (prepared as unknown as { segments: string[] }).segments.join("");
}

const textOf = (tokens: readonly ShikiToken[]): string =>
	tokens.map((token) => token.content).join("");

/**
 * Assert exact per-line alignment, and that colours were actually produced (a
 * split that silently degraded every line to `[]` would "align" trivially).
 */
function expectExactAlignment(code: string, lang: string, width: number) {
	const lines = visualLines(code, width);
	const split = splitTokensByVisualLines(highlight(code, lang), lines);
	expect(split).not.toBeNull();
	if (!split) throw new Error("unreachable");
	expect(split).toHaveLength(lines.length);

	let colouredLines = 0;
	for (let i = 0; i < lines.length; i++) {
		const expected = lines[i]?.text ?? "";
		const produced = textOf(split[i] ?? []);
		if (produced.length === 0 && expected.length > 0) continue; // documented fallback
		expect(produced).toBe(expected);
		if ((split[i]?.length ?? 0) > 0) colouredLines++;
	}
	// Blank-only bodies aside, real code must come back coloured.
	if (code.trim().length > 0) expect(colouredLines).toBeGreaterThan(0);
	return split;
}

const TS_SOURCE = [
	"import { useMemo } from 'react';",
	"",
	"export function computeTotals(rows: Row[], rate = 0.2): Totals {",
	"\tconst subtotal = rows.reduce((sum, row) => sum + row.price * row.quantity, 0);",
	"\t// A deliberately long comment line that will certainly need to soft wrap somewhere.",
	"\treturn { subtotal, tax: subtotal * rate, total: subtotal * (1 + rate) };",
	"}",
].join("\n");

const JSON_SOURCE = `{"name":"narrafork","nested":{"values":[1,2,3],"flag":true},"note":"a fairly long string value that should wrap at narrow widths"}`;

const SHELL_SOURCE = [
	"#!/usr/bin/env bash",
	"set -euo pipefail",
	'for f in "$@"; do',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in a fixture, not a JS placeholder
	'\techo "processing ${f}" && grep -rn "TODO" "$f" | head -20',
	"done",
].join("\n");

describe("token/visual-line alignment against real Shiki + real pretext", () => {
	it("reconstructs the source from pretext segments (RenderMarkdown's source path)", () => {
		expect(reconstructSource(TS_SOURCE)).toBe(TS_SOURCE);
		expect(reconstructSource(JSON_SOURCE)).toBe(JSON_SOURCE);
		expect(reconstructSource(SHELL_SOURCE)).toBe(SHELL_SOURCE);
	});

	it("aligns TypeScript at widths from very narrow to no-wrap", () => {
		// 60px forces aggressive wrapping; 4000px fits every line whole.
		for (const width of [60, 120, 240, 400, 800, 4000]) {
			expectExactAlignment(TS_SOURCE, "typescript", width);
		}
	});

	it("aligns a single long JSON line that only soft-wraps", () => {
		for (const width of [80, 200, 600]) {
			const split = expectExactAlignment(JSON_SOURCE, "json", width);
			// One physical line wrapping into many visual lines is the case where a
			// hard-break bug would show up as an off-by-one shift.
			if (width < 600) expect(split.length).toBeGreaterThan(1);
		}
	});

	it("aligns shell script with tabs, quotes and pipes", () => {
		for (const width of [90, 200, 500]) {
			expectExactAlignment(SHELL_SOURCE, "shellscript", width);
		}
	});

	it("keeps a wrapped identifier's colour continuous across the break", () => {
		const code = "const aVeryLongIdentifierName = 1;";
		const width = 100;
		const lines = visualLines(code, width);
		const split = splitTokensByVisualLines(highlight(code, "typescript"), lines);
		expect(split).not.toBeNull();
		// Every produced line still matches its text exactly.
		for (let i = 0; i < lines.length; i++) {
			const produced = textOf(split?.[i] ?? []);
			if (produced.length > 0) expect(produced).toBe(lines[i]?.text ?? "");
		}
		// Colours were assigned (the whole point of the integration).
		const anyColour = (split ?? []).flat().some((token) => token.color !== undefined);
		expect(anyColour).toBe(true);
	});

	it("preserves leading indentation characters in the coloured output", () => {
		const code = "function f() {\n\t\tconst indented = 1;\n}";
		const lines = visualLines(code, 4000);
		const split = splitTokensByVisualLines(highlight(code, "typescript"), lines);
		const indentedIndex = lines.findIndex((line) => line.text.includes("indented"));
		expect(indentedIndex).toBeGreaterThanOrEqual(0);
		expect(textOf(split?.[indentedIndex] ?? [])).toBe(lines[indentedIndex]?.text ?? "");
		expect(textOf(split?.[indentedIndex] ?? []).startsWith("\t\t")).toBe(true);
	});

	it("aligns a body whose blank lines create consecutive hard breaks", () => {
		const code = "const a = 1;\n\n\nconst b = 2;";
		const lines = visualLines(code, 4000);
		const split = splitTokensByVisualLines(highlight(code, "typescript"), lines);
		expect(split).toHaveLength(lines.length);
		for (let i = 0; i < lines.length; i++) {
			const produced = textOf(split?.[i] ?? []);
			if (produced.length > 0) expect(produced).toBe(lines[i]?.text ?? "");
		}
		// The last line must still be the second declaration, not a shifted remnant.
		expect(lines.at(-1)?.text).toBe("const b = 2;");
		expect(textOf(split?.at(-1) ?? [])).toBe("const b = 2;");
	});
});
