import { request } from "./client";

export interface SystemLifecycleStatus {
	phase: "idle" | "preparing" | "prepared" | "shutting_down" | "failed";
	shutdownRequested: boolean;
	error?: string;
	coordination: {
		phase: string;
		scheduled: boolean;
		pendingBackgroundBashCount: number;
		pendingOrdinaryExecutionCount: number;
		resumableExecutionCount: number;
		pausedToolCount: number;
		blockers: unknown[];
	};
}

interface SystemLifecycleActionResult {
	success: true;
	status: SystemLifecycleStatus;
}

export const systemLifecycleApi = {
	getSystemLifecycleStatus: (signal?: AbortSignal) =>
		request<SystemLifecycleStatus>("/system/lifecycle/status", { signal }),
	prepareSystemRecovery: () =>
		request<SystemLifecycleActionResult>("/system/lifecycle/prepare", { method: "POST" }),
	shutdownSystem: () =>
		request<SystemLifecycleActionResult>("/system/lifecycle/shutdown", { method: "POST" }),
	cancelSystemRecovery: () =>
		request<SystemLifecycleActionResult>("/system/lifecycle/cancel", { method: "POST" }),
};
