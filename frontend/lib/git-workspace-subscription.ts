import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { GitStagingFilesPage, GitStagingSummary } from "../../shared/git-staging-lists";
import type {
	GitStagingObservationState,
	GitWorkspaceSnapshot,
	GitWorkspaceView,
} from "../../shared/git-workspace-events";
import { type GitTarget, type GitWorkspace, gitTargetKey } from "./api/git";
import type { ListenerHandle, ListenerOptions, MessageCallback } from "./narrator-ws-manager";
import { observePageLifecycle, type PageLifecycleTarget } from "./page-lifecycle";

interface GitTransport {
	readonly connected: boolean;
	send(message: Record<string, unknown>): boolean;
	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
	onConnectionChange(callback: (connected: boolean, isReconnect: boolean) => void): () => void;
}

const FACTS = [
	"gitStatus",
	"gitStatusPages",
	"gitStatusPageStats",
	"gitLineStats",
	"gitWorkspaceSnapshot",
	"gitModifications",
	"gitDiff",
	"gitLog",
	"gitStashList",
	"gitCommitDetail",
	"gitCommitDiff",
	"gitStagingLists",
	"gitStagingFiles",
	"gitStagingDiff",
];
let nextSubscriptionId = 0;
const authorizationKey = (target: GitTarget) =>
	JSON.stringify([target.narratorId, target.workspaceKey]);
export const gitFactKey = (prefix: string, key: string | undefined, view: GitWorkspaceView) =>
	view === "details" ? [prefix, key] : [prefix, key, "summary"];
export const gitSnapshotKey = (key: string | undefined, view: GitWorkspaceView) => [
	"gitWorkspaceSnapshot",
	key,
	view,
];

interface Entry {
	target: GitTarget;
	consumers: Record<GitWorkspaceView, number>;
	view: GitWorkspaceView;
	id: string;
	version: number;
	acknowledged: boolean;
	catchUp: boolean;
	failed: boolean;
	stagingGeneration?: number;
	observation?: GitStagingObservationState;
	observationRevision: number;
	observationSubscriptionId?: string;
	awaitingObservation: boolean;
	observationHolds: number;
	observationPrincipal?: unknown;
	principal?: unknown;
	observationInstances: Set<string>;
	stagingRefresh?: {
		dirty: boolean;
		verify: boolean;
		affected: Set<string>;
		promise: Promise<void>;
	};
}

/** One transport/lifecycle observer per QueryClient; facts share a workspace, grants never do. */
export class GitWorkspaceSubscriptions {
	private entries = new Map<string, Entry>();
	private listeners = new Set<() => void>();
	private dispose: (() => void) | undefined;
	private visible: boolean;
	private connected: boolean;
	private revision = 0;

	constructor(
		private readonly qc: QueryClient,
		private readonly transport: GitTransport,
		private readonly lifecycle?: PageLifecycleTarget,
		private readonly onRejected?: (target: GitTarget) => void,
	) {
		this.connected = !!transport.connected;
		this.visible =
			(lifecycle?.document ?? (typeof document === "undefined" ? undefined : document))
				?.visibilityState !== "hidden";
	}

	watch = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	getRevision = () => this.revision;
	getStagingObservation(target: GitTarget): GitStagingObservationState | undefined {
		const entry = this.entries.get(authorizationKey(target));
		return entry &&
			!entry.failed &&
			!entry.awaitingObservation &&
			this.connected &&
			this.visible &&
			entry.principal === this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
			? entry.observation
			: undefined;
	}
	getStagingSelectionKey(target: GitTarget): string {
		const entry = this.entries.get(authorizationKey(target));
		return JSON.stringify([entry?.id, entry?.observationRevision]);
	}
	isStagingWritable(target: GitTarget, summary: GitStagingSummary | undefined): boolean {
		const entry = this.entries.get(authorizationKey(target));
		const state = this.getStagingObservation(target);
		return (
			!!entry?.acknowledged &&
			entry.observationHolds === 0 &&
			!!state &&
			state.status === "settled" &&
			state.completedEpoch >= state.epoch &&
			state.generation === summary?.generation &&
			state.observationId === summary.observationId &&
			(summary.state === "ready" || summary.state === "conflict") &&
			entry.observationPrincipal === this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
		);
	}
	retireStagingSelections(target: GitTarget): void {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry) return;
		entry.observationRevision++;
		this.notify();
	}
	/** Retire selections immediately, before the HTTP/WS observer acknowledges its target epoch. */
	beginStagingObservation(target: GitTarget): void {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry) return;
		entry.awaitingObservation = true;
		entry.observationRevision++;
		this.notify();
	}
	holdStagingObservation(target: GitTarget): () => void {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry) return () => {};
		entry.observationHolds++;
		this.beginStagingObservation(target);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.observationHolds--;
			if (this.entries.get(authorizationKey(target)) === entry) this.notify();
		};
	}
	/** State ordering is independent of ordinary Git event versions and ownership generations. */
	publishStagingObservation(target: GitTarget, state: GitStagingObservationState): void {
		const entry = this.entries.get(authorizationKey(target));
		if (
			!entry ||
			entry.failed ||
			!entry.acknowledged ||
			!this.connected ||
			!this.visible ||
			entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id ||
			!state ||
			typeof state.instanceId !== "string" ||
			!state.instanceId ||
			![
				state.stateSequence,
				state.epoch,
				state.completedEpoch,
				state.round,
				state.generation,
			].every((value) => Number.isSafeInteger(value) && value >= 0) ||
			state.completedEpoch > state.epoch ||
			!["pending", "observing", "failed", "settled"].includes(state.status) ||
			(state.observationId !== null && typeof state.observationId !== "string")
		)
			return;
		const previous = entry.observation;
		if (previous?.instanceId === state.instanceId) {
			if (
				state.stateSequence < previous.stateSequence ||
				(state.stateSequence === previous.stateSequence &&
					entry.observationSubscriptionId === entry.id) ||
				state.epoch < previous.epoch ||
				state.round < previous.round ||
				state.generation < previous.generation ||
				state.completedEpoch < previous.completedEpoch
			)
				return;
		} else if (entry.observationInstances.has(state.instanceId)) return;
		else if (entry.observationInstances.size >= 1_024) {
			// Preserve tombstones and fail closed instead of accepting a retired server incarnation.
			this.beginStagingObservation(target);
			return;
		}
		if (!previous || previous.instanceId !== state.instanceId)
			entry.observationInstances.add(state.instanceId);
		if (
			!previous ||
			previous.instanceId !== state.instanceId ||
			previous.epoch !== state.epoch ||
			state.status !== "settled"
		)
			entry.observationRevision++;
		entry.observation = state;
		entry.observationSubscriptionId = entry.id;
		entry.awaitingObservation = false;
		entry.observationPrincipal = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		this.notify();
		if (state.status !== "settled" || state.completedEpoch < state.epoch) return;
		const principal = entry.observationPrincipal;
		const key = ["gitStagingLists", target.workspaceKey, target.narratorId, principal];
		const summary = this.qc.getQueryData<GitStagingSummary>(key);
		if (
			summary?.generation !== state.generation ||
			summary.observationId !== state.observationId ||
			this.qc.getQueryState(key)?.status === "error"
		)
			void this.invalidateStagingObservation(target, state.generation, [], true);
	}
	/** A changed index starts a new cursor chain with one bounded first-page read. */
	async invalidateStagingList(target: GitTarget, listId: string) {
		const queryKey = ["gitStagingFiles", target.workspaceKey, listId, target.narratorId];
		await this.qc.cancelQueries({ queryKey });
		this.qc.setQueriesData<InfiniteData<GitStagingFilesPage>>({ queryKey }, (previous) =>
			previous && previous.pages?.length > 1
				? { pages: previous.pages.slice(0, 1), pageParams: previous.pageParams.slice(0, 1) }
				: previous,
		);
		await Promise.all([
			this.qc.invalidateQueries({ queryKey }),
			this.qc.invalidateQueries({
				queryKey: ["gitStagingDiff", target.workspaceKey, listId, target.narratorId],
			}),
		]);
	}
	/** HTTP and WS publish the same observation. One summary read changes only content keys that changed. */
	invalidateStagingObservation(
		target: GitTarget,
		generation: number,
		affectedListIds: readonly string[],
		ensureSummary = false,
	): Promise<void> {
		const entry = this.entries.get(authorizationKey(target));
		if (entry?.stagingRefresh && generation <= (entry.stagingGeneration ?? -1)) {
			entry.stagingRefresh.verify ||= ensureSummary;
			for (const id of affectedListIds) entry.stagingRefresh.affected.add(id);
			return entry.stagingRefresh.promise;
		}
		if (!ensureSummary && entry && generation <= (entry.stagingGeneration ?? -1))
			return entry.stagingRefresh?.promise ?? Promise.resolve();
		if (entry) entry.stagingGeneration = generation;
		if (entry?.stagingRefresh) {
			entry.stagingRefresh.dirty = true;
			entry.stagingRefresh.verify ||= ensureSummary;
			for (const id of affectedListIds) entry.stagingRefresh.affected.add(id);
			return entry.stagingRefresh.promise;
		}
		const refresh = {
			dirty: false,
			verify: ensureSummary,
			affected: new Set(affectedListIds),
			promise: Promise.resolve(),
		};
		if (entry) entry.stagingRefresh = refresh;
		refresh.promise = (async () => {
			let verificationRead = false;
			try {
				do {
					refresh.dirty = false;
					await this.qc.invalidateQueries(
						{ queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId] },
						{ cancelRefetch: false },
					);
					if (entry && (this.entries.get(authorizationKey(target)) !== entry || entry.failed))
						return;
					const summary = this.qc
						.getQueriesData<GitStagingSummary>({
							queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId],
						})
						.map(([, data]) => data)
						.find((data) => data?.initialized);
					// Keep current and unaffected cursor chains. Retire only superseded content snapshots.
					await this.qc.invalidateQueries({
						predicate: (query) =>
							["gitStagingFiles", "gitStagingDiff"].includes(String(query.queryKey[0])) &&
							query.queryKey[1] === target.workspaceKey &&
							query.queryKey[3] === target.narratorId &&
							refresh.affected.has(String(query.queryKey[2])) &&
							query.queryKey[5] !==
								summary?.lists.find((list) => list.id === query.queryKey[2])?.snapshotVersion,
						refetchType: "none",
					});
					// A pre-publication GET can finish after settled. Re-read once only if it missed that target.
					const verified = entry?.observation;
					if (
						refresh.verify &&
						!refresh.dirty &&
						!verificationRead &&
						verified?.status === "settled"
					) {
						const summaryKey = [
							"gitStagingLists",
							target.workspaceKey,
							target.narratorId,
							entry?.observationPrincipal,
						];
						const observedSummary = this.qc.getQueryData<GitStagingSummary>(summaryKey);
						if (
							this.qc.getQueryState(summaryKey)?.status !== "error" &&
							(observedSummary?.generation !== verified.generation ||
								observedSummary.observationId !== verified.observationId)
						) {
							verificationRead = true;
							refresh.dirty = true;
						}
					}
				} while (refresh.dirty);
			} finally {
				if (entry?.stagingRefresh === refresh) entry.stagingRefresh = undefined;
			}
		})();
		return refresh.promise;
	}
	private notify() {
		this.revision++;
		for (const listener of this.listeners) listener();
	}
	isVisible() {
		return this.visible;
	}
	isPush(target: GitTarget) {
		return this.connected && !this.entries.get(authorizationKey(target))?.failed;
	}
	isDenied(target: GitTarget) {
		return !!this.entries.get(authorizationKey(target))?.failed;
	}
	/** HTTP read denials and push denials revoke the same cached workspace facts. */
	reject(target: GitTarget) {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry || entry.failed) return;
		entry.acknowledged = false;
		entry.failed = true;
		for (const prefix of FACTS) {
			void this.qc.cancelQueries({ queryKey: [prefix, gitTargetKey(target)] });
			this.qc.removeQueries({ queryKey: [prefix, gitTargetKey(target)] });
		}
		this.onRejected?.(target);
		void this.qc.invalidateQueries({ queryKey: ["gitWorkspace", target.narratorId] });
		this.notify();
	}
	/** Access continuity only, not data freshness or a write grant. Capture before await. */
	getWriteResultGuard(target: GitTarget): () => boolean {
		const key = authorizationKey(target);
		const entry = this.entries.get(key);
		const id = entry?.id;
		const principal = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		return () =>
			!!entry &&
			this.entries.get(key) === entry &&
			!entry.failed &&
			entry.id === id &&
			this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id === principal;
	}
	owns(key: string) {
		return (
			this.connected &&
			[...this.entries.values()].some(
				(entry) => !entry.failed && gitTargetKey(entry.target) === key,
			)
		);
	}

	subscribe(target: GitTarget, view: GitWorkspaceView = "details"): () => void {
		const key = authorizationKey(target);
		let entry = this.entries.get(key);
		if (entry) {
			entry.consumers[view]++;
			if (entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id) {
				this.unsubscribeEntry(entry);
				this.subscribeEntry(entry);
				this.notify();
			}
			this.updateView(entry);
		} else {
			entry = {
				target,
				consumers: { summary: 0, details: 0 },
				view,
				id: "",
				version: -1,
				acknowledged: false,
				catchUp: false,
				failed: false,
				observationRevision: 0,
				awaitingObservation: true,
				observationHolds: 0,
				observationInstances: new Set(),
			};
			entry.consumers[view]++;
			this.entries.set(key, entry);
			if (!this.dispose) this.observe();
			this.subscribeEntry(entry);
			this.notify();
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.entries.get(key);
			if (!current) return;
			current.consumers[view]--;
			if (current.consumers.summary + current.consumers.details) this.updateView(current);
			else {
				this.unsubscribeEntry(current);
				this.entries.delete(key);
				if (!this.entries.size) {
					this.dispose?.();
					this.dispose = undefined;
				}
			}
		};
	}

	private updateView(entry: Entry) {
		const view = entry.consumers.details ? "details" : "summary";
		if (view === entry.view) return;
		entry.view = view;
		// Projection changes must not release the directory's last watcher.
		if (this.connected && this.visible && entry.id) this.sendSubscribe(entry);
	}
	private unsubscribeEntry(entry: Entry) {
		if (entry.id && this.connected)
			this.transport.send({ type: "git_workspace_unsubscribe", subscriptionId: entry.id });
		entry.acknowledged = false;
		entry.awaitingObservation = true;
		entry.observationRevision++;
		entry.id = "";
	}
	private subscribeEntry(entry: Entry) {
		if (!this.connected || !this.visible) return;
		entry.id = `git-workspace-${++nextSubscriptionId}`;
		entry.principal = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		entry.version = -1;
		entry.stagingGeneration = undefined;
		entry.awaitingObservation = true;
		entry.observationRevision++;
		entry.failed = false;
		entry.acknowledged = false;
		const key = gitTargetKey(entry.target);
		for (const prefix of ["gitStatus", "gitLineStats"])
			void this.qc.cancelQueries({ queryKey: [prefix, key] });
		// Reconnect may reach a restarted server. Keep values, not its revision baseline.
		for (const view of entry.view === "details"
			? (["details", "summary"] as const)
			: (["summary"] as const)) {
			this.qc.setQueryData<GitWorkspaceSnapshot>(gitSnapshotKey(key, view), (previous) =>
				previous ? { ...previous, revision: -1, updating: true } : undefined,
			);
		}
		this.sendSubscribe(entry);
	}
	private sendSubscribe(entry: Entry) {
		this.transport.send({
			type: "git_workspace_subscribe",
			subscriptionId: entry.id,
			view: entry.view,
			narratorId: entry.target.narratorId,
			workspaceKey: entry.target.workspaceKey,
		});
	}
	/** Manual refresh is one WS request; server mutations already mark their workspace dirty. */
	refresh(target: GitTarget): boolean {
		if (!this.visible) return true;
		const entry = this.entries.get(authorizationKey(target));
		if (!entry || !this.connected) return false;
		if (entry.failed) {
			this.subscribeEntry(entry);
			this.notify();
		} else if (entry.id && entry.acknowledged) {
			this.beginStagingObservation(target);
			this.transport.send({ type: "git_workspace_refresh", subscriptionId: entry.id });
		}
		return true;
	}
	retry(target: GitTarget) {
		const entry = this.entries.get(authorizationKey(target));
		if (entry?.failed) this.refresh(target);
	}

	private observe() {
		this.connected = !!this.transport.connected;
		this.visible =
			(this.lifecycle?.document ?? (typeof document === "undefined" ? undefined : document))
				?.visibilityState !== "hidden";
		const handle = this.transport.addListener(
			{
				narratorIds: "*",
				types: [
					"git_workspace_subscribed",
					"git_workspace_changed",
					"git_workspace_staging_lists_changed",
					"git_workspace_staging_observation",
					"git_workspace_snapshot",
					"git_workspace_error",
					"narrator_access_changed",
				],
			},
			(data) => this.receive(data),
		);
		const offConnection = this.transport.onConnectionChange((connected) => {
			if (this.connected === connected) return;
			this.connected = connected;
			for (const entry of this.entries.values()) {
				entry.catchUp ||= entry.acknowledged;
				entry.acknowledged = false;
				entry.awaitingObservation = true;
				entry.observationRevision++;
				if (connected) this.subscribeEntry(entry);
			}
			this.notify();
		});
		const offLifecycle = observePageLifecycle(
			{
				onHidden: () => {
					if (!this.visible) return;
					this.visible = false;
					for (const entry of this.entries.values()) {
						entry.catchUp ||= entry.acknowledged;
						this.unsubscribeEntry(entry);
					}
					this.notify();
				},
				onForeground: () => {
					if (
						this.visible ||
						(this.lifecycle?.document ?? (typeof document === "undefined" ? undefined : document))
							?.visibilityState === "hidden"
					)
						return;
					this.visible = true;
					for (const entry of this.entries.values()) this.subscribeEntry(entry);
					this.notify();
				},
			},
			this.lifecycle,
		);
		this.dispose = () => {
			offConnection();
			offLifecycle();
			this.transport.removeListener(handle);
		};
	}

	private receive(data: Parameters<MessageCallback>[0]) {
		if (data.type === "narrator_access_changed") {
			// Access hints invalidate pending results even before React applies its cache cleanup.
			for (const value of this.entries.values()) {
				if (data.narratorId !== value.target.narratorId) continue;
				this.unsubscribeEntry(value);
				this.subscribeEntry(value);
			}
			this.notify();
			return;
		}
		const entry = [...this.entries.values()].find(
			(value) => value.id && value.id === data.subscriptionId,
		);
		if (
			!entry ||
			!this.connected ||
			!this.visible ||
			entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
		)
			return;
		const target = entry.target;
		if (data.type === "git_workspace_error") {
			this.reject(target);
			return;
		}
		if (data.workspaceKey !== target.workspaceKey) return;
		if (data.type === "git_workspace_staging_observation") {
			if (
				data.narratorId !== target.narratorId ||
				(target.repositoryKey && data.repositoryKey !== target.repositoryKey)
			)
				return;
			this.publishStagingObservation(target, data.observation as GitStagingObservationState);
			return;
		}
		const initial = data.type === "git_workspace_subscribed";
		if (initial) {
			if (entry.acknowledged) return;
			entry.acknowledged = true;
			entry.version = typeof data.version === "number" ? data.version : -1;
			// The separate observation state verifies the post-gap baseline; matching snapshots stay cached.
			if (!entry.catchUp) return;
			entry.catchUp = false;
		}
		if (
			!initial &&
			(!entry.acknowledged || typeof data.version !== "number" || data.version <= entry.version)
		)
			return;
		if (data.type === "git_workspace_staging_lists_changed") {
			if (
				data.narratorId !== target.narratorId ||
				(target.repositoryKey && data.repositoryKey !== target.repositoryKey) ||
				(data.metadataChanged !== true &&
					typeof data.listId !== "string" &&
					!Array.isArray(data.affectedListIds)) ||
				(data.affectedListIds !== undefined &&
					(!Array.isArray(data.affectedListIds) ||
						data.affectedListIds.some((id: unknown) => typeof id !== "string" || !id))) ||
				!Number.isSafeInteger(data.version) ||
				(data.listId !== undefined && (typeof data.listId !== "string" || !data.listId)) ||
				(data.metadataChanged !== undefined && typeof data.metadataChanged !== "boolean")
			)
				return;
			entry.version = data.version as number;
			if (
				typeof data.generation === "number" &&
				data.generation <
					Math.max(entry.stagingGeneration ?? -1, entry.observation?.generation ?? -1)
			)
				return;
			if (
				typeof data.generation !== "number" ||
				data.generation !== entry.observation?.generation ||
				data.observationId !== entry.observation?.observationId
			)
				this.beginStagingObservation(target);
			const affected = new Set<string>(
				Array.isArray(data.affectedListIds) ? data.affectedListIds : [],
			);
			if (typeof data.listId === "string") affected.add(data.listId);
			if (typeof data.generation === "number" && Number.isSafeInteger(data.generation))
				void this.invalidateStagingObservation(target, data.generation, [...affected]);
			else {
				void this.qc.invalidateQueries({
					queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId],
				});
				for (const id of affected) void this.invalidateStagingList(target, id);
			}
			return;
		}
		if (data.type === "git_workspace_snapshot") {
			if (data.view !== entry.view || !data.snapshot || typeof data.version !== "number") return;
			entry.version = data.version;
			const snapshot = data.snapshot as GitWorkspaceSnapshot;
			for (const key of new Set([gitTargetKey(target), data.workspaceKey])) {
				if (typeof key !== "string") continue;
				this.publish(key, entry.view, snapshot);
				if (data.view === "details") this.publish(key, "summary", snapshot);
			}
			return;
		}
		if (!initial) {
			if (data.type !== "git_workspace_changed") return;
			entry.version = data.version as number;
		}
		// Only non-statistical views need catch-up after missed change categories.
		const categories = initial
			? ["worktree", "refs", "stash"]
			: Array.isArray(data.categories)
				? data.categories
				: [];
		const prefixes = new Set<string>();
		if (categories.some((category) => ["worktree", "index", "head", "refs"].includes(category)))
			for (const prefix of ["gitModifications", "gitDiff", "gitStatusPageStats"])
				prefixes.add(prefix);
		if (categories.includes("refs") || categories.includes("head")) prefixes.add("gitLog");
		if (categories.includes("stash")) prefixes.add("gitStashList");
		const keys = new Set([gitTargetKey(target), data.workspaceKey]);
		for (const [, workspace] of this.qc.getQueriesData<GitWorkspace>({
			queryKey: ["gitWorkspace"],
		})) {
			if (!workspace?.workspaceKey) continue;
			if (workspace.workspaceKey === data.workspaceKey) {
				keys.add(workspace.workspaceKey);
			} else if (data.repositoryKey && workspace.repositoryKey === data.repositoryKey) {
				for (const prefix of ["gitLog", "gitStashList"])
					if (prefixes.has(prefix))
						void this.qc.invalidateQueries({ queryKey: [prefix, workspace.workspaceKey] });
			}
		}
		for (const key of keys)
			if (typeof key === "string")
				for (const prefix of prefixes) void this.qc.invalidateQueries({ queryKey: [prefix, key] });
	}

	private publish(key: string, view: GitWorkspaceView, snapshot: GitWorkspaceSnapshot) {
		const queryKey = gitSnapshotKey(key, view);
		const previous = this.qc.getQueryData<GitWorkspaceSnapshot>(queryKey);
		if (
			previous &&
			(previous.revision > snapshot.revision ||
				(previous.revision === snapshot.revision && !previous.updating && snapshot.updating))
		)
			return;
		const projected = { ...snapshot };
		if (view === "summary") {
			if (snapshot.status) {
				const { files: _, ...status } = snapshot.status;
				projected.status = status;
			}
			if (snapshot.lineStats) {
				const { files: _, ...lines } = snapshot.lineStats;
				projected.lineStats = lines;
			}
		}
		this.qc.setQueryData(queryKey, projected);
		if (projected.status && (view === "summary" || projected.status.files))
			this.qc.setQueryData(gitFactKey("gitStatus", key, view), {
				...projected.status,
				truncated: projected.status.truncated || projected.detailsTruncated,
			});
		if (projected.lineStats && (view === "summary" || projected.lineStats.files))
			this.qc.setQueryData(gitFactKey("gitLineStats", key, view), projected.lineStats);
	}
}
