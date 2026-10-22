import {
	ApiError,
	apiBase,
	authorizedFetch,
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
			authorizedFetch(`${apiBase()}/projects`, {
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
