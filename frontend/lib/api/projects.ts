import type { ForkWorktreeSource } from "@shared/chapter-fork";
import {
	ApiError,
	authorizedFetch,
	BASE,
	getErrorMessage,
	readFetchError,
	request,
} from "./client";
import type {
	ApiEntity,
	ProjectAccess,
	ProjectMemberBatchResult,
	ProjectRole,
	ProjectVisibility,
} from "./types";

/**
 * One degraded aspect of a graph response.
 *
 * `error`/`code` are kept even though `/projects/:id/graph` no longer sends them
 * (see the note on `GraphFallback` in `server/routes/graph.ts`: git's stderr is
 * unbounded subprocess output and stays in the server log). They remain declared
 * because `formatGraphFallbackMessage` reads them as optional detail and this shape
 * is also what other degraded payloads are funnelled through — narrowing it would
 * only move the `unknown` casts around.
 */
export interface ProjectGraphFallback {
	feature: string;
	reason?: string;
	message?: string;
	error?: string;
	code?: string;
	/**
	 * How many chapters hit this failure. Reported instead of one fallback per
	 * chapter, because a repository-level fault (git gone, worktrees moved) fails
	 * every active chapter at once while the UI only ever renders one alert.
	 */
	failedChapters?: number;
	[key: string]: unknown;
}

/**
 * How a rebase's attempt to put parked work back on disk ended.
 *
 * `conflict` is a decision waiting for the user — the parked side and the rebased
 * workspace disagree, and editing either can resolve it. `failed` is a NarraFork or git
 * fault that no user action fixes. The distinction matters because the two used to be
 * indistinguishable (both merely set `parkedSnapshot`), so a hard failure was reported
 * with the same wording as an ordinary conflict.
 */
export type ParkedWorkStatus = "reapplied" | "conflict" | "failed" | "materialized";

export interface ParkedWorkFields {
	/**
	 * Snapshot holding uncommitted work the rebase set aside. Present whenever work was
	 * parked and did not make it fully back onto disk — a rebase no longer refuses a
	 * dirty workspace, so this is how the user learns where it went.
	 */
	parkedSnapshot?: string;
	/** True while the coordinates are still recorded, i.e. while recovery can still act. */
	parkedWorkPending?: boolean;
	parkedWorkStatus?: ParkedWorkStatus;
	/** Paths whose reapplication conflicted with the rebased result. Set when status is `conflict`. */
	reapplyConflictFiles?: string[];
	/** Fault detail. Set instead of `reapplyConflictFiles` when status is `failed`. */
	reapplyError?: string;
	/**
	 * An earlier rebase's parked work that can no longer be recovered at all — the
	 * snapshot no longer resolves. Reported alongside an otherwise successful result,
	 * because the alternative is that it disappears into a server log.
	 */
	lostParkedSnapshot?: string;
}

export interface RulerRebaseResponse extends ParkedWorkFields {
	success: boolean;
	commitSha?: string;
	conflictFiles?: Array<{ file: string; conflictLines: number }>;
}

export interface RulerRebaseParkedResponse extends ParkedWorkFields {
	success: boolean;
	/** Set by the `discard` action. */
	discardedSnapshot?: string;
	/** Set by `materialize`: paths written with conflict markers. */
	conflictFiles?: string[];
	/** Set by `materialize`: how many paths the write touched. */
	changedFiles?: number;
}

export interface ProjectGraphResponse {
	nodes: ApiEntity[];
	edges: ApiEntity[];
	openedTerminals?: ApiEntity[];
	// No `capabilities`: the graph route never sent one. `degraded`/`fallbacks` below are real.
	degraded?: boolean;
	fallbacks?: ProjectGraphFallback[];
}

export const projectsApi = {
	listProjects: (status?: string) =>
		request<ApiEntity[]>(`/projects${status ? `?status=${status}` : ""}`),
	getProject: (id: string) => request<ApiEntity>(`/projects/${id}`),
	createProject: (data: Record<string, unknown>) =>
		request<ApiEntity>("/projects", { method: "POST", body: JSON.stringify(data) }),
	/**
	 * Create a project with clone mode — returns an SSE stream.
	 * Events: "progress" (clone output), "complete" (project JSON), "error".
	 */
	createProjectStream: (
		data: Record<string, unknown>,
		onProgress: (message: string) => void,
		onCredentialRequired?: () => void,
	): Promise<ApiEntity> => {
		return new Promise((resolve, reject) => {
			authorizedFetch(`${BASE}/projects`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			})
				.then(async (response) => {
					try {
						if (response.status === 401) {
							const error = await readFetchError(response, "Unauthorized");
							reject(new ApiError(error.message, 401, error.data));
							return;
						}
						if (
							!response.ok &&
							!response.headers.get("content-type")?.includes("text/event-stream")
						) {
							const error = await readFetchError(response, "Request failed");
							reject(new ApiError(error.message, response.status, error.data));
							return;
						}

						const reader = response.body?.getReader();
						if (!reader) {
							reject(new ApiError("No response body", 500));
							return;
						}

						const decoder = new TextDecoder();
						let buffer = "";

						const pump = (): void => {
							reader
								.read()
								.then(({ done, value }) => {
									if (done) {
										reject(new ApiError("Stream ended without completion", 500));
										return;
									}
									buffer += decoder.decode(value, { stream: true });
									const lines = buffer.split("\n");
									buffer = lines.pop() ?? "";

									let eventType = "";
									for (const line of lines) {
										if (line.startsWith("event:")) {
											eventType = line.slice(6).trim();
										} else if (line.startsWith("data:")) {
											const jsonStr = line.slice(5).trim();
											if (!jsonStr) continue;
											try {
												const parsed = JSON.parse(jsonStr);
												if (eventType === "progress") {
													onProgress(parsed.message);
												} else if (eventType === "complete") {
													reader.cancel().catch(() => {});
													resolve(parsed);
													return;
												} else if (eventType === "credential_required") {
													reader.cancel().catch(() => {});
													if (onCredentialRequired) {
														onCredentialRequired();
													}
													reject(
														new ApiError(
															getErrorMessage(parsed, "Authentication required"),
															401,
															parsed,
														),
													);
													return;
												} else if (eventType === "error") {
													reader.cancel().catch(() => {});
													reject(
														new ApiError(getErrorMessage(parsed, "Clone failed"), 500, parsed),
													);
													return;
												}
											} catch {
												// skip malformed JSON
											}
										}
									}
									pump();
								})
								.catch(reject);
						};
						pump();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				})
				.catch(reject);
		});
	},
	updateProject: (id: string, data: Record<string, unknown>) =>
		request<ApiEntity>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteProject: (id: string) => request<ApiEntity>(`/projects/${id}`, { method: "DELETE" }),

	// Graph
	getProjectGraph: (projectId: string) =>
		request<ProjectGraphResponse>(`/projects/${projectId}/graph`),

	// Graph positions
	updateGraphPositions: (
		projectId: string,
		positions: Array<{
			chapterId: string;
			anchorCommitSha?: string;
			axisOffset: number;
			crossOffset: number;
			panelExpanded?: boolean;
			panelWidth?: number;
			panelHeight?: number;
		}>,
	) =>
		request<{ ok: boolean }>(`/projects/${projectId}/graph/positions`, {
			method: "PATCH",
			body: JSON.stringify({ positions }),
		}),

	// Ruler
	getRulerData: (
		projectId: string,
		opts?: {
			limit?: number;
			skip?: number;
			cursor?: string;
			direction?: "older" | "newer";
		},
	) => {
		const params = new URLSearchParams();
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.skip) params.set("skip", String(opts.skip));
		if (opts?.cursor) params.append("cursor", opts.cursor);
		if (opts?.direction) params.append("direction", opts.direction);
		const qs = params.toString();
		return request<ApiEntity>(`/projects/${projectId}/ruler${qs ? `?${qs}` : ""}`);
	},
	getRulerSegment: (
		projectId: string,
		fromSha: string,
		toSha?: string,
		detail?: "summary" | "full",
	) => {
		const params = new URLSearchParams({ from: fromSha });
		if (toSha) params.set("to", toSha);
		if (detail) params.set("detail", detail);
		return request<ApiEntity>(`/projects/${projectId}/ruler/segment?${params}`);
	},
	updateRulerPositions: (
		projectId: string,
		positions: Array<{
			chapterId: string;
			anchorCommitSha: string;
			axisOffset: number;
			crossOffset: number;
			width?: number;
			height?: number;
		}>,
	) =>
		request<{ success: boolean }>(`/projects/${projectId}/ruler/positions`, {
			method: "PATCH",
			body: JSON.stringify({ positions }),
		}),
	rulerFork: (
		projectId: string,
		data: {
			startCommitSha: string;
			worktreeSource: Extract<ForkWorktreeSource, "commit">;
			title?: string;
			inheritMode?: "fresh" | "compressed" | "full";
			parentChapterId?: string;
		},
	) =>
		request<ApiEntity>(`/projects/${projectId}/ruler/fork`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	rulerMerge: (
		projectId: string,
		data: { sourceChapterId: string; strategy?: string; message?: string },
	) =>
		request<ApiEntity>(`/projects/${projectId}/ruler/merge`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	rulerAbandon: (projectId: string, chapterId: string) =>
		request<{ success: boolean }>(`/projects/${projectId}/ruler/abandon`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
		}),
	rulerRebase: (projectId: string, chapterId: string) =>
		request<RulerRebaseResponse>(`/projects/${projectId}/ruler/rebase`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
		}),
	/**
	 * Act on work a rebase parked and could not put back.
	 *
	 * `retry` re-attempts the three-way reapply (worth offering, because the conflicting
	 * side is the current workspace and editing it can make the same merge succeed),
	 * `materialize` writes the conflicted tree with markers so it can be resolved in an
	 * editor, and `discard` forgets the coordinates. Restoring the parked tree wholesale
	 * is deliberately not offered by the server: it would overwrite the rebased result.
	 */
	rulerRebaseParked: (
		projectId: string,
		chapterId: string,
		action: "retry" | "materialize" | "discard",
	) =>
		request<RulerRebaseParkedResponse>(`/projects/${projectId}/ruler/rebase-parked`, {
			method: "POST",
			body: JSON.stringify({ chapterId, action }),
		}),
	rulerRebaseResolve: (
		projectId: string,
		data: { chapterId: string; action: "abort" | "continue" },
	) =>
		request<{ success: boolean; narratorId?: string }>(
			`/projects/${projectId}/ruler/rebase-resolve`,
			{ method: "POST", body: JSON.stringify(data) },
		),

	// Volume Snapshots
	listVolumeSnapshots: (
		projectId: string,
		filters?: { serviceName?: string; containerPath?: string },
	) => {
		const params = new URLSearchParams();
		if (filters?.serviceName) params.set("serviceName", filters.serviceName);
		if (filters?.containerPath) params.set("containerPath", filters.containerPath);
		const qs = params.toString();
		return request<ApiEntity[]>(`/projects/${projectId}/volume-snapshots${qs ? `?${qs}` : ""}`);
	},
	createVolumeSnapshot: (
		projectId: string,
		data: {
			chapterId: string;
			serviceName: string;
			containerPath: string;
			name: string;
			description?: string;
		},
	) =>
		request<ApiEntity>(`/projects/${projectId}/volume-snapshots`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	getVolumeSnapshot: (snapshotId: string) => request<ApiEntity>(`/volume-snapshots/${snapshotId}`),
	updateVolumeSnapshot: (
		snapshotId: string,
		data: { name?: string; description?: string | null },
	) =>
		request<ApiEntity>(`/volume-snapshots/${snapshotId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteVolumeSnapshot: (snapshotId: string) =>
		request<{ success: boolean }>(`/volume-snapshots/${snapshotId}`, { method: "DELETE" }),
	applyVolumeSnapshot: (snapshotId: string, targetChapterId: string) =>
		request<{ success: boolean }>(`/volume-snapshots/${snapshotId}/apply`, {
			method: "POST",
			body: JSON.stringify({ targetChapterId }),
		}),
	getSnapshotApplications: (snapshotId: string) =>
		request<ApiEntity[]>(`/volume-snapshots/${snapshotId}/applications`),

	// ── Access control (membership) ────────────────────────────────────────────

	/**
	 * Whether projects exist that this user cannot see.
	 *
	 * Only worth calling when the visible list is empty — it exists solely to tell
	 * "create your first project" apart from "you have not been added to any".
	 */
	getHiddenProjectExistence: () => request<{ hasHidden: boolean }>("/projects/hidden-existence"),

	getProjectAccess: (projectId: string) => request<ProjectAccess>(`/projects/${projectId}/access`),

	setProjectVisibility: (projectId: string, visibility: ProjectVisibility) =>
		request<ProjectAccess>(`/projects/${projectId}/visibility`, {
			method: "PATCH",
			body: JSON.stringify({ visibility }),
		}),

	/** Add several members at one tier; the response reports each user's outcome. */
	addProjectMembers: (projectId: string, userIds: string[], role: ProjectRole) =>
		request<ProjectMemberBatchResult>(`/projects/${projectId}/members`, {
			method: "POST",
			body: JSON.stringify({ userIds, role }),
		}),

	removeProjectMember: (projectId: string, userId: string) =>
		request<{ ok: true }>(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),

	transferProjectOwner: (projectId: string, userId: string) =>
		request<ProjectAccess>(`/projects/${projectId}/transfer-owner`, {
			method: "POST",
			body: JSON.stringify({ userId }),
		}),
};
