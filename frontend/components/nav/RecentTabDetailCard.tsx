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
import { ActionIcon, Avatar, Box, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import {
	IconArchive,
	IconClock,
	IconCopy,
	IconFolderPlus,
	IconPencil,
	IconPin,
	IconPinnedOff,
	IconServer,
	IconSubtask,
	IconTerminal2,
	IconWindowMaximize,
	IconX,
} from "@tabler/icons-react";
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
	actions,
	t,
}: {
	store: RecentTabHoverStore;
	tabs: RecentTab[];
	/** Quick actions under the details; omitted, the card only shows details. */
	actions?: RecentTabCardActions;
	t?: (key: string) => string;
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
			data-nav-keep-open
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
			{actions && t && (
				<CardActions
					tab={tab}
					actions={actions}
					t={t}
					// An action opens a dialog, a window or a toast: the card has done its job.
					onDone={store.hide}
				/>
			)}
		</Paper>
	);
}

/**
 * The row menu's everyday actions, as icons under the details, so a mouse user rarely
 * needs the right-click menu. Everything else (folders, moving, reveal, git identity)
 * stays in the menu. Sessions only: a folder or project row's card has no actions.
 */
export interface RecentTabCardActions {
	onPin: (tab: RecentTab) => void;
	onRename: (tab: RecentTab) => void;
	onCopyCwd: (tab: RecentTab) => void;
	onOpenInWindow: (tab: RecentTab) => void;
	canOpenInWindow: (tab: RecentTab) => boolean;
	onNewNarratorHere: (tab: RecentTab) => void;
	onArchive: (tab: RecentTab) => void;
	onClose: (tab: RecentTab) => void;
}

function CardActions({
	tab,
	actions,
	t,
	onDone,
}: {
	tab: RecentTab;
	actions: RecentTabCardActions;
	t: (key: string) => string;
	onDone: () => void;
}) {
	if (tab.type !== "narrator" && tab.type !== "subagent") return null;
	const isNarrator = tab.type === "narrator";
	const items: {
		key: string;
		label: string;
		icon: React.ReactNode;
		run: (tab: RecentTab) => void;
		color?: string;
	}[] = [
		{
			key: "pin",
			label: t(
				tab.folderId
					? tab.pinned
						? "unpinInFolder"
						: "pinInFolder"
					: tab.pinned
						? "unpinTab"
						: "pinTab",
			),
			icon: tab.pinned ? <IconPinnedOff size={15} /> : <IconPin size={15} />,
			run: actions.onPin,
		},
		...(isNarrator
			? [
					{
						key: "rename",
						label: t("rename"),
						icon: <IconPencil size={15} />,
						run: actions.onRename,
					},
				]
			: []),
		{ key: "copyCwd", label: t("copyCwd"), icon: <IconCopy size={15} />, run: actions.onCopyCwd },
		...(actions.canOpenInWindow(tab)
			? [
					{
						key: "openInWindow",
						label: t("openInWindow"),
						icon: <IconWindowMaximize size={15} />,
						run: actions.onOpenInWindow,
					},
				]
			: []),
		{
			key: "newNarratorHere",
			label: t("newNarratorHere"),
			icon: <IconFolderPlus size={15} />,
			run: actions.onNewNarratorHere,
		},
		...(isNarrator
			? [
					{
						key: "archive",
						label: t("archive"),
						icon: <IconArchive size={15} />,
						run: actions.onArchive,
						color: "orange",
					},
				]
			: []),
		{
			key: "close",
			label: t("closeTab"),
			icon: <IconX size={15} />,
			run: actions.onClose,
			color: "red",
		},
	];
	return (
		<Group
			gap={2}
			mt={8}
			pt={6}
			wrap="nowrap"
			data-recent-tab-card-actions
			style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
		>
			{items.map((item) => (
				<Tooltip key={item.key} label={item.label} position="bottom" withArrow openDelay={150}>
					<ActionIcon
						size={26}
						variant="subtle"
						color={item.color ?? "gray"}
						aria-label={item.label}
						data-card-action={item.key}
						onClick={() => {
							onDone();
							item.run(tab);
						}}
					>
						{item.icon}
					</ActionIcon>
				</Tooltip>
			))}
		</Group>
	);
}
