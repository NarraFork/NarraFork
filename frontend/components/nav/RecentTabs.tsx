import { DndContext, DragOverlay, useDraggable } from "@dnd-kit/core";
import {
	directoryRowId,
	groupRecentTabsByDirectory,
	hasDirectorySubtitle,
	type RecentTabRow,
} from "@frontend/hooks/recent-tab-directory-groups";
import { canRevealFromBrowser } from "@frontend/lib/local-origin";
import { statusRegistry } from "@frontend/lib/status-registry";
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
	IconClock,
	IconColumns,
	IconCopy,
	IconFolder,
	IconFolderPlus,
	IconGitBranch,
	IconPencil,
	IconPin,
	IconPinnedOff,
	IconPlus,
	IconRobot,
	IconServer,
	IconSubtask,
	IconTerminal2,
	IconWindowMaximize,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
	applyRecentTabsDeltaAndFollowUp,
	applyRecentTabsRuntimePatches,
	bumpRecentTabRuntimeVersions,
	clampRecentTabText,
	collectRecentTabsDeltaFrame,
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
import {
	clearNotifiedAttention,
	triggerNotification,
	updateAsyncQuestionAttention,
} from "../../lib/notification";
import { LeftTruncatedPathText } from "../common/TruncatedPath";
import type { CreateNarratorResult } from "../narrator/CreateNarratorModal";
import { UserAvatar } from "../UserAvatar";
import { PANEL_WINDOW_FEATURES, recentTabWindowHref } from "../window/panel-window";
import { NarratorStatusIcon } from "./NarratorStatusIcon";
import { getNarratorStatusIconColor, isFilledNarratorStatus } from "./narrator-status-icon-logic";
import { RecentTabDirectoryRow, type RecentTabDirectoryRowProps } from "./RecentTabDirectoryRow";
import { RecentTabDropIndicator } from "./RecentTabDropIndicator";
import type { RecentTabDropTarget } from "./recent-tab-drop-target";
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
	clampSwipeTravel,
	classifySwipeRelease,
	isTabActive,
	SWIPE_THRESHOLD,
} from "./recent-tabs-logic";
import { useRecentTabExternalDrop } from "./useRecentTabExternalDrop";
import { useRecentTabsDrag } from "./useRecentTabsDrag";

const CreateNarratorModal = React.lazy(() =>
	import("../narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);

const mantineVar = (color: string) => `var(--mantine-color-${color}-6)`;

const CONTAINER_STATUS_I18N: Record<string, string> = {
	running: "containerRunning",
	paused: "containerPaused",
	stopped: "containerStopped",
	created: "containerCreated",
	removed: "containerRemoved",
};

const QUERY_KEY = ["user-preferences", "recent-tabs"];

const PREFETCH_QUERY_GC_TIME_MS = 5 * 60_000;

function getRecentTabNarratorId(tab: RecentTab): string | null {
	if (tab.type === "narrator" || tab.type === "subagent") return tab.id;
	if (tab.type === "chapter") return tab.narratorId ?? null;
	// group tabs have no single narrator (multi-party)
	return null;
}

// Each list owns its click guard and pending submission state.
const RecentTabsDragContext = React.createContext<
	Pick<ReturnType<typeof useRecentTabsDrag>, "pending" | "consumeClick">
>({ pending: false, consumeClick: () => false });

function tabSortId(tab: RecentTab) {
	return `${tab.type}:${tab.id}`;
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
			} else if (
				event.type === "backgroundTaskCount" &&
				event.activeBackgroundTaskCount !== undefined
			) {
				patch.activeBackgroundTaskCount = event.activeBackgroundTaskCount;
				patch.activeBackgroundWorkCount = event.activeBackgroundWorkCount;
				patch.activeBackgroundServiceCount = event.activeBackgroundServiceCount;
			} else if (event.type === "containerStatus") patch.containerStatus = event.containerStatus;
			else if (event.type === "draft") patch.hasDraft = !!event.hasDraft;
			else if (event.type === "awaitedQuestion") {
				// The subscription reconciles caches for ALL changes before this callback.
				// Attention is separate: no synthetic status patch or urgency-gated refetch.
				const tab = tabsRef.current.find((item) => getRecentTabNarratorId(item) === narratorId);
				updateAsyncQuestionAttention(
					narratorId,
					event.questionId,
					event.awaited === true,
					tab?.title,
					userPrefsRef.current,
				);
				return;
			} else return;

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
				const isWaitingForModel =
					event.substatus?.includes("model_unavailable") ||
					event.substatus?.includes("quota_exhausted");
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

	const listBoxRef = useRef<HTMLDivElement | null>(null);
	// Collapse is a user/view preference, never a temporary drag state.
	const directoryCollapsedByPath = useMemo(() => {
		const children = new Map<string, RecentTab[]>();
		for (const tab of tabs) {
			if (!tab.workspaceId) continue;
			const group = children.get(tab.workspaceId) ?? [];
			group.push(tab);
			children.set(tab.workspaceId, group);
		}
		const rows = groupRecentTabsByDirectory(
			tabs.filter((tab) => !tab.workspaceId && !tab.pinned),
			children,
		);
		return new Map(
			rows.flatMap((row) => {
				if (row.kind !== "directory") return [];
				const containsActive = row.children.some((child) => isTabActive(child, pathname));
				const containsPending =
					!!pendingKey && row.children.some((child) => tabSortId(child) === pendingKey);
				return [
					[row.path, isDirectoryCollapsed(row.path, { containsActive, containsPending })] as const,
				];
			}),
		);
	}, [tabs, pathname, pendingKey, isDirectoryCollapsed]);
	const onReorderError = useCallback(() => {
		notifications.show({ color: "red", message: t("recentTabsReorderFailed") });
	}, [t]);
	const drag = useRecentTabsDrag({
		tabs,
		groupingEnabled,
		directoryCollapsedByPath,
		containerRef: listBoxRef,
		qc,
		onError: onReorderError,
	});
	const dragInteraction = useMemo(
		() => ({ pending: drag.pending, consumeClick: drag.consumeClick }),
		[drag.pending, drag.consumeClick],
	);

	// Rendering, hit testing and persistence share the same visual units.
	const { topLevel, childrenByWorkspace, pinnedItems, unpinnedItems, directoryRows } = drag.model;

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
	// Reveal runs on the server desktop. Explicit user opt-in also supports a local
	// browser accessing that server through a domain or LAN IP; react to preference changes.
	const canRevealFromThisBrowser = canRevealFromBrowser(userPrefsForGrouping?.treatAsLocalAccess);
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

	/** 在外部窗口打开该标签（叙述者/章节 → chat 面板窗口；workspace → 表面窗口；project → 主应用窗口） */
	const handleOpenInWindow = useCallback(() => {
		if (!ctxMenu) return;
		const href = recentTabWindowHref(ctxMenu.tab);
		setCtxMenu(null);
		if (href) window.open(href, "_blank", PANEL_WINDOW_FEATURES);
	}, [ctxMenu]);

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
	const renderTabGroup = (items: RecentTab[], group: "pinned" | "unpinned") =>
		items.map((tab, index) => {
			if (tab.workspaceId) {
				return (
					<DraggableWorkspaceChildTab
						key={tabSortId(tab)}
						tab={tab}
						active={isRowActive(tab)}
						onRemove={handleRemove}
						onNavigate={onNavigate}
						onContextMenu={handleContextMenu}
						onPrefetch={prefetchNarratorTab}
					/>
				);
			}
			return (
				<DraggableTabItem
					key={tabSortId(tab)}
					tab={tab}
					active={isRowActive(tab)}
					onRemove={handleRemove}
					onTogglePin={handleSwipePin}
					onNavigate={onNavigate}
					onContextMenu={handleContextMenu}
					onPrefetch={prefetchNarratorTab}
					connectTop={
						firstTabConnected && index === 0 && (group === "pinned" || pinnedItems.length === 0)
					}
					onWsAddClick={tab.type === "workspace" ? handleWsAddClick : undefined}
				/>
			);
		});

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
	const renderDirectoryRows = (rows: RecentTabRow[]) =>
		rows.map((row, index) => {
			const connectTop = firstTabConnected && pinnedItems.length === 0 && index === 0;
			if (row.kind === "tab") {
				return (
					<DraggableTabItem
						key={tabSortId(row.tab)}
						tab={row.tab}
						active={isRowActive(row.tab)}
						onRemove={handleRemove}
						onTogglePin={handleSwipePin}
						onNavigate={onNavigate}
						onContextMenu={handleContextMenu}
						onPrefetch={prefetchNarratorTab}
						connectTop={connectTop}
					/>
				);
			}
			if (row.kind === "workspace") {
				return (
					<React.Fragment key={tabSortId(row.tab)}>
						<DraggableTabItem
							tab={row.tab}
							active={isRowActive(row.tab)}
							onRemove={handleRemove}
							onTogglePin={handleSwipePin}
							onNavigate={onNavigate}
							onContextMenu={handleContextMenu}
							onPrefetch={prefetchNarratorTab}
							connectTop={connectTop}
							onWsAddClick={handleWsAddClick}
						/>
						{row.children.map((child) => (
							<DraggableWorkspaceChildTab
								key={tabSortId(child)}
								tab={child}
								active={isRowActive(child)}
								onRemove={handleRemove}
								onNavigate={onNavigate}
								onContextMenu={handleContextMenu}
								onPrefetch={prefetchNarratorTab}
							/>
						))}
					</React.Fragment>
				);
			}
			const containsActive = row.children.some((child) => isTabActive(child, pathname));
			const containsPending =
				!!pendingKey && row.children.some((child) => tabSortId(child) === pendingKey);
			const collapsed = directoryCollapsedByPath.get(row.path) ?? true;
			return (
				<React.Fragment key={directoryRowId(row.path)}>
					<DraggableDirectoryRow
						path={row.path}
						label={row.label}
						tabs={row.children}
						collapsed={collapsed}
						active={collapsed && row.children.some(isRowActive)}
						onToggle={(path) => toggleDirectory(path, { containsActive, containsPending })}
						connectTop={connectTop}
						t={t}
					/>
					{!collapsed &&
						row.children.map((child) => (
							<DraggableTabItem
								key={tabSortId(child)}
								tab={child}
								active={isRowActive(child)}
								onRemove={handleRemove}
								onTogglePin={handleSwipePin}
								onNavigate={onNavigate}
								onContextMenu={handleContextMenu}
								onPrefetch={prefetchNarratorTab}
								hideSubtitle
								indent
							/>
						))}
				</React.Fragment>
			);
		});

	// ── External drop: a narrator dragged in from the list page ────────────────
	//
	// Not part of the DndContexts above: their sortable ids come from the tabs that already
	// exist, so a narrator that is not a tab yet can never be an `active` item there. This
	// rides the `panel-drag` singleton instead (see `useRecentTabExternalDrop`).

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
		suspended: drag.draggingId !== null,
		suspendedRef: drag.draggingRef,
		measureRows: drag.measureRows,
		onDrop: handleExternalDrop,
	});

	let overlay: React.ReactNode = null;
	if (drag.draggingDirectory) {
		const row = drag.draggingDirectory;
		const collapsed = directoryCollapsedByPath.get(row.path) ?? true;
		overlay = (
			<>
				<RecentTabDirectoryRow
					path={row.path}
					label={row.label}
					tabs={row.children}
					collapsed={collapsed}
					active={false}
					onToggle={() => {}}
					t={t}
				/>
				{!collapsed &&
					row.children.map((tab) => (
						<DragOverlayTabItem key={tabSortId(tab)} tab={tab} active={false} />
					))}
			</>
		);
	} else if (drag.draggingTab) {
		const tab = drag.draggingTab;
		overlay =
			tab.type === "workspace" ? (
				<DragOverlayWorkspaceItem tab={tab} wsChildren={childrenByWorkspace.get(tab.id) ?? []} />
			) : (
				<DragOverlayTabItem tab={tab} active={isTabActive(tab, pathname)} />
			);
	}
	const indicator = drag.indicator ?? externalDrop;
	return (
		<RecentTabsDragContext.Provider value={dragInteraction}>
			<DndContext
				sensors={drag.sensors}
				autoScroll={drag.autoScrollOptions}
				onDragStart={drag.onDragStart}
				onDragMove={drag.onDragMove}
				onDragEnd={drag.onDragEnd}
				onDragCancel={drag.onDragCancel}
			>
				<Box
					ref={listBoxRef}
					style={{
						overflow: "hidden",
						position: "relative",
						...(topLevel.length === 0 && filter === "narrator" ? { minHeight: 44 } : {}),
					}}
				>
					{indicator && (
						<RecentTabDropIndicator
							rows={indicator.rows}
							target={indicator.target}
							containerTop={indicator.containerTop}
						/>
					)}
					{topLevel.length === 0 ? (
						emptyBody
					) : (
						<>
							{renderTabGroup(pinnedItems, "pinned")}
							{groupingEnabled
								? renderDirectoryRows(directoryRows)
								: renderTabGroup(unpinnedItems, "unpinned")}
						</>
					)}

					{topLevel.length > 0 &&
						(sectionState.isError ? (
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
						) : null)}

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
							onOpenInWindow={handleOpenInWindow}
							canOpenInWindow={recentTabWindowHref(ctxMenu.tab) !== null}
							onRename={handleRename}
							canRename={ctxMenu.tab.type === "narrator"}
							onArchive={handleArchive}
							canArchive={ctxMenu.tab.type === "narrator"}
							isFirst={
								topLevel.findIndex(
									(t) => t.type === ctxMenu.tab.type && t.id === ctxMenu.tab.id,
								) === 0
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
							<Button
								color="orange"
								loading={archiveNarrator.isPending}
								onClick={handleArchiveConfirm}
							>
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
				{/* Keep preview rows outside the measured source container. */}
				<DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
					{overlay}
				</DragOverlay>
			</DndContext>
		</RecentTabsDragContext.Provider>
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
	// The narrator bubble is shared verbatim with the narrator list page — see
	// `NarratorStatusIcon`. It owns its corner markers and the centre shape overlay.
	if (tab.type === "narrator") {
		return (
			<NarratorStatusIcon
				size={size}
				status={tab.status}
				substatus={tab.substatus}
				activeBackgroundWorkCount={tab.activeBackgroundWorkCount}
				activeBackgroundTaskCount={tab.activeBackgroundTaskCount}
				hasDraft={tab.hasDraft}
				isScheduled={tab.isScheduled}
			/>
		);
	}

	let icon: React.ReactNode;
	if (tab.type === "project") icon = <IconFolder size={size} />;
	else if (tab.type === "workspace") icon = <IconColumns size={size} />;
	else if (tab.type === "chapter") {
		icon = (
			<IconGitBranch size={size} color={iconColor} fill={filledStatus ? "currentColor" : "none"} />
		);
	} else icon = <IconRobot size={size} color={iconColor} />;

	// Corner markers remain for chapter / subagent rows. The centre state SHAPE
	// (tick / shield / alert) does not: it is knocked out in white and needs the
	// narrator bubble's solid body behind it — the git-branch and robot glyphs are
	// Tabler OUTLINE icons (stroke only, no closed shape), so a white glyph there
	// would land on the page background and disappear. `IconGitBranch`'s `fill`
	// only tints its three small nodes, which is not a body either.
	const canShowMarker = tab.type === "chapter" || tab.type === "subagent";
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
	const iconColor = getNarratorStatusIconColor(tab);
	const filledStatus = isFilledNarratorStatus(tab);

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

/** Compact workspace member; remains in normal layout throughout the gesture. */
const DraggableWorkspaceChildTab = React.memo(function DraggableWorkspaceChildTab({
	tab,
	active,
	onRemove,
	onNavigate,
	onContextMenu,
	onPrefetch,
}: {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	onPrefetch?: (tab: RecentTab) => void;
}) {
	const navigate = useNavigate();
	const drag = useContext(RecentTabsDragContext);
	const { attributes, listeners, setNodeRef } = useDraggable({
		id: tabSortId(tab),
		disabled: drag.pending,
	});
	const to =
		tab.type === "chapter" && tab.narratorId
			? `/narrators/${tab.narratorId}`
			: `/narrators/${tab.id}`;
	const prefetch = useCallback(() => onPrefetch?.(tab), [onPrefetch, tab]);
	return (
		<div ref={setNodeRef} {...attributes} {...listeners} data-tab-sort-id={tabSortId(tab)}>
			<NavLink
				active={active}
				label={<Text size="xs">{tab.title}</Text>}
				leftSection={
					<TabIcon
						tab={tab}
						size={14}
						iconColor={getNarratorStatusIconColor(tab)}
						filledStatus={isFilledNarratorStatus(tab)}
					/>
				}
				onClick={() => {
					if (drag.consumeClick()) return;
					prefetch();
					onNavigate?.();
					navigate({ to });
				}}
				onPointerEnter={prefetch}
				onFocus={prefetch}
				onMouseDown={(e: React.MouseEvent) => {
					prefetch();
					if (e.button === 1) e.preventDefault();
				}}
				onAuxClick={(e: React.MouseEvent) => {
					if (e.button === 1) {
						e.preventDefault();
						onRemove(tab.type, tab.id);
					}
				}}
				onContextMenu={(e) => onContextMenu(e, tab)}
				py={2}
				pl="lg"
				styles={{ root: { borderRadius: 4, minHeight: 28 }, label: { overflow: "hidden" } }}
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
	const iconColor = getNarratorStatusIconColor(tab);
	const filledStatus = isFilledNarratorStatus(tab);

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
						{tab.subtitle &&
							(hasDirectorySubtitle(tab) ? (
								// cwd: left-ellipsis + LTR isolation so the leading "/" stays put.
								<LeftTruncatedPathText path={tab.subtitle} size="xs" c="dimmed" />
							) : (
								<Text size="xs" c="dimmed" truncate>
									{tab.subtitle}
								</Text>
							))}
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
 * The body is independent of drag sensors. All list modes share the same gesture
 * wrapper and cross-surface bridge; previews render without interactive drag sources.
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
	const drag = useContext(RecentTabsDragContext);
	const { t } = useTranslation("common");
	const to =
		tab.type === "project"
			? `/projects/${tab.id}`
			: tab.type === "chapter" && tab.narratorId
				? `/narrators/${tab.narratorId}`
				: tab.type === "workspace"
					? `/narrators/workspace/${tab.id}`
					: `/narrators/${tab.id}`;
	const iconColor = getNarratorStatusIconColor(tab);
	const filledStatus = isFilledNarratorStatus(tab);

	const handlePrefetch = useCallback(() => onPrefetch?.(tab), [onPrefetch, tab]);

	// Only this list's synthetic post-drag click is suppressed.
	const handleClick = useCallback(() => {
		if (drag.consumeClick()) return;
		handlePrefetch();
		navigate({ to });
		onNavigate?.();
	}, [drag.consumeClick, handlePrefetch, navigate, to, onNavigate]);

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

	// Icon and body use the same sensors and cross-surface drag bridge.
	const dragNarratorId = getRecentTabNarratorId(tab);
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
							{tab.subtitle &&
								!hideSubtitle &&
								(hasDirectorySubtitle(tab) ? (
									// cwd: left-ellipsis + LTR isolation so the leading "/" stays put.
									<LeftTruncatedPathText path={tab.subtitle} size="xs" c="dimmed" />
								) : (
									<Text size="xs" c="dimmed" truncate>
										{tab.subtitle}
									</Text>
								))}
							{tab.type !== "project" && <TabIndicators tab={tab} t={t} />}
						</>
					}
					leftSection={
						<span
							style={{
								display: "flex",
								alignItems: "center",
								cursor: dragNarratorId ? "grab" : undefined,
								// Long-press activation belongs to the same touch sensor as the body.
								touchAction: "pan-y",
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

/** Sources stay visible in normal flow; only the overlay moves. */
const DraggableTabItem = React.memo(function DraggableTabItem(
	props: Omit<TabItemBodyProps, "outerRef" | "outerStyle" | "dragProps" | "isDragging">,
) {
	const drag = useContext(RecentTabsDragContext);
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: tabSortId(props.tab),
		disabled: drag.pending,
	});
	return (
		<TabItemBody
			{...props}
			isDragging={isDragging}
			outerRef={setNodeRef}
			dragProps={{ ...attributes, ...listeners }}
		/>
	);
});

function DraggableDirectoryRow(props: RecentTabDirectoryRowProps) {
	const drag = useContext(RecentTabsDragContext);
	const { attributes, listeners, setNodeRef } = useDraggable({
		id: directoryRowId(props.path),
		disabled: drag.pending,
	});
	return (
		<div ref={setNodeRef} {...attributes} {...listeners}>
			<RecentTabDirectoryRow
				{...props}
				onToggle={(path) => {
					if (!drag.consumeClick()) props.onToggle(path);
				}}
			/>
		</div>
	);
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
	const workCount = tab.activeBackgroundWorkCount ?? tab.activeBackgroundTaskCount ?? 0;
	const serviceCount = tab.activeBackgroundServiceCount ?? 0;
	const hasBackgroundTasks = workCount > 0;

	if (!hasViewers && !hasContainer && !hasTerminals && !hasBackgroundTasks && !serviceCount)
		return null;

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
						<IconTerminal2 size={11} style={{ opacity: 0.6, transform: "translateY(-1px)" }} />
						<Text size="xs" c="dimmed" lh={1}>
							{tab.activeTerminalCount}
						</Text>
					</Group>
				</Tooltip>
			)}
			{hasBackgroundTasks && (
				<Tooltip
					label={t("activeBackgroundTasks", { count: workCount })}
					withArrow
					position="right"
				>
					<Group gap={1} wrap="nowrap">
						<IconSubtask size={11} style={{ opacity: 0.6, transform: "translateY(-1px)" }} />
						<Text size="xs" c="dimmed" lh={1}>
							{workCount}
						</Text>
					</Group>
				</Tooltip>
			)}
			{serviceCount > 0 && (
				<Tooltip
					label={t("activeBackgroundServices", { count: serviceCount })}
					withArrow
					position="right"
				>
					<Group gap={1} wrap="nowrap">
						<IconServer size={11} style={{ opacity: 0.6 }} />
						<Text size="xs" c="dimmed" lh={1}>
							{serviceCount}
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
	onOpenInWindow: () => void;
	canOpenInWindow: boolean;
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
	onOpenInWindow,
	canOpenInWindow,
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
					{canOpenInWindow && (
						<UnstyledButton px="xs" py={4} onClick={onOpenInWindow} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconWindowMaximize size={14} />
								<Text size="sm">{t("openInWindow")}</Text>
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
					)}{" "}
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
