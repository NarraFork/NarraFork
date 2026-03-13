import type { QueryClient } from "@tanstack/react-query";
import type {
	ContentBlock,
	FlatToolItem,
	MessagesQueryData,
	NarratorMsg,
	PendingPermission,
	ToolCallRow,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

export function isToolOnlyMessage(msg: NarratorMsg): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return (
		msg.role === "assistant" &&
		blocks.length > 0 &&
		blocks.every(
			(b: ContentBlock) =>
				b.type === "tool_use" || b.type === "reasoning" || (b.type === "text" && !b.text?.trim()),
		)
	);
}

/** Check if an assistant message contains at least one tool_use block. */
export function hasToolUse(msg: NarratorMsg): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	return blocks.some((b: ContentBlock) => b.type === "tool_use");
}

/** Resolve ALL tool_use blocks from a message (one message may contain multiple tool calls).
 *  Reads enriched fields directly from contentJson blocks when available (set by
 *  the backend's enrichToolUseBlocks), falling back to the toolCalls array for
 *  messages that haven't been enriched (e.g. synthetic streaming chunks). */
export function resolveAllToolCallsFromMsg(msg: NarratorMsg): ToolCallData[] {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const results: ToolCallData[] = [];
	for (const block of blocks) {
		if (block.type !== "tool_use") continue;
		// Enriched blocks carry all fields directly; fall back to toolCalls lookup
		const isEnriched = block.status !== undefined;
		const tc = isEnriched
			? null
			: msg.toolCalls?.find((t: ToolCallRow) => t.toolUseId === (block.id ?? ""));
		const status = block.status ?? tc?.status ?? "running";
		// Derive startedAt for in-progress tools from persisted timestamps so the
		// elapsed timer works correctly when re-entering a session.
		let startedAt: number | undefined;
		if (status === "running" || status === "pending" || status === "initializing") {
			const ts =
				block.permissionDecidedAt ?? tc?.permissionDecidedAt ?? block.tcCreatedAt ?? tc?.createdAt;
			if (ts) startedAt = new Date(ts).getTime();
		}
		results.push({
			id: block.tcId ?? tc?.id,
			toolName: block.name ?? "",
			toolUseId: block.id,
			inputJson: block.inputJson ?? tc?.inputJson ?? block.input,
			outputJson: block.outputJson ?? tc?.outputJson,
			status,
			durationMs: block.durationMs ?? tc?.durationMs,
			errorMessage: block.errorMessage ?? tc?.errorMessage,
			permissionDenyMessage: block.permissionDenyMessage ?? tc?.permissionDenyMessage,
			permissionDecisionReason: block.permissionDecisionReason ?? tc?.permissionDecisionReason,
			permissionSuggestions: block.permissionSuggestions ?? tc?.permissionSuggestions,
			startedAt,
		});
	}
	return results;
}

/** Resolve a PendingPermission from a tool call's data or WS state fallback. */
export function resolvePendingPerm(
	tc: ToolCallData,
	wsPerm: PendingPermission | null | undefined,
	wsPermsMap?: Map<string, PendingPermission>,
): PendingPermission | null {
	// Prefer WS-sourced permissions — they carry the full (untruncated) inputJson.
	// The message-list API truncates large inputJson, so building from tc.inputJson
	// would lose data (e.g. ExitPlanMode plan text).
	if (wsPermsMap && tc.toolUseId) {
		const fromMap = wsPermsMap.get(tc.toolUseId);
		if (fromMap) return fromMap;
	}
	if (wsPerm && tc.toolUseId && tc.toolUseId === wsPerm.toolUseId) {
		return wsPerm;
	}
	// Fallback: build from the tool call record itself (status-driven path,
	// e.g. page refresh before WS reconnects or getPendingPermissions resolves).
	if (tc.status === "pending" && tc.toolUseId) {
		return {
			id: tc.id ?? tc.toolUseId,
			toolName: tc.toolName,
			toolUseId: tc.toolUseId,
			inputJson: tc.inputJson,
			decisionReason: tc.permissionDecisionReason ?? undefined,
			suggestions: tc.permissionSuggestions ?? undefined,
		};
	}
	return null;
}

export function filterChildrenByToolUse(
	children: NarratorMsg[],
	toolUseId: string | undefined,
): NarratorMsg[] {
	if (!toolUseId) return [];
	return children.filter((c) => c.parentToolUseId === toolUseId);
}

export function flattenToolRun(run: NarratorMsg[]): FlatToolItem[] {
	const items: FlatToolItem[] = [];
	for (const msg of run) {
		const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
		const origIndices = msg._blockOriginalIndices;
		for (let bi = 0; bi < blocks.length; bi++) {
			const block = blocks[bi];
			const realIndex = origIndices?.[bi] ?? bi;
			if (block.type === "reasoning" && typeof block.text === "string" && block.text.trim()) {
				items.push({
					kind: "reasoning",
					msg,
					reasoningText: block.text,
					translatedText: block.translatedText,
					blockIndex: realIndex,
				});
				continue;
			}
			if (block.type !== "tool_use") continue;
			const tcs = resolveAllToolCallsFromMsg(msg);
			const tc = tcs.find((t) => t.toolUseId === block.id);
			if (!tc) continue;
			const children = filterChildrenByToolUse(msg.children ?? [], tc.toolUseId);
			const isSubagent = tc.toolName === "Task" || children.length > 0;
			items.push({ kind: "tool", tc, msg, children, isSubagent, blockIndex: realIndex });
		}
	}
	return items;
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
