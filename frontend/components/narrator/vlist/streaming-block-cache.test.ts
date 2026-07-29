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
	const [{ measureMarkdown }, cache] = await Promise.all([
		import("./measure/measure-markdown"),
		import("./streaming-block-cache"),
	]);
	return { measureMarkdown, ...cache };
}

/**
 * Structures whose parse depends on text that arrives LATER — the cases no
 * offset-guessing scheme can handle.
 */
const FIXTURES: Record<string, string> = {
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
			const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } =
				await load();
			const key = `exact-${name}`;
			resetStreamingBlockCache(key);
			const mismatches: string[] = [];
			for (let end = 1; end <= text.length; end++) {
				const prefix = text.slice(0, end);
				const viaCache = measureMarkdown(prefix, WIDTH, {
					preparedBlocks: getStreamingPreparedBlocks(key, prefix),
				}).height;
				const viaFullParse = measureMarkdown(prefix, WIDTH).height;
				if (Math.abs(viaCache - viaFullParse) > 0.001) {
					mismatches.push(`len=${end} cache=${viaCache} full=${viaFullParse}`);
				}
			}
			expect(mismatches).toEqual([]);
		});
	}
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

describe("getStreamingPreparedBlocks — cache lifecycle", () => {
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

	it("stays correct after the unit memo is evicted by its cap", async () => {
		const { measureMarkdown, getStreamingPreparedBlocks, resetStreamingBlockCache } = await load();
		resetStreamingBlockCache("evict");
		// Enough distinct blocks to push past MAX_UNITS_PER_ROW, so the wholesale-clear
		// fallback path is exercised mid-stream.
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
	});
});
