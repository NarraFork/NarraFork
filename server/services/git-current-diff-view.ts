/** Current content/evidence correspondence, never blame or exclusive net-diff ownership. */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
	type FileChangeActor,
	type FileChangeBlobRef,
	type FileChangeEffect,
	type FileChangeState,
	fileChangeStatesEqual,
	hasSettledMeasuredFileEffect,
} from "../../shared/file-change-protocol";
import { db } from "../db";
import {
	fileAttributions,
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import {
	type AttributionActor,
	resolveAttributionActors,
	resolveEventAttributionActor,
	resolveHumanAttributionActors,
} from "./attribution-actors";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import {
	type CurrentFileBaseline,
	type CurrentGitBaseline,
	gitCurrentBaselineReader,
} from "./git-current-baseline";

const EFFECT_WINDOW = 10;
const MAX_PATHS = 200;
const METADATA_BYTES = 8192;

export type CurrentDiffReason =
	| "no_evidence"
	| "history_incomplete"
	| "ambiguous_order"
	| "legacy_or_external"
	| "state_mismatch"
	| "unverified_effect"
	| "missing_raw"
	| "scope_unknown"
	| "stale"
	| "unsupported"
	| "budget_exceeded"
	| "cancelled"
	| "unavailable";
export interface CurrentDiffTarget {
	source: "current_diff";
	target: "index" | "worktree";
	status: "matching_evidence" | "unknown" | "clean";
	/** This actor's after matches this target. It is NOT a claim of current ownership. */
	actor: AttributionActor | null;
	effectId: string | null;
	reason: CurrentDiffReason | null;
	baselineVersion: string;
	/** FileHistory completeness is independent from target fingerprint completeness. */
	historyComplete: boolean;
	/** Git's index retains only the executable bit, not full filesystem permissions. */
	modeScope: "git_executable_bit" | "filesystem";
	/** Identical external rewrites/staging authorship cannot be proved from content equality. */
	continuity: "unverified";
}
export interface CurrentDiffFile {
	filePath: string;
	index: CurrentDiffTarget;
	worktree: CurrentDiffTarget;
}
export interface CurrentDiffView {
	source: "current_diff";
	baselineStatus: "stable" | "stale" | "unsupported" | "unavailable";
	version: string | null;
	headSha: string | null;
	clean: boolean | null;
	complete: boolean;
	scope: {
		id: string;
		sourceInstanceId: string;
		workspaceInstanceId: string;
		revision: number;
	} | null;
	byFile: CurrentDiffFile[];
}
export interface CurrentDiffOptions {
	deviceId?: string;
	filePaths?: string[];
	signal?: AbortSignal;
	/** Trusted test/infrastructure injection only, never an HTTP parameter. */
	privateRoot?: string;
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function incarnation(source: string, root: string, object: string): string {
	const digest = createHash("sha256");
	for (const part of [source, root, object])
		digest.update(`${Buffer.byteLength(part)}:`).update(part);
	return digest.digest("hex");
}
function scopeFor(baseline: CurrentGitBaseline) {
	if (!baseline.sourceInstanceId) return undefined;
	const scope = db
		.select()
		.from(fileChangeScopes)
		.where(
			and(
				eq(fileChangeScopes.sourceInstanceId, baseline.sourceInstanceId),
				eq(fileChangeScopes.deviceId, LOCAL_DEVICE_ID),
				eq(
					fileChangeScopes.workspaceInstanceId,
					incarnation(baseline.sourceInstanceId, baseline.canonicalRoot, baseline.rootIdentity),
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
function target(
	target: CurrentDiffTarget["target"],
	version: string,
	reason: CurrentDiffReason = "no_evidence",
): CurrentDiffTarget {
	return {
		source: "current_diff",
		target,
		status: "unknown",
		actor: null,
		effectId: null,
		reason,
		baselineVersion: version,
		historyComplete: false,
		modeScope: target === "index" ? "git_executable_bit" : "filesystem",
		continuity: "unverified",
	};
}
function empty(
	paths: string[],
	reason: CurrentDiffReason,
	status: CurrentDiffView["baselineStatus"],
): CurrentDiffView {
	return {
		source: "current_diff",
		baselineStatus: status,
		version: null,
		headSha: null,
		clean: null,
		complete: false,
		scope: null,
		byFile: paths.slice(0, MAX_PATHS).map((filePath) => ({
			filePath,
			index: target("index", "", reason),
			worktree: target("worktree", "", reason),
		})),
	};
}
function rawRefs(effect: FileChangeEffect): FileChangeBlobRef[] {
	return [effect.before, effect.intendedAfter, effect.observedAfter].flatMap((state) =>
		state.kind === "regular" ? [state.blob] : state.kind === "symlink" ? [state.target] : [],
	);
}

/** Preserve immutable actor kind through live-row deletion; never invent a deleted name. */
export async function resolveEvidenceActor(
	snapshot: FileChangeActor,
	subagentType: string | null = null,
): Promise<AttributionActor> {
	const [narratorActors, humanActors] = await Promise.all([
		resolveAttributionActors(snapshot.narratorId ? [snapshot.narratorId] : []),
		resolveHumanAttributionActors(snapshot.userId ? [snapshot.userId] : []),
	]);
	return resolveEventAttributionActor(
		{
			action: snapshot.kind === "human" ? "human" : "write",
			narratorId: snapshot.narratorId,
			userId: snapshot.userId,
			subagentType,
			actorSnapshot: snapshot,
		},
		narratorActors,
		humanActors,
	);
}

type Candidate = {
	effect: FileChangeEffect;
	actor: FileChangeActor;
	subagentType: string | null;
	updatedAt: string;
};
function candidate(
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
function matches(effect: FileChangeEffect, state: FileChangeState, index: boolean): boolean {
	const after = effect.observedAfter;
	if (after.kind !== "regular" || state.kind !== "regular" || after.mode === null) return false;
	return fileChangeStatesEqual(
		index ? { ...after, mode: after.mode & 0o111 ? 0o755 : 0o644 } : after,
		state,
	);
}

function readObservations(canonicalRoot: string, filePath: string) {
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

/** No cache/TTL and no timestamp-based baseline: current targets are fingerprinted twice. */
export async function getGitCurrentDiffView(
	workspacePath: string,
	options: CurrentDiffOptions = {},
): Promise<CurrentDiffView> {
	const paths = [...new Set(options.filePaths ?? [])];
	if ((options.deviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID)
		return empty(paths, "unsupported", "unsupported");
	const started = performance.now();
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(12_000),
	]);
	const privateRoot = options.privateRoot ?? getNarraforkHome();
	let before: CurrentGitBaseline | undefined;
	try {
		before = await gitCurrentBaselineReader.snapshot(
			workspacePath,
			options.filePaths,
			privateRoot,
			signal,
		);
		const scope = scopeFor(before);
		const scopeStamp = scopeVersion(scope);
		const version = hash([before.version, scopeStamp]);
		const byFile: CurrentDiffFile[] = [];
		const proposed: { target: CurrentDiffTarget; candidate: Candidate }[] = [];
		const observationVersions = new Map<string, string>();
		for (const file of before.files) {
			signal.throwIfAborted();
			const fileVersion = hash([
				version,
				file.filePath,
				file.head,
				file.index,
				file.worktreeState,
				file.worktreeVersion,
			]);
			const entry = {
				filePath: file.filePath,
				index: target("index", fileVersion),
				worktree: target("worktree", fileVersion),
			};
			byFile.push(entry);
			const staged = file.status[0] !== " " && file.status[0] !== "?";
			const unstaged = file.status[1] !== " ";
			for (const [name, changed] of [
				["index", staged],
				["worktree", unstaged],
			] as const) {
				if (!changed || before.clean)
					Object.assign(entry[name], { status: "clean", reason: null, historyComplete: true });
			}
			if (!staged && !unstaged) continue;
			if (!scope) {
				for (const result of [entry.index, entry.worktree])
					if (result.status !== "clean") result.reason = "scope_unknown";
				continue;
			}
			const identity = createFileChangeIdentity(scope, {
				deviceId: LOCAL_DEVICE_ID,
				pathFlavor: scope.pathFlavor,
				canonicalPath: file.canonicalPath,
				lexicalPath: file.canonicalPath,
				objectRole: "referent",
			});
			const fileKey = fileChangeIdentityKey(identity);
			const summaries = db
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
			// Conservative until an exact indexed v2 projection replaces this bounded sample.
			if (summaries.length > EFFECT_WINDOW) {
				for (const result of [entry.index, entry.worktree])
					if (result.status !== "clean") result.reason = "history_incomplete";
				continue;
			}
			if (new Set(summaries.map((row) => row.revision)).size !== summaries.length) {
				for (const result of [entry.index, entry.worktree])
					if (result.status !== "clean") result.reason = "ambiguous_order";
				continue;
			}
			if (
				summaries[0] &&
				(summaries[0].settlement !== "settled" ||
					summaries[0].phase !== "apply" ||
					!summaries[0].confirmed ||
					summaries[0].grade !== "measured")
			) {
				for (const result of [entry.index, entry.worktree])
					if (result.status !== "clean") result.reason = "unverified_effect";
				continue;
			}
			const observations = readObservations(before.canonicalRoot, file.filePath);
			observationVersions.set(file.filePath, hash(observations));
			// The entire observation set must fit the budget. Within that set rowid is
			// insertion order (not execution proof); changedAt only expands the tie group.
			// A backdated external insertion must not disappear behind a newer clock value.
			const newestInserted = observations.reduce<(typeof observations)[number] | undefined>(
				(last, row) => (!last || row.rowId > last.rowId ? row : last),
				undefined,
			);
			const latest = observations.filter((row) => row.changedAt === newestInserted?.changedAt);
			const latestUnknown = latest.some(
				(row) =>
					!row.effectId ||
					!summaries.some((effect) => effect.id === row.effectId) ||
					row.grade !== "measured" ||
					row.action === "external" ||
					row.action === "bash",
			);
			for (const name of ["index", "worktree"] as const) {
				const result = entry[name];
				if (result.status === "clean") continue;
				result.historyComplete = true;
				const state = name === "index" ? file.indexState : file.worktreeState;
				if (state.kind !== "regular") {
					result.reason =
						state.kind === "unknown" && state.reason === "budget_exceeded"
							? "budget_exceeded"
							: "unsupported";
					continue;
				}
				const summary =
					name === "index"
						? summaries.find((row) => row.digest === state.blob.digest)
						: summaries[0];
				if (!summary) {
					result.reason = summaries.length ? "state_mismatch" : "no_evidence";
					continue;
				}
				const evidence = candidate(summary.id, scope, file);
				if (!evidence) {
					result.reason = "unverified_effect";
					continue;
				}
				if (!matches(evidence.effect, state, name === "index")) {
					result.reason = "state_mismatch";
					continue;
				}
				if (observations.length > EFFECT_WINDOW || latestUnknown) {
					result.reason =
						observations.length > EFFECT_WINDOW ? "history_incomplete" : "legacy_or_external";
					result.historyComplete = false;
					continue;
				}
				proposed.push({ target: result, candidate: evidence });
			}
		}
		const refs = [
			...new Map(
				proposed
					.flatMap(({ candidate }) => rawRefs(candidate.effect))
					.map((ref) => [ref.digest, ref]),
			).values(),
		];
		const verified = new Set(
			refs.length ? await gitCurrentBaselineReader.verifyBlobs(refs, privateRoot, signal) : [],
		);
		for (const item of proposed) {
			if (rawRefs(item.candidate.effect).some((ref) => !verified.has(ref.digest))) {
				item.target.reason = "missing_raw";
				continue;
			}
			item.target.actor = await resolveEvidenceActor(
				item.candidate.actor,
				item.candidate.subagentType,
			);
			item.target.status = "matching_evidence";
			item.target.effectId = item.candidate.effect.id;
			item.target.reason = null;
		}
		const after = await gitCurrentBaselineReader.snapshot(
			workspacePath,
			options.filePaths,
			privateRoot,
			signal,
		);
		const observationsChanged = [...observationVersions].some(
			([path, stamp]) => hash(readObservations(after.canonicalRoot, path)) !== stamp,
		);
		if (
			after.version !== before.version ||
			scopeVersion(scopeFor(after)) !== scopeStamp ||
			observationsChanged
		)
			return empty(
				before.files.map((file) => file.filePath),
				"stale",
				"stale",
			);
		return {
			source: "current_diff",
			baselineStatus: "stable",
			version,
			headSha: before.headSha,
			clean: before.clean,
			complete:
				!before.pathsTruncated &&
				byFile.every(
					(file) => file.index.status !== "unknown" && file.worktree.status !== "unknown",
				),
			scope: scope
				? {
						id: scope.id,
						sourceInstanceId: scope.sourceInstanceId,
						workspaceInstanceId: scope.workspaceInstanceId,
						revision: scope.revision,
					}
				: null,
			byFile,
		};
	} catch (error) {
		const reason: CurrentDiffReason = signal.aborted
			? "cancelled"
			: error instanceof Error && error.message === "stale"
				? "stale"
				: error instanceof Error && error.message.includes("budget")
					? "budget_exceeded"
					: "unavailable";
		return empty(
			before?.files.map((file) => file.filePath) ?? paths,
			reason,
			reason === "stale" ? "stale" : "unavailable",
		);
	} finally {
		const elapsedMs = Math.round(performance.now() - started);
		if (elapsedMs > 1000)
			logger.warn("Slow current-diff evidence view", {
				elapsedMs,
				requestedPaths: paths.length,
				cancelled: signal.aborted,
			});
	}
}
