/**
 * Regression guards for the cross-switch document cache.
 *
 * The behaviours pinned here are the ones whose absence produced the bug this
 * cache fixes (a full tail refetch + cold measure on every narrator switch) or
 * would introduce a worse one (restoring an empty/stale window over a live one).
 */

import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { createPretextDocumentCache } from "./pretext-document-cache";
import type { PretextDocumentInput } from "./pretext-document-loader";

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

function input(
	seqs: readonly number[],
	overrides: Partial<PretextDocumentInput> = {},
): PretextDocumentInput {
	const messages = seqs.map(message);
	return {
		messages,
		messageVersion: 7,
		oldestLoadedSeq: messages.length > 0 ? Math.min(...seqs) : null,
		hasPrev: false,
		...overrides,
	};
}

describe("createPretextDocumentCache", () => {
	it("round-trips a written document by narrator", () => {
		const cache = createPretextDocumentCache();
		const document = input([1, 2, 3]);
		cache.write({ narratorId: "n1", input: document });
		expect(cache.peek("n1")).toBe(document);
	});

	it("peek is non-destructive so StrictMode's second mount still hits", () => {
		const cache = createPretextDocumentCache();
		cache.write({ narratorId: "n1", input: input([1]) });
		expect(cache.peek("n1")).not.toBeNull();
		expect(cache.peek("n1")).not.toBeNull();
	});

	it("misses for an unknown narrator and for an empty id", () => {
		const cache = createPretextDocumentCache();
		cache.write({ narratorId: "n1", input: input([1]) });
		expect(cache.peek("n2")).toBeNull();
		expect(cache.peek("")).toBeNull();
	});

	it("refuses to cache an unfinished load, and clears any predecessor", () => {
		// Restoring an empty window would paint an empty conversation AND suppress
		// the fetch that fills it — strictly worse than a cold load.
		const cache = createPretextDocumentCache();
		cache.write({ narratorId: "n1", input: input([1, 2]) });
		cache.write({ narratorId: "n1", input: input([]) });
		expect(cache.peek("n1")).toBeNull();
	});

	it("refuses a zero messageVersion (never-committed document)", () => {
		const cache = createPretextDocumentCache();
		cache.write({ narratorId: "n1", input: input([1], { messageVersion: 0 }) });
		expect(cache.peek("n1")).toBeNull();
	});

	it("expires entries past the TTL", () => {
		let clock = 1_000;
		const cache = createPretextDocumentCache({ ttlMs: 500 }, () => clock);
		cache.write({ narratorId: "n1", input: input([1]) });
		clock += 400;
		expect(cache.peek("n1")).not.toBeNull();
		clock += 200;
		expect(cache.peek("n1")).toBeNull();
	});

	it("evicts the least recently used narrator beyond maxEntries", () => {
		const cache = createPretextDocumentCache({ maxEntries: 2 });
		cache.write({ narratorId: "n1", input: input([1]) });
		cache.write({ narratorId: "n2", input: input([2]) });
		// Touch n1 so n2 becomes the least recently used.
		cache.peek("n1");
		cache.write({ narratorId: "n3", input: input([3]) });
		expect(cache.peek("n1")).not.toBeNull();
		expect(cache.peek("n2")).toBeNull();
		expect(cache.peek("n3")).not.toBeNull();
	});

	it("keeps the newer version when two holders write the same narrator", () => {
		// The workspace preview and the full conversation both write on unmount; a
		// preview must not clobber the real view.
		const cache = createPretextDocumentCache();
		const newer = input([1, 2, 3], { messageVersion: 9 });
		cache.write({ narratorId: "n1", input: newer });
		cache.write({ narratorId: "n1", input: input([1], { messageVersion: 4 }) });
		expect(cache.peek("n1")).toBe(newer);
	});

	it("keeps the wider window when versions match", () => {
		const cache = createPretextDocumentCache();
		const wide = input([1, 2, 3, 4]);
		cache.write({ narratorId: "n1", input: wide });
		cache.write({ narratorId: "n1", input: input([4]) });
		expect(cache.peek("n1")).toBe(wide);
	});

	it("truncates to the newest messages and reopens upward paging", () => {
		// Dropping older history is only safe if the view still offers to load it,
		// and if the reverse-scroll cursor describes the retained head.
		const cache = createPretextDocumentCache({ maxMessages: 2 });
		cache.write({ narratorId: "n1", input: input([1, 2, 3, 4]) });
		const restored = cache.peek("n1");
		expect(restored?.messages.map((item) => item.seq)).toEqual([3, 4]);
		expect(restored?.hasPrev).toBe(true);
		expect(restored?.oldestLoadedSeq).toBe(3);
	});

	it("leaves a within-budget document untouched by reference", () => {
		const cache = createPretextDocumentCache({ maxMessages: 10 });
		const document = input([1, 2], { hasPrev: false });
		cache.write({ narratorId: "n1", input: document });
		expect(cache.peek("n1")).toBe(document);
	});

	it("invalidate drops a single narrator, clear drops everything", () => {
		const cache = createPretextDocumentCache();
		cache.write({ narratorId: "n1", input: input([1]) });
		cache.write({ narratorId: "n2", input: input([2]) });
		cache.invalidate("n1");
		expect(cache.peek("n1")).toBeNull();
		expect(cache.peek("n2")).not.toBeNull();
		cache.clear();
		expect(cache.peek("n2")).toBeNull();
	});

	it("reports entry and message counts", () => {
		const cache = createPretextDocumentCache();
		cache.write({ narratorId: "n1", input: input([1, 2]) });
		cache.write({ narratorId: "n2", input: input([3]) });
		expect(cache.stats()).toEqual({ entries: 2, messages: 3 });
	});
});
