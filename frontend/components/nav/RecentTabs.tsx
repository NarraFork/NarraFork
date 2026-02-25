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
import { Box, NavLink, Text } from "@mantine/core";
import { IconFolder, IconGitBranch, IconMessageCircle, IconX } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionListWSEvent } from "../../hooks/useNarratorWS";
import { type RecentTab, useRecentTabs } from "../../hooks/useRecentTabs";
import { useRecentTabsWS } from "../../hooks/useRecentTabsWS";
import { api } from "../../lib/api";

const STATUS_COLORS: Record<string, string> = {
	done: "var(--mantine-color-green-6)",
	thinking: "var(--mantine-color-blue-6)",
	waiting: "var(--mantine-color-orange-6)",
};

const QUERY_KEY = ["user-preferences", "recent-tabs"];
const SWIPE_THRESHOLD = 80;

// Module-level flag: set on dragEnd, cleared on next click capture.
// Prevents the synthetic click after drag from triggering Link navigation.
let justDragged = false;

const ACTIVE_STATUSES = new Set(["thinking", "waiting", "done"]);

/**
 * Move the tab matching `narratorId` to just after the last active (thinking/waiting/done) tab.
 * This places it above all idle tabs without disturbing the order of other active tabs.
 */
function promoteAboveIdle(tabs: RecentTab[], narratorId: string): RecentTab[] {
	const idx = tabs.findIndex(
		(t) => (t.type === "session" && t.id === narratorId) || t.narratorId === narratorId,
	);
	if (idx === -1) return tabs;

	// Find the position right after the last active tab (excluding the target itself)
	let lastActiveIdx = -1;
	for (let i = 0; i < tabs.length; i++) {
		if (i === idx) continue;
		if (ACTIVE_STATUSES.has(tabs[i].status ?? "")) {
			lastActiveIdx = i;
		}
	}

	// Insert after the last active tab; if none, insert at position 0
	const insertAt =
		lastActiveIdx === -1 ? 0 : lastActiveIdx < idx ? lastActiveIdx + 1 : lastActiveIdx;

	if (idx === insertAt) return tabs;

	const result = [...tabs];
	const [moved] = result.splice(idx, 1);
	result.splice(insertAt, 0, moved);
	return result;
}

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

	const narratorIds = useMemo(() => {
		const ids: string[] = [];
		for (const tab of tabs) {
			if (tab.type === "session") {
				ids.push(tab.id);
			} else if (tab.type === "chapter" && tab.narratorId) {
				ids.push(tab.narratorId);
			}
		}
		return ids;
	}, [tabs]);

	const handleWSUpdate = useCallback(
		(narratorId: string, event: SessionListWSEvent) => {
			const patch: Partial<Pick<RecentTab, "title" | "status">> = {};
			if (event.type === "title" && event.title) patch.title = event.title;
			else if (event.type === "status" && event.status) patch.status = event.status;
			else return;

			const isPromote = event.type === "status" && event.status === "thinking";

			qc.setQueryData<RecentTab[]>(QUERY_KEY, (prev) => {
				if (!prev) return prev;
				let changed = false;
				const next = prev.map((t) => {
					const match =
						(t.type === "session" && t.id === narratorId) || t.narratorId === narratorId;
					if (match) {
						changed = true;
						return { ...t, ...patch };
					}
					return t;
				});
				if (!changed) return prev;

				if (isPromote) {
					return promoteAboveIdle(next, narratorId);
				}
				return next;
			});

			const current = qc.getQueryData<RecentTab[]>(QUERY_KEY);
			if (isPromote && current) {
				api.reorderRecentTabs(current.map((t) => `${t.type}:${t.id}`)).catch(() => {});
			}
			const matched = current?.find(
				(t) => (t.type === "session" && t.id === narratorId) || t.narratorId === narratorId,
			);
			if (matched) {
				api.upsertRecentTab(matched).catch(() => {});
			}
		},
		[qc],
	);

	const handleGlobalEvent = useCallback(
		(event: { type: string }) => {
			if (event.type === "user:recent_tabs_changed") {
				qc.invalidateQueries({ queryKey: QUERY_KEY });
			}
		},
		[qc],
	);

	useRecentTabsWS(narratorIds, handleWSUpdate, handleGlobalEvent);

	return null;
}

// === Filtered tab list component ===

interface RecentTabListProps {
	filter: "project" | "session";
	onNavigate?: () => void;
	/** When true, the first tab (if active) removes its top border-radius */
	firstTabConnected?: boolean;
}

/**
 * Renders a filtered subset of recent tabs with DnD, clear button, etc.
 * `filter="project"` shows project tabs; `filter="session"` shows chapter+session tabs.
 */
export function RecentTabList({ filter, onNavigate, firstTabConnected }: RecentTabListProps) {
	const { tabs, removeTab, reorderTabs } = useRecentTabs();
	const pathname = useRouterState({ select: (s) => s.location.pathname });

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
			// Reorder within this group, keep the other group intact
			const reordered = [...filtered];
			const [moved] = reordered.splice(oldIndex, 1);
			reordered.splice(newIndex, 0, moved);
			const otherGroup = tabs.filter((t) =>
				filter === "project" ? t.type !== "project" : t.type === "project",
			);
			// Invariant: projects always precede sessions in the persisted array,
			// matching the visual layout in __root.tsx (project list above session list).
			const full =
				filter === "project" ? [...reordered, ...otherGroup] : [...otherGroup, ...reordered];
			reorderTabs(full);
		},
		[filtered, tabs, filter, reorderTabs],
	);

	const handleRemove = useCallback(
		(type: RecentTab["type"], id: string) => {
			removeTab(type, id);
		},
		[removeTab],
	);

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
							connectTop={firstTabConnected && i === 0}
						/>
					))}
				</SortableContext>
			</DndContext>
		</Box>
	);
}

export function isTabActive(tab: RecentTab, pathname: string): boolean {
	if (tab.type === "project") {
		return pathname === `/projects/${tab.id}`;
	}
	if (tab.type === "chapter") {
		return tab.narratorId ? pathname === `/sessions/${tab.narratorId}` : false;
	}
	return pathname === `/sessions/${tab.id}`;
}

interface SortableTabItemProps {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	onNavigate?: () => void;
	/** When true and active, remove top border-radius to connect with nav above */
	connectTop?: boolean;
}

function SortableTabItem({ tab, active, onRemove, onNavigate, connectTop }: SortableTabItemProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const to =
		tab.type === "project"
			? `/projects/${tab.id}`
			: tab.type === "chapter" && tab.narratorId
				? `/sessions/${tab.narratorId}`
				: `/sessions/${tab.id}`;
	const iconColor = STATUS_COLORS[tab.status ?? ""];

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
					onTouchStart={handleTouchStart}
					onTouchMove={handleTouchMove}
					onTouchEnd={handleTouchEnd}
					label={
						<Text size="sm" truncate>
							{tab.title}
						</Text>
					}
					description={tab.subtitle}
					leftSection={
						tab.type === "project" ? (
							<IconFolder size={14} />
						) : tab.type === "chapter" ? (
							<IconGitBranch size={14} color={iconColor} />
						) : (
							<IconMessageCircle size={14} color={iconColor} />
						)
					}
					rightSection={
						<IconX
							size={10}
							color="var(--mantine-color-dimmed)"
							style={{ cursor: "pointer", flexShrink: 0 }}
							onClick={(e: React.MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								onRemove(tab.type, tab.id);
							}}
							aria-label={t("closeTab")}
						/>
					}
					styles={{
						root: {
							cursor: "pointer",
							...(connectTop && active ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {}),
						},
						label: { overflow: "hidden" },
						section: { marginInlineEnd: 4 },
						description: {
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							direction: tab.type === "session" ? "rtl" : undefined,
							textAlign: "left",
						},
					}}
				/>
			</div>
		</div>
	);
}
