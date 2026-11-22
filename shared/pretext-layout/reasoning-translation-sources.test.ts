import { expect, test } from "bun:test";
import {
	mergedReasoningTranslationEvidence,
	reasoningTranslationSources,
	reasoningTranslationTargetForLine,
} from "./reasoning-translation-sources";

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

test("merged rows match only the block whose prose is visible", () => {
	const elements = [
		{ type: "reasoning", id: "first", text: "First paragraph.\n\nRepeated sentence." },
		{ type: "reasoning", id: "second", text: "Second paragraph.\n\nRepeated sentence." },
		{ type: "reasoning", id: "old", text: "Old paragraph.", translatedText: "旧的段落。" },
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
	expect(evidence).toHaveLength(4);
	const match = (text: string) => reasoningTranslationTargetForLine(evidence ?? [], text);
	expect(match("First   paragraph.")).toMatchObject({ elementId: "first", blockRevision: 1 });
	expect(match("Second paragraph.")).toMatchObject({ elementId: "second", blockRevision: 2 });
	expect(match("Repeated sentence.")).toBeUndefined();
	expect(match("旧的段落。")).toBeUndefined();
	expect(match("Unsealed paragraph.")).toBeUndefined();
	expect(match("Repeated sentence. Second paragraph.")).toBeUndefined();
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
