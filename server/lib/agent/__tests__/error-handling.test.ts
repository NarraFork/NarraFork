import { describe, expect, test } from "bun:test";
import {
	classifyInvalidState,
	isContextWindowExceededError,
	isRetryableError,
	isRetryableInvalidStateReason,
} from "../error-handling";

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
		for (const status of [500, 502, 503, 504, ...Array.from({ length: 10 }, (_, i) => 520 + i)]) {
			expect(isRetryableError({ status, message: `Provider API error ${status}` })).toBe(true);
		}
	});

	test("结构化 vendor retryable 标记优先于顶层 5xx 状态", () => {
		const fatal = Object.assign(new Error("vendor fatal failure"), {
			code: "vendor_fatal",
			retryable: false,
			status: 503,
		});
		const transient = Object.assign(new Error("vendor transient failure"), {
			code: "vendor_transient",
			retryable: true,
			status: 503,
		});
		expect(isRetryableError(fatal)).toBe(false);
		expect(isRetryableError(transient)).toBe(true);
	});

	test("keeps hard quota errors non-retryable even when the gateway returns 52x", () => {
		expect(
			isRetryableError({
				status: 524,
				message: "Provider API error 524: insufficient_quota; check your plan and billing",
			}),
		).toBe(false);
	});

	test("does not retry invalidState hard quota messages even with retryable reasons", () => {
		expect(
			isRetryableInvalidStateReason(
				"server_error",
				"insufficient_quota: check your plan and billing details",
			),
		).toBe(false);
		expect(isRetryableInvalidStateReason("internal_server_error", "payment required")).toBe(false);
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

	test("retries custom keyword-only rules for non-default API errors", () => {
		expect(
			isRetryableError({ status: 418, message: "Provider API error: shard warming" }, [
				{ id: "r1", keyword: " shard warming ", enabled: true },
			]),
		).toBe(true);
	});

	test("retries custom keyword-only rules for primitive thrown errors", () => {
		expect(
			isRetryableError("vendor queue draining", [
				{ id: "r1", keyword: "vendor queue draining", enabled: true },
			]),
		).toBe(true);
	});

	test("matches custom keyword rules against serialized API error fields", () => {
		expect(
			isRetryableError(
				{
					status: 418,
					error: { message: "try later", code: "vendor_busy" },
				},
				[{ id: "r1", keyword: "vendor_busy", enabled: true }],
			),
		).toBe(true);
	});

	test("retries custom keyword rules for invalid_state messages", () => {
		expect(
			isRetryableInvalidStateReason("upstream_busy", "vendor queue draining", [
				{ id: "r1", keyword: "queue draining", enabled: true },
			]),
		).toBe(true);
	});

	test("does not retry disabled custom keyword rules", () => {
		expect(
			isRetryableError({ status: 418, message: "Provider API error: shard warming" }, [
				{ id: "r1", keyword: "shard warming", enabled: false },
			]),
		).toBe(false);
	});

	test("classifies OpenAI 400 input-token-count errors as context overflow", () => {
		expect(
			isContextWindowExceededError(
				new Error(
					"OpenAI API error 400: The input token count exceeds the maximum number of tokens allowed (262144).",
				),
			),
		).toBe(true);
		expect(
			isContextWindowExceededError({
				status: 400,
				message: "The input token count exceeds the maximum number of tokens allowed (262144).",
			}),
		).toBe(true);
	});
});

describe("unified invalidState classification", () => {
	test("classifies resource exhaustion and 429 capacity errors as transient", () => {
		expect(
			classifyInvalidState("resource_exhausted", "temporary capacity exhausted"),
		).toMatchObject({
			category: "transient",
			retryable: true,
		});
		expect(classifyInvalidState("429", "Too many requests; retry later")).toMatchObject({
			category: "transient",
			retryable: true,
		});
	});

	test("classifies 5xx invalid states as transient", () => {
		expect(classifyInvalidState("500", "upstream failed")).toMatchObject({
			category: "transient",
			retryable: true,
		});
		expect(classifyInvalidState("api_error", "upstream failed", { statusCode: 503 })).toMatchObject(
			{
				category: "transient",
				retryable: true,
			},
		);
		for (let statusCode = 520; statusCode <= 529; statusCode++) {
			expect(classifyInvalidState("api_error", "gateway failed", { statusCode })).toMatchObject({
				category: "transient",
				retryable: true,
				statusCode,
			});
		}
	});

	test("prioritizes structured retry signals over broad refusal-like text", () => {
		expect(
			classifyInvalidState("api_error", "Service temporarily unable to respond", {
				statusCode: 503,
			}),
		).toMatchObject({
			category: "transient",
			retryable: true,
			statusCode: 503,
		});
		expect(
			classifyInvalidState("api_error", "Service temporarily unable to respond", {
				retryable: true,
			}),
		).toMatchObject({
			category: "transient",
			retryable: true,
		});
		expect(
			classifyInvalidState("refusal", "I cannot assist with that request", {
				statusCode: 503,
				retryable: true,
			}),
		).toMatchObject({
			category: "refusal",
			retryable: false,
			statusCode: 503,
		});
	});

	test("keeps completion limits non-retryable and distinct from context overflow", () => {
		const ambiguousMaximumTokensMessage =
			"The response exceeds the maximum number of tokens allowed.";
		expect(classifyInvalidState("max_tokens", ambiguousMaximumTokensMessage)).toMatchObject({
			category: "completion_limit",
			retryable: false,
		});
		expect(
			isContextWindowExceededError({
				reason: "max_tokens",
				message: ambiguousMaximumTokensMessage,
			}),
		).toBe(false);
		expect(
			isContextWindowExceededError({
				message: ambiguousMaximumTokensMessage,
				diagnostics: { reason: "max_tokens" },
			}),
		).toBe(false);
		expect(
			classifyInvalidState("model_context_window_exceeded", ambiguousMaximumTokensMessage),
		).toMatchObject({
			category: "context_overflow",
			retryable: false,
		});
	});

	test("keeps refusal and content filtering non-retryable", () => {
		expect(classifyInvalidState("refusal", "request refused")).toMatchObject({
			category: "refusal",
			retryable: false,
		});
		expect(classifyInvalidState("content_filter", "blocked by safety filter")).toMatchObject({
			category: "content_filter",
			retryable: false,
		});
		expect(classifyInvalidState("api_error", "content filter blocked; try again")).toMatchObject({
			category: "content_filter",
			retryable: false,
		});
	});
});

describe("plugin provider retryable classification", () => {
	test("explicit retryable=true wins over unknown reason/message patterns", () => {
		// Plugin classified its own error retryable but the reason/message match no known
		// retryable pattern — the plugin classification must win.
		expect(
			isRetryableInvalidStateReason("upstream_overloaded", "vendor busy", undefined, true),
		).toBe(true);
	});

	test("explicit retryable=false vetoes a retryable-looking message", () => {
		// Plugin declared the error non-retryable (e.g. quota/billing) even though the
		// message contains "429" / "500" — never retry.
		expect(
			isRetryableInvalidStateReason(
				"quota_exceeded",
				"status 429 too many requests",
				undefined,
				false,
			),
		).toBe(false);
		expect(isRetryableInvalidStateReason("billing", "error 500 quota", undefined, false)).toBe(
			false,
		);
	});

	test("hard non-retryable message still vetoes an optimistic retryable=true", () => {
		expect(isRetryableInvalidStateReason("quota", "payment required", undefined, true)).toBe(false);
	});

	test("undefined retryable falls back to heuristics", () => {
		expect(
			isRetryableInvalidStateReason("stream_read_error", undefined, undefined, undefined),
		).toBe(true);
		expect(isRetryableInvalidStateReason("unknown_reason", "ok", undefined, undefined)).toBe(false);
	});
});
