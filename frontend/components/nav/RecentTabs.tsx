import {
	type CollisionDetection,
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragMoveEvent,
	DragOverlay,
	type DragStartEvent,
	type DropAnimationFunctionArguments,
	MouseSensor,
	pointerWithin,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getEffectiveNarratorDisplay, statusRegistry } from "@frontend/lib/status-registry";
import { Z } from "@frontend/lib/z-index";
import {
	ActionIcon,
	Avatar,
	Box,
	Button,
	Center,
	Group,
	Loader,
	NavLink,
	Paper,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { RecentTabsDelta as RecentTabsDeltaFrame } from "@shared/recent-tabs";
import {
	IconArrowUp,
	IconBox,
	IconBrain,
	IconClock,
	IconColumns,
	IconFolder,
	IconGitBranch,
	IconMessageCircle,
	IconMessageCircleFilled,
	IconPencil,
	IconPin,
	IconPinnedOff,
	IconPlus,
	IconRobot,
	IconTerminal2,
	IconUsers,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NarratorListWSEvent } from "../../hooks/useNarratorWS";
import { useFsRevealCapability } from "../../hooks/usePlatform";
import { usePendingTabKey } from "../../hooks/useRecentTabKeyboardNav";
import {
	addRecentTab,
	addRecentTabsBatch,
	applyRecentTabMove,
	applyRecentTabsDelta,
	applyRecentTabsRuntimePatches,
	clampRecentTabText,
	collectRecentTabsDeltaFrame,
	normalizeRecentTabViewers,
	pruneRecentTabsTerminalCountVersions,
	type RecentTab,
	type RecentTabViewer,
	reconcileRecentTabsRuntimePatches,
	refreshRecentTabsLoadedWindow,
	selectRecentTabsLiveWindow,
	shouldApplyRecentTabsRuntimeResponse,
	useRecentTabs,
} from "../../hooks/useRecentTabs";
import { useRecentTabsWS } from "../../hooks/useRecentTabsWS";
import { useSetupWizardGuard } from "../../hooks/useSetupWizardGuard";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { clearFaviconAlert, setFaviconAlert } from "../../lib/favicon";
import { clearNotifiedAttention, triggerNotification } from "../../lib/notification";
import { endDrag, moveDrag, startDragManual, startPointerDrag } from "../../lib/panel-drag";
import type { CreateNarratorResult } from "../narrator/CreateNarratorModal";
import { queuePendingPanel } from "../narrator/workspace/dockview-layout";
import { UserAvatar } from "../UserAvatar";

const CreateNarratorModal = React.lazy(() =>
	import("../narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);

const mantineVar = (color: string) => `var(--mantine-color-${color}-6)`;

function getRecentTabDisplaySubstatus(tab: RecentTab): string[] | undefined {
	// Reasoning has its own corner marker in RecentTabs; don't let it override
	// higher-level session states such as planning for the base icon color.
	return tab.substatus?.includes("reasoning")
		? tab.substatus.filter((tag) => tag !== "reasoning")
		: tab.substatus;
}

function getRecentTabIconColor(tab: RecentTab): string | undefined {
	const substatus = getRecentTabDisplaySubstatus(tab);
	if (!tab.status && !substatus?.length) return undefined;
	return mantineVar(getEffectiveNarratorDisplay(tab.status ?? "idle", substatus).color);
}

function isFilledRecentTabStatus(tab: RecentTab): boolean {
	return (
		tab.status === "working" ||
		!!tab.substatus?.includes("planning") ||
		!!tab.substatus?.includes("error") ||
		!!tab.substatus?.includes("unread")
	);
}

const CONTAINER_STATUS_I18N: Record<string, string> = {
	running: "containerRunning",
	paused: "containerPaused",
	stopped: "containerStopped",
	created: "containerCreated",
	removed: "containerRemoved",
};

const QUERY_KEY = ["user-preferences", "recent-tabs"];
const SWIPE_THRESHOLD = 80;
const PREFETCH_QUERY_GC_TIME_MS = 5 * 60_000;

function getRecentTabNarratorId(tab: RecentTab): string | null {
	if (tab.type === "narrator" || tab.type === "subagent") return tab.id;
	if (tab.type === "chapter") return tab.narratorId ?? null;
	// group tabs have no single narrator (multi-party)
	return null;
}

// Module-level flag: set on dragEnd, cleared on next click capture.
// Prevents the synthetic click after drag from triggering Link navigation.
let justDragged = false;

function tabSortId(tab: RecentTab) {
	return `${tab.type}:${tab.id}`;
}

function workspaceGroupId(tab: RecentTab | undefined): string | null {
	if (!tab) return null;
	if (tab.type === "workspace") return tab.id;
	return tab.workspaceId ?? null;
}

function sameTabOrder(left: RecentTab[], right: RecentTab[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (tabSortId(left[i]) !== tabSortId(right[i])) return false;
	}
	return true;
}

// === Shared hook: WS subscription + cache updates (mount once in root) ===

interface RecentTabsWSProviderProps {
	onNavigate?: () => void;
}

/** Invisible root component that maintains the bounded RecentTabs live window. */
export function RecentTabsWSProvider(_props: RecentTabsWSProviderProps) {
	const { tabs } = useRecentTabs();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { t } = useTranslation("nav");
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const { data: userPrefs } = useUserPreferences();
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const pathnameRef = useRef(pathname);
	pathnameRef.current = pathname;
	const userPrefsRef = useRef(userPrefs);
	userPrefsRef.current = userPrefs;
	const deltaBatchesRef = useRef<Parameters<typeof collectRecentTabsDeltaFrame>[0]>(new Map());

	const liveTabs = useMemo(() => selectRecentTabsLiveWindow(tabs, pathname), [tabs, pathname]);
	const narratorIds = useMemo(
		() => liveTabs.map(getRecentTabNarratorId).filter((id): id is string => !!id),
		[liveTabs],
	);
	const runtimeTargetsKey = JSON.stringify(
		liveTabs.map((tab) => [tabSortId(tab), getRecentTabNarratorId(tab)] as const),
	);
	const runtimeTargets = useMemo(
		() => JSON.parse(runtimeTargetsKey) as Array<[string, string | null]>,
		[runtimeTargetsKey],
	);
	const runtimeKeys = useMemo(() => runtimeTargets.map(([key]) => key), [runtimeTargets]);
	const runtimeNarratorIdsByKey = useMemo(
		() =>
			new Map(
				runtimeTargets.flatMap(([key, narratorId]) =>
					narratorId ? [[key, narratorId] as const] : [],
				),
			),
		[runtimeTargets],
	);
	const runtimeRefreshGenerationRef = useRef(0);
	const terminalCountVersionsRef = useRef(new Map<string, number>());
	const runtimeNarratorIds = useMemo(
		() => new Set(runtimeNarratorIdsByKey.values()),
		[runtimeNarratorIdsByKey],
	);
	const runtimeNarratorIdsRef = useRef(runtimeNarratorIds);
	runtimeNarratorIdsRef.current = runtimeNarratorIds;
	const inFlightRuntimeNarratorIdsRef = useRef(new Map<number, ReadonlySet<string>>());

	const refreshRuntime = useCallback(async () => {
		const requestGeneration = ++runtimeRefreshGenerationRef.current;
		if (runtimeKeys.length === 0) return;
		const requestNarratorIds = new Set(runtimeNarratorIdsByKey.values());
		const terminalCountVersionsAtRequest = new Map(
			[...requestNarratorIds].map((narratorId) => [
				narratorId,
				terminalCountVersionsRef.current.get(narratorId) ?? 0,
			]),
		);
		inFlightRuntimeNarratorIdsRef.current.set(requestGeneration, requestNarratorIds);
		try {
			const result = await api.getRecentTabsRuntime(runtimeKeys);
			if (
				!shouldApplyRecentTabsRuntimeResponse(
					requestGeneration,
					runtimeRefreshGenerationRef.current,
				)
			) {
				return;
			}
			applyRecentTabsRuntimePatches(
				qc,
				reconcileRecentTabsRuntimePatches(
					result.patches,
					runtimeNarratorIdsByKey,
					terminalCountVersionsAtRequest,
					terminalCountVersionsRef.current,
				),
			);
		} finally {
			inFlightRuntimeNarratorIdsRef.current.delete(requestGeneration);
			pruneRecentTabsTerminalCountVersions(
				terminalCountVersionsRef.current,
				runtimeNarratorIdsRef.current,
				inFlightRuntimeNarratorIdsRef.current.values(),
			);
		}
	}, [qc, runtimeKeys, runtimeNarratorIdsByKey]);

	useEffect(() => {
		pruneRecentTabsTerminalCountVersions(
			terminalCountVersionsRef.current,
			runtimeNarratorIds,
			inFlightRuntimeNarratorIdsRef.current.values(),
		);
		void refreshRuntime().catch(() => {});
	}, [refreshRuntime, runtimeNarratorIds]);

	const pendingTabPatchesRef = useRef(new Map<string, Partial<RecentTab>>());
	const tabPatchRafRef = useRef(0);
	const tabPatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flushTabPatches = useCallback(() => {
		if (tabPatchRafRef.current) {
			cancelAnimationFrame(tabPatchRafRef.current);
			tabPatchRafRef.current = 0;
		}
		if (tabPatchTimerRef.current) {
			clearTimeout(tabPatchTimerRef.current);
			tabPatchTimerRef.current = null;
		}
		const pending = pendingTabPatchesRef.current;
		if (pending.size === 0) return;
		pendingTabPatchesRef.current = new Map();
		const patches = tabsRef.current.flatMap((tab) => {
			const narratorId = getRecentTabNarratorId(tab);
			const patch = narratorId ? pending.get(narratorId) : undefined;
			return patch ? [{ key: tabSortId(tab), patch }] : [];
		});
		applyRecentTabsRuntimePatches(qc, patches);
	}, [qc]);

	const scheduleTabPatchFlush = useCallback(() => {
		if (!tabPatchTimerRef.current) tabPatchTimerRef.current = setTimeout(flushTabPatches, 0);
		if (document.visibilityState === "visible" && !tabPatchRafRef.current) {
			tabPatchRafRef.current = requestAnimationFrame(flushTabPatches);
		}
	}, [flushTabPatches]);

	useEffect(() => {
		return () => {
			if (tabPatchRafRef.current) cancelAnimationFrame(tabPatchRafRef.current);
			if (tabPatchTimerRef.current) clearTimeout(tabPatchTimerRef.current);
		};
	}, []);

	const handleWSUpdate = useCallback(
		(narratorId: string, event: NarratorListWSEvent) => {
			const patch: Partial<RecentTab> = {};
			if (event.type === "terminalCount" && event.activeTerminalCount !== undefined) {
				terminalCountVersionsRef.current.set(
					narratorId,
					(terminalCountVersionsRef.current.get(narratorId) ?? 0) + 1,
				);
			}
			if (event.type === "title" && event.title) patch.title = clampRecentTabText(event.title);
			else if (event.type === "status") {
				if (event.status) patch.status = event.status;
				if (event.substatus !== undefined) patch.substatus = event.substatus;
				if (!patch.status && !patch.substatus) return;
			} else if (event.type === "presence" && event.viewers) {
				const normalized = normalizeRecentTabViewers(event.viewers);
				patch.viewers = normalized.viewers;
				patch.viewerCount = normalized.viewerCount;
			} else if (event.type === "terminalCount" && event.activeTerminalCount !== undefined) {
				patch.activeTerminalCount = event.activeTerminalCount;
			} else if (event.type === "containerStatus") patch.containerStatus = event.containerStatus;
			else if (event.type === "draft") patch.hasDraft = !!event.hasDraft;
			else return;

			if (event.type === "status") {
				const isReflecting = event.substatus?.includes("reflecting");
				const shouldNotify =
					!isReflecting && (event.status === "waiting" || event.substatus?.includes("unread"));
				if (isReflecting) {
					setFaviconAlert(narratorId, "reflecting");
				} else if (shouldNotify) {
					const alertKind = event.substatus?.includes("error")
						? "error"
						: event.status === "waiting"
							? "waiting"
							: "unread";
					setFaviconAlert(narratorId, alertKind);
					if (userPrefsRef.current) {
						const tab = tabsRef.current.find((item) => getRecentTabNarratorId(item) === narratorId);
						if (tab) {
							triggerNotification(
								narratorId,
								tab.title,
								event.status === "waiting" ? "waiting" : "unread",
								userPrefsRef.current,
								event.turnStartedAt,
							);
						}
					}
				} else if (event.status !== undefined) {
					clearFaviconAlert(narratorId);
					clearNotifiedAttention(narratorId);
				}
			}

			if (event.type === "status" && event.status === "working") {
				const tab = tabsRef.current.find((item) => getRecentTabNarratorId(item) === narratorId);
				if (tab && tab.status !== "working") {
					const moveKey = tab.workspaceId ? `workspace:${tab.workspaceId}` : tabSortId(tab);
					api
						.moveRecentTab(moveKey, { position: "above_idle" })
						.then((result) => {
							const gaps = applyRecentTabsDelta(qc, result);
							return refreshRecentTabsLoadedWindow(qc, {
								reset: gaps.length > 0,
								minimumRevision: result.revision,
							});
						})
						.catch(() => {});
				}
			}

			const existing = pendingTabPatchesRef.current.get(narratorId);
			pendingTabPatchesRef.current.set(narratorId, existing ? { ...existing, ...patch } : patch);
			scheduleTabPatchFlush();
		},
		[qc, scheduleTabPatchFlush],
	);

	const handleGlobalEvent = useCallback(
		(event: { type: string; [key: string]: unknown }) => {
			if (event.type === "group:ready" && typeof event.groupId === "string") {
				const groupId = event.groupId;
				const title = (event.title as string) || t("groupChat");
				addRecentTab({ type: "group", id: groupId, title });
				notifications.show({
					title: t("groupCreatedTitle"),
					message: t("groupCreatedMessage", { title }),
					color: "grape",
					autoClose: 6000,
					style: { cursor: "pointer" },
					onClick: () => navigate({ to: "/groups/$groupId", params: { groupId } }),
				});
				return;
			}
			if (
				event.type === "user:recent_tabs_delta" &&
				typeof event.baseRevision === "number" &&
				typeof event.revision === "number" &&
				Array.isArray(event.operations)
			) {
				const frame: RecentTabsDeltaFrame = {
					type: "user:recent_tabs_delta",
					baseRevision: event.baseRevision,
					revision: event.revision,
					operations: event.operations as RecentTabsDeltaFrame["operations"],
					batchIndex: typeof event.batchIndex === "number" ? event.batchIndex : 0,
					batchCount: typeof event.batchCount === "number" ? event.batchCount : 1,
				};
				const collected = collectRecentTabsDeltaFrame(deltaBatchesRef.current, frame);
				if (collected.status === "pending") return;
				if (collected.status === "gap") {
					void refreshRecentTabsLoadedWindow(qc, { reset: true }).catch(() => {});
					return;
				}
				const { delta } = collected;
				flushTabPatches();
				const previousTabs = tabsRef.current;
				const gaps = applyRecentTabsDelta(qc, delta);
				void refreshRecentTabsLoadedWindow(qc, {
					reset: gaps.length > 0,
					minimumRevision: delta.revision,
				}).catch(() => {});
				const nextTabs = qc.getQueryData<RecentTab[]>(QUERY_KEY) ?? previousTabs;
				const currentPath = pathnameRef.current;
				if (
					previousTabs.some((tab) => isTabActive(tab, currentPath)) &&
					!nextTabs.some((tab) => isTabActive(tab, currentPath))
				) {
					navigate({ to: "/" });
				}
				if (
					delta.operations.some(
						(operation) => operation.type === "remove" && operation.key.startsWith("project:"),
					)
				) {
					void qc.invalidateQueries({ queryKey: ["projects"] });
				}
				return;
			}
			// Legacy compatibility during rolling upgrades: rebuild loaded windows from revision zero.
			if (event.type === "user:recent_tabs_snapshot") {
				void refreshRecentTabsLoadedWindow(qc, { reset: true }).catch(() => {});
			}
		},
		[flushTabPatches, navigate, qc, t],
	);

	const lastReconnectRefreshRef = useRef(0);
	const handleReconnect = useCallback(() => {
		const now = Date.now();
		if (now - lastReconnectRefreshRef.current < 5000) return;
		lastReconnectRefreshRef.current = now;
		void Promise.all([refreshRecentTabsLoadedWindow(qc), refreshRuntime()]).catch(() => {
			notifications.show({ color: "red", message: t("recentTabsSyncError") });
		});
	}, [qc, refreshRuntime, t]);

	useRecentTabsWS(narratorIds, handleWSUpdate, handleGlobalEvent, handleReconnect);
	return null;
}

// === Filtered tab list component ===

interface RecentTabListProps {
	filter: "project" | "narrator";
	onNavigate?: () => void;
	/** When true, the first tab (if active) removes its top border-radius */
	firstTabConnected?: boolean;
	/** Narrator ID to exclude from active highlighting. */
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
	sortItemsById: Map<string, RecentTab>,
): ReturnType<CollisionDetection> {
	const baseCollisions = pointerWithin(args);
	const collisions = baseCollisions.length > 0 ? baseCollisions : closestCenter(args);
	if (collisions.length === 0) return collisions;

	const first = collisions[0];
	if (!first) return collisions;

	const overTab = sortItemsById.get(String(first.id));
	if (!overTab) return collisions;

	const activeTab = sortItemsById.get(String(args.active.id));
	const overWorkspaceId = workspaceGroupId(overTab);
	const activeChildWorkspaceId = activeTab?.workspaceId ?? null;

	if (activeChildWorkspaceId) {
		if (overWorkspaceId === activeChildWorkspaceId) {
			return collisions;
		}
		return [{ ...first, id: args.active.id }];
	}

	if (!overWorkspaceId) return collisions;

	const wsHeader = sortItemsById.get(`workspace:${overWorkspaceId}`);
	if (!wsHeader) return collisions;

	return [{ ...first, id: tabSortId(wsHeader) }];
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
	const recentTabs = useRecentTabs();
	const { removeTab, moveTab, pinTab } = recentTabs;
	const sectionState = filter === "project" ? recentTabs.projects : recentTabs.work;
	const tabs = sectionState.tabs;
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { t } = useTranslation("nav");
	const requireSetup = useSetupWizardGuard();
	const pendingKey = usePendingTabKey();

	// Stable refs for values used in callbacks — avoids putting `tabs`/`pathname`
	// in useCallback deps which would invalidate React.memo on every WS update.
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const pathnameRef = useRef(pathname);
	pathnameRef.current = pathname;

	const prefetchNarratorTab = useCallback(
		(tab: RecentTab) => {
			const narratorId = getRecentTabNarratorId(tab);
			if (!narratorId) return;

			const narratorKey = ["narrators", narratorId] as const;
			if (
				!qc.getQueryData(narratorKey) &&
				qc.getQueryState(narratorKey)?.fetchStatus !== "fetching"
			) {
				void qc.prefetchQuery({
					queryKey: narratorKey,
					queryFn: () => api.getNarrator(narratorId),
					staleTime: 30_000,
					gcTime: PREFETCH_QUERY_GC_TIME_MS,
				});
			}

			if (tab.type === "chapter" && !qc.getQueryData(["chapters", tab.id])) {
				void qc.prefetchQuery({
					queryKey: ["chapters", tab.id],
					queryFn: () => api.getChapter(tab.id),
					gcTime: PREFETCH_QUERY_GC_TIME_MS,
				});
			}
		},
		[qc],
	);

	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		tab: RecentTab;
	} | null>(null);

	// Workspace "add narrator" modal state
	const [wsCreateTarget, setWsCreateTarget] = useState<string | null>(null);

	// Drag state: the tab currently being dragged (for workspace, tracks the whole group)
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [optimisticTabs, setOptimisticTabs] = useState<RecentTab[] | null>(null);
	// When true, all sortable items skip their transition so the post-drop
	// layout snaps into place without any sliding animation.
	const [dropSnap, setDropSnap] = useState(false);

	const renderTabs = optimisticTabs ?? tabs;

	useEffect(() => {
		if (!optimisticTabs || draggingTabId) return;
		if (sameTabOrder(optimisticTabs, tabs)) {
			setOptimisticTabs(null);
			return;
		}

		const timeout = window.setTimeout(() => {
			setOptimisticTabs(null);
		}, 1000);
		return () => window.clearTimeout(timeout);
	}, [optimisticTabs, tabs, draggingTabId]);

	const filtered = useMemo(
		() =>
			filter === "project"
				? renderTabs.filter((t) => t.type === "project")
				: renderTabs.filter((t) => t.type !== "project"),
		[renderTabs, filter],
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
	// Split into pinned and unpinned groups for separate DnD contexts.
	const { pinnedItems, unpinnedItems } = useMemo(() => {
		const pinned: RecentTab[] = [];
		const unpinned: RecentTab[] = [];
		for (const tab of topLevel) {
			const target = tab.pinned ? pinned : unpinned;
			target.push(tab);
			if (tab.type === "workspace") {
				const children = childrenByWorkspace.get(tab.id) ?? [];
				target.push(...children);
			}
		}
		return { pinnedItems: pinned, unpinnedItems: unpinned };
	}, [topLevel, childrenByWorkspace]);

	// Stable sort-id arrays for SortableContext
	const pinnedSortIds = useMemo(() => pinnedItems.map(tabSortId), [pinnedItems]);
	const unpinnedSortIds = useMemo(() => unpinnedItems.map(tabSortId), [unpinnedItems]);
	const pinnedItemsBySortId = useMemo(
		() => new Map(pinnedItems.map((tab) => [tabSortId(tab), tab])),
		[pinnedItems],
	);
	const unpinnedItemsBySortId = useMemo(
		() => new Map(unpinnedItems.map((tab) => [tabSortId(tab), tab])),
		[unpinnedItems],
	);

	// Helper: for a given sortIdx in a specific group, return the indices of the whole workspace group
	// that the item at that index belongs to (header + all children).
	// Returns a range [startIdx, endIdx] (inclusive).
	// Returns [idx, idx] for non-workspace items.
	const getWorkspaceGroupRange = useCallback(
		(items: RecentTab[], idx: number): [start: number, end: number] => {
			const tab = items[idx];
			if (!tab) return [idx, idx];
			if (tab.type !== "workspace") return [idx, idx];
			// Find the last index of this workspace's children
			let end = idx;
			for (let i = idx + 1; i < items.length; i++) {
				if (items[i].workspaceId === tab.id) end = i;
				else break;
			}
			return [idx, end];
		},
		[],
	);

	// Custom collision detection factory for a specific group
	const pinnedCollisionDetection = useMemo(
		() => (args: Parameters<CollisionDetection>[0]) =>
			workspaceGroupCollisionDetection(args, pinnedItemsBySortId),
		[pinnedItemsBySortId],
	);

	const unpinnedCollisionDetection = useMemo(
		() => (args: Parameters<CollisionDetection>[0]) =>
			workspaceGroupCollisionDetection(args, unpinnedItemsBySortId),
		[unpinnedItemsBySortId],
	);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
	);

	// Height of the workspace group (header + children) measured on drag start.
	// Applied to the header's sortable wrapper when isDragging so dnd-kit reserves
	// the full group height as the gap placeholder.
	const [wsGroupHeight, setWsGroupHeight] = useState<number | null>(null);
	// Workspace ID whose children should stay collapsed (cleared with wsGroupHeight).
	const [collapsedWsId, setCollapsedWsId] = useState<string | null>(null);
	// Track which group (pinned/unpinned) is currently being dragged
	const [activeGroup, setActiveGroup] = useState<"pinned" | "unpinned" | null>(null);

	// Bridge @dnd-kit drag into global narrator drag so workspace panels can receive drops
	const pinnedItemsRef = useRef(pinnedItems);
	pinnedItemsRef.current = pinnedItems;
	const unpinnedItemsRef = useRef(unpinnedItems);
	unpinnedItemsRef.current = unpinnedItems;

	const handleDragStartForGroup = useCallback(
		(group: "pinned" | "unpinned", event: DragStartEvent) => {
			setOptimisticTabs(null);
			const activeId = event.active.id as string;
			setDraggingTabId(activeId);
			setActiveGroup(group);

			const items = group === "pinned" ? pinnedItemsRef.current : unpinnedItemsRef.current;

			// Measure workspace group height before children collapse
			const tab = items.find((t) => tabSortId(t) === activeId);
			if (tab?.type === "workspace") {
				setCollapsedWsId(tab.id);
				const headerEl = document.querySelector(
					`[data-tab-sort-id="${globalThis.CSS.escape(activeId)}"]`,
				) as HTMLElement | null;
				if (headerEl) {
					let totalHeight = headerEl.offsetHeight;
					let sibling = headerEl.nextElementSibling as HTMLElement | null;
					while (sibling) {
						const sibId = sibling.getAttribute("data-tab-sort-id");
						if (!sibId) break;
						const sibTab = items.find((t) => tabSortId(t) === sibId);
						if (!sibTab || sibTab.workspaceId !== tab.id) break;
						totalHeight += sibling.offsetHeight;
						sibling = sibling.nextElementSibling as HTMLElement | null;
					}
					setWsGroupHeight(totalHeight);
				}
			} else {
				setWsGroupHeight(null);
				setCollapsedWsId(null);
			}

			const nId =
				tab?.type === "narrator" ? tab.id : tab?.type === "chapter" ? tab.narratorId : null;
			if (!nId || !tab) return;
			const me = event.activatorEvent as MouseEvent | TouchEvent;
			const x = "clientX" in me ? me.clientX : (me.touches?.[0]?.clientX ?? 0);
			const y = "clientY" in me ? me.clientY : (me.touches?.[0]?.clientY ?? 0);
			startDragManual(nId, tab.title, x, y);
		},
		[],
	);

	const handleDragStartPinned = useCallback(
		(event: DragStartEvent) => handleDragStartForGroup("pinned", event),
		[handleDragStartForGroup],
	);

	const handleDragStartUnpinned = useCallback(
		(event: DragStartEvent) => handleDragStartForGroup("unpinned", event),
		[handleDragStartForGroup],
	);

	const handleDragMove = useCallback((event: DragMoveEvent) => {
		const me = event.activatorEvent as MouseEvent | TouchEvent;
		const baseX = "clientX" in me ? me.clientX : (me.touches?.[0]?.clientX ?? 0);
		const baseY = "clientY" in me ? me.clientY : (me.touches?.[0]?.clientY ?? 0);
		moveDrag(baseX + event.delta.x, baseY + event.delta.y);
	}, []);

	// After a drop, suppress all sortable transitions for one frame so the
	// layout snaps into place without any sliding animation.
	const clearDragState = useCallback(() => {
		setDropSnap(true);
		setDraggingTabId(null);
		setWsGroupHeight(null);
		setCollapsedWsId(null);
		setActiveGroup(null);
		requestAnimationFrame(() => setDropSnap(false));
	}, []);

	// Sort-id of the item being dropped — used by dropAnimation to locate
	// the target DOM element after React re-renders with the optimistic order.
	const dropTargetIdRef = useRef<string | null>(null);

	// Custom drop animation: wait one frame for React to render the optimistic
	// list (with dropSnap killing transitions), then animate the overlay from
	// its current position to the new DOM position of the dropped item.
	const dropAnimation = useCallback(
		(args: DropAnimationFunctionArguments) => {
			const { dragOverlay, transform: currentTransform } = args;
			const node = dragOverlay.node;
			const targetId = dropTargetIdRef.current;
			dropTargetIdRef.current = null;

			return new Promise<void>((resolve) => {
				// Double rAF: the first frame lets React flush the optimistic
				// re-render (with dropSnap killing transitions); the second
				// frame guarantees layout has settled so getBoundingClientRect
				// reflects the element's true position in the new order.
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						const targetEl = targetId
							? (document.querySelector(
									`[data-tab-sort-id="${globalThis.CSS.escape(targetId)}"]`,
								) as HTMLElement | null)
							: null;

						if (!targetEl) {
							clearDragState();
							resolve();
							return;
						}

						// The overlay is position:fixed with top/left set to the
						// drag-start viewport position, plus a CSS transform for
						// the drag delta.  getBoundingClientRect() on the target
						// gives us the destination in viewport coords; subtract
						// the overlay's fixed top/left (without transform) to get
						// the required transform at the end of the animation.
						const targetRect = targetEl.getBoundingClientRect();
						const overlayRect = node.getBoundingClientRect();
						// Current visual position already accounts for currentTransform
						const finalX = currentTransform.x + (targetRect.left - overlayRect.left);
						const finalY = currentTransform.y + (targetRect.top - overlayRect.top);

						if (
							Math.abs(finalX - currentTransform.x) < 1 &&
							Math.abs(finalY - currentTransform.y) < 1
						) {
							clearDragState();
							resolve();
							return;
						}

						// Keyframes must include the current transform as the start
						// so the animation begins at the overlay's actual position
						// rather than snapping to (0,0) which is the fixed top/left.
						const animation = node.animate(
							[
								{
									transform: `translate3d(${currentTransform.x}px, ${currentTransform.y}px, 0)`,
								},
								{ transform: `translate3d(${finalX}px, ${finalY}px, 0)` },
							],
							{ duration: 250, easing: "ease", fill: "forwards" },
						);
						const finish = () => {
							clearDragState();
							resolve();
						};
						animation.onfinish = finish;
						animation.oncancel = finish;
					});
				});
			});
		},
		[clearDragState],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			justDragged = true;
			// Clear on the next tick. The browser fires its synthetic click (if any)
			// synchronously right after mouseup — before this timeout runs — so that
			// click is still suppressed by handleClick. But a reorder drag usually
			// produces NO synthetic click (the element moved / DOM reflowed), and
			// without this reset the flag would linger and swallow the user's next
			// real click on a tab (the "have to click twice" bug).
			setTimeout(() => {
				justDragged = false;
			}, 0);
			// End global narrator drag first — workspace drop handlers run synchronously
			endDrag();

			const { active, over } = event;
			if (!over || active.id === over.id) {
				clearDragState();
				return;
			}

			if (!activeGroup) {
				clearDragState();
				return;
			}

			const items = activeGroup === "pinned" ? pinnedItems : unpinnedItems;

			const oldSortIdx = items.findIndex((t) => tabSortId(t) === active.id);
			const newSortIdx = items.findIndex((t) => tabSortId(t) === over.id);
			if (oldSortIdx === -1 || newSortIdx === -1) {
				clearDragState();
				return;
			}

			const activeTab = items[oldSortIdx];
			if (!activeTab) {
				clearDragState();
				return;
			}

			const [overStart, overEnd] = getWorkspaceGroupRange(items, newSortIdx);
			const movingDown = oldSortIdx < newSortIdx;
			const anchorTab = items[movingDown ? overEnd : overStart];
			if (!anchorTab) {
				clearDragState();
				return;
			}

			const anchorKey = tabSortId(anchorTab);
			const localTarget: { afterKey: string } | { beforeKey: string } = movingDown
				? { afterKey: anchorKey }
				: { beforeKey: anchorKey };

			const optimistic = applyRecentTabMove(renderTabs, tabSortId(activeTab), localTarget);

			// Snap the list to the new order immediately (dropSnap kills transitions).
			// Expand workspace children (clear collapsedWsId) so they occupy layout
			// space, but keep draggingTabId alive so everything stays opacity:0
			// while the overlay animates to the new position.
			setDropSnap(true);
			setOptimisticTabs(optimistic);
			setCollapsedWsId(null);
			setWsGroupHeight(null);
			dropTargetIdRef.current = tabSortId(activeTab);

			moveTab(tabSortId(activeTab), localTarget);
		},
		[
			pinnedItems,
			unpinnedItems,
			activeGroup,
			renderTabs,
			moveTab,
			getWorkspaceGroupRange,
			clearDragState,
		],
	);

	/** Release all child tabs from a workspace and delete the workspace entity. */
	const releaseWorkspace = useCallback(
		async (wsId: string) => {
			// Remove query cache first to prevent 404 errors on the workspace page
			qc.removeQueries({ queryKey: ["workspace", wsId] });
			const children = childrenByWorkspace.get(wsId) ?? [];
			if (children.length > 0) {
				await addRecentTabsBatch(
					children.map((child) => ({
						type: child.type,
						id: child.id,
						title: child.title,
						workspaceId: null,
						updateOnly: true,
					})),
				).catch(() => {});
			}
			await api.deleteWorkspace(wsId).catch(() => {});
		},
		[childrenByWorkspace, qc],
	);

	/** Remove a tab and navigate to dashboard if it was the active page. */
	const handleRemove = useCallback(
		(type: RecentTab["type"], id: string) => {
			const tab = tabsRef.current.find((t) => t.type === type && t.id === id);
			if (tab && isTabActive(tab, pathnameRef.current)) {
				navigate({ to: "/" });
			}
			if (type === "workspace") {
				void releaseWorkspace(id).then(() => removeTab(type, id));
				return;
			}
			removeTab(type, id);
		},
		[removeTab, navigate, releaseWorkspace],
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

	const handlePin = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		pinTab(tabSortId(tab), !tab.pinned);
		setCtxMenu(null);
	}, [ctxMenu, pinTab]);

	const handleCtxClose = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		if (isTabActive(tab, pathnameRef.current)) {
			navigate({ to: "/" });
		}
		if (tab.type === "workspace") {
			void releaseWorkspace(tab.id).then(() => removeTab(tab.type, tab.id));
		} else {
			removeTab(tab.type, tab.id);
		}
		setCtxMenu(null);
	}, [ctxMenu, removeTab, navigate, releaseWorkspace]);

	const fsRevealCapability = useFsRevealCapability();

	const handleReveal = useCallback(async () => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (!fsRevealCapability.supported) return;
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
	}, [ctxMenu, fsRevealCapability.supported]);

	const handleDragCancel = useCallback(() => {
		endDrag();
		setOptimisticTabs(null);
		clearDragState();
	}, [clearDragState]);

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
			// Hand the new narrator off to the Dockview workspace as a pending panel.
			// The DockviewWorkspace drains this on mount/activation and adds the
			// panel via its own layout API, so the sidebar never needs to touch the
			// layout serialization format.
			queuePendingPanel(wsId, { panelType: "narrator", narratorId: data.id });
			// Navigate to the workspace
			navigate({ to: `/narrators/workspace/${wsId}` });
			onNavigate?.();
		},
		[wsCreateTarget, navigate, onNavigate],
	);

	if (topLevel.length === 0) {
		if (sectionState.isLoading) {
			return (
				<Center py="xs">
					<Loader size="xs" />
				</Center>
			);
		}
		if (sectionState.isError) {
			return (
				<Stack gap={2} py={4} align="center">
					<Text size="xs" c="red">
						{t("recentTabsSyncError")}
					</Text>
					<Button size="compact-xs" variant="subtle" onClick={sectionState.retry}>
						{t("retryRecentTabs")}
					</Button>
				</Stack>
			);
		}
		return null;
	}

	// The tab being dragged (may be a workspace header or a child).
	const draggingTab = draggingTabId
		? (pinnedItems.find((t) => tabSortId(t) === draggingTabId) ??
			unpinnedItems.find((t) => tabSortId(t) === draggingTabId) ??
			null)
		: null;

	// Helper to render a group of tabs
	const renderTabGroup = (items: RecentTab[], group: "pinned" | "unpinned") => {
		if (items.length === 0) return null;

		const sortIds = group === "pinned" ? pinnedSortIds : unpinnedSortIds;
		const collisionDetection =
			group === "pinned" ? pinnedCollisionDetection : unpinnedCollisionDetection;
		const onDragStart = group === "pinned" ? handleDragStartPinned : handleDragStartUnpinned;

		return (
			<DndContext
				sensors={sensors}
				collisionDetection={collisionDetection}
				onDragStart={onDragStart}
				onDragMove={handleDragMove}
				onDragEnd={handleDragEnd}
				onDragCancel={handleDragCancel}
			>
				<SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
					{items.map((tab, sortIdx) => {
						const isHeader = !tab.workspaceId;
						const isDraggingThis = tabSortId(tab) === draggingTabId;
						// When a workspace header is being dragged (or animating its drop),
						// keep children invisible — the overlay shows them.
						const isChildOfDraggingWs =
							!isHeader &&
							tab.workspaceId &&
							draggingTab?.type === "workspace" &&
							tab.workspaceId === draggingTab.id;

						// Workspace children use a compact sortable component.
						if (!isHeader) {
							const tabKey = `${tab.type}:${tab.id}`;
							return (
								<SortableWorkspaceChildTab
									key={tabSortId(tab)}
									tab={tab}
									active={
										pendingKey
											? pendingKey === tabKey
											: isTabActive(tab, pathname) &&
												!(excludeActiveNarratorId && tab.id === excludeActiveNarratorId)
									}
									onRemove={handleRemove}
									onNavigate={onNavigate}
									onContextMenu={handleContextMenu}
									onPrefetch={prefetchNarratorTab}
									dimmed={isDraggingThis || !!isChildOfDraggingWs}
									collapsed={!!tab.workspaceId && tab.workspaceId === collapsedWsId}
								/>
							);
						}

						const tabKey = `${tab.type}:${tab.id}`;
						// Only connect top for the visually-first tab: the first pinned tab
						// when the pinned group exists, otherwise the first unpinned tab.
						// (Unpinned items render below the pinned group, so their first tab
						// must NOT connect to the nav header when pinned tabs are present.)
						const shouldConnectTop =
							firstTabConnected &&
							sortIdx === 0 &&
							(group === "pinned" || pinnedItems.length === 0);

						return (
							<SortableTabItem
								key={tabSortId(tab)}
								tab={tab}
								active={
									pendingKey
										? pendingKey === tabKey
										: isTabActive(tab, pathname) &&
											!(excludeActiveNarratorId && tab.id === excludeActiveNarratorId)
								}
								onRemove={handleRemove}
								onNavigate={onNavigate}
								onContextMenu={handleContextMenu}
								onPrefetch={prefetchNarratorTab}
								connectTop={shouldConnectTop}
								onWsAddClick={tab.type === "workspace" ? handleWsAddClick : undefined}
								dimmed={isDraggingThis}
								wsGroupHeight={
									isDraggingThis && tab.type === "workspace"
										? (wsGroupHeight ?? undefined)
										: undefined
								}
							/>
						);
					})}
				</SortableContext>
				{/* Floating overlay while dragging — workspace shows the whole group, others show a single tab. */}
				<DragOverlay dropAnimation={dropAnimation}>
					{draggingTab && activeGroup === group ? (
						draggingTab.type === "workspace" ? (
							<DragOverlayWorkspaceItem
								tab={draggingTab}
								wsChildren={childrenByWorkspace.get(draggingTab.id) ?? []}
							/>
						) : (
							<DragOverlayTabItem tab={draggingTab} active={isTabActive(draggingTab, pathname)} />
						)
					) : null}
				</DragOverlay>
			</DndContext>
		);
	};

	return (
		<Box style={{ overflow: "hidden" }}>
			{/* When dropSnap is true, kill all transitions so items snap into place */}
			{dropSnap && <style>{"[data-tab-sort-id]{transition:none!important}"}</style>}

			{/* Render pinned tabs group */}
			{renderTabGroup(pinnedItems, "pinned")}

			{/* Render unpinned tabs group */}
			{renderTabGroup(unpinnedItems, "unpinned")}

			{sectionState.isError ? (
				<Stack gap={2} py={4} align="center">
					<Text size="xs" c="red">
						{t("recentTabsSyncError")}
					</Text>
					<Button size="compact-xs" variant="subtle" onClick={sectionState.retry}>
						{t("retryRecentTabs")}
					</Button>
				</Stack>
			) : sectionState.hasMore ? (
				<Button
					size="compact-xs"
					variant="subtle"
					fullWidth
					loading={sectionState.isFetchingNextPage}
					onClick={sectionState.loadMore}
				>
					{t("loadMoreRecentTabs")}
				</Button>
			) : (
				<Text size="xs" c="dimmed" ta="center" py={4}>
					{t("allRecentTabsLoaded")}
				</Text>
			)}

			{ctxMenu && (
				<TabContextMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					onClose={() => setCtxMenu(null)}
					onMoveToTop={handleMoveToTop}
					onPin={handlePin}
					isPinned={!!ctxMenu.tab.pinned}
					onRemove={handleCtxClose}
					onReveal={handleReveal}
					canReveal={fsRevealCapability.supported && ctxMenu.tab.type !== "project"}
					isFirst={
						topLevel.findIndex((t) => t.type === ctxMenu.tab.type && t.id === ctxMenu.tab.id) === 0
					}
					isWorkspace={ctxMenu.tab.type === "workspace"}
					t={t}
				/>
			)}
			{wsCreateTarget !== null && (
				<React.Suspense fallback={null}>
					<CreateNarratorModal
						opened={wsCreateTarget !== null}
						onClose={() => setWsCreateTarget(null)}
						onCreated={handleWsNarratorCreated}
					/>
				</React.Suspense>
			)}
		</Box>
	);
}

/** Shared icon component for recent tabs — avoids duplicating icon logic across 4 components. */
function TabIcon({
	tab,
	size,
	iconColor,
	filledStatus,
}: {
	tab: RecentTab;
	size: number;
	iconColor?: string;
	filledStatus: boolean;
}) {
	let icon: React.ReactNode;
	if (tab.type === "project") icon = <IconFolder size={size} />;
	else if (tab.type === "workspace") icon = <IconColumns size={size} />;
	else if (tab.type === "chapter") {
		icon = (
			<IconGitBranch size={size} color={iconColor} fill={filledStatus ? "currentColor" : "none"} />
		);
	} else if (tab.type === "subagent") icon = <IconRobot size={size} color={iconColor} />;
	else if (tab.type === "group") icon = <IconUsers size={size} color={iconColor} />;
	else {
		icon = filledStatus ? (
			<IconMessageCircleFilled size={size} color={iconColor} />
		) : (
			<IconMessageCircle size={size} color={iconColor} />
		);
	}

	const canShowMarker =
		tab.type === "chapter" || tab.type === "narrator" || tab.type === "subagent";
	const showDraft = !!tab.hasDraft && canShowMarker;
	const showReasoning = !!tab.substatus?.includes("reasoning") && canShowMarker;
	const showScheduled = !!tab.isScheduled && canShowMarker;
	if (!showDraft && !showReasoning && !showScheduled) return icon;

	return (
		<Box component="span" pos="relative" style={{ display: "inline-flex", lineHeight: 0 }}>
			{icon}
			{showScheduled && (
				<Box
					component="span"
					style={{
						position: "absolute",
						right: -4,
						bottom: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-indigo-6)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-white)",
						pointerEvents: "none",
					}}
				>
					<IconClock size={7} stroke={2.5} />
				</Box>
			)}
			{showReasoning && (
				<Box
					component="span"
					style={{
						position: "absolute",
						left: -4,
						top: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-grape-light)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-grape-light-color)",
						pointerEvents: "none",
					}}
				>
					<IconBrain size={7} stroke={2.5} />
				</Box>
			)}
			{showDraft && (
				<Box
					component="span"
					style={{
						position: "absolute",
						right: -4,
						top: -4,
						width: 11,
						height: 11,
						borderRadius: "50%",
						background: "var(--mantine-color-yellow-6)",
						border: "1px solid var(--mantine-color-body)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--mantine-color-dark-9)",
						pointerEvents: "none",
					}}
				>
					<IconPencil size={7} stroke={2.5} />
				</Box>
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
	if (tab.type === "workspace") {
		return pathname === `/narrators/workspace/${tab.id}`;
	}
	if (tab.type === "group") {
		return pathname === `/groups/${tab.id}`;
	}
	// narrator and subagent both route to /narrators/:id
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
	const iconColor = getRecentTabIconColor(tab);
	const filledStatus = isFilledRecentTabStatus(tab);

	return (
		<NavLink
			active={active}
			label={<Text size="xs">{tab.title}</Text>}
			leftSection={
				<TabIcon tab={tab} size={14} iconColor={iconColor} filledStatus={filledStatus} />
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
const SortableWorkspaceChildTab = React.memo(function SortableWorkspaceChildTab({
	tab,
	active,
	onRemove,
	onNavigate,
	onContextMenu,
	onPrefetch,
	dimmed,
	collapsed: collapsedProp,
}: {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	onPrefetch?: (tab: RecentTab) => void;
	/** When true, hide the child (opacity 0) — overlay is showing it */
	dimmed?: boolean;
	/** When true, collapse to height 0 so dnd-kit measures header-only gap */
	collapsed?: boolean;
}) {
	const navigate = useNavigate();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tabSortId(tab),
	});

	// Track whether this child was dimmed (collapsed) in the previous render.
	// When transitioning from dimmed→visible we skip the dnd-kit transition
	// so the child snaps back instantly instead of sliding in.
	const wasDimmedRef = useRef(false);
	const skipTransition = !dimmed && wasDimmedRef.current;
	useEffect(() => {
		wasDimmedRef.current = !!dimmed;
	});
	const to =
		tab.type === "chapter" && tab.narratorId
			? `/narrators/${tab.narratorId}`
			: `/narrators/${tab.id}`;
	const iconColor = getRecentTabIconColor(tab);
	const filledStatus = isFilledRecentTabStatus(tab);
	const handlePrefetch = useCallback(() => onPrefetch?.(tab), [onPrefetch, tab]);
	const handleClick = useCallback(() => {
		handlePrefetch();
		onNavigate?.();
		navigate({ to });
	}, [handlePrefetch, navigate, onNavigate, to]);
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			handlePrefetch();
			if (e.button === 1) e.preventDefault();
		},
		[handlePrefetch],
	);

	// When the parent workspace header is being dragged, collapse children to
	// zero height so dnd-kit measures the gap as header-only and the full group
	// height comes from the header's sortable item alone.
	const collapsed = collapsedProp && !isDragging;
	const sortStyle: React.CSSProperties = collapsed
		? { height: 0, overflow: "hidden", opacity: 0, transition: "none" }
		: skipTransition
			? { opacity: dimmed ? 0 : 1, transition: "none" }
			: {
					transform: CSS.Transform.toString(transform),
					transition,
					opacity: isDragging || dimmed ? 0 : 1,
				};

	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			style={sortStyle}
			data-tab-sort-id={tabSortId(tab)}
		>
			<NavLink
				active={active}
				label={<Text size="xs">{tab.title}</Text>}
				leftSection={
					<TabIcon tab={tab} size={14} iconColor={iconColor} filledStatus={filledStatus} />
				}
				onClick={handleClick}
				onPointerEnter={handlePrefetch}
				onFocus={handlePrefetch}
				onMouseDown={handleMouseDown}
				onAuxClick={(e: React.MouseEvent) => {
					if (e.button === 1) {
						e.preventDefault();
						onRemove(tab.type, tab.id);
					}
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
});

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
	return (
		<div style={{ overflow: "hidden" }}>
			<NavLink
				active={false}
				label={
					<Group gap={4} wrap="nowrap" style={{ overflow: "hidden" }}>
						{tab.pinned && <IconPin size={12} style={{ flexShrink: 0, opacity: 0.5 }} />}
						<Text size="sm">{tab.title}</Text>
					</Group>
				}
				leftSection={
					<span>
						<IconColumns size={16} />
					</span>
				}
				styles={{
					root: {
						cursor: "grabbing",
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
		</div>
	);
}

/** Rendered in DragOverlay while a non-workspace tab is being dragged. */
function DragOverlayTabItem({ tab, active }: { tab: RecentTab; active: boolean }) {
	const { t } = useTranslation("common");
	const iconColor = getRecentTabIconColor(tab);
	const filledStatus = isFilledRecentTabStatus(tab);

	return (
		<div style={{ overflow: "hidden" }}>
			<NavLink
				active={active}
				label={
					<Group gap={4} wrap="nowrap" style={{ overflow: "hidden" }}>
						{tab.pinned && <IconPin size={12} style={{ flexShrink: 0, opacity: 0.5 }} />}
						<Text size="sm" truncate>
							{tab.title}
						</Text>
					</Group>
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
					<span>
						<TabIcon tab={tab} size={16} iconColor={iconColor} filledStatus={filledStatus} />
					</span>
				}
				styles={{
					root: {
						cursor: "grabbing",
					},
					label: { overflow: "hidden" },
				}}
			/>
		</div>
	);
}

interface SortableTabItemProps {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	onPrefetch?: (tab: RecentTab) => void;
	/** When true and active, remove top border-radius to connect with nav above */
	connectTop?: boolean;
	/** Workspace-only: click handler for the "add narrator" button */
	onWsAddClick?: (e: React.MouseEvent, wsId: string) => void;
	/** When true, reduce opacity to indicate the item is being dragged */
	dimmed?: boolean;
	/** Measured group height (header + children) — applied when dragging a workspace */
	wsGroupHeight?: number;
}

const SortableTabItem = React.memo(function SortableTabItem({
	tab,
	active,
	onRemove,
	onNavigate,
	onContextMenu,
	onPrefetch,
	connectTop,
	onWsAddClick,
	dimmed,
	wsGroupHeight,
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
					: tab.type === "group"
						? `/groups/${tab.id}`
						: `/narrators/${tab.id}`;
	const iconColor = getRecentTabIconColor(tab);
	const filledStatus = isFilledRecentTabStatus(tab);

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tabSortId(tab),
	});

	const sortStyle: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging || dimmed ? 0 : 1,
		zIndex: isDragging ? 10 : undefined,
		// When dragging a workspace header, reserve the full group height
		// (header + children) so the gap placeholder matches the overlay size.
		...(isDragging && wsGroupHeight ? { height: wsGroupHeight } : {}),
	};

	const handlePrefetch = useCallback(() => onPrefetch?.(tab), [onPrefetch, tab]);

	// Click to navigate — blocked after drag via module-level flag
	const handleClick = useCallback(() => {
		if (justDragged) {
			justDragged = false;
			return;
		}
		handlePrefetch();
		navigate({ to });
		onNavigate?.();
	}, [handlePrefetch, navigate, to, onNavigate]);

	// Middle-click to close — preventDefault on mousedown to suppress autoscroll
	// when the tab list overflows and has a scrollbar.
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			handlePrefetch();
			if (e.button === 1) {
				e.preventDefault();
			}
		},
		[handlePrefetch],
	);
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
		tab.type === "narrator" || tab.type === "subagent"
			? tab.id
			: tab.type === "chapter"
				? tab.narratorId
				: null;

	const handleIconPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0 || !dragNarratorId) return;
			e.stopPropagation();
			e.preventDefault();
			startPointerDrag(dragNarratorId, tab.title, e.clientX, e.clientY);
		},
		[dragNarratorId, tab.title],
	);

	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			style={{ ...sortStyle, overflow: "hidden", touchAction: "pan-y" }}
			data-tab-sort-id={tabSortId(tab)}
		>
			<div style={swipeStyle}>
				<NavLink
					active={active}
					onClick={handleClick}
					onPointerEnter={handlePrefetch}
					onFocus={handlePrefetch}
					onMouseDown={handleMouseDown}
					onAuxClick={handleAuxClick}
					onContextMenu={handleContextMenu}
					onTouchStart={handleTouchStart}
					onTouchMove={handleTouchMove}
					onTouchEnd={handleTouchEnd}
					label={
						<Group gap={4} wrap="nowrap" style={{ overflow: "hidden" }}>
							{tab.pinned && <IconPin size={12} style={{ flexShrink: 0, opacity: 0.5 }} />}
							<Text size="sm" truncate>
								{tab.title}
							</Text>
						</Group>
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
							style={{
								cursor: dragNarratorId ? "grab" : undefined,
								// Give the drag singleton exclusive ownership of the touch
								// gesture (same fix as `.nf-panel-header`): without this the
								// browser claims vertical swipes for scroll and the drag dies.
								touchAction: dragNarratorId ? "none" : undefined,
							}}
						>
							<TabIcon tab={tab} size={16} iconColor={iconColor} filledStatus={filledStatus} />
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
});

// === Indicator components for extra tab info ===

interface TabIndicatorsProps {
	tab: RecentTab;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

function TabIndicators({ tab, t }: TabIndicatorsProps) {
	const viewerCount = tab.viewerCount ?? tab.viewers?.length ?? 0;
	const hasViewers = viewerCount >= 2;
	const hasContainer = tab.type === "chapter" && tab.containerStatus;
	const hasTerminals = (tab.activeTerminalCount ?? 0) > 0;

	if (!hasViewers && !hasContainer && !hasTerminals) return null;

	return (
		<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
			{hasViewers && (
				<ViewerAvatars
					viewers={(tab.viewers ?? []) as RecentTabViewer[]}
					viewerCount={viewerCount}
					t={t}
				/>
			)}
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
	viewerCount: number;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

const MAX_VISIBLE_AVATARS = 3;

function ViewerAvatars({ viewers, viewerCount, t }: ViewerAvatarsProps) {
	const visible = viewers.slice(0, MAX_VISIBLE_AVATARS);
	const overflow = Math.max(0, viewerCount - MAX_VISIBLE_AVATARS);

	return (
		<Tooltip label={t("viewersWatching", { count: viewerCount })} withArrow position="right">
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
	onPin: () => void;
	isPinned: boolean;
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
	onPin,
	isPinned,
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
				style={{ position: "fixed", inset: 0, zIndex: Z.contextMenuBackdrop }}
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
					zIndex: Z.contextMenu,
					minWidth: 140,
				}}
			>
				<Stack gap={2}>
					{!isFirst && !isPinned && (
						<UnstyledButton px="xs" py={4} onClick={onMoveToTop} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconArrowUp size={14} />
								<Text size="sm">{t("moveToTop")}</Text>
							</Group>
						</UnstyledButton>
					)}
					<UnstyledButton px="xs" py={4} onClick={onPin} style={{ borderRadius: 4 }}>
						<Group gap={8} wrap="nowrap">
							{isPinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
							<Text size="sm">{t(isPinned ? "unpinTab" : "pinTab")}</Text>
						</Group>
					</UnstyledButton>
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
