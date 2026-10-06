import { describe, expect, test } from "bun:test";
import { catalogError } from "../../errors";
import { settings } from "../../settings";
import {
	getProvider,
	registerExternalProviderResolver,
	resolveProviderAndModel,
} from "../provider";

// Keep old model values inert even after the scripted provider is deleted.
describe("retired tutorial provider", () => {
	for (const model of [
		"tutorial:guide",
		"tutorial:guide/first-turn/en",
		"tutorial:guide/tool-calls/zh-CN",
		"tutorial:guide/subagents/zh-CN/explore",
		"tutorial:unknown-lesson",
	]) {
		test(`rejects ${model} locally with a retirement error`, () => {
			expect(() => resolveProviderAndModel(model)).toThrow(catalogError("TUTORIAL_REMOVED"));
		});
	}

	test("also rejects a retired default model and direct provider lookup", () => {
		settings.agent.defaultModel = "tutorial:guide/first-turn/en";
		expect(() => resolveProviderAndModel()).toThrow(catalogError("TUTORIAL_REMOVED"));
		expect(() => getProvider("tutorial")).toThrow(catalogError("TUTORIAL_REMOVED"));
	});

	test("a configured API cannot claim the retired prefix", () => {
		settings.customApiProviders = [
			{
				id: "retirement-test",
				name: "A provider trying to claim the old prefix",
				prefix: "tutorial",
				apiKey: "test-only",
				baseUrl: "https://provider.invalid/v1",
				defaultModel: "guide",
				protocol: "responses-compatible",
			},
		];
		expect(() => resolveProviderAndModel("tutorial:guide/first-turn/en")).toThrow(
			catalogError("TUTORIAL_REMOVED"),
		);
	});

	test("a plugin never receives retired model requests", () => {
		let pluginResolverCalls = 0;
		const unregister = registerExternalProviderResolver(() => {
			pluginResolverCalls++;
			return {} as never;
		});
		try {
			expect(() => resolveProviderAndModel("tutorial:guide/first-turn/en")).toThrow(
				catalogError("TUTORIAL_REMOVED"),
			);
			expect(() => getProvider("tutorial")).toThrow(catalogError("TUTORIAL_REMOVED"));
			expect(pluginResolverCalls).toBe(0);
		} finally {
			unregister();
		}
	});

	test("a distinct provider whose name starts with tutorial is unaffected", () => {
		const adapter = {} as never;
		const unregister = registerExternalProviderResolver((provider) =>
			provider === "tutorial-mirror" ? adapter : null,
		);
		try {
			const resolved = resolveProviderAndModel("tutorial-mirror:chat");
			expect(resolved.adapter).toBe(adapter);
			expect(resolved.model).toBe("tutorial-mirror:chat");
		} finally {
			unregister();
		}
	});
});
