/**
 * useInputHistory.test.ts — the storage side of up-arrow recall.
 *
 * Two properties matter here and neither is about React:
 *
 *  1. An overflowing list is TRIMMED from the oldest end, not dropped. Recall
 *     exists for what the user just typed, so discarding the whole list on
 *     overflow throws away exactly the entries it is for.
 *  2. The write path is shared with the legacy-key migration
 *     (`purgeLegacyNarratorInputStorage`), so an adopted list is subject to the
 *     same limits as a freshly typed one. A second implementation is what would
 *     let the two drift.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { flush, readSession, resetSessionStoreForTest } from "@frontend/lib/session-store";
import { MAX_HISTORY_MESSAGE_CHARS, writeInputHistoryEntries } from "./useInputHistory";

const globalObject = globalThis as typeof globalThis & { sessionStorage?: Storage };
const originalSessionStorage = globalObject.sessionStorage;
let values: Map<string, string>;

beforeEach(() => {
	values = new Map();
	Object.defineProperty(globalObject, "sessionStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			removeItem: (key: string) => {
				values.delete(key);
			},
			setItem: (key: string, value: string) => values.set(key, value),
		} satisfies Storage,
	});
	resetSessionStoreForTest();
});

afterAll(() => {
	if (originalSessionStorage === undefined) {
		Reflect.deleteProperty(globalObject, "sessionStorage");
	} else {
		Object.defineProperty(globalObject, "sessionStorage", {
			configurable: true,
			value: originalSessionStorage,
		});
	}
});

function storedEntries(storageId: string): string[] | null {
	const raw = readSession("narrator-history", storageId);
	if (!raw) return null;
	const parsed: unknown = JSON.parse(raw);
	return Array.isArray(parsed) ? (parsed as string[]) : null;
}

describe("writeInputHistoryEntries", () => {
	test("stores a small list verbatim, newest first", () => {
		writeInputHistoryEntries("u1:n1", ["newest", "older"]);
		flush();
		expect(storedEntries("u1:n1")).toEqual(["newest", "older"]);
	});

	test("drops entries past the per-message ceiling, keeping the rest", () => {
		// A multi-thousand-character body is retrieved from the transcript, not with
		// the up arrow — but its presence must not cost the shorter entries.
		writeInputHistoryEntries("u1:n1", ["short", "x".repeat(MAX_HISTORY_MESSAGE_CHARS + 1)]);
		flush();
		expect(storedEntries("u1:n1")).toEqual(["short"]);
	});

	test("an overflowing list is trimmed from the OLDEST end, not discarded", () => {
		// 50 entries at the per-message ceiling cannot all fit the list budget.
		const entries = Array.from({ length: 50 }, (_, i) =>
			`${i}`.padEnd(MAX_HISTORY_MESSAGE_CHARS, "x"),
		);
		writeInputHistoryEntries("u1:n1", entries);
		flush();
		const stored = storedEntries("u1:n1");
		expect(stored).not.toBeNull();
		// Something was dropped (the budget forced it) …
		expect((stored ?? []).length).toBeLessThan(entries.length);
		// … and what survived starts at the newest entry.
		expect((stored ?? [])[0]).toBe(entries[0]);
	});

	test("an empty list removes the key instead of storing []", () => {
		writeInputHistoryEntries("u1:n1", ["keep"]);
		flush();
		writeInputHistoryEntries("u1:n1", []);
		flush();
		expect(readSession("narrator-history", "u1:n1")).toBeNull();
	});

	test("a list of only oversized entries stores nothing", () => {
		writeInputHistoryEntries("u1:n1", ["x".repeat(MAX_HISTORY_MESSAGE_CHARS + 1)]);
		flush();
		expect(readSession("narrator-history", "u1:n1")).toBeNull();
	});
});
