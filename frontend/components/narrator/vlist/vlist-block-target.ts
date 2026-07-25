/**
 * vlist-block-target.ts — Pure, DOM-free mapping from a rendered vlist item
 * (spec.kind + spec.key + manifest sourceMessageIds) to the selection system's
 * blockId and the (messageId, blockIndex) pair needed by single-block actions.
 *
 * spec.key encodings (shared/pretext-layout/segment-adapter.ts):
 *   markdown / reasoning / reasoning-steps / web-search / media : `{msgId}-b{blockIndex}`
 *   message-bubble (user)                                        : `{msgId}-bubble` (blockIndex 0)
 *   tool-call / subagent-card                                    : `tool-{toolUseId}`
 *   aggregates (tool-run-summary / tool-run-count / activity-*)  : no single block
 *
 * Selection blockId encodings (vlist-selection.ts / MessageSelectionCtx):
 *   content block: `msg-{messageId}-{blockIndex}`
 *   tool call:     `tc-{toolUseId}`
 *   subagent:      `sa-{toolUseId}`
 *
 * tool/subagent (messageId, blockIndex) are NOT recoverable from the spec alone
 * (spec.data lacks them and manifest sourceMessageIds is the whole tool-run's
 * id set). Callers must resolve the authoritative entry through
 * `selectionIndex.byBlockId.get(blockId)`.
 */

import type { VListElementKind } from "@shared/pretext-layout/element-kinds";

export interface VListBlockTarget {
	/** Selection-system blockId (msg-… | tc-… | sa-…). */
	blockId: string;
	/** Owning message id — reliable for single-message rows (not for tool runs). */
	messageId: string;
	/** Resolved block index for single-message rows; -1 when the row is a tool card
	 *  (block index must come from the selection entry instead). */
	blockIndex: number;
}

/** Kinds that are folded aggregates spanning multiple blocks/messages. These
 *  intentionally get no single-block menu (parity with the chunked path, whose
 *  ToolRunSummary/ActivityTrace/ToolRunCount are not wrapped in a block menu). */
const AGGREGATE_KINDS = new Set<VListElementKind>([
	"tool-run-summary",
	"tool-run-count",
	"activity-trace",
]);

/** Kinds that never participate in the single-block interaction menu. */
const NON_INTERACTIVE_KINDS = new Set<VListElementKind>([
	"prune-divider",
	"tool-call-group",
	"reasoning-count",
	"ask-user-question",
	"inline-permission",
]);

/** Single-message content kinds whose blockIndex is encoded as a `-b{n}` suffix. */
const BLOCK_INDEXED_KINDS = new Set<VListElementKind>([
	"markdown",
	"reasoning",
	"reasoning-steps",
	"web-search",
	"media",
	"system-simple",
	"system-text",
	"knowledge-hint",
	"plan-card",
	"ask-in-passing",
]);

const BLOCK_INDEX_SUFFIX = /-b(\d+)$/;

/** Extract the trailing `-b{n}` block index from a spec key, or null. */
function blockIndexFromKey(key: string): number | null {
	const match = BLOCK_INDEX_SUFFIX.exec(key);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Resolve the block target for a rendered row, or null when the row has no
 * single-block interaction menu (aggregates and non-interactive chrome).
 *
 * @param kind  The element kind (spec.kind).
 * @param key   The stable spec key (spec.key).
 * @param sourceMessageIds  manifest item's source message ids (first is the
 *   owning message for single-message rows).
 */
export function resolveVListBlockTarget(
	kind: VListElementKind,
	key: string,
	sourceMessageIds: readonly string[],
): VListBlockTarget | null {
	const messageId = sourceMessageIds[0];
	if (!messageId) return null;

	if (kind === "tool-call" || kind === "subagent-card") {
		// key = `tool-{toolUseId}`; prefix length 5. Selection registers both
		// tc-/sa- aliases to the same entry, so either prefix resolves the entry.
		const toolUseId = key.startsWith("tool-") ? key.slice(5) : null;
		if (!toolUseId) return null;
		const prefix = kind === "subagent-card" ? "sa-" : "tc-";
		return { blockId: `${prefix}${toolUseId}`, messageId, blockIndex: -1 };
	}

	if (kind === "message-bubble") {
		// User bubble: a single selectable block at index 0.
		return { blockId: `msg-${messageId}-0`, messageId, blockIndex: 0 };
	}

	if (NON_INTERACTIVE_KINDS.has(kind)) return null;
	if (AGGREGATE_KINDS.has(kind)) return null;

	if (BLOCK_INDEXED_KINDS.has(kind)) {
		const blockIndex = blockIndexFromKey(key);
		if (blockIndex == null) return null;
		return { blockId: `msg-${messageId}-${blockIndex}`, messageId, blockIndex };
	}

	return null;
}

/**
 * Inverse of the tool blockId encoding: `tc-{toolUseId}` / `sa-{toolUseId}` →
 * toolUseId. Content-block ids (`msg-…`) have no tool call, so they yield
 * undefined. Used to look a row up in the tool-metadata index.
 */
export function toolUseIdFromBlockId(blockId: string): string | undefined {
	if (!blockId.startsWith("tc-") && !blockId.startsWith("sa-")) return undefined;
	return blockId.slice(3) || undefined;
}
