import type { GitStatusPageCacheState } from "@shared/git-status-page";
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
	reconnect?(): void;
	getCredentialIdentity?(): unknown;
	getConnectionCredentialIdentity?(): unknown;
	onCredentialChange?(callback: () => void): () => void;
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

export type GitAuthorizationState =
	| "waiting"
	| "authorized"
	| "paused"
	| "refresh_required"
	| "denied"
	| "workspace_changed";

interface Entry {
	target: GitTarget;
	consumers: Record<GitWorkspaceView, number>;
	view: GitWorkspaceView;
	id: string;
	version: number;
	acknowledged: boolean;
	catchUp: boolean;
	state: GitAuthorizationState;
	authorizationEpoch: number;
	errorCode?: string;
	readError?: Error;
	workspaceReprobed?: boolean;
	writeConfirmed?: boolean;
	confirmedCanWrite?: boolean;
	everAcknowledged?: boolean;
	everSubscribed?: boolean;
	httpAuthorized?: boolean;
	stagingGeneration?: number;
	statusPages?: GitStatusPageCacheState;
	statusPagesUpdating?: boolean;
	retiredPageWorkers: Set<string>;
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
	private principalTransition = false;
	private principalRequiresProbe = false;
	private principalCredential: unknown;
	private principalIdentity: unknown;
	private hasPrincipalBinding = false;
	private subjectConsumers = 0;
	private trustedCredential: unknown;
	private trustedPrincipal: unknown;
	private awaitingPrincipal = false;
	private reconnectCredential: unknown;
	private credentialChanged = false;
	private verifiedTargets = new Map<string, { principal: unknown; repositoryKey?: string }>();

	constructor(
		private readonly qc: QueryClient,
		private readonly transport: GitTransport,
		private readonly lifecycle?: PageLifecycleTarget,
		private readonly onRejected?: (target: GitTarget, denied: boolean) => void,
		private readonly onWorkspaceChanged?: (target: GitTarget) => void,
		private readonly onAuthorized?: (target: GitTarget, renewed: boolean) => void,
	) {
		this.connected = !!transport.connected;
		this.principalCredential = transport.getCredentialIdentity?.();
		this.principalIdentity = qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		this.trustedCredential = this.principalCredential;
		this.trustedPrincipal = this.principalIdentity;
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
	getPrincipalKey(): string {
		return JSON.stringify([
			this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id,
			this.transport.getCredentialIdentity?.(),
		]);
	}
	retainSubject(): () => void {
		this.synchronizePrincipal();
		this.hasPrincipalBinding = true;
		this.subjectConsumers++;
		if (!this.dispose) this.observe();
		return () => {
			this.subjectConsumers--;
			if (!this.subjectConsumers && !this.entries.size && !this.principalTransition) {
				this.dispose?.();
				this.dispose = undefined;
			}
		};
	}
	getStatusPageConnectionKey(target: GitTarget): string | undefined {
		const entry = this.entries.get(authorizationKey(target));
		return entry?.acknowledged &&
			this.isPush(target) &&
			this.visible &&
			(!target.repositoryKey || entry.target.repositoryKey === target.repositoryKey) &&
			entry.principal === this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
			? entry.id
			: undefined;
	}
	isStatusPageUpdating(target: GitTarget): boolean {
		return this.entries.get(authorizationKey(target))?.statusPagesUpdating === true;
	}
	getStatusPageState(target: GitTarget): GitStatusPageCacheState | undefined {
		const entry = this.entries.get(authorizationKey(target));
		return entry &&
			this.canRead(target) &&
			entry.principal === this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
			? entry.statusPages
			: undefined;
	}
	/** Capture before dispatch: a response cannot replace a newer connection or Worker notice. */
	statusPageReadPublisher(
		target: GitTarget,
		{ membershipOnly = false } = {},
	): (state: GitStatusPageCacheState) => boolean {
		const key = authorizationKey(target);
		const entry = this.entries.get(key);
		const id = entry?.id;
		const principal = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		const worker = entry?.statusPages?.workerEpoch;
		const authorized = this.getWriteResultGuard(target);
		return (state) => {
			if (
				!entry ||
				this.entries.get(key) !== entry ||
				entry.id !== id ||
				!authorized() ||
				this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id !== principal
			)
				return false;
			const previous = entry.statusPages;
			if (previous && previous.workerEpoch !== worker && state.workerEpoch !== previous.workerEpoch)
				return false;
			const samePublished =
				previous?.workerEpoch === state.workerEpoch &&
				previous.memberVersion === state.memberVersion &&
				previous.statsVersion === state.statsVersion;
			if (
				membershipOnly &&
				previous?.workerEpoch === state.workerEpoch &&
				previous.memberVersion === state.memberVersion &&
				previous.statsVersion > state.statsVersion
			)
				return true;
			// Equal versions do not order scheduling/error transitions. Keep the latest
			// authorized notice instead of letting an older HTTP read clear it.
			return samePublished || this.publishStatusPageState(target, state);
		};
	}
	/** HTTP reconciliation may advance a published version, never resurrect a retired Worker. */
	publishStatusPageState(target: GitTarget, state: GitStatusPageCacheState): boolean {
		const entry = this.entries.get(authorizationKey(target));
		if (
			!entry ||
			!this.canRead(target) ||
			!state ||
			entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id ||
			typeof state.workerEpoch !== "string" ||
			!Number.isSafeInteger(state.memberVersion) ||
			!Number.isSafeInteger(state.statsVersion) ||
			entry.retiredPageWorkers.has(state.workerEpoch)
		)
			return false;
		const previous = entry.statusPages;
		if (
			previous?.workerEpoch === state.workerEpoch &&
			(previous.memberVersion > state.memberVersion ||
				(previous.memberVersion === state.memberVersion &&
					previous.statsVersion > state.statsVersion))
		)
			return false;
		if (previous && previous.workerEpoch !== state.workerEpoch) {
			entry.retiredPageWorkers.add(previous.workerEpoch);
			if (entry.retiredPageWorkers.size > 16) {
				const oldest = entry.retiredPageWorkers.values().next().value;
				if (oldest !== undefined) entry.retiredPageWorkers.delete(oldest);
			}
		}
		if (JSON.stringify(previous) === JSON.stringify(state)) return true;
		entry.statusPages = state;
		entry.statusPagesUpdating = state.updating;
		this.notify();
		return true;
	}
	private markStatusPagesUpdating(entry: Entry): void {
		if (entry.statusPagesUpdating) return;
		entry.statusPagesUpdating = true;
		if (entry.statusPages) entry.statusPages = { ...entry.statusPages, updating: true };
		this.notify();
	}
	getStagingObservation(target: GitTarget): GitStagingObservationState | undefined {
		const entry = this.entries.get(authorizationKey(target));
		return entry &&
			this.canRead(target) &&
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
			this.canWrite(target) &&
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
			!this.canRead(target) ||
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
		const authorized = this.getWriteResultGuard(target);
		if (!authorized()) return Promise.resolve();
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
					if (!authorized()) return;
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
	/** Transport ownership is not authorization; paused push subscriptions never trigger HTTP fallback. */
	isPush(target: GitTarget) {
		return this.connected && !this.isDenied(target);
	}
	getState(target: GitTarget): GitAuthorizationState {
		return this.entries.get(authorizationKey(target))?.state ?? "waiting";
	}
	getReadError(target: GitTarget): Error | undefined {
		return this.entries.get(authorizationKey(target))?.readError;
	}
	getAuthorizationKey(target: GitTarget): string {
		const entry = this.entries.get(authorizationKey(target));
		return JSON.stringify([entry?.id, entry?.authorizationEpoch]);
	}
	private completePrincipalTransition(): boolean {
		if (
			!this.principalTransition ||
			!this.connected ||
			this.awaitingPrincipal ||
			!this.credentialChanged ||
			this.principalIdentity === undefined ||
			this.transport.getConnectionCredentialIdentity?.() !== this.principalCredential ||
			this.transport.getCredentialIdentity?.() !== this.principalCredential
		)
			return false;
		this.principalTransition = false;
		return true;
	}
	private synchronizePrincipal(principalObserved = false, reconnect = true) {
		const current = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		const credential = this.transport.getCredentialIdentity?.();
		if (!this.hasPrincipalBinding) {
			this.principalIdentity = current;
			this.principalCredential = credential;
			this.trustedCredential = credential;
			this.trustedPrincipal = current;
			return;
		}
		const principalChanged = this.principalIdentity !== current;
		const tokenChanged = this.principalCredential !== credential;
		if (!principalChanged && !tokenChanged) {
			if (principalObserved && this.awaitingPrincipal && current !== undefined) {
				this.awaitingPrincipal = false;
				if (this.completePrincipalTransition())
					for (const entry of this.entries.values()) this.subscribeEntry(entry);
				void this.qc.invalidateQueries({ queryKey: ["gitWorkspace"] });
				this.notify();
			}
			return;
		}
		this.credentialChanged = credential !== undefined && credential !== this.trustedCredential;
		this.awaitingPrincipal =
			tokenChanged && !principalObserved && current === this.trustedPrincipal;
		this.principalCredential = credential;
		this.principalIdentity = current;
		this.principalTransition = true;
		this.principalRequiresProbe = true;
		this.verifiedTargets.clear();
		if (!this.dispose) this.observe();
		for (const entry of this.entries.values()) {
			this.unsubscribeEntry(entry, true, true);
			entry.principal = current;
			entry.state = "refresh_required";
		}
		const privateQueries = {
			predicate: (query: { queryKey: readonly unknown[] }) => {
				const prefix = String(query.queryKey[0]);
				if (prefix === "gitWorkspace" || prefix === "gitSummary")
					return (
						(tokenChanged && !principalObserved) ||
						query.queryKey.length < 5 ||
						query.queryKey[4] !== current
					);
				return [...FACTS, "gitBranches"].includes(prefix);
			},
		};
		void this.qc.cancelQueries(privateQueries);
		this.qc.removeQueries(privateQueries);
		if (tokenChanged && !principalObserved) {
			void this.qc.cancelQueries({ queryKey: ["auth", "me"], exact: true });
			void this.qc.invalidateQueries({ queryKey: ["auth", "me"], exact: true });
		}
		if (this.completePrincipalTransition()) {
			for (const entry of this.entries.values()) this.subscribeEntry(entry);
		} else if (
			reconnect &&
			this.credentialChanged &&
			this.reconnectCredential !== credential &&
			this.transport.getConnectionCredentialIdentity?.() !== credential
		) {
			this.reconnectCredential = credential;
			this.transport.reconnect?.();
		}
		this.notify();
	}
	canConfirmWorkspace(): boolean {
		return !this.awaitingPrincipal && (!this.principalTransition || this.credentialChanged);
	}
	private verified(target: GitTarget): boolean {
		const value = this.verifiedTargets.get(authorizationKey(target));
		return (
			!!value &&
			value.principal === this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id &&
			(!target.repositoryKey || value.repositoryKey === target.repositoryKey)
		);
	}
	needsWorkspaceProbe(narratorId: string): boolean {
		if (
			this.hasPrincipalBinding &&
			(this.principalIdentity !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id ||
				this.transport.getCredentialIdentity?.() !== this.principalCredential)
		)
			return true;
		return (
			this.principalRequiresProbe &&
			![...this.verifiedTargets.keys()].some(
				(key) => (JSON.parse(key) as unknown[])[0] === narratorId,
			)
		);
	}
	canRead(target: GitTarget): boolean {
		const entry = this.entries.get(authorizationKey(target));
		if (
			this.hasPrincipalBinding &&
			this.principalIdentity !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
		)
			return false;
		if (
			!this.visible ||
			this.principalTransition ||
			this.awaitingPrincipal ||
			(this.transport.getCredentialIdentity &&
				this.transport.getCredentialIdentity() !== this.principalCredential) ||
			(this.principalRequiresProbe && !this.verified(target))
		)
			return false;
		if (!entry) return !this.connected;
		if (target.repositoryKey && entry.target.repositoryKey !== target.repositoryKey) return false;
		if (entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id)
			return false;
		// Preserve initial HTTP-only clients, never fall back after a grant or pause.
		return entry.state === "authorized" && entry.acknowledged && this.connected
			? true
			: !this.connected &&
					!entry.everSubscribed &&
					(entry.httpAuthorized === true ||
						(entry.authorizationEpoch === 0 && entry.state === "waiting"));
	}
	isDenied(target: GitTarget) {
		return this.getState(target) === "denied";
	}
	private suspend(
		entry: Entry,
		state: GitAuthorizationState,
		clear = false,
		cancelWorkspace = true,
	) {
		entry.catchUp ||= entry.acknowledged;
		entry.acknowledged = false;
		entry.httpAuthorized = false;
		entry.authorizationEpoch++;
		entry.state = state;
		entry.awaitingObservation = true;
		entry.observationRevision++;
		entry.observationSubscriptionId = undefined;
		entry.stagingRefresh = undefined;
		const key = gitTargetKey(entry.target);
		if (cancelWorkspace)
			void this.qc.cancelQueries({ queryKey: ["gitWorkspace", entry.target.narratorId] });
		void this.qc.cancelQueries({ queryKey: ["gitSummary", entry.target.narratorId] });
		for (const prefix of [...FACTS, "gitBranches"]) {
			void this.qc.cancelQueries({ queryKey: [prefix, key] });
			if (clear) this.qc.removeQueries({ queryKey: [prefix, key] });
		}
	}
	pauseNarrator(narratorId: string, retry = false) {
		for (const entry of this.entries.values()) {
			if (entry.target.narratorId !== narratorId) continue;
			this.unavailable(entry.target);
			if (retry) this.refresh(entry.target);
		}
	}
	revokeNarrator(narratorId: string, denied: boolean) {
		for (const entry of this.entries.values()) {
			if (entry.target.narratorId !== narratorId) continue;
			if (denied) this.reject(entry.target);
			else this.unavailable(entry.target, true);
		}
	}
	private retireTransport(entry: Entry) {
		if (entry.id && this.connected)
			this.transport.send({ type: "git_workspace_unsubscribe", subscriptionId: entry.id });
		entry.id = "";
	}
	/** HTTP read denials and push denials revoke the same cached workspace facts. */
	reject(target: GitTarget, error?: Error) {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry || this.isDenied(target)) return;
		if (error) entry.readError = error;
		this.suspend(entry, "denied", true);
		this.retireTransport(entry);
		this.onRejected?.(target, true);
		this.notify();
	}
	canWrite(target: GitTarget): boolean {
		const entry = this.entries.get(authorizationKey(target));
		return (
			this.canRead(target) && entry?.writeConfirmed !== false && entry?.confirmedCanWrite !== false
		);
	}
	confirmWorkspace(target: GitTarget | null) {
		this.synchronizePrincipal();
		if (!this.canConfirmWorkspace())
			throw new DOMException("Git principal confirmation pending", "AbortError");
		this.hasPrincipalBinding = true;
		if (!target) return;
		this.verifiedTargets.set(authorizationKey(target), {
			principal: this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id,
			repositoryKey: target.repositoryKey ?? undefined,
		});
		if (this.verifiedTargets.size > 64) {
			const oldest = this.verifiedTargets.keys().next().value;
			if (oldest !== undefined) this.verifiedTargets.delete(oldest);
		}
		const entry = this.entries.get(authorizationKey(target));
		if (entry && !entry.everSubscribed && !this.connected && !this.principalTransition) {
			entry.httpAuthorized = true;
			entry.state = "authorized";
		}
		if (entry?.state === "authorized") {
			if (
				entry.readError ||
				entry.writeConfirmed === false ||
				entry.confirmedCanWrite !== target.canWrite
			) {
				entry.readError = undefined;
				entry.confirmedCanWrite = target.canWrite;
				entry.writeConfirmed = true;
				this.notify();
			}
			return;
		}
		if (entry && !entry.id && this.principalRequiresProbe) {
			entry.target = target;
			if (!this.principalTransition) this.subscribeEntry(entry);
			this.notify();
			return;
		}
		if (entry?.state !== "workspace_changed") return;
		this.unsubscribeEntry(entry, false, true);
		entry.target = target;
		this.subscribeEntry(entry);
		this.notify();
	}
	workspaceChanged(target: GitTarget) {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry) return;
		const reprobe = !entry.workspaceReprobed;
		entry.workspaceReprobed = true;
		this.suspend(entry, "workspace_changed");
		if (reprobe) this.onWorkspaceChanged?.(target);
		this.notify();
	}
	unavailable(target: GitTarget, clear = false, error?: Error) {
		const entry = this.entries.get(authorizationKey(target));
		if (!entry) return;
		if (error) entry.readError = error;
		this.suspend(entry, "refresh_required", clear);
		if (clear) {
			this.retireTransport(entry);
			this.onRejected?.(target, false);
		}
		this.notify();
	}
	/** Access continuity only, not data freshness or a write grant. Capture before await. */
	getWriteResultGuard(target: GitTarget): () => boolean {
		const key = authorizationKey(target);
		const entry = this.entries.get(key);
		const id = entry?.id;
		const epoch = entry?.authorizationEpoch;
		const principal = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		if (!entry)
			return () => {
				const current = this.entries.get(key);
				return (
					!this.connected &&
					(!current || current.authorizationEpoch === 0) &&
					this.canRead(target) &&
					this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id === principal
				);
			};
		return () =>
			!!entry &&
			this.entries.get(key) === entry &&
			this.canRead(target) &&
			entry.id === id &&
			entry.authorizationEpoch === epoch &&
			this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id === principal;
	}
	owns(key: string) {
		return (
			this.connected &&
			[...this.entries.values()].some((entry) => !!entry.id && gitTargetKey(entry.target) === key)
		);
	}

	subscribe(target: GitTarget, view: GitWorkspaceView = "details"): () => void {
		this.synchronizePrincipal();
		this.hasPrincipalBinding = true;
		const key = authorizationKey(target);
		let entry = this.entries.get(key);
		if (entry) {
			entry.consumers[view]++;
			if (
				entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id ||
				(target.repositoryKey && entry.target.repositoryKey !== target.repositoryKey)
			) {
				this.unsubscribeEntry(entry);
				entry.target = target;
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
				state: "waiting",
				authorizationEpoch: 0,
				principal: this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id,
				observationRevision: 0,
				awaitingObservation: true,
				observationHolds: 0,
				observationInstances: new Set(),
				retiredPageWorkers: new Set(),
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
				if (!this.entries.size && !this.subjectConsumers && !this.principalTransition) {
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
	private unsubscribeEntry(entry: Entry, clear = false, preserveWorkspaceRead = true) {
		if (entry.id && this.connected)
			this.transport.send({ type: "git_workspace_unsubscribe", subscriptionId: entry.id });
		this.suspend(entry, "waiting", clear, !preserveWorkspaceRead);
		entry.id = "";
	}
	private subscribeEntry(entry: Entry) {
		if (this.principalTransition || (this.principalRequiresProbe && !this.verified(entry.target))) {
			entry.state = "refresh_required";
			return;
		}
		if (!this.connected || !this.visible) return;
		const credential = this.transport.getCredentialIdentity?.();
		if (
			this.transport.getCredentialIdentity &&
			(credential === undefined ||
				this.transport.getConnectionCredentialIdentity?.() !== credential)
		) {
			entry.state = "refresh_required";
			if (credential !== undefined) {
				this.principalTransition = true;
				this.principalCredential = credential;
				this.credentialChanged = true;
				this.transport.reconnect?.();
			}
			return;
		}
		entry.id = `git-workspace-${++nextSubscriptionId}`;
		entry.everSubscribed = true;
		entry.principal = this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
		entry.version = -1;
		// A new authorization/connection owns its own cache baseline.
		entry.statusPages = undefined;
		entry.statusPagesUpdating = false;
		entry.retiredPageWorkers.clear();
		entry.stagingGeneration = undefined;
		entry.awaitingObservation = true;
		entry.observationRevision++;
		entry.state = "waiting";
		entry.errorCode = undefined;
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
		entry.readError = undefined;
		if (entry.state === "denied" || entry.errorCode === "GIT_WORKSPACE_SUBSCRIPTION_LIMIT") {
			this.subscribeEntry(entry);
			this.notify();
		} else if (entry.id) {
			if (entry.acknowledged) {
				this.markStatusPagesUpdating(entry);
				this.beginStagingObservation(target);
			} else if (entry.state !== "workspace_changed") {
				entry.state = "paused";
				this.notify();
			}
			this.transport.send({ type: "git_workspace_refresh", subscriptionId: entry.id });
		} else this.subscribeEntry(entry);
		return true;
	}
	retry(target: GitTarget) {
		const entry = this.entries.get(authorizationKey(target));
		if (entry && entry.state !== "waiting" && !entry.acknowledged) this.refresh(target);
	}

	private observe() {
		this.connected = !!this.transport.connected;
		this.completePrincipalTransition();
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
		const offPrincipal = this.qc.getQueryCache().subscribe((event) => {
			if (event.query.queryKey[0] === "auth" && event.query.queryKey[1] === "me")
				this.synchronizePrincipal(event.type === "updated" && event.action.type === "success");
		});
		const offCredential = this.transport.onCredentialChange?.(() => this.synchronizePrincipal());
		const offConnection = this.transport.onConnectionChange((connected) => {
			if (this.connected === connected) return;
			this.synchronizePrincipal(false, false);
			this.connected = connected;
			this.completePrincipalTransition();
			for (const entry of this.entries.values()) {
				this.suspend(entry, "waiting");
				if (connected) this.subscribeEntry(entry);
			}
			this.notify();
			if (!this.entries.size && !this.subjectConsumers && !this.principalTransition) {
				this.dispose?.();
				this.dispose = undefined;
			}
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
			offPrincipal();
			offCredential?.();
			offConnection();
			offLifecycle();
			this.transport.removeListener(handle);
		};
	}

	private receive(data: Parameters<MessageCallback>[0]) {
		if (!data) return;
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
			this.principalTransition ||
			this.awaitingPrincipal ||
			(this.transport.getCredentialIdentity &&
				this.transport.getCredentialIdentity() !== this.principalCredential) ||
			entry.principal !== this.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id
		)
			return;
		const target = entry.target;
		if (data.type === "git_workspace_error") {
			if (data.version !== undefined) {
				if (!Number.isSafeInteger(data.version) || (data.version as number) <= entry.version)
					return;
				entry.version = data.version as number;
			}
			const denied =
				data.kind === "denied" ||
				(data.kind === undefined &&
					[
						"GIT_WORKSPACE_ACCESS_DENIED",
						"GIT_ACCESS_DENIED",
						"ACCESS_DENIED",
						"access_denied",
						"FORBIDDEN",
					].includes(String(data.code)));
			const changed = data.kind === "workspace_changed";
			const alreadyChanged = entry.workspaceReprobed === true;
			if (changed) entry.workspaceReprobed = true;
			const state = denied
				? "denied"
				: changed
					? "workspace_changed"
					: data.retrying === true
						? "paused"
						: "refresh_required";
			this.suspend(entry, state, denied || data.code === "GIT_WORKSPACE_UNAVAILABLE");
			if (denied) this.retireTransport(entry);
			entry.errorCode = typeof data.code === "string" ? data.code : undefined;
			if (denied || data.code === "GIT_WORKSPACE_UNAVAILABLE") this.onRejected?.(target, denied);
			if (changed && !alreadyChanged) this.onWorkspaceChanged?.(target);
			this.notify();
			return;
		}
		if (
			data.workspaceKey !== target.workspaceKey ||
			data.narratorId !== target.narratorId ||
			(target.repositoryKey && data.repositoryKey !== target.repositoryKey) ||
			!Number.isSafeInteger(data.version) ||
			(data.version as number) <= entry.version
		)
			return;
		const initial = data.type === "git_workspace_subscribed";
		if (initial) {
			if (entry.state === "workspace_changed") return;
			const renewed = entry.everAcknowledged === true;
			if (entry.acknowledged) this.suspend(entry, "waiting");
			entry.writeConfirmed = !renewed || !this.onAuthorized;
			entry.everAcknowledged = true;
			entry.acknowledged = true;
			this.trustedCredential = this.transport.getCredentialIdentity?.();
			this.trustedPrincipal = entry.principal;
			entry.state = "authorized";
			entry.readError = undefined;
			entry.workspaceReprobed = false;
			entry.errorCode = undefined;
			entry.version = data.version as number;
			if (renewed) {
				for (const view of ["details", "summary"] as const)
					this.qc.setQueryData<GitWorkspaceSnapshot>(
						gitSnapshotKey(gitTargetKey(target), view),
						(previous) => (previous ? { ...previous, revision: -1, updating: true } : undefined),
					);
			}
			this.onAuthorized?.(target, renewed);
			this.notify();
			// Reauthorization starts a fresh cache baseline on the same subscription.
			if (!entry.catchUp) return;
			entry.catchUp = false;
		}
		if (!initial && !entry.acknowledged) return;
		if (data.type === "git_workspace_staging_observation") {
			entry.version = data.version as number;
			this.publishStagingObservation(target, data.observation as GitStagingObservationState);
			return;
		}
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
			if (snapshot.statusPages) {
				this.publishStatusPageState(target, snapshot.statusPages);
				entry.statusPagesUpdating = entry.statusPages?.updating;
				this.notify();
			}
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
			if (
				Array.isArray(data.categories) &&
				data.categories.some((category) => ["worktree", "index", "head", "refs"].includes(category))
			)
				this.markStatusPagesUpdating(entry);
		}
		// Only non-statistical views need catch-up after missed change categories.
		const categories = initial
			? ["worktree", "refs", "stash"]
			: Array.isArray(data.categories)
				? data.categories
				: [];
		const prefixes = new Set<string>();
		if (categories.some((category) => ["worktree", "index", "head", "refs"].includes(category)))
			for (const prefix of ["gitModifications", "gitDiff"]) prefixes.add(prefix);
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
