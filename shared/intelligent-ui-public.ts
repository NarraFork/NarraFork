/**
 * IntelligentUI tool cards are static in public transcripts and portable exports:
 * preview references never grant access to live resources. UI source read/written
 * through ordinary Read/Write/Edit tools follows the same rules as other file history;
 * this boundary does not make those files or their historical contents private.
 */
export const INTELLIGENT_UI_TOOL_NAME = "IntelligentUI";
export const INTELLIGENT_UI_PUBLIC_SUMMARY_CODE = "INTELLIGENT_UI_PRIVATE";
export const INTELLIGENT_UI_PUBLIC_SUMMARY =
	"Interactive previews are unavailable in this shared transcript.";

export function isIntelligentUiToolName(name: unknown): boolean {
	return name === INTELLIGENT_UI_TOOL_NAME;
}

/**
 * Rebuild rather than delete known sensitive fields: new output/preview/capability fields
 * must not silently become public. The machine code lets clients translate the fallback.
 * No model-authored title, summary, privacy flag, or resource identifier is trusted here.
 */
export function publicIntelligentUiSummary(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {
		publicSummary: INTELLIGENT_UI_PUBLIC_SUMMARY_CODE,
	};
	for (const key of [
		"id",
		"tcId",
		"toolCallId",
		"toolUseId",
		"tool_use_id",
		"narratorId",
		"messageId",
		"parentToolUseId",
	]) {
		if (typeof value[key] === "string" && value[key].length <= 256) result[key] = value[key];
	}
	for (const key of ["executionAttempt", "durationMs", "streamStartedAt", "streamCompletedAt"]) {
		if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
	}
	if (
		typeof value.status === "string" &&
		[
			"pending",
			"streaming",
			"waiting",
			"running",
			"success",
			"error",
			"denied",
			"cancelled",
		].includes(value.status)
	)
		result.status = value.status;
	if (value.type === "tool_result") {
		return { ...result, type: "tool_result", content: INTELLIGENT_UI_PUBLIC_SUMMARY };
	}
	if (typeof value.type === "string" && /^tool_(use|started|completed)$/.test(value.type))
		result.type = value.type;
	if (value.type === "tool_use") result.name = INTELLIGENT_UI_TOOL_NAME;
	else result.toolName = INTELLIGENT_UI_TOOL_NAME;
	result.input = {};
	result.inputJson = {};
	result.outputJson = { text: INTELLIGENT_UI_PUBLIC_SUMMARY };
	if ("output" in value) result.output = INTELLIGENT_UI_PUBLIC_SUMMARY;
	return result;
}
