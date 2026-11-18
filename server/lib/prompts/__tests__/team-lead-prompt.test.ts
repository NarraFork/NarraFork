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
	test("both locales, deterministic, no numbers or settings interpolated", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const first = getTeamLeadPrompt(locale);
			expect(getTeamLeadPrompt(locale)).toBe(first);
			expect(first).toContain("AskUserQuestion");
			// The limits are per-team settings (P2 reminders carry the numbers): none here.
			for (const value of Object.values(DEFAULT_COORDINATOR_LIMITS))
				expect(first).not.toContain(String(value));
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
			"never commit there directly",
			"worktree of the work item",
			// M1: several people in one conversation.
			"in the order they were sent",
			"address people by name",
			"never merge two people's instructions",
			"When members' instructions conflict, ask before acting",
			"do not choose between people yourself",
			"Onlookers can read this conversation but cannot speak, approve or answer",
			"Any member may answer, and the team records who did",
		])
			expect(en).toContain(phrase);
		const zh = getTeamLeadPrompt("zh-CN");
		for (const phrase of ["称呼人时用名字", "成员之间的指令有冲突时先问再做", "推荐项放第一个"])
			expect(zh).toContain(phrase);
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
