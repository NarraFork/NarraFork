const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
	if (options?.body) {
		headers["Content-Type"] = "application/json";
	}
	const response = await fetch(`${BASE}${path}`, { ...options, headers });
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: response.statusText }));
		throw new Error(error.error ?? "Request failed");
	}
	return response.json();
}

export const api = {
	// Projects
	listProjects: (status?: string) =>
		request<any[]>(`/projects${status ? `?status=${status}` : ""}`),
	getProject: (id: string) => request<any>(`/projects/${id}`),
	createProject: (data: any) =>
		request<any>("/projects", { method: "POST", body: JSON.stringify(data) }),
	updateProject: (id: string, data: any) =>
		request<any>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteProject: (id: string) => request<any>(`/projects/${id}`, { method: "DELETE" }),

	// Chapters
	listChapters: (projectId: string, status?: string) =>
		request<any[]>(`/chapters?projectId=${projectId}${status ? `&status=${status}` : ""}`),
	getChapter: (id: string) => request<any>(`/chapters/${id}`),
	createChapter: (data: any) =>
		request<any>("/chapters", { method: "POST", body: JSON.stringify(data) }),
	updateChapter: (id: string, data: any) =>
		request<any>(`/chapters/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteChapter: (id: string) => request<any>(`/chapters/${id}`, { method: "DELETE" }),

	// Settings
	getSettings: () => request<any>("/settings"),
	updateSettings: (data: any) =>
		request<any>("/settings", { method: "PATCH", body: JSON.stringify(data) }),

	// Narrators
	listNarrators: (chapterId: string) => request<any[]>(`/narrators?chapterId=${chapterId}`),
	getNarrator: (id: string) => request<any>(`/narrators/${id}`),
	createNarrator: (data: { chapterId: string; type?: string; model?: string }) =>
		request<any>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	deleteNarrator: (id: string) => request<any>(`/narrators/${id}`, { method: "DELETE" }),
	getNarratorMessages: (id: string, limit?: number) =>
		request<any[]>(`/narrators/${id}/messages${limit ? `?limit=${limit}` : ""}`),
	interruptNarrator: (id: string) => request<any>(`/narrators/${id}/interrupt`, { method: "POST" }),
	getPendingPermissions: (id: string) => request<any[]>(`/narrators/${id}/permissions`),
	approvePermission: (requestId: string) =>
		request<any>(`/narrators/permissions/${requestId}/approve`, { method: "POST" }),
	denyPermission: (requestId: string, message?: string) =>
		request<any>(`/narrators/permissions/${requestId}/deny`, {
			method: "POST",
			body: JSON.stringify({ message }),
		}),
};
