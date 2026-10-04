import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { eq, gt, inArray, sql } from "drizzle-orm";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { normalizePathForComparison } from "../lib/platform-path";
import { narraforkDir } from "../lib/settings";
import { safeSpawn } from "../lib/spawn";
import { treeSnapshotPhysicalDir } from "./tree-snapshot-paths";

export interface LifecycleTarget {
	deviceId?: string;
	path?: string;
	repositoryKey?: string;
	shadowKey?: string;
	/** Authorization scope is independent of repository/path/device location. */
	scopeProjectId?: string | null;
}
export interface ResourceClaim extends LifecycleTarget {
	kind: "registry" | "chapter" | "narrator" | "receipt";
	id: string;
	chapterId?: string | null;
	state?: string;
	revision?: number;
	/** Only pre-switch, still chapter-bound legacy references have one-way containment. */
	legacyChapterCwd?: boolean;
}
export interface ProtectionInspection {
	status: "clear" | "protected" | "unavailable";
	complete: boolean;
	claims: ResourceClaim[];
}
export class ResourceProtectionError extends AppError {
	constructor(
		readonly operation: string,
		readonly inspection: ProtectionInspection,
	) {
		super(
			inspection.status === "protected"
				? `Resource is already in use by an independent/shared claim; refusing ${operation}`
				: `Cannot completely verify resource protection; refusing ${operation}`,
			409,
			inspection.status === "protected" ? "RESOURCE_PROTECTED" : "RESOURCE_PROTECTION_UNAVAILABLE",
		);
	}
}
export function isResourceProtectionError(error: unknown): error is ResourceProtectionError {
	return (
		error instanceof ResourceProtectionError ||
		(error instanceof AppError &&
			["RESOURCE_PROTECTED", "RESOURCE_PROTECTION_UNAVAILABLE"].includes(error.code))
	);
}

const MAX_BYTES = 256 * 1024;
const MAX_MS = 5000;
const PAGE = 128;
const MAX_TARGETS = 128;
/** Opaque, service-created authority; callers cannot supply chapter IDs as a force token. */
interface VerifiedReleaseScope {
	chapters: Set<string>;
	narrators: Map<string, string[]>;
	/** Service-verified dormant lineage identities; these operations do not delete cwd. */
	shadowOnlyPaths: Set<string>;
}
interface PathFootprint {
	raw: string;
	canonical: string;
	identity: string | null;
	removed?: boolean;
}
interface Reservation {
	id: symbol;
	footprints?: Map<string, PathFootprint>;
	ports?: LifecycleGuardPorts;
	targets: LifecycleTarget[];
	preparing: boolean;
	admission: boolean;
	/** Rows inserted by this service creation, not pre-existing legacy ownership. */
	createdChapters?: Set<string>;
	createdNarrators?: Set<string>;
	/** Positive Git-root evidence acquired before this reserved retirement changes paths. */
	distinctRoots?: Map<string, string>;
}
const domain = hotSafe("narrafork.worktreeLifecycleGuard", () => ({
	reservations: new Set<Reservation>(),
	context: new AsyncLocalStorage<{ reservation: Reservation; scope?: VerifiedReleaseScope }>(),
}));

const creationContext = hotSafe(
	"narrafork.chapterCreationAdmission",
	() => new AsyncLocalStorage<Reservation>(),
);

const verifiedScopes = hotSafe(
	"narrafork.worktreeLifecycleScopes",
	() => new WeakSet<VerifiedReleaseScope>(),
);
function liveContext() {
	const current = domain.context.getStore();
	return current && domain.reservations.has(current.reservation) ? current : undefined;
}
function footprintReservation(): Reservation | undefined {
	const current = creationContext.getStore();
	return (
		liveContext()?.reservation ??
		(current && domain.reservations.has(current) ? current : undefined)
	);
}
function overlaps(a: LifecycleTarget, b: LifecycleTarget): boolean {
	if (a.scopeProjectId && a.scopeProjectId === b.scopeProjectId) return true;
	if ((a.deviceId ?? "local") !== (b.deviceId ?? "local")) return false;
	if (a.repositoryKey && a.repositoryKey === b.repositoryKey) return true;
	if (a.shadowKey && a.shadowKey === b.shadowKey) return true;
	return !!(
		a.path &&
		b.path &&
		(localPathSemantics.contains(a.path, b.path) || localPathSemantics.contains(b.path, a.path))
	);
}
const unavailable = (): ProtectionInspection => ({
	status: "unavailable",
	complete: false,
	claims: [],
});
function reject(operation: string, inspection: ProtectionInspection): never {
	throw new ResourceProtectionError(operation, inspection);
}

/** Called after backend canonicalization. No await may separate this check from a sync commit. */
export function assertWorkspaceAdmission(target: LifecycleTarget): void {
	for (const held of domain.reservations) {
		if (!held.admission && (held.preparing || held.targets.some((item) => overlaps(item, target))))
			reject("workspace admission", { status: "protected", complete: true, claims: [] });
	}
}
/** Initial chapter creation is an admission, never a legacy-release authority.
 * Install the reservation before canonicalization and hold it through compensation.
 * A nested retirement callback cannot borrow its release scope to become a creator. */
export async function withChapterCreation<T>(
	projectId: string,
	gitPath: string,
	body: () => Promise<T>,
	worktreePath?: string,
): Promise<T> {
	const raw = { scopeProjectId: projectId, deviceId: "local", path: gitPath };
	const targets: LifecycleTarget[] = [raw];
	if (worktreePath)
		targets.push(
			{ deviceId: "local", path: worktreePath },
			{ deviceId: "local", path: treeSnapshotPhysicalDir("local", worktreePath) },
		);
	const prepare = async (held: Reservation) => {
		const deadline = performance.now() + MAX_MS;
		const repository = await freezeFootprint(held, gitPath, deadline);
		if (repository.identity === null) reject("chapter repository unavailable", unavailable());
		// Re-read after admission, not from a project captured before an await gap.
		const { db } = await import("../db");
		const { projects } = await import("../db/schema");
		const project = db
			.select({ path: projects.gitPath })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1)
			.get();
		if (
			!project?.path ||
			(await boundedRead(productionPorts.canonicalPath(project.path), deadline)) !==
				repository.canonical
		)
			reject("chapter project changed or unavailable", unavailable());
		if (worktreePath) {
			const footprint = await freezeFootprint(held, worktreePath, deadline);
			if (footprint.identity !== null) reject("chapter destination already exists", unavailable());
			const shadow = await freezeFootprint(
				held,
				treeSnapshotPhysicalDir("local", worktreePath),
				deadline,
			);
			if (shadow.identity !== null)
				reject("chapter shadow destination already exists", unavailable());
		}
		await revalidateFootprints(held, deadline);
	};
	for (const target of targets) assertWorkspaceAdmission(target);
	const current = creationContext.getStore();
	if (current && domain.reservations.has(current)) {
		current.preparing = true;
		try {
			const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
			for (const target of canonical) assertWorkspaceAdmission(target);
			current.targets.push(...canonical);
			if (current.targets.length > MAX_TARGETS) reject("chapter creation budget", unavailable());
			await prepare(current);
			current.preparing = false;
			return await body();
		} finally {
			current.preparing = false;
		}
	}
	return withWorkspaceAdmission(targets, async () => {
		const held = [...domain.reservations].find((item) => item.targets.includes(raw));
		if (!held) reject("chapter creation", unavailable());
		held.preparing = true;
		try {
			held.targets = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
			for (const target of held.targets) assertWorkspaceAdmission(target);
			await prepare(held);
			held.preparing = false;
			return await creationContext.run(held, body);
		} finally {
			held.preparing = false;
		}
	});
}

/** Called synchronously after the service insert returns; this grants row
 * compensation provenance, never an exemption for independent resource claims. */
export function recordChapterCreated(chapterId: string): void {
	const held = creationContext.getStore();
	if (!held || !domain.reservations.has(held))
		reject("unreserved chapter insertion", unavailable());
	held.createdChapters ??= new Set();
	held.createdChapters.add(chapterId);
}

export function recordChapterNarratorCreated(narratorId: string): void {
	const held = creationContext.getStore();
	if (!held || !domain.reservations.has(held))
		reject("unreserved narrator creation", unavailable());
	held.createdNarrators ??= new Set();
	held.createdNarrators.add(narratorId);
}

/** Backend canonicalization for a newly committed cwd/context claim, never inventory adoption. */
export async function canonicalWorkspaceAdmissionTarget(
	target: LifecycleTarget,
): Promise<LifecycleTarget> {
	if (target.path && (target.path.length > 4096 || target.path.includes("\0")))
		reject("workspace claim admission", unavailable());
	if ((target.deviceId ?? "local") !== "local") return { ...target };
	return {
		...target,
		...(target.path
			? {
					path: await boundedRead(
						productionPorts.canonicalPath(target.path),
						performance.now() + MAX_MS,
					),
				}
			: {}),
	};
}
/** Async registration/CAS must keep their claim visible until the durable write completes. */
export async function withWorkspaceAdmission<T>(
	target: LifecycleTarget | readonly LifecycleTarget[],
	body: () => Promise<T>,
): Promise<T> {
	const targets: LifecycleTarget[] = Array.isArray(target)
		? [...target]
		: [target as LifecycleTarget];
	if (!targets.length || targets.length > MAX_TARGETS) reject("workspace admission", unavailable());
	for (const item of targets) assertWorkspaceAdmission(item);
	const held: Reservation = { id: Symbol(), targets, preparing: false, admission: true };
	domain.reservations.add(held);
	try {
		return await body();
	} finally {
		domain.reservations.delete(held);
	}
}

async function canonicalPath(path: string): Promise<string> {
	if (!isAbsolute(path) || path.length > 4096 || path.includes("\0"))
		throw new Error("Invalid resource path");
	let current = path;
	const suffix: string[] = [];
	for (let depth = 0; depth < 64; depth++) {
		try {
			return normalizePathForComparison(resolve(await realpath(current), ...suffix));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const node = await lstat(current).catch((cause) => {
				if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw cause;
			});
			if (node?.isSymbolicLink()) {
				const link = await readlink(current);
				if (Buffer.byteLength(link) > 4096) throw new Error("Symlink target exceeds budget");
				current = resolve(dirname(current), link);
				continue;
			}
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.unshift(localPathSemantics.basename(current));
			current = parent;
		}
	}
	throw new Error("Resource path ancestry exceeded budget");
}

export interface LifecycleGuardPorts {
	readClaims(
		deadline: number,
		signal?: AbortSignal,
	): Promise<{ complete: boolean; claims: ResourceClaim[] }>;
	canonicalPath(path: string): Promise<string>;
	/** Bounded lstat projection: device/inode only, never contents or a directory walk. */
	pathIdentity?(path: string): Promise<string | null>;
	probeGitRoot?(path: string, deadline: number): Promise<{ root: string; common: string } | null>;
}

/** Small projections only; cursor pagination never converts a truncated scan to no owners. */
async function readClaims(deadline: number, signal?: AbortSignal) {
	const { db } = await import("../db");
	const { chapters, narrators, narratorWorktreeResources } = await import("../db/schema");
	const claims: ResourceClaim[] = [];
	let bytes = 0;
	const append = (claim: ResourceClaim) => {
		bytes += Buffer.byteLength(JSON.stringify(claim));
		if (bytes > MAX_BYTES || performance.now() > deadline || signal?.aborted)
			throw new Error("Inventory budget exceeded");
		claims.push(claim);
	};
	let cursor: string | undefined;
	for (let page = 0; page < 32; page++) {
		const rows = db
			.select({
				id: narratorWorktreeResources.id,
				deviceId: narratorWorktreeResources.deviceId,
				path: narratorWorktreeResources.worktreePath,
				repositoryKey: narratorWorktreeResources.repositoryKey,
				scopeProjectId: narratorWorktreeResources.scopeProjectId,
				state: narratorWorktreeResources.state,
			})
			.from(narratorWorktreeResources)
			.where(cursor ? gt(narratorWorktreeResources.id, cursor) : undefined)
			.orderBy(narratorWorktreeResources.id)
			.limit(PAGE + 1)
			.all();
		for (const row of rows.slice(0, PAGE)) append({ kind: "registry", ...row });
		if (rows.length <= PAGE) break;
		if (page === 31) throw new Error("Inventory truncated");
		cursor = rows[PAGE - 1]?.id;
		await new Promise<void>((done) => setTimeout(done, 0));
	}
	cursor = undefined;
	for (let page = 0; page < 32; page++) {
		const rows = db
			.select({
				id: chapters.id,
				path: chapters.worktreePath,
				shadowKey: chapters.snapshotShadowKey,
			})
			.from(chapters)
			.where(cursor ? gt(chapters.id, cursor) : undefined)
			.orderBy(chapters.id)
			.limit(PAGE + 1)
			.all();
		for (const row of rows.slice(0, PAGE))
			append({
				kind: "chapter",
				id: row.id,
				...(row.path ? { path: row.path } : {}),
				...(row.shadowKey ? { shadowKey: row.shadowKey } : {}),
			});
		if (rows.length <= PAGE) break;
		if (page === 31) throw new Error("Chapter inventory truncated");
		cursor = rows[PAGE - 1]?.id;
		await new Promise<void>((done) => setTimeout(done, 0));
	}
	cursor = undefined;
	for (let page = 0; page < 32; page++) {
		const rows = db
			.select({
				id: narrators.id,
				chapterId: narrators.chapterId,
				cwd: narrators.cwd,
				defaultDeviceId: narrators.defaultDeviceId,
				revision: narrators.workspaceRevision,
				contextCwd: sql<string | null>`json_extract(${narrators.workspaceContext}, '$.cwd')`,
				contextCwdType: sql<string | null>`json_type(${narrators.workspaceContext}, '$.cwd')`,
				deviceId: sql<string | null>`json_extract(${narrators.workspaceContext}, '$.deviceId')`,
				contextDeviceType: sql<
					string | null
				>`json_type(${narrators.workspaceContext}, '$.deviceId')`,
				repositoryKey: sql<
					string | null
				>`json_extract(${narrators.workspaceContext}, '$.git.repositoryKey')`,
			})
			.from(narrators)
			.where(cursor ? gt(narrators.id, cursor) : undefined)
			.orderBy(narrators.id)
			.limit(PAGE + 1)
			.all();
		for (const row of rows.slice(0, PAGE)) {
			const validDevice = (device: unknown) =>
				device === null ||
				(typeof device === "string" &&
					device.length > 0 &&
					device.length <= 256 &&
					!device.includes("\0"));
			if (
				!validDevice(row.defaultDeviceId) ||
				!validDevice(row.deviceId) ||
				(row.contextDeviceType !== null &&
					row.contextDeviceType !== "null" &&
					row.contextDeviceType !== "text")
			)
				throw new Error("Legacy claim device is unverifiable");
			if (
				(row.cwd !== null &&
					(typeof row.cwd !== "string" ||
						row.cwd.length === 0 ||
						row.cwd.length > 4096 ||
						row.cwd.includes("\0"))) ||
				(row.contextCwdType !== null &&
					row.contextCwdType !== "null" &&
					row.contextCwdType !== "text") ||
				(row.contextCwd !== null &&
					(typeof row.contextCwd !== "string" ||
						row.contextCwd.length === 0 ||
						row.contextCwd.length > 4096 ||
						row.contextCwd.includes("\0")))
			)
				throw new Error("Legacy claim cwd is unverifiable");
			const rawDevice =
				row.cwd && isAbsolute(row.cwd) ? "local" : (row.defaultDeviceId ?? row.deviceId ?? "local");
			const contextDevice =
				row.deviceId ?? (row.defaultDeviceId && row.defaultDeviceId !== "local" ? null : "local");
			if (row.contextCwd && !contextDevice)
				throw new Error("Legacy context device is unverifiable");
			if (row.cwd)
				append({
					kind: "narrator",
					id: row.id,
					chapterId: row.chapterId,
					legacyChapterCwd: !!row.chapterId && row.revision === 0,
					revision: row.revision,
					path:
						rawDevice === "local" ? localPathSemantics.resolve(process.cwd(), row.cwd) : row.cwd,
					deviceId: rawDevice,
				});
			if (row.contextCwd)
				append({
					kind: "narrator",
					id: row.id,
					chapterId: row.chapterId,
					legacyChapterCwd: !!row.chapterId && row.revision === 0,
					revision: row.revision,
					deviceId: contextDevice ?? "local",
					path:
						contextDevice === "local"
							? localPathSemantics.resolve(process.cwd(), row.contextCwd)
							: row.contextCwd,
					...(row.repositoryKey ? { repositoryKey: row.repositoryKey } : {}),
				});
		}
		if (rows.length <= PAGE) break;
		if (page === 31) throw new Error("Narrator inventory truncated");
		cursor = rows[PAGE - 1]?.id;
		await new Promise<void>((done) => setTimeout(done, 0));
	}
	const directory = join(narraforkDir, "worktree-requests");
	const metadata = await lstat(directory).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	if (metadata) {
		if (!metadata.isDirectory() || metadata.isSymbolicLink())
			throw new Error("Unsafe receipt directory");
		let count = 0;
		for await (const entry of await opendir(directory)) {
			if (
				++count > 512 ||
				performance.now() > deadline ||
				signal?.aborted ||
				!entry.isFile() ||
				!/^[a-f0-9]{64}\.json$/.test(entry.name)
			)
				throw new Error("Receipt inventory unavailable");
			const file = await open(
				join(directory, entry.name),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				const stat = await file.stat();
				if (stat.size > 32 * 1024 || bytes + stat.size > MAX_BYTES)
					throw new Error("Receipt budget exceeded");
				const buffer = Buffer.alloc(Math.min(32 * 1024 + 1, MAX_BYTES - bytes + 1));
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
				bytes += bytesRead;
				if (bytesRead > 32 * 1024 || bytes > MAX_BYTES) throw new Error("Receipt budget exceeded");
				const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
				// The actual journal's historical contract is unversioned, with an
				// optional deviceId (absence means local). Explicit null is NOT absence.
				if (
					!record ||
					Array.isArray(record) ||
					Object.getPrototypeOf(record) !== Object.prototype ||
					Object.hasOwn(record, "__proto__") ||
					Object.hasOwn(record, "version") ||
					typeof record.destination !== "string" ||
					!isAbsolute(record.destination) ||
					record.destination.length > 4096 ||
					record.destination.includes("\0") ||
					typeof record.repositoryKey !== "string" ||
					!record.repositoryKey.trim() ||
					record.repositoryKey.length > 4096 ||
					(Object.hasOwn(record, "deviceId") &&
						(typeof record.deviceId !== "string" ||
							!record.deviceId.trim() ||
							!/^[-A-Za-z0-9_]{1,128}$/.test(record.deviceId)))
				)
					throw new Error("Invalid receipt");
				append({
					kind: "receipt",
					id: entry.name,
					deviceId: record.deviceId ?? "local",
					path: record.destination,
					repositoryKey: record.repositoryKey,
				});
			} finally {
				await file.close();
			}
		}
	}
	return { complete: true, claims };
}

const fixturePorts = new AsyncLocalStorage<LifecycleGuardPorts>();
/** Read-only fixture injection; execution/storage sinks remain the real service methods. */
export function withLifecycleGuardPorts<T>(
	ports: LifecycleGuardPorts,
	body: () => Promise<T>,
): Promise<T> {
	return fixturePorts.run(ports, body);
}
async function readPathIdentity(path: string): Promise<string | null> {
	const node = await lstat(path).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	return node ? `${node.dev}:${node.ino}` : null;
}
function lifecycleGitProbeEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		GIT_DIR: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
	};
}
async function probeGitRoot(
	path: string,
	deadline: number,
): Promise<{ root: string; common: string } | null> {
	const result = await safeSpawn({
		cmd: [
			"git",
			"--no-optional-locks",
			"-C",
			path,
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-common-dir",
		],
		timeout: Math.max(1, Math.min(MAX_MS, deadline - performance.now())),
		maxOutputBytes: 2048,
		env: lifecycleGitProbeEnv(),
	});
	if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) return null;
	const parts = result.stdout.trim().split("\n");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { root: await canonicalPath(parts[0]), common: await canonicalPath(parts[1]) };
}
const productionPorts: LifecycleGuardPorts = {
	readClaims: (deadline, signal) =>
		(fixturePorts.getStore()?.readClaims ?? readClaims)(deadline, signal),
	canonicalPath: (path) => (fixturePorts.getStore()?.canonicalPath ?? canonicalPath)(path),
	pathIdentity: (path) => (fixturePorts.getStore()?.pathIdentity ?? readPathIdentity)(path),
	probeGitRoot: (path, deadline) =>
		(fixturePorts.getStore()?.probeGitRoot ?? probeGitRoot)(path, deadline),
};
async function boundedRead<T>(work: Promise<T>, deadline: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Protection read timed out")),
					Math.max(0, deadline - performance.now()),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function freezeFootprint(
	held: Reservation,
	path: string,
	deadline: number,
): Promise<PathFootprint> {
	const ports = held.ports ?? productionPorts;
	const canonical = await boundedRead(ports.canonicalPath(path), deadline);
	const identity = await boundedRead(
		ports.pathIdentity?.(canonical) ?? Promise.resolve(null),
		deadline,
	);
	held.footprints ??= new Map();
	const key = normalizePathForComparison(path);
	const existing = held.footprints.get(key);
	if (existing) {
		if (
			canonical !== existing.canonical ||
			identity !== (existing.removed ? null : existing.identity)
		)
			reject("resource footprint changed", unavailable());
		return existing;
	}
	if (held.footprints.size >= MAX_TARGETS * 3) reject("resource footprint budget", unavailable());
	const footprint = { raw: path, canonical, identity };
	held.footprints.set(key, footprint);
	// An absent destination has no inode yet. Freeze its nearest real parent so
	// replacing that directory cannot silently redirect a later trusted creation.
	if (identity === null && ports.pathIdentity) {
		let parent = dirname(path);
		let found = false;
		for (let depth = 0; depth < 64; depth++) {
			const canonicalParent = await boundedRead(ports.canonicalPath(parent), deadline);
			if (await boundedRead(ports.pathIdentity(canonicalParent), deadline)) {
				await freezeFootprint(held, parent, deadline);
				found = true;
				break;
			}
			const next = dirname(parent);
			if (next === parent) break;
			parent = next;
		}
		if (!found) reject("unknown resource parent", unavailable());
	}
	return footprint;
}
async function revalidateFootprints(held: Reservation, deadline = performance.now() + MAX_MS) {
	for (const footprint of held.footprints?.values() ?? [])
		await freezeFootprint(held, footprint.raw, deadline);
}
/** Last dispatch check. Never re-target a reserved raw alias to a new directory/inode. */
export async function revalidateLifecycleTarget(path: string): Promise<string> {
	const held = footprintReservation();
	if (!held) reject("unreserved resource dispatch", unavailable());
	try {
		await revalidateFootprints(held);
		const key = normalizePathForComparison(path);
		const footprint =
			held.footprints?.get(key) ??
			[...(held.footprints?.values() ?? [])].find((item) => item.canonical === key);
		if (!footprint) reject("unfrozen resource dispatch", unavailable());
		return footprint.canonical;
	} catch (error) {
		if (isResourceProtectionError(error)) throw error;
		reject("resource footprint verification", unavailable());
	}
}
/** Read-only working-context capture (e.g. Git's repository cwd), not an ownership claim. */
export async function captureLifecycleContextPath(path: string): Promise<string> {
	const held = footprintReservation();
	if (!held) reject("unreserved resource context", unavailable());
	try {
		return (
			await freezeFootprint(
				held,
				isAbsolute(path) ? path : resolve(path),
				performance.now() + MAX_MS,
			)
		).canonical;
	} catch (error) {
		if (isResourceProtectionError(error)) throw error;
		reject("resource context verification", unavailable());
	}
}
/** Legacy wake/create may create its own reserved path; no inventory/owner is invented. */
export async function lifecycleCreationPath(path: string): Promise<string> {
	if (!footprintReservation()) return path;
	const normalized = isAbsolute(path) ? path : resolve(path);
	await captureLifecycleContextPath(normalized);
	return revalidateLifecycleTarget(normalized);
}
export async function confirmLifecyclePathCreated(
	path: string,
	expectedIdentity?: string,
): Promise<void> {
	const held = footprintReservation();
	if (!held) return;
	const ports = held.ports ?? productionPorts;
	const canonical = await boundedRead(ports.canonicalPath(path), performance.now() + MAX_MS);
	const records = [...(held.footprints?.values() ?? [])].filter(
		(item) => item.canonical === canonical,
	);
	if (!records.length) reject("unfrozen legacy creation", unavailable());
	const identity = await boundedRead(
		ports.pathIdentity?.(canonical) ?? Promise.resolve(null),
		performance.now() + MAX_MS,
	);
	if (expectedIdentity !== undefined && identity !== expectedIdentity)
		reject("created directory identity changed", unavailable());
	for (const record of records) {
		if (
			(await boundedRead(ports.canonicalPath(record.raw), performance.now() + MAX_MS)) !==
			record.canonical
		)
			reject("legacy creation alias changed", unavailable());
		if (record.identity !== null && !record.removed && record.identity !== identity)
			reject("legacy creation footprint changed", unavailable());
		record.identity = identity;
		record.removed = false;
	}
}
/** Called only after the bounded Git/rm sink reports success and absence is verified. */
export async function confirmLifecyclePathRemoved(path: string): Promise<void> {
	const held = footprintReservation();
	if (!held) reject("unreserved legacy removal", unavailable());
	const ports = held.ports ?? productionPorts;
	const canonical = await boundedRead(ports.canonicalPath(path), performance.now() + MAX_MS);
	if (
		await boundedRead(
			ports.pathIdentity?.(canonical) ?? Promise.resolve(null),
			performance.now() + MAX_MS,
		)
	)
		reject("legacy removal not confirmed", unavailable());
	const records = [...(held.footprints?.values() ?? [])].filter(
		(item) => item.canonical === canonical,
	);
	if (!records.length) reject("unfrozen legacy removal", unavailable());
	for (const record of records) {
		if (
			(await boundedRead(ports.canonicalPath(record.raw), performance.now() + MAX_MS)) !==
			record.canonical
		)
			reject("legacy removal alias changed", unavailable());
		record.removed = true;
	}
}
/** Injectable read-only ports allow lifecycle integration tests without touching user data. */
export function createLifecycleGuard(ports: LifecycleGuardPorts) {
	async function inspectOnce(
		targets: readonly LifecycleTarget[],
		operation: string,
		scope?: VerifiedReleaseScope,
		signal?: AbortSignal,
		frozenTargets = false,
	): Promise<ProtectionInspection> {
		const deadline = performance.now() + MAX_MS;
		try {
			if (scope && !verifiedScopes.has(scope)) return unavailable();
			if (
				!targets.length ||
				targets.length > MAX_TARGETS ||
				signal?.aborted ||
				targets.some(
					(target) =>
						!target.path && !target.repositoryKey && !target.shadowKey && !target.scopeProjectId,
				) ||
				Buffer.byteLength(JSON.stringify(targets)) > MAX_BYTES
			)
				return unavailable();
			const normalized = await Promise.all(
				targets.map(async (target) => {
					if ((target.deviceId ?? "local") !== "local")
						throw new Error("Remote retirement unsupported");
					return {
						...target,
						...(target.path
							? { path: frozenTargets ? target.path : await ports.canonicalPath(target.path) }
							: {}),
					};
				}),
			);
			const inventory = await ports.readClaims(deadline, signal);
			if (!inventory.complete) return unavailable();
			const protectedClaims: ResourceClaim[] = [];
			let bytes = Buffer.byteLength(JSON.stringify(normalized));
			const probes = new Map<string, { root: string; common: string } | null>();
			const held = footprintReservation();
			async function distinctGitRoots(targetPath: string, claimPath: string): Promise<boolean> {
				const key = `${targetPath}\0${claimPath}`;
				const priorCommon = held?.distinctRoots?.get(key);
				if (priorCommon && held) await revalidateFootprints(held, deadline);
				if (!ports.probeGitRoot) return false;
				for (const path of [targetPath, claimPath]) {
					if (!probes.has(path)) {
						if (probes.size >= 32) throw new Error("Git identity probe budget exceeded");
						const identity = await ports.probeGitRoot(path, deadline);
						bytes += 2048; // source output cap, including failed/empty probes
						if (bytes > MAX_BYTES || performance.now() > deadline || signal?.aborted)
							throw new Error("Git identity budget exceeded");
						probes.set(path, identity);
					}
				}
				const targetRoot = probes.get(targetPath);
				const claimRoot = probes.get(claimPath);
				const removedByThisReservation =
					!!priorCommon &&
					[...(held?.footprints?.values() ?? [])].some(
						(path) => path.canonical === targetPath && path.removed,
					);
				const distinct = !!(
					claimRoot &&
					claimRoot.root === claimPath &&
					((targetRoot &&
						targetRoot.root === targetPath &&
						claimRoot.root !== targetRoot.root &&
						targetRoot.common === claimRoot.common) ||
						(!targetRoot && removedByThisReservation && priorCommon === claimRoot.common))
				);
				if (distinct && held && claimRoot) {
					held.distinctRoots ??= new Map();
					held.distinctRoots.set(key, claimRoot.common);
				}
				return distinct;
			}
			for (const claim of inventory.claims) {
				bytes += Buffer.byteLength(JSON.stringify(claim));
				if (bytes > MAX_BYTES || performance.now() > deadline || signal?.aborted)
					return unavailable();
				if (claim.kind === "chapter" && scope?.chapters.has(claim.id)) continue;
				const canonical = {
					...claim,
					...(claim.path && (claim.deviceId ?? "local") === "local"
						? { path: await ports.canonicalPath(claim.path) }
						: {}),
				};
				if (canonical.shadowKey && !canonical.path) {
					const parts = canonical.shadowKey.split("\0");
					const [deviceId, path] = parts;
					if (parts.length !== 2 || !deviceId || !path)
						throw new Error("Unverifiable shadow reference");
					canonical.deviceId = deviceId;
					canonical.path = deviceId === "local" ? await ports.canonicalPath(path) : path;
				}
				if (
					claim.kind === "narrator" &&
					claim.revision === 0 &&
					canonical.path &&
					scope?.narrators.get(claim.id)?.includes(canonical.path)
				)
					continue;
				for (const target of normalized) {
					if (!overlaps(target, canonical)) continue;
					if (
						claim.kind === "chapter" &&
						target.path &&
						canonical.path &&
						(operation === "legacy creation rollback" || operation === "shadow destroy") &&
						scope?.shadowOnlyPaths.has(target.path) &&
						target.path !== canonical.path &&
						localPathSemantics.contains(canonical.path, target.path) &&
						!(target.shadowKey && target.shadowKey === canonical.shadowKey)
					)
						continue;
					// A repository-root cwd is not an owner of every linked worktree stored
					// beneath it. This exception needs positive distinct Git-root evidence,
					// never a path convention; durable inventories/receipts are never waived.
					const targetPath = target.path;
					const claimPath = canonical.path;
					const pathOnlyAncestor =
						targetPath &&
						claimPath &&
						localPathSemantics.contains(claimPath, targetPath) &&
						!localPathSemantics.contains(targetPath, claimPath) &&
						!(target.repositoryKey && target.repositoryKey === canonical.repositoryKey) &&
						!(target.shadowKey && target.shadowKey === canonical.shadowKey);
					if (
						pathOnlyAncestor &&
						(claim.kind === "chapter" || claim.kind === "narrator") &&
						targetPath &&
						claimPath &&
						(await distinctGitRoots(targetPath, claimPath))
					)
						continue;
					protectedClaims.push(canonical);
					break;
				}
			}
			return {
				status: protectedClaims.length ? "protected" : "clear",
				complete: true,
				claims: protectedClaims,
			};
		} catch {
			return unavailable();
		}
	}
	async function inspect(
		targets: readonly LifecycleTarget[],
		operation: string,
		scope?: VerifiedReleaseScope,
		signal?: AbortSignal,
		frozenTargets = false,
	): Promise<ProtectionInspection> {
		const started = performance.now();
		try {
			return await boundedRead(
				inspectOnce(targets, operation, scope, signal, frozenTargets),
				started + MAX_MS,
			);
		} catch {
			return unavailable();
		} finally {
			const elapsedMs = Math.round(performance.now() - started);
			if (elapsedMs >= 1000)
				logger.warn("Slow lifecycle protection inspection", {
					operation,
					elapsedMs,
					targetCount: targets.length,
				});
		}
	}
	async function reserve<T>(
		targets: readonly LifecycleTarget[],
		operation: string,
		body: () => Promise<T>,
		scope?: VerifiedReleaseScope,
		deadline = performance.now() + MAX_MS,
		signal?: AbortSignal,
		contextPaths: readonly string[] = [],
	): Promise<T> {
		if (
			signal?.aborted ||
			!targets.length ||
			targets.length > MAX_TARGETS ||
			contextPaths.length > MAX_TARGETS ||
			Buffer.byteLength(JSON.stringify(targets)) > MAX_BYTES ||
			targets.some((target) => (target.deviceId ?? "local") !== "local")
		)
			reject(operation, unavailable());
		const previous = liveContext();
		const effectiveScope = scope ?? previous?.scope;
		const held: Reservation = previous?.reservation ?? {
			id: Symbol(),
			targets: [],
			preparing: true,
			admission: false,
		};
		const ownCreation = creationContext.getStore();
		const isCompensation =
			!targets.some((target) => target.scopeProjectId) &&
			(operation === "legacy creation rollback" ||
				(!!effectiveScope &&
					[...effectiveScope.chapters].every((id) => ownCreation?.createdChapters?.has(id))));
		// A cold shadow initializer may reuse only its creator's already frozen,
		// absent destination. This skips a self-admission conflict, not any claim.
		const birth = targets.length === 1 ? targets[0] : undefined;
		const birthTarget =
			operation === "shadow initialization" &&
			birth?.deviceId === "local" &&
			!birth.scopeProjectId &&
			!birth.repositoryKey &&
			!birth.shadowKey
				? birth.path
				: undefined;
		const birthFootprint =
			birthTarget &&
			(ownCreation?.footprints?.get(normalizePathForComparison(birthTarget)) ??
				[...(ownCreation?.footprints?.values() ?? [])].find(
					(item) => item.canonical === normalizePathForComparison(birthTarget),
				));
		const isOwnedBirth = !!(
			birthFootprint &&
			(birthFootprint.identity === null || birthFootprint.removed) &&
			ownCreation?.targets.some(
				(target) => !target.scopeProjectId && target.path === birthFootprint.canonical,
			)
		);
		// Capturing a parent's cold shadow is also a tracked context birth, not
		// creator ownership. Synchronize its inode without skipping self-admission.
		if (birthFootprint && !previous) held.footprints = ownCreation?.footprints;
		const skipOwnAdmission = isCompensation || isOwnedBirth;
		for (const other of domain.reservations) {
			if (other === held || (skipOwnAdmission && other === ownCreation)) continue;
			if (other.preparing || other.targets.some((a) => targets.some((b) => overlaps(a, b))))
				reject(operation, unavailable());
		}
		if (!previous) domain.reservations.add(held);
		held.ports ??= ports;
		let admitted = false;
		try {
			const resolved = await boundedRead(
				Promise.all(
					targets.map(async (target) => ({
						...target,
						...(target.path
							? { path: (await freezeFootprint(held, target.path, deadline)).canonical }
							: {}),
					})),
				),
				deadline,
			);
			for (const path of contextPaths) await freezeFootprint(held, path, deadline);
			for (const other of domain.reservations) {
				if (
					other !== held &&
					!(skipOwnAdmission && other === ownCreation) &&
					(other.preparing || other.targets.some((a) => resolved.some((b) => overlaps(a, b))))
				)
					reject(operation, unavailable());
			}
			for (const target of resolved) {
				if (
					!held.targets.some(
						(item) =>
							item.deviceId === target.deviceId &&
							item.path === target.path &&
							item.repositoryKey === target.repositoryKey &&
							item.shadowKey === target.shadowKey &&
							item.scopeProjectId === target.scopeProjectId,
					)
				)
					held.targets.push(target);
			}
			if (
				held.targets.length > MAX_TARGETS ||
				Buffer.byteLength(JSON.stringify(held.targets)) > MAX_BYTES
			)
				reject(operation, unavailable());
			held.preparing = false;
			const inspection = await boundedRead(
				domain.context.run({ reservation: held, scope: effectiveScope }, () =>
					inspect(resolved, operation, effectiveScope, signal, true),
				),
				deadline,
			);
			if (inspection.status !== "clear") reject(operation, inspection);
			await revalidateFootprints(held, deadline);
			if (signal?.aborted) reject(operation, unavailable());
			admitted = true;
			return await domain.context.run({ reservation: held, scope: effectiveScope }, body);
		} catch (error) {
			if (isResourceProtectionError(error)) throw error;
			if (!admitted) reject(operation, unavailable());
			throw error;
		} finally {
			if (!previous) domain.reservations.delete(held);
		}
	}
	return { inspect, withProtectionReservation: reserve };
}
const guard = createLifecycleGuard(productionPorts);
export const inspect = guard.inspect;
/** Re-read the complete bounded claim set at a last destructive fallback, not merely inode. */
export async function assertLifecycleProtectionCurrent(
	targets: readonly LifecycleTarget[],
	operation: string,
): Promise<void> {
	const current = liveContext();
	if (!current) reject(operation, unavailable());
	const resolved = await Promise.all(
		targets.map(async (target) => ({
			...target,
			...(target.path ? { path: await revalidateLifecycleTarget(target.path) } : {}),
		})),
	);
	const inspection = await createLifecycleGuard(
		current.reservation.ports ?? productionPorts,
	).inspect(resolved, operation, current.scope, undefined, true);
	if (inspection.status !== "clear") reject(operation, inspection);
	await revalidateFootprints(current.reservation);
}
export function withProtectionReservation<T>(
	targets: readonly LifecycleTarget[],
	operation: string,
	body: () => Promise<T>,
	signal?: AbortSignal,
	contextPaths: readonly string[] = [],
): Promise<T> {
	return guard.withProtectionReservation(
		targets,
		operation,
		body,
		undefined,
		undefined,
		signal,
		contextPaths,
	);
}

/** Rollback preflight precedes even narrator/chapter deletion, so deleting those rows
 * cannot erase the evidence which protects an independently claimed resource. */
export async function withLegacyCreationRollback<T>(
	chapterId: string,
	path: string,
	body: () => Promise<T>,
): Promise<T> {
	const { db } = await import("../db");
	const { chapters } = await import("../db/schema");
	const row = db
		.select({ path: chapters.worktreePath, shadowKey: chapters.snapshotShadowKey })
		.from(chapters)
		.where(eq(chapters.id, chapterId))
		.limit(1)
		.get();
	const creation = creationContext.getStore();
	if (row && creation && !creation.createdChapters?.has(chapterId))
		reject("unowned chapter compensation", unavailable());
	if (!row)
		return withProtectionReservation(
			[{ path }, { path: treeSnapshotPhysicalDir("local", path) }],
			"legacy creation rollback",
			body,
		);
	if (row.path && normalizePathForComparison(row.path) !== normalizePathForComparison(path))
		reject("legacy creation rollback", unavailable());
	if (row.shadowKey && row.shadowKey !== `local\0${normalizePathForComparison(path)}`)
		reject("legacy creation rollback", unavailable());
	return withLegacyRetirement([chapterId], "legacy creation rollback", body, [{ path }]);
}

/** Compensate only steps recorded AFTER successful creation. A refused compensation
 * leaves protected resources intact and never replaces the original creation error. */
export async function compensateLegacyCreation(
	chapterId: string,
	path: string,
	steps: Array<() => Promise<void>>,
): Promise<void> {
	if (!steps.length) return;
	try {
		const creation = creationContext.getStore();
		if (creation && domain.reservations.has(creation)) await revalidateFootprints(creation);
		await withLegacyCreationRollback(chapterId, path, async () => {
			for (const step of steps.reverse()) {
				try {
					await step();
				} catch (error) {
					if (isResourceProtectionError(error)) throw error;
					logger.error("Creation compensation step failed", { error: String(error) });
				}
			}
		});
	} catch (error) {
		logger.error("Creation compensation refused or failed; preserving original error", {
			chapterId,
			error: String(error),
		});
	}
}

/** The chapter service alone derives its release authority from the current DB rows. */
export async function withLegacyRetirement<T>(
	chapterIds: readonly string[],
	operation: string,
	body: () => Promise<T>,
	extraTargets: readonly LifecycleTarget[] = [],
	deadlineLimit = performance.now() + MAX_MS,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) reject(operation, unavailable());
	const current = liveContext();
	if (current?.scope && chapterIds.every((id) => current.scope?.chapters.has(id))) {
		return extraTargets.length
			? guard.withProtectionReservation(
					extraTargets,
					operation,
					body,
					undefined,
					deadlineLimit,
					signal,
				)
			: body();
	}
	if (!chapterIds.length || chapterIds.length > MAX_TARGETS) reject(operation, unavailable());
	const deadline = Math.min(deadlineLimit, performance.now() + MAX_MS);
	let admitted = false;
	try {
		const { db } = await import("../db");
		const { chapters, narrators } = await import("../db/schema");
		const rows = db
			.select({
				id: chapters.id,
				path: chapters.worktreePath,
				shadowKey: chapters.snapshotShadowKey,
			})
			.from(chapters)
			.where(inArray(chapters.id, [...chapterIds]))
			.limit(MAX_TARGETS + 1)
			.all();
		if (rows.length !== new Set(chapterIds).size) reject(operation, unavailable());
		const targets: LifecycleTarget[] = [...extraTargets];
		const scope: VerifiedReleaseScope = {
			chapters: new Set(rows.map((row) => row.id)),
			narrators: new Map(),
			shadowOnlyPaths: new Set(),
		};
		verifiedScopes.add(scope);
		for (const row of rows) {
			if (
				(row.path !== null &&
					(!row.path ||
						row.path.length > 4096 ||
						row.path.includes("\0") ||
						!isAbsolute(row.path))) ||
				(row.shadowKey !== null && (!row.shadowKey || row.shadowKey.length > 4102))
			)
				reject(operation, unavailable());
			// Physical shadow storage is not beneath the logical checkout. Reserve every
			// actual sink key (current path and persisted dormant/alias lineage) up front.
			const shadowPaths = new Set<string>();
			if (row.path) shadowPaths.add(row.path);
			if (row.shadowKey) {
				const parts = row.shadowKey.split("\0");
				if (parts.length !== 2 || parts[0] !== "local" || !parts[1] || !isAbsolute(parts[1]))
					reject(operation, unavailable());
				shadowPaths.add(parts[1]);
			}
			for (const path of shadowPaths)
				targets.push({ deviceId: "local", path: treeSnapshotPhysicalDir("local", path) });
			if (row.path)
				targets.push({ path: row.path, ...(row.shadowKey ? { shadowKey: row.shadowKey } : {}) });
			else if (row.shadowKey) {
				const [deviceId, path] = row.shadowKey.split("\0");
				if (path)
					scope.shadowOnlyPaths.add(
						await boundedRead(productionPorts.canonicalPath(path), deadline),
					);
				targets.push({ deviceId, path, shadowKey: row.shadowKey });
			}
		}
		// No resources may exist for old dormant rows. A DB-only retirement still must read
		// inventory, and a harmless, non-filesystem sentinel avoids granting force authority.
		if (!targets.length) targets.push({ shadowKey: `legacy-retirement:${chapterIds.join(",")}` });
		const owners = db
			.select({
				id: narrators.id,
				cwd: narrators.cwd,
				contextCwd: sql<string | null>`json_extract(${narrators.workspaceContext}, '$.cwd')`,
				revision: narrators.workspaceRevision,
			})
			.from(narrators)
			.where(inArray(narrators.chapterId, [...chapterIds]))
			.limit(MAX_TARGETS + 1)
			.all();
		if (
			owners.length > MAX_TARGETS ||
			Buffer.byteLength(JSON.stringify(rows)) + Buffer.byteLength(JSON.stringify(owners)) >
				MAX_BYTES ||
			performance.now() > deadline
		)
			reject(operation, unavailable());
		const creation = creationContext.getStore();
		const newlyCreated = creation && chapterIds.every((id) => creation.createdChapters?.has(id));
		for (const owner of owners) {
			// A new chapter binding is not proof that this request created that narrator.
			if (newlyCreated && !creation.createdNarrators?.has(owner.id)) continue;
			// Changed contexts are ordinary independent claims, not old chapter cwd aliases.
			if (owner.revision > 0) continue;
			const allowed: string[] = [];
			for (const path of [owner.cwd, owner.contextCwd]) {
				if (
					path &&
					rows.some((row) =>
						[row.path, row.shadowKey?.split("\0")[1]].some(
							(logicalPath) => logicalPath && localPathSemantics.contains(logicalPath, path),
						),
					)
				)
					allowed.push(await boundedRead(productionPorts.canonicalPath(path), deadline));
			}
			scope.narrators.set(owner.id, allowed);
		}
		if (performance.now() > deadline) reject(operation, unavailable());
		return await guard.withProtectionReservation(
			targets,
			operation,
			async () => {
				admitted = true;
				return body();
			},
			scope,
			deadline,
			signal,
		);
	} catch (error) {
		if (isResourceProtectionError(error) || admitted) throw error;
		reject(operation, unavailable());
	}
}

/** Project deletion also protects linked independent worktrees outside its gitPath. */
export async function withProjectRetirement<T>(
	projectId: string,
	gitPath: string | null,
	body: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) reject("project delete", unavailable());
	const deadline = performance.now() + MAX_MS;
	let admitted = false;
	const run = async () => {
		admitted = true;
		return body();
	};
	try {
		const { db } = await import("../db");
		const { chapters, narratorWorktreeResources } = await import("../db/schema");
		const scopedResource = db
			.select({
				id: narratorWorktreeResources.id,
				path: narratorWorktreeResources.worktreePath,
				deviceId: narratorWorktreeResources.deviceId,
				state: narratorWorktreeResources.state,
				scopeProjectId: narratorWorktreeResources.scopeProjectId,
			})
			.from(narratorWorktreeResources)
			.where(eq(narratorWorktreeResources.scopeProjectId, projectId))
			.limit(1)
			.get();
		if (scopedResource)
			reject("project delete", {
				status: "protected",
				// Indexed existence is conclusive protection, not a complete owner inventory.
				complete: false,
				claims: [{ kind: "registry", ...scopedResource }],
			});
		const rows = db
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.projectId, projectId))
			.limit(MAX_TARGETS + 1)
			.all();
		if (rows.length > MAX_TARGETS) reject("project delete", unavailable());
		const targets: LifecycleTarget[] = [{ scopeProjectId: projectId }];
		if (gitPath) {
			const result = await safeSpawn({
				cmd: [
					"git",
					"--no-optional-locks",
					"-C",
					gitPath,
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				],
				timeout: Math.max(1, deadline - performance.now()),
				maxOutputBytes: 4096,
				env: lifecycleGitProbeEnv(),
				signal,
			});
			if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
				reject("project delete", unavailable());
			const repositoryPath = await boundedRead(
				productionPorts.canonicalPath(result.stdout.trim()),
				deadline,
			);
			const repositoryKey = createHash("sha256")
				.update(JSON.stringify(["local", localPathSemantics.identityKey(repositoryPath)]))
				.digest("hex");
			targets.push({ path: gitPath, repositoryKey });
		}
		if (performance.now() > deadline) reject("project delete", unavailable());
		if (rows.length)
			return await withLegacyRetirement(
				rows.map((row) => row.id),
				"project delete",
				run,
				targets,
				deadline,
				signal,
			);
		return await guard.withProtectionReservation(
			targets.length ? targets : [{ shadowKey: `project:${projectId}` }],
			"project delete",
			run,
			undefined,
			deadline,
			signal,
		);
	} catch (error) {
		if (isResourceProtectionError(error) || admitted) throw error;
		reject("project delete", unavailable());
	}
}
