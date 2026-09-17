import { describe, expect, test } from "bun:test";
import {
	buildToolUseIndex,
	insertChildIntoCache,
	mergeFieldsByIndex,
	removeSubagentStreamingChunk,
	subagentStreamingId,
	updateToolUseIndex,
	upsertStreamingToolBlock,
	upsertSubagentStreamingChunk,
} from "../../frontend/components/narrator/message/message-tree-utils";
import type { TreeMessage } from "../../frontend/lib/api";
import { makeMessage } from "./narrator-timeline.fixtures";

function createBaseCache(): {
	pages: Array<{ messages: TreeMessage[]; hasMore?: boolean; nextCursor?: string | null }>;
	pageParams?: unknown[];
} {
	const parent = makeMessage({
		id: "msg-parent",
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "tu-parent", name: "Task", input: {} }],
		toolCalls: [
			{
				id: "tc-parent",
				toolUseId: "tu-parent",
				toolName: "Task",
				status: "running",
				createdAt: "2025-01-01T00:00:00.000Z",
			},
		],
	});
	return {
		pages: [{ messages: [parent], hasMore: false, nextCursor: null }],
		pageParams: [undefined],
	};
}

describe("message-tree-utils legacy behavior", () => {
	test("mergeFieldsByIndex 同步更新 toolCalls 与 enriched tool_use block", () => {
		const cache = createBaseCache();
		const index = buildToolUseIndex(cache.pages);
		const updated = mergeFieldsByIndex(
			cache,
			"tu-parent",
			{ status: "success", outputJson: { ok: true } },
			index,
		);

		const msg = updated.pages[0].messages[0];
		expect(msg.toolCalls[0].status).toBe("success");
		expect(msg.toolCalls[0].outputJson).toEqual({ ok: true });

		const block = msg.contentJson.find((b) => b.type === "tool_use" && b.id === "tu-parent");
		expect(block?.status).toBe("success");
		expect(block?.outputJson).toEqual({ ok: true });
	});

	test("updateToolUseIndex 在增量页面更新时保留旧索引并加入新 toolUseId", () => {
		const cache = createBaseCache();
		const prevPages = cache.pages;
		const prevIndex = buildToolUseIndex(prevPages);

		const nextMsg = makeMessage({
			id: "msg-next",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu-next", name: "Bash", input: {} }],
			toolCalls: [
				{
					toolUseId: "tu-next",
					toolName: "Bash",
					status: "running",
					createdAt: "2025-01-01T00:00:00.000Z",
				},
			],
		});
		const newPages = [{ ...prevPages[0], messages: [...prevPages[0].messages, nextMsg] }];

		const nextIndex = updateToolUseIndex(prevIndex, prevPages, newPages);
		expect(nextIndex.get("tu-parent")?.path).toEqual([0]);
		expect(nextIndex.get("tu-next")?.path).toEqual([1]);
	});

	test("insertChildIntoCache 依据 parentToolUseId 挂载子消息", () => {
		const cache = createBaseCache();
		const index = buildToolUseIndex(cache.pages);
		const child = makeMessage({
			id: "child-1",
			narratorId: "n-sub",
			parentToolUseId: "tu-parent",
			role: "assistant",
			contentJson: [{ type: "text", text: "child" }],
		});

		const updated = insertChildIntoCache(cache, child, index);
		expect(updated.pages[0].messages[0].children.map((m: TreeMessage) => m.id)).toEqual([
			"child-1",
		]);
	});

	test("upsertSubagentStreamingChunk 可重复更新同一 synthetic child 并支持移除", () => {
		let cache = createBaseCache();
		let index = buildToolUseIndex(cache.pages);

		cache = upsertSubagentStreamingChunk(
			cache,
			"tu-parent",
			"n-main",
			"tu-sub-1",
			"Write",
			12,
			index,
		);
		const syntheticId = subagentStreamingId("tu-parent");
		let child = cache.pages[0].messages[0].children.find((m) => m.id === syntheticId);
		expect(child).toBeDefined();
		expect(child?.toolCalls).toHaveLength(1);
		expect((child?.toolCalls[0].inputJson as { _streamingChars: number })._streamingChars).toBe(12);

		index = buildToolUseIndex(cache.pages);
		cache = upsertSubagentStreamingChunk(
			cache,
			"tu-parent",
			"n-main",
			"tu-sub-1",
			"Write",
			24,
			index,
		);
		child = cache.pages[0].messages[0].children.find((m) => m.id === syntheticId);
		expect(child?.toolCalls).toHaveLength(1);
		expect((child?.toolCalls[0].inputJson as { _streamingChars: number })._streamingChars).toBe(24);

		cache = removeSubagentStreamingChunk(cache, "tu-parent", index);
		expect(cache.pages[0].messages[0].children.find((m) => m.id === syntheticId)).toBeUndefined();
	});

	test("upsertStreamingToolBlock 对同一 toolUseId 不重复追加", () => {
		let blocks: Array<{
			type: string;
			id?: string;
			name?: string;
			input?: Record<string, unknown>;
		}> = [];
		let calls: Array<{
			toolUseId: string;
			toolName: string;
			inputJson?: unknown;
			status?: string;
		}> = [];

		({ blocks, toolCalls: calls } = upsertStreamingToolBlock(blocks, calls, "tu-1", "Edit", {
			_streamingChars: 5,
		}));
		expect(blocks).toHaveLength(1);
		expect(calls).toHaveLength(1);

		({ blocks, toolCalls: calls } = upsertStreamingToolBlock(blocks, calls, "tu-1", "Edit", {
			_streamingChars: 8,
		}));
		expect(blocks).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect((calls[0].inputJson as { _streamingChars: number })._streamingChars).toBe(8);
	});
});
