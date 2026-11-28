import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import { GIT_STAGING_LIMITS } from "../../shared/git-staging-lists";
import type { GitStagingWatchState } from "../../shared/git-workspace-events";
import { CHANGELIST_APPLICATION_ID, CHANGELIST_SCHEMA_VERSION } from "./git-changelist-store";
import {
	type GitStagingDiffOptions,
	type GitStagingFilesOptions,
	type GitStagingKernelAction,
	IndependentGitStagingKernel,
	resolveGitStagingRepository,
} from "./git-staging-kernel";
import type { GitStagingObservationRetryError } from "./git-staging-observation";
import { GitStagingKernelError, observeStagingChildren } from "./git-staging-process";

export type GitStagingWork = { cwd: string; workspaceKey: string } & (
	| { method: "baseline" }
	| { method: "summary" }
	| { method: "watch"; previous?: GitStagingWatchState }
	| { method: "files"; listId: string; options: GitStagingFilesOptions }
	| { method: "diff"; listId: string; options: GitStagingDiffOptions }
	| { method: "actionPaths"; request: GitStagingKernelAction }
	| { method: "action"; request: GitStagingKernelAction }
);
export type GitStagingWorkerRequest = GitStagingWork & { action: "execute"; taskId: string };

async function watchState(
	cwd: string,
	signal: AbortSignal,
	previous?: GitStagingWatchState,
): Promise<GitStagingWatchState> {
	const repo = await resolveGitStagingRepository(cwd);
	const info = (path: string) =>
		lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	for (const path of [resolve(repo.gitDir, "narrafork"), repo.directory]) {
		const entry = await info(path);
		if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
			throw new GitStagingKernelError("GIT_STAGING_STORAGE_UNSAFE", "Unsafe ChangeList directory");
	}
	const database = resolve(repo.directory, "changelists.sqlite");
	const identities: string[] = [];
	let present = false;
	for (const [index, path] of [database, `${database}-wal`, `${database}-shm`].entries()) {
		const entry = await info(path);
		if (entry && (!entry.isFile() || entry.isSymbolicLink()))
			throw new GitStagingKernelError(
				"GIT_STAGING_STORAGE_UNSAFE",
				"Unsafe ChangeList database file",
			);
		if (index === 0) present = entry !== null;
		if (index < 2)
			identities.push(
				entry
					? `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`
					: "missing",
			);
	}
	const databaseIdentity = identities.join(";");
	signal.throwIfAborted();
	if (previous?.databaseIdentity === databaseIdentity) return previous;
	let generation = 0;
	let observationId: string | null = null;
	let listIds: string[] = [];
	let workspaceState: unknown = null;
	if (present) {
		signal.throwIfAborted();
		const db = new Database(database, { readonly: true, strict: true });
		try {
			db.exec("PRAGMA busy_timeout=20; PRAGMA query_only=ON");
			const application = db.query("PRAGMA application_id").get() as { application_id: number };
			const version = db.query("PRAGMA user_version").get() as { user_version: number };
			if (
				application.application_id !== CHANGELIST_APPLICATION_ID ||
				version.user_version !== CHANGELIST_SCHEMA_VERSION
			)
				throw new GitStagingKernelError(
					"GIT_STAGING_UNSUPPORTED_FORMAT",
					"Unsupported ChangeList SQLite format",
				);
			db.exec("BEGIN");
			const state = db
				.query(
					"SELECT generation,observation_id,active_list_id,state,scanned_at FROM v_workspace_state",
				)
				.get() as { generation: number; observation_id: string | null } | null;
			workspaceState = state;
			if (!state)
				throw new GitStagingKernelError(
					"GIT_STAGING_STORAGE_INVALID",
					"Missing ChangeList workspace state",
				);
			const lists = db
				.query("SELECT id FROM change_lists WHERE archived=0 ORDER BY id LIMIT ?")
				.all(GIT_STAGING_LIMITS.maxSummaryLists + 1) as { id: string }[];
			if (lists.length > GIT_STAGING_LIMITS.maxSummaryLists)
				throw new GitStagingKernelError("GIT_STAGING_LIMIT", "Too many ChangeLists to observe");
			generation = state.generation;
			observationId = state.observation_id;
			listIds = lists.map((list) => list.id);
			db.exec("COMMIT");
		} finally {
			db.close();
		}
	}
	signal.throwIfAborted();
	return {
		databaseIdentity,
		generation,
		observationId,
		listIds,
		fingerprint: createHash("sha256")
			.update(JSON.stringify([workspaceState, listIds]))
			.digest("hex"),
	};
}

const port = parentPort;
if (port) {
	let running: { taskId: string; controller: AbortController } | undefined;
	let retired = false;
	observeStagingChildren((pid, active) =>
		port.postMessage({ action: "child", taskId: running?.taskId, pid, active }),
	);
	port.on(
		"message",
		async (message: GitStagingWorkerRequest | { action: "ping" | "cancel"; taskId?: string }) => {
			if (message.action === "ping") {
				port.postMessage({ ready: true });
				return;
			}
			if (message.action === "cancel") {
				if (running && (!message.taskId || running.taskId === message.taskId)) {
					running.controller.abort(new Error("Git staging Worker cancelled"));
					retired = true;
				}
				return;
			}
			if (message.action !== "execute") return;
			if (running || retired) {
				port.postMessage({
					action: "error",
					taskId: message.taskId,
					code: "GIT_STAGING_WORKER_UNAVAILABLE",
					message: "Git staging Worker is unavailable",
				});
				return;
			}
			const controller = new AbortController();
			running = { taskId: message.taskId, controller };
			try {
				let value: unknown;
				if (message.method === "watch") {
					value = await watchState(message.cwd, controller.signal, message.previous);
				} else {
					const kernel = new IndependentGitStagingKernel(
						message.cwd,
						message.workspaceKey,
						controller.signal,
					);
					switch (message.method) {
						case "baseline":
							value = await kernel.baseline();
							break;
						case "summary":
							value = await kernel.summary();
							break;
						case "files":
							value = await kernel.files(message.listId, message.options);
							break;
						case "diff":
							value = await kernel.diff(message.listId, message.options);
							break;
						case "actionPaths":
							value = await kernel.actionPaths(message.request);
							break;
						case "action":
							value = await kernel.action(message.request);
							break;
					}
				}
				port.postMessage({ action: "result", taskId: message.taskId, value });
			} catch (e) {
				retired = true;
				port.postMessage({
					action: "error",
					taskId: message.taskId,
					code: e instanceof GitStagingKernelError ? e.code : "GIT_STAGING_UNAVAILABLE",
					message: e instanceof Error ? e.message : String(e),
					...(e instanceof GitStagingKernelError &&
					e.code === "GIT_STAGING_CONCURRENT_CHANGE" &&
					(e as GitStagingKernelError & GitStagingObservationRetryError)
						.observationRetriesExhausted === true
						? { observationRetriesExhausted: true }
						: {}),
				});
			} finally {
				running = undefined;
			}
		},
	);
}
