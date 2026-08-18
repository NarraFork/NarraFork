import type { ExecutorPathRule } from "@shared/executor-path-rules";
import type {
	ExecutorManifest,
	ExecutorPlatform,
	ExecutorPlatformInfo,
} from "@shared/remote-executor";
import { request } from "./client";

export type { ExecutorPathRule };

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
	/** Ordered path guard rules recorded here (desired state). */
	pathRules: ExecutorPathRule[] | null;
	/** Ordered rules the device reported enforcing at its last handshake. */
	reportedPathRules: ExecutorPathRule[] | null;
	scope: "global" | "project";
	projectId: string | null;
	/**
	 * Set when the key was collected by the one-line installer rather than pasted by
	 * hand. Attribution only; never used to authorize anything.
	 */
	enrolledAt: string | null;
	enrolledFromIp: string | null;
	enrolledUserAgent: string | null;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
}

export interface DevicePathRulesResponse {
	rules: ExecutorPathRule[];
	/** Null until the device has completed a handshake that reports its rules. */
	reportedRules: ExecutorPathRule[] | null;
	/** Ready-to-paste `pathRules` fragment for the device's config file. */
	configSnippet: string;
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

/** One level of a remote device's directory tree, in that device's path syntax. */
export interface RemoteDirectoryListing {
	path: string;
	entries: Array<{ name: string; path: string; isDirectory: boolean }>;
	parent: string | null;
	sep: string;
	truncated: boolean;
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

export interface DeviceTransferTask {
	id: string;
	deviceId: string;
	direction: "download" | "upload";
	remotePath: string;
	localPath: string;
	recursive: boolean;
	status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
	filesTransferred: number;
	bytesTransferred: number;
	totalFiles: number | null;
	totalBytes: number | null;
	currentFile: string | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	updatedAt: string;
	completedAt: string | null;
}

export type DeviceConnectionStage =
	| "ready"
	| "waiting_for_executor"
	| "idle"
	| "connecting"
	| "waiting_auth_init"
	| "authenticating"
	| "waiting_hello"
	| "reconnect_wait"
	| "offline";

export interface DeviceConnectionDiagnostics {
	deviceId: string;
	mode: "reverse" | "direct";
	online: boolean;
	stage: DeviceConnectionStage;
	directUrl?: string | null;
	socketState?: "connecting" | "open" | "closing" | "closed";
	lastError?: string | null;
	lastEventAt?: number;
	lastSeenAt?: string | null;
	agentVersion?: string;
	protocolVersion?: number;
	platform?: {
		os: string;
		arch: string;
		shellPath?: string;
		shellType?: string;
		shellLoginWrap?: boolean;
	};
	capabilities?: Record<string, unknown>;
	defaultCwd?: string | null;
}

export interface TestConnectionResult {
	ok: boolean;
	stage: string;
	latencyMs?: number;
	message?: string;
	diagnostics: DeviceConnectionDiagnostics;
}

export interface UpdateDeviceInput {
	name?: string;
	description?: string | null;
	connectionMode?: "reverse" | "direct";
	directUrl?: string | null;
	scope?: "global" | "project";
	projectId?: string | null;
}

export interface ExecutorManifestResponse {
	/** Null when no executor release has been published or the server is offline. */
	manifest: ExecutorManifest | null;
	/** Device RPC protocol version this server speaks. */
	expectedProtocolVersion: number;
	platforms: ExecutorPlatformInfo[];
}

/** How the device key reaches the target machine. See `deviceInstallScriptSchema`. */
export type ExecutorTokenDelivery = "enroll" | "prompt";

export interface InstallScriptInput {
	platform: ExecutorPlatform;
	mode: "system" | "user";
	disableShell?: boolean;
	/**
	 * Absolute base URL the TARGET machine will use to reach NarraFork.
	 *
	 * Should normally be sent: the server can only fall back to the forwarded
	 * request origin, which is right for a standard reverse proxy but wrong whenever
	 * the target machine reaches this server by another name.
	 */
	serverBaseUrl?: string;
	/** Defaults to "enroll" server-side (one-line install). */
	tokenDelivery?: ExecutorTokenDelivery;
}

export interface InstallScriptResult {
	script: string;
	filename: string;
	shell: "sh" | "powershell";
	/** Public URL serving the script body; what the one-liner fetches. */
	scriptUrl: string;
	/** The single command to paste on the target machine. */
	oneLiner: string;
	tokenDelivery: ExecutorTokenDelivery;
	executorVersion: string;
	platform: ExecutorPlatform;
	/** The embedded enrollment ticket stops working after this time. */
	expiresAt: string;
}

export const devicesApi = {
	listDevices: () => request<RemoteDevice[]>("/devices"),
	getDevice: (id: string) => request<RemoteDevice>(`/devices/${id}`),
	getDevicePathRules: (id: string) =>
		request<DevicePathRulesResponse>(`/devices/${encodeURIComponent(id)}/path-rules`),
	/**
	 * Records desired rules. Does not change what the device enforces: the operator
	 * must still apply the returned snippet on the machine and restart the service.
	 */
	updateDevicePathRules: (id: string, rules: ExecutorPathRule[]) =>
		request<DevicePathRulesResponse>(`/devices/${encodeURIComponent(id)}/path-rules`, {
			method: "PUT",
			body: JSON.stringify({ rules }),
		}),
	statDevicePath: (id: string, path: string, recursive = false) => {
		const params = new URLSearchParams({ path, recursive: String(recursive) });
		return request<RemoteStatResult>(`/devices/${id}/fs?${params}`);
	},
	/**
	 * List one level of a device's directories for interactive path pickers.
	 * Omit `path` to start at the device's default working directory.
	 */
	browseDevicePath: (id: string, path?: string, opts?: { showHidden?: boolean }) => {
		const params = new URLSearchParams();
		if (path) params.set("path", path);
		if (opts?.showHidden) params.set("showHidden", "1");
		const qs = params.toString();
		return request<RemoteDirectoryListing>(`/devices/${id}/browse${qs ? `?${qs}` : ""}`);
	},
	startTransferTask: (
		id: string,
		data: {
			direction: "download" | "upload";
			remotePath: string;
			localPath: string;
			recursive?: boolean;
		},
	) =>
		request<DeviceTransferTask>(`/devices/${id}/transfer-tasks`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	listTransferTasks: (id: string) => request<DeviceTransferTask[]>(`/devices/${id}/transfer-tasks`),
	getTransferTask: (id: string, taskId: string) =>
		request<DeviceTransferTask>(`/devices/${id}/transfer-tasks/${taskId}`),
	pauseTransferTask: (id: string, taskId: string) =>
		request<DeviceTransferTask>(`/devices/${id}/transfer-tasks/${taskId}/pause`, {
			method: "POST",
		}),
	cancelTransferTask: (id: string, taskId: string) =>
		request<DeviceTransferTask>(`/devices/${id}/transfer-tasks/${taskId}/cancel`, {
			method: "POST",
		}),
	resumeTransferTask: (id: string, taskId: string) =>
		request<DeviceTransferTask>(`/devices/${id}/transfer-tasks/${taskId}/resume`, {
			method: "POST",
		}),
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
	updateDevice: (id: string, data: UpdateDeviceInput) =>
		request<RemoteDevice>(`/devices/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	rotateDeviceToken: (id: string) =>
		request<{ token: string }>(`/devices/${id}/rotate-token`, { method: "POST" }),
	deleteDevice: (id: string) =>
		request<{ success: boolean }>(`/devices/${id}`, { method: "DELETE" }),
	getDeviceDiagnostics: (id: string) =>
		request<DeviceConnectionDiagnostics>(`/devices/${id}/diagnostics`),
	testDevice: (id: string) =>
		request<TestConnectionResult>(`/devices/${id}/test`, { method: "POST" }),
	getExecutorManifest: (opts?: { refresh?: boolean }) =>
		request<ExecutorManifestResponse>(
			`/devices/executor/manifest${opts?.refresh ? "?refresh=1" : ""}`,
		),
	createInstallScript: (id: string, data: InstallScriptInput) =>
		request<InstallScriptResult>(`/devices/${id}/install-script`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
};
