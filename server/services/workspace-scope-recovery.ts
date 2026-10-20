import { createHash, createHmac, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { readQuery, readQueryFirst, readTransactionTask } from "@server/db/worker-read";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRecoveryVerdict,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, asc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import type { db as defaultDb } from "../db";
import {
	fileChangeOperations,
	fileChangeScopes,
	users,
	workspaceExecutionOwners,
	workspaceWriteLeases,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isWorkspaceProcessIdentity } from "../lib/workspace-process-identity";
import type { FileChangeScopeIdentity } from "./file-change-identity";
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
} from "./file-change-runtime";
import {
	assertWorkspaceMaintenanceAuthority,
	proveWorkspaceOwnerEnded,
} from "./workspace-execution-owner";
import { leaseManifest, type RecoveryEffect, recoveryEffects } from "./workspace-recovery-read";
import type { WorkspaceRecoveryReservation } from "./workspace-write-coordinator";
import {
	WORKSPACE_WRITE_COORDINATOR_LIMITS,
	WorkspaceWriteCoordinatorError,
} from "./workspace-write-coordinator";

/** No workspace file writes. Observation is bounded and outside the final synchronous transaction. */
export const WORKSPACE_RECOVERY_LIMITS = Object.freeze({
	pageItems: 25,
	files: FILE_CHANGE_LIMITS.revertFiles,
	manifestMutations: WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease,
	fileBytes: FILE_CHANGE_LIMITS.blobBytes,
	totalBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes,
	durationMs: 30_000,
	metadataBytes: 2 * FILE_CHANGE_LIMITS.summaryBytes,
	legacyAudits: 64,
	maintenanceDurationMs: 5 * 60_000,
	maintenanceSessions: 64,
});
const tokenSecret = randomBytes(32);

export interface WorkspaceBarrierScopeSummary {
	id: string;
	deviceId: string;
	canonicalRoot: string;
	pathFlavor: "posix" | "windows";
	status: "active" | "retired" | "needs_verification";
	activeLeaseId: string | null;
	activeMutationCount: number;
	updatedAt: string;
}
export interface WorkspaceBarrierEffectSummary {
	effectId: string;
	operationId: string;
	canonicalPath: string;
	displayPath: string;
	settlement: string;
	dispatched: boolean;
	beforeKind: FileChangeState["kind"];
	intendedKind: FileChangeState["kind"];
}
export interface WorkspaceBarrierOperationSummary {
	operationId: string;
	sourceKind: string;
	narratorId: string | null;
	toolCallId: string | null;
	startedAt: string;
}
export interface WorkspaceBarrier {
	scope: WorkspaceBarrierScopeSummary;
	leaseId: string | null;
	kind: "quarantined" | "unverified_root";
	local: boolean;
	ranges: { canonicalPath: string; kind: string }[];
	executionEnded: boolean;
	blockedReason: string | null;
	maintenanceRequired: boolean;
	ownerProbeRetryAllowed: boolean;
	operations: WorkspaceBarrierOperationSummary[];
	effects: WorkspaceBarrierEffectSummary[];
}
export interface WorkspaceBarrierObservation {
	effectId: string;
	canonicalPath: string;
	displayPath: string;
	verdict: FileChangeRecoveryVerdict;
	actualKind: "absent" | "regular" | "unobservable";
	/** This preview compares current bytes only; it never reclassifies completed execution. */
	alreadySettled: boolean;
	observedDigest: string | null;
	observedSizeBytes: number | null;
	observedMode: number | null;
}
export interface WorkspaceScopeRecoveryDeps {
	database: Pick<typeof defaultDb, "select">;
	getRuntime(): Promise<Pick<LocalFileChangeRuntime, "coordinator" | "evidence">>;
	/** Must prove exclusive local ownership; never supplied by the HTTP client. */
	assertMaintenanceAuthority?: () => void;
	now?: () => number;
	/** Tests may tighten budgets, never expand the production ceilings. */
	observationLimits?: Partial<{ fileBytes: number; totalBytes: number; durationMs: number }>;
}
type ScopeRow = typeof fileChangeScopes.$inferSelect;
type Database = WorkspaceScopeRecoveryDeps["database"];

function scopeIdentity(row: ScopeRow): FileChangeScopeIdentity {
	return {
		id: row.id,
		sourceInstanceId: row.sourceInstanceId,
		deviceId: row.deviceId,
		workspaceInstanceId: row.workspaceInstanceId,
		pathFlavor: row.pathFlavor,
		canonicalRoot: row.canonicalRoot,
	};
}
function scopeSummary(row: ScopeRow): WorkspaceBarrierScopeSummary {
	return {
		id: row.id,
		deviceId: row.deviceId,
		canonicalRoot: row.canonicalRoot,
		pathFlavor: row.pathFlavor,
		status: row.status,
		activeLeaseId: row.activeLeaseId,
		activeMutationCount: row.activeMutationCount,
		updatedAt: row.updatedAt,
	};
}
function isDispatched(effect: RecoveryEffect): boolean {
	return (
		effect.historicallyDispatched ??
		(effect.settlement === "applying" || effect.settlement === "reconcile_required")
	);
}
function effectSummary(effect: RecoveryEffect): WorkspaceBarrierEffectSummary {
	return {
		effectId: effect.id,
		operationId: effect.operationId,
		canonicalPath: effect.identityJson.canonicalPath,
		displayPath: effect.identityJson.displayPath,
		settlement: effect.settlement,
		dispatched: isDispatched(effect),
		beforeKind: effect.beforeStateJson.kind,
		intendedKind: effect.intendedAfterStateJson.kind,
	};
}
function barrierKind(row: ScopeRow): WorkspaceBarrier["kind"] {
	// Path-only Bash buckets never carry historical root identity. Their unknown
	// activity barriers require human inspection, not initial root verification.
	// Classification grants no end-of-execution proof: the coordinator still
	// requires exclusive maintenance for a bucket with no recorded owner evidence.
	if (row.workspaceInstanceId.startsWith("bash-coordination:v1:")) return "quarantined";
	// A previously verified root with no lease may represent unknown activity.
	return row.status === "needs_verification" &&
		row.activeLeaseId === null &&
		row.rootIdentityJson === null
		? "unverified_root"
		: "quarantined";
}
async function requireScopeRow(database: Database, scopeId: string): Promise<ScopeRow> {
	const row = await readQueryFirst(
		database.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, scopeId)),
	);
	if (!row) throw new AppError("Unknown file-change scope", 404, "SCOPE_NOT_FOUND");
	return row;
}
async function resolveLeaseId(
	database: Database,
	scope: ScopeRow,
	requested?: string | null,
): Promise<string | null> {
	if (requested) return requested;
	if (!scope.activeLeaseId) return null;
	return (
		(
			await readQueryFirst(
				database
					.select({ id: workspaceWriteLeases.leaseId })
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.leaseId, scope.activeLeaseId)),
			)
		)?.id ?? null
	);
}
function requireLocal(scope: ScopeRow) {
	if (scope.deviceId !== LOCAL_DEVICE_ID)
		throw new AppError(
			"Recovery requires the server's local device",
			400,
			"REMOTE_DEVICE_UNSUPPORTED",
		);
}
function conflict(message: string): never {
	throw new AppError(message, 409, "RECOVERY_CONFLICT");
}
function mapCoordinatorError(error: unknown): never {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
		throw new AppError(
			error.name === "TimeoutError"
				? "Recovery observation timed out"
				: "Recovery observation cancelled",
			error.name === "TimeoutError" ? 408 : 499,
			error.name === "TimeoutError" ? "RECOVERY_TIMEOUT" : "RECOVERY_CANCELLED",
		);
	if (error instanceof WorkspaceWriteCoordinatorError)
		throw new AppError(error.message, 409, `WORKSPACE_${error.code.toUpperCase()}`);
	throw error;
}

function readRecoveryEffects(
	database: Database,
	scope: ScopeRow,
	leaseId: string | null,
	signal?: AbortSignal,
): Promise<RecoveryEffect[]> {
	return readTransactionTask<RecoveryEffect[]>(
		database,
		{
			kind: "workspace-recovery-effects-v1",
			scope: { id: scope.id, revision: scope.revision, fencingToken: scope.fencingToken },
			leaseId,
			limits: WORKSPACE_RECOVERY_LIMITS,
		},
		() => recoveryEffects(database, scope, leaseId, WORKSPACE_RECOVERY_LIMITS),
		{ signal },
	);
}

interface ObservationBudget {
	bytes: number;
	signal: AbortSignal;
	limits: { fileBytes: number; totalBytes: number; durationMs: number };
}
async function readActual(
	canonicalPath: string,
	budget: ObservationBudget,
): Promise<{
	kind: WorkspaceBarrierObservation["actualKind"];
	state: FileChangeState | null;
	digest: string | null;
	sizeBytes: number | null;
	mode: number | null;
}> {
	const unknown = {
		kind: "unobservable" as const,
		state: null,
		digest: null,
		sizeBytes: null,
		mode: null,
	};
	const absent = {
		kind: "absent" as const,
		state: { kind: "absent" as const },
		digest: null,
		sizeBytes: null,
		mode: null,
	};
	try {
		budget.signal.throwIfAborted();
		let entry: BigIntStats;
		try {
			entry = await lstat(canonicalPath, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
			throw error;
		}
		if (entry.isSymbolicLink() || !entry.isFile()) return unknown;
		const size = Number(entry.size);
		if (size > budget.limits.fileBytes || budget.bytes + size > budget.limits.totalBytes)
			throw new AppError("Recovery observation exceeds the byte limit", 413, "RECOVERY_BYTE_LIMIT");
		budget.bytes += size;
		const observed = await fileChangeLocalIo.read(canonicalPath, budget.signal);
		budget.signal.throwIfAborted();
		if (observed.bytes === null) return absent;
		budget.bytes += Math.max(0, observed.bytes.byteLength - size);
		if (
			observed.bytes.byteLength > budget.limits.fileBytes ||
			budget.bytes > budget.limits.totalBytes
		)
			throw new AppError("Recovery observation exceeds the byte limit", 413, "RECOVERY_BYTE_LIMIT");
		const digest = createHash("sha256").update(observed.bytes).digest("hex");
		return {
			kind: "regular",
			state: {
				kind: "regular",
				blob: { algorithm: "sha256", digest, sizeBytes: observed.bytes.byteLength },
				mode: observed.mode,
			},
			digest,
			sizeBytes: observed.bytes.byteLength,
			mode: observed.mode,
		};
	} catch (error) {
		// Cancellation/deadline and resource limits are not physical file verdicts.
		budget.signal.throwIfAborted();
		if (error instanceof AppError) throw error;
		return unknown;
	}
}
async function observeEffects(
	effects: RecoveryEffect[],
	budget: ObservationBudget,
): Promise<WorkspaceBarrierObservation[]> {
	const { signal } = budget;
	const observations: WorkspaceBarrierObservation[] = [];
	for (const effect of effects) {
		signal.throwIfAborted();
		const actual = await readActual(effect.identityJson.canonicalPath, budget);
		const verdict: FileChangeRecoveryVerdict =
			!effect.alreadySettled && !isDispatched(effect)
				? "not_dispatched"
				: actual.kind === "unobservable" || actual.state === null
					? "unobservable"
					: fileChangeStatesEqual(actual.state, effect.intendedAfterStateJson)
						? "applied"
						: fileChangeStatesEqual(actual.state, effect.beforeStateJson)
							? "not_applied"
							: "foreign";
		observations.push({
			effectId: effect.id,
			canonicalPath: effect.identityJson.canonicalPath,
			displayPath: effect.identityJson.displayPath,
			verdict,
			actualKind: actual.kind,
			alreadySettled: effect.alreadySettled === true,
			observedDigest: actual.digest,
			observedSizeBytes: actual.sizeBytes,
			observedMode: actual.mode,
		});
	}
	return observations;
}
export interface WorkspaceRangeObservation {
	canonicalPath: string;
	kind: string;
	actualKind: string;
	identity: string | null;
	observedDigest: string | null;
	observedSizeBytes: number | null;
	observedMode: number | null;
}
/** Subtrees are never recursively scanned: show the boundary and require human inspection. */
async function observeRanges(
	ranges: readonly { canonicalPath: string; kind: string }[],
	effects: RecoveryEffect[],
	budget: ObservationBudget,
): Promise<WorkspaceRangeObservation[]> {
	const covered = new Set(effects.map((effect) => effect.identityJson.canonicalPath));
	const observations: WorkspaceRangeObservation[] = [];
	for (const range of ranges) {
		budget.signal.throwIfAborted();
		if (range.kind === "file" && covered.has(range.canonicalPath)) continue;
		let entry: BigIntStats;
		try {
			entry = await lstat(range.canonicalPath, { bigint: true });
		} catch (error) {
			budget.signal.throwIfAborted();
			observations.push({
				...range,
				actualKind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unobservable",
				identity: null,
				observedDigest: null,
				observedSizeBytes: null,
				observedMode: null,
			});
			continue;
		}
		if (entry.isFile()) {
			const actual = await readActual(range.canonicalPath, budget);
			observations.push({
				...range,
				actualKind: actual.kind,
				identity: null,
				observedDigest: actual.digest,
				observedSizeBytes: actual.sizeBytes,
				observedMode: actual.mode,
			});
		} else {
			observations.push({
				...range,
				actualKind: entry.isDirectory() ? "directory" : "unsupported",
				identity: `${entry.dev}:${entry.ino}:${entry.ctimeNs}:${entry.mtimeNs}`,
				observedDigest: null,
				observedSizeBytes: Number(entry.size),
				observedMode: Number(entry.mode),
			});
		}
	}
	return observations;
}
function assertObservationObjectLimit(
	effects: RecoveryEffect[],
	ranges: readonly { canonicalPath: string; kind: string }[],
) {
	const covered = new Set(effects.map((effect) => effect.identityJson.canonicalPath));
	const objects =
		effects.length +
		ranges.filter((range) => range.kind !== "file" || !covered.has(range.canonicalPath)).length;
	if (objects > WORKSPACE_RECOVERY_LIMITS.files)
		throw new AppError("Recovery observation exceeds the object limit", 413, "RECOVERY_FILE_LIMIT");
}
function confirmationToken(value: unknown): string {
	return createHmac("sha256", tokenSecret).update(JSON.stringify(value)).digest("hex");
}
function boundedSignal(durationMs: number, signal?: AbortSignal) {
	const deadline = AbortSignal.timeout(durationMs);
	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export interface WorkspaceRecoveryInput {
	scopeId: string;
	leaseId?: string | null;
	recoveredByUserId: string;
	confirmationToken: string;
	acknowledgements: { effectId: string; verdict: FileChangeRecoveryVerdict }[];
	acknowledgeInspected?: boolean;
	signal?: AbortSignal;
}

export interface WorkspaceMaintenanceInput {
	scopeId: string;
	adminUserId: string;
	maintenanceToken: string;
	signal?: AbortSignal;
}
interface MaintenanceSession {
	token: string;
	scopeId: string;
	leaseId: string | null;
	adminUserId: string;
	oldOwnerEpoch: string | null;
	operatorReason: string;
	attestedAt: string;
	expiresAt: number;
	reservation: WorkspaceRecoveryReservation;
	controller: AbortController;
	timer: ReturnType<typeof setTimeout>;
	inFlight?: Promise<unknown>;
	closing: boolean;
}

export function createWorkspaceScopeRecovery(deps: WorkspaceScopeRecoveryDeps) {
	const { database, getRuntime } = deps;
	const now = deps.now ?? Date.now;
	const authorityCheck = deps.assertMaintenanceAuthority ?? assertWorkspaceMaintenanceAuthority;
	const assertAuthority = () => {
		try {
			authorityCheck();
		} catch (error) {
			throw new AppError(
				error instanceof Error ? error.message : "Exclusive maintenance authority is unavailable",
				409,
				"MAINTENANCE_AUTHORITY_REQUIRED",
			);
		}
	};
	const maintenance = new Map<string, MaintenanceSession>();
	function assertAdmin(adminUserId: string) {
		if (
			database.select({ role: users.role }).from(users).where(eq(users.id, adminUserId)).get()
				?.role !== "admin"
		)
			throw new AppError("Administrator permission required", 403, "FORBIDDEN");
	}
	async function releaseMaintenance(session: MaintenanceSession) {
		session.closing = true;
		session.controller.abort();
		clearTimeout(session.timer);
		// Cancellation is not proof that native IO has ended. Retain the scope until joined.
		try {
			await session.inFlight;
		} catch {
			/* The IO caller receives its own error. */
		}
		session.reservation.release();
		if (maintenance.get(session.token) === session) maintenance.delete(session.token);
	}
	function ownerIdentityQuery(oldOwnerEpoch: string) {
		return database
			.select({ identity: workspaceExecutionOwners.identityJson })
			.from(workspaceExecutionOwners)
			.where(eq(workspaceExecutionOwners.ownerEpoch, oldOwnerEpoch));
	}
	function hasOwnerIdentity(oldOwnerEpoch: string | null) {
		return (
			!!oldOwnerEpoch &&
			isWorkspaceProcessIdentity(ownerIdentityQuery(oldOwnerEpoch).get()?.identity)
		);
	}
	function assertLegacyOwner(oldOwnerEpoch: string | null) {
		if (hasOwnerIdentity(oldOwnerEpoch))
			throw new AppError(
				"Registered owner requires strict process evidence, not administrator attestation",
				409,
				"MAINTENANCE_OWNER_INELIGIBLE",
			);
	}
	function assertMaintenance(session: MaintenanceSession) {
		assertAdmin(session.adminUserId);
		assertAuthority();
		assertLegacyOwner(session.oldOwnerEpoch);
		if (session.closing || now() >= session.expiresAt) {
			void releaseMaintenance(session);
			throw new AppError(
				"Maintenance permission expired or cancelled; begin again",
				409,
				"MAINTENANCE_EXPIRED",
			);
		}
		session.reservation.assertCurrent();
	}
	function requireMaintenance(input: WorkspaceMaintenanceInput) {
		const session = maintenance.get(input.maintenanceToken);
		if (!session || session.scopeId !== input.scopeId || session.adminUserId !== input.adminUserId)
			throw new AppError(
				"Maintenance permission is invalid for this administrator and scope",
				409,
				"MAINTENANCE_INVALID",
			);
		return session;
	}
	async function withMaintenance<T>(
		input: WorkspaceMaintenanceInput,
		body: (session: MaintenanceSession, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const session = requireMaintenance(input);
		assertMaintenance(session);
		if (session.inFlight) conflict("Maintenance observation or commit is already running");
		const signal = input.signal
			? AbortSignal.any([input.signal, session.controller.signal])
			: session.controller.signal;
		const operation = Promise.resolve().then(() => {
			assertMaintenance(session);
			return body(session, signal);
		});
		session.inFlight = operation;
		try {
			return await operation;
		} finally {
			session.inFlight = undefined;
		}
	}
	async function beginWorkspaceMaintenance(input: {
		scopeId: string;
		leaseId?: string | null;
		adminUserId: string;
		acknowledgeWritersStopped: boolean;
		operatorReason: string;
	}) {
		assertAdmin(input.adminUserId);
		assertAuthority();
		if (
			input.acknowledgeWritersStopped !== true ||
			!input.operatorReason.trim() ||
			input.operatorReason.length > 1000
		)
			throw new AppError(
				"Confirm old instances and external writers are stopped and provide a reason",
				400,
				"ACK_REQUIRED",
			);
		const runtime = await getRuntime();
		assertAdmin(input.adminUserId);
		assertAuthority();
		const scope = await requireScopeRow(database, input.scopeId);
		requireLocal(scope);
		const leaseId = await resolveLeaseId(database, scope, input.leaseId);
		if (maintenance.size >= WORKSPACE_RECOVERY_LIMITS.maintenanceSessions)
			throw new AppError("Too many maintenance sessions", 429, "MAINTENANCE_LIMIT");
		const oldOwnerEpoch = leaseId
			? ((
					await readQueryFirst(
						database
							.select({ epoch: workspaceWriteLeases.ownerEpoch })
							.from(workspaceWriteLeases)
							.where(eq(workspaceWriteLeases.leaseId, leaseId)),
					)
				)?.epoch ?? null)
			: scope.activeLeaseEpoch;
		assertLegacyOwner(oldOwnerEpoch);
		const expiresAt = now() + WORKSPACE_RECOVERY_LIMITS.maintenanceDurationMs;
		const controller = new AbortController();
		const reservation = runtime.coordinator.reserveMaintenance(
			{ scope: scopeIdentity(scope), leaseId: leaseId ?? undefined },
			() => {
				assertAdmin(input.adminUserId);
				assertAuthority();
				assertLegacyOwner(oldOwnerEpoch);
				if (now() >= expiresAt || controller.signal.aborted)
					conflict("Maintenance permission expired or cancelled");
			},
		);
		const token = randomBytes(32).toString("hex");
		const session: MaintenanceSession = {
			token,
			scopeId: scope.id,
			leaseId,
			adminUserId: input.adminUserId,
			oldOwnerEpoch,
			operatorReason: input.operatorReason.trim(),
			attestedAt: new Date(now()).toISOString(),
			expiresAt,
			reservation,
			controller,
			closing: false,
			timer: setTimeout(() => {
				void releaseMaintenance(session);
			}, WORKSPACE_RECOVERY_LIMITS.maintenanceDurationMs),
		};
		session.timer.unref?.();
		maintenance.set(token, session);
		return {
			maintenanceToken: token,
			expiresAt: new Date(expiresAt).toISOString(),
			generation: reservation.generation,
		};
	}
	async function observeWorkspaceMaintenance(input: WorkspaceMaintenanceInput) {
		return withMaintenance(input, (session, signal) =>
			observeWorkspaceBarrier(session.scopeId, signal, session.leaseId, session),
		);
	}
	async function commitWorkspaceMaintenance(
		input: WorkspaceMaintenanceInput &
			Omit<WorkspaceRecoveryInput, "recoveredByUserId" | "leaseId">,
	) {
		const result = await withMaintenance(input, (session, signal) =>
			recoverWorkspaceBarrier(
				{ ...input, leaseId: session.leaseId, recoveredByUserId: session.adminUserId, signal },
				session,
			),
		);
		const session = maintenance.get(input.maintenanceToken);
		if (session) await releaseMaintenance(session);
		return result;
	}
	async function cancelWorkspaceMaintenance(input: WorkspaceMaintenanceInput) {
		const session = requireMaintenance(input);
		await releaseMaintenance(session);
		return { cancelled: true as const };
	}
	const limits: ObservationBudget["limits"] = {
		fileBytes: WORKSPACE_RECOVERY_LIMITS.fileBytes,
		totalBytes: WORKSPACE_RECOVERY_LIMITS.totalBytes,
		durationMs: WORKSPACE_RECOVERY_LIMITS.durationMs,
	};
	for (const key of ["fileBytes", "totalBytes", "durationMs"] as const) {
		const value = deps.observationLimits?.[key];
		if (value !== undefined) {
			if (!Number.isSafeInteger(value) || value < 1 || value > limits[key])
				throw new Error("Invalid recovery observation budget");
			limits[key] = value;
		}
	}

	async function retryWorkspaceRecoveryPersistence(scopeId: string) {
		const scope = await requireScopeRow(database, scopeId);
		requireLocal(scope);
		const runtime = await getRuntime();
		try {
			return await runtime.coordinator.retryFinishedPersistence(scopeIdentity(scope));
		} catch (error) {
			mapCoordinatorError(error);
		}
	}
	async function listWorkspaceBarriers(cursor?: string): Promise<{
		items: WorkspaceBarrier[];
		nextCursor: string | null;
	}> {
		const runtime = await getRuntime();
		const phase = cursor?.startsWith("scope:") ? "scope" : "lease";
		const after = cursor?.slice(cursor.indexOf(":") + 1);
		if (cursor && !/^(lease|scope):[A-Za-z0-9_-]{0,256}$/.test(cursor))
			throw new AppError("Invalid barrier cursor", 400, "INVALID_CURSOR");
		const items: WorkspaceBarrier[] = [];
		const targets: { scope: ScopeRow; leaseId: string | null }[] = [];
		let nextCursor: string | null = null;
		if (phase === "lease") {
			const rows = await readQuery(
				database
					.select({ id: workspaceWriteLeases.leaseId, scopeId: workspaceWriteLeases.scopeId })
					.from(workspaceWriteLeases)
					.where(
						and(
							inArray(workspaceWriteLeases.status, ["quarantined", "executing"]),
							after ? gt(workspaceWriteLeases.leaseId, after) : undefined,
						),
					)
					.orderBy(asc(workspaceWriteLeases.leaseId))
					.limit(WORKSPACE_RECOVERY_LIMITS.pageItems + 1),
			);
			for (const lease of rows.slice(0, WORKSPACE_RECOVERY_LIMITS.pageItems))
				targets.push({ scope: await requireScopeRow(database, lease.scopeId), leaseId: lease.id });
			nextCursor =
				rows.length > WORKSPACE_RECOVERY_LIMITS.pageItems
					? `lease:${rows[WORKSPACE_RECOVERY_LIMITS.pageItems - 1]?.id}`
					: "scope:";
		} else {
			const rows = await readQuery(
				database
					.select()
					.from(fileChangeScopes)
					.where(
						and(
							or(
								eq(fileChangeScopes.status, "needs_verification"),
								isNotNull(fileChangeScopes.activeLeaseId),
							),
							after ? gt(fileChangeScopes.id, after) : undefined,
						),
					)
					.orderBy(asc(fileChangeScopes.id))
					.limit(WORKSPACE_RECOVERY_LIMITS.pageItems + 1),
			);
			for (const scope of rows.slice(0, WORKSPACE_RECOVERY_LIMITS.pageItems)) {
				if (
					scope.activeLeaseId &&
					(await readQueryFirst(
						database
							.select({ id: workspaceWriteLeases.leaseId })
							.from(workspaceWriteLeases)
							.where(eq(workspaceWriteLeases.leaseId, scope.activeLeaseId)),
					))
				)
					continue;
				targets.push({ scope, leaseId: null });
			}
			if (rows.length > WORKSPACE_RECOVERY_LIMITS.pageItems)
				nextCursor = `scope:${rows[WORKSPACE_RECOVERY_LIMITS.pageItems - 1]?.id}`;
		}
		if (phase === "lease" && targets.length === 0) return listWorkspaceBarriers("scope:");
		let responseBytes = 0;
		for (const { scope, leaseId } of targets) {
			let ranges: WorkspaceBarrier["ranges"] = [
				{ kind: "subtree", canonicalPath: scope.canonicalRoot },
			];
			let executionEnded = false;
			let ownerEpoch = scope.activeLeaseEpoch;
			let localFileIo = false;
			let ownerProbeRetryAllowed = false;
			let blockedReason: string | null = null;
			let maintenanceRequired = false;
			if (leaseId) {
				const row = await readQueryFirst(
					database
						.select({
							ranges: workspaceWriteLeases.rangesJson,
							ended: workspaceWriteLeases.executionEndedAt,
							ownerEpoch: workspaceWriteLeases.ownerEpoch,
							executionClass: workspaceWriteLeases.executionClass,
						})
						.from(workspaceWriteLeases)
						.where(eq(workspaceWriteLeases.leaseId, leaseId)),
				);
				if (row) {
					ranges = [...row.ranges.ranges];
					executionEnded = row.ended !== null;
					ownerEpoch = row.ownerEpoch;
					localFileIo = row.executionClass === "local_file_io";
				}
			}
			try {
				const eligibility = runtime.coordinator.inspectRecovery({
					scope: scopeIdentity(scope),
					leaseId: leaseId ?? undefined,
				});
				ranges = [...eligibility.ranges];
				executionEnded = eligibility.executionEnded;
			} catch (error) {
				blockedReason = error instanceof Error ? error.message : String(error);
				const unknownOwner =
					error instanceof WorkspaceWriteCoordinatorError &&
					error.recoveryReason === "owner_unknown";
				const identified =
					unknownOwner &&
					!!ownerEpoch &&
					isWorkspaceProcessIdentity(
						(await readQueryFirst(ownerIdentityQuery(ownerEpoch)))?.identity,
					);
				maintenanceRequired = unknownOwner && !identified;
				ownerProbeRetryAllowed = identified && localFileIo;
			}
			let effects: RecoveryEffect[] = [];
			try {
				effects = await readRecoveryEffects(database, scope, leaseId);
			} catch (error) {
				blockedReason = error instanceof Error ? error.message : String(error);
			}
			const operations: WorkspaceBarrierOperationSummary[] = [];
			for (const operationId of new Set(effects.map((effect) => effect.operationId))) {
				operations.push(
					...(await readQuery(
						database
							.select({
								operationId: fileChangeOperations.id,
								sourceKind: fileChangeOperations.sourceKind,
								narratorId: fileChangeOperations.narratorId,
								toolCallId: fileChangeOperations.toolCallId,
								startedAt: fileChangeOperations.startedAt,
							})
							.from(fileChangeOperations)
							.where(eq(fileChangeOperations.id, operationId)),
					)),
				);
			}
			const item: WorkspaceBarrier = {
				scope: scopeSummary(scope),
				leaseId,
				kind: leaseId ? "quarantined" : barrierKind(scope),
				local: scope.deviceId === LOCAL_DEVICE_ID,
				ranges,
				executionEnded,
				blockedReason,
				maintenanceRequired,
				ownerProbeRetryAllowed,
				operations,
				effects: effects.map(effectSummary),
			};
			const bytes = Buffer.byteLength(JSON.stringify(item));
			if (responseBytes + bytes > WORKSPACE_RECOVERY_LIMITS.metadataBytes) {
				const previous = items.at(-1);
				if (!previous)
					throw new AppError(
						"Barrier summary exceeds the byte limit",
						413,
						"RECOVERY_METADATA_LIMIT",
					);
				nextCursor = `${phase}:${previous.leaseId ?? previous.scope.id}`;
				break;
			}
			responseBytes += bytes;
			items.push(item);
		}
		return { items, nextCursor };
	}

	async function observeWorkspaceBarrier(
		scopeId: string,
		signal?: AbortSignal,
		requestedLeaseId?: string | null,
		maintenanceSession?: MaintenanceSession,
	) {
		const runtime = await getRuntime();
		let scope = await requireScopeRow(database, scopeId);
		const leaseId = await resolveLeaseId(database, scope, requestedLeaseId);
		requireLocal(scope);
		const started = performance.now();
		const bounded = boundedSignal(limits.durationMs, signal);
		try {
			bounded.throwIfAborted();
			// Explicit POST only: retry a bounded strict owner probe after a transient startup failure.
			// Never infer the end of Bash/opaque execution or write anything during inventory GET.
			if (!maintenanceSession && leaseId) {
				const lease = await readQueryFirst(
					database
						.select({
							ownerEpoch: workspaceWriteLeases.ownerEpoch,
							executionClass: workspaceWriteLeases.executionClass,
							ended: workspaceWriteLeases.executionEndedAt,
						})
						.from(workspaceWriteLeases)
						.where(eq(workspaceWriteLeases.leaseId, leaseId)),
				);
				if (
					lease?.executionClass === "local_file_io" &&
					!lease.ended &&
					lease.ownerEpoch !== runtime.coordinator.ownerEpoch()
				) {
					assertAuthority();
					const proof = await proveWorkspaceOwnerEnded(database, lease.ownerEpoch);
					bounded.throwIfAborted();
					if (proof) {
						runtime.coordinator.recordLocalOwnerTermination(leaseId, proof);
						scope = await requireScopeRow(database, scopeId);
					}
				}
			}
			const reservation =
				maintenanceSession?.reservation ??
				runtime.coordinator.reserveRecovery({
					scope: scopeIdentity(scope),
					leaseId: leaseId ?? undefined,
				});
			try {
				const effects = await readRecoveryEffects(database, scope, leaseId ?? null, signal);
				const rootIdentity =
					!leaseId && barrierKind(scope) === "unverified_root"
						? await localDirectoryIdentity(scope.canonicalRoot)
						: null;
				assertObservationObjectLimit(effects, reservation.ranges);
				const budget = { bytes: 0, signal: bounded, limits };
				const observations = await observeEffects(effects, budget);
				const rangeObservations = await observeRanges(reservation.ranges, effects, budget);
				bounded.throwIfAborted();
				if (maintenanceSession) assertMaintenance(maintenanceSession);
				return {
					scope: scopeSummary(scope),
					leaseId: leaseId ?? null,
					observations,
					rangeObservations,
					confirmationToken: confirmationToken({
						scopeId,
						leaseId: leaseId ?? null,
						generation: reservation.generation,
						maintenanceToken: maintenanceSession?.token,
						effects,
						observations,
						rangeObservations,
						rootIdentity,
					}),
				};
			} finally {
				if (!maintenanceSession) reservation.release();
			}
		} catch (error) {
			mapCoordinatorError(error);
		} finally {
			const durationMs = Math.round(performance.now() - started);
			if (durationMs >= 1000)
				logger.warn("Slow workspace recovery observation", {
					scopeId: scope.id,
					leaseId,
					durationMs,
				});
		}
	}

	async function reconcileWorkspaceBarrier(scopeId: string, leaseId: string, signal?: AbortSignal) {
		const lease = await readQueryFirst(
			database
				.select({
					scopeId: workspaceWriteLeases.scopeId,
					executionClass: workspaceWriteLeases.executionClass,
				})
				.from(workspaceWriteLeases)
				.where(eq(workspaceWriteLeases.leaseId, leaseId)),
		);
		if (!lease || lease.scopeId !== scopeId || lease.executionClass !== "local_file_io")
			return { recovered: false as const, reason: "manual_observation_required" };
		const preview = await observeWorkspaceBarrier(scopeId, signal, leaseId);
		if (
			preview.observations.length === 0 ||
			preview.rangeObservations.length > 0 ||
			preview.observations.some(
				(entry) => entry.verdict === "foreign" || entry.verdict === "unobservable",
			)
		)
			return { recovered: false as const, reason: "manual_observation_required" };
		return recoverWorkspaceBarrier(
			{
				scopeId,
				leaseId,
				signal,
				recoveredByUserId: null,
				confirmationToken: preview.confirmationToken,
				acknowledgements: preview.observations.map(({ effectId, verdict }) => ({
					effectId,
					verdict,
				})),
			},
			undefined,
			true,
		);
	}
	async function recoverWorkspaceBarrier(
		input: Omit<WorkspaceRecoveryInput, "recoveredByUserId"> & { recoveredByUserId: string | null },
		maintenanceSession?: MaintenanceSession,
		systemReconciled = false,
	) {
		const runtime = await getRuntime();
		const scope = await requireScopeRow(database, input.scopeId);
		const leaseId = await resolveLeaseId(database, scope, input.leaseId);
		requireLocal(scope);
		const started = performance.now();
		const signal = boundedSignal(limits.durationMs, input.signal);
		try {
			signal.throwIfAborted();
			const reservation =
				maintenanceSession?.reservation ??
				runtime.coordinator.reserveRecovery({
					scope: scopeIdentity(scope),
					leaseId: leaseId ?? undefined,
				});
			try {
				const effects = await readRecoveryEffects(database, scope, leaseId ?? null, signal);
				const rootIdentity =
					!leaseId && barrierKind(scope) === "unverified_root"
						? await localDirectoryIdentity(scope.canonicalRoot)
						: null;
				assertObservationObjectLimit(effects, reservation.ranges);
				const budget = { bytes: 0, signal, limits };
				const observations = await observeEffects(effects, budget);
				const rangeObservations = await observeRanges(reservation.ranges, effects, budget);
				signal.throwIfAborted();
				const token = confirmationToken({
					scopeId: scope.id,
					leaseId: leaseId ?? null,
					generation: reservation.generation,
					maintenanceToken: maintenanceSession?.token,
					effects,
					observations,
					rangeObservations,
					rootIdentity,
				});
				if (token !== input.confirmationToken)
					throw new AppError(
						"Recovery preview changed; observe and confirm again",
						409,
						"OBSERVATION_CHANGED",
					);
				const acknowledgements = new Map(
					input.acknowledgements.map((ack) => [ack.effectId, ack.verdict]),
				);
				if (
					acknowledgements.size !== input.acknowledgements.length ||
					acknowledgements.size !== observations.length ||
					observations.some((entry) => acknowledgements.get(entry.effectId) !== entry.verdict)
				)
					throw new AppError("Acknowledge every observed effect exactly once", 400, "ACK_REQUIRED");
				if (
					!rootIdentity &&
					(observations.length === 0 || rangeObservations.length > 0) &&
					!input.acknowledgeInspected
				)
					throw new AppError("Confirm that you inspected the affected ranges", 400, "ACK_REQUIRED");
				// Detect evidence changes during awaited IO before entering the commit boundary.
				if (
					JSON.stringify(effects) !==
					JSON.stringify(
						recoveryEffects(database, scope, leaseId ?? null, WORKSPACE_RECOVERY_LIMITS),
					)
				)
					conflict("Recovery evidence changed during observation");
				let settledEffectCount = 0;
				if (maintenanceSession) assertMaintenance(maintenanceSession);
				reservation.complete((tx) => {
					if (maintenanceSession) assertMaintenance(maintenanceSession);
					if (rootIdentity)
						runtime.evidence.recordScopeVerification(
							{
								scopeId: scope.id,
								canonicalRoot: scope.canonicalRoot,
								rootIdentity: { object: rootIdentity },
							},
							tx,
						);
					if (!rootIdentity || maintenanceSession) {
						const manifest = leaseId ? leaseManifest(tx, leaseId) : [];
						settledEffectCount = runtime.evidence.closeBooksForRecovery(
							{
								scopeId: scope.id,
								workspaceLeaseId: leaseId ?? null,
								recoveredByUserId: input.recoveredByUserId,
								resolutionAuthority: maintenanceSession
									? "administrator_attested"
									: systemReconciled
										? "system_reconciled"
										: "execution_proven",
								maintenanceEvidenceJson: maintenanceSession
									? {
											version: 1,
											mode: "legacy_owner_offline",
											oldOwnerEpoch: maintenanceSession.oldOwnerEpoch,
											operatorReason: maintenanceSession.operatorReason,
											maintenanceAuthority: "exclusive_instance_lock",
											generation: reservation.generation,
											attestedAt: maintenanceSession.attestedAt,
										}
									: undefined,
								effectIds: effects.map((effect) => effect.id),
								operationIds: [
									...new Set(
										manifest.flatMap((entry) => (entry.operationId ? [entry.operationId] : [])),
									),
								],
								decisions: observations.map((entry) => ({
									effectId: entry.effectId,
									canonicalPath: entry.canonicalPath,
									verdict: entry.verdict,
									observedDigest: entry.observedDigest,
									observedSizeBytes: entry.observedSizeBytes,
								})),
							},
							tx,
						).settledEffectCount;
					}
				});
				const cleared = await requireScopeRow(database, scope.id);
				return {
					recovered: rootIdentity ? ("root_verified" as const) : ("barrier_cleared" as const),
					settledEffectCount,
					revision: cleared.revision,
					fencingToken: cleared.fencingToken,
					remaining: {
						rootVerificationRequired: cleared.status === "needs_verification",
						legacyBarrier: cleared.activeLeaseId !== null,
						leaseBarrier: !!(await readQueryFirst(
							database
								.select({ id: workspaceWriteLeases.leaseId })
								.from(workspaceWriteLeases)
								.where(
									and(
										eq(workspaceWriteLeases.scopeId, scope.id),
										inArray(workspaceWriteLeases.status, ["executing", "quarantined"]),
									),
								)
								.limit(1),
						)),
					},
				};
			} finally {
				if (!maintenanceSession) reservation.release();
			}
		} catch (error) {
			mapCoordinatorError(error);
		} finally {
			const durationMs = Math.round(performance.now() - started);
			if (durationMs >= 1000)
				logger.warn("Slow workspace recovery observation", {
					scopeId: scope.id,
					leaseId,
					durationMs,
				});
		}
	}
	return {
		listWorkspaceBarriers,
		observeWorkspaceBarrier,
		recoverWorkspaceBarrier,
		beginWorkspaceMaintenance: (...args: Parameters<typeof beginWorkspaceMaintenance>) =>
			beginWorkspaceMaintenance(...args).catch(mapCoordinatorError),
		observeWorkspaceMaintenance: (...args: Parameters<typeof observeWorkspaceMaintenance>) =>
			observeWorkspaceMaintenance(...args).catch(mapCoordinatorError),
		commitWorkspaceMaintenance: (...args: Parameters<typeof commitWorkspaceMaintenance>) =>
			commitWorkspaceMaintenance(...args).catch(mapCoordinatorError),
		cancelWorkspaceMaintenance: (...args: Parameters<typeof cancelWorkspaceMaintenance>) =>
			cancelWorkspaceMaintenance(...args).catch(mapCoordinatorError),
		reconcileWorkspaceBarrier,
		retryWorkspaceRecoveryPersistence,
	};
}

// Keep the same registry, timers and HMAC closure across --hot. A process restart
// deliberately loses these capabilities; durable barriers remain authoritative.
const DEFAULT_RECOVERY = Symbol.for("narrafork.workspaceScopeRecovery.v1");
const recoveryGlobals = globalThis as unknown as Record<
	symbol,
	Promise<ReturnType<typeof createWorkspaceScopeRecovery>> | undefined
>;
function defaultRecovery() {
	recoveryGlobals[DEFAULT_RECOVERY] ??= import("../db").then(({ db }) =>
		createWorkspaceScopeRecovery({
			database: db,
			getRuntime: getDefaultLocalFileChangeRuntime,
		}),
	);
	return recoveryGlobals[DEFAULT_RECOVERY];
}
export async function beginWorkspaceMaintenance(
	input: Parameters<
		ReturnType<typeof createWorkspaceScopeRecovery>["beginWorkspaceMaintenance"]
	>[0],
) {
	return (await defaultRecovery()).beginWorkspaceMaintenance(input);
}
export async function observeWorkspaceMaintenance(input: WorkspaceMaintenanceInput) {
	return (await defaultRecovery()).observeWorkspaceMaintenance(input);
}
export async function commitWorkspaceMaintenance(
	input: Parameters<
		ReturnType<typeof createWorkspaceScopeRecovery>["commitWorkspaceMaintenance"]
	>[0],
) {
	return (await defaultRecovery()).commitWorkspaceMaintenance(input);
}
export async function cancelWorkspaceMaintenance(input: WorkspaceMaintenanceInput) {
	return (await defaultRecovery()).cancelWorkspaceMaintenance(input);
}
export async function retryWorkspaceRecoveryPersistence(scopeId: string) {
	return (await defaultRecovery()).retryWorkspaceRecoveryPersistence(scopeId);
}
export async function listWorkspaceBarriers(cursor?: string) {
	return (await defaultRecovery()).listWorkspaceBarriers(cursor);
}
export async function observeWorkspaceBarrier(
	scopeId: string,
	signal?: AbortSignal,
	leaseId?: string | null,
) {
	return (await defaultRecovery()).observeWorkspaceBarrier(scopeId, signal, leaseId);
}
export async function recoverWorkspaceBarrier(input: WorkspaceRecoveryInput) {
	return (await defaultRecovery()).recoverWorkspaceBarrier(input);
}
