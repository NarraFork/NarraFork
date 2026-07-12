import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects, userPreferences } from "../db/schema";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { logger } from "../lib/logger";
import { getBlockedSkills, isSkillBlocked } from "../lib/narrator-custom-traits";
import type { Command, CommandModelOverride, CommandParam } from "./chapter-service";
import { loadSkillSummariesForContext, resolveSkillContextForNarrator } from "./skill-service";

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
	runBashFirst?: boolean;
	bashCommand?: string;
	params?: CommandParam[];
	modelOverride?: CommandModelOverride;
}

interface CommandResolveResult {
	resolved: true;
	expandedPrompt: string;
	bashCommand?: string;
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

export interface UnloadToolResult {
	resolved: true;
	unloadTool: string;
	rawCommand: string;
}

export interface UnloadToolNotFound {
	resolved: true;
	unloadToolNotFound: string;
	rawCommand: string;
}

export interface LoadSkillResult {
	resolved: true;
	loadSkill: string;
	skillInput: string;
	rawCommand: string;
}

/** `/unload skill <name>` — block a specific skill for this narrator. */
export interface BlockSkillResult {
	resolved: true;
	blockSkill: string;
	rawCommand: string;
}

/** `/unload all_skills` — block every skill for this narrator. */
export interface BlockAllSkillsResult {
	resolved: true;
	blockAllSkills: true;
	rawCommand: string;
}

/** `/load skill <name>` — unblock a previously blocked skill. */
export interface UnblockSkillResult {
	resolved: true;
	unblockSkill: string;
	rawCommand: string;
}

/** `/load all_skills` — clear the blocked-skills restriction. */
export interface UnblockAllSkillsResult {
	resolved: true;
	unblockAllSkills: true;
	rawCommand: string;
}

export interface BashCommandResult {
	resolved: true;
	bashCommand: string;
	rawCommand: string;
}

export interface SpecGoalCommandResult {
	resolved: true;
	specGoal: true;
	objective: string;
	rawCommand: string;
}

export type ResolveResult =
	| CommandResolveResult
	| CommandNotResolved
	| LoadToolResult
	| LoadToolNotFound
	| UnloadToolResult
	| UnloadToolNotFound
	| LoadSkillResult
	| BlockSkillResult
	| BlockAllSkillsResult
	| UnblockSkillResult
	| UnblockAllSkillsResult
	| BashCommandResult
	| SpecGoalCommandResult;

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

function replaceCommandPlaceholders(template: string, values: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(values)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

function resolveBuiltinToolById(toolId: string) {
	return getBuiltinToolRoutines().find((r) => r.id === toolId && r.tool);
}

export function getAvailableOptionalToolIds(): string[] {
	return getBuiltinToolRoutines()
		.filter((r) => r.tool)
		.map((r) => r.id);
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
		const rawInput = parsed.input.trim();
		const lowerInput = rawInput.toLowerCase();
		// /load all_skills — clear the blocked-skills restriction entirely.
		if (lowerInput === "all_skills") {
			return { resolved: true, unblockAllSkills: true, rawCommand: prompt };
		}
		// /load skill <name> — unblock a specific skill.
		if (lowerInput === "skill" || lowerInput.startsWith("skill ")) {
			const skillName = rawInput.slice("skill".length).trim();
			if (!skillName) return { resolved: false };
			return { resolved: true, unblockSkill: skillName, rawCommand: prompt };
		}
		const toolId = lowerInput;
		if (!toolId) return { resolved: false };
		const toolRoutine = resolveBuiltinToolById(toolId);
		if (toolRoutine?.tool) {
			return { resolved: true, loadTool: toolRoutine.tool.toolName, rawCommand: prompt };
		}
		return { resolved: true, loadToolNotFound: toolId, rawCommand: prompt };
	}

	// Handle /unload <toolName> — unload an optional tool from the session
	if (parsed.name.toLowerCase() === "unload") {
		const rawInput = parsed.input.trim();
		const lowerInput = rawInput.toLowerCase();
		// /unload all_skills — block every skill for this narrator.
		if (lowerInput === "all_skills") {
			return { resolved: true, blockAllSkills: true, rawCommand: prompt };
		}
		// /unload skill <name> — block a specific skill.
		if (lowerInput === "skill" || lowerInput.startsWith("skill ")) {
			const skillName = rawInput.slice("skill".length).trim();
			if (!skillName) return { resolved: false };
			return { resolved: true, blockSkill: skillName, rawCommand: prompt };
		}
		const toolId = lowerInput;
		if (!toolId) return { resolved: false };
		const toolRoutine = resolveBuiltinToolById(toolId);
		if (toolRoutine?.tool) {
			return { resolved: true, unloadTool: toolRoutine.tool.toolName, rawCommand: prompt };
		}
		return { resolved: true, unloadToolNotFound: toolId, rawCommand: prompt };
	}

	// Handle /skill <name> [input] — directly inject skill content into the message
	if (parsed.name.toLowerCase() === "skill") {
		// Split: first token is skill name, rest is user input
		const parts = parsed.input.split(/\s+/);
		const skillName = parts[0]?.trim();
		if (!skillName) return { resolved: false };
		const skillInput = parts.slice(1).join(" ").trim();
		return { resolved: true, loadSkill: skillName, skillInput, rawCommand: prompt };
	}

	// Handle /bash <command> — directly execute a bash command without AI
	if (parsed.name.toLowerCase() === "bash") {
		const bashCommand = parsed.input.trim();
		if (!bashCommand) return { resolved: false };
		return { resolved: true, bashCommand, rawCommand: prompt };
	}

	// Handle /goal <objective> — add a protected task to spec://tasks.json.
	if (parsed.name.toLowerCase() === "goal") {
		const objective = parsed.input.trim();
		if (!objective) return { resolved: false };
		return { resolved: true, specGoal: true, objective, rawCommand: prompt };
	}

	const commands = await getAvailableCommands(narratorId, userId);
	const cmd = commands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
	if (!cmd) return { resolved: false };

	let expandedPrompt = cmd.prompt;
	let expandedBashCommand = cmd.runBashFirst ? cmd.bashCommand : undefined;

	if (cmd.params?.length) {
		// Multi-param mode: parse positional args and substitute {{paramName}} / {{input}}
		const args = parseCommandArgs(parsed.input, cmd.params);
		if (args) {
			const values = { input: parsed.input, ...args };
			expandedPrompt = replaceCommandPlaceholders(expandedPrompt, values);
			if (expandedBashCommand) {
				expandedBashCommand = replaceCommandPlaceholders(expandedBashCommand, values);
			}
		}
	} else {
		if (expandedPrompt.includes("{{input}}")) {
			expandedPrompt = expandedPrompt.replaceAll("{{input}}", parsed.input);
		} else if (parsed.input) {
			// If no placeholder but user provided input, append it
			expandedPrompt = `${expandedPrompt}\n\n${parsed.input}`;
		}
		if (expandedBashCommand) {
			expandedBashCommand = expandedBashCommand.replaceAll("{{input}}", parsed.input);
		}
	}

	logger.debug("Resolved slash command", {
		name: cmd.name,
		source: cmd.source,
		narratorId,
	});

	return {
		resolved: true,
		expandedPrompt: expandedPrompt.trim(),
		...(expandedBashCommand?.trim() ? { bashCommand: expandedBashCommand.trim() } : {}),
		command: cmd,
		rawCommand: prompt,
	};
}

// === Skill summary for slash menu ===

export interface SkillSummary {
	name: string;
	description: string;
	source: "global" | "project" | "workspace";
	/** Whether this skill is currently blocked for the narrator (via custom trait). */
	blocked?: boolean;
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
): Promise<{
	commands: ResolvedCommand[];
	skills: SkillSummary[];
	tools: OptionalToolMenuItem[];
	allSkillsBlocked: boolean;
}> {
	const [customCommands, skillContext, narrator] = await Promise.all([
		getAvailableCommands(narratorId, userId),
		resolveSkillContextForNarrator(narratorId),
		db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { traits: true },
		}),
	]);
	const blockedSkills = getBlockedSkills(narrator?.traits);
	const commands: ResolvedCommand[] = [
		{
			name: "goal",
			prompt: "/goal <objective>",
			description: "Add a protected task to the task list",
			source: "user",
		},
		...customCommands,
	];

	// Load global + project + workspace skills for this narrator context.
	let skills: SkillSummary[] = [];
	try {
		const result = await loadSkillSummariesForContext(skillContext);
		skills = result.skills
			.filter((s) => !s.disabled)
			.map((s) => ({
				name: s.name,
				description: s.description,
				source: s.source,
				blocked: isSkillBlocked(blockedSkills, s.name),
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

	return { commands, skills, tools, allSkillsBlocked: blockedSkills.all };
}
