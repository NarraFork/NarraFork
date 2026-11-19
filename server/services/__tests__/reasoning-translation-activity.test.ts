import { describe, expect, test } from "bun:test";
import { readReasoningTranslationActivity } from "@shared/reasoning-translation";
import { ReasoningTranslationActivities } from "../reasoning-translation-activity";

const target = (elementId: string, ownerNarratorId = "author") => ({
	ownerNarratorId,
	messageId: "message",
	blockId: "holder",
	elementId,
});

describe("author-local reasoning completion ranges", () => {
	test("the final sealed summary remains pending until a confirmed successor or response end", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1);
		state.checkpoint("author", target("r"), 1, 1, false);
		expect(state.seal("author", "r", 1, 0, 1)).toBeUndefined();
		expect(state.get("author")?.completedRanges).toEqual([]);
		expect(state.allows(target("r"), 0, 1)).toBe(false);
		expect(state.finish("author")).toEqual(target("r"));
		expect(state.completedRanges(target("r"))).toEqual([{ start: 0, end: 1 }]);
	});

	test("durable explicit completion releases the full item while its display lane stays active", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "B", 1);
		expect(state.checkpoint("author", target("B"), 2, 4, true)).toBe(true);
		expect(state.get("author")).toEqual({
			elementId: "B",
			revision: 2,
			completedRanges: [{ start: 0, end: 4 }],
			displayTailStart: 0,
		});
		expect(state.allows(target("B"), 0, 4)).toBe(true);
		expect(state.checkpoint("author", target("B"), 2, 4, true)).toBe(false);
		expect(state.start("author", "C", 1)).toEqual(target("B"));
		expect(state.allows(target("B"), 0, 4)).toBe(true);
		expect(state.get("author")?.elementId).toBe("C");
	});

	test.each([
		false,
		undefined,
	])("a %s completion flag cannot release the active item", (completed) => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1);
		expect(state.checkpoint("author", target("r"), 1, 4, completed)).toBe(false);
		expect(state.ranges(target("r"), 4)).toEqual([]);
		expect(state.get("author")?.displayTailStart).toBe(0);
	});

	test("a checkpoint-only completed item creates a persistent display owner", () => {
		const state = new ReasoningTranslationActivities();
		expect(state.checkpoint("author", target("r"), 2, 4, true)).toBe(true);
		expect(state.allows(target("r"), 0, 4)).toBe(true);
		expect(state.get("author")).toMatchObject({ elementId: "r", displayTailStart: 0 });
	});

	test("completion scopes tolerate absent authors and legacy targets without element IDs", () => {
		const state = new ReasoningTranslationActivities();
		const legacy = { ...target("r"), elementId: undefined };
		expect(state.completedRanges(target("r"))).toBeUndefined();
		expect(state.completedRanges(legacy)).toBeUndefined();
		state.start("author", "r", 1);
		state.checkpoint("author", target("r"), 1, 3, false);
		expect(state.completedRanges(target("r"))).toEqual([]);
		expect(state.completedRanges(legacy)).toBeUndefined();
		state.finish("author");
		expect(state.completedRanges(target("r"))).toEqual([{ start: 0, end: 3 }]);
		expect(state.completedRanges(legacy)).toBeUndefined();
		state.finish("author", true);
		expect(state.completedRanges(legacy)).toBeUndefined();
	});

	test("A/B finish at lane switches while C checkpoints remain active", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "A", 1);
		state.checkpoint("author", target("A"), 1, 4, false);
		expect(state.ranges(target("A"), 4)).toEqual([]);
		expect(state.start("author", "B", 1)).toEqual(target("A"));
		state.checkpoint("author", target("B"), 1, 4, false);
		expect(state.start("author", "C", 1)).toEqual(target("B"));
		state.checkpoint("author", target("C"), 1, 4, false);
		expect(state.ranges(target("A"), 4)).toEqual([{ start: 0, end: 4 }]);
		expect(state.ranges(target("B"), 4)).toEqual([{ start: 0, end: 4 }]);
		expect(state.ranges(target("C"), 4)).toEqual([]);
		expect(state.get("author")).toMatchObject({ elementId: "C", revision: 1 });
		expect(state.finish("author", true)).toEqual(target("C"));
		expect(state.get("author")).toBeNull();
	});

	test("a switched lane completes when its delayed checkpoint acknowledgement lands", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "A", 1);
		state.start("author", "B", 1);
		expect(state.checkpoint("author", target("A"), 1, 3, false)).toBe(true);
		expect(state.get("author")?.elementId).toBe("B");
		expect(state.allows(target("A"), 0, 3)).toBe(true);
		expect(state.allows(target("B"), 0, 3)).toBe(false);
	});

	test("sealed summary prefixes permit only acknowledged exact ranges", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 3, 0, { id: "A", index: 0 });
		state.checkpoint("author", target("r"), 3, 12, false);
		expect(state.seal("author", "r", 2, 0, 4, { id: "A", index: 0 })).toBeUndefined();
		expect(state.seal("author", "r", 3, 0, 4, { id: "A", index: 0 })).toBeUndefined();
		expect(state.start("author", "r", 4, 12, { id: "B", index: 1 })).toEqual(target("r"));
		expect(state.seal("author", "r", 3, 4, 8, { id: "B", index: 1 })).toBeUndefined();
		expect(state.start("author", "r", 5, 12, { id: "C", index: 2 })).toEqual(target("r"));
		expect(state.get("author")?.completedRanges).toEqual([{ start: 0, end: 8 }]);
		expect(state.allows(target("r"), 0, 4)).toBe(true);
		expect(state.allows(target("r"), 8, 12)).toBe(false);
		expect(state.allows(target("historical"), 0, 4)).toBe(true);
	});

	test("late completion cannot close a reopened tail or erase its valid prefix", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1);
		expect(state.checkpoint("author", target("r"), 1, 4, true)).toBe(true);
		state.finish("author");
		state.start("author", "r", 3, 4);
		expect(state.checkpoint("author", target("r"), 2, 4, true)).toBe(false);
		expect(state.get("author")).toEqual({
			elementId: "r",
			revision: 3,
			completedRanges: [{ start: 0, end: 4 }],
			displayTailStart: 0,
		});
		expect(state.allows(target("r"), 0, 4)).toBe(true);
		expect(state.allows(target("r"), 4, 5)).toBe(false);
	});

	test("summary handoff owns the display boundary even after the whole item becomes translatable", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1, 0, { id: "A", index: 0 });
		state.checkpoint("author", target("r"), 1, 3, false);
		state.seal("author", "r", 1, 0, 3, { id: "A", index: 0 });
		state.start("author", "r", 2, 3, { id: "B", index: 1 });
		expect(state.get("author")?.displayTailStart).toBe(3);
		expect(state.checkpoint("author", target("r"), 3, 7, true)).toBe(true);
		expect(state.get("author")).toEqual({
			elementId: "r",
			revision: 3,
			completedRanges: [{ start: 0, end: 7 }],
			displayTailStart: 3,
		});
		const reconnect = readReasoningTranslationActivity(state.get("author"));
		expect(reconnect?.displayTailStart).toBe(3);
		expect(reconnect?.completedRanges).toEqual([{ start: 0, end: 7 }]);
		state.finish("author");
		state.start("author", "r", 4, 7);
		expect(state.get("author")?.displayTailStart).toBe(3);
		expect(state.allows(target("r"), 7, 8)).toBe(false);
	});

	test("append preserves eligible text and rewrite invalidates late checkpoints and summary seals", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1, 0, { id: "A", index: 0 });
		state.checkpoint("author", target("r"), 1, 4, true);
		state.start("author", "r", 2, 4, { id: "B", index: 1 });
		expect(state.allows(target("r"), 0, 4)).toBe(true);
		expect(state.allows(target("r"), 4, 5)).toBe(false);
		expect(state.get("author")?.displayTailStart).toBe(4);
		state.start("author", "r", 3, 1);
		expect(state.get("author")?.displayTailStart).toBe(1);
		expect(state.seal("author", "r", 1, 0, 4, { id: "A", index: 0 })).toBeUndefined();
		expect(state.checkpoint("author", target("r"), 1, 4, true)).toBe(false);
		expect(state.get("author")?.completedRanges).toEqual([{ start: 0, end: 1 }]);
		expect(state.allows(target("r"), 1, 2)).toBe(false);
		state.checkpoint("author", target("r"), 3, 3, false);
		expect(state.allows(target("r"), 1, 3)).toBe(false);
	});

	test("a newer incomplete checkpoint without raw deltas cannot inherit old completion", () => {
		const state = new ReasoningTranslationActivities();
		state.checkpoint("author", target("r"), 1, 4, true);
		expect(state.checkpoint("author", target("r"), 2, 4, false)).toBe(false);
		expect(state.get("author")?.completedRanges).toEqual([]);
		expect(state.allows(target("r"), 0, 4)).toBe(false);
	});

	test("terminal cleanup is authoritative across delayed checkpoints and later real output", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1);
		state.finish("author", true);
		expect(state.checkpoint("author", target("r"), 2, 4, true)).toBe(false);
		expect(state.get("author")).toBeNull();
		expect(state.completedRanges(target("r"))).toBeUndefined();
		state.start("author", "next", 1);
		expect(state.get("author")).toMatchObject({ elementId: "next", displayTailStart: 0 });
	});

	test("only a newer real summary identity releases pending parts; late identities never downgrade it", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1, 0, { id: "A", index: 0 });
		state.checkpoint("author", target("r"), 1, 3, false);
		state.seal("author", "r", 1, 0, 1, { id: "A", index: 0 });
		expect(state.start("author", "r", 2, 3, { id: "B", index: 1 })).toEqual(target("r"));
		state.checkpoint("author", target("r"), 2, 4, false);
		state.seal("author", "r", 2, 3, 4, { id: "B", index: 1 });
		expect(state.allows(target("r"), 3, 4)).toBe(false);
		expect(state.start("author", "r", 3, 4, { id: "B", index: 1 })).toBeUndefined();
		expect(state.start("author", "r", 4, 5, { id: "A", index: 0 })).toBeUndefined();
		expect(state.allows(target("r"), 3, 4)).toBe(false);
		expect(state.start("author", "r", 5, 6, { id: "C", index: 2 })).toEqual(target("r"));
		expect(state.allows(target("r"), 3, 4)).toBe(true);
	});

	test("missing part identity stays conservative until a different lane or terminal event", () => {
		const state = new ReasoningTranslationActivities();
		state.start("author", "r", 1, 0);
		state.checkpoint("author", target("r"), 1, 3, false);
		state.seal("author", "r", 1, 0, 1);
		expect(state.start("author", "r", 2, 3)).toBeUndefined();
		expect(state.get("author")?.completedRanges).toEqual([]);
		state.finish("author");
		expect(state.completedRanges(target("r"))).toEqual([{ start: 0, end: 3 }]);
	});

	test("parent/child activity and completion are isolated", () => {
		const state = new ReasoningTranslationActivities();
		for (const author of ["parent", "child"]) {
			state.start(author, "same-id", 1);
			state.checkpoint(author, target("same-id", author), 1, 3, false);
		}
		state.finish("child", true);
		expect(state.get("parent")?.elementId).toBe("same-id");
		expect(state.allows(target("same-id", "parent"), 0, 3)).toBe(false);
		expect(state.allows(target("same-id", "child"), 0, 3)).toBe(true);
	});

	test("activity decoding accepts only ordered bounded integer ranges", () => {
		const valid = { elementId: "r", revision: 1, completedRanges: [{ start: 0, end: 2 }] };
		expect(readReasoningTranslationActivity(valid)).toEqual(valid);
		expect(readReasoningTranslationActivity(null)).toBeNull();
		expect(readReasoningTranslationActivity({ ...valid, revision: -1 })).toBeNull();
		expect(
			readReasoningTranslationActivity({
				...valid,
				completedRanges: [
					{ start: 2, end: 4 },
					{ start: 1, end: 2 },
				],
			}),
		).toBeNull();
		expect(
			readReasoningTranslationActivity({
				...valid,
				completedRanges: Array(65).fill({ start: 0, end: 1 }),
			}),
		).toBeNull();
	});
});
