import { Group, Text, ThemeIcon } from "@mantine/core";
import { IconTool } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleTrace } from "./CollapsibleTrace";
import type { ToolRunItem } from "./message-segments";
import { getCategory, getCategoryColor, getCategoryIcon, getSummary } from "./ToolCallCard";

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
}: {
	items: ToolRunItem[];
	runKey: string;
	narratorId?: string;
}) {
	const { t } = useTranslation("narrator");
	// Shimmer the last active tool row (the one currently streaming / running).
	const lastActiveIdx = (() => {
		for (let i = items.length - 1; i >= 0; i--) {
			if (isToolActive(items[i])) return i;
		}
		return -1;
	})();

	return (
		<CollapsibleTrace
			items={items.map((item, i) => {
				const cat = getCategory(item.tc.toolName, item.tc.inputJson);
				const Icon = getCategoryIcon(cat, item.tc.toolName);
				return {
					key: item.tc.toolUseId ?? `${runKey}-row-${i}`,
					icon: <Icon size={9} />,
					iconColor: getCategoryColor(cat),
					title: displaySummary(item),
					body: null,
					shimmer: i === lastActiveIdx,
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
