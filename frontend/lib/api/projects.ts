import {
	ApiError,
	authorizedFetch,
	BASE,
	getErrorMessage,
	readFetchError,
	request,
} from "./client";
import type { ApiEntity } from "./types";

export interface ProjectGraphFallback {
	feature: string;
	reason?: string;
	message?: string;
	error?: string;
	code?: string;
	[key: string]: unknown;
}

export interface ProjectGraphCapabilities {
	commitSync?: {
		graphReadRefresh?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface ProjectGraphResponse {
	nodes: ApiEntity[];
	edges: ApiEntity[];
	explorationGroups?: ApiEntity[];
	openedTerminals?: ApiEntity[];
	capabilities?: ProjectGraphCapabilities;
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
			title?: string;
			inheritMode?: string;
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
		request<{
			success: boolean;
			commitSha?: string;
			conflictFiles?: Array<{ file: string; conflictLines: number }>;
		}>(`/projects/${projectId}/ruler/rebase`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
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
};
