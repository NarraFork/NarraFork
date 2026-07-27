import { describe, expect, test } from "bun:test";
import type { ChunkManifestEntry, TreeMessage } from "../../lib/api";
import { type CachedChunkSnapshot, createNarratorChunksCache } from "./narrator-chunks-cache";

function message(id: string, seq: number): TreeMessage {
	return { id, seq, role: "assistant" } as unknown as TreeMessage;
}

/** Build a tail-anchored snapshot of `chunkCount` chunks, `perChunk` messages each. */
function snapshot(options: {
	narratorId?: string;
	chunkCount: number;
	perChunk?: number;
	messageVersion?: number;
	/** Chunk indices (0-based) whose content is NOT loaded. */
	unloaded?: number[];
	hasOlderChunks?: boolean;
}): CachedChunkSnapshot {
	const {
		narratorId = "n1",
		chunkCount,
		perChunk = 2,
		messageVersion = 1,
		unloaded = [],
		hasOlderChunks = false,
	} = options;
	const manifest: ChunkManifestEntry[] = [];
	const loaded = new Map<string, TreeMessage[]>();
	const skip = new Set(unloaded);
	for (let i = 0; i < chunkCount; i++) {
		const firstSeq = i * perChunk + 1;
		const id = `c${i}`;
		manifest.push({ id, firstSeq, lastSeq: firstSeq + perChunk - 1, count: perChunk });
		if (skip.has(i)) continue;
		loaded.set(
			id,
			Array.from({ length: perChunk }, (_, j) => message(`${id}-m${j}`, firstSeq + j)),
		);
	}
	return {
		narratorId,
		manifest,
		loaded,
		total: chunkCount * perChunk,
		messageVersion,
		hasOlderChunks,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
	};
}

describe("narrator chunks cache validity gate", () => {
	test("does not cache a snapshot whose initial load never committed", () => {
		const cache = createNarratorChunksCache();

		// StrictMode's throwaway first mount, or an unmount mid-initial-load.
		cache.write({
			narratorId: "n1",
			manifest: [],
			loaded: new Map(),
			total: 0,
			messageVersion: 0,
			hasOlderChunks: false,
			pruneBoundaryMessageId: null,
			prunedPercent: null,
		});
		expect(cache.peek("n1")).toBeNull();

		// A manifest without a server version is equally unusable.
		cache.write(snapshot({ chunkCount: 2, messageVersion: 0 }));
		expect(cache.peek("n1")).toBeNull();

		cache.write(snapshot({ chunkCount: 2, messageVersion: 7 }));
		expect(cache.peek("n1")?.messageVersion).toBe(7);
	});

	test("an unusable snapshot drops a previously cached entry", () => {
		const cache = createNarratorChunksCache();
		cache.write(snapshot({ chunkCount: 2, messageVersion: 4 }));
		expect(cache.peek("n1")).not.toBeNull();

		// e.g. the narrator was reset/deleted and the hook unmounts with empty state.
		cache.write(snapshot({ chunkCount: 0, messageVersion: 0 }));
		expect(cache.peek("n1")).toBeNull();
	});

	test("peek is non-destructive so a StrictMode double mount both restore", () => {
		const cache = createNarratorChunksCache();
		cache.write(snapshot({ chunkCount: 2, messageVersion: 3 }));

		expect(cache.peek("n1")?.messageVersion).toBe(3);
		expect(cache.peek("n1")?.messageVersion).toBe(3);
	});
});

describe("narrator chunks cache write precedence", () => {
	test("a newer server version always wins", () => {
		const cache = createNarratorChunksCache();
		cache.write(snapshot({ chunkCount: 5, messageVersion: 9 }));

		cache.write(snapshot({ chunkCount: 5, messageVersion: 4 }));
		expect(cache.peek("n1")?.messageVersion).toBe(9);

		cache.write(snapshot({ chunkCount: 5, messageVersion: 10 }));
		expect(cache.peek("n1")?.messageVersion).toBe(10);
	});

	test("at equal versions a narrow preview cannot clobber the full window", () => {
		const cache = createNarratorChunksCache();
		cache.write(snapshot({ chunkCount: 8, messageVersion: 2 }));

		// The workspace chunk preview holds a tail-only window for the same narrator.
		cache.write(snapshot({ chunkCount: 1, messageVersion: 2 }));
		expect(cache.peek("n1")?.manifest).toHaveLength(8);

		cache.write(snapshot({ chunkCount: 12, messageVersion: 2 }));
		expect(cache.peek("n1")?.manifest).toHaveLength(12);
	});

	test("at an equal window size the snapshot with more loaded content wins", () => {
		const cache = createNarratorChunksCache();
		cache.write(snapshot({ chunkCount: 4, messageVersion: 2, unloaded: [0, 1, 2] }));
		expect(cache.peek("n1")?.loaded.size).toBe(1);

		cache.write(snapshot({ chunkCount: 4, messageVersion: 2 }));
		expect(cache.peek("n1")?.loaded.size).toBe(4);

		cache.write(snapshot({ chunkCount: 4, messageVersion: 2, unloaded: [0, 1, 2] }));
		expect(cache.peek("n1")?.loaded.size).toBe(4);
	});
});

describe("narrator chunks cache truncation", () => {
	test("keeps the newest chunks and flags that older history was dropped", () => {
		const cache = createNarratorChunksCache({ maxChunks: 3 });
		cache.write(snapshot({ chunkCount: 10, perChunk: 1, messageVersion: 1 }));

		const restored = cache.peek("n1");
		expect(restored?.manifest.map((c) => c.id)).toEqual(["c7", "c8", "c9"]);
		// Tail-anchored and contiguous, so reconcile's backward diff still aligns.
		expect(restored?.manifest[2].lastSeq).toBe(10);
		expect(restored?.hasOlderChunks).toBeTrue();
		expect([...(restored?.loaded.keys() ?? [])]).toEqual(["c7", "c8", "c9"]);
	});

	test("caps retained messages while keeping whole chunks", () => {
		const cache = createNarratorChunksCache({ maxMessages: 5 });
		cache.write(snapshot({ chunkCount: 10, perChunk: 2, messageVersion: 1 }));

		const restored = cache.peek("n1");
		// Chunks are kept whole: 2 messages each, so 5 allows 2 chunks (4 messages);
		// a third would exceed the budget.
		expect(restored?.manifest.map((c) => c.id)).toEqual(["c8", "c9"]);
		expect(cache.stats().messages).toBe(4);
		expect(restored?.hasOlderChunks).toBeTrue();
	});

	test("retains a single oversized tail chunk rather than caching nothing", () => {
		const cache = createNarratorChunksCache({ maxMessages: 3 });
		cache.write(snapshot({ chunkCount: 3, perChunk: 10, messageVersion: 1 }));

		const restored = cache.peek("n1");
		expect(restored?.manifest.map((c) => c.id)).toEqual(["c2"]);
		expect(restored?.loaded.get("c2")).toHaveLength(10);
	});

	test("leaves a within-budget snapshot untouched by reference", () => {
		const cache = createNarratorChunksCache({ maxChunks: 10, maxMessages: 100 });
		const original = snapshot({ chunkCount: 3, messageVersion: 1 });
		cache.write(original);

		const restored = cache.peek("n1");
		expect(restored).toBe(original);
		expect(restored?.hasOlderChunks).toBeFalse();
	});

	test("does not resurrect loaded data for chunks outside the kept window", () => {
		const cache = createNarratorChunksCache({ maxChunks: 2 });
		cache.write(snapshot({ chunkCount: 6, perChunk: 1, messageVersion: 1 }));

		const restored = cache.peek("n1");
		const manifestIds = new Set(restored?.manifest.map((c) => c.id));
		for (const chunkId of restored?.loaded.keys() ?? []) {
			expect(manifestIds.has(chunkId)).toBeTrue();
		}
	});
});

describe("narrator chunks cache eviction", () => {
	test("evicts the least recently used narrator beyond the entry limit", () => {
		const cache = createNarratorChunksCache({ maxEntries: 2 });
		cache.write(snapshot({ narratorId: "a", chunkCount: 1 }));
		cache.write(snapshot({ narratorId: "b", chunkCount: 1 }));

		// Reading `a` makes `b` the least recently used.
		expect(cache.peek("a")).not.toBeNull();
		cache.write(snapshot({ narratorId: "c", chunkCount: 1 }));

		expect(cache.peek("b")).toBeNull();
		expect(cache.peek("a")).not.toBeNull();
		expect(cache.peek("c")).not.toBeNull();
		expect(cache.stats().entries).toBe(2);
	});

	test("treats an entry past its TTL as a miss and drops it", () => {
		let clock = 1_000;
		const cache = createNarratorChunksCache({ ttlMs: 500 }, () => clock);
		cache.write(snapshot({ chunkCount: 2 }));

		clock += 499;
		expect(cache.peek("n1")).not.toBeNull();

		clock += 2;
		expect(cache.peek("n1")).toBeNull();
		expect(cache.stats().entries).toBe(0);
	});

	test("an expired entry does not block a lower-version replacement", () => {
		let clock = 1_000;
		const cache = createNarratorChunksCache({ ttlMs: 500 }, () => clock);
		cache.write(snapshot({ chunkCount: 5, messageVersion: 9 }));

		clock += 1_000;
		cache.write(snapshot({ chunkCount: 1, messageVersion: 2 }));
		expect(cache.peek("n1")?.messageVersion).toBe(2);
	});
});

describe("narrator chunks cache manual clearing", () => {
	test("invalidate drops one narrator and clear drops everything", () => {
		const cache = createNarratorChunksCache();
		cache.write(snapshot({ narratorId: "a", chunkCount: 1 }));
		cache.write(snapshot({ narratorId: "b", chunkCount: 1 }));

		cache.invalidate("a");
		expect(cache.peek("a")).toBeNull();
		expect(cache.peek("b")).not.toBeNull();

		cache.clear();
		expect(cache.peek("b")).toBeNull();
		expect(cache.stats()).toEqual({ entries: 0, messages: 0 });
	});
});
