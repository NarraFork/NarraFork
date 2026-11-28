import type {
	ResolveProjectDirectoryRequest,
	ResolveProjectDirectoryResponse,
} from "@shared/project-directory";
import type {
	ProjectAttentionResponse,
	ProjectListSummaryResponse,
	ProjectMemberCount,
	ProjectSessionPage,
	ProjectSessionView,
} from "@shared/project-overview";
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
	/** The project list's card numbers (R2), one request for all cards. */
	getProjectSummaries: (signal?: AbortSignal) =>
		request<ProjectListSummaryResponse>("/projects/summaries", { signal }),
	/** The project page's 「等你处理」 (members only: 403 for readers). */
	getProjectAttention: (projectId: string, signal?: AbortSignal) =>
		request<ProjectAttentionResponse>(`/projects/${encodeURIComponent(projectId)}/attention`, {
			signal,
		}),
	/** One page of the project page's session list. */
	listProjectSessions: (
		projectId: string,
		options: { view: ProjectSessionView; cursor?: string; limit?: number },
		signal?: AbortSignal,
	) => {
		const search = new URLSearchParams({ view: options.view });
		if (options.cursor) search.set("cursor", options.cursor);
		if (options.limit) search.set("limit", String(options.limit));
		return request<ProjectSessionPage>(
			`/projects/${encodeURIComponent(projectId)}/sessions?${search.toString()}`,
			{ signal },
		);
	},
	getProject: (id: string) => request<ApiEntity>(`/projects/${id}`),
	/**
	 * Which project a local directory belongs to (`create: true` makes the project of a git
	 * repository that has none). See `shared/project-directory.ts`.
	 */
	resolveProjectDirectory: (data: ResolveProjectDirectoryRequest) =>
		request<ResolveProjectDirectoryResponse>("/projects/resolve-directory", {
			method: "POST",
			body: JSON.stringify(data),
		}),
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

	// ── Access control (membership) ────────────────────────────────────────────

	/**
	 * Whether projects exist that this user cannot see.
	 *
	 * Only worth calling when the visible list is empty — it exists solely to tell
	 * "create your first project" apart from "you have not been added to any".
	 */
	getHiddenProjectExistence: () => request<{ hasHidden: boolean }>("/projects/hidden-existence"),

	getProjectAccess: (projectId: string) => request<ProjectAccess>(`/projects/${projectId}/access`),

	/** The header's 「N 位成员」: a count, never the list. */
	getProjectMemberCount: (projectId: string, signal?: AbortSignal) =>
		request<ProjectMemberCount>(`/projects/${projectId}/members/count`, { signal }),

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
