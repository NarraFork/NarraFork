import { isHistoryClearedContent } from "../storage-retention";

/**
 * Portable, bounded probe for the compact JSON emitted by clearedToolOutput().
 * No JSON parser is allowed to walk an uncleared multi-MiB output just to test its marker.
 */
export function clearedToolOutputSql(column = "output_json"): string {
	const prefix = `substr(CAST(${column} AS TEXT), 1, 512)`;
	return `coalesce((${prefix} LIKE '{"!_text":"[Tool details cleared]","!_payloadClearedAt":"%' ESCAPE '!'
		OR ${prefix} LIKE '{"!_payloadClearedAt":"%","!_text":"[Tool details cleared]"}' ESCAPE '!'), FALSE)`;
}

/** New human text after retention keeps the old execution ledger out of replay. */
export function isHistoryProtectedContent(value: unknown): boolean {
	return (
		isHistoryClearedContent(value) ||
		(Array.isArray(value) && value[0]?.historyToolsSuppressed === true)
	);
}

/** Pure redaction used by retention and late body writers. Never retains provider credentials. */
export function redactToolPayloadElement(value: unknown, toolUseIds: ReadonlySet<string>): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const raw = value as Record<string, unknown>;
	const id =
		raw.type === "tool_result" ? (raw.tool_use_id ?? raw.toolUseId) : (raw.id ?? raw.toolUseId);
	if (typeof id !== "string" || !toolUseIds.has(id)) return value;
	if (raw.type === "tool_use") {
		return { type: "tool_use", id, name: raw.name, input: {}, payloadCleared: true };
	}
	if (raw.type === "tool_result") {
		return {
			type: "tool_result",
			tool_use_id: id,
			content: "[Tool details cleared]",
			payloadCleared: true,
		};
	}
	return value;
}
