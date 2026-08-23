/**
 * markdown-anchor.test.ts — the slug a heading advertises and the slug a `#…`
 * href asks for must be produced by ONE rule, or a document-internal link
 * silently resolves to nothing.
 *
 * That silence is the whole risk in this module: a wrong slug does not throw, it
 * just makes the click do nothing (both renderers refuse to navigate for an
 * unresolved same-document anchor, which is better than the old behaviour of
 * opening a blank tab, but indistinguishable from a bug). So the round-trip —
 * `slugifyHeading(headingText)` equals `classifyMarkdownAnchor("#" + href).slug` —
 * is asserted directly rather than inferred from the two halves separately.
 *
 * The other silent failure is the `sameDocument` / `slug` split: an href like `#!`
 * IS a same-document fragment with no slug, and reporting it as "not an anchor"
 * hands the click back to the browser, which pushes an invalid fragment that
 * TanStack Router reads as a location change. So both fields are asserted, never
 * just the slug.
 */

import { describe, expect, it } from "bun:test";
import { classifyMarkdownAnchor, inlineTokensToPlainText, slugifyHeading } from "./markdown-anchor";

describe("slugifyHeading", () => {
	it("lowercases and joins words with hyphens", () => {
		expect(slugifyHeading("Implementation Details")).toBe("implementation-details");
		expect(slugifyHeading("  Leading and trailing  ")).toBe("leading-and-trailing");
	});

	it("keeps CJK text instead of dropping it", () => {
		// The reason this module does not reuse `server/lib/slug.ts`'s ASCII-oriented
		// rule: a Chinese heading is the common case here, and slugging it to "" would
		// leave every `#实现细节` link dead.
		expect(slugifyHeading("实现细节")).toBe("实现细节");
		expect(slugifyHeading("架构 与 实现")).toBe("架构-与-实现");
	});

	it("drops punctuation the way GitHub does", () => {
		expect(slugifyHeading("Don't do this!")).toBe("dont-do-this");
		expect(slugifyHeading("What is `code`?")).toBe("what-is-code");
		expect(slugifyHeading("A/B testing")).toBe("ab-testing");
	});

	it("keeps hyphens and underscores, collapsing hyphen runs", () => {
		expect(slugifyHeading("well-known")).toBe("well-known");
		expect(slugifyHeading("snake_case_name")).toBe("snake_case_name");
		// GitHub would emit `a---b`; collapsing only widens what matches, because the
		// href goes through this same function.
		expect(slugifyHeading("a - b")).toBe("a-b");
		expect(slugifyHeading("a -- b")).toBe("a-b");
	});

	it("trims hyphens that would land on an edge", () => {
		expect(slugifyHeading("— Heading —")).toBe("heading");
		expect(slugifyHeading("(note)")).toBe("note");
	});

	it("returns an empty string for a heading with nothing sluggable", () => {
		// Callers must read "" as "no anchor" rather than emitting `id=""`.
		expect(slugifyHeading("***")).toBe("");
		expect(slugifyHeading("🎉")).toBe("");
		expect(slugifyHeading("   ")).toBe("");
	});
});

describe("classifyMarkdownAnchor", () => {
	it("accepts a fragment-only href", () => {
		expect(classifyMarkdownAnchor("#implementation-details")).toEqual({
			sameDocument: true,
			slug: "implementation-details",
		});
		expect(classifyMarkdownAnchor("#Implementation Details")).toEqual({
			sameDocument: true,
			slug: "implementation-details",
		});
	});

	it("percent-decodes a non-ASCII fragment", () => {
		// How a CJK anchor normally arrives once it has been through a URL.
		expect(classifyMarkdownAnchor("#%E5%AE%9E%E7%8E%B0%E7%BB%86%E8%8A%82").slug).toBe("实现细节");
		expect(classifyMarkdownAnchor("#实现细节").slug).toBe("实现细节");
	});

	it("uses a malformed escape as written rather than failing", () => {
		// A lone `%` is legal in a fragment; the browser does not reject it either.
		expect(classifyMarkdownAnchor("#100%-done").slug).toBe("100-done");
	});

	it("refuses anything that is not a pure fragment", () => {
		// These name another document; hijacking them would break real navigation.
		for (const href of [
			"/docs/page#section",
			"https://example.com/#section",
			"page.md#section",
			"mailto:a@b.com",
			null,
			undefined,
		]) {
			expect(classifyMarkdownAnchor(href)).toEqual({ sameDocument: false, slug: null });
		}
	});

	it("leaves a BARE `#` to the browser", () => {
		// "Top of page", which the browser does correctly — and the conventional href of
		// a link whose behaviour lives entirely in its own click handler.
		expect(classifyMarkdownAnchor("#")).toEqual({ sameDocument: false, slug: null });
		// `"#   "` is the same href: the whole value is trimmed first, so trailing
		// whitespace cannot turn top-of-page into an anchor that scrolls nowhere.
		expect(classifyMarkdownAnchor("#   ")).toEqual({ sameDocument: false, slug: null });
	});

	it("claims a fragment with nothing sluggable, reporting no slug", () => {
		// The regression this pins: these ARE same-document fragments. Reporting them as
		// "not an anchor" let the browser push `#!` into the URL, which TanStack Router
		// reads as a location change — the page-jump symptom the anchor work set out to
		// remove. Consumed, scrolls nowhere.
		for (const href of ["#!", "#🎉", "#***", "#---", "#%20"]) {
			expect(classifyMarkdownAnchor(href), href).toEqual({ sameDocument: true, slug: null });
		}
	});
});

describe("heading ↔ href round-trip", () => {
	/** Every pair a model plausibly writes: the heading, and the link to it. */
	const pairs: ReadonlyArray<readonly [heading: string, href: string]> = [
		["Implementation Details", "#implementation-details"],
		["实现细节", "#实现细节"],
		["实现细节", "#%E5%AE%9E%E7%8E%B0%E7%BB%86%E8%8A%82"],
		["Don't do this!", "#dont-do-this"],
		["Chapter 2: Forking", "#chapter-2-forking"],
		["架构 与 实现", "#架构-与-实现"],
		["well-known limits", "#well-known-limits"],
	];

	for (const [heading, href] of pairs) {
		it(`resolves ${JSON.stringify(href)} to ${JSON.stringify(heading)}`, () => {
			expect(classifyMarkdownAnchor(href).slug).toBe(slugifyHeading(heading));
		});
	}
});

describe("inlineTokensToPlainText", () => {
	it("reads the visible text, not a link's destination", () => {
		// The heading token's raw `.text` would slug the URL into the anchor.
		const tokens = [
			{ type: "text", text: "见 " },
			{ type: "link", text: "文档", tokens: [{ type: "text", text: "文档" }] },
		];
		expect(inlineTokensToPlainText(tokens)).toBe("见 文档");
		expect(slugifyHeading(inlineTokensToPlainText(tokens))).toBe("见-文档");
	});

	it("descends through emphasis and keeps codespan text verbatim", () => {
		const tokens = [
			{ type: "strong", tokens: [{ type: "text", text: "Bold" }] },
			{ type: "text", text: " and " },
			{ type: "codespan", text: "code()" },
		];
		expect(inlineTokensToPlainText(tokens)).toBe("Bold and code()");
	});

	it("tolerates tokens with neither text nor children", () => {
		expect(inlineTokensToPlainText([{ type: "br" }, { type: "text", text: "x" }])).toBe("x");
		expect(inlineTokensToPlainText([])).toBe("");
	});
});
