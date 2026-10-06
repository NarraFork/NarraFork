import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { narraforkDir } from "../lib/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolAccessMode = "readOnly" | "general" | "custom";

export interface CustomSubagentDef {
	/** Unique identifier (directory name, e.g. "security-reviewer") */
	name: string;
	/** Human-readable description */
	description: string;
	/** Tool access mode */
	toolAccess: ToolAccessMode;
	/** Explicit tool list when toolAccess === "custom" */
	customTools: string[];
	/** Default model override (empty string = inherit from parent) */
	defaultModel: string;
	/** System prompt (markdown body) */
	prompt: string;
	/** Absolute path to the SUBAGENT.md file */
	location: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUILTIN_TYPES = new Set(["explore", "plan", "general", "review"]);
const SUBAGENTS_DIR = join(narraforkDir, "subagents");
const SUBAGENT_FILE = "SUBAGENT.md";

// ---------------------------------------------------------------------------
// mtime-based cache
// ---------------------------------------------------------------------------

interface CachedDef {
	mtimeMs: number;
	def: CustomSubagentDef;
}

const defCache = new Map<string, CachedDef>();

async function getMtimeMs(filePath: string): Promise<number | null> {
	try {
		const s = await stat(filePath);
		return s.mtimeMs;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseSubagentFile(
	raw: string,
	location: string,
	dirName: string,
): CustomSubagentDef | null {
	try {
		const { data, content } = matter(raw);

		const name = typeof data.name === "string" ? data.name.trim() : dirName;
		const description = typeof data.description === "string" ? data.description.trim() : "";
		if (!name) {
			logger.warn("Custom subagent missing name", { location });
			return null;
		}

		const toolAccess: ToolAccessMode =
			data.toolAccess === "general" || data.toolAccess === "custom" ? data.toolAccess : "readOnly";

		const customTools: string[] = Array.isArray(data.customTools)
			? data.customTools.filter((t: unknown) => typeof t === "string")
			: [];

		const defaultModel = typeof data.defaultModel === "string" ? data.defaultModel.trim() : "";

		return {
			name,
			description,
			toolAccess,
			customTools,
			defaultModel,
			prompt: content.trim(),
			location,
		};
	} catch (err) {
		logger.warn("Failed to parse custom subagent file", { location, error: String(err) });
		return null;
	}
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadCached(filePath: string, dirName: string): Promise<CustomSubagentDef | null> {
	const mtimeMs = await getMtimeMs(filePath);
	if (mtimeMs === null) return null;

	const cached = defCache.get(filePath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.def;

	const raw = await readFile(filePath, "utf-8");
	const def = parseSubagentFile(raw, filePath, dirName);
	if (!def) {
		defCache.delete(filePath);
		return null;
	}

	defCache.set(filePath, { mtimeMs, def });
	return def;
}

/** Load all custom subagent definitions from ~/.narrafork/subagents/ */
export async function loadAll(): Promise<CustomSubagentDef[]> {
	const defs: CustomSubagentDef[] = [];
	try {
		const entries = await readdir(SUBAGENTS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const filePath = join(SUBAGENTS_DIR, entry.name, SUBAGENT_FILE);
			const def = await loadCached(filePath, entry.name);
			if (def) defs.push(def);
		}
	} catch {
		// Directory doesn't exist yet — that's fine
	}
	return defs;
}

/** Load a single custom subagent by name. */
export async function loadByName(name: string): Promise<CustomSubagentDef | null> {
	const dirName = sanitizeDirName(name);
	if (!dirName) return null;
	const filePath = join(SUBAGENTS_DIR, dirName, SUBAGENT_FILE);
	return loadCached(filePath, dirName);
}

/** Check whether a name refers to a built-in subagent type. */
export function isBuiltinType(name: string): boolean {
	return BUILTIN_TYPES.has(name);
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

function sanitizeDirName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function buildSubagentMd(def: Omit<CustomSubagentDef, "location">): string {
	const fm: Record<string, unknown> = {
		name: def.name,
		description: def.description,
		toolAccess: def.toolAccess,
	};
	if (def.toolAccess === "custom" && def.customTools.length > 0) {
		fm.customTools = def.customTools;
	}
	if (def.defaultModel) {
		fm.defaultModel = def.defaultModel;
	}
	return matter.stringify(`\n${def.prompt}\n`, fm);
}

export async function create(
	input: Omit<CustomSubagentDef, "location">,
): Promise<CustomSubagentDef> {
	if (isBuiltinType(input.name)) {
		throw new ValidationError(`"${input.name}" is a built-in subagent type and cannot be used`);
	}
	const dirName = sanitizeDirName(input.name);
	if (!dirName) throw new ValidationError("Invalid subagent name");

	const dir = join(SUBAGENTS_DIR, dirName);
	const filePath = join(dir, SUBAGENT_FILE);

	const dirExists = await stat(dir).then(
		() => true,
		() => false,
	);
	if (dirExists) throw new ValidationError(`Custom subagent directory already exists: ${dirName}`);

	await mkdir(dir, { recursive: true });
	await writeFile(filePath, buildSubagentMd(input), "utf-8");
	defCache.delete(filePath);

	const def = await loadCached(filePath, dirName);
	if (!def) throw new AppError("Failed to create custom subagent — parse error", 500);
	return def;
}

export async function update(
	currentName: string,
	input: Omit<CustomSubagentDef, "location">,
): Promise<CustomSubagentDef> {
	const existing = await loadByName(currentName);
	if (!existing) throw new NotFoundError("Custom subagent", currentName);

	const oldDir = dirname(existing.location);
	const oldDirName = oldDir.split("/").pop() ?? "";
	const newDirName = sanitizeDirName(input.name);
	if (!newDirName) throw new ValidationError("Invalid subagent name");

	const needsRename = newDirName !== oldDirName;

	if (needsRename) {
		if (isBuiltinType(input.name)) {
			throw new ValidationError(`"${input.name}" is a built-in subagent type and cannot be used`);
		}
		const newDir = join(SUBAGENTS_DIR, newDirName);
		const newDirExists = await stat(newDir).then(
			() => true,
			() => false,
		);
		if (newDirExists) {
			throw new ValidationError(`Custom subagent directory already exists: ${newDirName}`);
		}
		// Rename first, then write — avoids corrupting the old file if rename fails
		defCache.delete(existing.location);
		await rename(oldDir, newDir);

		const newFilePath = join(newDir, SUBAGENT_FILE);
		await writeFile(newFilePath, buildSubagentMd(input), "utf-8");

		const def = await loadCached(newFilePath, newDirName);
		if (!def) throw new AppError("Failed to update custom subagent — parse error", 500);
		return def;
	}

	// No rename — just update the file in place
	await writeFile(existing.location, buildSubagentMd(input), "utf-8");
	defCache.delete(existing.location);

	const def = await loadCached(existing.location, oldDirName);
	if (!def) throw new AppError("Failed to update custom subagent — parse error", 500);
	return def;
}

export async function remove(name: string): Promise<void> {
	const existing = await loadByName(name);
	if (!existing) throw new NotFoundError("Custom subagent", name);

	const dir = dirname(existing.location);
	defCache.delete(existing.location);
	await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const customSubagentService = {
	loadAll,
	loadByName,
	isBuiltinType,
	create,
	update,
	remove,
};
