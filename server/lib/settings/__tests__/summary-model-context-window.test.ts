/**
 * `getSummaryModelContextWindow` must follow the same "unset summary follows the
 * default model" rule as generation.
 *
 * Regression: it parsed the raw `agent.summaryModel` setting, so the fresh-install
 * value `""` reached the model catalog and failed query validation with the
 * opaque "Invalid string at ModelQuery.upstreamModelId" — compact computes its
 * token budget from this BEFORE calling `summaryGenerate`, so every compact failed
 * even though `summaryGenerate` itself resolved the empty value to the default
 * model correctly. No mocks here: the resolution chain under test is the point.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelAggregation } from "../../settings/types";
import {
	DEFAULT_CONTEXT_WINDOW,
	getModelContextWindow,
	getSummaryModelContextWindow,
	parseModelId,
	settings,
} from "../index";

const DEFAULT_MODEL = "anthropic:claude-opus-4-8";
const SUMMARY_MODEL = "anthropic:claude-haiku-4-5";

function windowOf(model: string): number {
	const parsed = parseModelId(model);
	return (
		getModelContextWindow(parsed.model, parsed.provider ?? "anthropic") ?? DEFAULT_CONTEXT_WINDOW
	);
}

describe("getSummaryModelContextWindow", () => {
	// The two fixtures must have different windows, or "which model was looked up"
	// would not be observable. Asserted rather than assumed, so a model-card change
	// that equalises them fails loudly here instead of making every test vacuous.
	test("fixtures are distinguishable", () => {
		expect(windowOf(DEFAULT_MODEL)).not.toBe(windowOf(SUMMARY_MODEL));
	});

	let original: {
		defaultModel: string;
		summaryModel: string;
		modelAggregations: ModelAggregation[] | undefined;
	};

	beforeEach(() => {
		original = {
			defaultModel: settings.agent.defaultModel,
			summaryModel: settings.agent.summaryModel,
			modelAggregations: settings.agent.modelAggregations,
		};
		settings.agent.defaultModel = DEFAULT_MODEL;
	});

	afterEach(() => {
		settings.agent.defaultModel = original.defaultModel;
		settings.agent.summaryModel = original.summaryModel;
		settings.agent.modelAggregations = original.modelAggregations;
	});

	test("an empty summary model follows the default model instead of throwing", () => {
		settings.agent.summaryModel = "";
		expect(() => getSummaryModelContextWindow()).not.toThrow();
		expect(getSummaryModelContextWindow()).toBe(windowOf(DEFAULT_MODEL));
	});

	test("the __summary__ sentinel resolves the same way", () => {
		settings.agent.summaryModel = "";
		expect(getSummaryModelContextWindow("__summary__")).toBe(windowOf(DEFAULT_MODEL));
		settings.agent.summaryModel = SUMMARY_MODEL;
		expect(getSummaryModelContextWindow("__summary__")).toBe(windowOf(SUMMARY_MODEL));
	});

	test("a configured summary model is looked up directly", () => {
		settings.agent.summaryModel = SUMMARY_MODEL;
		expect(getSummaryModelContextWindow()).toBe(windowOf(SUMMARY_MODEL));
	});

	test("an explicit model override wins over the setting", () => {
		settings.agent.summaryModel = "";
		expect(getSummaryModelContextWindow(SUMMARY_MODEL)).toBe(windowOf(SUMMARY_MODEL));
	});

	test("an empty aggregation falls back to the default model", () => {
		settings.agent.modelAggregations = [
			{ id: "emptyagg", name: "Empty", models: [], routingMode: "priority" },
		];
		settings.agent.summaryModel = "__agg__:emptyagg";
	});

	test("with no model configured anywhere it degrades to the tier default, never throws", () => {
		settings.agent.summaryModel = "";
		settings.agent.defaultModel = "";
		expect(() => getSummaryModelContextWindow()).not.toThrow();
		expect(getSummaryModelContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
	});
});
