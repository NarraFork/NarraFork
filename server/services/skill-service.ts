import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { logger } from "../lib/logger";

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

/**
 * Scan directories for SKILL.md files.
 * Searches: .narrafork/skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md, .agents/skills/<name>/SKILL.md
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
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const skillDir = join(dir, entry.name);
				const skillFile = join(skillDir, "SKILL.md");
				const skill = await loadSkillCached(skillFile, skillDir);
				if (skill) {
					skills.push(skill);
				}
			}
		} catch {
			// Directory doesn't exist, skip
		}
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
			if (entry.isFile() && entry.name !== "SKILL.md") {
				files.push(relative(skillDir, fullPath));
			} else if (entry.isDirectory() && depth < 2) {
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
 * Load all skills for a project. Skills are keyed by name; later entries override earlier ones.
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
 * Load a single skill by name from a project.
 */
export async function loadSkillByName(
	projectGitPath: string,
	name: string,
): Promise<SkillInfo | null> {
	const skills = await loadProjectSkills(projectGitPath);
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
	if (!resolved.startsWith(`${skillDir}/`) && resolved !== skillDir) {
		throw new Error("Path traversal not allowed");
	}
	return readFile(resolved, "utf-8");
}

export const skillService = {
	loadProjectSkills,
	loadSkillByName,
	readSkillFile,
};
