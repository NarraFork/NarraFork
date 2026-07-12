import { describe, expect, test } from "bun:test";
import {
	clearNarratorRuntimeModel,
	getNarratorRuntimeModel,
	recordNarratorRuntimeModel,
} from "../narrator-session-state";

describe("narrator runtime model cache", () => {
	test("returns the latest concrete member only for the current model reference", () => {
		const narratorId = `runtime-model-${crypto.randomUUID()}`;
		recordNarratorRuntimeModel(narratorId, "__agg__:balanced", "openai", "gpt-5.4");

		expect(getNarratorRuntimeModel(narratorId, "__agg__:balanced")).toMatchObject({
			requestedModel: "__agg__:balanced",
			provider: "openai",
			model: "gpt-5.4",
		});
		expect(getNarratorRuntimeModel(narratorId, "anthropic:claude-sonnet-4.6")).toBeNull();
	});

	test("evicts the oldest entries when the bounded cache is full", () => {
		const prefix = `runtime-model-bound-${crypto.randomUUID()}`;
		for (let index = 0; index <= 256; index++) {
			recordNarratorRuntimeModel(
				`${prefix}-${index}`,
				"__agg__:balanced",
				"openai",
				`model-${index}`,
			);
		}

		expect(getNarratorRuntimeModel(`${prefix}-0`, "__agg__:balanced")).toBeNull();
		expect(getNarratorRuntimeModel(`${prefix}-256`, "__agg__:balanced")?.model).toBe("model-256");
		for (let index = 0; index <= 256; index++) {
			clearNarratorRuntimeModel(`${prefix}-${index}`);
		}
	});
});
