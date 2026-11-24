/**
 * The team page's frame (docs/PROJECT_TEAMS-PLAN.md §二.11; P4): the project's teams on the
 * left, the coordinator's conversation in the middle, the board and the activity on the right,
 * the top bar above.
 *
 * The layout follows the frame's own width, not the viewport's (the app's sidebar takes up to
 * 480 px of it), and the conversation keeps at least `TEAM_CONVERSATION_MIN_WIDTH`:
 *   - room for all three → three columns;
 *   - room for the conversation and the side panel → two (the teams list leaves; the top bar's
 *     back link leads to the project, which lists them);
 *   - less → tabs (conversation / board / activity).
 *
 * The conversation sits at ONE place in the React tree in every layout; only CSS (display,
 * widths) and the tab bar change around it. So a tablet rotation or a sidebar resize never
 * remounts the session view (which would reload it and lose its scroll position).
 *
 * Layout only: the route fills the slots, so the browser fixture can render the frame without a
 * live session.
 */
import { NarratorPanelVisibilityProvider } from "@frontend/components/narrator/narrator-panel-visibility";
import { Box, ScrollArea, SegmentedControl, Stack, Tabs } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
	focusConversation = 0,
}: {
	topBar: ReactNode;
	teams: ReactNode;
	conversation: ReactNode;
	board: ReactNode;
	activity: ReactNode;
	initialTab?: TeamPageTab;
	/** Bumped to bring the conversation into view (and focus its composer). */
	focusConversation?: number;
}) {
	const { t } = useTranslation("projects");
	const { ref, width } = useElementSize();
	const measured = width > 0;
	const layout = measured ? teamWorkspaceLayout(width) : null;
	const tabs = layout === "tabs";
	const [tab, setTab] = useState<TeamPageTab>(initialTab);
	const [side, setSide] = useState<SideTab>(initialTab === "activity" ? "activity" : "board");
	const conversationRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!focusConversation) return;
		setTab("conversation");
		// After the tab switch has shown it.
		requestAnimationFrame(() => {
			const element = conversationRef.current;
			if (!element) return;
			element.scrollIntoView({ block: "nearest" });
			element.querySelector<HTMLElement>("textarea, [contenteditable=true]")?.focus();
		});
	}, [focusConversation]);

	const conversationShown = !tabs || tab === "conversation";
	const sideShown = !tabs || tab !== "conversation";
	const sideContent: SideTab = tabs ? (tab === "activity" ? "activity" : "board") : side;

	return (
		<Stack
			ref={ref}
			gap={0}
			h="100%"
			style={{ minWidth: 0, visibility: measured ? undefined : "hidden" }}
			data-testid="team-workspace"
			data-layout={layout ?? "measuring"}
		>
			{topBar}
			{tabs && (
				<Tabs value={tab} onChange={(value) => value && setTab(value as TeamPageTab)}>
					<Tabs.List grow>
						{TEAM_PAGE_TABS.map((value) => (
							<Tabs.Tab key={value} value={value} data-testid={`team-tab-${value}`}>
								{t(`teams.tabs.${value}`)}
							</Tabs.Tab>
						))}
					</Tabs.List>
				</Tabs>
			)}
			<Box style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch" }}>
				<ScrollArea
					w={TEAM_TEAMS_WIDTH}
					type="auto"
					style={{
						display: layout === "columns" ? undefined : "none",
						flexShrink: 0,
						borderRight: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<Box p="sm">{layout === "columns" && teams}</Box>
				</ScrollArea>
				<Box
					ref={conversationRef}
					style={{
						display: conversationShown ? undefined : "none",
						flex: 1,
						minWidth: 0,
						minHeight: 0,
					}}
					data-testid="team-conversation"
				>
					{/* Hidden but mounted: the session stops what only a visible panel needs. */}
					<NarratorPanelVisibilityProvider value={conversationShown}>
						{conversation}
					</NarratorPanelVisibilityProvider>
				</Box>
				<Stack
					gap={0}
					style={{
						display: sideShown ? undefined : "none",
						flex: tabs ? 1 : undefined,
						width: tabs ? undefined : TEAM_SIDE_WIDTH,
						flexShrink: 0,
						minWidth: 0,
						minHeight: 0,
						borderLeft: tabs ? undefined : "1px solid var(--mantine-color-default-border)",
					}}
					data-testid="team-side"
				>
					{!tabs && (
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
					)}
					<ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
						<Box p="sm" pt={tabs ? "sm" : 4}>
							{sideContent === "board" ? board : activity}
						</Box>
					</ScrollArea>
				</Stack>
			</Box>
		</Stack>
	);
}
