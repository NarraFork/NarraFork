import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { skillService } from "../services/skill-service";

export const skillRoutes = new Hono();

skillRoutes.use("/*", requireAuth);

/**
 * GET /api/skills?projectId=xxx
 * List all skills available for a project (scanned from project directory).
 */
skillRoutes.get("/", async (c) => {
	const projectId = c.req.query("projectId");
	if (!projectId) throw new ValidationError("projectId is required");

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project) throw new NotFoundError("Project", projectId);
	if (!project.gitPath) throw new ValidationError("Project has no git path");

	const skills = await skillService.loadProjectSkills(project.gitPath);
	return c.json(
		skills.map((s) => ({
			name: s.name,
			description: s.description,
			location: s.location,
			files: s.files,
		})),
	);
});

/**
 * GET /api/skills/:name?projectId=xxx
 * Get a single skill's full content by name.
 */
skillRoutes.get("/:name", async (c) => {
	const projectId = c.req.query("projectId");
	const name = c.req.param("name");
	if (!projectId) throw new ValidationError("projectId is required");

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project) throw new NotFoundError("Project", projectId);
	if (!project.gitPath) throw new ValidationError("Project has no git path");

	const skill = await skillService.loadSkillByName(project.gitPath, name);
	if (!skill) throw new NotFoundError("Skill", name);

	return c.json(skill);
});

/**
 * GET /api/skills/:name/files/:filePath{.+}?projectId=xxx
 * Read a companion file from a skill directory.
 */
skillRoutes.get("/:name/files/:filePath{.+}", async (c) => {
	const projectId = c.req.query("projectId");
	const name = c.req.param("name");
	const filePath = c.req.param("filePath");
	if (!projectId) throw new ValidationError("projectId is required");

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project) throw new NotFoundError("Project", projectId);
	if (!project.gitPath) throw new ValidationError("Project has no git path");

	const skill = await skillService.loadSkillByName(project.gitPath, name);
	if (!skill) throw new NotFoundError("Skill", name);

	try {
		const content = await skillService.readSkillFile(skill.location, filePath);
		return c.json({ content });
	} catch {
		throw new NotFoundError("Skill file", filePath);
	}
});
