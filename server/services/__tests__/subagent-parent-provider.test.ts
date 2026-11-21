import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type EffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
} from "../../lib/narrator-custom-traits";
import { resolveAggregation, settings } from "../../lib/settings";
import type { ModelAggregation } from "../../lib/settings/types";
import {
	type ActiveNarrator,
	activeNarrators,
	clearNarratorRuntimeModel,
	recordNarratorRuntimeModel,
} from "../narrator-session-state";
import { resolveParentNarratorProvider } from "../subagent-model";

const pool: EffectiveSubagentModelPolicy = {
	source: "settings",
	poolKey: "general",
	models: [{ model: "provB:m1" }, { model: "provA:m2", reasoningEffort: "high" }],
	isExplicitEmpty: false,
};

describe("resolveParentNarratorProvider", () => {
	let originalAggregations: ModelAggregation[] | undefined;
	let originalDisabledProviders: string[] | undefined;
	let originalDefaultModel: string;
	const ids: string[] = [];
	const newId = () => {
		const id = `parent-provider-${crypto.randomUUID()}`;
		ids.push(id);
		return id;
	};

	beforeEach(() => {
		originalAggregations = settings.agent.modelAggregations;
		originalDisabledProviders = settings.agent.disabledProviders;
		originalDefaultModel = settings.agent.defaultModel;
		settings.agent.disabledProviders = [];
	});

	afterEach(() => {
		for (const id of ids.splice(0)) {
			activeNarrators.delete(id);
			clearNarratorRuntimeModel(id);
		}
		settings.agent.modelAggregations = originalAggregations;
		settings.agent.disabledProviders = originalDisabledProviders;
		settings.agent.defaultModel = originalDefaultModel;
	});

	test("an active parent session's actual provider wins", () => {
		const id = newId();
		activeNarrators.set(id, { alive: true, provider: "provA" } as unknown as ActiveNarrator);
		recordNarratorRuntimeModel(id, "provB:m1", "provB", "m1");
		expect(resolveParentNarratorProvider(id, "provB:m1")).toBe("provA");
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: pool,
				candidates: [],
				preferredProvider: resolveParentNarratorProvider(id, "provB:m1"),
			}),
		).toEqual({ model: "provA:m2", poolEntry: pool.models[1] });
	});

	test("a runtime record counts only while it matches the stored model", () => {
		const aggId = `parent-balanced-${crypto.randomUUID()}`;
		settings.agent.modelAggregations = [
			{ id: aggId, name: "B", models: ["provB:x", "provA:y"], routingMode: "balanced" },
		];
		const id = newId();
		recordNarratorRuntimeModel(id, `__agg__:${aggId}`, "provA", "y");
		expect(resolveParentNarratorProvider(id, `__agg__:${aggId}`)).toBe("provA");
		// A stale record (stored model changed) is ignored and derivation takes over.
		expect(resolveParentNarratorProvider(id, "provC:z")).toBe("provC");
	});

	test("derives from the stored model when nothing is recorded", () => {
		expect(resolveParentNarratorProvider(newId(), "provA:m")).toBe("provA");
		settings.agent.defaultModel = "provD:default";
		expect(resolveParentNarratorProvider(newId(), null)).toBe("provD");
		expect(resolveParentNarratorProvider(newId(), "__default__")).toBe("provD");
	});

	test("priority aggregation uses its first enabled member", () => {
		const aggId = `parent-priority-${crypto.randomUUID()}`;
		settings.agent.modelAggregations = [
			{ id: aggId, name: "P", models: ["provB:x", "provA:y"], routingMode: "priority" },
		];
		settings.agent.disabledProviders = ["provB"];
		expect(resolveParentNarratorProvider(newId(), `__agg__:${aggId}`)).toBe("provA");
		expect(resolveParentNarratorProvider(newId(), `__agg__:${aggId}:provB:x`)).toBe("provB");
	});

	test("balanced aggregation without a record stays undetermined and keeps the first entry", () => {
		const aggId = `parent-balanced-${crypto.randomUUID()}`;
		settings.agent.modelAggregations = [
			{ id: aggId, name: "B", models: ["provA:y", "provB:x"], routingMode: "balanced" },
		];
		const provider = resolveParentNarratorProvider(newId(), `__agg__:${aggId}`);
		expect(provider).toBeUndefined();
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: pool,
				candidates: [],
				preferredProvider: provider,
			})?.model,
		).toBe("provB:m1");
		// Resolution never advanced the round-robin counter.
		expect(resolveAggregation(aggId)).toBe("provA:y");
	});

	test("the follow-parent sentinel yields no provider", () => {
		expect(resolveParentNarratorProvider(newId(), "__parent__")).toBeUndefined();
	});
});
