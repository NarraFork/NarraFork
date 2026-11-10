import { DndContext, DragOverlay, useDraggable } from "@dnd-kit/core";
import type { RecentTabRow } from "@frontend/hooks/recent-tab-folders";
import { canRevealFromBrowser } from "@frontend/lib/local-origin";
import { TOUCH_POINTER_MEDIA_QUERY, useMatchMedia } from "@frontend/lib/use-match-media";
import {
	Box,
	Button,
	Center,
	Group,
	Loader,
	Modal,
	NavLink,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	RECENT_TAB_FOLDER_DEFAULT_PREVIEW,
	type RecentTabsDelta as RecentTabsDeltaFrame,
} from "@shared/recent-tabs";
import { IconBrain, IconClock, IconFolder, IconPencil, IconRobot } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFolderDisplay } from "../../hooks/useFolderDisplay";
import { useArchiveNarrator } from "../../hooks/useNarrator";
import type { NarratorListWSEvent } from "../../hooks/useNarratorWS";
import { useFsRevealCapability } from "../../hooks/usePlatform";
import { useNarratorIsOptimizingPrompt } from "../../hooks/usePromptOptimizeTask";
import { usePendingTabKey } from "../../hooks/useRecentTabKeyboardNav";
import {
	addRecentTab,
	addRecentTabOrThrow,
	applyRecentTabsDeltaAndFollowUp,
	applyRecentTabsRuntimePatches,
	bumpRecentTabRuntimeVersions,
	clampRecentTabText,
	collectRecentTabsDeltaFrame,
	normalizeRecentTabViewers,
	pruneRecentTabsRuntimeVersions,
	type RecentTab,
	type RecentTabRuntimeVersions,
	type RecentTabsInfiniteData,
	recentTabsSectionQueryKey,
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
import { CreateNarratorLazyModal } from "../narrator/CreateNarratorLazyModal";
import type { CreateNarratorResult } from "../narrator/CreateNarratorModal";
import { PANEL_WINDOW_FEATURES, recentTabWindowHref } from "../window/panel-window";
import { NarratorStatusIcon } from "./NarratorStatusIcon";
import { getNarratorStatusIconColor } from "./narrator-status-icon-logic";
import { type RecentTabCardActions, RecentTabDetailCard } from "./RecentTabDetailCard";
import { RecentTabDropIndicator } from "./RecentTabDropIndicator";
import { RecentTabFolderEditModal } from "./RecentTabFolderEditModal";
import {
	RecentTabFolderHeader,
	type RecentTabFolderHeaderProps,
	RecentTabFolderPinDivider,
	RecentTabFolderStrip,
	recentTabFolderCardStyle,
} from "./RecentTabFolderRows";
import { RecentTabPinDivider, TabContextMenu } from "./RecentTabMenu";
import {
	createRecentTabDragModel,
	type FolderViewOptions,
	planRecentTabDrop,
} from "./recent-tab-drag-model";
import type { RecentTabDropSource, RecentTabDropTarget } from "./recent-tab-drop-target";
import { createRecentTabHoverStore, type RecentTabHoverStore } from "./recent-tab-hover";
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
import { stripKey } from "./recent-tab-keyboard-nav";
import { newSessionTargetFor } from "./recent-tab-new-session";
import { isBackgroundWorkSilencedStatus, isTabActive } from "./recent-tabs-logic";
import { useRecentTabExternalDrop } from "./useRecentTabExternalDrop";
import { useRecentTabsDrag } from "./useRecentTabsDrag";
import { SwipeMenuHint, useRowSwipe } from "./useRowSwipe";

const QUERY_KEY = ["user-preferences", "recent-tabs"];

const PREFETCH_QUERY_GC_TIME_MS = 5 * 60_000;

function getRecentTabNarratorId(tab: RecentTab): string | null {
	if (tab.type === "narrator" || tab.type === "subagent") return tab.id;
	// group tabs have no single narrator (multi-party)
	return null;
}

// Each list owns its click guard and pending submission state.
const RecentTabsDragContext = React.createContext<
	Pick<ReturnType<typeof useRecentTabsDrag>, "pending" | "consumeClick">
>({ pending: false, consumeClick: () => false });

/**
 * The list's hover-card store; null on touch, where rows report no hover and the
 * details are shown at the top of the row menu instead.
 */
const RecentTabHoverContext = React.createContext<RecentTabHoverStore | null>(null);

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
			} else if (event.type === "draft") patch.hasDraft = !!event.hasDraft;
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
					// Done while non-service background work is still running: keep the
					// in-app unread + favicon state, but stay silent (no sound, no PWA
					// browser notification). The wake-up turn after the last background
					// task completes emits a fresh, unflagged done which notifies normally.
					if (!isBackgroundWorkSilencedStatus(event) && userPrefsRef.current) {
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
					// A folder member is promoted inside its folder and the folder moves with it;
					// the server resolves that from the member key.
					api
						.moveRecentTab(tabSortId(tab), { position: "above_idle" })
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
	/** Narrator ID to exclude from active highlighting. */
	excludeActiveNarratorId?: string;
}

/**
 * Renders a filtered subset of recent tabs with DnD, clear button, etc.
 * `filter="project"` shows project tabs; `filter="narrator"` shows narrator tabs.
 *
 * The narrator section also renders folders: a folder header, its visible members
 * (collapsed = none, preview = first N, expanded = all) and a strip under an open folder.
 */
export function RecentTabList({ filter, onNavigate, excludeActiveNarratorId }: RecentTabListProps) {
	const recentTabs = useRecentTabs();
	const { removeTab, moveTab, pinTab, updateFolder, dissolveFolder, clearTabs } = recentTabs;
	const isTouch = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	const [hoverStore] = useState(createRecentTabHoverStore);
	const sectionState = filter === "project" ? recentTabs.projects : recentTabs.work;
	const tabs = sectionState.tabs;
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { t } = useTranslation("nav");
	const { t: tn } = useTranslation("narrator");
	const requireSetup = useSetupWizardGuard();
	const pendingKey = usePendingTabKey();
	const { data: userPrefs } = useUserPreferences();
	const { displays: folderDisplays, setDisplay: setFolderDisplay } = useFolderDisplay();
	/** Live preview count while a folder's strip is being dragged. */
	const [previewDrag, setPreviewDrag] = useState<{ folderId: string; count: number } | null>(null);

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
	const [editFolder, setEditFolder] = useState<RecentTab | null>(null);

	// Open the shell before resolving cwd; only a resolved target mounts the form body.
	// 文件夹目标没有目录要解析，`folderId` 表示"建完把新会话放进去"。
	const [newNarratorTarget, setNewNarratorTarget] = useState<{
		narratorId?: string;
		cwd?: string;
		folderId?: string;
	} | null>(null);
	const newNarratorTargetRef = useRef(newNarratorTarget);
	newNarratorTargetRef.current = newNarratorTarget;
	const newNarratorRequestRef = useRef(0);

	const listBoxRef = useRef<HTMLDivElement | null>(null);
	const onReorderError = useCallback(() => {
		notifications.show({ color: "red", message: t("recentTabsReorderFailed") });
	}, [t]);

	/**
	 * Which members each folder shows. In preview, the open page stays visible even past
	 * the limit; a collapsed folder instead highlights its header. The keyboard walks only
	 * what is shown (Enter opens a folder or its "N more" row), so it forces nothing. A
	 * strip being dragged previews its new count live.
	 */
	const folderOptions = useMemo<FolderViewOptions>(
		() => ({
			displayOf: (folderId) => folderDisplays[folderId],
			defaultPreview: RECENT_TAB_FOLDER_DEFAULT_PREVIEW,
			isForcedVisible: (member) => isTabActive(member, pathname),
		}),
		[folderDisplays, pathname],
	);
	const effectiveFolderOptions = useMemo<FolderViewOptions>(
		() =>
			previewDrag
				? {
						...folderOptions,
						displayOf: (folderId) =>
							folderId === previewDrag.folderId ? "preview" : folderOptions.displayOf(folderId),
						previewCountOf: (folderId) =>
							folderId === previewDrag.folderId ? previewDrag.count : undefined,
						// While resizing, the resized folder shows exactly N so the user sees what
						// will be saved; other folders keep showing the open page.
						isForcedVisible: (member) =>
							member.folderId !== previewDrag.folderId && !!folderOptions.isForcedVisible?.(member),
					}
				: folderOptions,
		[folderOptions, previewDrag],
	);
	const newFolderTitle = t("newFolderName");
	const drag = useRecentTabsDrag({
		tabs,
		folderOptions: effectiveFolderOptions,
		containerRef: listBoxRef,
		qc,
		onError: onReorderError,
		newFolderTitle,
	});
	const dragInteraction = useMemo(
		() => ({ pending: drag.pending, consumeClick: drag.consumeClick }),
		[drag.pending, drag.consumeClick],
	);

	// Rendering, hit testing and persistence share the same rows.
	const { pinnedRows, unpinnedRows, folderViews } = drag.model;
	const topLevelCount = pinnedRows.length + unpinnedRows.length;
	// Shown only when clearing would remove something: folders and their members are always
	// kept, like pinned tabs and sessions that are busy or have news.
	const hasClearableTabs = tabs.some(
		(tab) =>
			tab.type !== "project" &&
			tab.type !== "folder" &&
			!tab.folderId &&
			!tab.pinned &&
			!["working", "waiting"].includes(tab.status ?? "") &&
			!tab.substatus?.includes("unread"),
	);
	const activeTabKey = useMemo(() => {
		const active = tabs.find((tab) => isTabActive(tab, pathname));
		return active ? tabSortId(active) : undefined;
	}, [tabs, pathname]);

	// The hover card never outlives a drag, a scroll of the list or an open menu.
	useEffect(() => {
		if (drag.draggingId || ctxMenu) hoverStore.hide();
	}, [drag.draggingId, ctxMenu, hoverStore]);
	useEffect(() => {
		const hide = () => hoverStore.hide();
		window.addEventListener("scroll", hide, true);
		return () => window.removeEventListener("scroll", hide, true);
	}, [hoverStore]);

	/**
	 * Remove a tab (a folder takes its members with it) and leave the page if it was the
	 * one being closed.
	 */
	const handleRemove = useCallback(
		(type: RecentTab["type"], id: string) => {
			const closesActive = tabsRef.current.some(
				(t) =>
					((t.type === type && t.id === id) || (type === "folder" && t.folderId === id)) &&
					isTabActive(t, pathnameRef.current),
			);
			if (closesActive) navigate({ to: "/" });
			removeTab(type, id);
		},
		[removeTab, navigate],
	);

	const handleContextMenu = useCallback((e: React.MouseEvent, tab: RecentTab) => {
		e.preventDefault();
		e.stopPropagation();
		setCtxMenu({ x: e.clientX, y: e.clientY, tab });
	}, []);

	/** Touch: a left swipe opens the same menu at the release point. */
	const handleSwipeMenu = useCallback((tab: RecentTab, x: number, y: number) => {
		setCtxMenu({ x, y, tab });
	}, []);

	const handleMoveToTop = useCallback(() => {
		if (!ctxMenu) return;
		moveTab(tabSortId(ctxMenu.tab), { position: "top" });
		setCtxMenu(null);
	}, [ctxMenu, moveTab]);

	const pinTabToggle = useCallback(
		(tab: RecentTab) => pinTab(tabSortId(tab), !tab.pinned),
		[pinTab],
	);
	const handlePin = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		pinTabToggle(ctxMenu.tab);
	}, [ctxMenu, pinTabToggle]);

	const handleLeaveFolder = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (!tab.folderId) return;
		const folder = tabsRef.current.find(
			(candidate) => candidate.type === "folder" && candidate.id === tab.folderId,
		);
		// Land right after the folder, so the tab stays near where the user was looking —
		// unless the folder is pinned: an unpinned tab must not sit inside the pinned block,
		// so it goes to the top of the unpinned tabs instead.
		moveTab(
			tabSortId(tab),
			folder?.pinned ? { folderId: null } : { afterKey: `folder:${tab.folderId}`, folderId: null },
		);
	}, [ctxMenu, moveTab]);

	const handleEditFolder = useCallback(() => {
		if (!ctxMenu) return;
		setEditFolder(ctxMenu.tab);
		setCtxMenu(null);
	}, [ctxMenu]);

	const handleDissolveFolder = useCallback(() => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		setFolderDisplay(tab.id, null);
		void dissolveFolder(tab.id).catch(() => {});
	}, [ctxMenu, dissolveFolder, setFolderDisplay]);

	const toggleFolderCollapsed = useCallback(
		(folder: RecentTab) => {
			const current = folderDisplays[folder.id] ?? "preview";
			setFolderDisplay(folder.id, current === "collapsed" ? null : "collapsed");
		},
		[folderDisplays, setFolderDisplay],
	);

	const handleCtxFolderToggle = useCallback(() => {
		if (!ctxMenu) return;
		toggleFolderCollapsed(ctxMenu.tab);
		setCtxMenu(null);
	}, [ctxMenu, toggleFolderCollapsed]);

	const closeTabRow = useCallback(
		(tab: RecentTab) => handleRemove(tab.type, tab.id),
		[handleRemove],
	);
	const handleCtxClose = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		closeTabRow(ctxMenu.tab);
	}, [ctxMenu, closeTabRow]);

	/**
	 * Resolve the on-disk directory a tab points at: its narrator's cwd. Returns null
	 * when the tab has no
	 * directory (folder, project) or the lookup fails.
	 */
	const resolveTabDirectory = useCallback(
		async (tabOrNarratorId: RecentTab | string): Promise<string | null> => {
			try {
				const narratorId =
					typeof tabOrNarratorId === "string"
						? tabOrNarratorId
						: getRecentTabNarratorId(tabOrNarratorId);
				if (!narratorId) return null;
				// Directory actions must see cwd changes made in other windows, even with cached data.
				const narrator = await qc.fetchQuery({
					queryKey: ["narrators", narratorId],
					queryFn: () => api.getNarrator(narratorId),
					staleTime: 0,
					gcTime: PREFETCH_QUERY_GC_TIME_MS,
				});
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				return ((narrator as any)?.cwd as string | undefined) ?? null;
			} catch {
				return null;
			}
		},
		[qc],
	);

	const closeNewNarratorHere = useCallback(() => {
		newNarratorRequestRef.current += 1;
		newNarratorTargetRef.current = null;
		setNewNarratorTarget(null);
	}, []);

	const newNarratorHereFor = useCallback(
		async (tab: RecentTab) => {
			if (!requireSetup()) return;
			const sessionTarget = newSessionTargetFor(tab);
			if (!sessionTarget) return;
			// 文件夹没有目录要解析：直接用弹窗的默认预填，建完再归入这个文件夹。
			if ("folderId" in sessionTarget) {
				newNarratorRequestRef.current += 1;
				const folderTarget = { folderId: sessionTarget.folderId };
				newNarratorTargetRef.current = folderTarget;
				setNewNarratorTarget(folderTarget);
				return;
			}
			const { narratorId } = sessionTarget;
			const request = ++newNarratorRequestRef.current;
			const target = { narratorId };
			newNarratorTargetRef.current = target;
			setNewNarratorTarget(target);
			const dir = await resolveTabDirectory(narratorId);
			if (request !== newNarratorRequestRef.current || newNarratorTargetRef.current !== target) {
				return;
			}
			if (!dir) {
				closeNewNarratorHere();
				notifications.show({ color: "red", message: t("newNarratorHereNoDir") });
				return;
			}
			const resolved = { narratorId, cwd: dir };
			newNarratorTargetRef.current = resolved;
			setNewNarratorTarget(resolved);
		},
		[requireSetup, resolveTabDirectory, closeNewNarratorHere, t],
	);
	const handleNewNarratorHere = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		void newNarratorHereFor(ctxMenu.tab);
	}, [ctxMenu, newNarratorHereFor]);

	const handleNewNarratorHereCreated = useCallback(
		(data: CreateNarratorResult) => {
			const folderId = newNarratorTargetRef.current?.folderId;
			closeNewNarratorHere();
			void (async () => {
				await addRecentTab({
					type: "narrator",
					id: data.id,
					title: data.title,
					subtitle: data.cwd,
					status: data.status,
				});
				// 侧栏 upsert 会剥离 folderId，归属只能走文件夹端点；失败不影响已创建的会话。
				if (folderId) {
					await api.moveRecentTab(`narrator:${data.id}`, { folderId }).catch(() => {});
				}
			})();
			navigate({ to: `/narrators/${data.id}` });
			onNavigate?.();
		},
		[navigate, onNavigate, closeNewNarratorHere],
	);

	const fsRevealCapability = useFsRevealCapability();
	// Reveal runs on the server desktop. Explicit user opt-in also supports a local
	// browser accessing that server through a domain or LAN IP; react to preference changes.
	const canRevealFromThisBrowser = canRevealFromBrowser(userPrefs?.treatAsLocalAccess);
	const revealAvailable = fsRevealCapability.supported && canRevealFromThisBrowser;

	const handleReveal = useCallback(async () => {
		if (!ctxMenu) return;
		const { tab } = ctxMenu;
		setCtxMenu(null);
		if (!revealAvailable) return;
		try {
			const narratorId = tab.type === "subagent" ? null : getRecentTabNarratorId(tab);
			if (narratorId) {
				const narrator = await api.getNarrator(narratorId);
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const cwd = (narrator as any)?.cwd;
				if (cwd) await api.fsReveal(cwd);
			}
		} catch {
			// ignore
		}
	}, [ctxMenu, revealAvailable]);

	/** 复制工作目录到剪贴板（narrator/subagent） */
	const copyTabCwd = useCallback(
		async (tab: RecentTab) => {
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
		},
		[resolveTabDirectory, t],
	);
	const handleCopyCwd = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		void copyTabCwd(ctxMenu.tab);
	}, [ctxMenu, copyTabCwd]);

	/** 在外部窗口打开该标签（叙述者 → chat 面板窗口；project → 主应用窗口） */
	const openTabInWindow = useCallback((tab: RecentTab) => {
		const href = recentTabWindowHref(tab);
		if (href) window.open(href, "_blank", PANEL_WINDOW_FEATURES);
	}, []);
	const handleOpenInWindow = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		openTabInWindow(ctxMenu.tab);
	}, [ctxMenu, openTabInWindow]);

	/** 打开重命名对话框 */
	const renameTabRow = useCallback((tab: RecentTab) => {
		if (tab.type !== "narrator") return; // 仅叙述者会话可重命名
		setRenameValue(tab.title || "");
		setRenameTab({ id: tab.id, title: tab.title || "" });
	}, []);
	const handleRename = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		renameTabRow(ctxMenu.tab);
	}, [ctxMenu, renameTabRow]);

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
	const archiveTabRow = useCallback((tab: RecentTab) => {
		if (tab.type !== "narrator") return;
		setArchiveConfirmTab({ id: tab.id });
	}, []);
	const handleArchive = useCallback(() => {
		if (!ctxMenu) return;
		setCtxMenu(null);
		archiveTabRow(ctxMenu.tab);
	}, [ctxMenu, archiveTabRow]);

	/** 执行归档 */
	const handleArchiveConfirm = useCallback(() => {
		if (!archiveConfirmTab) return;
		archiveNarrator.mutate(archiveConfirmTab.id);
		setArchiveConfirmTab(null);
	}, [archiveConfirmTab, archiveNarrator]);

	/**
	 * The empty-section body, or null when there are tabs to render.
	 *
	 * Computed rather than returned early: the external-drop hook below must run on every
	 * render (rules of hooks), and an EMPTY section is precisely a state that has to accept
	 * a drop — a fresh install or a just-cleared sidebar is where dragging a narrator in is
	 * most useful.
	 */
	const emptyBody =
		topLevelCount > 0 ? null : sectionState.isLoading ? (
			// Collapsed, the rail shows icons only: these are not rows, so nothing clips them
			// to it, and they would paint at the list's full width over the page.
			<Center py="xs" className="nf-nav-expanded-only">
				<Loader size="xs" />
			</Center>
		) : sectionState.isError ? (
			<Stack gap={2} py={4} align="center" className="nf-nav-expanded-only">
				<Text size="xs" c="red">
					{t("recentTabsSyncError")}
				</Text>
				<Button size="compact-xs" variant="subtle" onClick={sectionState.retry}>
					{t("retryRecentTabs")}
				</Button>
			</Stack>
		) : null;

	/**
	 * Active/highlight state for a row. While Ctrl+Up / Ctrl+Down moves, only the row the
	 * highlight is on reads as active (a folder header and its "N more" row included).
	 */
	const isRowActive = (tab: RecentTab) => {
		const tabKey = `${tab.type}:${tab.id}`;
		return pendingKey
			? pendingKey === tabKey
			: isTabActive(tab, pathname) &&
					!(excludeActiveNarratorId && tab.id === excludeActiveNarratorId);
	};
	/** A folder header: its own highlight, else a hidden member open (or highlighted). */
	const isFolderHeaderActive = (folder: RecentTab, hidden: RecentTab[]) =>
		pendingKey ? pendingKey === tabSortId(folder) : hidden.some(isRowActive);

	/**
	 * Save a strip-dragged preview count. The live preview stays until the save settles:
	 * clearing it first would show the old count for a frame (the optimistic write waits
	 * on query cancellation), and on failure the rollback restores the old count anyway.
	 */
	const commitPreviewCount = useCallback(
		(folder: RecentTab, count: number) => {
			if (count === (folder.folderPreviewCount ?? RECENT_TAB_FOLDER_DEFAULT_PREVIEW)) {
				setPreviewDrag(null);
				return;
			}
			void updateFolder(folder.id, { previewCount: count })
				.catch(() => {})
				.finally(() => setPreviewDrag(null));
		},
		[updateFolder],
	);

	const renderRows = (rows: RecentTabRow[]) =>
		rows.map((row) => {
			if (row.kind === "tab") {
				return (
					<DraggableTabItem
						key={tabSortId(row.tab)}
						tab={row.tab}
						active={isRowActive(row.tab)}
						onRemove={handleRemove}
						onSwipeMenu={handleSwipeMenu}
						onNavigate={onNavigate}
						onContextMenu={handleContextMenu}
						onPrefetch={prefetchNarratorTab}
					/>
				);
			}
			const folder = row.tab;
			// The model builds a view for every folder row it returns.
			const view = folderViews.get(folder.id) as NonNullable<ReturnType<typeof folderViews.get>>;
			const previewCount =
				previewDrag?.folderId === folder.id
					? previewDrag.count
					: (folder.folderPreviewCount ?? RECENT_TAB_FOLDER_DEFAULT_PREVIEW);
			const firstUnpinned = view.visible.findIndex((member) => !member.pinned);
			return (
				<div
					key={tabSortId(folder)}
					data-folder-unit={folder.id}
					style={recentTabFolderCardStyle(folder.folderColor)}
				>
					<DraggableFolderHeader
						folder={folder}
						members={row.members}
						hidden={view.hidden}
						display={view.display}
						active={isFolderHeaderActive(folder, view.hidden)}
						onToggle={() => toggleFolderCollapsed(folder)}
						onContextMenu={handleContextMenu}
						onSwipeMenu={handleSwipeMenu}
						t={t}
					/>
					{view.visible.map((member, index) => (
						<React.Fragment key={tabSortId(member)}>
							{index > 0 && index === firstUnpinned && <RecentTabFolderPinDivider />}
							<DraggableTabItem
								tab={member}
								active={isRowActive(member)}
								onRemove={handleRemove}
								onSwipeMenu={handleSwipeMenu}
								onNavigate={onNavigate}
								onContextMenu={handleContextMenu}
								onPrefetch={prefetchNarratorTab}
							/>
						</React.Fragment>
					))}
					{view.display !== "collapsed" && row.members.length > 0 && (
						<RecentTabFolderStrip
							folder={folder}
							members={row.members}
							hidden={view.hidden}
							display={view.display}
							previewCount={previewCount}
							onToggleExpanded={() =>
								setFolderDisplay(folder.id, view.display === "expanded" ? null : "expanded")
							}
							onPreviewDrag={(count) =>
								setPreviewDrag(count === null ? null : { folderId: folder.id, count })
							}
							onPreviewCommit={(count) => commitPreviewCount(folder, count)}
							highlighted={pendingKey === stripKey(folder.id)}
							t={t}
						/>
					)}
				</div>
			);
		});

	// ── External drop: a narrator dragged in from the list page ────────────────
	//
	// Not part of the DndContext above: its draggable ids come from the tabs that already
	// exist, so a narrator that is not a tab yet can never be an `active` item there. This
	// rides the `panel-drag` singleton instead (see `useRecentTabExternalDrop`).

	const externalSourceFor = useCallback(
		(narratorId: string): RecentTabDropSource => {
			const existing = drag.model.tabs.find(
				(tab) => tab.type === "narrator" && tab.id === narratorId,
			);
			return {
				key: `narrator:${narratorId}`,
				kind: existing?.folderId ? "member" : "tab",
				pinned: existing && !existing.folderId ? !!existing.pinned : false,
				...(existing?.folderId ? { folderId: existing.folderId } : {}),
				canNest: true,
			};
		},
		[drag.model],
	);

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
			const key = `narrator:${narratorId}`;
			const cached = findCachedNarratorSummary(qc, narratorId);
			const tab = {
				type: "narrator" as const,
				id: narratorId,
				title: cached?.title || title || "",
				// `cwd` becomes the tab's subtitle, which is NOT a runtime field, so nothing
				// backfills it later; a tab created without it stays subtitle-less until visited.
				...(cached?.cwd ? { subtitle: cached.cwd } : {}),
				...(cached?.status ? { status: cached.status } : {}),
			};
			const fail = () =>
				notifications.show({ color: "red", message: t("recentTabsReorderFailed") });
			const existing = drag.model.tabs.some((candidate) => tabSortId(candidate) === key);
			const anchor =
				target.kind === "before" || target.kind === "member-before"
					? { beforeKey: target.key }
					: target.kind === "after" || target.kind === "member-after"
						? { afterKey: target.key }
						: undefined;

			// Plain top-level placement of a narrator: one anchored upsert (creates or moves).
			if (target.kind === "empty" || target.kind === "before" || target.kind === "after") {
				void addRecentTabOrThrow(tab, anchor).catch(fail);
				return;
			}
			// Everything else needs the tab to exist first, then the drag plan does the rest.
			// The plan is computed from the cache, which the upsert's delta has already updated
			// (the rendered `tabs` may not have caught up yet).
			void (async () => {
				if (!existing) await addRecentTabOrThrow(tab);
				const latest = (
					qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages ?? []
				).flatMap((page) => page.items as RecentTab[]);
				const model = createRecentTabDragModel(latest, effectiveFolderOptions);
				const plan = planRecentTabDrop(model, key, target, newFolderTitle);
				if (plan) await drag.submitPlan(plan);
			})().catch(fail);
		},
		[qc, t, drag.model, drag.submitPlan, effectiveFolderOptions, newFolderTitle],
	);

	const externalDrop = useRecentTabExternalDrop({
		containerRef: listBoxRef,
		// Project tabs are not narrators, so that section has nothing to accept.
		enabled: filter === "narrator",
		// An internal drag is bridged into the same singleton, so without this gate one
		// drop would be handled twice — by @dnd-kit and by this hook.
		suspended: drag.draggingId !== null,
		suspendedRef: drag.draggingRef,
		measureRows: drag.measureRows,
		sourceFor: externalSourceFor,
		onDrop: handleExternalDrop,
	});

	let overlay: React.ReactNode = null;
	if (drag.draggingTab) {
		const tab = drag.draggingTab;
		overlay =
			tab.type === "folder" ? (
				<RecentTabFolderHeader
					folder={tab}
					members={tabs.filter((member) => member.folderId === tab.id)}
					hidden={[]}
					display="collapsed"
					active={false}
					onToggle={() => {}}
					onContextMenu={() => {}}
					t={t}
				/>
			) : (
				<DragOverlayTabItem tab={tab} active={isTabActive(tab, pathname)} />
			);
	}
	const indicator = drag.indicator ?? externalDrop;
	// The hover card's quick actions: the everyday part of the row menu, one click away.
	const cardActions = useMemo<RecentTabCardActions>(
		() => ({
			onPin: pinTabToggle,
			onRename: renameTabRow,
			onCopyCwd: (tab) => void copyTabCwd(tab),
			onOpenInWindow: openTabInWindow,
			canOpenInWindow: (tab) => recentTabWindowHref(tab) !== null,
			onNewNarratorHere: (tab) => void newNarratorHereFor(tab),
			onArchive: archiveTabRow,
			onClose: closeTabRow,
		}),
		[
			pinTabToggle,
			renameTabRow,
			copyTabCwd,
			openTabInWindow,
			newNarratorHereFor,
			archiveTabRow,
			closeTabRow,
		],
	);

	const ctxTab = ctxMenu?.tab;
	const ctxIsFolder = ctxTab?.type === "folder";
	const ctxInFolder = !!ctxTab?.folderId;
	const ctxUnitKey = ctxTab ? (ctxInFolder ? `folder:${ctxTab.folderId}` : tabSortId(ctxTab)) : "";
	const ctxIsFirst = ctxInFolder
		? (() => {
				const members = tabs.filter((member) => member.folderId === ctxTab?.folderId);
				const zone = members.filter((member) => !!member.pinned === !!ctxTab?.pinned);
				return zone[0] && tabSortId(zone[0]) === tabSortId(ctxTab as RecentTab);
			})()
		: [...pinnedRows, ...unpinnedRows].findIndex((row) => tabSortId(row.tab) === ctxUnitKey) === 0;
	return (
		<RecentTabHoverContext.Provider value={isTouch ? null : hoverStore}>
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
						// Where Ctrl+Up / Ctrl+Down reads the rows it walks (useRecentTabKeyboardNav).
						data-recent-tab-list={filter === "narrator" ? "" : undefined}
						style={{
							// `clip`, not `hidden`: `hidden` makes this box a scroll container, which
							// would trap the folder strip's `position: sticky` inside it instead of
							// letting it stick to the sidebar's real scroller.
							overflow: "clip",
							position: "relative",
							...(topLevelCount === 0 && filter === "narrator" ? { minHeight: 44 } : {}),
						}}
					>
						{indicator && (
							<RecentTabDropIndicator
								rows={indicator.rows}
								target={indicator.target}
								containerTop={indicator.containerTop}
							/>
						)}
						{topLevelCount === 0 ? (
							emptyBody
						) : (
							<>
								{renderRows(pinnedRows)}
								{filter === "narrator" && (
									<RecentTabPinDivider
										clearable={hasClearableTabs}
										onClear={() => clearTabs("inactive_narrators", activeTabKey)}
										touch={isTouch}
										t={t}
									/>
								)}
								{renderRows(unpinnedRows)}
							</>
						)}

						{topLevelCount > 0 &&
							(sectionState.isError ? (
								<Stack gap={2} py={4} align="center" className="nf-nav-expanded-only">
									<Text size="xs" c="red">
										{t("recentTabsSyncError")}
									</Text>
									<Button size="compact-xs" variant="subtle" onClick={sectionState.retry}>
										{t("retryRecentTabs")}
									</Button>
								</Stack>
							) : sectionState.hasMore ? (
								// Not a row, so nothing clips it to the rail: collapsed, it would be
								// painted at the list's full width over the page.
								<Button
									className="nf-nav-expanded-only"
									size="compact-xs"
									variant="subtle"
									fullWidth
									loading={sectionState.isFetchingNextPage}
									onClick={sectionState.loadMore}
								>
									{t("loadMoreRecentTabs")}
								</Button>
							) : null)}

						{ctxMenu && ctxTab && (
							<TabContextMenu
								x={ctxMenu.x}
								y={ctxMenu.y}
								onClose={() => setCtxMenu(null)}
								onMoveToTop={handleMoveToTop}
								onPin={handlePin}
								isPinned={!!ctxTab.pinned}
								pinScope={ctxInFolder ? "folder" : "list"}
								onRemove={handleCtxClose}
								onReveal={handleReveal}
								canReveal={revealAvailable && ctxTab.type !== "project" && !ctxIsFolder}
								onNewNarratorHere={handleNewNarratorHere}
								canNewNarratorHere={newSessionTargetFor(ctxTab) !== null}
								newNarratorHereLabel={ctxIsFolder ? t("newNarratorInFolder") : t("newNarratorHere")}
								onCopyCwd={handleCopyCwd}
								canCopyCwd={["narrator", "subagent"].includes(ctxTab.type)}
								onOpenInWindow={handleOpenInWindow}
								canOpenInWindow={!ctxIsFolder && recentTabWindowHref(ctxTab) !== null}
								onRename={handleRename}
								canRename={ctxTab.type === "narrator"}
								onArchive={handleArchive}
								canArchive={ctxTab.type === "narrator"}
								isFirst={ctxIsFirst}
								folder={
									ctxIsFolder
										? {
												collapsed: (folderDisplays[ctxTab.id] ?? "preview") === "collapsed",
												onEdit: handleEditFolder,
												onToggle: handleCtxFolderToggle,
												onDissolve: handleDissolveFolder,
											}
										: null
								}
								onLeaveFolder={ctxInFolder ? handleLeaveFolder : null}
								gitIdentityNarratorId={ctxTab.type === "narrator" ? ctxTab.id : null}
								gitIdentityFolderId={ctxIsFolder ? ctxTab.id : null}
								detailsTab={isTouch && !ctxIsFolder ? ctxTab : null}
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
						<RecentTabFolderEditModal
							folder={editFolder}
							onClose={() => setEditFolder(null)}
							onSave={updateFolder}
							t={t}
						/>
						<CreateNarratorLazyModal
							opened={newNarratorTarget !== null}
							// 只有"待解析目录的会话目标"才算忙；文件夹目标直接出表单。
							busy={newNarratorTarget?.narratorId != null && newNarratorTarget.cwd == null}
							initialCwd={newNarratorTarget?.cwd}
							// 从文件夹里新建时，弹窗要说清 git 身份跟的是这个文件夹。
							gitIdentityFolderId={newNarratorTarget?.folderId}
							onClose={closeNewNarratorHere}
							onCreated={handleNewNarratorHereCreated}
						/>
					</Box>
					{/* Keep preview rows outside the measured source container. */}
					<DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
						{overlay}
					</DragOverlay>
				</DndContext>
			</RecentTabsDragContext.Provider>
			{!isTouch && (
				<RecentTabDetailCard store={hoverStore} tabs={tabs} actions={cardActions} t={t} />
			)}
		</RecentTabHoverContext.Provider>
	);
}

/** Shared icon component for recent tabs — avoids duplicating icon logic across 4 components. */
function TabIcon({ tab, size, iconColor }: { tab: RecentTab; size: number; iconColor?: string }) {
	// Read from the optimize registry, not from tab props: the request outlives the
	// composer that started it, so the sidebar has to learn about it from the same
	// place the request lives. `TabIcon` is a component (not a render helper) so a
	// hook is legal here even though it is called per row.
	const narratorId = tab.type === "narrator" ? getRecentTabNarratorId(tab) : null;
	const isOptimizingPrompt = useNarratorIsOptimizingPrompt(narratorId);

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
				isOptimizingPrompt={isOptimizingPrompt}
			/>
		);
	}

	let icon: React.ReactNode;
	if (tab.type === "project") icon = <IconFolder size={size} />;
	else icon = <IconRobot size={size} color={iconColor} />;

	// Corner markers remain for subagent rows. The centre state SHAPE (tick / shield /
	// alert) does not: it is knocked out in white and needs the narrator bubble's solid
	// body behind it — the robot glyph is a Tabler OUTLINE icon (stroke only, no closed
	// shape), so a white glyph there would land on the page background and disappear.
	const canShowMarker = tab.type === "subagent";
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

/** Rendered in DragOverlay while a tab is being dragged. */
function DragOverlayTabItem({ tab, active }: { tab: RecentTab; active: boolean }) {
	const iconColor = getNarratorStatusIconColor(tab);
	return (
		<div style={{ overflow: "hidden" }}>
			<NavLink
				active={active}
				label={<RecentTabTitle tab={tab} />}
				leftSection={
					<span style={{ display: "flex" }}>
						<TabIcon tab={tab} size={16} iconColor={iconColor} />
					</span>
				}
				styles={ROW_STYLES_GRABBING}
			/>
		</div>
	);
}

/** A row's only text: its title on one line. Everything else is in the details card. */
function RecentTabTitle({ tab }: { tab: RecentTab }) {
	return (
		<Text size="sm" truncate>
			{tab.title}
		</Text>
	);
}

const ROW_STYLES = {
	root: { cursor: "pointer" },
	label: { overflow: "hidden" },
} as const;
const ROW_STYLES_GRABBING = {
	root: { cursor: "grabbing" },
	label: { overflow: "hidden" },
} as const;

interface TabItemBodyProps {
	tab: RecentTab;
	active: boolean;
	onRemove: (type: RecentTab["type"], id: string) => void;
	/**
	 * Open the row's context menu from a LEFT swipe on touch, where right-click does not
	 * exist — long-press is the drag gesture, and the `contextmenu` it fires is swallowed.
	 */
	onSwipeMenu?: (tab: RecentTab, x: number, y: number) => void;
	onNavigate?: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	onPrefetch?: (tab: RecentTab) => void;
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
 * right-click menu, swipe-right-to-close, swipe-left-for-menu, and dragging the row into
 * a workspace panel or a folder.
 *
 * The body is independent of drag sensors. All list modes share the same gesture
 * wrapper and cross-surface bridge; previews render without interactive drag sources.
 */
function TabItemBody({
	tab,
	active,
	onRemove,
	onSwipeMenu,
	onNavigate,
	onContextMenu,
	onPrefetch,
	isDragging = false,
	outerRef,
	outerStyle,
	dragProps,
}: TabItemBodyProps) {
	const navigate = useNavigate();
	const drag = useContext(RecentTabsDragContext);
	const hover = useContext(RecentTabHoverContext);
	const { t } = useTranslation("common");
	const to = tab.type === "project" ? `/projects/${tab.id}` : `/narrators/${tab.id}`;
	const iconColor = getNarratorStatusIconColor(tab);
	const rowKey = tabSortId(tab);

	const handlePrefetch = useCallback(() => onPrefetch?.(tab), [onPrefetch, tab]);

	// Only this list's synthetic post-drag click is suppressed.
	const handleClick = useCallback(() => {
		if (drag.consumeClick()) return;
		hover?.hide();
		handlePrefetch();
		navigate({ to });
		onNavigate?.();
	}, [drag.consumeClick, hover, handlePrefetch, navigate, to, onNavigate]);

	// Mouse only: touch has no hover, its details live at the top of the row menu.
	const handlePointerEnter = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			handlePrefetch();
			if (e.pointerType !== "mouse" || !hover) return;
			const row = e.currentTarget;
			hover.enter(rowKey, () => row.getBoundingClientRect());
		},
		[handlePrefetch, hover, rowKey],
	);
	const handlePointerLeave = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			if (e.pointerType === "mouse") hover?.leave();
		},
		[hover],
	);

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

	// Touch: right swipe closes, left swipe opens the menu (touch has no right-click).
	const swipe = useRowSwipe({
		isDragging,
		onClose: useCallback(() => onRemove(tab.type, tab.id), [onRemove, tab.type, tab.id]),
		onMenu: useMemo(
			() => (onSwipeMenu ? (x: number, y: number) => onSwipeMenu(tab, x, y) : undefined),
			[onSwipeMenu, tab],
		),
	});

	// Right-click menu; the long-press `contextmenu` on touch is suppressed (it is a drag).
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (swipe.touching()) {
				e.preventDefault();
				return;
			}
			hover?.hide();
			onContextMenu(e, tab);
		},
		[onContextMenu, tab, swipe.touching, hover],
	);

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
				// Anchor for the swipe-left menu hint.
				position: "relative",
			}}
			data-tab-sort-id={tabSortId(tab)}
		>
			<SwipeMenuHint swipeX={swipe.swipeX} label={t("swipeMenu")} />
			<div style={swipe.style}>
				<NavLink
					active={active}
					onClick={handleClick}
					onPointerEnter={handlePointerEnter}
					onPointerLeave={handlePointerLeave}
					onFocus={handlePrefetch}
					onMouseDown={handleMouseDown}
					onAuxClick={handleAuxClick}
					onContextMenu={handleContextMenu}
					{...swipe.handlers}
					label={<RecentTabTitle tab={tab} />}
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
							<TabIcon tab={tab} size={16} iconColor={iconColor} />
						</span>
					}
					styles={ROW_STYLES}
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

/** Folder header as a drag source: dragging it moves the whole folder. */
function DraggableFolderHeader(
	props: Omit<RecentTabFolderHeaderProps, "outerRef" | "dragProps" | "isDragging" | "consumeClick">,
) {
	const drag = useContext(RecentTabsDragContext);
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `folder:${props.folder.id}`,
		disabled: drag.pending,
	});
	return (
		<RecentTabFolderHeader
			{...props}
			isDragging={isDragging}
			outerRef={setNodeRef}
			dragProps={{ ...attributes, ...listeners }}
			consumeClick={drag.consumeClick}
		/>
	);
}

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
 * row would stay subtitle-less until someone opened it.
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
