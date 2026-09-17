import { formatLocaleNumber } from "@frontend/lib/intl-format";
import { narratorColumnPlaceholderStyle } from "@frontend/lib/narrator-content-column";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import type { AsyncQuestion } from "@frontend/types/narrator";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Drawer,
	Group,
	Loader,
	Menu,
	Modal,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { DEFAULT_CONTEXT_THRESHOLDS } from "@shared/context-thresholds";
import { tailRoleAllowsContinue } from "@shared/continue-tail";
import type {
	FileReference,
	FileReferenceContext,
	FileReferenceEditorSelection,
} from "@shared/file-reference";

import {
	IconArrowDown,
	IconArrowLeft,
	IconArrowsMinimize,
	IconCopy,
	IconEraser,
	IconExternalLink,
	IconGitFork,
	IconSettings,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveSwipeAnchorOffScreen } from "../../hooks/scroll-parent";
import {
	useAnswerAsyncQuestion,
	useAsyncQuestions,
	useDismissAsyncQuestion,
} from "../../hooks/useAsyncQuestions";
import { useCurrentUser } from "../../hooks/useAuth";
import { useChapter } from "../../hooks/useChapters";
import { useChatUnread, useNarratorChatRoom } from "../../hooks/useChat";
import { useGitWorkspace } from "../../hooks/useGit";
import { loadedHumanAttentionItems, useHumanAttention } from "../../hooks/useHumanAttention";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useLodIndicatorTrigger } from "../../hooks/useLodIndicatorTrigger";
import { useModelCardIndex } from "../../hooks/useModelCards";
import { useAllModels } from "../../hooks/useModels";
import {
	useArchiveNarrator,
	useCreateNarrator,
	useEnterPlanMode,
	useExitPlanMode,
	useInterruptNarrator,
	useNarrator,
	usePromoteNarrator,
	useStopTakeoverSubagent,
	useTakeoverSubagent,
	useUpdateFastMode,
	useUpdateModel,
	useUpdatePermissionMode,
	useUpdateReasoningEffort,
	useUpdateReflectionOverrides,
	useUpdateRelaxedPlan,
	useUpdateSubagentConclusion,
} from "../../hooks/useNarrator";
import { useNarratorLod } from "../../hooks/useNarratorLod";
import {
	useNarratorBrowserSessionsCapability,
	useNarratorCompactCapability,
	useNarratorPermissionsCapability,
	useNarratorPlanModeCapability,
	useNarratorRetryRecoveryCapability,
	useNarratorRollbackEditRegenerateCapability,
	useNarratorSubagentsCapability,
	useProviderModelRefreshCapability,
	useProviderRuntimeCapability,
} from "../../hooks/usePlatform";
import { useSpecTasks } from "../../hooks/useSpec";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { ApiError, api } from "../../lib/api";
import type { RevertScope } from "../../lib/api/narrators";
import { statusRegistry } from "../../lib/constants";
import { collectElementTextPreview, compactWhitespacePreview } from "../../lib/dom-text";
import {
	calculateEffectiveTurnElapsedMs,
	formatColonDuration,
	formatFullLocaleDateTime,
} from "../../lib/format";

import { requestNugModelRefreshOnPickerOpen } from "../../lib/nug-model-refresh";
import { formatRevertWarnings } from "../../lib/revert-warnings";
import {
	SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
	SAFE_AREA_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
} from "../../lib/safe-area";
import { Z } from "../../lib/z-index";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { SelectionPopover } from "../common/SelectionPopover";
import { TruncatedPath } from "../common/TruncatedPath";
import { buildPluginDockPanelOpenRequest } from "../plugins/PluginContributionPicker";
import { usePluginUiSurface } from "../plugins/PluginUiSurfaceContext";
import {
	BackgroundTasksDrawerHost,
	useBackgroundTasksButton,
} from "./background/BackgroundTasksDrawer";
import {
	COMPACTING_MARKER_ATTR,
	CompactSummaryModal,
	CompactSummaryModalCtx,
} from "./compact/compact-summary-modal";
import { useCompactSummaryModal } from "./compact/use-compact-summary-modal";
import type { FileReferenceScopeValue } from "./composer/FileReferenceScope";
import type { NarratorComposerHandle, NarratorRemoteDraft } from "./composer/NarratorComposer";
import { ContentViewerEnvironmentProvider } from "./content/ContentViewer";
import { ContextThresholdSettingsModal } from "./context-management/ContextThresholdSettingsModal";
import {
	type ContextManagementDraft,
	DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
	DEFAULT_CONTEXT_THRESHOLDS_DRAFT,
} from "./context-management/types";
import { useNarratorDockContext } from "./dock/NarratorDockContext";
import { HeaderToolbar } from "./header/HeaderToolbar";
import { NarratorPanelHeaderTitle } from "./header/NarratorPanelHeaderTitle";
import {
	getNarratorStatusBarDisplay,
	planNarratorWorkIndicator,
} from "./header/narrator-status-bar";
import type { NarratorToolbarBadgeCounts } from "./header/narrator-toolbar-badges";
import type { NarratorToolbarHost } from "./header/narrator-toolbar-items";
import { DropOverlay } from "./interaction/DropOverlay";
import { buildMobileToolbarActions } from "./interaction/mobile-toolbar-actions";
import {
	normalizeBooleanOverride,
	normalizeDangerReflectionLevel,
	normalizeDangerReflectionOverride,
} from "./interaction/reflection-types";
import { SetGlobalModelModal } from "./interaction/SetGlobalModelModal";
import { useComposerAttachments } from "./interaction/use-composer-attachments";
import { useComposerFileIngest } from "./interaction/use-composer-file-ingest";
import { useInternalFileViewer } from "./interaction/use-internal-file-viewer";
import { useInterruptLongPress } from "./interaction/use-interrupt-long-press";
import { useMessageRevertConfirm } from "./interaction/use-message-revert-confirm";
import { useNarratorForkActions } from "./interaction/use-narrator-fork-actions";
import { useNarratorSend } from "./interaction/use-narrator-send";
import { usePermissionFocusNav } from "./interaction/use-permission-focus-nav";
import { useResolvedModel } from "./interaction/use-resolved-model";
import { LodSwitchToast } from "./lod/LodSwitchToast";
import { type RenderLod, RenderLodCtx } from "./lod/RenderLodCtx";
import { MobileToolPanelHost, type MobileToolPanelKind } from "./MobileToolPanelHost";
import { EditingMessageCtx, type EditingMessageState } from "./message/EditingMessageCtx";
import { BLOCK_ID_ATTR, MessageSelectionCtx } from "./message/MessageSelectionCtx";
import type { MessageListHandle, MessageListTailMeta } from "./message/message-list-handle";
// TEMPORARY: streaming harness activity flag (see ./mock/README-REMOVAL.md).
// Store-only import — the panel component itself is lazy-loaded by the dock.
import { useMockStreamActive } from "./mock/mock-stream-store";
import {
	formatKimiBarText,
	formatKimiDetailsText,
	isKimiProviderBaseUrl,
} from "./model/kimi-usage-format";
import { NugRechargeDialog } from "./model/NugRechargeDialog";
import { useNarratorQuota } from "./model/use-narrator-quota";
import { useNugQuota } from "./model/use-nug-quota";
import { NarratorInteractionArea } from "./NarratorInteractionArea";
import { NarratorMessageListSkeleton } from "./NarratorMessageListSkeleton";
import { NarratorPanelSkeleton } from "./NarratorPanelSkeleton";
import type { AsyncQuestionSlot, NarratorPanelProps } from "./narrator-panel-types";
import { LeakedToolCallModal } from "./permission/LeakedToolCallModal";
import { RevertActionConfirmModal } from "./permission/RevertScopeConfirmModal";
import { compactProgressLabel } from "./progress-label";
import { toBannerQuestions } from "./question/async-question-questions";
import { SwipeAnchorOverlay } from "./scroll/SwipeAnchorOverlay";
import { resolveSelectionOverlayBlockId } from "./scroll/selection-anchor-overlay";
import { type SwipeAnchorInfo, setGlobalOnSwipeAnchorInfo } from "./scroll/swipeState";
import { useMessageSelection } from "./selection/use-message-selection";
import { revealSpecFile } from "./spec/spec-file-reveal";
import {
	AllowRetryCtx,
	FileModDrawerCtx,
	LatestTodosToolUseIdCtx,
	PermEnterHintCtx,
} from "./tool-call/tool-call-contexts";
import { useNarratorPanelWS } from "./useNarratorPanelWS";

/* ── Shared menu-item renderers (desktop NativeSelect + mobile ActionIcon share these) ── */

const NarratorDetailsPanel = lazy(() =>
	import("./details/NarratorDetailsPanel").then((module) => ({
		default: module.NarratorDetailsPanel,
	})),
);

const SpecPanel = lazy(() =>
	import("./spec/SpecPanel").then((module) => ({ default: module.SpecPanel })),
);
const FileModificationsDrawer = lazy(() =>
	import("./file-panel/FileModificationsDrawer").then((module) => ({
		default: module.FileModificationsDrawer,
	})),
);
// Body of the read-only file viewer. Shared with the `file` dock panel — the
// drawer below is just the off-dock (mobile) host for the same content, so both
// surfaces show the same viewer instead of the drawer growing its own.
const FileViewerContent = lazy(() =>
	import("./file-viewer/FileViewerContent").then((module) => ({
		default: module.FileViewerContent,
	})),
);

// Flag-gated pretext virtualized list. Now the default renderer, but still lazily
// imported so an explicit opt-out (Virtual OFF) never bundles vlist; the isolation
// guard requires this dynamic import (no static import of vlist from outside the
// vlist/ directory). The exact-layout shell is the sole Virtual renderer (the band
// path has been retired).
const PretextExactMessageList = lazy(() =>
	import("./vlist/PretextExactMessageList").then((module) => ({
		default: module.PretextExactMessageList,
	})),
);

/** Mount the lazy drawer only after it is first opened; keep it mounted on close. */
export function shouldRenderFileModificationsDrawer(
	opened: boolean,
	hasBeenOpened: boolean,
): boolean {
	return opened || hasBeenOpened;
}

/**
 * Stable empty list for the async-question inbox.
 *
 * A fresh `[]` per render would give the slot memo a new dependency every time and
 * rebuild the map (and with it every mounted question form) on unrelated renders.
 */
const EMPTY_ASYNC_QUESTIONS: AsyncQuestion[] = [];

type CompactingMarkerKind = "context" | "segment";

function getMessageViewportScrollBottom(scroller: HTMLElement) {
	return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

function _getMessageViewportDistanceFromBottom(scroller: HTMLElement) {
	return getMessageViewportScrollBottom(scroller) - scroller.scrollTop;
}

export function NarratorPanel({
	narratorId,
	narrator: narratorProp,
	onForkFromMessage,
	highlightMessageId,
	highlightRequestId,
	onSendToTerminal,
	appendInputRef,
	terminalOpen,
	onToggleTerminal,
	compact,
	ownsHorizontalSafeArea = false,
	onMinimize,
	onBack,
	onOpenStandalonePage,
	onViewSubagentSession,
	onHeaderPointerDown,
	onClose,
	onOpenTerminalPanel,
	workspacePreview,
	suppressAutoFocusOnPromote,
	fileModPanelOpen,
	onToggleFileModPanel,
	onFileModPropsChange,
	detailsPanelOpen,
	onToggleDetailsPanel,
	onDetailsPropsChange,
	specPanelOpen,
	onToggleSpecPanel,
}: NarratorPanelProps) {
	const navigate = useNavigate();
	const { data: fetchedNarrator } = useNarrator(narratorId);
	const narrator = narratorProp ?? fetchedNarrator;
	const humanAttentionQuery = useHumanAttention(!workspacePreview);
	const attentionItems = loadedHumanAttentionItems(humanAttentionQuery.data?.pages);
	// Only synchronous decisions owned by this session already have a tail prompt.
	// Async asks (even when awaited), child sessions and unknown pages still need the inbox.
	const showHumanAttentionInbox =
		humanAttentionQuery.isError ||
		humanAttentionQuery.hasNextPage ||
		attentionItems.length === 0 ||
		attentionItems.some(
			(item) => item.narratorId !== narratorId || item.source === "question" || !item.blocking,
		);
	const relaxedPlanForced = narrator?.permissionMode === "bypassPermissions";
	const relaxedPlanEnabled = relaxedPlanForced || narrator?.relaxedPlan === true;

	// Unified dockview surface (optional): when present, the chat panel publishes
	// its cross-panel state (file-mod / details / browser) into the context and
	// bridges chat input to it, so sibling tool panels can consume it. Outside a
	// provider these all fall back to the legacy prop callbacks.
	const dock = useNarratorDockContext();
	const pluginSurface = usePluginUiSurface();
	// Effective sidebar callbacks: prefer explicit props, else route through dock.
	const effOnFileModPropsChange = onFileModPropsChange ?? dock?.setFileModProps;
	const effOnDetailsPropsChange = onDetailsPropsChange ?? dock?.setDetailsProps;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterId = (narrator as any)?.chapterId as string | null | undefined;
	const { data: chapterData } = useChapter(chapterId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const projectId = (chapterData as any)?.projectId as string | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterStatus = (chapterData as any)?.status as string | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterWorktreePath = (chapterData as any)?.worktreePath as string | null | undefined;
	const isChapterMerged = chapterStatus === "merged";
	const createNarratorMutation = useCreateNarrator();
	const updateConclusionMutation = useUpdateSubagentConclusion();
	const takeoverMutation = useTakeoverSubagent();
	const stopTakeoverMutation = useStopTakeoverSubagent();
	const isWorkspacePreview = workspacePreview === true;
	const gitWorkspaceQuery = useGitWorkspace(isWorkspacePreview ? null : narratorId);
	// Chunk mode is the only live message-list implementation. Workspace
	// previews use a separate lightweight tail-chunk query below.
	const [chunkTailMeta, setMessageListTailMeta] = useState<MessageListTailMeta>({
		lastRealMessage: null,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		setMessageListTailMeta({ lastRealMessage: null });
	}, [narratorId]);
	const handleMessageListTailMetaChange = useCallback((meta: MessageListTailMeta) => {
		setMessageListTailMeta((prev) => {
			if (
				prev.statusReady === meta.statusReady &&
				prev.lastRealMessage?.id === meta.lastRealMessage?.id &&
				prev.lastRealMessage?.role === meta.lastRealMessage?.role &&
				prev.lastUserMessageId === meta.lastUserMessageId &&
				prev.contextPercent === meta.contextPercent &&
				prev.turnUsageJson === meta.turnUsageJson &&
				prev.latestSpecTasksToolUseId === meta.latestSpecTasksToolUseId
			) {
				return prev;
			}
			return meta;
		});
	}, []);
	const [_messageRenderPhase, setMessageRenderPhase] = useState<"tail" | "full">(() =>
		highlightMessageId ? "full" : "tail",
	);
	useEffect(() => {
		if (highlightMessageId) setMessageRenderPhase("full");
	}, [highlightMessageId]);
	const interruptMutation = useInterruptNarrator();
	const archiveMutation = useArchiveNarrator();
	const permModeMutation = useUpdatePermissionMode();
	const enterPlanModeMutation = useEnterPlanMode();
	const exitPlanModeMutation = useExitPlanMode();
	const promoteMutation = usePromoteNarrator();
	const reasoningEffortMutation = useUpdateReasoningEffort();
	const fastModeMutation = useUpdateFastMode();
	const relaxedPlanMutation = useUpdateRelaxedPlan();
	const reflectionOverridesMutation = useUpdateReflectionOverrides();
	const modelMutation = useUpdateModel();
	const {
		visibleWithDefault: allModels,
		groupedModels,
		defaultModelValue,
		summaryModelValue,
		settingsData,
		aggregations,
		providerLabels,
		nugProviderIdByPrefix,
	} = useAllModels();
	const modelCardIndex = useModelCardIndex();
	const { data: currentUser } = useCurrentUser();
	const currentUserId = currentUser?.id ? String(currentUser.id) : null;
	const { data: userPrefs } = useUserPreferences();
	const updateUserPrefs = useUpdateUserPreferences();
	const fastModeDefault = userPrefs?.fastModeDefault ?? false;
	const isMobileViewport = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const isCoarsePointer = useMediaQuery("(hover: none), (pointer: coarse)") ?? false;
	const fastModeUsesTapSettings = isMobileViewport || isCoarsePointer;

	const contentViewerEnvironment = useMemo(
		() => ({
			isMobile: isMobileViewport,
			defaultWraps: {
				markdown: userPrefs?.wordWrapMarkdown ?? true,
				code: userPrefs?.wordWrapCode ?? true,
				diff: userPrefs?.wordWrapDiff ?? true,
			},
		}),
		[
			isMobileViewport,
			userPrefs?.wordWrapCode,
			userPrefs?.wordWrapDiff,
			userPrefs?.wordWrapMarkdown,
		],
	);
	const { t, i18n } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const narratorPermissionsCapability = useNarratorPermissionsCapability();
	const availablePermissionModes = narratorPermissionsCapability.supported
		? narratorPermissionsCapability.modes
		: [];
	const permissionModesUnavailableReason = narratorPermissionsCapability.supported
		? undefined
		: (narratorPermissionsCapability.reason ?? t("permissionModesUnavailable"));
	const permissionReflections = narratorPermissionsCapability.reflections;
	const planReflectionSupported = permissionReflections.includes("plan");
	const dangerReflectionSupported = permissionReflections.includes("danger");
	const planModeCapability = useNarratorPlanModeCapability();
	const planModeSupported = planModeCapability.supported;
	const planModeUnsupportedReason = planModeSupported
		? undefined
		: (planModeCapability.reason ?? t("planModeUnavailable"));
	const retryRecoveryCapability = useNarratorRetryRecoveryCapability();
	const retryRecoverySupported = retryRecoveryCapability.supported;
	const retryRecoveryAllowsRetry =
		retryRecoverySupported && retryRecoveryCapability.retry !== false;
	const retryRecoveryAllowsContinue =
		retryRecoverySupported && retryRecoveryCapability.continue !== false;
	const retryRecoveryAllowsInterrupt =
		retryRecoverySupported && retryRecoveryCapability.interrupt !== false;
	const compactCapability = useNarratorCompactCapability();
	const compactSupported = compactCapability.supported;
	const compactUsesFallbackSummary = compactCapability.fallbackSummary === true;
	const compactFallbackSummaryReason =
		compactCapability.fallbackReason ?? t("compactFallbackSummaryDesc");
	const compactUnsupportedReason = compactCapability.reason ?? t("compactUnsupported");
	const rollbackEditRegenerateCapability = useNarratorRollbackEditRegenerateCapability();
	const rollbackEditRegenerateSupported = rollbackEditRegenerateCapability.supported;
	const rollbackEditRegenerateUnsupportedReason =
		rollbackEditRegenerateCapability.reason ?? t("rollbackEditRegenerateUnsupported");
	const browserSessionsCapability = useNarratorBrowserSessionsCapability();
	const confirm = useConfirmDialog();
	const { t: tt } = useTranslation("terminal");
	/*
	 * Unread count for the discussion-room toolbar entry.
	 *
	 * Deliberately NOT gated on `dock` any more. It used to be, on the premise that
	 * a dock surface is "the only surface with a panel to open" — that premise is no
	 * longer true (MobileToolPanelHost opens the room in a Drawer), and leaving the
	 * gate would have made the mobile badge silently read zero: the room would never
	 * resolve, so `byRoom[...]` would have nothing to look up and the entry would
	 * claim there was nothing to read.
	 *
	 * Still skipped for workspace previews, which stay lightweight and offer no
	 * tool entries at all.
	 */
	const userChatRoomQuery = useNarratorChatRoom(narratorId, !isWorkspacePreview);
	const chatUnreadQuery = useChatUnread();
	const userChatRoomId = userChatRoomQuery.data?.id;
	const userChatUnread = userChatRoomId ? (chatUnreadQuery.data?.byRoom[userChatRoomId] ?? 0) : 0;
	const qc = useQueryClient();
	const executionDevicesQuery = useQuery({
		queryKey: ["narratorExecutionDevices", narratorId],
		queryFn: () => api.getNarratorExecutionDevices(narratorId),
		enabled: !isWorkspacePreview,
		// 设备列表变化缓慢, 60s 轮询足够
		refetchInterval: 60_000,
	});
	const updateExecutionDeviceMutation = useMutation({
		mutationFn: (deviceId: string | null) => api.updateNarratorDefaultDevice(narratorId, deviceId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narratorExecutionDevices", narratorId] });
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
			qc.resetQueries({ queryKey: ["gitWorkspace", narratorId] });
		},
		onError: (error) =>
			notifications.show({
				color: "red",
				message: error instanceof Error ? error.message : String(error),
			}),
	});
	const updateSettingsMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
			// Only invalidate contextThresholds — settings cache is already
			// updated via setQueryData above, no need to trigger a refetch.
			qc.invalidateQueries({ queryKey: ["contextThresholds"] });
		},
	});
	// Which global model the "edit" modal is targeting ("default" | "summary" | null).
	const [globalModelEditTarget, setGlobalModelEditTarget] = useState<"default" | "summary" | null>(
		null,
	);
	const handleSetDefaultModel = useCallback(
		(model: string) => {
			updateSettingsMutation.mutate(
				{ agent: { defaultModel: model } },
				{
					onSuccess: () => {
						notifications.show({ message: t("defaultModelUpdated") });
						setGlobalModelEditTarget(null);
					},
				},
			);
		},
		[updateSettingsMutation, t],
	);
	const handleSetSummaryModel = useCallback(
		(model: string) => {
			updateSettingsMutation.mutate(
				{ agent: { summaryModel: model } },
				{
					onSuccess: () => {
						notifications.show({ message: t("summaryModelUpdated") });
						setGlobalModelEditTarget(null);
					},
				},
			);
		},
		[updateSettingsMutation, t],
	);
	// Re-fetch one NUG gateway's model catalog straight from the model menu. This
	// is also how a stale "temporarily unavailable" flag gets cleared, since a
	// refresh replaces the cached list wholesale.
	const nugModelRefreshCapability = useProviderModelRefreshCapability("nug");
	const nugRuntimeCapability = useProviderRuntimeCapability("nug");
	const canRefreshNugModels =
		nugModelRefreshCapability.supported &&
		nugRuntimeCapability?.routes?.supported !== false &&
		nugRuntimeCapability?.routes?.perProviderModelsRefresh !== false;
	const [refreshingNugProviderId, setRefreshingNugProviderId] = useState<string | null>(null);
	const handleRefreshNugModels = useCallback(
		async (providerId: string) => {
			setRefreshingNugProviderId(providerId);
			try {
				await api.nugRefreshProviderModels(providerId);
				await qc.invalidateQueries({ queryKey: ["settings"] });
			} catch (error) {
				notifications.show({
					color: "red",
					title: t("refreshProviderModelsErrorTitle"),
					message: error instanceof Error ? error.message : String(error),
				});
			} finally {
				setRefreshingNugProviderId(null);
			}
		},
		[qc, t],
	);
	// Opening the picker also kicks off an opportunistic catalog refresh, so a
	// model that recovered upstream stops showing as "temporarily unavailable"
	// without the user having to find the per-provider refresh button. The real
	// rate limit is a process-wide cooldown on the server; `requestNugModelRefresh…`
	// only avoids redundant round-trips from this tab.
	const handleModelPickerOpened = useCallback(() => {
		void requestNugModelRefreshOnPickerOpen().then((refreshed) => {
			if (refreshed) qc.invalidateQueries({ queryKey: ["settings"] });
		});
	}, [qc]);
	const hasNugModelGroups = Object.keys(nugProviderIdByPrefix).length > 0;
	const modelMenuRefreshProps = canRefreshNugModels
		? {
				nugProviderIdByPrefix,
				onRefreshProviderModels: (providerId: string) => {
					void handleRefreshNugModels(providerId);
				},
				refreshingProviderId: refreshingNugProviderId,
				// No NUG gateway in the picker → nothing to refresh, so don't even ask.
				...(hasNugModelGroups ? { onPickerOpened: handleModelPickerOpened } : {}),
			}
		: {};
	const dangerReflectionGlobalLevel = normalizeDangerReflectionLevel(
		settingsData?.agent?.dangerReflectionLevel,
		settingsData?.agent?.dangerReflectionEnabled ?? true,
	);
	const dangerReflectionGlobal = dangerReflectionGlobalLevel !== "off";
	const planReflectionAutoApproveGlobal = settingsData?.agent?.planReflectionAutoApprove ?? false;
	const reflectionSettingsDisabled =
		!settingsData || updateSettingsMutation.isPending || reflectionOverridesMutation.isPending;
	const contextThresholdSettings = useMemo<ContextManagementDraft>(() => {
		const thresholds = settingsData?.agent?.contextThresholds ?? DEFAULT_CONTEXT_THRESHOLDS_DRAFT;
		return {
			contextThresholds: {
				standard: {
					compactStart:
						thresholds.standard?.compactStart ??
						DEFAULT_CONTEXT_THRESHOLDS_DRAFT.standard.compactStart,
				},
				large: {
					compactStart:
						thresholds.large?.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS_DRAFT.large.compactStart,
				},
			},
			autoCompactKeepPairs:
				settingsData?.agent?.autoCompactKeepPairs ?? DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
		};
	}, [settingsData?.agent]);
	const handlePromote = useCallback(() => {
		promoteMutation.mutate(narratorId, {
			onSuccess: (data) => {
				if (data.type === "forked" && data.chapter) {
					notifications.show({
						message: t("promote_success_forked"),
						color: "teal",
					});
					navigate({
						to: "/projects/$projectId",
						params: {
							projectId: (data.chapter as Record<string, string>).projectId,
						},
					});
				} else {
					notifications.show({
						message: t("promote_success_unlocked"),
						color: "teal",
					});
				}
			},
			onError: (error: Error) => {
				notifications.show({
					message: error.message,
					color: "red",
					autoClose: 5000,
				});
			},
		});
	}, [promoteMutation, narratorId, t, navigate]);

	/**
	 * A chapter node's header already shows this title and owns the edit / generate
	 * actions, so drawing them again here is not just redundant — this header's dozen
	 * tool buttons squeezed the title to zero width, leaving the node with a header
	 * full of icons and no readable title at all. The whole title block is dropped in
	 * that case, which also hands its width to the tool row.
	 *
	 * The editing state below stays wired up: every other surface (focus page,
	 * workspace, detached subagent panel) still renders this block.
	 */
	const hostOwnsTitle = dock?.hostOwnsTitle === true;

	/*
	 * Header geometry for the tool-row capacity measurement. The ROW is the budget
	 * source: its width does not depend on how many entries are inline, which is
	 * what keeps the decision from cascading (see narrator-header-toolbar-capacity).
	 */
	const headerRowRef = useRef<HTMLDivElement>(null);
	const headerLeadingRef = useRef<HTMLDivElement>(null);
	const headerToolbarRef = useRef<HTMLDivElement>(null);

	// Resolve the effective model: when following default, use the actual default
	// model value; when using a model aggregation, resolve to a representative
	// concrete member so capability/context-window lookups work (the backend
	// resolves the actual member at request time).
	// Only the model *resolution* stays in the panel: resolvedModel feeds the NUG
	// quota, Kimi usage and context-threshold queries and the WS state below. The
	// reasoning/codex/fast-mode/permission control derivations moved down into the
	// status bar (see useStatusBarProps), which is where they are consumed.
	const { resolvedModel, resolvedProvider, resolvedBareModel, resolvedModelOption } =
		useResolvedModel(narrator?.model, defaultModelValue, aggregations, allModels);

	// Fetch context thresholds for the current model (used as fallback when WS hasn't pushed yet)
	const { data: modelThresholds } = useQuery({
		queryKey: ["contextThresholds", resolvedBareModel, resolvedProvider],
		queryFn: () => api.getContextThresholds(resolvedBareModel, resolvedProvider),
		staleTime: 5 * 60 * 1000,
		placeholderData: DEFAULT_CONTEXT_THRESHOLDS.standard,
	});

	// NUG quota data layer (provider config + quota queries + cache writeback +
	// derived provider info). Kept lifted here because the derived info feeds the
	// shared `useNarratorPanelWS` below and the payment-required recharge logic.
	const nugProviderInfo = useNugQuota(resolvedModel, settingsData?.nugProviders);

	// Kimi (kimi.com / kimi.ai) usage quotas — server keeps one global cache per
	// provider; GET triggers a stale-while-revalidate refresh upstream. The query
	// stays disabled unless the current narrator's provider is a Kimi provider,
	// so nothing polls while Kimi is not in use.
	const currentKimiProviderId = useMemo(() => {
		const prefix = resolvedModel?.split(":")[0];
		if (!prefix) return null;
		const cfg = (
			(settingsData?.customApiProviders ?? []) as Array<{
				id: string;
				prefix?: string;
				baseUrl?: string;
				disabled?: boolean;
			}>
		).find((p) => p.prefix === prefix);
		return cfg && !cfg.disabled && isKimiProviderBaseUrl(cfg.baseUrl) ? cfg.id : null;
	}, [resolvedModel, settingsData?.customApiProviders]);
	const { data: kimiUsagesData } = useQuery({
		queryKey: ["kimi", "usages"],
		queryFn: api.kimiGetUsages,
		enabled: currentKimiProviderId != null,
		staleTime: 30_000,
		refetchInterval: 60_000,
	});

	// Active terminal count for badge indicator
	const { data: narratorTerminals } = useNarratorTerminals(narratorId);
	const activeTerminalCount = useMemo(
		() => narratorTerminals?.filter((t) => t.status === "running").length ?? 0,
		[narratorTerminals],
	);

	// --- Message operations ---
	const setUnreadCountRef = useRef<React.Dispatch<React.SetStateAction<number>>>(undefined);
	const handleEditAndRegenerate = useCallback(
		async (
			messageId: string,
			newContent: string,
			revertOpts: { skipRevert: boolean; scope?: RevertScope },
			opts?: {
				keepImageIds: string[];
				newImages: File[];
				keepTextFilePaths: string[];
				newTextFiles: File[];
				fileReferences?: FileReference[];
			},
		): Promise<boolean> => {
			if (!rollbackEditRegenerateSupported) {
				notifications.show({
					title: t("rollbackEditRegenerateUnsupportedTitle"),
					message: rollbackEditRegenerateUnsupportedReason,
					color: "yellow",
				});
				return false;
			}
			try {
				const result = await api.editAndRegenerate(narratorId, messageId, newContent, {
					...revertOpts,
					...opts,
				});
				// The rollback this edit performed can reach past the chosen scope
				// (subagent writes, a workspace restore) — reported exactly as it is for
				// rollback-to-block, so the outcome is verified rather than assumed.
				const warningText = formatRevertWarnings(t, result.warnings);
				if (warningText) {
					notifications.show({
						title: t("rollbackPartialTitle"),
						message: warningText,
						color: "yellow",
						autoClose: false,
					});
				}
				return result.ok;
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to edit and regenerate";
				notifications.show({ title: t("editFailed"), message, color: "red" });
				return false;
			}
		},
		[narratorId, rollbackEditRegenerateSupported, rollbackEditRegenerateUnsupportedReason, t],
	);

	const handleEditAssistantMessage = useCallback(
		async (messageId: string, newContent: string) => {
			try {
				await api.editAssistantMessage(narratorId, messageId, newContent);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to edit message";
				notifications.show({ title: t("editFailed"), message, color: "red" });
			}
		},
		[narratorId, t],
	);

	const handleRestoreAssistantMessage = useCallback(
		async (messageId: string) => {
			try {
				await api.restoreAssistantMessage(narratorId, messageId);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to restore message";
				notifications.show({ title: t("editFailed"), message, color: "red" });
			}
		},
		[narratorId, t],
	);

	// --- Editing message state ---
	// Tracks when a MessageBubble is in edit mode so the bottom send/retry
	// button can trigger the edit submit instead of the default action.
	const [editingMessageState, setEditingMessageState] = useState<EditingMessageState | null>(null);
	const editingMessageCtxValue = useMemo(
		() => ({
			register: (state: EditingMessageState) => setEditingMessageState(state),
			unregister: () => setEditingMessageState(null),
		}),
		[],
	);

	// Render detail level. Each narrator remembers its own level (persisted on
	// switch); the global default — saved via the toast's "set as default" — is
	// only the opening level for narrators with no remembered level yet.
	const {
		lod: renderLod,
		isDefault: renderLodIsDefault,
		setLod,
		stepUp,
		stepDown,
		setAsDefault,
	} = useNarratorLod(narratorId);
	const renderLodCtxValue = useMemo(
		() => ({ lod: renderLod, interactive: !isWorkspacePreview }),
		[renderLod, isWorkspacePreview],
	);
	// Stable LOD step handler for the message list's alt+wheel / pinch gestures.
	const handleLodStep = useCallback(
		(dir: 1 | -1) => {
			if (dir > 0) stepUp();
			else stepDown();
		},
		[stepUp, stepDown],
	);

	// Hoist compact-summary modals above the virtualized message rows so a message
	// append/stream update cannot unmount the row and implicitly close the modal.
	const {
		compactSummaryModalTarget,
		setCompactSummaryModalTarget,
		compactSummaryModalCtxValue,
		closeCompactSummaryModal,
	} = useCompactSummaryModal(narratorId);

	// --- Composer (text input) ---
	// The text-input state lives in <NarratorComposer>: it changes on every
	// keystroke, and keeping it here re-rendered this entire (very large) panel
	// per key — measured ~110ms/keystroke in a dev trace. The panel interacts
	// with the text purely through this imperative handle.
	const composerRef = useRef<NarratorComposerHandle>(null);
	const sendingRef = useRef(false);
	// Flips only on the empty↔non-empty boundary (send-button gating, permission
	// Enter hint) — the composer reports the flag, never the text.
	const [composerHasText, setComposerHasText] = useState(false);
	// WS draft_changed events land on the panel-level subscription; forward them
	// into the composer's draft state machine.
	const forwardDraftChanged = useCallback(
		(draft: NarratorRemoteDraft) => composerRef.current?.handleDraftChanged(draft),
		[],
	);

	// Pending composer attachments (images + text files) + their IndexedDB draft
	// persistence. The send flow (hide/clear/restore) and drag handlers below
	// consume these; see the hook for why both kinds share one version counter.
	const {
		attachedImages,
		attachedTextFiles,
		attachedImagesRef,
		attachedTextFilesRef,
		isDragging,
		setIsDragging,
		dragCounterRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		hideAttachedFilesForSend,
		clearAttachedFilesAndDraft,
	} = useComposerAttachments({ narratorId, currentUserId, sendingRef, t });

	// --- Scroll state ---
	const [isAtBottom, setIsAtBottom] = useState(true);
	const viewportRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const chunkListRef = useRef<MessageListHandle>(null);

	// Confirm-then-apply flow for the two destructive history actions (delete tool
	// block / rollback to block). Kept lifted here: the context-menu triggers and
	// the two confirm modals span the panel JSX, and it reads the shared chunkListRef.
	const {
		revertHistorySubmitting,
		pendingBlockDelete,
		setPendingBlockDelete,
		handleDeleteBlock,
		confirmBlockDelete,
		pendingRollback,
		setPendingRollback,
		handleRollback,
		confirmRollback,
	} = useMessageRevertConfirm({
		narratorId,
		chunkListRef,
		rollbackEditRegenerateSupported,
		rollbackEditRegenerateUnsupportedReason,
		t,
	});

	// The message area box — the LOD indicator's containing block, and the hover
	// region that decides whether holding Alt targets THIS panel.
	const messageAreaRef = useRef<HTMLDivElement>(null);
	// Holding Alt reveals the indicator only while the Alt gesture is enabled: with
	// it off, Alt is not an LOD modifier at all, so it must not summon LOD UI.
	const [lodAltGesture] = useLocalPref("narrafork_lod_alt_gesture");
	const lodIndicatorPinned = useLodIndicatorTrigger(
		messageAreaRef,
		!isWorkspacePreview && lodAltGesture,
	);
	// Indicator-driven level pick (notch click or −/+). Unlike the gestures there
	// is no pointer event to anchor on, so anchor on the indicator's own position
	// (the middle of the message area) before the rebuild — otherwise picking a
	// level would jump the content the user is reading.
	const handleSelectLod = useCallback(
		(next: RenderLod) => {
			const el = messageAreaRef.current;
			if (el) {
				const rect = el.getBoundingClientRect();
				chunkListRef.current?.prepareLodChange(rect.top + rect.height / 2);
			}
			setLod(next);
		},
		[setLod],
	);
	// Reading-width preference, needed here only so the lazy-chunk fallback lays its
	// skeleton out in the same column the list will use (no width step on mount).
	const [narratorCenteredColumn] = useLocalPref("narrafork_narrator_centered_column");
	// TEMPORARY: the mock-stream harness (see ./mock/README-REMOVAL.md). The pref
	// gates both the toolbar entry and the store read, so with it off this costs
	// one constant-false subscription and nothing else.
	const [mockStreamEnabled] = useLocalPref("narrafork_mock_stream");
	const mockStreamActive = useMockStreamActive(narratorId, mockStreamEnabled);
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;
	const scrollToBottomRef = useRef<(instant?: boolean) => void>(() => {});

	// --- Scroll helpers ---
	const followRafRef = useRef(0);
	const followingRef = useRef(false);
	// Suppress detachFromBottom for programmatic scrollTop changes.
	// - `programmaticScrollRef` is a one-shot flag for individual scrollTop writes
	//   (e.g. scrollToBottom instant, startFollowing final snap).
	// - `resizingRef` is a sustained flag that stays true for the entire duration
	//   of a viewport resize (set by vpObserver, cleared after a 150ms debounce).
	//   During a resize, multiple scroll events fire from multiple programmatic
	//   scrollTop writes; a one-shot flag can't cover them all, so we need this
	//   sustained flag to prevent the oscillation loop.
	const programmaticScrollRef = useRef(false);
	const _resizingRef = useRef(false);

	const lastFollowScrollTop = useRef(0);

	const _startFollowing = useCallback(() => {
		if (followingRef.current) return;
		const step = () => {
			const vp = viewportRef.current;
			if (!vp) {
				followingRef.current = false;
				return;
			}
			// If scrollTop decreased since last frame, user scrolled up — stop following
			if (vp.scrollTop < lastFollowScrollTop.current) {
				followingRef.current = false;
				return;
			}
			const target = getMessageViewportScrollBottom(vp);
			const gap = target - vp.scrollTop;
			if (gap < 1.5) {
				programmaticScrollRef.current = true;
				vp.scrollTop = target;
				followingRef.current = false;
				if (!isAtBottomRef.current) {
					isAtBottomRef.current = true;
					setIsAtBottom(true);
					setUnreadCountRef.current?.(0);
				}
				return;
			}
			vp.scrollTop += Math.max(gap * 0.25, 1.5);
			lastFollowScrollTop.current = vp.scrollTop;
			followRafRef.current = requestAnimationFrame(step);
		};
		followingRef.current = true;
		lastFollowScrollTop.current = viewportRef.current?.scrollTop ?? 0;
		followRafRef.current = requestAnimationFrame(step);
	}, []);

	const stopFollowing = useCallback(() => {
		followingRef.current = false;
		cancelAnimationFrame(followRafRef.current);
	}, []);

	const _detachFromFullBottom = useCallback(() => {
		stopFollowing();
		if (isAtBottomRef.current) {
			isAtBottomRef.current = false;
			setIsAtBottom(false);
		}
	}, [stopFollowing]);

	const scrollToBottom = useCallback((instant?: boolean) => {
		chunkListRef.current?.scrollToBottom(instant);
	}, []);
	scrollToBottomRef.current = scrollToBottom;
	// Optimistically flip the cached narrator to "working" after a send, guarding
	// the race where the WS subscribe message hasn't been processed server-side
	// when the status_change event is broadcast.
	const setNarratorWorking = useCallback(() => {
		qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
			old && old.status !== "working"
				? { ...old, status: "working", turnStartedAt: new Date().toISOString() }
				: old,
		);
	}, [qc, narratorId]);
	const wasWorkspacePreviewRef = useRef(isWorkspacePreview);
	useEffect(() => {
		const wasWorkspacePreview = wasWorkspacePreviewRef.current;
		if (wasWorkspacePreview && !isWorkspacePreview) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					scrollToBottom(true);
					if (!suppressAutoFocusOnPromote) {
						composerRef.current?.focus();
					}
				});
			});
		}
		wasWorkspacePreviewRef.current = isWorkspacePreview;
	}, [isWorkspacePreview, scrollToBottom, suppressAutoFocusOnPromote]);

	// --- WebSocket + real-time state ---
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isSubagent = !!(fetchedNarrator as any)?.variant?.startsWith("subagent:");

	// Parse persisted substatus from narrator data to seed the WS hook's reducer
	const narratorSubstatus = useMemo(() => {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const raw = (narrator as any)?.substatus;
		if (!raw) return [];
		if (Array.isArray(raw)) return raw as string[];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? (parsed as string[]) : [];
		} catch {
			return [];
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	}, [(narrator as any)?.substatus]);

	// Resolve custom API provider info for initial generic quota balance
	const customApiProviderInfo = useMemo(() => {
		const prefix = resolvedModel?.split(":")[0];
		if (!prefix) return null;
		const customApiProviders: Array<{ id: string; prefix?: string }> =
			settingsData?.customApiProviders ?? [];
		const cfg = customApiProviders.find((p) => p.prefix === prefix);
		if (!cfg) return null;
		// Kimi providers show structured usage (5h window in the bar, weekly/monthly
		// in the details popover) instead of the generic relay quota string.
		const kimiUsage = kimiUsagesData?.[cfg.id];
		if (kimiUsage) {
			const quotaBalance = formatKimiBarText(kimiUsage, t);
			const detailedQuotaBalance = formatKimiDetailsText(kimiUsage, t);
			if (quotaBalance || detailedQuotaBalance) {
				return { providerId: cfg.id, quotaBalance, detailedQuotaBalance };
			}
		}
		const quotas = settingsData?.customApiQuotas as
			| Record<string, { quotaBalance: string | null; detailedQuotaBalance?: string | null }>
			| undefined;
		const quota = quotas?.[cfg.id];
		const rawDetailedQuotaBalance = quota?.detailedQuotaBalance;
		const detailedQuotaBalance = rawDetailedQuotaBalance?.trim() ? rawDetailedQuotaBalance : null;
		return {
			providerId: cfg.id,
			quotaBalance: quota?.quotaBalance ?? null,
			detailedQuotaBalance,
		};
	}, [
		resolvedModel,
		settingsData?.customApiProviders,
		settingsData?.customApiQuotas,
		kimiUsagesData,
		t,
	]);

	const wsState = useNarratorPanelWS({
		narratorId,
		narratorStatus: narrator?.status,
		narratorErrorMessage: narrator?.errorMessage ?? null,
		initialMessageStatus: chunkTailMeta,
		isAtBottomRef,
		isSubagent,
		narratorSubstatus,
		initialQuotaBalance: customApiProviderInfo?.quotaBalance ?? nugProviderInfo?.quotaBalance,
		initialDetailedQuotaBalance:
			customApiProviderInfo?.detailedQuotaBalance ?? nugProviderInfo?.detailedQuotaBalance,
		customApiProviderId: customApiProviderInfo?.providerId,
		nugProviderId: nugProviderInfo?.providerId,
		quotaProviderKey: customApiProviderInfo?.providerId ?? nugProviderInfo?.providerId,
		onDraftChanged: forwardDraftChanged,
		onQueuedNewNarratorCreated: (newNarratorId) => {
			navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarratorId } });
		},
	});
	// Publish browser session info to the dock so a sibling browser panel can
	// render without being a child of this chat panel. No-op outside dock mode.
	const dockSetBrowserInfo = dock?.setBrowserInfo;
	useEffect(() => {
		dockSetBrowserInfo?.({
			sessionCount: wsState.browserSessionCount,
			visualChange: wsState.browserVisualChange,
		});
	}, [dockSetBrowserInfo, wsState.browserSessionCount, wsState.browserVisualChange]);

	// Auto-open the browser dock panel when a NEW session appears (count rises).
	// The first observed value only seeds the ref so an initial load / reconnect
	// with pre-existing sessions doesn't force the panel open — only a genuine
	// increase (a freshly created session) triggers it. Opening an already-open
	// panel just re-activates it, which is fine when a second session starts.
	const dockOpenToolPanel = dock?.openToolPanel;
	const prevBrowserSessionCountRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		const prev = prevBrowserSessionCountRef.current;
		const cur = wsState.browserSessionCount;
		prevBrowserSessionCountRef.current = cur;
		if (prev === undefined) return;
		if (cur > prev && !isWorkspacePreview && browserSessionsCapability.supported !== false) {
			dockOpenToolPanel?.("browser");
		}
	}, [
		dockOpenToolPanel,
		wsState.browserSessionCount,
		isWorkspacePreview,
		browserSessionsCapability.supported,
	]);

	const {
		disconnected,
		reconnect,
		cancelBuffer,
		renderPermCb,
		queuedMessages,
		setQueuedMessages,
		reconcileBufferedMessages,
		substatus,
		contextPercent,
		promptTokens,
		contextWindow,
		isEstimated,
		contextStale,
		activeCompactStart,
		compactProgress,
		compactFailure,
		quotaBalance,
		detailedQuotaBalance,
		retryInfo,
		paymentRequired,
		setPaymentRequired,
		leakedToolEvent,
		setLeakedToolEvent,
		unreadCount,
		setUnreadCount,
		viewers,
	} = wsState;
	setUnreadCountRef.current = setUnreadCount;
	// Quota display + NUG recharge derivations (flags, dialog disclosure, and the
	// payment-required reconstruction / auto-open effects) live in useNarratorQuota.
	const {
		quotaDetailsText,
		hasQuotaDetailsPopover,
		shouldShowNugRechargeButton,
		shouldShowNugRechargeInQuotaDetails,
		nugRechargeOpened,
		openNugRecharge,
		closeNugRecharge,
	} = useNarratorQuota({
		nugProviderInfo,
		quotaBalance,
		detailedQuotaBalance,
		paymentRequired,
		setPaymentRequired,
		narratorSubstatus,
		narratorErrorMessage: narrator?.errorMessage,
	});

	const handleCompactError = useCallback(
		(err: unknown) => {
			const isInProgress = err instanceof ApiError && err.status === 409;
			notifications.show({
				title: isInProgress ? t("compactInProgress") : t("compactFailed"),
				message: isInProgress ? t("compactInProgressDesc") : t("compactFailedDesc"),
				color: isInProgress ? "yellow" : "red",
				autoClose: 5000,
			});
		},
		[t],
	);

	const handleCompactBefore = useCallback(
		(messageId: string) => {
			if (!compactSupported) {
				notifications.show({
					title: t("compactUnsupportedTitle"),
					message: compactUnsupportedReason,
					color: "yellow",
				});
				return;
			}
			if (compactUsesFallbackSummary) {
				notifications.show({
					title: t("compactFallbackSummaryTitle"),
					message: compactFallbackSummaryReason,
					color: "yellow",
					autoClose: 5000,
				});
			}
			// Compacting state will arrive via substatus_change WS event
			api.triggerCompact(narratorId, messageId).catch((err) => {
				handleCompactError(err);
			});
		},
		[
			narratorId,
			handleCompactError,
			compactSupported,
			compactUnsupportedReason,
			compactUsesFallbackSummary,
			compactFallbackSummaryReason,
			t,
		],
	);

	const handleClearContextBefore = useCallback(
		(messageId: string) => {
			api.clearContext(narratorId, messageId).catch((err) => {
				handleCompactError(err);
			});
		},
		[narratorId, handleCompactError],
	);

	// Manual summarize: insert an empty compact marker before the message, then
	// open its summary editor so the user can write the summary by hand.
	const handleManualSummarize = useCallback(
		(messageId: string) => {
			api
				.clearContext(narratorId, messageId)
				.then((res) => {
					if (res.messageId) {
						setCompactSummaryModalTarget({
							kind: "context",
							narratorId,
							messageId: res.messageId,
							autoEdit: true,
						});
					}
				})
				.catch((err) => {
					handleCompactError(err);
				});
		},
		[narratorId, handleCompactError, setCompactSummaryModalTarget],
	);

	const [archiveConfirmOpened, { open: openArchiveConfirm, close: closeArchiveConfirm }] =
		useDisclosure(false);
	const [internalDetailsOpened, { toggle: toggleInternalDetails, close: closeInternalDetails }] =
		useDisclosure(false);
	// Precedence for the details toggle: dock context (unified surface) > explicit
	// prop callback (legacy desktop sidebar) > internal disclosure (workspace/graph).
	const detailsOpened = dock
		? dock.openToolTypes.has("details")
		: onToggleDetailsPanel
			? (detailsPanelOpen ?? false)
			: internalDetailsOpened;
	const detailsPanelOpenRef = useRef(detailsPanelOpen ?? false);
	detailsPanelOpenRef.current = detailsPanelOpen ?? false;
	const toggleDetails = dock
		? () => dock.toggleToolPanel("details")
		: (onToggleDetailsPanel ?? toggleInternalDetails);
	const closeDetails = useCallback(() => {
		if (dock) {
			dock.closeToolPanel("details");
			return;
		}
		if (onToggleDetailsPanel) {
			if (detailsPanelOpenRef.current) onToggleDetailsPanel();
			return;
		}
		closeInternalDetails();
	}, [dock, closeInternalDetails, onToggleDetailsPanel]);
	const [
		contextThresholdSettingsOpened,
		{ open: openContextThresholdSettingsModal, close: closeContextThresholdSettings },
	] = useDisclosure(false);

	const detailsPanelExternalProps = useMemo(
		() => ({
			narratorId,
			narrator,
			viewers,
			defaultModelValue,
			planReflectionAutoApproveGlobal,
			dangerReflectionGlobal,
			dangerReflectionGlobalLevel,
		}),
		[
			dangerReflectionGlobal,
			dangerReflectionGlobalLevel,
			defaultModelValue,
			narrator,
			narratorId,
			planReflectionAutoApproveGlobal,
			viewers,
		],
	);

	useEffect(() => {
		if (!effOnDetailsPropsChange || !narrator) return;
		// In dock mode publish unconditionally (the details panel may be mounted
		// independently); in legacy prop mode keep the open-gated behaviour.
		if (!dock && !detailsOpened) return;
		effOnDetailsPropsChange(detailsPanelExternalProps);
	}, [dock, detailsOpened, detailsPanelExternalProps, narrator, effOnDetailsPropsChange]);

	// File modifications drawer/panel state
	// When onToggleFileModPanel is provided (desktop sidebar mode), use external state;
	// otherwise use internal state (mobile drawer / workspace fallback).
	const [internalFileModOpen, setInternalFileModOpen] = useState(false);
	const fileModDrawerOpened = dock
		? dock.openToolTypes.has("filemod")
		: onToggleFileModPanel
			? (fileModPanelOpen ?? false)
			: internalFileModOpen;
	const [fileModDrawerHasOpened, setFileModDrawerHasOpened] = useState(false);
	useEffect(() => {
		if (fileModDrawerOpened) setFileModDrawerHasOpened(true);
	}, [fileModDrawerOpened]);
	const fileModPanelOpenRef = useRef(fileModPanelOpen ?? false);
	fileModPanelOpenRef.current = fileModPanelOpen ?? false;
	const externalSetFileModOpened = useCallback(
		(v: boolean | ((prev: boolean) => boolean)) => {
			if (!onToggleFileModPanel) return;
			if (typeof v === "function") {
				const next = v(fileModPanelOpenRef.current);
				if (next !== fileModPanelOpenRef.current) onToggleFileModPanel();
			} else if (v !== fileModPanelOpenRef.current) {
				onToggleFileModPanel();
			}
		},
		[onToggleFileModPanel],
	);
	const dockFileModToggle = useCallback(
		(v: boolean | ((prev: boolean) => boolean)) => {
			if (!dock) return;
			const cur = dock.openToolTypes.has("filemod");
			const next = typeof v === "function" ? v(cur) : v;
			if (next !== cur) dock.toggleToolPanel("filemod");
		},
		[dock],
	);
	const setFileModDrawerOpened = dock
		? dockFileModToggle
		: onToggleFileModPanel
			? externalSetFileModOpened
			: setInternalFileModOpen;

	// Spec toggle: three mutually-exclusive routes, in precedence order.
	//  1. dock spec tab   — the unified surface, but ONLY for the dock's own base
	//     narrator. When a subagent session is pushed into the dock, `dock.narratorId`
	//     still points at the parent, so the dock spec panel would show the parent's
	//     tasks (data mismatch). Detect that via `subagentInDock` and fall through.
	//  2. onToggleSpecPanel — legacy external callback (mobile drawer).
	//  3. internal drawer  — off-dock / pushed-subagent view. Renders SpecPanel bound
	//     to THIS panel's narratorId, so subagents show their own tasks. Excluded for
	//     workspace previews, which stay lightweight (mirrors `tasksButtonEnabled`).
	const [internalSpecOpen, setInternalSpecOpen] = useState(false);
	const subagentInDock = !!dock && dock.narratorId !== narratorId;
	const useDockSpec = !!dock && !subagentInDock;
	const useInternalSpec = !useDockSpec && !onToggleSpecPanel && !isWorkspacePreview;
	// Button availability mirrors the render conditions exactly: whenever a spec
	// surface exists (dock / external / internal), the toolbar entry point exists.
	const specToolAvailable = useDockSpec || !!onToggleSpecPanel || useInternalSpec;
	const specToolOpened = useDockSpec
		? dock.openToolTypes.has("spec")
		: onToggleSpecPanel
			? (specPanelOpen ?? false)
			: internalSpecOpen;
	const toggleSpecTool = useCallback(() => {
		if (useDockSpec) dock.toggleToolPanel("spec");
		else if (onToggleSpecPanel) onToggleSpecPanel();
		else setInternalSpecOpen((v) => !v);
	}, [useDockSpec, dock, onToggleSpecPanel]);
	// Open (not toggle) the spec panel — used by the current-task status bar so a
	// click always reveals the task list rather than closing an open panel.
	const openSpecTool = useCallback(() => {
		if (useDockSpec) dock.openToolPanel("spec");
		else if (onToggleSpecPanel) {
			if (!specToolOpened) onToggleSpecPanel();
		} else setInternalSpecOpen(true);
	}, [useDockSpec, dock, onToggleSpecPanel, specToolOpened]);
	// Stable handle so the viewport `spec-open-tasks` listener can call the latest
	// openSpecTool without re-subscribing on every dependency change.
	const openSpecToolRef = useRef(openSpecTool);
	openSpecToolRef.current = openSpecTool;

	// Background tasks: on the dock surface the tasks list is a dockview sibling
	// tab (toggled from the toolbar); off-dock (mobile) it falls back to a Drawer.
	// Dock tool panels are scoped to the base narrator in context; hide the button
	// for pushed subagent views so the badge and opened panel never disagree.
	const tasksPanelMatchesCurrentNarrator = !dock || dock.narratorId === narratorId;
	const tasksButtonEnabled = !isWorkspacePreview && tasksPanelMatchesCurrentNarrator;
	const { supported: tasksSupported, runningCount: tasksRunningCount } = useBackgroundTasksButton(
		narratorId,
		tasksButtonEnabled,
	);
	// Open state and toggling for the tasks entry now live in the registry-driven
	// header (`toolbarEntryActive` / `activateToolbarEntry`), which also handles the
	// off-dock drawer fallback.

	// Dynamic Spec current task, for the compact status bar above the input.
	const { data: specTasksData } = useSpecTasks(narratorId);
	const currentSpecTask = specTasksData?.compiled.currentTask ?? null;
	// Terminal toggle: dock context takes precedence over onToggleTerminal.
	const terminalToolAvailable = !!dock || !!onToggleTerminal;
	const terminalToolOpened = dock ? dock.openToolTypes.has("terminal") : (terminalOpen ?? false);
	const toggleTerminalTool = useCallback(() => {
		if (dock) dock.toggleToolPanel("terminal");
		else onToggleTerminal?.();
	}, [dock, onToggleTerminal]);
	// Chat → terminal "send selection": prefer the explicit prop, else bridge
	// through the dock context (writes to the terminal panel if one is open).
	const dockWriteTerminalStdin = dock?.writeTerminalStdin;
	const effSendToTerminal = useMemo<((text: string) => void) | undefined>(() => {
		if (onSendToTerminal) return onSendToTerminal;
		if (dock && terminalToolOpened && dockWriteTerminalStdin) return dockWriteTerminalStdin;
		return undefined;
	}, [onSendToTerminal, dock, terminalToolOpened, dockWriteTerminalStdin]);

	// ── Plugin panel picker (dock surfaces only) ──
	// Opens a plugin UI contribution as a dockview sibling panel. Params are
	// schema-valid PluginDockPanelParams; the Dockview api comes from the dock
	// context (focus page) or the workspace shard store.
	const dockApiRef = dock?.apiRef;
	useEffect(() => {
		pluginSurface?.registerNarratorContext({ narratorId, chapterId, projectId });
	}, [pluginSurface, narratorId, chapterId, projectId]);
	const openPluginPanel = useCallback(
		(pick: {
			pluginId: string;
			contributionId: string;
			title: string;
			version: string;
			hash: string;
		}) => {
			const api = dockApiRef?.current;
			if (!api) return;
			// A plugin contribution is a singleton per narrator surface: re-picking it
			// from the picker must focus the existing panel, not stack a second
			// instance (each addPanel gets a fresh panelInstanceId).
			const existingPlugin = api.panels.find((panel) => {
				const params = panel.params as
					| { panelType?: string; pluginId?: string; contributionId?: string }
					| undefined;
				return (
					params?.panelType === "plugin" &&
					params.pluginId === pick.pluginId &&
					params.contributionId === pick.contributionId
				);
			});
			if (existingPlugin) {
				existingPlugin.api.setActive();
				return;
			}
			// Stack into the cluster's secondary group when one exists, otherwise
			// split right of the chat/narrator panel (mirrors openToolPanel).
			const request = buildPluginDockPanelOpenRequest({
				pick,
				hostContext: pluginSurface
					? { ...pluginSurface.hostContext, narratorId, chapterId, projectId }
					: undefined,
				panels: api.panels,
			});
			api.addPanel(request);
		},
		[dockApiRef, pluginSurface, narratorId, chapterId, projectId],
	);
	const [deletePreviewMessageId, setDeletePreviewMessageId] = useState<string | null>(null);
	const [pendingDeleteCallback, setPendingDeleteCallback] = useState<(() => void) | null>(null);

	// ── Asynchronous questions (AskUserQuestion with `async: true`) ──────────
	//
	// Kept entirely apart from `renderPermCb.pendingPermissions`: nothing is suspended
	// waiting for these, so they must not reach the composer send gate, the Enter-key
	// binding or the attention notifications, all of which read that list to mean "the
	// session is blocked on the user".
	//
	// This per-narrator query feeds the INLINE forms on the tool cards. The inbox button
	// above the composer reads the cross-session query instead (it has to be able to say
	// "2 waiting elsewhere"), and both are kept in step by invalidating the narrator
	// and global inbox queries on every decision.
	const { data: asyncQuestionData } = useAsyncQuestions(narratorId, !isWorkspacePreview);
	const answerAsyncQuestion = useAnswerAsyncQuestion(narratorId);
	const dismissAsyncQuestion = useDismissAsyncQuestion(narratorId);
	const [busyAsyncQuestionId, setBusyAsyncQuestionId] = useState<string | null>(null);
	const openAsyncQuestions = asyncQuestionData?.items ?? EMPTY_ASYNC_QUESTIONS;
	const asyncQuestionSlots = useMemo(() => {
		const map = new Map<string, AsyncQuestionSlot>();
		for (const question of openAsyncQuestions) {
			if (!question.toolUseId) continue;
			map.set(question.toolUseId, {
				id: question.id,
				draftId: question.toolCallId,
				questions: toBannerQuestions(question.questions),
				busy: busyAsyncQuestionId === question.id,
				denyLabel: t("asyncQuestionDismiss"),
				awaited: question.awaited,
				awaitedLabel: t("asyncQuestionAwaitedNotice"),
				onSubmit: (questionId, answers) => {
					setBusyAsyncQuestionId(questionId);
					answerAsyncQuestion.mutate(
						{ questionId, answers },
						{ onSettled: () => setBusyAsyncQuestionId(null) },
					);
				},
				onDismiss: (questionId) => {
					setBusyAsyncQuestionId(questionId);
					dismissAsyncQuestion.mutate(
						{ questionId },
						{ onSettled: () => setBusyAsyncQuestionId(null) },
					);
				},
			});
		}
		return map;
	}, [openAsyncQuestions, busyAsyncQuestionId, answerAsyncQuestion, dismissAsyncQuestion, t]);
	const permCbWithAsyncQuestions = useMemo(
		() => ({ ...renderPermCb, asyncQuestions: asyncQuestionSlots }),
		[renderPermCb, asyncQuestionSlots],
	);

	// Get the first pending Write/Edit permission for the drawer
	const firstEditPermission = useMemo(() => {
		for (const perm of renderPermCb.pendingPermissions) {
			if (perm.toolName === "Write" || perm.toolName === "Edit") {
				return perm;
			}
		}
		return null;
	}, [renderPermCb.pendingPermissions]);

	// Expose file-mod panel props to parent for desktop sidebar rendering
	useEffect(() => {
		if (effOnFileModPropsChange) {
			effOnFileModPropsChange({
				narratorId,
				pendingPermission: firstEditPermission,
				onPermissionDecision: renderPermCb.onPermissionDecision,
				deletePreviewMessageId,
				onConfirmDelete: () => {
					pendingDeleteCallback?.();
					setDeletePreviewMessageId(null);
					setPendingDeleteCallback(null);
				},
				onCancelDelete: () => {
					setDeletePreviewMessageId(null);
					setPendingDeleteCallback(null);
				},
			});
		}
	}, [
		effOnFileModPropsChange,
		narratorId,
		firstEditPermission,
		renderPermCb.onPermissionDecision,
		deletePreviewMessageId,
		pendingDeleteCallback,
	]);

	const isWorking = narrator?.status === "working";
	/**
	 * Whether the live streaming tail should be mounted.
	 *
	 * `mockStreamActive` is the TEMPORARY harness term (see ./mock/README-REMOVAL.md):
	 * a mock run never writes to the database, so the narrator stays `idle` and the
	 * streaming subscription — gated on this flag — would never mount. Faking a
	 * `status_change` frame instead does not work; `useNarratorPanelWS` invalidates
	 * the narrator query and the refetch restores `idle`.
	 */
	const isActive =
		narrator?.status === "working" || narrator?.status === "waiting" || mockStreamActive;
	const isWaiting = narrator?.status === "waiting";
	// Takeover: the user is operating this subagent directly while the parent
	// tool call stays blocked. canTakeover is shown only while the subagent is
	// running and not already taken over.
	const isTakenOver = isSubagent && substatus.includes("taken_over");
	const canTakeover = isSubagent && isActive && !isTakenOver && retryRecoveryAllowsInterrupt;
	/**
	 * Whether the composer may offer the cut-in (priority queue) action.
	 *
	 * Cutting in means "stop at the next safe tool boundary and take my message
	 * first", which the server implements by pairing the queued message with a soft
	 * stop. A taken-over subagent is deliberately excluded from that: the user is
	 * driving it, so `POST /:id/messages` queues their input with
	 * `requestSoftStop: false` rather than interrupting the user's own turn. The
	 * cut-in label and its hold gesture would promise something the server refuses
	 * to do, so a taken-over subagent gets the ordinary send button instead — the
	 * message still queues (202) and runs as the next turn.
	 *
	 * This is most visible during the takeover "settling" window, where the
	 * taken_over tag is already written but the DB status is still working.
	 */
	const canCutInLine = isActive && !isTakenOver;
	const hasPlanTrait = Array.isArray(narrator?.traits)
		? narrator.traits.includes("plan")
		: !!narrator?.planMode;
	// (Plan-mode toggle + plan/danger reflection controls moved into the status bar
	// via useStatusBarProps; hasPlanTrait above stays in the panel for isPlanning /
	// detailsPanelExternalProps.)
	const handleOpenContextThresholdSettings = useCallback(() => {
		// The modal seeds its own draft from `contextThresholdSettings` on open.
		openContextThresholdSettingsModal();
	}, [openContextThresholdSettingsModal]);
	const handleSaveContextThresholdSettings = useCallback(
		// `normalized` is already clamped/rounded by the modal.
		(normalized: ContextManagementDraft) => {
			updateSettingsMutation.mutate(
				{
					agent: {
						contextThresholds: normalized.contextThresholds,
						autoCompactKeepPairs: normalized.autoCompactKeepPairs,
					},
				},
				{
					onSuccess: () => {
						closeContextThresholdSettings();
						notifications.show({ message: t("contextThresholdSettingsSaved"), color: "teal" });
					},
				},
			);
		},
		[closeContextThresholdSettings, t, updateSettingsMutation],
	);
	const isPlanning = hasPlanTrait && narrator?.status === "working";
	const isRetrying = !!retryInfo;
	/*
	 * Parked until an unavailable model recovers. Shares the `waiting` status with
	 * "waiting for your approval", so it must be checked first to keep the
	 * attention-colored (yellow) treatment off a wait the user cannot resolve.
	 */
	const isWaitingForModel = substatus.includes("model_unavailable");
	/** Registry-owned accent for that state, so the shade lives in one place. */
	const modelUnavailableColor = statusRegistry.accentColor(
		statusRegistry.narratorSubstatus("model_unavailable"),
	);
	// Derive compacting flags from substatus. "compacting" is blocking; background compact
	// can run alongside an active turn or after the turn has become idle.
	const isBlockingCompacting = substatus.includes("compacting");
	const isBackgroundCompacting = substatus.includes("background_compacting");
	const isCompacting = isBlockingCompacting || isBackgroundCompacting;
	/**
	 * Whether the composer should present the compaction wait/run-now choice.
	 *
	 * Only meaningful while the narrator is idle: a busy narrator's own queue modes
	 * already govern where the message lands, and a background compact running
	 * alongside a live turn changes nothing about that decision. Subagents are
	 * excluded because the server cannot queue them across a compaction (their queue
	 * needs a foreground runner), so it keeps waiting internally and there is no
	 * choice to offer.
	 *
	 * Declared next to the compacting flags rather than inline at the button so the
	 * send handler and the menu cannot disagree about which state the composer is in.
	 */
	const showCompactQueueChoice = isCompacting && !isActive && !isSubagent;
	const compactProgressText = isCompacting ? compactProgressLabel(t, compactProgress) : null;
	const queuePosition = substatus.find((s) => s.startsWith("queue_position:"));
	const queueDepth = substatus.find((s) => s.startsWith("queue_depth:"));
	const queueMessage = substatus.find((s) => s.startsWith("queue_message:"));
	const queuePositionValue = queuePosition ? Number(queuePosition.split(":")[1]) : null;
	const queueDepthValue = queueDepth ? Number(queueDepth.split(":")[1]) : null;
	const queueMessageValue = queueMessage
		? decodeURIComponent(queueMessage.slice("queue_message:".length))
		: null;
	const showWorkIndicator = !!(isWorking || isWaiting || isCompacting || isRetrying);
	/*
	 * Single source for the work-indicator accent, shared by the spinner and its
	 * label so the two can never drift. `model_unavailable` uses the blue-toned
	 * neutral from the status registry so it reads as "the system is waiting", not
	 * "you need to do something".
	 */
	const workIndicatorColor = isRetrying
		? "yellow"
		: isBlockingCompacting || (isBackgroundCompacting && !isWorking)
			? "orange"
			: isWaitingForModel
				? modelUnavailableColor
				: isWaiting
					? "yellow"
					: isPlanning
						? "green"
						: "blue";

	// --- Turn elapsed timer ---
	const turnStartedAt = narrator?.turnStartedAt as string | null | undefined;
	const narratorUpdatedAt = narrator?.updatedAt as string | null | undefined;
	const [turnElapsed, setTurnElapsed] = useState<number | null>(null);
	useEffect(() => {
		const update = () => {
			const elapsedMs = calculateEffectiveTurnElapsedMs({
				turnStartedAt,
				endAt: showWorkIndicator ? undefined : narratorUpdatedAt,
				nowMs: Date.now(),
				substatus,
			});
			setTurnElapsed(elapsedMs == null ? null : Math.floor(elapsedMs / 1000));
		};
		update();
		if (!turnStartedAt || !showWorkIndicator) return;
		const id = setInterval(update, 1000);
		return () => clearInterval(id);
	}, [turnStartedAt, showWorkIndicator, narratorUpdatedAt, substatus]);
	const turnElapsedText = useMemo(
		() => (turnElapsed == null ? null : formatColonDuration(turnElapsed)),
		[turnElapsed],
	);
	const turnStartedAtLabel = useMemo(() => {
		if (!turnStartedAt) return null;
		const time = formatFullLocaleDateTime(turnStartedAt);
		return time ? t("toolStartedAt", { time }) : null;
	}, [turnStartedAt, t]);

	const todosCtxValue = useMemo(
		() => ({
			isThinking: !!isWorking,
			latestSpecTasksToolUseId: chunkTailMeta.latestSpecTasksToolUseId ?? null,
		}),
		[isWorking, chunkTailMeta.latestSpecTasksToolUseId],
	);

	const fileModDrawerCtxValue = useMemo(
		() => ({
			openForApproval: () => setFileModDrawerOpened(true),
		}),
		[setFileModDrawerOpened],
	);

	// What the composer currently holds, split by ownership: the text flag comes
	// from NarratorComposer (updates only on empty↔non-empty flips), attachments
	// are panel state. An image-only draft behaves like a typed one everywhere below.
	const composerHasAttachments = attachedImages.length + attachedTextFiles.length > 0;
	const composerSendable = composerHasText || composerHasAttachments;

	// Index-based keyboard navigation for permission buttons. Kept lifted here:
	// the ctx value wraps the whole panel via PermEnterHintCtx.Provider (consumed
	// by nested permission children) and the global keydown handler reads the
	// shared composerRef so it never steals arrow/Enter while the user is typing.
	const { effectiveFocusIndex, permEnterHintCtxValue } = usePermissionFocusNav({
		pendingPermissionId: renderPermCb.pendingPermission?.id ?? null,
		pendingPermissionToolName: renderPermCb.pendingPermission?.toolName,
		composerSendable,
		composerRef,
	});

	// --- Image management ---

	// Title editing now lives in <NarratorPanelHeaderTitle> (it owns useTitleEditing).
	const fileInputRef = useRef<HTMLInputElement>(null);
	// Visible send/upload feedback. `progress` is 0..1 while attachments upload,
	// or null once the request body is sent and we're awaiting the server.
	// `canCancel` gates the cancel button — only meaningful while the upload is
	// still in flight (an AbortController is armed) and not yet handed to the server.
	// --- Long-press interrupt ---
	const {
		interruptProgress,
		startInterruptPress,
		interruptBtnRef,
		handleInterruptMouseUp,
		clearInterruptTimer,
	} = useInterruptLongPress({ narratorId, interruptMutation, t });

	// --- Message state from chunk tail ---
	const narratorIsIdle = narrator?.status === "idle";
	const effectiveLastMessage = chunkTailMeta.lastRealMessage;

	const canRetryLastUserMessage =
		!!effectiveLastMessage &&
		effectiveLastMessage.role === "user" &&
		!String(effectiveLastMessage.id).startsWith("optimistic-") &&
		narratorIsIdle &&
		retryRecoveryAllowsRetry;

	// A trailing injection (`role: "sys"`) is continuable for the same reason a stalled
	// assistant turn is: it is content the narrator has been handed and has not answered.
	// Requiring `assistant` here left an injection-terminated conversation with no primary
	// action at all — Retry wants a `user` tail, so the reader got a disabled send button
	// and no way to say "go on". `tailRoleAllowsContinue` is the shared rule the server's
	// continue path reads too.
	const canContinueNarrator =
		!!effectiveLastMessage &&
		tailRoleAllowsContinue(effectiveLastMessage.role) &&
		!String(effectiveLastMessage.id).startsWith("optimistic-") &&
		narratorIsIdle &&
		retryRecoveryAllowsContinue;

	const hasChapter = !!narrator?.chapterId;

	// --- Fork + ask-in-passing handlers ---
	// Kept lifted here: the resolved handlers feed the trace-row action context
	// memo below, consumed by descendants.
	const { forkHandler, handleAskInPassing } = useNarratorForkActions({
		narratorId,
		chapterId: narrator?.chapterId,
		onForkFromMessage,
		navigateToNarrator: (id: string) =>
			navigate({ to: "/narrators/$narratorId", params: { narratorId: id } }),
	});
	// --- Message rendering setup ---

	// --- Multi-select (state + range/toggle handlers + toolbar + batch actions) ---
	const {
		selectionMode,
		selectedBlockIds,
		setChunkSelectionResolver,
		exitSelection,
		handleBatchCopy,
		handleBatchDelete,
		handleBatchFork,
		handleSegmentCompact,
		selectionToolbarRef,
		selectionToolbarParentRef,
		selectionToolbarTop,
		selectionCtxValue,
	} = useMessageSelection({
		narratorId,
		contentRef,
		viewportRef,
		chunkListRef,
		navigate,
		t,
		confirm,
		compactSupported,
		compactUnsupportedReason,
		compactUsesFallbackSummary,
		compactFallbackSummaryReason,
	});

	// --- Off-screen swipe/compacting anchor overlay state ---
	const [swipeAnchorOverlay, setSwipeAnchorOverlay] = useState<SwipeAnchorInfo | null>(null);
	const [compactingMarkerOverlay, setCompactingMarkerOverlay] = useState<SwipeAnchorInfo | null>(
		null,
	);
	const [selectionAnchorOverlay, setSelectionAnchorOverlay] = useState<SwipeAnchorInfo | null>(
		null,
	);

	useEffect(() => {
		setGlobalOnSwipeAnchorInfo(setSwipeAnchorOverlay);
		return () => setGlobalOnSwipeAnchorInfo(null);
	}, []);

	// --- vlist subagent-card / tool-card command actions ---
	// The chunked SubagentCard owns these itself; the vlist renderers are pure, so
	// the panel supplies them and the row menu calls them. Capability gating and
	// error tolerance mirror SubagentCard (a child may already have finished).
	const subagentsCapability = useNarratorSubagentsCapability();
	const canDetachSubagentToBackground =
		subagentsCapability.supported &&
		subagentsCapability.background &&
		subagentsCapability.detachAttach;
	const canCancelSubagentBackground =
		subagentsCapability.supported && subagentsCapability.background;

	// Open a file path in a read-only viewer. Two routes, in precedence order —
	// mirroring the spec panel's dock/drawer split:
	//  1. dock file panel — a dockview surface can host a real tab beside the chat.
	//  2. internal drawer — off-dock surfaces (the mobile narrator page, which
	//     renders NarratorPanel directly with no dock) get the same viewer inside a
	//     Drawer. Without this the swipe/context menu silently dropped "open in
	//     panel" on mobile, which is the one surface where a swipe menu is the
	//     ONLY way to reach it.
	// Workspace previews stay lightweight and get neither (same rule as the spec
	// drawer), so their rows leave the affordance hidden rather than dead.
	/**
	 * Off-dock host state for the tool panels that previously had NO mobile entry
	 * point (git / search / browser / discussion). One at a time: they are
	 * full-screen drawers, and each holds a live subscription.
	 */
	const [mobileToolPanel, setMobileToolPanel] = useState<MobileToolPanelKind | null>(null);
	/** Off-dock host state for the background-tasks drawer. */
	const [mobileTasksOpen, setMobileTasksOpen] = useState(false);

	// File opening (dock file panel when hosted in a dock, else an off-dock right
	// Drawer). Kept lifted here: its handlers feed the fileReferenceScope memo
	// below (consumed by descendants) and the Drawer lives in this panel's JSX.
	const {
		internalFileViewerPath,
		setInternalFileViewerPath,
		internalFileViewerTarget,
		handleOpenFilePanel,
		handleOpenReferencedFile,
		canOpenReferencedFile,
	} = useInternalFileViewer({ narratorId, isWorkspacePreview, t });
	const [localFileSelection, setLocalFileSelection] = useState<FileReferenceEditorSelection | null>(
		null,
	);
	const addFileReference = useCallback((reference: FileReference) => {
		composerRef.current?.addFileReference(reference);
	}, []);
	const fileReferenceDevice = executionDevicesQuery.data
		? (executionDevicesQuery.data.defaultDeviceId ?? "local")
		: undefined;
	const fileReferenceCwd =
		fileReferenceDevice === "local"
			? (fetchedNarrator?.cwd ?? narrator?.cwd ?? chapterWorktreePath)
			: executionDevicesQuery.data?.devices.find((device) => device.id === fileReferenceDevice)
					?.defaultCwd;
	const fileReferenceContext = useMemo<FileReferenceContext | null>(
		() =>
			fileReferenceDevice && fileReferenceCwd
				? { deviceId: fileReferenceDevice, cwd: fileReferenceCwd }
				: null,
		[fileReferenceDevice, fileReferenceCwd],
	);
	const fileReferenceScope = useMemo<FileReferenceScopeValue>(
		() => ({
			narratorId,
			context: fileReferenceContext,
			openFile: canOpenReferencedFile ? handleOpenReferencedFile : undefined,
			addReference: addFileReference,
			selection: dock?.fileReferenceSelection ?? localFileSelection,
			setSelection: dock?.setFileReferenceSelection ?? setLocalFileSelection,
		}),
		[
			narratorId,
			fileReferenceContext,
			canOpenReferencedFile,
			handleOpenReferencedFile,
			addFileReference,
			dock?.fileReferenceSelection,
			dock?.setFileReferenceSelection,
			localFileSelection,
		],
	);

	// Opening a child session prefers the host-provided handler (dock/workspace
	// aware); standalone panels fall back to routing, like SubagentCard does.
	const handleVlistViewSubagentSession = useCallback(
		(subagentNarratorId: string, messageId?: string) => {
			if (onViewSubagentSession) {
				onViewSubagentSession(subagentNarratorId, messageId);
				return;
			}
			// Standalone fallback: the narrator page reads `?scrollTo=` as its
			// highlight target, which is the same jump the dock performs in-place.
			navigate({
				to: "/narrators/$narratorId",
				params: { narratorId: subagentNarratorId },
				search: messageId ? { scrollTo: messageId } : undefined,
			});
		},
		[onViewSubagentSession, navigate],
	);

	/**
	 * Open the Dynamic Spec panel with one file selected.
	 *
	 * Reuses `openSpecTool` (which opens rather than toggles — a click from a row that
	 * points at a file must reveal it, never close an open panel) and then asks the
	 * panel to select the uri. Only bound when this surface HAS a spec panel to open,
	 * so a row on a surface without one stays inert.
	 */
	/**
	 * Open a knowledge entry a hint row points at.
	 *
	 * Prefers the dock panel (staying beside the conversation the hint belongs to) and
	 * falls back to the route on surfaces without one — the same in-surface-first rule
	 * `handleVlistViewSubagentSession` follows.
	 */
	const dockOpenKnowledgePanel = dock?.openKnowledgePanel;
	const handleOpenKnowledgeEntry = useCallback(
		(entryId: string, scope: "global" | "personal") => {
			if (dockOpenKnowledgePanel) {
				dockOpenKnowledgePanel(entryId, scope);
				return;
			}
			if (scope === "personal") {
				navigate({
					to: "/knowledge/personal/$personalEntryId",
					params: { personalEntryId: entryId },
				});
				return;
			}
			navigate({ to: "/knowledge/$entryId", params: { entryId } });
		},
		[dockOpenKnowledgePanel, navigate],
	);

	const handleOpenSpecFile = useCallback(
		(uri: string) => {
			openSpecTool();
			// The panel usually does not exist yet at this point — opening it IS this
			// click's first effect — so the selection is applied through the registry,
			// which waits briefly for the panel to mount. See `spec-file-reveal`.
			revealSpecFile(narratorId, uri);
		},
		[openSpecTool, narratorId],
	);

	/**
	 * Open a chapter referenced by a review-feedback / merge-summary row.
	 *
	 * Always a route: a chapter is not a panel kind, so there is no in-surface
	 * destination to prefer over navigation.
	 */
	const handleOpenChapter = useCallback(
		(chapterId: string) => {
			navigate({ to: "/chapters/$chapterId", params: { chapterId } });
		},
		[navigate],
	);

	const handleDetachSubagent = useCallback(async (subagentNarratorId: string) => {
		try {
			await api.detachSubagent(subagentNarratorId);
		} catch {
			// The subagent may have already completed.
		}
	}, []);

	const handleCancelSubagentBackground = useCallback(
		async (subagentNarratorId: string) => {
			try {
				await api.cancelBackgroundTask(narratorId, subagentNarratorId);
			} catch {
				// The background task may have already completed.
			}
		},
		[narratorId],
	);

	// Queue controls are declared through refs because the vlist handler bundle is
	// built before the queue editor callbacks below. The resolver returns mailbox-row
	// actions only when a canonical timeline message points at a queued summary.
	const queuedEditRef = useRef<(id: string) => void>(() => {});
	const queuedCancelRef = useRef<(id: string) => void>(() => {});
	const queuedRetryRef = useRef<(id: string) => void>(() => {});
	const resolveQueuedMessage = useCallback(
		(messageId: string) => {
			const queued = queuedMessages.find((item) => item.messageId === messageId);
			if (!queued) return undefined;
			return {
				onEdit: () => queuedEditRef.current(queued.id),
				onCancel: () => queuedCancelRef.current(queued.id),
				...(queued.state === "failed" ? { onRetry: () => queuedRetryRef.current(queued.id) } : {}),
			};
		},
		[queuedMessages],
	);

	// Single-block action handlers for the vlist message list. Memoized so the
	// object identity is stable across renders — the vlist interaction layer
	// keys its per-row payloads off this and must not rebuild them every render.
	// Mirrors the props passed to ChunkedMessageList (same names/signatures).
	const vlistRowHandlers = useMemo(
		() => ({
			onForkFromMessage: forkHandler,
			onAskInPassing: handleAskInPassing,
			onCompactBeforeMessage: compactSupported ? handleCompactBefore : undefined,
			onClearContextBefore: compactSupported ? handleClearContextBefore : undefined,
			onManualSummarize: compactSupported ? handleManualSummarize : undefined,
			onDeleteBlock: handleDeleteBlock,
			onRollbackToBlock: rollbackEditRegenerateSupported ? handleRollback : undefined,
			// Message editing: same gating as the chunked branch below — the user
			// flow requires provider support, the assistant text edit does not.
			onEditAndRegenerate: rollbackEditRegenerateSupported ? handleEditAndRegenerate : undefined,
			resolveQueuedMessage,
			onEditAssistantMessage: handleEditAssistantMessage,
			onRestoreAssistantMessage: handleRestoreAssistantMessage,
			onViewSubagentSession: handleVlistViewSubagentSession,
			// Gated on provider capability, mirroring SubagentCard: an unsupported
			// backend hides the item rather than failing on click.
			onDetachSubagent: canDetachSubagentToBackground ? handleDetachSubagent : undefined,
			onCancelBackgroundTask: canCancelSubagentBackground
				? handleCancelSubagentBackground
				: undefined,
			onOpenFilePanel: handleOpenFilePanel,
			// Injection-bubble navigation. Each is undefined on surfaces that cannot reach
			// the destination, which leaves those rows inert rather than dead-clickable.
			onOpenKnowledgeEntry: handleOpenKnowledgeEntry,
			onOpenSpecFile: handleOpenSpecFile,
			onOpenChapter: handleOpenChapter,
		}),
		[
			forkHandler,
			handleAskInPassing,
			compactSupported,
			handleCompactBefore,
			handleClearContextBefore,
			handleManualSummarize,
			handleDeleteBlock,
			rollbackEditRegenerateSupported,
			handleRollback,
			handleEditAndRegenerate,
			resolveQueuedMessage,
			handleEditAssistantMessage,
			handleRestoreAssistantMessage,
			handleVlistViewSubagentSession,
			canDetachSubagentToBackground,
			handleDetachSubagent,
			canCancelSubagentBackground,
			handleCancelSubagentBackground,
			handleOpenFilePanel,
			handleOpenKnowledgeEntry,
			handleOpenSpecFile,
			handleOpenChapter,
		],
	);

	// --- Flat message elements ---
	const showScrollToBottomButton = !isAtBottom || unreadCount > 0;

	// --- Scroll state ---
	const cleanupRef = useRef<(() => void) | null>(null);
	const chunkViewportRef = useCallback((node: HTMLDivElement | null) => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		(viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		if (!node) return;
		// The spec carryover / spec_goal_added cards bubble a "spec-open-tasks"
		// CustomEvent up to this scroll viewport (their DOM ancestor) to open the
		// Spec task board. Register the listener on the live viewport node — this
		// ties the listener to the node's mount lifecycle.
		// register it here on the live viewport node instead — this ties the listener
		// to the node's mount lifecycle and never depends on the disabled effect.
		const onSpecOpenTasks = () => openSpecToolRef.current();
		node.addEventListener("spec-open-tasks", onSpecOpenTasks);
		cleanupRef.current = () => {
			node.removeEventListener("spec-open-tasks", onSpecOpenTasks);
		};
	}, []);

	/**
	 * Reveal a message, returning whether the jump actually landed.
	 *
	 * Async because the virtual list may have to page upward into unloaded history before it
	 * can position anything, and its answer is the real one — a caller that treats "handed
	 * off" as "revealed" would mark the jump done and never retry. Callers that only fire and
	 * forget can `void` it.
	 */
	const scrollToMessageTarget = useCallback(
		async ({
			domIds,
			targetIds,
			highlightId,
		}: {
			domIds: string[];
			targetIds: string[];
			highlightId?: string;
		}): Promise<boolean> => {
			// The virtual list owns the whole jump (reveal, flash, and paging upward into
			// not-yet-loaded history). Short-circuiting on a mounted DOM node here would
			// hand it only the easy case AND paint no highlight: the flash is written to
			// the revealed node imperatively inside the list, not driven by this panel's
			// `highlightedId` state.
			const handle = chunkListRef.current;
			if (!handle) return false;
			return await handle.scrollToMessageTarget({ domIds, targetIds, highlightId });
		},
		[],
	);

	// Bridge: let the sibling search panel jump to a message in this chat via the
	// dock context, reusing the same scroll/highlight path as deep-link nav.
	const registerScrollToMessage = dock?.registerScrollToMessage;
	useEffect(() => {
		if (!registerScrollToMessage) return;
		return registerScrollToMessage((messageId: string) => {
			// The dock callback is synchronous; the list reports an unreachable target to the
			// user itself, so there is nothing for the search panel to do with the result.
			void scrollToMessageTarget({
				domIds: [`msg-${messageId}`],
				targetIds: [messageId],
				highlightId: messageId,
			});
		});
	}, [registerScrollToMessage, scrollToMessageTarget]);

	const compactingMarkerMessageId: string | null = null;
	const compactingMarkerKind = "context" as CompactingMarkerKind;

	useEffect(() => {
		if (!compactingMarkerMessageId || isWorkspacePreview) {
			setCompactingMarkerOverlay((prev) => (prev ? null : prev));
			return;
		}

		const scrollEl = viewportRef.current;
		if (!scrollEl) {
			setCompactingMarkerOverlay((prev) => (prev ? null : prev));
			return;
		}
		const contentEl = contentRef.current ?? scrollEl;
		const fallbackPreviewText =
			compactingMarkerKind === "segment" ? t("segmentCompacting") : t("compacting");

		let rafId = 0;
		const findMarker = () => contentEl.querySelector<HTMLElement>(`[${COMPACTING_MARKER_ATTR}]`);
		const clearOverlay = () => setCompactingMarkerOverlay((prev) => (prev ? null : prev));
		const scrollBackToMarker = (
			source: HTMLElement,
			messageId: string,
			sourceIsMarker: boolean,
		) => {
			if (sourceIsMarker && source.isConnected) {
				source.scrollIntoView({ behavior: "smooth", block: "center" });
				return;
			}
			// Fire and forget: the overlay's job is to start the jump, and the list already
			// tells the user when a target cannot be reached.
			void scrollToMessageTarget({
				domIds: [`msg-${messageId}`],
				targetIds: [messageId],
				highlightId: messageId,
			});
		};
		const showOverlay = (
			source: HTMLElement,
			offScreen: "top" | "bottom",
			sourceIsMarker: boolean,
			previewTextOverride?: string,
		) => {
			const messageId = source.getAttribute("data-message-id") ?? compactingMarkerMessageId;
			const blockId = `compacting:${messageId}`;
			const previewText =
				previewTextOverride ??
				compactWhitespacePreview(collectElementTextPreview(source, 80)) ??
				blockId;
			const previewColor = compactingMarkerKind === "segment" ? "teal" : "orange";

			setCompactingMarkerOverlay((prev) => {
				if (
					prev?.blockId === blockId &&
					prev.offScreen === offScreen &&
					prev.previewText === previewText &&
					prev.previewColor === previewColor
				) {
					return prev;
				}
				return {
					blockId,
					previewText,
					previewColor,
					element: source,
					scrollBack: () => scrollBackToMarker(source, messageId, sourceIsMarker),
					close: clearOverlay,
					offScreen,
				};
			});
		};
		const getFallbackOffScreen = (): "top" | "bottom" | null => {
			return null;
		};
		const checkMarker = () => {
			const marker = findMarker();
			if (marker?.isConnected) {
				const markerRect = marker.getBoundingClientRect();
				const viewportRect = scrollEl.getBoundingClientRect();
				const showMargin = 4;
				const clearMargin = 16;
				if (markerRect.bottom < viewportRect.top - showMargin) {
					showOverlay(marker, "top", true);
					return;
				}
				if (markerRect.top > viewportRect.bottom + showMargin) {
					showOverlay(marker, "bottom", true);
					return;
				}
				const markerSafelyVisible =
					markerRect.bottom > viewportRect.top + clearMargin &&
					markerRect.top < viewportRect.bottom - clearMargin;
				if (markerSafelyVisible) clearOverlay();
				return;
			}
			const fallbackOffScreen = getFallbackOffScreen();
			if (!fallbackOffScreen) return;
			showOverlay(scrollEl, fallbackOffScreen, false, fallbackPreviewText);
		};
		const scheduleCheck = () => {
			if (rafId) return;
			rafId = window.requestAnimationFrame(() => {
				rafId = 0;
				checkMarker();
			});
		};

		scheduleCheck();
		scrollEl.addEventListener("scroll", scheduleCheck, { passive: true });
		window.addEventListener("resize", scheduleCheck, { passive: true });
		const mutationObserver = new MutationObserver(scheduleCheck);
		mutationObserver.observe(contentEl, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [COMPACTING_MARKER_ATTR, "data-message-id"],
		});

		return () => {
			cancelAnimationFrame(rafId);
			scrollEl.removeEventListener("scroll", scheduleCheck);
			window.removeEventListener("resize", scheduleCheck);
			mutationObserver.disconnect();
		};
	}, [compactingMarkerKind, isWorkspacePreview, scrollToMessageTarget, t]);

	/**
	 * Desktop: keep a preview strip on the ONE selected block once it scrolls out of
	 * the message area, so the reader retains a handle on where the selection is.
	 *
	 * Same strip and same producer contract as the touch swipe anchor and the
	 * compaction marker (see `resolveSelectionOverlayBlockId` for why this producer
	 * is limited to a single selected block on desktop only).
	 *
	 * Unlike the swipe path, this NEVER depends on the row staying mounted: the
	 * selection lives in panel state keyed by blockId, so when the virtual list
	 * unmounts the row the strip simply falls back to `scrollToMessageTarget`, which
	 * can reach an unmounted row through the document index.
	 */
	const selectionOverlayBlockId = resolveSelectionOverlayBlockId({
		selectedBlockIds,
		isMobileViewport,
		hasSwipeAnchor: swipeAnchorOverlay != null,
	});
	useEffect(() => {
		if (!selectionOverlayBlockId || isWorkspacePreview) {
			setSelectionAnchorOverlay((prev) => (prev ? null : prev));
			return;
		}
		const scrollEl = viewportRef.current;
		if (!scrollEl) {
			setSelectionAnchorOverlay((prev) => (prev ? null : prev));
			return;
		}
		const contentEl = contentRef.current ?? scrollEl;
		const clearOverlay = () => setSelectionAnchorOverlay((prev) => (prev ? null : prev));

		let rafId = 0;
		// A block id can carry characters that are not selector-safe, so scanning
		// attributes avoids building a selector (and needing to escape one) at all.
		const findBlock = (): HTMLElement | null => {
			for (const el of contentEl.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`)) {
				if (el.getAttribute(BLOCK_ID_ATTR) === selectionOverlayBlockId) return el;
			}
			return null;
		};
		const check = () => {
			const block = findBlock();
			// Row not mounted (virtual list scrolled past it). The strip stays as it is:
			// re-deriving a direction without geometry would guess, and the reader's
			// last-known direction is still the truthful one.
			if (!block?.isConnected) return;
			const offScreen = resolveSwipeAnchorOffScreen(
				block.getBoundingClientRect(),
				scrollEl.getBoundingClientRect(),
			);
			if (!offScreen) {
				clearOverlay();
				return;
			}
			const messageId = block.getAttribute("data-message-id") ?? "";
			const previewText =
				compactWhitespacePreview(collectElementTextPreview(block, 80)) || selectionOverlayBlockId;
			setSelectionAnchorOverlay((prev) => {
				if (
					prev?.blockId === selectionOverlayBlockId &&
					prev.offScreen === offScreen &&
					prev.previewText === previewText
				) {
					return prev;
				}
				return {
					blockId: selectionOverlayBlockId,
					previewText,
					previewColor: "indigo",
					element: block,
					scrollBack: () => {
						const live = findBlock();
						if (live?.isConnected) {
							live.scrollIntoView({ behavior: "smooth", block: "center" });
							return;
						}
						// Unmounted by virtualization — the list can still reach it by index.
						if (messageId) {
							void scrollToMessageTarget({
								domIds: [`msg-${messageId}`],
								targetIds: [messageId],
								highlightId: messageId,
							});
						}
					},
					// Dismissing the strip must not clear the selection: it is a wayfinding
					// aid, and losing a selection to a stray tap would be destructive.
					close: clearOverlay,
					offScreen,
				};
			});
		};
		const scheduleCheck = () => {
			if (rafId) return;
			rafId = window.requestAnimationFrame(() => {
				rafId = 0;
				check();
			});
		};

		scheduleCheck();
		scrollEl.addEventListener("scroll", scheduleCheck, { passive: true });
		window.addEventListener("resize", scheduleCheck, { passive: true });
		// The virtual list mounts / unmounts rows as it scrolls, so the strip has to
		// re-check on structural changes too, not only on scroll events.
		const mutationObserver = new MutationObserver(scheduleCheck);
		mutationObserver.observe(contentEl, { childList: true, subtree: true });

		return () => {
			cancelAnimationFrame(rafId);
			scrollEl.removeEventListener("scroll", scheduleCheck);
			window.removeEventListener("resize", scheduleCheck);
			mutationObserver.disconnect();
		};
	}, [selectionOverlayBlockId, isWorkspacePreview, scrollToMessageTarget]);

	// Narrator send subsystem (sending state, buffered-send reconciliation,
	// optimistic submit, mode-aware send, dock-bridge forward, retry/continue).
	// Kept lifted here: its inputs (composerRef, attachments, scroll, sendingRef)
	// and the stable send refs it returns are shared with the composer, the queue
	// actions below, and the dock bridge.
	const {
		sendingState,
		isSending,
		cancelSending,
		handleSend,
		handleSendRef,
		handleSendWithModeRef,
		ctrlEnterQueueModeRef,
		composerSendWithMode,
		forwardTextToNarrator,
		handleRetry,
		handleContinue,
	} = useNarratorSend({
		narratorId,
		composerRef,
		attachedImages,
		attachedTextFiles,
		attachedImagesRef,
		attachedTextFilesRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		hideAttachedFilesForSend,
		clearAttachedFilesAndDraft,
		sendingRef,
		setQueuedMessages,
		reconcileBufferedMessages,
		scrollToBottom,
		isActive,
		isSubagent,
		isTakenOver,
		showCompactQueueChoice,
		canRetryLastUserMessage,
		canContinueNarrator,
		fetchedNarrator,
		narrator,
		chapterWorktreePath,
		currentUser,
		enterQueueMode: userPrefs?.enterQueueMode ?? "turn",
		ctrlEnterQueueMode: userPrefs?.ctrlEnterQueueMode ?? "tool",
		createNarrator: createNarratorMutation,
		interruptNarrator: interruptMutation,
		registerSubmitToNarrator: dock?.registerSubmitToNarrator,
		setNarratorWorking,
		navigateToNarrator: (id: string) =>
			navigate({ to: "/narrators/$narratorId", params: { narratorId: id } }),
		normalizeBooleanOverride,
		normalizeDangerReflectionOverride,
		t,
	});

	// The queue-buffer interaction hook (useQueuedMessageActions) is no longer
	// called here: its entire output set is consumed only inside
	// NarratorInteractionArea's subtree (the queued-messages panel + the composer
	// hold gesture), so the hook is called there. The panel only forwards the
	// stable refs/setters it depends on via the `queueDeps` group below.

	const handleAllowRetryToolCall = useCallback(
		async (toolUseId: string) => {
			try {
				await api.allowRetryToolCall(narratorId, toolUseId);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to re-execute tool call";
				notifications.show({ title: "Error", message, color: "red" });
			}
		},
		[narratorId],
	);

	// Allow-retry context: a denied tool call in the latest assistant turn may be
	// re-executed only while the narrator is idle (no live loop running).
	const allowRetryLatestAssistantMessageId =
		narratorIsIdle &&
		effectiveLastMessage?.role === "assistant" &&
		!String(effectiveLastMessage.id).startsWith("optimistic-")
			? effectiveLastMessage.id
			: null;
	const allowRetryCtxValue = useMemo(
		() => ({
			enabled: narratorIsIdle && !!allowRetryLatestAssistantMessageId,
			latestAssistantMessageId: allowRetryLatestAssistantMessageId,
			onAllowRetry: handleAllowRetryToolCall,
		}),
		[narratorIsIdle, allowRetryLatestAssistantMessageId, handleAllowRetryToolCall],
	);

	// Composer file ingestion (image/text validation + resize, file picker, paste
	// bridge, and the whole-panel dropzone handlers). The dropzone stays wired to
	// the panel root below, so the hook is called here rather than sunk into a child.
	const { handleFileInputChange, handleComposerPasteImages, dropZoneProps } = useComposerFileIngest(
		{
			updateAttachedImages,
			updateAttachedTextFiles,
			setIsDragging,
			dragCounterRef,
			t,
		},
	);

	/*
	 * ── Header toolbar: entries, layout and activation ──
	 *
	 * The header used to hard-code ~13 buttons in JSX, several of them behind
	 * `{dock && …}`. That is what left the mobile page with no entry point at all
	 * for git / search / browser / discussion: off-dock those conditions are false,
	 * so the controls were absent rather than collapsed, and nothing said so.
	 *
	 * Now the SET of entries comes from the registry, the ORDER from the user's
	 * persisted layout, and only the HOSTING is decided here.
	 *
	 * Placed ABOVE the skeleton early-return below: these are hooks, so they must
	 * run on every render regardless of whether the narrator has loaded.
	 */
	const headerHostCapabilities = useMemo<NarratorToolbarHost[]>(() => {
		if (isWorkspacePreview) return ["inline"];
		// A drawer host exists whenever this panel is not a lightweight preview: it
		// either owns its own drawers (details / filemod / spec) or is handed one by
		// the route (terminal), and MobileToolPanelHost covers the rest.
		const caps: NarratorToolbarHost[] = ["inline", "drawer"];
		if (dock) caps.push("dock");
		return caps;
	}, [dock, isWorkspacePreview]);

	const toolbarBadgeCounts = useMemo<NarratorToolbarBadgeCounts>(
		() => ({
			backgroundTasks: tasksRunningCount,
			browserSessions: wsState.browserSessionCount,
			userChatUnread,
			terminals: activeTerminalCount,
		}),
		[tasksRunningCount, wsState.browserSessionCount, userChatUnread, activeTerminalCount],
	);

	if (!narrator) return <NarratorPanelSkeleton />;

	const statusBarDisplay = getNarratorStatusBarDisplay({
		panelNarratorId: narratorId,
		narrator,
		liveSubstatus: substatus,
	});

	/*
	 * One decision for both compaction slots on the status row (the primary label
	 * and the appended short suffix), so the row can never say the same thing
	 * twice. See planNarratorWorkIndicator for the invariant.
	 */
	const workIndicatorPlan = planNarratorWorkIndicator({
		isRetrying,
		isBlockingCompacting,
		isBackgroundCompacting,
		isWaitingForModel,
		hasSpecTask: !!currentSpecTask,
		isWaiting,
		isPlanning,
		hasCompactFailure: compactFailure != null,
	});
	// `compactProgressText` is non-null whenever either compact flag is set; the
	// fallback only keeps the template from interpolating "null".
	const compactProgressFragment = compactProgressText ?? "";

	const hasContextData = contextPercent != null;
	const contextIndicatorPercent = hasContextData ? Math.min(contextPercent, 100) : 0;
	const contextIndicatorRadius = 9;
	const contextIndicatorCirc = 2 * Math.PI * contextIndicatorRadius;
	const contextIndicatorOffset = contextIndicatorCirc * (1 - contextIndicatorPercent / 100);
	const contextStaleColor = "light-dark(var(--mantine-color-black), var(--mantine-color-dark-0))";
	const contextIndicatorColor = contextStale
		? contextStaleColor
		: contextIndicatorPercent >= 99
			? "var(--mantine-color-red-6)"
			: contextIndicatorPercent >= 95
				? "var(--mantine-color-yellow-6)"
				: "var(--mantine-color-blue-6)";
	const contextIndicatorLabel = contextStale
		? t("contextStaleHint")
		: hasContextData
			? `Context: ${contextPercent.toFixed(1)}%`
			: "Context";
	const contextRingNode = (
		<Box
			style={{
				position: "relative",
				width: 24,
				height: 24,
				flexShrink: 0,
				cursor: isWorkspacePreview ? "default" : "pointer",
			}}
			className="context-ring"
		>
			<svg width={24} height={24} viewBox="0 0 24 24" role="img" aria-label={contextIndicatorLabel}>
				<title>{contextIndicatorLabel}</title>
				<circle
					cx={12}
					cy={12}
					r={contextIndicatorRadius}
					fill="none"
					stroke="light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))"
					strokeWidth={2.5}
				/>
				{hasContextData && (
					<circle
						cx={12}
						cy={12}
						r={contextIndicatorRadius}
						fill="none"
						stroke={contextIndicatorColor}
						strokeWidth={2.5}
						strokeDasharray={contextIndicatorCirc}
						strokeDashoffset={contextIndicatorOffset}
						strokeLinecap="round"
						transform="rotate(-90 12 12)"
						style={{ transition: "stroke-dashoffset 0.3s ease" }}
					/>
				)}
				{contextStale && (
					<text
						x={12}
						y={12}
						textAnchor="middle"
						dominantBaseline="central"
						fontSize={12}
						fontWeight={700}
						fill={contextStaleColor}
					>
						?
					</text>
				)}
			</svg>
		</Box>
	);
	const contextIndicator = isWorkspacePreview ? (
		contextRingNode
	) : (
		<Menu position="top-start">
			<Menu.Target>{contextRingNode}</Menu.Target>
			<Menu.Dropdown>
				{contextStale && (
					<Menu.Label c="orange" fz={10} style={{ maxWidth: 240, whiteSpace: "normal" }}>
						{t("contextStaleHint")}
					</Menu.Label>
				)}
				<Menu.Label c="dimmed" fz={10}>
					{t("activeThresholds", {
						compact: activeCompactStart ?? modelThresholds?.compactStart,
					})}
				</Menu.Label>
				<Menu.Item
					leftSection={<IconSettings size={14} />}
					c="dimmed"
					fz="xs"
					onClick={handleOpenContextThresholdSettings}
				>
					{t("thresholdSettings")}
				</Menu.Item>
				<Menu.Divider />
				{hasContextData && (
					<Menu.Label>
						{t("contextUsagePercent", { percent: contextPercent.toFixed(1) })}
					</Menu.Label>
				)}
				{promptTokens != null && (
					<Menu.Label>
						{contextWindow != null
							? t("contextUsageTokensWithWindow", {
									tokens: formatLocaleNumber(promptTokens),
									window: formatLocaleNumber(contextWindow),
								})
							: t("contextUsageTokens", {
									tokens: formatLocaleNumber(promptTokens),
								})}
						{isEstimated && <span style={{ opacity: 0.6, marginLeft: 4 }}>({t("estimated")})</span>}
					</Menu.Label>
				)}
				<Menu.Divider />
				<Menu.Item
					leftSection={<IconArrowsMinimize size={14} />}
					onClick={() => {
						// Compacting state will arrive via substatus_change WS event
						api.triggerCompact(narratorId).catch((err) => {
							handleCompactError(err);
						});
					}}
				>
					{t("triggerCompact")}
				</Menu.Item>
				<Menu.Item
					leftSection={<IconEraser size={14} />}
					onClick={() => {
						api.clearContext(narratorId).catch(() => {});
					}}
				>
					{t("clearContext")}
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);

	// Mobile status-row actions (path rules / relaxed plan / promote) live in
	// useMobileToolbarActions. The terminal entry deliberately is NOT here — it is
	// a tool entry owned by the header registry (narrator-toolbar-items).
	const mobileToolbarActions = buildMobileToolbarActions({
		narratorId,
		t,
		hasPlanTrait,
		relaxedPlanEnabled,
		relaxedPlanForced,
		relaxedPlanMutation,
		isAskInPassing: narrator.isAskInPassing,
		chapterId: narrator.chapterId,
		promoteMutation,
		handlePromote,
	});
	// Only inputs that change an action's own rendered width belong here. The
	// leading controls (model, reasoning effort, fast mode, permission mode) are
	// re-measured every pass, so including them would needlessly drop the cache
	// and repaint every action inline for a frame.
	const mobileToolbarMeasurementKey = [i18n.resolvedLanguage, activeTerminalCount].join(":");

	return (
		<PermEnterHintCtx.Provider value={permEnterHintCtxValue}>
			<ContentViewerEnvironmentProvider
				value={contentViewerEnvironment}
				fileReferences={fileReferenceScope}
			>
				<Stack
					data-narrator-panel
					h="100%"
					gap={0}
					style={{ overflow: "hidden", position: "relative" }}
					{...dropZoneProps}
				>
					<NugRechargeDialog
						opened={nugRechargeOpened}
						narratorId={narratorId}
						providerId={nugProviderInfo?.providerId ?? paymentRequired?.providerId ?? null}
						providerName={nugProviderInfo?.name ?? paymentRequired?.providerPrefix ?? null}
						paymentRequired={paymentRequired}
						onClose={closeNugRecharge}
						onPaymentRequiredChange={setPaymentRequired}
					/>
					{/* Drop overlay */}
					<DropOverlay visible={isDragging} />
					{/* Header */}
					<Group
						ref={headerRowRef}
						justify="space-between"
						py="xs"
						px="md"
						className={onHeaderPointerDown ? "nf-panel-header" : undefined}
						style={{
							borderBottom: "1px solid var(--mantine-color-default-border)",
							flexShrink: 0,
							cursor: onHeaderPointerDown ? "grab" : undefined,
						}}
						onPointerDown={
							onHeaderPointerDown
								? (e: React.PointerEvent) => {
										// Skip drag initiation when clicking interactive elements
										const el = e.target as HTMLElement;
										if (el.closest("button, a, input, select, textarea, [role='button']")) return;
										onHeaderPointerDown(e);
									}
								: undefined
						}
					>
						<Group ref={headerLeadingRef} gap="xs" style={{ flex: 1, minWidth: 0 }}>
							{!isWorkspacePreview &&
								(onMinimize ? (
									<Tooltip label={t("backToGraph")} position="right">
										<ActionIcon size="sm" variant="subtle" color="gray" onClick={onMinimize}>
											<IconArrowsMinimize size={16} />
										</ActionIcon>
									</Tooltip>
								) : onBack ? (
									<ActionIcon size="sm" variant="subtle" color="gray" onClick={onBack}>
										<IconArrowLeft size={16} />
									</ActionIcon>
								) : onOpenStandalonePage ? (
									<Tooltip label={t("openStandalonePage")} position="right">
										<ActionIcon
											size="sm"
											variant="subtle"
											color="gray"
											onClick={onOpenStandalonePage}
										>
											<IconExternalLink size={16} />
										</ActionIcon>
									</Tooltip>
								) : compact ? (
									<ActionIcon
										size="sm"
										variant="subtle"
										color="gray"
										onClick={() =>
											navigate({
												to: "/narrators/$narratorId",
												params: { narratorId },
												search: { from: "graph" },
											})
										}
									>
										<IconExternalLink size={16} />
									</ActionIcon>
								) : (
									<ActionIcon
										size="sm"
										variant="subtle"
										color="gray"
										onClick={() => navigate({ to: ".." })}
									>
										<IconArrowLeft size={16} />
									</ActionIcon>
								))}
							{/*
							 * `flex: 1` even when the title is suppressed: it is what pushes the
							 * tool row to the right edge, and it hands the freed width to those
							 * buttons instead of leaving a gap where the title used to be.
							 *
							 * The floor that keeps the title readable is the capacity BUDGET
							 * (`headerTitleSlotMinWidth`), not a CSS `min-width`. A min-width here
							 * would win against the tool row's `flex-shrink: 0` only by overflowing
							 * or wrapping a nowrap row — both worse than the truncation it would
							 * prevent. `HEADER_TITLE_SLOT_ATTR` marks the slot so the measurement
							 * budgets it by policy instead of reading a width this element derives
							 * from whatever the tool row left over.
							 */}
							<NarratorPanelHeaderTitle
								narratorId={narratorId}
								narrator={narrator}
								hostOwnsTitle={hostOwnsTitle}
								isWorkspacePreview={isWorkspacePreview}
							/>
							{disconnected && !isWorkspacePreview && (
								<Badge
									size="xs"
									variant="dot"
									color="red"
									style={{ cursor: "pointer" }}
									onClick={reconnect}
									title={t("reconnect")}
								>
									{t("disconnected")}
								</Badge>
							)}
						</Group>
						{!isWorkspacePreview && (
							<HeaderToolbar
								headerToolbarRef={headerToolbarRef}
								headerRowRef={headerRowRef}
								headerLeadingRef={headerLeadingRef}
								hostOwnsTitle={hostOwnsTitle}
								isWorkspacePreview={isWorkspacePreview}
								isMobileViewport={isMobileViewport}
								toolbarBadgeCounts={toolbarBadgeCounts}
								headerHostCapabilities={headerHostCapabilities}
								chapterId={chapterId}
								gitWorkspaceAvailable={
									!gitWorkspaceQuery.isError &&
									gitWorkspaceQuery.data?.state === "ready" &&
									gitWorkspaceQuery.data.capabilities.read
								}
								tasksSupported={tasksSupported}
								tasksButtonEnabled={tasksButtonEnabled}
								specToolAvailable={specToolAvailable}
								terminalToolAvailable={terminalToolAvailable}
								onOpenTerminalPanel={onOpenTerminalPanel}
								browserSessionsSupported={browserSessionsCapability.supported}
								mobileTasksOpen={mobileTasksOpen}
								mobileToolPanel={mobileToolPanel}
								fileModDrawerOpened={fileModDrawerOpened}
								detailsOpened={detailsOpened}
								terminalToolOpened={terminalToolOpened}
								specToolOpened={specToolOpened}
								setMobileTasksOpen={setMobileTasksOpen}
								setMobileToolPanel={setMobileToolPanel}
								setFileModDrawerOpened={setFileModDrawerOpened}
								toggleDetails={toggleDetails}
								toggleTerminalTool={toggleTerminalTool}
								toggleSpecTool={toggleSpecTool}
								openArchiveConfirm={openArchiveConfirm}
								archiveMutation={archiveMutation}
								executionDevicesQuery={executionDevicesQuery}
								updateExecutionDeviceMutation={updateExecutionDeviceMutation}
								renderLod={renderLod}
								renderLodIsDefault={renderLodIsDefault}
								handleSelectLod={handleSelectLod}
								setAsDefault={setAsDefault}
								openPluginPanel={openPluginPanel}
								dock={dock}
								mockStreamEnabled={mockStreamEnabled}
								onClose={onClose}
								t={t}
							/>
						)}
					</Group>

					<LeakedToolCallModal
						narratorId={narratorId}
						event={leakedToolEvent}
						onClose={() => setLeakedToolEvent(null)}
					/>

					<Modal
						opened={archiveConfirmOpened}
						onClose={closeArchiveConfirm}
						title={t("archiveConfirmTitle")}
						centered
					>
						<Stack>
							<Text size="sm">{t("archiveActiveWarning")}</Text>
							<Group justify="flex-end">
								<Button variant="default" onClick={closeArchiveConfirm}>
									{t("cancel")}
								</Button>
								<Button
									color="orange"
									onClick={async () => {
										if (isActive && retryRecoveryAllowsInterrupt) {
											await interruptMutation.mutateAsync(narratorId);
										}

										archiveMutation.mutate(narratorId);
										closeArchiveConfirm();
										if (onClose) {
											onClose();
										} else if (onMinimize) {
											onMinimize();
										} else {
											navigate({ to: "/narrators" });
										}
									}}
								>
									{t("confirmArchive")}
								</Button>
							</Group>
						</Stack>
					</Modal>

					<CompactSummaryModal
						target={compactSummaryModalTarget}
						onClose={closeCompactSummaryModal}
					/>

					<ContextThresholdSettingsModal
						opened={contextThresholdSettingsOpened}
						onClose={closeContextThresholdSettings}
						current={contextThresholdSettings}
						onSave={handleSaveContextThresholdSettings}
						saving={updateSettingsMutation.isPending}
						canSave={!!settingsData}
						onOpenGlobalSettings={() => navigate({ to: "/settings/agent" })}
					/>

					{/* Keep the Details drawer mounted (only gate on context, not on
					    `detailsOpened`) so Mantine plays its slide in/out transition —
					    driven by the `opened` prop, matching the terminal/spec drawers.
					    All of the panel's data hooks are `opened`-gated, so a mounted-
					    but-closed drawer fetches nothing. */}
					{!dock && !onToggleDetailsPanel && (
						<Suspense fallback={null}>
							<NarratorDetailsPanel
								opened={detailsOpened}
								onClose={closeDetails}
								narratorId={narratorId}
								narrator={narrator}
								viewers={viewers}
								defaultModelValue={defaultModelValue}
								planReflectionAutoApproveGlobal={planReflectionAutoApproveGlobal}
								dangerReflectionGlobal={dangerReflectionGlobal}
								dangerReflectionGlobalLevel={dangerReflectionGlobalLevel}
								displayMode="drawer"
							/>
						</Suspense>
					)}

					{/* Messages */}
					<Box
						ref={messageAreaRef}
						pos="relative"
						style={{ flex: 1, minHeight: 0, overflow: "hidden", isolation: "isolate" }}
					>
						<Box
							h="100%"
							ref={selectionToolbarParentRef}
							style={{
								position: "relative",
								userSelect: selectionMode ? "none" : undefined,
							}}
						>
							<CompactSummaryModalCtx.Provider value={compactSummaryModalCtxValue}>
								<MessageSelectionCtx.Provider value={selectionCtxValue}>
									<AllowRetryCtx.Provider value={allowRetryCtxValue}>
										<FileModDrawerCtx.Provider value={fileModDrawerCtxValue}>
											<LatestTodosToolUseIdCtx.Provider value={todosCtxValue}>
												<EditingMessageCtx.Provider value={editingMessageCtxValue}>
													<RenderLodCtx.Provider value={renderLodCtxValue}>
														{/* Same message-shaped skeleton the list itself shows while its
													    document loads, so the lazy-chunk wait and the document wait
													    look like one continuous placeholder (no blank → text flash).
													    The column geometry comes from the shared helper rather than
													    Mantine padding, so this fallback, the list's own placeholder
													    and the real rows are all the same width — otherwise the
													    mount stepped through two different column widths. */}
														<Suspense
															fallback={
																<Box style={narratorColumnPlaceholderStyle(narratorCenteredColumn)}>
																	<NarratorMessageListSkeleton />
																</Box>
															}
														>
															<PretextExactMessageList
																ref={chunkListRef}
																narratorId={narratorId}
																isSubagent={isSubagent}
																isActive={isActive}
																scrollRef={chunkViewportRef}
																contentRef={contentRef}
																onAtBottomChange={setIsAtBottom}
																onUnreadCountChange={setUnreadCount}
																onTailMetaChange={handleMessageListTailMetaChange}
																onLodStep={handleLodStep}
																onSelectionResolverChange={setChunkSelectionResolver}
																rowHandlers={vlistRowHandlers}
																permCb={permCbWithAsyncQuestions}
																hasChapter={hasChapter}
																highlightMessageId={highlightMessageId}
																highlightRequestId={highlightRequestId}
																tailFooter={
																	isSubagent &&
																	narrator &&
																	narrator.status === "idle" &&
																	!isTakenOver &&
																	substatus.includes("manual_override") &&
																	!isActive ? (
																		<Box ta="center" py="sm">
																			<Button
																				size="compact-sm"
																				variant="light"
																				color="indigo"
																				onClick={() => updateConclusionMutation.mutate(narratorId)}
																				loading={updateConclusionMutation.isPending}
																			>
																				{t("updateConclusion")}
																			</Button>
																		</Box>
																	) : null
																}
															/>
														</Suspense>
													</RenderLodCtx.Provider>
													<LodSwitchToast
														lod={renderLod}
														isDefault={renderLodIsDefault}
														onSetAsDefault={setAsDefault}
														onSelectLod={handleSelectLod}
														pinned={lodIndicatorPinned}
													/>
												</EditingMessageCtx.Provider>
											</LatestTodosToolUseIdCtx.Provider>
										</FileModDrawerCtx.Provider>
									</AllowRetryCtx.Provider>
								</MessageSelectionCtx.Provider>
							</CompactSummaryModalCtx.Provider>
						</Box>

						{/* Off-screen anchor overlay — one strip, three producers in priority
						    order: an active touch swipe, a running compaction, then the
						    desktop single-block selection (the weakest claim: it is a passive
						    wayfinding aid, the other two track a live operation). */}
						{(swipeAnchorOverlay ?? compactingMarkerOverlay ?? selectionAnchorOverlay) && (
							<SwipeAnchorOverlay
								info={
									(swipeAnchorOverlay ??
										compactingMarkerOverlay ??
										selectionAnchorOverlay) as SwipeAnchorInfo
								}
							/>
						)}

						{/* Multi-select floating toolbar — anchored to the message area's right edge,
						    not the viewport, so it stays inside this narrator's dockview panel. */}
						{selectionMode && (
							<Box
								ref={selectionToolbarRef}
								style={{
									position: "absolute",
									right: 16,
									top: selectionToolbarTop ?? "50%",
									transform: "translateY(-50%)",
									zIndex: Z.popover,
									pointerEvents: "auto",
									transition: "top 80ms ease-out",
								}}
							>
								<Menu opened withinPortal={false} position="bottom-start">
									<Menu.Dropdown style={{ position: "relative", width: 180 }}>
										<Menu.Label>{t("selectedBlocks", { count: selectedBlockIds.size })}</Menu.Label>
										<Menu.Item leftSection={<IconCopy size={14} />} onClick={handleBatchCopy}>
											{t("batchCopy")}
										</Menu.Item>
										<Menu.Item leftSection={<IconGitFork size={14} />} onClick={handleBatchFork}>
											{t("batchFork")}
										</Menu.Item>
										<Menu.Item
											leftSection={<IconArrowsMinimize size={14} />}
											onClick={handleSegmentCompact}
											disabled={!compactSupported}
											title={!compactSupported ? compactUnsupportedReason : undefined}
										>
											{t("segmentCompact")}
										</Menu.Item>
										<Menu.Item
											color="red"
											leftSection={<IconTrash size={14} />}
											onClick={handleBatchDelete}
										>
											{t("batchDelete")}
										</Menu.Item>
										<Menu.Divider />
										<Menu.Item leftSection={<IconX size={14} />} onClick={exitSelection}>
											{tc("cancel")}
										</Menu.Item>
									</Menu.Dropdown>
								</Menu>
							</Box>
						)}

						{effSendToTerminal && (
							<SelectionPopover
								containerRef={contentRef}
								onAction={effSendToTerminal}
								label={tt("sendToTerminal")}
							/>
						)}

						{/* Scroll to bottom button */}
						{!isWorkspacePreview && (
							<Box
								style={{
									position: "absolute",
									bottom: 12,
									right: 24,
									zIndex: 10,
									transform: showScrollToBottomButton ? "translateY(0)" : "translateY(80px)",
									opacity: showScrollToBottomButton ? 1 : 0,
									transition: "transform 200ms ease, opacity 200ms ease",
									pointerEvents: showScrollToBottomButton ? "auto" : "none",
								}}
							>
								{unreadCount > 0 && (
									<Badge
										size="sm"
										circle
										color="indigo"
										style={{
											position: "absolute",
											top: -6,
											right: -6,
											zIndex: 1,
											pointerEvents: "none",
										}}
									>
										{unreadCount > 99 ? "99+" : unreadCount}
									</Badge>
								)}
								<ActionIcon
									variant="filled"
									color="gray"
									radius="xl"
									size="lg"
									onClick={() => {
										chunkListRef.current?.scrollToBottom(true);
									}}
									title={
										unreadCount > 0
											? t("scrollToBottomWithCount", { count: unreadCount })
											: t("scrollToBottom")
									}
								>
									<IconArrowDown size={18} />
								</ActionIcon>
							</Box>
						)}
					</Box>

					{/* ═══════════════════ Bottom Interaction Area ═══════════════════ */}
					<NarratorInteractionArea
						common={{ narratorId, narrator, isWorkspacePreview, compact, isMobileViewport }}
						attachedImages={attachedImages}
						attachedTextFiles={attachedTextFiles}
						updateAttachedImages={updateAttachedImages}
						updateAttachedTextFiles={updateAttachedTextFiles}
						sendingState={sendingState}
						cancelSending={cancelSending}
						queueDeps={{
							queuedMessages,
							setQueuedMessages,
							reconcileBufferedMessages,
							cancelBuffer,
							composerRef,
							handleSendRef,
							handleSendWithModeRef,
							ctrlEnterQueueModeRef,
							queuedEditRef,
							queuedCancelRef,
							queuedRetryRef,
						}}
						chapterId={narrator.chapterId}
						onOpenGitPanel={
							isWorkspacePreview
								? undefined
								: dock
									? () => dock.openToolPanel("git")
									: () => setMobileToolPanel("git")
						}
						showHumanAttentionInbox={showHumanAttentionInbox}
						isChapterMerged={isChapterMerged}
						statusBarInputs={{
							ownsHorizontalSafeArea,
							borderTop:
								attachedImages.length > 0 || queuedMessages.length > 0
									? undefined
									: "1px solid var(--mantine-color-default-border)",
							t,
							tt,
							contextIndicator,
							viewers,
							currentUser,
							workIndicator: {
								show: showWorkIndicator,
								color: workIndicatorColor,
								plan: workIndicatorPlan,
								statusBarDisplay,
								isRetrying,
								isCompacting,
								currentSpecTask,
								retryInfo,
								compactingMarkerMessageId,
								compactFailure,
								compactProgressFragment,
								turnElapsedText,
								turnStartedAtLabel,
								onOpenSpecTool: openSpecTool,
								onScrollToMessageTarget: scrollToMessageTarget,
							},
							queue: {
								positionValue: queuePositionValue,
								depthValue: queueDepthValue,
								messageValue: queueMessageValue,
							},
							tasks: {
								supported: tasksSupported,
								buttonEnabled: tasksButtonEnabled,
								runningCount: tasksRunningCount,
								onOpenPanel: () => {
									if (dock) dock.openToolPanel("tasks");
									else setMobileTasksOpen(true);
								},
							},
							model: {
								allModels,
								aggregations,
								providerLabels,
								defaultModelValue,
								refreshProps: modelMenuRefreshProps,
								mutation: modelMutation,
								onEditDefaultModel: () => setGlobalModelEditTarget("default"),
								onEditSummaryModel: () => setGlobalModelEditTarget("summary"),
							},
							quota: {
								balance: quotaBalance,
								detailsText: quotaDetailsText,
								hasDetailsPopover: hasQuotaDetailsPopover,
								shouldShowNugRechargeButton,
								shouldShowNugRechargeInQuotaDetails,
								onOpenNugRecharge: openNugRecharge,
							},
							relaxedPlan: {
								enabled: relaxedPlanEnabled,
								forced: relaxedPlanForced,
								mutation: relaxedPlanMutation,
							},
							terminal: {
								toolAvailable: terminalToolAvailable,
								toolOpened: terminalToolOpened,
								activeCount: activeTerminalCount,
								onOpenPanel: onOpenTerminalPanel,
								onToggle: toggleTerminalTool,
							},
							promote: {
								show: !!narrator.isAskInPassing,
								pending: promoteMutation.isPending,
								onPromote: handlePromote,
							},
							mobile: {
								actions: mobileToolbarActions,
								measurementKey: mobileToolbarMeasurementKey,
							},
							// Inputs for the control sub-objects assembled by useStatusBarProps.
							resolvedModel,
							resolvedBareModel,
							resolvedModelOption,
							narratorReasoningEffort: narrator.reasoningEffort,
							settingsData,
							modelCardIndex,
							reasoningEffortMutation,
							updateSettingsMutation,
							narratorFastModeOverride: narrator.fastModeOverride,
							fastModeDefault,
							fastModeUsesTapSettings,
							fastModeMutation,
							updateUserPrefs,
							availablePermissionModes,
							permissionModesUnavailableReason,
							permModeMutation,
							hasPlanTrait,
							planModePending: enterPlanModeMutation.isPending || exitPlanModeMutation.isPending,
							planModeSupported,
							planModeUnsupportedReason,
							planReflectionSupported,
							dangerReflectionSupported,
							narratorPlanReflectionAutoApproveOverride: narrator.planReflectionAutoApproveOverride,
							narratorDangerReflectionOverride: narrator.dangerReflectionOverride,
							planReflectionAutoApproveGlobal,
							dangerReflectionGlobal,
							dangerReflectionGlobalLevel,
							settingsLoaded: !!settingsData,
							enterPlanModeMutation,
							exitPlanModeMutation,
							reflectionOverridesMutation,
							confirm,
							reflectionSettingsDisabled,
						}}
						composerRowProps={{
							fileInputRef,
							composerRef,
							sendingRef,
							appendInputRef,
							interruptBtnRef,
							isActive,
							composerHasText,
							composerHasAttachments,
							setComposerHasText,
							effectiveFocusIndex,
							enterQueueMode: userPrefs?.enterQueueMode ?? "turn",
							ctrlEnterQueueMode: userPrefs?.ctrlEnterQueueMode ?? "tool",
							onFileInputChange: handleFileInputChange,
							onComposerPasteImages: handleComposerPasteImages,
							onSendWithMode: composerSendWithMode,
							onSend: handleSend,
							onRetry: handleRetry,
							onContinue: handleContinue,
							onTakeover: () => takeoverMutation.mutate(narratorId),
							onStopTakeover: () => stopTakeoverMutation.mutate(narratorId),
							queuedMessagesCount: queuedMessages.length,
							showCompactQueueChoice,
							canCutInLine,
							hasCutInMessage: !isTakenOver && !!queuedMessages[0]?.priority,
							canTakeover,
							isTakenOver,
							canRetryLastUserMessage,
							canContinueNarrator,
							retryRecoveryAllowsInterrupt,
							editingMessageState,
							isSending,
							takeoverMutationPending: takeoverMutation.isPending,
							stopTakeoverMutationPending: stopTakeoverMutation.isPending,
							interruptMutationPending: interruptMutation.isPending,
							interruptProgress,
							startInterruptPress,
							handleInterruptMouseUp,
							clearInterruptTimer,
							// queueHoldProgress / startQueueHold / handleQueuePointerUp /
							// cancelQueueHold / handleQueueClick are injected by
							// NarratorInteractionArea from its local useQueuedMessageActions.
							onUpdateEnterQueueMode: (mode) => updateUserPrefs.mutate({ enterQueueMode: mode }),
							onUpdateCtrlEnterQueueMode: (mode) =>
								updateUserPrefs.mutate({ ctrlEnterQueueMode: mode }),
						}}
					/>
					{/* ═══════════════════ End Bottom Interaction Area ═══════════════════ */}

					{/* Only mount the lazy Drawer after its first open (mobile / workspace). */}
					{!dock &&
						!onToggleFileModPanel &&
						shouldRenderFileModificationsDrawer(fileModDrawerOpened, fileModDrawerHasOpened) && (
							<Suspense fallback={null}>
								<FileModificationsDrawer
									narratorId={narratorId}
									opened={fileModDrawerOpened}
									onClose={() => {
										setFileModDrawerOpened(false);
										setDeletePreviewMessageId(null);
										setPendingDeleteCallback(null);
									}}
									pendingPermission={firstEditPermission}
									onPermissionDecision={renderPermCb.onPermissionDecision}
									deletePreviewMessageId={deletePreviewMessageId}
									onConfirmDelete={() => {
										pendingDeleteCallback?.();
										setDeletePreviewMessageId(null);
										setPendingDeleteCallback(null);
									}}
									onCancelDelete={() => {
										setDeletePreviewMessageId(null);
										setPendingDeleteCallback(null);
									}}
								/>
							</Suspense>
						)}

					{/* Internal spec drawer — the third fallback when there is no dock spec
					    tab (off-dock page) or the dock is showing a pushed subagent. Bound to
					    THIS panel's narratorId so subagents show their own tasks. */}
					{useInternalSpec && (
						<Drawer
							opened={internalSpecOpen}
							onClose={() => setInternalSpecOpen(false)}
							position="right"
							size={600}
							title={t("spec.title")}
							styles={{
								header: SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
								body: {
									height: safeAreaDrawerBodyHeight(60),
									padding: 0,
									display: "flex",
									flexDirection: "column",
									...SAFE_AREA_DRAWER_BODY_STYLE,
								},
							}}
						>
							<Suspense
								fallback={
									<Center h="100%">
										<Loader size="sm" />
									</Center>
								}
							>
								<SpecPanel
									narratorId={narratorId}
									onClose={() => setInternalSpecOpen(false)}
									chromeless
								/>
							</Suspense>
						</Drawer>
					)}

					{/* Internal file viewer drawer — the off-dock host for "open in panel".
					    Mounted only while a path is selected (and torn down on close), so a
					    session that never opens a file pays nothing. Same viewer body the
					    dock's `file` panel renders. */}
					{internalFileViewerPath && (
						<Drawer
							opened
							onClose={() => setInternalFileViewerPath(null)}
							position="right"
							size={isMobileViewport ? "100%" : 600}
							// The viewer body already shows the base name; the title carries the
							// full path so the drawer adds information rather than repeating it.
							//
							// `TruncatedPath` rather than `truncate`: it ellipsizes from the LEFT,
							// so a deep path keeps the filename — the part that identifies the file —
							// visible instead of clipping it and leaving only directories.
							title={<TruncatedPath path={internalFileViewerPath} fw={600} />}
							closeButtonProps={{ size: "sm" }}
							styles={{
								header: SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
								// Mantine's header is a flex row and its title child has no
								// `min-width: 0`, so a long unbroken path floors at its content
								// width and pushes the close button off-screen — with no way back
								// on touch, where there is no Escape key. The title must be the
								// side that yields.
								title: { minWidth: 0, flex: 1, overflow: "hidden" },
								body: {
									height: safeAreaDrawerBodyHeight(60),
									padding: 0,
									display: "flex",
									flexDirection: "column",
									...SAFE_AREA_DRAWER_BODY_STYLE,
								},
							}}
						>
							<Suspense
								fallback={
									<Center h="100%">
										<Loader size="sm" />
									</Center>
								}
							>
								<FileViewerContent
									key={internalFileViewerPath}
									filePath={internalFileViewerPath}
									narratorId={narratorId}
									deviceId={internalFileViewerTarget?.deviceId ?? "local"}
									referenceOrigin={!!internalFileViewerTarget}
									selection={internalFileViewerTarget?.selection}
									highlightRequestId={internalFileViewerTarget?.highlightRequestId}
									onOpenFileTarget={handleOpenReferencedFile}
								/>
							</Suspense>
						</Drawer>
					)}
					{/*
					 * Off-dock hosts for the entries that previously had NO mobile entry
					 * point. Mounted only when this panel has no dock to put panels in, so
					 * a desktop surface keeps using real dockview tabs.
					 */}
					{!dock && !isWorkspacePreview && (
						<>
							<MobileToolPanelHost
								kind={mobileToolPanel}
								onClose={() => setMobileToolPanel(null)}
								narratorId={narratorId}
								chapterId={chapterId}
								browserSessionCount={wsState.browserSessionCount}
								browserVisualChange={wsState.browserVisualChange}
								// Replaces the dock's `scrollToMessage` / `submitToNarrator` bridges,
								// which do not exist off-dock. Without these the mobile search panel
								// would list results it cannot open, and the discussion room could not
								// forward anything to the narrator. Forwarding goes through the SAME
								// `forwardTextToNarrator` the dock bridge registers, so the mobile
								// path preserves the in-progress draft and staged attachments too.
								onJumpToMessage={(messageId) => {
									void scrollToMessageTarget({
										domIds: [`msg-${messageId}`],
										targetIds: [messageId],
										highlightId: messageId,
									});
								}}
								onForwardToNarrator={forwardTextToNarrator}
							/>
							<BackgroundTasksDrawerHost
								narratorId={narratorId}
								opened={mobileTasksOpen}
								onClose={() => setMobileTasksOpen(false)}
							/>
						</>
					)}
				</Stack>
			</ContentViewerEnvironmentProvider>
			<RevertActionConfirmModal
				narratorId={narratorId}
				action="rollback_to_block"
				pending={pendingRollback}
				submitting={revertHistorySubmitting}
				onConfirm={confirmRollback}
				onCancel={() => {
					if (!revertHistorySubmitting) setPendingRollback(null);
				}}
			/>
			<RevertActionConfirmModal
				narratorId={narratorId}
				action="delete_tool_block"
				pending={pendingBlockDelete}
				submitting={revertHistorySubmitting}
				onConfirm={confirmBlockDelete}
				onCancel={() => {
					if (!revertHistorySubmitting) setPendingBlockDelete(null);
				}}
			/>
			<SetGlobalModelModal
				opened={globalModelEditTarget != null}
				mode={globalModelEditTarget}
				groupedModels={groupedModels}
				currentValue={globalModelEditTarget === "summary" ? summaryModelValue : defaultModelValue}
				saving={updateSettingsMutation.isPending}
				onClose={() => setGlobalModelEditTarget(null)}
				onConfirm={
					globalModelEditTarget === "summary" ? handleSetSummaryModel : handleSetDefaultModel
				}
			/>
		</PermEnterHintCtx.Provider>
	);
}
