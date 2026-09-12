import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULTS,
	purgeStaleAgentModelRefs,
	resolveAggregation,
	resolveEffectiveModel,
	settings,
} from "../index";
import type { ModelAggregation } from "../types";

// resolveAggregation maps an aggregation id to a concrete "provider:model" value.
// These tests pin the routing contract:
//   - priority mode always honors the configured member order (ignores the
//     session sticky provider) so reordering takes effect on the next request;
//   - balanced mode round-robins but keeps a session pinned via sticky provider.

const AGG_ID = "testaggr";

function setAggregation(agg: Omit<ModelAggregation, "id">) {
	if (!settings.agent) throw new Error("settings.agent missing");
	settings.agent.modelAggregations = [{ id: AGG_ID, ...agg }];
}

describe("resolveAggregation", () => {
	let originalAggregations: ModelAggregation[] | undefined;
	let originalDisabledProviders: string[] | undefined;
	let originalDefaultModel: string;
	let originalSummaryModel: string;

	beforeEach(() => {
		originalAggregations = settings.agent?.modelAggregations;
		originalDisabledProviders = settings.agent?.disabledProviders;
		originalDefaultModel = settings.agent.defaultModel;
		originalSummaryModel = settings.agent.summaryModel;
		if (settings.agent) settings.agent.disabledProviders = [];
	});

	afterEach(() => {
		if (settings.agent) {
			settings.agent.modelAggregations = originalAggregations;
			settings.agent.disabledProviders = originalDisabledProviders;
			settings.agent.defaultModel = originalDefaultModel;
			settings.agent.summaryModel = originalSummaryModel;
		}
	});

	test("priority mode returns the first member regardless of sticky provider", () => {
		setAggregation({
			name: "Test",
			models: ["provA:model", "provB:model"],
			routingMode: "priority",
		});

		// A session that last used provB must NOT stay pinned to it — the configured
		// order wins so a reorder (or a re-enabled higher-priority member) takes effect.
		expect(resolveAggregation(AGG_ID, "provB")).toBe("provA:model");
		expect(resolveAggregation(AGG_ID)).toBe("provA:model");
	});

	test("priority mode reflects a reordered member list on the next call", () => {
		setAggregation({
			name: "Test",
			models: ["provA:model", "provB:model"],
			routingMode: "priority",
		});
		expect(resolveAggregation(AGG_ID, "provA")).toBe("provA:model");

		// Reorder so provB is now the top priority.
		setAggregation({
			name: "Test",
			models: ["provB:model", "provA:model"],
			routingMode: "priority",
		});
		// Even with a sticky provA session, the new order is honored immediately.
		expect(resolveAggregation(AGG_ID, "provA")).toBe("provB:model");
	});

	test("priority mode skips disabled providers", () => {
		setAggregation({
			name: "Test",
			models: ["provA:model", "provB:model"],
			routingMode: "priority",
		});
		if (settings.agent) settings.agent.disabledProviders = ["provA"];

		expect(resolveAggregation(AGG_ID, "provA")).toBe("provB:model");
	});

	test("balanced mode keeps a session pinned via sticky provider", () => {
		setAggregation({
			name: "Test",
			models: ["provA:model", "provB:model"],
			routingMode: "balanced",
		});

		// A session that landed on provB stays there for cache/context warmth.
		expect(resolveAggregation(AGG_ID, "provB")).toBe("provB:model");
		expect(resolveAggregation(AGG_ID, "provB")).toBe("provB:model");
	});

	test("translation model defaults to dynamically following the summary model", () => {
		expect(DEFAULTS.agent.translationModel).toBe("__summary__");
		settings.agent.defaultModel = "provDefault:model";
		settings.agent.summaryModel = "provSummary:model";

		expect(resolveEffectiveModel(DEFAULTS.agent.translationModel)).toBe("provSummary:model");
		settings.agent.summaryModel = "provNext:model";
		expect(resolveEffectiveModel(DEFAULTS.agent.translationModel)).toBe("provNext:model");
		expect(resolveEffectiveModel("provTranslation:model")).toBe("provTranslation:model");
	});

	test("stale translation model falls back to following the summary model", () => {
		const draft = structuredClone(DEFAULTS);
		draft.agent.translationModel = "removed:model";

		expect(purgeStaleAgentModelRefs(draft, (prefix) => prefix === "removed")).toBe(true);
		expect(draft.agent.translationModel).toBe("__summary__");
	});

	test("prompt optimize model defaults to dynamically following the summary model", () => {
		expect(DEFAULTS.agent.promptOptimizeModel).toBe("__summary__");
		settings.agent.defaultModel = "provDefault:model";
		settings.agent.summaryModel = "provSummary:model";

		expect(resolveEffectiveModel(DEFAULTS.agent.promptOptimizeModel)).toBe("provSummary:model");
		settings.agent.summaryModel = "provNext:model";
		expect(resolveEffectiveModel(DEFAULTS.agent.promptOptimizeModel)).toBe("provNext:model");
		expect(resolveEffectiveModel("provOptimize:model")).toBe("provOptimize:model");
	});

	test("stale prompt optimize model falls back to following the summary model", () => {
		const draft = structuredClone(DEFAULTS);
		draft.agent.promptOptimizeModel = "removed:model";

		expect(purgeStaleAgentModelRefs(draft, (prefix) => prefix === "removed")).toBe(true);
		expect(draft.agent.promptOptimizeModel).toBe("__summary__");
	});

	test("purging a stale summary model logs the previous value and prefix", async () => {
		const { logger } = await import("../../logger");
		const warnCalls: Array<Record<string, unknown> | undefined> = [];
		const originalWarn = logger.warn;
		logger.warn = (_msg: string, data?: Record<string, unknown>) => {
			warnCalls.push(data);
		};
		try {
			const draft = structuredClone(DEFAULTS);
			draft.agent.summaryModel = "removed:model";

			expect(purgeStaleAgentModelRefs(draft, (prefix) => prefix === "removed")).toBe(true);
			expect(draft.agent.summaryModel).toBe("");
			expect(warnCalls).toHaveLength(1);
			expect(warnCalls[0]).toMatchObject({
				previousValue: "removed:model",
				stalePrefix: "removed",
			});
		} finally {
			logger.warn = originalWarn;
		}
	});

	test("returns null when every member's provider is disabled", () => {
		setAggregation({
			name: "Test",
			models: ["provA:model", "provB:model"],
			routingMode: "priority",
		});
		if (settings.agent) settings.agent.disabledProviders = ["provA", "provB"];

		expect(resolveAggregation(AGG_ID)).toBeNull();
	});
});
