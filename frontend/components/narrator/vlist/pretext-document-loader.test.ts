import { describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import {
	firstScreenPageSizeForLod,
	loadPretextDocument,
	loadPretextDocumentOlder,
	loadPretextDocumentTail,
	type PretextDocumentInput,
} from "./pretext-document-loader";

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
	flags: { hasNext?: boolean; hasPrev?: boolean } = {},
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
		hasNext: flags.hasNext ?? false,
		hasPrev: flags.hasPrev ?? false,
		messageVersion: options.messageVersion ?? 7,
		pruneBoundaryMessageId: options.pruneBoundaryMessageId ?? null,
		prunedPercent: options.prunedPercent ?? null,
	};
}

describe("loadPretextDocumentTail", () => {
	it("loads only the newest page and exposes the reverse-scroll cursor", async () => {
		const requests: Array<{ afterSeq?: number; beforeSeq?: number; limit: number }> = [];
		const result = await loadPretextDocumentTail("n1", {
			pageSize: 50,
			fetchPage: async (_id, opts) => {
				requests.push({ afterSeq: opts.afterSeq, beforeSeq: opts.beforeSeq, limit: opts.limit });
				return page(8, 9, { hasPrev: true }, { pruneBoundaryMessageId: "m-8" });
			},
		});
		// A single tail request with no cursor — never the whole history.
		expect(requests).toEqual([{ afterSeq: undefined, beforeSeq: undefined, limit: 50 }]);
		expect(result.messages.map((item) => item.seq)).toEqual([8, 9]);
		expect(result.oldestLoadedSeq).toBe(8);
		expect(result.hasPrev).toBe(true);
		expect(result.pruneBoundaryMessageId).toBe("m-8");
	});

	it("rejects an invalid message version", async () => {
		await expect(
			loadPretextDocumentTail("n1", {
				fetchPage: async () => page(0, 1, {}, { messageVersion: -1 }),
			}),
		).rejects.toThrow("invalid message version");
	});

	it("uses firstScreenPageSize for the tail request when provided", async () => {
		let limit = 0;
		await loadPretextDocumentTail("n1", {
			firstScreenPageSize: 40,
			pageSize: 100,
			fetchPage: async (_id, opts) => {
				limit = opts.limit;
				return page(60, 99, { hasPrev: true });
			},
		});
		// firstScreenPageSize wins over pageSize for the first screen.
		expect(limit).toBe(40);
	});

	it("falls back to pageSize for the tail when no firstScreenPageSize is set", async () => {
		let limit = 0;
		await loadPretextDocumentTail("n1", {
			pageSize: 50,
			fetchPage: async (_id, opts) => {
				limit = opts.limit;
				return page(50, 99, { hasPrev: true });
			},
		});
		expect(limit).toBe(50);
	});
});

describe("firstScreenPageSizeForLod", () => {
	it("returns a large page for low LOD (collapsed cards need many, but measure cheap)", () => {
		expect(firstScreenPageSizeForLod(1)).toBe(100);
		expect(firstScreenPageSizeForLod(2)).toBe(100);
		expect(firstScreenPageSizeForLod(3)).toBe(100);
	});

	it("caps the page at high LOD (expanded cards are tall + expensive to measure)", () => {
		expect(firstScreenPageSizeForLod(4)).toBe(40);
		expect(firstScreenPageSizeForLod(5)).toBe(40);
		expect(firstScreenPageSizeForLod(6)).toBe(40);
	});
});

describe("loadPretextDocumentOlder", () => {
	const base: PretextDocumentInput = {
		messages: [message(8), message(9)],
		messageVersion: 7,
		pruneBoundaryMessageId: "m-8",
		prunedPercent: 40,
		oldestLoadedSeq: 8,
		hasPrev: true,
	};

	it("prepends the older page using beforeSeq and advances the cursor", async () => {
		const requests: Array<{ beforeSeq?: number; messageVersion?: number }> = [];
		const next = await loadPretextDocumentOlder("n1", base, {
			pageSize: 50,
			fetchPage: async (_id, opts) => {
				requests.push({ beforeSeq: opts.beforeSeq, messageVersion: opts.messageVersion });
				return page(6, 7, { hasPrev: true }, { pruneBoundaryMessageId: "m-8", prunedPercent: 40 });
			},
		});
		expect(requests).toEqual([{ beforeSeq: 8, messageVersion: 7 }]);
		expect(next.messages.map((item) => item.seq)).toEqual([6, 7, 8, 9]);
		expect(next.oldestLoadedSeq).toBe(6);
		expect(next.hasPrev).toBe(true);
	});

	it("closes the upward window when the server returns no older rows", async () => {
		const next = await loadPretextDocumentOlder("n1", base, {
			fetchPage: async () => ({
				messages: [],
				minSeq: null,
				maxSeq: null,
				hasNext: true,
				hasPrev: false,
				messageVersion: 7,
				pruneBoundaryMessageId: "m-8",
				prunedPercent: 40,
			}),
		});
		expect(next.messages.map((item) => item.seq)).toEqual([8, 9]);
		expect(next.hasPrev).toBe(false);
	});

	it("no-ops when there is nothing older to load", async () => {
		let called = false;
		const next = await loadPretextDocumentOlder(
			"n1",
			{ ...base, hasPrev: false },
			{
				fetchPage: async () => {
					called = true;
					return page(6, 7, {});
				},
			},
		);
		expect(called).toBe(false);
		expect(next.hasPrev).toBe(false);
		expect(next.messages.map((item) => item.seq)).toEqual([8, 9]);
	});

	it("rejects a page from a different document version", async () => {
		await expect(
			loadPretextDocumentOlder("n1", base, {
				fetchPage: async () => page(6, 7, { hasPrev: true }, { messageVersion: 8 }),
			}),
		).rejects.toThrow("changed during pagination");
	});

	it("rejects prune metadata drift", async () => {
		await expect(
			loadPretextDocumentOlder("n1", base, {
				fetchPage: async () =>
					page(6, 7, { hasPrev: true }, { pruneBoundaryMessageId: "m-6", prunedPercent: 10 }),
			}),
		).rejects.toThrow("prune metadata changed");
	});

	it("rejects an older page that overlaps the loaded window", async () => {
		await expect(
			loadPretextDocumentOlder("n1", base, {
				// maxSeq 8 is not strictly older than oldestLoadedSeq 8.
				fetchPage: async () =>
					page(7, 8, { hasPrev: true }, { pruneBoundaryMessageId: "m-8", prunedPercent: 40 }),
			}),
		).rejects.toThrow("overlap");
	});

	it("fails closed when the loaded window exceeds the safety limit", async () => {
		await expect(
			loadPretextDocumentOlder("n1", base, {
				maxMessages: 3,
				fetchPage: async () =>
					page(4, 7, { hasPrev: true }, { pruneBoundaryMessageId: "m-8", prunedPercent: 40 }),
			}),
		).rejects.toThrow("exact-layout limit");
	});
});

describe("loadPretextDocument (full fallback)", () => {
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
				return opts.afterSeq != null && opts.afterSeq < 0
					? page(0, 2, { hasNext: true }, { pruneBoundaryMessageId: "m-2", prunedPercent: 40 })
					: page(
							(opts.afterSeq ?? 0) + 1,
							4,
							{},
							{ pruneBoundaryMessageId: "m-2", prunedPercent: 40 },
						);
			},
		});
		expect(requests).toEqual([
			{ afterSeq: -1, limit: 20, messageVersion: undefined },
			{ afterSeq: 2, limit: 20, messageVersion: 7 },
		]);
		expect(result.messages.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(result.messageVersion).toBe(7);
		expect(result.pruneBoundaryMessageId).toBe("m-2");
		expect(result.prunedPercent).toBe(40);
		expect(result.hasPrev).toBe(false);
	});

	it("rejects pages from a newer document version instead of mixing snapshots", async () => {
		await expect(
			loadPretextDocument("n1", {
				fetchPage: async (_id, opts) =>
					(opts.afterSeq ?? -1) < 0
						? page(0, 1, { hasNext: true }, { messageVersion: 7 })
						: page(2, 3, {}, { messageVersion: 8 }),
			}),
		).rejects.toThrow("changed during pagination");
	});

	it("rejects overlapping pages instead of silently duplicating scroll items", async () => {
		await expect(
			loadPretextDocument("n1", {
				fetchPage: async (_id, opts) =>
					(opts.afterSeq ?? -1) < 0 ? page(0, 2, { hasNext: true }) : page(2, 4, {}),
			}),
		).rejects.toThrow("overlap");
	});

	it("fails closed when exact input exceeds the configured safety limit", async () => {
		await expect(
			loadPretextDocument("n1", {
				maxMessages: 2,
				fetchPage: async () => page(0, 2, {}),
			}),
		).rejects.toThrow("exact-layout limit");
	});
});
