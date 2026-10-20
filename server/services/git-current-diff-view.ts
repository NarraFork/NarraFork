/** Current content/evidence correspondence, never blame or exclusive net-diff ownership. */
import { createHash } from "node:crypto";
import {
	type FileChangeActor,
	type FileChangeBlobRef,
	type FileChangeEffect,
	type FileChangeState,
	fileChangeStatesEqual,
} from "../../shared/file-change-protocol";
import { db, sqlite } from "../db";
import { readTransactionTask } from "../db/worker-read";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { getNarraforkHome } from "../lib/narrafork-home";
import { diagnosticAwait } from "../lib/request-diagnostics";
import {
	type AttributionActor,
	resolveAttributionActors,
	resolveEventAttributionActor,
	resolveHumanAttributionActors,
} from "./attribution-actors";
import { type CurrentGitBaseline, gitCurrentBaselineReader } from "./git-current-baseline";
import {
	type Candidate,
	type CurrentDiffReadResult,
	runCurrentDiffRead,
} from "./git-current-diff-read";

const EFFECT_WINDOW = 10;
const MAX_PATHS = 200;
const SLICE_MS = 8;
const SLICE_CHECKPOINTS = 32;

/** Microtask-only awaits do not service HTTP, timers or request cancellation. */
function evidenceCheckpoint(signal: AbortSignal) {
	let sliceStarted = performance.now();
	let checkpoints = 0;
	return async () => {
		signal.throwIfAborted();
		if (++checkpoints < SLICE_CHECKPOINTS && performance.now() - sliceStarted < SLICE_MS) return;
		await diagnosticAwait("yield", () => new Promise<void>((resolve) => setImmediate(resolve)));
		signal.throwIfAborted();
		checkpoints = 0;
		sliceStarted = performance.now();
	};
}

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

function matches(effect: FileChangeEffect, state: FileChangeState, index: boolean): boolean {
	const after = effect.observedAfter;
	if (after.kind !== "regular" || state.kind !== "regular" || after.mode === null) return false;
	return fileChangeStatesEqual(
		index ? { ...after, mode: after.mode & 0o111 ? 0o755 : 0o644 } : after,
		state,
	);
}

/** No cross-request cache/TTL: current targets are fingerprinted twice, never by timestamp. */
export async function getGitCurrentDiffView(
	workspacePath: string,
	options: CurrentDiffOptions = {},
): Promise<CurrentDiffView> {
	const paths = [...new Set(options.filePaths ?? [])];
	if ((options.deviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID)
		return empty(paths, "unsupported", "unsupported");
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(12_000),
	]);
	const privateRoot = options.privateRoot ?? getNarraforkHome();
	let before: CurrentGitBaseline | undefined;
	const checkpoint = evidenceCheckpoint(signal);
	try {
		signal.throwIfAborted();
		before = await diagnosticAwait("baseline.before", () =>
			gitCurrentBaselineReader.snapshot(workspacePath, options.filePaths, privateRoot, signal),
		);
		const readTask = { kind: "git-current-diff-read-v1", baseline: before } as const;
		const evidenceRead = await readTransactionTask<CurrentDiffReadResult>(
			db,
			readTask,
			() => runCurrentDiffRead(sqlite, readTask, signal) as CurrentDiffReadResult,
			{ signal },
		);
		const { scope, scopeStamp } = evidenceRead;
		const version = hash([before.version, scopeStamp]);
		const byFile: CurrentDiffFile[] = [];
		const proposed: { target: CurrentDiffTarget; candidate: Candidate }[] = [];
		const observationVersions = new Map<string, string>();
		for (const [fileIndex, file] of before.files.entries()) {
			await checkpoint();
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
			const evidenceFile = evidenceRead.files[fileIndex];
			const summaries = evidenceFile.summaries;
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
			const observations = evidenceFile.observations;
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
			// Scoped to this file and this baseline/scope version; the summary ID
			// identifies the immutable effect. Do not share across requests or files.
			const candidates = new Map(evidenceFile.candidates);
			for (const name of ["index", "worktree"] as const) {
				await checkpoint();
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
				const evidence = candidates.get(summary.id);
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
			refs.length
				? await diagnosticAwait("blob.verify", () =>
						gitCurrentBaselineReader.verifyBlobs(refs, privateRoot, signal),
					)
				: [],
		);
		// Immutable actor snapshots (not just narrator/user IDs) and projection
		// subtype form the key; live labels are resolved once in this request.
		const actors = new Map<string, AttributionActor>();
		for (const item of proposed) {
			await checkpoint();
			if (rawRefs(item.candidate.effect).some((ref) => !verified.has(ref.digest))) {
				item.target.reason = "missing_raw";
				continue;
			}
			const actorKey = hash([item.candidate.actor, item.candidate.subagentType]);
			let actor = actors.get(actorKey);
			if (!actor) {
				actor = await diagnosticAwait("actor.resolve", () =>
					resolveEvidenceActor(item.candidate.actor, item.candidate.subagentType),
				);
				actors.set(actorKey, actor);
			}
			signal.throwIfAborted();
			item.target.actor = actor;
			item.target.status = "matching_evidence";
			item.target.effectId = item.candidate.effect.id;
			item.target.reason = null;
		}
		const after = await diagnosticAwait("baseline.after", () =>
			gitCurrentBaselineReader.snapshot(workspacePath, options.filePaths, privateRoot, signal),
		);
		signal.throwIfAborted();
		// The final observations and scope revision share one short worker read snapshot.
		// The two filesystem snapshots still bracket evidence and actor/blob resolution.
		const validationTask = {
			kind: "git-current-diff-validate-v1",
			baseline: after,
			scopeStamp,
			observations: [...observationVersions],
		} as const;
		const validation = await readTransactionTask<{ inconsistent: boolean }>(
			db,
			validationTask,
			() => runCurrentDiffRead(sqlite, validationTask, signal) as { inconsistent: boolean },
			{ signal },
		);
		const inconsistent = after.version !== before.version || validation.inconsistent;
		if (inconsistent)
			return empty(
				before.files.map((file) => file.filePath),
				"stale",
				"stale",
			);
		signal.throwIfAborted();
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
	}
}
