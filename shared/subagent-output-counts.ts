/** Reply-body JS string length accumulated by one live child logical run. */
export interface SubagentOutputCount {
	childNarratorId: string;
	logicalRunId: string;
	toolUseId: string;
	toolCallId: string;
	attempt: number;
	count: number;
	active: boolean;
}

/** Accept only the small, exact run/Agent-attempt identity and numeric projection. */
export function parseSubagentOutputCount(value: unknown): SubagentOutputCount | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const item = value as Record<string, unknown>;
	const { childNarratorId, logicalRunId, toolUseId, toolCallId, attempt, count, active } = item;
	if (
		typeof childNarratorId !== "string" ||
		!childNarratorId.trim() ||
		childNarratorId.length > 64 ||
		typeof logicalRunId !== "string" ||
		!logicalRunId.trim() ||
		logicalRunId.length > 128 ||
		typeof toolUseId !== "string" ||
		!toolUseId.trim() ||
		toolUseId.length > 128 ||
		typeof toolCallId !== "string" ||
		!toolCallId.trim() ||
		toolCallId.length > 128 ||
		typeof attempt !== "number" ||
		!Number.isSafeInteger(attempt) ||
		attempt < 0 ||
		typeof count !== "number" ||
		!Number.isSafeInteger(count) ||
		count < 0 ||
		typeof active !== "boolean"
	)
		return undefined;
	return { childNarratorId, logicalRunId, toolUseId, toolCallId, attempt, count, active };
}
