/**
 * vlist-block-target.ts — Pure, DOM-free mapping from a rendered vlist item
 * (spec.kind + spec.key + manifest sourceMessageIds) to the selection system's
 * blockId and the (messageId, blockIndex) pair needed by single-block actions.
 *
 * spec.key encodings (shared/pretext-layout/segment-adapter.ts):
 *   markdown / reasoning / reasoning-steps / web-search / media : `{msgId}-b{blockIndex}`
 *   message-bubble (user)                                        : `{msgId}-bubble` (blockIndex 0)
 *   tool-call / subagent-card                                    : `tool-{toolUseId}`
 *   aggregates (tool-run-count / activity-*)                     : no single block
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
 *  ActivityTrace/ToolRunCount are not wrapped in a block menu). */
const AGGREGATE_KINDS = new Set<VListElementKind>(["tool-run-count", "activity-trace"]);

/** Kinds that never participate in the single-block interaction menu. */
const NON_INTERACTIVE_KINDS = new Set<VListElementKind>([
	"tool-call-group",
	"reasoning-count",
	"ask-user-question",
	"inline-permission",
	// `injection-bubble` was listed here while one block fanned out into N bubbles with
	// no per-bubble address. Persistence now writes ONE injection per row, so the bubble
	// IS the block and gets the full single-block menu (delete / rollback / fork /
	// inspect), exactly like a user's own message. See resolveVListBlockTarget.
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

const BLOCK_INDEX_TOKEN = /-b(\d+)(?:-|$)/;

/** Extract the stable `-b{n}` block index from a spec key, or null. */
function blockIndexFromKey(key: string, messageId?: string): number | null {
	const suffix = messageId && key.startsWith(`${messageId}-`) ? key.slice(messageId.length) : key;
	const match = BLOCK_INDEX_TOKEN.exec(suffix);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * An injection bubble's block index sits MID-key (`{msgId}-b{n}-m-sender`), not at the
 * end, because the sender/source suffix is what keeps the key stable. Extract the
 * `-b{n}-` segment rather than a trailing one.
 */
const INJECTION_BLOCK_INDEX = /-b(\d+)-/;
function injectionBlockIndexFromKey(key: string, messageId?: string): number | null {
	const suffix = messageId && key.startsWith(`${messageId}-`) ? key.slice(messageId.length) : key;
	const match = INJECTION_BLOCK_INDEX.exec(suffix);
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

	if (kind === "tool-call" || kind === "subagent-card" || kind === "communication-bubble") {
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

	// An injection bubble is ONE content block per row now (the fan-out is gone). Its
	// key carries the block index as `-b{n}-` before the speaker/source suffix, which is
	// the row's address for delete / rollback / fork — the same operations a user's own
	// message exposes.
	if (kind === "injection-bubble") {
		const blockIndex = injectionBlockIndexFromKey(key, messageId);
		if (blockIndex == null) return null;
		return { blockId: `msg-${messageId}-${blockIndex}`, messageId, blockIndex };
	}

	if (BLOCK_INDEXED_KINDS.has(kind)) {
		const blockIndex = blockIndexFromKey(key, messageId);
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
