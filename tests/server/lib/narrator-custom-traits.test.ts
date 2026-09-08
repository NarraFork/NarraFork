import { afterEach, describe, expect, test } from "bun:test";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	formatSubagentModelRestrictionDescription,
	getBlockedSkills,
	isBlockedSkillsEmpty,
	isSkillBlocked,
	normalizeBlockedSkills,
	normalizeSubagentModelRestriction,
	parseBlockedSkillsTrait,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelFromPolicy,
	resolveSubagentModelSelectionFromPolicy,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../../../server/lib/narrator-custom-traits";
import { resolveEffectiveModel, settings } from "../../../server/lib/settings";
import type { SubagentModelUse } from "../../../shared/subagent-model-policy";

const originalPools = {
	explore: [...settings.agent.subagentAllowedModels.explore],
	plan: [...settings.agent.subagentAllowedModels.plan],
	general: [...settings.agent.subagentAllowedModels.general],
	search: [...(settings.agent.subagentAllowedModels.search ?? [])],
	review: [...(settings.agent.subagentAllowedModels.review ?? [])],
};

afterEach(() => {
	settings.agent.subagentAllowedModels = {
		explore: [...originalPools.explore],
		plan: [...originalPools.plan],
		general: [...originalPools.general],
		search: [...originalPools.search],
		review: [...originalPools.review],
	};
});

describe("narrator custom subagent model traits", () => {
	test("falls back to global pools when a custom trait omits a subagent type", () => {
		settings.agent.subagentAllowedModels = {
			explore: ["openai:global-explore"],
			plan: ["openai:global-plan"],
			general: ["openai:global-general"],
		};
		const restriction = normalizeSubagentModelRestriction({
			pools: { explore: [{ model: "openai:custom-explore" }] },
		});
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction);

		const explorePolicy = resolveEffectiveSubagentModelPolicy(traits, "explore");
		const planPolicy = resolveEffectiveSubagentModelPolicy(traits, "plan");

		expect(explorePolicy).toMatchObject({ source: "custom", poolKey: "explore" });
		expect(explorePolicy.models.map((entry) => entry.model)).toEqual(["openai:custom-explore"]);
		expect(planPolicy).toMatchObject({ source: "settings", poolKey: "plan" });
		expect(planPolicy.models.map((entry) => entry.model)).toEqual(["openai:global-plan"]);
	});

	test("review resolves to its own settings pool instead of falling through to general", () => {
		settings.agent.subagentAllowedModels = {
			explore: [],
			plan: [],
			general: ["openai:global-general"],
			search: [],
			review: ["openai:global-review"],
		};
		const policy = resolveEffectiveSubagentModelPolicy([], "review");

		expect(policy).toMatchObject({ source: "settings", poolKey: "review" });
		expect(policy.models.map((entry) => entry.model)).toEqual(["openai:global-review"]);
	});

	test("review honors a custom per-narrator pool over global settings", () => {
		settings.agent.subagentAllowedModels = {
			explore: [],
			plan: [],
			general: [],
			search: [],
			review: ["openai:global-review"],
		};
		const restriction = normalizeSubagentModelRestriction({
			pools: { review: [{ model: "openai:custom-review" }] },
		});
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction);

		const policy = resolveEffectiveSubagentModelPolicy(traits, "review");

		expect(policy).toMatchObject({ source: "custom", poolKey: "review" });
		expect(policy.models.map((entry) => entry.model)).toEqual(["openai:custom-review"]);
	});

	test("empty custom restrictions do not disable global pools", () => {
		settings.agent.subagentAllowedModels = {
			explore: [],
			plan: ["openai:global-plan"],
			general: [],
		};
		const restriction = normalizeSubagentModelRestriction({ pools: {} });
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction);

		const policy = resolveEffectiveSubagentModelPolicy(traits, "plan");

		expect(policy).toMatchObject({ source: "settings", poolKey: "plan" });
		expect(policy.models.map((entry) => entry.model)).toEqual(["openai:global-plan"]);
	});
});

describe("optional fixed subagent reasoning effort", () => {
	function policy(entries: SubagentModelUse[]) {
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
			version: 1,
			pools: { explore: entries },
		});
		return resolveEffectiveSubagentModelPolicy(traits, "explore");
	}

	test("normalizes optional metadata without changing legacy entries or dropping invalid models", () => {
		expect(
			normalizeSubagentModelRestriction({
				pools: {
					explore: [
						"model-a",
						{ model: "model-b", purpose: " legacy " },
						{ model: "model-c", purpose: "new", reasoningEffort: "high" },
						{ model: "model-d", purpose: "keep", reasoningEffort: "invalid" },
						{ model: "model-e", reasoningEffort: "none" },
					],
				},
			}).pools.explore,
		).toEqual([
			{ model: "model-a" },
			{ model: "model-b", purpose: "legacy" },
			{ model: "model-c", purpose: "new", reasoningEffort: "high" },
			{ model: "model-d", purpose: "keep" },
			{ model: "model-e", reasoningEffort: "none" },
		]);
	});

	test("empty or absent effort maps preserve global pool entries exactly", () => {
		settings.agent.subagentAllowedModels.explore = ["provider:a"];
		delete settings.agent.subagentModelReasoningEfforts;
		const before = resolveEffectiveSubagentModelPolicy([], "explore");
		settings.agent.subagentModelReasoningEfforts = {};
		expect(resolveEffectiveSubagentModelPolicy([], "explore")).toEqual(before);
		expect(before.models).toEqual([{ model: "provider:a" }]);
	});

	test("global metadata only applies to its own type and authorized entries", () => {
		settings.agent.subagentAllowedModels = {
			explore: ["provider:a"],
			plan: ["provider:a"],
			general: [],
		};
		settings.agent.subagentModelReasoningEfforts = {
			explore: { "provider:a": "high", "provider:not-allowed": "max" },
			general: { "provider:a": "medium" },
		};
		expect(resolveEffectiveSubagentModelPolicy([], "explore").models).toEqual([
			{ model: "provider:a", reasoningEffort: "high" },
		]);
		expect(resolveEffectiveSubagentModelPolicy([], "plan").models).toEqual([
			{ model: "provider:a" },
		]);
		expect(resolveEffectiveSubagentModelPolicy([], "general")).toMatchObject({
			source: "none",
			models: [],
		});
	});

	test("malformed optional disk values do not remove the model", () => {
		settings.agent.subagentAllowedModels.explore = ["provider:a"];
		Object.assign(settings.agent, {
			subagentModelReasoningEfforts: { explore: { "provider:a": "bad" } },
		});
		expect(resolveEffectiveSubagentModelPolicy([], "explore").models).toEqual([
			{ model: "provider:a" },
		]);
	});

	test("custom pools do not pick up the global map even for the same model", () => {
		settings.agent.subagentAllowedModels.explore = ["provider:a"];
		settings.agent.subagentModelReasoningEfforts = { explore: { "provider:a": "high" } };
		expect(policy([{ model: "provider:a" }]).models).toEqual([{ model: "provider:a" }]);
	});

	test("custom types use their named pool or general with metadata intact", () => {
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
			version: 1,
			pools: {
				auditor: [{ model: "a", reasoningEffort: "high" }],
				general: [{ model: "b", reasoningEffort: "none" }],
			},
		});
		expect(resolveEffectiveSubagentModelPolicy(traits, "auditor").models[0]?.reasoningEffort).toBe(
			"high",
		);
		expect(resolveEffectiveSubagentModelPolicy(traits, "other").models[0]?.reasoningEffort).toBe(
			"none",
		);
	});

	test("selection retains metadata and the legacy model-only wrapper result", () => {
		const input = {
			policy: policy([{ model: "a", reasoningEffort: "none" }]),
			explicitModel: "a",
			candidates: [],
		};
		const selection = resolveSubagentModelSelectionFromPolicy(input);
		expect(selection).toEqual({ model: "a", poolEntry: { model: "a", reasoningEffort: "none" } });
		expect(resolveSubagentModelFromPolicy(input)).toBe(selection?.model);
	});

	test("first-pool fallback keeps its effort and explicit disallowed models remain rejected", () => {
		const p = policy([
			{ model: "a", reasoningEffort: "high" },
			{ model: "b", reasoningEffort: "medium" },
		]);
		expect(
			resolveSubagentModelSelectionFromPolicy({ policy: p, candidates: ["no-match"] }),
		).toEqual({
			model: "a",
			poolEntry: p.models[0],
		});
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: p,
				explicitModel: "no-match",
				candidates: ["a"],
			}),
		).toBeUndefined();
		expect(
			resolveSubagentModelSelectionFromPolicy({ policy: policy([]), candidates: ["a"] }),
		).toBeUndefined();
	});

	test("unrestricted selection does not invent pool metadata or defaults", () => {
		const p = { source: "none" as const, poolKey: "explore", models: [], isExplicitEmpty: false };
		expect(
			resolveSubagentModelSelectionFromPolicy({ policy: p, explicitModel: "a", candidates: ["b"] }),
		).toEqual({ model: "a" });
		expect(resolveSubagentModelSelectionFromPolicy({ policy: p, candidates: [] })).toBeUndefined();
	});

	test("annotated default and summary references preserve their owning entries", () => {
		settings.agent.defaultModel = "deepseek:a";
		settings.agent.summaryModel = "deepseek:b";
		const p = policy([
			{ model: "__default__", reasoningEffort: "high" },
			{ model: "__summary__", reasoningEffort: "low" },
		]);
		for (const [candidate, model, effort] of [
			["default (currently deepseek:a)", "__default__", "high"],
			["summary (currently deepseek:b)", "__summary__", "low"],
			["deepseek:b", "deepseek:b", "low"],
		]) {
			expect(
				resolveSubagentModelSelectionFromPolicy({
					policy: p,
					explicitModel: candidate,
					candidates: [],
				}),
			).toMatchObject({ model, poolEntry: { reasoningEffort: effort } });
		}
	});

	test("pinned aggregate members retain metadata without authorizing other members", () => {
		settings.agent.modelAggregations = [
			{
				id: "pinned-effort",
				name: "pool",
				models: ["deepseek:a", "deepseek:b"],
				routingMode: "balanced",
			},
		];
		const pinned = "__agg__:pinned-effort:deepseek:b";
		const p = policy([{ model: pinned, reasoningEffort: "max" }]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: p,
				explicitModel: "deepseek:b",
				candidates: [],
			}),
		).toEqual({ model: "deepseek:b", poolEntry: p.models[0] });
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: p,
				explicitModel: "deepseek:a",
				candidates: [],
			}),
		).toBeUndefined();
		expect(resolveEffectiveModel("__agg__:pinned-effort")).toBe("deepseek:a");
	});

	test("overlapping semantic references use the original first matching pool entry", () => {
		settings.agent.defaultModel = "deepseek:a";
		settings.agent.summaryModel = "deepseek:a";
		const p = policy([
			{ model: "__summary__", reasoningEffort: "low" },
			{ model: "__default__", reasoningEffort: "high" },
		]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: p,
				explicitModel: "deepseek:a",
				candidates: [],
			}),
		).toEqual({ model: "deepseek:a", poolEntry: p.models[0] });
	});

	test("aggregate metadata matching does not advance balanced routing", () => {
		settings.agent.modelAggregations = [
			{
				id: "fixed-effort-balanced",
				name: "pool",
				models: ["deepseek:a", "deepseek:b"],
				routingMode: "balanced",
			},
		];
		const aggregate = "__agg__:fixed-effort-balanced";
		const p = policy([{ model: aggregate, reasoningEffort: "high" }]);
		for (let i = 0; i < 3; i++) {
			expect(
				resolveSubagentModelSelectionFromPolicy({
					policy: p,
					explicitModel: "deepseek:b",
					candidates: [],
				}),
			).toMatchObject({
				model: "deepseek:b",
				poolEntry: { model: aggregate, reasoningEffort: "high" },
			});
		}
		expect(resolveEffectiveModel(aggregate)).toBe("deepseek:a");
	});

	test("an exact entry owns effort ahead of an overlapping aggregate without changing selection", () => {
		settings.agent.modelAggregations = [
			{
				id: "fixed-effort-overlap",
				name: "pool",
				models: ["deepseek:a", "deepseek:b"],
				routingMode: "priority",
			},
		];
		const p = policy([
			{ model: "__agg__:fixed-effort-overlap", reasoningEffort: "low" },
			{ model: "deepseek:b", reasoningEffort: "high" },
		]);
		const input = { policy: p, explicitModel: "deepseek:b", candidates: [] };
		expect(resolveSubagentModelSelectionFromPolicy(input)).toEqual({
			model: "deepseek:b",
			poolEntry: p.models[1],
		});
		expect(resolveSubagentModelFromPolicy(input)).toBe("deepseek:b");
	});

	test("matching a sentinel keeps legacy concrete selection even with a later exact entry", () => {
		settings.agent.defaultModel = "deepseek:a";
		const p = policy([
			{ model: "deepseek:a", reasoningEffort: "low" },
			{ model: "__default__", reasoningEffort: "high" },
		]);
		expect(
			resolveSubagentModelSelectionFromPolicy({
				policy: p,
				explicitModel: "default",
				candidates: [],
			}),
		).toEqual({ model: "deepseek:a", poolEntry: p.models[1] });
	});

	test("descriptions only annotate configured entries and retain purpose", () => {
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
			version: 1,
			pools: {
				review: [{ model: "a", reasoningEffort: "high", purpose: "audit" }, { model: "b" }],
			},
		});
		const description = formatSubagentModelRestrictionDescription(traits);
		expect(description).toContain("a [fixed reasoning_effort=high] — audit; b");
		expect(description).not.toContain("b [fixed");
	});
});

describe("narrator blocked-skills trait", () => {
	test("normalizes names: trims, dedupes, drops empties, caps length", () => {
		const trait = normalizeBlockedSkills({
			all: false,
			names: ["  pdf  ", "pdf", "", "commit", 42, "commit"],
		});
		expect(trait).toEqual({ version: 1, all: false, names: ["pdf", "commit"] });
	});

	test("coerces missing/invalid input to an empty, non-blocking trait", () => {
		expect(normalizeBlockedSkills(null)).toEqual({ version: 1, all: false, names: [] });
		expect(normalizeBlockedSkills({ all: "yes" })).toEqual({ version: 1, all: false, names: [] });
		expect(isBlockedSkillsEmpty(normalizeBlockedSkills(undefined))).toBe(true);
		expect(isBlockedSkillsEmpty(normalizeBlockedSkills({ all: true, names: [] }))).toBe(false);
		expect(isBlockedSkillsEmpty(normalizeBlockedSkills({ all: false, names: ["x"] }))).toBe(false);
	});

	test("round-trips through encoded trait and resolves enforcement state", () => {
		const trait = normalizeBlockedSkills({ all: false, names: ["pdf", "review-pr"] });
		const traits = upsertEncodedTrait([], BLOCKED_SKILLS_TRAIT_PREFIX, trait);

		const parsed = parseBlockedSkillsTrait(traits);
		expect(parsed).toEqual({ version: 1, all: false, names: ["pdf", "review-pr"] });

		const state = getBlockedSkills(traits);
		expect(state.all).toBe(false);
		expect(isSkillBlocked(state, "pdf")).toBe(true);
		expect(isSkillBlocked(state, "review-pr")).toBe(true);
		expect(isSkillBlocked(state, "commit")).toBe(false);
	});

	test("all=true blocks every skill regardless of names", () => {
		const trait = normalizeBlockedSkills({ all: true, names: ["pdf"] });
		const traits = upsertEncodedTrait([], BLOCKED_SKILLS_TRAIT_PREFIX, trait);
		const state = getBlockedSkills(traits);
		expect(state.all).toBe(true);
		expect(isSkillBlocked(state, "anything-at-all")).toBe(true);
	});

	test("no trait resolves to an empty, non-blocking state", () => {
		const state = getBlockedSkills([]);
		expect(state.all).toBe(false);
		expect(state.names.size).toBe(0);
		expect(isSkillBlocked(state, "pdf")).toBe(false);
	});
});
