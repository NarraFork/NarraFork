/**
 * reasoning-segments-cache.test.ts — The incremental reasoning parser must be
 * EXACT, not an approximation.
 *
 * The equivalence-at-every-prefix suite is the real contract: a cache that shadows a
 * parser is only safe if it returns byte-identical results at every intermediate
 * state a stream can pass through. A "mostly right" incremental parser would show up
 * as reasoning rows that change or disappear as the model keeps writing — the exact
 * failure mode `streaming-block-cache.ts` documents for its own earlier guesswork.
 */

import { describe, expect, it } from "bun:test";
import { parseReasoningSegments } from "./reasoning-segments";
import {
	parseStreamingReasoningSegments,
	parseStreamingReasoningTitles,
	resetStreamingReasoningCache,
	streamingReasoningCacheSize,
} from "./reasoning-segments-cache";

/**
 * Shapes a reasoning stream actually produces. Titles, empty placeholders, untitled
 * leading prose, `**Result:** inline` (which must NOT count as a title), CRLF, and
 * blank lines carrying trailing whitespace are all parser edge cases.
 */
const FIXTURES: Record<string, string> = {
	"single titled step": "**分析折叠逻辑**\n\n检查图标位置是否稳定。",
	"several titled steps":
		"**第一步**\n\n读取渲染单元。\n\n**第二步**\n\n确认交接行为。\n\n**第三步**\n\n补充测试。",
	"leading untitled prose": "先看一下现状。\n\n**随后**\n\n开始动手改。",
	"empty placeholder seals a step": "**准备**\n\n<!-- -->\n\n接下来的正文属于新的一步。",
	"title only": "**只有标题**",
	"consecutive titles": "**甲**\n\n**乙**\n\n**丙**\n\n最后的正文。",
	"inline bold is not a title": "**结果：** 继续推进\n\n这一段是正文。",
	"placeholder inside prose": "**说明**\n\n使用 `<!-- -->` 作为占位符。",
	"multi paragraph body":
		"**较长的一步**\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。\n\n**下一步**\n\n收尾。",
	"crlf separators": "**标题甲**\r\n\r\n正文甲。\r\n\r\n**标题乙**\r\n\r\n正文乙。",
	"blank line with trailing spaces": "**标题**\n   \n正文紧随其后。\n \n**下一个标题**\n\n结尾。",
	"trailing blank lines": "**标题**\n\n正文。\n\n\n\n",
	"no titles at all": "第一段。\n\n第二段。\n\n第三段。",
};

describe("parseStreamingReasoningSegments — exact at every prefix", () => {
	for (const [name, text] of Object.entries(FIXTURES)) {
		it(`matches a full parse at every prefix: ${name}`, () => {
			const key = `exact-${name}`;
			resetStreamingReasoningCache(key);
			const mismatches: string[] = [];
			for (let end = 1; end <= text.length; end++) {
				const prefix = text.slice(0, end);
				const incremental = parseStreamingReasoningSegments(key, prefix);
				const full = parseReasoningSegments(prefix);
				if (JSON.stringify(incremental) !== JSON.stringify(full)) {
					mismatches.push(
						`len=${end}\n  incremental=${JSON.stringify(incremental)}\n  full       =${JSON.stringify(full)}`,
					);
				}
			}
			expect(mismatches).toEqual([]);
		});
	}

	it("is exact when the stream arrives in irregular multi-character chunks", () => {
		// Real deltas are not one char at a time; a boundary can land mid-separator.
		const text = FIXTURES["multi paragraph body"] ?? "";
		for (const step of [2, 3, 5, 7, 11]) {
			const key = `chunked-${step}`;
			resetStreamingReasoningCache(key);
			for (let end = step; end <= text.length; end += step) {
				const prefix = text.slice(0, end);
				expect(parseStreamingReasoningSegments(key, prefix)).toEqual(
					parseReasoningSegments(prefix),
				);
			}
			expect(parseStreamingReasoningSegments(key, text)).toEqual(parseReasoningSegments(text));
		}
	});
});

/**
 * `parseStreamingReasoningTitles` is a deliberately LOSSY projection: it truncates each
 * body to its first line (capped), because a folded trace row displays only the title
 * or that first line. Lossy is fine; changing what the reader SEES is not. These tests
 * pin the projection to exactly what the consumer renders.
 */
describe("parseStreamingReasoningTitles — lossy body, identical displayed title", () => {
	/** The consumer's rule (segment-adapter's reasoningStepTitle + truncateTitle). */
	const displayedTitle = (segment: { title: string | null; body: string }) => {
		const raw =
			segment.title ??
			(segment.body.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
		return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
	};

	const LONG_LINE = "这一句很长".repeat(300); // one 1500-char unbroken line

	for (const [name, text] of Object.entries({
		...FIXTURES,
		"untitled body with a very long first line": LONG_LINE,
		"titled step with a very long first line": `**标题**\n\n${LONG_LINE}`,
		"long line followed by more paragraphs": `${LONG_LINE}\n\n后续段落。\n\n再一段。`,
	})) {
		it(`renders the same titles as a full parse: ${name}`, () => {
			const key = `titles-${name}`;
			resetStreamingReasoningCache(key);
			const projected = parseStreamingReasoningTitles(key, text);
			const full = parseReasoningSegments(text);
			// Same number of steps, and each step displays the same string.
			expect(projected.map(displayedTitle)).toEqual(full.map(displayedTitle));
			// The `isEmpty` flag decides whether a row is expandable at all, so it must
			// also survive the projection.
			expect(projected.map((s) => s.isEmpty)).toEqual(full.map((s) => s.isEmpty));
		});
	}

	it("bounds the retained body even when the stream never emits a newline", () => {
		// The shape that defeated an earlier attempt: with no line terminator the "first
		// line" is the whole reply, so without a cap the emitted body grew without bound
		// and was rebuilt every frame (0.0475ms at 400k chars, still scaling).
		const key = "unbounded-line";
		resetStreamingReasoningCache(key);
		const huge = `**分析**\n\n${"字".repeat(400_000)}`;
		const [segment] = parseStreamingReasoningTitles(key, huge);
		expect(segment?.body.length).toBeLessThanOrEqual(512);
		// Still displays the correct title (which comes from the bold header here).
		expect(displayedTitle(segment ?? { title: null, body: "" })).toBe("分析");
	});

	it("does not serve a titles-only entry to a full-body caller", () => {
		// The two projections share a key namespace, so a cache hit across them would
		// silently hand back clipped text.
		const key = "shared-key";
		const text = `**标题**\n\n${"内容".repeat(500)}`;
		resetStreamingReasoningCache(key);
		const clipped = parseStreamingReasoningTitles(key, text)[0]?.body ?? "";
		const full = parseStreamingReasoningSegments(key, text)[0]?.body ?? "";
		expect(clipped.length).toBeLessThan(full.length);
		expect(full).toEqual(parseReasoningSegments(text)[0]?.body ?? "");
	});
});

describe("parseStreamingReasoningSegments — cache lifecycle", () => {
	it("re-parses from scratch when the body is REWRITTEN, not appended", () => {
		// A retry replaces the text. Accepting it as growth would return steps parsed
		// from content that is no longer present.
		const key = "rewrite";
		resetStreamingReasoningCache(key);
		parseStreamingReasoningSegments(key, "**第一次尝试**\n\n原始正文。\n\n更多正文。");
		const rewritten = "**完全不同的标题**\n\n新的正文内容。";
		expect(parseStreamingReasoningSegments(key, rewritten)).toEqual(
			parseReasoningSegments(rewritten),
		);
	});

	it("re-parses correctly when the body is front-truncated", () => {
		const key = "truncate";
		resetStreamingReasoningCache(key);
		parseStreamingReasoningSegments(key, "**开头**\n\n中间正文。\n\n**结尾**\n\n结尾正文。");
		// The streaming accumulator drops from the FRONT past its cap, so the new text
		// is not a prefix extension.
		const truncated = "间正文。\n\n**结尾**\n\n结尾正文扩展。";
		expect(parseStreamingReasoningSegments(key, truncated)).toEqual(
			parseReasoningSegments(truncated),
		);
	});

	it("keeps separate bodies isolated under interleaved growth", () => {
		resetStreamingReasoningCache();
		const a = "**甲的标题**\n\n甲的正文。";
		const b = "**乙的标题**\n\n乙的正文。";
		parseStreamingReasoningSegments("row-a", a);
		parseStreamingReasoningSegments("row-b", b);
		expect(parseStreamingReasoningSegments("row-a", `${a}继续`)).toEqual(
			parseReasoningSegments(`${a}继续`),
		);
		expect(parseStreamingReasoningSegments("row-b", `${b}继续`)).toEqual(
			parseReasoningSegments(`${b}继续`),
		);
	});

	it("releases entries on reset and bounds the tracked set", () => {
		resetStreamingReasoningCache();
		expect(parseStreamingReasoningSegments("empty", "")).toEqual([]);
		expect(streamingReasoningCacheSize()).toBe(0);

		for (let i = 0; i < 12; i++) {
			parseStreamingReasoningSegments(`row-${i}`, `**标题 ${i}**\n\n正文。`);
		}
		// Bounded: only the live body needs tracking, so the map must not creep.
		expect(streamingReasoningCacheSize()).toBeLessThanOrEqual(4);

		resetStreamingReasoningCache();
		expect(streamingReasoningCacheSize()).toBe(0);
	});
});

describe("parseStreamingReasoningSegments — cost stays flat as the body grows", () => {
	const STEP = `**分析步骤**\n\n${"这一段说明了折叠后的渲染行为与图标位置的稳定性。".repeat(3)}\n\n`;

	/**
	 * Median per-frame parse cost while the body grows from `from` to `to` chars.
	 *
	 * ⚠️ The `charCodeAt(0)` is load-bearing, and getting it wrong is how this test
	 * first lied to me. `text += delta` produces a ROPE; the first character access
	 * inside the parser forces an O(len) flatten. Timing that flatten attributes it to
	 * the parser and reports ~0.21ms/frame at 200k chars scaling 28x — which is what
	 * made a genuinely flat implementation look broken. Flattening OUTSIDE the timed
	 * region measures the parser instead of V8's string representation.
	 *
	 * The flatten itself is real but is not this module's cost: the streaming
	 * accumulator concatenates onto the same string (`appendStreamingTextPreview`), so
	 * whoever touches the text first pays it once per frame regardless of how the
	 * reasoning is parsed.
	 */
	const medianCost = (from: number, to: number) => {
		const key = `cost-${from}`;
		resetStreamingReasoningCache(key);
		let text = STEP.repeat(Math.ceil(from / STEP.length));
		parseStreamingReasoningSegments(key, text);
		const samples: number[] = [];
		while (text.length < to) {
			text += STEP;
			text.charCodeAt(0); // force the rope flat before the timed region
			const started = performance.now();
			parseStreamingReasoningSegments(key, text);
			samples.push(performance.now() - started);
		}
		samples.sort((left, right) => left - right);
		return samples[Math.floor(samples.length / 2)] ?? 0;
	};

	it("does not re-walk the accumulated text on every frame", () => {
		// This is the whole reason the module exists: the folded low-LOD trace re-adapts
		// the live row per delta, so an O(len) parse becomes O(len²) over a turn. The
		// full parser measured 0.365ms → 3.573ms across this range (100x text → 9.8x
		// cost); the incremental one pays only for newly settled paragraphs.
		medianCost(1_000, 4_000); // warm the JIT
		const early = medianCost(2_000, 6_000);
		const late = medianCost(200_000, 204_000);

		expect(late).toBeLessThan(Math.max(early, 0.02) * 4);
	});

	it("beats a full re-parse by a wide margin on a long body", () => {
		// An absolute-ratio guard against the incremental path silently degrading into
		// "call the full parser every frame", which the flat-cost test alone would not
		// catch if both sides regressed together.
		const text = STEP.repeat(Math.ceil(200_000 / STEP.length));
		text.charCodeAt(0);
		const key = "vs-full";
		resetStreamingReasoningCache(key);
		parseStreamingReasoningSegments(key, text);

		let grown = text;
		const incremental: number[] = [];
		const full: number[] = [];
		for (let i = 0; i < 20; i++) {
			grown += STEP;
			grown.charCodeAt(0);
			let started = performance.now();
			parseStreamingReasoningSegments(key, grown);
			incremental.push(performance.now() - started);
			started = performance.now();
			parseReasoningSegments(grown);
			full.push(performance.now() - started);
		}
		const median = (values: number[]) => {
			values.sort((left, right) => left - right);
			return values[Math.floor(values.length / 2)] ?? 0;
		};
		expect(median(incremental)).toBeLessThan(median(full) / 5);
	});
});
