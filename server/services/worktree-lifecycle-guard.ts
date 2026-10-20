import { AsyncLocalStorage } from "node:async_hooks";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { readQuery, readQueryFirst, readTransactionTask } from "../db/worker-read";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import {
	canonicalProtectionAdmissionPath as canonicalAdmissionPath,
	canonicalProtectionPath as canonicalPath,
	readProtectionClaims,
} from "./resource-protection-index";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { runWorktreeLifecycleRead } from "./worktree-lifecycle-read";

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
const MAX_TARGETS = 128;
/** Opaque, service-created authority; callers cannot supply chapter IDs as a force token. */
interface VerifiedReleaseScope {
	chapters: Set<string>;
	/** Raw pre-switch legacy bindings; canonicalized only by an actual sink. */
	narrators: Map<string, string[]>;
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
	admission: boolean;
	/** Rows inserted by this service creation, not pre-existing legacy ownership. */
	createdChapters?: Set<string>;
	createdNarrators?: Set<string>;
	/** Paths proven to have been born inside this identity context. */
	createdPaths?: Set<string>;
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
/** A new cwd above a retiring linked checkout is not being deleted. Admissions
 * conflict only when the deletion contains the reference, not vice versa. */
function deletionContainsAdmission(deletion: LifecycleTarget, claim: LifecycleTarget): boolean {
	if (deletion.scopeProjectId && deletion.scopeProjectId === claim.scopeProjectId) return true;
	if ((deletion.deviceId ?? "local") !== (claim.deviceId ?? "local")) return false;
	if (deletion.repositoryKey && deletion.repositoryKey === claim.repositoryKey) return true;
	if (deletion.shadowKey && deletion.shadowKey === claim.shadowKey) return true;
	return !!(deletion.path && claim.path && localPathSemantics.contains(deletion.path, claim.path));
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
		if (!held.admission && held.targets.some((item) => deletionContainsAdmission(item, target)))
			reject("workspace admission", { status: "protected", complete: true, claims: [] });
	}
}
/** Initial chapter creation is an admission, never a legacy-release authority.
 * The source repository is identity context, not an exclusive directory target. */
export async function withChapterCreation<T>(
	projectId: string,
	gitPath: string,
	body: () => Promise<T>,
	worktreePath?: string,
): Promise<T> {
	const targets: LifecycleTarget[] = [{ scopeProjectId: projectId }];
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
		const project = await readQueryFirst(
			db
				.select({ path: projects.gitPath })
				.from(projects)
				.where(eq(projects.id, projectId))
				.limit(1),
			{ timeoutMs: Math.max(1, deadline - performance.now()) },
		);
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
	const current = creationContext.getStore();
	const previous = current && domain.reservations.has(current) ? current : undefined;
	const held: Reservation = previous ?? {
		id: Symbol(),
		targets: [],
		admission: true,
		ports: productionPorts,
	};
	try {
		await prepare(held);
		const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
		await revalidateFootprints(held);
		if (held.targets.length + canonical.length > MAX_TARGETS)
			reject("chapter creation budget", unavailable());
		// No await between comparing published canonical targets and publishing ours.
		for (const target of canonical) assertWorkspaceAdmission(target);
		held.targets.push(...canonical);
		if (!previous) domain.reservations.add(held);
		// Publication may follow a completed project retirement. Re-read the row, too.
		await prepare(held);
		// An unrelated enclosing retirement must neither supply release authority
		// nor intercept the new creator's identity ledger.
		return await domain.context.exit(() => creationContext.run(held, body));
	} finally {
		if (!previous) domain.reservations.delete(held);
	}
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

/**
 * Backend canonicalization for a newly committed cwd/context claim, never inventory adoption.
 * `path` is the comparison key used by reservations; `canonicalCwd` is safe to persist/execute.
 */
export async function canonicalWorkspaceAdmissionTarget(
	target: LifecycleTarget,
): Promise<LifecycleTarget & { canonicalCwd?: string }> {
	if (target.path && (target.path.length > 4096 || target.path.includes("\0")))
		reject("workspace claim admission", unavailable());
	if ((target.deviceId ?? "local") !== "local") return { ...target, canonicalCwd: target.path };
	const shadow = await canonicalShadowReference(target.shadowKey, productionPorts);
	const resolved = { ...target, ...(shadow ? { shadowKey: shadow.key } : {}) };
	if (!target.path) return resolved;
	const canonicalCwd = await boundedRead(
		productionPorts.canonicalAdmissionPath(target.path),
		performance.now() + MAX_MS,
	);
	return { ...resolved, path: normalizePathForComparison(canonicalCwd), canonicalCwd };
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
	const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
	for (const item of canonical) assertWorkspaceAdmission(item);
	const held: Reservation = { id: Symbol(), targets: canonical, admission: true };
	domain.reservations.add(held);
	try {
		return await body();
	} finally {
		domain.reservations.delete(held);
	}
}

export interface LifecycleGuardPorts {
	readClaims(
		deadline: number,
		signal?: AbortSignal,
		targets?: readonly LifecycleTarget[],
		includeLegacyReceipts?: boolean,
	): Promise<{ complete: boolean; claims: ResourceClaim[] | AsyncIterable<ResourceClaim> }>;
	/** Canonical comparison key, case-folded on Windows. */
	canonicalPath(path: string): Promise<string>;
	/** Case-preserving canonical path for a committed cwd/context (fixture seam). */
	canonicalAdmissionPath?(path: string): Promise<string>;
	/** Bounded lstat projection: device/inode only, never contents or a directory walk. */
	pathIdentity?(path: string): Promise<string | null>;
	probeGitRoot?(path: string, deadline: number): Promise<{ root: string; common: string } | null>;
}

/** A shadow reference owns its hashed storage, never its historical logical cwd. */
async function canonicalShadowReference(
	key: string | undefined,
	ports: LifecycleGuardPorts,
	deadline = performance.now() + MAX_MS,
): Promise<{ key: string; deviceId: string; physicalPath: string } | undefined> {
	if (!key) return undefined;
	const parts = key.split("\0");
	const [deviceId, path] = parts;
	if (parts.length !== 2 || !deviceId || !path || path.length > 4096 || !isAbsolute(path))
		throw new Error("Unverifiable shadow reference");
	const canonical =
		deviceId === "local" ? await boundedRead(ports.canonicalPath(path), deadline) : path;
	return {
		key: treeSnapshotKey(deviceId, canonical),
		deviceId,
		physicalPath: treeSnapshotPhysicalDir(deviceId, path),
	};
}

/** The caller's complete actual deletion set; retained shadows do not own checkout paths. */
export function legacyDeletionTargets(
	path: string | null | undefined,
	effects: { checkout: boolean; shadow: boolean },
): LifecycleTarget[] {
	if (!path) return [];
	return [
		...(effects.checkout ? [{ deviceId: "local", path }] : []),
		...(effects.shadow
			? [
					{ deviceId: "local", shadowKey: treeSnapshotKey("local", path) },
					{ deviceId: "local", path: treeSnapshotPhysicalDir("local", path) },
				]
			: []),
	];
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
const productionPorts: LifecycleGuardPorts & {
	canonicalAdmissionPath(path: string): Promise<string>;
} = {
	readClaims: (deadline, signal, targets, includeLegacyReceipts) => {
		const fixture = fixturePorts.getStore();
		return fixture
			? fixture.readClaims(deadline, signal, targets, includeLegacyReceipts)
			: readProtectionClaims(targets ?? [], deadline, signal, includeLegacyReceipts);
	},
	canonicalPath: (path) => (fixturePorts.getStore()?.canonicalPath ?? canonicalPath)(path),
	canonicalAdmissionPath: (path) => {
		const fixture = fixturePorts.getStore();
		return (fixture?.canonicalAdmissionPath ?? fixture?.canonicalPath ?? canonicalAdmissionPath)(
			path,
		);
	},
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
/** Identity context is deliberately target-free: normal use neither inventories nor
 * excludes sharing. A later destructive sink must still publish its real targets. */
export function withLifecycleContext<T>(
	paths: readonly string[],
	body: () => Promise<T>,
): Promise<T> {
	return runLifecycleContext(paths, body);
}

async function runLifecycleContext<T>(
	paths: readonly string[],
	body: () => Promise<T>,
	scope?: VerifiedReleaseScope,
	deadline = performance.now() + MAX_MS,
	signal?: AbortSignal,
): Promise<T> {
	if (paths.length > MAX_TARGETS || signal?.aborted) reject("lifecycle context", unavailable());
	const previous = liveContext();
	const creation = creationContext.getStore();
	if (creation && domain.reservations.has(creation)) creation.footprints ??= new Map();
	const held: Reservation = previous?.reservation ?? {
		id: Symbol(),
		targets: [],
		admission: false,
		ports: productionPorts,
		// Trusted births must remain visible to an enclosing chapter creation.
		footprints: creation && domain.reservations.has(creation) ? creation.footprints : new Map(),
	};
	try {
		for (const path of paths) await freezeFootprint(held, path, deadline);
		await revalidateFootprints(held, deadline);
		if (signal?.aborted) reject("lifecycle context", unavailable());
		if (!previous) domain.reservations.add(held);
		return await domain.context.run({ reservation: held, scope: scope ?? previous?.scope }, body);
	} finally {
		if (!previous) domain.reservations.delete(held);
	}
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
		if (identity !== null && (record.identity === null || record.removed)) {
			held.createdPaths ??= new Set();
			held.createdPaths.add(canonical);
		}
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
		_operation: string,
		scope?: VerifiedReleaseScope,
		signal?: AbortSignal,
		frozenTargets = false,
		creatingShadow = false,
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
					const shadow = frozenTargets
						? undefined
						: await canonicalShadowReference(target.shadowKey, ports, deadline);
					return {
						...target,
						...(shadow ? { shadowKey: shadow.key } : {}),
						...(target.path
							? { path: frozenTargets ? target.path : await ports.canonicalPath(target.path) }
							: {}),
					};
				}),
			);
			// Cold capture creates an exclusive new shadow and never deletes a failed
			// birth. Legacy request-log migration is a prerequisite for deletion, not capture.
			const inventory = await ports.readClaims(deadline, signal, normalized, !creatingShadow);
			if (!inventory.complete) return unavailable();
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
			for await (const claim of inventory.claims) {
				// Bound individual evidence, not the amount of unrelated instance history.
				if (
					Buffer.byteLength(JSON.stringify(claim)) > MAX_BYTES ||
					performance.now() > deadline ||
					signal?.aborted
				)
					return unavailable();
				if (claim.kind === "chapter" && scope?.chapters.has(claim.id)) continue;
				const canonical = {
					...claim,
					...(claim.path && (claim.deviceId ?? "local") === "local"
						? { path: await ports.canonicalPath(claim.path) }
						: {}),
				};
				const shadow = await canonicalShadowReference(claim.shadowKey, ports, deadline);
				if (shadow) canonical.shadowKey = shadow.key;
				// A cold mkdir birth is not deletion of an existing lineage store.
				// Direct cwd/registry paths still protect D; only the derived shadow
				// reference is non-exclusive while initializing the new physical store.
				const shadowPhysical = !creatingShadow &&
					shadow && {
						deviceId: shadow.deviceId,
						path:
							shadow.deviceId === "local"
								? await ports.canonicalPath(shadow.physicalPath)
								: shadow.physicalPath,
					};
				if (claim.kind === "narrator" && claim.revision === 0 && canonical.path) {
					const released = await Promise.all(
						(scope?.narrators.get(claim.id) ?? []).map((path) =>
							boundedRead(ports.canonicalPath(path), deadline),
						),
					);
					if (released.includes(canonical.path)) continue;
				}
				for (const target of normalized) {
					if (!overlaps(target, canonical) && !(shadowPhysical && overlaps(target, shadowPhysical)))
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
					// One independent reference is sufficient to refuse; diagnostics need
					// not collect every user of a shared resource into the main-thread heap.
					return { status: "protected", complete: true, claims: [canonical] };
				}
			}
			return { status: "clear", complete: true, claims: [] };
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
		creatingShadow = false,
	): Promise<ProtectionInspection> {
		const started = performance.now();
		try {
			return await boundedRead(
				inspectOnce(targets, operation, scope, signal, frozenTargets, creatingShadow),
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
		creatingShadow = false,
	): Promise<T> {
		if (
			signal?.aborted ||
			!targets.length ||
			targets.length > MAX_TARGETS ||
			contextPaths.length > MAX_TARGETS ||
			Buffer.byteLength(JSON.stringify(targets)) > MAX_BYTES ||
			(scope && !verifiedScopes.has(scope)) ||
			targets.some(
				(target) =>
					(target.deviceId ?? "local") !== "local" ||
					(!target.path && !target.shadowKey && !target.repositoryKey && !target.scopeProjectId),
			)
		)
			reject(operation, unavailable());
		const previous = liveContext();
		const effectiveScope = scope ?? previous?.scope;
		const held: Reservation = previous?.reservation ?? {
			id: Symbol(),
			targets: [],
			admission: false,
		};
		const ownCreation = creationContext.getStore();
		const isCompensation =
			!targets.some((target) => target.scopeProjectId) &&
			(operation === "legacy creation rollback" ||
				(!!effectiveScope &&
					effectiveScope.chapters.size > 0 &&
					[...effectiveScope.chapters].every((id) => ownCreation?.createdChapters?.has(id))));
		// A cold initializer can reuse only its creator's frozen absent destination;
		// preparation stays private until all canonical targets are known.
		const birth = creatingShadow && targets.length === 1 ? targets[0] : undefined;
		const birthTarget =
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
		if (birthFootprint && !previous) held.footprints = ownCreation?.footprints;
		held.ports ??= ports;
		const publishedTargets: LifecycleTarget[] = [];
		let admitted = false;
		try {
			const resolved = await boundedRead(
				Promise.all(
					targets.map(async (target) => {
						const shadow = await canonicalShadowReference(target.shadowKey, ports, deadline);
						return {
							...target,
							...(shadow ? { shadowKey: shadow.key } : {}),
							...(target.path
								? { path: (await freezeFootprint(held, target.path, deadline)).canonical }
								: {}),
						};
					}),
				),
				deadline,
			);
			for (const path of contextPaths) await freezeFootprint(held, path, deadline);
			await revalidateFootprints(held, deadline);
			const ownBirthRollback =
				operation === "shadow initialization rollback" &&
				resolved.every((target) => target.path && held.createdPaths?.has(target.path));
			const skipOwnAdmission = isCompensation || ownBirthRollback || isOwnedBirth;
			// Compare and publish in one synchronous segment. Preparing work stays private;
			// any claim committed during it is checked by the subsequent inventory read.
			for (const other of domain.reservations) {
				if (
					other !== held &&
					!(skipOwnAdmission && other === ownCreation) &&
					other.targets.some((a) =>
						resolved.some((b) =>
							other.admission ? deletionContainsAdmission(b, a) : overlaps(a, b),
						),
					)
				)
					reject(operation, { status: "protected", complete: true, claims: [] });
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
				) {
					held.targets.push(target);
					publishedTargets.push(target);
				}
			}
			if (
				held.targets.length > MAX_TARGETS ||
				Buffer.byteLength(JSON.stringify(held.targets)) > MAX_BYTES
			)
				reject(operation, unavailable());
			if (!previous) domain.reservations.add(held);
			// Metadata-only coordination has an indexed project-scope check at its
			// caller, and must not turn into a global resource inventory operation.
			const resources = resolved.filter(
				(target) => target.path || target.shadowKey || target.repositoryKey,
			);
			if (resources.length) {
				const inspection = await boundedRead(
					domain.context.run({ reservation: held, scope: effectiveScope }, () =>
						inspect(resources, operation, effectiveScope, signal, true, creatingShadow),
					),
					deadline,
				);
				if (inspection.status !== "clear") reject(operation, inspection);
			}
			await revalidateFootprints(held, deadline);
			if (signal?.aborted) reject(operation, unavailable());
			admitted = true;
			return await domain.context.run({ reservation: held, scope: effectiveScope }, body);
		} catch (error) {
			if (isResourceProtectionError(error)) throw error;
			if (!admitted) reject(operation, unavailable());
			throw error;
		} finally {
			if (!admitted && publishedTargets.length)
				held.targets = held.targets.filter((target) => !publishedTargets.includes(target));
			if (!previous) domain.reservations.delete(held);
		}
	}
	return {
		inspect,
		withProtectionReservation: reserve,
		withShadowCreationReservation<T>(
			target: { deviceId: "local"; path: string },
			body: () => Promise<T>,
		): Promise<T> {
			return reserve(
				[target],
				"shadow initialization",
				body,
				undefined,
				undefined,
				undefined,
				[],
				true,
			);
		},
	};
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
	for (const target of resolved) {
		const path = target.path;
		const published = current.reservation.targets.filter(
			(item) => (item.deviceId ?? "local") === (target.deviceId ?? "local"),
		);
		if (
			(!target.path && !target.shadowKey && !target.repositoryKey && !target.scopeProjectId) ||
			(path &&
				!published.some((item) => item.path && localPathSemantics.contains(item.path, path))) ||
			(target.shadowKey && !published.some((item) => item.shadowKey === target.shadowKey)) ||
			(target.repositoryKey &&
				!published.some((item) => item.repositoryKey === target.repositoryKey)) ||
			(target.scopeProjectId &&
				!published.some((item) => item.scopeProjectId === target.scopeProjectId))
		)
			reject("unreserved destructive target", unavailable());
	}
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

/** Creation reserves only its physical destination; it never grants cleanup authority. */
export function withShadowCreationReservation<T>(
	target: { deviceId: "local"; path: string },
	body: () => Promise<T>,
): Promise<T> {
	return guard.withShadowCreationReservation(target, body);
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
	const row = await readQueryFirst(
		db
			.select({ path: chapters.worktreePath, shadowKey: chapters.snapshotShadowKey })
			.from(chapters)
			.where(eq(chapters.id, chapterId))
			.limit(1),
	);
	const creation = creationContext.getStore();
	if (row && creation && !creation.createdChapters?.has(chapterId))
		reject("unowned chapter compensation", unavailable());
	if (!row)
		return withProtectionReservation(
			legacyDeletionTargets(path, { checkout: true, shadow: true }),
			"legacy creation rollback",
			body,
		);
	if (row.path && normalizePathForComparison(row.path) !== normalizePathForComparison(path))
		reject("legacy creation rollback", unavailable());
	if (row.shadowKey && row.shadowKey !== `local\0${normalizePathForComparison(path)}`)
		reject("legacy creation rollback", unavailable());
	return withLegacyRetirement(
		[chapterId],
		"legacy creation rollback",
		body,
		// A dormant split prefix never had a checkout. Its rollback destroys
		// only the real shadow storage, not an invented path beneath the repo.
		legacyDeletionTargets(path, { checkout: !!row.path, shadow: true }),
	);
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
	targets: readonly LifecycleTarget[] = [],
	deadlineLimit = performance.now() + MAX_MS,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) reject(operation, unavailable());
	const current = liveContext();
	if (current?.scope && chapterIds.every((id) => current.scope?.chapters.has(id))) {
		return targets.length
			? guard.withProtectionReservation(targets, operation, body, undefined, deadlineLimit, signal)
			: body();
	}
	if (!chapterIds.length || chapterIds.length > MAX_TARGETS) reject(operation, unavailable());
	const deadline = Math.min(deadlineLimit, performance.now() + MAX_MS);
	let admitted = false;
	try {
		const { db, sqlite } = await import("../db");
		const task = {
			kind: "worktree-lifecycle-read-v1" as const,
			chapterIds: [...chapterIds],
			limit: MAX_TARGETS + 1,
		};
		const { rows, owners } = await readTransactionTask<ReturnType<typeof runWorktreeLifecycleRead>>(
			db,
			task,
			() => runWorktreeLifecycleRead(sqlite, task, signal ?? new AbortController().signal),
			{
				signal,
				timeoutMs: Math.max(1, deadline - performance.now()),
				site: "worktree.retirement.provenance",
			},
		);
		if (rows.length !== new Set(chapterIds).size) reject(operation, unavailable());
		const scope: VerifiedReleaseScope = {
			chapters: new Set(rows.map((row) => row.id)),
			narrators: new Map(),
		};
		verifiedScopes.add(scope);
		const provenanceComplete =
			owners.length <= MAX_TARGETS &&
			Buffer.byteLength(JSON.stringify(rows)) + Buffer.byteLength(JSON.stringify(owners)) <=
				MAX_BYTES;
		if (performance.now() > deadline) reject(operation, unavailable());
		const creation = creationContext.getStore();
		const newlyCreated = creation && chapterIds.every((id) => creation.createdChapters?.has(id));
		for (const owner of provenanceComplete ? owners : []) {
			// A new chapter binding is not proof that this request created that narrator.
			if (newlyCreated && !creation.createdNarrators?.has(owner.id)) continue;
			// Changed contexts are ordinary independent claims, not old chapter cwd aliases.
			if (owner.revision > 0) continue;
			const allowed: string[] = [];
			for (const path of [owner.cwd, owner.contextCwd]) {
				if (
					typeof path === "string" &&
					path.length > 0 &&
					path.length <= 4096 &&
					!path.includes("\0") &&
					isAbsolute(path) &&
					rows.some((row) =>
						[row.path, row.shadowKey?.split("\0")[1]].some(
							(logicalPath) => logicalPath && localPathSemantics.contains(logicalPath, path),
						),
					)
				)
					allowed.push(path); // Canonicalize only if a real sink later needs this release proof.
			}
			scope.narrators.set(owner.id, allowed);
		}
		if (performance.now() > deadline) reject(operation, unavailable());
		if (!targets.length)
			return await runLifecycleContext(
				[],
				async () => {
					admitted = true;
					return body();
				},
				scope,
				deadline,
				signal,
			);
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

/** Project metadata is a scope barrier; only actual non-root cleanup owns disk targets. */
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
		// Publish metadata first, without inventory or filesystem probing. Chapter
		// creation and scope CAS now cannot insert a missed same-project resource.
		return await guard.withProtectionReservation(
			[{ scopeProjectId: projectId }],
			"project delete",
			async () => {
				const { db } = await import("../db");
				const { chapters, narratorWorktreeResources } = await import("../db/schema");
				const scopedResource = await readQueryFirst(
					db
						.select({
							id: narratorWorktreeResources.id,
							path: narratorWorktreeResources.worktreePath,
							deviceId: narratorWorktreeResources.deviceId,
							state: narratorWorktreeResources.state,
							scopeProjectId: narratorWorktreeResources.scopeProjectId,
						})
						.from(narratorWorktreeResources)
						.where(eq(narratorWorktreeResources.scopeProjectId, projectId))
						.limit(1),
					{ signal, timeoutMs: Math.max(1, deadline - performance.now()) },
				);
				if (scopedResource)
					reject("project delete", {
						status: "protected",
						complete: false,
						claims: [{ kind: "registry", ...scopedResource }],
					});
				const rows = await readQuery(
					db
						.select({ id: chapters.id, path: chapters.worktreePath, isRoot: chapters.isRoot })
						.from(chapters)
						.where(eq(chapters.projectId, projectId))
						.limit(MAX_TARGETS + 1),
					{ signal, timeoutMs: Math.max(1, deadline - performance.now()) },
				);
				if (rows.length > MAX_TARGETS) reject("project delete", unavailable());
				const targets: LifecycleTarget[] = [];
				for (const row of rows) {
					if (gitPath && !row.isRoot && row.path)
						targets.push(...legacyDeletionTargets(row.path, { checkout: true, shadow: true }));
				}
				if (performance.now() > deadline || signal?.aborted)
					reject("project delete", unavailable());
				return rows.length
					? withLegacyRetirement(
							rows.map((row) => row.id),
							"project delete",
							run,
							targets,
							deadline,
							signal,
						)
					: run();
			},
			undefined,
			deadline,
			signal,
		);
	} catch (error) {
		if (isResourceProtectionError(error) || admitted) throw error;
		reject("project delete", unavailable());
	}
}
