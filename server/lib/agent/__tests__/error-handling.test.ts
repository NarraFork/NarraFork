import { describe, expect, test } from "bun:test";
import {
	AUXILIARY_MAX_RETRIES_CAP,
	AUXILIARY_RETRY_BASE_MS,
	AUXILIARY_RETRY_MAX_MS,
	auxiliaryRetryDelayMs,
	classifyInvalidState,
	getAuxiliaryMaxRetries,
	isContextWindowExceededError,
	isModelUnavailableError,
	isRetryableError,
	isRetryableInvalidStateReason,
	ProviderInvalidStateError,
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

	test("retries a TLS handshake that failed without an attributable cause", () => {
		// Bun falls back to this code when no X509 verify code explains the failure —
		// a disturbed handshake (relay/VPN/interception), not a bad certificate.
		expect(
			isRetryableError(
				Object.assign(new Error("unknown certificate verification error"), {
					code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
				}),
			),
		).toBe(true);
		// The wrapped NetworkRequestError keeps the code only inside its message.
		expect(
			isRetryableError(
				new Error(
					"Network request failed [tls/UNKNOWN_CERTIFICATE_VERIFICATION_ERROR] after 15571 ms: " +
						"The TLS handshake or certificate verification failed.",
				),
			),
		).toBe(true);
		// Also reachable when a provider buries the transport failure deeper than
		// the two nesting levels the code checks inspect directly.
		expect(
			isRetryableError(
				new Error("NUG chat request failed", {
					cause: new Error("transport failed", {
						cause: Object.assign(new Error("handshake failed"), {
							code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
						}),
					}),
				}),
			),
		).toBe(true);
	});

	test("does not retry attributable certificate failures", () => {
		for (const [code, message] of [
			["CERT_HAS_EXPIRED", "certificate has expired"],
			["DEPTH_ZERO_SELF_SIGNED_CERT", "self signed certificate"],
			["SELF_SIGNED_CERT_IN_CHAIN", "self signed certificate in certificate chain"],
			["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"],
			["ERR_TLS_CERT_ALTNAME_INVALID", "hostname/IP does not match certificate's altnames"],
			["HOSTNAME_MISMATCH", "hostname mismatch"],
		] as const) {
			expect(isRetryableError(Object.assign(new Error(message), { code }))).toBe(false);
			expect(
				isRetryableError(
					new Error(
						`Network request failed [tls/${code}] after 120 ms: POST https://example.com/v1/chat ` +
							"via direct connection. The TLS handshake or certificate verification failed.",
					),
				),
			).toBe(false);
		}
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

describe("resumable classification (NUG continuation-after-forwarded-payload signal)", () => {
	test("diagnostics.resumable=true on an unknown reason marks the classification resumable", () => {
		expect(
			classifyInvalidState("weird_unknown_reason", "upstream stream error", {
				statusCode: 400,
				retryable: false,
				resumable: true,
			}),
		).toMatchObject({
			category: "non_retryable",
			retryable: false,
			resumable: true,
		});
	});

	test("diagnostics.resumable=false stays non-resumable", () => {
		expect(
			classifyInvalidState("weird_unknown_reason", "upstream stream error", {
				statusCode: 400,
				retryable: false,
				resumable: false,
			}),
		).toMatchObject({
			category: "non_retryable",
			retryable: false,
			resumable: false,
		});
	});

	test("a retryable transient classification is never also resumable (mutually exclusive)", () => {
		expect(
			classifyInvalidState("stream_read_error", "connection reset", {
				resumable: true,
			}),
		).toMatchObject({
			category: "transient",
			retryable: true,
			resumable: false,
		});
	});

	test("hard non-retryable quota/billing text vetoes an optimistic resumable=true", () => {
		expect(
			classifyInvalidState("api_error", "insufficient_quota: check your plan and billing", {
				resumable: true,
			}),
		).toMatchObject({
			category: "non_retryable",
			retryable: false,
			resumable: false,
		});
	});

	test("refusal and content_filter are never resumable even with an optimistic flag", () => {
		expect(classifyInvalidState("refusal", "request refused", { resumable: true })).toMatchObject({
			category: "refusal",
			retryable: false,
			resumable: false,
		});
		expect(
			classifyInvalidState("content_filter", "blocked by safety filter", { resumable: true }),
		).toMatchObject({
			category: "content_filter",
			retryable: false,
			resumable: false,
		});
	});

	test("completion_limit and context_overflow are never resumable", () => {
		expect(classifyInvalidState("max_tokens", "truncated", { resumable: true })).toMatchObject({
			category: "completion_limit",
			resumable: false,
		});
		expect(
			classifyInvalidState("model_context_window_exceeded", "too long", { resumable: true }),
		).toMatchObject({
			category: "context_overflow",
			resumable: false,
		});
	});

	test("resumable 429 without retry keywords stays resumable instead of hard non-retryable", () => {
		expect(
			classifyInvalidState("stream_initialization_failed", "status 429: internal server error", {
				resumable: true,
			}),
		).toMatchObject({
			category: "non_retryable",
			retryable: false,
			resumable: true,
		});
	});

	test("ProviderInvalidStateError exposes resumable from diagnostics", () => {
		const err = new ProviderInvalidStateError("weird_unknown_reason", "upstream stream error", {
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 400,
				retryable: false,
				resumable: true,
			},
		});
		expect(err.retryable).toBe(false);
		expect(err.resumable).toBe(true);
	});
});

describe("auxiliary retry policy", () => {
	test("honors small non-negative retry counts verbatim", () => {
		expect(getAuxiliaryMaxRetries(0)).toBe(0);
		expect(getAuxiliaryMaxRetries(1)).toBe(1);
		expect(getAuxiliaryMaxRetries(5)).toBe(5);
		expect(getAuxiliaryMaxRetries(AUXILIARY_MAX_RETRIES_CAP)).toBe(AUXILIARY_MAX_RETRIES_CAP);
	});

	test("caps infinite (-1) and oversized values at the hard cap", () => {
		expect(getAuxiliaryMaxRetries(-1)).toBe(AUXILIARY_MAX_RETRIES_CAP);
		expect(getAuxiliaryMaxRetries(11)).toBe(AUXILIARY_MAX_RETRIES_CAP);
		expect(getAuxiliaryMaxRetries(100)).toBe(AUXILIARY_MAX_RETRIES_CAP);
		expect(getAuxiliaryMaxRetries(Number.MAX_SAFE_INTEGER)).toBe(AUXILIARY_MAX_RETRIES_CAP);
	});

	test("falls back to the cap for non-finite / invalid inputs", () => {
		expect(getAuxiliaryMaxRetries(Number.NaN)).toBe(AUXILIARY_MAX_RETRIES_CAP);
		expect(getAuxiliaryMaxRetries(Number.POSITIVE_INFINITY)).toBe(AUXILIARY_MAX_RETRIES_CAP);
		expect(getAuxiliaryMaxRetries(undefined as unknown as number)).toBe(AUXILIARY_MAX_RETRIES_CAP);
	});

	test("floors fractional retry counts", () => {
		expect(getAuxiliaryMaxRetries(3.9)).toBe(3);
	});

	test("never exceeds the cap regardless of input", () => {
		for (const input of [-100, -1, 0, 3, 9, 10, 10.9, 50, 1000]) {
			expect(getAuxiliaryMaxRetries(input)).toBeLessThanOrEqual(AUXILIARY_MAX_RETRIES_CAP);
		}
	});

	test("exponential backoff grows then clamps at the ceiling", () => {
		expect(auxiliaryRetryDelayMs(0)).toBe(AUXILIARY_RETRY_BASE_MS); // 3000
		expect(auxiliaryRetryDelayMs(1)).toBe(AUXILIARY_RETRY_BASE_MS * 2); // 6000
		expect(auxiliaryRetryDelayMs(2)).toBe(AUXILIARY_RETRY_BASE_MS * 4); // 12000
		expect(auxiliaryRetryDelayMs(3)).toBe(AUXILIARY_RETRY_MAX_MS); // 24000 -> clamp 15000
		expect(auxiliaryRetryDelayMs(10)).toBe(AUXILIARY_RETRY_MAX_MS);
		for (const attempt of [0, 1, 2, 3, 5, 10, 20]) {
			expect(auxiliaryRetryDelayMs(attempt)).toBeLessThanOrEqual(AUXILIARY_RETRY_MAX_MS);
		}
	});
});

describe("isModelUnavailableError", () => {
	test("detects credential-exhaustion message phrases", () => {
		expect(isModelUnavailableError(new Error("NUG chat error 503: no available credentials"))).toBe(
			true,
		);
		expect(isModelUnavailableError(new Error("no available API keys: all disabled"))).toBe(true);
		expect(isModelUnavailableError(new Error("model upstream unavailable"))).toBe(true);
		expect(isModelUnavailableError(new Error("all credentials exhausted after retries: 401"))).toBe(
			true,
		);
	});

	test("detects structured upstream-unavailable diagnostics via reason", () => {
		expect(
			isModelUnavailableError({
				message: "unavailable",
				diagnostics: {
					schema: "narrafork.error-diagnostics.v1",
					reason: "model_upstream_unavailable",
				},
			}),
		).toBe(true);
		expect(
			isModelUnavailableError({
				message: "gateway error",
				diagnostics: {
					schema: "narrafork.error-diagnostics.v1",
					reason: "no_credential_available",
				},
			}),
		).toBe(true);
	});

	test("does NOT treat generic transient blips as model-unavailable", () => {
		// A bare 503/5xx or timeout must keep going through the normal transient
		// retry path, not the suspend-and-wait path.
		expect(isModelUnavailableError(new Error("Provider API error 503"))).toBe(false);
		expect(isModelUnavailableError(new Error("service unavailable"))).toBe(false);
		expect(isModelUnavailableError(new Error("fetch failed"))).toBe(false);
		expect(isModelUnavailableError({ status: 503, message: "gateway timeout" })).toBe(false);
	});

	test("does NOT treat hard quota/billing failures as model-unavailable", () => {
		// Even if a credential-ish phrase co-occurs, quota/billing wins → not a wait.
		expect(
			isModelUnavailableError(
				new Error("no available credentials; insufficient_quota, check your plan and billing"),
			),
		).toBe(false);
		expect(isModelUnavailableError({ status: 402, message: "payment required" })).toBe(false);
	});

	test("handles null/undefined/non-error inputs", () => {
		expect(isModelUnavailableError(null)).toBe(false);
		expect(isModelUnavailableError(undefined)).toBe(false);
		expect(isModelUnavailableError("no available credentials")).toBe(true);
	});
});
