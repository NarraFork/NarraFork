/**
 * Built-in `skill-creator` routine.
 *
 * This is the first `type: "skill"` entry in `BUILTIN_ROUTINES`, so it also
 * pins the skill-routine contract: opt-in (not preloaded), materialized as a
 * real SKILL.md under `$NARRAFORK_HOME/skills/_routine-skill-creator/` when
 * enabled, and removed when disabled. Content must teach NarraFork skill
 * locations — a Codex-shaped guide would send the model to `$CODEX_HOME`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projects } from "../../db/schema";
import {
	type BuiltinRoutine,
	getBuiltinRoutine,
	getBuiltinSkillRoutines,
} from "../../lib/builtin-routines";
import { generateId } from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import { settings } from "../../lib/settings";
import {
	disableRoutineForProject,
	disableRoutineGlobal,
	enableRoutineGlobal,
	getGlobalRoutineStatuses,
	resetRoutineForProject,
} from "../routine-service";
import {
	loadAllSkills,
	loadSkillByName,
	loadSkillByNameForContext,
	loadSkillSummariesForContext,
} from "../skill-service";

const ROUTINE_ID = "skill-creator";
const SKILL_DIR_NAME = "_routine-skill-creator";
const USER_ID = "test-skill-creator-user";

function skillMdPath(): string {
	return join(getNarraforkHome(), "skills", SKILL_DIR_NAME, "SKILL.md");
}

function skillCreator(): BuiltinRoutine {
	const routine = getBuiltinRoutine(ROUTINE_ID);
	if (!routine) throw new Error("skill-creator routine missing from registry");
	return routine;
}

/** Undo settings writes from enable/disable so later tests see a clean default. */
function resetRoutineSettings(): void {
	settings.routines = {
		disabledRoutines: settings.routines?.disabledRoutines ?? [],
		enabledRoutines: (settings.routines?.enabledRoutines ?? []).filter((id) => id !== ROUTINE_ID),
		toolModes: settings.routines?.toolModes ?? {},
	};
}

afterEach(async () => {
	resetRoutineSettings();
	await rm(join(getNarraforkHome(), "skills", SKILL_DIR_NAME), {
		recursive: true,
		force: true,
	});
});

describe("skill-creator builtin skill routine", () => {
	test("is registered as an opt-in skill routine", () => {
		const routine = skillCreator();
		expect(routine.type).toBe("skill");
		expect(routine.category).toBe("workflow");
		// Explicit false: methodology must not be force-loaded into every session.
		expect(routine.defaultEnabled).toBe(false);
		expect(routine.skill?.name).toBe("skill-creator");
		expect(routine.skill?.descriptionEn.length).toBeGreaterThan(0);
		expect(routine.skill?.descriptionZh.length).toBeGreaterThan(0);
		expect(routine.skill?.content.length).toBeGreaterThan(200);
	});

	test("appears in the skill-routine filter and default global status", () => {
		expect(getBuiltinSkillRoutines().some((r) => r.id === ROUTINE_ID)).toBe(true);
		const status = getGlobalRoutineStatuses().find((r) => r.id === ROUTINE_ID);
		expect(status?.type).toBe("skill");
		expect(status?.enabled).toBe(false);
		expect(status?.mode).toBeUndefined();
	});

	test("enable materializes SKILL.md and disable removes it", async () => {
		const path = skillMdPath();
		await expect(access(path)).rejects.toThrow();

		await enableRoutineGlobal(ROUTINE_ID, USER_ID);
		const raw = await readFile(path, "utf-8");
		expect(raw.startsWith("---\n")).toBe(true);
		expect(raw).toContain('name: "skill-creator"');
		expect(raw).toContain("description:");
		expect(getGlobalRoutineStatuses().find((r) => r.id === ROUTINE_ID)?.enabled).toBe(true);

		await disableRoutineGlobal(ROUTINE_ID, USER_ID);
		await expect(access(path)).rejects.toThrow();
		expect(getGlobalRoutineStatuses().find((r) => r.id === ROUTINE_ID)?.enabled).toBe(false);
	});

	test("global enabled skill obeys project disable and restores inheritance without stale caches", async () => {
		await enableRoutineGlobal(ROUTINE_ID, USER_ID);
		const gitPath = await mkdtemp(join(getNarraforkHome(), "routine-project-"));
		const projectId = generateId();
		const now = new Date().toISOString();
		await db
			.insert(projects)
			.values({ id: projectId, name: "routine test", gitPath, createdAt: now, updatedAt: now });
		const context = { projectGitPath: gitPath, cwd: gitPath };
		try {
			expect(
				(await loadSkillSummariesForContext(context)).skills.some((s) => s.name === ROUTINE_ID),
			).toBe(true);
			expect(await loadSkillByNameForContext(context, ROUTINE_ID)).not.toBeNull();
			await disableRoutineForProject(ROUTINE_ID, projectId);
			expect(
				(await loadSkillSummariesForContext(context)).skills.some((s) => s.name === ROUTINE_ID),
			).toBe(false);
			expect(await loadSkillByNameForContext(context, ROUTINE_ID)).toBeNull();
			expect(await loadSkillByName(gitPath, ROUTINE_ID)).toBeNull();
			expect((await loadAllSkills(gitPath)).some((s) => s.name === ROUTINE_ID)).toBe(false);
			// Project intent never removes the global artifact for other projects.
			expect((await loadAllSkills(null)).some((s) => s.name === ROUTINE_ID)).toBe(true);
			await resetRoutineForProject(ROUTINE_ID, projectId);
			expect(
				(await loadSkillSummariesForContext(context)).skills.some((s) => s.name === ROUTINE_ID),
			).toBe(true);
			expect(await loadSkillByNameForContext(context, ROUTINE_ID)).not.toBeNull();
			expect(await loadSkillByName(gitPath, ROUTINE_ID)).not.toBeNull();
		} finally {
			await db.delete(projects).where(eq(projects.id, projectId));
			await rm(gitPath, { recursive: true, force: true });
		}
	});

	test("content teaches NarraFork skill paths, not Codex home conventions", () => {
		const content = skillCreator().skill?.content ?? "";
		expect(content).toContain("$NARRAFORK_HOME/skills");
		expect(content).toContain(".narrafork/skills");
		expect(content).toContain("SKILL.md");
		// Must not send the model to Codex-only locations or Codex-only scripts.
		expect(content).not.toContain("$CODEX_HOME");
		expect(content).not.toContain("init_skill.py");
		expect(content).not.toContain("quick_validate.py");
		expect(content).not.toContain("agents/openai.yaml");
	});
});
