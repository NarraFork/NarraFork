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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type FileReferenceInput,
	insertFileReference,
} from "@frontend/components/narrator/file-reference-input";
import { flush, readSession, resetSessionStoreForTest } from "@frontend/lib/session-store";
import type { FileReference } from "@shared/file-reference";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	MAX_HISTORY_MESSAGE_CHARS,
	readInputHistoryEntries,
	useInputHistory,
	writeInputHistoryEntries,
} from "./useInputHistory";

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

const reference: FileReference = {
	id: "history-ref",
	deviceId: "RemoteABC",
	path: "/work/a.ts",
	label: "a.ts",
};

describe("file reference history", () => {
	test("reads mixed legacy strings and reference entries without guessing text tokens", () => {
		const state = insertFileReference({ text: "read ", fileReferences: [] }, reference);
		writeInputHistoryEntries("u1:n1", [state, "#file:plain.ts"]);
		expect(readInputHistoryEntries("u1:n1")).toEqual([
			{ text: state.text, fileReferences: state.fileReferences },
			{ text: "#file:plain.ts", fileReferences: [] },
		]);
		expect(readInputHistoryEntries("other-user:n1")).toEqual([]);
	});
	test("never persists snapshots and bounds complete history metadata", () => {
		writeInputHistoryEntries(
			"u1:n1",
			Array.from({ length: 50 }, (_, i) => ({
				text: `entry ${i}`,
				fileReferences: [
					{
						...reference,
						id: String(i),
						path: `/work/${"x".repeat(1800)}`,
						snapshotText: "SERVER ONLY",
					},
				],
			})),
		);
		const raw = readSession("narrator-history", "u1:n1") ?? "";
		expect(raw.length).toBeLessThanOrEqual(24_000);
		expect(raw).not.toContain("snapshotText");
		expect(readInputHistoryEntries("u1:n1")[0]?.text).toBe("entry 0");
	});
});

describe("history hook whole-input navigation", () => {
	let root: Root;
	let host: HTMLElement;
	let history: ReturnType<typeof useInputHistory>;
	let storageKey: string | null;
	const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
	function Harness() {
		history = useInputHistory(storageKey);
		return null;
	}
	beforeEach(async () => {
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		for (const [key, value] of Object.entries({
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
		})) {
			previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		storageKey = "u1:n1";
		await act(async () => root.render(createElement(Harness)));
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
		for (const [key, descriptor] of previousGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		previousGlobals.clear();
	});
	test("push trims without dropping references, then down restores the unsent text and refs", async () => {
		const sent = insertFileReference({ text: "  ", fileReferences: [] }, reference);
		const draft = insertFileReference(
			{ text: "unsent ", fileReferences: [] },
			{ ...reference, id: "unsent-ref", deviceId: "local" },
		);
		await act(async () => history.push(sent.text, sent.fileReferences));
		let recalled: FileReferenceInput | null = null;
		await act(async () => {
			recalled = history.navigateEntry("up", draft.text, draft.fileReferences);
		});
		expect(recalled).toMatchObject({
			text: sent.text.trim(),
			fileReferences: [{ ...reference, inputRange: [0, sent.text.trim().length] }],
		});
		expect(history.isBrowsing).toBe(true);
		await act(async () => {
			recalled = history.navigateEntry("down", "ignored");
		});
		expect(recalled as FileReferenceInput | null).toEqual({
			text: draft.text,
			fileReferences: draft.fileReferences,
		});
		expect(history.isBrowsing).toBe(false);
	});
	test("same text with different device refs is not deduplicated, and legacy navigate still returns text", async () => {
		await act(async () => {
			history.push("same", [reference]);
			history.push("same", [{ ...reference, deviceId: "local" }]);
		});
		expect(readInputHistoryEntries("u1:n1")).toHaveLength(2);
		let value: string | null = null;
		await act(async () => {
			value = history.navigate("up", "draft");
		});
		expect(value as string | null).toBe("same");
		storageKey = "u2:n1";
		await act(async () => root.render(createElement(Harness)));
		expect(history.isBrowsing).toBe(false);
		expect(history.navigateEntry("up", "")).toBeNull();
	});
	test("unknown user scope writes nothing and reference-only messages remain recallable", async () => {
		storageKey = null;
		await act(async () => root.render(createElement(Harness)));
		await act(async () => history.push("", [reference]));
		expect(readInputHistoryEntries("u1:n1")).toEqual([]);
		storageKey = "u1:n1";
		await act(async () => root.render(createElement(Harness)));
		await act(async () => history.push("", [reference]));
		expect(readInputHistoryEntries("u1:n1")).toEqual([{ text: "", fileReferences: [reference] }]);
	});
});
