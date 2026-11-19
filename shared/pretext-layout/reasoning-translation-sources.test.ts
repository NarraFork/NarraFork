import { describe, expect, test } from "bun:test";
import type { RowBlock } from "../narrator-blocks/message-blocks";
import type {
	ReasoningTranslationActivity,
	ReasoningTranslationPart,
} from "../reasoning-translation";
import { parseReasoningSegments } from "./reasoning-segments";
import {
	matchReasoningTranslationText,
	REASONING_VISIBILITY_MAX_SOURCE_CHARS,
	reasoningTranslationDisplayRange,
	reasoningTranslationSource,
	reasoningTranslationStepSources,
} from "./reasoning-translation-sources";

interface Element {
	type: string;
	id?: string;
	thinking?: string;
	text?: string;
	translatedText?: string;
	translationGeneration?: string;
	translationParts?: ReasoningTranslationPart[];
}
function message(
	elements: Element[],
	opts: {
		named?: boolean;
		id?: string;
		liveContentProjection?: boolean;
		liveBlockIndex?: number;
		reasoningTranslationActivity?: ReasoningTranslationActivity;
	} = {},
) {
	const blocks: RowBlock<Element>[] = elements.map((element, index) => ({
		id: `block-${index}`,
		kind: "reasoning",
		subtype: null,
		phase: "complete",
		revision: 7,
		wireId: null,
		attemptId: null,
		hasOriginal: false,
		named: opts.named ?? true,
		elements: [element],
	}));
	return {
		id: opts.id ?? "message",
		narratorId: "owner",
		blocks,
		liveContentProjection: opts.liveContentProjection,
		liveBlockIndex: opts.liveBlockIndex,
		reasoningTranslationActivity: opts.reasoningTranslationActivity,
	};
}
function source(elements: Element[]) {
	return reasoningTranslationSource(
		message(elements),
		elements.map((block, index) => ({ block, index })),
	);
}
function requireSource(elements: Element[]) {
	const result = source(elements);
	if (!result) throw new Error("Expected untranslated source provenance");
	return result;
}

describe("reasoning translation visual ranges", () => {
	test.each([
		"译",
		"**标题甲**\n\n更长的译文正文\n\n**标题乙**\n\n第二段",
	])("maps a fully completed source to its complete replacement: %s", (translatedText) => {
		const text = "original paragraph\n\nlast source paragraph";
		const block: Element = {
			type: "reasoning",
			text,
			translationGeneration: "g",
			translationParts: [
				{
					id: "all",
					generation: "g",
					start: 0,
					end: text.length,
					sourceText: text,
					translatedText,
				},
			],
		};
		expect(reasoningTranslationDisplayRange(block, 0, text.length)).toMatchObject({
			start: 0,
			end: translatedText.length,
			translationRevision: expect.any(String),
		});
	});

	test("maps source gaps and indivisible parts without applying raw lengths to translated text", () => {
		const text = "prefix\n\ntail source";
		const block: Element = {
			type: "reasoning",
			text,
			translationGeneration: "g",
			translationParts: [
				{
					id: "a",
					generation: "g",
					start: 0,
					end: 6,
					sourceText: "prefix",
					translatedText: "第一段\n\n第二段",
				},
				{
					id: "b",
					generation: "g",
					start: 8,
					end: text.length,
					sourceText: "tail source",
					translatedText: "尾",
				},
			],
		};
		expect(reasoningTranslationDisplayRange(block, 8, text.length)).toEqual({
			start: 10,
			end: 11,
			translationRevision: JSON.stringify(["b", "尾"]),
		});
		expect(reasoningTranslationDisplayRange(block, 10, 12)).toEqual({
			start: 10,
			end: 11,
			translationRevision: JSON.stringify(["b", "尾"]),
		});
		const invalid = { ...block, translationGeneration: "another" };
		expect(reasoningTranslationDisplayRange(invalid, 8, text.length)).toEqual({
			start: 8,
			end: text.length,
		});
	});
});

describe("reasoning translation display provenance", () => {
	test("oversized source projections stop before parsing translation metadata", () => {
		expect(
			source([
				{ type: "reasoning", id: "a", text: "x".repeat(REASONING_VISIBILITY_MAX_SOURCE_CHARS + 1) },
			]),
		).toBeUndefined();
	});

	test("adjacent elements preserve separate source targets", () => {
		const result = requireSource([
			{ type: "thinking", id: "a", thinking: "first visible text" },
			{ type: "reasoning", id: "b", text: "second hidden text" },
		]);
		expect(result?.text).toBe("first visible text\n\nsecond hidden text");
		expect(
			matchReasoningTranslationText(result, "first visible text").map(
				(part) => part.target.elementId,
			),
		).toEqual(["a"]);
		expect(
			matchReasoningTranslationText(result, "second hidden text").map(
				(part) => part.target.elementId,
			),
		).toEqual(["b"]);
		const cachedPrefix = source([
			{ type: "thinking", id: "a", thinking: "first visible text", translatedText: "已译" },
			{ type: "reasoning", id: "b", text: "second hidden text" },
		]);
		expect(cachedPrefix?.group).toEqual(result.group);
		expect(cachedPrefix?.group?.anchor.elementId).toBe("a");
		expect(cachedPrefix?.ranges.map((range) => range.target.elementId)).toEqual(["b"]);
	});

	test("a visible structured title never includes another element's collapsed body", () => {
		const result = requireSource([
			{ type: "reasoning", id: "title", text: "**Visible title**" },
			{ type: "reasoning", id: "body", text: "Collapsed body text" },
		]);
		const steps =
			reasoningTranslationStepSources(parseReasoningSegments(result.text), result) ?? [];
		expect(steps[0]?.title?.ranges.map((range) => range.target.elementId)).toEqual(["title"]);
		expect(steps[0]?.body?.ranges.map((range) => range.target.elementId)).toEqual(["body"]);
	});

	test("repeated titles are projected in parser order, including blank-line normalization", () => {
		const result = requireSource([
			{ type: "reasoning", id: "a", text: "**Repeat**\r\n \r\nfirst body" },
			{ type: "reasoning", id: "b", text: "**Repeat**\n\nsecond body" },
		]);
		const steps =
			reasoningTranslationStepSources(parseReasoningSegments(result.text), result) ?? [];
		expect(steps.map((step) => step.title?.ranges[0]?.target.elementId)).toEqual(["a", "b"]);
		expect(steps.map((step) => step.body?.ranges[0]?.target.elementId)).toEqual(["a", "b"]);
	});

	test("legacy coordinates use original message positions and exact named block revision", () => {
		const block = { type: "reasoning", text: "legacy body" };
		const elements = [{ type: "text", text: "answer" }, block];
		const result = reasoningTranslationSource(message(elements), [{ block, index: 1 }]);
		expect(result?.ranges[0]?.target).toEqual({
			ownerNarratorId: "owner",
			messageId: "message",
			blockId: "block-1",
			legacyIndex: 1,
			legacyVersion: 7,
		});
		expect(result?.ranges[0]?.target).not.toHaveProperty("elementId");
	});

	test("synthetic and client-built messages cannot request persistent translation", () => {
		const block = { type: "reasoning", id: "a", text: "text" };
		for (const opts of [{ id: "__streaming__" }, { named: false }])
			expect(
				reasoningTranslationSource(message([block], opts), [{ block, index: 0 }]),
			).toBeUndefined();
	});

	test("checkpoint projections report original fragments of completed and active elements", () => {
		const elements = [
			{ type: "reasoning", id: "a", text: "completed first" },
			{ type: "reasoning", id: "b", text: "completed second", translatedText: "已译二" },
			{ type: "reasoning", id: "c", text: "active tail", translatedText: "过期尾部" },
		];
		const result = reasoningTranslationSource(
			message(elements, { liveContentProjection: true, liveBlockIndex: 2 }),
			elements.map((block, index) => ({ block, index })),
		);
		expect(result?.text).toBe("completed first\n\n已译二\n\nactive tail");
		expect(result?.ranges.map((range) => range.target.elementId)).toEqual(["a", "c"]);
	});

	test("sealed display parts stay bounded while active original fragments report element visibility", () => {
		const block = {
			type: "reasoning",
			id: "r",
			text: "first second tail",
			translationGeneration: "g",
			translationParts: [
				{
					id: "first",
					generation: "g",
					start: 0,
					end: 5,
					sourceText: "first",
					translatedText: "一",
				},
				{
					id: "tail",
					generation: "g",
					start: 13,
					end: 17,
					sourceText: "tail",
					translatedText: "错误尾部",
				},
			],
		};
		const result = reasoningTranslationSource(
			message([block], {
				liveContentProjection: true,
				liveBlockIndex: 0,
				reasoningTranslationActivity: {
					elementId: "r",
					revision: 3,
					completedRanges: [{ start: 0, end: 12 }],
				},
			}),
			[{ block, index: 0 }],
		);
		expect(result?.text).toBe("一 second tail");
		expect(result?.ranges.map((range) => result.text.slice(range.start, range.end))).toEqual([
			" second tail",
		]);
		expect(
			result &&
				matchReasoningTranslationText(result, "tail").map((range) => range.target.elementId),
		).toEqual(["r"]);
	});

	test("a sealed last part keeps cached translation hidden until real successor output promotes it", () => {
		const block = {
			type: "reasoning",
			id: "r",
			revision: 2,
			completed: true,
			text: "A\n\nB",
			translationGeneration: "g",
			translationParts: [
				{ id: "a", generation: "g", start: 0, end: 1, sourceText: "A", translatedText: "甲" },
				{ id: "b", generation: "g", start: 3, end: 4, sourceText: "B", translatedText: "乙" },
			],
		};
		const pending = reasoningTranslationSource(
			message([block], {
				liveContentProjection: true,
				liveBlockIndex: 0,
				reasoningTranslationActivity: {
					elementId: "r",
					revision: 2,
					completedRanges: [{ start: 0, end: 1 }],
				},
			}),
			[{ block, index: 0 }],
		);
		expect(pending?.text).toBe("甲\n\nB");
		expect(
			pending && matchReasoningTranslationText(pending, "B").map((range) => range.target.elementId),
		).toEqual(["r"]);
		const next = { ...block, completed: false, revision: 3, text: "A\n\nB\n\nC" };
		const advanced = reasoningTranslationSource(
			message([next], {
				liveContentProjection: true,
				liveBlockIndex: 0,
				reasoningTranslationActivity: {
					elementId: "r",
					revision: 3,
					completedRanges: [
						{ start: 0, end: 1 },
						{ start: 3, end: 4 },
					],
				},
			}),
			[{ block: next, index: 0 }],
		);
		expect(advanced?.text).toBe("甲\n\n乙\n\nC");
	});

	test("only real persisted active elements expose visibility targets", () => {
		const block = {
			type: "reasoning",
			id: "r",
			text: "active original",
			translatedText: "过期译文",
		};
		const activity = { elementId: "r", revision: 3, completedRanges: [] };
		const opts = {
			liveContentProjection: true,
			liveBlockIndex: 0,
			reasoningTranslationActivity: activity,
		};
		const result = reasoningTranslationSource(message([block], opts), [{ block, index: 0 }]);
		expect(result?.text).toBe("active original");
		expect(result?.ranges.map((range) => range.target.elementId)).toEqual(["r"]);
		expect(
			reasoningTranslationSource(message([block], { ...opts, id: "__streaming__" }), [
				{ block, index: 0 },
			]),
		).toBeUndefined();
	});

	test("complete legacy caches and complete validated parts retain group identity without demand", () => {
		expect(
			source([{ type: "reasoning", id: "a", text: "text", translatedText: "译文" }])?.ranges,
		).toEqual([]);
		expect(
			source([
				{
					type: "reasoning",
					id: "a",
					text: "text",
					translationGeneration: "g",
					translationParts: [
						{
							id: "p",
							generation: "g",
							start: 0,
							end: 4,
							sourceText: "text",
							translatedText: "译文",
						},
					],
				},
			])?.ranges,
		).toEqual([]);
	});

	test("only an untranslated tail carries a target after cached parts", () => {
		const result = requireSource([
			{
				type: "reasoning",
				id: "a",
				text: "prefix tail",
				translationGeneration: "g",
				translationParts: [
					{
						id: "p",
						generation: "g",
						start: 0,
						end: 6,
						sourceText: "prefix",
						translatedText: "前缀",
					},
				],
			},
		]);
		expect(result.text).toBe("前缀 tail");
		expect(matchReasoningTranslationText(result, "前缀")).toEqual([]);
		expect(
			matchReasoningTranslationText(result, "tail").map((range) => range.target.elementId),
		).toEqual(["a"]);
	});

	test("source generation mismatches cannot suppress untranslated characters", () => {
		const result = requireSource([
			{
				type: "reasoning",
				id: "a",
				text: "new text",
				translationGeneration: "new",
				translationParts: [
					{
						id: "p",
						generation: "old",
						start: 0,
						end: 8,
						sourceText: "new text",
						translatedText: "旧译文",
					},
				],
			},
		]);
		expect(result.text).toBe("new text");
		expect(result.ranges[0]?.end).toBe(8);
	});

	test("ambiguous repeated rendered text cannot activate a hidden source", () => {
		const result = requireSource([
			{ type: "reasoning", id: "a", text: "repeat" },
			{ type: "reasoning", id: "b", text: "repeat" },
		]);
		expect(matchReasoningTranslationText(result, "repeat")).toEqual([]);
		expect(matchReasoningTranslationText(result, "not in source")).toEqual([]);
	});

	test("markdown soft line breaks retain UTF-16 source coordinates", () => {
		const result = requireSource([{ type: "reasoning", id: "a", text: "first\nsecond" }]);
		expect(matchReasoningTranslationText(result, "first second")[0]).toMatchObject({
			start: 0,
			end: 12,
			target: { elementId: "a" },
		});
	});
});
