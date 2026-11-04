/**
 * Everything a sidebar row no longer shows inline: full title, state, working directory,
 * live counts and who else is watching.
 *
 * Rows are one line (status bubble + title). The rest is here, in two places:
 *   - `RecentTabDetailCard`: a hover card next to the row, for mouse users;
 *   - `RecentTabDetails` at the top of the row menu, for touch users, who have no hover
 *     and reach the menu with a left swipe.
 */

import {
	hasDirectorySubtitle,
	type RecentTab,
	type RecentTabViewer,
} from "@frontend/hooks/recent-tabs-utils";
import { getEffectiveNarratorDisplay, statusRegistry } from "@frontend/lib/status-registry";
import { Z } from "@frontend/lib/z-index";
import { Avatar, Box, Group, Paper, Stack, Text } from "@mantine/core";
import { IconClock, IconPencil, IconServer, IconSubtask, IconTerminal2 } from "@tabler/icons-react";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../UserAvatar";
import type { RecentTabHoverStore } from "./recent-tab-hover";

type T = (key: string, opts?: Record<string, unknown>) => string;

const MAX_VISIBLE_AVATARS = 3;
const CARD_WIDTH = 280;
const CARD_GAP = 8;
const EDGE_GAP = 8;

function ViewerAvatars({
	viewers,
	viewerCount,
}: {
	viewers: RecentTabViewer[];
	viewerCount: number;
}) {
	const visible = viewers.slice(0, MAX_VISIBLE_AVATARS);
	const overflow = Math.max(0, viewerCount - MAX_VISIBLE_AVATARS);
	const avatarStyle = {
		root: {
			border: "1.5px solid var(--mantine-color-body)",
			fontSize: 8,
			minWidth: 16,
			minHeight: 16,
		},
	};
	return (
		<Avatar.Group spacing={4}>
			{visible.map((v) => (
				<UserAvatar
					key={v.userId}
					username={v.username}
					avatarColor={v.avatarColor}
					avatarImageId={v.avatarImageId}
					userId={v.userId}
					size={16}
					radius="xl"
					showTooltip={false}
					styles={avatarStyle}
				/>
			))}
			{overflow > 0 && (
				<Avatar size={16} radius="xl" styles={avatarStyle}>
					+{overflow}
				</Avatar>
			)}
		</Avatar.Group>
	);
}

function DetailLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<Group gap={6} wrap="nowrap">
			<Box style={{ display: "flex", flexShrink: 0, opacity: 0.6 }}>{icon}</Box>
			<Text size="xs" c="dimmed">
				{children}
			</Text>
		</Group>
	);
}

/**
 * The details block itself. `compact` drops the title for the menu header, where the
 * row the user swiped is right next to it.
 */
export function RecentTabDetails({ tab, compact = false }: { tab: RecentTab; compact?: boolean }) {
	const { t } = useTranslation("common");
	const tt = t as T;
	const isSession = tab.type === "narrator" || tab.type === "subagent";
	const display = isSession
		? getEffectiveNarratorDisplay(tab.status ?? "idle", tab.substatus)
		: null;
	const viewerCount = tab.viewerCount ?? tab.viewers?.length ?? 0;
	const terminals = tab.activeTerminalCount ?? 0;
	const work = tab.activeBackgroundWorkCount ?? tab.activeBackgroundTaskCount ?? 0;
	const services = tab.activeBackgroundServiceCount ?? 0;

	return (
		<Stack gap={4} data-recent-tab-details={`${tab.type}:${tab.id}`}>
			{!compact && (
				<Text size="sm" fw={500} style={{ wordBreak: "break-word" }}>
					{tab.title}
				</Text>
			)}
			{display && (
				<Group gap={6} wrap="nowrap">
					<Box
						style={{
							width: 8,
							height: 8,
							borderRadius: "50%",
							flexShrink: 0,
							background: statusRegistry.accentVar(display, 6),
						}}
					/>
					<Text size="xs">{tt(display.i18nKey)}</Text>
				</Group>
			)}
			{tab.subtitle && (
				// The whole path, wrapped: the card has the room the one-line row did not.
				// Plain LTR text, so the leading "/" needs no bidi isolation here.
				<Text
					size="xs"
					c="dimmed"
					style={hasDirectorySubtitle(tab) ? { wordBreak: "break-all" } : undefined}
				>
					{tab.subtitle}
				</Text>
			)}
			{terminals > 0 && (
				<DetailLine icon={<IconTerminal2 size={12} />}>
					{tt("activeTerminals", { count: terminals })}
				</DetailLine>
			)}
			{work > 0 && (
				<DetailLine icon={<IconSubtask size={12} />}>
					{tt("activeBackgroundTasks", { count: work })}
				</DetailLine>
			)}
			{services > 0 && (
				<DetailLine icon={<IconServer size={12} />}>
					{tt("activeBackgroundServices", { count: services })}
				</DetailLine>
			)}
			{tab.isScheduled && (
				<DetailLine icon={<IconClock size={12} />}>{tt("recentTabScheduled")}</DetailLine>
			)}
			{tab.hasDraft && (
				<DetailLine icon={<IconPencil size={12} />}>{tt("recentTabHasDraft")}</DetailLine>
			)}
			{viewerCount >= 2 && (
				<Group gap={6} wrap="nowrap">
					<ViewerAvatars viewers={tab.viewers ?? []} viewerCount={viewerCount} />
					<Text size="xs" c="dimmed">
						{tt("viewersWatching", { count: viewerCount })}
					</Text>
				</Group>
			)}
		</Stack>
	);
}

/**
 * The hover card. Placed to the right of the row, flipped to the left when the sidebar
 * sits at the right edge, and kept inside the viewport vertically.
 */
export function RecentTabDetailCard({
	store,
	tabs,
}: {
	store: RecentTabHoverStore;
	tabs: RecentTab[];
}) {
	const anchor = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const tab = anchor
		? tabs.find((candidate) => `${candidate.type}:${candidate.id}` === anchor.key)
		: undefined;
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [top, setTop] = useState<number | null>(null);

	useLayoutEffect(() => {
		if (!node || !anchor) {
			setTop(null);
			return;
		}
		const height = node.getBoundingClientRect().height;
		const view = node.ownerDocument.defaultView;
		const maxTop = (view?.innerHeight ?? anchor.rect.top + height) - height - EDGE_GAP;
		setTop(Math.max(EDGE_GAP, Math.min(anchor.rect.top, maxTop)));
	}, [node, anchor]);

	if (!anchor || !tab) return null;
	const view = typeof window === "undefined" ? undefined : window;
	const fitsRight =
		(view?.innerWidth ?? Number.POSITIVE_INFINITY) - anchor.rect.right >=
		CARD_WIDTH + CARD_GAP + EDGE_GAP;
	const left = fitsRight
		? anchor.rect.right + CARD_GAP
		: Math.max(EDGE_GAP, anchor.rect.left - CARD_WIDTH - CARD_GAP);

	return (
		<Paper
			ref={setNode}
			shadow="md"
			p="sm"
			withBorder
			onPointerEnter={store.holdOpen}
			onPointerLeave={store.leave}
			style={{
				position: "fixed",
				left,
				top: top ?? anchor.rect.top,
				width: CARD_WIDTH,
				zIndex: Z.popover,
				visibility: top === null ? "hidden" : "visible",
			}}
		>
			<RecentTabDetails tab={tab} />
		</Paper>
	);
}
