/**
 * reflection-progress-store.test.ts — The render-only reflection progress store,
 * plus the invariant that makes it necessary: progress must never reach the vlist
 * height model.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearAllReflectionProgress,
	clearReflectionProgress,
	getReflectionProgress,
	setReflectionProgress,
} from "./reflection-progress-store";

const OUTPUT = { phase: "output" as const, thinkingChars: 0, outputChars: 12 };
const THINKING = { phase: "thinking" as const, thinkingChars: 40, outputChars: 0 };

describe("reflection progress store", () => {
	test("stores and reads a gate's progress by requestId", () => {
		clearAllReflectionProgress();
		setReflectionProgress("req-a", THINKING);
		setReflectionProgress("req-b", OUTPUT);

		expect(getReflectionProgress("req-a")).toEqual(THINKING);
		expect(getReflectionProgress("req-b")).toEqual(OUTPUT);
		expect(getReflectionProgress("req-missing")).toBeUndefined();
	});

	test("clears one gate without touching the others", () => {
		clearAllReflectionProgress();
		setReflectionProgress("req-a", THINKING);
		setReflectionProgress("req-b", OUTPUT);

		clearReflectionProgress("req-a");
		expect(getReflectionProgress("req-a")).toBeUndefined();
		expect(getReflectionProgress("req-b")).toEqual(OUTPUT);
	});

	test("clears everything on narrator switch", () => {
		// A provider requestId can legitimately recur across narrators, so a stale
		// entry would otherwise paint one narrator's progress on another's card.
		clearAllReflectionProgress();
		setReflectionProgress("req-a", THINKING);
		setReflectionProgress("req-b", OUTPUT);

		clearAllReflectionProgress();
		expect(getReflectionProgress("req-a")).toBeUndefined();
		expect(getReflectionProgress("req-b")).toBeUndefined();
	});

	test("notifies subscribers only when the snapshot actually moves", () => {
		clearAllReflectionProgress();
		// Subscription goes through useSyncExternalStore in the component; here we
		// verify the de-duplication that backs it by observing stored identity.
		setReflectionProgress("req-a", THINKING);
		const first = getReflectionProgress("req-a");
		setReflectionProgress("req-a", { ...THINKING });
		expect(getReflectionProgress("req-a")).toBe(first); // unchanged → not replaced
		setReflectionProgress("req-a", { ...THINKING, thinkingChars: 41 });
		expect(getReflectionProgress("req-a")).not.toBe(first);
	});

	test("ignores an empty requestId", () => {
		clearAllReflectionProgress();
		setReflectionProgress("", OUTPUT);
		expect(getReflectionProgress("")).toBeUndefined();
	});
});

describe("reflection progress stays off the vlist height model", () => {
	const VLIST_DIR = join(import.meta.dir, "vlist");

	test("no vlist measure module reads the progress store", () => {
		// The store is render-only by design: a gate ticks several times a second, and
		// a measured value that a SERVER event can move would break the list's
		// "committed rows only resize on user action" invariant.
		const measureFiles = [
			"measure/measure-reflection-notice.ts",
			"measure/measure-tool-call.ts",
			"measure-cache.ts",
			"segment-adapter.ts",
		];
		for (const file of measureFiles) {
			const source = readFileSync(join(VLIST_DIR, file), "utf8");
			expect(source).not.toContain("reflection-progress-store");
			expect(source).not.toContain("useReflectionProgress");
		}
	});

	test("only the render layer imports the store inside vlist", () => {
		const render = readFileSync(join(VLIST_DIR, "render/RenderReflectionNotice.tsx"), "utf8");
		expect(render).toContain("useReflectionProgress");
	});
});
