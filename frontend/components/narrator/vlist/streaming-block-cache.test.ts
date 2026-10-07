/**
 * streaming-block-cache.test.ts
 *
 * The load-bearing property: the blocks returned for a streaming body must be
 * byte-identical to a full parse of that same body, at EVERY prefix. Earlier content
 * must never change or disappear as the stream continues.
 *
 * This suite exists because the first implementation violated exactly that. It froze
 * the prepared blocks before the last blank line and re-parsed only the tail — but a
 * blank line is not a markdown block boundary. Inside a fenced code block it is
 * ordinary content, so the freeze tore one code block into several permanently and the
 * reader watched earlier output mutate. The fixtures below are the shapes that exposed
 * it, walked character by character.
 *
 * The current implementation takes its boundaries from `marked.lexer` (correct by
 * definition) and memoises preparation per top-level token, so it is incremental
 * WITHOUT approximating.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const WIDTH = 800;

async function load() {
	const [{ measureMarkdown }, cache, parser, { markdownMathSupport }] = await Promise.all([
		import("./measure/measure-markdown"),
		import("./streaming-block-cache"),
		import("@shared/pretext-layout/parse-markdown"),
		import("./measure/math-support"),
	]);
	return { measureMarkdown, ...cache, ...parser, markdownMathSupport };
}

/**
 * Structures whose parse depends on text that arrives LATER — the cases no
 * offset-guessing scheme can handle.
 */
const FIXTURES: Record<string, string> = {
	"CJK emphasis source offsets":
		"**注意：**说明 **结果：**说明 **结论：**说明\n\n第二段完整内容\n\n第三段内容继续",
	"emphasis with CRLF": "**注意：**说明\r\n\r\n第二段完整内容\r\n\r\n第三段内容继续",
	"protected code and URL":
		"**注意：**说明\n\n``**代码：**原样``\n\n[x](https://example.com/?q=**注意：**说明)\n\n尾段",
	"plain paragraphs": Array.from({ length: 6 }, (_, i) => `段落${i} ${"词".repeat(60)}`).join(
		"\n\n",
	),
	// A blank line INSIDE a fence: the case that broke the original implementation.
	"code containing a blank line": "说明文本\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n结尾",
	"code containing two blank lines":
		"前言\n\n```py\ndef f():\n    pass\n\n\ndef g():\n    pass\n```\n\n后记",
	"unterminated fence": "开始\n\n```ts\nconst a = 1;\nconst b = 2;",
	"back-to-back code": "```js\nlet x=1;\n```\n\n中间说明\n\n```py\nprint(1)\n```\n\n结尾",
	// A blank line between items makes the list loose, re-spacing earlier items.
	"loose list": "说明：\n\n- 第一项\n\n- 第二项\n\n- 第三项\n\n结论",
	"tight becoming loose": "说明：\n\n- 第一项\n- 第二项\n\n- 第三项\n\n结论",
	"nested loose list": "列表：\n\n- 外层\n\n  - 内层\n\n- 外层2\n\n完",
	"indented code": "示例：\n\n    line1\n\n    line2\n\n结束",
	headings: "# 标题一\n\n正文内容一\n\n## 标题二\n\n正文内容二\n\n#### 标题四\n\n正文四",
	"setext headings": "标题\n====\n\n正文\n\n小标题\n----\n\n结尾",
	"bullet list": "说明如下：\n\n- 第一项内容\n- 第二项内容\n- 第三项内容\n\n结论段落",
	table: "数据：\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n表后文字",
	blockquote: "引用：\n\n> 被引用的内容\n>\n> 第二段引用\n\n引用之后",
	"horizontal rule": "上半部分\n\n---\n\n下半部分内容",
	"forward link definition":
		"[链接][target]\n\n第二段\n\n第三段\n\n第四段\n\n[target]: https://example.com",
	"backward link definition":
		"[target]: https://example.com\n\n首段\n\n第二段\n\n第三段\n\n[链接][target]",
	math: "公式：\n\n$$a^2+b^2=c^2$$\n\n之后 $x$ 行内",
	mixed: [
		"# 报告",
		`概述段落${"词".repeat(40)}`,
		"```ts\nconst x = 1;\n\nconst y = 2;\n```",
		"- 项目一\n\n- 项目二",
		"| A | B |\n|---|---|\n| 1 | 2 |",
		"> 注意事项",
		`结论${"词".repeat(30)}`,
	].join("\n\n"),
};

describe("getStreamingPreparedBlocks — byte-exact at every prefix", () => {
	for (const [name, text] of Object.entries(FIXTURES)) {
		it(`matches a full parse while streaming: ${name}`, async () => {
			const {
				measureMarkdown,
				getStreamingPreparedBlocks,
				resetStreamingBlockCache,
				parseMarkdownToPreparedBlocks,
				markdownMathSupport,
			} = await load();
			const key = `exact-${name}`;
			resetStreamingBlockCache(key);
			const mismatches: string[] = [];
			for (let end = 1; end <= text.length; end++) {
				const prefix = text.slice(0, end);
				const blocks = getStreamingPreparedBlocks(key, prefix);
				// Height equality misses dropped characters on the same line. Compare
				// the complete prepared tree, including segments, marks, hrefs and math.
				expect(blocks, `${name}: prefix ${end}`).toEqual(
					parseMarkdownToPreparedBlocks(prefix, markdownMathSupport()),
				);
				const viaCache = measureMarkdown(prefix, WIDTH, { preparedBlocks: blocks }).height;
				const viaFullParse = measureMarkdown(prefix, WIDTH).height;
				if (Math.abs(viaCache - viaFullParse) > 0.001) {
					mismatches.push(`len=${end} cache=${viaCache} full=${viaFullParse}`);
				}
			}
			expect(mismatches).toEqual([]);
		});
	}
});

describe("source offsets survive Markdown preprocessing", () => {
	it("does not drop the first character of the second block on a two-frame append", async () => {
		const {
			getStreamingPreparedBlocks,
			resetStreamingBlockCache,
			parseMarkdownToPreparedBlocks,
			parseMarkdownUnits,
		} = await load();
		const source = "**注意：**说明 **结果：**说明 **结论：**说明\n\n第二段完整内容\n\n第三段内容";
		resetStreamingBlockCache("emphasis-two-frames");
		expect(getStreamingPreparedBlocks("emphasis-two-frames", source)).toEqual(
			parseMarkdownToPreparedBlocks(source),
		);
		const next = getStreamingPreparedBlocks("emphasis-two-frames", `${source}继续`);
		expect(next).toEqual(parseMarkdownToPreparedBlocks(`${source}继续`));
		const second = next[1];
		expect(second?.kind).toBe("inline");
		if (second?.kind === "inline") {
			// Pretext's public handle is opaque; inspect the text payload for this
			// regression, not just its line count or resulting height.
			const flow = second.flow as unknown as { items: { prepared: { segments: string[] } }[] };
			expect(flow.items[0]?.prepared.segments.join("")).toBe("第二段完整内容");
		}
		const units = parseMarkdownUnits(source);
		expect(units[0]?.raw).toBe(source.split("\n\n")[0] as string);
		expect(source.slice(units[0]?.consumedLength)).toBe("\n\n第二段完整内容\n\n第三段内容");
	});

	it("maps normalized/trimmed math to original offsets and original memo keys", async () => {
		const runtime = await import("./katex-runtime");
		await runtime.ensureKatexLoaded("$a$");
		const {
			getStreamingPreparedBlocks,
			resetStreamingBlockCache,
			parseMarkdownToPreparedBlocks,
			parseMarkdownUnits,
			markdownMathSupport,
		} = await load();
		try {
			const math = markdownMathSupport();
			expect(math).toBeDefined();
			for (const formula of [
				"$long_variable + 1$",
				"\\(x + 1\\)",
				"$$  x + 1  $$",
				"\\[\n x + 1 \n\\]",
			]) {
				const first = `**注意：**说明 ${formula}`;
				const source = `${first}\n\n第二段 $y$ 完整内容\n\n第三段 $z$ 内容\n\n第四段继续`;
				const units = parseMarkdownUnits(source, math);
				expect(units[0]?.raw).toBe(first);
				expect(units[0]?.consumedLength).toBe(first.length);
				resetStreamingBlockCache("math-offsets");
				for (let end = 1; end <= source.length; end++) {
					const prefix = source.slice(0, end);
					expect(getStreamingPreparedBlocks("math-offsets", prefix), `${formula}: ${end}`).toEqual(
						parseMarkdownToPreparedBlocks(prefix, math),
					);
				}
				resetStreamingBlockCache("math-two-frames");
				getStreamingPreparedBlocks("math-two-frames", source);
				expect(getStreamingPreparedBlocks("math-two-frames", `${source}新增`)).toEqual(
					parseMarkdownToPreparedBlocks(`${source}新增`, math),
				);
			}
			// Different formulas can both lift to E0000E001. Raw source must not
			// collide in the unit memo when those units become the live tail.
			const a = parseMarkdownUnits("$alpha$", math)[0];
			const b = parseMarkdownUnits("$beta$", math, {
				reuse: (raw) => (raw === a?.raw ? a.blocks : undefined),
			})[0];
			expect(b?.blocks).toEqual(parseMarkdownToPreparedBlocks("$beta$", math));
		} finally {
			runtime.resetKatexRuntimeForTest();
			resetStreamingBlockCache();
		}
	});
});

describe("getStreamingPreparedBlocks — reuse actually happens", () => {
	it("reuses the prepared blocks of settled tokens across frames", async () => {
		const { getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		resetStreamingBlockCache("reuse");
		const settled = "第一段内容\n\n第二段内容\n\n第三段内容\n\n";
		const first = getStreamingPreparedBlocks("reuse", `${settled}第四段`);
		const second = getStreamingPreparedBlocks("reuse", `${settled}第四段更长了一些`);
		// The leading block objects are the SAME references — that identity is the
		// mechanism the optimisation rests on.
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
	});

	it("keeps per-frame cost flat as the body grows", async () => {
		const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		const text = Array.from({ length: 70 }, (_, i) => `段落 ${i}：${"词".repeat(90)}`).join("\n\n");
		const sample = (label: string, from: number, to: number): number => {
			resetStreamingBlockCache(label);
			for (let end = 1; end <= from; end += 40) {
				getStreamingPreparedBlocks(label, text.slice(0, end));
			}
			const samples: number[] = [];
			for (let end = from; end <= to; end += 40) {
				const prefix = text.slice(0, end);
				const started = performance.now();
				measureMarkdown(prefix, WIDTH, {
					preparedBlocks: getStreamingPreparedBlocks(label, prefix),
				});
				samples.push(performance.now() - started);
			}
			samples.sort((left, right) => left - right);
			return samples[Math.floor(samples.length / 2)] ?? 0;
		};
		const early = sample("early", 40, 1200);
		const late = sample("late", text.length - 1200, text.length);
		// A late frame carries ~5x more accumulated text; re-preparing all of it would
		// scale with that. Reuse keeps the marginal cost roughly constant.
		expect(late).toBeLessThan(Math.max(early, 0.05) * 4);
	});
});

describe("StreamingBlockCache — bounded pane-local retention", () => {
	it("retains only the current raw tail through 600 growing-paragraph frames", async () => {
		const { StreamingBlockCache, parseMarkdownToPreparedBlocks, markdownMathSupport } =
			await load();
		const cache = new StreamingBlockCache();
		let text = "";
		for (let frame = 0; frame < 600; frame++) {
			text += "长段落增长内容 ";
			const blocks = cache.get("live", text);
			if (frame % 100 === 0 || frame === 599) {
				expect(blocks).toEqual(parseMarkdownToPreparedBlocks(text, markdownMathSupport()));
			}
			expect(cache.getStats()).toMatchObject({
				entries: 1,
				memoUnits: 1,
				memoSourceChars: text.length,
				retainedSourceChars: text.length,
				retainedUnits: 1,
			});
		}
	}, 30_000);

	it("retains settled blocks but memoizes only the two current live units", async () => {
		const { StreamingBlockCache, parseMarkdownUnits } = await load();
		const cache = new StreamingBlockCache();
		let text = "";
		for (let frame = 0; frame < 90; frame++) {
			text += `段落 ${frame}\n\n`;
			cache.get("live", text);
			const units = parseMarkdownUnits(text);
			expect(cache.getStats()).toMatchObject({
				memoUnits: Math.min(2, units.length),
				memoSourceChars: units.slice(-2).reduce((sum, unit) => sum + unit.raw.length, 0),
				retainedUnits: units.length,
			});
			expect(cache.getStats().retainedSourceChars).toBeLessThanOrEqual(text.length);
		}
	});

	it("isolates same-key reuse, clear and build pruning across pane instances", async () => {
		const { StreamingBlockCache } = await load();
		const a = new StreamingBlockCache();
		const b = new StreamingBlockCache();
		const text = "开头\n\n中间\n\n末段";
		const aFirst = a.get("same", text);
		const bFirst = b.get("same", text);
		expect(aFirst[0]).not.toBe(bFirst[0]);
		expect(a.get("same", text)[0]).toBe(aFirst[0]);
		expect(b.get("same", text)[0]).toBe(bFirst[0]);
		a.get("unused", "unused");
		a.beginBuild();
		a.get("same", text);
		a.endBuild();
		expect(a.size).toBe(1);
		expect(b.size).toBe(1);
		a.clear("same");
		expect(a.size).toBe(0);
		expect(b.get("same", text)[0]).toBe(bFirst[0]);
		a.get("same", text);
		a.clear();
		expect(b.size).toBe(1);
		b.beginBuild();
		b.endBuild();
		expect(b.size).toBe(0);
	});

	it("keeps rows across reads outside a build and safely ignores an unmatched end", async () => {
		const { StreamingBlockCache } = await load();
		const cache = new StreamingBlockCache();
		cache.get("a", "first");
		cache.get("b", "second");
		cache.endBuild();
		cache.get("a", "first");
		expect(cache.size).toBe(2);
	});

	it("bounds entries and aggregate source/units while oversized rows remain exact", async () => {
		const { StreamingBlockCache, parseMarkdownToPreparedBlocks, markdownMathSupport } =
			await load();
		for (const options of [{ maxEntries: 0 }, { maxSourceChars: 10 }, { maxUnits: 2 }]) {
			const cache = new StreamingBlockCache(options);
			cache.get("large", "short");
			const text = "第一段\n\n第二段\n\n第三段\n\n第四段";
			expect(cache.get("large", text)).toEqual(
				parseMarkdownToPreparedBlocks(text, markdownMathSupport()),
			);
			expect(cache.getStats()).toMatchObject({
				entries: 0,
				memoUnits: 0,
				retainedUnits: 0,
				retainedSourceChars: 0,
			});
		}
		const cache = new StreamingBlockCache({ maxEntries: 2, maxSourceChars: 15, maxUnits: 3 });
		const a = cache.get("a", "first");
		cache.get("b", "second");
		expect(cache.get("a", "first")[0]).toBe(a[0]);
		cache.get("c", "third");
		expect(cache.size).toBe(2);
		expect(cache.getStats().retainedSourceChars).toBeLessThanOrEqual(15);
		expect(cache.get("a", "first")[0]).toBe(a[0]);
		for (let i = 0; i < 10; i++) cache.get(`row-${i}`, "字\n\n字");
		expect(cache.getStats().retainedUnits).toBeLessThanOrEqual(3);
		expect(cache.getStats().retainedSourceChars).toBeLessThanOrEqual(15);
	});

	it("accounts for exactly one current full source including whitespace and replacements", async () => {
		const { StreamingBlockCache, parseMarkdownToPreparedBlocks, markdownMathSupport } =
			await load();
		const cache = new StreamingBlockCache({ maxSourceChars: 24 });
		const initial = "abc\n\nsecond\n\nthird\n\n";
		cache.get("same", initial);
		expect(cache.getStats().retainedSourceChars).toBe(initial.length);
		cache.get("same", "abcDEF");
		expect(cache.getStats().retainedSourceChars).toBe(6);
		const padded = "\n\nother\n\n";
		cache.get("other", padded);
		expect(cache.getStats().retainedSourceChars).toBe(6 + padded.length);
		const oversized = `${"abcDEF"}${"x".repeat(25)}`;
		expect(cache.get("same", oversized)).toEqual(
			parseMarkdownToPreparedBlocks(oversized, markdownMathSupport()),
		);
		expect(cache.getStats().retainedSourceChars).toBe(padded.length);
		expect(cache.size).toBe(1);
	});

	it("enforces default row and source ceilings", async () => {
		const { StreamingBlockCache, parseMarkdownToPreparedBlocks, markdownMathSupport } =
			await load();
		const cache = new StreamingBlockCache();
		for (let i = 0; i < 80; i++) cache.get(`row-${i}`, "small");
		expect(cache.size).toBe(64);
		const oversized = "x".repeat(256 * 1024 + 1);
		expect(cache.get("oversized", oversized)).toEqual(
			parseMarkdownToPreparedBlocks(oversized, markdownMathSupport()),
		);
		expect(cache.size).toBe(64);
		expect(cache.getStats().retainedSourceChars).toBeLessThanOrEqual(256 * 1024);
	});

	it("invalidates all rows on font and typography revisions, including settled blocks", async () => {
		const { StreamingBlockCache, parseMarkdownToPreparedBlocks, markdownMathSupport } =
			await load();
		const fonts = await import("@shared/pretext-layout/prepared-markdown-cache");
		const typography = await import("@shared/pretext-layout/typography");
		const oldFont = fonts.getPreparedFontRevision();
		const oldTypography = { ...typography.getTypography() };
		const cache = new StreamingBlockCache();
		const text = "# 标题\n\n第二段\n\n第三段\n\n第四段";
		try {
			for (const invalidate of [
				() => fonts.setPreparedFontRevision(oldFont + 1),
				() => typography.setTypography({ fontScalePercent: oldTypography.fontScalePercent + 1 }),
			]) {
				const beforeA = cache.get("a", text);
				const beforeB = cache.get("b", text);
				invalidate();
				const afterA = cache.get("a", text);
				const afterB = cache.get("b", text);
				expect(afterA[0]).not.toBe(beforeA[0]);
				expect(afterB[0]).not.toBe(beforeB[0]);
				expect(afterA).toEqual(parseMarkdownToPreparedBlocks(text, markdownMathSupport()));
				expect(afterB).toEqual(parseMarkdownToPreparedBlocks(text, markdownMathSupport()));
			}
		} finally {
			fonts.setPreparedFontRevision(oldFont);
			typography.setTypography(oldTypography);
		}
	});
});

describe("getStreamingPreparedBlocks — cache lifecycle", () => {
	for (const [name, before, after] of [
		["retry shares a settled prefix", "abc\n\nsecond\n\nthird", "abcDEF"],
		["translation replaces the same key", "原文\n\n第二段\n\n第三段", "原文的翻译结果"],
		[
			"retry is longer but not append-only",
			"abc\n\nsecond\n\nthird",
			"abc rewritten as a much longer single paragraph",
		],
		["tail truncation to a settled boundary", "abc\n\nsecond\n\nthird", "abc"],
		["tail truncation inside a live block", "abc\n\nsecond\n\nthird", "abc\n\nsec"],
	] as const) {
		it(`matches a cold full parse after ${name}`, async () => {
			const { StreamingBlockCache, parseMarkdownToPreparedBlocks, markdownMathSupport } =
				await load();
			const hot = new StreamingBlockCache();
			const cold = new StreamingBlockCache();
			hot.get("same-key", before);
			const actual = hot.get("same-key", after);
			expect(actual).toEqual(cold.get("same-key", after));
			expect(actual).toEqual(parseMarkdownToPreparedBlocks(after, markdownMathSupport()));
			// A later append must continue from the replacement, never the older source.
			expect(hot.get("same-key", `${after}新增`)).toEqual(
				parseMarkdownToPreparedBlocks(`${after}新增`, markdownMathSupport()),
			);
		});
	}

	it("rebuilds when the text is front-truncated (not an append-only extension)", async () => {
		const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		resetStreamingBlockCache("truncate");
		getStreamingPreparedBlocks("truncate", "开头段落\n\n中间段落\n\n结尾段落");
		// appendStreamingTextPreview drops from the FRONT past its 120k cap, so the new
		// text is not a prefix extension and the settled boundary is void.
		const truncated = "间段落\n\n结尾段落扩展";
		expect(
			measureMarkdown(truncated, WIDTH, {
				preparedBlocks: getStreamingPreparedBlocks("truncate", truncated),
			}).height,
		).toBeCloseTo(measureMarkdown(truncated, WIDTH).height, 5);
	});

	it("handles a body rewritten from scratch under the same key (a retry)", async () => {
		const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		resetStreamingBlockCache("retry");
		getStreamingPreparedBlocks("retry", "第一次尝试的内容\n\n第二段落");
		const rewritten = "# 完全不同的标题\n\n新的正文内容";
		expect(
			measureMarkdown(rewritten, WIDTH, {
				preparedBlocks: getStreamingPreparedBlocks("retry", rewritten),
			}).height,
		).toBeCloseTo(measureMarkdown(rewritten, WIDTH).height, 5);
	});

	it("keeps separate rows isolated", async () => {
		const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		resetStreamingBlockCache();
		const a = "行A第一段\n\n行A第二段";
		const b = "# 行B标题\n\n行B正文";
		getStreamingPreparedBlocks("row-a", a);
		getStreamingPreparedBlocks("row-b", b);
		// Interleaved growth must not let one row's units leak into the other.
		expect(
			measureMarkdown(`${a}扩展`, WIDTH, {
				preparedBlocks: getStreamingPreparedBlocks("row-a", `${a}扩展`),
			}).height,
		).toBeCloseTo(measureMarkdown(`${a}扩展`, WIDTH).height, 5);
		expect(
			measureMarkdown(`${b}扩展`, WIDTH, {
				preparedBlocks: getStreamingPreparedBlocks("row-b", `${b}扩展`),
			}).height,
		).toBeCloseTo(measureMarkdown(`${b}扩展`, WIDTH).height, 5);
	});

	it("stores one entry per row and releases it on reset", async () => {
		const { getStreamingPreparedBlocks, resetStreamingBlockCache, streamingBlockCacheSize } =
			await load();
		resetStreamingBlockCache();
		const text = Array.from({ length: 12 }, (_, i) => `段落${i} ${"词".repeat(30)}`).join("\n\n");
		for (let end = 1; end <= text.length; end += 7) {
			getStreamingPreparedBlocks("growth", text.slice(0, end));
		}
		expect(streamingBlockCacheSize()).toBe(1);
		resetStreamingBlockCache("growth");
		expect(streamingBlockCacheSize()).toBe(0);
	});

	it("returns no blocks for empty text and caches nothing", async () => {
		const { getStreamingPreparedBlocks, resetStreamingBlockCache, streamingBlockCacheSize } =
			await load();
		resetStreamingBlockCache();
		expect(getStreamingPreparedBlocks("empty", "")).toEqual([]);
		expect(streamingBlockCacheSize()).toBe(0);
	});

	/**
	 * The KaTeX runtime arrives asynchronously, so a streaming body can SETTLE while
	 * formulas are still literal text. This cache keeps its own settled blocks (it does
	 * not go through prepared-markdown-cache, whose key already carries the revision),
	 * so without tracking the revision itself it kept serving those text-only blocks
	 * after the runtime landed — formulas stayed as raw `$…$` until a page reload.
	 */
	it("re-prepares settled blocks when the KaTeX revision changes", async () => {
		const { getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		const runtime = await import("./katex-runtime");
		runtime.resetKatexRuntimeForTest();
		resetStreamingBlockCache("math-rev");

		// Settle several blocks BEFORE the runtime exists, ending with display math.
		// LIVE_TAIL_TOKENS keeps the last two units unsettled, so the trailing prose
		// is what pushes the formula into the settled prefix.
		const text = "开头段落\n\n$$a^2+b^2=c^2$$\n\n中间段落\n\n结尾段落\n\n补充段落\n";
		const before = getStreamingPreparedBlocks("math-rev", text);
		expect(before.some((block) => block.kind === "unknown" && block.tag === "katex")).toBe(false);

		await runtime.ensureKatexLoaded("$a$");
		expect(runtime.isKatexReady()).toBe(true);

		// Same text, same key: the entry is reusable by prefix, so only the revision
		// check can force the re-preparation that turns the formula into a katex block.
		const after = getStreamingPreparedBlocks("math-rev", text);
		expect(after.some((block) => block.kind === "unknown" && block.tag === "katex")).toBe(true);

		runtime.resetKatexRuntimeForTest();
		resetStreamingBlockCache("math-rev");
	});

	it("stays correct after the retained-unit budget falls back to uncached preparation", async () => {
		const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		resetStreamingBlockCache("evict");
		// Beyond the default 512 retained units, no streaming entry is kept; every
		// subsequent result must still contain the complete prepared document.
		let text = "";
		for (let index = 0; index < 700; index++) {
			text += `段落 ${index}\n\n`;
			if (index % 97 === 0) {
				expect(
					measureMarkdown(text, WIDTH, {
						preparedBlocks: getStreamingPreparedBlocks("evict", text),
					}).height,
				).toBeCloseTo(measureMarkdown(text, WIDTH).height, 5);
			} else {
				getStreamingPreparedBlocks("evict", text);
			}
		}
		expect(
			measureMarkdown(text, WIDTH, {
				preparedBlocks: getStreamingPreparedBlocks("evict", text),
			}).height,
		).toBeCloseTo(measureMarkdown(text, WIDTH).height, 5);
	}, 30_000);
});
