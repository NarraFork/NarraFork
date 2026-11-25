import { afterAll, expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";
import { setNugCachedModels } from "../../nug-model-cache";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	resetProviderKeyStoreForTests,
	TOKENDANCE_KEY_OWNER,
} from "../../provider-keys";
import { saveSettings, settings } from "../../settings";
import { registerTokenDanceRuntime } from "../../tokendance-runtime";
import { PooledProvider, resetProviderKeyRuntimeForTests } from "../pooled-provider";
import { resolveProviderAndModel } from "../provider";

// Storage-specific restart coverage. Pure memory/transport matrices run only in
// source-key-pools.test.ts; migration billing has its own real factory/restart suite.
const credentials = seedUnifiedCredentials();
const saved = structuredClone(settings);
const nugId = "unified-resolver-nug";
const unregister = registerTokenDanceRuntime({
	getTokenDanceRuntimeConfig: () => settings.tokendance,
	getTokenDanceCatalogModels: () => [
		{ id: "m", name: "M", context_length: 8192, supported_protocols: ["openai:chat-completions"] },
	],
	assertTokenDanceConnection: () => {},
	registerTokenDanceRequest: () => () => {},
});
afterAll(() => {
	unregister();
	for (const owner of [TOKENDANCE_KEY_OWNER, COMMAND_CODE_KEY_OWNER, nugKeyOwner(nugId)])
		getProviderKeyStore().removeProvider(owner);
	saveSettings(saved);
	resetProviderKeyRuntimeForTests();
});

for (const [owner, modelId] of [
	[TOKENDANCE_KEY_OWNER, "tokendance:m"],
	[COMMAND_CODE_KEY_OWNER, "CommandCode:gpt-test"],
	[nugKeyOwner(nugId), "unifiednug:upstream:m"],
] as const) {
	test(`${owner}: persisted order, disabled state and network survive rebuild into the real resolver`, () => {
		saveSettings({
			...settings,
			agent: { ...settings.agent, disabledProviders: [] },
			tokendance: { apiKey: "", generation: 1, disabled: false },
			commandCode: { apiKey: "", disabled: false },
			nugProviders: [
				{
					id: nugId,
					name: "Unified NUG",
					prefix: "unifiednug",
					apiKey: "",
					baseUrl: "https://unified-nug.invalid",
					defaultModel: "upstream:m",
				},
			],
		});
		const store = getProviderKeyStore();
		store.removeProvider(owner);
		const first = store.add(owner, { apiKey: "unified-first" });
		const second = store.add(owner, {
			apiKey: "unified-second",
			network: { userAgentMode: "custom", customUserAgent: "second-agent" },
		});
		store.update(first.id, { disabled: true });
		store.reorder(owner, [second.id, first.id]);
		resetProviderKeyStoreForTests();
		resetProviderKeyRuntimeForTests();
		const rebuilt = getProviderKeyStore();
		expect(rebuilt.list(owner).map((key) => key.id)).toEqual([second.id, first.id]);
		expect(rebuilt.get(second.id)?.network).toEqual(second.network);
		expect(rebuilt.get(first.id)?.disabled).toBe(true);
		setNugCachedModels(nugId, [
			{ id: "upstream:m", channel: "upstream", channelType: "openai", model: "m" },
		]);
		const { adapter } = resolveProviderAndModel(modelId);
		expect(adapter).toBeInstanceOf(PooledProvider);
		// Resolver preparation must expose the real delegate without sending a request.
		expect(adapter.getActiveReasoningSource?.()).toBeTruthy();
		rebuilt.update(second.id, { disabled: true });
		expect(() => resolveProviderAndModel(modelId)).toThrow("no usable API key");
		expect(credentials.written()).toBe(true);
	});
}
