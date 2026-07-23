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

function page(
	start: number,
	end: number,
	hasNext: boolean,
	options: {
		messageVersion?: number;
		pruneBoundaryMessageId?: string | null;
		prunedPercent?: number | null;
	} = {},
): PretextDocumentPageResult {
	return {
		messages: Array.from({ length: end - start + 1 }, (_, offset) => message(start + offset)),
		minSeq: start,
		maxSeq: end,
		hasNext,
		messageVersion: options.messageVersion ?? 7,
		pruneBoundaryMessageId: options.pruneBoundaryMessageId ?? null,
		prunedPercent: options.prunedPercent ?? null,
	};
}

describe("loadPretextDocument", () => {
	it("collects all transport pages before returning exact-layout input", async () => {
		const requests: Array<{ afterSeq?: number; limit: number; messageVersion?: number }> = [];
		const result = await loadPretextDocument("n1", {
			pageSize: 20,
			fetchPage: async (_id, opts) => {
				requests.push({
					afterSeq: opts.afterSeq,
					limit: opts.limit,
					messageVersion: opts.messageVersion,
				});
				return opts.afterSeq == null
					? page(0, 2, true, { pruneBoundaryMessageId: "m-2", prunedPercent: 40 })
					: page(opts.afterSeq + 1, 4, false, {
							pruneBoundaryMessageId: "m-2",
							prunedPercent: 40,
						});
			},
		});
		expect(requests).toEqual([
			{ afterSeq: undefined, limit: 20, messageVersion: undefined },
			{ afterSeq: 2, limit: 20, messageVersion: 7 },
		]);
		expect(result.messages.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(result.messageVersion).toBe(7);
		expect(result.pruneBoundaryMessageId).toBe("m-2");
		expect(result.prunedPercent).toBe(40);
	});

	it("rejects pages from a newer document version instead of mixing snapshots", async () => {
		await expect(
			loadPretextDocument("n1", {
				fetchPage: async (_id, opts) =>
					opts.afterSeq == null
						? page(0, 1, true, { messageVersion: 7 })
						: page(2, 3, false, { messageVersion: 8 }),
			}),
		).rejects.toThrow("changed during pagination");
	});

	it("rejects prune metadata that changes within one document version", async () => {
		await expect(
			loadPretextDocument("n1", {
				fetchPage: async (_id, opts) =>
					opts.afterSeq == null
						? page(0, 1, true, { pruneBoundaryMessageId: "m-1", prunedPercent: 20 })
						: page(2, 3, false, { pruneBoundaryMessageId: "m-2", prunedPercent: 40 }),
			}),
		).rejects.toThrow("prune metadata changed");
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
