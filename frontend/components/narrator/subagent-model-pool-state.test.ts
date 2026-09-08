import { describe, expect, test } from "bun:test";
import type {
	SubagentModelPools,
	SubagentModelReasoningEfforts,
} from "@shared/subagent-model-policy";
import {
	removeDeselectedPoolEfforts,
	selectPoolModels,
	setPoolReasoningEffort,
	updatePoolModel,
} from "./subagent-model-pool-state";

describe("subagent pool edits preserve declarations and metadata", () => {
	const pools: SubagentModelPools = {
		explore: [{ model: "default", purpose: "keep purpose", reasoningEffort: "high" }],
		plan: [],
		search: [{ model: "summary", purpose: "search", reasoningEffort: "none" }],
		review: [{ model: "aggregation:r", reasoningEffort: "max" }],
		custom: [{ model: "provider:m (note)", purpose: "custom" }],
	};

	test("selection preserves selected metadata, hidden types and explicit empty pools", () => {
		const next = selectPoolModels(pools, "explore", ["default", "provider:new"]);
		expect(next.explore).toEqual([...pools.explore, { model: "provider:new" }]);
		expect(next.plan).toEqual([]);
		for (const type of ["search", "review", "custom"]) expect(next[type]).toBe(pools[type]);
		expect(selectPoolModels({}, "general", ["provider:new"])).toEqual({
			general: [{ model: "provider:new" }],
		});
	});

	test("explicitly clearing selection deletes only that layer's type declaration", () => {
		const next = selectPoolModels(pools, "explore", []);
		expect(next).not.toHaveProperty("explore");
		expect(next.plan).toEqual([]);
		expect(next.search).toEqual(pools.search);
		expect(pools.explore).toHaveLength(1);
	});

	test("setting none and clearing effort preserves model, purpose and other tiers", () => {
		const fixed = updatePoolModel(pools, "explore", "default", { reasoningEffort: "none" });
		expect(fixed.explore[0]).toEqual({ ...pools.explore[0], reasoningEffort: "none" });
		const cleared = updatePoolModel(fixed, "explore", "default", { reasoningEffort: undefined });
		expect(cleared.explore[0]).toEqual({ model: "default", purpose: "keep purpose" });
		expect(JSON.parse(JSON.stringify(cleared))).toEqual(cleared);
		expect(cleared.search).toEqual(pools.search);
	});

	test("purpose edits do not erase an effort and do not trim unrelated stored purposes", () => {
		const next = updatePoolModel(pools, "explore", "default", { purpose: "new purpose" });
		expect(next.explore[0].reasoningEffort).toBe("high");
		expect(updatePoolModel(next, "explore", "default", { purpose: "" }).explore[0]).toEqual({
			model: "default",
			reasoningEffort: "high",
		});
	});
});

describe("global sparse effort map", () => {
	const efforts: SubagentModelReasoningEfforts = {
		explore: { "p:same": "high", "p:hidden": "max" },
		review: { "p:same": "low" },
	};
	test("removal only touches explicitly deselected references of that type", () => {
		const next = removeDeselectedPoolEfforts(efforts, "explore", ["p:same"], []);
		expect(next).toEqual({ explore: { "p:hidden": "max" }, review: { "p:same": "low" } });
		expect(efforts.explore?.["p:same"]).toBe("high");
	});
	test("no removal or catalog filtering never manufactures a map edit", () => {
		expect(removeDeselectedPoolEfforts(efforts, "explore", [], [])).toBe(efforts);
		expect(removeDeselectedPoolEfforts(efforts, "explore", ["p:same"], ["p:same"])).toBe(efforts);
		const empty = {};
		expect(removeDeselectedPoolEfforts(empty, "explore", ["p:same"], [])).toBe(empty);
	});
	test("clear last fixed value produces an empty map, while none is explicit", () => {
		const next = setPoolReasoningEffort({}, "general", "default", "none");
		expect(next).toEqual({ general: { default: "none" } });
		expect(setPoolReasoningEffort(next, "general", "default", undefined)).toEqual({});
	});
});
