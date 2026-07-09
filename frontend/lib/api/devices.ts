import { request } from "./client";

export interface RemoteDevice {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	tokenPrefix: string;
	connectionMode: "reverse" | "direct";
	directUrl: string | null;
	status: "online" | "offline";
	lastSeenAt: string | null;
	platformOs: string | null;
	platformArch: string | null;
	shellPath: string | null;
	defaultCwd: string | null;
	agentVersion: string | null;
	capabilities: Record<string, unknown> | null;
	scope: "global" | "project";
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
}

export interface CreateDeviceInput {
	name: string;
	slug?: string;
	description?: string;
	connectionMode: "reverse" | "direct";
	directUrl?: string;
	scope: "global" | "project";
	projectId?: string;
}

export interface RemoteStatEntry {
	relPath: string;
	size: number;
	mtimeMs: number;
	isDirectory: boolean;
}

export interface RemoteStatResult {
	exists: boolean;
	isDirectory: boolean;
	size: number;
	mtimeMs: number;
	entries?: RemoteStatEntry[];
	truncated?: boolean;
}

export interface TransferResult {
	ok: boolean;
	filesTransferred: number;
	bytesTransferred: number;
}

export const devicesApi = {
	listDevices: () => request<RemoteDevice[]>("/devices"),
	getDevice: (id: string) => request<RemoteDevice>(`/devices/${id}`),
	statDevicePath: (id: string, path: string, recursive = false) => {
		const params = new URLSearchParams({ path, recursive: String(recursive) });
		return request<RemoteStatResult>(`/devices/${id}/fs?${params}`);
	},
	transferDeviceFile: (
		id: string,
		data: {
			direction: "download" | "upload";
			remotePath: string;
			localPath: string;
			recursive?: boolean;
		},
	) =>
		request<TransferResult>(`/devices/${id}/transfers`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	createDevice: (data: CreateDeviceInput) =>
		request<{ device: RemoteDevice; token: string }>("/devices", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateDevice: (id: string, data: Partial<CreateDeviceInput> & { description?: string | null }) =>
		request<RemoteDevice>(`/devices/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	rotateDeviceToken: (id: string) =>
		request<{ token: string }>(`/devices/${id}/rotate-token`, { method: "POST" }),
	deleteDevice: (id: string) =>
		request<{ success: boolean }>(`/devices/${id}`, { method: "DELETE" }),
};
