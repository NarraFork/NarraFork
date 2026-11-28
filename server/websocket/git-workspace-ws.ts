import { GIT_STAGING_LIMITS } from "@shared/git-staging-lists";
import type {
	GitStagingListsChanged,
	GitStagingObservationState,
	GitStatusPagesWatchState,
	GitWorkspaceCategory,
	GitWorkspaceClientMessage,
	GitWorkspaceErrorKind,
	GitWorkspaceServerMessage,
	GitWorkspaceSnapshot,
	GitWorkspaceSubscribe,
	GitWorkspaceView,
} from "@shared/git-workspace-events";
import { toDatabaseReadUnavailablePayload } from "../lib/app-error-response";
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
	authorizationController?: AbortController;
	watchController?: AbortController;
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
		sub.authorizationController?.abort();
		sub.watchController?.abort();
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
	sub?.authorizationController?.abort();
	sub?.watchController?.abort();
	clearTimeout(sub?.retryTimer);
	clearTimeout(sub?.stagingTimer);
	sub?.stop?.();
	entries?.delete(id);
	if (!entries?.size) sockets.delete(ws);
}
function subscriptionFailure(error: unknown): { kind: GitWorkspaceErrorKind; code: string } {
	const unavailable = toDatabaseReadUnavailablePayload(error);
	if (unavailable) return { kind: "retryable", code: unavailable.code };
	if (error instanceof AppError) {
		if (error.statusCode === 403) return { kind: "denied", code: "GIT_WORKSPACE_ACCESS_DENIED" };
		if (
			error.statusCode === 409 &&
			["GIT_WORKSPACE_CHANGED", "WORKSPACE_KEY_MISMATCH"].includes(error.code)
		)
			return { kind: "workspace_changed", code: "GIT_WORKSPACE_CHANGED" };
		if ([502, 503, 504].includes(error.statusCode)) return { kind: "retryable", code: error.code };
	}
	if (error instanceof Error && error.name === "TimeoutError")
		return { kind: "retryable", code: "GIT_WATCH_RETRYABLE" };
	// A missing resource and an unknown failure are indistinguishable to subscribers.
	return { kind: "unavailable", code: "GIT_WORKSPACE_UNAVAILABLE" };
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
	let version = 0;
	const fail = (failure: ReturnType<typeof subscriptionFailure>, retrying = false) =>
		send(ws, {
			type: "git_workspace_error",
			subscriptionId: message.subscriptionId,
			...failure,
			version: ++version,
			retrying,
			message: "Git workspace subscription unavailable; refresh workspace and retry",
		});
	if (entries.size >= 16) {
		fail({ kind: "unavailable", code: "GIT_WORKSPACE_SUBSCRIPTION_LIMIT" });
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
	let confirmedIdentity: string | undefined;
	let expectedKey = message.workspaceKey;
	let lastAuthorizedAt = 0;
	let retryAttempts = 0;
	let refreshPending = false;
	let paused = false;
	let lastSnapshot: GitWorkspaceSnapshot | undefined;
	const isActive = () => !signal.aborted && sockets.get(ws)?.get(message.subscriptionId) === sub;
	const pause = () => {
		paused = true;
		lastAuthorizedAt = 0;
		sub.watchController?.abort();
		sub.stop?.();
		sub.stop = undefined;
		currentTarget = undefined;
		lastSnapshot = undefined;
		sub.pending.clear();
		sub.pendingSnapshot = undefined;
		sub.pendingPages = undefined;
		sub.pendingObservation = undefined;
		sub.pendingStaging.clear();
		clearTimeout(sub.stagingTimer);
		sub.stagingTimer = undefined;
	};
	const run = async (
		categories: GitWorkspaceCategory[],
		snapshot?: GitWorkspaceSnapshot,
		pages?: GitStatusPagesWatchState,
		reauthorize = false,
	) => {
		if (!isActive() || (paused && !reauthorize)) return;
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
		if (sub.refreshRequested) refreshPending = true;
		sub.refreshRequested = false;
		const authorization = new AbortController();
		sub.authorizationController = authorization;
		const authorizationSignal = AbortSignal.any([signal, authorization.signal]);
		let authorizationPending = true;
		const timeout = setTimeout(() => {
			if (authorizationPending)
				authorization.abort(new DOMException("Git authorization timed out", "TimeoutError"));
		}, 20_000);
		timeout.unref?.();
		try {
			const fresh = await authorize(
				ws,
				{ ...message, workspaceKey: expectedKey },
				authorizationSignal,
				currentTarget &&
					(sub.pendingStaging.size > 0 || sub.pendingObservation !== undefined) &&
					!sub.pending.size &&
					!sub.pendingSnapshot &&
					!sub.pendingPages &&
					!refreshPending
					? currentTarget
					: undefined,
			);
			if (!isActive()) return;
			authorizationSignal.throwIfAborted();
			authorizationPending = false;
			clearTimeout(timeout);
			const { workspaceKey, repositoryKey } = fresh.workspace;
			if (!workspaceKey || !repositoryKey) throw new Error("Missing Git workspace identity");
			const workspaceIdentity = JSON.stringify([
				workspaceKey,
				repositoryKey,
				fresh.workspace.rootPath,
				fresh.workspace.deviceId,
			]);
			if (confirmedIdentity !== undefined && confirmedIdentity !== workspaceIdentity)
				throw new AppError("Git workspace identity changed", 409, "GIT_WORKSPACE_CHANGED");
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
				sub.watchController?.abort();
				sub.stop?.();
				const watchController = new AbortController();
				sub.watchController = watchController;
				const watchSignal = AbortSignal.any([signal, watchController.signal]);
				const watchActive = () => isActive() && !watchSignal.aborted;
				currentTarget = fresh;
				confirmedIdentity = workspaceIdentity;
				paused = false;
				expectedKey = workspaceKey;
				sub.pendingSnapshot = undefined;
				lastSnapshot = undefined;
				// New readers consume the shared snapshot; subscribing is not a filesystem change.
				send(ws, { type: "git_workspace_subscribed", ...identity, version: ++version });
				if (signal.aborted) return;
				let writeTarget: GitWorkspaceTarget | undefined;
				sub.stop = pool.subscribe(
					fresh,
					async (categories, pages) => {
						if (watchActive()) await run(categories, undefined, pages);
					},
					(value) => {
						if (watchActive()) void run([], value);
					},
					{
						authorizationKey: JSON.stringify([ws.data.userId, message.narratorId]),
						writable: fresh.workspace.capabilities?.write === true,
						beforeWrite: async () => {
							watchSignal.throwIfAborted();
							writeTarget = undefined;
							const session = ws.data.sessionId
								? await resolveLiveSession(ws.data.sessionId)
								: null;
							watchSignal.throwIfAborted();
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
								watchSignal,
								false,
								false,
								fresh,
							);
							watchSignal.throwIfAborted();
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
							watchSignal.throwIfAborted();
							if (!writeTarget?.authorizeFilePaths)
								throw new AppError(
									"Git path authorization is required",
									403,
									"GIT_WORKSPACE_ACCESS_DENIED",
								);
							const { validateGitFileTargets } = await import("../services/git-management-service");
							watchSignal.throwIfAborted();
							await validateGitFileTargets(
								writeTarget,
								paths,
								GIT_STAGING_LIMITS.maxRowsPerList * 4,
							);
							watchSignal.throwIfAborted();
							await writeTarget.authorizeFilePaths(paths, "write");
							watchSignal.throwIfAborted();
						},
						observation: (state) => {
							if (!watchActive()) return;
							sub.pendingObservation = state;
							void run([]);
						},
					},
				);
			} else if (refreshPending) {
				// HTTP reads may have suspended the client while this watcher stayed healthy.
				// Explicit reauthorization must acknowledge a new access continuity boundary.
				send(ws, { type: "git_workspace_subscribed", ...identity, version: ++version });
				if (!isActive()) return;
				sub.pendingSnapshot ??= lastSnapshot;
			}
			lastAuthorizedAt = Date.now();
			if (refreshPending) {
				pool.refresh(fresh);
				refreshPending = false;
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
					if (!isActive()) return;
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
			retryAttempts = 0;
		} catch (error) {
			if (!isActive()) return;
			pause();
			const failure = subscriptionFailure(
				authorizationSignal.aborted ? authorizationSignal.reason : error,
			);
			const retrying = failure.kind === "retryable" && retryAttempts < 4;
			if (retrying) {
				const delay = 3000 * 2 ** retryAttempts++;
				const timer = setTimeout(() => {
					// A cleared timer may already be queued; never steal a newer timer.
					if (!isActive() || sub.retryTimer !== timer) return;
					sub.retryTimer = undefined;
					void run([], undefined, undefined, true);
				}, delay);
				sub.retryTimer = timer;
				timer.unref?.();
			}
			fail(failure, retrying);
			// Known denial/identity changes require a new subscription. Other failures
			// remain paused so an explicit refresh can reauthorize the same id.
			if (failure.kind === "denied" || failure.kind === "workspace_changed")
				cancel(ws, message.subscriptionId);
		} finally {
			authorizationPending = false;
			clearTimeout(timeout);
			if (sub.authorizationController === authorization) sub.authorizationController = undefined;
			sub.checking = false;
			if (isActive() && sub.refreshRequested) {
				clearTimeout(sub.retryTimer);
				sub.retryTimer = undefined;
			}
			// Coalesce refreshes and facts into one serial trailing delivery.
			if (
				isActive() &&
				!sub.retryTimer &&
				!sub.stagingTimer &&
				(sub.refreshRequested ||
					(!paused &&
						(sub.pendingStaging.size ||
							sub.pending.size ||
							sub.pendingSnapshot ||
							sub.pendingPages ||
							sub.pendingObservation)))
			) {
				const timer = setTimeout(() => {
					if (!isActive() || sub.stagingTimer !== timer) return;
					sub.stagingTimer = undefined;
					void run([], undefined, undefined, sub.refreshRequested === true);
				}, 0);
				sub.stagingTimer = timer;
				timer.unref?.();
			}
		}
	};
	sub.stagingChanged = (change) => {
		if (
			!isActive() ||
			paused ||
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
		const timer = setTimeout(() => {
			if (!isActive() || sub.stagingTimer !== timer) return;
			sub.stagingTimer = undefined;
			void run([]);
		}, 50);
		sub.stagingTimer = timer;
		timer.unref?.();
	};
	// Projection changes reuse the directory observer and its existing results.
	sub.updateView = async (view) => {
		sub.view = view;
		await run([], lastSnapshot);
	};
	sub.refresh = async () => {
		if (!isActive()) return;
		retryAttempts = 0;
		sub.refreshRequested = true;
		clearTimeout(sub.retryTimer);
		sub.retryTimer = undefined;
		await run([], undefined, undefined, true);
	};
	await run([]);
}
