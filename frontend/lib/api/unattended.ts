import { request } from "./client";

/**
 * Unattended mode (Issue #514).
 *
 * Two payloads share this type: administrators receive the full status (power-off command,
 * per-kind execution counters, narrator ids, diagnostics) while every other signed-in user
 * receives the redacted view — same keys minus the optional admin-only extras. Both views
 * carry `blockers` and `phase`, which is everything the global banner needs.
 */

export type UnattendedPhase = "off" | "waiting" | "quiet" | "shutting_down";

export interface UnattendedBlockerSummary {
	narrators: number;
	compacting: number;
	queuedDeliveries: boolean;
	backgroundTasks: boolean;
	dueScheduledTasks: boolean;
	maintenance: boolean;
	unknown: boolean;
}

export interface UnattendedExecutions {
	backgroundBash: number;
	ordinary: number;
	responses: number;
	preAdmission: number;
	toolStartGrants: number;
	pausedTools: number;
}

export interface UnattendedStatus {
	enabled: boolean;
	phase: UnattendedPhase;
	options: {
		powerOff: boolean;
		quietSeconds: number;
		armDelaySeconds: number;
		/** Administrator payload only. */
		powerOffCommand?: string | null;
	};
	shutdownAt: string | null;
	blocked: boolean;
	blockers: UnattendedBlockerSummary;
	/* Administrator payload only. */
	armedAt?: string | null;
	quietSince?: string | null;
	pollIntervalMs?: number;
	checkedAt?: string | null;
	powerOffPlan?: { supported: boolean; command: string[] | null; note?: string };
	diagnostics?: {
		narratorIds: string[];
		executions: UnattendedExecutions;
		dbWorkingNarrators: number;
		pendingPublications: boolean;
		error?: string;
	};
	lastError?: string;
}

export interface UnattendedPatch {
	enabled: boolean;
	powerOff?: boolean;
	powerOffCommand?: string | null;
	quietSeconds?: number;
	armDelaySeconds?: number;
}

export interface UnattendedActionResult {
	success: boolean;
	status: UnattendedStatus;
}

export const unattendedStatusQueryKey = ["system-unattended"] as const;

export const unattendedApi = {
	getUnattendedStatus: (signal?: AbortSignal) =>
		request<UnattendedStatus>("/system/unattended", { signal }),
	setUnattendedMode: (patch: UnattendedPatch) =>
		request<UnattendedActionResult>("/system/unattended", {
			method: "POST",
			body: JSON.stringify(patch),
		}),
	/**
	 * The safety valve. Any signed-in user may call this, so it is deliberately separate
	 * from `setUnattendedMode` (administrator only) and carries no options.
	 */
	cancelUnattendedMode: () =>
		request<UnattendedActionResult>("/system/unattended/cancel", { method: "POST" }),
};
