/**
 * Project index — which projects a session belongs to, derived from its directory.
 *
 * Projects are lightweight: a session working inside a git repository joins that
 * repository's project without anyone creating it by hand. `narrator_project_links`
 * records the result so project pages and access checks are indexed lookups rather
 * than path arithmetic on every request.
 *
 * Every link is a pure function of the session's own columns (`context_project_id`,
 * `cwd`, `default_device_id`) and the project roots. Nothing here is a source of
 * truth, so the table may be rebuilt at any time and a rebuild deletes links that can
 * no longer be derived.
 *
 * ## Which project a directory belongs to
 *
 * 1. The longest existing project root containing the directory, compared on path
 *    segment boundaries. Archived projects take part, so archiving never causes a
 *    second project to be created for the same directory.
 * 2. Otherwise the main repository root of the directory's git repository: a linked
 *    worktree belongs to its main repository, a subdirectory to its repository root.
 *    That project is created on the spot — public, owned by the session's owner.
 * 3. Otherwise (not a git repository) no project: the session stays standalone.
 *
 * Only local directories are indexed. A remote device's path names another machine's
 * filesystem, so neither prefix matching nor a local `git` probe means anything there.
 *
 * ## Which link decides
 *
 * `context_project_id` (a session created from a project page, or an externally
 * provisioned one) is the primary project. Otherwise the working directory's project
 * is. Access checks and configuration follow only the primary project; an
 * `additional` link merely lists the session on another project's page.
 */

import { realpath } from "node:fs/promises";
import { basename, isAbsolute, posix, resolve } from "node:path";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narratorProjectLinks, narrators, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { normalizePathForComparison, toForwardSlash } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";

const LOCAL_DEVICE_ID = "local";
const GIT_PROBE_TIMEOUT_MS = 2_000;
const GIT_PROBE_MAX_OUTPUT_BYTES = 8 * 1024;
const GIT_PROBE_CACHE_TTL_MS = 30_000;
const GIT_PROBE_CACHE_MAX_ENTRIES = 512;
/** Deeper than any real directory tree; bounds the ancestor list a lookup sends to SQL. */
const MAX_ANCESTOR_DEPTH = 64;
const REBUILD_BATCH_SIZE = 200;
const ROOT_KEY_BATCH_SIZE = 100;
const REBUILD_CACHE_MAX_ENTRIES = 512;
const REBUILD_TIME_SLICE_MS = 8;
const DERIVATION_MAX_ATTEMPTS = 8;

type DirectoryProject = { projectId: string; directory: string } | null;

/** Facts needed to validate only the relevant project topology after asynchronous IO. */
interface DirectoryResolution {
	projectId: string | null;
	directory: string;
	repositoryRootKey: string | null;
}

interface DerivedIndexState {
	links: DerivedProjectLink[];
	directory: DirectoryResolution | null;
}

type IndexReader = Pick<typeof db, "select">;

/** No persistent completion marker: every pass probes its directories again. */
interface RebuildContext {
	keys: Map<string, string>;
	roots: Map<string, string | null>;
	resolved: Map<string, DirectoryResolution>;
	freshGitProbes: boolean;
	revision: string;
	directoryResolutions: number;
	gitProbes: number;
}

function cacheInPass<T>(cache: Map<string, T>, key: string, value: T): void {
	if (cache.size >= REBUILD_CACHE_MAX_ENTRIES && !cache.has(key)) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}

/**
 * A cheap conservative invalidation token, not a project-table scan. total_changes
 * sees writes through our connection (including triggers); data_version sees other
 * connections. Any write invalidates derived project matches and page snapshots.
 * Prepared lazily: PG must never touch its deliberately unavailable SQLite handle.
 */
function databaseRevision(): string {
	const row = sqlite
		.query<{ changes: number; version: number }, []>(
			"select total_changes() as changes, data_version as version from pragma_data_version",
		)
		.get();
	return `${row?.changes}:${row?.version}`;
}

function createResolutionContext(freshGitProbes: boolean): RebuildContext {
	return {
		keys: new Map(),
		roots: new Map(),
		resolved: new Map(),
		freshGitProbes,
		revision: databaseRevision(),
		directoryResolutions: 0,
		gitProbes: 0,
	};
}

function refreshResolutionCache(context: RebuildContext): string {
	const revision = databaseRevision();
	if (context.revision !== revision) {
		context.resolved.clear();
		context.revision = revision;
	}
	return revision;
}

async function directoryKeyInPass(dir: string, context?: RebuildContext): Promise<string> {
	if (!context) return directoryKey(dir);
	const cached = context.keys.get(dir);
	if (cached !== undefined) return cached;
	context.directoryResolutions++;
	const key = await directoryKey(dir);
	cacheInPass(context.keys, dir, key);
	return key;
}

type LinkRole = "primary" | "additional";
type LinkSource = "cwd" | "explicit";

export interface DerivedProjectLink {
	projectId: string;
	role: LinkRole;
	source: LinkSource;
	deviceId: string;
	directory: string | null;
}

/** The narrator columns link derivation reads — nothing else. */
export interface ProjectIndexNarratorRow {
	id: string;
	cwd: string | null;
	contextProjectId: string | null;
	defaultDeviceId: string | null;
	ownerUserId: string | null;
}

const NARRATOR_INDEX_COLUMNS = {
	id: narrators.id,
	cwd: narrators.cwd,
	contextProjectId: narrators.contextProjectId,
	defaultDeviceId: narrators.defaultDeviceId,
	ownerUserId: narrators.ownerUserId,
};

/**
 * The comparison key for a local directory: realpath when it exists, forward slashes,
 * no trailing slash, case-folded where the filesystem is case-insensitive.
 */
export async function directoryKey(dir: string): Promise<string> {
	let resolved = dir;
	try {
		resolved = await realpath(dir);
	} catch {
		// A directory that does not exist (yet) is still keyed by its spelling.
	}
	const key = normalizePathForComparison(resolved);
	return process.platform === "darwin" ? key.toLowerCase() : key;
}

/** The key itself followed by each ancestor, nearest first. */
export function ancestorKeys(key: string): string[] {
	const keys = [key];
	let current = key;
	while (keys.length < MAX_ANCESTOR_DEPTH) {
		let parent = posix.dirname(current);
		if (/^[a-z]:$/i.test(parent)) parent = `${parent}/`;
		if (parent === current || parent === ".") break;
		keys.push(parent);
		current = parent;
	}
	return keys;
}

/** The project whose root is the longest prefix of `key`, if any. */
function matchProjectByKey(key: string, reader: IndexReader = db): string | null {
	const candidates = ancestorKeys(key);
	const rows = reader
		.select({ id: projects.id, rootKey: projects.rootKey })
		.from(projects)
		.where(inArray(projects.rootKey, candidates))
		.all();
	let best: { id: string; length: number } | null = null;
	for (const row of rows) {
		const length = row.rootKey?.length ?? 0;
		if (!best || length > best.length) best = { id: row.id, length };
	}
	return best?.id ?? null;
}

const gitProbeCache = new Map<string, { expiresAt: number; root: Promise<string | null> }>();

/**
 * The main repository root of the git repository containing `dir`, or null.
 *
 * `--git-common-dir` names the shared `.git` of a linked worktree too, which is what
 * makes a worktree resolve to its main repository. Bare repositories, a `.git`
 * elsewhere (`--separate-git-dir`) and any failure all read as "not a repository":
 * there is no working tree to name a project after.
 */
async function probeRepositoryRoot(dir: string): Promise<string | null> {
	const result = await safeSpawn({
		cmd: ["git", "-C", dir, "rev-parse", "--git-common-dir"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		timeout: GIT_PROBE_TIMEOUT_MS,
		maxOutputBytes: GIT_PROBE_MAX_OUTPUT_BYTES,
		maxStderrBytes: 1024,
	}).catch(() => null);
	if (!result || result.exitCode !== 0 || result.terminationReason || result.stdoutTruncated)
		return null;
	const output = result.stdout.split("\n")[0]?.trim();
	if (!output) return null;
	const commonDir = toForwardSlash(isAbsolute(output) ? output : resolve(dir, output)).replace(
		/\/+$/,
		"",
	);
	if (!commonDir.endsWith("/.git")) return null;
	return commonDir.slice(0, -"/.git".length) || "/";
}

function cachedRepositoryRoot(dir: string, key: string): Promise<string | null> {
	const now = Date.now();
	const hit = gitProbeCache.get(key);
	if (hit && hit.expiresAt > now) return hit.root;
	if (gitProbeCache.size >= GIT_PROBE_CACHE_MAX_ENTRIES) {
		const oldest = gitProbeCache.keys().next().value;
		if (oldest !== undefined) gitProbeCache.delete(oldest);
	}
	const root = probeRepositoryRoot(dir);
	gitProbeCache.set(key, { expiresAt: now + GIT_PROBE_CACHE_TTL_MS, root });
	return root;
}

/** In-process single flight per root, so concurrent sessions in one repository create one project. */
const creationsInFlight = new Map<string, Promise<string | null>>();

async function createProjectForRoot(
	root: string,
	rootKey: string,
	ownerUserId: string | null,
): Promise<string | null> {
	const now = new Date().toISOString();
	// The unique root-key index is the cross-process guard: a losing insert does nothing
	// and the winner's row is read back.
	await db
		.insert(projects)
		.values({
			id: generateId(),
			name: basename(root) || root,
			gitPath: root,
			ownerUserId,
			visibility: "public",
			rootKey,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	const row = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.rootKey, rootKey))
		.get();
	if (row) logger.info("Project index: project for repository", { root, projectId: row.id });
	return row?.id ?? null;
}

/**
 * The project a local directory belongs to, creating one for a git repository that has
 * none. Returns null for a directory outside every project and every repository.
 */
export async function resolveProjectForDirectory(
	dir: string,
	ownerUserId: string | null,
): Promise<DirectoryProject> {
	const resolved = await resolveDirectoryProject(dir, ownerUserId);
	return resolved.projectId
		? { projectId: resolved.projectId, directory: resolved.directory }
		: null;
}

async function resolveDirectoryProject(
	dir: string,
	ownerUserId: string | null,
	context?: RebuildContext,
): Promise<DirectoryResolution> {
	await ensureProjectRootKeys();
	if (context) {
		refreshResolutionCache(context);
		const cached = context.resolved.get(dir);
		if (cached) return cached;
	}
	const key = await directoryKeyInPass(dir, context);
	const matched = matchProjectByKey(key);
	if (matched) return { projectId: matched, directory: key, repositoryRootKey: null };

	let root: string | null;
	if (context?.freshGitProbes) {
		// Do not reuse the normal 30s probe cache across rebuilds: an offline git init
		// or worktree change must be observed even by an immediately repeated pass.
		if (context.roots.has(key)) root = context.roots.get(key) ?? null;
		else {
			context.gitProbes++;
			root = await probeRepositoryRoot(dir);
			cacheInPass(context.roots, key, root);
		}
	} else root = await cachedRepositoryRoot(dir, key);
	if (!root) return { projectId: null, directory: key, repositoryRootKey: null };
	const rootKey = await directoryKeyInPass(root, context);
	// Recheck the original directory too: a more specific project may have been
	// created while the git probe ran.
	const existing = matchProjectByKey(key) ?? matchProjectByKey(rootKey);
	if (existing) return { projectId: existing, directory: key, repositoryRootKey: rootKey };

	let creation = creationsInFlight.get(rootKey);
	if (!creation) {
		// Registered before the first await, so a concurrent caller joins this creation.
		creation = realpath(root)
			.catch(() => root)
			.then((realRoot) => createProjectForRoot(toForwardSlash(realRoot), rootKey, ownerUserId))
			.finally(() => creationsInFlight.delete(rootKey));
		creationsInFlight.set(rootKey, creation);
	}
	const projectId = await creation;
	return { projectId, directory: key, repositoryRootKey: rootKey };
}

function isLocalDevice(deviceId: string | null): boolean {
	return !deviceId || deviceId === LOCAL_DEVICE_ID;
}

/** The links a narrator should have, from its own columns. */
export async function deriveNarratorProjectLinks(
	row: ProjectIndexNarratorRow,
): Promise<DerivedProjectLink[]> {
	return (await deriveLinks(row)).links;
}

async function deriveLinks(
	row: ProjectIndexNarratorRow,
	context?: RebuildContext,
): Promise<DerivedIndexState> {
	const links: DerivedProjectLink[] = [];
	let directory: DirectoryResolution | null = null;
	if (row.contextProjectId) {
		links.push({
			projectId: row.contextProjectId,
			role: "primary",
			source: "explicit",
			deviceId: LOCAL_DEVICE_ID,
			directory: null,
		});
	}
	if (row.cwd && isLocalDevice(row.defaultDeviceId)) {
		const resolved = await resolveDirectoryProject(row.cwd, row.ownerUserId, context);
		directory = resolved;
		if (context) cacheInPass(context.resolved, row.cwd, resolved);
		if (resolved.projectId && resolved.projectId !== row.contextProjectId) {
			links.push({
				projectId: resolved.projectId,
				role: links.length === 0 ? "primary" : "additional",
				source: "cwd",
				deviceId: LOCAL_DEVICE_ID,
				directory: resolved.directory,
			});
		}
	}
	return { links, directory };
}

function directoryResolutionMatches(
	resolution: DirectoryResolution | null,
	reader: IndexReader = db,
): boolean {
	if (!resolution) return true;
	const current =
		matchProjectByKey(resolution.directory, reader) ??
		(resolution.repositoryRootKey ? matchProjectByKey(resolution.repositoryRootKey, reader) : null);
	return current === resolution.projectId;
}

function sameLinks(
	current: Array<Omit<DerivedProjectLink, "deviceId"> & { deviceId: string }>,
	desired: DerivedProjectLink[],
): boolean {
	if (current.length !== desired.length) return false;
	return desired.every((link) =>
		current.some(
			(row) =>
				row.projectId === link.projectId &&
				row.role === link.role &&
				row.source === link.source &&
				row.deviceId === link.deviceId &&
				row.directory === link.directory,
		),
	);
}

/**
 * Replace a narrator's links with `desired`; writes nothing when they already match.
 * Returns whether anything changed.
 */
function sameNarratorInputs(a: ProjectIndexNarratorRow, b: ProjectIndexNarratorRow): boolean {
	return (
		a.cwd === b.cwd &&
		a.contextProjectId === b.contextProjectId &&
		a.defaultDeviceId === b.defaultDeviceId &&
		a.ownerUserId === b.ownerUserId
	);
}

function readNarrator(
	narratorId: string,
	reader: IndexReader = db,
): ProjectIndexNarratorRow | undefined {
	return reader
		.select(NARRATOR_INDEX_COLUMNS)
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get();
}

function writeNarratorProjectLinks(
	row: ProjectIndexNarratorRow,
	derived: DerivedIndexState,
): boolean | "retry" {
	const narratorId = row.id;
	const desired = derived.links;
	return db.transaction((tx) => {
		// Validate the target inputs and relevant project roots in the same read
		// snapshot as the write. Unrelated message/narrator writes are not conflicts.
		const alive = readNarrator(narratorId, tx);
		if (!alive) return false;
		if (!sameNarratorInputs(alive, row) || !directoryResolutionMatches(derived.directory, tx))
			return "retry";
		const current = tx
			.select({
				projectId: narratorProjectLinks.projectId,
				role: narratorProjectLinks.role,
				source: narratorProjectLinks.source,
				deviceId: narratorProjectLinks.deviceId,
				directory: narratorProjectLinks.directory,
			})
			.from(narratorProjectLinks)
			.where(eq(narratorProjectLinks.narratorId, narratorId))
			.all();
		if (sameLinks(current, desired)) return false;
		tx.delete(narratorProjectLinks).where(eq(narratorProjectLinks.narratorId, narratorId)).run();
		if (desired.length === 0) return true;
		const now = new Date().toISOString();
		// A project deleted while the links were being derived has no row to point at.
		const existing = new Set(
			tx
				.select({ id: projects.id })
				.from(projects)
				.where(
					inArray(
						projects.id,
						desired.map((link) => link.projectId),
					),
				)
				.all()
				.map((row) => row.id),
		);
		const rows = desired
			.filter((link) => existing.has(link.projectId))
			.map((link) => ({ narratorId, ...link, updatedAt: now }));
		if (rows.length > 0) tx.insert(narratorProjectLinks).values(rows).run();
		return true;
	});
}

/**
 * Recompute one narrator's links. Cheap when nothing changed: one narrator read, an
 * indexed prefix lookup and, for a directory outside every project, a cached git probe.
 */
export async function syncNarratorProjectLinks(narratorId: string): Promise<void> {
	if (activeDatabaseBackend !== "sqlite") return;
	await ensureProjectRootKeys();
	const row = readNarrator(narratorId);
	if (row && (await syncIndexRow(row, createResolutionContext(false))) === "changed")
		await invalidateProjectDerivedState(row.id);
}

type CurrentLink = Omit<DerivedProjectLink, "deviceId"> & { deviceId: string };

/** Retries async derivation, never committing an obsolete directory or explicit project. */
async function syncIndexRow(
	initial: ProjectIndexNarratorRow,
	context: RebuildContext,
	prefetched?: { links: CurrentLink[]; revision: string },
): Promise<"changed" | "skipped"> {
	let row: ProjectIndexNarratorRow | undefined = initial;
	for (let attempt = 0; attempt < DERIVATION_MAX_ATTEMPTS; attempt++) {
		const revision = refreshResolutionCache(context);
		// Page rows and links are a snapshot, not authority after an async mutation.
		if (attempt > 0 || (prefetched && prefetched.revision !== revision))
			row = readNarrator(initial.id);
		if (!row) return "skipped";
		const derived = await deriveLinks(row, context);
		const afterDerivation = databaseRevision();
		if (afterDerivation !== revision) {
			const latest = readNarrator(row.id);
			if (!latest) return "skipped";
			// The global token invalidates caches, but is NOT a reason to retry:
			// unrelated message writes must never starve a cwd/permission update.
			if (!sameNarratorInputs(latest, row) || !directoryResolutionMatches(derived.directory)) {
				context.resolved.clear();
				await yieldToEventLoop();
				continue;
			}
		}
		const current =
			prefetched?.revision === afterDerivation
				? prefetched.links
				: db
						.select({
							projectId: narratorProjectLinks.projectId,
							role: narratorProjectLinks.role,
							source: narratorProjectLinks.source,
							deviceId: narratorProjectLinks.deviceId,
							directory: narratorProjectLinks.directory,
						})
						.from(narratorProjectLinks)
						.where(eq(narratorProjectLinks.narratorId, row.id))
						.all();
		// Even after a page snapshot was invalidated by an earlier changed row,
		// re-read only this small link set; do not open a no-op transaction.
		if (sameLinks(current, derived.links) && databaseRevision() === afterDerivation)
			return "skipped";
		const changed = writeNarratorProjectLinks(row, derived);
		if (changed === "retry") {
			context.resolved.clear();
			await yieldToEventLoop();
			continue;
		}
		return changed ? "changed" : "skipped";
	}
	// Only changes to this narrator's inputs or its relevant roots can consume this
	// budget. Keep retries bounded when those actual inputs continuously move.
	throw new Error("Project index inputs changed repeatedly during derivation");
}

/**
 * The primary project decides the session's execution policy (project directory and
 * command rules), which is cached per narrator: drop it when the project changed.
 * Imported lazily to keep this module out of the policy engine's import graph.
 */
async function invalidateProjectDerivedState(narratorId: string): Promise<void> {
	const { executionPolicyEngine } = await import("./execution-policy/engine");
	executionPolicyEngine.invalidate(narratorId);
}

/** Same, never throwing: the index must not fail the operation that triggered it. */
export async function syncNarratorProjectLinksSafely(narratorId: string): Promise<void> {
	try {
		await syncNarratorProjectLinks(narratorId);
	} catch (error) {
		logger.warn("Project index: narrator sync failed", { narratorId, error: String(error) });
	}
}

// ── Project root keys ───────────────────────────────────────────────────────

/**
 * Give one project its root key, unless another project already holds that key.
 *
 * Older databases can have several projects on one directory; only the first to claim
 * the key takes part in matching, the others keep a null key.
 */
export async function assignProjectRootKey(projectId: string): Promise<void> {
	const row = await db
		.select({ gitPath: projects.gitPath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!row) return;
	const key = row.gitPath ? await directoryKey(row.gitPath) : null;
	// A slow realpath must not put an old key back after another root update.
	const sameRoot = and(
		eq(projects.id, projectId),
		row.gitPath === null ? isNull(projects.gitPath) : eq(projects.gitPath, row.gitPath),
	);
	await db.update(projects).set({ rootKey: null }).where(sameRoot);
	if (!key) return;
	try {
		await db
			.update(projects)
			.set({ rootKey: key })
			.where(
				and(sameRoot, sql`not exists (select 1 from projects held where held.root_key = ${key})`),
			);
	} catch (error) {
		// Lost a race for the key: this project stays out of matching, like any duplicate.
		logger.warn("Project index: root key already claimed", { projectId, error: String(error) });
	}
}

async function backfillProjectRootKeys(): Promise<void> {
	let cursor: { createdAt: string; id: string } | null = null;
	for (;;) {
		const page: Array<{ id: string; createdAt: string }> = await db
			.select({ id: projects.id, createdAt: projects.createdAt })
			.from(projects)
			.where(
				and(
					isNull(projects.rootKey),
					isNotNull(projects.gitPath),
					cursor
						? or(
								gt(projects.createdAt, cursor.createdAt),
								and(eq(projects.createdAt, cursor.createdAt), gt(projects.id, cursor.id)),
							)
						: undefined,
				),
			)
			.orderBy(asc(projects.createdAt), asc(projects.id))
			.limit(ROOT_KEY_BATCH_SIZE);
		if (page.length === 0) return;
		for (const project of page) await assignProjectRootKey(project.id);
		const last = page[page.length - 1];
		cursor = { createdAt: last.createdAt, id: last.id };
		await yieldToEventLoop();
	}
}

let rootKeysReady: Promise<void> | null = null;

/**
 * Root keys for projects that predate the index (or whose key could not be written)
 * are filled in once per process, oldest first, before anything is matched or created.
 */
export function ensureProjectRootKeys(): Promise<void> {
	if (activeDatabaseBackend !== "sqlite") return Promise.resolve();
	rootKeysReady ??= backfillProjectRootKeys().catch((error) => {
		rootKeysReady = null;
		throw error;
	});
	return rootKeysReady;
}

// ── Rebuild ─────────────────────────────────────────────────────────────────

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolveYield) => setImmediate(resolveYield));
}

async function rebuildProjectIndex() {
	await ensureProjectRootKeys();
	const context = createResolutionContext(true);
	let cursor = "";
	let scanned = 0;
	let changed = 0;
	let skipped = 0;
	let failed = 0;
	let sliceStarted = performance.now();
	for (;;) {
		const revision = databaseRevision();
		const page = db
			.select(NARRATOR_INDEX_COLUMNS)
			.from(narrators)
			.where(gt(narrators.id, cursor))
			.orderBy(asc(narrators.id))
			.limit(REBUILD_BATCH_SIZE)
			.all();
		if (page.length === 0) break;
		const current = new Map<string, CurrentLink[]>();
		const links = db
			.select({
				narratorId: narratorProjectLinks.narratorId,
				projectId: narratorProjectLinks.projectId,
				role: narratorProjectLinks.role,
				source: narratorProjectLinks.source,
				deviceId: narratorProjectLinks.deviceId,
				directory: narratorProjectLinks.directory,
			})
			.from(narratorProjectLinks)
			.where(
				inArray(
					narratorProjectLinks.narratorId,
					page.map((row) => row.id),
				),
			)
			.all();
		for (const link of links) {
			const rows = current.get(link.narratorId) ?? [];
			rows.push(link);
			current.set(link.narratorId, rows);
		}
		for (const row of page) {
			try {
				const outcome = await syncIndexRow(row, context, {
					links: current.get(row.id) ?? [],
					revision,
				});
				if (outcome === "changed") {
					changed++;
					await invalidateProjectDerivedState(row.id);
				} else skipped++;
			} catch (error) {
				failed++;
				// Do not let a failed resolution poison a later narrator with the same cwd.
				context.resolved.clear();
				logger.warn("Project index: narrator skipped during rebuild", {
					narratorId: row.id,
					error: String(error),
				});
			}
			scanned++;
			if (performance.now() - sliceStarted >= REBUILD_TIME_SLICE_MS) {
				await yieldToEventLoop();
				sliceStarted = performance.now();
			}
		}
		cursor = page[page.length - 1].id;
		await yieldToEventLoop();
		sliceStarted = performance.now();
	}
	return {
		narrators: scanned,
		scanned,
		changed,
		skipped,
		failed,
		directoryResolutions: context.directoryResolutions,
		gitProbes: context.gitProbes,
	};
}

let rebuildRunning: Promise<void> | null = null;
let rebuildRequested = false;

/**
 * Rebuild every narrator's links in the background: paged by id, yielding between
 * pages, never blocking a request. A request arriving mid-rebuild schedules one more
 * pass instead of starting a second concurrent one.
 */
export function scheduleProjectIndexRebuild(): Promise<void> {
	if (activeDatabaseBackend !== "sqlite") return Promise.resolve();
	if (rebuildRunning) {
		rebuildRequested = true;
		return rebuildRunning;
	}
	rebuildRunning = (async () => {
		do {
			rebuildRequested = false;
			const started = Date.now();
			try {
				const result = await rebuildProjectIndex();
				logger.info("Project index rebuilt", { ...result, ms: Date.now() - started });
			} catch (error) {
				logger.warn("Project index rebuild failed", { error: String(error) });
			}
		} while (rebuildRequested);
	})().finally(() => {
		rebuildRunning = null;
	});
	return rebuildRunning;
}

/** Test hook: forget cached probes and the per-process root-key pass. */
export function resetProjectIndexStateForTests(): void {
	gitProbeCache.clear();
	creationsInFlight.clear();
	rootKeysReady = null;
}
