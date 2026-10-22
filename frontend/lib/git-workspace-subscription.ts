import type { QueryClient } from "@tanstack/react-query";
import type { GitWorkspaceSnapshot, GitWorkspaceView } from "../../shared/git-workspace-events";
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
	"gitLineStats",
	"gitWorkspaceSnapshot",
	"gitModifications",
	"gitDiff",
	"gitLog",
	"gitStashList",
	"gitCommitDetail",
	"gitCommitDiff",
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
		entry.id = "";
	}
	private subscribeEntry(entry: Entry) {
		if (!this.connected || !this.visible) return;
		entry.id = `git-workspace-${++nextSubscriptionId}`;
		entry.version = -1;
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
		} else if (entry.id && entry.acknowledged)
			this.transport.send({ type: "git_workspace_refresh", subscriptionId: entry.id });
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
					"git_workspace_snapshot",
					"git_workspace_error",
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
		const entry = [...this.entries.values()].find(
			(value) => value.id && value.id === data.subscriptionId,
		);
		if (!entry || !this.connected || !this.visible) return;
		const target = entry.target;
		if (data.type === "git_workspace_error") {
			entry.acknowledged = false;
			entry.failed = true;
			for (const prefix of FACTS) {
				void this.qc.cancelQueries({ queryKey: [prefix, gitTargetKey(target)] });
				this.qc.removeQueries({ queryKey: [prefix, gitTargetKey(target)] });
			}
			this.onRejected?.(target);
			void this.qc.invalidateQueries({ queryKey: ["gitWorkspace", target.narratorId] });
			this.notify();
			return;
		}
		if (data.workspaceKey !== target.workspaceKey) return;
		const initial = data.type === "git_workspace_subscribed";
		if (initial) {
			if (entry.acknowledged) return;
			entry.acknowledged = true;
			entry.version = typeof data.version === "number" ? data.version : -1;
			if (!entry.catchUp) return;
			entry.catchUp = false;
		}
		if (
			!initial &&
			(!entry.acknowledged || typeof data.version !== "number" || data.version <= entry.version)
		)
			return;
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
