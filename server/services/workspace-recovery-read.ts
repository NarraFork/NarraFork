import type { Database as SqliteDatabase } from "bun:sqlite";
import type { FileChangeRecoveryDecision } from "@shared/file-change-protocol";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { fileChangeEffects, fileChangeScopeRecoveries, workspaceWriteLeases } from "../db/schema";
import { AppError } from "../lib/errors";
import { WORKSPACE_LEASE_LIMITS } from "./workspace-write-lease-store";

type Database = Pick<BunSQLiteDatabase, "select">;
export interface WorkspaceRecoveryReadParams {
	kind: "workspace-recovery-effects-v1";
	scope: { id: string; revision: number; fencingToken: number };
	leaseId: string | null;
	limits: { manifestMutations: number; files: number; legacyAudits: number; metadataBytes: number };
}
function conflict(message: string): never {
	throw new AppError(message, 409, "RECOVERY_CONFLICT");
}
const effectColumns = {
	id: fileChangeEffects.id,
	operationId: fileChangeEffects.operationId,
	identityJson: fileChangeEffects.identityJson,
	beforeStateJson: fileChangeEffects.beforeStateJson,
	intendedAfterStateJson: fileChangeEffects.intendedAfterStateJson,
	settlement: fileChangeEffects.settlement,
	updatedAt: fileChangeEffects.updatedAt,
};
export type RecoveryEffect = {
	[K in keyof typeof effectColumns]: (typeof fileChangeEffects.$inferSelect)[K];
} & {
	/** Current-state comparison only: never infer an original dispatch from a settled row. */
	alreadySettled?: boolean;
	historicallyDispatched?: boolean;
};

/** Legacy releases used two commits. Recover the exact audit's effect set, not an empty prefix. */
export function leaseManifest(database: Database, leaseId: string) {
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
export function recoveryEffects(
	database: Database,
	scope: WorkspaceRecoveryReadParams["scope"],
	leaseId: string | null,
	limits: WorkspaceRecoveryReadParams["limits"],
): RecoveryEffect[] {
	const manifest = leaseId ? leaseManifest(database, leaseId) : null;
	if (manifest && manifest.length > limits.manifestMutations)
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
		.limit(limits.files + 1)
		.all();
	if (effects.length > limits.files)
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
			.limit(limits.legacyAudits + 1)
			.all();
		if (
			audits.length > limits.legacyAudits ||
			audits.reduce((sum, audit) => sum + audit.bytes, 0) > limits.metadataBytes
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
			if (audit.decisions.length > limits.files)
				throw new AppError("Legacy audit exceeds the file limit", 413, "RECOVERY_FILE_LIMIT");
			for (const decision of audit.decisions)
				if (!decisions.has(decision.effectId)) decisions.set(decision.effectId, decision);
			if (decisions.size > limits.files)
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
	if (effects.length > limits.files)
		throw new AppError("Recovery exceeds the file limit", 413, "RECOVERY_FILE_LIMIT");
	if (Buffer.byteLength(JSON.stringify(effects)) > limits.metadataBytes)
		throw new AppError(
			"Recovery evidence metadata exceeds the byte limit",
			413,
			"RECOVERY_METADATA_LIMIT",
		);
	return effects.sort((a, b) => a.id.localeCompare(b.id));
}

export function runWorkspaceRecoveryRead(
	sqlite: SqliteDatabase,
	params: WorkspaceRecoveryReadParams,
	signal: AbortSignal,
): RecoveryEffect[] {
	signal.throwIfAborted();
	return sqlite.transaction(() =>
		recoveryEffects(drizzle(sqlite), params.scope, params.leaseId, params.limits),
	)();
}
