/**
 * Three-parser consistency. The repository parses markdown with marked@18 (the dialect's
 * reference, `shared/pretext-layout`), marked@17 (`@tiptap/markdown`, SpecMarkdownEditor) and
 * micromark (react-markdown + remark-gfm, read-only display). The dialect only uses the subset
 * all three read the same way: for random dialect bodies, the serializer's output must project
 * to the same blocks, text, marks, links and table cells under all three.
 *
 * Disagreements found while building this, and how the serializer avoids each (the regression
 * cases below pin them):
 * - Leading whitespace of a line: marked keeps it, CommonMark strips it → written as `&#32;`.
 * - GFM bare URLs (`http://`, `www.`) and emails run raw up to whitespace in marked@17 and
 *   micromark, swallowing escapes, delimiters and `[[…]]` → a mention after a URL gets a space
 *   (design rule); otherwise a non-plain run is broken with `http\://`, `www\.` or `\@`.
 * - Closing `*` directly followed by opening `*` (`*b***\`c\`**`, `***a****b*`): marked is more
 *   lenient than CommonMark's flanking rules → marks nest by extent, and the remaining
 *   junctions spell the openers with `_`.
 * - `[[x]](…)` is an inline link to parsers without mentions → `(` after a mention is escaped.
 * - `<!x` / `<x` inside link text closed by the `>` of a `<…>` destination is inline HTML to
 *   micromark → tag-like `<` is escaped whenever a `>` follows anywhere or a link is present.
 * Nothing found was left unfixed. `$…$` math is not compared: remark-math is not part of these
 * three parsers, and the serializer always escapes `$` anyway.
 */
import { describe, expect, test } from "bun:test";
import { type Body, type Inline, serializeBody } from "../dialect";
import { FUZZ_TIMEOUT_MS, fuzzCount, randomBody, realisticParagraph, rng } from "./fuzz.fixture";
import {
	marked17Version,
	projectDialect,
	projectMarked17,
	projectMicromark,
} from "./parsers.fixture";

interface Disagreement {
	src: string;
	parser: "marked@17" | "micromark";
}

function check(src: string, out: Disagreement[]): void {
	const want = JSON.stringify(projectDialect(src));
	if (JSON.stringify(projectMarked17(src)) !== want) out.push({ src, parser: "marked@17" });
	if (JSON.stringify(projectMicromark(src)) !== want) out.push({ src, parser: "micromark" });
}

function agree(src: string): void {
	const out: Disagreement[] = [];
	check(src, out);
	expect(out).toEqual([]);
}

const text = (t: string, ...marks: Array<"strong" | "em" | "strike" | "code">): Inline => ({
	type: "text",
	text: t,
	marks: marks.map((type) => ({ type })),
});
const mention = (ref: string): Inline => ({ type: "mention", ref, label: null, marks: [] });
const para = (...content: Inline[]): Body => ({ type: "paragraph", content });

describe("parsers under comparison", () => {
	test("marked@17 is the copy @tiptap/markdown resolves", () => {
		// If @tiptap/markdown moves to another marked major, revisit which parsers matter.
		expect(marked17Version.split(".")[0]).toBe("17");
	});
});

describe("regressions: each disagreement class stays fixed", () => {
	const cases: Array<[string, Body, string]> = [
		[
			"leading whitespace becomes a character reference",
			para(text("  缩进\n\t第二行")),
			"&#32; 缩进\n&#9;第二行",
		],
		[
			"a mention right after a bare URL is separated by a space",
			para(text("见 https://e.x/a"), mention("P1/b2")),
			"见 https://e.x/a [[P1/b2]]",
		],
		[
			"a bare URL containing an escaped character is broken at its colon",
			para(text("https://e.x/a*b")),
			"https\\://e.x/a\\*b",
		],
		[
			"a bare URL running into a mark is broken",
			para(text("www.e.x"), text("粗", "strong")),
			"www\\.e.x**粗**",
		],
		[
			"a bold URL followed by space stays plain (trailing `**` is GFM trailing punctuation)",
			para(text("https://e.x/a", "strong"), text(" 后")),
			"**https://e.x/a** 后",
		],
		[
			"an email touching a mark boundary is broken at its @",
			para(text("me@e.x", "strong")),
			"**me\\@e.x**",
		],
		[
			"closing `*` then opening `**` before punctuation is respelled with `__`",
			para(text("b", "em"), text("c", "strong", "code")),
			"*b*__`c`__",
		],
		[
			"crossing bold and italics do not produce `***a****b*`",
			para(text("x", "strong"), text("a", "strong", "em"), text("b", "em")),
			"**x*a***_b_",
		],
		["`(` right after a mention is escaped", para(mention("x"), text("(y)")), "[[x]]\\(y)"],
		[
			"tag-like `<` inside link text is escaped when the destination uses `<…>`",
			para({ type: "text", text: "<!b", marks: [{ type: "link", href: "https://e.x/a b" }] }),
			"[\\<!b](<https://e.x/a b>)",
		],
	];
	for (const [name, body, want] of cases) {
		test(name, () => {
			const src = serializeBody(body);
			expect(src).toBe(want);
			agree(src);
		});
	}
});

describe("random dialect bodies read the same in all three parsers", () => {
	function fuzz(seed: number, n: number, gen: (r: () => number) => Body): Disagreement[] {
		const r = rng(seed);
		const out: Disagreement[] = [];
		for (let i = 0; i < n && out.length < 5; i++) check(serializeBody(gen(r)), out);
		return out;
	}

	test(
		"adversarial alphabet",
		() => {
			expect(fuzz(5, fuzzCount(1200), randomBody)).toEqual([]);
		},
		FUZZ_TIMEOUT_MS,
	);

	test(
		"realistic mixed Chinese/English prose",
		() => {
			expect(fuzz(21, fuzzCount(400), realisticParagraph)).toEqual([]);
		},
		FUZZ_TIMEOUT_MS,
	);
});
