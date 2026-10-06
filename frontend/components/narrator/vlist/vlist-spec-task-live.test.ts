/**
 * vlist-spec-task-live.test.ts — locks the rule that keeps the scrollback still.
 *
 * The bug being guarded: a spec task's `doing` is a RECORDED status, so animating on
 * it alone made every task bubble in the history spin at once, each claiming to be
 * working right now. Only the newest surface of a RUNNING narrator is live.
 */

import { describe, expect, test } from "bun:test";
import {
	findLatestSpecTaskBubbleKey,
	isSpecTaskLiveItem,
	resolveSpecTaskLiveGate,
	type SpecTaskLiveItemLike,
} from "./vlist-spec-task-live";

function bubble(key: string): SpecTaskLiveItemLike {
	return {
		spec: { key, kind: "injection-bubble", data: { payload: { kind: "spec-task", data: {} } } },
	};
}

function otherBubble(key: string): SpecTaskLiveItemLike {
	return { spec: { key, kind: "injection-bubble", data: { markdown: "hello" } } };
}

function taskCard(key: string, toolUseId: string): SpecTaskLiveItemLike {
	return { spec: { key, kind: "tool-call", data: {} }, measured: { toolUseId } };
}

describe("findLatestSpecTaskBubbleKey", () => {
	test("returns null when no framed spec-task bubble exists", () => {
		expect(findLatestSpecTaskBubbleKey([])).toBeNull();
		expect(findLatestSpecTaskBubbleKey([otherBubble("b1")])).toBeNull();
	});

	test("the LAST spec-task bubble wins (document order)", () => {
		const items = [bubble("s1"), otherBubble("b1"), bubble("s2"), otherBubble("b2")];
		expect(findLatestSpecTaskBubbleKey(items)).toBe("s2");
	});

	test("a markdown injection bubble is not a task bubble", () => {
		expect(findLatestSpecTaskBubbleKey([bubble("s1"), otherBubble("b9")])).toBe("s1");
	});
});

describe("resolveSpecTaskLiveGate", () => {
	test("an idle narrator has NO live surface, however recent the digest", () => {
		const gate = resolveSpecTaskLiveGate([bubble("s1")], false, "tu-1");
		expect(gate).toEqual({ bubbleKey: null, toolUseId: null });
	});

	test("a running narrator pins both surfaces", () => {
		const gate = resolveSpecTaskLiveGate([bubble("s1"), bubble("s2")], true, "tu-7");
		expect(gate).toEqual({ bubbleKey: "s2", toolUseId: "tu-7" });
	});

	test("a running narrator with no tasks card carries a null tool id", () => {
		expect(resolveSpecTaskLiveGate([bubble("s1")], true, null).toolUseId).toBeNull();
		expect(resolveSpecTaskLiveGate([bubble("s1")], true, undefined).toolUseId).toBeNull();
	});
});

describe("isSpecTaskLiveItem", () => {
	test("only the newest bubble is live; older ones are history", () => {
		const older = bubble("s1");
		const newer = bubble("s2");
		const gate = resolveSpecTaskLiveGate([older, newer], true, null);
		expect(isSpecTaskLiveItem(older, gate)).toBe(false);
		expect(isSpecTaskLiveItem(newer, gate)).toBe(true);
	});

	test("a tasks card is matched by tool-use id, not by position", () => {
		const older = taskCard("tool-a", "tu-a");
		const newer = taskCard("tool-b", "tu-b");
		const gate = resolveSpecTaskLiveGate([older, newer], true, "tu-b");
		expect(isSpecTaskLiveItem(older, gate)).toBe(false);
		expect(isSpecTaskLiveItem(newer, gate)).toBe(true);
	});

	test("nothing is live once the narrator settles", () => {
		const items = [bubble("s1"), taskCard("tool-a", "tu-a")];
		const gate = resolveSpecTaskLiveGate(items, false, "tu-a");
		for (const item of items) expect(isSpecTaskLiveItem(item, gate)).toBe(false);
	});

	test("an item with no tool-use id never matches the card pin", () => {
		const gate = resolveSpecTaskLiveGate([], true, "tu-a");
		expect(isSpecTaskLiveItem(otherBubble("b1"), gate)).toBe(false);
		expect(isSpecTaskLiveItem({ spec: { key: "k", kind: "markdown" } }, gate)).toBe(false);
	});
});
