import { describe, expect, test } from "bun:test";
import {
	initializeTokenDanceModelCollection,
	TOKENDANCE_COLLECTED_MODEL_IDS,
} from "../tokendance-model-collection";
import type { NarraForkSettings } from "../types";

type ConnectedSettings = NarraForkSettings & {
	tokendance: NonNullable<NarraForkSettings["tokendance"]>;
};

function config(): ConnectedSettings {
	return {
		tokendance: { apiKey: "test-key", disabled: false, generation: 1 },
		agent: { hiddenModels: ["other:keep-hidden"] },
	} as ConnectedSettings;
}

describe("TokenDance fixed collection snapshot", () => {
	test("snapshot collects exactly 66 unique existing IDs", () => {
		expect(TOKENDANCE_COLLECTED_MODEL_IDS).toHaveLength(66);
		expect(new Set(TOKENDANCE_COLLECTED_MODEL_IDS).size).toBe(66);
	});
	test("the five retained IDs and future models remain visible by default", () => {
		const settings = config();
		expect(initializeTokenDanceModelCollection(settings)).toBe(true);
		for (const id of [
			"kimi-k3",
			"glm-5.3",
			"glm-5.3-flash",
			"deepseek-v4.1-flash",
			"qwen3.8-flash",
			"future-new-model",
		]) {
			expect(settings.agent.hiddenModels).not.toContain(`tokendance:${id}`);
		}
		expect(settings.agent.hiddenModels).toContain("tokendance:glm-5.3-flashx");
		expect(settings.agent.hiddenModels).toContain("other:keep-hidden");
	});
	test("manual enabling and hiding retained models survive subsequent initialization", () => {
		const settings = config();
		initializeTokenDanceModelCollection(settings);
		settings.agent.hiddenModels = settings.agent.hiddenModels?.filter(
			(id) => id !== "tokendance:glm-5",
		);
		settings.agent.hiddenModels?.push("tokendance:kimi-k3");
		const before = structuredClone(settings);
		expect(initializeTokenDanceModelCollection(settings)).toBe(false);
		expect(settings).toEqual(before);
		expect(settings.agent.hiddenModels).not.toContain("tokendance:glm-5");
		expect(settings.agent.hiddenModels).toContain("tokendance:kimi-k3");
	});
	test("snapshot does not depend on a live catalog and cannot expand with new models", () => {
		const settings = config();
		settings.tokendance.models = [
			{
				id: "future-new-model",
				name: "Future",
				context_length: 1000,
				supported_protocols: ["openai:responses"],
			},
		];
		initializeTokenDanceModelCollection(settings);
		expect(settings.agent.hiddenModels).not.toContain("tokendance:future-new-model");
		expect(settings.tokendance?.models).toHaveLength(1);
	});
	test("existing hidden entries are preserved and duplicate entries are not created", () => {
		const settings = config();
		settings.agent.hiddenModels?.push("tokendance:glm-5", "tokendance:kimi-k3");
		initializeTokenDanceModelCollection(settings);
		expect(settings.agent.hiddenModels?.filter((id) => id === "tokendance:glm-5")).toHaveLength(1);
		expect(settings.agent.hiddenModels).toContain("tokendance:kimi-k3");
	});
	test("disconnected installations and legacy manual prefixes remain untouched", () => {
		const settings = config();
		settings.tokendance.apiKey = "";
		settings.agent.hiddenModels?.push("tokendance:manual-model");
		const before = structuredClone(settings);
		expect(initializeTokenDanceModelCollection(settings)).toBe(false);
		expect(settings).toEqual(before);
	});
	test("disabled platform connections are initialized once and preserve later choices", () => {
		const settings = config();
		settings.tokendance.disabled = true;
		expect(initializeTokenDanceModelCollection(settings)).toBe(true);
		settings.agent.hiddenModels = [];
		expect(initializeTokenDanceModelCollection(settings)).toBe(false);
		expect(settings.agent.hiddenModels).toEqual([]);
	});
});
