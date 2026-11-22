import { expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import {
	type ReasoningTranslationPatch,
	readReasoningTranslationPatch,
} from "@shared/reasoning-translation";
import {
	patchReasoningTranslation,
	RetainedTranslationPatches,
} from "./useReasoningTranslationLivePatches";

const frame: ReasoningTranslationPatch = {
	type: "reasoning_translation_patch",
	narratorId: "parent",
	ownerNarratorId: "child",
	messageId: "message",
	blockId: "block",
	elementId: "element",
	blockRevision: 2,
	stateRevision: 4,
	translationGeneration: "generation",
	part: {
		id: "p1",
		generation: "generation",
		start: 0,
		end: 5,
		sourceText: "alpha",
		translatedText: "甲",
	},
};

function row(): TreeMessage {
	return {
		id: "message",
		narratorId: "child",
		parentToolUseId: "child-tool",
		role: "assistant",
		blocks: [
			{
				id: "block",
				kind: "reasoning",
				subtype: null,
				phase: "complete",
				revision: 2,
				wireId: "element",
				attemptId: null,
				named: true,
				hasOriginal: false,
				elements: [{ type: "reasoning", id: "element", text: "alpha beta" }],
			},
		],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-11-22T00:00:00.000Z",
	};
}

test("normalizes wire patches and rejects malformed revisions, range and generation", () => {
	expect(readReasoningTranslationPatch({ ...frame, accidental: "payload" })).toEqual(frame);
	expect(readReasoningTranslationPatch({ ...frame, stateRevision: -1 })).toBeNull();
	expect(readReasoningTranslationPatch({ ...frame, part: { ...frame.part, start: 1 } })).toBeNull();
	expect(readReasoningTranslationPatch({ ...frame, translationGeneration: "other" })).toBeNull();
});

test("replays a patch over a late page, without editing source or duplicating a persisted part", () => {
	const store = new RetainedTranslationPatches();
	store.remember(frame);
	expect(store.apply([]).changed).toBe(false);
	const result = store.apply([row()]);
	expect(result.changed).toBe(true);
	expect(result.messages[0]).toMatchObject({
		stateRevision: 4,
		blocks: [{ elements: [{ text: "alpha beta", translationParts: [frame.part] }] }],
	});
	expect(store.apply(result.messages)).toEqual({ messages: result.messages, changed: false });
});

test("rejects wrong owner, changed source, and a generation-less newer block", () => {
	const message = row();
	expect(
		patchReasoningTranslation([message], { ...frame, ownerNarratorId: "parent" }).changed,
	).toBe(false);
	expect(
		patchReasoningTranslation([message], { ...frame, part: { ...frame.part, sourceText: "omega" } })
			.changed,
	).toBe(false);
	message.blocks[0].revision++;
	expect(patchReasoningTranslation([message], frame).changed).toBe(false);
});
