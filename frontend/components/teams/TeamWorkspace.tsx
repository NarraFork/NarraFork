/**
 * The team page's frame (docs/PROJECT_TEAMS-PLAN.md §二.11; P4): the project's teams on the
 * left, the coordinator's conversation in the middle, the board and the activity on the right,
 * the top bar above.
 *
 * The layout follows the frame's own width, not the viewport's (the app's sidebar takes up to
 * 480 px of it), and the conversation keeps at least {@link TEAM_CONVERSATION_MIN_WIDTH}:
 *   - room for all three → three columns;
 *   - room for the conversation and the side panel → two (the teams list leaves; the top bar's
 *     back link leads to the project, which lists them);
 *   - less → tabs (conversation / board / activity).
 *
 * Layout only: the route fills the slots, so the browser fixture can render the frame without a
 * live session.
 */
import { NarratorPanelVisibilityProvider } from "@frontend/components/narrator/narrator-panel-visibility";
import { Box, Group, ScrollArea, SegmentedControl, Stack, Tabs } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TEAM_PAGE_TABS,
	TEAM_SIDE_WIDTH,
	TEAM_TEAMS_WIDTH,
	type TeamPageTab,
	teamWorkspaceLayout,
} from "./team-page-model";

type SideTab = Exclude<TeamPageTab, "conversation">;

export function TeamWorkspace({
	topBar,
	teams,
	conversation,
	board,
	activity,
	initialTab = "conversation",
}: {
	topBar: ReactNode;
	teams: ReactNode;
	conversation: ReactNode;
	board: ReactNode;
	activity: ReactNode;
	initialTab?: TeamPageTab;
}) {
	const { t } = useTranslation("projects");
	const { ref, width } = useElementSize();
	const layout = width > 0 ? teamWorkspaceLayout(width) : null;
	const [tab, setTab] = useState<TeamPageTab>(initialTab);
	const [side, setSide] = useState<SideTab>(initialTab === "activity" ? "activity" : "board");

	let body: ReactNode = null;
	if (layout === "tabs")
		body = (
			<Tabs
				value={tab}
				onChange={(value) => value && setTab(value as TeamPageTab)}
				keepMounted
				style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
			>
				<Tabs.List grow>
					{TEAM_PAGE_TABS.map((value) => (
						<Tabs.Tab key={value} value={value} data-testid={`team-tab-${value}`}>
							{t(`teams.tabs.${value}`)}
						</Tabs.Tab>
					))}
				</Tabs.List>
				<Tabs.Panel value="conversation" style={{ flex: 1, minHeight: 0 }}>
					{/* Hidden but mounted: the session stops what only a visible panel needs. */}
					<NarratorPanelVisibilityProvider value={tab === "conversation"}>
						<Box h="100%" style={{ minHeight: 0 }} data-testid="team-conversation">
							{conversation}
						</Box>
					</NarratorPanelVisibilityProvider>
				</Tabs.Panel>
				<Tabs.Panel value="board" style={{ flex: 1, minHeight: 0 }}>
					<ScrollArea h="100%" type="auto">
						<Box p="sm">{board}</Box>
					</ScrollArea>
				</Tabs.Panel>
				<Tabs.Panel value="activity" style={{ flex: 1, minHeight: 0 }}>
					<ScrollArea h="100%" type="auto">
						<Box p="sm">{activity}</Box>
					</ScrollArea>
				</Tabs.Panel>
			</Tabs>
		);
	else if (layout)
		body = (
			<Group gap={0} wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
				{layout === "columns" && (
					<ScrollArea
						w={TEAM_TEAMS_WIDTH}
						type="auto"
						style={{ flexShrink: 0, borderRight: "1px solid var(--mantine-color-default-border)" }}
					>
						<Box p="sm">{teams}</Box>
					</ScrollArea>
				)}
				<Box style={{ flex: 1, minWidth: 0, minHeight: 0 }} data-testid="team-conversation">
					{conversation}
				</Box>
				<Stack
					gap={0}
					w={TEAM_SIDE_WIDTH}
					style={{
						flexShrink: 0,
						minHeight: 0,
						borderLeft: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<Box p="xs">
						<SegmentedControl
							fullWidth
							size="xs"
							value={side}
							onChange={(value) => setSide(value as SideTab)}
							data={[
								{ value: "board", label: t("teams.tabs.board") },
								{ value: "activity", label: t("teams.tabs.activity") },
							]}
							data-testid="team-side-switch"
						/>
					</Box>
					<ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
						<Box p="sm" pt={4}>
							{side === "board" ? board : activity}
						</Box>
					</ScrollArea>
				</Stack>
			</Group>
		);

	return (
		<Stack
			ref={ref}
			gap={0}
			h="100%"
			style={{ minWidth: 0 }}
			data-testid="team-workspace"
			data-layout={layout ?? "measuring"}
		>
			{layout && topBar}
			{body}
		</Stack>
	);
}
