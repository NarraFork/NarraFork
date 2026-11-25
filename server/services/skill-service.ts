import { realpathSync } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
import matter from "gray-matter";
import { db } from "../db";
import { narrators, projects, skillDirectoryCaches } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { getBuiltinSkillRoutines } from "../lib/builtin-routines";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { hotSafe, hotTimer } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { isInsidePath } from "../lib/platform-path";
import { resolveNarratorProjectId } from "./narrator-project";
import {
	replaceSkillDirectory,
	snapshotSkillDefinition,
	snapshotSkillDirectory,
} from "./skill-directory-sync";
import { type DownloadedSkillFile, validateImportedSkillPath } from "./skill-github-import";
import { downloadSkillLink, isGitHubSkillDirectoryUrl } from "./skill-link-download";
import { withSkillCreation } from "./skill-write-scope";

export type SkillSource = "global" | "project" | "workspace";

export interface SkillInfo {
	name: string;
	description: string;
	location: string;
	content: string;
	/** Additional files in the skill directory (relative paths) */
	files: string[];
	/** Whether this skill is disabled (SKILL.md.disabled) */
	disabled?: boolean;
	/** Set only for management APIs, not the narrator prompt. */
	canUpdateFromUrl?: boolean;
	/** Context source when loaded through narrator/workspace APIs. */
	source?: SkillSource;
	rootKind?: SkillSource;
	/** Codex-compatible: frontmatter `metadata.short-description` or sidecar `interface.short_description`. */
	shortDescription?: string;
	/** Codex-compatible: sidecar `interface.display_name`. */
	displayName?: string;
	/** Codex-compatible: sidecar `interface.default_prompt`. */
	defaultPrompt?: string;
	/**
	 * Codex-compatible: sidecar `policy.allow_implicit_invocation`.
	 * When explicitly false, the skill is excluded from the auto-injected
	 * `<available_skills>` list but can still be invoked explicitly by name.
	 * Undefined is treated as true.
	 */
	allowImplicitInvocation?: boolean;
}

export interface SkillSummaryInfo {
	name: string;
	description: string;
	location: string;
	files: string[];
	disabled?: boolean;
	source: SkillSource;
	rootKind: SkillSource;
	normalizedRootPath: string;
	/** Codex-compatible metadata (see {@link SkillInfo}). */
	shortDescription?: string;
	displayName?: string;
	defaultPrompt?: string;
	allowImplicitInvocation?: boolean;
}

export interface SkillContext {
	projectGitPath?: string | null;
	cwd?: string | null;
}

export interface SkillRootInfo {
	rootKind: SkillSource;
	rootPath: string;
	normalizedRootPath: string;
}

export interface SkillRootCacheMeta extends SkillRootInfo {
	scannedAt?: string | null;
	lastAccessedAt?: string | null;
	expiresAt?: string | null;
	cacheHit: boolean;
	refreshed: boolean;
	cacheable: boolean;
	skillCount: number;
}

export interface SkillContextLoadResult {
	skills: SkillSummaryInfo[];
	roots: SkillRootCacheMeta[];
	scopeKey: string;
}

interface SkillSignatureEntry {
	location: string;
	disabled: boolean;
	mtimeMs: number;
}

interface DiscoveredSkillFile extends SkillSignatureEntry {
	skillDir: string;
	/**
	 * Index of the search directory this file was found under, per
	 * {@link getSkillSearchDirs}. Higher wins a name collision.
	 */
	searchDirRank: number;
}

interface DiscoveryResult {
	entries: DiscoveredSkillFile[];
	truncated: boolean;
}

// === mtime-based full-content cache ===

interface CachedSkill {
	mtimeMs: number;
	/** mtime of the `agents/openai.yaml` sidecar, or null when absent. */
	sidecarMtimeMs: number | null;
	skill: SkillInfo;
}

/** Cache keyed by SKILL.md absolute path → parsed result + mtime. */
const skillCache = new Map<string, CachedSkill>();

const SKILL_SUMMARY_REFRESH_TTL_MS = 15_000;
const SKILL_DIRECTORY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SKILL_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SKILLS_PER_ROOT = 200;
const MAX_SKILL_DESCRIPTION_CHARS = 1_000;
const MAX_SIGNATURE_JSON_BYTES = 120_000;
const MAX_SKILLS_JSON_BYTES = 240_000;
const MAX_SKILL_CACHE_ROOTS = 200;
const SKILL_CACHE_TIMER_KEY = "narrafork.skillDirectoryCacheCleanup";

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

async function readSkillTextBounded(path: string, maxBytes: number): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return null;
		const declared = Number(info.size);
		if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
			logger.warn("Skill file exceeds the read limit", { path, maxBytes });
			return null;
		}
		// Allocate the declared size, then read one extra byte so a growing file cannot
		// be parsed from a short snapshot.
		const buffer = new Uint8Array(declared);
		let total = 0;
		while (total < declared) {
			const { bytesRead } = await handle.read(buffer, total, declared - total, total);
			if (!bytesRead) break;
			total += bytesRead;
		}
		const extra = new Uint8Array(1);
		const more = await handle.read(extra, 0, 1, declared);
		if (total !== declared || more.bytesRead > 0) {
			logger.warn("Skill file changed while it was being read", { path });
			return null;
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		} catch {
			logger.warn("Skill file is not valid UTF-8", { path });
			return null;
		}
	} finally {
		await handle.close();
	}
}

type SkillYamlState = { anchor: string | null };
// gray-matter exposes its safe YAML engine at runtime, but omits it from its types.
const skillYaml = (
	matter as typeof matter & {
		engines: {
			yaml: {
				parse(
					raw: string,
					options: { listener(event: string, state: SkillYamlState): void },
				): unknown;
			};
		};
	}
).engines.yaml;
function parseSkillYaml(raw: string): Record<string, unknown> {
	let nodes = 0;
	const parsed = skillYaml.parse(raw, {
		listener(event, state) {
			// Stop at an anchor's parse boundary, before aliases can cause repeated
			// merge work. Quoted text, comments and block scalars remain ordinary data.
			if (++nodes > 40_000 || (event === "close" && state.anchor !== null)) {
				throw new ValidationError(
					"Skill YAML references exceed the parsing budget",
					"SKILL_YAML_COMPLEXITY",
				);
			}
		},
	});
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}
/**
 * Load and parse a single SKILL.md (or SKILL.md.disabled), using cache if mtime hasn't changed.
 */
async function loadSkillCached(
	skillFile: string,
	skillDir: string,
	disabled = false,
): Promise<SkillInfo | null> {
	const mtimeMs = await getMtimeMs(skillFile);
	if (mtimeMs === null) return null;

	const sidecarMtimeMs = await getMtimeMs(getSidecarPath(skillDir));

	const cached = skillCache.get(skillFile);
	if (cached && cached.mtimeMs === mtimeMs && cached.sidecarMtimeMs === sidecarMtimeMs) {
		return cached.skill;
	}

	// Cache miss or stale — read and parse
	const raw = await readSkillTextBounded(skillFile, 200_000);
	if (raw === null) {
		skillCache.delete(skillFile);
		return null;
	}
	const parsed = parseSkillFile(raw, skillFile);
	if (!parsed) {
		skillCache.delete(skillFile);
		return null;
	}

	const files = await collectSkillFiles(skillDir);
	const skill: SkillInfo = { ...parsed, files, disabled };

	// Codex-compatible: merge `agents/openai.yaml` sidecar metadata.
	// Frontmatter `metadata.short-description` takes precedence over the sidecar.
	const sidecar = await loadSkillSidecar(skillDir);
	if (sidecar) {
		if (sidecar.displayName) skill.displayName = sidecar.displayName;
		if (sidecar.defaultPrompt) skill.defaultPrompt = sidecar.defaultPrompt;
		if (sidecar.shortDescription && !skill.shortDescription) {
			skill.shortDescription = sidecar.shortDescription;
		}
		if (typeof sidecar.allowImplicitInvocation === "boolean") {
			skill.allowImplicitInvocation = sidecar.allowImplicitInvocation;
		}
	}

	skillCache.set(skillFile, { mtimeMs, sidecarMtimeMs, skill });
	return skill;
}

/** Directories to skip when recursively scanning for skills. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Maximum recursion depth when walking skill directories. */
const MAX_WALK_DEPTH = 5;

/**
 * Recursively walk a directory tree looking for sub-directories that contain a
 * `SKILL.md` file.  When `SKILL.md` or `SKILL.md.disabled` is present the directory
 * is a skill root and we do **not** recurse deeper, even if the file cannot be
 * loaded. Nested dirs are companion files, not nested skills.
 */
async function walkForSkills(dir: string, skills: SkillInfo[], depth: number): Promise<void> {
	if (depth > MAX_WALK_DEPTH) return;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // directory doesn't exist or not readable
	}
	// Name-sorted, because the winner of a same-name collision is decided by ARRIVAL
	// ORDER (callers build a Map and let the later entry overwrite). `readdir` gives no
	// order guarantee, so two skills of the same name in sibling sub-directories of ONE
	// search dir could resolve differently here than in the summary path
	// (`walkForSkillFiles`, which sorts by `location`) — and a disagreement between
	// those two means the toggle writes to a different copy than the list displays.
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		if ((await resolveEntryType(dir, entry)) !== "dir") continue;
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

		const childDir = join(dir, entry.name);
		const skillFile = join(childDir, "SKILL.md");
		// Presence owns the directory. An oversized, invalid, or non-UTF-8 definition
		// stays a skill root so companion directories are not discovered as skills.
		if ((await getMtimeMs(skillFile)) !== null) {
			const skill = await loadSkillCached(skillFile, childDir);
			if (skill) skills.push(skill);
			continue;
		}
		const disabledFile = join(childDir, "SKILL.md.disabled");
		if ((await getMtimeMs(disabledFile)) !== null) {
			const disabledSkill = await loadSkillCached(disabledFile, childDir, true);
			if (disabledSkill) skills.push(disabledSkill);
			continue;
		}
		await walkForSkills(childDir, skills, depth + 1);
	}
}

/**
 * Scan directories for SKILL.md files (recursively).
 * Searches every directory {@link getSkillSearchDirs} lists for `basePath`, walking
 * sub-directories up to {@link MAX_WALK_DEPTH} levels deep.
 */
async function scanSkillDirs(basePath: string): Promise<SkillInfo[]> {
	const skills: SkillInfo[] = [];
	const searchDirs = getSkillSearchDirs(basePath);

	for (const dir of searchDirs) {
		await walkForSkills(dir, skills, 0);
	}

	return skills;
}

/**
 * The physical path `path` names, or the lexically resolved path when it cannot be
 * resolved (it may not exist yet).
 *
 * Needed because the home root arrives here already realpath'd — `resolveSkillRootsForContext`
 * normalizes every root — while `homedir()` and `NARRAFORK_HOME` are raw. On a system where
 * `/home/u` is a symlink to `/mnt/data/u`, comparing the two forms makes the home root look
 * like an ordinary directory, and the user-level search dirs below silently drop out.
 */
function canonical(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

let cachedHomeDir: string | null = null;
function getHomeDir(): string {
	if (cachedHomeDir === null) cachedHomeDir = canonical(homedir());
	return cachedHomeDir;
}

function getSkillSearchDirs(basePath: string): string[] {
	const dirs = [
		join(basePath, ".narrafork", "skills"),
		join(basePath, ".narrafork", "skill"),
		join(basePath, ".claude", "skills"),
		join(basePath, ".agents", "skills"),
		// Codex-compatible locations: `.codex/skills` (repo-level) and, for the home
		// directory, the default `~/.codex/skills` user-level location.
		join(basePath, ".codex", "skills"),
	];

	// User-level roots that are NOT derived from `basePath`. Only meaningful when this
	// call is scanning the home directory: for a project or workspace root, appending
	// them would scan the same user-level directories once per project.
	if (canonical(basePath) === getHomeDir()) {
		// `$NARRAFORK_HOME/skills`. This is where `createGlobalSkill` and routine
		// materialization WRITE, so leaving it out of the read path meant a custom
		// NARRAFORK_HOME made every global skill invisible the moment it was created —
		// no error, just a skill that never appears. With the default home the path is
		// `~/.narrafork/skills`, already covered above, hence deduped rather than added.
		const narraforkSkills = join(getNarraforkHome(), "skills");
		if (!dirs.includes(narraforkSkills)) dirs.push(narraforkSkills);

		// Support a custom CODEX_HOME (e.g. not `~/.codex`).
		const codexHome = process.env.CODEX_HOME?.trim();
		if (codexHome) {
			const codexSkills = join(resolve(codexHome), "skills");
			if (!dirs.includes(codexSkills)) dirs.push(codexSkills);
		}
	}

	return dirs;
}

/**
 * Parse a SKILL.md file with YAML frontmatter.
 */
function parseSkillFile(raw: string, location: string): Omit<SkillInfo, "files"> | null {
	try {
		// Skills use YAML only. gray-matter also ships a JavaScript engine which
		// evaluates tagged frontmatter; never let downloaded (or local) skills select it.
		const normalized = raw.replace(/^\uFEFF/, "");
		if (!/^---[\t ]*\r?\n/.test(normalized)) return null;
		const { data, content } = matter(normalized, { engines: { yaml: parseSkillYaml } });
		const name = typeof data.name === "string" ? data.name.trim() : "";
		const description = typeof data.description === "string" ? data.description.trim() : "";
		if (!name || !description) {
			logger.warn("Skill missing name or description", { location });
			return null;
		}
		// Codex-compatible: `metadata.short-description` (nested, kebab-case key).
		const metadata =
			data.metadata && typeof data.metadata === "object"
				? (data.metadata as Record<string, unknown>)
				: null;
		const rawShort = metadata?.["short-description"];
		const shortDescription = typeof rawShort === "string" ? rawShort.trim() : undefined;
		return {
			name,
			description,
			location,
			content: content.trim(),
			...(shortDescription ? { shortDescription } : {}),
		};
	} catch (err) {
		logger.warn("Failed to parse skill file", { location, error: String(err) });
		return null;
	}
}

/**
 * Read and parse a Codex-compatible `agents/openai.yaml` sidecar from a skill
 * directory. Returns partial metadata to merge onto the skill.
 *
 * Fail-open: a missing or malformed sidecar must never block loading SKILL.md
 * (mirrors Codex's `load_skill_metadata`).
 */
async function loadSkillSidecar(skillDir: string): Promise<{
	displayName?: string;
	shortDescription?: string;
	defaultPrompt?: string;
	allowImplicitInvocation?: boolean;
} | null> {
	const sidecarPath = join(skillDir, "agents", "openai.yaml");
	let raw: string;
	try {
		const content = await readSkillTextBounded(sidecarPath, 200_000);
		if (content === null) return null;
		raw = content;
	} catch {
		return null; // no sidecar
	}

	let parsed: unknown;
	try {
		parsed = parseSkillYaml(raw);
	} catch (err) {
		logger.warn("Failed to parse skill sidecar", { location: sidecarPath, error: String(err) });
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;

	const root = parsed as Record<string, unknown>;
	const result: {
		displayName?: string;
		shortDescription?: string;
		defaultPrompt?: string;
		allowImplicitInvocation?: boolean;
	} = {};

	const iface =
		root.interface && typeof root.interface === "object"
			? (root.interface as Record<string, unknown>)
			: null;
	if (iface) {
		if (typeof iface.display_name === "string" && iface.display_name.trim()) {
			result.displayName = iface.display_name.trim();
		}
		if (typeof iface.short_description === "string" && iface.short_description.trim()) {
			result.shortDescription = iface.short_description.trim();
		}
		if (typeof iface.default_prompt === "string" && iface.default_prompt.trim()) {
			result.defaultPrompt = iface.default_prompt.trim();
		}
	}

	const policy =
		root.policy && typeof root.policy === "object"
			? (root.policy as Record<string, unknown>)
			: null;
	if (policy && typeof policy.allow_implicit_invocation === "boolean") {
		result.allowImplicitInvocation = policy.allow_implicit_invocation;
	}

	return result;
}

function getSidecarPath(skillDir: string): string {
	return join(skillDir, "agents", "openai.yaml");
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
			if (kind === "file" && entry.name !== "SKILL.md" && entry.name !== "SKILL.md.disabled") {
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
	let dir = resolve(startDir);
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

async function normalizeRootPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function addRootIfDistinct(roots: SkillRootInfo[], rootKind: SkillSource, rootPath: string): void {
	const normalizedRootPath = resolve(rootPath);
	if (roots.some((root) => root.normalizedRootPath === normalizedRootPath)) return;
	roots.push({ rootKind, rootPath: normalizedRootPath, normalizedRootPath });
}

async function resolveWorkspaceRoot(cwd: string | null | undefined): Promise<string | null> {
	if (!cwd?.trim()) return null;
	const normalizedCwd = await normalizeRootPath(cwd.trim());
	const gitRoot = await findGitRoot(normalizedCwd);
	return gitRoot ?? normalizedCwd;
}

/** Resolve all skill roots for a narrator/workspace context. */
export async function resolveSkillRootsForContext(context: SkillContext): Promise<SkillRootInfo[]> {
	const roots: SkillRootInfo[] = [];

	addRootIfDistinct(roots, "global", await normalizeRootPath(homedir()));

	if (context.projectGitPath?.trim()) {
		addRootIfDistinct(roots, "project", await normalizeRootPath(context.projectGitPath.trim()));
	}

	const workspaceRoot = await resolveWorkspaceRoot(context.cwd);
	if (workspaceRoot) {
		addRootIfDistinct(roots, "workspace", workspaceRoot);
	}

	return roots;
}

export function getSkillContextCacheKey(context: SkillContext): string {
	const project = context.projectGitPath?.trim() ? resolve(context.projectGitPath.trim()) : "";
	const cwd = context.cwd?.trim() ? resolve(context.cwd.trim()) : "";
	return `project:${project}|cwd:${cwd}`;
}

function getSkillRootCacheKey(roots: SkillRootInfo[]): string {
	return roots.map((root) => `${root.rootKind}:${root.normalizedRootPath}`).join("|");
}

function truncateDescription(description: string): string {
	return description.length > MAX_SKILL_DESCRIPTION_CHARS
		? `${description.slice(0, MAX_SKILL_DESCRIPTION_CHARS)}…`
		: description;
}

function toSkillSummary(skill: SkillInfo, root: SkillRootInfo): SkillSummaryInfo {
	return {
		name: skill.name,
		description: truncateDescription(skill.description),
		location: skill.location,
		files: skill.files.slice(0, 20),
		disabled: skill.disabled,
		source: root.rootKind,
		rootKind: root.rootKind,
		normalizedRootPath: root.normalizedRootPath,
		...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
		...(skill.displayName ? { displayName: skill.displayName } : {}),
		...(skill.defaultPrompt ? { defaultPrompt: skill.defaultPrompt } : {}),
		...(typeof skill.allowImplicitInvocation === "boolean"
			? { allowImplicitInvocation: skill.allowImplicitInvocation }
			: {}),
	};
}

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

function asSummaryArray(value: unknown): SkillSummaryInfo[] | null {
	const raw = typeof value === "string" ? safeJsonParse(value) : value;
	if (!Array.isArray(raw)) return null;
	return raw
		.filter((item): item is SkillSummaryInfo => {
			return (
				item != null &&
				typeof item === "object" &&
				typeof (item as SkillSummaryInfo).name === "string" &&
				typeof (item as SkillSummaryInfo).description === "string" &&
				typeof (item as SkillSummaryInfo).location === "string" &&
				Array.isArray((item as SkillSummaryInfo).files)
			);
		})
		.slice(0, MAX_SKILLS_PER_ROOT);
}

function asSignatureArray(value: unknown): SkillSignatureEntry[] | null {
	const raw = typeof value === "string" ? safeJsonParse(value) : value;
	if (!Array.isArray(raw)) return null;
	return raw
		.filter((item): item is SkillSignatureEntry => {
			return (
				item != null &&
				typeof item === "object" &&
				typeof (item as SkillSignatureEntry).location === "string" &&
				typeof (item as SkillSignatureEntry).disabled === "boolean" &&
				typeof (item as SkillSignatureEntry).mtimeMs === "number"
			);
		})
		.slice(0, MAX_SKILLS_PER_ROOT);
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function signaturesEqual(a: SkillSignatureEntry[] | null, b: SkillSignatureEntry[]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].location !== b[i].location) return false;
		if (a[i].disabled !== b[i].disabled) return false;
		if (a[i].mtimeMs !== b[i].mtimeMs) return false;
	}
	return true;
}

async function walkForSkillFiles(
	dir: string,
	entries: DiscoveredSkillFile[],
	depth: number,
	state: { truncated: boolean },
	searchDirRank: number,
): Promise<void> {
	if (depth > MAX_WALK_DEPTH || state.truncated) return;
	let dirEntries: import("node:fs").Dirent[];
	try {
		dirEntries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	// Sorted for the same reason as `walkForSkills`: the two walkers must agree on
	// which copy of a same-named skill wins. The final `entries.sort` below orders the
	// whole list, but it cannot fix the TRUNCATION boundary — with an unordered
	// readdir, hitting the entry cap would keep an arbitrary subset.
	dirEntries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of dirEntries) {
		if (state.truncated) return;
		if ((await resolveEntryType(dir, entry)) !== "dir") continue;
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

		const childDir = join(dir, entry.name);
		const skillFile = join(childDir, "SKILL.md");
		const skillMtime = await getMtimeMs(skillFile);
		if (skillMtime !== null) {
			entries.push({
				location: skillFile,
				skillDir: childDir,
				disabled: false,
				mtimeMs: skillMtime,
				searchDirRank,
			});
		} else {
			const disabledFile = join(childDir, "SKILL.md.disabled");
			const disabledMtime = await getMtimeMs(disabledFile);
			if (disabledMtime !== null) {
				entries.push({
					location: disabledFile,
					skillDir: childDir,
					disabled: true,
					mtimeMs: disabledMtime,
					searchDirRank,
				});
			} else {
				await walkForSkillFiles(childDir, entries, depth + 1, state, searchDirRank);
			}
		}

		if (entries.length >= MAX_SKILLS_PER_ROOT) {
			state.truncated = true;
			return;
		}
	}
}

async function discoverSkillFiles(rootPath: string): Promise<DiscoveryResult> {
	const entries: DiscoveredSkillFile[] = [];
	const state = { truncated: false };
	const searchDirs = getSkillSearchDirs(rootPath);
	for (let rank = 0; rank < searchDirs.length; rank++) {
		await walkForSkillFiles(searchDirs[rank], entries, 0, state, rank);
		if (state.truncated) break;
	}
	// Stable order for the cache signature. Sorting by absolute path alone would
	// silently reorder name collisions relative to `getSkillSearchDirs` (".agents"
	// sorts before ".narrafork", but ranks after it), which is what let a disabled
	// copy in a higher-priority dir be shadowed by an enabled lower-priority one.
	entries.sort((a, b) => a.searchDirRank - b.searchDirRank || a.location.localeCompare(b.location));
	return { entries, truncated: state.truncated };
}

async function getRootCache(root: SkillRootInfo) {
	const rows = await readQuery(
		db
			.select()
			.from(skillDirectoryCaches)
			.where(
				and(
					eq(skillDirectoryCaches.rootKind, root.rootKind),
					eq(skillDirectoryCaches.normalizedRootPath, root.normalizedRootPath),
				),
			)
			.limit(1),
		{ executionPolicy: "worker-required" },
	);
	return rows[0] ?? null;
}

function nextExpiry(nowMs: number): string {
	return new Date(nowMs + SKILL_DIRECTORY_CACHE_MAX_AGE_MS).toISOString();
}

async function touchRootCache(id: string, nowIso: string, expiresAt: string): Promise<void> {
	await db
		.update(skillDirectoryCaches)
		.set({ lastAccessedAt: nowIso, expiresAt })
		.where(eq(skillDirectoryCaches.id, id));
}

async function upsertRootCache(
	root: SkillRootInfo,
	skills: SkillSummaryInfo[],
	signature: SkillSignatureEntry[],
	nowIso: string,
	expiresAt: string,
	cacheId?: string,
): Promise<void> {
	const values = {
		rootKind: root.rootKind,
		normalizedRootPath: root.normalizedRootPath,
		skillsJson: skills,
		signatureJson: signature,
		scannedAt: nowIso,
		lastAccessedAt: nowIso,
		expiresAt,
	};
	if (cacheId) {
		await db.update(skillDirectoryCaches).set(values).where(eq(skillDirectoryCaches.id, cacheId));
		return;
	}

	try {
		await db.insert(skillDirectoryCaches).values({ id: generateId(), ...values });
	} catch {
		const existing = await getRootCache(root);
		if (!existing) throw new AppError("Failed to write skill cache", 500);
		await db
			.update(skillDirectoryCaches)
			.set(values)
			.where(eq(skillDirectoryCaches.id, existing.id));
	}
}

async function deleteRootCache(root: SkillRootInfo): Promise<void> {
	await db
		.delete(skillDirectoryCaches)
		.where(
			and(
				eq(skillDirectoryCaches.rootKind, root.rootKind),
				eq(skillDirectoryCaches.normalizedRootPath, root.normalizedRootPath),
			),
		);
}

async function invalidateRootCache(rootKind: SkillSource, rootPath: string): Promise<void> {
	try {
		const normalizedRootPath = await normalizeRootPath(rootPath);
		await db
			.delete(skillDirectoryCaches)
			.where(
				and(
					eq(skillDirectoryCaches.rootKind, rootKind),
					eq(skillDirectoryCaches.normalizedRootPath, normalizedRootPath),
				),
			);
	} catch (err) {
		logger.debug("Failed to invalidate skill directory cache", {
			rootKind,
			rootPath,
			error: String(err),
		});
	}
}

async function loadRootSkillSummaries(
	root: SkillRootInfo,
	options: { forceRefresh?: boolean } = {},
): Promise<{ skills: SkillSummaryInfo[]; meta: SkillRootCacheMeta }> {
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const expiresAt = nextExpiry(nowMs);
	const existing = await getRootCache(root);
	const existingSkills = existing ? asSummaryArray(existing.skillsJson) : null;
	const scannedAtMs = existing?.scannedAt ? Date.parse(existing.scannedAt) : Number.NaN;
	const fresh = Number.isFinite(scannedAtMs) && nowMs - scannedAtMs < SKILL_SUMMARY_REFRESH_TTL_MS;

	if (!options.forceRefresh && existing && existingSkills && fresh) {
		await touchRootCache(existing.id, nowIso, expiresAt);
		return {
			skills: existingSkills,
			meta: {
				...root,
				scannedAt: existing.scannedAt,
				lastAccessedAt: nowIso,
				expiresAt,
				cacheHit: true,
				refreshed: false,
				cacheable: true,
				skillCount: existingSkills.length,
			},
		};
	}

	const discovery = await discoverSkillFiles(root.rootPath);
	const signature = discovery.entries.map(({ location, disabled, mtimeMs }) => ({
		location,
		disabled,
		mtimeMs,
	}));
	const signatureCacheable =
		!discovery.truncated && jsonByteLength(signature) <= MAX_SIGNATURE_JSON_BYTES;

	const existingSignature = existing ? asSignatureArray(existing.signatureJson) : null;
	if (
		signatureCacheable &&
		existing &&
		existingSkills &&
		signaturesEqual(existingSignature, signature)
	) {
		await db
			.update(skillDirectoryCaches)
			.set({
				signatureJson: signature,
				scannedAt: nowIso,
				lastAccessedAt: nowIso,
				expiresAt,
			})
			.where(eq(skillDirectoryCaches.id, existing.id));
		return {
			skills: existingSkills,
			meta: {
				...root,
				scannedAt: nowIso,
				lastAccessedAt: nowIso,
				expiresAt,
				cacheHit: false,
				refreshed: true,
				cacheable: true,
				skillCount: existingSkills.length,
			},
		};
	}

	const skills: SkillSummaryInfo[] = [];
	for (const entry of discovery.entries) {
		const skill = await loadSkillCached(entry.location, entry.skillDir, entry.disabled);
		if (skill) skills.push(toSkillSummary(skill, root));
	}

	const cacheable =
		signatureCacheable &&
		skills.length <= MAX_SKILLS_PER_ROOT &&
		jsonByteLength(skills) <= MAX_SKILLS_JSON_BYTES;
	if (cacheable) {
		await upsertRootCache(root, skills, signature, nowIso, expiresAt, existing?.id);
	} else if (existing) {
		await deleteRootCache(root);
	}

	return {
		skills,
		meta: {
			...root,
			scannedAt: nowIso,
			lastAccessedAt: nowIso,
			expiresAt: cacheable ? expiresAt : null,
			cacheHit: false,
			refreshed: true,
			cacheable,
			skillCount: skills.length,
		},
	};
}

/** Apply project intent after merging cached filesystem roots, also on explicit loads. */
async function applyProjectRoutineSkillOverrides<T extends { name: string; location: string }>(
	skills: T[],
	projectGitPath: string | null | undefined,
): Promise<T[]> {
	if (!projectGitPath) return skills;
	const project = await readQuery(
		db.query.projects.findFirst({
			where: eq(projects.gitPath, projectGitPath),
			columns: { chapterSettings: true },
		}),
		{ executionPolicy: "worker-required" },
	);
	let config: unknown = project?.chapterSettings;
	if (typeof config === "string") {
		try {
			config = JSON.parse(config);
		} catch {
			return skills;
		}
	}
	const disabled = (config as { routines?: { disabledRoutines?: unknown } } | null)?.routines
		?.disabledRoutines;
	if (!Array.isArray(disabled) || disabled.length === 0) return skills;
	const managed = new Map(
		getBuiltinSkillRoutines()
			.filter((routine) => disabled.includes(routine.id))
			.map((routine) => [`_routine-${routine.id}`, routine.skill?.name]),
	);
	return skills.filter((skill) => managed.get(basename(dirname(skill.location))) !== skill.name);
}

export async function loadSkillSummariesForContext(
	context: SkillContext,
	options: { forceRefresh?: boolean } = {},
): Promise<SkillContextLoadResult> {
	const roots = await resolveSkillRootsForContext(context);
	const scopeKey = getSkillRootCacheKey(roots) || getSkillContextCacheKey(context);
	const rootResults = await Promise.all(
		roots.map((root) => loadRootSkillSummaries(root, { forceRefresh: options.forceRefresh })),
	);

	const skillMap = new Map<string, SkillSummaryInfo>();
	for (const result of rootResults) {
		for (const skill of result.skills) {
			skillMap.set(skill.name, skill);
		}
	}

	return {
		skills: await applyProjectRoutineSkillOverrides(
			Array.from(skillMap.values()),
			context.projectGitPath,
		),
		roots: rootResults.map((result) => result.meta),
		scopeKey,
	};
}

export async function loadSkillByNameForContext(
	context: SkillContext,
	name: string,
): Promise<SkillInfo | null> {
	let result = await loadSkillSummariesForContext(context);
	let found = result.skills.find((skill) => !skill.disabled && skill.name === name);

	// If a user explicitly asks for a skill that is missing from a still-fresh cache,
	// force one signature pass before returning not found.
	if (!found) {
		result = await loadSkillSummariesForContext(context, { forceRefresh: true });
		found = result.skills.find((skill) => !skill.disabled && skill.name === name);
	}
	if (!found) return null;

	const skillDir = dirname(found.location);
	const loaded = await loadSkillCached(found.location, skillDir, found.disabled ?? false);
	if (!loaded) return null;
	return { ...loaded, source: found.source, rootKind: found.rootKind };
}

export async function resolveSkillContextForNarrator(narratorId: string): Promise<SkillContext> {
	const narrator = await readQuery(
		db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { id: true, contextProjectId: true, cwd: true },
		}),
		{ executionPolicy: "worker-required" },
	);
	if (!narrator) throw new NotFoundError("Narrator", narratorId);

	// The same project resolution as ACL/traits: the explicit project, else the project the
	// session's directory was indexed into.
	const projectId = await resolveNarratorProjectId(narrator);
	const project = projectId
		? await readQuery(
				db.query.projects.findFirst({
					where: eq(projects.id, projectId),
					columns: { gitPath: true },
				}),
				{ executionPolicy: "worker-required" },
			)
		: null;
	const projectGitPath = project?.gitPath ?? null;
	return {
		projectGitPath,
		cwd: narrator.cwd || projectGitPath || homedir(),
	};
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

	return applyProjectRoutineSkillOverrides(Array.from(skillMap.values()), projectGitPath);
}

/** Load a single project-level skill by name (does not include global skills). */
export async function loadProjectSkillByName(
	projectGitPath: string,
	name: string,
): Promise<SkillInfo | null> {
	const skills = await loadProjectSkills(projectGitPath);
	return skills.find((s) => s.name === name) ?? null;
}

/**
 * Load global (user-level) skills: the home-rooted directories plus the
 * `basePath`-independent ones (`$NARRAFORK_HOME/skills`, `$CODEX_HOME/skills`).
 * See {@link getSkillSearchDirs}.
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
 *   < ~/.codex/skills < $NARRAFORK_HOME/skills < $CODEX_HOME/skills
 *   < <project>/.narrafork/skills < ... < <project>/.codex/skills
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

	return applyProjectRoutineSkillOverrides(Array.from(skillMap.values()), projectGitPath);
}

/**
 * Resolve a legacy single skill scan root for a given directory.
 * For project-bound narrators, this is the project gitPath.
 * For standalone narrators, prefer the git root when present; otherwise use cwd itself.
 */
export async function resolveSkillRoot(
	projectGitPath: string | null | undefined,
	cwd: string,
): Promise<string | null> {
	if (projectGitPath) return projectGitPath;
	const normalizedCwd = await normalizeRootPath(cwd);
	return (await findGitRoot(normalizedCwd)) ?? normalizedCwd;
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

export async function cleanupSkillDirectoryCaches(): Promise<{ expired: number; lru: number }> {
	const nowIso = new Date().toISOString();
	const expiredRows = await readQuery(
		db
			.select({ id: skillDirectoryCaches.id })
			.from(skillDirectoryCaches)
			.where(lt(skillDirectoryCaches.expiresAt, nowIso)),
		{ executionPolicy: "worker-required" },
	);
	if (expiredRows.length > 0) {
		// The expiry is re-checked by the delete: an entry renewed after the read stays.
		await db.delete(skillDirectoryCaches).where(
			and(
				inArray(
					skillDirectoryCaches.id,
					expiredRows.map((row) => row.id),
				),
				lt(skillDirectoryCaches.expiresAt, nowIso),
			),
		);
	}

	const [{ value: total = 0 } = { value: 0 }] = await readQuery(
		db.select({ value: count() }).from(skillDirectoryCaches),
		{ executionPolicy: "worker-required" },
	);
	const overLimit = Math.max(0, total - MAX_SKILL_CACHE_ROOTS);
	let lru = 0;
	if (overLimit > 0) {
		const rows = await readQuery(
			db
				.select({ id: skillDirectoryCaches.id })
				.from(skillDirectoryCaches)
				.orderBy(asc(skillDirectoryCaches.lastAccessedAt))
				.limit(overLimit),
			{ executionPolicy: "worker-required" },
		);
		if (rows.length > 0) {
			await db.delete(skillDirectoryCaches).where(
				inArray(
					skillDirectoryCaches.id,
					rows.map((row) => row.id),
				),
			);
			lru = rows.length;
		}
	}

	return { expired: expiredRows.length, lru };
}

export function startSkillCacheCleanupTimer(): ReturnType<typeof setInterval> {
	return hotTimer(SKILL_CACHE_TIMER_KEY, () =>
		setInterval(() => {
			cleanupSkillDirectoryCaches().catch((err) => {
				logger.warn("Skill directory cache cleanup failed", { error: String(err) });
			});
		}, SKILL_CACHE_CLEANUP_INTERVAL_MS),
	);
}

// === Global skill CRUD (writes to $NARRAFORK_HOME/skills/, default ~/.narrafork/skills/) ===

/**
 * Resolved per call rather than at module load so a `NARRAFORK_HOME` set after this
 * module is imported (test preloads, embedded runtimes) still lands in the same
 * directory {@link getSkillSearchDirs} reads back.
 */
function getGlobalSkillsDir(): string {
	return join(getNarraforkHome(), "skills");
}

const projectSkillsRelativeDir = join(".narrafork", "skills");

async function assertPathInsideProject(projectGitPath: string, targetPath: string): Promise<void> {
	const projectRoot = resolve(projectGitPath);
	const resolvedTarget = resolve(targetPath);
	if (!isInsidePath(projectRoot, resolvedTarget)) {
		throw new ValidationError("Skill path must be inside the project repository");
	}

	try {
		const realProjectRoot = await realpath(projectGitPath);
		const realTarget = await realpath(targetPath);
		if (!isInsidePath(realProjectRoot, realTarget)) {
			throw new ValidationError("Skill path must be inside the project repository");
		}
	} catch (err) {
		if (err instanceof ValidationError) throw err;
		// Missing targets are checked lexically above before creation.
	}
}

async function assertNoSymlinkAncestor(projectGitPath: string, targetPath: string): Promise<void> {
	const projectRoot = resolve(projectGitPath);
	const resolvedTarget = resolve(targetPath);
	if (!isInsidePath(projectRoot, resolvedTarget)) {
		throw new ValidationError("Skill path must be inside the project repository");
	}

	const rel = relative(projectRoot, resolvedTarget);
	if (!rel || rel.startsWith("..")) return;

	let current = projectRoot;
	for (const part of rel.split(/[\\/]+/)) {
		current = join(current, part);
		try {
			const s = await lstat(current);
			if (s.isSymbolicLink()) {
				throw new ValidationError("Project skill paths cannot contain symbolic links");
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			// The remaining path does not exist yet, so it cannot already be a symlink.
			return;
		}
	}
}

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

async function createSkillDirectoryExclusive(skillDir: string): Promise<void> {
	try {
		await mkdir(skillDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new ValidationError(`Skill directory already exists: ${basename(skillDir)}`);
		}
		throw error;
	}
}

export const SKILL_IMPORT_TIMEOUT_MS = 45_000;
const importCapacity = hotSafe("narrafork.skill-import-capacity.v1", () => ({ active: 0 }));

async function withRemoteSkillTask<T>(
	parentSignal: AbortSignal | undefined,
	body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	parentSignal?.throwIfAborted();
	if (importCapacity.active >= 2) {
		throw new AppError(
			"Two skill link requests are already running. Try again shortly.",
			429,
			"SKILL_IMPORT_BUSY",
		);
	}
	importCapacity.active++;
	const startedAt = performance.now();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), SKILL_IMPORT_TIMEOUT_MS);
	const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;
	let succeeded = false;
	try {
		const result = await body(signal);
		succeeded = true;
		return result;
	} catch (error) {
		// Recovery evidence is more important than an overlapping timeout/cancellation.
		if (error instanceof AppError && error.code === "SKILL_SYNC_RECOVERY_REQUIRED") throw error;
		if (deadline.signal.aborted)
			throw new AppError(
				"Skill import or sync timed out. Please try again.",
				408,
				"SKILL_IMPORT_TIMEOUT",
			);
		if (parentSignal?.aborted)
			throw new AppError("Skill import or sync was cancelled.", 408, "SKILL_IMPORT_CANCELLED");
		throw error;
	} finally {
		clearTimeout(timer);
		importCapacity.active--;
		const durationMs = Math.round(performance.now() - startedAt);
		if (durationMs >= 5_000)
			logger.warn("Slow GitHub skill import or sync", { durationMs, succeeded });
	}
}

function parseDownloadedSkill(files: DownloadedSkillFile[]): Omit<SkillInfo, "files"> {
	const entry = files.find((file) => file.path === "SKILL.md");
	if (!entry || entry.bytes.byteLength > 200_000) {
		throw new ValidationError("The skill directory must contain SKILL.md (at most 200 KB)");
	}
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
	} catch {
		throw new ValidationError("SKILL.md must be UTF-8 text");
	}
	const metadata = parseSkillFile(raw, "GitHub SKILL.md");
	if (!metadata || metadata.name.length > 100 || metadata.description.length > 2_000) {
		throw new ValidationError(
			"SKILL.md requires YAML name (up to 100 characters) and description (up to 2000 characters)",
		);
	}
	return metadata;
}

async function stageDownloadedSkill(
	staging: string,
	files: DownloadedSkillFile[],
	signal: AbortSignal,
	disabled = false,
): Promise<SkillInfo> {
	for (const file of files) {
		signal.throwIfAborted();
		validateImportedSkillPath(file.path);
		if (file.path === "SKILL.md.disabled")
			throw new ValidationError("The link contains a reserved skill file");
		if (file.path === "agents/openai.yaml") {
			if (file.bytes.byteLength > 200_000)
				throw new ValidationError("Skill sidecar exceeds 200 KB");
			parseSkillYaml(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
		}
		const path = disabled && file.path === "SKILL.md" ? "SKILL.md.disabled" : file.path;
		const destination = join(staging, ...path.split("/"));
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, file.bytes, {
			flag: "wx",
			mode: file.executable ? 0o755 : 0o644,
			signal,
		});
	}
	const prepared = await loadSkillCached(
		join(staging, disabled ? "SKILL.md.disabled" : "SKILL.md"),
		staging,
		disabled,
	);
	if (!prepared) throw new ValidationError("The link must contain a valid SKILL.md");
	return prepared;
}

function forgetSkillDirectory(skillDir: string): void {
	skillCache.delete(join(skillDir, "SKILL.md"));
	skillCache.delete(join(skillDir, "SKILL.md.disabled"));
}

async function invalidateInstalledSkills(projectGitPath: string | null): Promise<void> {
	try {
		await invalidateRootCache(projectGitPath ? "project" : "global", projectGitPath ?? homedir());
		// A dotfiles project may share the global skills directory.
		if (projectGitPath && canonical(projectGitPath) === getHomeDir())
			await invalidateRootCache("global", homedir());
	} catch (error) {
		logger.warn("Skill installed but summary cache invalidation failed", { error: String(error) });
	}
}

export async function describeSkillManagement(
	projectGitPath: string | null,
	skill: SkillInfo,
): Promise<SkillInfo> {
	const root = projectGitPath ?? getNarraforkHome();
	const skillsDir = projectGitPath
		? join(projectGitPath, projectSkillsRelativeDir)
		: getGlobalSkillsDir();
	let canUpdateFromUrl = false;
	try {
		const dir = dirname(skill.location);
		const rel = relative(resolve(skillsDir), resolve(dir));
		if (rel && !rel.startsWith(".") && isInsidePath(resolve(skillsDir), resolve(dir))) {
			await assertNoSymlinkAncestor(root, skill.location);
			const info = await lstat(skill.location);
			canUpdateFromUrl = info.isFile() && !info.isSymbolicLink();
		}
	} catch {
		// Scanning external directories remains supported, but never makes them writable by sync.
	}
	return { ...skill, canUpdateFromUrl };
}
async function importSkillFromUrl(
	projectGitPath: string | null,
	url: string,
	parentSignal?: AbortSignal,
): Promise<SkillInfo> {
	return withRemoteSkillTask(parentSignal, async (signal) => {
		const { files } = await downloadSkillLink(url, signal);
		const metadata = parseDownloadedSkill(files);
		const dirName = sanitizeSkillDirName(metadata.name);
		if (!dirName || SKIP_DIRS.has(dirName))
			throw new ValidationError("Invalid skill directory name");
		validateImportedSkillPath(dirName);
		const root = projectGitPath ?? getNarraforkHome();
		const skillsDir = projectGitPath
			? join(projectGitPath, projectSkillsRelativeDir)
			: getGlobalSkillsDir();
		return withSkillCreation(
			skillsDir,
			async () => {
				signal.throwIfAborted();
				const existing = projectGitPath
					? await loadProjectSkills(projectGitPath)
					: await loadGlobalSkills();
				if (existing.some((s) => s.name.toLowerCase() === metadata.name.toLowerCase()))
					throw new ValidationError(`Skill already exists: ${metadata.name}`);
				const skillDir = join(skillsDir, dirName);
				await assertNoSymlinkAncestor(root, skillDir);
				await mkdir(skillsDir, { recursive: true });
				const assertAbsent = async () => {
					try {
						await lstat(skillDir);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
						throw error;
					}
					throw new ValidationError(`Skill directory already exists: ${dirName}`);
				};
				await assertAbsent();
				const staging = await mkdtemp(join(skillsDir, ".import-"));
				try {
					const prepared = await stageDownloadedSkill(staging, files, signal);
					await assertNoSymlinkAncestor(root, skillDir);
					await assertAbsent();
					signal.throwIfAborted();
					await rename(staging, skillDir);
					forgetSkillDirectory(skillDir);
					await invalidateInstalledSkills(projectGitPath);
					return { ...prepared, location: join(skillDir, "SKILL.md"), canUpdateFromUrl: true };
				} finally {
					forgetSkillDirectory(staging);
					await rm(staging, { recursive: true, force: true }).catch((error) =>
						logger.warn("Skill staging cleanup failed", { staging, error: String(error) }),
					);
				}
			},
			signal,
		);
	});
}

async function findManagedSkill(projectGitPath: string | null, name: string): Promise<SkillInfo> {
	const skills = projectGitPath
		? await loadProjectSkills(projectGitPath)
		: await loadGlobalSkills();
	const found = skills.find((skill) => skill.name === name);
	if (!found) throw new NotFoundError("Skill", name);
	const managed = await describeSkillManagement(projectGitPath, found);
	if (!managed.canUpdateFromUrl)
		throw new ValidationError(
			"Only skills in this scope's NarraFork skills directory can be updated from a link",
			"SKILL_SYNC_UNSUPPORTED",
		);
	return managed;
}

async function updateSkillFromUrl(
	projectGitPath: string | null,
	name: string,
	url: string,
	parentSignal?: AbortSignal,
): Promise<SkillInfo> {
	const root = projectGitPath ?? getNarraforkHome();
	const skillsDir = projectGitPath
		? join(projectGitPath, projectSkillsRelativeDir)
		: getGlobalSkillsDir();
	return withRemoteSkillTask(parentSignal, async (signal) => {
		const wholeDirectory = isGitHubSkillDirectoryUrl(url);
		// Validate the target before any network work. Capture a bounded identity/content
		// snapshot so a local edit during download cannot be silently overwritten.
		const initial = await withSkillCreation(
			skillsDir,
			async () => {
				const skill = await findManagedSkill(projectGitPath, name);
				const directory = dirname(skill.location);
				const snapshot = wholeDirectory
					? await snapshotSkillDirectory(directory, signal)
					: await snapshotSkillDefinition(skill.location, signal);
				return { skill, directory, snapshot };
			},
			signal,
		);
		const downloaded = await downloadSkillLink(url, signal);
		const metadata = parseDownloadedSkill(downloaded.files);
		if (metadata.name !== name)
			throw new ValidationError(
				"The linked skill name must match the existing skill",
				"SKILL_UPDATE_NAME_MISMATCH",
			);
		await assertNoSymlinkAncestor(root, initial.directory);
		const staging = await mkdtemp(join(skillsDir, ".update-"));
		try {
			const prepared = await stageDownloadedSkill(
				staging,
				downloaded.files,
				signal,
				initial.skill.disabled ?? false,
			);
			return await withSkillCreation(
				skillsDir,
				async () => {
					const current = await findManagedSkill(projectGitPath, name);
					await assertNoSymlinkAncestor(root, initial.directory);
					const now = wholeDirectory
						? await snapshotSkillDirectory(initial.directory, signal)
						: await snapshotSkillDefinition(current.location, signal);
					if (
						current.location !== initial.skill.location ||
						now.fingerprint !== initial.snapshot.fingerprint
					)
						throw new AppError(
							"The skill changed while downloading. Refresh and try again.",
							409,
							"SKILL_UPDATE_CONFLICT",
						);
					signal.throwIfAborted();
					if (downloaded.kind === "markdown") {
						// Atomic single-file replacement: preserve all companion files and disabled state.
						await rename(join(staging, basename(current.location)), current.location);
					} else {
						const result = await replaceSkillDirectory(staging, initial.directory, signal);
						if (result.cleanupWarning)
							logger.warn("Skill updated but backup cleanup failed", {
								warning: result.cleanupWarning,
							});
					}
					forgetSkillDirectory(initial.directory);
					await invalidateInstalledSkills(projectGitPath);
					if (downloaded.kind === "markdown") {
						const updated = await loadSkillCached(
							current.location,
							initial.directory,
							current.disabled ?? false,
						);
						if (updated) return { ...updated, canUpdateFromUrl: true };
					}
					return { ...prepared, location: current.location, canUpdateFromUrl: true };
				},
				signal,
			);
		} finally {
			forgetSkillDirectory(staging);
			await rm(staging, { recursive: true, force: true }).catch((error) =>
				logger.warn("Skill staging cleanup failed", { staging, error: String(error) }),
			);
		}
	});
}

export function updateGlobalSkillFromUrl(
	name: string,
	url: string,
	signal?: AbortSignal,
): Promise<SkillInfo> {
	return updateSkillFromUrl(null, name, url, signal);
}

export function updateProjectSkillFromUrl(
	projectGitPath: string,
	name: string,
	url: string,
	signal?: AbortSignal,
): Promise<SkillInfo> {
	return updateSkillFromUrl(projectGitPath, name, url, signal);
}
export function importGlobalSkill(url: string, signal?: AbortSignal): Promise<SkillInfo> {
	return importSkillFromUrl(null, url, signal);
}

export function importProjectSkill(
	projectGitPath: string,
	url: string,
	signal?: AbortSignal,
): Promise<SkillInfo> {
	return importSkillFromUrl(projectGitPath, url, signal);
}
export async function createGlobalSkill(
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	return withSkillCreation(getGlobalSkillsDir(), async () => {
		const dirName = sanitizeSkillDirName(name);
		if (!dirName) throw new ValidationError("Invalid skill name");
		const skillDir = join(getGlobalSkillsDir(), dirName);
		const skillFile = join(skillDir, "SKILL.md");
		await mkdir(dirname(skillDir), { recursive: true });
		await createSkillDirectoryExclusive(skillDir);
		await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");
		skillCache.delete(skillFile);
		await invalidateRootCache("global", homedir());
		const skill = await loadSkillCached(skillFile, skillDir);
		if (!skill) throw new AppError("Failed to create skill — parse error", 500);
		return skill;
	});
}

async function withSkillMutation<T>(
	projectGitPath: string | null,
	name: string,
	body: (skill: SkillInfo) => Promise<T>,
): Promise<T> {
	const load = () => (projectGitPath ? loadProjectSkills(projectGitPath) : loadGlobalSkills());
	const initial = (await load()).find((skill) => skill.name === name);
	if (!initial) throw new NotFoundError("Skill", name);
	const directory = dirname(initial.location);
	// Both scopes scan several roots; select the actual root to share locks even
	// when a custom global home points inside a project's .claude/skills directory.
	const candidates = getSkillSearchDirs(projectGitPath ?? homedir())
		.filter((root) => isInsidePath(resolve(root), resolve(directory)))
		.sort((a, b) => b.length - a.length);
	const skillsRoot = candidates[0] ?? dirname(directory);
	return withSkillCreation(skillsRoot, async () => {
		await assertNoSymlinkAncestor(skillsRoot, initial.location);
		const current = (await load()).find((skill) => skill.name === name);
		if (!current || current.location !== initial.location)
			throw new AppError("The skill changed. Refresh and try again.", 409, "SKILL_UPDATE_CONFLICT");
		return body(current);
	});
}
export async function updateGlobalSkill(
	currentName: string,
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	return withSkillMutation(null, currentName, async (existing) => {
		const skillFile = existing.location;
		const skillDir = dirname(skillFile);
		await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");
		skillCache.delete(skillFile);
		await invalidateRootCache("global", homedir());
		const updated = await loadSkillCached(skillFile, skillDir, existing.disabled ?? false);
		if (!updated) throw new AppError("Failed to update skill — parse error", 500);
		return updated;
	});
}

export async function deleteGlobalSkill(name: string): Promise<void> {
	return withSkillMutation(null, name, async (existing) => {
		forgetSkillDirectory(dirname(existing.location));
		await rm(dirname(existing.location), { recursive: true, force: true });
		await invalidateRootCache("global", homedir());
	});
}

export async function toggleGlobalSkill(name: string, enabled: boolean): Promise<SkillInfo> {
	return withSkillMutation(null, name, async (existing) => {
		if (enabled === !existing.disabled) return existing;
		const skillDir = dirname(existing.location);
		const target = join(skillDir, enabled ? "SKILL.md" : "SKILL.md.disabled");
		await rename(existing.location, target);
		forgetSkillDirectory(skillDir);
		await invalidateRootCache("global", homedir());
		const skill = await loadSkillCached(target, skillDir, !enabled);
		if (!skill) throw new AppError("Failed to toggle skill", 500);
		return skill;
	});
}

// === Project skill CRUD (writes to <project>/.narrafork/skills/) ===

export async function createProjectSkill(
	projectGitPath: string,
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	return withSkillCreation(join(projectGitPath, projectSkillsRelativeDir), async () => {
		const dirName = sanitizeSkillDirName(name);
		if (!dirName) throw new ValidationError("Invalid skill name");
		const existingByName = await loadProjectSkillByName(projectGitPath, name);
		if (existingByName) throw new ValidationError(`Project skill already exists: ${name}`);
		const skillDir = join(projectGitPath, projectSkillsRelativeDir, dirName);
		const skillFile = join(skillDir, "SKILL.md");
		await assertNoSymlinkAncestor(projectGitPath, skillDir);
		await mkdir(dirname(skillDir), { recursive: true });
		await createSkillDirectoryExclusive(skillDir);
		await assertPathInsideProject(projectGitPath, skillDir);
		await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");
		skillCache.delete(skillFile);
		await invalidateRootCache("project", projectGitPath);
		const skill = await loadSkillCached(skillFile, skillDir);
		if (!skill) throw new AppError("Failed to create project skill — parse error", 500);
		return skill;
	});
}

export async function updateProjectSkill(
	projectGitPath: string,
	currentName: string,
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	return withSkillMutation(projectGitPath, currentName, async (existing) => {
		const duplicate =
			name === currentName ? null : await loadProjectSkillByName(projectGitPath, name);
		if (duplicate && duplicate.location !== existing.location)
			throw new ValidationError(`Project skill already exists: ${name}`);
		const skillFile = existing.location;
		const skillDir = dirname(skillFile);
		await assertPathInsideProject(projectGitPath, skillFile);
		await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");
		skillCache.delete(skillFile);
		await invalidateRootCache("project", projectGitPath);
		const updated = await loadSkillCached(skillFile, skillDir, existing.disabled ?? false);
		if (!updated) throw new AppError("Failed to update project skill — parse error", 500);
		return updated;
	});
}

export async function deleteProjectSkill(projectGitPath: string, name: string): Promise<void> {
	return withSkillMutation(projectGitPath, name, async (existing) => {
		const skillDir = dirname(existing.location);
		await assertPathInsideProject(projectGitPath, existing.location);
		forgetSkillDirectory(skillDir);
		await rm(skillDir, { recursive: true, force: true });
		await invalidateRootCache("project", projectGitPath);
	});
}

export const skillService = {
	loadProjectSkills,
	loadProjectSkillByName,
	loadGlobalSkills,
	loadAllSkills,
	loadSkillByName,
	loadSkillSummariesForContext,
	loadSkillByNameForContext,
	resolveSkillRootsForContext,
	resolveSkillContextForNarrator,
	readSkillFile,
	cleanupSkillDirectoryCaches,
	startSkillCacheCleanupTimer,
	createGlobalSkill,
	importGlobalSkill,
	importProjectSkill,
	updateGlobalSkillFromUrl,
	updateProjectSkillFromUrl,
	describeSkillManagement,
	updateGlobalSkill,
	deleteGlobalSkill,
	toggleGlobalSkill,
	createProjectSkill,
	updateProjectSkill,
	deleteProjectSkill,
};
