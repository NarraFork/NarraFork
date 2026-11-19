import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	type FileChangeActor,
	type FileChangeBlobRef,
	type FileChangeEffect,
	hasSettledMeasuredFileEffect,
} from "../../shared/file-change-protocol";
import {
	fileAttributions,
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
} from "../db/schema";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import type { CurrentFileBaseline, CurrentGitBaseline } from "./git-current-baseline";

type Reader = ReturnType<typeof drizzle>;
const LOCAL_DEVICE_ID = "local";
const METADATA_BYTES = 8192;
const EFFECT_WINDOW = 10;
function incarnation(source: string, root: string, object?: string): string {
	const digest = createHash("sha256");
	for (const part of object === undefined ? [source, root] : [source, root, object])
		digest.update(`${Buffer.byteLength(part)}:`).update(part);
	return digest.digest("hex");
}
function scopeFor(db: Reader, baseline: CurrentGitBaseline) {
	if (!baseline.sourceInstanceId) return undefined;
	return db
		.select()
		.from(fileChangeScopes)
		.where(
			and(
				eq(fileChangeScopes.sourceInstanceId, baseline.sourceInstanceId),
				eq(fileChangeScopes.deviceId, LOCAL_DEVICE_ID),
				eq(fileChangeScopes.canonicalRoot, baseline.canonicalRoot),
				inArray(fileChangeScopes.workspaceInstanceId, [
					incarnation(baseline.sourceInstanceId, baseline.canonicalRoot),
					incarnation(baseline.sourceInstanceId, baseline.canonicalRoot, baseline.rootIdentity),
				]),
			),
		)
		.orderBy(desc(fileChangeScopes.updatedAt), desc(fileChangeScopes.id))
		.limit(1)
		.get();
}
function rawRefs(effect: FileChangeEffect): FileChangeBlobRef[] {
	return [effect.before, effect.intendedAfter, effect.observedAfter].flatMap((state) =>
		state.kind === "regular" ? [state.blob] : state.kind === "symlink" ? [state.target] : [],
	);
}
type Candidate = {
	effect: FileChangeEffect;
	actor: FileChangeActor;
	subagentType: string | null;
	updatedAt: string;
};
function candidate(
	db: Reader,
	id: string,
	scope: NonNullable<ReturnType<typeof scopeFor>>,
	file: CurrentFileBaseline,
): Candidate | undefined {
	const row = db
		.select()
		.from(fileChangeEffects)
		.where(
			and(
				eq(fileChangeEffects.id, id),
				sql`length(cast(${fileChangeEffects.identityJson} as blob)) <= ${METADATA_BYTES}`,
				sql`length(cast(${fileChangeEffects.beforeStateJson} as blob)) <= ${METADATA_BYTES}`,
				sql`length(cast(${fileChangeEffects.intendedAfterStateJson} as blob)) <= ${METADATA_BYTES}`,
				sql`length(cast(${fileChangeEffects.observedAfterStateJson} as blob)) <= ${METADATA_BYTES}`,
				sql`(${fileChangeEffects.executionReceiptJson} IS NULL OR length(cast(${fileChangeEffects.executionReceiptJson} as blob)) <= ${METADATA_BYTES})`,
			),
		)
		.limit(1)
		.get();
	if (!row) return undefined;
	const operation = db
		.select({
			id: fileChangeOperations.id,
			attempt: fileChangeOperations.attempt,
			source: fileChangeOperations.sourceInstanceId,
			kind: fileChangeOperations.sourceKind,
			actor: fileChangeOperations.actorJson,
			coverage: fileChangeOperations.coverage,
			settlement: fileChangeOperations.settlement,
		})
		.from(fileChangeOperations)
		.where(
			and(
				eq(fileChangeOperations.id, row.operationId),
				sql`length(cast(${fileChangeOperations.actorJson} as blob)) <= ${METADATA_BYTES}`,
			),
		)
		.limit(1)
		.get();
	const projection = db
		.select({
			action: fileAttributions.action,
			operationId: fileAttributions.operationId,
			scopeId: fileAttributions.scopeId,
			fileKey: fileAttributions.fileKey,
			subagentType: fileAttributions.subagentType,
		})
		.from(fileAttributions)
		.where(eq(fileAttributions.effectId, row.id))
		.limit(1)
		.get();
	if (
		!operation ||
		operation.source !== scope.sourceInstanceId ||
		operation.settlement !== "settled" ||
		operation.coverage !== "complete" ||
		!projection ||
		projection.scopeId !== scope.id ||
		projection.fileKey !== row.fileKey ||
		projection.operationId !== operation.id
	)
		return undefined;
	if (
		operation.kind === "editor"
			? projection.action !== "human" || operation.actor.kind !== "human"
			: operation.kind !== "tool" ||
				!["write", "edit"].includes(projection.action) ||
				!["primary", "subagent"].includes(operation.actor.kind)
	)
		return undefined;
	const identity = row.identityJson;
	if (
		identity.scopeId !== scope.id ||
		identity.sourceInstanceId !== scope.sourceInstanceId ||
		identity.deviceId !== LOCAL_DEVICE_ID ||
		identity.workspaceInstanceId !== scope.workspaceInstanceId ||
		identity.canonicalPath !== file.canonicalPath ||
		identity.objectRole !== "referent" ||
		identity.pathFlavor !== scope.pathFlavor ||
		row.phase !== "apply" ||
		row.outcome !== "changed"
	)
		return undefined;
	const effect: FileChangeEffect = {
		id: row.id,
		operationId: row.operationId,
		attempt: operation.attempt,
		mutationId: row.mutationId,
		requestDigest: row.requestDigest,
		phase: row.phase,
		identity,
		before: row.beforeStateJson,
		intendedAfter: row.intendedAfterStateJson,
		observedAfter: row.observedAfterStateJson,
		outcome: row.outcome,
		diskOutcome: row.diskOutcome,
		settlement: row.settlement,
		attribution: row.attributionGrade,
		executionConfirmed: row.executionConfirmed,
		executionReceipt: row.executionReceiptJson,
		linesAdded: row.linesAdded,
		linesRemoved: row.linesRemoved,
	};
	if (
		!hasSettledMeasuredFileEffect(effect) ||
		effect.observedAfter.kind !== "regular" ||
		effect.observedAfter.mode === null
	)
		return undefined;
	for (const ref of rawRefs(effect)) {
		const blob = db
			.select({ size: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, ref.digest))
			.limit(1)
			.get();
		if (!blob || blob.status !== "ready" || blob.size !== ref.sizeBytes) return undefined;
	}
	return {
		effect,
		actor: operation.actor,
		subagentType: projection.subagentType,
		updatedAt: row.updatedAt,
	};
}
function readObservations(db: Reader, canonicalRoot: string, filePath: string) {
	return db
		.select({
			id: fileAttributions.id,
			rowId: sql<number>`${fileAttributions}.rowid`,
			effectId: fileAttributions.effectId,
			action: fileAttributions.action,
			grade: fileAttributions.attributionGrade,
			changedAt: fileAttributions.changedAt,
		})
		.from(fileAttributions)
		.where(
			and(
				eq(fileAttributions.deviceId, LOCAL_DEVICE_ID),
				eq(fileAttributions.workspacePath, canonicalRoot),
				eq(fileAttributions.filePath, filePath),
			),
		)
		.orderBy(desc(fileAttributions.changedAt), sql`${fileAttributions}.rowid desc`)
		.limit(EFFECT_WINDOW + 1)
		.all();
}
export interface GitEvidenceInput {
	baseline: CurrentGitBaseline;
}
/** Evidence only: Git fingerprints and stale-view decisions remain with the caller. */
export function readGitCurrentDiffEvidence(
	sqlite: Database,
	input: GitEvidenceInput,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const db = drizzle(sqlite);
	const scope = scopeFor(db, input.baseline) ?? null;
	const files = input.baseline.files.map((file) => {
		signal.throwIfAborted();
		if (!scope)
			return {
				filePath: file.filePath,
				summaries: [],
				observations: [],
				candidates: [] as Candidate[],
			};
		const fileKey = fileChangeIdentityKey(
			createFileChangeIdentity(scope, {
				deviceId: LOCAL_DEVICE_ID,
				pathFlavor: scope.pathFlavor,
				canonicalPath: file.canonicalPath,
				lexicalPath: file.canonicalPath,
				objectRole: "referent",
			}),
		);
		const summaries = db
			.select({
				id: fileChangeEffects.id,
				digest: fileChangeEffects.observedAfterBlobDigest,
				revision: fileChangeEffects.scopeRevision,
				journalSeq: fileChangeEffects.journalSeq,
				settlement: fileChangeEffects.settlement,
				confirmed: fileChangeEffects.executionConfirmed,
				grade: fileChangeEffects.attributionGrade,
				phase: fileChangeEffects.phase,
			})
			.from(fileChangeEffects)
			.where(and(eq(fileChangeEffects.scopeId, scope.id), eq(fileChangeEffects.fileKey, fileKey)))
			.orderBy(
				desc(fileChangeEffects.journalSeq),
				desc(fileChangeEffects.scopeRevision),
				desc(fileChangeEffects.id),
			)
			.limit(EFFECT_WINDOW + 1)
			.all();
		const selected = new Set<string | undefined>([summaries[0]?.id]);
		if (file.indexState.kind === "regular") {
			const digest = file.indexState.blob.digest;
			selected.add(summaries.find((row) => row.digest === digest)?.id);
		}
		const candidates = [...selected].flatMap((id) => {
			signal.throwIfAborted();
			if (!id) return [];
			const item = candidate(db, id, scope, file);
			return item ? [item] : [];
		});
		return {
			filePath: file.filePath,
			summaries,
			observations: readObservations(db, input.baseline.canonicalRoot, file.filePath),
			candidates,
		};
	});
	return { scope, files };
}
export type GitEvidenceSnapshot = ReturnType<typeof readGitCurrentDiffEvidence>;
