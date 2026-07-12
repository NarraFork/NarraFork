import { describe, expect, test } from "bun:test";
import type { ResolvedNugModelMeta } from "../../nug-model-cache";
import type { NUGProviderConfig } from "../../settings";
import { buildNugDelegateBaseConfig } from "../nug-delegate-config";

function modelMeta(channelType: string): ResolvedNugModelMeta {
	return {
		providerId: "nug-test",
		providerPrefix: "nug",
		nugModelId: `${channelType}:model`,
		routedModel: `${channelType}:model`,
		channel: channelType,
		channelType,
		bareModel: "model",
	};
}

describe("NUG proxy override", () => {
	test("includes the provider override in the shared delegate configuration", () => {
		const config: NUGProviderConfig = {
			id: "nug-test",
			name: "NUG Test",
			prefix: "nug",
			apiKey: "test-key",
			baseUrl: "https://nug.example.test",
			defaultModel: "responses:model",
			proxy: { mode: "custom", url: "http://proxy.example.test:8080" },
		};
		const extraHeaders = { "x-nug-model-hash": "hash" };

		for (const channelType of ["codex", "openai", "responses", "anthropic"]) {
			const delegateConfig = buildNugDelegateBaseConfig(
				config,
				modelMeta(channelType),
				extraHeaders,
			);
			expect(delegateConfig.proxy).toEqual(config.proxy);
			expect(delegateConfig.defaultModel).toBe(`${channelType}:model`);
			expect(delegateConfig.extraHeaders).toBe(extraHeaders);
		}
	});
});
