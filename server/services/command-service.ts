import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects, userPreferences } from "../db/schema";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { logger } from "../lib/logger";
import type { Command, CommandParam } from "./chapter-service";
import { loadAllSkills } from "./skill-service";

/** Safely extract commands array from a chapterSettings value. */
function parseChapterSettingsCommands(raw: unknown): Command[] {
	try {
		const settings = typeof raw === "string" ? JSON.parse(raw) : raw;
		return Array.isArray(settings?.commands) ? settings.commands : [];
	} catch {
		return [];
	}
}

export interface ResolvedCommand {
	name: string;
	prompt: string;
	description?: string;
	source: "user" | "project";
	params?: CommandParam[];
}

interface CommandResolveResult {
	resolved: true;
	expandedPrompt: string;
	command: ResolvedCommand;
	rawCommand: string;
}

interface CommandNotResolved {
	resolved: false;
}

export interface LoadToolResult {
	resolved: true;
	loadTool: string;
	rawCommand: string;
}

export interface LoadToolNotFound {
	resolved: true;
	loadToolNotFound: string;
	rawCommand: string;
}

export type ResolveResult =
	| CommandResolveResult
	| CommandNotResolved
	| LoadToolResult
	| LoadToolNotFound;

/** Parse a user prompt that starts with `/commandName ...rest`. */
function parseCommandInput(prompt: string): { name: string; input: string } | null {
	const trimmed = prompt.trim();
	if (!trimmed.startsWith("/")) return null;
	const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
	if (!match) return null;
	return { name: match[1], input: match[2]?.trim() ?? "" };
}

/** Load user-level commands from user_preferences. */
async function getUserCommands(userId: string): Promise<Command[]> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { commands: true },
	});
	if (!pref?.commands) return [];
	try {
		const parsed = typeof pref.commands === "string" ? JSON.parse(pref.commands) : pref.commands;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Load project-level commands from project.chapterSettings. */
async function getProjectCommandsForNarrator(narratorId: string): Promise<Command[]> {
	// narrator → chapter → project
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return [];

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { projectId: true },
	});
	if (!chapter) return [];

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, chapter.projectId),
		columns: { chapterSettings: true },
	});
	if (!project?.chapterSettings) return [];

	return parseChapterSettingsCommands(project.chapterSettings);
}

/** Load project-level commands directly from a project ID. */
async function getProjectCommandsById(projectId: string): Promise<Command[]> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { chapterSettings: true },
	});
	if (!project?.chapterSettings) return [];
	return parseChapterSettingsCommands(project.chapterSettings);
}

/**
 * Get merged command list for a narrator. Project-level overrides user-level.
 * Returns commands tagged with their source.
 */
export async function getAvailableCommands(
	narratorId: string,
	userId: string,
): Promise<ResolvedCommand[]> {
	const [userCmds, projectCmds] = await Promise.all([
		getUserCommands(userId),
		getProjectCommandsForNarrator(narratorId),
	]);

	return mergeCommands(userCmds, projectCmds);
}

/**
 * Get merged command list for a standalone session (no chapter/project).
 * Only user-level commands are available.
 */
export async function getAvailableCommandsForSession(userId: string): Promise<ResolvedCommand[]> {
	const userCmds = await getUserCommands(userId);
	return userCmds.map((c) => ({ ...c, source: "user" as const }));
}

/**
 * Get merged command list for a project (for project settings UI).
 */
export async function getAvailableCommandsForProject(
	projectId: string,
	userId: string,
): Promise<ResolvedCommand[]> {
	const [userCmds, projectCmds] = await Promise.all([
		getUserCommands(userId),
		getProjectCommandsById(projectId),
	]);
	return mergeCommands(userCmds, projectCmds);
}

/** Merge user + project commands. Project-level wins on name collision. */
function mergeCommands(userCmds: Command[], projectCmds: Command[]): ResolvedCommand[] {
	const map = new Map<string, ResolvedCommand>();

	for (const c of userCmds) {
		map.set(c.name.toLowerCase(), { ...c, source: "user" });
	}
	// Project overrides user
	for (const c of projectCmds) {
		map.set(c.name.toLowerCase(), { ...c, source: "project" });
	}

	return Array.from(map.values());
}

/**
 * Parse positional arguments from user input based on command param definitions.
 * The first N-1 params each consume one whitespace-delimited token;
 * the last param consumes all remaining text.
 */
function parseCommandArgs(input: string, params: CommandParam[]): Record<string, string> | null {
	if (!params.length) return null;
	const tokens = input.split(/\s+/).filter(Boolean);
	const result: Record<string, string> = {};

	for (let i = 0; i < params.length; i++) {
		if (i === params.length - 1) {
			// Last param gets all remaining text
			result[params[i].name] = tokens.slice(i).join(" ") || (params[i].defaultValue ?? "");
		} else if (i < tokens.length) {
			result[params[i].name] = tokens[i];
		} else {
			// Missing token — use default or empty
			result[params[i].name] = params[i].defaultValue ?? "";
		}
	}
	return result;
}

/**
 * Check if a prompt is a slash command and resolve it.
 * Returns the expanded prompt text if matched, or null.
 */
export async function resolveCommand(
	prompt: string,
	narratorId: string,
	userId: string,
): Promise<ResolveResult> {
	const parsed = parseCommandInput(prompt);
	if (!parsed) return { resolved: false };

	// Handle /load <toolName> — load an optional tool into the session
	if (parsed.name.toLowerCase() === "load") {
		const toolId = parsed.input.trim().toLowerCase();
		if (!toolId) return { resolved: false };
		// Match against builtin tool routines by id
		const toolRoutine = getBuiltinToolRoutines().find((r) => r.id === toolId);
		if (toolRoutine?.tool) {
			return { resolved: true, loadTool: toolRoutine.tool.toolName, rawCommand: prompt };
		}
		return { resolved: true, loadToolNotFound: toolId, rawCommand: prompt };
	}

	const commands = await getAvailableCommands(narratorId, userId);
	const cmd = commands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
	if (!cmd) return { resolved: false };

	let expandedPrompt = cmd.prompt;

	if (cmd.params?.length) {
		// Multi-param mode: parse positional args and substitute {{paramName}}
		const args = parseCommandArgs(parsed.input, cmd.params);
		if (args) {
			for (const [key, value] of Object.entries(args)) {
				expandedPrompt = expandedPrompt.replaceAll(`{{${key}}}`, value);
			}
		}
	} else if (expandedPrompt.includes("{{input}}")) {
		expandedPrompt = expandedPrompt.replaceAll("{{input}}", parsed.input);
	} else if (parsed.input) {
		// If no placeholder but user provided input, append it
		expandedPrompt = `${expandedPrompt}\n\n${parsed.input}`;
	}

	logger.debug("Resolved slash command", {
		name: cmd.name,
		source: cmd.source,
		narratorId,
	});

	return {
		resolved: true,
		expandedPrompt: expandedPrompt.trim(),
		command: cmd,
		rawCommand: prompt,
	};
}

// === Skill summary for slash menu ===

export interface SkillSummary {
	name: string;
	description: string;
	source: "global" | "project";
}

/**
 * Resolve the project gitPath for a narrator (narrator → chapter → project).
 * Returns null for standalone narrators.
 */
async function getProjectGitPathForNarrator(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return null;

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { projectId: true },
	});
	if (!chapter) return null;

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, chapter.projectId),
		columns: { gitPath: true },
	});
	return project?.gitPath ?? null;
}

export interface OptionalToolMenuItem {
	id: string;
	toolName: string;
	descriptionEn: string;
	descriptionZh: string;
}

/**
 * Get commands + skills + optional tools for the slash menu.
 * Returns all lists so the frontend can render them with different styles.
 */
export async function getSlashMenuItems(
	narratorId: string,
	userId: string,
): Promise<{ commands: ResolvedCommand[]; skills: SkillSummary[]; tools: OptionalToolMenuItem[] }> {
	const [commands, gitPath] = await Promise.all([
		getAvailableCommands(narratorId, userId),
		getProjectGitPathForNarrator(narratorId),
	]);

	// Load global skills + project skills (merged), then tag source
	let skills: SkillSummary[] = [];
	try {
		const allSkills = await loadAllSkills(gitPath);
		skills = allSkills.map((s) => ({
			name: s.name,
			description: s.description,
			source:
				gitPath && s.location.startsWith(gitPath) ? ("project" as const) : ("global" as const),
		}));
	} catch {
		// Non-fatal — skills unavailable
	}

	// Optional tools available via /load
	const tools: OptionalToolMenuItem[] = getBuiltinToolRoutines()
		.filter((r) => r.tool)
		.map((r) => ({
			id: r.id,
			toolName: r.tool?.toolName ?? "",
			descriptionEn: r.tool?.descriptionEn ?? "",
			descriptionZh: r.tool?.descriptionZh ?? "",
		}));

	return { commands, skills, tools };
}
