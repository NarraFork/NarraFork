import type {
	GitStagingListsChanged,
	GitStagingObservationState,
	GitStatusPagesWatchState,
	GitWorkspaceCategory,
	GitWorkspaceClientMessage,
	GitWorkspaceServerMessage,
	GitWorkspaceSnapshot,
	GitWorkspaceSubscribe,
	GitWorkspaceView,
} from "@shared/git-workspace-events";
import { resolveLiveSession } from "../lib/auth";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import type { GitWorkspaceTarget } from "../services/git-workspace";
import { assertGitWorkspaceKey } from "../services/git-workspace";
import {
	authorizeGitTargetForPrincipal,
	requireReadyGitTarget,
} from "../services/git-workspace-access";
import {
	GitWorkspaceWatchPool,
	projectGitSnapshot,
	settleGitStagingWatch,
} from "../services/git-workspace-watch";

interface Socket {
	data: { userId?: string; userRole?: string; sessionId?: string };
	send(message: string): unknown;
	getBufferedAmount?(): number;
	close?(code?: number, reason?: string): void;
}
interface Subscription {
	target: GitWorkspaceSubscribe;
	view: GitWorkspaceView;
	updateView?: (view: GitWorkspaceView) => Promise<void>;
	controller: AbortController;
	stop?: () => void;
	checking: boolean;
	pending: Set<GitWorkspaceCategory>;
	pendingSnapshot?: GitWorkspaceSnapshot;
	pendingPages?: GitStatusPagesWatchState;
	pendingObservation?: GitStagingObservationState;
	pendingStaging: Map<string, GitStagingListsChanged>;
	stagingChanged?: (change: GitStagingListsChanged) => void;
	stagingTimer?: ReturnType<typeof setTimeout>;
	refreshRequested?: boolean;
	refresh?: () => Promise<void>;
	retryTimer?: ReturnType<typeof setTimeout>;
}
const sockets = new Map<Socket, Map<string, Subscription>>();
const pool = new GitWorkspaceWatchPool();
// One metadata listener; no Git probe or fact-cache invalidation is needed for a list rename.
eventBus.on("git:staging_lists_changed", (change) => {
	for (const entries of sockets.values())
		for (const sub of entries.values()) sub.stagingChanged?.(change);
});
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
		clearTimeout(sub.stagingTimer);
		sub.stop?.();
	}
	sockets.delete(ws);
}
function cancel(ws: Socket, id: string) {
	const entries = sockets.get(ws);
	const sub = entries?.get(id);
	sub?.controller.abort();
	clearTimeout(sub?.retryTimer);
	clearTimeout(sub?.stagingTimer);
	sub?.stop?.();
	entries?.delete(id);
	if (!entries?.size) sockets.delete(ws);
}
async function authorize(
	ws: Socket,
	message: GitWorkspaceSubscribe,
	signal: AbortSignal,
	metadataTarget?: GitWorkspaceTarget,
) {
	if (!ws.data.userId || !message.narratorId) throw new Error("Invalid Git subscription target");
	const origin = { narratorId: message.narratorId };
	const target = await authorizeGitTargetForPrincipal(
		{ userId: ws.data.userId, isAdmin: ws.data.userRole === "admin" },
		origin,
		"read",
		signal,
		false,
		false,
		metadataTarget ?? false,
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
	if (message.type === "git_workspace_refresh") {
		await sockets.get(ws)?.get(message.subscriptionId)?.refresh?.();
		return;
	}
	const existing = sockets.get(ws)?.get(message.subscriptionId);
	if (
		message.type === "git_workspace_subscribe" &&
		existing &&
		existing.target.narratorId === message.narratorId &&
		existing.target.workspaceKey === message.workspaceKey
	) {
		await existing.updateView?.(message.view ?? "details");
		return;
	}
	cancel(ws, message.subscriptionId);
	if (message.type !== "git_workspace_subscribe") return;
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
		target: message,
		view: message.view ?? "details",
		controller: new AbortController(),
		checking: false,
		pending: new Set(),
		pendingStaging: new Map(),
	};
	entries.set(message.subscriptionId, sub);
	const signal = sub.controller.signal;
	let currentTarget: GitWorkspaceTarget | undefined;
	let expectedKey = message.workspaceKey;
	let lastAuthorizedAt = 0;
	let failures = 0;
	let version = 0;
	let lastSnapshot: GitWorkspaceSnapshot | undefined;
	const run = async (
		categories: GitWorkspaceCategory[],
		snapshot?: GitWorkspaceSnapshot,
		pages?: GitStatusPagesWatchState,
	) => {
		if (signal.aborted) return;
		for (const category of categories) sub.pending.add(category);
		if (pages) {
			sub.pendingPages = {
				statusPagesChanged:
					(sub.pendingPages?.statusPagesChanged ?? false) || pages.statusPagesChanged,
				statusPagesReliable: pages.statusPagesReliable,
			};
		}
		if (snapshot && (!sub.pendingSnapshot || snapshot.revision >= sub.pendingSnapshot.revision)) {
			sub.pendingSnapshot = snapshot;
			lastSnapshot = snapshot;
		}
		if (sub.checking || sub.retryTimer) return;
		// Quiet workspaces do not redo the full ACL/path scan every three seconds.
		// Every actual notification still passes a fresh authorization check.
		if (
			currentTarget &&
			!sub.pending.size &&
			!sub.pendingSnapshot &&
			!sub.pendingPages &&
			!sub.pendingStaging.size &&
			!sub.pendingObservation &&
			!sub.refreshRequested &&
			Date.now() - lastAuthorizedAt < 30_000
		)
			return;
		sub.checking = true;
		try {
			const fresh = await authorize(
				ws,
				{ ...message, workspaceKey: expectedKey },
				AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
				currentTarget &&
					(sub.pendingStaging.size > 0 || sub.pendingObservation !== undefined) &&
					!sub.pending.size &&
					!sub.pendingSnapshot &&
					!sub.pendingPages &&
					!sub.refreshRequested
					? currentTarget
					: undefined,
			);
			if (signal.aborted) return;
			const { workspaceKey, repositoryKey } = fresh.workspace;
			if (!workspaceKey || !repositoryKey) throw new Error("Missing Git workspace identity");
			const identity = {
				subscriptionId: message.subscriptionId,
				narratorId: message.narratorId,
				workspaceKey,
				repositoryKey,
			};
			const rebind =
				!currentTarget ||
				(currentTarget.discoveryRuntimeGeneration ?? currentTarget.backend?.runtimeGeneration) !==
					(fresh.discoveryRuntimeGeneration ?? fresh.backend?.runtimeGeneration) ||
				currentTarget.workspace.capabilities?.write !== fresh.workspace.capabilities?.write;
			if (rebind) {
				sub.stop?.();
				currentTarget = fresh;
				expectedKey = workspaceKey;
				sub.pendingSnapshot = undefined;
				lastSnapshot = undefined;
				// New readers consume the shared snapshot; subscribing is not a filesystem change.
				send(ws, { type: "git_workspace_subscribed", ...identity, version: ++version });
				if (signal.aborted) return;
				let writeTarget: GitWorkspaceTarget | undefined;
				sub.stop = pool.subscribe(
					fresh,
					(categories, pages) => run(categories, undefined, pages),
					(value) => void run([], value),
					{
						authorizationKey: JSON.stringify([ws.data.userId, message.narratorId]),
						writable: fresh.workspace.capabilities?.write === true,
						beforeWrite: async () => {
							signal.throwIfAborted();
							const session = ws.data.sessionId
								? await resolveLiveSession(ws.data.sessionId)
								: null;
							if (
								!session ||
								session.sub !== ws.data.userId ||
								sockets.get(ws)?.get(message.subscriptionId) !== sub
							)
								throw new AppError(
									"Git observation session expired",
									403,
									"GIT_WORKSPACE_ACCESS_DENIED",
								);
							const next = await authorizeGitTargetForPrincipal(
								{ userId: session.sub, isAdmin: session.role === "admin" },
								{ narratorId: message.narratorId ?? "" },
								"write",
								signal,
								false,
								false,
								fresh,
							);
							requireReadyGitTarget(next, "write");
							if (
								next.workspace.workspaceKey !== workspaceKey ||
								next.workspace.repositoryKey !== repositoryKey ||
								next.workspace.rootPath !== fresh.workspace.rootPath ||
								(next.discoveryRuntimeGeneration ?? next.backend?.runtimeGeneration) !==
									(fresh.discoveryRuntimeGeneration ?? fresh.backend?.runtimeGeneration)
							)
								throw new AppError(
									"Git observation workspace changed",
									409,
									"GIT_WORKSPACE_CHANGED",
								);
							writeTarget = next;
						},
						authorizePaths: async (paths) => {
							signal.throwIfAborted();
							if (!writeTarget?.authorizeFilePaths)
								throw new AppError(
									"Git path authorization is required",
									403,
									"GIT_WORKSPACE_ACCESS_DENIED",
								);
							const { validateGitFileTargets } = await import("../services/git-management-service");
							await validateGitFileTargets(writeTarget, paths);
							await writeTarget.authorizeFilePaths(paths, "write");
						},
						observation: (state) => {
							if (signal.aborted) return;
							sub.pendingObservation = state;
							void run([]);
						},
					},
				);
			}
			lastAuthorizedAt = Date.now();
			failures = 0;
			if (sub.refreshRequested) {
				sub.refreshRequested = false;
				pool.refresh(fresh);
			}
			if (sub.pending.size || sub.pendingPages) {
				send(ws, {
					type: "git_workspace_changed",
					...identity,
					categories: [...sub.pending],
					...sub.pendingPages,
					version: ++version,
				});
				sub.pending.clear();
				sub.pendingPages = undefined;
			}
			if (sub.pendingStaging.size && !signal.aborted) {
				await settleGitStagingWatch(workspaceKey, signal);
				if (signal.aborted) return;
				const changes = [...sub.pendingStaging.values()];
				sub.pendingStaging.clear();
				clearTimeout(sub.stagingTimer);
				sub.stagingTimer = undefined;
				for (const change of changes) {
					if (change.workspaceKey !== workspaceKey || fresh.workspace.deviceId !== "local")
						continue;
					send(ws, {
						type: "git_workspace_staging_lists_changed",
						...identity,
						...(change.listId ? { listId: change.listId } : {}),
						...(change.metadataChanged ? { metadataChanged: true } : {}),
						...(change.metadataListId ? { metadataListId: change.metadataListId } : {}),
						...(change.affectedListIds ? { affectedListIds: change.affectedListIds } : {}),
						...(change.generation !== undefined
							? { generation: change.generation, observationId: change.observationId }
							: {}),
						version: ++version,
					});
				}
			}
			if (sub.pendingObservation && !signal.aborted) {
				const observation = sub.pendingObservation;
				sub.pendingObservation = undefined;
				send(ws, {
					type: "git_workspace_staging_observation",
					...identity,
					observation,
					version: ++version,
				});
			}
			if (sub.pendingSnapshot && !signal.aborted) {
				const value = sub.pendingSnapshot;
				sub.pendingSnapshot = undefined;
				const view = sub.view;
				send(ws, {
					type: "git_workspace_snapshot",
					...identity,
					version: ++version,
					view,
					snapshot: projectGitSnapshot(value, view),
				});
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
			// A debounce can fire while authorization is awaiting. Retain one trailing
			// delivery instead of depending on an unrelated future Git/watch event.
			if (
				!signal.aborted &&
				!sub.retryTimer &&
				!sub.stagingTimer &&
				(sub.pendingStaging.size ||
					sub.pending.size ||
					sub.pendingSnapshot ||
					sub.pendingPages ||
					sub.pendingObservation ||
					sub.refreshRequested)
			) {
				sub.stagingTimer = setTimeout(() => {
					sub.stagingTimer = undefined;
					void run([]);
				}, 0);
				sub.stagingTimer.unref?.();
			}
		}
	};
	sub.stagingChanged = (change) => {
		if (
			signal.aborted ||
			(expectedKey !== undefined && change.workspaceKey !== expectedKey) ||
			(currentTarget && currentTarget.workspace.deviceId !== "local")
		)
			return;
		const key = `${change.workspaceKey}:${change.listId ?? change.metadataListId ?? ""}`;
		const pending = sub.pendingStaging.get(key);
		const newest =
			pending && (pending.generation ?? -1) > (change.generation ?? -1) ? pending : change;
		sub.pendingStaging.set(key, {
			...pending,
			...change,
			generation: newest.generation,
			observationId: newest.observationId,
			affectedListIds: pending
				? pending.affectedListIds && change.affectedListIds
					? [...new Set([...pending.affectedListIds, ...change.affectedListIds])]
					: undefined
				: change.affectedListIds,
			...(pending?.metadataChanged ? { metadataChanged: true } : {}),
		});
		if (sub.stagingTimer || sub.retryTimer) return;
		sub.stagingTimer = setTimeout(() => {
			sub.stagingTimer = undefined;
			void run([]);
		}, 50);
		sub.stagingTimer.unref?.();
	};
	// Projection changes reuse the directory observer and its existing results.
	sub.updateView = async (view) => {
		sub.view = view;
		await run([], lastSnapshot);
	};
	sub.refresh = async () => {
		sub.refreshRequested = true;
		clearTimeout(sub.retryTimer);
		sub.retryTimer = undefined;
		await run([]);
	};
	await run([]);
}
