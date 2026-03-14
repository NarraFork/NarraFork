import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	disableRoutineForProject,
	disableRoutineGlobal,
	enableRoutineForProject,
	enableRoutineGlobal,
	getGlobalRoutineStatuses,
	getProjectRoutineStatusesWithOverride,
	resetRoutineForProject,
} from "../services/routine-service";

export const routineRoutes = new Hono();

/** List all built-in routines with global enabled status. */
routineRoutes.get("/", (c) => {
	return c.json({ routines: getGlobalRoutineStatuses() });
});

/** Toggle a routine globally. */
routineRoutes.post("/:id/toggle", async (c) => {
	const routineId = c.req.param("id");
	const body = await c.req.json<{ enabled: boolean }>();
	if (typeof body.enabled !== "boolean") {
		throw new ValidationError("enabled must be a boolean");
	}

	const userId = c.get("user").sub;
	if (body.enabled) {
		await enableRoutineGlobal(routineId, userId);
	} else {
		await disableRoutineGlobal(routineId, userId);
	}

	return c.json({ ok: true });
});

/** List all built-in routines with project-level status. */
routineRoutes.get("/project/:projectId", async (c) => {
	const projectId = c.req.param("projectId");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { chapterSettings: true },
	});
	if (!project) throw new NotFoundError("Project", projectId);

	let routinesConf: { disabledRoutines?: string[]; enabledRoutines?: string[] } | undefined;
	try {
		const cs =
			typeof project.chapterSettings === "string"
				? JSON.parse(project.chapterSettings)
				: project.chapterSettings;
		routinesConf = cs?.routines;
	} catch {
		// ignore
	}

	return c.json({ routines: getProjectRoutineStatusesWithOverride(routinesConf) });
});

/** Toggle a routine for a specific project. */
routineRoutes.post("/project/:projectId/:id/toggle", async (c) => {
	const projectId = c.req.param("projectId");
	const routineId = c.req.param("id");
	const body = await c.req.json<{ action: "enable" | "disable" | "reset" }>();

	if (!["enable", "disable", "reset"].includes(body.action)) {
		throw new ValidationError("action must be 'enable', 'disable', or 'reset'");
	}

	switch (body.action) {
		case "enable":
			await enableRoutineForProject(routineId, projectId);
			break;
		case "disable":
			await disableRoutineForProject(routineId, projectId);
			break;
		case "reset":
			await resetRoutineForProject(routineId, projectId);
			break;
	}

	return c.json({ ok: true });
});

// ── Global Prompt (AGENT.md / CLAUDE.md) ──

const GLOBAL_PROMPT_CANDIDATES = [
	join(homedir(), ".agents", "AGENT.md"),
	join(homedir(), ".claude", "CLAUDE.md"),
];

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Read the global prompt file (first found among candidates). */
routineRoutes.get("/global-prompt", async (c) => {
	const candidates: Array<{ path: string; exists: boolean }> = [];
	let content: string | null = null;
	let filePath: string | null = null;

	for (const candidate of GLOBAL_PROMPT_CANDIDATES) {
		const exists = await fileExists(candidate);
		candidates.push({ path: candidate, exists });
		if (!filePath && exists) {
			filePath = candidate;
			try {
				content = await readFile(candidate, "utf-8");
			} catch {
				content = null;
			}
		}
	}

	return c.json({ content, filePath, candidates });
});

/** Write the global prompt file. */
routineRoutes.put("/global-prompt", async (c) => {
	const body = await c.req.json<{ content: string; filePath?: string }>();
	if (typeof body.content !== "string") {
		throw new ValidationError("content must be a string");
	}

	let targetPath = body.filePath;

	if (!targetPath) {
		// Write to the first existing file, or default to ~/.agents/AGENT.md
		for (const candidate of GLOBAL_PROMPT_CANDIDATES) {
			if (await fileExists(candidate)) {
				targetPath = candidate;
				break;
			}
		}
		if (!targetPath) {
			targetPath = GLOBAL_PROMPT_CANDIDATES[0];
		}
	}

	// Validate the target path is one of the known candidates (resolve to
	// normalize any relative segments or encoding tricks from user input).
	if (!GLOBAL_PROMPT_CANDIDATES.includes(resolve(targetPath))) {
		throw new ValidationError("filePath must be one of the known global prompt paths");
	}

	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(targetPath, body.content, "utf-8");

	return c.json({ ok: true, filePath: targetPath });
});
