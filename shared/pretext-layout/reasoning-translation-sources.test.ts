import { beforeAll, expect, test } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";
import { parseMarkdownToPreparedBlocks } from "./parse-markdown";
import {
	mergedReasoningTranslationEvidence,
	reasoningTranslationSources,
	reasoningTranslationTargetForRange,
} from "./reasoning-translation-sources";
import { adaptSegment } from "./segment-adapter";

beforeAll(() => installCanvasStub());

test("merged runs retain only completed, untranslated named elements", () => {
	const elements = [
		{ type: "reasoning", id: "done", text: "original" },
		{ type: "reasoning", id: "live", text: "still writing" },
		{ type: "reasoning", id: "legacy", text: "translated", translatedText: "翻译" },
	];
	const blocks = elements.map((element, i) => ({
		id: `block-${i}`,
		kind: "reasoning",
		subtype: null,
		phase: i === 1 ? "open" : "done",
		named: true,
		revision: i + 10,
		wireId: null,
		attemptId: null,
		hasOriginal: false,
		elements: [element],
	}));
	expect(
		reasoningTranslationSources(
			{ id: "message", narratorId: "owner", blocks },
			elements.map((block, index) => ({ block, index })),
		),
	).toEqual([
		{
			ownerNarratorId: "owner",
			messageId: "message",
			blockId: "block-0",
			blockRevision: 10,
			elementId: "done",
		},
	]);
});

test("formatted and repeated prose are attributed by source position, not painted text", () => {
	const elements = [
		{ type: "reasoning", id: "first", text: "Compare **these** plans.\n\nRepeated sentence." },
		{ type: "reasoning", id: "second", text: "Compare these plans.\n\nRepeated sentence." },
		{ type: "reasoning", id: "old", text: "Old paragraph.", translatedText: "已翻译。" },
		{ type: "reasoning", id: "live", text: "Unsealed paragraph.", completed: false },
	];
	const blocks = elements.map((element, i) => ({
		id: `block-${i}`,
		kind: "reasoning",
		subtype: null,
		phase: i === 3 ? "open" : "done",
		named: true,
		revision: i + 1,
		wireId: null,
		attemptId: null,
		hasOriginal: false,
		elements: [element],
	}));
	const evidence = mergedReasoningTranslationEvidence(
		{ id: "message", narratorId: "owner", blocks },
		elements.map((block, index) => ({ block, index })),
	);
	expect(evidence).toHaveLength(2);
	const text = elements.map((element) => element.translatedText ?? element.text).join("\n\n");
	const parsed = parseMarkdownToPreparedBlocks(text, undefined, true);
	expect(
		parsed.map((block) => {
			const range = block.sourceRange;
			return (
				range &&
				reasoningTranslationTargetForRange(evidence ?? [], range.start, range.end)?.elementId
			);
		}),
	).toEqual(["first", "first", "second", "second", undefined, undefined]);
	expect(reasoningTranslationTargetForRange(evidence ?? [], 0, text.length)).toBeUndefined();
});

test("step provenance follows the rendered paragraphs across titles and translation updates", () => {
	const elements = [
		{ type: "reasoning", id: "first", text: "**First**\r\nCompare **these** plans.\n\nAgain." },
		{ type: "reasoning", id: "second", text: "**Second**\n\nCompare these plans." },
	];
	const message = {
		id: "message",
		narratorId: "owner",
		role: "assistant" as const,
		model: "gpt-5.6",
		blocks: elements.map((element, i) => ({
			id: `block-${i}`,
			kind: "reasoning",
			subtype: null,
			phase: "done" as const,
			named: true,
			revision: i + 1,
			wireId: null,
			attemptId: null,
			hasOriginal: false,
			elements: [element],
		})),
	};
	const getSpec = (msg = message) => adaptSegment({ kind: "message", msg }, { lod: 5 })[0];
	const spec = getSpec();
	expect(spec.kind).toBe("reasoning-steps");
	const firstLength = "Compare **these** plans.\n\nAgain.".length;
	const secondLength = "Compare these plans.".length;
	expect(
		reasoningTranslationTargetForRange(spec.reasoningTranslationEvidence ?? [], 0, firstLength, 0),
	).toMatchObject({ elementId: "first" });
	expect(
		reasoningTranslationTargetForRange(spec.reasoningTranslationEvidence ?? [], 0, secondLength, 1),
	).toMatchObject({ elementId: "second" });
	const translated = getSpec({
		...message,
		blocks: [
			{
				...message.blocks[0],
				elements: [
					{ ...elements[0], translatedText: "**第一**\n\n检查。" } as (typeof elements)[number],
				],
			},
			message.blocks[1],
		],
	});
	expect(
		reasoningTranslationTargetForRange(translated.reasoningTranslationEvidence ?? [], 0, 3, 0),
	).toBeUndefined();
	expect(
		reasoningTranslationTargetForRange(
			translated.reasoningTranslationEvidence ?? [],
			0,
			secondLength,
			1,
		),
	).toMatchObject({ elementId: "second" });
});

test("a Markdown list formed by two reasoning blocks retains per-item provenance", () => {
	const left = "- [x] **First** item\r\n  continued";
	const right = "- [ ] Second item";
	const text = `${left}\r\n\r\n${right}`;
	const parsed = parseMarkdownToPreparedBlocks(text, undefined, true);
	expect(parsed.map(({ sourceRange }) => sourceRange)).toEqual([
		{ start: 0, end: left.length },
		{ start: left.length + 4, end: text.length },
	]);
	expect(parsed.map(({ sourceRange: _range, ...block }) => block)).toEqual(
		parseMarkdownToPreparedBlocks(text),
	);
});

test("an inexact blockquote cannot mask the exact source of a following paragraph", () => {
	const quote = "> - item\n>\n> - next\nwrapped";
	const tail = "Repeated prose.";
	const text = `${tail}\n\n${quote}\n\n${tail}`;
	const parsed = parseMarkdownToPreparedBlocks(text, undefined, true);
	expect(parsed[0]?.sourceRange).toEqual({ start: 0, end: tail.length });
	expect(parsed.slice(1, -1).every(({ sourceRange }) => !sourceRange)).toBe(true);
	expect(parsed.at(-1)?.sourceRange).toEqual({
		start: text.length - tail.length,
		end: text.length,
	});
});

test("exact paragraphs between rewritten quotes keep their positional provenance", () => {
	const quote = "> - item\r\n>\r\n> - next\r\nwrapped";
	const copy = "Repeated **prose**.";
	const separator = "\r\n\r\n";
	const text = [copy, quote, copy, quote, copy].join(separator);
	const paragraphStride = copy.length + quote.length + 2 * separator.length;
	const parsed = parseMarkdownToPreparedBlocks(text, undefined, true);
	expect(parsed.flatMap(({ sourceRange }) => (sourceRange ? [sourceRange] : []))).toEqual(
		[0, paragraphStride, 2 * paragraphStride].map((start) => ({
			start,
			end: start + copy.length,
		})),
	);
});

test("duplicate link definitions do not shift later source ranges", () => {
	const definitions = "[same]: /first\r\n[same]: /second\r\n\r\n";
	const paragraph = "Use [the link][same].";
	const text = definitions + paragraph;
	const parsed = parseMarkdownToPreparedBlocks(text, undefined, true);
	expect(parsed.map(({ sourceRange }) => sourceRange)).toEqual([
		{ start: definitions.length, end: text.length },
	]);
	expect(parsed.map(({ sourceRange: _range, ...block }) => block)).toEqual(
		parseMarkdownToPreparedBlocks(text),
	);
});

test("an open checkpoint is requested only until its sealed prefix is translated", () => {
	const checkpoint = {
		type: "reasoning",
		id: "element",
		text: "First\n\nStill streaming",
		completed: false,
		sealedReasoningLength: 5,
	};
	const targets = (
		element: typeof checkpoint & import("../reasoning-translation").ReasoningTranslationFields,
		phase: "open" | "aborted",
	) =>
		reasoningTranslationSources(
			{
				id: "message",
				narratorId: "owner",
				blocks: [
					{
						id: "block",
						kind: "reasoning",
						phase,
						named: true,
						revision: 7,
						subtype: null,
						wireId: null,
						attemptId: null,
						hasOriginal: false,
						elements: [element],
					},
				],
			},
			[{ index: 0, block: element }],
		);
	expect(targets(checkpoint, "open")).toEqual([
		expect.objectContaining({ elementId: "element", blockRevision: 7 }),
	]);
	expect(targets(checkpoint, "aborted")).toEqual([]);
	expect(
		targets(
			{
				...checkpoint,
				translationGeneration: "generation",
				translationParts: [
					{
						id: "first",
						start: 0,
						end: 5,
						sourceText: "First",
						translatedText: "第一",
						generation: "generation",
					},
				],
			},
			"open",
		),
	).toEqual([]);
});
