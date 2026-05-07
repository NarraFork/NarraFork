import { describe, expect, test } from "bun:test";
import { isRetryableError, isRetryableInvalidStateReason } from "../error-handling";

describe("agent error handling", () => {
	test("treats truncated Responses API streams as retryable", () => {
		expect(isRetryableInvalidStateReason("stream_closed_before_response_completed")).toBe(true);
	});

	test("treats stream read errors as retryable", () => {
		expect(isRetryableInvalidStateReason("stream_read_error")).toBe(true);
		expect(isRetryableError({ reason: "stream_read_error", message: "stream read failed" })).toBe(
			true,
		);
		expect(isRetryableError(new Error("OpenAI Responses stream error (stream_read_error)"))).toBe(
			true,
		);
	});

	test("does not retry plain 429 errors without retry/load keywords", () => {
		expect(
			isRetryableError({ status: 429, message: "Provider API error 429: billing failed" }),
		).toBe(false);
		expect(
			isRetryableError({ status: 429, message: "Provider API error 429: internal server error" }),
		).toBe(false);
	});

	test("retries 429 errors with retry/load/capacity keywords", () => {
		expect(isRetryableError({ status: 429, message: "Provider API error 429: retry later" })).toBe(
			true,
		);
		expect(isRetryableError({ status: 429, message: "Provider API error 429: overloaded" })).toBe(
			true,
		);
		expect(isRetryableError({ status: 429, message: "Provider API error 429: at capacity" })).toBe(
			true,
		);
		expect(isRetryableError({ status: 429, message: "Provider API error 429: at capacty" })).toBe(
			true,
		);
	});

	test("does not retry 429 errors that match hard quota patterns", () => {
		expect(
			isRetryableError({
				status: 429,
				message: "Provider API error 429: insufficient_quota, please retry after billing",
			}),
		).toBe(false);
		expect(
			isRetryableError({
				status: 429,
				message:
					"Provider API error 429: exceeded your current quota; check your plan and billing details",
			}),
		).toBe(false);
	});

	test("still retries server-side transient status codes without keywords", () => {
		for (const status of [500, 502, 503, 529]) {
			expect(isRetryableError({ status, message: `Provider API error ${status}` })).toBe(true);
		}
	});

	test("requires retry/load keywords for invalidState 429 messages", () => {
		expect(isRetryableInvalidStateReason("stream_initialization_failed", "status 429")).toBe(false);
		expect(
			isRetryableInvalidStateReason(
				"stream_initialization_failed",
				"status 429: internal server error",
			),
		).toBe(false);
		expect(
			isRetryableInvalidStateReason("stream_initialization_failed", "status 429: overload"),
		).toBe(true);
		expect(
			isRetryableInvalidStateReason("stream_initialization_failed", "status 429: capacity"),
		).toBe(true);
		expect(isRetryableInvalidStateReason("stream_initialization_failed", "status 429: retry")).toBe(
			true,
		);
	});
});
