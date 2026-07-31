import { IconBrain, IconTool } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import {
	CollapsibleTrace,
	type CollapsibleTraceItem,
	type CollapsibleTraceRowContext,
} from "./CollapsibleTrace";
import { filterChildrenByToolUse, type ToolRunItem } from "./message-segments";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";
import { parseReasoningSegments } from "./reasoning-segments";
import { getCategory, getCategoryColor, getCategoryIcon, getSummary } from "./ToolCallCard";
import {
	isSelectionSubagentTool,
	reasoningTraceRowIdentity,
	type TraceRowIdentity,
	toolTraceRowIdentity,
} from "./trace-row-identity";
import {
	buildTraceRowActions,
	type TraceRowHandlers,
	type TraceRowSubagentHandlers,
} from "./trace-row-menu";

// ---------------------------------------------------------------------------
// ActivityTrace — the unified L1/L2 fold. A continuous run of assistant activity
// (reasoning blocks + tool calls, from possibly several adjacent messages)
// merges into ONE shared CollapsibleTrace instead of alternating reasoning/tool
// rows. L1 collapses the whole trace; L2 keeps its rows visible. Built on
// CollapsibleTrace so it looks
// identical to the reasoning trace; item-level keys (toolUseId /
// msg.id+blockIndex) stay stable for future animated LOD transitions.
// ---------------------------------------------------------------------------

/** One reasoning block folded into the trace. */
export interface ActivityReasoningInput {
	kind: "reasoning";
	msg: NarratorMsg;
	blockIndex: number;
	block: ContentBlock;
	/**
	 * Hand-off-stable key base for this reasoning RUN, assigned by
	 * `groupRenderUnits` as an ordinal within the activity unit.
	 *
	 * Row keys must not derive from `msg.id`: a live run owns the synthetic
	 * `__streaming__` id and inherits a real one when the turn persists, so an
	 * id-derived key changes at the hand-off and React rebuilds a row whose content
	 * only settled — the icon/frame jump this whole fold exists to remove. The
	 * ordinal is identical on both sides, so the row keeps its DOM node.
	 */
	stableKeyBase?: string;
	/** This block's offset inside its run (rows of one run share `stableKeyBase`). */
	stableKeyOffset?: number;
}

/** One tool call folded into the trace. */
export interface ActivityToolInput {
	kind: "tool";
	msg: NarratorMsg;
	blockIndex: number;
	tc: ToolRunItem["tc"];
	/**
	 * Disambiguator for a REPEATED tool-use id within one unit.
	 *
	 * A provider retry can put the same id in two persisted messages, which are two
	 * real calls the reader must both see. Their row keys would otherwise be identical
	 * (`tool-<id>`) and, since trace rows are absolutely positioned, they would paint
	 * on top of each other. Absent for the overwhelmingly common single-occurrence
	 * case, so normal rows keep their hand-off-stable key unchanged.
	 */
	dedupeSuffix?: number;
}

export type ActivityInput = ActivityReasoningInput | ActivityToolInput;

const MAX_VISIBLE_ROWS = 10;

function truncateTitle(raw: string): string {
	return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

function reasoningTitles(text: string): string[] {
	const segments = parseReasoningSegments(text);
	if (segments.length === 0) {
		const firstLine =
			text
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? "";
		return [truncateTitle(firstLine)];
	}
	return segments.map((segment) => {
		const firstBodyLine = segment.body.split("\n").find((line) => line.trim().length > 0) ?? "";
		return truncateTitle(segment.title ?? firstBodyLine.trim());
	});
}

function toolTitle(tc: ToolRunItem["tc"]): string {
	const raw = getSummary(tc.toolName, tc.inputJson, tc._metadata);
	const name = tc.toolName === "Task" ? "Agent" : tc.toolName;
	const text = raw ? `${name} · ${raw}` : name;
	return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function toolIsActive(tc: ToolRunItem["tc"]): boolean {
	const s = tc.status;
	return s === "running" || s === "pending" || s === "initializing";
}

/**
 * Hand-off-stable key for one folded reasoning BLOCK.
 *
 * Prefers the run ordinal `groupRenderUnits` assigned (see
 * `ActivityReasoningInput.stableKeyBase`), which survives the live→persisted
 * transition. Falls back to the message-derived form for callers that build
 * `ActivityInput`s without going through the grouper (cross-chunk overrides).
 */
function reasoningBlockKey(item: ActivityReasoningInput): string {
	if (item.stableKeyBase) return `r-${item.stableKeyBase}-${item.stableKeyOffset ?? 0}`;
	return `r-${item.msg.id}-${item.blockIndex}`;
}

/**
 * Row key for one folded TOOL item.
 *
 * Exported because this derivation must not drift from the vlist adapter's
 * (`toolItemKey` + `dedupeSuffix` in segment-adapter): both render the same fold, and a
 * divergence would mean one path de-duplicates while the other overlaps. Pure, so the
 * uniqueness invariant can assert it without mounting the component.
 */
export function activityToolRowKey(item: ActivityToolInput): string {
	const baseKey = item.tc.toolUseId ?? `t-${item.msg.id}-${item.blockIndex}`;
	// A retry's repeated id gets a suffix so the two rows do not overlap.
	return item.dedupeSuffix ? `${baseKey}#${item.dedupeSuffix}` : baseKey;
}

/**
 * Every row key the chunked trace will render for `items`, in order.
 *
 * The component derives these inline while building its React nodes; this mirrors that
 * derivation so the invariant test can check the CHUNKED path too. Kept beside the
 * component (rather than in the test) so a change to one is visibly a change to both.
 */
export function activityTraceRowKeys(items: ActivityInput[]): string[] {
	return items.flatMap((item) => {
		if (item.kind === "reasoning") {
			const text = (item.block.text as string) ?? (item.block.thinking as string) ?? "";
			const blockKey = reasoningBlockKey(item);
			return reasoningTitles(text).map((_title, titleIndex) => `${blockKey}-step-${titleIndex}`);
		}
		return [activityToolRowKey(item)];
	});
}

export const ActivityTrace = memo(function ActivityTrace({
	items,
	runKey,
	streaming,
	collapsed,
	narratorId,
	rowHandlers,
	subagentHandlers,
}: {
	items: ActivityInput[];
	/** Stable key base (first source message id) for persistence. */
	runKey: string;
	/** True while this run is streaming — shimmer the latest live row. */
	streaming?: boolean;
	/** L1 starts with the whole activity trace collapsed; L2 shows its rows. */
	collapsed?: boolean;
	/** Owning narrator — enables the per-row tool-call inspector. */
	narratorId?: string;
	/** Panel handlers behind each row's message actions; absent → no such items. */
	rowHandlers?: TraceRowHandlers;
	/** Subagent lifecycle handlers (open session / detach / cancel). */
	subagentHandlers?: TraceRowSubagentHandlers;
}) {
	const { t } = useTranslation("narrator");

	if (items.length === 0) return null;

	// Shimmer: the last row that is still live. While streaming, that's the last
	// item of the streaming message (reasoning growing / latest tool); otherwise
	// the last active tool.
	let shimmerKey: string | null = null;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		const isLive =
			item.kind === "tool" &&
			(toolIsActive(item.tc) || (streaming && item.msg.id === "__streaming__"));
		const isStreamingReasoning =
			item.kind === "reasoning" && streaming && item.msg.id === "__streaming__";
		if (isLive || isStreamingReasoning) {
			shimmerKey =
				item.kind === "tool"
					? (item.tc.toolUseId ?? `t-${item.msg.id}-${item.blockIndex}`)
					: reasoningBlockKey(item);
			break;
		}
	}

	const toolCount = items.filter((item) => item.kind === "tool").length;
	let reasoningCount = 0;

	/**
	 * Resolve a folded row's selection/menu identity. Streaming output is never
	 * selectable (it has no committed message), so those rows stay plain.
	 *
	 * ⚠️ Reasoning rows MUST identify themselves by their reasoning RUN's start
	 * index, which `reasoningTraceRowIdentity` handles: this fold walks reasoning
	 * blocks one by one, while buildSelectionIndex registers only the run start.
	 * Using the row's own blockIndex would mint a blockId no selection entry
	 * matches and every selection action would silently do nothing.
	 */
	const resolveIdentity = (item: ActivityInput): TraceRowIdentity | undefined => {
		const messageId = item.msg?.id;
		if (!messageId || messageId === "__streaming__") return undefined;
		if (item.kind === "reasoning") {
			const blocks = Array.isArray(item.msg.contentJson)
				? (item.msg.contentJson as ContentBlock[])
				: undefined;
			return reasoningTraceRowIdentity(messageId, blocks, item.blockIndex);
		}
		// The tc-/sa- prefix must match the selection entry's PRIMARY id, whose rule
		// is narrower than ToolRunItem.isSubagent — see isSelectionSubagentTool.
		const hasChildren =
			filterChildrenByToolUse(item.msg.children ?? [], item.tc.toolUseId).length > 0;
		const isSubagent = isSelectionSubagentTool(item.tc.toolName, hasChildren);
		return toolTraceRowIdentity(messageId, item.blockIndex, item.tc, isSubagent) ?? undefined;
	};

	const resolveActions = (item: ActivityInput) => {
		const messageId = item.msg?.id;
		if (!messageId || !rowHandlers) return undefined;
		return buildTraceRowActions(
			{ messageId, messageUuid: item.msg.messageUuid ?? null },
			rowHandlers,
		);
	};

	const traceItems: CollapsibleTraceItem[] = items.flatMap((item) => {
		const identity = resolveIdentity(item);
		const actions = identity ? resolveActions(item) : undefined;
		if (item.kind === "reasoning") {
			const text = (item.block.text as string) ?? (item.block.thinking as string) ?? "";
			const blockKey = reasoningBlockKey(item);
			const titles = reasoningTitles(text);
			reasoningCount += titles.length;
			return titles.map((title, titleIndex) => ({
				key: `${blockKey}-step-${titleIndex}`,
				icon: <IconBrain size={9} />,
				iconColor: "grape",
				title,
				body: null,
				shimmer: blockKey === shimmerKey && titleIndex === titles.length - 1,
				identity,
				actions,
			}));
		}
		const cat = getCategory(item.tc.toolName, item.tc.inputJson);
		const Icon = getCategoryIcon(cat, item.tc.toolName);
		const key = activityToolRowKey(item);
		return {
			key,
			icon: <Icon size={9} />,
			iconColor: getCategoryColor(cat),
			title: toolTitle(item.tc),
			body: null,
			shimmer: key === shimmerKey,
			identity,
			actions,
		};
	});

	const rowContext: CollapsibleTraceRowContext | undefined =
		narratorId || subagentHandlers ? { narratorId, ...subagentHandlers } : undefined;

	return (
		<CollapsibleTrace
			items={traceItems}
			headerIcon={<IconTool size={10} />}
			headerColor="gray"
			headerLabel={t("activityTraceLabel")}
			headerCount={t("activityTraceCount", { reasoning: reasoningCount, tools: toolCount })}
			maxVisible={MAX_VISIBLE_ROWS}
			persistKeyBase={runKey}
			showEarlierLabel={(n) => t("reasoningShowEarlier", { count: n })}
			hideEarlierLabel={t("reasoningHideEarlier")}
			collapseItems={collapsed}
			rowContext={rowContext}
		/>
	);
});
