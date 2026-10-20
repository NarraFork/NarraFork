/** Connection-injected evidence reads; each task observes one SQLite snapshot. */
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

const LOCAL_DEVICE_ID = "local";
const EFFECT_WINDOW = 10;
const METADATA_BYTES = 8192;
type ReadDatabase = ReturnType<typeof drizzle>;
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function incarnation(source: string, root: string, object: string): string {
	const digest = createHash("sha256");
	for (const part of [source, root, object])
		digest.update(`${Buffer.byteLength(part)}:`).update(part);
	return digest.digest("hex");
}
function scopeFor(db: ReadDatabase, baseline: CurrentGitBaseline) {
	const sourceInstanceId = baseline.sourceInstanceId;
	if (!sourceInstanceId) return undefined;
	const scope = db
		.select()
		.from(fileChangeScopes)
		.where(
			and(
				eq(fileChangeScopes.sourceInstanceId, sourceInstanceId),
				eq(fileChangeScopes.deviceId, LOCAL_DEVICE_ID),
				eq(
					fileChangeScopes.workspaceInstanceId,
					incarnation(sourceInstanceId, baseline.canonicalRoot, baseline.rootIdentity),
				),
			),
		)
		.limit(1)
		.get();
	if (
		!scope ||
		scope.status !== "active" ||
		scope.canonicalRoot !== baseline.canonicalRoot ||
		scope.rootIdentityJson?.object !== baseline.rootIdentity ||
		scope.activeMutationCount !== 0 ||
		scope.activeLeaseId !== null
	)
		return undefined;
	return scope;
}
function scopeVersion(scope: ReturnType<typeof scopeFor>): string {
	return hash(
		scope
			? [
					scope.id,
					scope.sourceInstanceId,
					scope.workspaceInstanceId,
					scope.revision,
					scope.fencingToken,
					scope.activeLeaseId,
					scope.activeMutationCount,
					scope.status,
				]
			: null,
	);
}
function rawRefs(effect: FileChangeEffect): FileChangeBlobRef[] {
	return [effect.before, effect.intendedAfter, effect.observedAfter].flatMap((state) =>
		state.kind === "regular" ? [state.blob] : state.kind === "symlink" ? [state.target] : [],
	);
}

export type Candidate = {
	effect: FileChangeEffect;
	actor: FileChangeActor;
	subagentType: string | null;
	updatedAt: string;
};
function candidate(
	db: ReadDatabase,
	id: string,
	scope: NonNullable<ReturnType<typeof scopeFor>>,
	file: CurrentFileBaseline,
): Candidate | undefined {
	// Every selected JSON field is independently bounded before SQLite returns it.
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
				sql`length(cast(${fileChangeEffects.executionReceiptJson} as blob)) <= ${METADATA_BYTES}`,
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
		row.scopeRevision > scope.revision ||
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
	// At most three refs from the bounded state metadata: <=3 digest parameters
	// and rows, <=24KiB of digests plus numeric sizes, never raw blob bytes. Check each
	// original ref's size even when before/intended/observed share a digest.
	const refs = rawRefs(effect);
	const digests = [...new Set(refs.map((ref) => ref.digest))];
	const blobs = db
		.select({ digest: fileChangeBlobs.digest, size: fileChangeBlobs.sizeBytes })
		.from(fileChangeBlobs)
		.where(and(inArray(fileChangeBlobs.digest, digests), eq(fileChangeBlobs.status, "ready")))
		.limit(3)
		.all();
	if (
		refs.some(
			(ref) => !blobs.some((blob) => blob.digest === ref.digest && blob.size === ref.sizeBytes),
		)
	)
		return undefined;
	return {
		effect,
		actor: operation.actor,
		subagentType: projection.subagentType,
		updatedAt: row.updatedAt,
	};
}
function readObservations(db: ReadDatabase, canonicalRoot: string, filePath: string) {
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

function summariesFor(
	db: ReadDatabase,
	scope: NonNullable<ReturnType<typeof scopeFor>>,
	file: CurrentFileBaseline,
) {
	const identity = createFileChangeIdentity(scope, {
		deviceId: LOCAL_DEVICE_ID,
		pathFlavor: scope.pathFlavor,
		canonicalPath: file.canonicalPath,
		lexicalPath: file.canonicalPath,
		objectRole: "referent",
	});
	const fileKey = fileChangeIdentityKey(identity);
	return db
		.select({
			id: fileChangeEffects.id,
			digest: fileChangeEffects.observedAfterBlobDigest,
			revision: fileChangeEffects.scopeRevision,
			settlement: fileChangeEffects.settlement,
			confirmed: fileChangeEffects.executionConfirmed,
			grade: fileChangeEffects.attributionGrade,
			phase: fileChangeEffects.phase,
		})
		.from(fileChangeEffects)
		.where(and(eq(fileChangeEffects.scopeId, scope.id), eq(fileChangeEffects.fileKey, fileKey)))
		.orderBy(desc(fileChangeEffects.scopeRevision), desc(fileChangeEffects.id))
		.limit(EFFECT_WINDOW + 1)
		.all();
}
export type CurrentDiffReadParams =
	| { kind: "git-current-diff-read-v1"; baseline: CurrentGitBaseline }
	| {
			kind: "git-current-diff-validate-v1";
			baseline: CurrentGitBaseline;
			scopeStamp: string;
			observations: readonly [string, string][];
	  };
export function runCurrentDiffRead(
	sqlite: Database,
	params: CurrentDiffReadParams,
	signal: AbortSignal,
) {
	const db = drizzle(sqlite);
	return sqlite.transaction(() => {
		signal.throwIfAborted();
		const scope = scopeFor(db, params.baseline);
		const scopeStamp = scopeVersion(scope);
		if (params.kind === "git-current-diff-validate-v1") {
			return {
				inconsistent:
					scopeStamp !== params.scopeStamp ||
					params.observations.some(([path, stamp]) => {
						signal.throwIfAborted();
						return hash(readObservations(db, params.baseline.canonicalRoot, path)) !== stamp;
					}),
			};
		}
		const files = params.baseline.files.map((file) => {
			signal.throwIfAborted();
			const summaries = scope ? summariesFor(db, scope, file) : [];
			const observations = scope
				? readObservations(db, params.baseline.canonicalRoot, file.filePath)
				: [];
			const selectedIds = new Set<string>();
			if (summaries.length <= EFFECT_WINDOW && summaries[0]) {
				selectedIds.add(summaries[0].id);
				const indexState = file.indexState;
				if (indexState.kind === "regular") {
					const staged = summaries.find((row) => row.digest === indexState.blob.digest);
					if (staged) selectedIds.add(staged.id);
				}
			}
			const candidates = scope
				? [...selectedIds].map((id) => [id, candidate(db, id, scope, file)] as const)
				: [];
			return { filePath: file.filePath, summaries, observations, candidates };
		});
		return { scope, scopeStamp, files };
	})();
}
export type CurrentDiffReadResult = Extract<
	ReturnType<typeof runCurrentDiffRead>,
	{ files: unknown }
>;
