import { type Context, Hono } from "hono";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { requireProjectAccess } from "../lib/project-access";
import {
	createProjectSkillSchema,
	importSkillSchema,
	updateProjectSkillSchema,
} from "../lib/validators";
import { requireAdmin, requireAuth } from "../middleware/auth";
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

async function readSkillRemoteBody(c: Context): Promise<unknown> {
	// Count actual bytes, including chunked bodies and misleading Content-Length.
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new ValidationError("A JSON request body is required");
	const buffer = new Uint8Array(8_192);
	let bytes = 0;
	let timedOut = false;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	const timer = setTimeout(() => {
		timedOut = true;
		cancel();
	}, 5_000);
	c.req.raw.signal.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			c.req.raw.signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (timedOut) throw new AppError("Skill import request timed out", 408);
			c.req.raw.signal.throwIfAborted();
			if (done) break;
			if (bytes + value.byteLength > buffer.byteLength) {
				throw new AppError("Skill import request body is too large", 413);
			}
			buffer.set(value, bytes);
			bytes += value.byteLength;
		}
	} finally {
		clearTimeout(timer);
		c.req.raw.signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
	} catch {
		throw new ValidationError("Invalid JSON request body");
	}
	return body;
}

async function readImportUrl(c: Context): Promise<string> {
	const parsed = importSkillSchema.safeParse(await readSkillRemoteBody(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data.url;
}

// Keep literal import endpoints before the name routes. Authorization always precedes downloads.
// Global link import writes a remote file tree into the instance-wide skills directory.
skillRoutes.post("/global/import", requireAdmin, async (c) => {
	const url = await readImportUrl(c);
	const skill = await skillService.importGlobalSkill(url, c.req.raw.signal);
	return c.json(skill, 201);
});

skillRoutes.post("/import", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "write");
	const url = await readImportUrl(c);
	const skill = await skillService.importProjectSkill(projectGitPath, url, c.req.raw.signal);
	return c.json(skill, 201);
});

skillRoutes.post("/global/:name/update-from-url", requireAdmin, async (c) => {
	const url = await readImportUrl(c);
	return c.json(
		await skillService.updateGlobalSkillFromUrl(c.req.param("name") ?? "", url, c.req.raw.signal),
	);
});

skillRoutes.post("/:name/update-from-url", async (c) => {
	const projectGitPath = await getProjectGitPath(c, c.req.query("projectId"), "write");
	const url = await readImportUrl(c);
	return c.json(
		await skillService.updateProjectSkillFromUrl(
			projectGitPath,
			c.req.param("name"),
			url,
			c.req.raw.signal,
		),
	);
});

// === Global skill CRUD (must be before /:name to avoid route conflict) ===

/**
 * GET /api/skills/global
 * List all global skills (scanned from ~/).
 */
skillRoutes.get("/global", async (c) => {
	const loaded = await skillService.loadGlobalSkills();
	const skills = await Promise.all(
		loaded.map((skill) => skillService.describeSkillManagement(null, skill)),
	);
	return c.json(
		skills.map((s) => ({
			name: s.name,
			description: s.description,
			location: s.location,
			files: s.files,
			disabled: s.disabled ?? false,
			canUpdateFromUrl: s.canUpdateFromUrl ?? false,
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
	return c.json(await skillService.describeSkillManagement(null, skill));
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
	const loaded = await skillService.loadProjectSkills(projectGitPath);
	const skills = await Promise.all(
		loaded.map((skill) => skillService.describeSkillManagement(projectGitPath, skill)),
	);
	return c.json(
		skills.map((s) => ({
			name: s.name,
			description: s.description,
			location: s.location,
			files: s.files,
			disabled: s.disabled ?? false,
			canUpdateFromUrl: s.canUpdateFromUrl ?? false,
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

	return c.json(await skillService.describeSkillManagement(projectGitPath, skill));
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
