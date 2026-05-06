import type { QueryClient } from "@tanstack/react-query";
import type { MessagesQueryData, NarratorMsg, PendingPermission } from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

function hasDangerReflectionSuggestion(suggestions: unknown[] | null | undefined): boolean {
	return Array.isArray(suggestions)
		? suggestions.some((suggestion) => {
				if (!suggestion || typeof suggestion !== "object") return false;
				const type = String((suggestion as { type?: unknown }).type ?? "");
				return type === "danger_reflection" || type === "yolo_reflection";
			})
		: false;
}

export function isDangerReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	return hasDangerReflectionSuggestion(value.suggestions ?? value.permissionSuggestions);
}

// Re-export functions that moved to message-segments.ts for backward compatibility
export {
	filterChildrenByToolUse,
	hasToolUse,
	isToolOnlyMessage,
	resolveAllToolCallsFromMsg,
} from "./message-segments";

/** Resolve a PendingPermission from a tool call's data or WS state fallback. */
export function resolvePendingPerm(
	tc: ToolCallData,
	wsPerm: PendingPermission | null | undefined,
	wsPermsMap?: Map<string, PendingPermission>,
): PendingPermission | null {
	// Prefer WS-sourced permissions — they carry the full (untruncated) inputJson.
	// The message-list API truncates large inputJson, so building from tc.inputJson
	// would lose data (e.g. ExitPlanMode plan text).
	let perm: PendingPermission | null = null;
	if (wsPermsMap && tc.toolUseId) {
		const fromMap = wsPermsMap.get(tc.toolUseId);
		if (fromMap) perm = fromMap;
	}
	if (!perm && wsPerm && tc.toolUseId && tc.toolUseId === wsPerm.toolUseId) {
		perm = wsPerm;
	}
	// Fallback: build from the tool call record itself (status-driven path,
	// e.g. page refresh before WS reconnects or getPendingPermissions resolves).
	// Danger reflection also stores a pending tool-call row while the internal
	// reflection loop decides, but it is not an actionable user permission request.
	if (!perm && tc.status === "pending" && tc.toolUseId && !isDangerReflectionPermissionLike(tc)) {
		perm = {
			id: tc.id ?? tc.toolUseId,
			toolName: tc.toolName,
			toolUseId: tc.toolUseId,
			inputJson: tc.inputJson,
			decisionReason: tc.permissionDecisionReason ?? undefined,
			suggestions: tc.permissionSuggestions ?? undefined,
		};
	}
	return perm;
}

export function revokeContentBlockPreviewUrls(
	blocks: Array<{ previewUrl?: unknown }> | null | undefined,
): void {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (typeof block?.previewUrl === "string") {
			URL.revokeObjectURL(block.previewUrl);
		}
	}
}

export function removeStreamingChunksMsg(
	qc: QueryClient,
	messagesQueryKey: readonly unknown[],
): void {
	qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
		if (!old?.pages?.length) return old;
		const firstPage = old.pages[0];
		const msgs = Array.isArray(firstPage.messages) ? firstPage.messages : [];
		if (!msgs.some((m: NarratorMsg) => m.id === STREAMING_CHUNKS_MSG_ID)) return old;
		const pages = [...old.pages];
		pages[0] = {
			...firstPage,
			messages: msgs.filter((m: NarratorMsg) => m.id !== STREAMING_CHUNKS_MSG_ID),
		};
		return { ...old, pages };
	});
}
