import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type EffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
} from "../narrator-custom-traits";
import { resolveAggregation, settings } from "../settings";
import { listConcreteModelsForReference } from "../settings/provider";
import type { ModelAggregation } from "../settings/types";

function pool(models: EffectiveSubagentModelPolicy["models"]): EffectiveSubagentModelPolicy {
	return { source: "settings", poolKey: "general", models, isExplicitEmpty: false };
}

describe("subagent pool default prefers the parent's provider", () => {
	let originalAggregations: ModelAggregation[] | undefined;
	let originalDisabledProviders: string[] | undefined;
	let originalDefaultModel: string;

	beforeEach(() => {
		originalAggregations = settings.agent.modelAggregations;
		originalDisabledProviders = settings.agent.disabledProviders;
		originalDefaultModel = settings.agent.defaultModel;
		settings.agent.disabledProviders = [];
	});

	afterEach(() => {
		settings.agent.modelAggregations = originalAggregations;
		settings.agent.disabledProviders = originalDisabledProviders;
		settings.agent.defaultModel = originalDefaultModel;
	});

	test("selects the first entry on the preferred provider", () => {
		const policy = pool([{ model: "provB:m1" }, { model: "provA:m2" }, { model: "provA:m3" }]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy,
				candidates: [],
				preferredProvider: "provA",
			}),
		).toEqual({ model: "provA:m2", poolEntry: { model: "provA:m2" } });
	});

	test("falls back to the first entry when no entry matches or no provider is given", () => {
		const policy = pool([{ model: "provB:m1" }, { model: "provC:m2" }]);
		const expected = { model: "provB:m1", poolEntry: { model: "provB:m1" } };
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy,
				candidates: [],
				preferredProvider: "provA",
			}),
		).toEqual(expected);
		expect(resolveSubagentModelSelectionFromPolicy({ policy, candidates: [] })).toEqual(expected);
	});

	test("resolves an aggregation entry to its same-provider member and keeps entry metadata", () => {
		const aggId = `pref-agg-${crypto.randomUUID()}`;
		settings.agent.modelAggregations = [
			{ id: aggId, name: "Mixed", models: ["provB:x", "provA:y"], routingMode: "balanced" },
		];
		const aggEntry = { model: `__agg__:${aggId}`, reasoningEffort: "high" as const };
		const policy = pool([{ model: "provB:m1" }, aggEntry]);

		expect(listConcreteModelsForReference(`__agg__:${aggId}`)).toEqual(["provB:x", "provA:y"]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy,
				candidates: [],
				preferredProvider: "provA",
			}),
		).toEqual({ model: "provA:y", poolEntry: aggEntry });
		// Matching never advanced balanced routing: the first route is still member 0.
		expect(resolveAggregation(aggId)).toBe("provB:x");
	});

	test("expands the follow-default sentinel through the configured default", () => {
		settings.agent.defaultModel = "provA:default-model";
		const entry = { model: "__default__" };
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: pool([{ model: "provB:m1" }, entry]),
				candidates: [],
				preferredProvider: "provA",
			}),
		).toEqual({ model: "provA:default-model", poolEntry: entry });
	});

	test("a legacy aggregation never pins a disabled preferred provider", () => {
		const aggId = `disabled-pref-${crypto.randomUUID()}`;
		settings.agent.modelAggregations = [
			{ id: aggId, name: "Mixed", models: ["provA:y", "provB:x"], routingMode: "balanced" },
		];
		settings.agent.disabledProviders = ["provA"];
		const entry = { model: `__agg__:${aggId}`, reasoningEffort: "high" as const };
		expect(listConcreteModelsForReference(entry.model)).toEqual(["provB:x"]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: pool([entry]),
				candidates: ["provA:other"],
				preferredProvider: "provA",
			}),
		).toEqual({ model: entry.model, poolEntry: entry });
		expect(resolveAggregation(aggId)).toBe("provB:x");
		settings.agent.disabledProviders = ["provA", "provB"];
		expect(listConcreteModelsForReference(entry.model)).toEqual([]);
	});

	test("explicit models and candidate hits ignore the provider preference", () => {
		const policy = pool([{ model: "provB:m1" }, { model: "provA:m2" }]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy,
				explicitModel: "provB:m1",
				candidates: [],
				preferredProvider: "provA",
			})?.model,
		).toBe("provB:m1");
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy,
				explicitModel: "provZ:outside",
				candidates: [],
				preferredProvider: "provA",
			}),
		).toBeUndefined();
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy,
				candidates: ["provB:m1"],
				preferredProvider: "provA",
			})?.model,
		).toBe("provB:m1");
	});

	test("an explicitly empty pool still selects nothing", () => {
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: { source: "custom", poolKey: "general", models: [], isExplicitEmpty: true },
				candidates: [],
				preferredProvider: "provA",
			}),
		).toBeUndefined();
	});
});
