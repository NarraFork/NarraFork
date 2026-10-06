/**
 * shiki-token-cache.test.ts — Contract tests for the subscribable token cache.
 *
 * The cache is what makes highlighting safe to request from a React render pass,
 * so the properties under test are the ones the render path depends on:
 *   - a miss triggers exactly ONE load, no matter how many times it is asked
 *     (strict-mode double invocation, many components, repeated renders)
 *   - the version snapshot only moves when tokens actually land, so
 *     useSyncExternalStore never re-renders spuriously
 *   - LRU reads do not move the version (re-insertion must stay invisible)
 *   - non-highlightable inputs never reach the loader
 *   - eviction holds both the entry and the byte ceiling
 *
 * The loader is injected, so no process-wide module mocking is needed.
 */

import { describe, expect, it } from "bun:test";
import {
	createShikiTokenCache,
	MAX_HIGHLIGHT_CODE_CHARS,
	normalizeThemedTokens,
	type ShikiToken,
	type ShikiTokenLoader,
} from "./shiki-token-cache";

const THEME = "github-dark-default";

interface LoaderProbe {
	loader: ShikiTokenLoader;
	calls: Array<{ code: string; lang: string; theme: string }>;
	/** Resolve the oldest pending load. */
	flush(): Promise<void>;
	/** Resolve every pending load. */
	flushAll(): Promise<void>;
}

/** A loader that records calls and resolves on demand. */
function makeLoader(
	tokensFor: (code: string, lang: string) => ShikiToken[][] | null = (code) => [
		[{ content: code, color: "#abcdef" }],
	],
): LoaderProbe {
	const calls: LoaderProbe["calls"] = [];
	const pending: Array<() => void> = [];
	const loader: ShikiTokenLoader = (code, lang, theme) => {
		calls.push({ code, lang, theme });
		return new Promise((resolve) => {
			pending.push(() => resolve(tokensFor(code, lang)));
		});
	};
	const settle = async () => {
		// Let the cache's .then/.finally chain run to completion.
		for (let i = 0; i < 6; i++) await Promise.resolve();
	};
	return {
		loader,
		calls,
		async flush() {
			pending.shift()?.();
			await settle();
		},
		async flushAll() {
			while (pending.length > 0) pending.shift()?.();
			await settle();
		},
	};
}

describe("shiki token cache", () => {
	it("returns null on first ask and the tokens after the load lands", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);

		expect(cache.get("const a = 1", "typescript", THEME)).toBeNull();
		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]).toEqual({ code: "const a = 1", lang: "typescript", theme: THEME });

		await probe.flushAll();
		expect(cache.get("const a = 1", "typescript", THEME)).toEqual([
			[{ content: "const a = 1", color: "#abcdef" }],
		]);
	});

	it("collapses concurrent asks for the same key into one load", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);

		// Strict-mode double render + a second component + a re-render.
		cache.get("x", "typescript", THEME);
		cache.get("x", "typescript", THEME);
		cache.get("x", "typescript", THEME);
		cache.get("x", "typescript", THEME);
		expect(probe.calls).toHaveLength(1);

		await probe.flushAll();
		// Settled: served from cache, still one load.
		cache.get("x", "typescript", THEME);
		expect(probe.calls).toHaveLength(1);
	});

	it("keys on theme and language separately", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);

		cache.get("x", "typescript", THEME);
		cache.get("x", "typescript", "github-light-default");
		cache.get("x", "python", THEME);
		expect(probe.calls).toHaveLength(3);
		await probe.flushAll();

		expect(cache.get("x", "typescript", THEME)).not.toBeNull();
		expect(cache.get("x", "typescript", "github-light-default")).not.toBeNull();
		expect(cache.get("x", "python", THEME)).not.toBeNull();
	});

	it("never asks the loader for non-highlightable input", () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);

		expect(cache.get("", "typescript", THEME)).toBeNull();
		expect(cache.get("code", undefined, THEME)).toBeNull();
		expect(cache.get("code", "text", THEME)).toBeNull();
		expect(cache.get("a".repeat(MAX_HIGHLIGHT_CODE_CHARS + 1), "typescript", THEME)).toBeNull();
		expect(probe.calls).toHaveLength(0);
	});

	it("cacheOnly reads without triggering a load", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);

		expect(cache.get("y", "typescript", THEME, true)).toBeNull();
		expect(probe.calls).toHaveLength(0);

		cache.get("y", "typescript", THEME);
		await probe.flushAll();
		expect(cache.get("y", "typescript", THEME, true)).not.toBeNull();
		expect(probe.calls).toHaveLength(1);
	});

	it("bumps the version only when tokens land, and notifies subscribers", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);
		let notifications = 0;
		const unsubscribe = cache.subscribe(() => {
			notifications++;
		});

		expect(cache.getVersion()).toBe(0);
		cache.get("a", "typescript", THEME);
		// Requested but not settled: no version movement, no notification.
		expect(cache.getVersion()).toBe(0);
		expect(notifications).toBe(0);

		await probe.flushAll();
		expect(cache.getVersion()).toBe(1);
		expect(notifications).toBe(1);

		// A cache HIT re-inserts the entry (LRU) — that must stay invisible.
		cache.get("a", "typescript", THEME);
		cache.get("a", "typescript", THEME);
		expect(cache.getVersion()).toBe(1);
		expect(notifications).toBe(1);

		unsubscribe();
		cache.get("b", "typescript", THEME);
		await probe.flushAll();
		expect(cache.getVersion()).toBe(2);
		expect(notifications).toBe(1);
	});

	it("does not bump the version when the loader reports no tokens", async () => {
		const probe = makeLoader(() => null);
		const cache = createShikiTokenCache(probe.loader);

		cache.get("unknown-grammar", "not-a-language", THEME);
		await probe.flushAll();
		expect(cache.getVersion()).toBe(0);
		expect(cache.stats().entries).toBe(0);
	});

	it("survives a rejecting loader and releases the in-flight slot", async () => {
		const calls: string[] = [];
		let attempt = 0;
		const loader: ShikiTokenLoader = async (code) => {
			calls.push(code);
			attempt++;
			if (attempt === 1) throw new Error("chunk load failure");
			return [[{ content: code }]];
		};
		const cache = createShikiTokenCache(loader);

		cache.get("z", "typescript", THEME);
		for (let i = 0; i < 6; i++) await Promise.resolve();
		expect(cache.stats().inFlight).toBe(0);
		expect(cache.getVersion()).toBe(0);

		// The slot was released, so a later ask retries.
		cache.get("z", "typescript", THEME);
		for (let i = 0; i < 6; i++) await Promise.resolve();
		expect(calls).toHaveLength(2);
		expect(cache.get("z", "typescript", THEME)).toEqual([[{ content: "z" }]]);
	});

	it("evicts the least recently used entry past the entry ceiling", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader, { maxEntries: 2 });

		for (const code of ["a", "b"]) {
			cache.get(code, "typescript", THEME);
		}
		await probe.flushAll();
		// Touch "a" so "b" becomes the least recently used.
		expect(cache.get("a", "typescript", THEME)).not.toBeNull();

		cache.get("c", "typescript", THEME);
		await probe.flushAll();
		expect(cache.stats().entries).toBe(2);
		expect(cache.get("a", "typescript", THEME, true)).not.toBeNull();
		expect(cache.get("c", "typescript", THEME, true)).not.toBeNull();
		expect(cache.get("b", "typescript", THEME, true)).toBeNull();
	});

	it("holds the byte ceiling and skips an entry larger than the whole budget", async () => {
		const probe = makeLoader((code) => [[{ content: code }]]);
		const cache = createShikiTokenCache(probe.loader, { maxEntries: 100, maxBytes: 600 });

		for (const code of ["a".repeat(100), "b".repeat(100), "c".repeat(100)]) {
			cache.get(code, "typescript", THEME);
			await probe.flushAll();
		}
		expect(cache.stats().bytes).toBeLessThanOrEqual(600);
		expect(cache.stats().entries).toBeGreaterThan(0);

		// A body whose tokens exceed the entire budget is not cached at all, and
		// must not evict the existing entries on the way through.
		const entriesBefore = cache.stats().entries;
		cache.get("d".repeat(5_000), "typescript", THEME);
		await probe.flushAll();
		expect(cache.get("d".repeat(5_000), "typescript", THEME, true)).toBeNull();
		expect(cache.stats().entries).toBe(entriesBefore);
	});

	it("clear() drops entries, bytes and in-flight slots", async () => {
		const probe = makeLoader();
		const cache = createShikiTokenCache(probe.loader);

		cache.get("a", "typescript", THEME);
		await probe.flushAll();
		cache.get("b", "typescript", THEME); // still in flight
		expect(cache.stats().entries).toBe(1);
		expect(cache.stats().inFlight).toBe(1);

		cache.clear();
		expect(cache.stats()).toEqual({ entries: 0, bytes: 0, inFlight: 0 });
		expect(cache.get("a", "typescript", THEME, true)).toBeNull();
	});
});

describe("normalizeThemedTokens", () => {
	it("keeps content and drops unusable colours", () => {
		expect(
			normalizeThemedTokens([
				[
					{ content: "const", color: "#ff0000" },
					{ content: " ", color: "  " },
					{ content: "a" },
				] as never,
			]),
		).toEqual([[{ content: "const", color: "#ff0000" }, { content: " " }, { content: "a" }]]);
	});

	it("preserves the physical line grouping", () => {
		expect(
			normalizeThemedTokens([[{ content: "a" }], [{ content: "b" }], []] as never),
		).toHaveLength(3);
	});
});
