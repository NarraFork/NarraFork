import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, resolveProviderAndModel } from "../../../server/lib/agent/provider";
import { __setCodexManagerForTests, CodexManager } from "../../../server/lib/codex-manager";
import { resolveProvider, settings } from "../../../server/lib/settings";

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
	settings.codex = undefined;
	settings.agent.customModels = [];
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
		expect(provider.constructor.name).toBe("OpenAIProvider");
	});

		);
	});

		addOpenaiProvider("deepseek");
		const provider = getProvider("unknown-provider");
		expect(provider.constructor.name).toBe("OpenAIProvider");
	});

		expect(() => getProvider("unknown-provider")).toThrow(
			'Provider "unknown-provider" is not configured, and no fallback provider is available.',
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
		expect(resolved.provider).toBe("deepseek");
		expect(resolved.adapter.constructor.name).toBe("OpenAIProvider");
		expect(resolved.model).toBe("deepseek:gpt-4o");
	});

	test("provider 未变更时保留原模型", () => {
		addOpenaiProvider("deepseek");
		const resolved = resolveProviderAndModel("deepseek:deepseek-chat");
		expect(resolved.provider).toBe("deepseek");
		expect(resolved.model).toBe("deepseek:deepseek-chat");
	});
});
