/**
 * Citation contract tests.
 *
 * The legacy marker parser intentionally follows Codex's `InlineHiddenTagParser`
 * discipline: literal delimiters plus streaming state, never a regex that guesses
 * bare refs or broad Private Use Area ranges. This distinction is load-bearing in
 * a multi-provider app: other protocols may emit URLs, identifiers, logs, or Nerd
 * Font glyphs that merely resemble pieces of the marker.
 */

import { describe, expect, it } from "bun:test";
import {
	CHATGPT_CITATION_CLOSE,
	CHATGPT_CITATION_OPEN,
	CHATGPT_CITATION_SOURCE_SEPARATOR,
	CITATION_LIMITS,
	CitationMarkupStreamParser,
	cleanAssistantText,
	findCodeRanges,
	hasLegacyCitationMarkers,
	isChatGptCitationSourceRef,
	normalizeTextCitations,
	parseLegacyCitationMarkers,
	projectAssistantTextForDisplay,
	projectCitationsToMarkdown,
	projectStreamingAssistantText,
	remapIndexThroughRemovals,
	resolveAssistantTextDisplay,
	sanitizeCitationUrl,
	type TextCitation,
} from "../citations";

function marker(...refs: string[]): string {
	return `${CHATGPT_CITATION_OPEN}${refs.join(CHATGPT_CITATION_SOURCE_SEPARATOR)}${CHATGPT_CITATION_CLOSE}`;
}

describe("ChatGPT citation source refs", () => {
	it("accepts observed search/view refs without hard-coding kind names", () => {
		expect(isChatGptCitationSourceRef("turn0search3")).toBe(true);
		expect(isChatGptCitationSourceRef("turn204588view0")).toBe(true);
		expect(isChatGptCitationSourceRef("turn12futurekind34")).toBe(true);
	});

	it("rejects malformed and identifier-like values", () => {
		for (const value of [
			"turn",
			"turnsearch1",
			"turn1search",
			"turn1search1_suffix",
			"Turn1search1",
			"turn1search1/extra",
		]) {
			expect(isChatGptCitationSourceRef(value)).toBe(false);
		}
	});
});

describe("parseLegacyCitationMarkers", () => {
	it("strips the exact persisted envelope and retains the opaque ref", () => {
		const result = parseLegacyCitationMarkers(`结论正确${marker("turn0search1")}。`);

		expect(result.text).toBe("结论正确。");
		expect(result.changed).toBe(true);
		expect(result.citations).toEqual([
			{ startIndex: 4, endIndex: 4, sources: [{ sourceRef: "turn0search1" }] },
		]);
	});

	it("supports several refs in one exact envelope", () => {
		const result = parseLegacyCitationMarkers(
			`答案${marker("turn0search1", "turn204588view0")} 后续`,
		);

		expect(result.text).toBe("答案 后续");
		expect(result.citations[0].sources).toEqual([
			{ sourceRef: "turn0search1" },
			{ sourceRef: "turn204588view0" },
		]);
	});

	it("auto-closes a valid opened envelope at EOF, matching Codex", () => {
		const result = parseLegacyCitationMarkers(`正文${CHATGPT_CITATION_OPEN}turn0search1`);

		expect(result.text).toBe("正文");
		expect(result.citations[0].sources).toEqual([{ sourceRef: "turn0search1" }]);
	});

	it("keeps UTF-16 anchors correct across emoji and CJK", () => {
		const result = parseLegacyCitationMarkers(`🚀 中文测试${marker("turn0search1")}尾部`);

		expect(result.text).toBe("🚀 中文测试尾部");
		// emoji surrogate pair (2) + space (1) + four CJK chars (4).
		expect(result.citations[0].endIndex).toBe(7);
	});

	it("preserves exact envelopes inside fenced and inline code", () => {
		const fenced = ["说明：", "```text", marker("turn0search1"), "```", "结束"].join("\n");
		expect(parseLegacyCitationMarkers(fenced).changed).toBe(false);
		const inline = `示例 \`${marker("turn0search1")}\` 结束`;
		expect(parseLegacyCitationMarkers(inline).changed).toBe(false);
	});

	it("fails open for malformed or oversized envelopes", () => {
		for (const raw of [
			`${CHATGPT_CITATION_OPEN}not-a-ref${CHATGPT_CITATION_CLOSE}`,
			`${CHATGPT_CITATION_OPEN}${"x".repeat(CITATION_LIMITS.maxMarkerLength + 1)}${CHATGPT_CITATION_CLOSE}`,
		]) {
			const result = parseLegacyCitationMarkers(raw);
			expect(result.changed).toBe(false);
			expect(result.text).toBe(raw);
		}
	});
});

describe("other protocols are byte-identical when no exact citation envelope exists", () => {
	it("does not guess bare refs or stripped keyword forms", () => {
		for (const raw of [
			"turn204588view0",
			"citeturn0search1",
			"[turn0search1]",
			"turn0view0_suffix",
			"Return0search1",
		]) {
			expect(hasLegacyCitationMarkers(raw)).toBe(false);
			expect(parseLegacyCitationMarkers(raw)).toEqual({
				text: raw,
				citations: [],
				removals: [],
				changed: false,
			});
		}
	});

	it("does not rewrite URLs containing ref-like path segments", () => {
		const raw = "见 https://example.com/turn0search1?next=turn2view3 文档";
		expect(cleanAssistantText(raw)).toEqual({ text: raw, citations: [], changed: false });
	});

	it("does not remove Nerd Font PUA glyphs or text between them", () => {
		// Font Awesome Extension in Nerd Fonts occupies U+E200–U+E2A9.
		const glyphs = "\ue200\ue201\ue202\ue203\ue204\ue205\ue206";
		for (const glyph of glyphs) {
			const raw = `构建状态 ${glyph} 通过`;
			expect(cleanAssistantText(raw).text).toBe(raw);
		}
		const between = "图标A \ue200 中间这一大段正文都是用户内容 \ue201 图标B";
		expect(cleanAssistantText(between).text).toBe(between);
	});

	it("does not trim a Nerd Font glyph or following prose while streaming", () => {
		for (const raw of [
			"正文结尾有个图标 \ue205",
			"构建通过 \ue200 后面还有很长一段正文内容需要保留",
		]) {
			expect(projectStreamingAssistantText(raw)).toBe(raw);
		}
	});

	it("leaves ordinary provider prose and code byte-identical", () => {
		for (const raw of [
			"turn left 3 times, then search 1 result",
			"for (let turn = 0; turn < 8; turn++) search(turn);",
			"```text\nturn0search1\n```",
		]) {
			expect(resolveAssistantTextDisplay(raw)).toEqual({ display: raw, copyText: null });
		}
	});
});

describe("CitationMarkupStreamParser", () => {
	it("parses an envelope split across arbitrary chunk boundaries", () => {
		const parser = new CitationMarkupStreamParser();
		const chunks = [
			parser.push("Hello \ue200ci"),
			parser.push("te\ue202turn0sea"),
			parser.push("rch1\ue201 world"),
			parser.finish(),
		];

		expect(chunks.map((chunk) => chunk.visibleText).join("")).toBe("Hello  world");
		expect(chunks.flatMap((chunk) => chunk.citations)).toEqual([
			{ anchorIndex: 6, sources: [{ sourceRef: "turn0search1" }] },
		]);
	});

	it("buffers a partial opener, but emits it literally at EOF", () => {
		const parser = new CitationMarkupStreamParser();
		expect(parser.push("hello \ue200ci").visibleText).toBe("hello ");
		expect(parser.finish().visibleText).toBe("\ue200ci");
	});

	it("auto-closes a valid opened envelope at EOF", () => {
		const parser = new CitationMarkupStreamParser();
		expect(parser.push(`x${CHATGPT_CITATION_OPEN}turn0view1`).visibleText).toBe("x");
		expect(parser.finish().citations).toEqual([
			{ anchorIndex: 1, sources: [{ sourceRef: "turn0view1" }] },
		]);
	});

	it("fails open for invalid and oversized payloads", () => {
		const invalid = new CitationMarkupStreamParser();
		const invalidRaw = `${CHATGPT_CITATION_OPEN}not-a-ref${CHATGPT_CITATION_CLOSE}`;
		expect(invalid.push(invalidRaw).visibleText).toBe(invalidRaw);

		const oversized = new CitationMarkupStreamParser();
		const payload = "x".repeat(CITATION_LIMITS.maxMarkerLength + 1);
		const out = oversized.push(`${CHATGPT_CITATION_OPEN}${payload}`);
		expect(out.visibleText).toBe(`${CHATGPT_CITATION_OPEN}${payload}`);
	});
});

describe("findCodeRanges", () => {
	it("covers fenced blocks including the closing fence", () => {
		const text = "a\n```\ncode\n```\nb";
		const ranges = findCodeRanges(text);
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe("```\ncode\n```\n");
	});

	it("matches inline spans by backtick run length", () => {
		const text = "``a ` b`` tail";
		const ranges = findCodeRanges(text);
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe("``a ` b``");
	});
});

describe("normalizeTextCitations", () => {
	it("drops citations without a usable source", () => {
		expect(
			normalizeTextCitations(
				[{ startIndex: 0, endIndex: 1, sources: [{ url: "javascript:alert(1)" }] }],
				10,
			),
		).toHaveLength(0);
	});

	it("clamps, merges and deduplicates sources", () => {
		const out = normalizeTextCitations(
			[
				{ startIndex: -5, endIndex: 999, sources: [{ url: "https://a.test" }] },
				{
					startIndex: 0,
					endIndex: 10,
					sources: [{ url: "https://a.test" }, { url: "https://b.test" }],
				},
			],
			10,
		);
		expect(out).toEqual([
			{
				startIndex: 0,
				endIndex: 10,
				sources: [{ url: "https://a.test" }, { url: "https://b.test" }],
			},
		]);
	});

	it("enforces count and metadata limits", () => {
		const many = Array.from({ length: CITATION_LIMITS.maxCitations + 20 }, (_, i) => ({
			startIndex: i,
			endIndex: i,
			sources: [{ url: `https://a.test/${i}` }],
		}));
		expect(normalizeTextCitations(many, 5000)).toHaveLength(CITATION_LIMITS.maxCitations);
		const title = normalizeTextCitations(
			[
				{
					startIndex: 0,
					endIndex: 0,
					sources: [{ title: "T".repeat(CITATION_LIMITS.maxTitleLength + 50) }],
				},
			],
			5,
		);
		expect(title[0].sources[0].title).toHaveLength(CITATION_LIMITS.maxTitleLength);
	});
});

describe("sanitizeCitationUrl", () => {
	it("accepts only bounded http/https URLs", () => {
		expect(sanitizeCitationUrl("https://ok.test/a?b=1")).toBe("https://ok.test/a?b=1");
		expect(sanitizeCitationUrl("http://ok.test")).toBe("http://ok.test");
		expect(sanitizeCitationUrl("ftp://no.test")).toBeUndefined();
		expect(sanitizeCitationUrl("javascript:alert(1)")).toBeUndefined();
		expect(
			sanitizeCitationUrl(`https://a.test/${"x".repeat(CITATION_LIMITS.maxUrlLength)}`),
		).toBeUndefined();
	});
});

describe("citation projection", () => {
	it("renders resolved sources as links and internal refs as plain numbers", () => {
		const citations: TextCitation[] = [
			{ startIndex: 0, endIndex: 2, sources: [{ url: "https://a.test", title: "A" }] },
			{ startIndex: 3, endIndex: 5, sources: [{ sourceRef: "turn0view0" }] },
		];
		const { markdown } = projectCitationsToMarkdown("ab cde", citations);
		expect(markdown).toBe("ab[1](<https://a.test>) cd[2]e");
		expect(markdown).not.toContain("turn0view0");
	});

	it("projects an exact legacy envelope and copies only prose", () => {
		const raw = `已修复${marker("turn204588view0")}`;
		expect(projectAssistantTextForDisplay(raw)).toBe("已修复[1]");
		expect(resolveAssistantTextDisplay(raw)).toEqual({
			display: "已修复[1]",
			copyText: "已修复",
		});
	});

	it("keeps a partial exact opener hidden only while streaming", () => {
		const partial = "进行中\ue200ci";
		expect(projectStreamingAssistantText(partial)).toBe("进行中");
		expect(projectAssistantTextForDisplay(partial)).toBe(partial);
	});

	it("remaps structured indices after removing an exact envelope", () => {
		const raw = `ab ${marker("turn0search1")} cd`;
		const out = projectAssistantTextForDisplay(raw, [
			{ startIndex: raw.length, endIndex: raw.length, sources: [{ url: "https://a.test" }] },
		]);
		expect(out).toBe("ab [1] cd[2](<https://a.test>)");
	});
});

describe("remapIndexThroughRemovals", () => {
	const removals = [
		{ start: 5, end: 10 },
		{ start: 20, end: 25 },
	];
	it("keeps, shifts and collapses indices deterministically", () => {
		expect(remapIndexThroughRemovals(3, removals)).toBe(3);
		expect(remapIndexThroughRemovals(15, removals)).toBe(10);
		expect(remapIndexThroughRemovals(30, removals)).toBe(20);
		expect(remapIndexThroughRemovals(7, removals)).toBe(5);
		expect(remapIndexThroughRemovals(22, removals)).toBe(15);
	});
});
