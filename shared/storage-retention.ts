/** Retention policies, cleanup responses and durable content markers shared by both clients. */
export const STORAGE_RETENTION_TARGETS = ["toolCallPayloads", "messageHistory"] as const;
export type StorageRetentionTarget = (typeof STORAGE_RETENTION_TARGETS)[number];

/** Inputs still used by legacy first-touch file reconstruction, kept outside ordinary details. */
export const STORAGE_REPLAY_INPUT_TOOLS = ["Write", "Edit", "StructSed", "GenUI"] as const;
export function retainsStorageReplayInput(toolName: string): boolean {
	return (STORAGE_REPLAY_INPUT_TOOLS as readonly string[]).includes(toolName);
}

export interface StorageRetentionRule {
	/** null keeps all history; a number keeps the most recent N days. */
	retentionDays: number | null;
	autoCleanup: boolean;
}
export type StorageRetentionSettings = Record<StorageRetentionTarget, StorageRetentionRule>;

export interface StorageHistoryPreview {
	target: StorageRetentionTarget;
	cutoffAt: string;
	count: number;
	/** Estimated bytes of the selected payloads, rather than an exact file-size reduction. */
	approxBytes: number;
}

export type StorageHistoryJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export interface StorageHistoryJob {
	id: string;
	target: StorageRetentionTarget;
	cutoffAt: string;
	source: "manual" | "automatic";
	status: StorageHistoryJobStatus;
	processed: number;
	cleared: number;
	retained: number;
	approxBytes: number;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
}
export type StorageHistoryJobs = Record<StorageRetentionTarget, StorageHistoryJob | null>;

/** Bounded metadata selected by a read worker; writes recheck the revision and cutoff. */
export interface StorageHistoryCandidate {
	rowid: number;
	id: string;
	messageId: string | null;
	revision: number;
	approxBytes: number;
}
export interface StorageHistoryMutationResult {
	cleared: boolean;
	retained: boolean;
}

export interface HistoryClearedText {
	type: "text";
	text: string;
	historyClearedAt: string;
	historyClearVersion: 1;
}

export function historyClearedText(clearedAt: string): HistoryClearedText {
	return {
		type: "text",
		text: "[History cleared]",
		historyClearedAt: clearedAt,
		historyClearVersion: 1,
	};
}

export function isHistoryClearedElement(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).historyClearVersion === 1 &&
		typeof (value as Record<string, unknown>).historyClearedAt === "string"
	);
}

export function isHistoryClearedContent(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0 && isHistoryClearedElement(value[0]);
}

export function clearedToolOutput(clearedAt: string): {
	_text: string;
	_payloadClearedAt: string;
} {
	return { _text: "[Tool details cleared]", _payloadClearedAt: clearedAt };
}

export function isClearedToolOutput(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>)._payloadClearedAt === "string"
	);
}
