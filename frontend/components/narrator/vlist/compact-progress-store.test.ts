import { describe, expect, it } from "bun:test";
import {
	type CompactProgressLabels,
	clearAllCompactProgress,
	clearCompactProgressAliases,
	formatCompactProgressText,
	getCompactProgress,
	setCompactProgress,
} from "./compact-progress-store";

const labels: CompactProgressLabels = {
	compacting: "Compacting context...",
	segmentCompacting: "Segment compacting...",
	outputChars: "{count} chars",
	thinking: "thinking",
	thinkingChars: "{count} chars",
	retrying: "retry #{count}",
};

function requireProgress(messageId: string, isSegment: boolean) {
	const progress = getCompactProgress(messageId, isSegment);
	if (!progress) throw new Error("expected compact progress snapshot");
	return progress;
}

describe("compact progress store", () => {
	it("keeps live progress outside the measured document and formats each phase", () => {
		clearAllCompactProgress();
		setCompactProgress("message-1", false, {
			phase: "output",
			thinkingChars: 12,
			outputChars: 128,
			retryCount: 0,
		});
		expect(getCompactProgress("message-1", false)).toEqual({
			phase: "output",
			thinkingChars: 12,
			outputChars: 128,
			retryCount: 0,
		});
		expect(formatCompactProgressText(labels, requireProgress("message-1", false), false)).toBe(
			"Compacting context... · 128 chars",
		);

		setCompactProgress("message-1", false, {
			phase: "thinking",
			thinkingChars: 24,
			outputChars: 0,
			retryCount: 0,
		});
		expect(formatCompactProgressText(labels, requireProgress("message-1", false), false)).toBe(
			"Compacting context... · thinking · 24 chars",
		);
	});

	it("isolates segment markers and preserves retry status", () => {
		clearAllCompactProgress();
		setCompactProgress("message-1", true, {
			phase: "output",
			thinkingChars: 0,
			outputChars: 0,
			retryCount: 2,
		});
		expect(getCompactProgress("message-1", false)).toBeNull();
		expect(formatCompactProgressText(labels, requireProgress("message-1", true), true)).toBe(
			"Segment compacting... · retry #2",
		);
	});

	it("stores only snapshot fields even when a wider event object is passed", () => {
		clearAllCompactProgress();
		setCompactProgress("message-1", false, {
			phase: "output",
			thinkingChars: 0,
			outputChars: 40,
			retryCount: 0,
			mode: "blocking",
			model: "should-not-persist",
			output: "chunk",
		} as never);
		expect(getCompactProgress("message-1", false)).toEqual({
			phase: "output",
			thinkingChars: 0,
			outputChars: 40,
			retryCount: 0,
		});
	});

	it("clears every COW compact alias id, not just the new messageId", () => {
		clearAllCompactProgress();
		setCompactProgress("old-marker", false, {
			phase: "output",
			thinkingChars: 0,
			outputChars: 10,
			retryCount: 0,
		});
		setCompactProgress("new-marker", false, {
			phase: "output",
			thinkingChars: 0,
			outputChars: 20,
			retryCount: 0,
		});
		const attempted = clearCompactProgressAliases({
			oldMessageId: "old-marker",
			replacedMessageId: "old-marker",
			messageId: "new-marker",
			newMessageId: "new-marker",
			replacementMessageId: "new-marker",
		});
		expect(attempted).toBe(true);
		expect(getCompactProgress("old-marker", false)).toBeNull();
		expect(getCompactProgress("new-marker", false)).toBeNull();
		expect(clearCompactProgressAliases(undefined)).toBe(false);
	});
});
