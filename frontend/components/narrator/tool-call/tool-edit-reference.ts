import type { ToolCallDetailRef } from "../../../lib/api/narrators";

/** Historical resource identity, independent of the current file/device and host panel. */
export interface ToolEditReference extends ToolCallDetailRef {
	narratorId: string;
	toolUseId: string;
}

export function toolEditReferenceKey(ref: ToolEditReference): string {
	return JSON.stringify([
		ref.narratorId,
		ref.toolUseId,
		ref.toolCallId ?? null,
		ref.messageId ?? null,
		ref.executionAttempt ?? null,
	]);
}

export function isToolEditReference(value: unknown): value is ToolEditReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const ref = value as Record<string, unknown>;
	const validId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
	return (
		validId(ref.narratorId) &&
		validId(ref.toolUseId) &&
		(ref.toolCallId === undefined || validId(ref.toolCallId)) &&
		(ref.messageId === undefined || validId(ref.messageId)) &&
		(ref.executionAttempt === undefined ||
			(typeof ref.executionAttempt === "number" &&
				Number.isSafeInteger(ref.executionAttempt) &&
				ref.executionAttempt >= 0))
	);
}
