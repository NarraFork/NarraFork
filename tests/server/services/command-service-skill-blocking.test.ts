import { describe, expect, test } from "bun:test";
import { resolveCommand } from "../../../server/services/command-service";

// These commands short-circuit inside resolveCommand's /load and /unload branches
// before any DB access, so they can be exercised without a database fixture.
const NARRATOR = "narrator-test";
const USER = "user-test";

describe("resolveCommand skill blocking", () => {
	test("/unload all_skills → blockAllSkills", async () => {
		const result = await resolveCommand("/unload all_skills", NARRATOR, USER);
		expect(result).toMatchObject({ resolved: true, blockAllSkills: true });
	});

	test("/unload skill <name> → blockSkill (preserves original casing)", async () => {
		const result = await resolveCommand("/unload skill PDF-Export", NARRATOR, USER);
		expect(result).toMatchObject({ resolved: true, blockSkill: "PDF-Export" });
	});

	test("/unload skill with no name is not resolved", async () => {
		const result = await resolveCommand("/unload skill", NARRATOR, USER);
		expect(result).toEqual({ resolved: false });
	});

	test("/load all_skills → unblockAllSkills", async () => {
		const result = await resolveCommand("/load all_skills", NARRATOR, USER);
		expect(result).toMatchObject({ resolved: true, unblockAllSkills: true });
	});

	test("/load skill <name> → unblockSkill", async () => {
		const result = await resolveCommand("/load skill commit", NARRATOR, USER);
		expect(result).toMatchObject({ resolved: true, unblockSkill: "commit" });
	});

	test("multi-word skill names are captured after the skill keyword", async () => {
		const result = await resolveCommand("/unload skill my custom skill", NARRATOR, USER);
		expect(result).toMatchObject({ resolved: true, blockSkill: "my custom skill" });
	});

	test("skill keyword matching is case-insensitive", async () => {
		const result = await resolveCommand("/UNLOAD SKILL pdf", NARRATOR, USER);
		expect(result).toMatchObject({ resolved: true, blockSkill: "pdf" });
	});
});
