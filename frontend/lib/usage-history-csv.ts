import type { UsageHistoryRecord } from "@frontend/types/usage-history";
import { usageUserLabel } from "./usage-history-user";

/** Export only the already bounded page, including stable ownership IDs. */
export function usageHistoryCsv(records: UsageHistoryRecord[], unattributedLabel: string): string {
	const headers = [
		"Time",
		"User ID",
		"User",
		"Narrator",
		"Chapter",
		"Kind",
		"Provider",
		"Model",
		"Input Tokens",
		"Output Tokens",
		"Cached Tokens",
		"Reasoning Tokens",
		"TTFT (ms)",
		"Duration (ms)",
		"Known Reference Cost (USD)",
		"Cost Status",
		"Missing Price Fields",
		"Error",
	];
	const rows = records.map((r) => [
		r.createdAt,
		r.userId ?? "",
		usageUserLabel(r, unattributedLabel),
		r.narratorTitle ?? r.narratorId ?? "",
		r.chapterTitle ?? "",
		r.kind,
		r.provider ?? "",
		r.model ?? "",
		r.inputTokens,
		r.outputTokens,
		r.cachedInputTokens,
		r.reasoningTokens,
		r.ttftMs ?? "",
		r.durationMs ?? "",
		r.costStatus === "unknown" ? "" : (r.costUsd ?? ""),
		r.costStatus ?? "legacy",
		(r.costMissingFields ?? []).join("; "),
		r.errorMessage ?? "",
	]);
	const escapeCsv = (value: unknown) => {
		let text = String(value ?? "");
		// User-controlled labels must not become spreadsheet formulas.
		if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
		return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	return [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}
