import { afterEach, describe, expect, test } from "bun:test";
import { invalidateCommandCodeAuthCache, resolveCommandCodeToken } from "../commandcode-manager";
import { invalidateCommandCodeModelsCache, listCommandCodeModels } from "../commandcode-models";
import { getSubagentVisibleModels, getVisibleModels, settings } from "../settings";

/**
 * Command Code 的模型来自上游目录（`GET /provider/v1/models`），不是 settings 里的静态列表。
 * 这曾经让枚举路径和调用路径脱节：显式传 `CommandCode:<model>` 能正常跑子代理，但 Agent 工具
 * 说明的 model 名单里没有它，AI 助手据此误判模型不可用。
 *
 * 这些用例钉住那条枚举路径（Agent 工具实际消费的是 `getSubagentVisibleModels()`，两条都断言），
 * 并确认 commandCode.disabled 与 hiddenModels 仍然生效。
 */

const BASE = "https://models.example/provider/v1";
const MODEL_ID = "deepseek/deepseek-v4.1-flash";
const MODEL = `CommandCode:${MODEL_ID}`;
const OTHER_KEY = "other_key";
const OTHER_MODEL_ID = "qwen/other-model";
const OTHER_MODEL = `CommandCode:${OTHER_MODEL_ID}`;

const originalFetch = globalThis.fetch;
const originalCommandCode = settings.commandCode;
const originalHiddenModels = settings.agent.hiddenModels;

/** 本机有没有 CLI 凭据决定了"无凭据"用例能不能跑，见文件末尾。 */
const hasCliCredential = !!resolveCommandCodeToken(undefined, { fresh: true }).credential;

function stubCatalog(modelIds: string[]): void {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				data: modelIds.map((id) => ({ id, supported_endpoints: ["/chat/completions"] })),
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as unknown as typeof fetch;
}

/** 用一次上游响应把目录装进缓存——getVisibleModels 只读缓存，自己不发请求。 */
async function primeCatalog(apiKey = "test_key", modelId = MODEL_ID): Promise<void> {
	stubCatalog([modelId]);
	await listCommandCodeModels(apiKey, BASE);
}

function configureCommandCode(apiKey: string, disabled: boolean): void {
	settings.commandCode = { disabled, apiKey, baseUrl: BASE };
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	invalidateCommandCodeModelsCache();
	invalidateCommandCodeAuthCache();
	settings.commandCode = originalCommandCode;
	settings.agent.hiddenModels = originalHiddenModels;
});

describe("Command Code models in the agent model list", () => {
	test("an enabled provider's catalog models are visible to agents and subagents", async () => {
		await primeCatalog();
		configureCommandCode("test_key", false);

		expect(getVisibleModels()).toContain(MODEL);
		expect(getSubagentVisibleModels()).toContain(MODEL);
	});

	test("a disabled provider contributes no models", async () => {
		await primeCatalog();
		configureCommandCode("test_key", true);

		expect(getVisibleModels()).not.toContain(MODEL);
		expect(getSubagentVisibleModels()).not.toContain(MODEL);
	});

	test("hiddenModels still hides a Command Code model", async () => {
		await primeCatalog();
		configureCommandCode("test_key", false);
		settings.agent.hiddenModels = [...(originalHiddenModels ?? []), MODEL];

		// Agent 工具读的是 subagent 名单，两个入口都要挡住。
		expect(getVisibleModels()).not.toContain(MODEL);
		expect(getSubagentVisibleModels()).not.toContain(MODEL);
	});

	test("a catalog cached for another credential does not leak into the list", async () => {
		await primeCatalog("test_key", MODEL_ID);
		stubCatalog([OTHER_MODEL_ID]);
		configureCommandCode(OTHER_KEY, false);

		// 缓存按 token + base 分槽：test_key 的目录既不算 other_key 的，也不该露出来。
		const beforeFetch = getVisibleModels();
		expect(beforeFetch).not.toContain(MODEL);
		expect(beforeFetch).not.toContain(OTHER_MODEL);

		// other_key 自己的目录落地后才出现，且只有它自己的模型。
		await listCommandCodeModels(OTHER_KEY, BASE);
		const afterFetch = getVisibleModels();
		expect(afterFetch).not.toContain(MODEL);
		expect(afterFetch).toContain(OTHER_MODEL);
	});

	test.skipIf(hasCliCredential)(
		"no credential contributes no models and never reaches the upstream",
		() => {
			let calls = 0;
			globalThis.fetch = (async () => {
				calls += 1;
				throw new Error("must not reach the upstream");
			}) as unknown as typeof fetch;
			// 设置里没有 apiKey，本机也没有 CLI 凭据（否则本用例跳过）。
			configureCommandCode("", false);

			expect(getVisibleModels().some((model) => model.startsWith("CommandCode:"))).toBe(false);
			expect(calls).toBe(0);
		},
	);
});
