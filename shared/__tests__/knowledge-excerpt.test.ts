/**
 * knowledge-excerpt.test.ts — Markdown body → one-line plain-text excerpt.
 *
 * ## The bug under test
 *
 * A knowledge hit's `summary` was produced by `body.replace(/\s+/g, " ")` and then
 * rendered AS MARKDOWN. Flattening does not neutralize Markdown, it weaponizes it: an
 * entry body opens with `# Title`, so after the collapse the entire excerpt sat behind
 * one `#` and painted as a single display-size heading several lines tall, with the
 * body's surviving `>` / backtick / `-` markers strewn through it.
 *
 * So what is pinned here is that the excerpt comes out as PROSE, that a leading line
 * repeating the entry title is dropped (the bubble header already shows it), and that
 * the transform is IDEMPOTENT — which is what lets the server clean new rows while the
 * display path cleans rows already stored raw.
 */

import { describe, expect, it } from "bun:test";
import { KNOWLEDGE_EXCERPT_MAX_CHARS, knowledgeExcerpt } from "../knowledge-excerpt";

describe("knowledgeExcerpt — strips block structure to prose", () => {
	it("drops a leading heading's marker instead of swallowing the excerpt into it", () => {
		// The exact shape from the report: heading, blockquote metadata, then content.
		const body = [
			"# PocketJS 在 Kindle PW5 实机部署踩坑",
			"",
			"> 2026-08-10；fork 修复分支：`AndrewZhuCC/pocketjs`",
			"",
			"## 1. fork 情况",
			"- 完整 fork，有 main 分支",
		].join("\n");
		const out = knowledgeExcerpt(body);
		expect(out).not.toContain("#");
		expect(out).not.toContain(">");
		expect(out).not.toContain("`");
		expect(out).not.toContain("- ");
		expect(out).toContain("PocketJS 在 Kindle PW5 实机部署踩坑");
		expect(out).toContain("fork 情况");
		// One line, no structure left to render.
		expect(out).not.toContain("\n");
	});

	it("keeps inline code and link labels as text, dropping the syntax", () => {
		const out = knowledgeExcerpt("see `bun run dev` and [the docs](https://example.com/a/b)");
		expect(out).toBe("see bun run dev and the docs");
	});

	it("unwraps emphasis without eating snake_case identifiers", () => {
		const out = knowledgeExcerpt("**bold** and *em* and ~~gone~~ around ask_in_passing");
		expect(out).toBe("bold and em and gone around ask_in_passing");
	});

	it("skips fenced code blocks entirely, including their content", () => {
		const body = ["intro line", "```ts", "const secret = 1;", "```", "after the fence"].join("\n");
		const out = knowledgeExcerpt(body);
		expect(out).toBe("intro line after the fence");
	});

	it("skips YAML frontmatter so metadata keys are not the excerpt", () => {
		const body = ["---", "title: X", "tags: [a, b]", "---", "the real opening line"].join("\n");
		expect(knowledgeExcerpt(body)).toBe("the real opening line");
	});

	it("treats an unterminated --- as content, not frontmatter", () => {
		const body = ["---", "still prose"].join("\n");
		expect(knowledgeExcerpt(body)).toBe("still prose");
	});

	it("drops thematic breaks and table delimiter rows", () => {
		const body = ["a", "---", "| col | col |", "|-----|:---:|", "| 1 | 2 |", "b"].join("\n");
		const out = knowledgeExcerpt(body);
		expect(out).toContain("a");
		expect(out).toContain("b");
		expect(out).not.toContain("---");
		expect(out).not.toContain(":---:");
	});

	it("strips nested block markers on one line", () => {
		expect(knowledgeExcerpt("> - > 1. deeply nested")).toBe("deeply nested");
	});

	it("survives a pathological blockquote run without hanging", () => {
		const out = knowledgeExcerpt(`${">".repeat(2000)} tail`);
		// The strip loop is bounded, so some markers may remain — what matters is that it
		// terminates and the content is still there.
		expect(out).toContain("tail");
	});
});

describe("knowledgeExcerpt — title de-duplication", () => {
	const body = ["# Rebase policy", "", "Always rebase onto trunk before merging."].join("\n");

	it("drops a first line that merely repeats the entry title", () => {
		expect(knowledgeExcerpt(body, { title: "Rebase policy" })).toBe(
			"Always rebase onto trunk before merging.",
		);
	});

	it("compares loosely (case and whitespace), not byte-for-byte", () => {
		expect(knowledgeExcerpt(body, { title: "  rebase   POLICY " })).toBe(
			"Always rebase onto trunk before merging.",
		);
	});

	it("keeps the line when no title is supplied", () => {
		expect(knowledgeExcerpt(body)).toContain("Rebase policy");
	});

	it("only checks the FIRST surviving line, not every occurrence", () => {
		const repeated = ["# Rebase policy", "", "See Rebase policy for details."].join("\n");
		expect(knowledgeExcerpt(repeated, { title: "Rebase policy" })).toBe(
			"See Rebase policy for details.",
		);
	});
});

describe("knowledgeExcerpt — an ALREADY-flattened excerpt", () => {
	/*
	 * This is the shape actually stored in `summary`: the body went through
	 * `\s+ → " "` before anyone thought about rendering, so every block marker is
	 * stranded mid-line where no line-leading rule can reach it. Rows written before the
	 * server started stripping still hold exactly this.
	 */
	const FLAT =
		"# PocketJS 在 Kindle PW5 实机部署踩坑 > 2026-08-10；fork 分支：`AndrewZhuCC/pocketjs` ## 1. fork 情况 - 完整 fork";

	it("removes mid-line heading and quote markers", () => {
		const out = knowledgeExcerpt(FLAT);
		expect(out).not.toMatch(/(^|\s)#/);
		expect(out).not.toMatch(/(^|\s)>/);
		expect(out).toContain("2026-08-10");
		expect(out).toContain("fork 情况");
	});

	it("drops a title repeated as a PREFIX, not just as its own line", () => {
		const out = knowledgeExcerpt(FLAT, { title: "PocketJS 在 Kindle PW5 实机部署踩坑" });
		expect(out.startsWith("2026-08-10")).toBe(true);
	});

	it("also eats the separator left behind by the dropped title", () => {
		expect(
			knowledgeExcerpt("Rebase policy — always rebase first", { title: "Rebase policy" }),
		).toBe("always rebase first");
		expect(knowledgeExcerpt("Rebase policy: always rebase first", { title: "Rebase policy" })).toBe(
			"always rebase first",
		);
	});

	it("yields EMPTY when the title is all there is, matching the per-line path", () => {
		// Empty is the useful answer: the injection adapter reads it as "no excerpt worth a
		// bubble" and keeps the hit in the compact list, instead of drawing a bubble whose
		// body just repeats its own header.
		expect(knowledgeExcerpt("Rebase policy", { title: "Rebase policy" })).toBe("");
		expect(knowledgeExcerpt("# Rebase policy", { title: "Rebase policy" })).toBe("");
	});

	it("cuts at the right offset when lowercasing changes a character's length", () => {
		/*
		 * The prefix walk advances a SOURCE offset and a NORMALIZED offset together, and
		 * `normalizeLoose` lowercases. `toLowerCase()` is not length-preserving for every
		 * character — Turkish dotted capital İ (U+0130) becomes two code units, "i" plus a
		 * combining dot — so counting source units against the normalized length drifted by
		 * one per such character and cut into the following word.
		 */
		expect(knowledgeExcerpt("İstanbul notes — the real content", { title: "İstanbul notes" })).toBe(
			"the real content",
		);
		// Two of them, so the drift would be two characters rather than one.
		expect(knowledgeExcerpt("İİ notes: body text", { title: "İİ notes" })).toBe("body text");
	});

	it("leaves a title that is only a mid-string substring alone", () => {
		const out = knowledgeExcerpt("see Rebase policy below", { title: "Rebase policy" });
		expect(out).toBe("see Rebase policy below");
	});

	it("does NOT strip mid-line list markers, which are usually prose", () => {
		// `- ` and `1. ` mid-sentence are punctuation far more often than flattened
		// structure, and they render as plain characters anyway.
		const out = knowledgeExcerpt("a range 3 - 5 and step 1. do it");
		expect(out).toBe("a range 3 - 5 and step 1. do it");
	});

	it("leaves mid-line markers alone in a MULTI-line body", () => {
		// A real body has its structure at line starts; the looser rule is only needed for
		// text that lost its newlines, and applying it everywhere would damage prose.
		const out = knowledgeExcerpt("intro\nis 5 > 3 true");
		expect(out).toBe("intro is 5 > 3 true");
	});
});

describe("knowledgeExcerpt — bounds and idempotence", () => {
	it("caps at maxChars with an ellipsis", () => {
		const out = knowledgeExcerpt("x".repeat(1000), { maxChars: 20 });
		expect(out).toBe(`${"x".repeat(20)}…`);
	});

	it("defaults to KNOWLEDGE_EXCERPT_MAX_CHARS", () => {
		const out = knowledgeExcerpt("y".repeat(5000));
		expect(out.length).toBe(KNOWLEDGE_EXCERPT_MAX_CHARS + 1); // + the ellipsis
	});

	it("does not ellipsize text that fits", () => {
		expect(knowledgeExcerpt("short enough")).toBe("short enough");
	});

	/*
	 * The cut is by UTF-16 code unit, which is what `maxChars` promises — but an astral
	 * character occupies TWO units, so a naive `slice` can land between the halves of a
	 * surrogate pair and leave a lone surrogate. A lone surrogate is not a character: it
	 * paints as U+FFFD and survives JSON as an unpaired escape, so it reaches the stored
	 * excerpt rather than just one render. These pin that the boundary is respected for
	 * emoji and for the CJK extension blocks that appear in real entries.
	 */
	const hasLoneSurrogate = (s: string): boolean => {
		for (let i = 0; i < s.length; i++) {
			const code = s.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = s.charCodeAt(i + 1);
				if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
				i++;
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				return true;
			}
		}
		return false;
	};

	it("never cuts an emoji in half", () => {
		// maxChars 5 lands mid-pair: "ab" + 🎉(2) + 🎉 → the cut falls between the second
		// emoji's high and low halves.
		const out = knowledgeExcerpt("ab🎉🎉🎉tail", { maxChars: 5 });
		expect(hasLoneSurrogate(out)).toBe(false);
		expect(out).toBe("ab🎉…");
		// The cap is a ceiling, so dropping the orphaned half is the right direction.
		expect(out.length).toBeLessThanOrEqual(6); // 5 + the ellipsis
	});

	it("never cuts an astral CJK character in half", () => {
		// 𠮟 (U+20B9F) and 𩸽 (U+29E3D) are two code units each, exactly like an emoji.
		const out = knowledgeExcerpt("𠮟𩸽𠮟𩸽", { maxChars: 3 });
		expect(hasLoneSurrogate(out)).toBe(false);
		expect(out).toBe("𠮟…");
	});

	it("keeps a pair that ends exactly at the cap", () => {
		// The complementary case: an even cut is already on a boundary and must not lose a
		// character to over-cautious backtracking.
		const out = knowledgeExcerpt("🎉🎉🎉", { maxChars: 4 });
		expect(out).toBe("🎉🎉…");
	});

	it("leaves BMP text unaffected by the surrogate-safe cut", () => {
		// Regression guard: the boundary check must not shift ordinary cuts by one.
		expect(knowledgeExcerpt("abcdefgh", { maxChars: 4 })).toBe("abcd…");
		expect(knowledgeExcerpt("中文测试内容", { maxChars: 3 })).toBe("中文测…");
	});

	it("is idempotent — the display path may re-run it over a stored excerpt", () => {
		// This is the property that lets the server clean NEW rows while the reader-facing
		// projection cleans rows ALREADY stored with raw Markdown, without the two fighting.
		const body = ["# Title", "> quoted `code` and [link](http://x)", "- bullet"].join("\n");
		const once = knowledgeExcerpt(body);
		expect(knowledgeExcerpt(once)).toBe(once);
	});

	it("returns empty for empty or structure-only input", () => {
		expect(knowledgeExcerpt("")).toBe("");
		expect(knowledgeExcerpt("   \n\n  ")).toBe("");
		expect(knowledgeExcerpt("```\nonly code\n```")).toBe("");
		expect(knowledgeExcerpt("---\n---")).toBe("");
	});
});
