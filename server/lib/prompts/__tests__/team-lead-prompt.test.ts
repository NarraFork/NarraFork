/**
 * The team coordinator protocol (docs/PROJECT_TEAMS-PLAN.md §二.2 / §二.14): present for a
 * narrator with the `team` trait, after its own prompt, in both locales, and byte-identical
 * across builds so the system prompt stays prompt-cache stable.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_COORDINATOR_LIMITS } from "@shared/project-teams";
import { TEAM_TRAIT } from "../../narrator-utils";
import { getTeamLeadPrompt } from "../team-lead";

const { runtimeBasePrompt } = await import("../../../services/agent-runtime/orchestrator");
const { resolveRuntimePolicy } = await import("../../../services/agent-runtime/policy");

describe("team lead prompt", () => {
	test("both locales, deterministic, with the default soft limits", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const first = getTeamLeadPrompt(locale);
			expect(getTeamLeadPrompt(locale)).toBe(first);
			for (const value of [
				DEFAULT_COORDINATOR_LIMITS.editLines,
				DEFAULT_COORDINATOR_LIMITS.newFileLines,
				DEFAULT_COORDINATOR_LIMITS.readLines,
				DEFAULT_COORDINATOR_LIMITS.searchLines,
			])
				expect(first).toContain(String(value));
			expect(first).toContain("AskUserQuestion");
			expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		}
		expect(getTeamLeadPrompt("en")).toContain("Team coordinator");
		expect(getTeamLeadPrompt("zh-CN")).toContain("团队协调者");
	});

	test("the practices that apply in phase 1 are stated", () => {
		const en = getTeamLeadPrompt("en");
		for (const phrase of [
			"in the background and do not Await",
			"fresh subagent",
			"back to the subagent that wrote the change",
			"never retried through another agent",
			"recommended option first",
			"say so in your report",
			"Never stop, restart or take over",
		])
			expect(en).toContain(phrase);
		// No hosting / CI / integration instructions before those PRs.
		expect(en).not.toMatch(/pull request|\bPR\b|\bCI\b|integration branch/i);
	});

	test("a coordinator gets it after its own prompt; other narrators do not", () => {
		const policy = resolveRuntimePolicy([]);
		const lead = runtimeBasePrompt({ systemPrompt: "PERSONA", traits: [TEAM_TRAIT] }, "en", policy);
		expect(lead?.startsWith("PERSONA")).toBe(true);
		expect(lead).toContain(getTeamLeadPrompt("en"));
		expect(runtimeBasePrompt({ systemPrompt: "PERSONA", traits: [TEAM_TRAIT] }, "en", policy)).toBe(
			lead,
		);
		expect(
			runtimeBasePrompt({ systemPrompt: "PERSONA", traits: [TEAM_TRAIT] }, "zh-CN", policy),
		).toContain("团队协调者");
		expect(runtimeBasePrompt({ systemPrompt: "PERSONA", traits: [] }, "en", policy)).toBe(
			"PERSONA",
		);
	});
});
