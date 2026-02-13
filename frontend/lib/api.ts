const BASE = "/api";
const TOKEN_KEY = "narrafork_token";

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
	if (options?.body) {
		headers["Content-Type"] = "application/json";
	}
	const token = getToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const response = await fetch(`${BASE}${path}`, { ...options, headers });
	if (response.status === 401) {
		clearToken();
		window.location.href = "/login";
		throw new Error("Session expired");
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: response.statusText }));
		throw new Error(error.error ?? "Request failed");
	}
	return response.json();
}

export const api = {
	// Auth
	authStatus: () => request<{ hasUsers: boolean; registrationOpen: boolean }>("/auth/status"),
	register: (data: { username: string; password: string }) =>
		request<{ user: any; token: string }>("/auth/register", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	login: (data: { username: string; password: string }) =>
		request<{ user: any; token: string }>("/auth/login", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	me: () => request<any>("/auth/me"),

	// Admin
	listUsers: () => request<any[]>("/admin/users"),
	deleteUser: (id: string) => request<any>(`/admin/users/${id}`, { method: "DELETE" }),
	updateAdminSettings: (data: { registrationOpen: boolean }) =>
		request<any>("/admin/settings", { method: "PATCH", body: JSON.stringify(data) }),

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

	// Terminals
	listTerminals: (chapterId: string) => request<any[]>(`/terminals?chapterId=${chapterId}`),
	createTerminal: (data: { chapterId: string; name?: string; cols?: number; rows?: number }) =>
		request<any>("/terminals", { method: "POST", body: JSON.stringify(data) }),
	getTerminal: (id: string) => request<any>(`/terminals/${id}`),
	deleteTerminal: (id: string) => request<any>(`/terminals/${id}`, { method: "DELETE" }),
};
