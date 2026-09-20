import { createHash, createHmac, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRecoveryDecision,
	type FileChangeRecoveryVerdict,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { db as defaultDb } from "../db";
import {
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopeRecoveries,
	fileChangeScopes,
	workspaceWriteLeases,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { FileChangeScopeIdentity } from "./file-change-identity";
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
} from "./file-change-runtime";
import {
	WORKSPACE_WRITE_COORDINATOR_LIMITS,
	WorkspaceWriteCoordinatorError,
} from "./workspace-write-coordinator";
import { WORKSPACE_LEASE_LIMITS } from "./workspace-write-lease-store";

/** No disk writes. Observation is bounded and outside the final synchronous transaction. */
export const WORKSPACE_RECOVERY_LIMITS = Object.freeze({
	pageItems: 25,
	files: FILE_CHANGE_LIMITS.revertFiles,
	manifestMutations: WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease,
	fileBytes: FILE_CHANGE_LIMITS.blobBytes,
	totalBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes,
	durationMs: 30_000,
	metadataBytes: 2 * FILE_CHANGE_LIMITS.summaryBytes,
	legacyAudits: 64,
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
	/** Tests may tighten budgets, never expand the production ceilings. */
	observationLimits?: Partial<{ fileBytes: number; totalBytes: number; durationMs: number }>;
}
type ScopeRow = typeof fileChangeScopes.$inferSelect;
type Database = WorkspaceScopeRecoveryDeps["database"];

// Do not load immutable receipts, actor metadata or file bodies for inventory/preview.
const effectColumns = {
	id: fileChangeEffects.id,
	operationId: fileChangeEffects.operationId,
	identityJson: fileChangeEffects.identityJson,
	beforeStateJson: fileChangeEffects.beforeStateJson,
	intendedAfterStateJson: fileChangeEffects.intendedAfterStateJson,
	settlement: fileChangeEffects.settlement,
	updatedAt: fileChangeEffects.updatedAt,
};
type RecoveryEffect = {
	[K in keyof typeof effectColumns]: (typeof fileChangeEffects.$inferSelect)[K];
} & {
	/** Current-state comparison only: never infer an original dispatch from a settled row. */
	alreadySettled?: boolean;
	historicallyDispatched?: boolean;
};

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
	// A previously verified root with no lease may represent unknown activity.
	return row.status === "needs_verification" &&
		row.activeLeaseId === null &&
		row.rootIdentityJson === null
		? "unverified_root"
		: "quarantined";
}
function requireScopeRow(database: Database, scopeId: string): ScopeRow {
	const row = database
		.select()
		.from(fileChangeScopes)
		.where(eq(fileChangeScopes.id, scopeId))
		.get();
	if (!row) throw new AppError("Unknown file-change scope", 404, "SCOPE_NOT_FOUND");
	return row;
}
function resolveLeaseId(
	database: Database,
	scope: ScopeRow,
	requested?: string | null,
): string | null {
	if (requested) return requested;
	if (!scope.activeLeaseId) return null;
	return (
		database
			.select({ id: workspaceWriteLeases.leaseId })
			.from(workspaceWriteLeases)
			.where(eq(workspaceWriteLeases.leaseId, scope.activeLeaseId))
			.get()?.id ?? null
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

/** Legacy releases used two commits. Recover the exact audit's effect set, not an empty prefix. */
function leaseManifest(database: Database, leaseId: string) {
	// Mutation count and unique effect count are independent: apply + compensate
	// can legally record 2,000 dispatch identities for at most 1,000 effects.
	const header = database
		.select({
			bytes: sql<number>`length(cast(${workspaceWriteLeases.mutationManifestJson} as blob))`,
		})
		.from(workspaceWriteLeases)
		.where(eq(workspaceWriteLeases.leaseId, leaseId))
		.get();
	if (!header) conflict("Recovery lease no longer exists");
	if (header.bytes > WORKSPACE_LEASE_LIMITS.manifestBytes)
		throw new AppError("Recovery manifest exceeds the byte limit", 413, "RECOVERY_MANIFEST_LIMIT");
	const lease = database
		.select({ manifest: workspaceWriteLeases.mutationManifestJson })
		.from(workspaceWriteLeases)
		.where(eq(workspaceWriteLeases.leaseId, leaseId))
		.get();
	if (!lease) conflict("Recovery lease no longer exists");
	if (lease.manifest.version !== 1) conflict("Unsupported recovery manifest version");
	return lease.manifest.mutations;
}
function recoveryEffects(
	database: Database,
	scope: ScopeRow,
	leaseId: string | null,
): RecoveryEffect[] {
	const manifest = leaseId ? leaseManifest(database, leaseId) : null;
	if (manifest && manifest.length > WORKSPACE_RECOVERY_LIMITS.manifestMutations)
		throw new AppError(
			"Recovery manifest exceeds the mutation limit",
			413,
			"RECOVERY_MUTATION_LIMIT",
		);
	const effectIds = manifest
		? [...new Set(manifest.flatMap((entry) => (entry.effectId ? [entry.effectId] : [])))]
		: null;
	const operationIds = manifest
		? [
				...new Set(
					manifest.flatMap((entry) =>
						!entry.effectId && entry.operationId ? [entry.operationId] : [],
					),
				),
			]
		: [];
	const effects: RecoveryEffect[] = database
		.select(effectColumns)
		.from(fileChangeEffects)
		.where(
			and(
				eq(fileChangeEffects.scopeId, scope.id),
				effectIds
					? or(
							inArray(fileChangeEffects.id, effectIds),
							inArray(fileChangeEffects.operationId, operationIds),
						)
					: ne(fileChangeEffects.settlement, "settled"),
			),
		)
		.orderBy(asc(fileChangeEffects.id))
		.limit(WORKSPACE_RECOVERY_LIMITS.files + 1)
		.all();
	if (effects.length > WORKSPACE_RECOVERY_LIMITS.files)
		throw new AppError("Recovery exceeds the file limit", 413, "RECOVERY_FILE_LIMIT");
	if (leaseId) {
		for (const effect of effects) if (effect.settlement === "settled") effect.alreadySettled = true;
		if (effectIds?.some((id) => !effects.some((effect) => effect.id === id)))
			conflict("Recovery manifest references missing effects");
	}
	if (!leaseId) {
		// Metadata first: never parse an unbounded audit history or silently trust
		// only the latest (potentially empty) retry from the old two-commit release.
		const audits = database
			.select({
				id: fileChangeScopeRecoveries.id,
				bytes: sql<number>`length(cast(${fileChangeScopeRecoveries.effectDecisionsJson} as blob))`,
			})
			.from(fileChangeScopeRecoveries)
			.where(
				and(
					eq(fileChangeScopeRecoveries.scopeId, scope.id),
					isNull(fileChangeScopeRecoveries.workspaceLeaseId),
					eq(fileChangeScopeRecoveries.scopeRevisionBefore, scope.revision),
					eq(fileChangeScopeRecoveries.fencingTokenBefore, scope.fencingToken),
				),
			)
			.orderBy(desc(fileChangeScopeRecoveries.createdAt), desc(fileChangeScopeRecoveries.id))
			.limit(WORKSPACE_RECOVERY_LIMITS.legacyAudits + 1)
			.all();
		if (
			audits.length > WORKSPACE_RECOVERY_LIMITS.legacyAudits ||
			audits.reduce((sum, audit) => sum + audit.bytes, 0) > WORKSPACE_RECOVERY_LIMITS.metadataBytes
		)
			throw new AppError(
				"Matching legacy audits exceed the recovery budget",
				413,
				"RECOVERY_AUDIT_LIMIT",
			);
		const decisions = new Map<string, FileChangeRecoveryDecision>();
		for (const header of audits) {
			const audit = database
				.select({ decisions: fileChangeScopeRecoveries.effectDecisionsJson })
				.from(fileChangeScopeRecoveries)
				.where(eq(fileChangeScopeRecoveries.id, header.id))
				.get();
			if (!audit) conflict("Legacy recovery audit disappeared");
			if (audit.decisions.length > WORKSPACE_RECOVERY_LIMITS.files)
				throw new AppError("Legacy audit exceeds the file limit", 413, "RECOVERY_FILE_LIMIT");
			for (const decision of audit.decisions)
				if (!decisions.has(decision.effectId)) decisions.set(decision.effectId, decision);
			if (decisions.size > WORKSPACE_RECOVERY_LIMITS.files)
				throw new AppError(
					"Legacy audit effects exceed the file limit",
					413,
					"RECOVERY_FILE_LIMIT",
				);
		}
		{
			const existing = new Set(effects.map((effect) => effect.id));
			for (const decision of decisions.values()) {
				if (existing.has(decision.effectId)) continue;
				const effect = database
					.select(effectColumns)
					.from(fileChangeEffects)
					.where(
						and(
							eq(fileChangeEffects.id, decision.effectId),
							eq(fileChangeEffects.scopeId, scope.id),
						),
					)
					.get();
				if (!effect || effect.identityJson.canonicalPath !== decision.canonicalPath)
					conflict("Legacy recovery evidence is missing or has changed");
				effects.push({
					...effect,
					alreadySettled: effect.settlement === "settled",
					historicallyDispatched: decision.verdict !== "not_dispatched",
				});
				existing.add(effect.id);
			}
		}
	}
	if (effects.length > WORKSPACE_RECOVERY_LIMITS.files)
		throw new AppError("Recovery exceeds the file limit", 413, "RECOVERY_FILE_LIMIT");
	if (Buffer.byteLength(JSON.stringify(effects)) > WORKSPACE_RECOVERY_LIMITS.metadataBytes)
		throw new AppError(
			"Recovery evidence metadata exceeds the byte limit",
			413,
			"RECOVERY_METADATA_LIMIT",
		);
	return effects.sort((a, b) => a.id.localeCompare(b.id));
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

export function createWorkspaceScopeRecovery(deps: WorkspaceScopeRecoveryDeps) {
	const { database, getRuntime } = deps;
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
			const rows = database
				.select({ id: workspaceWriteLeases.leaseId, scopeId: workspaceWriteLeases.scopeId })
				.from(workspaceWriteLeases)
				.where(
					and(
						inArray(workspaceWriteLeases.status, ["quarantined", "executing"]),
						after ? gt(workspaceWriteLeases.leaseId, after) : undefined,
					),
				)
				.orderBy(asc(workspaceWriteLeases.leaseId))
				.limit(WORKSPACE_RECOVERY_LIMITS.pageItems + 1)
				.all();
			for (const lease of rows.slice(0, WORKSPACE_RECOVERY_LIMITS.pageItems))
				targets.push({ scope: requireScopeRow(database, lease.scopeId), leaseId: lease.id });
			nextCursor =
				rows.length > WORKSPACE_RECOVERY_LIMITS.pageItems
					? `lease:${rows[WORKSPACE_RECOVERY_LIMITS.pageItems - 1]?.id}`
					: "scope:";
		} else {
			const rows = database
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
				.limit(WORKSPACE_RECOVERY_LIMITS.pageItems + 1)
				.all();
			for (const scope of rows.slice(0, WORKSPACE_RECOVERY_LIMITS.pageItems)) {
				if (
					scope.activeLeaseId &&
					database
						.select({ id: workspaceWriteLeases.leaseId })
						.from(workspaceWriteLeases)
						.where(eq(workspaceWriteLeases.leaseId, scope.activeLeaseId))
						.get()
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
			let blockedReason: string | null = null;
			if (leaseId) {
				const row = database
					.select({
						ranges: workspaceWriteLeases.rangesJson,
						ended: workspaceWriteLeases.executionEndedAt,
					})
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.leaseId, leaseId))
					.get();
				if (row) {
					ranges = [...row.ranges.ranges];
					executionEnded = row.ended !== null;
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
			}
			let effects: RecoveryEffect[] = [];
			try {
				effects = recoveryEffects(database, scope, leaseId);
			} catch (error) {
				blockedReason = error instanceof Error ? error.message : String(error);
			}
			const operations = [...new Set(effects.map((effect) => effect.operationId))].flatMap(
				(operationId) =>
					database
						.select({
							operationId: fileChangeOperations.id,
							sourceKind: fileChangeOperations.sourceKind,
							narratorId: fileChangeOperations.narratorId,
							toolCallId: fileChangeOperations.toolCallId,
							startedAt: fileChangeOperations.startedAt,
						})
						.from(fileChangeOperations)
						.where(eq(fileChangeOperations.id, operationId))
						.all(),
			);
			const item: WorkspaceBarrier = {
				scope: scopeSummary(scope),
				leaseId,
				kind: leaseId ? "quarantined" : barrierKind(scope),
				local: scope.deviceId === LOCAL_DEVICE_ID,
				ranges,
				executionEnded,
				blockedReason,
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
	) {
		const runtime = await getRuntime();
		const scope = requireScopeRow(database, scopeId);
		const leaseId = resolveLeaseId(database, scope, requestedLeaseId);
		requireLocal(scope);
		const started = performance.now();
		const bounded = boundedSignal(limits.durationMs, signal);
		try {
			bounded.throwIfAborted();
			const reservation = runtime.coordinator.reserveRecovery({
				scope: scopeIdentity(scope),
				leaseId: leaseId ?? undefined,
			});
			try {
				const effects = recoveryEffects(database, scope, leaseId ?? null);
				const rootIdentity =
					!leaseId && barrierKind(scope) === "unverified_root"
						? await localDirectoryIdentity(scope.canonicalRoot)
						: null;
				assertObservationObjectLimit(effects, reservation.ranges);
				const budget = { bytes: 0, signal: bounded, limits };
				const observations = await observeEffects(effects, budget);
				const rangeObservations = await observeRanges(reservation.ranges, effects, budget);
				bounded.throwIfAborted();
				return {
					scope: scopeSummary(scope),
					leaseId: leaseId ?? null,
					observations,
					rangeObservations,
					confirmationToken: confirmationToken({
						scopeId,
						leaseId: leaseId ?? null,
						generation: reservation.generation,
						effects,
						observations,
						rangeObservations,
						rootIdentity,
					}),
				};
			} finally {
				reservation.release();
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

	async function recoverWorkspaceBarrier(input: WorkspaceRecoveryInput) {
		const runtime = await getRuntime();
		const scope = requireScopeRow(database, input.scopeId);
		const leaseId = resolveLeaseId(database, scope, input.leaseId);
		requireLocal(scope);
		const started = performance.now();
		const signal = boundedSignal(limits.durationMs, input.signal);
		try {
			signal.throwIfAborted();
			const reservation = runtime.coordinator.reserveRecovery({
				scope: scopeIdentity(scope),
				leaseId: leaseId ?? undefined,
			});
			try {
				const effects = recoveryEffects(database, scope, leaseId ?? null);
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
					JSON.stringify(recoveryEffects(database, scope, leaseId ?? null))
				)
					conflict("Recovery evidence changed during observation");
				let settledEffectCount = 0;
				reservation.complete((tx) => {
					if (rootIdentity)
						runtime.evidence.recordScopeVerification(
							{
								scopeId: scope.id,
								canonicalRoot: scope.canonicalRoot,
								rootIdentity: { object: rootIdentity },
							},
							tx,
						);
					else {
						const manifest = leaseId ? leaseManifest(database, leaseId) : [];
						settledEffectCount = runtime.evidence.closeBooksForRecovery(
							{
								scopeId: scope.id,
								workspaceLeaseId: leaseId ?? null,
								recoveredByUserId: input.recoveredByUserId,
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
				const cleared = requireScopeRow(database, scope.id);
				return {
					recovered: rootIdentity ? ("root_verified" as const) : ("barrier_cleared" as const),
					settledEffectCount,
					revision: cleared.revision,
					fencingToken: cleared.fencingToken,
				};
			} finally {
				reservation.release();
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
	return { listWorkspaceBarriers, observeWorkspaceBarrier, recoverWorkspaceBarrier };
}

async function defaultRecovery() {
	const { db } = await import("../db");
	return createWorkspaceScopeRecovery({
		database: db,
		getRuntime: getDefaultLocalFileChangeRuntime,
	});
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
