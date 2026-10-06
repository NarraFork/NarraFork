/**
 * The load-bearing test here is the LENGTH INVARIANT.
 *
 * `TokenFlowText` verifies that the token characters plus one `\n` per line boundary
 * reproduce the input exactly, and renders plain text when they do not. So a tokenizer bug
 * that drops or duplicates a character does not show up as a visible defect — highlighting
 * just silently stops working. Every shape is therefore checked against that invariant, not
 * only against the colours it produces.
 */

import { describe, expect, test } from "bun:test";
import {
	MAX_STRUCT_HIGHLIGHT_CHARS,
	STRUCT_THEME_DARK,
	STRUCT_THEME_LIGHT,
	type StructTokenTheme,
	tokenizeStructViewBody,
} from "@frontend/lib/struct-view-tokens";

/** Reproduce what the renderer will paint, so a drift is measured the way it matters. */
function rendered(text: string, theme: StructTokenTheme = STRUCT_THEME_DARK): string {
	const lines = tokenizeStructViewBody(text, theme);
	if (!lines) return "";
	return lines.map((line) => line.map((token) => token.content).join("")).join("\n");
}

/** The colour assigned to the first token whose content matches. */
function colorOf(text: string, needle: string): string | undefined {
	const lines = tokenizeStructViewBody(text, STRUCT_THEME_DARK) ?? [];
	for (const line of lines) {
		for (const token of line) {
			if (token.content === needle) return token.color;
		}
	}
	return undefined;
}

function tokensOf(text: string): Array<{ content: string; color?: string }> {
	return (tokenizeStructViewBody(text, STRUCT_THEME_DARK) ?? [])[0] ?? [];
}

/** Real emitter output, one sample per line shape. */
const SAMPLES: Record<string, string> = {
	outlineRow:
		"L13-27       function toLocatedNode (node: RichOutlineNode) : LocatedNode  · exported",
	outlineNested: "  L48          variable flat  · = flattenOutline(…) refs:3",
	outlineDead:
		"L257-259     function _getMessageViewportDistanceFromBottom (scroller: HTMLElement)  · refs:1 ⚠",
	outlineDestructured:
		"  L334-336     variable [ chunkTailMeta, setMessageListTailMeta ]  · = useState(…) refs:5",
	structuralCall: "  L338-340     call useEffect [narratorId]",
	refsRow: "   1  L109    function parsePosition",
	callsRow: "   45  t",
	callsDotted: "    4  flat.filter",
	importRow: "  L10  @frontend/lib/responsive",
	treeRow: "L2631-3477   <PermEnterHintCtx.Provider>",
	treeConditional: "L2680-2684             {ternary} <Tooltip>",
	enclosingRow: "→ function enclosingInOutline  (L79-103)",
	heading: "STRUCTURE (top level, 368 declarations total)",
	headingPlain: "TOP CALLS",
	headingWithProse: "SINGLE-REFERENCE SYMBOLS (5) — defined but never used in this file.",
	prose: "Cross-file usage is invisible here; confirm with Grep before deleting.",
	header: "frontend/components/narrator/NarratorPanel.tsx  [tsx, via exact]  3480 lines · 133 KB",
	largest: "largest: function NarratorPanel L261-3479 (93% of file)",
	sectionLabel: "refs  line     declaration",
	callsLabel: "Calls:",
	importsLabel: "Imports (97):",
};

describe("length invariant", () => {
	for (const [name, sample] of Object.entries(SAMPLES)) {
		test(`${name} round-trips exactly`, () => {
			expect(rendered(sample)).toBe(sample);
		});
	}

	test("a whole multi-line body round-trips", () => {
		const body = Object.values(SAMPLES).join("\n");
		expect(rendered(body)).toBe(body);
	});

	test("blank and whitespace-only lines survive", () => {
		const body = "L1  function a\n\n   \n\t\nL9  function b";
		expect(rendered(body)).toBe(body);
	});

	test("both themes preserve the text", () => {
		const body = Object.values(SAMPLES).join("\n");
		expect(rendered(body, STRUCT_THEME_LIGHT)).toBe(body);
	});

	test("CRLF survives, unlike the Shiki path which normalizes it", () => {
		const body = "L1-3  function a\r\nL5  variable b\r\n";
		expect(rendered(body)).toBe(body);
	});

	test("CJK, tabs and wide symbols survive", () => {
		const body =
			"L1-9   function 处理消息 (参数: 类型)  · exported\n\tL20  variable 状态  · refs:1 ⚠";
		expect(rendered(body)).toBe(body);
	});

	test("a very long single line survives", () => {
		const body = `L1-2  function wide (${"a: string, ".repeat(400)})  · exported`;
		expect(rendered(body)).toBe(body);
	});

	test("unrecognised lines pass through untouched", () => {
		const body = "!!! nothing like an emitter row !!!\n<<< >>>\n42";
		expect(rendered(body)).toBe(body);
	});
});

describe("the three defects a language grammar produced", () => {
	test("`variable` is coloured as a kind, not left grey", () => {
		// Shiki left this uncoloured because `variable` is not a TS keyword — while
		// colouring `refs` on the same row.
		expect(colorOf(SAMPLES.outlineNested, "variable")).toBe(STRUCT_THEME_DARK.kind);
	});

	test("a line range is ONE token, not a subtraction", () => {
		const tokens = tokensOf(SAMPLES.outlineRow);
		const range = tokens.find((t) => t.content === "L13-27");
		expect(range).toBeDefined();
		expect(range?.color).toBe(STRUCT_THEME_DARK.line);
		// The hyphen must not appear as a standalone operator token.
		expect(tokens.some((t) => t.content === "-")).toBe(false);
	});

	test("`exported` reads as metadata, never as a symbol name", () => {
		const meta = tokensOf(SAMPLES.outlineRow).at(-1);
		expect(meta?.content).toContain("exported");
		expect(meta?.color).toBe(STRUCT_THEME_DARK.meta);
		expect(meta?.color).not.toBe(STRUCT_THEME_DARK.symbol);
	});
});

describe("colour roles", () => {
	test("kind and symbol are distinguishable on a declaration row", () => {
		expect(colorOf(SAMPLES.outlineRow, "function")).toBe(STRUCT_THEME_DARK.kind);
		expect(colorOf(SAMPLES.outlineRow, "toLocatedNode")).toBe(STRUCT_THEME_DARK.symbol);
	});

	test("refs:1 is a warning; a higher count is quiet", () => {
		expect(colorOf(SAMPLES.outlineDead, "refs:1 ⚠")).toBe(STRUCT_THEME_DARK.warn);
		expect(colorOf(SAMPLES.outlineNested, "refs:3")).toBe(STRUCT_THEME_DARK.meta);
	});

	test("a JSX component and its conditional marker differ", () => {
		expect(colorOf(SAMPLES.treeConditional, "{ternary}")).toBe(STRUCT_THEME_DARK.conditional);
		expect(colorOf(SAMPLES.treeConditional, "<Tooltip>")).toBe(STRUCT_THEME_DARK.component);
	});

	test("occurrence counts are coloured as counts", () => {
		expect(colorOf(SAMPLES.refsRow, "1")).toBe(STRUCT_THEME_DARK.count);
		expect(colorOf(SAMPLES.callsDotted, "4")).toBe(STRUCT_THEME_DARK.count);
	});

	test("a heading is emphasised and its trailing explanation is prose", () => {
		expect(colorOf(SAMPLES.headingPlain, "TOP CALLS")).toBe(STRUCT_THEME_DARK.heading);
		const explanation = tokensOf(SAMPLES.headingWithProse).at(-1);
		expect(explanation?.color).toBe(STRUCT_THEME_DARK.prose);
	});

	test("prose gets no syntax colour at all", () => {
		const tokens = tokensOf(SAMPLES.prose);
		expect(tokens).toHaveLength(1);
		expect(tokens[0]?.color).toBe(STRUCT_THEME_DARK.prose);
		// The words a TS grammar mistook for keywords must not stand out.
		expect(tokens[0]?.color).not.toBe(STRUCT_THEME_DARK.kind);
	});

	test("the header line separates path from stats", () => {
		const tokens = tokensOf(SAMPLES.header);
		expect(tokens[0]?.color).toBe(STRUCT_THEME_DARK.path);
		expect(tokens[0]?.content).toContain("NarratorPanel.tsx");
	});

	test("an unknown leading word is left uncoloured rather than guessed", () => {
		// Guessing is exactly what the language grammar got wrong.
		const tokens = tokensOf("L5-9   frobnicate someName  · exported");
		expect(tokens.some((t) => t.content === "frobnicate" && t.color)).toBe(false);
	});

	test("every role has a distinct colour in both themes", () => {
		for (const theme of [STRUCT_THEME_DARK, STRUCT_THEME_LIGHT]) {
			const values = Object.values(theme);
			expect(new Set(values).size).toBe(values.length);
			for (const value of values) expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
		}
	});
});

describe("limits", () => {
	test("empty input yields no tokens", () => {
		expect(tokenizeStructViewBody("", STRUCT_THEME_DARK)).toBeNull();
	});

	test("an oversized body is left to plain text", () => {
		const huge = "L1  function a\n".repeat(Math.ceil(MAX_STRUCT_HIGHLIGHT_CHARS / 15) + 1);
		expect(huge.length).toBeGreaterThan(MAX_STRUCT_HIGHLIGHT_CHARS);
		expect(tokenizeStructViewBody(huge, STRUCT_THEME_DARK)).toBeNull();
	});

	test("no token is empty, so no zero-length spans are emitted", () => {
		const lines = tokenizeStructViewBody(Object.values(SAMPLES).join("\n"), STRUCT_THEME_DARK);
		for (const line of lines ?? []) {
			for (const token of line) expect(token.content.length).toBeGreaterThan(0);
		}
	});
});
