import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { RuntimePolicyTrait } from "../lib/runtime-policy-trait";
import { narraforkDir } from "../lib/settings";
import { BUILTIN_DELEGATION_TEMPLATES, compileDelegationPolicy } from "./agent-runtime/policy";

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

const BUILTIN_TYPES = new Set(["explore", "plan", "general", "worker", "review"]);
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

/**
 * A name a user's template may not take: a built-in's, compared the way names map to
 * directories (case-insensitive, sanitized), so `Worker` or ` WORKER ` cannot land in a
 * built-in's directory either.
 */
export function isReservedTemplateName(name: string): boolean {
	const dir = sanitizeDirName(name);
	return (
		isBuiltinType(name) ||
		BUILTIN_DELEGATION_TEMPLATES.has(name) ||
		BUILTIN_TYPES.has(dir) ||
		BUILTIN_DELEGATION_TEMPLATES.has(dir)
	);
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
	if (isReservedTemplateName(input.name)) {
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
		if (isReservedTemplateName(input.name)) {
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

/**
 * Compile a delegation template, loading its custom definition when it is not built
 * in, into the ceiling trait stored on the created narrator. Every creation path
 * (live delegation, review conversion, session import) uses this, so stored rows
 * carry their ceiling and runtime never re-reads the template.
 */
export async function compileDelegationCeiling(
	requested: string,
	options: { outlineSession?: boolean } = {},
): Promise<RuntimePolicyTrait> {
	const template = canonicalTemplateName(requested);
	return compileDelegationPolicy({
		template,
		customDefinition: await resolveTemplateDefinition(template),
		outlineSession: options.outlineSession,
	});
}

/**
 * The user's definition a template name resolves to, or null for a built-in. The one
 * rule every delegation path uses (live delegation, creation, import). A built-in name
 * always means the built-in, in any spelling: a name whose directory would be a
 * built-in's (`"Worker"` → `worker/`) never loads a user's file.
 */
export async function resolveTemplateDefinition(
	template: string,
): Promise<CustomSubagentDef | null> {
	if (isReservedTemplateName(template)) return null;
	return loadByName(template);
}

/** Every directory name that belongs to a built-in template. */
function reservedDirNames(): string[] {
	return [...new Set([...BUILTIN_TYPES, ...BUILTIN_DELEGATION_TEMPLATES])];
}

/**
 * The template a requested `subagent_type` means: a name whose directory is a built-in's
 * (`"Worker"`, `"GENERAL"`) means that built-in, so a model's capitalisation never lands
 * on the read-only unknown-type fallback. Any other name is returned unchanged.
 */
export function canonicalTemplateName(name: string): string {
	if (BUILTIN_DELEGATION_TEMPLATES.has(name)) return name;
	const dir = sanitizeDirName(name);
	return BUILTIN_DELEGATION_TEMPLATES.has(dir) ? dir : name;
}

/** File operations of the move-aside, injectable so a failure can be tested. */
export interface MoveAsideIo {
	writeFile: (path: string, data: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
}

const defaultMoveAsideIo: MoveAsideIo = {
	writeFile: (path, data) => writeFile(path, data, "utf-8"),
	rename: (from, to) => rename(from, to),
};

/**
 * Move every user template that sits in a built-in's directory (created before built-in
 * names were reserved in every spelling, or before a built-in such as `worker` existed)
 * to `<name>-custom` (numbered when taken), renaming it in its file too, with a warning
 * naming the new name. The built-in always wins; nothing is deleted.
 *
 * Crash-safe order: the file is rewritten first (a temp file renamed over it inside the
 * old directory), then the directory is renamed. An interruption leaves either the old
 * directory (moved again next startup) or a fully renamed one, never a `*-custom`
 * directory whose file still claims the reserved name. A symlinked directory is skipped
 * with a warning rather than written through. Returns the new names.
 */
export async function moveAsideReservedTemplates(
	io: MoveAsideIo = defaultMoveAsideIo,
): Promise<string[]> {
	const moved: string[] = [];
	for (const reserved of reservedDirNames()) {
		const dir = join(SUBAGENTS_DIR, reserved);
		const info = await lstat(dir).catch(() => null);
		if (!info) continue;
		if (info.isSymbolicLink()) {
			logger.warn(
				`Custom subagent template directory "${reserved}" is a symlink and names a built-in template; it was left alone and is not used`,
				{ path: dir },
			);
			continue;
		}
		if (!info.isDirectory()) continue;
		const filePath = join(dir, SUBAGENT_FILE);
		if ((await getMtimeMs(filePath)) === null) continue;
		let target = `${reserved}-custom`;
		for (let n = 2; await pathExists(join(SUBAGENTS_DIR, target)); n++)
			target = `${reserved}-custom-${n}`;
		try {
			const def = parseSubagentFile(await readFile(filePath, "utf-8"), filePath, reserved);
			defCache.delete(filePath);
			if (def) {
				const { location: _old, ...rest } = def;
				const temp = join(dir, `.${SUBAGENT_FILE}.moving`);
				await io.writeFile(temp, buildSubagentMd({ ...rest, name: target }));
				await io.rename(temp, filePath);
			}
			await io.rename(dir, join(SUBAGENTS_DIR, target));
		} catch (error) {
			logger.warn(
				`Custom subagent template "${reserved}" names a built-in template and could not be renamed; it is not used and will be retried at the next start`,
				{ path: dir, error: error instanceof Error ? error.message : String(error) },
			);
			continue;
		}
		logger.warn(
			`Custom subagent template "${reserved}" names a built-in template; it was renamed to "${target}". Use subagent_type "${target}" to keep using it.`,
			{ from: dir, to: join(SUBAGENTS_DIR, target) },
		);
		moved.push(target);
	}
	return moved;
}

async function pathExists(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		() => false,
	);
}

export const customSubagentService = {
	loadAll,
	loadByName,
	resolveTemplateDefinition,
	canonicalTemplateName,
	moveAsideReservedTemplates,
	isBuiltinType,
	create,
	update,
	remove,
};
