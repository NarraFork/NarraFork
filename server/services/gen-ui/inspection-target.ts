import { readGenUiFileReference } from "@shared/gen-ui-files";
import { UI_MARKUP_LIMITS } from "@shared/gen-ui-markup";
import { GEN_UI_TOOL_NAME } from "@shared/gen-ui-tool-policy";
import { uiError } from "./files";

export interface InspectionToolRecord {
	id: string;
	toolName: string;
	status: string;
	inputJson: unknown;
	outputJson: unknown;
	executionOriginToolCallId?: string | null;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The caller must obtain this record through the narrator's visible-tool lookup. */
export function inspectionTarget(
	tool: InspectionToolRecord,
	toolUseId: string,
	toolCallId: string,
) {
	if (tool.id !== toolCallId || tool.toolName !== GEN_UI_TOOL_NAME || tool.status !== "success")
		throw uiError("Inspection requires a completed, visible GenUI render or show call", 404);
	const input = object(tool.inputJson);
	const metadata = object(object(tool.outputJson)._metadata);
	if (input.action === "show") {
		const reference = readGenUiFileReference(metadata.genUi);
		if (
			!reference ||
			reference.toolUseId !== toolUseId ||
			(reference.toolCallId !== tool.id && reference.toolCallId !== tool.executionOriginToolCallId)
		)
			throw uiError("The selected tool result is not a GenUI file reference", 404);
		return { mode: "app" as const, reference: { ...reference, toolCallId: tool.id } };
	}
	if (
		input.action !== "render" ||
		typeof input.source !== "string" ||
		input.source.length === 0 ||
		input.source.length > UI_MARKUP_LIMITS.sourceChars ||
		object(metadata.genUiInline).version !== 1 ||
		!tool.executionDeviceId ||
		!tool.executionCwd
	)
		throw uiError("The selected tool result is not a bound GenUI render", 404);
	return {
		mode: "markup" as const,
		source: input.source,
		deviceId: tool.executionDeviceId,
		cwd: tool.executionCwd,
		workspaceKey: object(metadata.genUiInspection).workspaceKey,
	};
}
