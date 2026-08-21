/**
 * vlist-reflection-index.ts — Pure derivation of the per-row REFLECTION data the
 * exact vlist needs to render a `ReflectionNotice` at parity with the chunked path.
 *
 * The chunked card resolves its permission area in this order (ToolCallCard.tsx:5418):
 *
 *   reflection = getToolCallReflection(toolCall, pendingPermission)
 *   reflection && reflection.status !== "awaiting_user"  → <ReflectionNotice/>
 *   pendingPermission                                    → <InlinePermission/>
 *
 * The vlist bridge only had the second branch, so a *running* reflection rendered
 * raw approve/deny buttons (the request is still in the live pending list — see
 * useNarratorPanelWS.replacePendingPermissions) and a *resolved* reflection rendered
 * nothing at all (it is filtered out of the pending list, and the persisted
 * `permissionSuggestions` were never read).
 *
 * This module supplies the missing half: a `toolUseId → reflection source` index
 * built from the loaded message tree, plus the same resolution the chunked card
 * performs. Reflection parsing itself is NOT reimplemented — it delegates to the
 * shared helpers in narrator-message-helpers so both paths cannot drift.
 *
 * Zero DOM, zero React: only data in, data out.
 */

import type { ToolCallRecord } from "@frontend/lib/api";
import {
	getPermissionReflectionSuggestion,
	isReflectionPermissionLike,
	normalizeReflectionAfterToolStatus,
	type ReflectionSuggestion,
} from "../narrator-message-helpers";
import type { ContentBlock, NarratorMsg, PendingPermission } from "../narrator-panel-types";
import type { ToolCallData } from "../tool-call-data";

/**
 * The reflection-relevant facts of one tool call. Mirrors exactly the fields the
 * chunked `getToolCallReflection` + `ReflectionNotice` read off `ToolCallData`;
 * everything else the layout spec already carries is intentionally absent.
 */
export interface VListReflectionSource {
	/** Tool-call row id — equals the reflection request id for persisted gates. */
	toolCallId?: string;
	toolName: string;
	status?: string;
	errorMessage?: string;
	permissionDecisionReason?: string;
	suggestions?: unknown[] | null;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function suggestionsOf(value: unknown): unknown[] | null {
	return Array.isArray(value) ? value : null;
}

/**
 * Merge a `tool_use` content block with its (optional) tool-call row. The block
 * wins because the backend enriches it from the row (enrichToolUseBlocks), while a
 * non-enriched block falls back to the row — same precedence as
 * message-segments.resolveAllToolCallsFromMsg.
 */
function mergeSource(block: ContentBlock, tc: ToolCallRecord | undefined): VListReflectionSource {
	const source: VListReflectionSource = {
		toolName: nonEmpty(block.name) ?? nonEmpty(tc?.toolName) ?? "",
	};
	const toolCallId = nonEmpty(block.tcId) ?? nonEmpty(tc?.id);
	if (toolCallId) source.toolCallId = toolCallId;
	const status = nonEmpty(block.status) ?? nonEmpty(tc?.status);
	if (status) source.status = status;
	const errorMessage = nonEmpty(block.errorMessage) ?? nonEmpty(tc?.errorMessage);
	if (errorMessage) source.errorMessage = errorMessage;
	const reason = nonEmpty(block.permissionDecisionReason) ?? nonEmpty(tc?.permissionDecisionReason);
	if (reason) source.permissionDecisionReason = reason;
	source.suggestions =
		suggestionsOf(block.permissionSuggestions) ?? suggestionsOf(tc?.permissionSuggestions);
	return source;
}

/** A tool-call row with no matching content block (defensive; mirrors the chunked walk). */
function sourceFromToolCall(tc: ToolCallRecord): VListReflectionSource {
	const source: VListReflectionSource = { toolName: nonEmpty(tc.toolName) ?? "" };
	const toolCallId = nonEmpty(tc.id);
	if (toolCallId) source.toolCallId = toolCallId;
	const status = nonEmpty(tc.status);
	if (status) source.status = status;
	const errorMessage = nonEmpty(tc.errorMessage);
	if (errorMessage) source.errorMessage = errorMessage;
	const reason = nonEmpty(tc.permissionDecisionReason);
	if (reason) source.permissionDecisionReason = reason;
	source.suggestions = suggestionsOf(tc.permissionSuggestions);
	return source;
}

/**
 * Record (or clear) one occurrence. Only reflection-bearing tool calls are kept, so
 * the index stays tiny and an empty map reliably means "this narrator has no
 * reflections at all". A NEWER occurrence of a reused toolUseId that carries no
 * reflection deletes the older entry — the newest occurrence always decides, which
 * is what the chunked newest-first walk resolves to
 * (message-tree-utils.getNewestReflectionToolOccurrenceInTree).
 */
function record(
	index: Map<string, VListReflectionSource>,
	toolUseId: string,
	source: VListReflectionSource,
): void {
	if (isReflectionPermissionLike({ permissionSuggestions: source.suggestions ?? null })) {
		index.set(toolUseId, source);
	} else {
		index.delete(toolUseId);
	}
}

function collectFromMessage(msg: NarratorMsg, index: Map<string, VListReflectionSource>): void {
	const toolCalls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : [];
	const rowByToolUseId = new Map<string, ToolCallRecord>();
	for (const tc of toolCalls) {
		if (tc?.toolUseId) rowByToolUseId.set(tc.toolUseId, tc);
	}

	const covered = new Set<string>();
	const blocks = Array.isArray(msg?.contentJson) ? (msg.contentJson as ContentBlock[]) : [];
	for (const block of blocks) {
		if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
		const toolUseId = nonEmpty(block.id);
		if (!toolUseId) continue;
		covered.add(toolUseId);
		record(index, toolUseId, mergeSource(block, rowByToolUseId.get(toolUseId)));
	}
	for (const tc of toolCalls) {
		const toolUseId = tc?.toolUseId;
		if (!toolUseId || covered.has(toolUseId)) continue;
		record(index, toolUseId, sourceFromToolCall(tc));
	}
}

/**
 * Build the `toolUseId → VListReflectionSource` index for a loaded message tree.
 *
 * Walk order encodes the chunked precedence (child occurrence beats its parent row,
 * later message beats earlier): each message writes itself first, then recurses into
 * its children, and later writes overwrite earlier ones.
 *
 * NOTE: duplicate occurrences of one provider toolUseId collapse into a single entry,
 * because a vlist row resolves to a `tool-<toolUseId>` key (the `#dupN` suffix is
 * stripped) — the same conflation `findPendingForKey` already applies.
 */
export function buildReflectionSourceIndex(
	messages: readonly NarratorMsg[],
): Map<string, VListReflectionSource> {
	const index = new Map<string, VListReflectionSource>();
	if (!Array.isArray(messages)) return index;
	const walk = (list: readonly NarratorMsg[]): void => {
		for (const msg of list) {
			if (!msg) continue;
			collectFromMessage(msg, index);
			if (Array.isArray(msg.children) && msg.children.length > 0) walk(msg.children);
		}
	};
	walk(messages);
	return index;
}

/**
 * Resolve the reflection to show for one row — a 1:1 mirror of the chunked
 * `getToolCallReflection` (ToolCallCard.tsx:1566): the live permission's suggestions
 * win over the persisted ones, and a failed tool call downgrades a still-active
 * reflection to `aborted` with the failure text as its reason.
 */
export function resolveRowReflection(
	source: VListReflectionSource | undefined,
	pending: PendingPermission | null,
): ReflectionSuggestion | null {
	const reflection = getPermissionReflectionSuggestion({
		permissionSuggestions: source?.suggestions ?? null,
		suggestions: pending?.suggestions,
	});
	const normalized = normalizeReflectionAfterToolStatus(reflection, source?.status, !!pending);
	if (normalized?.status === "aborted" && normalized !== reflection) {
		const reason =
			source?.errorMessage || source?.permissionDecisionReason || reflection?.reason || undefined;
		return { ...normalized, ...(reason ? { reason } : {}) };
	}
	return normalized;
}

/**
 * Synthesize the minimal `ToolCallData` `ReflectionNotice` needs. The component only
 * reads `id` (keyboard/request identity fallback) and `permissionDecisionReason` /
 * `errorMessage` (summary fallback); the remaining fields satisfy the type.
 */
export function reflectionToolCallData(
	toolUseId: string,
	source: VListReflectionSource | undefined,
	pending: PendingPermission | null,
): ToolCallData {
	return {
		id: source?.toolCallId ?? pending?.id ?? toolUseId,
		toolUseId: toolUseId || undefined,
		toolName: source?.toolName || pending?.toolName || "",
		inputJson: pending?.inputJson ?? {},
		status: source?.status ?? "pending",
		...(source?.errorMessage ? { errorMessage: source.errorMessage } : {}),
		permissionDecisionReason:
			source?.permissionDecisionReason ?? pending?.decisionReason ?? undefined,
		permissionSuggestions: source?.suggestions ?? null,
	};
}
