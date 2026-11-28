/**
 * Capability-model selection for `useResolvedModel`.
 *
 * A follow-parent subagent stores `__parent__`, which no provider-prefix parse
 * can read — before this substitution the status bar could not tell the child
 * was running a Codex model, so the fast-mode control (and context-threshold /
 * quota lookups) silently never appeared for following subagents.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeModelSummary } from "@shared/model-runtime";
import { FOLLOW_PARENT_MODEL } from "../../../lib/constants";
import { runtimeReasoningEffortSupport } from "./use-model-selection";
import { capabilityModelReference, runtimeSummaryToResolvedModel } from "./use-resolved-model";

const runtimeSummary: RuntimeModelSummary = {
	selection: { value: "auto:x", label: "X" },
	state: "observed",
	revision: "one",
	settingsRevision: 1,
	concreteValue: "actual:x",
	resolvedProvider: "actual",
	resolvedBareModel: "x",
	reasoning: { supported: true, levels: ["low", "high"], canDisable: false },
};
describe("runtime projection", () => {
	test("unknown auto does not guess a source and observed B stays B", () => {
		expect(
			runtimeSummaryToResolvedModel({
				...runtimeSummary,
				state: "not-observed",
				concreteValue: null,
				resolvedProvider: null,
			}).resolvedModel,
		).toBe("");
		expect(runtimeSummaryToResolvedModel(runtimeSummary).resolvedModel).toBe("actual:x");
		expect(
			runtimeSummaryToResolvedModel({ ...runtimeSummary, effortLevels: [] }).resolvedModelOption
				?.effortLevels,
		).toEqual([]);
		expect(
			runtimeSummaryToResolvedModel(runtimeSummary).resolvedModelOption?.effortLevels,
		).toBeUndefined();
	});
	test("bare runtime model uses the new concreteValue rather than inventing a prefix", () => {
		expect(
			capabilityModelReference("auto:x", null, { model: "x", concreteValue: "actual:x" }),
		).toBe("actual:x");
	});
	test("summary reasoning keeps empty/missing/null levels distinct and honors local overrides", () => {
		expect(runtimeReasoningEffortSupport(runtimeSummary).reasoningEffortOptions).toEqual([
			"low",
			"high",
		]);
		expect(
			runtimeReasoningEffortSupport({ ...runtimeSummary, effortLevels: [] })
				.supportsReasoningEffort,
		).toBe(false);
		expect(
			runtimeReasoningEffortSupport({ ...runtimeSummary, effortLevels: null })
				.supportsReasoningEffort,
		).toBe(true);
		expect(
			runtimeReasoningEffortSupport({
				...runtimeSummary,
				effortLevels: [],
				provenance: { reasoning: "local-connection" },
			}).reasoningEffortOptions,
		).toEqual(["low", "high"]);
	});
});

describe("capabilityModelReference", () => {
	test("follow-parent resolves through the reported inheritance model", () => {
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, "codex:gpt-5")).toBe("codex:gpt-5");
	});

	test("follow-parent without an inheritance report keeps the sentinel", () => {
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, undefined)).toBe(FOLLOW_PARENT_MODEL);
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, null)).toBe(FOLLOW_PARENT_MODEL);
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, "")).toBe(FOLLOW_PARENT_MODEL);
	});

	test("pinned models ignore inheritance even when one is reported", () => {
		expect(capabilityModelReference("openai:gpt-4o", "codex:gpt-5")).toBe("openai:gpt-4o");
		expect(capabilityModelReference(undefined, "codex:gpt-5")).toBeUndefined();
	});

	test("an auto: session follows the source its last turn actually used", () => {
		const served = { provider: "relay", model: "relay:gpt-5.5" };
		expect(capabilityModelReference("auto:gpt-5.5", undefined, served)).toBe("relay:gpt-5.5");
		// Before the first turn (or when the server has nothing), the auto value stays.
		expect(capabilityModelReference("auto:gpt-5.5", undefined, null)).toBe("auto:gpt-5.5");
		expect(capabilityModelReference("auto:gpt-5.5", undefined, { model: "" })).toBe("auto:gpt-5.5");
		// A named service never takes the runtime value: it is already the source.
		expect(capabilityModelReference("codex:gpt-5.5", undefined, served)).toBe("codex:gpt-5.5");
		// A follow-parent child whose parent uses auto: follows the parent's served source too.
		expect(capabilityModelReference(FOLLOW_PARENT_MODEL, "auto:gpt-5.5", served)).toBe(
			"relay:gpt-5.5",
		);
	});
});
