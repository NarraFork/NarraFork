/**
 * The chapter write store's selection rules (`store.ts`).
 *
 * Mirrors `services/knowledge/__tests__/store-wiring.test.ts`: the pure resolver is
 * driven with explicit configurations, so the fail-closed rules are pinned without
 * re-importing modules under different environments:
 *
 *   - absent/aliased/unknown values resolve to the SQLite store;
 *   - an explicit `postgres` without an injected store THROWS (never a silent
 *     fallback onto a different database than the operator configured);
 *   - an explicit `postgres` with an injected store returns that store;
 *   - a read/write mismatch THROWS — one process must read and write the same
 *     database.
 */
import { describe, expect, test } from "bun:test";
import { sqliteChapterWriteStore } from "../sqlite-write-store";
import { resolveChapterWriteStore } from "../store";
import type { ChapterWriteStore } from "../write-store";

const fakePgStore = { backendId: "postgres" } as unknown as ChapterWriteStore;

describe("chapter write store wiring", () => {
	test("absent, aliased and unknown values fail closed to SQLite", () => {
		for (const writeBackend of [
			undefined,
			"",
			"sqlite",
			"sqlite3",
			"bun-sqlite",
			"POSTGRES",
			"pg",
		]) {
			expect(resolveChapterWriteStore({ writeBackend }, undefined)).toBe(sqliteChapterWriteStore);
		}
	});

	test("an explicit postgres without an injected store throws", () => {
		expect(() => resolveChapterWriteStore({ writeBackend: "postgres" }, undefined)).toThrow(
			/unavailable/,
		);
	});

	test("an explicit postgres with an injected store resolves to it", () => {
		expect(
			resolveChapterWriteStore({ writeBackend: "postgres", readBackend: "postgres" }, fakePgStore),
		).toBe(fakePgStore);
	});

	test("a read/write mismatch is a loud error, not a quiet data fork", () => {
		expect(() =>
			resolveChapterWriteStore({ writeBackend: "postgres", readBackend: "sqlite" }, fakePgStore),
		).toThrow(/does not match/);
		expect(() =>
			resolveChapterWriteStore({ writeBackend: "sqlite", readBackend: "postgres" }, fakePgStore),
		).toThrow(/does not match/);
	});
});
