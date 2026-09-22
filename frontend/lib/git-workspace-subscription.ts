import type { QueryClient } from "@tanstack/react-query";
import { type GitTarget, type GitWorkspace, gitTargetKey } from "./api/git";
import type { ListenerHandle, ListenerOptions, MessageCallback } from "./narrator-ws-manager";

interface GitTransport {
	readonly connected: boolean;
	send(message: Record<string, unknown>): boolean;
	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
	onConnectionChange(callback: (connected: boolean, isReconnect: boolean) => void): () => void;
}

const FACTS = ["gitStatus", "gitModifications", "gitDiff", "gitLog", "gitStashList"];
let nextSubscriptionId = 0;

/** No timers: only the active panel's server subscription drives background reads. */
export class GitWorkspaceSubscriptions {
	private entries = new Map<string, { count: number; dispose: () => void; retry: () => void }>();

	constructor(
		private readonly qc: QueryClient,
		private readonly transport: GitTransport,
	) {}

	subscribe(target: GitTarget): () => void {
		const key = JSON.stringify(
			typeof target === "string" ? ["chapter", target] : [target.narratorId, target.workspaceKey],
		);
		const existing = this.entries.get(key);
		if (existing) {
			existing.count++;
			return () => this.release(key);
		}
		const subscriptionId = `git-panel-${++nextSubscriptionId}`;
		let version = -1;
		let subscribed = false;
		let failed = false;
		const sendSubscribe = () => {
			failed = false;
			version = -1;
			subscribed = false;
			this.transport.send({
				type: "git_workspace_subscribe",
				subscriptionId,
				...(typeof target === "string"
					? { chapterId: target }
					: { narratorId: target.narratorId, workspaceKey: target.workspaceKey }),
			});
		};
		const handle = this.transport.addListener(
			{
				narratorIds: "*",
				types: ["git_workspace_subscribed", "git_workspace_changed", "git_workspace_error"],
			},
			(data) => {
				if (data.subscriptionId !== subscriptionId) return;
				if (data.type === "git_workspace_error") {
					subscribed = false;
					failed = true;
					// Do not leave facts from a revoked or switched workspace visible.
					for (const prefix of FACTS)
						this.qc.removeQueries({ queryKey: [prefix, gitTargetKey(target)] });
					if (typeof target !== "string")
						void this.qc.invalidateQueries({ queryKey: ["gitWorkspace", target.narratorId] });
					return;
				}
				if (typeof target !== "string" && data.workspaceKey !== target.workspaceKey) return;
				const initial = data.type === "git_workspace_subscribed";
				if (!initial && !subscribed) return;
				if (!initial && typeof data.version === "number" && data.version <= version) return;
				if (typeof data.version === "number") version = data.version;
				subscribed = true;
				const categories = initial
					? ["worktree", "refs", "stash"]
					: Array.isArray(data.categories)
						? data.categories
						: [];
				const prefixes = new Set<string>();
				if (categories.some((category) => ["worktree", "index", "head", "refs"].includes(category)))
					for (const prefix of ["gitStatus", "gitModifications", "gitDiff"]) prefixes.add(prefix);
				if (categories.includes("refs") || categories.includes("head")) prefixes.add("gitLog");
				if (categories.includes("stash")) prefixes.add("gitStashList");
				const keys = new Set([gitTargetKey(target), data.workspaceKey]);
				// Refs/stashes are shared across linked worktrees; file changes are not.
				for (const [, workspace] of this.qc.getQueriesData<GitWorkspace>({
					queryKey: ["gitWorkspace"],
				})) {
					if (!workspace?.workspaceKey) continue;
					if (workspace.workspaceKey === data.workspaceKey) {
						keys.add(workspace.workspaceKey);
						if (workspace.chapterId) keys.add(workspace.chapterId);
					} else if (data.repositoryKey && workspace.repositoryKey === data.repositoryKey) {
						for (const prefix of ["gitLog", "gitStashList"]) {
							if (!prefixes.has(prefix)) continue;
							void this.qc.invalidateQueries({ queryKey: [prefix, workspace.workspaceKey] });
							if (workspace.chapterId)
								void this.qc.invalidateQueries({ queryKey: [prefix, workspace.chapterId] });
						}
					}
				}
				for (const cacheKey of keys) {
					if (typeof cacheKey !== "string") continue;
					for (const prefix of prefixes)
						void this.qc.invalidateQueries({ queryKey: [prefix, cacheKey] });
				}
			},
		);
		const offConnection = this.transport.onConnectionChange((connected) => {
			if (connected) sendSubscribe();
			else subscribed = false;
		});
		this.entries.set(key, {
			count: 1,
			retry: () => {
				if (failed && this.transport.connected) sendSubscribe();
			},
			dispose: () => {
				offConnection();
				this.transport.removeListener(handle);
				this.transport.send({ type: "git_workspace_unsubscribe", subscriptionId });
			},
		});
		if (this.transport.connected) sendSubscribe();
		return () => this.release(key);
	}

	/** Explicit refresh can recover a rejected subscription without a polling loop. */
	retry(target: GitTarget): void {
		const key = JSON.stringify(
			typeof target === "string" ? ["chapter", target] : [target.narratorId, target.workspaceKey],
		);
		this.entries.get(key)?.retry();
	}

	private release(key: string) {
		const entry = this.entries.get(key);
		if (!entry || --entry.count > 0) return;
		entry.dispose();
		this.entries.delete(key);
	}
}
