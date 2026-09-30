/**
 * vlist-exact-row-state.ts — how one rendered row resolves its identity, its viewer
 * targets and its memo payload.
 *
 * Extracted from `PretextExactMessageList.tsx` unchanged. Three related jobs live here,
 * all of them about a ROW rather than about the list:
 *
 *  - **viewer targets** — which readable bodies a row can open fullscreen. Derived from
 *    the MEASURED element (a tool card's bodies live in its measured detail region), so
 *    it cannot live in the pure target module.
 *  - **selection identity** — the authoritative blockId for a folded trace's row, which
 *    only the selection index knows (`tc-` vs `sa-` depends on child messages the
 *    adapter never sees).
 *  - **memo equality** — `sameRowInteraction` / `rowInteractionSig`, the terms that let
 *    an unchanged row skip re-rendering during scroll. Dropping a field here does not
 *    break a render; it makes a row keep STALE content, which is why every field the
 *    row paints or dispatches from is compared explicitly.
 *
 * These stayed outside the `ExactRow` body deliberately (see the note on
 * `resolveTraceRowCardData`): `spec.data` must not become a memo comparison, since it
 * is a fresh object per rebuild and comparing it would re-render the whole mounted
 * window every frame.
 */

import type { ToolCappedDetail, ToolSectionsDetail } from "@shared/pretext-layout/tool-detail";
import type { MessageContextMenuActions } from "../message/MessageContextMenuCtx";
import { makeMessageBlockSelectionId } from "../message/MessageSelectionCtx";
import type { TraceRowIdentity } from "../trace/trace-row-identity";
import type { MeasuredReasoning } from "./measure/measure-reasoning";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import type { MeasuredToolCall } from "./measure/measure-tool-call";
import type { MeasuredCollapsibleTrace, MeasuredTraceRow } from "./measure/measure-tool-run";
import type { VListRenderLabels } from "./useVListLabels";
import type { VListToolDetailRequest } from "./useVListToolDetails";
import {
	resolveRowViewTargets,
	resolveSubagentModelTargets,
	resolveSubagentViewTargets,
	resolveToolDetailModelTargets,
	resolveToolDetailViewTargets,
	type VListViewOwner,
	type VListViewTarget,
} from "./vlist-content-view-target";
import type { VListEditRole } from "./vlist-edit-target";
import type { VListInteractionState } from "./vlist-interaction-state";
import type { VListItem } from "./vlist-pipeline";
import type { VListRowActionTarget, VListRowToolActions } from "./vlist-row-actions";
import { sameBoundActionKeys, sameNumberList } from "./vlist-row-payload-reuse";
import type { SelectionIndex } from "./vlist-selection";
import type { VListToolMeta } from "./vlist-tool-meta";

/**
 * The readable bodies of one row, for the fullscreen viewer.
 *
 * Derived here (not in the adapter) because it needs the MEASURED element: a
 * tool card's bodies live in its measured detail region, and a subagent card only
 * has bodies once it drew them. Pure and cheap — it walks the already-built block
 * list and copies strings — so it runs per mounted row, never per message.
 */
export function ownerRequestKey(owner: VListViewOwner): string {
	return owner.traceItemIndex == null
		? owner.specKey
		: `${owner.specKey}#row${owner.traceItemIndex}`;
}

export function resolveItemViewTargets(
	item: VListItem,
	renderLabels: VListRenderLabels,
	extra: Record<string, unknown>,
	fromSource = false,
): readonly VListViewTarget[] {
	const kind = item.spec.kind;
	if (kind === "communication-bubble") {
		const data = item.spec.data as { messageBody?: ToolCappedDetail };
		return resolveToolDetailModelTargets(
			item.spec.key,
			{
				kind: "sections",
				sections: data.messageBody
					? [{ key: "input.message", label: "message", body: data.messageBody }]
					: [],
			},
			{ sections: renderLabels.toolCall.sections },
		);
	}
	if (kind === "tool-call") {
		const labels = { sections: renderLabels.toolCall.sections };
		const model = (item.spec.data as { detail?: ToolSectionsDetail } | null)?.detail;
		return fromSource && model
			? resolveToolDetailModelTargets(item.spec.key, model, labels)
			: resolveToolDetailViewTargets(item.spec.key, item.measured as MeasuredToolCall, labels);
	}
	if (kind === "subagent-card") {
		const data = (item.spec.data ?? {}) as { resultText?: unknown; agentType?: unknown };
		const description = typeof extra.description === "string" ? extra.description : "";
		const agentType = typeof data.agentType === "string" ? data.agentType : "agent";
		const options = { title: description ? `${agentType} — ${description}` : agentType };
		const labels = { prompt: renderLabels.subagent.prompt };
		return fromSource
			? resolveSubagentModelTargets(
					item.spec.key,
					item.spec.data as { promptBody?: ToolCappedDetail; resultBody?: ToolCappedDetail },
					options,
					labels,
				)
			: resolveSubagentViewTargets(
					item.spec.key,
					item.measured as MeasuredSubagent,
					options,
					labels,
				);
	}
	return resolveRowViewTargets(
		item.spec,
		{
			reasoning: renderLabels.reasoning.reasoning,
			thinking: renderLabels.reasoning.thinking,
		},
		// Whether the ROW's renderer can swap its body for the raw source. Decided
		// from the MEASURED form, which is why it cannot live in the pure target
		// module: a markdown row always paints a body, while a reasoning run only
		// does so when expanded — its three other forms are single header rows with
		// nowhere to put the text, so the toggle would be a dead control there.
		{ sourceInline: canShowRowSourceInline(item) },
	);
}

/** True when this plain content row paints a body an in-place source view can replace. */
export function canShowRowSourceInline(item: VListItem): boolean {
	if (item.spec.kind === "markdown") return true;
	if (item.spec.kind === "reasoning") {
		return (item.measured as MeasuredReasoning).form === "expanded";
	}
	return false;
}

/**
 * The readable bodies of ONE drilled-in trace row's nested tool card.
 *
 * Mirrors what the `rowCard` slot hands the card at render time, so the fullscreen
 * modal re-derives exactly the body it is showing. Empty when that row is no longer
 * open (the reader collapsed it while the modal was up, which the modal treats the
 * same way as any vanished target).
 */
/**
 * One drilled-in trace row's CARD payload, read from the freshly adapted spec.
 *
 * A drilled-in card is not its own list element, so its render props cannot come
 * from `resolveRenderExtra(item.spec)` — they live one level down, on the trace's
 * row item. Reading them here (rather than off the measured payload) is the same
 * contract the row live-tails follow: `measured` may be a cache hit, while the
 * spec is rebuilt every commit.
 *
 * Kept OUTSIDE the ExactRow body deliberately, like `resolveTraceRowViewTargets`
 * below. `spec.data` must not become a memo comparison — it is a fresh object on
 * every rebuild, so comparing it would re-render the whole window per frame — and
 * it does not need to be: a payload change moves the trace's measure-cache
 * revision (see measure-cache's `traceRevision` → `subagentRevision`), which
 * yields a new `measured` object and re-renders the row through that term.
 */
export function resolveTraceRowCardData(
	item: VListItem,
	itemIndex: number,
): Record<string, unknown> {
	const traceItems = (item.spec.data as { items?: Array<{ card?: unknown }> } | null)?.items;
	const card = traceItems?.[itemIndex]?.card;
	return card && typeof card === "object" ? (card as Record<string, unknown>) : {};
}

export function resolveTraceRowViewTargets(
	item: VListItem,
	itemIndex: number,
	renderLabels: VListRenderLabels,
	fromSource = false,
): readonly VListViewTarget[] {
	const owner = { specKey: item.spec.key, traceItemIndex: itemIndex };
	const cardData = resolveTraceRowCardData(item, itemIndex);
	if (fromSource) {
		if (cardData.detail)
			return resolveToolDetailModelTargets(owner, cardData.detail as ToolSectionsDetail, {
				sections: renderLabels.toolCall.sections,
			});
		if (cardData.promptBody || cardData.resultBody)
			return resolveSubagentModelTargets(
				owner,
				cardData as { promptBody?: ToolCappedDetail; resultBody?: ToolCappedDetail },
				{ title: String(cardData.agentType ?? "agent") },
				{ prompt: renderLabels.subagent.prompt },
			);
	}
	const measured = item.measured as MeasuredCollapsibleTrace;
	const row = measured.rows?.find((candidate) => candidate.itemIndex === itemIndex);
	const card = row?.cardMeasured;
	if (!card) return [];
	// A SUBAGENT row's bodies are the card's prompt + result, resolved exactly as
	// the standalone card's are (see resolveItemViewTargets). Reading the payload
	// from the fresh spec keeps this aligned with what `rowCard` painted.
	if (row?.cardKind === "subagent-card") {
		const cardData = resolveTraceRowCardData(item, itemIndex);
		const description = typeof cardData.description === "string" ? cardData.description : "";
		const agentType = typeof cardData.agentType === "string" ? cardData.agentType : "agent";
		return resolveSubagentViewTargets(
			owner,
			card as MeasuredSubagent,
			{ title: description ? `${agentType} — ${description}` : agentType },
			{ prompt: renderLabels.subagent.prompt },
		);
	}
	return resolveToolDetailViewTargets(owner, card as MeasuredToolCall, {
		sections: renderLabels.toolCall.sections,
	});
}

/** Kinds whose card open/close is user-toggleable (needs onToggle). */
export const TOGGLEABLE_CARD_KINDS = new Set([
	"reasoning",
	"tool-call",
	"subagent-card",
	// Slash-command bubbles fold their expanded prompt behind a toggle. Plain user
	// bubbles carry no `commandText`, so the render layer ignores the callback.
	"message-bubble",
]);
/** Trace-family kinds with header/earlier/row toggles. */
export const TRACE_KINDS = new Set(["activity-trace", "reasoning-steps"]);
/**
 * Folded traces whose individual ROWS get their own interaction surface.
 *
 * `reasoning-steps` is excluded on purpose: that element already receives an
 * element-level menu (it is in vlist-block-target's BLOCK_INDEXED_KINDS), and its
 * rows all belong to the same reasoning run — so a row menu would be a redundant
 * nested duplicate of the element's own.
 */
export const TRACE_ROW_INTERACTION_KINDS = new Set(["activity-trace"]);

/**
 * Resolve a measured trace row into the authoritative selection identity.
 *
 * The adapter attaches only message coordinates (and a toolUseId): it cannot know
 * whether a tool is filed under `tc-` or `sa-`, because that depends on the child
 * messages it never sees. The selection index does know, and registers both
 * aliases — so look the entry up and use its PRIMARY blockId. That matters
 * because `entriesToBlockMeta` / `computeSelectedRange` test membership against
 * the primary id; selecting a row under the wrong alias would highlight it but
 * make the selection toolbar silently skip it.
 *
 * Returns null when no selection entry exists (streaming / id-less rows), leaving
 * the row plain.
 */
export function resolveTraceRowIdentity(
	row: MeasuredTraceRow,
	selectionIndex: SelectionIndex,
	toolMetaIndex: Map<string, VListToolMeta>,
): TraceRowIdentity | null {
	const rowIdentity = row.identity;
	if (!rowIdentity?.messageId) return null;

	const { messageId, toolUseId } = rowIdentity;
	// Tool rows resolve through either alias; content rows through msg-{id}-{index}.
	const lookupId = toolUseId
		? `tc-${toolUseId}`
		: makeMessageBlockSelectionId(messageId, rowIdentity.blockIndex);
	const entry = selectionIndex.byBlockId.get(lookupId);
	if (!entry) return null;

	const identity: TraceRowIdentity = {
		blockId: entry.blockId,
		messageId: entry.messageId,
		blockIndex: entry.blockIndex,
		blockIndices: entry.blockIndices ?? rowIdentity.blockIndices,
	};
	if (entry.copyText?.trim()) identity.copyText = entry.copyText;
	if (toolUseId) {
		const meta = toolMetaIndex.get(toolUseId);
		identity.tool = {
			toolName: rowIdentity.toolName ?? meta?.toolName ?? "",
			toolUseId,
			...(meta?.isRunningBash ? { isRunningBash: true } : {}),
			...(meta?.filePath ? { filePath: meta.filePath } : {}),
			...(meta?.isReadTool ? { isReadTool: true } : {}),
			// Gates "open in panel". Broader than isReadTool (any Read/Write/Edit with
			// a path), and NOT implied by `filePath`: dropping it here is what silently
			// cost the folded row the item the expanded card offers.
			...(meta?.isFileTool ? { isFileTool: true } : {}),
			// Embedded metadata only — never a per-row network lookup.
			...(meta?.awaitAgentNarratorId ? { awaitAgentNarratorId: meta.awaitAgentNarratorId } : {}),
			// Subagent lifecycle facts (open session / detach / cancel), matching the
			// three items the expanded SubagentCard offers.
			...(meta?.subagentNarratorId ? { subagentNarratorId: meta.subagentNarratorId } : {}),
			// Send's addressee — the only source is the tool's own returned targets.
			...(meta?.sendTargetNarratorId ? { sendTargetNarratorId: meta.sendTargetNarratorId } : {}),
			...(meta?.isBackground ? { isBackground: true } : {}),
			...(meta?.isTerminal ? { isTerminal: true } : {}),
		};
	}
	return identity;
}

/**
 * Every selection blockId one rendered row can answer for.
 *
 * Used only to locate the touch swipe ANCHOR's row so it can be pinned into the
 * mounted window. A row is more than its own element id: a folded trace paints one
 * independently-swipeable row per tool call / reasoning step, and any of those rows
 * may be the anchor while the unit that must stay mounted is the trace ELEMENT.
 *
 * Tool rows are reported under BOTH aliases because the primary id the anchor
 * carries (`tc-` vs `sa-`) is decided by child messages the trace row never sees —
 * the same reason `resolveTraceRowIdentity` has to consult the selection index.
 * Guessing wrong here would just fail to pin, so both are emitted.
 *
 * Returns null for rows with no interaction surface at all (chrome, aggregates
 * without rows), so the anchor scan skips them without allocating.
 */
export function rowSelectionBlockIds(
	item: VListItem,
	elementBlockId: string | undefined,
): readonly string[] | null {
	const rows = TRACE_ROW_INTERACTION_KINDS.has(item.spec.kind)
		? (item.measured as MeasuredCollapsibleTrace).rows
		: undefined;
	if (!rows || rows.length === 0) return elementBlockId ? [elementBlockId] : null;
	const ids: string[] = elementBlockId ? [elementBlockId] : [];
	for (const row of rows) {
		const identity = row.identity;
		if (!identity?.messageId) continue;
		if (identity.toolUseId) {
			ids.push(`tc-${identity.toolUseId}`, `sa-${identity.toolUseId}`);
		} else {
			ids.push(makeMessageBlockSelectionId(identity.messageId, identity.blockIndex));
		}
	}
	return ids.length > 0 ? ids : null;
}

/**
 * Is this row's card currently OPEN? — the value `onToggle` inverts.
 *
 * Answered from the MEASURED element wherever possible, because that is the only
 * place the LOD-resolved truth lives: `effectiveOpened` / `effectiveExpanded` are
 * "what the reader is actually looking at" after LOD, recency and lodExempt have
 * had their say, which is not the same as the stored preference. Per-kind shapes:
 *
 *   tool-call      → `effectiveOpened`
 *   subagent-card  → `effectiveExpanded`
 *   reasoning      → `form === "expanded"` (its four forms encode the fold)
 *   message-bubble → `form === "command"` + `expanded` (a slash-command bubble's
 *                    `form` is the literal "command", so the generic checks above
 *                    cannot see its fold; plain bubbles have no fold at all)
 *
 * The `state` fallback exists for keys that have NO measured entry at all; the
 * state map is authoritative for those, since nothing but this toggle writes them.
 */
export function resolveRowOpenState(
	measuredElement: VListItem["measured"] | undefined,
	state: VListInteractionState,
	key: string,
): boolean {
	const measured = measuredElement as
		| {
				effectiveOpened?: boolean;
				effectiveExpanded?: boolean;
				form?: string;
				expanded?: boolean;
		  }
		| undefined;
	if (measured) {
		// Slash-command bubble: its own `expanded` flag, checked first because its
		// `form` value would otherwise fall through to the `"expanded"` comparison.
		if (measured.form === "command") return measured.expanded === true;
		if (measured.effectiveOpened !== undefined) return measured.effectiveOpened;
		if (measured.effectiveExpanded !== undefined) return measured.effectiveExpanded;
		if (measured.form !== undefined) return measured.form === "expanded";
		if (measured.expanded !== undefined) return measured.expanded;
	}
	return state.expanded.get(key) === true;
}

/**
 * Compact signature of everything in the interaction state that can change a
 * single row's height/appearance. Rows whose signature is unchanged (and whose
 * item + geometry are unchanged) can skip re-rendering entirely during scroll.
 */
export function rowInteractionSig(state: VListInteractionState, key: string): string {
	const expanded = state.expanded.get(key);
	const lodOverride = state.lodUserOverrides.has(key) ? 1 : 0;
	const showEarlier = state.showEarlier.has(key) ? 1 : 0;
	const rows = state.expandedRows.get(key);
	const rowsSig = rows && rows.size > 0 ? [...rows].sort((a, b) => a - b).join(",") : "";
	// A folded trace's drill-down lives in its own KEY-addressed channel, so it needs
	// its own term here: without it a trace row opening changed nothing the memo
	// compares (the index-addressed `rowsSig` stays empty for traces) and the row
	// could skip the re-render that paints the revealed card.
	const traceRows = state.expandedTraceRows.get(key);
	const traceRowsSig = traceRows && traceRows.size > 0 ? [...traceRows].sort().join(",") : "";
	const promptOpen = state.promptOpen.has(key) ? 1 : 0;
	// The file-list fold changes how many rows are DRAWN, so it must move the opts
	// signature — otherwise expanding it would not re-measure the card.
	const fileChangesOpen = state.fileChangesOpen.has(key) ? 1 : 0;
	return `${expanded === undefined ? "u" : expanded ? "1" : "0"}:${lodOverride}:${showEarlier}:${rowsSig}:${traceRowsSig}:${promptOpen}:${fileChangesOpen}`;
}

/**
 * Do two `RowInteraction` payloads describe the same row content?
 *
 * Used to keep the PREVIOUS frame's object when a rebuild changed nothing this row
 * renders (see vlist-row-payload-reuse.ts for why identity matters and why the
 * closures are compared by BOUND KEYS rather than by reference).
 *
 * Every field the row paints or dispatches from is covered: dropping one would let
 * a row keep stale content, which is exactly the frozen-live-tail failure mode one
 * layer down.
 */
export function sameRowInteraction(a: RowInteraction, b: RowInteraction): boolean {
	return (
		a.blockId === b.blockId &&
		a.messageId === b.messageId &&
		a.blockIndex === b.blockIndex &&
		sameNumberList(a.blockIndices, b.blockIndices) &&
		a.copyText === b.copyText &&
		// These were previously protected only by replacing the whole document cache.
		a.editRole === b.editRole &&
		a.queuedActions?.onEdit === b.queuedActions?.onEdit &&
		a.queuedActions?.onCancel === b.queuedActions?.onCancel &&
		a.queuedActions?.onRetry === b.queuedActions?.onRetry &&
		a.toolUseId === b.toolUseId &&
		a.toolDetailRef?.toolUseId === b.toolDetailRef?.toolUseId &&
		a.toolDetailRef?.toolCallId === b.toolDetailRef?.toolCallId &&
		a.toolDetailRef?.messageId === b.toolDetailRef?.messageId &&
		a.toolDetailRef?.executionAttempt === b.toolDetailRef?.executionAttempt &&
		// Tool facts drive the row's menu items and the card's open-session button.
		// Compared field-wise: the index is rebuilt per frame, so the object identity
		// always differs even when the facts do not.
		sameToolMeta(a.toolMeta, b.toolMeta) &&
		// Which ACTIONS are bound is the part that can change within a generation (a
		// tool going terminal drops "detach", a resolved await gains "open session").
		sameBoundActionKeys(
			a.toolActions as Record<string, unknown> | undefined,
			b.toolActions as Record<string, unknown> | undefined,
		) &&
		sameBoundActionKeys(
			a.actions as unknown as Record<string, unknown>,
			b.actions as unknown as Record<string, unknown>,
		) &&
		// Presence only: the callback closes over `messageId`, already compared above.
		!!a.onViewOriginal === !!b.onViewOriginal &&
		// The inspector's content is derived from the spec; a different injection body
		// must not inherit a neighbour's "what the model saw" text.
		a.inspectContent?.text === b.inspectContent?.text &&
		a.inspectContent?.title === b.inspectContent?.title
	);
}

/** Field-wise comparison of the tool facts a row payload carries. */
export function sameToolMeta(a: VListToolMeta | undefined, b: VListToolMeta | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.toolName === b.toolName &&
		a.toolUseId === b.toolUseId &&
		a.isRunningBash === b.isRunningBash &&
		a.filePath === b.filePath &&
		a.isFileTool === b.isFileTool &&
		a.isReadTool === b.isReadTool &&
		a.subagentNarratorId === b.subagentNarratorId &&
		a.awaitQuestionId === b.awaitQuestionId &&
		a.awaitQuestionSeq === b.awaitQuestionSeq &&
		a.awaitAgentTargetId === b.awaitAgentTargetId &&
		a.awaitAgentNarratorId === b.awaitAgentNarratorId &&
		a.sendTargetNarratorId === b.sendTargetNarratorId &&
		a.isBackground === b.isBackground &&
		a.isTerminal === b.isTerminal &&
		a.resultMessageId === b.resultMessageId
	);
}

/** Stable per-key toggle callbacks, memoized so equal rows keep referential props. */
export interface RowToggles {
	onToggle: () => void;
	onToggleItems: () => void;
	onToggleEarlier: () => void;
	/**
	 * Drill into one row.
	 *
	 * Passing `rowKey` selects the KEY-addressed channel (`expandedTraceRows`),
	 * omitting it the index-addressed one (`expandedRows`). Which one an element
	 * needs is decided by its kind, not by this callback — see
	 * `traceRowFoldChannel`, and the routing at the `TRACE_KINDS` binding.
	 */
	onToggleRow: (rowIndex: number, rowKey?: string) => void;
	/** Flip a translated body between its translation and the original. */
	onToggleTranslation: () => void;
	/**
	 * Fold / unfold a subagent card's PROMPT body — a second, independent fold
	 * inside the card (parity with the chunked SubagentCard's `showPrompt`).
	 */
	onTogglePrompt: () => void;
	/** Expand / collapse a subagent card's file-change list (its own fold). */
	onToggleFileChanges: () => void;
}

/**
 * Referential-stable interaction payload for one row, cached by spec.key so the
 * ExactRow memo keeps skipping unchanged rows during scroll. `copyText` and the
 * context-menu actions close over the resolved selection entry.
 */
export interface RowInteraction {
	blockId: string;
	messageId: string;
	blockIndex: number;
	blockIndices?: readonly number[];
	copyText?: string;
	actions: MessageContextMenuActions;
	/** Editor mode captured by the bound edit action, not just action presence. */
	editRole?: VListEditRole;
	/** Queued controls may change behind a stable resolver; compare the bound callbacks. */
	queuedActions?: VListRowActionTarget["queued"];
	/** Tool-call id for tc-/sa- rows (drives the inspector item). */
	toolUseId?: string;
	/** Exact request identity from the card, not the selection alias. */
	toolDetailRef?: VListToolDetailRequest;
	/** Row tool facts (file path, child narrator, background state). */
	toolMeta?: VListToolMeta;
	/** Card-specific actions bound to this row's tool. */
	toolActions?: VListRowToolActions;
	/**
	 * Reveal this message's pre-edit text. Present only when the owning message
	 * carries `editedAt`; the modal itself is a single shell-level instance.
	 */
	onViewOriginal?: () => void;
	/**
	 * Verbatim model-facing content for the "what the model saw" inspector, carried
	 * by injection-bubble rows (which speak FOR somebody). Read off `spec.data`'s
	 * `modelFacing`, with the speaker/source label as the inspector's title.
	 */
	inspectContent?: { title: string; text: string };
}
