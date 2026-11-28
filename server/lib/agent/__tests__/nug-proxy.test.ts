import { describe, expect, test } from "bun:test";
import type { ResolvedNugModelMeta } from "../../nug-model-cache";
import { buildNugDelegateBaseConfig, type NugInferenceConfig } from "../nug-delegate-config";

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
		const config: NugInferenceConfig = {
			id: "nug-test",
			name: "NUG Test",
			prefix: "nug",
			apiKey: "test-key",
			baseUrl: "https://nug.example.test",
			defaultModel: "responses:model",
			proxy: { mode: "custom", url: "http://proxy.example.test:8080" },
			toolResultImages: "separate",
			extraHeaders: { "X-Identity": "key", "x-nug-model-hash": "stale" },
		};
		const extraHeaders = { "x-nug-model-hash": "hash" };

		for (const channelType of ["codex", "openai", "responses", "anthropic"]) {
			const delegateConfig = buildNugDelegateBaseConfig(
				config,
				modelMeta(channelType),
				extraHeaders,
			);
			expect(delegateConfig.proxy).toEqual(config.proxy);
			expect(delegateConfig.toolResultImages).toBe("separate");
			expect(delegateConfig.defaultModel).toBe(`${channelType}:model`);
			expect(delegateConfig.extraHeaders).toEqual({ "X-Identity": "key", ...extraHeaders });
			expect(config.extraHeaders?.["x-nug-model-hash"]).toBe("stale");
		}
	});
});
