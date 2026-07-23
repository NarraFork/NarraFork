import { describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { loadPretextDocument } from "./pretext-document-loader";

function message(seq: number): TreeMessage {
	return {
		id: `m-${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text: `message ${seq}` }],
		contentText: `message ${seq}`,
		toolCalls: [],
		createdAt: "2026-07-23T00:00:00.000Z",
		children: [],
		seq,
	} as TreeMessage;
}

function page(start: number, end: number, hasNext: boolean): PretextDocumentPageResult {
	return {
		messages: Array.from({ length: end - start + 1 }, (_, offset) => message(start + offset)),
		minSeq: start,
		maxSeq: end,
		hasNext,
		messageVersion: 7,
	};
}

describe("loadPretextDocument", () => {
	it("collects all transport pages before returning exact-layout input", async () => {
		const requests: Array<{ afterSeq?: number; limit: number }> = [];
		const result = await loadPretextDocument("n1", {
			pageSize: 20,
			fetchPage: async (_id, opts) => {
				requests.push({ afterSeq: opts.afterSeq, limit: opts.limit });
				return opts.afterSeq == null ? page(0, 2, true) : page(opts.afterSeq + 1, 4, false);
			},
		});
		expect(requests).toEqual([
			{ afterSeq: undefined, limit: 20 },
			{ afterSeq: 2, limit: 20 },
		]);
		expect(result.messages.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(result.messageVersion).toBe(7);
	});

	it("rejects overlapping pages instead of silently duplicating scroll items", async () => {
		await expect(
			loadPretextDocument("n1", {
				fetchPage: async (_id, opts) =>
					opts.afterSeq == null ? page(0, 2, true) : page(2, 4, false),
			}),
		).rejects.toThrow("overlap");
	});

	it("fails closed when exact input exceeds the configured safety limit", async () => {
		await expect(
			loadPretextDocument("n1", {
				maxMessages: 2,
				fetchPage: async () => page(0, 2, false),
			}),
		).rejects.toThrow("exact-layout limit");
	});
});
