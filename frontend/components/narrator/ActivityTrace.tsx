import { IconBrain, IconTool } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleTrace, type CollapsibleTraceItem } from "./CollapsibleTrace";
import type { ToolRunItem } from "./message-segments";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";
import { parseReasoningSegments } from "./reasoning-segments";
import { getCategory, getCategoryColor, getCategoryIcon, getSummary } from "./ToolCallCard";

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
}

/** One tool call folded into the trace. */
export interface ActivityToolInput {
	kind: "tool";
	msg: NarratorMsg;
	blockIndex: number;
	tc: ToolRunItem["tc"];
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

export const ActivityTrace = memo(function ActivityTrace({
	items,
	runKey,
	streaming,
	collapsed,
}: {
	items: ActivityInput[];
	/** Stable key base (first source message id) for persistence. */
	runKey: string;
	/** True while this run is streaming — shimmer the latest live row. */
	streaming?: boolean;
	/** L1 starts with the whole activity trace collapsed; L2 shows its rows. */
	collapsed?: boolean;
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
					: `r-${item.msg.id}-${item.blockIndex}`;
			break;
		}
	}

	const toolCount = items.filter((item) => item.kind === "tool").length;
	let reasoningCount = 0;

	const traceItems: CollapsibleTraceItem[] = items.flatMap((item) => {
		if (item.kind === "reasoning") {
			const text = (item.block.text as string) ?? (item.block.thinking as string) ?? "";
			const blockKey = `r-${item.msg.id}-${item.blockIndex}`;
			const titles = reasoningTitles(text);
			reasoningCount += titles.length;
			return titles.map((title, titleIndex) => ({
				key: `${blockKey}-step-${titleIndex}`,
				icon: <IconBrain size={9} />,
				iconColor: "grape",
				title,
				body: null,
				shimmer: blockKey === shimmerKey && titleIndex === titles.length - 1,
			}));
		}
		const cat = getCategory(item.tc.toolName, item.tc.inputJson);
		const Icon = getCategoryIcon(cat, item.tc.toolName);
		const key = item.tc.toolUseId ?? `t-${item.msg.id}-${item.blockIndex}`;
		return {
			key,
			icon: <Icon size={9} />,
			iconColor: getCategoryColor(cat),
			title: toolTitle(item.tc),
			body: null,
			shimmer: key === shimmerKey,
		};
	});

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
		/>
	);
});
