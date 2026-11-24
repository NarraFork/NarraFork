import { describe, expect, test } from "bun:test";
import {
	COMMAND_CODE_PROVIDER_BASE,
	commandCodeApiOrigin,
	endpointFromSupported,
	parseCommandCodeModels,
	resolveCommandCodeEndpoint,
	selectCommandCodeEndpoint,
} from "../commandcode-protocol";
import {
	commandCodeUsageSnapshot,
	parseCommandCodeCredits,
	parseCommandCodeSummary,
	probeCommandCodeQuota,
	readResponseJsonLimited,
} from "../commandcode-usage";
import { keyQuotaBlockedUntil } from "../provider-key-quota";
import { quotaStore } from "../sourcing/quota-store";

describe("Command Code 端点选择（规则与实测 supported_endpoints 一致）", () => {
	test("claude 系只支持 /messages", () => {
		expect(resolveCommandCodeEndpoint("claude-haiku-5-5")).toBe("messages");
		expect(resolveCommandCodeEndpoint("claude-sonnet-5-5")).toBe("messages");
		expect(resolveCommandCodeEndpoint("claude-opus-5-5")).toBe("messages");
	});

	test("其余模型走 OpenAI 协议", () => {
		expect(resolveCommandCodeEndpoint("gpt-5.6-luna")).toBe("completions");
		expect(resolveCommandCodeEndpoint("deepseek/deepseek-v4-pro")).toBe("completions");
		expect(resolveCommandCodeEndpoint("Qwen/Qwen3.8-Max")).toBe("completions");
		expect(resolveCommandCodeEndpoint("z-ai/glm-5.3-flash")).toBe("completions");
	});

	test("大小写与首尾空格不敏感", () => {
		expect(resolveCommandCodeEndpoint("  CLAUDE-opus-5  ")).toBe("messages");
	});

	test("带 CommandCode 前缀的 claude 模型仍走 /messages", () => {
		expect(selectCommandCodeEndpoint("CommandCode:claude-haiku-5-5")).toBe("messages");
		expect(selectCommandCodeEndpoint("CommandCode:gpt-5.6-luna")).toBe("completions");
	});

	test("目录里的 supported_endpoints 优先于模型名，显式协议再优先于目录", () => {
		expect(endpointFromSupported(["/messages"])).toBe("messages");
		// 与 TokenDance 不同：/messages 不可用，同时支持时仍优先 /responses。
		expect(endpointFromSupported(["/responses", "/messages"])).toBe("responses");
		expect(selectCommandCodeEndpoint("foo-model", { supportedEndpoints: ["/messages"] })).toBe(
			"messages",
		);
		expect(
			selectCommandCodeEndpoint("claude-haiku-5-5", {
				protocol: "completions-compatible",
				supportedEndpoints: ["/messages"],
			}),
		).toBe("completions");
	});

	test("gemini 协议没有 Command Code 端点，退回模型名规则", () => {
		expect(
			selectCommandCodeEndpoint("CommandCode:claude-haiku-5-5", {
				protocol: "gemini-compatible",
			}),
		).toBe("messages");
		expect(commandCodeApiOrigin("https://proxy.example/provider/v1")).toBe("https://proxy.example");
		expect(commandCodeApiOrigin(undefined)).toBe("https://api.commandcode.ai");
	});

	test("逐模型覆盖优先于默认规则", () => {
		const overrides = { "claude-haiku-5-5": "completions", "gpt-5.6-luna": "responses" } as const;
		expect(resolveCommandCodeEndpoint("claude-haiku-5-5", overrides)).toBe("completions");
		expect(resolveCommandCodeEndpoint("gpt-5.6-luna", overrides)).toBe("responses");
	});
});

describe("Command Code 模型列表解析（结构取自实测响应）", () => {
	test("解析 id / 端点能力 / 上下文长度", () => {
		const models = parseCommandCodeModels({
			object: "list",
			data: [
				{
					id: "claude-sonnet-5-5",
					name: "Claude Sonnet 5.5",
					context_length: 1000000,
					supported_endpoints: ["/messages"],
				},
				{ id: "gpt-5.6-luna", supported_endpoints: ["/chat/completions", "/responses"] },
			],
		});
		expect(models.length).toBe(2);
		expect(models[0]?.endpoints).toEqual(["/messages"]);
		expect(models[0]?.contextLength).toBe(1000000);
		expect(models[1]?.endpoints).toContain("/chat/completions");
	});

	test("畸形输入返回空数组而不抛错", () => {
		expect(parseCommandCodeModels(null)).toEqual([]);
		expect(parseCommandCodeModels({})).toEqual([]);
		expect(parseCommandCodeModels({ data: [{ noId: 1 }] })).toEqual([]);
		expect(parseCommandCodeModels({ data: "x" })).toEqual([]);
	});

	test("响应体超过上限时取消读取", async () => {
		const response = new Response("x".repeat(8 * 1024));
		await expect(readResponseJsonLimited(response, 1024)).rejects.toThrow("response_too_large");
	});

	test("Provider API 根地址取自实测", () => {
		expect(COMMAND_CODE_PROVIDER_BASE).toBe("https://api.commandcode.ai/provider/v1");
	});
});

describe("Command Code 额度解析（结构取自实测响应）", () => {
	test("解析嵌套的 credits", () => {
		const { credits } = parseCommandCodeCredits({
			credits: {
				monthlyCredits: 25.5435786986,
				purchasedCredits: 0,
				freeCredits: 0,
				creditThreshold: 0,
				belowThreshold: false,
			},
		});
		expect(credits.monthlyCredits).toBeCloseTo(25.5436, 4);
		expect(credits.belowThreshold).toBe(false);
	});

	test("解析 5 小时与周滚动窗口", () => {
		const { windowLimits } = parseCommandCodeCredits({
			windowLimits: {
				limited: true,
				fiveHour: { used: 1.057, cap: 14, exceeded: false, resetAt: 1792305100492 },
				weekly: { used: 9.389, cap: 35, exceeded: false, resetAt: 1792637339993 },
			},
		});
		expect(windowLimits?.limited).toBe(true);
		expect(windowLimits?.fiveHour?.cap).toBe(14);
		expect(windowLimits?.fiveHour?.resetAt).toBe(1792305100492);
		expect(windowLimits?.weekly?.used).toBeCloseTo(9.389, 3);
	});

	test("字段缺失或类型不符都降级为 0 / undefined", () => {
		expect(parseCommandCodeCredits({}).credits.monthlyCredits).toBe(0);
		expect(parseCommandCodeCredits(null).credits.monthlyCredits).toBe(0);
		expect(parseCommandCodeCredits({}).windowLimits).toBeUndefined();
		expect(
			parseCommandCodeCredits({ credits: { monthlyCredits: "25" } }).credits.monthlyCredits,
		).toBe(0);
		expect(
			parseCommandCodeCredits({ windowLimits: { limited: true, fiveHour: null } }).windowLimits
				?.fiveHour,
		).toBeUndefined();
	});

	test("解析 usage summary，非对象返回 undefined", () => {
		const summary = parseCommandCodeSummary({
			totalCount: 9705,
			totalTokens: 4281721543,
			successRate: 100,
			periodStart: "2026-10-08T02:00:13.000Z",
		});
		expect(summary?.totalCount).toBe(9705);
		expect(summary?.successRate).toBe(100);
		expect(parseCommandCodeSummary(null)).toBeUndefined();
	});

	test("快照保留原响应，并派生窗口、月额度与统一额度跳过", () => {
		const usage = {
			credits: {
				monthlyCredits: 4,
				purchasedCredits: 2,
				freeCredits: 1,
				creditThreshold: 0.5,
				belowThreshold: false,
			},
			windowLimits: {
				limited: true,
				fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: Date.now() + 60_000 },
				weekly: { used: 3, cap: 10, exceeded: false },
			},
			sandboxAccess: true,
			summary: {
				totalCount: 8,
				totalTokens: 100,
				totalTokensIn: 60,
				totalTokensOut: 40,
				successRate: 100,
				completedCount: 8,
				failedCount: 0,
				totalMonthlyCredits: 6,
				periodStart: "2026-11-01T00:00:00.000Z",
			},
		};
		const snapshot = commandCodeUsageSnapshot(usage, 1234);
		expect(snapshot.scope).toBe("subscription");
		expect(snapshot.fetchedAt).toBe(1234);
		expect(snapshot.windows).toEqual([
			{ kind: "5h", usedRatio: 1, resetsAt: usage.windowLimits.fiveHour.resetAt },
			{ kind: "weekly", usedRatio: 0.3, resetsAt: null },
		]);
		expect(snapshot.balances).toEqual([{ unit: "credits", remaining: 4, total: 10 }]);
		expect(snapshot.detail).toEqual(usage);
		quotaStore.set("CommandCode", "test", snapshot);
		expect(keyQuotaBlockedUntil("CommandCode")).toBe(usage.windowLimits.fiveHour.resetAt);
		quotaStore.remove("CommandCode");
	});

	test("零 cap 不猜测用量，summary 缺失时月额度没有 total", () => {
		const { credits, windowLimits } = parseCommandCodeCredits({
			credits: { monthlyCredits: 2 },
			windowLimits: { fiveHour: { used: 1, cap: 0, exceeded: false } },
		});
		const snapshot = commandCodeUsageSnapshot({ credits, windowLimits });
		expect(snapshot.windows[0]).toEqual({ kind: "5h", usedRatio: null, resetsAt: null });
		expect(snapshot.balances).toEqual([{ unit: "credits", remaining: 2 }]);
	});

	test("summary 阶段的取消不会被降级成一次成功探测", async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls === 1) return Response.json({ credits: { monthlyCredits: 1 } });
			controller.abort();
			throw new Error("summary abort");
		}) as unknown as typeof fetch;
		try {
			await expect(
				probeCommandCodeQuota(
					{
						id: "CommandCode",
						providerId: "CommandCode",
						config: { apiKey: "key" },
					},
					controller.signal,
				),
			).rejects.toThrow("summary abort");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
