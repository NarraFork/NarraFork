/**
 * TokenLines.test.tsx — Render contract for the colour-only code painters.
 *
 * The properties asserted here are what keep syntax colours compatible with the
 * zero-DOM-measure height contract:
 *
 *   1. TEXT FIDELITY — the rendered characters are byte-identical to the plain
 *      text, so the browser lays out the same glyph run and the measured line
 *      geometry stays correct.
 *   2. COLOUR ONLY — spans carry `color` and nothing else (no display, font,
 *      white-space or spacing), so they cannot alter the line box.
 *   3. SAFE DEGRADATION — missing tokens, or tokens that do not cover the text
 *      exactly, fall back to plain text rather than painting shifted colours.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenFlowText, TokenText } from "../../content/TokenLines";

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const renderLine = (text: string, tokens?: readonly ShikiToken[] | null) =>
	parse(renderToStaticMarkup(<TokenText text={text} tokens={tokens} />));
const renderFlow = (text: string, tokens?: ShikiToken[][] | null) =>
	parse(renderToStaticMarkup(<TokenFlowText text={text} tokens={tokens} />));

/** Every style property set on the rendered spans, deduped. */
function styledProperties(root: Element): string[] {
	const props = new Set<string>();
	for (const span of Array.from(root.querySelectorAll("span"))) {
		const style = span.getAttribute("style") ?? "";
		for (const decl of style.split(";")) {
			const name = decl.split(":")[0]?.trim();
			if (name) props.add(name);
		}
	}
	return [...props].sort();
}

describe("TokenText", () => {
	it("renders plain text when there are no tokens", () => {
		expect(renderLine("const a = 1;").textContent).toBe("const a = 1;");
		expect(renderLine("const a = 1;", null).textContent).toBe("const a = 1;");
		expect(renderLine("const a = 1;", []).textContent).toBe("const a = 1;");
		expect(renderLine("const a = 1;").querySelectorAll("span")).toHaveLength(0);
	});

	it("paints one span per token and preserves the exact text", () => {
		const root = renderLine("const a", [
			{ content: "const", color: "#ff7b72" },
			{ content: " a", color: "#c9d1d9" },
		]);
		expect(root.textContent).toBe("const a");
		const spans = Array.from(root.querySelectorAll("span"));
		expect(spans).toHaveLength(2);
		expect(spans[0]?.textContent).toBe("const");
		expect(spans[0]?.getAttribute("style")).toContain("#ff7b72");
	});

	it("sets ONLY the colour property (geometry must stay untouched)", () => {
		const root = renderLine("ab", [
			{ content: "a", color: "#fff" },
			{ content: "b", color: "#000" },
		]);
		expect(styledProperties(root)).toEqual(["color"]);
	});

	it("emits no style attribute for an uncoloured token", () => {
		const root = renderLine("  x", [{ content: "  " }, { content: "x", color: "#abc" }]);
		expect(root.textContent).toBe("  x");
		const spans = Array.from(root.querySelectorAll("span"));
		expect(spans[0]?.hasAttribute("style")).toBe(false);
		expect(spans[1]?.getAttribute("style")).toContain("#abc");
	});

	it("preserves whitespace-only tokens so indentation survives", () => {
		const root = renderLine("\t\treturn", [
			{ content: "\t\t" },
			{ content: "return", color: "#f0f" },
		]);
		expect(root.textContent).toBe("\t\treturn");
	});

	it("falls back to plain text when tokens do not cover the line exactly", () => {
		// Short by one character — colouring would shift every glyph after it.
		const short = renderLine("abcd", [{ content: "abc", color: "#f00" }]);
		expect(short.textContent).toBe("abcd");
		expect(short.querySelectorAll("span")).toHaveLength(0);

		// Too long (a desync in the other direction).
		const long = renderLine("ab", [{ content: "abcd", color: "#f00" }]);
		expect(long.textContent).toBe("ab");
		expect(long.querySelectorAll("span")).toHaveLength(0);
	});

	it("renders an empty line as empty", () => {
		expect(renderLine("", null).textContent).toBe("");
	});
});

describe("TokenFlowText", () => {
	it("renders plain text when there are no tokens", () => {
		expect(renderFlow("a\nb").textContent).toBe("a\nb");
		expect(renderFlow("a\nb", null).textContent).toBe("a\nb");
		expect(renderFlow("a\nb", []).textContent).toBe("a\nb");
	});

	it("rejoins physical lines with real newlines, byte-identical to the source", () => {
		const text = "const a = 1;\nconst b = 2;";
		const root = renderFlow(text, [
			[
				{ content: "const", color: "#ff7b72" },
				{ content: " a = 1;", color: "#c9d1d9" },
			],
			[
				{ content: "const", color: "#ff7b72" },
				{ content: " b = 2;", color: "#c9d1d9" },
			],
		]);
		// The `pre-wrap` container relies on the newline being a real text node.
		expect(root.textContent).toBe(text);
		expect(root.querySelectorAll("span")).toHaveLength(4);
	});

	it("sets ONLY the colour property", () => {
		const root = renderFlow("a\nb", [[{ content: "a", color: "#fff" }], [{ content: "b" }]]);
		expect(styledProperties(root)).toEqual(["color"]);
	});

	it("round-trips blank lines inside the body", () => {
		const text = "a\n\nb";
		const root = renderFlow(text, [
			[{ content: "a", color: "#111" }],
			[],
			[{ content: "b", color: "#333" }],
		]);
		expect(root.textContent).toBe(text);
	});

	it("falls back to plain text when the token total does not match (e.g. CRLF)", () => {
		// Shiki normalizes \r\n, so its tokens are shorter than the rendered source.
		const text = "a\r\nb";
		const root = renderFlow(text, [[{ content: "a", color: "#f00" }], [{ content: "b" }]]);
		expect(root.textContent).toBe(text);
		expect(root.querySelectorAll("span")).toHaveLength(0);
	});

	it("falls back when a line's tokens are short", () => {
		const text = "abc\ndef";
		const root = renderFlow(text, [
			[{ content: "ab", color: "#f00" }],
			[{ content: "def", color: "#0f0" }],
		]);
		expect(root.textContent).toBe(text);
		expect(root.querySelectorAll("span")).toHaveLength(0);
	});

	it("handles a single-line body", () => {
		const root = renderFlow("solo", [[{ content: "solo", color: "#abc" }]]);
		expect(root.textContent).toBe("solo");
		expect(root.querySelectorAll("span")).toHaveLength(1);
	});
});
