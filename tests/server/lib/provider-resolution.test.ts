import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, resolveProviderAndModel } from "../../../server/lib/agent/provider";
import { __setCodexManagerForTests, CodexManager } from "../../../server/lib/codex-manager";
import { AppError } from "../../../server/lib/errors";
import { deleteNugCachedModels, setNugCachedModels } from "../../../server/lib/nug-model-cache";
import { isProviderUnavailableError } from "../../../server/lib/provider-availability-error";
import {
	expandAllowedPoolForDisplay,
	getContextThresholds,
	getModelContextWindow,
	LARGE_CONTEXT_BOUNDARY,
	resolveAllowedModelCandidate,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../../../server/lib/settings";

const settingsKeys = Object.keys(settings) as Array<keyof typeof settings>;
const tempDirs: string[] = [];

function cloneSettingsSnapshot() {
	return structuredClone(settings);
}

function restoreFromSnapshot(snapshot: ReturnType<typeof cloneSettingsSnapshot>): void {
	for (const key of settingsKeys) {
		// biome-ignore lint/suspicious/noExplicitAny: generic key/value restoration in test helper
		(settings as any)[key] = snapshot[key];
	}
}

function resetProviders(): void {
	settings.openaiProviders = [];
	settings.anthropicProviders = [];
	settings.nugProviders = [];
	settings.codex = undefined;
	if (settings.agent) {
		settings.agent.customModels = [];
	}
}

function createTempCodexManagerWithCredential(): CodexManager {
	const tempHome = mkdtempSync(join(tmpdir(), "narrafork-provider-resolution-"));
	tempDirs.push(tempHome);
	const credsDir = join(tempHome, ".narrafork");
	mkdirSync(credsDir, { recursive: true });
	writeFileSync(
		join(credsDir, "codex-credentials.json"),
		JSON.stringify(
			[
				{
					id: "cred-test",
					refreshToken: "test-refresh-token",
					priority: 0,
					disabled: false,
				},
			],
			null,
			2,
		),
	);
	return new CodexManager({ homeDir: tempHome, registerProcessHooks: false });
}

function addOpenaiProvider(prefix: string): void {
	settings.openaiProviders = [
		{
			id: `${prefix}-id`,
			name: `${prefix}-name`,
			prefix,
			apiKey: "test-key",
			baseUrl: "https://api.openai.com/v1",
			defaultModel: "gpt-4o",
		},
	];
}

function addAnthropicProvider(prefix: string): void {
	settings.anthropicProviders = [
		{
			id: `${prefix}-id`,
			name: `${prefix}-name`,
			prefix,
			apiKey: "anthropic-key",
			baseUrl: "https://api.anthropic.com/v1",
			defaultModel: "claude-sonnet-4-20250514",
		},
	];
}

describe("resolveProvider fallback order", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		resetProviders();
		__setCodexManagerForTests(undefined);
	});
	afterEach(() => {
		restoreFromSnapshot(snapshot);
		__setCodexManagerForTests(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unknown model 优先 fallback 到已配置 openai provider", () => {
		addOpenaiProvider("deepseek");
		const provider = resolveProvider("unknown-model");
		expect(provider).toBe("deepseek");
	});

	test("unknown model 无 openai 时 fallback 到 anthropic provider", () => {
		addAnthropicProvider("anthropic-cn");
		const provider = resolveProvider("unknown-model");
		expect(provider).toBe("anthropic-cn");
	});

	test("unknown model 无 openai/anthropic 但有 codex 可用凭据时 fallback 到 codex", () => {
		settings.codex = {};
		const manager = createTempCodexManagerWithCredential();
		__setCodexManagerForTests(manager);
		const provider = resolveProvider("unknown-model");
		expect(provider).toBe("codex");
	});

	test("无任何 provider 配置时 fallback 到 anthropic", () => {
		const provider = resolveProvider("unknown-model");
		expect(provider).toBe("anthropic");
	});

	test("explicit provider prefix 保持优先", () => {
		addOpenaiProvider("deepseek");
		const provider = resolveProvider("anthropic:gpt-4o");
		expect(provider).toBe("anthropic");
	});

	test("GPT-6 系列作为 builtin Codex 模型解析", () => {
		expect(resolveProvider("gpt-6-astra")).toBe("codex");
		expect(resolveProvider("gpt-6-sol")).toBe("codex");
		expect(resolveProvider("gpt-6-luna")).toBe("codex");
	});

	test("已退役的内置 Codex 模型不再强制解析为 Codex", () => {
		for (const model of ["gpt-5.1-codex", "gpt-5.3-codex-spark", "gpt-5.4"]) {
			expect(resolveProvider(model)).not.toBe("codex");
		}
	});
});

describe("getProvider fallback behavior", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		resetProviders();
		__setCodexManagerForTests(undefined);
	});
	afterEach(() => {
		restoreFromSnapshot(snapshot);
		__setCodexManagerForTests(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unknown provider 直接报错而非静默回退", () => {
		addOpenaiProvider("deepseek");
		expect(() => getProvider("unknown-provider")).toThrow(
			/Provider "unknown-provider" is not configured/,
		);
	});

	test("显式 openai provider 返回 OpenAIProvider", () => {
		addOpenaiProvider("deepseek");
		const provider = getProvider("deepseek");
		expect(provider.constructor.name).toBe("OpenAIProvider");
	});
});

describe("resolveProviderAndModel behavior", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		resetProviders();
		__setCodexManagerForTests(undefined);
	});
	afterEach(() => {
		restoreFromSnapshot(snapshot);
		__setCodexManagerForTests(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("未配置的 provider 直接报错而非静默回退", () => {
		addOpenaiProvider("deepseek");
		expect(() => resolveProviderAndModel("acme:some-model")).toThrow(
			/Provider "acme" is not configured/,
		);
	});

	test("provider 未变更时保留原模型", () => {
		addOpenaiProvider("deepseek");
		const resolved = resolveProviderAndModel("deepseek:deepseek-chat");
		expect(resolved.provider).toBe("deepseek");
		expect(resolved.model).toBe("deepseek:deepseek-chat");
	});

	test("follow-default sentinel 在 provider 解析前替换为真实默认模型", () => {
		addOpenaiProvider("deepseek");
		settings.agent.defaultModel = "deepseek:gpt-4o";

		const resolved = resolveProviderAndModel("__default__");

		expect(resolved.provider).toBe("deepseek");
		expect(resolved.model).toBe("deepseek:gpt-4o");
	});

	test("prefixed follow-default sentinel 不会作为模型名泄漏", () => {
		addOpenaiProvider("deepseek");
		settings.agent.defaultModel = "deepseek:gpt-4o";

		const resolved = resolveProviderAndModel("deepseek:__default__");

		expect(resolved.provider).toBe("deepseek");
		expect(resolved.model).toBe("deepseek:gpt-4o");
		expect(resolved.model).not.toContain("__default__");
	});

	test("follow-default 支持聚合默认模型并解析到成员模型", () => {
		addOpenaiProvider("deepseek");
		settings.agent.modelAggregations = [
			{
				id: "aggtest",
				name: "Test Aggregation",
				models: ["deepseek:gpt-4o"],
				routingMode: "priority",
			},
		];
		settings.agent.defaultModel = "__agg__:aggtest";

		const resolved = resolveProviderAndModel("__default__");

		expect(resolved.provider).toBe("deepseek");
		expect(resolved.model).toBe("deepseek:gpt-4o");
	});

	// 这里刻意不做硬 fallback：回退会命名一个用户从未配置的 provider，
	// 于是真正的问题（没有配置默认模型）被伪装成 provider 未配置错误，
	// 在初始设置阶段表现为凭空出现的模型。直接报错才指向真实原因。
	test("self-referential defaultModel 直接报错，不回退到硬编码模型", () => {
		settings.agent.defaultModel = "__default__";

		expect(() => resolveEffectiveModel("__default__")).toThrow(/No default model is configured/);
	});

	test("未配置 defaultModel 时解析 follow-default 直接报错", () => {
		settings.agent.defaultModel = "";

		expect(() => resolveEffectiveModel("__default__")).toThrow(/No default model is configured/);
	});

	test("未配置默认模型的报错是可本地化的 503，而不是不透明的 500", () => {
		// 必须是 AppError 且带 catalog 信息：裸 Error 会被全局 Hono handler
		// 兜成 "Internal server error" 500，把唯一可行动的信息（去设置里选一个
		// 默认模型）丢掉——External API v1 的调用方只能看到 500。
		settings.agent.defaultModel = "";

		let caught: unknown;
		try {
			resolveEffectiveModel("__default__");
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(AppError);
		const appError = caught as AppError;
		expect(appError.name).toBe("DefaultModelNotConfiguredError");
		expect(appError.statusCode).toBe(503);
		expect(appError.code).toBe("DEFAULT_MODEL_NOT_CONFIGURED");
		expect(appError.messageCode).toBe("DEFAULT_MODEL_NOT_CONFIGURED");
		// 重试无法修复它，所以不能落进 summary 模型的 transient 重试路径：
		// 那里会以退避重试数分钟，表现为请求挂住而不是报出真实原因。
		expect(isProviderUnavailableError(appError)).toBe(true);
	});

	test("未配置 defaultModel 不影响具体模型的解析", () => {
		// 报错必须只落在真正需要默认模型的路径上：显式选定模型的会话
		// 不应该因为实例还没配默认模型而失败。
		addOpenaiProvider("deepseek");
		settings.agent.defaultModel = "";

		expect(resolveEffectiveModel("deepseek:deepseek-chat")).toBe("deepseek:deepseek-chat");
	});

	test("summaryModel 未设置且 defaultModel 未配置时报错而非回退", () => {
		settings.agent.defaultModel = "";
		settings.agent.summaryModel = "";

		expect(() => resolveEffectiveModel("__summary__")).toThrow(/No default model is configured/);
	});

	test("空聚合的 defaultModel 报错而非回退到硬编码模型", () => {
		settings.agent.modelAggregations = [
			{
				id: "empty-agg",
				name: "Empty Aggregation",
				models: [],
				routingMode: "priority",
			},
		];
		settings.agent.defaultModel = "__agg__:empty-agg";

		expect(() => resolveEffectiveModel("__default__")).toThrow(/No default model is configured/);
	});

	test("未配置 defaultModel 时上下文窗口查询回落到默认档位而不是编造模型", () => {
		// 这是纯元数据查询（上下文窗口/能力），不能抛错；但也绝不能替换成一个
		// 具体模型——那会把某个用户从未选择的模型的上下文窗口当作事实上报。
		settings.agent.defaultModel = "";

		expect(() => getModelContextWindow("__default__", "")).not.toThrow();
	});

	test("allowed pool 匹配 follow-default 不推进 balanced 聚合轮询", () => {
		settings.agent.modelAggregations = [
			{
				id: "balanced-default-match",
				name: "Balanced Default Match",
				models: ["deepseek:model-a", "deepseek:model-b"],
				routingMode: "balanced",
			},
		];
		settings.agent.defaultModel = "__agg__:balanced-default-match";

		expect(resolveAllowedModelCandidate("__default__", ["__default__"])).toBe("__default__");
		expect(resolveEffectiveModel("__default__")).toBe("deepseek:model-a");
	});

	test("allowed pool 可将 follow-default 聚合限制到具体成员且不推进轮询", () => {
		settings.agent.modelAggregations = [
			{
				id: "balanced-default-concrete",
				name: "Balanced Default Concrete",
				models: ["deepseek:model-a", "deepseek:model-b"],
				routingMode: "balanced",
			},
		];
		settings.agent.defaultModel = "__agg__:balanced-default-concrete";

		expect(resolveAllowedModelCandidate("__default__", ["deepseek:model-b"])).toBe(
			"deepseek:model-b",
		);
		expect(resolveEffectiveModel("__default__")).toBe("deepseek:model-a");
	});
});

describe("follow-summary sentinel (__summary__)", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		resetProviders();
		settings.agent.modelAggregations = [];
		__setCodexManagerForTests(undefined);
	});
	afterEach(() => {
		restoreFromSnapshot(snapshot);
		__setCodexManagerForTests(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resolveEffectiveModel 解析到配置的摘要模型", () => {
		settings.agent.defaultModel = "deepseek:default-x";
		settings.agent.summaryModel = "deepseek:summary-y";
		expect(resolveEffectiveModel("__summary__")).toBe("deepseek:summary-y");
	});

	test("修改摘要模型设置后跟随变化", () => {
		settings.agent.summaryModel = "deepseek:summary-a";
		expect(resolveEffectiveModel("__summary__")).toBe("deepseek:summary-a");
		settings.agent.summaryModel = "deepseek:summary-b";
		expect(resolveEffectiveModel("__summary__")).toBe("deepseek:summary-b");
	});

	test("摘要模型未设置时回退到默认模型", () => {
		settings.agent.defaultModel = "deepseek:default-z";
		settings.agent.summaryModel = "";
		expect(resolveEffectiveModel("__summary__")).toBe("deepseek:default-z");
	});

	test("摘要模型自引用时回退到默认模型，避免递归", () => {
		settings.agent.defaultModel = "deepseek:default-z";
		settings.agent.summaryModel = "__summary__";
		expect(resolveEffectiveModel("__summary__")).toBe("deepseek:default-z");
	});

	test("摘要模型支持聚合并解析到成员模型", () => {
		settings.agent.modelAggregations = [
			{
				id: "sumagg",
				name: "Summary Agg",
				models: ["deepseek:m-a", "deepseek:m-b"],
				routingMode: "balanced",
			},
		];
		settings.agent.summaryModel = "__agg__:sumagg";
		expect(resolveEffectiveModel("__summary__")).toBe("deepseek:m-a");
	});

	test("allowed pool 含 __summary__ 时显式摘要目标模型可匹配", () => {
		settings.agent.summaryModel = "deepseek:summary-y";
		expect(resolveAllowedModelCandidate("deepseek:summary-y", ["__summary__"])).toBe(
			"deepseek:summary-y",
		);
		// 传哨兵本身也匹配
		expect(resolveAllowedModelCandidate("__summary__", ["__summary__"])).toBe("__summary__");
		// 不相关模型不匹配
		expect(resolveAllowedModelCandidate("deepseek:other", ["__summary__"])).toBeNull();
	});

	test("展示保留哨兵 token 并标注当前指向", () => {
		settings.agent.summaryModel = "deepseek:summary-y";
		expect(expandAllowedPoolForDisplay(["__summary__"])).toEqual([
			"summary (currently deepseek:summary-y)",
		]);
	});

	test("展示能区分 default 与 summary 两个哨兵", () => {
		settings.agent.defaultModel = "deepseek:default-x";
		settings.agent.summaryModel = "deepseek:summary-y";
		expect(expandAllowedPoolForDisplay(["__default__", "__summary__"])).toEqual([
			"default (currently deepseek:default-x)",
			"summary (currently deepseek:summary-y)",
		]);
	});
});

describe("getModelContextWindow / getContextThresholds 解析元模型引用", () => {
	let snapshot: ReturnType<typeof cloneSettingsSnapshot>;

	beforeEach(() => {
		snapshot = cloneSettingsSnapshot();
		resetProviders();
		settings.agent.modelAggregations = [];
		settings.agent.modelContextWindows = {};
		settings.agent.contextThresholds = undefined;
		__setCodexManagerForTests(undefined);
	});
	afterEach(() => {
		restoreFromSnapshot(snapshot);
		__setCodexManagerForTests(undefined);
		deleteNugCachedModels("nug-id");
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("NUG channel 模型优先使用模型目录中的上下文窗口", () => {
		settings.nugProviders = [
			{
				id: "nug-id",
				name: "NUG",
				prefix: "nug",
				apiKey: "test-key",
				baseUrl: "https://nug.example.test",
				defaultModel: "antigravity:claude-opus-4-6-thinking",
			},
		];
		setNugCachedModels("nug-id", [
			{
				id: "antigravity:claude-opus-4-6-thinking",
				model: "claude-opus-4-6-thinking",
				channel: "antigravity",
				channelType: "anthropic",
				contextWindow: 1_000_000,
			},
		]);

		expect(getModelContextWindow("nug:antigravity:claude-opus-4-6-thinking", "nug")).toBe(
			1_000_000,
		);
		expect(getContextThresholds("nug:antigravity:claude-opus-4-6-thinking", "nug")).toEqual({
			compactStart: 75,
		});
	});

	test("channel 前缀模型能回退到内置模型上下文窗口", () => {
		expect(getModelContextWindow("antigravity:claude-opus-4-6-thinking", "nug")).toBe(1_000_000);
	});

	test("聚合值(provider/model 被拆分)解析到成员模型的上下文窗口", () => {
		settings.agent.modelAggregations = [
			{
				id: "agg1m",
				name: "1M Agg",
				models: ["anthropic:claude-sonnet-4.6"],
				routingMode: "priority",
			},
		];
		// 模拟前端把 "__agg__:agg1m" 拆成 provider="__agg__", model="agg1m"
		expect(getModelContextWindow("agg1m", "__agg__")).toBe(1_000_000);
		// 也支持未拆分的完整聚合值
		expect(getModelContextWindow("__agg__:agg1m", "")).toBe(1_000_000);
	});

	test("聚合值不再静默回退到默认上下文长度", () => {
		settings.agent.modelAggregations = [
			{
				id: "aggbig",
				name: "Big Agg",
				models: ["anthropic:claude-sonnet-4.6"],
				routingMode: "priority",
			},
		];
		// 修复前：provider="__agg__"、model="aggbig" 匹配不到 → 回落默认值
		expect(getModelContextWindow("aggbig", "__agg__")).not.toBe(272_000);
	});

	test("pinned 聚合值解析到被钉住的成员", () => {
		settings.agent.modelAggregations = [
			{
				id: "aggpin",
				name: "Pinned Agg",
				models: ["anthropic:claude-sonnet-4.6", "deepseek:deepseek-chat"],
				routingMode: "priority",
			},
		];
		expect(getModelContextWindow("aggpin:deepseek:deepseek-chat", "__agg__")).toBe(64_000);
	});

	test("follow-default 哨兵解析到默认模型的上下文窗口", () => {
		settings.agent.defaultModel = "anthropic:claude-sonnet-4.6";
		expect(getModelContextWindow("__default__", "")).toBe(1_000_000);
	});

	test("聚合大上下文模型选中 large 档阈值", () => {
		settings.agent.modelAggregations = [
			{
				id: "agglarge",
				name: "Large Agg",
				models: ["anthropic:claude-sonnet-4.6"],
				routingMode: "priority",
			},
		];
		settings.agent.contextThresholds = {
			standard: { compactStart: 90 },
			large: { compactStart: 85 },
		};
		// 成员是 1M 模型，应越过 LARGE_CONTEXT_BOUNDARY 落 large 档
		expect(LARGE_CONTEXT_BOUNDARY).toBe(600_000);
		expect(getContextThresholds("agglarge", "__agg__")).toEqual({
			compactStart: 85,
		});
	});

	test("解析聚合上下文窗口不推进 balanced 轮询", () => {
		settings.agent.modelAggregations = [
			{
				id: "aggbal",
				name: "Balanced Agg",
				models: ["anthropic:claude-sonnet-4.6", "deepseek:deepseek-chat"],
				routingMode: "balanced",
			},
		];
		// 多次查询窗口应保持稳定(取第一个成员)，且不影响后续 resolveEffectiveModel 轮询
		expect(getModelContextWindow("aggbal", "__agg__")).toBe(1_000_000);
		expect(getModelContextWindow("aggbal", "__agg__")).toBe(1_000_000);
		expect(resolveEffectiveModel("__agg__:aggbal")).toBe("anthropic:claude-sonnet-4.6");
	});

	test("具体模型不受影响", () => {
		expect(getModelContextWindow("claude-sonnet-4.6", "anthropic")).toBe(1_000_000);
		expect(getModelContextWindow("deepseek-chat", "deepseek")).toBe(64_000);
	});

	test("Claude 4.7/4.8/5 系列与 fable/mythos 内置窗口为 1M", () => {
		for (const model of [
			"claude-opus-4-7",
			"claude-opus-4.7",
			"claude-opus-4-8",
			"claude-opus-4.8",
			"claude-sonnet-4-8",
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"claude-mythos-5",
			"claude-mythos-preview",
		]) {
			expect(getModelContextWindow(model, "anthropic")).toBe(1_000_000);
		}
	});

	test("1M 是默认值而非地板：显式配置的更小窗口优先", () => {
		// 用户给只支持 200k 的中转显式配置窗口时，不能被内置的 1M 覆盖，
		// 否则 context 百分比虚低、auto-compact 迟迟不触发。
		settings.anthropicProviders = [
			{
				id: "relay-id",
				name: "Relay",
				prefix: "relay",
				apiKey: "relay-key",
				baseUrl: "https://relay.example.test/v1",
				defaultModel: "claude-opus-4-8",
				defaultContextWindow: 200_000,
			},
		];
		expect(getModelContextWindow("claude-opus-4-8", "relay")).toBe(200_000);
		// 未显式配置时才兜到内置的 1M。
		expect(getModelContextWindow("claude-opus-4-8", "anthropic")).toBe(1_000_000);
	});

	test("per-model 覆盖优先于内置 1M", () => {
		settings.agent.modelContextWindows = { "anthropic:claude-opus-4-8": 300_000 };
		expect(getModelContextWindow("claude-opus-4-8", "anthropic")).toBe(300_000);
		settings.agent.modelContextWindows = {};
	});
});
