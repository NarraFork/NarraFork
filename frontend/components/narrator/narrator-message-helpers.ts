import type { QueryClient } from "@tanstack/react-query";
import type { MessagesQueryData, NarratorMsg, PendingPermission } from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

export type ReflectionKind =
	| "danger_reflection"
	| "plan_reflection"
	| "goal_reflection"
	| "question_reflection";
export type ReflectionStatus = "running" | "awaiting_user" | "confirmed" | "cancelled" | "aborted";

export interface ReflectionSuggestion {
	kind: ReflectionKind;
	status: ReflectionStatus;
	reason?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic suggestion payload
	danger?: any;
	activeGoal?: unknown;
	nextSteps?: string;
	requestId?: string;
}

const REFLECTION_KINDS = new Set<ReflectionKind>([
	"danger_reflection",
	"plan_reflection",
	"goal_reflection",
	"question_reflection",
]);
const ACTIVE_REFLECTION_STATUSES = new Set<ReflectionStatus>(["running", "awaiting_user"]);

export function getReflectionSuggestion(
	suggestions: unknown[] | null | undefined,
): ReflectionSuggestion | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object") continue;
		const record = suggestion as {
			type?: unknown;
			status?: unknown;
			reason?: unknown;
			danger?: unknown;
			activeGoal?: unknown;
			nextSteps?: unknown;
			requestId?: unknown;
		};
		const kind = String(record.type ?? "");
		if (!REFLECTION_KINDS.has(kind as ReflectionKind)) continue;
		const rawStatus = typeof record.status === "string" ? record.status : "running";
		const status = ACTIVE_REFLECTION_STATUSES.has(rawStatus as ReflectionStatus)
			? (rawStatus as ReflectionStatus)
			: rawStatus === "allow"
				? "confirmed"
				: rawStatus === "deny"
					? "cancelled"
					: rawStatus === "confirmed" || rawStatus === "cancelled" || rawStatus === "aborted"
						? (rawStatus as ReflectionStatus)
						: "running";
		return {
			kind: kind as ReflectionKind,
			status,
			reason: typeof record.reason === "string" ? record.reason : undefined,
			danger: record.danger,
			activeGoal: record.activeGoal,
			nextSteps: typeof record.nextSteps === "string" ? record.nextSteps : undefined,
			requestId: typeof record.requestId === "string" ? record.requestId : undefined,
		};
	}
	return null;
}

export function getPermissionReflectionSuggestion(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): ReflectionSuggestion | null {
	return getReflectionSuggestion(value.suggestions ?? value.permissionSuggestions);
}

export function isReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	return getPermissionReflectionSuggestion(value) !== null;
}

export function isActiveReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	const reflection = getPermissionReflectionSuggestion(value);
	return reflection ? ACTIVE_REFLECTION_STATUSES.has(reflection.status) : false;
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
	// Reflection gates also store a pending tool-call row while their internal
	// loop decides. They are actionable only while still running or awaiting user;
	// after they resolve, historical notices must not keep approval controls alive.
	if (
		!perm &&
		tc.status === "pending" &&
		tc.toolUseId &&
		(!isReflectionPermissionLike(tc) || isActiveReflectionPermissionLike(tc))
	) {
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
