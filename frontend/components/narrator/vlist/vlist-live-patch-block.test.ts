import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import type { ReasoningTranslationPatch } from "@shared/reasoning-translation";
import { composeReasoningTranslation } from "@shared/reasoning-translation";
import { toolCompletedPatch } from "./vlist-live-events";
import { patchReasoningTranslation, ReasoningTranslationPatchStore } from "./vlist-live-patch";

/** Two rows holding the same call id (a reused provider id), each in its own tool block. */
function rows(): TreeMessage[] {
	const row = (id: string, blockId: string) =>
		({
			id,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			createdAt: "2026-10-01T00:00:00.000Z",
			toolCalls: [],
			blocks: [
				{
					id: blockId,
					kind: "tool",
					subtype: null,
					phase: "open",
					revision: 0,
					wireId: "call_1",
					attemptId: null,
					hasOriginal: false,
					named: true,
					elements: [
						{ type: "tool_use", id: "call_1", name: "Bash", input: {}, status: "running" },
					],
				},
			],
		}) as unknown as TreeMessage;
	return [row("m1", "b-old"), row("m2", "b-new")];
}

const status = (messages: readonly TreeMessage[]) =>
	messages.map((message) => (messageBody(message)[0] as { status?: string }).status);

function translationRows(): TreeMessage[] {
	const message = rows()[0];
	return [
		{
			...message,
			parentMessageId: "parent",
			stateRevision: 0,
			blocks: [
				{
					...message.blocks[0],
					id: "persisted-reasoning",
					kind: "reasoning",
					revision: 2,
					elements: [
						{
							type: "reasoning",
							id: "element",
							revision: 5,
							text: "abcdef",
							translationGeneration: "g1",
						},
					],
				},
			],
		},
	];
}

function translationPatch(start = 0, stateRevision = 7): ReasoningTranslationPatch {
	const sourceText = start === 0 ? "abc" : "def";
	return {
		narratorId: "n1",
		ownerNarratorId: "n1",
		messageId: "m1",
		blockId: "persisted-reasoning",
		elementId: "element",
		blockRevision: 2,
		stateRevision,
		translationGeneration: "g1",
		part: {
			id: `p${start}`,
			generation: "g1",
			start,
			end: start + 3,
			sourceText,
			translatedText: start === 0 ? "甲" : "乙",
		},
	};
}

describe("persistent reasoning translation parts", () => {
	test("merges older independent state parts and duplicates are referential no-ops", () => {
		const loaded = translationRows();
		const second = patchReasoningTranslation(loaded, translationPatch(3, 9));
		const first = patchReasoningTranslation(second.messages, translationPatch(0, 7));
		expect(first.changed).toBe(true);
		expect(first.messages[0].stateRevision).toBe(9);
		expect(first.messages[0].blocks[0].revision).toBe(2);
		const element = messageBody(first.messages[0])[0];
		expect(element.revision).toBe(5);
		expect(
			composeReasoningTranslation(
				element.text ?? "",
				element.translationGeneration,
				element.translationParts,
			),
		).toBe("甲乙");
		expect(patchReasoningTranslation(first.messages, translationPatch(0, 7)).messages).toBe(
			first.messages,
		);
		expect(messageBody(loaded[0])[0].translationParts).toBeUndefined();
	});

	test("addresses a flat nested row by persistent block and element, not body revision aliases", () => {
		const loaded = translationRows();
		for (const fields of [
			{ blockId: "element" },
			{ elementId: "persisted-reasoning" },
			{ ownerNarratorId: "other" },
			{ blockRevision: 3 },
			{ translationGeneration: "old" },
		]) {
			expect(patchReasoningTranslation(loaded, { ...translationPatch(), ...fields }).changed).toBe(
				false,
			);
		}
		loaded[0].blocks[0].named = false;
		expect(patchReasoningTranslation(loaded, translationPatch()).changed).toBe(false);
	});

	test("validates append growth, rewritten source and surrogate boundaries", () => {
		const loaded = translationRows();
		loaded[0].blocks[0] = {
			...loaded[0].blocks[0],
			revision: 3,
			elements: [
				{ type: "reasoning", id: "element", text: "abcdef tail", translationGeneration: "g1" },
			],
		};
		expect(patchReasoningTranslation(loaded, translationPatch()).changed).toBe(true);
		const stale = translationPatch();
		stale.part.sourceText = "bad";
		expect(patchReasoningTranslation(loaded, stale).changed).toBe(false);
		loaded[0].blocks[0].elements = [
			{ type: "reasoning", id: "element", text: "😀", translationGeneration: "g1" },
		];
		const split = translationPatch();
		split.part = { ...split.part, start: 0, end: 1, sourceText: "\ud83d" };
		expect(patchReasoningTranslation(loaded, split).changed).toBe(false);
	});

	test("retains a bounded early patch across late pages/checkpoints and forgets removed rows", () => {
		const store = new ReasoningTranslationPatchStore();
		expect(store.remember(translationPatch(3, 9))).toBe(true);
		expect(store.remember(translationPatch(0, 7))).toBe(true);
		expect(store.apply([]).changed).toBe(false);
		const late = translationRows();
		const result = store.apply(late);
		expect(messageBody(result.messages[0])[0].translationParts).toHaveLength(2);
		expect(store.apply(result.messages).messages).toBe(result.messages);
		expect(
			messageBody(store.apply(translationRows()).messages[0])[0].translationParts,
		).toHaveLength(2);
		const missing = translationRows();
		delete missing[0].blocks[0].elements[0].translationGeneration;
		expect(messageBody(store.apply(missing).messages[0])[0].translationParts).toHaveLength(2);
		const bounded = new ReasoningTranslationPatchStore(1024 * 1024, 1);
		expect(bounded.remember(translationPatch())).toBe(true);
		expect(bounded.remember(translationPatch(3))).toBe(false);
		expect(messageBody(bounded.apply(late).messages[0])[0].translationParts).toHaveLength(1);
		store.forget(["m1"]);
		expect(store.apply(late).messages).toBe(late);
	});
});

describe("tool lifecycle patches", () => {
	test("a frame naming its tool block patches only that block's row", () => {
		const patch = toolCompletedPatch({ toolUseId: "call_1", blockId: "b-old", status: "success" });
		const result = patch(rows());
		expect(result.changed).toBe(true);
		expect(status(result.messages)).toEqual(["success", "running"]);
	});

	test("without a block id every occurrence of the call is patched, as before", () => {
		const result = toolCompletedPatch({ toolUseId: "call_1", status: "success" })(rows());
		expect(status(result.messages)).toEqual(["success", "success"]);
	});

	test("a block no loaded row holds falls back to every occurrence", () => {
		const result = toolCompletedPatch({ toolUseId: "call_1", blockId: "b-gone", status: "fail" })(
			rows(),
		);
		expect(status(result.messages)).toEqual(["fail", "fail"]);
	});
});
