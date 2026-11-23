import { Group, Loader, Text } from "@mantine/core";
import { resolveToolRowStatusMark, type ToolRowStatusMark } from "@shared/tool-row-status";
import { IconBan, IconCircleX, IconClock, IconPlayerPause, IconShield } from "@tabler/icons-react";
import { subagentRecentCallSummary, traceRowTitle } from "../narrator/tool-call/tool-display";
import type { ActivityToolRow } from "./dashboard-activity";

const TOOL_MARK_SIZE = 12;

/**
 * A compact row's status glyph. Same mark rule (`@shared/tool-row-status`: success
 * unmarked, only `running` moves) and the same icons/hues as the vlist trace rows;
 * drawn here because nothing outside `vlist/` may import it statically.
 */
function ToolMarkGlyph({ mark }: { mark: ToolRowStatusMark }) {
	const props = { size: TOOL_MARK_SIZE, style: { flexShrink: 0 } } as const;
	switch (mark) {
		case "running":
			return <Loader size={10} />;
		case "queued":
			return <IconClock {...props} color="var(--mantine-color-slate-5)" />;
		case "reflecting":
			return <IconShield {...props} color="var(--mantine-color-indigo-6)" />;
		case "awaiting":
			return <IconPlayerPause {...props} color="var(--mantine-color-yellow-6)" />;
		case "failed":
			return <IconCircleX {...props} color="var(--mantine-color-red-6)" />;
		default:
			return <IconBan {...props} color="var(--mantine-color-orange-6)" />;
	}
}

/** One recent tool call: the same label and status mark as a subagent card's row. */
export function ActivityToolCallRow({ tool }: { tool: ActivityToolRow }) {
	const mark = resolveToolRowStatusMark(tool.status);
	const label = traceRowTitle(
		tool.toolName,
		subagentRecentCallSummary(tool.toolName, tool.inputSummary ?? null),
	);
	return (
		<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
			<span
				style={{
					width: TOOL_MARK_SIZE,
					height: TOOL_MARK_SIZE,
					flexShrink: 0,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				{mark ? <ToolMarkGlyph mark={mark} /> : null}
			</span>
			<Text size="xs" c={mark === "running" ? undefined : "dimmed"} ff="monospace" truncate>
				{label}
			</Text>
		</Group>
	);
}
