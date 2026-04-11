/**
 * Routine service — manages enabling/disabling built-in routines.
 *
 * When a routine is enabled:
 *   - command → written into user_preferences.commands (global) or project chapterSettings.commands (project)
 *   - skill   → written as SKILL.md into ~/.narrafork/skills/ (global) or <project>/.narrafork/skills/ (project)
 *
 * When disabled, the corresponding file/command entry is removed.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects, userPreferences } from "../db/schema";
import {
	type BuiltinRoutine,
	getAllBuiltinRoutines,
	getBuiltinRoutine,
} from "../lib/builtin-routines";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { narraforkDir, settings } from "../lib/settings";
import type { Command } from "./chapter-service";

// ---------------------------------------------------------------------------
// Marker used to identify routine-managed entries
// ---------------------------------------------------------------------------

/** Prefix added to command descriptions to mark them as routine-managed. */
const ROUTINE_MARKER = "[routine:";
function routineTag(routineId: string): string {
	return `${ROUTINE_MARKER}${routineId}]`;
}
function isRoutineCommand(cmd: Command, routineId: string): boolean {
	return cmd.description?.includes(routineTag(routineId)) ?? false;
}

// ---------------------------------------------------------------------------
// Skill file helpers
// ---------------------------------------------------------------------------

const globalSkillsDir = join(narraforkDir, "skills");

function routineSkillDirName(routineId: string): string {
	return `_routine-${routineId}`;
}

function buildSkillMd(name: string, description: string, content: string): string {
	return `---\nname: "${name.replace(/"/g, '\\"')}"\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n${content}\n`;
}

// ---------------------------------------------------------------------------
// Status queries
// ---------------------------------------------------------------------------

export interface RoutineStatus {
	id: string;
	type: "command" | "skill" | "tool";
	category: string;
	name: string;
	descriptionEn: string;
	descriptionZh: string;
	enabled: boolean;
}

/** Check if a routine is globally enabled (not in the disabled list). */
function isGloballyEnabled(routineId: string): boolean {
	const routine = getBuiltinRoutine(routineId);
	const disabled = settings.routines?.disabledRoutines ?? [];
	// Routines default to off (defaultEnabled omitted or false).
	// They require explicit opt-in via the enabledRoutines whitelist.
	// Routines with defaultEnabled: true use the legacy blacklist approach.
	if (!routine?.defaultEnabled) {
		const enabled = settings.routines?.enabledRoutines ?? [];
		return enabled.includes(routineId);
	}
	return !disabled.includes(routineId);
}

/** Check if a routine is enabled for a specific project. */
function isProjectEnabled(
	routineId: string,
	projectRoutines?: { disabledRoutines?: string[]; enabledRoutines?: string[] },
): boolean {
	const globalEnabled = isGloballyEnabled(routineId);
	if (!projectRoutines) return globalEnabled;

	// Project-level enable overrides global disable
	if (projectRoutines.enabledRoutines?.includes(routineId)) return true;
	// Project-level disable overrides global enable
	if (projectRoutines.disabledRoutines?.includes(routineId)) return false;

	return globalEnabled;
}

function routineToStatus(r: BuiltinRoutine, enabled: boolean): RoutineStatus {
	const def = r.type === "command" ? r.command : r.type === "skill" ? r.skill : r.tool;
	if (!def) throw new ValidationError(`Routine ${r.id} missing definition`);
	return {
		id: r.id,
		type: r.type,
		category: r.category,
		name: "toolName" in def ? def.toolName : def.name,
		descriptionEn: def.descriptionEn,
		descriptionZh: def.descriptionZh,
		enabled,
	};
}

/** Get all routines with their global enabled status. */
export function getGlobalRoutineStatuses(): RoutineStatus[] {
	return getAllBuiltinRoutines().map((r) => routineToStatus(r, isGloballyEnabled(r.id)));
}

/** Get all routines with their effective status for a project. */
export function getProjectRoutineStatuses(projectRoutines?: {
	disabledRoutines?: string[];
	enabledRoutines?: string[];
}): RoutineStatus[] {
	return getAllBuiltinRoutines().map((r) =>
		routineToStatus(r, isProjectEnabled(r.id, projectRoutines)),
	);
}

// ---------------------------------------------------------------------------
// Enable / Disable — Global
// ---------------------------------------------------------------------------

/** Enable a routine globally: write command/skill to filesystem/DB. */
export async function enableRoutineGlobal(routineId: string, userId: string): Promise<void> {
	const routine = getBuiltinRoutine(routineId);
	if (!routine) throw new NotFoundError("Routine", routineId);

	// Remove from disabled list, add to enabled list in settings
	const disabled = settings.routines?.disabledRoutines ?? [];
	const enabled = settings.routines?.enabledRoutines ?? [];
	const newDisabled = disabled.filter((id) => id !== routineId);
	const newEnabled = enabled.includes(routineId) ? enabled : [...enabled, routineId];
	const { saveSettings } = await import("../lib/settings");
	saveSettings({
		...settings,
		routines: {
			...settings.routines,
			disabledRoutines: newDisabled,
			enabledRoutines: newEnabled,
		},
	});

	// Materialize (tool type needs no materialization — just the settings flag)
	if (routine.type === "command" && routine.command) {
		await addGlobalCommand(routine, userId);
	} else if (routine.type === "skill" && routine.skill) {
		await addGlobalSkill(routine);
	}

	logger.info("Routine enabled globally", { routineId });
}

/** Disable a routine globally: remove command/skill from filesystem/DB. */
export async function disableRoutineGlobal(routineId: string, userId: string): Promise<void> {
	const routine = getBuiltinRoutine(routineId);
	if (!routine) throw new NotFoundError("Routine", routineId);

	// Add to disabled list, remove from enabled list in settings
	const disabled = settings.routines?.disabledRoutines ?? [];
	const enabled = settings.routines?.enabledRoutines ?? [];
	const newEnabled = enabled.filter((id) => id !== routineId);
	if (!disabled.includes(routineId)) {
		const { saveSettings } = await import("../lib/settings");
		saveSettings({
			...settings,
			routines: {
				...settings.routines,
				disabledRoutines: [...disabled, routineId],
				enabledRoutines: newEnabled,
			},
		});
	} else if (newEnabled.length !== enabled.length) {
		const { saveSettings } = await import("../lib/settings");
		saveSettings({
			...settings,
			routines: { ...settings.routines, enabledRoutines: newEnabled },
		});
	}

	// Remove materialized artifacts
	if (routine.type === "command" && routine.command) {
		await removeGlobalCommand(routine, userId);
	} else if (routine.type === "skill" && routine.skill) {
		await removeGlobalSkill(routine);
	}

	logger.info("Routine disabled globally", { routineId });
}

// ---------------------------------------------------------------------------
// Enable / Disable — Project
// ---------------------------------------------------------------------------

/** Enable a routine for a project. */
export async function enableRoutineForProject(routineId: string, projectId: string): Promise<void> {
	const routine = getBuiltinRoutine(routineId);
	if (!routine) throw new NotFoundError("Routine", routineId);

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { id: true, gitPath: true, chapterSettings: true },
	});
	if (!project) throw new NotFoundError("Project", projectId);

	// Update chapterSettings.routines
	const cs = parseChapterSettings(project.chapterSettings);
	const routinesConf = cs.routines ?? {};
	routinesConf.enabledRoutines = [...new Set([...(routinesConf.enabledRoutines ?? []), routineId])];
	routinesConf.disabledRoutines = (routinesConf.disabledRoutines ?? []).filter(
		(id) => id !== routineId,
	);
	cs.routines = routinesConf;
	await db
		.update(projects)
		.set({ chapterSettings: JSON.stringify(cs), updatedAt: new Date().toISOString() })
		.where(eq(projects.id, projectId));

	// Materialize into project
	if (routine.type === "command" && routine.command) {
		await addProjectCommand(routine, projectId, cs);
	} else if (routine.type === "skill" && routine.skill && project.gitPath) {
		await addProjectSkill(routine, project.gitPath);
	}

	logger.info("Routine enabled for project", { routineId, projectId });
}

/** Disable a routine for a project. */
export async function disableRoutineForProject(
	routineId: string,
	projectId: string,
): Promise<void> {
	const routine = getBuiltinRoutine(routineId);
	if (!routine) throw new NotFoundError("Routine", routineId);

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { id: true, gitPath: true, chapterSettings: true },
	});
	if (!project) throw new NotFoundError("Project", projectId);

	// Update chapterSettings.routines
	const cs = parseChapterSettings(project.chapterSettings);
	const routinesConf = cs.routines ?? {};
	routinesConf.disabledRoutines = [
		...new Set([...(routinesConf.disabledRoutines ?? []), routineId]),
	];
	routinesConf.enabledRoutines = (routinesConf.enabledRoutines ?? []).filter(
		(id) => id !== routineId,
	);
	cs.routines = routinesConf;
	await db
		.update(projects)
		.set({ chapterSettings: JSON.stringify(cs), updatedAt: new Date().toISOString() })
		.where(eq(projects.id, projectId));

	// Remove materialized artifacts
	if (routine.type === "command" && routine.command) {
		await removeProjectCommand(routine, projectId, cs);
	} else if (routine.type === "skill" && routine.skill && project.gitPath) {
		await removeProjectSkill(routine, project.gitPath);
	}

	logger.info("Routine disabled for project", { routineId, projectId });
}

/** Reset a routine to follow global setting for a project. */
export async function resetRoutineForProject(routineId: string, projectId: string): Promise<void> {
	const routine = getBuiltinRoutine(routineId);
	if (!routine) throw new NotFoundError("Routine", routineId);

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { id: true, gitPath: true, chapterSettings: true },
	});
	if (!project) throw new NotFoundError("Project", projectId);

	const cs = parseChapterSettings(project.chapterSettings);
	const routinesConf = cs.routines ?? {};
	routinesConf.enabledRoutines = (routinesConf.enabledRoutines ?? []).filter(
		(id) => id !== routineId,
	);
	routinesConf.disabledRoutines = (routinesConf.disabledRoutines ?? []).filter(
		(id) => id !== routineId,
	);
	cs.routines = routinesConf;
	await db
		.update(projects)
		.set({ chapterSettings: JSON.stringify(cs), updatedAt: new Date().toISOString() })
		.where(eq(projects.id, projectId));

	// Sync materialized state based on effective status
	const effective = isProjectEnabled(routineId, routinesConf);
	if (effective) {
		if (routine.type === "command" && routine.command) {
			await addProjectCommand(routine, projectId, cs);
		} else if (routine.type === "skill" && routine.skill && project.gitPath) {
			await addProjectSkill(routine, project.gitPath);
		}
	} else {
		if (routine.type === "command" && routine.command) {
			await removeProjectCommand(routine, projectId, cs);
		} else if (routine.type === "skill" && routine.skill && project.gitPath) {
			await removeProjectSkill(routine, project.gitPath);
		}
	}

	logger.info("Routine reset to global for project", { routineId, projectId });
}

// ---------------------------------------------------------------------------
// Project routine status with override info
// ---------------------------------------------------------------------------

export interface ProjectRoutineStatus extends RoutineStatus {
	/** "global" = follows global, "enabled" = project override on, "disabled" = project override off */
	override: "global" | "enabled" | "disabled";
	globalEnabled: boolean;
}

export function getProjectRoutineStatusesWithOverride(projectRoutines?: {
	disabledRoutines?: string[];
	enabledRoutines?: string[];
}): ProjectRoutineStatus[] {
	return getAllBuiltinRoutines().map((r) => {
		const globalEnabled = isGloballyEnabled(r.id);
		const isOverrideEnabled = projectRoutines?.enabledRoutines?.includes(r.id) ?? false;
		const isOverrideDisabled = projectRoutines?.disabledRoutines?.includes(r.id) ?? false;
		const override: "global" | "enabled" | "disabled" = isOverrideEnabled
			? "enabled"
			: isOverrideDisabled
				? "disabled"
				: "global";
		const effective = isProjectEnabled(r.id, projectRoutines);
		return {
			...routineToStatus(r, effective),
			override,
			globalEnabled,
		};
	});
}

// ---------------------------------------------------------------------------
// Internal: command materialization
// ---------------------------------------------------------------------------

function buildCommandFromRoutine(routine: BuiltinRoutine): Command {
	const cmd = routine.command;
	if (!cmd) throw new ValidationError(`Routine ${routine.id} is not a command`);
	return {
		name: cmd.name,
		prompt: cmd.prompt,
		description: `${cmd.descriptionEn} ${routineTag(routine.id)}`,
		params: cmd.params,
		...(cmd.modelOverride ? { modelOverride: cmd.modelOverride } : {}),
	};
}

async function addGlobalCommand(routine: BuiltinRoutine, userId: string): Promise<void> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { commands: true },
	});

	let cmds: Command[] = [];
	if (pref?.commands) {
		try {
			const parsed = typeof pref.commands === "string" ? JSON.parse(pref.commands) : pref.commands;
			cmds = Array.isArray(parsed) ? parsed : [];
		} catch {
			cmds = [];
		}
	}

	// Remove existing routine command if any, then add fresh
	cmds = cmds.filter((c) => !isRoutineCommand(c, routine.id));
	cmds.push(buildCommandFromRoutine(routine));

	const now = new Date().toISOString();
	const { sqlite } = await import("../db");
	// Use raw SQL for atomic upsert like user-preferences route does
	sqlite.run(
		`INSERT INTO user_preferences (id, user_id, commands, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET commands = ?, updated_at = ?`,
		[generateId(), userId, JSON.stringify(cmds), now, now, JSON.stringify(cmds), now],
	);
}

async function removeGlobalCommand(routine: BuiltinRoutine, userId: string): Promise<void> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { commands: true },
	});
	if (!pref?.commands) return;

	let cmds: Command[] = [];
	try {
		const parsed = typeof pref.commands === "string" ? JSON.parse(pref.commands) : pref.commands;
		cmds = Array.isArray(parsed) ? parsed : [];
	} catch {
		return;
	}

	const filtered = cmds.filter((c) => !isRoutineCommand(c, routine.id));
	if (filtered.length === cmds.length) return; // nothing to remove

	const now = new Date().toISOString();
	await db
		.update(userPreferences)
		.set({ commands: JSON.stringify(filtered), updatedAt: now })
		.where(eq(userPreferences.userId, userId));
}

async function addProjectCommand(
	routine: BuiltinRoutine,
	projectId: string,
	cs: ChapterSettingsObj,
): Promise<void> {
	let cmds = cs.commands ?? [];
	cmds = cmds.filter((c: Command) => !isRoutineCommand(c, routine.id));
	cmds.push(buildCommandFromRoutine(routine));
	cs.commands = cmds;

	await db
		.update(projects)
		.set({ chapterSettings: JSON.stringify(cs), updatedAt: new Date().toISOString() })
		.where(eq(projects.id, projectId));
}

async function removeProjectCommand(
	routine: BuiltinRoutine,
	projectId: string,
	cs: ChapterSettingsObj,
): Promise<void> {
	const cmds = cs.commands ?? [];
	const filtered = cmds.filter((c: Command) => !isRoutineCommand(c, routine.id));
	if (filtered.length === cmds.length) return;
	cs.commands = filtered;

	await db
		.update(projects)
		.set({ chapterSettings: JSON.stringify(cs), updatedAt: new Date().toISOString() })
		.where(eq(projects.id, projectId));
}

// ---------------------------------------------------------------------------
// Internal: skill materialization
// ---------------------------------------------------------------------------

async function addGlobalSkill(routine: BuiltinRoutine): Promise<void> {
	const skill = routine.skill;
	if (!skill) return;
	const dirName = routineSkillDirName(routine.id);
	const skillDir = join(globalSkillsDir, dirName);
	const skillFile = join(skillDir, "SKILL.md");

	await mkdir(skillDir, { recursive: true });
	await writeFile(skillFile, buildSkillMd(skill.name, skill.descriptionEn, skill.content), "utf-8");
}

async function removeGlobalSkill(routine: BuiltinRoutine): Promise<void> {
	const dirName = routineSkillDirName(routine.id);
	const skillDir = join(globalSkillsDir, dirName);
	try {
		await access(skillDir);
		await rm(skillDir, { recursive: true, force: true });
	} catch {
		// Already gone
	}
}

async function addProjectSkill(routine: BuiltinRoutine, gitPath: string): Promise<void> {
	const skill = routine.skill;
	if (!skill) return;
	const dirName = routineSkillDirName(routine.id);
	const skillDir = join(gitPath, ".narrafork", "skills", dirName);
	const skillFile = join(skillDir, "SKILL.md");

	await mkdir(skillDir, { recursive: true });
	await writeFile(skillFile, buildSkillMd(skill.name, skill.descriptionEn, skill.content), "utf-8");
}

async function removeProjectSkill(routine: BuiltinRoutine, gitPath: string): Promise<void> {
	const dirName = routineSkillDirName(routine.id);
	const skillDir = join(gitPath, ".narrafork", "skills", dirName);
	try {
		await access(skillDir);
		await rm(skillDir, { recursive: true, force: true });
	} catch {
		// Already gone
	}
}

// ---------------------------------------------------------------------------
// Internal: chapterSettings parsing
// ---------------------------------------------------------------------------

interface ChapterSettingsObj {
	autoCreateNarrator?: boolean;
	commands?: Command[];
	routines?: {
		disabledRoutines?: string[];
		enabledRoutines?: string[];
	};
	[key: string]: unknown;
}

function parseChapterSettings(raw: unknown): ChapterSettingsObj {
	try {
		if (!raw) return {};
		return typeof raw === "string" ? JSON.parse(raw) : (raw as ChapterSettingsObj);
	} catch {
		return {};
	}
}
