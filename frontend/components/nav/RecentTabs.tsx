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
import {
	applyDirectoryMemberOrder,
	directoryRowId,
	directoryRowKeyBlock,
	directoryRowSortableIds,
	directoryRowSortId,
	groupRecentTabsByDirectory,
	moveDirectoryRow,
	type RecentTabRow,
	resolveDirectoryDropTarget,
	sameRecentTabOrder,
} from "@frontend/hooks/recent-tab-directory-groups";
import { isLoopbackBrowserOrigin } from "@frontend/lib/local-origin";
import {
	getEffectiveNarratorDisplay,
	type StatusShape,
	statusRegistry,
} from "@frontend/lib/status-registry";
import { Z } from "@frontend/lib/z-index";
import {
	ActionIcon,
	Avatar,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Modal,
	NavLink,
	Paper,
	Stack,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { RecentTabsDelta as RecentTabsDeltaFrame } from "@shared/recent-tabs";
import {
	IconArchive,
	IconArrowUp,
	IconBox,
	IconBrain,
	IconCheck,
	IconClock,
	IconColumns,
	IconCopy,
	IconExclamationMark,
	IconFolder,
	IconFolderPlus,
	IconGitBranch,
	IconMessageCircle,
	IconMessageCircleFilled,
	IconPencil,
	IconPin,
	IconPinnedOff,
	IconPlus,
	IconRobot,
	IconShield,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCollapsedTabDirectories } from "../../hooks/useCollapsedTabDirectories";
import { useArchiveNarrator } from "../../hooks/useNarrator";
import type { NarratorListWSEvent } from "../../hooks/useNarratorWS";
import { useFsRevealCapability } from "../../hooks/usePlatform";
import { usePendingTabKey } from "../../hooks/useRecentTabKeyboardNav";
import {
	addRecentTab,
	addRecentTabOrThrow,
	addRecentTabsBatch,
	applyRecentTabMove,
	applyRecentTabsDelta,
	applyRecentTabsDeltaAndFollowUp,
	applyRecentTabsRuntimePatches,
	bumpRecentTabRuntimeVersions,
	clampRecentTabText,
	collectRecentTabsDeltaFrame,
	computeRecentTabOrderMoves,
	normalizeRecentTabViewers,
	pruneRecentTabsRuntimeVersions,
	type RecentTab,
	type RecentTabRuntimeVersions,
	type RecentTabViewer,
	reconcileRecentTabsRuntimePatches,
	refreshRecentTabsLoadedWindow,
	selectRecentTabsLiveWindow,
	shouldApplyRecentTabsRuntimeResponse,
	snapshotRecentTabRuntimeVersions,
	updateRecentTabLocal,
	useRecentTabs,
} from "../../hooks/useRecentTabs";
import { useRecentTabsWS } from "../../hooks/useRecentTabsWS";
import { useSetupWizardGuard } from "../../hooks/useSetupWizardGuard";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { copyTextToClipboard } from "../../lib/clipboard";
import { clearFaviconAlert, setFaviconAlert } from "../../lib/favicon";
import { clearNotifiedAttention, triggerNotification } from "../../lib/notification";
import { endDrag, moveDrag, startDragManual, startPointerDrag } from "../../lib/panel-drag";
import type { CreateNarratorResult } from "../narrator/CreateNarratorModal";

import { UserAvatar } from "../UserAvatar";
import { RecentTabDirectoryRow, type RecentTabDirectoryRowProps } from "./RecentTabDirectoryRow";
import { RecentTabDropIndicator } from "./RecentTabDropIndicator";
import type { RecentTabDropRow, RecentTabDropTarget } from "./recent-tab-drop-target";
/*
 * Imported, NOT re-exported.
 *
 * A convenience `export { … } from "./recent-tabs-logic"` here would keep old import
 * paths working, but it is still a runtime export of this module, so plugin-react puts it
 * in `currentExports` and the boundary breaks exactly as before. Measured: editing
 * `recent-tabs-logic.ts` behind such a re-export still produced
 * `invalidate … ("autoScrollAllowedForPointer" export is incompatible)` and a full page
 * reload. Importers must reach the logic module directly.
 */
import {
	autoScrollAllowedForPointer,
	clampSwipeTravel,
	classifySwipeRelease,
	isTabActive,
	SWIPE_THRESHOLD,
} from "./recent-tabs-logic";
import { useRecentTabExternalDrop } from "./useRecentTabExternalDrop";

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
	return statusRegistry.accentVar(getEffectiveNarratorDisplay(tab.status ?? "idle", substatus), 6);
}

/**
 * The state shape for a tab, or undefined when it has none.
 *
 * Derived from the registry rather than re-enumerated here, so a state that gains a
 * shape tomorrow is picked up automatically — the same contract `isFilledRecentTabStatus`
 * follows for `solidAccent`.
 */
function getRecentTabShape(tab: RecentTab): StatusShape | undefined {
	return getEffectiveNarratorDisplay(tab.status ?? "idle", getRecentTabDisplaySubstatus(tab)).shape;
}

/**
 * Tabler glyph per shape, drawn OVER the centre of the tab's own icon.
 *
 * ⚠️ Not a corner badge. These started as 11px corner dots holding a 7px glyph — the
 * same treatment the draft / reasoning / scheduled markers use — and at that size a
 * shield and an exclamation mark were simply not legible. A shape that cannot be
 * recognised carries no information, so it defeats the whole reason shape was introduced
 * (the palette having no distinguishable hue left; see `StatusShape`).
 *
 * Overlaying the centre buys roughly 2× the glyph size. It works for every tab type,
 * which a composed icon would not: Tabler ships `IconMessageCircleCheck` and
 * `…Exclamation`, but nothing for a shield, and no composed variants at all for the
 * git-branch / robot / users icons the other tab types use.
 */
const SHAPE_MARKERS: Record<StatusShape, { Icon: typeof IconCheck }> = {
	check: { Icon: IconCheck },
	shield: { Icon: IconShield },
	alert: { Icon: IconExclamationMark },
};

/**
 * How much of the host icon the knocked-out glyph occupies.
 *
 * Sized by what the host can hold, not by taste. The tabs render at 14–16px, so a glyph
 * kept "inside" the icon at ~58% came out around 8px — no better than the 7px corner badge
 * it replaced, which was rejected for being unreadable. At 0.62 it lands at 9–10px and a
 * shield is distinguishable from an exclamation mark, while still leaving a rim of the
 * bubble's colour so the hue keeps doing its grouping job.
 */
const SHAPE_GLYPH_RATIO = 0.62;

/**
 * Nudge, as a fraction of icon size, from the icon's geometric centre to the visual centre
 * of the message bubble's round body.
 *
 * Tabler's message-circle is not a centred disc: its body occupies roughly x/y 2.3–20 of
 * the 24-unit viewBox and the remaining bottom strip is the tail. Centring the glyph on the
 * box therefore pushes it down-right and it reads as misaligned. ~4% of the size back along
 * both axes puts it on the body.
 */
const SHAPE_INK_OFFSET = 0.04;

function isFilledRecentTabStatus(tab: RecentTab): boolean {
	const display = getEffectiveNarratorDisplay(
		tab.status ?? "idle",
		getRecentTabDisplaySubstatus(tab),
	);
	// Hollow vs filled is this surface's "idle vs occupied" signal, so a state
	// that owns a solid accent (e.g. waiting for a model) must fill too —
	// otherwise it stays a hollow dot next to idle's hollow dot regardless of hue.
	if (display.solidAccent) return true;
	// A state that draws a SHAPE must fill too, for a hard reason rather than a stylistic
	// one: `ShapeOverlay` knocks its glyph out in white, expecting a solid bubble of the
	// state's colour behind it. On a hollow outline that white glyph would sit on the page
	// background and disappear entirely.
	if (display.shape) return true;
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

/**
 * Horizontal band that a scroll container's auto-scroll is allowed in.
 *
 * The container itself is the inner `overflow:auto` box, which sits inside the navbar's
 * horizontal padding. Gating on its own rect would leave that padding as a dead strip
 * where a drag still inside the sidebar stops scrolling. So the enclosing `<nav>` is
 * preferred when there is one, and the element's own rect is the fallback for any
 * scroll container outside the navbar.
 */
function autoScrollGateRect(element: Element): { left: number; right: number } {
	const nav = element.closest("nav");
	return (nav ?? element).getBoundingClientRect();
}

/** Viewport x of a drag's activator event, or null for non-pointer activations. */
function pointerXFromActivatorEvent(activatorEvent: Event): number | null {
	const e = activatorEvent as MouseEvent | TouchEvent;
	if ("clientX" in e) return e.clientX;
	return e.touches?.[0]?.clientX ?? null;
}
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
	// The serialized form is the dependency for everything runtime-related below, so it
	// must only be recomputed when the live window itself changed — not on every render
	// of a component that re-renders on each narrator status tick.
	const runtimeTargetsKey = useMemo(
		() => JSON.stringify(liveTabs.map((tab) => [tabSortId(tab), getRecentTabNarratorId(tab)])),
		[liveTabs],
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
	// Per-narrator, per-field counters of runtime values already delivered over WS.
	// The runtime endpoint returns a full snapshot of every field, so any field whose
	// counter moved while the request was in flight must not be overwritten by it.
	const runtimeVersionsRef = useRef<RecentTabRuntimeVersions>(new Map());
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
		const versionsAtRequest = snapshotRecentTabRuntimeVersions(
			runtimeVersionsRef.current,
			requestNarratorIds,
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
					versionsAtRequest,
					runtimeVersionsRef.current,
				),
			);
		} finally {
			inFlightRuntimeNarratorIdsRef.current.delete(requestGeneration);
			pruneRecentTabsRuntimeVersions(
				runtimeVersionsRef.current,
				runtimeNarratorIdsRef.current,
				inFlightRuntimeNarratorIdsRef.current.values(),
			);
		}
	}, [qc, runtimeKeys, runtimeNarratorIdsByKey]);

	useEffect(() => {
		pruneRecentTabsRuntimeVersions(
			runtimeVersionsRef.current,
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

			// This WS event is now the freshest source for these fields. An older runtime
			// response must not roll them back (icon colour / filled state lag).
			bumpRecentTabRuntimeVersions(runtimeVersionsRef.current, narratorId, Object.keys(patch));

			if (event.type === "status") {
				const isReflecting = event.substatus?.includes("reflecting");
				/*
				 * A narrator parked until an unavailable model recovers is also
				 * `waiting`, but the user has nothing to act on: no favicon dot, no
				 * sound, no PWA notification. Those channels are reserved for real
				 * attention (the preference behind them is literally "notify when a
				 * narrator needs permission", and the PWA body text says so too).
				 * The panel keeps a persistent in-app notice explaining the wait.
				 */
				const isWaitingForModel = event.substatus?.includes("model_unavailable");
				const shouldNotify =
					!isReflecting &&
					!isWaitingForModel &&
					(event.status === "waiting" || event.substatus?.includes("unread"));
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
						.then((result) => applyRecentTabsDeltaAndFollowUp(qc, result))
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
				void applyRecentTabsDeltaAndFollowUp(qc, delta).catch(() => {});
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
		[flushTabPatches, navigate, qc],
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
	const { t: tn } = useTranslation("narrator");
	const requireSetup = useSetupWizardGuard();
	const pendingKey = usePendingTabKey();
	const { data: userPrefsForGrouping } = useUserPreferences();
	const { isCollapsed: isDirectoryCollapsed, toggle: toggleDirectory } =
		useCollapsedTabDirectories();
	// Only the work section aggregates: project tabs have no working directory at all.
	const groupingEnabled =
		filter === "narrator" && userPrefsForGrouping?.recentTabsGroupMode === "directory";

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

	// Rename / archive-from-context-menu modal state
	const [renameTab, setRenameTab] = useState<{ id: string; title: string } | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [archiveConfirmTab, setArchiveConfirmTab] = useState<{ id: string } | null>(null);
	const archiveNarrator = useArchiveNarrator();

	// Workspace "add narrator" modal state
	const [wsCreateTarget, setWsCreateTarget] = useState<string | null>(null);
	// "New narrator in this directory" modal state (cwd pre-filled from a tab)
	const [newNarratorCwd, setNewNarratorCwd] = useState<string | null>(null);

	// Drag state: the tab currently being dragged (for workspace, tracks the whole group)
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [optimisticTabs, setOptimisticTabs] = useState<RecentTab[] | null>(null);
	// When true, all sortable items skip their transition so the post-drop
	// layout snaps into place without any sliding animation.
	const [dropSnap, setDropSnap] = useState(false);

	const renderTabs = optimisticTabs ?? tabs;

	/**
	 * True while directory mode is replaying a multi-move sequence.
	 *
	 * One aggregated drop can expand into several serial `moveRecentTab` requests, and the
	 * optimistic order must survive all of them. State rather than a ref because the
	 * convergence effect below genuinely depends on it: it arms its fallback timeout only
	 * once the replay finishes, and must re-run when that flips. On a slow connection the
	 * old unconditional timeout fired mid-sequence, so the list snapped back to the old
	 * order and then jumped to the new one.
	 */
	const [dirReplayInFlight, setDirReplayInFlight] = useState(false);

	useEffect(() => {
		if (!optimisticTabs || draggingTabId) return;
		// Compares `dirSortOrder` too: an in-group reorder leaves the flat sequence
		// untouched, so an identity-only check reads as converged immediately and the
		// row springs back for one round trip.
		if (sameRecentTabOrder(optimisticTabs, tabs)) {
			setOptimisticTabs(null);
			return;
		}
		// Still replaying: the server order is legitimately mid-sequence, so waiting is
		// correct and a timeout here would only expose an intermediate state.
		if (dirReplayInFlight) return;

		// Fallback for the case where the server order never converges to the optimistic
		// one (a move was rejected, or another client reordered concurrently). Dropping
		// the mask is the honest outcome: what the server holds is the truth.
		const timeout = window.setTimeout(() => {
			setOptimisticTabs(null);
		}, 1000);
		return () => window.clearTimeout(timeout);
	}, [optimisticTabs, tabs, draggingTabId, dirReplayInFlight]);

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

	/**
	 * Directory-aggregated rows for the unpinned group.
	 *
	 * Built from the unpinned TOP-LEVEL tabs; workspace children are folded into their
	 * header's unit inside `groupRecentTabsByDirectory`, so a workspace the user assembled
	 * by hand is neither scattered into directory groups nor split by a drag.
	 */
	const directoryRows = useMemo(() => {
		if (!groupingEnabled) return [];
		return groupRecentTabsByDirectory(
			topLevel.filter((tab) => !tab.pinned),
			childrenByWorkspace,
		);
	}, [groupingEnabled, topLevel, childrenByWorkspace]);
	const directoryRowsRef = useRef(directoryRows);
	directoryRowsRef.current = directoryRows;
	/** Sortable id currently dragged in directory mode; its unit's children collapse. */
	const [dirDraggingId, setDirDraggingId] = useState<string | null>(null);

	/**
	 * Collapsed state per directory path, resolved once and shared.
	 *
	 * Both the renderer and `directorySortIds` need this answer, and they must not
	 * disagree: registering a sortable id for a row that did not render leaves dnd-kit
	 * with an id it cannot measure. Computing it twice is exactly how the two would
	 * drift, so it is derived here and read from both places.
	 */
	const directoryCollapsedByPath = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const row of directoryRows) {
			if (row.kind !== "directory") continue;
			const containsActive = row.children.some((child) => isTabActive(child, pathname));
			const containsPending =
				!!pendingKey && row.children.some((child) => `${child.type}:${child.id}` === pendingKey);
			map.set(row.path, isDirectoryCollapsed(row.path, { containsActive, containsPending }));
		}
		return map;
	}, [directoryRows, pathname, pendingKey, isDirectoryCollapsed]);

	const directorySortIds = useMemo(
		() =>
			directoryRows.flatMap((row) =>
				directoryRowSortableIds(row, {
					collapsed: row.kind === "directory" ? directoryCollapsedByPath.get(row.path) : undefined,
					dragging:
						row.kind === "directory" ? dirDraggingId === directoryRowId(row.path) : undefined,
				}),
			),
		[directoryRows, directoryCollapsedByPath, dirDraggingId],
	);

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

	/**
	 * Viewport x of the pointer for the in-flight drag, or null when unknown.
	 *
	 * A ref rather than state because it is written on every pointer move and only read
	 * from `canScroll` below — re-rendering the whole tab list per frame is exactly what
	 * this file avoids elsewhere.
	 */
	const dragPointerXRef = useRef<number | null>(null);

	/**
	 * Scope auto-scroll to the sidebar column.
	 *
	 * Without this the tab list keeps scrolling after the pointer has moved onto the
	 * narrator / workspace area, because dnd-kit derives the vertical scroll direction
	 * from the pointer's height alone. See `autoScrollAllowedForPointer`.
	 */
	const autoScrollOptions = useMemo(
		() => ({
			canScroll: (element: Element) =>
				autoScrollAllowedForPointer(dragPointerXRef.current, autoScrollGateRect(element)),
		}),
		[],
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
			// Seed the auto-scroll gate here, not only in onDragMove: the body below
			// returns early for tabs with no narrator, and auto-scroll can already run
			// on the frames before the first move event.
			dragPointerXRef.current = pointerXFromActivatorEvent(event.activatorEvent);

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
		// Feed the auto-scroll gate before moving the panel-drag singleton: dnd-kit runs
		// its auto-scroll effect after this callback, so the x it reads is this frame's.
		dragPointerXRef.current = baseX + event.delta.x;
		moveDrag(baseX + event.delta.x, baseY + event.delta.y);
	}, []);

	// After a drop, suppress all sortable transitions for one frame so the
	// layout snaps into place without any sliding animation.
	const clearDragState = useCallback(() => {
		dragPointerXRef.current = null;
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

	/**
	 * Toggle pinned directly on a tab, for the swipe-left gesture.
	 *
	 * Separate from `handlePin` because that one reads the tab out of the context menu
	 * state, and the swipe path never opens a menu — on touch it cannot: long-press fires
	 * `contextmenu`, which the row swallows.
	 *
	 * Workspace CHILDREN are excluded. Pinning is a top-level ordering concept
	 * (`pinnedItems` / `unpinnedItems` are top-level splits, and children render under
	 * their header), so pinning a child would pull it out of its workspace group.
	 */
	const handleSwipePin = useCallback(
		(tab: RecentTab) => {
			if (tab.workspaceId) return;
			pinTab(tabSortId(tab), !tab.pinned);
		},
		[pinTab],
	);

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

	/**
	 * Resolve the on-disk directory a tab points at: a chapter's worktree, or a
	 * narrator/subagent's cwd. Returns null when the tab has no directory
	 * (workspace, project) or the lookup fails.
	 */
	const resolveTabDirectory = useCallback(async (tab: RecentTab): Promise<string | null> => {
		try {
			if (tab.type === "chapter") {
				const chapter = await api.getChapter(tab.id);
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				return ((chapter as any)?.worktreePath as string | undefined) ?? null;
			}
			if (tab.type === "narrator" || tab.type === "subagent") {
				const narrator = await api.getNarrator(tab.id);
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				return ((narrator as any)?.cwd as string | undefined) ?? null;
			}
		} catch {
			return null;
		}
		return null;
	}, []);

	const handleNewNarratorHere = useCallback(async () => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (!requireSetup()) return;
		const dir = await resolveTabDirectory(tab);
		if (!dir) {
			notifications.show({ color: "red", message: t("newNarratorHereNoDir") });
			return;
		}
		setNewNarratorCwd(dir);
	}, [ctxMenu, requireSetup, resolveTabDirectory, t]);

	const handleNewNarratorHereCreated = useCallback(
		(data: CreateNarratorResult) => {
			setNewNarratorCwd(null);
			addRecentTab({
				type: "narrator",
				id: data.id,
				title: data.title,
				subtitle: data.cwd,
				status: data.status,
			});
			navigate({ to: `/narrators/${data.id}` });
			onNavigate?.();
		},
		[navigate, onNavigate],
	);

	const fsRevealCapability = useFsRevealCapability();
	/**
	 * Reveal opens a file manager window on the *server* host, so it is only offered when
	 * the browser is on that same machine. Remote users would get a silent success (or a
	 * window on someone else's desktop), which is worse than not seeing the option.
	 * The origin cannot change without a page load, so this is computed once.
	 */
	const canRevealFromThisBrowser = useMemo(() => isLoopbackBrowserOrigin(), []);
	const revealAvailable = fsRevealCapability.supported && canRevealFromThisBrowser;

	const handleReveal = useCallback(async () => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (!revealAvailable) return;
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
	}, [ctxMenu, revealAvailable]);

	/** 复制工作目录到剪贴板（chapter/narrator/subagent） */
	const handleCopyCwd = useCallback(async () => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		const dir = await resolveTabDirectory(tab);
		if (!dir) {
			notifications.show({ color: "red", message: t("copyCwdNoDir") });
			return;
		}
		try {
			// 走仓库的剪贴板封装而非直接 navigator.clipboard：私有化部署常以纯 HTTP
			// 访问，此时 Clipboard API 不存在，封装会回落到临时选中的表单控件。
			await copyTextToClipboard(dir);
			notifications.show({ color: "green", message: t("copyCwdSuccess", { path: dir }) });
		} catch {
			notifications.show({ color: "red", message: t("copyCwdFailed") });
		}
	}, [ctxMenu, resolveTabDirectory, t]);

	/** 打开重命名对话框 */
	const handleRename = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (tab.type !== "narrator") return; // 仅叙述者会话可重命名
		setRenameValue(tab.title || "");
		setRenameTab({ id: tab.id, title: tab.title || "" });
	}, [ctxMenu]);

	/** 提交重命名 */
	const handleRenameSubmit = useCallback(async () => {
		if (!renameTab) return;
		const trimmed = renameValue.trim();
		if (!trimmed || trimmed === renameTab.title) {
			setRenameTab(null);
			return;
		}
		setRenaming(true);
		try {
			await api.updateNarratorTitle(renameTab.id, trimmed);
			updateRecentTabLocal("narrator", renameTab.id, { title: trimmed });
			qc.invalidateQueries({ queryKey: ["narrators"] });
			setRenameTab(null);
		} catch {
			// Keep the dialog open. Closing it on failure was indistinguishable from
			// success, so a rename that never happened looked like one the server had
			// accepted and then ignored.
			notifications.show({ message: tn("titleUpdateFailed"), color: "red", autoClose: 4000 });
		} finally {
			setRenaming(false);
		}
	}, [renameTab, renameValue, qc, tn]);

	/** 打开归档确认 */
	const handleArchive = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (tab.type !== "narrator") return;
		setArchiveConfirmTab({ id: tab.id });
	}, [ctxMenu]);

	/** 执行归档 */
	const handleArchiveConfirm = useCallback(() => {
		if (!archiveConfirmTab) return;
		archiveNarrator.mutate(archiveConfirmTab.id);
		setArchiveConfirmTab(null);
	}, [archiveConfirmTab, archiveNarrator]);

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
			// Persist MEMBERSHIP first, then navigate.
			//
			// This used to write the recent-tab row and queue the panel in memory, which is
			// how a sidebar child could end up with no panel anywhere: the row survived and
			// the queued panel did not. The server now writes the panel row and its sidebar
			// projection in one transaction, so there is no half-applied state to leave
			// behind — and no need to add the tab from here at all.
			try {
				await api.addWorkspacePanel(wsId, { kind: "narrator", narratorId: data.id });
			} catch {
				// Nothing was persisted, so nothing has to be undone. Staying put (rather
				// than opening a workspace that does not contain the narrator) is what keeps
				// the sidebar and the surface in agreement.
				notifications.show({ color: "red", message: t("workspaceAddPanelFailed") });
				return;
			}
			void refreshRecentTabsLoadedWindow(qc).catch(() => {});
			navigate({ to: `/narrators/workspace/${wsId}` });
			onNavigate?.();
		},
		[wsCreateTarget, navigate, onNavigate, qc, t],
	);

	// ── Directory-mode drag and drop ───────────────────────────────────────────
	//
	// The aggregated order is DERIVED from the server's flat order, so a drop cannot be
	// persisted directly ("third slot inside a derived group" is not a before/after key).
	// Instead the drop is translated twice: `moveDirectoryRow` permutes the visible rows,
	// then `computeRecentTabOrderMoves` replays that permutation as flat before/after
	// moves — the exact primitive the server persists. `finalTabs` from the same call is
	// what the cache converges to, so it is shown optimistically and the order does not
	// snap back while the moves are replayed one by one.

	const directoryCollisionDetection = useCallback((args: Parameters<CollisionDetection>[0]) => {
		const base = pointerWithin(args);
		const collisions = base.length > 0 ? base : closestCenter(args);
		if (collisions.length === 0) return collisions;
		const first = collisions[0];
		const resolved = resolveDirectoryDropTarget(
			directoryRowsRef.current,
			String(args.active.id),
			String(first.id),
		);
		return [{ ...first, id: resolved }];
	}, []);

	/**
	 * Pointer travel direction for the in-flight directory drag.
	 *
	 * `moveDirectoryRow` needs it because the drop anchor is collapsed to a group HEADER,
	 * which loses where inside a multi-row group the pointer was. Kept in a ref because
	 * it is written on every pointer move and only read once, at drop.
	 */
	const dirDragDirectionRef = useRef<"up" | "down">("down");

	const handleDirectoryDragMove = useCallback(
		(event: DragMoveEvent) => {
			if (event.delta.y !== 0) dirDragDirectionRef.current = event.delta.y > 0 ? "down" : "up";
			handleDragMove(event);
		},
		[handleDragMove],
	);

	const handleDirectoryDragStart = useCallback((event: DragStartEvent) => {
		setOptimisticTabs(null);
		const activeId = String(event.active.id);
		setDirDraggingId(activeId);
		dirDragDirectionRef.current = "down";
		dragPointerXRef.current = pointerXFromActivatorEvent(event.activatorEvent);
		// Bridge into the workspace-panel drag singleton, same as the flat handler.
		const tab = findDirectoryRowTab(directoryRowsRef.current, activeId);
		const nId =
			tab?.type === "narrator" || tab?.type === "subagent"
				? tab.id
				: tab?.type === "chapter"
					? tab.narratorId
					: null;
		if (!tab || !nId) return;
		const me = event.activatorEvent as MouseEvent | TouchEvent;
		const x = "clientX" in me ? me.clientX : (me.touches?.[0]?.clientX ?? 0);
		const y = "clientY" in me ? me.clientY : (me.touches?.[0]?.clientY ?? 0);
		startDragManual(nId, tab.title, x, y);
	}, []);

	const handleDirectoryDragCancel = useCallback(() => {
		endDrag();
		dragPointerXRef.current = null;
		setDirDraggingId(null);
		setOptimisticTabs(null);
	}, []);

	const handleDirectoryDragEnd = useCallback(
		(event: DragEndEvent) => {
			justDragged = true;
			setTimeout(() => {
				justDragged = false;
			}, 0);
			endDrag();
			dragPointerXRef.current = null;
			setDirDraggingId(null);

			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const rows = directoryRowsRef.current;
			const activeId = String(active.id);
			const nextRows = moveDirectoryRow(
				rows,
				activeId,
				String(over.id),
				dirDragDirectionRef.current,
			);
			if (!nextRows) return;

			// A reorder INSIDE one directory group is persisted as that group's member
			// order, never as flat moves. Flat moves would have to shuffle the recency
			// order to express it, and `above_idle` rewrites that order the moment any
			// member starts working — which is why hand-ordering never used to survive.
			const memberRow = findDirectoryMemberRow(nextRows, activeId);
			if (memberRow) {
				const keys = memberRow.children.map((child) => `${child.type}:${child.id}`);
				setDropSnap(true);
				setOptimisticTabs(applyDirectoryMemberOrder(tabsRef.current, keys));
				requestAnimationFrame(() => setDropSnap(false));
				void api
					.setRecentTabDirectoryOrder(keys)
					.then((result) => applyRecentTabsDeltaAndFollowUp(qc, result))
					.catch(() => {
						notifications.show({ color: "red", message: t("recentTabsReorderFailed") });
						void refreshRecentTabsLoadedWindow(qc, { reset: true }).catch(() => {});
					});
				return;
			}

			const { moves, finalTabs } = computeRecentTabOrderMoves(
				tabsRef.current,
				nextRows.map(directoryRowKeyBlock),
			);
			if (moves.length === 0) return;

			// Show the converged order at once; the moves below then persist it. The
			// intermediate server states never flash because optimisticTabs masks them
			// until the real order matches (same contract as the flat handler).
			setDropSnap(true);
			setOptimisticTabs(finalTabs);
			requestAnimationFrame(() => setDropSnap(false));

			setDirReplayInFlight(true);
			void (async () => {
				try {
					let resetNeeded = false;
					let backfillNeeded = false;
					let lastRevision: number | undefined;
					for (const move of moves) {
						const result = await api.moveRecentTab(
							move.key,
							move.beforeKey
								? { beforeKey: move.beforeKey }
								: { afterKey: move.afterKey as string },
						);
						const applied = applyRecentTabsDelta(qc, result);
						if (applied.gaps.length > 0) resetNeeded = true;
						if (applied.backfill.length > 0) backfillNeeded = true;
						lastRevision = result.revision;
					}
					// One follow-up for the whole replay, and only when a move could not be
					// applied locally: a pure reorder never changes which rows are loaded.
					if (resetNeeded || backfillNeeded) {
						await refreshRecentTabsLoadedWindow(qc, {
							reset: resetNeeded,
							minimumRevision: lastRevision,
						});
					}
				} catch {
					// A failed move leaves the server order HALF-REPLAYED, so resync rather
					// than trusting the optimistic order or the partial cache. The user must
					// be told: the list is about to settle into an order that is neither what
					// they had nor what they asked for, and silently doing that reads as the
					// drag having been ignored at random.
					notifications.show({ color: "red", message: t("recentTabsReorderFailed") });
					await refreshRecentTabsLoadedWindow(qc, { reset: true }).catch(() => {});
				} finally {
					// Releases the convergence effect to arm its fallback timeout.
					setDirReplayInFlight(false);
				}
			})();
		},
		[qc, t],
	);

	/**
	 * The empty-section body, or null when there are tabs to render.
	 *
	 * Computed rather than returned early: the external-drop hook below must run on every
	 * render (rules of hooks), and an EMPTY section is precisely a state that has to accept
	 * a drop — a fresh install or a just-cleared sidebar is where dragging a narrator in is
	 * most useful. Returning before the hook would have made those the only cases it never
	 * armed for.
	 */
	const emptyBody =
		topLevel.length > 0 ? null : sectionState.isLoading ? (
			<Center py="xs">
				<Loader size="xs" />
			</Center>
		) : sectionState.isError ? (
			<Stack gap={2} py={4} align="center">
				<Text size="xs" c="red">
					{t("recentTabsSyncError")}
				</Text>
				<Button size="compact-xs" variant="subtle" onClick={sectionState.retry}>
					{t("retryRecentTabs")}
				</Button>
			</Stack>
		) : null;

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
				autoScroll={autoScrollOptions}
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
								onTogglePin={handleSwipePin}
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
				{/*
				 * `pointerEvents: none` is load-bearing, not cosmetic. dnd-kit renders this
				 * ghost as `position: fixed` under the pointer and tracks the gesture on
				 * document, so it never needs hits itself — but while it is hittable it is
				 * the topmost element at every release point, and the drop targets that ask
				 * the DOM "what is under the pointer" (dockview surfaces, the graph canvas)
				 * all see the ghost instead of themselves.
				 */}
				<DragOverlay dropAnimation={dropAnimation} style={{ pointerEvents: "none" }}>
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

	/** Active/highlight state for a row, shared by both render paths. */
	const isRowActive = (tab: RecentTab) => {
		const tabKey = `${tab.type}:${tab.id}`;
		return pendingKey
			? pendingKey === tabKey
			: isTabActive(tab, pathname) &&
					!(excludeActiveNarratorId && tab.id === excludeActiveNarratorId);
	};

	/**
	 * Directory-aggregated renderer for the unpinned group. Every unit is sortable:
	 * plain tabs and directory members move individually (members only within their own
	 * group — membership comes from the cwd, not the position), directory headers move
	 * the whole group, and workspace headers move the whole workspace, whose children
	 * stay static because a workspace is a structure the user built by hand.
	 */
	const renderDirectoryRows = (rows: RecentTabRow[]) => {
		if (rows.length === 0) return null;
		const connectTopEligible = firstTabConnected && pinnedItems.length === 0;

		return rows.map((row, rowIdx) => {
			if (row.kind === "tab") {
				const tab = row.tab;
				return (
					<SortableTabItem
						key={tabSortId(tab)}
						tab={tab}
						active={isRowActive(tab)}
						onRemove={handleRemove}
						onTogglePin={handleSwipePin}
						onNavigate={onNavigate}
						onContextMenu={handleContextMenu}
						onPrefetch={prefetchNarratorTab}
						connectTop={connectTopEligible && rowIdx === 0}
					/>
				);
			}

			if (row.kind === "workspace") {
				const draggingThis = dirDraggingId === tabSortId(row.tab);
				return (
					<React.Fragment key={tabSortId(row.tab)}>
						<SortableTabItem
							tab={row.tab}
							active={isRowActive(row.tab)}
							onRemove={handleRemove}
							onTogglePin={handleSwipePin}
							onNavigate={onNavigate}
							onContextMenu={handleContextMenu}
							onPrefetch={prefetchNarratorTab}
							connectTop={connectTopEligible && rowIdx === 0}
							onWsAddClick={handleWsAddClick}
						/>
						{/* Children are not individually sortable here; they collapse while the
						    header is dragged so the drop gap measures as one header. */}
						<div style={draggingThis ? { height: 0, overflow: "hidden" } : undefined}>
							{row.children.map((child) => (
								<StaticTabItem
									key={tabSortId(child)}
									tab={child}
									active={isRowActive(child)}
									onRemove={handleRemove}
									onNavigate={onNavigate}
									onContextMenu={handleContextMenu}
									onPrefetch={prefetchNarratorTab}
									indent
								/>
							))}
						</div>
					</React.Fragment>
				);
			}

			const containsActive = row.children.some((child) => isTabActive(child, pathname));
			const containsPending =
				!!pendingKey && row.children.some((child) => `${child.type}:${child.id}` === pendingKey);
			// Read the SHARED resolution rather than calling `isDirectoryCollapsed` again:
			// `directorySortIds` registers member ids based on that map, and a second
			// evaluation here could disagree and register ids for rows that never rendered.
			const collapsed = directoryCollapsedByPath.get(row.path) ?? true;
			const draggingThis = dirDraggingId === directoryRowId(row.path);

			return (
				<React.Fragment key={directoryRowId(row.path)}>
					<SortableDirectoryRow
						path={row.path}
						label={row.label}
						tabs={row.children}
						collapsed={collapsed}
						active={collapsed && row.children.some((child) => isRowActive(child))}
						onToggle={(path) => toggleDirectory(path, { containsActive, containsPending })}
						connectTop={connectTopEligible && rowIdx === 0}
						t={t}
					/>
					{!collapsed && (
						<div style={draggingThis ? { height: 0, overflow: "hidden" } : undefined}>
							{row.children.map((child) => (
								<SortableTabItem
									key={tabSortId(child)}
									tab={child}
									active={isRowActive(child)}
									onRemove={handleRemove}
									// Pinning a member lifts it out of the group into the pinned
									// section — what "pin" means everywhere else in the list.
									onTogglePin={handleSwipePin}
									onNavigate={onNavigate}
									onContextMenu={handleContextMenu}
									onPrefetch={prefetchNarratorTab}
									// The path lives on the header above; repeating it per member is
									// exactly what this mode exists to stop.
									hideSubtitle
									indent
								/>
							))}
						</div>
					)}
				</React.Fragment>
			);
		});
	};

	// ── External drop: a narrator dragged in from the list page ────────────────
	//
	// Not part of the DndContexts above: their sortable ids come from the tabs that already
	// exist, so a narrator that is not a tab yet can never be an `active` item there. This
	// rides the `panel-drag` singleton instead (see `useRecentTabExternalDrop`).

	const listBoxRef = useRef<HTMLDivElement | null>(null);

	/**
	 * Measure the rendered rows in viewport coordinates.
	 *
	 * Read from the DOM rather than computed from the tab arrays: only the DOM knows the
	 * real geometry after collapsed directories, workspace children and variable row
	 * heights. `data-tab-sort-id` is already on every row variant, so no new markup is
	 * needed — and a row that did not render simply is not measured, which is the correct
	 * answer for a collapsed group's members.
	 */
	const measureDropRows = useCallback((): RecentTabDropRow[] => {
		const container = listBoxRef.current;
		if (!container) return [];
		const pinnedKeys = new Set(pinnedItemsRef.current.map(tabSortId));
		const blockByRowId = new Map<string, string[]>();
		for (const row of directoryRowsRef.current) {
			blockByRowId.set(directoryRowSortId(row), directoryRowKeyBlock(row));
		}
		const tabsById = new Map(
			[...pinnedItemsRef.current, ...unpinnedItemsRef.current].map((tab) => [tabSortId(tab), tab]),
		);
		const rows: RecentTabDropRow[] = [];
		for (const element of container.querySelectorAll<HTMLElement>("[data-tab-sort-id]")) {
			const key = element.dataset.tabSortId;
			if (!key) continue;
			const rect = element.getBoundingClientRect();
			// A zero-height row is a collapsed workspace child (squashed during an internal
			// drag). Including it would give the pointer a target with no area, and several
			// coincident ones make the resolved slot arbitrary.
			if (rect.height <= 0) continue;
			const tab = tabsById.get(key);
			const directoryBlock = blockByRowId.get(key);
			// A directory row has no tab of its own; its members' keys ARE its block. Members
			// rendered under an expanded header share that block so an anchor next to any of
			// them lands outside the group rather than splitting it.
			const memberBlock = directoryRowsRef.current
				.filter((row) => row.kind === "directory")
				.find((row) => row.children.some((child) => tabSortId(child) === key));
			const keyBlock = directoryBlock ??
				(memberBlock ? directoryRowKeyBlock(memberBlock) : undefined) ?? [key];
			rows.push({
				key,
				top: rect.top,
				bottom: rect.bottom,
				pinned: pinnedKeys.has(key),
				...(tab ? { workspaceId: workspaceGroupId(tab) ?? undefined } : {}),
				keyBlock,
			});
		}
		return rows;
	}, []);

	const handleExternalDrop = useCallback(
		({
			narratorId,
			title,
			target,
		}: {
			narratorId: string;
			title: string;
			target: RecentTabDropTarget;
		}) => {
			const cached = findCachedNarratorSummary(qc, narratorId);
			const tab = {
				type: "narrator" as const,
				id: narratorId,
				title: cached?.title || title || "",
				// `cwd` becomes the tab's subtitle, which is also what directory grouping keys
				// on — and it is NOT a runtime field, so nothing backfills it later. A tab
				// created without it stays subtitle-less (and ungroupable) until the narrator
				// is visited, which is why the lookup below also reads the paginated cache.
				...(cached?.cwd ? { subtitle: cached.cwd } : {}),
				...(cached?.status ? { status: cached.status } : {}),
			};

			if (target.kind === "workspace") {
				const workspaceId = target.workspaceId;
				// A drop onto a workspace is a MEMBERSHIP change, so it goes to the panel
				// endpoint — which writes the row and the sidebar grouping together. The old
				// path wrote the tab here and queued the panel in memory, which is how the two
				// could end up disagreeing for good.
				void api
					.addWorkspacePanel(workspaceId, { kind: "narrator", narratorId })
					.then(() => {
						// The projection changed server-side; pull the authoritative window so the
						// tab appears under its new header without a second write from here.
						void refreshRecentTabsLoadedWindow(qc).catch(() => {});
						navigate({ to: "/narrators/workspace/$workspaceId", params: { workspaceId } });
						onNavigate?.();
					})
					.catch(() => {
						notifications.show({ color: "red", message: t("workspaceAddPanelFailed") });
					});
				return;
			}

			// An empty section has no anchor to name; the default insertion point in an empty
			// list is the first slot, which is the only position there is.
			const anchor =
				target.kind === "empty"
					? undefined
					: target.kind === "before"
						? { beforeKey: target.key }
						: { afterKey: target.key };
			void addRecentTabOrThrow(tab, anchor).catch(() => {
				notifications.show({ color: "red", message: t("recentTabsReorderFailed") });
			});
		},
		[navigate, onNavigate, qc, t],
	);

	const externalDrop = useRecentTabExternalDrop({
		containerRef: listBoxRef,
		// Project tabs are not narrators, so that section has nothing to accept.
		enabled: filter === "narrator",
		// An internal reorder is bridged into the same singleton, so without this gate one
		// drop would be handled twice — by @dnd-kit and by this hook.
		suspended: draggingTabId !== null || dirDraggingId !== null,
		measureRows: measureDropRows,
		onDrop: handleExternalDrop,
	});

	/** Floating preview while dragging in directory mode: header-only for a group. */
	let directoryOverlay: React.ReactNode = null;
	if (dirDraggingId) {
		const dirRow = directoryRows.find(
			(r) => r.kind === "directory" && directoryRowId(r.path) === dirDraggingId,
		);
		if (dirRow?.kind === "directory") {
			directoryOverlay = (
				<RecentTabDirectoryRow
					path={dirRow.path}
					label={dirRow.label}
					tabs={dirRow.children}
					collapsed
					active={false}
					onToggle={() => {}}
					t={t}
				/>
			);
		} else {
			const tab = findDirectoryRowTab(directoryRows, dirDraggingId);
			if (tab) {
				directoryOverlay = <DragOverlayTabItem tab={tab} active={isTabActive(tab, pathname)} />;
			}
		}
	}

	if (topLevel.length === 0) {
		return (
			<Box
				ref={listBoxRef}
				style={{
					overflow: "hidden",
					position: "relative",
					// An empty section is content-sized, i.e. zero-height, so the drop hit test
					// would never match and dragging a narrator into a freshly cleared sidebar
					// could not work. Reserve one row's worth of area for it — but only where a
					// drop is actually accepted, so the projects section stays flush.
					...(filter === "narrator" ? { minHeight: 44 } : {}),
				}}
			>
				{emptyBody}
				{externalDrop && (
					<RecentTabDropIndicator
						rows={externalDrop.rows}
						target={externalDrop.target}
						containerTop={externalDrop.containerTop}
					/>
				)}
			</Box>
		);
	}

	return (
		// `position: relative` anchors the external-drop indicator, which is absolutely
		// positioned over the rows.
		<Box ref={listBoxRef} style={{ overflow: "hidden", position: "relative" }}>
			{/* When dropSnap is true, kill all transitions so items snap into place */}
			{dropSnap && <style>{"[data-tab-sort-id]{transition:none!important}"}</style>}

			{externalDrop && (
				<RecentTabDropIndicator
					rows={externalDrop.rows}
					target={externalDrop.target}
					containerTop={externalDrop.containerTop}
				/>
			)}

			{/* Render pinned tabs group — always flat, always sortable */}
			{renderTabGroup(pinnedItems, "pinned")}

			{/* Render unpinned tabs group */}
			{groupingEnabled ? (
				<DndContext
					sensors={sensors}
					collisionDetection={directoryCollisionDetection}
					autoScroll={autoScrollOptions}
					onDragStart={handleDirectoryDragStart}
					onDragMove={handleDirectoryDragMove}
					onDragEnd={handleDirectoryDragEnd}
					onDragCancel={handleDirectoryDragCancel}
				>
					<SortableContext items={directorySortIds} strategy={verticalListSortingStrategy}>
						{renderDirectoryRows(directoryRows)}
					</SortableContext>
					{/* See the pointerEvents note on the flat group's DragOverlay above. */}
					<DragOverlay style={{ pointerEvents: "none" }}>{directoryOverlay}</DragOverlay>
				</DndContext>
			) : (
				renderTabGroup(unpinnedItems, "unpinned")
			)}

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
			) : null}

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
					canReveal={revealAvailable && ctxMenu.tab.type !== "project"}
					onNewNarratorHere={handleNewNarratorHere}
					canNewNarratorHere={
						ctxMenu.tab.type === "chapter" ||
						ctxMenu.tab.type === "narrator" ||
						ctxMenu.tab.type === "subagent"
					}
					onCopyCwd={handleCopyCwd}
					canCopyCwd={["chapter", "narrator", "subagent"].includes(ctxMenu.tab.type)}
					onRename={handleRename}
					canRename={ctxMenu.tab.type === "narrator"}
					onArchive={handleArchive}
					canArchive={ctxMenu.tab.type === "narrator"}
					isFirst={
						topLevel.findIndex((t) => t.type === ctxMenu.tab.type && t.id === ctxMenu.tab.id) === 0
					}
					isWorkspace={ctxMenu.tab.type === "workspace"}
					t={t}
				/>
			)}
			<Modal
				opened={!!renameTab}
				onClose={() => setRenameTab(null)}
				title={t("rename")}
				centered
				size="sm"
			>
				<TextInput
					value={renameValue}
					onChange={(e) => setRenameValue(e.currentTarget.value)}
					onKeyDown={(e) => {
						// Enter while an IME candidate is open commits the word, not the rename.
						if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleRenameSubmit();
						if (e.key === "Escape") setRenameTab(null);
					}}
					data-autofocus
				/>
				<Group justify="flex-end" mt="md">
					<Button variant="default" onClick={() => setRenameTab(null)}>
						{t("cancel")}
					</Button>
					<Button loading={renaming} onClick={() => void handleRenameSubmit()}>
						{t("rename")}
					</Button>
				</Group>
			</Modal>
			<Modal
				opened={!!archiveConfirmTab}
				onClose={() => setArchiveConfirmTab(null)}
				title={tn("archiveNarrator")}
				centered
				size="sm"
			>
				<Text size="sm">{tn("archiveActiveWarning")}</Text>
				<Group justify="flex-end" mt="md">
					<Button variant="default" onClick={() => setArchiveConfirmTab(null)}>
						{t("cancel")}
					</Button>
					<Button color="orange" loading={archiveNarrator.isPending} onClick={handleArchiveConfirm}>
						{tn("confirmArchive")}
					</Button>
				</Group>
			</Modal>
			{wsCreateTarget !== null && (
				<React.Suspense fallback={null}>
					<CreateNarratorModal
						opened={wsCreateTarget !== null}
						onClose={() => setWsCreateTarget(null)}
						onCreated={handleWsNarratorCreated}
					/>
				</React.Suspense>
			)}
			{newNarratorCwd !== null && (
				<React.Suspense fallback={null}>
					<CreateNarratorModal
						opened={newNarratorCwd !== null}
						initialCwd={newNarratorCwd}
						onClose={() => setNewNarratorCwd(null)}
						onCreated={handleNewNarratorHereCreated}
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
	// The state SHAPE (tick / shield / alert), knocked out of the middle of the icon. The
	// palette had no hue left to distinguish these states (see `StatusShape`), so shape
	// carries the difference instead.
	//
	// Restricted to the narrator bubble, and only once it is filled, because the glyph is
	// white and supplies no body of its own — it needs solid colour behind it. The chapter
	// and subagent icons are Tabler OUTLINE glyphs (git-branch, robot: stroke only, no
	// closed shape), so a white glyph there would land on the page background and disappear.
	// `IconGitBranch`'s `fill` only tints its three small nodes, which is not a body either.
	const canShowShape = tab.type === "narrator" && filledStatus;
	const shape = canShowShape ? getRecentTabShape(tab) : undefined;
	if (!showDraft && !showReasoning && !showScheduled && !shape) return icon;

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
			{/* State shape, centred OVER the tab icon rather than tucked into a corner —
			    see SHAPE_MARKERS on why a corner badge was too small to read. The three
			    corner markers stay where they are; this one owns the middle.

			    `needsBacking` is false only for the narrator bubble, the one tab type whose
			    icon is a genuinely FILLED shape the white glyph can be cut out of. */}
			{shape && <ShapeOverlay shape={shape} size={size} />}
		</Box>
	);
}

/**
 * The state shape, knocked out in WHITE from the middle of the tab's filled bubble.
 *
 * ── WHY THERE IS NO BACKGROUND HERE ───────────────────────────────────────────
 * Two earlier attempts went wrong in opposite directions, and both are worth recording
 * because the pull toward each is still there:
 *
 *  1. A 7px badge in the corner. Too small to tell a shield from an exclamation mark.
 *  2. A filled disc the full size of the icon. This one looked worse: the bubble's ink only
 *     covers about three quarters of its box (the rest is the tail and padding), so a
 *     full-size disc buried the bubble AND spilled past its edge — a blob stuck onto the
 *     tab rather than a symbol inside it. It also appeared off-centre, because the box
 *     centre is not the bubble's centre.
 *
 * What works is to add no body at all. The bubble is already solid in the state's colour
 * (`isFilledRecentTabStatus` guarantees it for any state carrying a shape), so the glyph is
 * cut out of the colour that is already there. Nothing to align, nothing to cover.
 *
 * `pointerEvents: none` because the whole icon is one click target; the glyph must not
 * become a dead spot in the middle of it.
 */
function ShapeOverlay({ shape, size }: { shape: StatusShape; size: number }) {
	const { Icon } = SHAPE_MARKERS[shape];
	return (
		<Box
			component="span"
			data-tab-shape={shape}
			style={{
				position: "absolute",
				// Centre on the bubble's INK, not on the icon's box. Tabler's message-circle
				// draws its round body in the upper-left of the viewBox and spends the bottom
				// strip on the tail, so box-centre sits low and right of where the eye reads
				// the centre. `SHAPE_INK_OFFSET` walks it back onto the body.
				left: `calc(50% - ${(size * SHAPE_INK_OFFSET).toFixed(2)}px)`,
				top: `calc(50% - ${(size * SHAPE_INK_OFFSET).toFixed(2)}px)`,
				transform: "translate(-50%, -50%)",
				display: "inline-flex",
				// No disc of its own. The host bubble is already filled with the state's
				// colour, so the glyph is knocked out OF it. Painting another circle here
				// covered the bubble entirely and spilled past its ink, which read as a blob
				// stuck on the tab rather than as a symbol inside it.
				color: "var(--mantine-color-white)",
				pointerEvents: "none",
			}}
		>
			<Icon size={Math.round(size * SHAPE_GLYPH_RATIO)} stroke={3} />
		</Box>
	);
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

interface TabItemBodyProps {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	/**
	 * Toggle pinned state. Supplied by the list so a LEFT swipe can pin/unpin on touch,
	 * where the right-click menu (the only other way to pin) is unreachable — long-press
	 * fires `contextmenu`, which `handleContextMenu` deliberately swallows on touch.
	 */
	onTogglePin?: (tab: RecentTab) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	onPrefetch?: (tab: RecentTab) => void;
	/** When true and active, remove top border-radius to connect with nav above */
	connectTop?: boolean;
	/** Workspace-only: click handler for the "add narrator" button */
	onWsAddClick?: (e: React.MouseEvent, wsId: string) => void;
	/**
	 * Directory mode: the working directory is printed once on the group header, so the
	 * member rows must not repeat it. This is the entire space saving of the mode.
	 */
	hideSubtitle?: boolean;
	/** Directory mode: indent the row so it reads as a member of the group above. */
	indent?: boolean;
	/** True while dnd-kit is dragging this row — suppresses the swipe-to-close gesture. */
	isDragging?: boolean;
	/** Outer wrapper ref (dnd-kit's `setNodeRef`, or nothing in the static case). */
	outerRef?: (node: HTMLElement | null) => void;
	outerStyle?: React.CSSProperties;
	/** dnd-kit attributes + listeners, spread onto the outer wrapper. */
	// biome-ignore lint/suspicious/noExplicitAny: dnd-kit attribute/listener bags are untyped maps
	dragProps?: Record<string, any>;
}

/**
 * The visible row and every interaction on it: click-to-navigate, middle-click close,
 * right-click menu, swipe-right-to-close, swipe-left-to-pin, and dragging the icon into
 * a workspace panel.
 *
 * Deliberately free of `useSortable`. Directory mode renders rows OUTSIDE any
 * `DndContext` (see `RecentTabList`), and a `useSortable` call there would throw. Keeping
 * the body sortable-agnostic means both modes run the same interaction code instead of a
 * second copy that drifts.
 */
function TabItemBody({
	tab,
	active,
	onRemove,
	onTogglePin,
	onNavigate,
	onContextMenu,
	onPrefetch,
	connectTop,
	onWsAddClick,
	hideSubtitle,
	indent,
	isDragging = false,
	outerRef,
	outerStyle,
	dragProps,
}: TabItemBodyProps) {
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
	const iconColor = getRecentTabIconColor(tab);
	const filledStatus = isFilledRecentTabStatus(tab);

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

	// Horizontal swipe gestures (touch only, and only when dnd-kit is not dragging):
	// right closes the tab, left toggles pinned.
	//
	// Left-swipe exists because pinning had NO touch entry point at all. The only other
	// way in is the right-click menu, and on touch that menu never opens: long-press
	// fires `contextmenu`, which `handleContextMenu` suppresses (otherwise every
	// long-press-to-drag would pop a menu).
	const touchStartX = useRef(0);
	const touchStartY = useRef(0);
	const swiping = useRef(false);
	const directionLocked = useRef<"horizontal" | "vertical" | null>(null);
	const [swipeX, setSwipeX] = useState(0);
	const [exiting, setExiting] = useState(false);
	const canPin = !!onTogglePin;

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
			setSwipeX(clampSwipeTravel(dx, canPin));
		},
		[isDragging, canPin],
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
		const release = classifySwipeRelease(swipeX, canPin);
		if (release === "close") {
			setExiting(true);
			setTimeout(() => onRemove(tab.type, tab.id), 200);
			return;
		}
		// Both remaining outcomes snap the row home. Pinning does not fly the row out:
		// it stays in the list and only moves between the pinned and unpinned groups.
		setSwipeX(0);
		if (release === "pin") onTogglePin?.(tab);
	}, [swipeX, isDragging, tab, onRemove, canPin, onTogglePin]);

	const swipeStyle: React.CSSProperties = exiting
		? {
				transform: "translateX(100%)",
				opacity: 0,
				transition: "transform 0.2s ease-out, opacity 0.2s ease-out",
			}
		: swipeX !== 0
			? { transform: `translateX(${swipeX}px)`, transition: "none" }
			: // Animate the snap-back so a released half-swipe glides home instead of
				// teleporting. Harmless at rest: nothing is moving.
				{ transform: "translateX(0)", transition: "transform 0.15s ease-out" };

	// Affordance revealed under the row while swiping left. It has to live BEHIND the row
	// (the row itself is what moves), so it is absolutely positioned in the clipped outer
	// wrapper and only mounted while the gesture is in progress.
	const pinHintActive = swipeX < -SWIPE_THRESHOLD;

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
			ref={outerRef}
			{...dragProps}
			style={{
				...outerStyle,
				overflow: "hidden",
				touchAction: "pan-y",
				// Anchor for the swipe-left pin affordance below.
				position: "relative",
			}}
			data-tab-sort-id={tabSortId(tab)}
		>
			{swipeX < 0 && (
				<Group
					gap={4}
					wrap="nowrap"
					justify="flex-end"
					pr="sm"
					style={{
						position: "absolute",
						inset: 0,
						pointerEvents: "none",
						color: pinHintActive ? "var(--mantine-color-indigo-4)" : "var(--mantine-color-dimmed)",
					}}
				>
					{tab.pinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />}
					<Text size="xs">{t(tab.pinned ? "swipeUnpin" : "swipePin")}</Text>
				</Group>
			)}
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
					pl={indent ? "lg" : undefined}
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
							{tab.subtitle && !hideSubtitle && (
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
}

interface SortableTabItemProps
	extends Omit<TabItemBodyProps, "outerRef" | "outerStyle" | "dragProps" | "isDragging"> {
	/** When true, reduce opacity to indicate the item is being dragged */
	dimmed?: boolean;
	/** Measured group height (header + children) — applied when dragging a workspace */
	wsGroupHeight?: number;
}

/** Draggable row for the flat list: `useSortable` wrapper around {@link TabItemBody}. */
const SortableTabItem = React.memo(function SortableTabItem({
	dimmed,
	wsGroupHeight,
	...bodyProps
}: SortableTabItemProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tabSortId(bodyProps.tab),
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

	return (
		<TabItemBody
			{...bodyProps}
			isDragging={isDragging}
			outerRef={setNodeRef}
			outerStyle={sortStyle}
			dragProps={{ ...attributes, ...listeners }}
		/>
	);
});

/**
 * Non-draggable row, for the children of a workspace in directory mode.
 *
 * In directory mode a workspace moves as ONE unit (dragging the header moves the whole
 * structure, and its members are not pulled into directory groups either), so children
 * must not register as sortable — but they still render inside the DndContext. Keeping
 * this sortable-free variant shares the interaction code instead of forking it.
 */
const StaticTabItem = React.memo(function StaticTabItem(
	props: Omit<TabItemBodyProps, "outerRef" | "outerStyle" | "dragProps" | "isDragging">,
) {
	return <TabItemBody {...props} />;
});

/**
 * Sortable wrapper for a directory group header. The header is the unit's drag handle
 * AND its collapse toggle, so the click must go through the same post-drag suppression
 * (`justDragged`) the flat rows use — without it, every reorder would also fold the group.
 */
function SortableDirectoryRow(props: RecentTabDirectoryRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: directoryRowId(props.path),
	});

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0 : 1,
		zIndex: isDragging ? 10 : undefined,
	};

	const handleToggle = (path: string) => {
		if (justDragged) {
			justDragged = false;
			return;
		}
		props.onToggle(path);
	};

	return (
		<div ref={setNodeRef} {...attributes} {...listeners} style={style}>
			<RecentTabDirectoryRow {...props} onToggle={handleToggle} />
		</div>
	);
}

/**
 * The directory row that owns `sortId` as a MEMBER, if any.
 *
 * Distinguishes "reordered a member inside its group" (persisted as group member order)
 * from every other drop (persisted as flat moves). A directory HEADER is not a member,
 * so dragging a whole group correctly falls through to the flat path.
 */
function findDirectoryMemberRow(
	rows: RecentTabRow[],
	sortId: string,
): Extract<RecentTabRow, { kind: "directory" }> | null {
	for (const row of rows) {
		if (row.kind !== "directory") continue;
		if (row.children.some((child) => `${child.type}:${child.id}` === sortId)) return row;
	}
	return null;
}

/** Resolve a sortable id to its tab across the aggregated rows (for drag previews). */
interface CachedNarratorSummary {
	title?: string | null;
	cwd?: string | null;
	status?: string | null;
}

/**
 * Best-effort narrator metadata from whatever the query cache already holds.
 *
 * Checks the single-narrator entry first, then every paginated LIST cache. The list page is
 * where an external drag starts, and it populates only `["narrators", "paginated", …]` —
 * the detail entry exists just for narrators that have been opened. Reading only the detail
 * key therefore missed exactly the common case, producing a tab with no `cwd`: a permanent
 * gap, because `cwd` is persisted rather than patched in by the runtime endpoint, so the
 * row would stay subtitle-less and invisible to directory grouping until someone opened it.
 *
 * No fetch here on purpose: a drop must commit in the same tick as the release, and the
 * fields are cosmetic — the tab is correct without them and self-corrects on the first visit.
 */
function findCachedNarratorSummary(
	qc: ReturnType<typeof useQueryClient>,
	narratorId: string,
): CachedNarratorSummary | null {
	const direct = qc.getQueryData<CachedNarratorSummary>(["narrators", narratorId]);
	if (direct) return direct;
	const lists = qc.getQueriesData<{
		pages?: Array<{ items?: Array<CachedNarratorSummary & { id?: string }> }>;
	}>({ queryKey: ["narrators", "paginated"] });
	for (const [, data] of lists) {
		for (const page of data?.pages ?? []) {
			const hit = page.items?.find((item) => item.id === narratorId);
			if (hit) return hit;
		}
	}
	return null;
}

function findDirectoryRowTab(rows: RecentTabRow[], sortId: string): RecentTab | null {
	for (const row of rows) {
		if (row.kind === "directory") {
			const hit = row.children.find((child) => tabSortId(child) === sortId);
			if (hit) return hit;
			continue;
		}
		if (tabSortId(row.tab) === sortId) return row.tab;
	}
	return null;
}

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
	onNewNarratorHere: () => void;
	canNewNarratorHere: boolean;
	onCopyCwd: () => void;
	canCopyCwd: boolean;
	onRename: () => void;
	canRename: boolean;
	onArchive: () => void;
	canArchive: boolean;
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
	onNewNarratorHere,
	canNewNarratorHere,
	onCopyCwd,
	canCopyCwd,
	onRename,
	canRename,
	onArchive,
	canArchive,
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
					{canCopyCwd && (
						<UnstyledButton px="xs" py={4} onClick={onCopyCwd} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconCopy size={14} />
								<Text size="sm">{t("copyCwd")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canRename && (
						<UnstyledButton px="xs" py={4} onClick={onRename} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconPencil size={14} />
								<Text size="sm">{t("rename")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canArchive && (
						<UnstyledButton px="xs" py={4} onClick={onArchive} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconArchive size={14} />
								<Text size="sm">{t("archive")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canReveal && (
						<UnstyledButton px="xs" py={4} onClick={onReveal} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconFolder size={14} />
								<Text size="sm">{t("revealInExplorer")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canNewNarratorHere && (
						<UnstyledButton px="xs" py={4} onClick={onNewNarratorHere} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconFolderPlus size={14} />
								<Text size="sm">{t("newNarratorHere")}</Text>
							</Group>
						</UnstyledButton>
					)}
				</Stack>
			</Paper>
		</>
	);
}
