import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	GitStagingListsChanged,
	GitStagingObservationState,
	GitStagingWatchState,
	GitStatusPagesWatchState,
	GitWorkspaceCategory,
	GitWorkspaceSnapshot,
	GitWorkspaceView,
} from "@shared/git-workspace-events";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { safeSpawn } from "../lib/spawn";
import { gitDiscoveryCache } from "./git-discovery-cache";
import {
	getGitWorkspaceLineStats,
	getGitWorkspaceStatus,
	getGitWorkspaceStatusPagesCacheState,
	invalidateGitWorkspace,
	invalidateGitWorkspaceFacts,
	observeGitWorkspaceStatusPages,
	releaseGitWorkspaceStatusPages,
	retainGitWorkspaceStatusPages,
	validateGitWorkspaceCache,
	validateGitWorkspaceStatusPages,
} from "./git-management-service";
import {
	createGitStagingListsService,
	executeGitStagingWork,
	type GitStagingContext,
	isGitStagingListWriting,
} from "./git-staging-lists-service";
import {
	dirtyGitStagingObservation,
	settleGitStagingObservations,
} from "./git-staging-observation";
import { GitStatusPageError } from "./git-status-page-protocol";
import { localGitStatusScopesOverlap } from "./git-status-query";
import type { GitWorkspaceTarget } from "./git-workspace";
import { getRemoteGitStatusQueryKey } from "./remote-git-service";

export const WATCH_INTERVAL_MS = 3000;
export const WATCH_MAX_BYTES = 128 * 1024;
const CATEGORIES: GitWorkspaceCategory[] = ["worktree", "index", "refs", "head", "stash"];
export interface WatchSample {
	fingerprints: Partial<Record<GitWorkspaceCategory, string>>;
	uncertain: GitWorkspaceCategory[];
	stagingListsFingerprint?: string;
	stagingListsState?: GitStagingWatchState;
}

export function changedGitCategories(
	previous: WatchSample | undefined,
	sample: WatchSample,
): GitWorkspaceCategory[] {
	return CATEGORIES.filter(
		(category) =>
			(sample.uncertain.includes(category) && !previous?.uncertain.includes(category)) ||
			(previous === undefined
				? sample.fingerprints[category] !== undefined
				: sample.fingerprints[category] !== previous.fingerprints[category]),
	);
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** SQLite, WAL and published generation are sampled off the service thread. */
export async function probeGitStagingState(
	root: string,
	signal: AbortSignal,
	previous?: GitStagingWatchState,
): Promise<GitStagingWatchState> {
	return executeGitStagingWork<GitStagingWatchState>(
		{ cwd: root, workspaceKey: "watch", method: "watch", previous },
		signal,
	);
}

export class GitWatchFactsError extends Error {
	constructor(
		readonly stagingListsFingerprint: string,
		cause: unknown,
		readonly stagingListsState?: GitStagingWatchState,
	) {
		super("Git watch facts unavailable", { cause });
	}
}

export async function probeGitWatch(
	target: GitWorkspaceTarget,
	signal: AbortSignal,
	onStaging?: (state: GitStagingWatchState) => void,
	previousStaging?: GitStagingWatchState,
): Promise<WatchSample> {
	const callerSignal = signal;
	signal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	const stagingListsState =
		target.backend?.kind === "local" && target.workspace.rootPath
			? await probeGitStagingState(target.workspace.rootPath, signal, previousStaging).catch(() => {
					signal.throwIfAborted();
					// Unavailable ChangeList metadata must not disable ordinary Git monitoring.
					return undefined;
				})
			: undefined;
	// Deliver the lightweight SQLite/WAL observation before ordinary Git sampling.
	if (stagingListsState) onStaging?.(stagingListsState);
	try {
		const sample = await probeGitWatchFacts(target, signal);
		return stagingListsState === undefined
			? sample
			: {
					...sample,
					stagingListsFingerprint: stagingListsState.fingerprint,
					stagingListsState,
				};
	} catch (error) {
		callerSignal.throwIfAborted();
		if (stagingListsState !== undefined)
			throw new GitWatchFactsError(stagingListsState.fingerprint, error, stagingListsState);
		throw error;
	}
}

async function probeGitWatchFacts(
	target: GitWorkspaceTarget,
	signal: AbortSignal,
): Promise<WatchSample> {
	const { backend, workspace } = target;
	const root = workspace.rootPath;
	if (!backend || !root) throw new Error("Workspace unavailable");
	const fingerprints: WatchSample["fingerprints"] = {};
	const uncertain = new Set<GitWorkspaceCategory>();
	if (backend.kind === "remote") {
		if (!backend.gitWorkspace) throw new Error("Git workspace RPC unavailable");
		if (backend.supportsGitWorkspaceWatch) {
			const sample = await backend.gitWorkspace(
				{
					cwd: root,
					expectedRoot: root,
					operation: "watch",
					maxBytes: WATCH_MAX_BYTES,
					timeoutMs: 5000,
				},
				signal,
			);
			const outputs = sample.outputs ?? {};
			for (const category of ["worktree", "index", "head", "stash"] as const) {
				if (typeof outputs[category] !== "string")
					throw new Error("Incomplete Git watch fingerprint");
				fingerprints[category] = outputs[category];
			}
			if (sample.truncated) {
				// Metadata budgets never invalidate the independently bounded HEAD identity.
				uncertain.add("worktree");
				uncertain.add("index");
				uncertain.add("stash");
			}
			if (outputs.uncertainWorktree === "true") uncertain.add("worktree");
			return {
				fingerprints,
				uncertain: [...uncertain],
			};
		}
		const status = await backend.gitWorkspace(
			{
				cwd: root,
				expectedRoot: root,
				operation: "status",
				maxBytes: WATCH_MAX_BYTES,
				timeoutMs: 5000,
			},
			signal,
		);
		if (status.state && status.state !== "ready") throw new Error("Git watch unavailable");
		const outputs = status.outputs ?? {};
		if (outputs.head === undefined || outputs.branch === undefined || outputs.status === undefined)
			throw new Error("Incomplete remote Git watch status");
		fingerprints.head = fingerprint(`${outputs.head}\0${outputs.branch}`);
		if (outputs.stagedNumstat === undefined || status.truncated) uncertain.add("index");
		else fingerprints.index = fingerprint(outputs.stagedNumstat);
		// v1 exposes HEAD/branch, not unrelated refs. Never turn this limitation
		// into periodic log invalidations. Bounded patches detect equal-line edits.
		let patch = "";
		if (outputs.status || status.truncated) {
			const diff = await backend.gitWorkspace(
				{
					cwd: root,
					expectedRoot: root,
					operation: "fullDiff",
					maxBytes: WATCH_MAX_BYTES,
					timeoutMs: 5000,
				},
				signal,
			);
			patch = diff.stdout ?? "";
			if (diff.truncated || /Binary files .* differ|Subproject commit/.test(patch))
				uncertain.add("worktree");
		}
		fingerprints.worktree = fingerprint(`${outputs.status}\0${patch}`);
		if (status.truncated) uncertain.add("worktree");
		const stash = await backend.gitWorkspace(
			{
				cwd: root,
				expectedRoot: root,
				operation: "stashList",
				maxBytes: WATCH_MAX_BYTES,
				timeoutMs: 5000,
				limit: 100,
			},
			signal,
		);
		fingerprints.stash = fingerprint(stash.stdout ?? "");
		// Comparing the bounded prefix never makes the log refresh periodically.
		if (stash.truncated) uncertain.add("stash");
	} else {
		const run = async (args: string[], category: GitWorkspaceCategory) => {
			const result = await safeSpawn({
				cmd: ["git", "--no-optional-locks", "-C", root, ...args],
				timeout: 5000,
				maxOutputBytes: WATCH_MAX_BYTES,
				signal,
			});
			if (result.stdoutTruncated || result.stderrTruncated) uncertain.add(category);
			if (result.exitCode !== 0 && !(args[0] === "rev-parse" && result.exitCode === 1))
				throw new Error("Git watch probe failed");
			return result.stdout;
		};
		const status = await run(
			[
				"--no-literal-pathspecs",
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--branch",
				"--",
				".",
				":(top,exclude,glob)[.]narrafork/git-staging/**",
			],
			"worktree",
		);
		// The panel's log is HEAD-only (no --all or ref decorations). Enumerating
		// all refs is both unnecessary and makes large ref sets perpetually truncated.
		fingerprints.refs = fingerprint(
			await run(["rev-parse", "--verify", "--quiet", "HEAD"], "refs"),
		);
		fingerprints.stash = fingerprint(await run(["stash", "list", "--format=%gd:%H"], "stash"));
		fingerprints.index = fingerprint(
			await run(
				["diff", "--cached", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv"],
				"index",
			),
		);
		const records = status.split("\0");
		fingerprints.head = fingerprint(records[0]?.startsWith("##") ? records[0] : "");
		const hash = createHash("sha256");
		let scanned = 0;
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (!record || record.startsWith("##")) continue;
			hash.update(record);
			if (++scanned > 2000) {
				uncertain.add("worktree");
				break;
			}
			signal.throwIfAborted();
			const path = record.slice(3);
			const metadata = await lstat(resolve(root, path), { bigint: true }).catch(() => null);
			if (metadata?.isDirectory()) uncertain.add("worktree");
			hash.update(
				metadata
					? `${path}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.ino}`
					: `${path}:missing`,
			);
			if (/[RC]/.test(record.slice(0, 2))) hash.update(records[++i] ?? "");
		}
		fingerprints.worktree = hash.digest("hex");
	}
	return { fingerprints, uncertain: [...uncertain] };
}

export const GIT_SNAPSHOT_MAX_BYTES = 128 * 1024;
const REFRESH_INTERVAL_MS = 1000;
const REVALIDATE_INTERVAL_MS = 60_000;
let nextRevision = 0;

/** Bound the shared projection once, rather than scanning every file for each socket. */
export function boundGitSnapshot(snapshot: GitWorkspaceSnapshot): GitWorkspaceSnapshot {
	const status = snapshot.status;
	const originalFiles = status?.files;
	if (!status || !originalFiles) return snapshot;
	let files = originalFiles.slice(0, 200);
	const project = (): GitWorkspaceSnapshot => {
		const paths = new Set(files.map((file) => file.path));
		const truncated = files.length < originalFiles.length;
		return {
			...snapshot,
			status: { ...status, files, truncated: status.truncated || truncated },
			...(snapshot.lineStats && {
				lineStats: {
					...snapshot.lineStats,
					files: snapshot.lineStats.files?.filter((file) => paths.has(file.path)),
				},
			}),
			detailsTruncated: snapshot.detailsTruncated || snapshot.status?.truncated || truncated,
		};
	};
	let result = project();
	// Leave room for the bounded subscription identity and JSON envelope.
	while (
		files.length &&
		Buffer.byteLength(JSON.stringify(result)) > GIT_SNAPSHOT_MAX_BYTES - 4096
	) {
		files = files.slice(0, Math.floor(files.length / 2));
		result = project();
	}
	return result;
}

export function projectGitSnapshot(
	snapshot: GitWorkspaceSnapshot,
	view: GitWorkspaceView,
): GitWorkspaceSnapshot {
	if (view === "details") return snapshot;
	const result = { ...snapshot, detailsTruncated: undefined };
	if (snapshot.status) {
		const { files: _files, ...status } = snapshot.status;
		result.status = status;
	}
	if (snapshot.lineStats) {
		const { files: _files, ...lineStats } = snapshot.lineStats;
		result.lineStats = lineStats;
	}
	return result;
}

export interface GitStagingWatchAuthorization {
	authorizationKey: string;
	writable: boolean;
	beforeWrite: GitStagingContext["beforeWrite"];
	authorizePaths: NonNullable<GitStagingContext["authorizePaths"]>;
	observation(state: GitStagingObservationState): void;
}

interface Listener {
	changed(categories: GitWorkspaceCategory[], pages?: GitStatusPagesWatchState): void;
	snapshot?(snapshot: GitWorkspaceSnapshot): void;
}
interface Entry {
	target: GitWorkspaceTarget;
	listeners: Set<Listener>;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	previous?: WatchSample;
	stagingListsFingerprint?: string;
	stagingListsState?: GitStagingWatchState;
	stagingGeneration: number;
	stagingSyncing?: number;
	observationFingerprint?: string;
	lastObservationAt?: number;
	probed: boolean;
	failures: number;
	running: boolean;
	snapshot?: GitWorkspaceSnapshot;
	dirty: boolean;
	revision: number;
	refreshing: boolean;
	refreshTimer?: ReturnType<typeof setTimeout>;
	lastRefreshAt: number;
	lastValidatedAt: number;
	lineStatsUnsupported?: boolean;
	pagesRetained?: boolean;
}
const snapshotReads = {
	status: getGitWorkspaceStatus,
	lineStats: getGitWorkspaceLineStats,
	invalidate: invalidateGitWorkspace,
	invalidateFacts: invalidateGitWorkspaceFacts,
	validate: validateGitWorkspaceCache,
	validatePages: validateGitWorkspaceStatusPages,
	observePages: observeGitWorkspaceStatusPages,
	pagesState: getGitWorkspaceStatusPagesCacheState,
	releasePages: releaseGitWorkspaceStatusPages,
	retainPages: retainGitWorkspaceStatusPages,
};

const stagingSyncs = new Map<string, Set<Promise<void>>>();

/** Deliver notifications and HTTP results only after the filesystem baseline is current. */
export async function settleGitStagingWatch(
	workspaceKey: string,
	signal?: AbortSignal,
): Promise<void> {
	while (stagingSyncs.get(workspaceKey)?.size) {
		signal?.throwIfAborted();
		const pending = Promise.all(stagingSyncs.get(workspaceKey) ?? []);
		if (!signal) await pending;
		else {
			let abort = () => {};
			const cancelled = new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason ?? new Error("Git observation wait cancelled"));
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			});
			try {
				await Promise.race([pending, cancelled]);
			} finally {
				signal.removeEventListener("abort", abort);
			}
		}
	}
	await settleGitStagingObservations(workspaceKey, signal);
	signal?.throwIfAborted();
}

/** One probe and refresh per device/worktree, only while a consumer is subscribed. */
export class GitWorkspaceWatchPool {
	private entries = new Map<string, Entry>();
	private active = 0;
	private offInvalidated?: () => void;
	private emittingStaging = false;
	private invalidatingFacts = false;
	constructor(
		private probe = probeGitWatch,
		private interval = WATCH_INTERVAL_MS,
		private reads: Omit<
			typeof snapshotReads,
			| "invalidateFacts"
			| "validatePages"
			| "observePages"
			| "pagesState"
			| "releasePages"
			| "retainPages"
		> &
			Partial<
				Pick<
					typeof snapshotReads,
					| "invalidateFacts"
					| "validatePages"
					| "observePages"
					| "pagesState"
					| "releasePages"
					| "retainPages"
				>
			> = snapshotReads,
		private timing: { boundedIntervalMs?: number; revalidateIntervalMs?: number } = {},
	) {}

	subscribe(
		target: GitWorkspaceTarget,
		changed: Listener["changed"],
		snapshot?: Listener["snapshot"],
		staging?: GitStagingWatchAuthorization,
	): () => void {
		const key = `${target.workspace.deviceId}:${target.workspace.workspaceKey}`;
		let entry = this.entries.get(key);
		if (!entry) {
			if (this.entries.size >= 128) throw new Error("Git watch capacity reached");
			entry = {
				target,
				listeners: new Set(),
				controller: new AbortController(),
				failures: 0,
				running: false,
				probed: false,
				stagingGeneration: 0,
				dirty: true,
				revision: ++nextRevision,
				refreshing: false,
				lastRefreshAt: 0,
				lastValidatedAt: Date.now(),
			};
			this.entries.set(key, entry);
		} else if (
			(target.discoveryRuntimeGeneration ?? target.backend?.runtimeGeneration ?? 0) >
			(entry.target.discoveryRuntimeGeneration ?? entry.target.backend?.runtimeGeneration ?? 0)
		) {
			this.reads.releasePages?.(entry.target);
			entry.pagesRetained = false;
			entry.target = target;
			entry.previous = undefined;
			entry.stagingListsFingerprint = undefined;
			entry.stagingListsState = undefined;
			entry.probed = false;
			entry.snapshot = undefined;
			entry.lineStatsUnsupported = false;
			entry.dirty = true;
			entry.revision = ++nextRevision;
			entry.failures = 0;
			entry.controller.abort();
			entry.controller = new AbortController();
			clearTimeout(entry.timer);
			clearTimeout(entry.refreshTimer);
			entry.timer = undefined;
			entry.refreshTimer = undefined;
			// Old operations keep their slots until cancellation settles.
		}
		if (!this.offInvalidated) {
			const onInvalidated = ({ queryKey }: { queryKey: string }) => {
				for (const candidate of this.entries.values()) {
					const { backend, workspace } = candidate.target;
					const root = workspace.rootPath ?? workspace.cwd;
					const matches =
						backend?.kind === "remote"
							? getRemoteGitStatusQueryKey(backend, root) === queryKey
							: localGitStatusScopesOverlap(queryKey, root);
					if (matches) {
						this.markDirty(candidate);
						if (!this.invalidatingFacts && workspace.rootPath && workspace.workspaceKey)
							dirtyGitStagingObservation({
								rootPath: workspace.rootPath,
								workspaceKey: workspace.workspaceKey,
							});
					}
				}
			};
			const onStaging = ({
				workspaceKey,
				generation: publishedGeneration,
			}: GitStagingListsChanged) => {
				if (this.emittingStaging) return;
				for (const candidate of this.entries.values()) {
					const root = candidate.target.workspace.rootPath;
					if (
						candidate.target.workspace.workspaceKey !== workspaceKey ||
						candidate.target.backend?.kind !== "local" ||
						!root
					)
						continue;
					const generation = ++candidate.stagingGeneration;
					candidate.stagingSyncing = generation;
					const syncs = stagingSyncs.get(workspaceKey) ?? new Set<Promise<void>>();
					stagingSyncs.set(workspaceKey, syncs);
					const sync = probeGitStagingState(root, candidate.controller.signal)
						.then((state) => {
							if (candidate.stagingGeneration !== generation || candidate.controller.signal.aborted)
								return;
							candidate.stagingSyncing = undefined;
							// A newer external transaction must still be delivered, not acknowledged as our write.
							if (publishedGeneration !== undefined && state.generation > publishedGeneration)
								this.observeStaging(candidate, state.fingerprint, state);
							else {
								candidate.stagingListsState = state;
								candidate.stagingListsFingerprint = state.fingerprint;
							}
						})
						.catch(() => {})
						.finally(() => {
							if (candidate.stagingSyncing === generation) candidate.stagingSyncing = undefined;
							syncs.delete(sync);
							if (!syncs.size) stagingSyncs.delete(workspaceKey);
						});
					syncs.add(sync);
				}
			};
			eventBus.on("git:workspace_invalidated", onInvalidated);
			eventBus.on("git:staging_lists_changed", onStaging);
			this.offInvalidated = () => {
				eventBus.off("git:workspace_invalidated", onInvalidated);
				eventBus.off("git:staging_lists_changed", onStaging);
			};
		}
		const listener = { changed, snapshot };
		entry.listeners.add(listener);
		let stopObservation: (() => void) | undefined;
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			stopObservation?.();
			entry.listeners.delete(listener);
			if (entry.listeners.size) return;
			entry.controller.abort();
			this.reads.releasePages?.(entry.target);
			clearTimeout(entry.timer);
			clearTimeout(entry.refreshTimer);
			if (this.entries.get(key) === entry) this.entries.delete(key);
			if (!this.entries.size) {
				this.offInvalidated?.();
				this.offInvalidated = undefined;
			}
		};
		try {
			if (!entry.pagesRetained && this.reads.retainPages) {
				this.reads.retainPages(entry.target);
				entry.pagesRetained = true;
			}
			if (
				staging &&
				target.backend?.kind === "local" &&
				target.workspace.rootPath &&
				target.workspace.workspaceKey
			) {
				const service = createGitStagingListsService(
					{
						rootPath: target.workspace.rootPath,
						workspaceKey: target.workspace.workspaceKey,
						authorizationKey: staging.authorizationKey,
						beforeWrite: staging.beforeWrite,
						authorizePaths: staging.authorizePaths,
						signal: entry.controller.signal,
					},
					{ changed: (event) => eventBus.emit({ type: "git:staging_lists_changed", ...event }) },
				);
				stopObservation = service.watchObservation(staging.observation, staging.writable);
			}
			if (entry.snapshot) snapshot?.(entry.snapshot);
			if (snapshot && entry.dirty) this.scheduleRefresh(entry, true);
			if (!entry.timer && !entry.running) void this.tick(entry);
		} catch (error) {
			stop();
			throw error;
		}
		return stop;
	}

	/** An explicit refresh is authorized by the socket before reaching this method. */
	refresh(target: GitWorkspaceTarget): void {
		const entry = this.entries.get(`${target.workspace.deviceId}:${target.workspace.workspaceKey}`);
		if (!entry) return;
		this.invalidate(entry.target);
		this.markDirty(entry);
		clearTimeout(entry.refreshTimer);
		entry.refreshTimer = undefined;
		this.scheduleRefresh(entry, true);
		for (const listener of entry.listeners)
			listener.changed(["worktree", "index", "refs", "stash"], {
				statusPagesChanged: true,
				statusPagesReliable: false,
			});
	}

	private invalidate(target: GitWorkspaceTarget, factsOnly = false): void {
		this.invalidatingFacts = true;
		try {
			if (factsOnly) (this.reads.invalidateFacts ?? this.reads.invalidate)(target);
			else this.reads.invalidate(target);
		} finally {
			this.invalidatingFacts = false;
		}
	}

	private publish(entry: Entry, snapshot: GitWorkspaceSnapshot): void {
		entry.snapshot = boundGitSnapshot(snapshot);
		for (const listener of entry.listeners) listener.snapshot?.(entry.snapshot);
	}

	private markDirty(entry: Entry): void {
		if (!entry.dirty) {
			entry.dirty = true;
			entry.revision = ++nextRevision;
			if (entry.snapshot)
				this.publish(entry, {
					...entry.snapshot,
					revision: entry.revision,
					updating: true,
					...(entry.snapshot.statusPages && {
						statusPages: { ...entry.snapshot.statusPages, updating: true, errorCode: undefined },
					}),
					statusError: undefined,
					lineStatsError: undefined,
				});
		}
		this.scheduleRefresh(entry);
	}

	private scheduleRefresh(entry: Entry, immediate = false): void {
		if (
			(!entry.probed && !this.reads.observePages) ||
			entry.refreshing ||
			entry.refreshTimer ||
			entry.controller.signal.aborted
		)
			return;
		if (![...entry.listeners].some((listener) => listener.snapshot)) return;
		const delay = immediate
			? 0
			: Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - entry.lastRefreshAt));
		entry.refreshTimer = setTimeout(() => {
			entry.refreshTimer = undefined;
			void this.refreshFacts(entry);
		}, delay);
		entry.refreshTimer.unref?.();
	}

	private async refreshFacts(entry: Entry): Promise<void> {
		if (entry.controller.signal.aborted || !entry.dirty || entry.refreshing) return;
		entry.refreshing = true;
		entry.dirty = false;
		entry.lastRefreshAt = Date.now();
		const { controller, target, revision } = entry;
		// A newly observed directory has no fingerprint tied to the idle HTTP cache.
		// Read fresh once; later subscribers reuse this entry without invalidating it.
		const ttlMs = entry.snapshot?.status ? undefined : 0;
		const current = () => !controller.signal.aborted && entry.revision === revision;
		this.publish(entry, {
			...entry.snapshot,
			revision,
			updating: true,
			statusError: undefined,
			lineStatsError: undefined,
		});
		let fullStats: ReturnType<typeof getGitWorkspaceLineStats> | undefined;
		const readFullStats = (signal: AbortSignal) => {
			if (entry.lineStatsUnsupported)
				return Promise.reject(
					new AppError("Git line statistics unsupported", 503, "GIT_LINE_STATS_UNSUPPORTED"),
				);
			fullStats ??= this.reads.lineStats(
				target,
				AbortSignal.any([controller.signal, signal]),
				ttlMs,
			);
			return fullStats;
		};
		const pageTask = this.reads
			.observePages?.(target, controller.signal, readFullStats, (statusPages) => {
				if (current())
					this.publish(entry, { ...entry.snapshot, revision, updating: true, statusPages });
			})
			.then((statusPages) => {
				if (current())
					this.publish(entry, { ...entry.snapshot, revision, updating: true, statusPages });
			})
			.catch((error: unknown) => {
				if (!current()) return;
				this.publish(entry, {
					...entry.snapshot,
					revision,
					updating: true,
					statusPages: {
						status: "error",
						workerEpoch: entry.snapshot?.statusPages?.workerEpoch ?? "unavailable",
						memberVersion: entry.snapshot?.statusPages?.memberVersion ?? 0,
						statsVersion: entry.snapshot?.statusPages?.statsVersion ?? 0,
						updating: false,
						errorCode:
							error instanceof AppError || error instanceof GitStatusPageError
								? error.code
								: "GIT_STATUS_PAGE_SOURCE_FAILED",
					},
				});
			});
		let statusReady = false;
		try {
			const status = await this.reads.status(target, controller.signal, ttlMs);
			if (!current()) return;
			statusReady = true;
			this.publish(entry, {
				...entry.snapshot,
				revision,
				status,
				updating: true,
				detailsTruncated: status.truncated,
			});
			if (entry.lineStatsUnsupported) {
				this.publish(entry, {
					...entry.snapshot,
					revision,
					updating: false,
					lineStatsError: "GIT_LINE_STATS_UNSUPPORTED",
				});
				return;
			}
			const lineStats = await readFullStats(controller.signal);
			await pageTask;
			if (!current()) return;
			entry.lastValidatedAt = Date.now();
			this.publish(entry, { ...entry.snapshot, revision, lineStats, updating: false });
		} catch (error) {
			if (!current()) return;
			const code = error instanceof AppError ? error.code : "GIT_STATS_FAILED";
			if (statusReady && code === "GIT_LINE_STATS_UNSUPPORTED") entry.lineStatsUnsupported = true;
			this.publish(entry, {
				...entry.snapshot,
				revision,
				updating: false,
				...(statusReady ? { lineStatsError: code } : { statusError: code }),
			});
		} finally {
			await pageTask;
			if (current() && entry.snapshot?.updating)
				this.publish(entry, { ...entry.snapshot, updating: false });
			entry.refreshing = false;
			if (entry.dirty) this.scheduleRefresh(entry);
		}
	}

	private observeStaging(
		entry: Entry,
		_fingerprint: string | undefined,
		state?: GitStagingWatchState,
	): void {
		if (!state || entry.stagingSyncing !== undefined) return;
		const before = entry.stagingListsState;
		const workspaceKey = entry.target.workspace.workspaceKey;
		if (workspaceKey && isGitStagingListWriting(workspaceKey)) return;
		entry.stagingListsState = state;
		entry.stagingListsFingerprint = state.fingerprint;
		if (!before || !workspaceKey || before.fingerprint === state.fingerprint) return;
		if (entry.target.workspace.rootPath)
			dirtyGitStagingObservation({ rootPath: entry.target.workspace.rootPath, workspaceKey });
		this.emittingStaging = true;
		try {
			eventBus.emit({
				type: "git:staging_lists_changed",
				workspaceKey,
				metadataChanged: true,
				affectedListIds: [...new Set([...before.listIds, ...state.listIds])],
				generation: state.generation,
				observationId: state.observationId,
			});
		} finally {
			this.emittingStaging = false;
		}
	}

	private observeWorktree(entry: Entry, sample: WatchSample): void {
		const { workspace, backend } = entry.target;
		if (backend?.kind !== "local" || !workspace.rootPath || !workspace.workspaceKey) return;
		const identity = JSON.stringify([
			sample.fingerprints.worktree,
			sample.fingerprints.head,
			sample.fingerprints.refs,
		]);
		if (
			entry.observationFingerprint !== identity ||
			(sample.uncertain.includes("worktree") &&
				Date.now() - (entry.lastObservationAt ?? 0) >=
					(this.timing.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS))
		) {
			entry.observationFingerprint = identity;
			entry.lastObservationAt = Date.now();
			dirtyGitStagingObservation({
				rootPath: workspace.rootPath,
				workspaceKey: workspace.workspaceKey,
			});
		}
	}

	private async tick(entry: Entry): Promise<void> {
		if (entry.controller.signal.aborted || entry.running) return;
		entry.running = true;
		entry.timer = undefined;
		const { controller, target, stagingGeneration } = entry;
		if (this.active < 4) {
			this.active++;
			const started = performance.now();
			try {
				const sample = await this.probe(
					target,
					controller.signal,
					(state) => {
						if (!controller.signal.aborted && entry.stagingGeneration === stagingGeneration)
							this.observeStaging(entry, state.fingerprint, state);
					},
					entry.stagingListsState,
				);
				if (!controller.signal.aborted) {
					if (entry.stagingGeneration === stagingGeneration)
						this.observeStaging(entry, sample.stagingListsFingerprint, sample.stagingListsState);
					// Establish the directory baseline once, before reading facts. Its first
					// invalidation also excludes pre-baseline HTTP work still in flight;
					// additional subscribers never repeat this directory-level validation.
					// Lightweight Worker health check also wakes an existing subscription after eviction/restart.
					if (this.reads.pagesState && !entry.refreshing && !entry.dirty) {
						try {
							const cache = await this.reads.pagesState(target, controller.signal);
							controller.signal.throwIfAborted();
							if (
								(cache.status !== "ready" && cache.errorCode !== "GIT_STATUS_PAGE_BUSY") ||
								(cache.errorCode && cache.errorCode !== "GIT_STATUS_PAGE_BUSY") ||
								(cache.statsErrorCode &&
									cache.statsErrorCode !== "GIT_STATUS_PAGE_BUSY" &&
									!entry.lineStatsUnsupported) ||
								cache.updating ||
								cache.workerEpoch !== entry.snapshot?.statusPages?.workerEpoch
							)
								this.markDirty(entry);
						} catch {
							if (!controller.signal.aborted) this.markDirty(entry);
						}
					}
					const categories = entry.previous ? changedGitCategories(entry.previous, sample) : [];
					const related = categories.some((category) => category !== "stash");
					const uncertain = [...sample.uncertain, ...(entry.previous?.uncertain ?? [])].some(
						(category) => category !== "stash",
					);
					let pageState: GitStatusPagesWatchState | undefined;
					if (
						this.reads.validatePages &&
						!this.reads.observePages &&
						(!entry.previous ||
							related ||
							(uncertain &&
								Date.now() - entry.lastValidatedAt >=
									(this.timing.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS)))
					) {
						try {
							const validation = await this.reads.validatePages(target, controller.signal);
							pageState = {
								statusPagesChanged: validation.changed,
								statusPagesReliable: validation.reliable,
							};
						} catch {
							pageState = { statusPagesChanged: false, statusPagesReliable: false };
						}
						controller.signal.throwIfAborted();
					} else if (entry.previous && related) {
						pageState = { statusPagesChanged: true, statusPagesReliable: false };
					}
					if (categories.includes("head") || categories.includes("refs"))
						gitDiscoveryCache.invalidate(
							target.workspace.deviceId,
							target.workspace.rootPath ?? target.workspace.cwd,
							target.repositoryPath,
							target.backend?.paths.equals,
						);
					if (
						!entry.previous ||
						categories.some((category) => category !== "stash") ||
						Date.now() - entry.lastValidatedAt >=
							(this.timing.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS)
					) {
						// Uncertain fingerprints retain conservative statistics refreshes. The
						// Worker independently compares full bounded file membership before
						// expiring a cursor, so large unchanged trees can keep paging.
						this.invalidate(target, !!this.reads.validatePages || !related);
						this.markDirty(entry);
						entry.lastValidatedAt = Date.now();
					} else if (entry.previous && !entry.dirty) {
						this.reads.validate(target);
					}
					this.observeWorktree(entry, sample);
					entry.failures = 0;
					entry.previous = sample;
					for (const listener of entry.listeners) listener.changed(categories, pageState);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					if (error instanceof GitWatchFactsError && entry.stagingGeneration === stagingGeneration)
						this.observeStaging(entry, error.stagingListsFingerprint, error.stagingListsState);
					entry.failures = Math.min(entry.failures + 1, 4);
					if (
						Date.now() - entry.lastValidatedAt >=
						(this.timing.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS)
					) {
						this.invalidate(target, true);
						this.markDirty(entry);
						entry.lastValidatedAt = Date.now();
					}
					for (const listener of entry.listeners)
						listener.changed([], { statusPagesChanged: false, statusPagesReliable: false });
				}
			} finally {
				this.active--;
				// A failed monitor must not block independently available status forever.
				if (controller === entry.controller) entry.probed = true;
				if (performance.now() - started > 5000)
					logger.warn("Slow Git workspace watch probe", {
						workspaceKey: target.workspace.workspaceKey,
						deviceId: target.workspace.deviceId,
						elapsedMs: Math.round(performance.now() - started),
					});
			}
		}
		entry.running = false;
		if (controller === entry.controller && entry.dirty) this.scheduleRefresh(entry);
		if (!entry.controller.signal.aborted) {
			const legacyRemote =
				entry.target.backend?.kind === "remote" && !entry.target.backend.supportsGitWorkspaceWatch;
			const boundedWorktree = entry.previous?.uncertain.includes("worktree");
			const interval = legacyRemote
				? Math.max(30_000, this.interval)
				: boundedWorktree
					? Math.max(this.timing.boundedIntervalMs ?? 30_000, this.interval)
					: this.interval;
			entry.timer = setTimeout(
				() => void this.tick(entry),
				controller !== entry.controller ? 0 : Math.min(60_000, interval * 2 ** entry.failures),
			);
			entry.timer.unref?.();
		}
	}
}
