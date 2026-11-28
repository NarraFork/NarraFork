import { Group, Text, ThemeIcon } from "@mantine/core";
import {
	BARE_ROW_GAP,
	BARE_ROW_ICON,
	BARE_ROW_PADDING_Y,
} from "@shared/pretext-layout/row-metrics";
import { TRACE_SHIMMER_CLASS } from "@shared/tool-shimmer";
import { useTranslation } from "react-i18next";
import { useTraceRowShimmerKind } from "../../hooks/useTraceRowShimmerKind";
import { splitTraceRowTitle } from "../../lib/trace-row-title";
import { categoryIcon } from "../narrator/tool-call/tool-category-icons";
import {
	getCategory,
	getCategoryColor,
	subagentRecentCallSummary,
	traceRowTitle,
} from "../narrator/tool-call/tool-display";
import {
	resolveToolRowStatusMark,
	TRACE_ROW_STATUS_SLOT_STYLE,
	TraceRowStatusGlyph,
} from "../narrator/tool-call/trace-row-status";
import type { ActivityToolRow } from "./dashboard-activity";

/** Low-LOD trace chrome, without a disclosure control on this read-only surface. */
export function ActivityToolCallRow({ tool }: { tool: ActivityToolRow }) {
	const { t } = useTranslation("narrator");
	const mark = resolveToolRowStatusMark(tool.status);
	const shimmerKind = useTraceRowShimmerKind(tool);
	const shimmerLabel = shimmerKind ? t(`traceRowState.${shimmerKind}`) : undefined;
	const label = traceRowTitle(
		tool.toolName,
		subagentRecentCallSummary(tool.toolName, tool.inputSummary ?? null),
	);
	const split = splitTraceRowTitle(label, tool.toolName);
	const category = getCategory(tool.toolName, tool.inputSummary);
	const Icon = categoryIcon(category, tool.toolName);
	return (
		<Group
			gap={BARE_ROW_GAP}
			py={BARE_ROW_PADDING_Y}
			wrap="nowrap"
			style={{ minWidth: 0 }}
			data-activity-tool-row
			aria-label={shimmerLabel ? `${label} — ${shimmerLabel}` : undefined}
			title={shimmerLabel}
		>
			<ThemeIcon
				size={BARE_ROW_ICON}
				variant="light"
				color={getCategoryColor(category)}
				radius="sm"
				style={{ flexShrink: 0 }}
				data-trace-row-chip
			>
				<Icon size={9} />
			</ThemeIcon>
			<Text
				size="xs"
				c="dimmed"
				ff="monospace"
				truncate
				className={shimmerKind ? TRACE_SHIMMER_CLASS[shimmerKind] : undefined}
				style={{ flex: "0 1 auto", minWidth: 0 }}
			>
				{split ? (
					<>
						<span style={{ fontWeight: 600, marginRight: split.detail ? BARE_ROW_GAP : undefined }}>
							{split.name}
						</span>
						{split.detail || null}
					</>
				) : (
					label
				)}
			</Text>
			{mark ? (
				<span data-activity-tool-status style={TRACE_ROW_STATUS_SLOT_STYLE}>
					<TraceRowStatusGlyph
						mark={mark}
						labels={{
							[mark]: t(mark === "reflecting" ? "status_reflecting" : `traceRowMark.${mark}`),
						}}
					/>
				</span>
			) : null}
			<span style={{ flex: 1, minWidth: 0 }} />
		</Group>
	);
}
