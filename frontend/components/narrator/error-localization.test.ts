import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { localizeNarratorError } from "./error-localization";

/**
 * Stand-in for i18next that renders `key(param=value, ...)` so assertions can
 * verify both the chosen key and the interpolated values without loading the
 * real locale bundles.
 */
const t = ((key: string, params?: Record<string, unknown>) => {
	if (!params) return key;
	const rendered = Object.entries(params)
		.filter(([, value]) => value !== "" && value != null)
		.map(([name, value]) => `${name}=${String(value)}`)
		.join(", ");
	return rendered ? `${key}(${rendered})` : key;
}) as unknown as TFunction;

describe("localizeNarratorError 结构化归因", () => {
	test("按 diagnostics.reason 选择细分文案，而非回退到通用空响应文案", () => {
		const result = localizeNarratorError(
			"nug2: Provider streamed only bookkeeping events (usage/queue/quota) and no content.",
			t,
			undefined,
			{ reason: "empty_response_usage_only", provider: "nug2" },
		);
		expect(result).toBe("emptyResponseUsageOnly(provider=nug2)");
	});

	test("stopReason 从 responseSnippet 中提取并插值", () => {
		const result = localizeNarratorError("nug2: finished without content", t, undefined, {
			reason: "empty_response_stop_without_content",
			provider: "nug2",
			responseSnippet: "events=1 contentless=1 usage=false stopReason=content_filter",
		});
		expect(result).toBe(
			"emptyResponseStopWithoutContent(provider=nug2, stopReason=content_filter)",
		);
	});

	test("有 requestId 时附加请求 ID，便于对账上游日志", () => {
		const result = localizeNarratorError("nug2: nothing arrived", t, undefined, {
			reason: "empty_response_no_events",
			provider: "nug2",
			requestId: "req-abc",
		});
		expect(result).toBe(
			"emptyResponseNoEvents(provider=nug2) errorRequestIdLabel(requestId=req-abc)",
		);
	});

	test("纯思考耗尽不再复用空响应文案", () => {
		const result = localizeNarratorError("test: only reasoning", t, "reasoning_only_exhausted", {
			reason: "reasoning_only_exhausted",
			provider: "test",
		});
		expect(result).toBe("reasoningOnlyExhausted(provider=test)");
	});

	test("缺少 diagnostics.provider 时回退到消息前缀", () => {
		const result = localizeNarratorError("kimi-2: nothing arrived", t, undefined, {
			reason: "empty_response_no_events",
		});
		expect(result).toBe("emptyResponseNoEvents(provider=kimi-2)");
	});

	test("既无 diagnostics.provider 也无前缀时使用占位文案", () => {
		const result = localizeNarratorError("nothing arrived at all", t, undefined, {
			reason: "empty_response_no_events",
		});
		expect(result).toBe("emptyResponseNoEvents(provider=emptyResponseProviderFallback)");
	});
});

describe("localizeNarratorError 既有行为保持不变", () => {
	test("payment_required 仍走充值文案", () => {
		expect(localizeNarratorError("anything", t, "payment_required")).toBe(
			"recharge.paymentRequired",
		);
		expect(localizeNarratorError(JSON.stringify({ type: "payment_required" }), t)).toBe(
			"recharge.paymentRequired",
		);
	});

	test("上下文过长的 errorCode 仍走各自文案", () => {
		expect(localizeNarratorError("x", t, "context_too_long_compact_failed")).toBe(
			"contextTooLongCompactFailed",
		);
		expect(localizeNarratorError("x", t, "context_too_long_no_compact_boundary")).toBe(
			"contextTooLongNoCompactBoundary",
		);
	});

	test("旧版空响应消息（无 diagnostics）仍可本地化", () => {
		const legacy =
			"narrafork: Provider returned an empty response. This often indicates an API configuration error (base URL, model, or credentials).";
		expect(localizeNarratorError(legacy, t, "empty_response")).toBe(
			"emptyResponseError(provider=narrafork)",
		);
		// Also without an errorCode, matching how older records were stored.
		expect(localizeNarratorError(legacy, t)).toBe("emptyResponseError(provider=narrafork)");
	});

	test("无法识别的消息原样返回", () => {
		expect(localizeNarratorError("NUG chat error 503: model upstream unavailable", t)).toBe(
			"NUG chat error 503: model upstream unavailable",
		);
	});

	test("空值原样返回", () => {
		expect(localizeNarratorError(null, t)).toBeNull();
		expect(localizeNarratorError(undefined, t)).toBeUndefined();
		expect(localizeNarratorError("", t)).toBe("");
	});
});
