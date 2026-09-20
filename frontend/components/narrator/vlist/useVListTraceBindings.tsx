import type { ToolCallDetailRef } from "@frontend/lib/api/narrators";
import type { AdapterTraceRowIdentity } from "@shared/pretext-layout/segment-adapter";
import { useMemo, useRef } from "react";
import {
	type MessageContextMenuActions,
	MessageContextMenuCtx,
} from "../message/MessageContextMenuCtx";
import { makeMessageBlockSelectionId } from "../message/MessageSelectionCtx";
import { TraceRowInteraction } from "../trace/TraceRowInteraction";
import type { TraceRowIdentity } from "../trace/trace-row-identity";
import type { MeasuredCollapsibleTrace, MeasuredTraceRow } from "./measure/measure-tool-run";
import type { TraceRowInteractionSlot } from "./render/RenderToolRun";
import {
	resolveTraceRowCardData,
	resolveTraceRowIdentity,
	sameToolMeta,
	TRACE_KINDS,
	TRACE_ROW_INTERACTION_KINDS,
} from "./vlist-exact-row-state";
import type { VListItem } from "./vlist-pipeline";
import {
	buildRowCtxActions,
	buildRowToolActions,
	type VListRowHandlers,
	type VListRowToolActions,
} from "./vlist-row-actions";
import { sameNumberList } from "./vlist-row-payload-reuse";
import type { SelectionIndex } from "./vlist-selection";
import type { VListToolMeta } from "./vlist-tool-meta";

export interface TraceGroupBinding {
	rowInteraction: TraceRowInteractionSlot;
	/** A trace row's render key, including any retry/dedupe suffix. */
	resolveRowToolActions: (rowKey: string) => VListRowToolActions | undefined;
}

export interface VListTraceBindingsOptions {
	narratorId: string;
	renderItems: readonly (VListItem | undefined)[];
	selectionIndex: SelectionIndex | null | undefined;
	rowToolMetaIndex: Map<string, VListToolMeta>;
	rowHandlers?: VListRowHandlers;
}

const MESSAGE_HANDLERS = [
	"onForkFromMessage",
	"onAskInPassing",
	"onCompactBeforeMessage",
	"onClearContextBefore",
	"onManualSummarize",
	"onDeleteBlock",
	"onRollbackToBlock",
	"onEditMessage",
] as const;
const TOOL_HANDLERS = [
	"onViewSubagentSession",
	"onDetachSubagent",
	"onCancelBackgroundTask",
	"onOpenFilePanel",
] as const;
const BOUND_HANDLERS = [...MESSAGE_HANDLERS, ...TOOL_HANDLERS];

interface RowProjection {
	identity: TraceRowIdentity | null;
	toolDetailRef: ToolCallDetailRef | undefined;
	toolMeta: VListToolMeta | undefined;
	/** Only functions this row can actually dispatch, not the panel's handler shell. */
	handlers: VListRowHandlers;
}
interface BoundRow extends RowProjection {
	actions: MessageContextMenuActions | undefined;
	toolActions: VListRowToolActions | undefined;
}
interface BoundGroup {
	rows: Map<string, BoundRow>;
	binding: TraceGroupBinding;
}

function sameIdentity(a: TraceRowIdentity | null, b: TraceRowIdentity | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.blockId === b.blockId &&
		a.messageId === b.messageId &&
		a.blockIndex === b.blockIndex &&
		sameNumberList(a.blockIndices, b.blockIndices) &&
		a.copyText === b.copyText &&
		a.tool?.toolUseId === b.tool?.toolUseId &&
		sameToolMeta(a.tool, b.tool)
	);
}

function sameProjection(a: RowProjection, b: RowProjection): boolean {
	return (
		sameIdentity(a.identity, b.identity) &&
		sameToolMeta(a.toolMeta, b.toolMeta) &&
		a.toolDetailRef?.toolCallId === b.toolDetailRef?.toolCallId &&
		a.toolDetailRef?.messageId === b.toolDetailRef?.messageId &&
		a.toolDetailRef?.executionAttempt === b.toolDetailRef?.executionAttempt &&
		BOUND_HANDLERS.every((key) => a.handlers[key] === b.handlers[key])
	);
}

/** Snapshot only live capabilities; replacing an unrelated panel callback is not a change. */
function projectHandlers(
	identity: TraceRowIdentity | null,
	meta: VListToolMeta | undefined,
	handlers: VListRowHandlers = {},
): VListRowHandlers {
	const projected: VListRowHandlers = {};
	if (identity) {
		for (const key of MESSAGE_HANDLERS) Object.assign(projected, { [key]: handlers[key] });
	}
	if (meta?.filePath && meta.isFileTool) projected.onOpenFilePanel = handlers.onOpenFilePanel;
	if (meta?.subagentNarratorId ?? meta?.awaitAgentNarratorId ?? meta?.sendTargetNarratorId) {
		projected.onViewSubagentSession = handlers.onViewSubagentSession;
	}
	if (meta?.subagentNarratorId && !meta.isTerminal) {
		if (meta.isBackground) projected.onCancelBackgroundTask = handlers.onCancelBackgroundTask;
		else projected.onDetachSubagent = handlers.onDetachSubagent;
	}
	return projected;
}

/** Preserve the selection entry's primary alias, but not a retry's last-wins tool alias. */
function rowSelectionIndex(
	identity: AdapterTraceRowIdentity | undefined,
	index: SelectionIndex,
): SelectionIndex {
	if (!identity?.toolUseId) return index;
	const entry = index.byBlockId.get(
		makeMessageBlockSelectionId(identity.messageId, identity.blockIndex),
	);
	if (!entry) return index;
	return { entries: [], byBlockId: new Map([[`tc-${identity.toolUseId}`, entry]]) };
}

function projectRow(
	item: VListItem,
	row: MeasuredTraceRow,
	selectionIndex: VListTraceBindingsOptions["selectionIndex"],
	toolMetaIndex: Map<string, VListToolMeta>,
	rowHandlers: VListRowHandlers | undefined,
): RowProjection {
	const source = (
		item.spec.data as { items?: Array<{ identity?: AdapterTraceRowIdentity }> } | null
	)?.items?.[row.itemIndex];
	// Even an explicitly missing identity is authoritative (a row became id-less).
	// The measured passthrough is merely a fallback for older/non-adapter sources.
	const adapterIdentity = source && "identity" in source ? source.identity : row.identity;
	const card = resolveTraceRowCardData(item, row.itemIndex);
	const toolUseId =
		adapterIdentity?.toolUseId ?? (typeof card.toolUseId === "string" ? card.toolUseId : undefined);
	const meta = toolUseId ? toolMetaIndex.get(toolUseId) : undefined;
	const toolMeta = meta ? { ...meta } : undefined;
	const identity =
		selectionIndex && TRACE_ROW_INTERACTION_KINDS.has(item.spec.kind)
			? resolveTraceRowIdentity(
					{ ...row, identity: adapterIdentity },
					rowSelectionIndex(adapterIdentity, selectionIndex),
					toolMetaIndex,
				)
			: null;
	// Never retain mutable input arrays or either document-wide index in a binding.
	if (identity?.blockIndices) identity.blockIndices = [...identity.blockIndices];
	const detailRef =
		adapterIdentity?.toolDetailRef ?? (card.toolDetailRef as ToolCallDetailRef | undefined);
	const toolDetailRef = detailRef
		? {
				toolCallId: detailRef.toolCallId,
				messageId: detailRef.messageId,
				executionAttempt: detailRef.executionAttempt,
			}
		: undefined;
	return {
		identity,
		toolMeta,
		toolDetailRef,
		handlers: projectHandlers(identity, toolMeta, rowHandlers),
	};
}

/** These closures retain only one group's small semantic snapshots and actual functions. */
function bindGroup(narratorId: string, rows: Map<string, BoundRow>): TraceGroupBinding {
	return {
		rowInteraction: (row, rowBody) => {
			const projected = rows.get(row.key);
			if (!projected?.identity || !projected.actions) return null;
			const { identity, actions, handlers, toolDetailRef } = projected;
			return (
				<MessageContextMenuCtx.Provider value={actions}>
					<TraceRowInteraction
						identity={identity}
						actions={actions}
						narratorId={narratorId}
						toolDetailRef={toolDetailRef}
						onViewSubagentSession={handlers.onViewSubagentSession}
						onDetachSubagent={handlers.onDetachSubagent}
						onCancelBackgroundTask={handlers.onCancelBackgroundTask}
						onOpenFilePanel={handlers.onOpenFilePanel}
					>
						{rowBody}
					</TraceRowInteraction>
				</MessageContextMenuCtx.Provider>
			);
		},
		resolveRowToolActions: (rowKey) => rows.get(rowKey)?.toolActions,
	};
}

/** Rebuild projections from current indexes; reuse only groups whose dispatch semantics agree. */
export function useVListTraceBindings({
	narratorId,
	renderItems,
	selectionIndex,
	rowToolMetaIndex,
	rowHandlers,
}: VListTraceBindingsOptions): Map<string, TraceGroupBinding> {
	const cache = useRef<{ narratorId: string; groups: Map<string, BoundGroup> } | null>(null);
	return useMemo(() => {
		const previous = cache.current?.narratorId === narratorId ? cache.current.groups : undefined;
		const groups = new Map<string, BoundGroup>();
		const bindings = new Map<string, TraceGroupBinding>();
		for (const item of renderItems) {
			if (!item || !TRACE_KINDS.has(item.spec.kind)) continue;
			const oldGroup = previous?.get(item.spec.key);
			const rows = new Map<string, BoundRow>();
			// Include collapsed/closing rows too: their menu still surrounds the retained card.
			for (const row of (item.measured as MeasuredCollapsibleTrace).rows ?? []) {
				const projection = projectRow(item, row, selectionIndex, rowToolMetaIndex, rowHandlers);
				const oldRow = oldGroup?.rows.get(row.key);
				rows.set(
					row.key,
					oldRow && sameProjection(oldRow, projection)
						? oldRow
						: {
								...projection,
								actions: projection.identity
									? buildRowCtxActions(projection.identity, projection.handlers)
									: undefined,
								toolActions: projection.toolMeta
									? buildRowToolActions(projection.toolMeta, projection.handlers)
									: undefined,
							},
				);
			}
			const unchanged =
				oldGroup &&
				oldGroup.rows.size === rows.size &&
				[...rows].every(([key, row]) => oldGroup.rows.get(key) === row);
			const group = unchanged ? oldGroup : { rows, binding: bindGroup(narratorId, rows) };
			groups.set(item.spec.key, group);
			bindings.set(item.spec.key, group.binding);
		}
		// Replace, never merge: deletion, trimming and an LOD change release old groups/rows.
		cache.current = { narratorId, groups };
		return bindings;
	}, [narratorId, renderItems, selectionIndex, rowToolMetaIndex, rowHandlers]);
}
