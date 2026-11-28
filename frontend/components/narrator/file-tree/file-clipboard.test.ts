/**
 * file-clipboard.test.ts — the tree's copy/cut slot.
 *
 * The store is the only state a paste depends on, and a bug here is silent: a cut that is
 * never cleared pastes the same file twice (removing the source the second time it comes
 * from somewhere else), and a copy that is cleared too early makes the second paste fail.
 * So what is pinned is the exact clearing rule plus the subscription the row menu relies on.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearFileClipboard,
	type FileClipboardEntry,
	getFileClipboard,
	setFileClipboard,
	subscribeFileClipboard,
} from "./file-clipboard";

const entry: FileClipboardEntry = {
	mode: "copy",
	path: "/repo/src/a.ts",
	name: "a.ts",
	narratorId: "narrator-a",
};

beforeEach(() => {
	clearFileClipboard();
});

describe("the file clipboard", () => {
	test("starts empty and holds the last entry only", () => {
		expect(getFileClipboard()).toBeNull();
		setFileClipboard(entry);
		expect(getFileClipboard()).toEqual(entry);
		setFileClipboard({ ...entry, mode: "move", name: "b.ts" });
		expect(getFileClipboard()).toMatchObject({ mode: "move", name: "b.ts" });
	});

	test("clearing reports a change only when something was there", () => {
		let calls = 0;
		const unsubscribe = subscribeFileClipboard(() => {
			calls += 1;
		});
		clearFileClipboard();
		expect(calls).toBe(0);
		setFileClipboard(entry);
		expect(calls).toBe(1);
		clearFileClipboard();
		expect(calls).toBe(2);
		unsubscribe();
		setFileClipboard(entry);
		expect(calls).toBe(2);
	});

	test("an unsubscribed listener is not called", () => {
		let calls = 0;
		const unsubscribe = subscribeFileClipboard(() => {
			calls += 1;
		});
		unsubscribe();
		setFileClipboard(entry);
		expect(calls).toBe(0);
	});
});
