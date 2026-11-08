import { describe, expect, test } from "bun:test";
import type { AutoModelInfo } from "@shared/auto-model";
import { autoModelCountFor, autoModelsOnlyServedBy } from "./auto-participation";

const model = (modelId: string, ...providers: string[]): AutoModelInfo => ({
	value: `auto:${modelId}`,
	modelId,
	name: modelId,
	sources: providers.map((provider) => ({
		value: `${provider}:${modelId}`,
		provider,
		available: true,
		subscription: false,
	})),
});

describe("auto participation", () => {
	const models = [model("gpt-5.5", "codex", "relay"), model("glm-5.3", "relay"), model("kimi-k3")];

	test("a model is stranded only when this provider is its single source", () => {
		expect(autoModelsOnlyServedBy(models, "relay").map((m) => m.modelId)).toEqual(["glm-5.3"]);
		expect(autoModelsOnlyServedBy(models, "codex")).toEqual([]);
		// A model with no source left is already unusable; turning something off changes nothing.
		expect(autoModelsOnlyServedBy(models, "nobody")).toEqual([]);
	});

	test("counts the models a provider serves through auto", () => {
		expect(autoModelCountFor(models, "relay")).toBe(2);
		expect(autoModelCountFor(models, "codex")).toBe(1);
		expect(autoModelCountFor(models, "nobody")).toBe(0);
	});
});
