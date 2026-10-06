import { describe, expect, test } from "bun:test";
import { catalogError } from "@server/lib/errors";
import { parseErrorDiagnostics } from "@shared/agent-protocol/error-diagnostics";
import { ERROR_CATALOG, serializeCatalogErrorMessage } from "@shared/error-catalog";
import { createInstance, type TFunction } from "i18next";
import enErrors from "../../locales/en/errors.json";
import zhErrors from "../../locales/zh-CN/errors.json";
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

	test("cyber_policy 违规走专属文案，而非通用错误", () => {
		const result = localizeNarratorError(
			"codex: Request blocked by cyber safety policy",
			t,
			"cyber_policy",
			{
				reason: "cyber_policy",
				provider: "codex",
			},
		);
		expect(result).toBe("cyberPolicyViolation(provider=codex)");
	});

	test("cyber_policy 违规附带 requestId 便于对账上游日志", () => {
		const result = localizeNarratorError("codex: blocked", t, undefined, {
			reason: "cyber_policy",
			provider: "codex",
			requestId: "req-cyber-1",
		});
		expect(result).toBe(
			"cyberPolicyViolation(provider=codex) errorRequestIdLabel(requestId=req-cyber-1)",
		);
	});

	test("分隔符/大小写变体的违规码同样命中专属文案", () => {
		const result = localizeNarratorError("codex: blocked", t, "Cyber-Policy", {
			provider: "codex",
		});
		expect(result).toBe("cyberPolicyViolation(provider=codex)");
	});

	test("标准 HTTP 错误的通用 type 不遮住 cyber_policy code，并保留请求 ID", () => {
		const body = {
			error: {
				type: "invalid_request_error",
				code: "cyber_policy",
				message: "Request blocked by cyber safety policy",
			},
			request_id: "req-http-policy",
		};
		const diagnostics = parseErrorDiagnostics(body, { provider: "codex:account" });
		expect(diagnostics?.reason).toBe("invalid_request_error");
		expect(diagnostics?.code).toBe("cyber_policy");
		for (const errorCode of [undefined, "invalid_request_error"]) {
			expect(localizeNarratorError(body.error.message, t, errorCode, { ...diagnostics })).toBe(
				"cyberPolicyViolation(provider=codex:account) errorRequestIdLabel(requestId=req-http-policy)",
			);
		}
	});

	test("三个结构化载体独立识别策略码，通用错误码不能遮住 reason", () => {
		for (const [errorCode, diagnostics] of [
			["Cyber-Policy", { code: "invalid_request_error", reason: "invalid_request_error" }],
			["invalid_request_error", { code: " Cyber Policy ", reason: "invalid_request_error" }],
			["invalid_request_error", { code: "invalid_request_error", reason: "Cyber-Policy" }],
		] as const) {
			expect(localizeNarratorError("codex: blocked", t, errorCode, diagnostics)).toBe(
				"cyberPolicyViolation(provider=codex)",
			);
		}
	});

	test("仅正文提及 cyber_policy 或未知近似码不会误触发策略文案", () => {
		const message = "Provider could not load a document discussing cyber_policy";
		for (const code of [undefined, 400, "cyber_policy_extra", "unknown_policy"]) {
			expect(
				localizeNarratorError(message, t, "invalid_request_error", {
					code,
					reason: "invalid_request_error",
					responseSnippet: "cyber_policy",
				}),
			).toBe(message);
		}
	});

	test("既无 diagnostics.provider 也无前缀时使用占位文案", () => {
		const result = localizeNarratorError("nothing arrived at all", t, undefined, {
			reason: "empty_response_no_events",
		});
		expect(result).toBe("emptyResponseNoEvents(provider=emptyResponseProviderFallback)");
	});
});

describe("localizeNarratorError 教程下线", () => {
	const legacy = ERROR_CATALOG.TUTORIAL_REMOVED.en;
	const serialized = serializeCatalogErrorMessage(catalogError("TUTORIAL_REMOVED"));

	test("目录错误经序列化后保留稳定标识和英文兜底", () => {
		expect(JSON.parse(serialized)).toEqual({
			type: "catalog_error",
			error: legacy,
			messageCode: "TUTORIAL_REMOVED",
			messageParams: {},
		});
	});

	for (const [locale, bundle] of [
		["en", enErrors],
		["zh-CN", zhErrors],
	] as const) {
		test(`${locale}：实时错误与刷新后仅有 errorMessage 的详情都使用已有翻译`, async () => {
			const i18n = createInstance();
			await i18n.init({
				lng: locale,
				defaultNS: "narrator",
				resources: { [locale]: { errors: bundle } },
			});
			const translate = i18n.getFixedT(locale, "narrator") as TFunction;
			const wire = JSON.parse(JSON.stringify({ error: serialized }));
			const reloaded = JSON.parse(JSON.stringify({ errorMessage: serialized }));
			expect(localizeNarratorError(wire.error, translate)).toBe(bundle.TUTORIAL_REMOVED);
			expect(localizeNarratorError(reloaded.errorMessage, translate)).toBe(bundle.TUTORIAL_REMOVED);
		});

		test(`${locale}：确切的旧英文消息（含 Error 前缀）仍可本地化`, async () => {
			const i18n = createInstance();
			await i18n.init({
				lng: locale,
				defaultNS: "narrator",
				resources: { [locale]: { errors: bundle } },
			});
			const translate = i18n.getFixedT(locale, "narrator") as TFunction;
			for (const message of [legacy, `Error: ${legacy}`]) {
				expect(localizeNarratorError(message, translate)).toBe(bundle.TUTORIAL_REMOVED);
			}
			expect(localizeNarratorError("retired", translate, "TUTORIAL_REMOVED")).toBe(
				bundle.TUTORIAL_REMOVED,
			);
		});
	}

	test("旧消息兼容不匹配正文片段、引用、额外上下文或裸错误码", () => {
		for (const message of [
			`The upstream said: ${legacy}`,
			`${legacy} Additional diagnostic detail`,
			`"${legacy}"`,
			"TUTORIAL_REMOVED",
			JSON.stringify({ message: legacy }),
		]) {
			expect(localizeNarratorError(message, t)).toBe(message);
		}
	});

	test("新版本目录码及缺少翻译时显示原始可读消息而非 JSON", async () => {
		const i18n = createInstance();
		await i18n.init({ lng: "en", defaultNS: "narrator", resources: {} });
		const translate = i18n.getFixedT("en", "narrator") as TFunction;
		expect(localizeNarratorError(serialized, translate)).toBe(legacy);
		const future = JSON.stringify({
			type: "catalog_error",
			error: "Future server error",
			messageCode: "FROM_A_NEWER_SERVER",
		});
		expect(localizeNarratorError(future, translate)).toBe("Future server error");
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

/**
 * A Kimi quota wall that was understood but not waited on (the reset is beyond the
 * wait budget, or this run already suspended on quota too often).
 *
 * The information the user needs — when the allowance returns — is carried in the
 * `errorMessage` PAYLOAD rather than in `diagnostics`, because `errorMessage` is the
 * only failure carrier that survives a page reload. These cases pin that split: a
 * payload read from `diagnostics` would pass a live-session check and fail after a
 * refresh, which is the silent half of the original defect.
 */
describe("localizeNarratorError Kimi 额度墙", () => {
	const resetAt = Date.UTC(2026, 8, 17, 11, 22, 1);
	const payload = JSON.stringify({
		type: "kimi_quota_exhausted",
		reason: "reset-beyond-budget",
		model: "kimi-2:kimi-k2",
		quotaResetAt: resetAt,
	});

	test("报出重置时刻，而不是转发上游 403 原文", () => {
		const result = localizeNarratorError(payload, t);
		expect(result).toStartWith("quotaExhaustedWaitNotPossible(resetAt=");
		// A real, formatted instant rather than a raw epoch or an empty value.
		expect(result).not.toContain(String(resetAt));
		expect(result).not.toContain("resetAt=undefined");
	});

	test("刷新后仍可本地化：不依赖 diagnostics", () => {
		// No errorCode and no diagnostics — exactly what a reloaded narrator row has.
		expect(localizeNarratorError(payload, t)).toStartWith("quotaExhaustedWaitNotPossible(");
	});

	test("重置时刻缺失时退化为不含时刻的文案，而不是报 undefined", () => {
		const result = localizeNarratorError(
			JSON.stringify({ type: "kimi_quota_exhausted", reason: "wait-budget-spent" }),
			t,
		);
		expect(result).toBe("quotaExhaustedWaitNotPossibleNoReset");
	});

	test("英文原文本身不被误判为该 payload", () => {
		const upstream =
			"Anthropic API error 403: You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.";
		expect(localizeNarratorError(upstream, t)).toBe(upstream);
	});
});
