import { expect, test } from "bun:test";
import { reasoningTranslationSources } from "./reasoning-translation-sources";

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
