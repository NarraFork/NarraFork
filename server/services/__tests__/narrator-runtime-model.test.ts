import { describe, expect, test } from "bun:test";
import { eventBus } from "../../lib/event-bus";
import {
	clearNarratorRuntimeModel,
	getNarratorRuntimeModel,
	recordNarratorRuntimeModel,
} from "../narrator-session-state";

describe("narrator runtime model cache", () => {
	test("returns the latest concrete member only for the current model reference", () => {
		const narratorId = `runtime-model-${crypto.randomUUID()}`;
		recordNarratorRuntimeModel(
			narratorId,
			"__agg__:balanced",
			"openai",
			"gpt-5.4",
			"openai:gpt-5.4",
		);

		expect(getNarratorRuntimeModel(narratorId, "__agg__:balanced")).toMatchObject({
			requestedModel: "__agg__:balanced",
			provider: "openai",
			model: "gpt-5.4",
			concreteValue: "openai:gpt-5.4",
		});
		expect(getNarratorRuntimeModel(narratorId, "anthropic:claude-sonnet-4.6")).toBeNull();
		// A stale HTTP read of a different selection must not delete the newer runtime fact.
		expect(getNarratorRuntimeModel(narratorId, "__agg__:balanced")?.concreteValue).toBe(
			"openai:gpt-5.4",
		);
	});

	test("emits data-free source markers for unknown to B to C, not timestamp-only records", () => {
		const narratorId = `runtime-markers-${crypto.randomUUID()}`;
		const other = `other-${crypto.randomUUID()}`;
		const frames: unknown[] = [];
		const listener = (event: { narratorId: string; message: unknown }) => {
			if (event.narratorId === narratorId) frames.push(event.message);
		};
		eventBus.on("narrator:ws_broadcast", listener);
		try {
			recordNarratorRuntimeModel(narratorId, "auto:example", "B", "example", "B:example", 1);
			expect(frames).toEqual([{ type: "runtime_model_changed", narratorId }]);
			recordNarratorRuntimeModel(narratorId, "auto:example", "B", "example", "B:example", 2);
			expect(frames).toHaveLength(1);
			recordNarratorRuntimeModel(other, "auto:example", "C", "example", "C:example", 2);
			expect(frames).toHaveLength(1);
			recordNarratorRuntimeModel(narratorId, "auto:example", "C", "example", "C:example", 2);
			expect(frames).toEqual([
				{ type: "runtime_model_changed", narratorId },
				{ type: "runtime_model_changed", narratorId },
			]);
		} finally {
			eventBus.off("narrator:ws_broadcast", listener);
			clearNarratorRuntimeModel(narratorId);
			clearNarratorRuntimeModel(other);
		}
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
