import {
	access,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
import matter from "gray-matter";
import { db } from "../db";
import { chapters, narrators, projects, skillDirectoryCaches } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { hotTimer } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isInsidePath } from "../lib/platform-path";
import { narraforkDir } from "../lib/settings";

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
	const raw = await readFile(skillFile, "utf-8");
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
			// Check for disabled skill (SKILL.md.disabled)
			const disabledFile = join(childDir, "SKILL.md.disabled");
			const disabledSkill = await loadSkillCached(disabledFile, childDir, true);
			if (disabledSkill) {
				skills.push(disabledSkill);
			} else {
				// No SKILL.md here — keep looking deeper
				await walkForSkills(childDir, skills, depth + 1);
			}
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
	const searchDirs = getSkillSearchDirs(basePath);

	for (const dir of searchDirs) {
		await walkForSkills(dir, skills, 0);
	}

	return skills;
}

let cachedHomeDir: string | null = null;
function getHomeDir(): string {
	if (cachedHomeDir === null) cachedHomeDir = resolve(homedir());
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

	// Support a custom CODEX_HOME (e.g. not `~/.codex`) when scanning the home root.
	if (resolve(basePath) === getHomeDir()) {
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
		const { data, content } = matter(raw);
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
		raw = await readFile(sidecarPath, "utf-8");
	} catch {
		return null; // no sidecar
	}

	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(raw);
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
): Promise<void> {
	if (depth > MAX_WALK_DEPTH || state.truncated) return;
	let dirEntries: import("node:fs").Dirent[];
	try {
		dirEntries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

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
				});
			} else {
				await walkForSkillFiles(childDir, entries, depth + 1, state);
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
	for (const dir of getSkillSearchDirs(rootPath)) {
		await walkForSkillFiles(dir, entries, 0, state);
		if (state.truncated) break;
	}
	entries.sort((a, b) => a.location.localeCompare(b.location));
	return { entries, truncated: state.truncated };
}

async function getRootCache(root: SkillRootInfo) {
	const rows = await db
		.select()
		.from(skillDirectoryCaches)
		.where(
			and(
				eq(skillDirectoryCaches.rootKind, root.rootKind),
				eq(skillDirectoryCaches.normalizedRootPath, root.normalizedRootPath),
			),
		)
		.limit(1);
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
		skills: Array.from(skillMap.values()),
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
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, cwd: true },
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);

	if (!narrator.chapterId) {
		return { projectGitPath: null, cwd: narrator.cwd || homedir() };
	}

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { projectId: true, worktreePath: true },
	});
	if (!chapter) return { projectGitPath: null, cwd: narrator.cwd || homedir() };

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, chapter.projectId),
		columns: { gitPath: true },
	});
	const projectGitPath = project?.gitPath ?? null;
	return {
		projectGitPath,
		cwd: narrator.cwd || chapter.worktreePath || projectGitPath || homedir(),
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

	return Array.from(skillMap.values());
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
	const expiredRows = await db
		.select({ id: skillDirectoryCaches.id })
		.from(skillDirectoryCaches)
		.where(lt(skillDirectoryCaches.expiresAt, nowIso));
	if (expiredRows.length > 0) {
		await db.delete(skillDirectoryCaches).where(
			inArray(
				skillDirectoryCaches.id,
				expiredRows.map((row) => row.id),
			),
		);
	}

	const [{ value: total = 0 } = { value: 0 }] = await db
		.select({ value: count() })
		.from(skillDirectoryCaches);
	const overLimit = Math.max(0, total - MAX_SKILL_CACHE_ROOTS);
	let lru = 0;
	if (overLimit > 0) {
		const rows = await db
			.select({ id: skillDirectoryCaches.id })
			.from(skillDirectoryCaches)
			.orderBy(asc(skillDirectoryCaches.lastAccessedAt))
			.limit(overLimit);
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

// === Global skill CRUD (writes to ~/.narrafork/skills/) ===

const globalSkillsDir = join(narraforkDir, "skills");
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
			if (err instanceof ValidationError) throw err;
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
	await invalidateRootCache("global", homedir());

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
	await invalidateRootCache("global", homedir());

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
	await invalidateRootCache("global", homedir());
}

export async function toggleGlobalSkill(name: string, enabled: boolean): Promise<SkillInfo> {
	const globals = await loadGlobalSkills();
	const existing = globals.find((s) => s.name === name);
	if (!existing) throw new NotFoundError("Global skill", name);

	const skillDir = dirname(existing.location);
	const enabledPath = join(skillDir, "SKILL.md");
	const disabledPath = join(skillDir, "SKILL.md.disabled");

	if (enabled && existing.disabled) {
		// Re-enable: SKILL.md.disabled → SKILL.md
		await rename(disabledPath, enabledPath);
		skillCache.delete(disabledPath);
		await invalidateRootCache("global", homedir());
		const skill = await loadSkillCached(enabledPath, skillDir, false);
		if (!skill) throw new AppError("Failed to toggle skill", 500);
		return skill;
	}
	if (!enabled && !existing.disabled) {
		// Disable: SKILL.md → SKILL.md.disabled
		await rename(enabledPath, disabledPath);
		skillCache.delete(enabledPath);
		await invalidateRootCache("global", homedir());
		const skill = await loadSkillCached(disabledPath, skillDir, true);
		if (!skill) throw new AppError("Failed to toggle skill", 500);
		return skill;
	}

	// Already in the desired state
	return existing;
}

// === Project skill CRUD (writes to <project>/.narrafork/skills/) ===

export async function createProjectSkill(
	projectGitPath: string,
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	const dirName = sanitizeSkillDirName(name);
	if (!dirName) throw new ValidationError("Invalid skill name");

	const existingByName = await loadProjectSkillByName(projectGitPath, name);
	if (existingByName) throw new ValidationError(`Project skill already exists: ${name}`);

	const skillDir = join(projectGitPath, projectSkillsRelativeDir, dirName);
	const skillFile = join(skillDir, "SKILL.md");

	await assertNoSymlinkAncestor(projectGitPath, skillDir);
	try {
		await access(skillDir);
		throw new ValidationError(`Skill directory already exists: ${dirName}`);
	} catch (err) {
		if (err instanceof ValidationError) throw err;
		// Directory doesn't exist — good
	}

	await mkdir(skillDir, { recursive: true });
	await assertPathInsideProject(projectGitPath, skillDir);
	await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");

	skillCache.delete(skillFile);
	await invalidateRootCache("project", projectGitPath);

	const skill = await loadSkillCached(skillFile, skillDir);
	if (!skill) throw new AppError("Failed to create project skill — parse error", 500);
	return skill;
}

export async function updateProjectSkill(
	projectGitPath: string,
	currentName: string,
	name: string,
	description: string,
	content: string,
): Promise<SkillInfo> {
	const existing = await loadProjectSkillByName(projectGitPath, currentName);
	if (!existing) throw new NotFoundError("Project skill", currentName);

	const duplicate =
		name === currentName ? null : await loadProjectSkillByName(projectGitPath, name);
	if (duplicate && duplicate.location !== existing.location) {
		throw new ValidationError(`Project skill already exists: ${name}`);
	}

	const skillFile = existing.location;
	const skillDir = dirname(skillFile);
	await assertPathInsideProject(projectGitPath, skillFile);

	await writeFile(skillFile, buildSkillMd(name, description, content), "utf-8");

	skillCache.delete(skillFile);
	await invalidateRootCache("project", projectGitPath);

	const updated = await loadSkillCached(skillFile, skillDir, existing.disabled ?? false);
	if (!updated) throw new AppError("Failed to update project skill — parse error", 500);
	return updated;
}

export async function deleteProjectSkill(projectGitPath: string, name: string): Promise<void> {
	const existing = await loadProjectSkillByName(projectGitPath, name);
	if (!existing) throw new NotFoundError("Project skill", name);

	const skillDir = dirname(existing.location);
	await assertPathInsideProject(projectGitPath, existing.location);
	skillCache.delete(existing.location);
	await rm(skillDir, { recursive: true, force: true });
	await invalidateRootCache("project", projectGitPath);
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
	updateGlobalSkill,
	deleteGlobalSkill,
	toggleGlobalSkill,
	createProjectSkill,
	updateProjectSkill,
	deleteProjectSkill,
};
