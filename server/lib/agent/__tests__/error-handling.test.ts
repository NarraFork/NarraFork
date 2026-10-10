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
	isResumableError,
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

	/**
	 * Regression: an opencode 429 announcing a *weekly* allowance wall was retried
	 * forever (observed: 8 identical requests in 54s with maxTransientRetries=-1).
	 *
	 * Two independent defects had to line up, so each is pinned separately below:
	 *   1. Cloudflare's `retry-after: 374160` (≈4.3 days) response header was
	 *      serialized into the error object and matched the bare `retry` keyword in
	 *      the 429 rate-limit list — a header NAME acting as an upstream signal.
	 *   2. "Weekly usage limit reached" matched neither `usage_limit_reached` nor
	 *      `usage limit has been reached`, so nothing classified it as a hard wall.
	 *
	 * The payload below is the real one from `api_requests.raw_dump_json`. The
	 * `retry-after` header MUST stay in it: without the header this assertion also
	 * passes on the unfixed code, making it useless as a regression guard.
	 */
	test("does not retry a hard weekly-usage-limit 429 that carries a Retry-After header", () => {
		const message =
			"OpenAI API error 429: Weekly usage limit reached. Resets in 4 days. To continue using " +
			"this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01M/go";
		const err = Object.assign(new Error(message), {
			status: 429,
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				source: "provider",
				phase: "http_error",
				reason: "GoUsageLimitError",
				errorType: "GoUsageLimitError",
				message: message.replace("OpenAI API error 429: ", ""),
				responseSnippet: message.replace("OpenAI API error 429: ", ""),
				statusCode: 429,
				responseHeaders: {
					"content-type": "text/plain;charset=UTF-8",
					"retry-after": "374160",
					server: "cloudflare",
				},
			},
		});
		expect(isRetryableError(err)).toBe(false);
	});

	test("a Retry-After header is not by itself evidence of a transient 429", () => {
		// No rate-limit wording anywhere; the only "retry" in the object is the header name.
		expect(
			isRetryableError({
				status: 429,
				message: "Provider API error 429: account restricted",
				diagnostics: { statusCode: 429, responseHeaders: { "retry-after": "600" } },
			}),
		).toBe(false);
	});

	test("field names containing 'retry' are not evidence of a transient 429", () => {
		expect(
			isRetryableError({
				status: 429,
				message: "Provider API error 429: account restricted",
				diagnostics: { statusCode: 429, requestId: "req_retry_pool_7" },
			}),
		).toBe(false);
		expect(
			isRetryableError({
				status: 429,
				message: "Provider API error 429: account restricted",
				retryCount: 3,
			}),
		).toBe(false);
	});

	test("still retries genuine rate-limit 429s", () => {
		expect(
			isRetryableError({
				status: 429,
				message:
					"OpenAI API error 429: Rate limit reached for gpt-4o on tokens per min. Please try again in 2s.",
			}),
		).toBe(true);
		// A standalone `retry` word is still a real signal, unlike `retry-after`.
		expect(isRetryableError({ status: 429, message: "Provider API error 429: please retry" })).toBe(
			true,
		);
	});

	test("recognizes the whole usage-limit wording family as a hard wall", () => {
		for (const wording of [
			"Weekly usage limit reached. Resets in 4 days.",
			"usage limit exceeded for this account",
			"monthly usage limit hit",
			"usage_limit_reached",
			"The usage limit has been reached",
		]) {
			expect(isRetryableError({ status: 429, message: `Provider API error 429: ${wording}` })).toBe(
				false,
			);
		}
	});

	test("an informational usage-limit mention is not treated as exhaustion", () => {
		// Noun without a consumed verb: must stay on the normal heuristic path, and the
		// rate-limit wording still makes it retryable.
		expect(
			isRetryableError({
				status: 429,
				message: "Provider API error 429: your usage limit is 1000/min; too many requests",
			}),
		).toBe(true);
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

	// The rendered error card prefixes the provider message with `Error: ` (and the
	// stored plain text with `[Error] `), but matching only ever sees the RAW
	// message. A keyword copied out of that card — exactly what the "mark as
	// retryable" dialog used to prefill — must still match.
	test("retries custom keyword rules whose keyword carries the error-card display prefix", () => {
		const err = new Error("Concurrency limit exceeded for account, please retry later");
		expect(
			isRetryableError(err, [
				{
					id: "r1",
					keyword: "Error: Concurrency limit exceeded for account, please retry later",
					enabled: true,
				},
			]),
		).toBe(true);
		// The doubly-decorated form persisted for error-card messages.
		expect(
			isRetryableError(err, [
				{ id: "r2", keyword: "[Error] Error: Concurrency limit exceeded", enabled: true },
			]),
		).toBe(true);
		// An invalid_state message goes through classifyInvalidState's rule path.
		expect(
			isRetryableInvalidStateReason("upstream_busy", "vendor queue draining", [
				{ id: "r3", keyword: "Error: vendor queue draining", enabled: true },
			]),
		).toBe(true);
	});

	test("a prefix-only keyword contributes no condition", () => {
		expect(
			isRetryableError({ status: 418, message: "some unrelated failure" }, [
				{ id: "r1", keyword: "Error:", enabled: true },
			]),
		).toBe(false);
	});

	// A hand-written rule is a deliberate user override: it outranks a provider's
	// own `retryable: false`, which otherwise short-circuits before rules run.
	test("custom rules override a provider-declared retryable:false", () => {
		const message = "Concurrency limit exceeded for account, please retry later";
		const rules = [{ id: "r1", keyword: "Concurrency limit exceeded", enabled: true }];
		expect(isRetryableError(Object.assign(new Error(message), { retryable: false }), rules)).toBe(
			true,
		);
		expect(
			isRetryableError(
				Object.assign(new Error(message), { diagnostics: { retryable: false } }),
				rules,
			),
		).toBe(true);
		expect(
			classifyInvalidState("upstream_busy", message, { retryable: false }, rules).retryable,
		).toBe(true);
	});

	test("provider retryable:false still wins when no custom rule matches", () => {
		expect(
			isRetryableError(
				Object.assign(new Error("Concurrency limit exceeded for account"), { retryable: false }),
				[{ id: "r1", keyword: "some other error", enabled: true }],
			),
		).toBe(false);
	});

	// A resumable failure already produced visible output; the loop continues from
	// it instead of replaying the request, so a rule must not downgrade that into a
	// full retry (which could duplicate output).
	test("custom rules do not override an explicitly resumable failure", () => {
		const message = "upstream stream error";
		const rules = [{ id: "r1", keyword: "upstream stream error", enabled: true }];
		expect(
			isRetryableError(
				Object.assign(new Error(message), {
					retryable: false,
					diagnostics: { resumable: true },
				}),
				rules,
			),
		).toBe(false);
		expect(
			classifyInvalidState(
				"weird_unknown_reason",
				message,
				{ statusCode: 400, retryable: false, resumable: true },
				rules,
			),
		).toMatchObject({ category: "non_retryable", retryable: false, resumable: true });
	});

	// Quota/billing is classified as hard non-retryable before rules are consulted,
	// so an over-broad user rule cannot turn a paid-out account into a retry loop.
	test("custom rules cannot override hard quota failures", () => {
		expect(
			isRetryableError(
				Object.assign(new Error("Your credit balance is too low"), { retryable: false }),
				[{ id: "r1", keyword: "credit balance", enabled: true }],
			),
		).toBe(false);
		expect(
			classifyInvalidState(
				"insufficient_quota",
				"You exceeded your current quota",
				{ retryable: false },
				[{ id: "r1", keyword: "quota", enabled: true }],
			).retryable,
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
						"POST https://nug.example.com/v1/chat via direct connection. " +
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

	test("recognizes prompt_too_long when the gateway also reports an English type", () => {
		// 真实事故形态：中继返回 {"error":{"code":"prompt_too_long","type":"invalid_request_error"}}。
		// 归一化时 reason 被 type 抢占，真正的原因码只留在 diagnostics.code 里；
		// 而 ProviderInvalidStateError 没有 error 对象字段，nested 回退永远拿不到它。
		const err = new ProviderInvalidStateError(
			"invalid_request_error",
			"OpenAI API error 400: 请求提示词超出模型上限：内容过长，请精简或新建任务",
			{
				diagnostics: {
					schema: "narrafork.error-diagnostics.v1",
					source: "provider",
					phase: "http_error",
					reason: "invalid_request_error",
					errorType: "invalid_request_error",
					message: "OpenAI API error 400: 请求提示词超出模型上限：内容过长，请精简或新建任务",
					code: "prompt_too_long",
					statusCode: 400,
				},
			},
		);
		// 判成溢出才会走紧急压缩 + 重试；漏判则把中继原文照抄给用户。
		expect(isContextWindowExceededError(err)).toBe(true);
	});

	test("recognizes a localized prompt-too-long message from a Chinese gateway", () => {
		expect(
			isContextWindowExceededError(
				new Error("OpenAI API error 400: 请求提示词超出模型上限：内容过长，请精简或新建任务"),
			),
		).toBe(true);
	});

	test("recognizes the numeric-code gateway envelope with a prompt-is-too-long msg", () => {
		// 上游第二种形态：数字业务码 + msg 字段 + extError 里再套一层英文 type/code。
		// code 是数字会被 reason 扫描跳过，判定必须靠 msg 里的英文表述兜住。
		const err = new ProviderInvalidStateError(
			"invalid_request_error",
			"prompt is too long: 1080519 tokens > 1048576 maximum",
			{
				diagnostics: {
					schema: "narrafork.error-diagnostics.v1",
					source: "gateway",
					phase: "http_error",
					reason: "invalid_request_error",
					errorType: "invalid_request_error",
					message: "prompt is too long: 1080519 tokens > 1048576 maximum",
					code: 11115,
					statusCode: 400,
				},
			},
		);
		expect(isContextWindowExceededError(err)).toBe(true);
	});

	test("does not treat an unrelated numeric gateway code as context overflow", () => {
		// 反向保护：数字码本身不构成溢出证据，别把别的业务错误一并吞进来。
		const err = new ProviderInvalidStateError("invalid_request_error", "invalid parameter: temperature", {
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				source: "gateway",
				phase: "http_error",
				reason: "invalid_request_error",
				errorType: "invalid_request_error",
				message: "invalid parameter: temperature",
				code: 11115,
				statusCode: 400,
			},
		});
		expect(isContextWindowExceededError(err)).toBe(false);
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

	test("classifies cyber_policy as a terminal content_filter violation", () => {
		// The upstream cyber-policy hard block must never retry, resume, or fail
		// over — replaying the violating prompt spreads ban risk across accounts.
		expect(classifyInvalidState("cyber_policy", "Request blocked by cyber policy")).toMatchObject({
			category: "content_filter",
			retryable: false,
			resumable: false,
		});
		// Separator/case variants of the same upstream code classify identically.
		expect(classifyInvalidState("Cyber-Policy", "blocked")).toMatchObject({
			category: "content_filter",
			retryable: false,
		});
		// A provider-resumable hint must not override the violation veto.
		expect(
			classifyInvalidState("cyber_policy", "blocked", { statusCode: 400, resumable: true }),
		).toMatchObject({ category: "content_filter", retryable: false, resumable: false });
		// Unrelated reasons are untouched by the detector.
		expect(classifyInvalidState("api_error", "upstream failed")).not.toMatchObject({
			category: "content_filter",
		});
	});

	test("policy violation force-disables retry even when a custom rule would match", () => {
		// The veto outranks user-authored retry rules on purpose: replaying a
		// violating prompt against another account is how upstream bans propagate.
		const rules = [{ id: "r1", keyword: "cyber", enabled: true }];
		const err = Object.assign(new Error("OpenAI API error 400: blocked by cyber policy"), {
			status: 400,
			diagnostics: { code: "cyber_policy", message: "blocked by cyber policy" },
		});
		expect(isRetryableError(err, rules)).toBe(false);
	});

	test("policy violation force-disables retry despite a provider retryable:true flag", () => {
		const err = Object.assign(new Error("blocked"), {
			code: "cyber_policy",
			retryable: true,
		});
		expect(isRetryableError(err)).toBe(false);
	});

	test("policy violation force-disables resumability despite a resumable flag", () => {
		const err = Object.assign(new Error("blocked"), {
			resumable: true,
			diagnostics: { code: "cyber_policy", resumable: true },
		});
		expect(isResumableError(err)).toBe(false);
	});

	test("non-violation errors still honor custom retry rules (veto does not overreach)", () => {
		const rules = [{ id: "r1", keyword: "vendor busy", enabled: true }];
		expect(isRetryableError(new Error("vendor busy right now"), rules)).toBe(true);
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
		expect(isModelUnavailableError(new Error('channel "anthropic" has no healthy nodes'))).toBe(
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
