/**
 * The team page's frame (docs/PROJECT_TEAMS-PLAN.md §二.11; P4): the project's teams on the
 * left, the coordinator's conversation in the middle, the board and the activity on the right,
 * the top bar above. On a narrow screen the three become tabs (conversation / board /
 * activity) and the teams list moves out of the way (the top bar's back link leads to the
 * project, which lists them).
 *
 * Layout only: the route fills the slots, so the browser fixture can render the frame without a
 * live session.
 */
import { Box, Group, ScrollArea, SegmentedControl, Stack, Tabs } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { TEAM_PAGE_TABS, type TeamPageTab } from "./team-page-model";

/** Three columns from this width up; tabs below it. */
export const TEAM_WORKSPACE_WIDE_QUERY = "(min-width: 62em)";

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
	const wide = useMediaQuery(TEAM_WORKSPACE_WIDE_QUERY, true, { getInitialValueInEffect: false });
	const [tab, setTab] = useState<TeamPageTab>(initialTab);
	const [side, setSide] = useState<SideTab>(initialTab === "activity" ? "activity" : "board");

	if (!wide)
		return (
			<Stack gap={0} h="100%" data-testid="team-workspace" data-layout="tabs">
				{topBar}
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
						<Box h="100%" style={{ minHeight: 0 }}>
							{conversation}
						</Box>
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
			</Stack>
		);

	return (
		<Stack gap={0} h="100%" data-testid="team-workspace" data-layout="columns">
			{topBar}
			<Group gap={0} wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
				<ScrollArea
					w={232}
					type="auto"
					style={{ flexShrink: 0, borderRight: "1px solid var(--mantine-color-default-border)" }}
				>
					<Box p="sm">{teams}</Box>
				</ScrollArea>
				<Box style={{ flex: 1, minWidth: 0, minHeight: 0 }} data-testid="team-conversation">
					{conversation}
				</Box>
				<Stack
					gap={0}
					w={380}
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
		</Stack>
	);
}
