import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Avatar,
	Box,
	Group,
	NavLink,
	Paper,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArrowUp,
	IconBox,
	IconFolder,
	IconGitBranch,
	IconMessageCircle,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NarratorListWSEvent } from "../../hooks/useNarratorWS";
import { type RecentTab, type RecentTabViewer, useRecentTabs } from "../../hooks/useRecentTabs";
import { useRecentTabsWS } from "../../hooks/useRecentTabsWS";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { triggerNotification } from "../../lib/notification";
import { UserAvatar } from "../UserAvatar";

const mantineVar = (color: string) => `var(--mantine-color-${color}-6)`;

const CONTAINER_STATUS_I18N: Record<string, string> = {
	running: "containerRunning",
	paused: "containerPaused",
	stopped: "containerStopped",
	created: "containerCreated",
	removed: "containerRemoved",
};

const QUERY_KEY = ["user-preferences", "recent-tabs"];
const SWIPE_THRESHOLD = 80;

// Module-level flag: set on dragEnd, cleared on next click capture.
// Prevents the synthetic click after drag from triggering Link navigation.
let justDragged = false;

function tabSortId(tab: RecentTab) {
	return `${tab.type}:${tab.id}`;
}

// === Shared hook: WS subscription + cache updates (mount once in root) ===

interface RecentTabsWSProviderProps {
	onNavigate?: () => void;
}

/**
 * Invisible component that maintains the WS connection for recent tabs.
 * Mount once in the root layout.
 */
export function RecentTabsWSProvider(_props: RecentTabsWSProviderProps) {
	const { tabs } = useRecentTabs();
	const qc = useQueryClient();
	const { data: userPrefs } = useUserPreferences();
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const userPrefsRef = useRef(userPrefs);
	userPrefsRef.current = userPrefs;
	const lastRevisionRef = useRef(0);

	const narratorIds = useMemo(() => {
		const ids: string[] = [];
		for (const tab of tabs) {
			if (tab.type === "narrator") {
				ids.push(tab.id);
			} else if (tab.type === "chapter" && tab.narratorId) {
				ids.push(tab.narratorId);
			}
		}
		return ids;
	}, [tabs]);

	const handleWSUpdate = useCallback(
		(narratorId: string, event: NarratorListWSEvent) => {
			const patch: Partial<
				Pick<RecentTab, "title" | "status" | "viewers" | "activeTerminalCount" | "containerStatus">
			> = {};
			if (event.type === "title" && event.title) patch.title = event.title;
			else if (event.type === "status" && event.status) patch.status = event.status;
			else if (event.type === "presence" && event.viewers) patch.viewers = event.viewers;
			else if (event.type === "terminalCount" && event.activeTerminalCount !== undefined)
				patch.activeTerminalCount = event.activeTerminalCount;
			else if (event.type === "containerStatus") patch.containerStatus = event.containerStatus;
			else return;

			// Trigger client-side notifications for done/waiting
			if (
				event.type === "status" &&
				(event.status === "done" || event.status === "waiting") &&
				userPrefsRef.current
			) {
				const tab = tabsRef.current.find(
					(t) => (t.type === "narrator" && t.id === narratorId) || t.narratorId === narratorId,
				);
				if (tab) {
					triggerNotification(
						narratorId,
						tab.title,
						event.status as "done" | "waiting",
						userPrefsRef.current,
					);
				}
			}

			// When a narrator starts thinking, ask server to promote it above idle tabs
			if (event.type === "status" && event.status === "thinking") {
				const tab = tabsRef.current.find(
					(t) => (t.type === "narrator" && t.id === narratorId) || t.narratorId === narratorId,
				);
				if (tab) {
					api.moveRecentTab(`${tab.type}:${tab.id}`, { position: "above_idle" }).catch(() => {});
				}
			}

			qc.setQueryData<RecentTab[]>(QUERY_KEY, (prev) => {
				if (!prev) return prev;
				let changed = false;
				const next = prev.map((t) => {
					const match =
						(t.type === "narrator" && t.id === narratorId) || t.narratorId === narratorId;
					if (match) {
						changed = true;
						return { ...t, ...patch };
					}
					return t;
				});
				return changed ? next : prev;
			});
		},
		[qc],
	);

	const handleGlobalEvent = useCallback(
		(event: { type: string; [key: string]: unknown }) => {
			if (event.type === "user:recent_tabs_snapshot" && Array.isArray(event.tabs)) {
				const revision = (event.revision as number) ?? 0;
				if (revision > 0 && revision < lastRevisionRef.current) return;
				lastRevisionRef.current = revision || Date.now();

				const serverTabs = event.tabs as RecentTab[];
				qc.setQueryData<RecentTab[]>(QUERY_KEY, (prev) => {
					if (!prev) return serverTabs;
					// Merge: server owns structure + order, preserve local runtime fields
					const runtimeMap = new Map<
						string,
						Pick<RecentTab, "status" | "viewers" | "activeTerminalCount" | "containerStatus">
					>();
					for (const t of prev) {
						runtimeMap.set(`${t.type}:${t.id}`, {
							status: t.status,
							viewers: t.viewers,
							activeTerminalCount: t.activeTerminalCount,
							containerStatus: t.containerStatus,
						});
					}
					return serverTabs.map((t) => {
						const runtime = runtimeMap.get(`${t.type}:${t.id}`);
						return runtime ? { ...t, ...runtime } : t;
					});
				});
			}
		},
		[qc],
	);

	const handleReconnect = useCallback(() => {
		// After WS reconnect, refresh all tab data to catch up on missed events
		qc.invalidateQueries({ queryKey: QUERY_KEY });
	}, [qc]);

	useRecentTabsWS(narratorIds, handleWSUpdate, handleGlobalEvent, handleReconnect);

	return null;
}

// === Filtered tab list component ===

interface RecentTabListProps {
	filter: "project" | "narrator";
	onNavigate?: () => void;
	/** When true, the first tab (if active) removes its top border-radius */
	firstTabConnected?: boolean;
}

/**
 * Renders a filtered subset of recent tabs with DnD, clear button, etc.
 * `filter="project"` shows project tabs; `filter="narrator"` shows chapter+narrator tabs.
 */
export function RecentTabList({ filter, onNavigate, firstTabConnected }: RecentTabListProps) {
	const { tabs, removeTab, moveTab } = useRecentTabs();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { t } = useTranslation("nav");

	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		tab: RecentTab;
	} | null>(null);

	const filtered = useMemo(
		() =>
			filter === "project"
				? tabs.filter((t) => t.type === "project")
				: tabs.filter((t) => t.type !== "project"),
		[tabs, filter],
	);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
		useSensor(KeyboardSensor),
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			justDragged = true;
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const oldIndex = filtered.findIndex((t) => tabSortId(t) === active.id);
			const newIndex = filtered.findIndex((t) => tabSortId(t) === over.id);
			if (oldIndex === -1 || newIndex === -1) return;

			// Compute the global index in the full tabs array based on the target tab's actual position.
			const targetTab = filtered[newIndex];
			const globalIndex = tabs.findIndex((t) => tabSortId(t) === tabSortId(targetTab));
			if (globalIndex === -1) return;

			moveTab(active.id as string, { toIndex: globalIndex });
		},
		[filtered, tabs, moveTab],
	);

	const handleRemove = useCallback(
		(type: RecentTab["type"], id: string) => {
			removeTab(type, id);
		},
		[removeTab],
	);

	const handleContextMenu = useCallback((e: React.MouseEvent, tab: RecentTab) => {
		e.preventDefault();
		e.stopPropagation();
		setCtxMenu({ x: e.clientX, y: e.clientY, tab });
	}, []);

	const handleMoveToTop = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		moveTab(tabSortId(tab), { position: "top" });
		setCtxMenu(null);
	}, [ctxMenu, moveTab]);

	const handleCtxClose = useCallback(() => {
		if (!ctxMenu) return;
		removeTab(ctxMenu.tab.type, ctxMenu.tab.id);
		setCtxMenu(null);
	}, [ctxMenu, removeTab]);

	if (filtered.length === 0) return null;

	const sortIds = filtered.map(tabSortId);

	return (
		<Box style={{ overflow: "hidden" }}>
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
				<SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
					{filtered.map((tab, i) => (
						<SortableTabItem
							key={tabSortId(tab)}
							tab={tab}
							active={isTabActive(tab, pathname)}
							onRemove={handleRemove}
							onNavigate={onNavigate}
							onContextMenu={handleContextMenu}
							connectTop={firstTabConnected && i === 0}
						/>
					))}
				</SortableContext>
			</DndContext>
			{ctxMenu && (
				<TabContextMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					onClose={() => setCtxMenu(null)}
					onMoveToTop={handleMoveToTop}
					onRemove={handleCtxClose}
					isFirst={
						filtered.findIndex((t) => t.type === ctxMenu.tab.type && t.id === ctxMenu.tab.id) === 0
					}
					t={t}
				/>
			)}
		</Box>
	);
}

export function isTabActive(tab: RecentTab, pathname: string): boolean {
	if (tab.type === "project") {
		return pathname === `/projects/${tab.id}`;
	}
	if (tab.type === "chapter") {
		return tab.narratorId ? pathname === `/narrators/${tab.narratorId}` : false;
	}
	return pathname === `/narrators/${tab.id}`;
}

interface SortableTabItemProps {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	/** When true and active, remove top border-radius to connect with nav above */
	connectTop?: boolean;
}

function SortableTabItem({
	tab,
	active,
	onRemove,
	onNavigate,
	onContextMenu,
	connectTop,
}: SortableTabItemProps) {
	const navigate = useNavigate();
	const { t } = useTranslation("common");
	const to =
		tab.type === "project"
			? `/projects/${tab.id}`
			: tab.type === "chapter" && tab.narratorId
				? `/narrators/${tab.narratorId}`
				: `/narrators/${tab.id}`;
	const iconColor = tab.status
		? mantineVar(statusRegistry.narratorStatus(tab.status).color)
		: undefined;

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tabSortId(tab),
	});

	const sortStyle: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
		zIndex: isDragging ? 10 : undefined,
	};

	// Click to navigate — blocked after drag via module-level flag
	const handleClick = useCallback(() => {
		if (justDragged) {
			justDragged = false;
			return;
		}
		navigate({ to });
		onNavigate?.();
	}, [navigate, to, onNavigate]);

	// Middle-click to close
	const handleAuxClick = useCallback(
		(e: React.MouseEvent) => {
			if (e.button === 1) {
				e.preventDefault();
				onRemove(tab.type, tab.id);
			}
		},
		[tab.type, tab.id, onRemove],
	);

	// Right-click context menu
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			onContextMenu(e, tab);
		},
		[onContextMenu, tab],
	);

	// Swipe-right to close (mobile) — only when not dragging
	const touchStartX = useRef(0);
	const touchStartY = useRef(0);
	const swiping = useRef(false);
	const directionLocked = useRef<"horizontal" | "vertical" | null>(null);
	const [swipeX, setSwipeX] = useState(0);
	const [exiting, setExiting] = useState(false);

	const handleTouchStart = useCallback((e: React.TouchEvent) => {
		touchStartX.current = e.touches[0].clientX;
		touchStartY.current = e.touches[0].clientY;
		directionLocked.current = null;
		swiping.current = true;
	}, []);

	const handleTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!swiping.current || isDragging) return;
			const dx = e.touches[0].clientX - touchStartX.current;
			const dy = e.touches[0].clientY - touchStartY.current;
			// Lock direction on first significant movement
			if (!directionLocked.current) {
				if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
				directionLocked.current = Math.abs(dy) > Math.abs(dx) ? "vertical" : "horizontal";
			}
			if (directionLocked.current === "vertical") return;
			setSwipeX(Math.max(0, dx));
		},
		[isDragging],
	);

	const handleTouchEnd = useCallback(() => {
		if (!swiping.current || isDragging) {
			swiping.current = false;
			return;
		}
		swiping.current = false;
		if (swipeX > SWIPE_THRESHOLD) {
			setExiting(true);
			setTimeout(() => onRemove(tab.type, tab.id), 200);
		} else {
			setSwipeX(0);
		}
	}, [swipeX, isDragging, tab.type, tab.id, onRemove]);

	const swipeStyle: React.CSSProperties = exiting
		? {
				transform: "translateX(100%)",
				opacity: 0,
				transition: "transform 0.2s ease-out, opacity 0.2s ease-out",
			}
		: swipeX > 0
			? { transform: `translateX(${swipeX}px)`, transition: "none" }
			: {};

	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			style={{ ...sortStyle, overflow: "hidden", touchAction: "pan-y" }}
		>
			<div style={swipeStyle}>
				<NavLink
					active={active}
					onClick={handleClick}
					onAuxClick={handleAuxClick}
					onContextMenu={handleContextMenu}
					onTouchStart={handleTouchStart}
					onTouchMove={handleTouchMove}
					onTouchEnd={handleTouchEnd}
					label={
						<Text size="sm" truncate>
							{tab.title}
						</Text>
					}
					description={
						<>
							{tab.subtitle && (
								<Text
									size="xs"
									c="dimmed"
									truncate
									style={{
										direction: tab.type === "narrator" ? "rtl" : undefined,
										textAlign: "left",
									}}
								>
									{tab.subtitle}
								</Text>
							)}
							{tab.type !== "project" && <TabIndicators tab={tab} t={t} />}
						</>
					}
					leftSection={
						tab.type === "project" ? (
							<IconFolder size={14} />
						) : tab.type === "chapter" ? (
							<IconGitBranch size={14} color={iconColor} />
						) : (
							<IconMessageCircle size={14} color={iconColor} />
						)
					}
					styles={{
						root: {
							cursor: "pointer",
							...(connectTop && active
								? {
										borderTopLeftRadius: 0,
										borderTopRightRadius: 0,
									}
								: {}),
						},
						label: { overflow: "hidden" },
						section: { marginInlineEnd: 4 },
					}}
				/>
			</div>
		</div>
	);
}

// === Indicator components for extra tab info ===

interface TabIndicatorsProps {
	tab: RecentTab;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

function TabIndicators({ tab, t }: TabIndicatorsProps) {
	const hasViewers = tab.viewers && tab.viewers.length >= 2;
	const hasContainer = tab.type === "chapter" && tab.containerStatus;
	const hasTerminals = (tab.activeTerminalCount ?? 0) > 0;

	if (!hasViewers && !hasContainer && !hasTerminals) return null;

	return (
		<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
			{hasViewers && <ViewerAvatars viewers={tab.viewers as RecentTabViewer[]} t={t} />}
			{hasContainer && (
				<Tooltip
					label={t(CONTAINER_STATUS_I18N[tab.containerStatus as string] ?? "containerStopped")}
					withArrow
					position="right"
				>
					<IconBox
						size={12}
						color={mantineVar(statusRegistry.containerStatus(tab.containerStatus as string).color)}
					/>
				</Tooltip>
			)}
			{hasTerminals && (
				<Tooltip
					label={t("activeTerminals", { count: tab.activeTerminalCount })}
					withArrow
					position="right"
				>
					<Group gap={1} wrap="nowrap">
						<IconTerminal2 size={11} style={{ opacity: 0.6 }} />
						<Text size="xs" c="dimmed" lh={1}>
							{tab.activeTerminalCount}
						</Text>
					</Group>
				</Tooltip>
			)}
		</Group>
	);
}

interface ViewerAvatarsProps {
	viewers: RecentTabViewer[];
	t: (key: string, opts?: Record<string, unknown>) => string;
}

const MAX_VISIBLE_AVATARS = 3;

function ViewerAvatars({ viewers, t }: ViewerAvatarsProps) {
	const visible = viewers.slice(0, MAX_VISIBLE_AVATARS);
	const overflow = viewers.length - MAX_VISIBLE_AVATARS;

	return (
		<Tooltip label={t("viewersWatching", { count: viewers.length })} withArrow position="right">
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
						styles={{
							root: {
								border: "1.5px solid var(--mantine-color-dark-7)",
								fontSize: 8,
								minWidth: 16,
								minHeight: 16,
							},
						}}
					/>
				))}
				{overflow > 0 && (
					<Avatar
						size={16}
						radius="xl"
						styles={{
							root: {
								border: "1.5px solid var(--mantine-color-dark-7)",
								fontSize: 8,
								minWidth: 16,
								minHeight: 16,
							},
						}}
					>
						+{overflow}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip>
	);
}

// === Tab context menu ===

interface TabContextMenuProps {
	x: number;
	y: number;
	onClose: () => void;
	onMoveToTop: () => void;
	onRemove: () => void;
	isFirst: boolean;
	t: (key: string) => string;
}

function TabContextMenu({ x, y, onClose, onMoveToTop, onRemove, isFirst, t }: TabContextMenuProps) {
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: 999 }}
				onClick={onClose}
				onContextMenu={(e) => {
					e.preventDefault();
					onClose();
				}}
				onKeyDown={() => {}}
				role="presentation"
			/>
			<Paper
				shadow="md"
				p={4}
				withBorder
				style={{
					position: "fixed",
					left: x,
					top: y,
					zIndex: 1000,
					minWidth: 140,
				}}
			>
				<Stack gap={2}>
					{!isFirst && (
						<UnstyledButton px="xs" py={4} onClick={onMoveToTop} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconArrowUp size={14} />
								<Text size="sm">{t("moveToTop")}</Text>
							</Group>
						</UnstyledButton>
					)}
					<UnstyledButton px="xs" py={4} onClick={onRemove} style={{ borderRadius: 4 }}>
						<Group gap={8} wrap="nowrap">
							<IconX size={14} />
							<Text size="sm">{t("closeTab")}</Text>
						</Group>
					</UnstyledButton>
				</Stack>
			</Paper>
		</>
	);
}
