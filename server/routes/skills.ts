import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { requireProjectAccess } from "../lib/project-access";
import { createProjectSkillSchema, updateProjectSkillSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";
import { skillService } from "../services/skill-service";

export const skillRoutes = new Hono();

skillRoutes.use("/*", requireAuth);

/**
 * Resolve a project's git path, authorizing the caller first.
 *
 * The single choke point for every project-scoped skill endpoint, which is why the
 * access check lives here rather than in six handlers. It matters more than most:
 * the return value is a filesystem path that the skill service reads and writes
 * under, so a missing check would leak (and let someone modify) files rather than
 * just rows.
 *
 * `need` is "read" for listing/reading skills and "write" for creating, editing or
 * deleting them.
 */
async function getProjectGitPath(
	c: Context,
	projectId: string | undefined,
	need: "read" | "write",
): Promise<string> {
	if (!projectId) throw new ValidationError("projectId is required");

	const project = await requireProjectAccess(c, projectId, need);
	if (!project.gitPath) throw new ValidationError("Project has no git path");
	return project.gitPath;
}

// === Global skill CRUD (must be before /:name to avoid route conflict) ===

/**
 * GET /api/skills/global
 * List all global skills (scanned from ~/).
 */
skillRoutes.get("/global", async (c) => {
	const skills = await skillService.loadGlobalSkills();
	return c.json(
		skills.map((s) => ({
			name: s.name,
			description: s.description,
			location: s.location,
			files: s.files,
			disabled: s.disabled ?? false,
		})),
	);
});

/**
 * GET /api/skills/global/:name
 * Get a single global skill's full content.
 */
skillRoutes.get("/global/:name", async (c) => {
	const name = c.req.param("name");
	const globals = await skillService.loadGlobalSkills();
	const skill = globals.find((s) => s.name === name);
	if (!skill) throw new NotFoundError("Global skill", name);
	return c.json(skill);
});

/**
 * POST /api/skills/global
 * Create a new global skill (writes to ~/.narrafork/skills/<name>/SKILL.md).
 */
skillRoutes.post("/global", async (c) => {
	const body = await c.req.json<{ name?: string; description?: string; content?: string }>();
	const name = body.name?.trim();
	const description = body.description?.trim();
	const content = body.content?.trim() ?? "";
	if (!name) throw new ValidationError("name is required");
	if (!description) throw new ValidationError("description is required");

	const skill = await skillService.createGlobalSkill(name, description, content);
	return c.json(skill, 201);
});

/**
 * PUT /api/skills/global/:name
 * Update an existing global skill.
 */
skillRoutes.put("/global/:name", async (c) => {
	const currentName = c.req.param("name");
	const body = await c.req.json<{ name?: string; description?: string; content?: string }>();
	const name = body.name?.trim() || currentName;
	const description = body.description?.trim();
	const content = body.content?.trim() ?? "";
	if (!description) throw new ValidationError("description is required");

	const skill = await skillService.updateGlobalSkill(currentName, name, description, content);
	return c.json(skill);
});

/**
 * DELETE /api/skills/global/:name
 * Delete a global skill directory.
 */
skillRoutes.delete("/global/:name", async (c) => {
	const name = c.req.param("name");
	await skillService.deleteGlobalSkill(name);
	return c.json({ ok: true });
});

/**
 * POST /api/skills/global/:name/toggle
 * Enable or disable a global skill by renaming SKILL.md <-> SKILL.md.disabled.
 */
skillRoutes.post("/global/:name/toggle", async (c) => {
	const name = c.req.param("name");
	const body = await c.req.json<{ enabled?: boolean }>();
	if (typeof body.enabled !== "boolean") throw new ValidationError("enabled (boolean) is required");

	const skill = await skillService.toggleGlobalSkill(name, body.enabled);
	return c.json({
		name: skill.name,
		description: skill.description,
		location: skill.location,
		files: skill.files,
		disabled: skill.disabled ?? false,
	});
});

// === Project-level skill routes ===

/**
 * GET /api/skills?projectId=xxx
 * List all skills available for a project (scanned from project directory).
 */
skillRoutes.get("/", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "read");
	const skills = await skillService.loadProjectSkills(projectGitPath);
	return c.json(
		skills.map((s) => ({
			name: s.name,
			description: s.description,
			location: s.location,
			files: s.files,
			disabled: s.disabled ?? false,
		})),
	);
});

/**
 * POST /api/skills?projectId=xxx
 * Create a project-level skill in <project>/.narrafork/skills/<name>/SKILL.md.
 */
skillRoutes.post("/", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "write");
	const parsed = createProjectSkillSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const name = parsed.data.name.trim();
	const description = parsed.data.description.trim();
	const content = parsed.data.content.trim();
	if (!name) throw new ValidationError("name is required");
	if (!description) throw new ValidationError("description is required");

	const skill = await skillService.createProjectSkill(projectGitPath, name, description, content);
	return c.json(skill, 201);
});

/**
 * GET /api/skills/:name?projectId=xxx
 * Get a single skill's full content by name.
 */
skillRoutes.get("/:name", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "read");
	const name = c.req.param("name");

	const skill = await skillService.loadSkillByName(projectGitPath, name);
	if (!skill) throw new NotFoundError("Skill", name);

	return c.json(skill);
});

/**
 * PUT /api/skills/:name?projectId=xxx
 * Update a project-level skill.
 */
skillRoutes.put("/:name", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "write");
	const currentName = c.req.param("name");
	const parsed = updateProjectSkillSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const name = parsed.data.name?.trim() || currentName;
	const description = parsed.data.description.trim();
	const content = parsed.data.content.trim();
	if (!description) throw new ValidationError("description is required");

	const skill = await skillService.updateProjectSkill(
		projectGitPath,
		currentName,
		name,
		description,
		content,
	);
	return c.json(skill);
});

/**
 * DELETE /api/skills/:name?projectId=xxx
 * Delete a project-level skill directory.
 */
skillRoutes.delete("/:name", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "write");
	const name = c.req.param("name");
	await skillService.deleteProjectSkill(projectGitPath, name);
	return c.json({ ok: true });
});

/**
 * GET /api/skills/:name/files/:filePath{.+}?projectId=xxx
 * Read a companion file from a skill directory.
 */
skillRoutes.get("/:name/files/:filePath{.+}", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "read");
	const name = c.req.param("name");
	const filePath = c.req.param("filePath");

	const skill = await skillService.loadSkillByName(projectGitPath, name);
	if (!skill) throw new NotFoundError("Skill", name);

	try {
		const content = await skillService.readSkillFile(skill.location, filePath);
		return c.json({ content });
	} catch {
		throw new NotFoundError("Skill file", filePath);
	}
});
