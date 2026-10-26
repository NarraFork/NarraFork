import type {
	FileChangeRevertApplyResponse,
	FileChangeRevertFileResult,
} from "@shared/file-change-protocol";
import type { QueryClient } from "@tanstack/react-query";

type Translate = (key: string, options?: Record<string, unknown>) => string;
const MAX_FILE_DETAILS = 12;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isFileResult(value: unknown): value is FileChangeRevertFileResult {
	const file = record(value);
	return (
		!!file &&
		typeof file.filePath === "string" &&
		typeof file.deviceId === "string" &&
		["applied", "unchanged", "conflict", "failed", "unknown", "not_attempted"].includes(
			String(file.status),
		) &&
		(file.reason === undefined || typeof file.reason === "string")
	);
}

/** Decode actual Error payloads as well as successful and wrapped API responses. */
export function extractRevertResult(value: unknown): FileChangeRevertApplyResponse | null {
	const envelope = record(value);
	const data = record(envelope?.data) ?? envelope;
	for (const value of [data?.revertResult, data?.result, data]) {
		const result = record(value);
		if (
			result &&
			typeof result.planId === "string" &&
			["committed", "partial", "failed", "cancelled", "executing"].includes(
				String(result.status),
			) &&
			typeof result.journalStatus === "string" &&
			typeof result.settling === "boolean" &&
			(result.reason === null || typeof result.reason === "string") &&
			Array.isArray(result.files) &&
			result.files.every(isFileResult) &&
			(result.historyStatus === "complete" || result.historyStatus === "unavailable") &&
			typeof result.historyCommitted === "boolean"
		)
			return result as unknown as FileChangeRevertApplyResponse;
	}
	return null;
}

/** An HTTP 200 or applied files alone never confirms the independent history update. */
export function isRevertHistoryCommitted(value: unknown): boolean {
	const result = extractRevertResult(value);
	return (
		!!result &&
		result.status === "committed" &&
		result.journalStatus === "committed" &&
		result.historyCommitted === true &&
		result.settling === false &&
		result.files.every((file) => file.status === "applied" || file.status === "unchanged")
	);
}

function formatFileResults(t: Translate, result: FileChangeRevertApplyResponse | null): string {
	if (!result) return "";
	const exceptions = result.files.filter(
		(file) => file.status !== "applied" && file.status !== "unchanged",
	);
	const details = exceptions.slice(0, MAX_FILE_DETAILS).map((file) => {
		const device = file.deviceId === "local" ? "" : `[${file.deviceId}] `;
		const reason = file.reason ? ` (${file.reason})` : "";
		return `${device}${file.filePath}: ${t(`revertFileStatus.${file.status}`)}${reason}`;
	});
	if (exceptions.length > MAX_FILE_DETAILS) {
		details.push(t("revertResultMoreFiles", { count: exceptions.length - MAX_FILE_DETAILS }));
	}
	for (const status of ["applied", "unchanged"] as const) {
		const count = result.files.filter((file) => file.status === status).length;
		if (count)
			details.push(
				t("revertResultSuccessCount", { count, status: t(`revertFileStatus.${status}`) }),
			);
	}
	return details.join("\n");
}

export function formatRevertFailure(
	t: Translate,
	value: unknown,
	options: { fallbackKey?: string; skipRevert?: boolean } = {},
): string {
	const result = extractRevertResult(value);
	const envelope = record(value);
	const data = record(envelope?.data) ?? envelope;
	const explanation = options.skipRevert
		? t(options.fallbackKey ?? "deleteMessageFailedDesc")
		: data?.code === "REVERT_RUNTIME_RELOAD_REQUIRED"
			? t("revertScopeRuntimeReloadRequired")
			: result?.settling
				? t("revertPlanSettling")
				: result?.status === "partial"
					? t("revertPlanPartial")
					: result?.status === "cancelled"
						? t("revertPlanCancelled")
						: t(options.fallbackKey ?? "revertPlanApplyFailed");
	const message = value instanceof Error ? value.message : data?.error;
	return [
		...new Set(
			[
				explanation,
				result?.historyCommitted === false ? t("revertHistoryUnchanged") : "",
				formatFileResults(t, result),
				result?.reason,
				typeof message === "string" ? message : "",
			].filter(Boolean),
		),
	].join("\n");
}

/** A committed history update can still have a file-history recording advisory. */
export function formatRevertSuccessWarning(t: Translate, value: unknown): string | null {
	const result = extractRevertResult(value);
	if (!result || !isRevertHistoryCommitted(result)) return null;
	const warning =
		result.reason ??
		(result.historyStatus === "unavailable" ? t("revertPlanHistoryUnavailable") : null);
	return warning ? [warning, formatFileResults(t, result)].filter(Boolean).join("\n") : null;
}

/** Refresh after every attempt: a lost response may still have changed files. */
export function invalidateRevertQueries(qc: QueryClient, narratorId: string): void {
	for (const resource of ["messages", "file-tree-status", "tool-calls"]) {
		void qc.invalidateQueries({ queryKey: ["narrators", narratorId, resource] });
	}
}
