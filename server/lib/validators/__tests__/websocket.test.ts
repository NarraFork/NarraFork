import { expect, test } from "bun:test";
import { narratorWsMessageSchema } from "../websocket";

test("translation visibility accepts bounded source identities and explicit release", () => {
	const target = {
		ownerNarratorId: "owner",
		messageId: "message",
		blockId: "block",
		elementId: "element",
	};
	const frame = {
		type: "reasoning_translation_visibility",
		narratorId: "view",
		visibilityId: "panel",
		targets: [target],
	};
	expect(narratorWsMessageSchema.safeParse(frame).success).toBe(true);
	expect(narratorWsMessageSchema.safeParse({ ...frame, targets: [] }).success).toBe(true);
	expect(narratorWsMessageSchema.safeParse({ ...frame, locale: "zh-CN" }).success).toBe(false);
	expect(
		narratorWsMessageSchema.safeParse({
			...frame,
			targets: Array.from({ length: 65 }, () => target),
		}).success,
	).toBe(false);
	const legacy = {
		ownerNarratorId: "owner",
		messageId: "message",
		blockId: "block",
		legacyIndex: 1,
		legacyVersion: 2,
	};
	expect(narratorWsMessageSchema.safeParse({ ...frame, targets: [legacy] }).success).toBe(true);
	for (const invalid of [
		{ ...legacy, legacyVersion: undefined },
		{ ...target, legacyIndex: 0, legacyVersion: 0 },
		{ ...target, blockId: "x".repeat(257) },
	])
		expect(narratorWsMessageSchema.safeParse({ ...frame, targets: [invalid] }).success).toBe(false);
});

test("message subscription restoration carries a strictly boolean reader-state request", () => {
	const frame = {
		type: "subscribe",
		narratorIds: ["narrator"],
		kind: "messages",
		version: 4,
		restoreState: true,
	};
	expect(narratorWsMessageSchema.parse(frame)).toMatchObject({ restoreState: true, version: 4 });
	expect(narratorWsMessageSchema.safeParse({ ...frame, restoreState: "true" }).success).toBe(false);
	expect(
		narratorWsMessageSchema.safeParse({ type: "subscribe", narratorIds: ["narrator"] }).success,
	).toBe(true);
});
