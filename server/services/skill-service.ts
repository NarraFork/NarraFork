import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isInsidePath } from "../lib/platform-path";
import { narraforkDir } from "../lib/settings";

export interface SkillInfo {
	name: string;
	description: string;
	location: string;
	content: string;
	/** Additional files in the skill directory (relative paths) */
	files: string[];
}

// === mtime-based cache ===

interface CachedSkill {
	mtimeMs: number;
	skill: SkillInfo;
}

/** Cache keyed by SKILL.md absolute path → parsed result + mtime */
const skillCache = new Map<string, CachedSkill>();

/**
 * Get the mtime of a file, or null if it doesn't exist.
 */
async function getMtimeMs(filePath: string): Promise<number | null> {
	try {
		const s = await stat(filePath);
		return s.mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Resolve a Dirent entry that may be a symlink and check whether it points to
 * a directory or a regular file.  For non-symlink entries the check is free
 * (no extra syscall).
 */
async function resolveEntryType(
	parentDir: string,
	entry: import("node:fs").Dirent,
): Promise<"dir" | "file" | null> {
	if (entry.isDirectory()) return "dir";
	if (entry.isFile()) return "file";
	if (entry.isSymbolicLink()) {
		try {
			const real = await realpath(join(parentDir, entry.name));
			const s = await stat(real);
			if (s.isDirectory()) return "dir";
			if (s.isFile()) return "file";
		} catch {
			// broken symlink — skip
		}
	}
	return null;
}

/**
 * Load and parse a single SKILL.md, using cache if mtime hasn't changed.
 */
async function loadSkillCached(skillFile: string, skillDir: string): Promise<SkillInfo | null> {
	const mtimeMs = await getMtimeMs(skillFile);
	if (mtimeMs === null) return null;

	const cached = skillCache.get(skillFile);
	if (cached && cached.mtimeMs === mtimeMs) {
		return cached.skill;
	}

	// Cache miss or stale — read and parse
	const raw = await readFile(skillFile, "utf-8");
	const parsed = parseSkillFile(raw, skillFile);
	if (!parsed) {
		skillCache.delete(skillFile);
		return null;
	}

	const files = await collectSkillFiles(skillDir);
	const skill: SkillInfo = { ...parsed, files };
	skillCache.set(skillFile, { mtimeMs, skill });
	return skill;
}

/** Directories to skip when recursively scanning for skills. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Maximum recursion depth when walking skill directories. */
const MAX_WALK_DEPTH = 5;

/**
 * Recursively walk a directory tree looking for sub-directories that contain a
 * `SKILL.md` file.  When a `SKILL.md` is found the directory is treated as a
 * skill root and we do **not** recurse deeper (nested dirs are companion files,
 * not nested skills).
 */
async function walkForSkills(dir: string, skills: SkillInfo[], depth: number): Promise<void> {
	if (depth > MAX_WALK_DEPTH) return;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // directory doesn't exist or not readable
	}

	for (const entry of entries) {
		if ((await resolveEntryType(dir, entry)) !== "dir") continue;
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

		const childDir = join(dir, entry.name);
		const skillFile = join(childDir, "SKILL.md");
		const skill = await loadSkillCached(skillFile, childDir);
		if (skill) {
			skills.push(skill);
			// Don't recurse into a skill directory — sub-dirs are companion files
		} else {
			// No SKILL.md here — keep looking deeper
			await walkForSkills(childDir, skills, depth + 1);
		}
	}
}

/**
 * Scan directories for SKILL.md files (recursively).
 * Searches: .narrafork/skills/, .claude/skills/, .agents/skills/ under basePath,
 * walking sub-directories up to {@link MAX_WALK_DEPTH} levels deep.
 */
async function scanSkillDirs(basePath: string): Promise<SkillInfo[]> {
	const skills: SkillInfo[] = [];
	const searchDirs = [
		join(basePath, ".narrafork", "skills"),
		join(basePath, ".narrafork", "skill"),
		join(basePath, ".claude", "skills"),
		join(basePath, ".agents", "skills"),
	];

	for (const dir of searchDirs) {
		await walkForSkills(dir, skills, 0);
	}

	return skills;
}

/**
 * Parse a SKILL.md file with YAML frontmatter.
 */
function parseSkillFile(raw: string, location: string): Omit<SkillInfo, "files"> | null {
	try {
		const { data, content } = matter(raw);
		const name = typeof data.name === "string" ? data.name.trim() : "";
		const description = typeof data.description === "string" ? data.description.trim() : "";
		if (!name || !description) {
			logger.warn("Skill missing name or description", { location });
			return null;
		}
		return { name, description, location, content: content.trim() };
	} catch (err) {
		logger.warn("Failed to parse skill file", { location, error: String(err) });
		return null;
	}
}

/**
 * Collect non-SKILL.md files in a skill directory (up to 20 files, max 2 levels deep).
 */
async function collectSkillFiles(skillDir: string, depth = 0): Promise<string[]> {
	if (depth > 2) return [];
	const files: string[] = [];
	try {
		const entries = await readdir(skillDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(skillDir, entry.name);
			const kind = await resolveEntryType(skillDir, entry);
			if (kind === "file" && entry.name !== "SKILL.md") {
				files.push(relative(skillDir, fullPath));
			} else if (kind === "dir" && depth < 2) {
				const sub = await collectSkillFiles(fullPath, depth + 1);
				files.push(...sub.map((f) => join(entry.name, f)));
			}
			if (files.length >= 20) break;
		}
	} catch {
		// ignore
	}
	return files.slice(0, 20);
}

/**
 * Walk up from `startDir` to find the nearest directory containing `.git`.
 * Returns the git root path, or null if none found.
 */
async function findGitRoot(startDir: string): Promise<string | null> {
	let dir = startDir;
	while (true) {
		try {
			await access(join(dir, ".git"));
			return dir;
		} catch {
			// not found here
		}
		const parent = dirname(dir);
		if (parent === dir) return null; // reached filesystem root
		dir = parent;
	}
}

/**
 * Load all skills for a project (project-level only, no global).
 * Skills are keyed by name; later entries override earlier ones.
 */
export async function loadProjectSkills(projectGitPath: string): Promise<SkillInfo[]> {
	const skillMap = new Map<string, SkillInfo>();

	const skills = await scanSkillDirs(projectGitPath);
	for (const skill of skills) {
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

/**
 * Load global skills from ~/  (scans ~/.narrafork/skills/, ~/.claude/skills/, ~/.agents/skills/).
 */
export async function loadGlobalSkills(): Promise<SkillInfo[]> {
	const skillMap = new Map<string, SkillInfo>();
	const skills = await scanSkillDirs(homedir());
	for (const s of skills) skillMap.set(s.name, s);
	return Array.from(skillMap.values());
}

/**
 * Load all skills (global + project-level). Project-level overrides global on name collision.
 *
 * Priority chain (low → high):
 *   ~/.narrafork/skills < ~/.narrafork/skill < ~/.claude/skills < ~/.agents/skills
 *   < <project>/.narrafork/skills < ... < <project>/.agents/skills
 */
export async function loadAllSkills(projectGitPath: string | null): Promise<SkillInfo[]> {
	const skillMap = new Map<string, SkillInfo>();

	// 1. Global skills (lowest priority)
	const globalSkills = await scanSkillDirs(homedir());
	for (const s of globalSkills) skillMap.set(s.name, s);

	// 2. Project-level skills (override global)
	if (projectGitPath) {
		const projectSkills = await scanSkillDirs(projectGitPath);
		for (const s of projectSkills) skillMap.set(s.name, s);
	}

	return Array.from(skillMap.values());
}

/**
 * Resolve the skill scan root for a given directory.
 * For project-bound narrators, this is the project gitPath.
 * For standalone narrators, walk up from cwd to find the git root.
 */
export async function resolveSkillRoot(
	projectGitPath: string | null | undefined,
	cwd: string,
): Promise<string | null> {
	if (projectGitPath) return projectGitPath;
	return findGitRoot(cwd);
}

/**
 * Load a single skill by name (global + project merged).
 */
export async function loadSkillByName(
	projectGitPath: string,
	name: string,
): Promise<SkillInfo | null> {
	const skills = await loadAllSkills(projectGitPath);
	return skills.find((s) => s.name === name) ?? null;
}

/**
 * Read a companion file from a skill directory.
 */
export async function readSkillFile(skillLocation: string, filePath: string): Promise<string> {
	// skillLocation is the SKILL.md path; get the directory
	const skillDir = resolve(dirname(skillLocation));
	const resolved = resolve(skillDir, filePath);
	// Security: ensure the resolved path is within the skill directory
	// resolve() normalises ".." segments AND handles absolute filePath values
	if (!isInsidePath(skillDir, resolved)) {
		throw new ValidationError("Path traversal not allowed");
	}
	return readFile(resolved, "utf-8");
}

// === Global skill CRUD (writes to ~/.narrafork/skills/) ===

const globalSkillsDir = join(narraforkDir, "skills");

function sanitizeSkillDirName(name: string): string {
	// Convert to a safe directory name: lowercase, replace spaces/special chars with hyphens
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function buildSkillMd(name: string, description: string, content: string): string {
	return `---\nname: "${name.replace(/"/g, '\\"')}"\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n${content}\n`;
}

export async function createGlobalSkill(
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	const dirName = sanitizeSkillDirName(name);
	if (!dirName) throw new ValidationError("Invalid skill name");

	const skillDir = join(globalSkillsDir, dirName);
	const skillFile = join(skillDir, "SKILL.md");

	// Check if directory already exists
	try {
		await access(skillDir);
		throw new ValidationError(`Skill directory already exists: ${dirName}`);
	} catch (err) {
		if (err instanceof ValidationError) throw err;
		// Directory doesn't exist — good
	}

	await mkdir(skillDir, { recursive: true });
	await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");

	// Invalidate cache
	skillCache.delete(skillFile);

	const skill = await loadSkillCached(skillFile, skillDir);
	if (!skill) throw new AppError("Failed to create skill — parse error", 500);
	return skill;
}

export async function updateGlobalSkill(
	currentName: string,
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	// Find the existing skill among global skills to get its location
	const globals = await loadGlobalSkills();
	const existing = globals.find((s) => s.name === currentName);
	if (!existing) throw new NotFoundError("Global skill", currentName);

	const skillFile = existing.location;
	const skillDir = dirname(skillFile);

	await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");

	// Invalidate cache
	skillCache.delete(skillFile);

	const updated = await loadSkillCached(skillFile, skillDir);
	if (!updated) throw new AppError("Failed to update skill — parse error", 500);
	return updated;
}

export async function deleteGlobalSkill(name: string): Promise<void> {
	const globals = await loadGlobalSkills();
	const existing = globals.find((s) => s.name === name);
	if (!existing) throw new NotFoundError("Global skill", name);

	const skillDir = dirname(existing.location);
	skillCache.delete(existing.location);
	await rm(skillDir, { recursive: true, force: true });
}

export const skillService = {
	loadProjectSkills,
	loadGlobalSkills,
	loadAllSkills,
	loadSkillByName,
	readSkillFile,
	createGlobalSkill,
	updateGlobalSkill,
	deleteGlobalSkill,
};
