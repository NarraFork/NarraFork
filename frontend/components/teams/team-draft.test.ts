/**
 * A new team's draft is checked by the team route's own rules (`shared/project-team-draft.ts`)
 * before anything is sent, so "start as a team" never makes a project for a draft the team route
 * would then refuse.
 *
 * Run: bun test --isolate frontend/components/teams/team-draft.test.ts
 */
import { describe, expect, test } from "bun:test";
import { TEAM_BRIEF_MAX_BYTES, TEAM_NAME_MAX_LENGTH } from "@shared/project-teams";
import { createProjectTeamSchema } from "../../../server/lib/validators/project-teams";
import { checkTeamDraft } from "./team-draft";

const draft = (overrides: Partial<{ name: string; baseBranch: string; brief: string }> = {}) => ({
	name: "Release crew",
	baseBranch: "",
	brief: "",
	...overrides,
});

describe("a draft the route takes", () => {
	test("trimmed name, optional branch and brief", () => {
		expect(checkTeamDraft(draft({ name: "  Crew  " }))).toEqual({
			ok: true,
			payload: { name: "Crew" },
		});
		expect(
			checkTeamDraft(draft({ baseBranch: " release/2.0 ", brief: "Keep main green." })),
		).toEqual({
			ok: true,
			payload: { name: "Release crew", baseBranch: "release/2.0", brief: "Keep main green." },
		});
	});
});

describe("a draft the route would refuse is stopped here", () => {
	test.each([
		"release target",
		"../main",
		"-main",
		"/main",
		"main/",
		"main.",
		"main.lock",
		"a//b",
		"feature~1",
		"x".repeat(201),
	])("base branch %p", (baseBranch) => {
		const result = checkTeamDraft(draft({ baseBranch }));
		expect(result).toEqual({ ok: false, errors: { baseBranch: "invalid" } });
		// The same verdict as the route's schema: no duplicated rule can drift.
		expect(
			createProjectTeamSchema.safeParse({ name: "Release crew", baseBranch: baseBranch.trim() })
				.success,
		).toBe(false);
	});

	test("an empty name", () => {
		expect(checkTeamDraft(draft({ name: "   " }))).toEqual({
			ok: false,
			errors: { name: "required" },
		});
	});

	test("a name past the limit", () => {
		expect(checkTeamDraft(draft({ name: "x".repeat(TEAM_NAME_MAX_LENGTH + 1) }))).toEqual({
			ok: false,
			errors: { name: "invalid" },
		});
	});

	test("a brief past 4 KB of UTF-8", () => {
		const brief = "规".repeat(Math.ceil(TEAM_BRIEF_MAX_BYTES / 3) + 1);
		expect(checkTeamDraft(draft({ brief }))).toEqual({ ok: false, errors: { brief: "tooLong" } });
	});

	test("every field at once", () => {
		expect(checkTeamDraft({ name: "", baseBranch: "a b", brief: "" })).toEqual({
			ok: false,
			errors: { name: "required", baseBranch: "invalid" },
		});
	});
});
