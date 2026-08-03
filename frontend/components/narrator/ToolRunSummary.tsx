import { Group, Text, ThemeIcon } from "@mantine/core";
import { IconTool } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleTrace, type CollapsibleTraceRowContext } from "./CollapsibleTrace";
import type { ToolRunItem } from "./message-segments";
import {
	getCategory,
	getCategoryColor,
	getCategoryIcon,
	getSummary,
	ToolTimingArea,
} from "./ToolCallCard";
import { isSelectionSubagentTool, toolTraceRowIdentity } from "./trace-row-identity";
import {
	buildTraceRowActions,
	type TraceRowHandlers,
	type TraceRowSubagentHandlers,
} from "./trace-row-menu";

/** Max tool rows visible before folding the rest behind a "show earlier" toggle. */
const MAX_VISIBLE_ROWS = 10;

function displaySummary(item: ToolRunItem): string {
	const tc = item.tc;
	const raw = getSummary(tc.toolName, tc.inputJson, tc._metadata);
	const name = tc.toolName === "Task" ? "Agent" : tc.toolName;
	const text = raw ? `${name} · ${raw}` : name;
	return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** True when this tool is mid-flight (streaming / running / pending). */
function isToolActive(item: ToolRunItem): boolean {
	const s = item.tc.status;
	return s === "running" || s === "pending" || s === "initializing";
}

// ---------------------------------------------------------------------------
// ToolRunSummary — L3 rendering of a whole tool-run: a bare (frameless) trace
// built on the shared CollapsibleTrace, so it looks exactly like the reasoning
// trace. The latest active tool row shimmers while streaming.
// ---------------------------------------------------------------------------
export const ToolRunSummary = memo(function ToolRunSummary({
	items,
	runKey,
	narratorId,
	rowHandlers,
	subagentHandlers,
}: {
	items: ToolRunItem[];
	/** Stable key base for row keys + cross-remount expand persistence. */
	runKey: string;
	/** Owning narrator — enables the per-row tool-call inspector. */
	narratorId?: string;
	/** Panel handlers behind each row's message actions; absent → no such items. */
	rowHandlers?: TraceRowHandlers;
	/** Subagent lifecycle handlers (open session / detach / cancel). */
	subagentHandlers?: TraceRowSubagentHandlers;
}) {
	const { t } = useTranslation("narrator");
	// Shimmer the last active tool row (the one currently streaming / running).
	const lastActiveIdx = (() => {
		for (let i = items.length - 1; i >= 0; i--) {
			if (isToolActive(items[i])) return i;
		}
		return -1;
	})();

	const rowContext: CollapsibleTraceRowContext | undefined =
		narratorId || subagentHandlers ? { narratorId, ...subagentHandlers } : undefined;

	return (
		<CollapsibleTrace
			items={items.map((item, i) => {
				const cat = getCategory(item.tc.toolName, item.tc.inputJson);
				const Icon = getCategoryIcon(cat, item.tc.toolName);
				// Streaming output has no committed message, so it stays non-selectable.
				// The tc-/sa- prefix must match the selection entry's PRIMARY id, whose
				// rule is narrower than ToolRunItem.isSubagent — see isSelectionSubagentTool.
				const messageId = item.msg?.id;
				const identity =
					messageId && messageId !== "__streaming__"
						? (toolTraceRowIdentity(
								messageId,
								item.blockIndex,
								item.tc,
								isSelectionSubagentTool(item.tc.toolName, item.children.length > 0),
							) ?? undefined)
						: undefined;
				const actions =
					identity && rowHandlers && messageId
						? buildTraceRowActions(
								{ messageId, messageUuid: item.msg.messageUuid ?? null },
								rowHandlers,
							)
						: undefined;
				return {
					key: item.tc.toolUseId ?? `${runKey}-row-${i}`,
					icon: <Icon size={9} />,
					iconColor: getCategoryColor(cat),
					title: displaySummary(item),
					body: null,
					shimmer: i === lastActiveIdx,
					// Outcome + duration, matching the activity fold and the subagent card's
					// recent-call rows. Height-neutral (see CollapsibleTrace's row).
					status: item.tc.status,
					trailing: <ToolTimingArea toolCall={item.tc} isActive={isToolActive(item)} />,
					identity,
					actions,
				};
			})}
			headerIcon={<IconTool size={10} />}
			headerColor="gray"
			headerLabel={t("toolCalls")}
			headerCount={t("toolCallsCount", { count: items.length })}
			maxVisible={MAX_VISIBLE_ROWS}
			persistKeyBase={runKey}
			showEarlierLabel={(n) => t("reasoningShowEarlier", { count: n })}
			hideEarlierLabel={t("reasoningHideEarlier")}
			rowContext={rowContext}
		/>
	);
});

// ---------------------------------------------------------------------------
// ToolRunCountLine — L2: a single bare line "🔧 Tool calls · N".
// ---------------------------------------------------------------------------
export const ToolRunCountLine = memo(function ToolRunCountLine({
	items,
}: {
	items: ToolRunItem[];
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group gap={6} wrap="nowrap" align="center" py={2} style={{ userSelect: "none" }}>
			<ThemeIcon size={16} variant="light" color="gray" radius="sm">
				<IconTool size={10} />
			</ThemeIcon>
			<Text size="xs" c="dimmed" fw={500}>
				{t("toolCalls")}
			</Text>
			<Text size="xs" c="dimmed" style={{ opacity: 0.5 }}>
				{t("toolCallsCount", { count: items.length })}
			</Text>
		</Group>
	);
});
