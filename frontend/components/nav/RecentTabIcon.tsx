import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { useNarratorIsOptimizingPrompt } from "@frontend/hooks/usePromptOptimizeTask";
import { Box } from "@mantine/core";
import { IconBrain, IconClock, IconFolder, IconPencil, IconRobot } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { NarratorStatusIcon } from "./NarratorStatusIcon";
import { getNarratorStatusIconColor } from "./narrator-status-icon-logic";

type RecentTabIconSource = Pick<
	RecentTab,
	| "id"
	| "type"
	| "status"
	| "substatus"
	| "activeBackgroundWorkCount"
	| "activeBackgroundTaskCount"
	| "hasDraft"
	| "isScheduled"
>;

/** The same session/project icon for RecentTabs and communication cards; no duplicate status rules. */
export function RecentTabIcon({
	tab,
	size,
	iconColor = getNarratorStatusIconColor(tab),
}: {
	tab: RecentTabIconSource;
	size: number;
	iconColor?: string;
}) {
	// Read from the optimize registry, not from tab props: the request outlives the
	// composer that started it, so the sidebar has to learn about it from the same
	// place the request lives. `RecentTabIcon` is a component (not a render helper) so a
	// hook is legal here even though it is called per row.
	const narratorId = tab.type === "narrator" ? tab.id : null;
	const isOptimizingPrompt = useNarratorIsOptimizingPrompt(narratorId);

	// The narrator bubble is shared verbatim with the narrator list page — see
	// `NarratorStatusIcon`. It owns its corner markers and the centre shape overlay.
	if (tab.type === "narrator") {
		return (
			<NarratorStatusIcon
				size={size}
				status={tab.status}
				substatus={tab.substatus}
				activeBackgroundWorkCount={tab.activeBackgroundWorkCount}
				activeBackgroundTaskCount={tab.activeBackgroundTaskCount}
				hasDraft={tab.hasDraft}
				isScheduled={tab.isScheduled}
				isOptimizingPrompt={isOptimizingPrompt}
			/>
		);
	}

	let icon: ReactNode;
	if (tab.type === "project") icon = <IconFolder size={size} />;
	else icon = <IconRobot size={size} color={iconColor} />;

	// Corner markers remain for subagent rows. The centre state SHAPE (tick / shield /
	// alert) does not: it is knocked out in white and needs the narrator bubble's solid
	// body behind it — the robot glyph is a Tabler OUTLINE icon (stroke only, no closed
	// shape), so a white glyph there would land on the page background and disappear.
	const canShowMarker = tab.type === "subagent";
	const showDraft = !!tab.hasDraft && canShowMarker;
	const showReasoning = !!tab.substatus?.includes("reasoning") && canShowMarker;
	const showScheduled = !!tab.isScheduled && canShowMarker;
	if (!showDraft && !showReasoning && !showScheduled) return icon;

	return (
		<Box component="span" pos="relative" style={{ display: "inline-flex", lineHeight: 0 }}>
			{icon}
			{showScheduled && (
				<Box
					component="span"
					style={{
						position: "absolute",
						right: -4,
						bottom: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-indigo-6)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-white)",
						pointerEvents: "none",
					}}
				>
					<IconClock size={7} stroke={2.5} />
				</Box>
			)}
			{showReasoning && (
				<Box
					component="span"
					style={{
						position: "absolute",
						left: -4,
						top: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-grape-light)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-grape-light-color)",
						pointerEvents: "none",
					}}
				>
					<IconBrain size={7} stroke={2.5} />
				</Box>
			)}
			{showDraft && (
				<Box
					component="span"
					style={{
						position: "absolute",
						right: -4,
						top: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-yellow-6)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-dark-9)",
						pointerEvents: "none",
					}}
				>
					<IconPencil size={7} stroke={2.5} />
				</Box>
			)}
		</Box>
	);
}
