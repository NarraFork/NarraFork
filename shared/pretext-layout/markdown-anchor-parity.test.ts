/**
 * The two markdown renderers must advertise the SAME heading slug.
 *
 * This app renders markdown twice, through unrelated pipelines:
 *   - `MarkdownContent` (react-markdown) — documents, knowledge entries, changelog
 *   - the prepared layer (`parse-markdown` → vlist) — narrator timelines, chat
 *
 * A reader who moves between them sees the same document, so `[见下文](#实现细节)`
 * must resolve in both or the anchor is unreliable in a way nobody can predict. The
 * failure mode is silent — a click that scrolls nowhere — so the agreement is
 * asserted directly rather than assumed from two separate slug tests.
 *
 * Both sides are exercised through their REAL text extractor
 * (`inlineTokensToPlainText` over marked's tokens; `reactChildrenToHeadingText` over
 * a rendered React tree), not through a shared helper that would make the test pass
 * by construction. The React trees below are hand-built in the shapes react-markdown
 * and rehype-katex actually produce, which is the part this file has to get right:
 * an `<img>` whose children are undefined, and a KaTeX subtree carrying both a
 * MathML twin and per-glyph visual spans.
 *
 * Run: bun test shared/pretext-layout/markdown-anchor-parity.test.ts
 */

import { describe, expect, it } from "bun:test";
import { marked } from "marked";
import {
	inlineTokensToPlainText,
	reactChildrenToHeadingText,
	slugifyHeading,
} from "./markdown-anchor";

/** The slug the prepared (vlist) renderer would attach, straight from marked. */
function preparedSlug(headingMarkdown: string): string {
	const tokens = marked.lexer(headingMarkdown);
	const heading = tokens.find((token) => token.type === "heading");
	if (!heading || !("tokens" in heading)) throw new Error(`not a heading: ${headingMarkdown}`);
	return slugifyHeading(
		inlineTokensToPlainText((heading.tokens ?? []) as readonly { type?: string; text?: string }[]),
	);
}

/** The slug `MarkdownContent` would attach, from its rendered children. */
function reactSlug(children: unknown): string {
	return slugifyHeading(reactChildrenToHeadingText(children));
}

/** A React element, in the shape the walkers see (`type` + `props`). */
function el(type: string, props: Record<string, unknown>): unknown {
	return { type, props };
}

describe("plain text and inline markup", () => {
	const cases: ReadonlyArray<readonly [markdown: string, reactChildren: unknown]> = [
		["## Implementation Details", "Implementation Details"],
		["## 实现细节", "实现细节"],
		["## Don't do this!", "Don't do this!"],
		// react-markdown hands children as an array once markup is involved.
		["## **Bold** and plain", [el("strong", { children: "Bold" }), " and plain"]],
		["## 见 `code()`", ["见 ", el("code", { children: "code()" })]],
		[
			"## 见 [文档](https://example.com)",
			["见 ", el("a", { href: "https://example.com", children: "文档" })],
		],
	];

	for (const [markdown, children] of cases) {
		it(`agrees on ${JSON.stringify(markdown)}`, () => {
			const expected = preparedSlug(markdown);
			expect(expected).not.toBe("");
			expect(reactSlug(children)).toBe(expected);
		});
	}
});

describe("raw HTML in a heading", () => {
	// marked emits the tags as `type: "html"` tokens whose `.text` is the MARKUP, so
	// counting them slugged the tag names: `<b>加粗</b>标题` → `b加粗b标题`. Neither
	// renderer shows those tags — react-markdown has no `rehype-raw` and drops them —
	// so the prepared side was describing something nobody sees, and the same anchor
	// resolved in the timeline but not in a document.
	const cases: ReadonlyArray<readonly [markdown: string, reactChildren: unknown, slug: string]> = [
		["## <b>加粗</b>标题", "加粗标题", "加粗标题"],
		["## a <span>b</span> c", "a b c", "a-b-c"],
		// A void tag contributes no text at all on either side.
		["## <br>下一节", "下一节", "下一节"],
	];

	for (const [markdown, children, slug] of cases) {
		it(`agrees on ${JSON.stringify(markdown)}`, () => {
			expect(preparedSlug(markdown)).toBe(slug);
			expect(reactSlug(children)).toBe(slug);
		});
	}

	it("a heading of nothing but markup has no anchor", () => {
		// Not `br`: an attribute here would advertise an anchor with no visible text
		// behind it, and `#br` would then be addressable in one renderer only.
		expect(preparedSlug("## <br>")).toBe("");
	});
});

describe("images", () => {
	it("both sides slug the alt text", () => {
		// The prepared path reads the image token's `text` (its alt); a naive React walk
		// found `<img>`'s undefined children and contributed nothing, so the two produced
		// `见-图` and `见` for the same heading.
		const markdown = "## 见 ![图](x.png)";
		expect(preparedSlug(markdown)).toBe("见-图");
		expect(reactSlug(["见 ", el("img", { src: "x.png", alt: "图" })])).toBe("见-图");
	});

	it("an image with an empty alt contributes nothing on either side", () => {
		expect(preparedSlug("## 结论 ![](x.png)")).toBe("结论");
		expect(reactSlug(["结论 ", el("img", { src: "x.png", alt: "" })])).toBe("结论");
	});
});

describe("inline math", () => {
	it("neither side puts a formula in the slug", () => {
		// The prepared path replaces `$x_1$` with a `\uE000<index>\uE001` sentinel before
		// marked sees it, so that shape is what a heading token carries. The index digits
		// used to survive the slug rule as Unicode numbers, giving `收敛条件-0`.
		const withSentinel = slugifyHeading(
			inlineTokensToPlainText([{ type: "text", text: "收敛条件 \uE0000\uE001" }]),
		);
		expect(withSentinel).toBe("收敛条件");

		// rehype-katex's output: a MathML twin holding the LaTeX source, plus visual
		// per-glyph spans. Counting the twin would slug the source itself.
		const katex = el("span", {
			className: "katex",
			children: [
				el("span", {
					className: "katex-mathml",
					children: "x_1",
				}),
				el("span", {
					className: "katex-html",
					children: [el("span", { className: "mord", children: "x" })],
				}),
			],
		});
		expect(reactSlug(["收敛条件 ", katex])).toBe("收敛条件");
	});
});

describe("nothing sluggable", () => {
	it("both sides report no anchor", () => {
		// Emitting an attribute here would advertise an anchor that cannot be addressed.
		expect(preparedSlug("## 🎉")).toBe("");
		expect(reactSlug("🎉")).toBe("");
		expect(preparedSlug("## ***")).toBe("");
		expect(reactSlug([el("em", { children: el("strong", { children: "" }) })])).toBe("");
	});
});
