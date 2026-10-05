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

export type SystemLifecycleNotice = Pick<SystemLifecycleStatus, "phase" | "shutdownRequested">;
export const systemLifecycleNoticeQueryKey = ["system-lifecycle-notice"] as const;
export const systemLifecycleStatusQueryKey = ["system-lifecycle"] as const;

interface SystemLifecycleActionResult {
	success: true;
	status: SystemLifecycleStatus;
}

export const systemLifecycleApi = {
	getSystemLifecycleNotice: (signal?: AbortSignal) =>
		request<SystemLifecycleNotice>("/system/lifecycle/notice", { signal }),
	getSystemLifecycleStatus: (signal?: AbortSignal) =>
		request<SystemLifecycleStatus>("/system/lifecycle/status", { signal }),
	prepareSystemRecovery: () =>
		request<SystemLifecycleActionResult>("/system/lifecycle/prepare", { method: "POST" }),
	shutdownSystem: () =>
		request<SystemLifecycleActionResult>("/system/lifecycle/shutdown", { method: "POST" }),
	cancelSystemRecovery: () =>
		request<SystemLifecycleActionResult>("/system/lifecycle/cancel", { method: "POST" }),
};
