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
import { ActionIcon, Box, Divider, Group, NavLink, Text, Tooltip } from "@mantine/core";
import { IconClearAll, IconGitBranch, IconMessageCircle, IconX } from "@tabler/icons-react";
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

interface RecentTabsProps {
	onNavigate?: () => void;
}

export function RecentTabs({ onNavigate }: RecentTabsProps) {
	const { t } = useTranslation("nav");
	const { tabs, removeTab, reorderTabs, clearAll } = useRecentTabs();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const qc = useQueryClient();

	// DnD sensors: mouse with distance for desktop, touch with delay for long-press
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
			const oldIndex = tabs.findIndex((t) => tabSortId(t) === active.id);
			const newIndex = tabs.findIndex((t) => tabSortId(t) === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const reordered = [...tabs];
			const [moved] = reordered.splice(oldIndex, 1);
			reordered.splice(newIndex, 0, moved);
			reorderTabs(reordered);
		},
		[tabs, reorderTabs],
	);

	const handleRemove = useCallback(
		(type: RecentTab["type"], id: string) => {
			removeTab(type, id);
		},
		[removeTab],
	);

	const handleClearAll = useCallback(() => {
		clearAll();
	}, [clearAll]);

	// Collect narrator IDs for WS subscription
	const narratorIds = useMemo(() => {
		const ids: string[] = [];
		for (const tab of tabs) {
			if (tab.type === "session") {
				ids.push(tab.id);
			} else if (tab.narratorId) {
				ids.push(tab.narratorId);
			}
		}
		return ids;
	}, [tabs]);

	// Subscribe to real-time title/status updates via WS
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

				// When a tab transitions to "thinking", promote it above all idle tabs
				// but keep it below existing thinking/waiting/done tabs.
				if (isPromote) {
					return promoteAboveIdle(next, narratorId);
				}
				return next;
			});

			const current = qc.getQueryData<RecentTab[]>(QUERY_KEY);
			if (isPromote && current) {
				// Persist the new order after promotion
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

	// When another client changes recent tabs, refetch from backend
	const handleGlobalEvent = useCallback(
		(event: { type: string }) => {
			if (event.type === "user:recent_tabs_changed") {
				qc.invalidateQueries({ queryKey: QUERY_KEY });
			}
		},
		[qc],
	);

	useRecentTabsWS(narratorIds, handleWSUpdate, handleGlobalEvent);

	if (tabs.length === 0) return null;

	const sortIds = tabs.map(tabSortId);

	return (
		<Box mt="xs" style={{ overflow: "hidden" }}>
			<Group justify="flex-end" px="xs" mb={2}>
				<Divider style={{ flex: 1 }} />
				<Tooltip label={t("clearAll")} position="right" withArrow>
					<ActionIcon
						size={16}
						variant="subtle"
						color="gray"
						onClick={handleClearAll}
						aria-label={t("clearAll")}
					>
						<IconClearAll size={12} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
				<SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
					{tabs.map((tab) => (
						<SortableTabItem
							key={tabSortId(tab)}
							tab={tab}
							active={isTabActive(tab, pathname)}
							onRemove={handleRemove}
							onNavigate={onNavigate}
						/>
					))}
				</SortableContext>
			</DndContext>
		</Box>
	);
}

function isTabActive(tab: RecentTab, pathname: string): boolean {
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
}

function SortableTabItem({ tab, active, onRemove, onNavigate }: SortableTabItemProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const to =
		tab.type === "chapter" && tab.narratorId
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
						tab.type === "chapter" ? (
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
						root: { borderRadius: "var(--mantine-radius-sm)", cursor: "pointer" },
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
