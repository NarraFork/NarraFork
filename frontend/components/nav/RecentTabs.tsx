import {
	type CollisionDetection,
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragMoveEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MouseSensor,
	pointerWithin,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { statusRegistry } from "@frontend/lib/status-registry";
import {
	ActionIcon,
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
import { notifications } from "@mantine/notifications";
import {
	IconArrowUp,
	IconBox,
	IconColumns,
	IconFolder,
	IconGitBranch,
	IconMessageCircle,
	IconMessageCircleFilled,
	IconPlus,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NarratorListWSEvent } from "../../hooks/useNarratorWS";
import { usePlatform } from "../../hooks/usePlatform";
import {
	addRecentTab,
	RECENT_TABS_QUERY_KEY,
	type RecentTab,
	type RecentTabViewer,
	useRecentTabs,
} from "../../hooks/useRecentTabs";
import { useRecentTabsWS } from "../../hooks/useRecentTabsWS";
import { useSetupWizardGuard } from "../../hooks/useSetupWizardGuard";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import {
	endNarratorDrag,
	moveNarratorDrag,
	startNarratorDrag,
	startNarratorDragManual,
} from "../../lib/narrator-drag";
import { triggerNotification } from "../../lib/notification";
import { CreateNarratorModal, type CreateNarratorResult } from "../narrator/CreateNarratorModal";
import { addLeaf, type SplitNode } from "../narrator/split-tree";
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
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { data: userPrefs } = useUserPreferences();
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const pathnameRef = useRef(pathname);
	pathnameRef.current = pathname;
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

				// If the current page's tab was removed, navigate to dashboard
				const currentPath = pathnameRef.current;
				const currentTabStillExists = serverTabs.some((t) => isTabActive(t, currentPath));
				const wasInTab = tabsRef.current.some((t) => isTabActive(t, currentPath));
				if (wasInTab && !currentTabStillExists) {
					navigate({ to: "/" });
				}

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
		[qc, navigate],
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
	/** Narrator ID to exclude from active highlighting (used for overseer) */
	excludeActiveNarratorId?: string;
}

/**
 * Custom collision detection that groups workspace children with their header.
 * When the pointer is over any workspace child (or its workspace header),
 * the entire workspace group is treated as a single drop target.
 * This ensures dragging an external item over a workspace causes the whole
 * group to shift together visually.
 */
function workspaceGroupCollisionDetection(
	args: Parameters<CollisionDetection>[0],
	sortItems: RecentTab[],
	childrenByWorkspace: Map<string, RecentTab[]>,
): ReturnType<CollisionDetection> {
	// First, use pointerWithin to find which items the pointer is over.
	const pointerCollisions = pointerWithin(args);

	if (pointerCollisions.length === 0) {
		// No items under pointer — fall back to closestCenter.
		return closestCenter(args);
	}

	// Find the first item under the pointer.
	const first = pointerCollisions[0];
	if (!first) return pointerCollisions;

	const tab = sortItems.find((t) => tabSortId(t) === first.id);
	if (!tab) return pointerCollisions;

	// Determine the group that this item belongs to.
	// A workspace header or child belongs to the workspace group.
	const groupIds: string[] = [];

	if (tab.type === "workspace") {
		// Pointer is over the workspace header — include header + all children.
		groupIds.push(tabSortId(tab));
		const children = childrenByWorkspace.get(tab.id) ?? [];
		groupIds.push(...children.map((c) => tabSortId(c)));
	} else if (tab.workspaceId) {
		// Pointer is over a workspace child — include the workspace header + all children.
		const wsHeader = sortItems.find((t) => t.type === "workspace" && t.id === tab.workspaceId);
		if (wsHeader) groupIds.push(tabSortId(wsHeader));
		const children = childrenByWorkspace.get(tab.workspaceId) ?? [];
		groupIds.push(...children.map((c) => tabSortId(c)));
	} else {
		// Non-workspace item — no grouping needed.
		groupIds.push(first.id as string);
	}

	// Filter pointer collisions to only include items in the same group.
	// But always include the first collision (the actual drop target) and any
	// siblings in the same workspace group.
	const groupIdSet = new Set(groupIds);
	const groupCollisions = pointerCollisions.filter((c) => groupIdSet.has(c.id as string));

	// If we're dragging a workspace header, we want the group to be treated as one.
	// Return the collision for the workspace header if it's in the group.
	const wsHeaderCollision = groupCollisions.find((c) => {
		const t = sortItems.find((s) => tabSortId(s) === c.id);
		return t?.type === "workspace";
	});

	return wsHeaderCollision ? [wsHeaderCollision] : groupCollisions;
}

/**
 * Renders a filtered subset of recent tabs with DnD, clear button, etc.
 * `filter="project"` shows project tabs; `filter="narrator"` shows chapter+narrator tabs.
 */
export function RecentTabList({
	filter,
	onNavigate,
	firstTabConnected,
	excludeActiveNarratorId,
}: RecentTabListProps) {
	const { tabs, removeTab, moveTab } = useRecentTabs();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { t } = useTranslation("nav");
	const requireSetup = useSetupWizardGuard();

	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		tab: RecentTab;
	} | null>(null);

	// Workspace "add narrator" modal state
	const [wsCreateTarget, setWsCreateTarget] = useState<string | null>(null);

	// Drag state: the tab currently being dragged (for workspace, tracks the whole group)
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

	const filtered = useMemo(
		() =>
			filter === "project"
				? tabs.filter((t) => t.type === "project")
				: tabs.filter((t) => t.type !== "project"),
		[tabs, filter],
	);

	// Split into top-level tabs and workspace children
	const { topLevel, childrenByWorkspace } = useMemo(() => {
		const top: RecentTab[] = [];
		const byWs = new Map<string, RecentTab[]>();
		for (const tab of filtered) {
			if (tab.workspaceId) {
				const arr = byWs.get(tab.workspaceId);
				if (arr) arr.push(tab);
				else byWs.set(tab.workspaceId, [tab]);
			} else {
				top.push(tab);
			}
		}
		return { topLevel: top, childrenByWorkspace: byWs };
	}, [filtered]);

	// Build a flat array of all items in visual order (topLevel + their workspace children).
	// This ensures dnd-kit sees the true layout so that dragging external items over
	// a workspace causes the whole group (header + children) to shift together.
	const sortItems = useMemo(() => {
		const items: RecentTab[] = [];
		for (const tab of topLevel) {
			items.push(tab);
			if (tab.type === "workspace") {
				const children = childrenByWorkspace.get(tab.id) ?? [];
				items.push(...children);
			}
		}
		return items;
	}, [topLevel, childrenByWorkspace]);

	// Helper: for a given sortIdx, return the indices of the whole workspace group
	// that the item at that index belongs to (header + all children).
	// Returns a range [startIdx, endIdx] (inclusive).
	// Returns [idx, idx] for non-workspace items.
	const getWorkspaceGroupRange = useCallback(
		(idx: number): [start: number, end: number] => {
			const tab = sortItems[idx];
			if (!tab) return [idx, idx];
			if (tab.type !== "workspace") return [idx, idx];
			// Find the last index of this workspace's children
			let end = idx;
			for (let i = idx + 1; i < sortItems.length; i++) {
				if (sortItems[i].workspaceId === tab.id) end = i;
				else break;
			}
			return [idx, end];
		},
		[sortItems],
	);

	// Custom collision detection: when pointer is over a workspace child or header,
	// treat the entire workspace group as a single target so dragging external items
	// over a workspace causes the whole group to shift together.
	const collisionDetection = useCallback(
		(args: Parameters<CollisionDetection>[0]) =>
			workspaceGroupCollisionDetection(args, sortItems, childrenByWorkspace),
		[sortItems, childrenByWorkspace],
	);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
		useSensor(KeyboardSensor),
	);

	// Bridge @dnd-kit drag into global narrator drag so workspace panels can receive drops
	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			setDraggingTabId(event.active.id as string);
			const tab = sortItems.find((t) => tabSortId(t) === event.active.id);
			if (!tab) return;
			const nId = tab.type === "narrator" ? tab.id : tab.type === "chapter" ? tab.narratorId : null;
			if (!nId) return;
			const me = event.activatorEvent as MouseEvent | TouchEvent;
			const x = "clientX" in me ? me.clientX : (me.touches?.[0]?.clientX ?? 0);
			const y = "clientY" in me ? me.clientY : (me.touches?.[0]?.clientY ?? 0);
			startNarratorDragManual(nId, tab.title, x, y);
		},
		[sortItems],
	);

	const handleDragMove = useCallback((event: DragMoveEvent) => {
		const me = event.activatorEvent as MouseEvent | TouchEvent;
		const baseX = "clientX" in me ? me.clientX : (me.touches?.[0]?.clientX ?? 0);
		const baseY = "clientY" in me ? me.clientY : (me.touches?.[0]?.clientY ?? 0);
		moveNarratorDrag(baseX + event.delta.x, baseY + event.delta.y);
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			justDragged = true;
			setDraggingTabId(null);
			// End global narrator drag first — workspace drop handlers run synchronously
			endNarratorDrag();

			const { active, over } = event;
			if (!over || active.id === over.id) return;

			// Find sort indices of active (dragged) and over (drop target) items.
			const oldSortIdx = sortItems.findIndex((t) => tabSortId(t) === active.id);
			const newSortIdx = sortItems.findIndex((t) => tabSortId(t) === over.id);
			if (oldSortIdx === -1 || newSortIdx === -1) return;

			const activeTab = sortItems[oldSortIdx];
			if (!activeTab) return;

			// Determine the range of indices of the target (over) group.
			const [overStart, overEnd] = getWorkspaceGroupRange(newSortIdx);

			// Helper: synchronously reorder query data BEFORE moveTab (whose onMutate
			// is async due to cancelQueries).  dnd-kit's drop animation reads the DOM
			// on the next frame, so the list must already reflect the new order.
			const reorderSync = (key: string, toIndex: number) => {
				qc.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, (prev) => {
					if (!prev) return prev;
					const idx = prev.findIndex((t) => `${t.type}:${t.id}` === key);
					if (idx === -1) return prev;
					const next = [...prev];
					const [moved] = next.splice(idx, 1);
					next.splice(Math.min(toIndex, next.length), 0, moved);
					return next;
				});
			};

			// If the active item is a workspace header, move the whole group.
			// If the active item is a workspace child, move only the child.
			if (activeTab.type === "workspace") {
				// Determine insertion point based on direction.
				const overTab = sortItems[overStart];
				if (!overTab) return;

				if (overStart === oldSortIdx) return; // no-op

				const overGlobalIdx = tabs.findIndex((t) => tabSortId(t) === tabSortId(overTab));
				if (overGlobalIdx === -1) return;

				let insertIdx: number;
				if (oldSortIdx < newSortIdx) {
					// Moving down: insert after the target group (the group occupies [overStart..overEnd]).
					const afterOverTab = sortItems[overEnd];
					if (!afterOverTab) return;
					const afterOverGlobalIdx = tabs.findIndex(
						(t) => tabSortId(t) === tabSortId(afterOverTab),
					);
					insertIdx = afterOverGlobalIdx + 1;
				} else {
					// Moving up: insert before the target group's header.
					insertIdx = overGlobalIdx;
				}

				// Sync reorder so dnd-kit sees the new order immediately
				reorderSync(tabSortId(activeTab), insertIdx);
				// Move the header tab — children follow implicitly via backend ordering by workspaceId.
				moveTab(tabSortId(activeTab), { toIndex: insertIdx });
			} else {
				// Normal item (non-workspace) drag — move single item.
				const targetTab = sortItems[overStart];
				if (!targetTab) return;
				const globalIndex = tabs.findIndex((t) => tabSortId(t) === tabSortId(targetTab));
				if (globalIndex === -1) return;
				// Sync reorder so dnd-kit sees the new order immediately
				reorderSync(active.id as string, globalIndex);
				moveTab(active.id as string, { toIndex: globalIndex });
			}
		},
		[sortItems, tabs, moveTab, getWorkspaceGroupRange, qc],
	);

	/** Release all child tabs from a workspace and delete the workspace entity. */
	const releaseWorkspace = useCallback(
		(wsId: string) => {
			// Remove query cache first to prevent 404 errors on the workspace page
			qc.removeQueries({ queryKey: ["workspace", wsId] });
			const children = childrenByWorkspace.get(wsId);
			if (children) {
				for (const child of children) {
					addRecentTab({
						type: child.type,
						id: child.id,
						title: child.title,
						workspaceId: null,
						updateOnly: true,
					});
				}
			}
			api.deleteWorkspace(wsId).catch(() => {});
		},
		[childrenByWorkspace, qc],
	);

	/** Remove a tab and navigate to dashboard if it was the active page. */
	const handleRemove = useCallback(
		(type: RecentTab["type"], id: string) => {
			const tab = tabs.find((t) => t.type === type && t.id === id);
			if (tab && isTabActive(tab, pathname)) {
				navigate({ to: "/" });
			}
			if (type === "workspace") releaseWorkspace(id);
			removeTab(type, id);
		},
		[removeTab, tabs, pathname, navigate, releaseWorkspace],
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
		const { tab } = ctxMenu;
		if (isTabActive(tab, pathname)) {
			navigate({ to: "/" });
		}
		if (tab.type === "workspace") releaseWorkspace(tab.id);
		removeTab(tab.type, tab.id);
		setCtxMenu(null);
	}, [ctxMenu, removeTab, pathname, navigate, releaseWorkspace]);

	const platform = usePlatform();

	const handleReveal = useCallback(async () => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		try {
			if (tab.type === "chapter") {
				const chapter = await api.getChapter(tab.id);
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const wt = (chapter as any)?.worktreePath;
				if (wt) await api.fsReveal(wt);
			} else if (tab.type === "narrator") {
				const narrator = await api.getNarrator(tab.id);
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const cwd = (narrator as any)?.cwd;
				if (cwd) await api.fsReveal(cwd);
			}
		} catch {
			// ignore
		}
	}, [ctxMenu]);

	const handleDragCancel = useCallback(() => {
		endNarratorDrag();
		setDraggingTabId(null);
	}, []);

	const handleWsAddClick = useCallback(
		(e: React.MouseEvent, wsId: string) => {
			e.stopPropagation();
			e.preventDefault();
			if (!requireSetup()) return;
			setWsCreateTarget(wsId);
		},
		[requireSetup],
	);

	const handleWsNarratorCreated = useCallback(
		async (data: CreateNarratorResult) => {
			if (!wsCreateTarget) return;
			const wsId = wsCreateTarget;
			setWsCreateTarget(null);
			// Add to recent tabs with workspaceId
			addRecentTab({
				type: "narrator",
				id: data.id,
				title: data.title,
				subtitle: data.cwd,
				status: data.status,
				workspaceId: wsId,
			});
			// Fetch current workspace tree, add the new leaf, persist
			try {
				const ws = (await api.getWorkspace(wsId)) as { tree?: string };
				const tree: SplitNode = ws?.tree
					? (JSON.parse(ws.tree) as SplitNode)
					: { type: "leaf", id: "sp_1", narratorId: null };
				const updated = addLeaf(tree, data.id);
				await api.updateWorkspace(wsId, { tree: JSON.stringify(updated) });
				qc.invalidateQueries({ queryKey: ["workspace", wsId] });
			} catch (err) {
				notifications.show({
					color: "yellow",
					title: t("workspaceTreeUpdateFailed") ?? "Workspace layout update failed",
					message: err instanceof Error ? err.message : String(err),
				});
			}
			// Navigate to the workspace
			navigate({ to: `/narrators/workspace/${wsId}` });
			onNavigate?.();
		},
		[wsCreateTarget, qc, navigate, onNavigate, t],
	);

	if (topLevel.length === 0) return null;

	const sortIds = sortItems.map(tabSortId);

	// The tab being dragged (may be a workspace header or a child).
	const draggingTab = draggingTabId
		? (sortItems.find((t) => tabSortId(t) === draggingTabId) ?? null)
		: null;

	return (
		<Box style={{ overflow: "hidden" }}>
			<DndContext
				sensors={sensors}
				collisionDetection={collisionDetection}
				onDragStart={handleDragStart}
				onDragMove={handleDragMove}
				onDragEnd={handleDragEnd}
				onDragCancel={handleDragCancel}
			>
				<SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
					{sortItems.map((tab, sortIdx) => {
						const isHeader = !tab.workspaceId;
						const isDraggingThis = tabSortId(tab) === draggingTabId;
						// When a workspace header is being dragged, hide its children too
						// (the overlay already renders them).
						const isChildOfDraggingWs =
							!isHeader &&
							tab.workspaceId &&
							draggingTab?.type === "workspace" &&
							tab.workspaceId === draggingTab.id;

						// Workspace children use a compact sortable component.
						if (!isHeader) {
							return (
								<SortableWorkspaceChildTab
									key={tabSortId(tab)}
									tab={tab}
									active={
										isTabActive(tab, pathname) &&
										!(excludeActiveNarratorId && tab.id === excludeActiveNarratorId)
									}
									onNavigate={onNavigate}
									onContextMenu={handleContextMenu}
									dimmed={isDraggingThis || !!isChildOfDraggingWs}
								/>
							);
						}

						return (
							<SortableTabItem
								key={tabSortId(tab)}
								tab={tab}
								active={
									isTabActive(tab, pathname) &&
									!(excludeActiveNarratorId && tab.id === excludeActiveNarratorId)
								}
								onRemove={handleRemove}
								onNavigate={onNavigate}
								onContextMenu={handleContextMenu}
								connectTop={
									firstTabConnected && sortIdx === topLevel.findIndex((t) => !t.workspaceId)
								}
								onWsAddClick={tab.type === "workspace" ? handleWsAddClick : undefined}
								dimmed={isDraggingThis}
							/>
						);
					})}
				</SortableContext>
				{/* Floating overlay while dragging — workspace shows the whole group, others show a single tab. */}
				<DragOverlay>
					{draggingTab ? (
						draggingTab.type === "workspace" ? (
							<Box style={{ opacity: 0.9 }}>
								<DragOverlayWorkspaceItem
									tab={draggingTab}
									wsChildren={childrenByWorkspace.get(draggingTab.id) ?? []}
								/>
							</Box>
						) : (
							<DragOverlayTabItem tab={draggingTab} active={isTabActive(draggingTab, pathname)} />
						)
					) : null}
				</DragOverlay>
			</DndContext>
			{ctxMenu && (
				<TabContextMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					onClose={() => setCtxMenu(null)}
					onMoveToTop={handleMoveToTop}
					onRemove={handleCtxClose}
					onReveal={handleReveal}
					canReveal={platform !== "linux" && ctxMenu.tab.type !== "project"}
					isFirst={
						topLevel.findIndex((t) => t.type === ctxMenu.tab.type && t.id === ctxMenu.tab.id) === 0
					}
					isWorkspace={ctxMenu.tab.type === "workspace"}
					t={t}
				/>
			)}
			<CreateNarratorModal
				opened={wsCreateTarget !== null}
				onClose={() => setWsCreateTarget(null)}
				onCreated={handleWsNarratorCreated}
			/>
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
	if (tab.type === "workspace") {
		return pathname === `/narrators/workspace/${tab.id}`;
	}
	return pathname === `/narrators/${tab.id}`;
}

/** Non-sortable child tab rendered indented under a workspace tab. */
function WorkspaceChildTab({
	tab,
	active,
	onNavigate,
	onContextMenu,
}: {
	tab: RecentTab;
	active: boolean;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
}) {
	const navigate = useNavigate();
	const to =
		tab.type === "chapter" && tab.narratorId
			? `/narrators/${tab.narratorId}`
			: `/narrators/${tab.id}`;
	const iconColor = tab.status
		? mantineVar(statusRegistry.narratorStatus(tab.status).color)
		: undefined;
	const filledStatus = tab.status === "thinking" || tab.status === "error" || tab.status === "done";

	return (
		<NavLink
			active={active}
			label={<Text size="xs">{tab.title}</Text>}
			leftSection={
				tab.type === "chapter" ? (
					<IconGitBranch
						size={14}
						color={iconColor}
						fill={filledStatus ? "currentColor" : "none"}
					/>
				) : filledStatus ? (
					<IconMessageCircleFilled size={14} color={iconColor} />
				) : (
					<IconMessageCircle size={14} color={iconColor} />
				)
			}
			onClick={() => {
				onNavigate?.();
				navigate({ to });
			}}
			onContextMenu={(e) => onContextMenu(e, tab)}
			py={2}
			pl="lg"
			styles={{
				root: { borderRadius: 4, minHeight: 28 },
				label: { overflow: "hidden" },
			}}
		/>
	);
}

/** Compact sortable child tab for workspace children. */
function SortableWorkspaceChildTab({
	tab,
	active,
	onNavigate,
	onContextMenu,
	dimmed,
}: {
	tab: RecentTab;
	active: boolean;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	dimmed?: boolean;
}) {
	const navigate = useNavigate();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tabSortId(tab),
	});
	const to =
		tab.type === "chapter" && tab.narratorId
			? `/narrators/${tab.narratorId}`
			: `/narrators/${tab.id}`;
	const iconColor = tab.status
		? mantineVar(statusRegistry.narratorStatus(tab.status).color)
		: undefined;
	const filledStatus = tab.status === "thinking" || tab.status === "error" || tab.status === "done";

	const sortStyle: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		// Both isDragging and dimmed (workspace children following header drag)
		// keep layout space so dnd-kit can compute correct drop positions.
		opacity: isDragging || dimmed ? 0 : 1,
	};

	return (
		<div ref={setNodeRef} {...attributes} {...listeners} style={sortStyle}>
			<NavLink
				active={active}
				label={<Text size="xs">{tab.title}</Text>}
				leftSection={
					tab.type === "chapter" ? (
						<IconGitBranch
							size={14}
							color={iconColor}
							fill={filledStatus ? "currentColor" : "none"}
						/>
					) : filledStatus ? (
						<IconMessageCircleFilled size={14} color={iconColor} />
					) : (
						<IconMessageCircle size={14} color={iconColor} />
					)
				}
				onClick={() => {
					onNavigate?.();
					navigate({ to });
				}}
				onContextMenu={(e) => onContextMenu(e, tab)}
				py={2}
				pl="lg"
				styles={{
					root: { borderRadius: 4, minHeight: 28 },
					label: { overflow: "hidden" },
				}}
			/>
		</div>
	);
}

/**
 * Rendered in DragOverlay while a workspace is being dragged.
 * Shows the workspace title + all its child tabs as a single floating preview.
 */
function DragOverlayWorkspaceItem({
	tab,
	wsChildren,
}: {
	tab: RecentTab;
	wsChildren: RecentTab[];
}) {
	const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
		id: tabSortId(tab),
	});

	const sortStyle: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<Box style={{ ...sortStyle, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", borderRadius: 8 }}>
			<NavLink
				ref={setNodeRef}
				{...attributes}
				{...listeners}
				active={false}
				label={<Text size="sm">{tab.title}</Text>}
				leftSection={<IconColumns size={16} />}
				styles={{
					root: {
						cursor: "grabbing",
						background: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
					},
				}}
			/>
			{wsChildren.map((child) => (
				<WorkspaceChildTab
					key={tabSortId(child)}
					tab={child}
					active={false}
					onContextMenu={() => {}}
				/>
			))}
		</Box>
	);
}

/** Rendered in DragOverlay while a non-workspace tab is being dragged. */
function DragOverlayTabItem({ tab, active }: { tab: RecentTab; active: boolean }) {
	const { t } = useTranslation("common");
	const iconColor = tab.status
		? mantineVar(statusRegistry.narratorStatus(tab.status).color)
		: undefined;
	const filledStatus = tab.status === "thinking" || tab.status === "error" || tab.status === "done";

	return (
		<Box style={{ opacity: 0.9, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", borderRadius: 8 }}>
			<NavLink
				active={active}
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
						<IconFolder size={16} />
					) : tab.type === "chapter" ? (
						<IconGitBranch
							size={16}
							color={iconColor}
							fill={filledStatus ? "currentColor" : "none"}
						/>
					) : filledStatus ? (
						<IconMessageCircleFilled size={16} color={iconColor} />
					) : (
						<IconMessageCircle size={16} color={iconColor} />
					)
				}
				styles={{
					root: {
						cursor: "grabbing",
						...(!active && {
							background: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
						}),
					},
					label: { overflow: "hidden" },
				}}
			/>
		</Box>
	);
}

interface SortableTabItemProps {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	/** When true and active, remove top border-radius to connect with nav above */
	connectTop?: boolean;
	/** Workspace-only: click handler for the "add narrator" button */
	onWsAddClick?: (e: React.MouseEvent, wsId: string) => void;
	/** When true, reduce opacity to indicate the item is being dragged */
	dimmed?: boolean;
}

function SortableTabItem({
	tab,
	active,
	onRemove,
	onNavigate,
	onContextMenu,
	connectTop,
	onWsAddClick,
	dimmed,
}: SortableTabItemProps) {
	const navigate = useNavigate();
	const { t } = useTranslation("common");
	const to =
		tab.type === "project"
			? `/projects/${tab.id}`
			: tab.type === "chapter" && tab.narratorId
				? `/narrators/${tab.narratorId}`
				: tab.type === "workspace"
					? `/narrators/workspace/${tab.id}`
					: `/narrators/${tab.id}`;
	const iconColor = tab.status
		? mantineVar(statusRegistry.narratorStatus(tab.status).color)
		: undefined;
	const filledStatus = tab.status === "thinking" || tab.status === "error" || tab.status === "done";

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tabSortId(tab),
	});

	const sortStyle: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0 : dimmed ? 0.3 : 1,
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

	// Right-click context menu — suppress on touch devices (long-press fires contextmenu)
	const isTouching = useRef(false);
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (isTouching.current) {
				e.preventDefault();
				return;
			}
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
		isTouching.current = true;
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
		// Defer clearing so the contextmenu event (fired after touchend) still sees the flag
		setTimeout(() => {
			isTouching.current = false;
		}, 0);
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

	// Cross-component drag — pointerdown on icon starts a global narrator drag.
	// We use onPointerDown + stopPropagation so @dnd-kit's PointerSensor
	// on the outer div doesn't capture it (pointer events fire before mouse events).
	const dragNarratorId =
		tab.type === "narrator" ? tab.id : tab.type === "chapter" ? tab.narratorId : null;

	const handleIconPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0 || !dragNarratorId) return;
			e.stopPropagation();
			e.preventDefault();
			startNarratorDrag(dragNarratorId, tab.title, e.clientX, e.clientY);
		},
		[dragNarratorId, tab.title],
	);

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
						<span
							onPointerDown={handleIconPointerDown}
							style={{ cursor: dragNarratorId ? "grab" : undefined }}
						>
							{tab.type === "project" ? (
								<IconFolder size={16} />
							) : tab.type === "workspace" ? (
								<IconColumns size={16} />
							) : tab.type === "chapter" ? (
								<IconGitBranch
									size={16}
									color={iconColor}
									fill={filledStatus ? "currentColor" : "none"}
								/>
							) : filledStatus ? (
								<IconMessageCircleFilled size={16} color={iconColor} />
							) : (
								<IconMessageCircle size={16} color={iconColor} />
							)}
						</span>
					}
					rightSection={
						onWsAddClick ? (
							<Tooltip label={t("addToWorkspace")} position="right">
								<ActionIcon
									size="xs"
									variant="subtle"
									onClick={(e: React.MouseEvent) => onWsAddClick(e, tab.id)}
									onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
								>
									<IconPlus size={14} />
								</ActionIcon>
							</Tooltip>
						) : undefined
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
	onReveal: () => void;
	canReveal: boolean;
	isFirst: boolean;
	isWorkspace: boolean;
	t: (key: string) => string;
}

function TabContextMenu({
	x,
	y,
	onClose,
	onMoveToTop,
	onRemove,
	onReveal,
	canReveal,
	isFirst,
	isWorkspace,
	t,
}: TabContextMenuProps) {
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
							<Text size="sm">{t(isWorkspace ? "dissolveWorkspace" : "closeTab")}</Text>
						</Group>
					</UnstyledButton>
					{canReveal && (
						<UnstyledButton px="xs" py={4} onClick={onReveal} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconFolder size={14} />
								<Text size="sm">{t("revealInExplorer")}</Text>
							</Group>
						</UnstyledButton>
					)}
				</Stack>
			</Paper>
		</>
	);
}
