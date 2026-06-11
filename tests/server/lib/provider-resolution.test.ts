import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, resolveProviderAndModel } from "../../../server/lib/agent/provider";
import { __setCodexManagerForTests, CodexManager } from "../../../server/lib/codex-manager";
import {
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
	settings.clineProviders = [];
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
		} else {
		}
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

		};
		const provider = resolveProvider("unknown-model");
	});

		const provider = resolveProvider("unknown-model");
	});

	test("explicit provider prefix 保持优先", () => {
		addOpenaiProvider("deepseek");
		const provider = resolveProvider("anthropic:gpt-4o");
		expect(provider).toBe("anthropic");
	});

	test("builtin codex model 仍解析为 codex", () => {
		const provider = resolveProvider("gpt-5.1-codex");
		expect(provider).toBe("codex");
	});

	test("builtin codex spark model 解析为 codex", () => {
		const provider = resolveProvider("gpt-5.3-codex-spark");
		expect(provider).toBe("codex");
	});

		const provider = resolveProvider("claude-sonnet");
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
		} else {
		}
		__setCodexManagerForTests(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

		addOpenaiProvider("deepseek");
	});

	});

	test("unknown provider 直接报错而非静默回退", () => {
		addOpenaiProvider("deepseek");
		expect(() => getProvider("unknown-provider")).toThrow(
			/Provider "unknown-provider" is not configured/,
		);
	});

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
		} else {
		}
		__setCodexManagerForTests(undefined);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

		addOpenaiProvider("deepseek");
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

	test("self-referential defaultModel 使用硬 fallback，避免递归返回占位符", () => {
		settings.agent.defaultModel = "__default__";

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
