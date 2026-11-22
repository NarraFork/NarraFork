import { createHash, randomUUID } from "node:crypto";
import {
	GIT_STAGING_LIMITS,
	type GitStagingAction,
	type GitStagingActionResult,
	type GitStagingDiff,
	type GitStagingFilesPage,
	type GitStagingSummary,
} from "../../shared/git-staging-lists";
import type { GitStagingObservationState } from "../../shared/git-workspace-events";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { WorkerCleanupError, type WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { TaskQueue, TaskQueueError, type TaskQueuePermit } from "../lib/worker-runtime/queue";
import type {
	GitStagingBaseline,
	GitStagingDiffOptions,
	GitStagingFilesOptions,
} from "./git-staging-kernel";
import {
	assertGitStagingObservationClean,
	type GitStagingObservationConsumer,
	type GitStagingObservationRetryError,
	gitStagingObservationState,
	publishGitStagingWrite,
	requestGitStagingObservation,
	serialGitStaging,
	subscribeGitStagingObservation,
} from "./git-staging-observation";
import type { GitStagingWork } from "./git-staging-worker";
import { terminateGitStatusPageChild } from "./git-status-page-process";
import type { GitWorkspaceTarget } from "./git-workspace";

export interface GitStagingContext {
	workspaceKey: string;
	rootPath: string;
	/** Server-side principal + narrator grant domain; never supplied by the client. */
	authorizationKey?: string;
	signal?: AbortSignal;
	beforeWrite: () => Promise<void>;
	/** Called with the complete Worker-resolved paths, not the client's loaded page. */
	authorizePaths?: (paths: string[]) => Promise<void>;
	authorizeReadPaths?: (paths: string[]) => Promise<void>;
	supported?: boolean;
}
export interface GitStagingChange {
	workspaceKey: string;
	listId?: string;
	metadataChanged?: boolean;
	metadataListId?: string;
	affectedListIds?: string[];
	generation?: number;
	observationId?: string | null;
}
export interface GitStagingServicePorts {
	execute?: <T>(request: GitStagingWork, signal?: AbortSignal) => Promise<T>;
	changed?: (event: GitStagingChange) => void;
}
const activeWrites = new Map<string, Map<string, number>>();
const workerTasks = new TaskQueue({ concurrency: 4, maxQueued: 0, maxQueuedBytes: 0 });

/** Observation only: pollers defer a worktree write until its published-generation event. */
export function isGitStagingListWriting(workspaceKey: string, listId?: string): boolean {
	const groups = activeWrites.get(workspaceKey);
	return listId === undefined ? !!groups?.size : !!groups?.has("*") || !!groups?.has(listId);
}
function beginWrite(workspaceKey: string, listId: string) {
	const groups = activeWrites.get(workspaceKey) ?? new Map<string, number>();
	activeWrites.set(workspaceKey, groups);
	groups.set(listId, (groups.get(listId) ?? 0) + 1);
	return () => {
		const count = (groups.get(listId) ?? 1) - 1;
		if (count) groups.set(listId, count);
		else groups.delete(listId);
		if (!groups.size) activeWrites.delete(workspaceKey);
	};
}

async function retireStagingWorker(
	handle: WorkerHandle<unknown> | undefined,
	permit: TaskQueuePermit,
): Promise<void> {
	try {
		await handle?.close();
		permit.release();
	} catch (error) {
		// A failed stop still owns the slot until native exit is actually observed.
		void handle?.exited.then(
			() => permit.release(),
			() => {},
		);
		throw error;
	}
}

/** A request is one Worker task. There is deliberately no inline execution path. */
export async function executeGitStagingWork<T>(
	request: GitStagingWork,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	if (process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER === "1")
		throw new AppError("Git staging Worker is disabled", 503, "GIT_STAGING_WORKER_UNAVAILABLE");
	const permit = await workerTasks
		.acquire({ signal, deadlineAt: Infinity })
		.catch((error: unknown) => {
			if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
				throw new AppError("Git staging workers are busy", 409, "GIT_STAGING_BUSY");
			throw error;
		});
	const taskId = randomUUID();
	const children = new Set<number>();
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const isCommit = request.method === "action" && request.request.action === "commit";
	const timeout =
		request.method === "action"
			? GIT_STAGING_LIMITS.writeTimeoutMs
			: GIT_STAGING_LIMITS.readTimeoutMs;
	const timer = setTimeout(
		() => controller.abort(new Error("Git staging operation timed out")),
		timeout + 5_000,
	);
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	let handle: WorkerHandle<unknown> | undefined;
	let removeListeners = () => {};
	const unknown = (message: string) =>
		new AppError(
			isCommit
				? `${message}; commit result is unknown. Inspect the retained operation evidence and recover by operationId`
				: message,
			isCommit ? 409 : 503,
			isCommit ? "GIT_STAGING_COMMIT_UNKNOWN" : "GIT_STAGING_WORKER_UNAVAILABLE",
		);
	try {
		let started: Awaited<ReturnType<typeof connectCompiledWorker>>;
		try {
			started = await connectCompiledWorker(
				compiledWorkerSpecifiers(
					"services/git-staging-worker.ts",
					"./git-staging-worker.ts",
					import.meta.url,
				),
				{ signal: controller.signal },
			);
		} catch (e) {
			if (e instanceof WorkerCleanupError) handle = e.handle;
			throw new AppError((e as Error).message, 503, "GIT_STAGING_WORKER_UNAVAILABLE");
		}
		handle = started.handle;
		const active = started.worker;
		return await new Promise<T>((resolve, reject) => {
			const cancel = () => {
				active.postMessage({ action: "cancel", taskId });
				forceTimer ??= setTimeout(
					() => reject(unknown("Git staging Worker did not finish cancellation")),
					5_000,
				);
			};
			const onMessage = (message: {
				action: string;
				taskId?: string;
				pid: number;
				active: boolean;
				message: string;
				code: string;
				observationRetriesExhausted?: boolean;
				value: T;
			}) => {
				if (message.taskId !== taskId) return;
				if (message.action === "child") {
					if (message.active) children.add(message.pid);
					else children.delete(message.pid);
				} else if (message.action === "error") {
					const error: AppError & GitStagingObservationRetryError = new AppError(
						message.message,
						message.code === "GIT_STAGING_UNSUPPORTED" ? 501 : 409,
						message.code,
					);
					if (
						message.code === "GIT_STAGING_CONCURRENT_CHANGE" &&
						message.observationRetriesExhausted === true
					)
						Object.defineProperty(error, "observationRetriesExhausted", { value: true });
					reject(error);
				} else if (message.action === "result") resolve(message.value);
			};
			const onError = (e: Error) => reject(unknown(e.message));
			const onExit = () => reject(unknown("Git staging Worker exited"));
			removeListeners = () => {
				controller.signal.removeEventListener("abort", cancel);
				active.off("message", onMessage);
				active.off("error", onError);
				active.off("exit", onExit);
			};
			controller.signal.addEventListener("abort", cancel, { once: true });
			active.on("message", onMessage);
			active.once("error", onError);
			active.once("exit", onExit);
			active.postMessage({ ...request, action: "execute", taskId });
			if (controller.signal.aborted) cancel();
		});
	} finally {
		clearTimeout(timer);
		if (forceTimer) clearTimeout(forceTimer);
		signal?.removeEventListener("abort", abort);
		removeListeners();
		try {
			await Promise.all(
				[...children].map((pid) =>
					terminateGitStatusPageChild({ pid, kill: () => process.kill(pid, "SIGKILL") }),
				),
			);
		} finally {
			await retireStagingWorker(handle, permit);
		}
	}
}

export function createGitStagingListsService(
	context: GitStagingContext,
	ports: GitStagingServicePorts = {},
) {
	const execute = ports.execute ?? executeGitStagingWork;
	const base = { cwd: context.rootPath, workspaceKey: context.workspaceKey };
	const supported = context.supported !== false;
	const assertSupported = () => {
		if (!supported)
			throw new AppError(
				"ChangeLists are only supported on local devices",
				501,
				"GIT_STAGING_UNSUPPORTED",
			);
	};
	const identity = { rootPath: context.rootPath, workspaceKey: context.workspaceKey };
	const authorizationKey = context.authorizationKey ?? randomUUID();
	const observationConsumer = (background: boolean): GitStagingObservationConsumer => ({
		authorizationKey,
		signal: context.signal,
		prepare: async (signal) => {
			await context.beforeWrite();
			signal.throwIfAborted();
			const request = { action: "sync" as const };
			const authorizedPaths = await execute<string[]>(
				{ ...base, method: "actionPaths", request },
				signal,
			);
			const authorizePaths = context.authorizePaths;
			if (!authorizePaths)
				throw new AppError("Complete path authorization is required", 403, "FORBIDDEN");
			await authorizePaths(authorizedPaths);
			const before = await execute<GitStagingBaseline>({ ...base, method: "baseline" }, signal);
			return {
				baseline: JSON.stringify([before.generation, before.observationId, before.state]),
				scope: createHash("sha256").update(JSON.stringify(authorizedPaths)).digest("hex"),
				revalidate: async (runningSignal) => {
					await context.beforeWrite();
					await authorizePaths(authorizedPaths);
					runningSignal.throwIfAborted();
				},
				run: async (runningSignal) => {
					if (!before.initialized && background)
						return {
							outcome: "applied",
							affectedListIds: [],
							generation: before.generation,
							observationId: before.observationId,
						};
					const endWrite = beginWrite(context.workspaceKey, "*");
					try {
						const result = await execute<GitStagingActionResult>(
							{ ...base, method: "action", request: { ...request, authorizedPaths } },
							runningSignal,
						);
						if (
							result.generation !== before.generation ||
							result.observationId !== before.observationId
						)
							ports.changed?.({
								workspaceKey: context.workspaceKey,
								metadataChanged: true,
								affectedListIds: result.affectedListIds,
								generation: result.generation,
								observationId: result.observationId,
							});
						return result;
					} finally {
						endWrite();
					}
				},
			};
		},
	});
	return {
		watchObservation(listener: (state: GitStagingObservationState) => void, writable = true) {
			assertSupported();
			return subscribeGitStagingObservation(
				identity,
				listener,
				writable ? observationConsumer(true) : undefined,
			);
		},
		async summary(): Promise<GitStagingSummary> {
			if (!supported)
				return {
					capability: {
						supported: false,
						reason: "ChangeLists are only supported on local devices",
					},
					workspaceKey: context.workspaceKey,
					initialized: false,
					generation: 0,
					observationId: null,
					activeListId: null,
					scannedAt: null,
					state: "uninitialized",
					lists: [],
					stats: {},
				};
			return execute<GitStagingSummary>({ ...base, method: "summary" }, context.signal);
		},
		async files(listId: string, options: GitStagingFilesOptions = {}) {
			assertSupported();
			const page = await execute<GitStagingFilesPage>(
				{ ...base, method: "files", listId, options },
				context.signal,
			);
			await context.authorizeReadPaths?.(
				page.files.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
			);
			return page;
		},
		async diff(listId: string, options: GitStagingDiffOptions) {
			assertSupported();
			const diff = await execute<GitStagingDiff>(
				{ ...base, method: "diff", listId, options },
				context.signal,
			);
			await context.authorizeReadPaths?.([
				...new Set([
					diff.path,
					...diff.units.flatMap((unit) => (unit.oldPath ? [unit.path, unit.oldPath] : [unit.path])),
				]),
			]);
			return diff;
		},
		async action(action: GitStagingAction) {
			assertSupported();
			if (action.action === "sync")
				return requestGitStagingObservation(identity, observationConsumer(false));
			const enqueued = gitStagingObservationState(identity);
			const request = action.action === "create" ? { ...action, listId: randomUUID() } : action;
			return serialGitStaging(
				context.rootPath,
				async () => {
					context.signal?.throwIfAborted();
					await context.beforeWrite();
					let authorizedPaths: string[] | undefined;
					if (context.authorizePaths) {
						authorizedPaths = await execute<string[]>(
							{ ...base, method: "actionPaths", request },
							context.signal,
						);
						await context.authorizePaths(authorizedPaths);
					}
					await context.beforeWrite();
					if (authorizedPaths) await context.authorizePaths?.(authorizedPaths);
					context.signal?.throwIfAborted();
					if (action.action === "move" || action.action === "delete" || action.action === "commit")
						assertGitStagingObservationClean(identity, enqueued, action);
					const endWrite = beginWrite(context.workspaceKey, "*");
					try {
						const result = await execute<GitStagingActionResult>(
							{
								...base,
								method: "action",
								request: { ...request, ...(authorizedPaths ? { authorizedPaths } : {}) },
							},
							context.signal,
						);
						publishGitStagingWrite(identity, result);
						ports.changed?.({
							workspaceKey: context.workspaceKey,
							metadataChanged: true,
							affectedListIds: result.affectedListIds,
							generation: result.generation,
							observationId: result.observationId,
						});
						const observation = gitStagingObservationState(identity);
						return observation ? { ...result, observation } : result;
					} finally {
						endWrite();
					}
				},
				context.signal,
			);
		},
	};
}

export async function getGitStagingListsService(
	target: GitWorkspaceTarget,
	actorId: string,
	signal?: AbortSignal,
	grantId?: string,
) {
	const { workspace } = target;
	if (!workspace.workspaceKey || !workspace.rootPath)
		throw new AppError("Git workspace unavailable", 409, "GIT_STAGING_UNAVAILABLE");
	return createGitStagingListsService(
		{
			workspaceKey: workspace.workspaceKey,
			rootPath: workspace.rootPath,
			authorizationKey: grantId ? JSON.stringify([actorId, grantId]) : undefined,
			signal,
			supported: target.backend?.kind === "local",
			authorizePaths: async (paths) => {
				const { validateGitFileTargets } = await import("./git-management-service");
				await validateGitFileTargets(target, paths, GIT_STAGING_LIMITS.maxRowsPerList * 4);
				if (!target.authorizeFilePaths)
					throw new AppError("File authorization is required", 403, "FORBIDDEN");
				await target.authorizeFilePaths(paths, "write");
			},
			authorizeReadPaths: async (paths) => {
				const { validateGitFileTargets } = await import("./git-management-service");
				await validateGitFileTargets(target, paths, GIT_STAGING_LIMITS.maxRowsPerList * 4);
				if (!target.authorizeFilePaths)
					throw new AppError("File authorization is required", 403, "FORBIDDEN");
				await target.authorizeFilePaths(paths, "read");
			},
			beforeWrite: async () => {
				if (!target.beforeWrite)
					throw new AppError("Write authorization is required", 403, "FORBIDDEN");
				await target.beforeWrite();
			},
		},
		{ changed: (event) => eventBus.emit({ type: "git:staging_lists_changed", ...event }) },
	);
}
