import { describe, expect, test } from "bun:test";
import { upsertStreamingToolBlock } from "../../frontend/components/narrator/message/message-tree-utils";

describe("message-tree-utils legacy behavior", () => {
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
