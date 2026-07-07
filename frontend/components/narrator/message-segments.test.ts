import { describe, expect, test } from "bun:test";
import { mergeStreamingSnapshotBlocks, type StreamingBlock } from "./message-segments";

describe("mergeStreamingSnapshotBlocks", () => {
	test("fills gaps from a snapshot into empty live blocks", () => {
		const blocks: StreamingBlock[] = [];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "text", text: "hello", outputIndex: 0 },
		]);
		expect(changed).toBe(true);
		expect(blocks).toEqual([{ type: "text", text: "hello", outputIndex: 0 }]);
	});

	test("never truncates live text with a shorter/older snapshot", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "hello world", outputIndex: 0 }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "text", text: "hello", outputIndex: 0 },
		]);
		expect(changed).toBe(false);
		expect(blocks[0]).toEqual({ type: "text", text: "hello world", outputIndex: 0 });
	});

	test("adopts a longer snapshot for the same text block", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "hel", outputIndex: 0 }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "text", text: "hello", outputIndex: 0 },
		]);
		expect(changed).toBe(true);
		expect(blocks[0]).toEqual({ type: "text", text: "hello", outputIndex: 0 });
	});

	test("merges text snapshots without outputIndex instead of duplicating them", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "hello world" }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [{ type: "text", text: "hello" }]);
		expect(changed).toBe(false);
		expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
	});

	test("matches reasoning by id and keeps the longer text", () => {
		const blocks: StreamingBlock[] = [{ type: "reasoning", id: "r1", text: "abcd" }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "reasoning", id: "r1", text: "ab" },
		]);
		expect(changed).toBe(false);
		expect(blocks[0]).toEqual({ type: "reasoning", id: "r1", text: "abcd" });
	});

	test("refreshes web_search status from the snapshot", () => {
		const blocks: StreamingBlock[] = [
			{ type: "web_search", id: "s1", status: "in_progress", query: "foo" },
		];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "web_search", id: "s1", status: "completed", query: "foo" },
		]);
		expect(changed).toBe(true);
		expect(blocks[0]).toEqual({
			type: "web_search",
			id: "s1",
			status: "completed",
			query: "foo",
		});
	});

	test("keeps blocks ordered by output index when inserting", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "second", outputIndex: 2 }];
		mergeStreamingSnapshotBlocks(blocks, [{ type: "text", text: "first", outputIndex: 1 }]);
		expect(blocks.map((b) => (b.type === "text" ? b.text : ""))).toEqual(["first", "second"]);
	});
});
