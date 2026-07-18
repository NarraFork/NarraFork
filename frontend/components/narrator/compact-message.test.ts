import { describe, expect, test } from "bun:test";
import {
	finishCompactAttempt,
	isCompactRetryableDetail,
	MAX_COMPACT_ERROR_CHARS,
	parseCompactMessageBlock,
	startCompactAttempt,
	truncateCompactError,
} from "@shared/compact-message";

describe("compact message compatibility", () => {
	test("parses legacy compact blocks without lifecycle metadata", () => {
		expect(
			parseCompactMessageBlock({ type: "compact", status: "compacted", summary: "legacy" }),
		).toMatchObject({ type: "compact", status: "compacted", summary: "legacy" });
	});

	test("truncates persisted errors to the fixed limit with an ellipsis", () => {
		const truncated = truncateCompactError("x".repeat(MAX_COMPACT_ERROR_CHARS + 20));
		expect(truncated).toHaveLength(MAX_COMPACT_ERROR_CHARS);
		expect(truncated.endsWith("…")).toBe(true);
	});

	test("keeps failed attempts when a retry later completes", () => {
		const first = startCompactAttempt(
			{ type: "compact", status: "compacting", mode: "blocking", trigger: "manual" },
			"provider:first",
			"2026-07-18T00:00:00.000Z",
		);
		const failed = finishCompactAttempt(first, "failed", "2026-07-18T00:01:00.000Z", "failed once");
		const retry = startCompactAttempt(failed, "provider:second", "2026-07-18T00:02:00.000Z");
		const completed = finishCompactAttempt(retry, "completed", "2026-07-18T00:03:00.000Z");

		expect(completed.status).toBe("compacted");
		expect(completed.attempts).toEqual([
			expect.objectContaining({ status: "failed", model: "provider:first" }),
			expect.objectContaining({ status: "completed", model: "provider:second" }),
		]);
	});

	test("shows retry only when the API marks the failed compact as retryable", () => {
		const base = {
			status: "failed" as const,
			summary: "",
			attempts: [],
		};
		expect(isCompactRetryableDetail({ ...base, canRetry: true })).toBe(true);
		expect(isCompactRetryableDetail({ ...base, canRetry: false })).toBe(false);
		expect(isCompactRetryableDetail({ ...base, canRetry: undefined })).toBe(false);
		expect(isCompactRetryableDetail({ ...base, status: "compacting", canRetry: true })).toBe(false);
	});
});
