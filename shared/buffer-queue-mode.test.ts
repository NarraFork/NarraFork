import { describe, expect, test } from "bun:test";
import {
	bufferedModePatch,
	ordinaryBufferReorder,
	resolveBufferQueueMode,
} from "./buffer-queue-mode";

const row = (id: string, seq: number, priority = false, queueMode?: string) => ({
	id,
	seq,
	priority,
	metadataJson: JSON.stringify({
		stagingId: "owned",
		queueMode,
		executionIntent: { controlCommand: true },
	}),
});

describe("buffer queue mode kernel shared by SQLite and PostgreSQL", () => {
	test("legacy fallback and unknown metadata stay deterministic", () => {
		expect(resolveBufferQueueMode(undefined, false)).toBe("turn");
		expect(resolveBufferQueueMode(undefined, true)).toBe("tool");
		expect(resolveBufferQueueMode("interrupt", false)).toBe("interrupt");
		expect(resolveBufferQueueMode("future-mode", true)).toBe("tool");
	});
	test("mode-only updates retain ownership and execution intent", () => {
		const ordinary = row("a", 1);
		const guide = row("b", -1, true, "tool");
		const patch = bufferedModePatch(ordinary, [ordinary, guide], "interrupt");
		expect(patch.priority).toBe(true);
		expect(patch.seq).toBeLessThan(guide.seq);
		expect(JSON.parse(patch.metadataJson)).toEqual({
			stagingId: "owned",
			queueMode: "interrupt",
			executionIntent: { controlCommand: true },
		});
		expect(bufferedModePatch(guide, [ordinary, guide], "interrupt").seq).toBeLessThan(guide.seq);
		expect(bufferedModePatch(guide, [ordinary, guide], "turn").seq).toBeGreaterThan(ordinary.seq);
	});
	test("complete legacy lists and ordinary-only lists cannot reorder guidance", () => {
		const rows = [
			row("a", 1),
			row("b", -1, true, "tool"),
			row("c", 2),
			row("d", 0, true, "interrupt"),
		];
		expect(ordinaryBufferReorder(rows, ["b", "d", "c", "a"])).toEqual(["c", "a"]);
		expect(ordinaryBufferReorder(rows, ["c", "a"])).toEqual(["c", "a"]);
		expect(ordinaryBufferReorder(rows, ["d", "b", "a", "c"])).toBeNull();
		expect(ordinaryBufferReorder(rows, ["b", "a", "d", "c"])).toBeNull();
		expect(ordinaryBufferReorder(rows, ["c", "c"])).toBeNull();
	});
});
