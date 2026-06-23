import { describe, expect, it } from "bun:test";
import {
	applyUpdatedMessageById,
	type ChunkMutState,
	removeDeletedMessagesFromLoaded,
} from "../../frontend/components/narrator/useNarratorChunksWS";
import type { TreeMessage } from "../../frontend/lib/api";

function message(id: string, contentJson: unknown[], children: TreeMessage[] = []): TreeMessage {
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role: "system",
		contentJson: contentJson as TreeMessage["contentJson"],
		contentText: null,
		toolCalls: [],
		createdAt: "2025-01-01T00:00:00.000Z",
		children,
	};
}

function state(messages: TreeMessage[]): ChunkMutState {
	return {
		loaded: new Map([["chunk-1", messages]]),
		manifest: [
			{ id: "chunk-1", firstSeq: 0, lastSeq: messages.length - 1, count: messages.length },
		],
		total: messages.length,
	};
}

describe("chunk message local updates", () => {
	it("同 id compact 完成消息应立即更新已加载标记内容", () => {
		const compacting = message("compact-1", [
			{ type: "compact", status: "compacting", summary: "" },
		]);
		const s = state([compacting, message("m1", [{ type: "text", text: "after" }])]);

		const next = applyUpdatedMessageById(
			s,
			message("compact-1", [{ type: "compact", status: "compacted", summary: "done" }]),
		);

		expect(next).not.toBe(s);
		const updated = next.loaded.get("chunk-1")?.[0];
		expect(updated?.contentJson?.[0]?.status).toBe("compacted");
		expect(updated?.contentJson?.[0]?.summary).toBe("done");
	});

	it("删除事件应立即从已加载 chunk 中移除标记", () => {
		const compacted = message("compact-1", [
			{ type: "compact", status: "compacted", summary: "done" },
		]);
		const after = message("m1", [{ type: "text", text: "after" }]);
		const s = state([compacted, after]);

		const next = removeDeletedMessagesFromLoaded(s, ["compact-1"]);

		expect(next.loaded.get("chunk-1")?.map((m) => m.id)).toEqual(["m1"]);
	});

	it("删除事件也会从已加载子消息树中移除目标", () => {
		const child = message("child-1", [{ type: "text", text: "child" }]);
		const parent = message("parent-1", [{ type: "text", text: "parent" }], [child]);
		const s = state([parent]);

		const next = removeDeletedMessagesFromLoaded(s, ["child-1"]);

		expect(next.loaded.get("chunk-1")?.[0]?.children).toEqual([]);
	});
});
