/**
 * The team page's frame (the redesign R): the header, 「等你处理」 when anything waits, then two
 * columns: the coordinator's conversation on the left (about 60%) and the right column (about
 * 40%) with its 「工作 | 动态」 switch. Narrow frames (a phone, or a desktop window whose sidebar
 * leaves little room) show 「对话 | 工作 (N)」 tabs instead; the work tab keeps the same switch.
 *
 * The layout follows the frame's own width, not the viewport's (the app sidebar takes some). The
 * conversation sits at ONE place in the React tree in every layout; only CSS and the tab bar
 * change around it, so a resize never remounts the session view (which would reload it and lose
 * its scroll position). An overlay (the starting state's prompt) can sit over the conversation's
 * empty message area without covering its header or composer.
 *
 * Layout only: the page fills the slots, so the browser fixture can render the frame without a
 * live session.
 */
import { NarratorPanelVisibilityProvider } from "@frontend/components/narrator/narrator-panel-visibility";
import { Box, Group, ScrollArea, SegmentedControl, Stack, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TeamPhoneTab, teamWorkspaceLayout } from "./team-page-model";
import { TABULAR } from "./team-page-ui";

export type SideTab = "work" | "activity";

export function TeamWorkspace({
	header,
	attention,
	conversation,
	conversationOverlay,
	work,
	activity,
	openCount,
	focusConversation = 0,
	initialTab = "conversation",
	onLayout,
}: {
	header: (layout: "split" | "tabs") => ReactNode;
	attention: (layout: "split" | "tabs") => ReactNode;
	conversation: ReactNode;
	/** Drawn over the conversation's message area (the starting state). */
	conversationOverlay?: ReactNode;
	work: ReactNode;
	activity: ReactNode;
	/** Unfinished work items, for 「工作 (N)」 and 「N 项未完成」. */
	openCount: number;
	/** Bumped to bring the conversation into view (and focus its composer). */
	focusConversation?: number;
	initialTab?: TeamPhoneTab;
	onLayout?: (layout: "split" | "tabs") => void;
}) {
	const { t } = useTranslation("projects");
	const { ref, width } = useElementSize();
	const measured = width > 0;
	const layout = measured ? teamWorkspaceLayout(width) : "split";
	const tabs = measured && layout === "tabs";
	const [tab, setTab] = useState<TeamPhoneTab>(initialTab);
	const [side, setSide] = useState<SideTab>("work");
	const conversationRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (measured) onLayout?.(layout);
	}, [measured, layout, onLayout]);

	// Bring the conversation forward, then focus its composer once it is shown (after the tab
	// switch has rendered, not in the same frame).
	const [focusWanted, setFocusWanted] = useState(0);
	useEffect(() => {
		if (!focusConversation) return;
		setTab("conversation");
		setFocusWanted(focusConversation);
	}, [focusConversation]);
	useEffect(() => {
		if (!focusWanted || (tabs && tab !== "conversation")) return;
		const frame = requestAnimationFrame(() => {
			const element = conversationRef.current;
			if (!element) return;
			element.scrollIntoView({ block: "nearest" });
			element.querySelector<HTMLElement>("textarea, [contenteditable=true]")?.focus();
			setFocusWanted(0);
		});
		return () => cancelAnimationFrame(frame);
	}, [focusWanted, tabs, tab]);

	const conversationShown = !tabs || tab === "conversation";
	const sideShown = !tabs || tab === "work";

	const sideSwitch = (
		<Group justify="space-between" wrap="nowrap" px="sm" py={8}>
			<SegmentedControl
				size="xs"
				value={side}
				onChange={(value) => setSide(value as SideTab)}
				data={[
					{ value: "work", label: t("teams.page.work.work") },
					{ value: "activity", label: t("teams.page.work.activity") },
				]}
				data-testid="team-side-switch"
			/>
			{openCount > 0 && (
				<Text size="xs" c="dimmed" style={TABULAR} data-testid="team-open-count">
					{t("teams.page.work.openCount", { count: openCount })}
				</Text>
			)}
		</Group>
	);

	return (
		<Stack
			ref={ref}
			gap={0}
			h="100%"
			style={{ minWidth: 0, visibility: measured ? undefined : "hidden" }}
			data-testid="team-workspace"
			data-layout={measured ? layout : "measuring"}
		>
			{header(layout)}
			{attention(layout)}
			{tabs && (
				<Box px="sm" pt="sm">
					<SegmentedControl
						fullWidth
						value={tab}
						onChange={(value) => setTab(value as TeamPhoneTab)}
						data={[
							{ value: "conversation", label: t("teams.tabs.conversation") },
							{
								value: "work",
								label: t("teams.page.work.phoneWork", { count: openCount }),
							},
						]}
						data-testid="team-phone-tabs"
					/>
				</Box>
			)}
			<Box
				style={{
					flex: 1,
					minHeight: 0,
					display: "flex",
					alignItems: "stretch",
					paddingTop: tabs ? undefined : "var(--mantine-spacing-xs)",
				}}
			>
				<Box
					ref={conversationRef}
					style={{
						display: conversationShown ? undefined : "none",
						flex: tabs ? 1 : "3 1 0",
						minWidth: 0,
						minHeight: 0,
						position: "relative",
					}}
					data-testid="team-conversation"
				>
					{/* Hidden but mounted: the session stops what only a visible panel needs. */}
					<NarratorPanelVisibilityProvider value={conversationShown}>
						{conversation}
					</NarratorPanelVisibilityProvider>
					{conversationOverlay}
				</Box>
				<Stack
					gap={0}
					style={{
						display: sideShown ? undefined : "none",
						flex: tabs ? 1 : "2 1 0",
						minWidth: tabs ? 0 : 320,
						maxWidth: tabs ? undefined : 560,
						minHeight: 0,
						borderLeft: tabs ? undefined : "1px solid var(--mantine-color-default-border)",
					}}
					data-testid="team-side"
				>
					{sideSwitch}
					<ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
						<Box px={6} pb="md">
							{side === "work" ? work : activity}
						</Box>
					</ScrollArea>
				</Stack>
			</Box>
		</Stack>
	);
}
