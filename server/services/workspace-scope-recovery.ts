import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRecoveryDecision,
	type FileChangeRecoveryVerdict,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import type { db as defaultDb } from "../db";
import { fileChangeEffects, fileChangeOperations, fileChangeScopes } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";
import type { FileChangeScopeIdentity } from "./file-change-identity";
import { fileChangeLocalIo, localDirectoryIdentity } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
} from "./file-change-runtime";
import { WORKSPACE_WRITE_COORDINATOR_LIMITS } from "./workspace-write-coordinator";

/**
 * External recovery for durable workspace write barriers ("needs_verification"
 * scopes and dead-epoch leases). The coordinator deliberately has NO automatic
 * recovery: only a human who has seen the re-observed physical state may close
 * the books. This service is that human-driven entry point. It NEVER writes to
 * the physical workspace: observe is read-only, and recover only finalizes
 * evidence bookkeeping (receipts stay frozen) and then clears the barrier.
 *
 * Dependencies are injectable for tests; the exported route-facing functions
 * bind the application database and the default local runtime.
 */

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
	/** Dispatched effects may have touched the physical file; others never reached IO. */
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
	/** "unverified_root": prepared but never root-verified; "quarantined": uncertain work. */
	kind: "quarantined" | "unverified_root";
	local: boolean;
	operations: WorkspaceBarrierOperationSummary[];
	effects: WorkspaceBarrierEffectSummary[];
}

export interface WorkspaceBarrierObservation {
	effectId: string;
	canonicalPath: string;
	displayPath: string;
	verdict: FileChangeRecoveryVerdict;
	actualKind: "absent" | "regular" | "unobservable";
	observedDigest: string | null;
	observedSizeBytes: number | null;
}

export interface WorkspaceScopeRecoveryDeps {
	database: Pick<typeof defaultDb, "select">;
	getRuntime(): Promise<Pick<LocalFileChangeRuntime, "coordinator" | "evidence">>;
}

type ScopeRow = typeof fileChangeScopes.$inferSelect;
type EffectRow = typeof fileChangeEffects.$inferSelect;
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

function isDispatched(effect: EffectRow): boolean {
	return effect.settlement === "applying" || effect.settlement === "reconcile_required";
}

function unsettledEffects(database: Database, scopeId: string): EffectRow[] {
	return database
		.select()
		.from(fileChangeEffects)
		.where(and(eq(fileChangeEffects.scopeId, scopeId), ne(fileChangeEffects.settlement, "settled")))
		.limit(FILE_CHANGE_LIMITS.revertFiles + 1)
		.all();
}

function effectSummary(effect: EffectRow): WorkspaceBarrierEffectSummary {
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

function barrierKind(row: ScopeRow): "quarantined" | "unverified_root" {
	return row.status === "needs_verification" && row.activeLeaseId === null
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

interface ActualObservation {
	kind: "absent" | "regular" | "unobservable";
	state: FileChangeState | null;
	digest: string | null;
	sizeBytes: number | null;
}

/** Read-only physical observation with the evidence byte cap enforced BEFORE reading. */
async function readActual(canonicalPath: string, signal?: AbortSignal): Promise<ActualObservation> {
	try {
		signal?.throwIfAborted();
		let entry: BigIntStats;
		try {
			entry = await lstat(canonicalPath, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { kind: "absent", state: { kind: "absent" }, digest: null, sizeBytes: null };
			}
			throw error;
		}
		// A symlink entry and its referent are different recovery objects; the
		// evidence pipeline only models regular files here, so anything else is
		// reported as unobservable for a human to inspect, never guessed.
		if (entry.isSymbolicLink() || !entry.isFile()) {
			return { kind: "unobservable", state: null, digest: null, sizeBytes: null };
		}
		if (entry.size > BigInt(FILE_CHANGE_LIMITS.blobBytes)) {
			return { kind: "unobservable", state: null, digest: null, sizeBytes: null };
		}
		const observed = await fileChangeLocalIo.read(canonicalPath, signal);
		if (observed.bytes === null) {
			return { kind: "absent", state: { kind: "absent" }, digest: null, sizeBytes: null };
		}
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
		};
	} catch {
		return { kind: "unobservable", state: null, digest: null, sizeBytes: null };
	}
}

async function observeEffects(
	database: Database,
	scopeId: string,
	signal?: AbortSignal,
): Promise<WorkspaceBarrierObservation[]> {
	const effects = unsettledEffects(database, scopeId);
	const observations: WorkspaceBarrierObservation[] = [];
	for (const effect of effects) {
		const identity = effect.identityJson;
		const actual = await readActual(identity.canonicalPath, signal);
		let verdict: FileChangeRecoveryVerdict;
		if (!isDispatched(effect)) verdict = "not_dispatched";
		else if (actual.kind === "unobservable" || actual.state === null) verdict = "unobservable";
		else if (fileChangeStatesEqual(actual.state, effect.intendedAfterStateJson))
			verdict = "applied";
		else if (fileChangeStatesEqual(actual.state, effect.beforeStateJson)) verdict = "not_applied";
		else verdict = "foreign";
		observations.push({
			effectId: effect.id,
			canonicalPath: identity.canonicalPath,
			displayPath: identity.displayPath,
			verdict,
			actualKind: actual.kind,
			observedDigest: actual.digest,
			observedSizeBytes: actual.sizeBytes,
		});
	}
	return observations;
}

export function createWorkspaceScopeRecovery(deps: WorkspaceScopeRecoveryDeps) {
	const { database, getRuntime } = deps;

	/** Bounded inventory; summary columns only, never blob bodies or raw receipts. */
	async function listWorkspaceBarriers(): Promise<{ items: WorkspaceBarrier[] }> {
		const runtime = await getRuntime();
		const epoch = runtime.coordinator.ownerEpoch();
		const rows = database
			.select()
			.from(fileChangeScopes)
			.where(
				or(
					eq(fileChangeScopes.status, "needs_verification"),
					isNotNull(fileChangeScopes.activeLeaseId),
				),
			)
			.limit(WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes + 1)
			.all();
		const items: WorkspaceBarrier[] = [];
		for (const row of rows) {
			// A lease owned by the LIVE epoch belongs to this running process; it is
			// ordinary in-flight work, never a recovery barrier.
			const liveLease = row.activeLeaseId !== null && row.activeLeaseEpoch === epoch;
			if (row.status !== "needs_verification" && (row.activeLeaseId === null || liveLease))
				continue;
			const effects = unsettledEffects(database, row.id);
			const operationIds = [...new Set(effects.map((effect) => effect.operationId))];
			// operationIds is bounded by revertFiles; a per-id lookup keeps the plan indexed.
			const operations = operationIds.flatMap((operationId) =>
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
			items.push({
				scope: scopeSummary(row),
				kind: barrierKind(row),
				local: row.deviceId === LOCAL_DEVICE_ID,
				operations,
				effects: effects.map(effectSummary),
			});
		}
		return { items };
	}

	/** Read-only per-effect verdicts for the confirmation UI. Never mutates anything. */
	async function observeWorkspaceBarrier(
		scopeId: string,
		signal?: AbortSignal,
	): Promise<{ scope: WorkspaceBarrierScopeSummary; observations: WorkspaceBarrierObservation[] }> {
		const scope = requireScopeRow(database, scopeId);
		if (scope.deviceId !== LOCAL_DEVICE_ID) {
			throw new AppError(
				"Physical re-observation is only available on the server's local device",
				400,
				"REMOTE_DEVICE_UNSUPPORTED",
			);
		}
		return {
			scope: scopeSummary(scope),
			observations: await observeEffects(database, scopeId, signal),
		};
	}

	/**
	 * Human-confirmed recovery. Re-observes everything first (TOCTOU guard: the
	 * acknowledged verdicts must still match), closes the evidence books, and only
	 * then clears the durable barrier. Settle-first ordering is fail-safe: a
	 * failure leaves the barrier in place and the whole call can be retried.
	 */
	async function recoverWorkspaceBarrier(input: {
		scopeId: string;
		recoveredByUserId: string;
		acknowledgements: { effectId: string; verdict: FileChangeRecoveryVerdict }[];
		acknowledgeInspected?: boolean;
		signal?: AbortSignal;
	}): Promise<{
		recovered: "barrier_cleared" | "root_verified";
		settledEffectCount: number;
		revision?: number;
		fencingToken?: number;
	}> {
		const runtime = await getRuntime();
		const scope = requireScopeRow(database, input.scopeId);
		if (scope.deviceId !== LOCAL_DEVICE_ID) {
			throw new AppError(
				"Recovery of a remote-device barrier is not supported yet",
				400,
				"REMOTE_DEVICE_UNSUPPORTED",
			);
		}
		if (barrierKind(scope) === "unverified_root") {
			// Prepared but never root-verified: re-measure the actual root identity and
			// record THAT verification. A missing root cannot be verified into existence.
			const rootIdentity = await localDirectoryIdentity(scope.canonicalRoot);
			runtime.evidence.recordScopeVerification({
				scopeId: scope.id,
				canonicalRoot: scope.canonicalRoot,
				rootIdentity: { object: rootIdentity },
			});
			return { recovered: "root_verified", settledEffectCount: 0 };
		}
		const observations = await observeEffects(database, scope.id, input.signal);
		const acknowledgements = new Map(
			input.acknowledgements.map((ack) => [ack.effectId, ack.verdict]),
		);
		for (const observation of observations) {
			const acknowledged = acknowledgements.get(observation.effectId);
			if (!acknowledged) {
				throw new AppError(
					`Effect ${observation.effectId} ("${observation.displayPath}") has no acknowledgement`,
					400,
					"ACK_REQUIRED",
				);
			}
			if (acknowledged !== observation.verdict) {
				throw new AppError(
					`The physical state of "${observation.displayPath}" changed since the preview; ` +
						"re-observe and confirm the new verdicts",
					409,
					"OBSERVATION_CHANGED",
				);
			}
		}
		if (observations.length === 0 && input.acknowledgeInspected !== true) {
			throw new AppError(
				"This barrier has no recorded effects; confirm that you inspected the directory yourself",
				400,
				"ACK_REQUIRED",
			);
		}
		const decisions: FileChangeRecoveryDecision[] = observations.map((observation) => ({
			effectId: observation.effectId,
			canonicalPath: observation.canonicalPath,
			verdict: observation.verdict,
			observedDigest: observation.observedDigest,
			observedSizeBytes: observation.observedSizeBytes,
		}));
		const { settledEffectCount } = runtime.evidence.closeBooksForRecovery({
			scopeId: scope.id,
			recoveredByUserId: input.recoveredByUserId,
			decisions,
		});
		const cleared = runtime.coordinator.recoverScopeBarrier(scopeIdentity(scope));
		return {
			recovered: "barrier_cleared",
			settledEffectCount,
			revision: cleared.revision,
			fencingToken: cleared.fencingToken,
		};
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

export async function listWorkspaceBarriers() {
	return (await defaultRecovery()).listWorkspaceBarriers();
}

export async function observeWorkspaceBarrier(scopeId: string, signal?: AbortSignal) {
	return (await defaultRecovery()).observeWorkspaceBarrier(scopeId, signal);
}

export async function recoverWorkspaceBarrier(input: {
	scopeId: string;
	recoveredByUserId: string;
	acknowledgements: { effectId: string; verdict: FileChangeRecoveryVerdict }[];
	acknowledgeInspected?: boolean;
	signal?: AbortSignal;
}) {
	return (await defaultRecovery()).recoverWorkspaceBarrier(input);
}
