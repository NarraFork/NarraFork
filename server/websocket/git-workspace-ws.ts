import type {
	GitWorkspaceCategory,
	GitWorkspaceClientMessage,
	GitWorkspaceServerMessage,
	GitWorkspaceSubscribe,
} from "@shared/git-workspace-events";
import { AppError } from "../lib/errors";
import { invalidateGitWorkspace } from "../services/git-management-service";
import type { GitWorkspaceTarget } from "../services/git-workspace";
import { assertGitWorkspaceKey } from "../services/git-workspace";
import {
	authorizeGitTargetForPrincipal,
	requireReadyGitTarget,
} from "../services/git-workspace-access";
import { GitWorkspaceWatchPool } from "../services/git-workspace-watch";

interface Socket {
	data: { userId?: string; userRole?: string };
	send(message: string): unknown;
	getBufferedAmount?(): number;
	close?(code?: number, reason?: string): void;
}
interface Subscription {
	controller: AbortController;
	stop?: () => void;
	checking: boolean;
	pending: Set<GitWorkspaceCategory>;
	retryTimer?: ReturnType<typeof setTimeout>;
}
const sockets = new Map<Socket, Map<string, Subscription>>();
const pool = new GitWorkspaceWatchPool();
function send(ws: Socket, message: GitWorkspaceServerMessage) {
	// Never silently lose an ack/change: force reconnect and snapshot recovery.
	if ((ws.getBufferedAmount?.() ?? 0) > 256 * 1024) {
		releaseGitWorkspaceSubscriptions(ws);
		ws.close?.(1013, "Git workspace backpressure; reconnect");
		return;
	}
	try {
		ws.send(JSON.stringify(message));
	} catch {
		releaseGitWorkspaceSubscriptions(ws);
	}
}
export function releaseGitWorkspaceSubscriptions(ws: Socket): void {
	for (const sub of sockets.get(ws)?.values() ?? []) {
		sub.controller.abort();
		clearTimeout(sub.retryTimer);
		sub.stop?.();
	}
	sockets.delete(ws);
}
function cancel(ws: Socket, id: string) {
	const entries = sockets.get(ws);
	const sub = entries?.get(id);
	sub?.controller.abort();
	clearTimeout(sub?.retryTimer);
	sub?.stop?.();
	entries?.delete(id);
	if (!entries?.size) sockets.delete(ws);
}
async function authorize(ws: Socket, message: GitWorkspaceSubscribe, signal: AbortSignal) {
	if (!ws.data.userId || !!message.narratorId === !!message.chapterId)
		throw new Error("Invalid Git subscription target");
	const origin = message.narratorId
		? { narratorId: message.narratorId }
		: { chapterId: message.chapterId ?? "" };
	const target = await authorizeGitTargetForPrincipal(
		{ userId: ws.data.userId, isAdmin: ws.data.userRole === "admin" },
		origin,
		"read",
		signal,
	);
	if (target.workspace.state === "device_offline")
		throw new AppError("Git device temporarily offline", 503, "GIT_WATCH_RETRYABLE");
	requireReadyGitTarget(target, "read");
	if (message.workspaceKey) assertGitWorkspaceKey(target.workspace, message.workspaceKey);
	return target;
}
export async function handleGitWorkspaceMessage(
	ws: Socket,
	message: GitWorkspaceClientMessage,
): Promise<void> {
	cancel(ws, message.subscriptionId);
	if (message.type === "git_workspace_unsubscribe") return;
	let entries = sockets.get(ws);
	if (!entries) {
		entries = new Map();
		sockets.set(ws, entries);
	}
	const fail = (error?: unknown) =>
		send(ws, {
			type: "git_workspace_error",
			subscriptionId: message.subscriptionId,
			code: error instanceof AppError ? error.code : "GIT_WORKSPACE_UNAVAILABLE",
			message: "Git workspace subscription unavailable; refresh workspace and retry",
		});
	if (entries.size >= 16) {
		fail();
		return;
	}
	const sub: Subscription = {
		controller: new AbortController(),
		checking: false,
		pending: new Set(),
	};
	entries.set(message.subscriptionId, sub);
	const signal = sub.controller.signal;
	let currentTarget: GitWorkspaceTarget | undefined;
	let expectedKey = message.workspaceKey;
	let lastAuthorizedAt = 0;
	let failures = 0;
	let version = 0;
	const run = async (categories: GitWorkspaceCategory[]) => {
		if (signal.aborted) return;
		for (const category of categories) sub.pending.add(category);
		if (sub.checking || sub.retryTimer) return;
		// Quiet workspaces do not redo the full ACL/path scan every three seconds.
		// Every actual notification still passes a fresh authorization check.
		if (currentTarget && !sub.pending.size && Date.now() - lastAuthorizedAt < 30_000) return;
		sub.checking = true;
		try {
			const fresh = await authorize(
				ws,
				{ ...message, workspaceKey: expectedKey },
				AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
			);
			if (signal.aborted) return;
			const { workspaceKey, repositoryKey } = fresh.workspace;
			if (!workspaceKey || !repositoryKey) throw new Error("Missing Git workspace identity");
			const identity = {
				subscriptionId: message.subscriptionId,
				narratorId: message.narratorId,
				chapterId: message.chapterId,
				workspaceKey,
				repositoryKey,
			};
			const rebind =
				!currentTarget ||
				currentTarget.backend?.runtimeGeneration !== fresh.backend?.runtimeGeneration;
			if (rebind) {
				sub.stop?.();
				currentTarget = fresh;
				expectedKey = workspaceKey;
				sub.stop = pool.subscribe(fresh, run);
				// The ACK makes a reconnect/device generation transition take one snapshot.
				invalidateGitWorkspace(fresh);
				send(ws, { type: "git_workspace_subscribed", ...identity, version: ++version });
			}
			lastAuthorizedAt = Date.now();
			failures = 0;
			if (sub.pending.size) {
				invalidateGitWorkspace(fresh);
				send(ws, {
					type: "git_workspace_changed",
					...identity,
					categories: [...sub.pending],
					version: ++version,
				});
				sub.pending.clear();
			}
		} catch (error) {
			if (signal.aborted) return;
			if (
				(error instanceof AppError && error.statusCode >= 500) ||
				(error instanceof Error && error.name === "TimeoutError")
			) {
				// Device/network failures keep the subscription alive with bounded backoff;
				// browser REST polling is not needed to discover recovery.
				failures = Math.min(failures + 1, 4);
				lastAuthorizedAt = 0;
				sub.stop?.();
				sub.stop = undefined;
				currentTarget = undefined;
				sub.retryTimer = setTimeout(
					() => {
						sub.retryTimer = undefined;
						void run([]);
					},
					Math.min(60_000, 3000 * 2 ** (failures - 1)),
				);
				sub.retryTimer.unref?.();
			} else {
				fail(error);
				cancel(ws, message.subscriptionId);
			}
		} finally {
			sub.checking = false;
		}
	};
	await run([]);
}
