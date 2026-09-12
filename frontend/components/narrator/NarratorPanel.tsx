import { fileReferenceApi } from "@frontend/lib/api/file-references";
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
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { tailRoleAllowsContinue } from "@shared/continue-tail";
import type {
	FileReference,
	FileReferenceContext,
	FileReferenceEditorSelection,
	FileTarget,
} from "@shared/file-reference";
import { cardEffortLevels, lookupModelCard } from "@shared/model-card";
import { MOBILE_TOOLBAR_VISIBLE_LIMIT } from "@shared/narrator-toolbar";
import { clampReasoningEffort, type ReasoningEffort } from "@shared/reasoning-effort";
import {
	claudeVersionAtLeast,
	GENERIC_REASONING_EFFORT_TIERS,
	modelAcceptsReasoningEffort,
	parseClaudeModel,
} from "@shared/reasoning-effort-support";
import {
	IconArrowDown,
	IconArrowLeft,
	IconArrowsMinimize,
	IconCopy,
	IconExternalLink,
	IconGitBranch,
	IconGitFork,
	IconLock,
	IconLockOpen,
	IconPencil,
	IconSparkles,
	IconTrash,
	IconUpload,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
	useForkNarrator,
	useInterruptNarrator,
	useNarrator,
	usePromoteNarrator,
	useRevertHistoryAction,
	useStartAskInPassing,
	useStopTakeoverSubagent,
	useTakeoverSubagent,
	useUpdateFastMode,
	useUpdateModel,
	useUpdatePermissionMode,
	useUpdatePruneEnabled,
	useUpdateReasoningEffort,
	useUpdateReflectionOverrides,
	useUpdateRelaxedPlan,
	useUpdateSubagentConclusion,
} from "../../hooks/useNarrator";
import { useNarratorHeaderToolbarCapacity } from "../../hooks/useNarratorHeaderToolbarCapacity";
import { useNarratorLod } from "../../hooks/useNarratorLod";
import { useNarratorToolbarLayout } from "../../hooks/useNarratorToolbarLayout";
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
import { ApiError, api, type BufferMessageSummary, isAbortError } from "../../lib/api";
import type { RevertActionConfirmOptions, RevertScope } from "../../lib/api/narrators";
import { type ModelOption, resolveDisplayModel, statusRegistry } from "../../lib/constants";
import { collectElementTextPreview, compactWhitespacePreview } from "../../lib/dom-text";
import {
	calculateEffectiveTurnElapsedMs,
	formatColonDuration,
	formatFullLocaleDateTime,
} from "../../lib/format";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { requestNugModelRefreshOnPickerOpen } from "../../lib/nug-model-refresh";
import { formatRevertWarnings } from "../../lib/revert-warnings";
import {
	SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE,
	SAFE_AREA_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
} from "../../lib/safe-area";
import { Z } from "../../lib/z-index";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { useImageViewer } from "../common/image-viewer-context";
import { SelectionPopover } from "../common/SelectionPopover";
import { TruncatedPath } from "../common/TruncatedPath";
import {
	buildPluginDockPanelOpenRequest,
	PluginContributionOptions,
} from "../plugins/PluginContributionPicker";
import { usePluginUiSurface } from "../plugins/PluginUiSurfaceContext";
import { toBannerQuestions } from "./async-question-questions";
import { BackgroundTasksDrawerHost, useBackgroundTasksButton } from "./BackgroundTasksDrawer";
import { ContentViewerEnvironmentProvider } from "./ContentViewer";
import {
	COMPACTING_MARKER_ATTR,
	CompactSummaryModal,
	CompactSummaryModalCtx,
	type CompactSummaryModalTarget,
} from "./compact-summary-modal";
import { hasSendableComposerContent } from "./composer-send-gate";
import { ContextThresholdSettingsModal } from "./context-management/ContextThresholdSettingsModal";
import {
	type ContextManagementDraft,
	DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
	DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD,
	DEFAULT_CONTEXT_THRESHOLDS_DRAFT,
	DEFAULT_MIN_PRUNE_RATIO,
} from "./context-management/types";
import { useNarratorDockContext } from "./dock/NarratorDockContext";
import { EditingMessageCtx, type EditingMessageState } from "./EditingMessageCtx";
import { ExecutionDeviceOptions } from "./ExecutionDeviceMenu";
import type { FileReferenceScopeValue } from "./FileReferenceScope";
import { useFilePanelNavigation } from "./file-panel-navigation";
import { trimFileReferenceInput } from "./file-reference-input";
import { HeaderToolbar } from "./header/HeaderToolbar";
import { useTitleEditing } from "./header/use-title-editing";
import { ContextUsageIndicator } from "./interaction/ContextUsageIndicator";
import { FastModeControl } from "./interaction/FastModeControl";
import { PathRulesPopover } from "./interaction/PathRulesPopover";
import {
	type BooleanOverride,
	type DangerReflectionOverride,
	normalizeBooleanOverride,
	normalizeDangerReflectionLevel,
	normalizeDangerReflectionOverride,
	resolveBooleanOverride,
	resolveDangerReflectionLevel,
} from "./interaction/reflection-types";
import { SetGlobalModelModal } from "./interaction/SetGlobalModelModal";
import { useComposerAttachments } from "./interaction/use-composer-attachments";
import { useInterruptLongPress } from "./interaction/use-interrupt-long-press";
import { useQueuedMessageActions } from "./interaction/use-queued-message-actions";
import {
	formatKimiBarText,
	formatKimiDetailsText,
	isKimiProviderBaseUrl,
} from "./kimi-usage-format";
import { LeakedToolCallModal } from "./LeakedToolCallModal";
import { LodSwitchToast } from "./LodSwitchToast";
import { MobileToolPanelHost, type MobileToolPanelKind } from "./MobileToolPanelHost";
import { BLOCK_ID_ATTR, MessageSelectionCtx } from "./message/MessageSelectionCtx";
import type { MessageListHandle, MessageListTailMeta } from "./message/message-list-handle";
// TEMPORARY: streaming harness activity flag (see ./mock/README-REMOVAL.md).
// Store-only import — the panel component itself is lazy-loaded by the dock.
import { useMockStreamActive } from "./mock/mock-stream-store";
import { NugRechargeDialog } from "./model/NugRechargeDialog";
import type { NarratorComposerHandle, NarratorRemoteDraft } from "./NarratorComposer";
import { NarratorInteractionArea } from "./NarratorInteractionArea";
import { NarratorLodOptions } from "./NarratorLodMenu";
import { NarratorMessageListSkeleton } from "./NarratorMessageListSkeleton";
import { NarratorPanelSkeleton } from "./NarratorPanelSkeleton";
import type { NarratorStatusToolbarAction } from "./NarratorStatusToolbar";
import {
	HEADER_TITLE_MIN_WIDTH_PX,
	HEADER_TITLE_SLOT_ATTR,
	selectHeaderToolbarEntries,
} from "./narrator-header-toolbar-capacity";
import { revokeContentBlockPreviewUrls } from "./narrator-message-helpers";
import type {
	AsyncQuestionSlot,
	ContentBlock,
	NarratorMsg,
	NarratorPanelProps,
} from "./narrator-panel-types";
import {
	ACCEPTED_TYPES,
	formatFileSize,
	isTextFile,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	MAX_TEXT_FILE_SIZE,
	resizeImageIfNeeded,
} from "./narrator-panel-types";
import { getNarratorStatusBarDisplay, planNarratorWorkIndicator } from "./narrator-status-bar";
import type { NarratorToolbarBadgeCounts } from "./narrator-toolbar-badges";
import type { NarratorToolbarHost, NarratorToolbarId } from "./narrator-toolbar-items";
import { nextHighlightRequestId } from "./panels/panel-kind";
import { compactProgressLabel } from "./progress-label";
import { type RenderLod, RenderLodCtx } from "./RenderLodCtx";
import { RevertActionConfirmModal } from "./RevertScopeConfirmModal";
import { SwipeAnchorOverlay } from "./SwipeAnchorOverlay";
import { useMessageSelection } from "./selection/use-message-selection";
import { resolveSelectionOverlayBlockId } from "./selection-anchor-overlay";
import { revealSpecFile } from "./spec-file-reveal";
import { type SwipeAnchorInfo, setGlobalOnSwipeAnchorInfo } from "./swipeState";
import {
	AllowRetryCtx,
	FileModDrawerCtx,
	LatestTodosToolUseIdCtx,
	PermEnterHintCtx,
} from "./tool-call/tool-call-contexts";
import { type PaymentRequiredInfo, useNarratorPanelWS } from "./useNarratorPanelWS";

function parsePersistedPaymentRequired(value: unknown): Partial<PaymentRequiredInfo> | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed.type !== "payment_required") return null;
		const resumeAction = parsed.resumeAction === "continue" ? "continue" : "retry";
		const balance = typeof parsed.balance === "number" ? parsed.balance : undefined;
		const required = typeof parsed.required === "number" ? parsed.required : undefined;
		return {
			providerId: typeof parsed.providerId === "string" ? parsed.providerId : undefined,
			providerPrefix: typeof parsed.providerPrefix === "string" ? parsed.providerPrefix : undefined,
			balance,
			required,
			resumeAction,
		};
	} catch {
		return null;
	}
}

/* ── Shared menu-item renderers (desktop NativeSelect + mobile ActionIcon share these) ── */

const NarratorDetailsPanel = lazy(() =>
	import("./NarratorDetailsPanel").then((module) => ({ default: module.NarratorDetailsPanel })),
);

const SpecPanel = lazy(() =>
	import("./SpecPanel").then((module) => ({ default: module.SpecPanel })),
);
const FileModificationsDrawer = lazy(() =>
	import("./FileModificationsDrawer").then((module) => ({
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

function _getCompactingMarkerKind(
	message: Pick<NarratorMsg, "contentJson">,
): CompactingMarkerKind | null {
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const block = blocks.find(
		(block: ContentBlock) =>
			(block.type === "compact" || block.type === "segment_compact") &&
			block.status === "compacting",
	);
	if (!block) return null;
	return block.type === "segment_compact" ? "segment" : "context";
}

type BufferedSendResult = {
	buffered?: boolean;
	id?: string;
	bufferedAt?: string;
	/** Set when a busy `/goal` was queued; used to show a "queued task" toast. */
	specGoalQueued?: boolean;
	/** The protected task text carried by a queued `/goal`. */
	objective?: string;
};

function getMessageViewportScrollBottom(scroller: HTMLElement) {
	return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

function _getMessageViewportDistanceFromBottom(scroller: HTMLElement) {
	return getMessageViewportScrollBottom(scroller) - scroller.scrollTop;
}

type ReasoningEffortValue = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Fallback tiers for a Codex model missing from the catalog below. Kept
 * separate from GENERIC_REASONING_EFFORT_TIERS: Codex models have no `max`
 * tier, so an unknown one must not offer it.
 */
const DEFAULT_CODEX_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
];

/** DeepSeek only supports two effective tiers: high and max (mapped from xhigh). */
const DEEPSEEK_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"high",
	"xhigh",
];

/**
 * Gemini exposes a three-tier thinking level (low/medium/high) plus "none" to
 * disable thinking. NarraFork's higher tiers (xhigh/max) collapse onto "high"
 * upstream, so they are not offered here.
 */
const GEMINI_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
];

/**
 * Anthropic effort tiers for 4.6-era models (official API and
 * Anthropic-compatible relays). The `xhigh` tier only arrived with Opus 4.7,
 * so these models expose low/medium/high/max plus "none" to disable thinking.
 */
const ANTHROPIC_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
	"max",
];

/**
 * Anthropic effort tiers for models with the `xhigh` tier — Opus 4.7/4.8, the
 * 5 series (Opus 5 / Sonnet 5) and Fable/Mythos.
 */
const ANTHROPIC_XHIGH_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const CODEX_REASONING_OPTIONS_BY_MODEL: Record<string, readonly ReasoningEffortValue[]> = {
	// GPT-6 Astra requires reasoning, so it intentionally omits `none`.
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
};

function getBareModelForReasoning(model?: string, modelOption?: ModelOption): string {
	if (modelOption?.bareModel) return modelOption.bareModel;
	if (!model) return "";
	const modelWithoutProvider = model.includes(":") ? model.split(":").slice(1).join(":") : model;
	const channel = modelOption?.channel ?? modelWithoutProvider.split(":")[0];
	if (channel) {
		const channelPrefix = `${channel}:`;
		if (modelWithoutProvider.startsWith(channelPrefix)) {
			return modelWithoutProvider.slice(channelPrefix.length);
		}
	}
	return modelWithoutProvider.startsWith("codex:")
		? modelWithoutProvider.slice("codex:".length)
		: modelWithoutProvider;
}

function getCodexReasoningEffortOptions(
	model?: string,
	modelOption?: ModelOption,
): readonly ReasoningEffortValue[] {
	const bareModel = getBareModelForReasoning(model, modelOption);
	return CODEX_REASONING_OPTIONS_BY_MODEL[bareModel] ?? DEFAULT_CODEX_REASONING_EFFORT_OPTIONS;
}

function codexModelSupportsReasoningDisabled(model?: string, modelOption?: ModelOption): boolean {
	return getBareModelForReasoning(model, modelOption) !== "gpt-6-astra";
}

function isDeepSeekModel(model?: string): boolean {
	if (!model) return false;
	return model.toLowerCase().includes("deepseek");
}

/**
 * Whether an Anthropic model has the `xhigh` tier (Opus 4.7+ / 5 series).
 * A tier question, not an access question — the parsing it relies on lives in
 * @shared/reasoning-effort-support alongside the backend's copy.
 */
function anthropicModelSupportsXhigh(model?: string): boolean {
	if (!model) return false;
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family !== "sonnet" && parsed.family !== "opus") return false;
	return claudeVersionAtLeast(parsed, 4, 7);
}

function normalizeReasoningEffortForModel(
	model: string | undefined,
	effort: string | null | undefined,
): string {
	if (!effort) return "";
	if (isDeepSeekModel(model) && (effort === "low" || effort === "medium")) return "high";
	return effort;
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
	const forkNarratorMutation = useForkNarrator();
	const createNarratorMutation = useCreateNarrator();
	const updateConclusionMutation = useUpdateSubagentConclusion();
	const takeoverMutation = useTakeoverSubagent();
	const stopTakeoverMutation = useStopTakeoverSubagent();
	const isWorkspacePreview = workspacePreview === true;
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
				prev.pruneBoundaryMessageId === meta.pruneBoundaryMessageId &&
				prev.prunedPercent === meta.prunedPercent &&
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
	const pruneEnabledMutation = useUpdatePruneEnabled();
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
	// "inherit" follows the default, so the default switch below also changes what
	// this session actually does — matching the server-side per-turn resolution.
	const fastModeOverride = narrator?.fastModeOverride ?? "inherit";
	const fastModeEnabled =
		fastModeOverride === "inherit" ? fastModeDefault : fastModeOverride === "on";
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
			qc.invalidateQueries({ queryKey: ["narrator", narratorId] });
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
	const pruneEnabledGlobal = settingsData?.agent?.defaultPruneEnabled ?? false;
	const pruneEnabledEffective = narrator?.pruneEnabled ?? pruneEnabledGlobal;
	const pruneDiffersFromDefault = pruneEnabledEffective !== pruneEnabledGlobal;
	const reflectionSettingsDisabled =
		!settingsData || updateSettingsMutation.isPending || reflectionOverridesMutation.isPending;
	const contextThresholdSettings = useMemo<ContextManagementDraft>(() => {
		const thresholds = settingsData?.agent?.contextThresholds ?? DEFAULT_CONTEXT_THRESHOLDS_DRAFT;
		return {
			contextThresholds: {
				standard: {
					pruneStart:
						thresholds.standard?.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS_DRAFT.standard.pruneStart,
					compactStart:
						thresholds.standard?.compactStart ??
						DEFAULT_CONTEXT_THRESHOLDS_DRAFT.standard.compactStart,
				},
				large: {
					pruneStart:
						thresholds.large?.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS_DRAFT.large.pruneStart,
					compactStart:
						thresholds.large?.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS_DRAFT.large.compactStart,
				},
			},
			autoCompactKeepPairs:
				settingsData?.agent?.autoCompactKeepPairs ?? DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
			autoCompactPruneThreshold:
				settingsData?.agent?.autoCompactPruneThreshold ?? DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD,
			minPruneRatio: settingsData?.agent?.minPruneRatio ?? DEFAULT_MIN_PRUNE_RATIO,
		};
	}, [settingsData?.agent]);
	const forceCompactPruneThreshold = contextThresholdSettings.autoCompactPruneThreshold;
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

	const displayTitle = narrator?.title || t("untitled");
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
	const resolvedModel = useMemo(
		() =>
			resolveDisplayModel(narrator?.model, {
				defaultModelValue,
				aggregations,
			}),
		[narrator?.model, defaultModelValue, aggregations],
	);

	// Parse provider:model for context threshold lookup
	const { resolvedProvider, resolvedBareModel } = useMemo(() => {
		const idx = resolvedModel.indexOf(":");
		if (idx > 0) {
			return {
				resolvedProvider: resolvedModel.slice(0, idx),
				resolvedBareModel: resolvedModel.slice(idx + 1),
			};
		}
		return { resolvedProvider: "", resolvedBareModel: resolvedModel };
	}, [resolvedModel]);

	// Fetch context thresholds for the current model (used as fallback when WS hasn't pushed yet)
	const { data: modelThresholds } = useQuery({
		queryKey: ["contextThresholds", resolvedBareModel, resolvedProvider],
		queryFn: () => api.getContextThresholds(resolvedBareModel, resolvedProvider),
		staleTime: 5 * 60 * 1000,
		placeholderData: { pruneStart: 95, compactStart: 99 },
	});

	const nugProviderConfig = useMemo(() => {
		const prefix = resolvedModel?.split(":")[0];
		if (!prefix) return null;
		const nugProviders: Array<{ id: string; name?: string; prefix?: string; disabled?: boolean }> =
			settingsData?.nugProviders ?? [];
		return (
			nugProviders.find((p) => !p.disabled && (p.prefix === prefix || p.id === prefix)) ?? null
		);
	}, [resolvedModel, settingsData?.nugProviders]);
	const hasNugProviders = (settingsData?.nugProviders?.length ?? 0) > 0;
	const { data: nugQuotasData } = useQuery({
		queryKey: ["nug", "quotas"],
		queryFn: api.nugGetQuotas,
		enabled: hasNugProviders,
		staleTime: 30_000,
	});
	const missingCurrentNugQuota = Boolean(
		nugProviderConfig?.id && nugQuotasData && !nugQuotasData[nugProviderConfig.id],
	);
	const { data: currentNugQuotaData } = useQuery({
		queryKey: ["nug", "quota", nugProviderConfig?.id],
		queryFn: () => api.nugGetQuota(nugProviderConfig?.id ?? ""),
		enabled: missingCurrentNugQuota,
		staleTime: 30_000,
	});

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

	useEffect(() => {
		if (!nugProviderConfig?.id || !currentNugQuotaData) return;
		qc.setQueryData(["nug", "quotas"], (old: unknown) => {
			const quotas = old && typeof old === "object" ? (old as Record<string, unknown>) : {};
			const existing =
				quotas[nugProviderConfig.id] && typeof quotas[nugProviderConfig.id] === "object"
					? (quotas[nugProviderConfig.id] as Record<string, unknown>)
					: {};
			return {
				...quotas,
				[nugProviderConfig.id]: {
					...existing,
					balance: currentNugQuotaData.balance,
					totalGranted: currentNugQuotaData.totalGranted,
					detailedQuotaBalance: currentNugQuotaData.detailedQuotaBalance ?? null,
					...(currentNugQuotaData.extra !== undefined ? { extra: currentNugQuotaData.extra } : {}),
				},
			};
		});
	}, [currentNugQuotaData, nugProviderConfig?.id, qc]);

	const codexCapableProviders = useMemo(() => {
		const providers = new Set<string>();
		if (settingsData?.codexAvailable) providers.add("codex");
		for (const provider of settingsData?.openaiProviders ?? []) {
			if (provider?.prefix && (provider.apiMode ?? "responses") === "codex") {
				providers.add(provider.prefix);
			}
		}
		return providers;
	}, [settingsData]);
	const resolvedModelOption = useMemo(
		() => allModels.find((m) => m.value === resolvedModel),
		[allModels, resolvedModel],
	);
	const isCodexChannelModel =
		resolvedModelOption?.channelType?.toLowerCase() === "codex" ||
		resolvedBareModel.startsWith("codex:");
	const supportsCodexControls = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		return (!!providerPrefix && codexCapableProviders.has(providerPrefix)) || isCodexChannelModel;
	}, [codexCapableProviders, isCodexChannelModel, resolvedModel]);
	const isBuiltInCodexModel = resolvedModel?.split(":")[0] === "codex";

	/**
	 * Whether to offer the reasoning-effort menu at all.
	 *
	 * Blacklist policy, mirroring the backend: effort is near-universal, so any
	 * configured model gets the menu unless it is excluded. The previous
	 * whitelist demanded a recognizable Claude/Codex/Gemini/DeepSeek id, which
	 * hid the menu for every third-party model behind a generic relay (GLM,
	 * Kimi, MiniMax, ...) even though those upstreams accept the parameter.
	 *
	 * Two exclusions, both shared with the backend via
	 * `modelAcceptsReasoningEffort`: pre-4.6 Claude, and the user's
	 * `agent.reasoningEffortBlocklist`.
	 */
	const supportsReasoningEffort = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		if (!providerPrefix) return false;
		// Codex always has tiers, regardless of the model id.
		if (codexCapableProviders.has(providerPrefix) || isCodexChannelModel) return true;
		return modelAcceptsReasoningEffort(
			getBareModelForReasoning(resolvedModel, resolvedModelOption),
			settingsData?.agent?.reasoningEffortBlocklist,
		);
	}, [
		codexCapableProviders,
		isCodexChannelModel,
		resolvedModelOption,
		settingsData?.agent?.reasoningEffortBlocklist,
		resolvedModel,
	]);
	const reasoningEffortOptions = useMemo(() => {
		if (!resolvedModel) return GENERIC_REASONING_EFFORT_TIERS;
		// DeepSeek: only two effective tiers (high / max mapped from xhigh)
		if (isDeepSeekModel(resolvedModel)) return DEEPSEEK_REASONING_EFFORT_OPTIONS;
		// Model cards: the editable replacement for the hardcoded per-model tables.
		// `none` is appended here rather than stored on the card, because on a card
		// it would become a clamp target able to silently turn a requested `low`
		// into thinking switched off.
		const cardTiers = modelCardIndex
			? cardEffortLevels(
					lookupModelCard(
						getBareModelForReasoning(resolvedModel, resolvedModelOption),
						modelCardIndex,
					)?.card,
				)
			: undefined;
		if (cardTiers?.length) {
			return codexModelSupportsReasoningDisabled(resolvedModel, resolvedModelOption)
				? (["none", ...cardTiers] as readonly ReasoningEffortValue[])
				: (cardTiers as readonly ReasoningEffortValue[]);
		}
		const providerPrefix = resolvedModel.split(":")[0];
		if (providerPrefix && (codexCapableProviders.has(providerPrefix) || isCodexChannelModel)) {
			return getCodexReasoningEffortOptions(resolvedModel, resolvedModelOption);
		}
		// Anthropic (official, compatible/cc relay, or NUG anthropic channel).
		// Opus 4.7+ and the 5 series add the xhigh tier; 4.6 stays on four tiers.
		const isAnthropic =
			resolvedModelOption?.channelType === "anthropic" ||
			(!!providerPrefix &&
				(settingsData?.anthropicProviders ?? []).some(
					(p: { prefix?: string }) => p.prefix === providerPrefix,
				));
		if (isAnthropic) {
			return anthropicModelSupportsXhigh(
				getBareModelForReasoning(resolvedModel, resolvedModelOption),
			)
				? ANTHROPIC_XHIGH_REASONING_EFFORT_OPTIONS
				: ANTHROPIC_REASONING_EFFORT_OPTIONS;
		}
		// Gemini (gemini-compatible): low/medium/high plus none.
		const isGemini =
			!!providerPrefix &&
			(settingsData?.geminiProviders ?? []).some(
				(p: { prefix?: string }) => p.prefix === providerPrefix,
			);
		if (isGemini) {
			return GEMINI_REASONING_EFFORT_OPTIONS;
		}
		// Everything else — a third-party model on a generic relay, with no tier
		// table of its own. Uses the shared generic ladder (none/low/medium/high/
		// max) that the backend clamps against, so the menu cannot offer a tier
		// the request path would silently rewrite.
		return GENERIC_REASONING_EFFORT_TIERS;
	}, [
		codexCapableProviders,
		isCodexChannelModel,
		modelCardIndex,
		resolvedModel,
		resolvedModelOption,
		settingsData?.anthropicProviders,
		settingsData?.geminiProviders,
	]);

	// The global default reasoning effort (single source of truth). Applied to
	// every model when the narrator has no explicit override.
	const globalDefaultReasoningEffort = useMemo<ReasoningEffort>(() => {
		const raw = settingsData?.agent?.defaultReasoningEffort;
		return (raw as ReasoningEffort) || "max";
	}, [settingsData?.agent?.defaultReasoningEffort]);

	// Whether the narrator is following the global default (no explicit override).
	const reasoningFollowsDefault = narrator?.reasoningEffort == null;

	// The effective reasoning effort to highlight in the menu. Always shows the
	// tier that will actually be used: the narrator's own override (clamped to
	// the model), or — when following default — the clamped global default.
	// Mirrors the permission/reflection menus, which show the effective value and
	// express the follow/override state only via the inline links below.
	const displayedReasoningEffort = useMemo(() => {
		const options = reasoningEffortOptions as readonly ReasoningEffort[];
		const desired = reasoningFollowsDefault
			? globalDefaultReasoningEffort
			: (normalizeReasoningEffortForModel(
					resolvedModel,
					narrator?.reasoningEffort,
				) as ReasoningEffort);
		if (!desired) return "";
		return clampReasoningEffort(desired, options);
	}, [
		resolvedModel,
		narrator?.reasoningEffort,
		reasoningEffortOptions,
		reasoningFollowsDefault,
		globalDefaultReasoningEffort,
	]);

	// "Follow default": clear the narrator's override so it tracks the global
	// default again.
	const handleFollowDefaultReasoning = useCallback(() => {
		reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: null });
	}, [narratorId, reasoningEffortMutation]);

	// "Set as default": promote the narrator's explicit override to the global
	// default (writing the raw desired value, NOT the per-model clamped one), then
	// reset the narrator to follow the default. Only meaningful when an override
	// exists, so the inline link is hidden while following default.
	const handleSetReasoningAsDefault = useCallback(() => {
		const desired = narrator?.reasoningEffort;
		if (!desired) return;
		updateSettingsMutation.mutate(
			{ agent: { defaultReasoningEffort: desired } },
			{
				onSuccess: () => {
					reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: null });
				},
			},
		);
	}, [narrator?.reasoningEffort, narratorId, reasoningEffortMutation, updateSettingsMutation]);

	// Active terminal count for badge indicator
	const { data: narratorTerminals } = useNarratorTerminals(narratorId);
	const activeTerminalCount = useMemo(
		() => narratorTerminals?.filter((t) => t.status === "running").length ?? 0,
		[narratorTerminals],
	);

	// --- Message operations ---
	const setUnreadCountRef = useRef<React.Dispatch<React.SetStateAction<number>>>(undefined);
	const revertHistoryAction = useRevertHistoryAction(narratorId);
	const { mutateAsync: applyHistoryAction, isPending: revertHistorySubmitting } =
		revertHistoryAction;
	// Deleting a block rolls its file changes back, so it asks first rather than
	// firing straight from the context menu.
	const [pendingBlockDelete, setPendingBlockDelete] = useState<{
		messageId: string;
		blockIndex: number;
	} | null>(null);

	const handleDeleteBlock = useCallback(
		(messageId: string, blockIndex: number) => {
			if (!revertHistorySubmitting) setPendingBlockDelete({ messageId, blockIndex });
		},
		[revertHistorySubmitting],
	);

	const confirmBlockDelete = useCallback(
		async (opts: RevertActionConfirmOptions) => {
			if (!pendingBlockDelete || revertHistorySubmitting) return;
			try {
				await applyHistoryAction({ action: "delete_tool_block", target: pendingBlockDelete, opts });
				setPendingBlockDelete(null);
			} catch {
				// The mutation explains the journal outcome. Keep the revoked preview open
				// for an explicit reload or a history-only choice; never retry automatically.
			} finally {
				chunkListRef.current?.refreshStructure("full");
			}
		},
		[applyHistoryAction, pendingBlockDelete, revertHistorySubmitting],
	);

	const [pendingRollback, setPendingRollback] = useState<{
		messageId: string;
		blockIndex: number;
	} | null>(null);

	const handleRollback = useCallback(
		(messageId: string, blockIndex: number) => {
			if (!rollbackEditRegenerateSupported) {
				notifications.show({
					title: t("rollbackEditRegenerateUnsupportedTitle"),
					message: rollbackEditRegenerateUnsupportedReason,
					color: "yellow",
				});
				return;
			}
			if (!revertHistorySubmitting) setPendingRollback({ messageId, blockIndex });
		},
		[
			rollbackEditRegenerateSupported,
			rollbackEditRegenerateUnsupportedReason,
			revertHistorySubmitting,
			t,
		],
	);

	const confirmRollback = useCallback(
		async (opts: RevertActionConfirmOptions) => {
			if (!pendingRollback || revertHistorySubmitting) return;
			if (!rollbackEditRegenerateSupported) {
				notifications.show({
					title: t("rollbackEditRegenerateUnsupportedTitle"),
					message: rollbackEditRegenerateUnsupportedReason,
					color: "yellow",
				});
				setPendingRollback(null);
				return;
			}
			try {
				await applyHistoryAction({ action: "rollback_to_block", target: pendingRollback, opts });
				setPendingRollback(null);
			} catch {
				// No second history mutation, and no re-plan/retry after an uncertain apply.
			} finally {
				chunkListRef.current?.refreshStructure("full");
			}
		},
		[
			applyHistoryAction,
			pendingRollback,
			revertHistorySubmitting,
			rollbackEditRegenerateSupported,
			rollbackEditRegenerateUnsupportedReason,
			t,
		],
	);

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
	const [compactSummaryModalTarget, setCompactSummaryModalTarget] =
		useState<CompactSummaryModalTarget | null>(null);
	const compactSummaryModalCtxValue = useMemo(
		() => ({
			open: (target: CompactSummaryModalTarget) => setCompactSummaryModalTarget(target),
		}),
		[],
	);
	const closeCompactSummaryModal = useCallback(() => setCompactSummaryModalTarget(null), []);
	useEffect(() => {
		setCompactSummaryModalTarget((current) =>
			current?.narratorId === narratorId ? current : null,
		);
	}, [narratorId]);

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

	const openImageViewer = useImageViewer();
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

	const nugProviderInfo = useMemo(() => {
		if (!nugProviderConfig) return null;
		const quota = nugQuotasData?.[nugProviderConfig.id] ?? currentNugQuotaData;
		const rawDetailedQuotaBalance = quota?.detailedQuotaBalance;
		const detailedQuotaBalance = rawDetailedQuotaBalance?.trim() ? rawDetailedQuotaBalance : null;
		return {
			providerId: nugProviderConfig.id,
			providerPrefix: nugProviderConfig.prefix,
			name: nugProviderConfig.name ?? nugProviderConfig.prefix ?? nugProviderConfig.id,
			quotaBalance: quota?.balance == null ? null : String(quota.balance),
			totalGranted: quota?.totalGranted ?? null,
			detailedQuotaBalance,
		};
	}, [nugProviderConfig, nugQuotasData, currentNugQuotaData]);

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
		activePruneStart,
		activeCompactStart,
		prunedPercent,
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
	const nugBalanceNumber =
		nugProviderInfo?.providerId && quotaBalance != null ? Number(quotaBalance) : Number.NaN;
	const shouldShowNugRechargeButton = Boolean(
		nugProviderInfo?.providerId &&
			(paymentRequired || !Number.isFinite(nugBalanceNumber) || nugBalanceNumber <= 0),
	);
	const shouldShowNugRechargeInQuotaDetails = Boolean(
		nugProviderInfo?.providerId && Number.isFinite(nugBalanceNumber) && nugBalanceNumber > 0,
	);
	const quotaDetailsText = detailedQuotaBalance?.trim() ? detailedQuotaBalance : null;
	const hasQuotaDetailsPopover = Boolean(quotaDetailsText || shouldShowNugRechargeInQuotaDetails);

	useEffect(() => {
		if (paymentRequired) return;
		if (!narratorSubstatus.includes("payment_required")) return;
		const persisted = parsePersistedPaymentRequired(narrator?.errorMessage);
		const providerId = nugProviderInfo?.providerId ?? persisted?.providerId;
		if (!providerId) return;
		setPaymentRequired({
			providerId,
			providerPrefix: nugProviderInfo?.providerPrefix ?? persisted?.providerPrefix,
			balance: persisted?.balance,
			required: persisted?.required,
			resumeAction: persisted?.resumeAction ?? "retry",
		});
	}, [
		narrator?.errorMessage,
		narratorSubstatus,
		nugProviderInfo?.providerId,
		nugProviderInfo?.providerPrefix,
		paymentRequired,
		setPaymentRequired,
	]);

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
		[narratorId, handleCompactError],
	);

	const [archiveConfirmOpened, { open: openArchiveConfirm, close: closeArchiveConfirm }] =
		useDisclosure(false);
	const [nugRechargeOpened, { open: openNugRecharge, close: closeNugRecharge }] =
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
	useEffect(() => {
		if (paymentRequired) openNugRecharge();
	}, [openNugRecharge, paymentRequired]);
	const [
		contextThresholdSettingsOpened,
		{ open: openContextThresholdSettingsModal, close: closeContextThresholdSettings },
	] = useDisclosure(false);

	const [fastModeSettingsOpened, setFastModeSettingsOpened] = useState(false);
	const fastModeSettingsCloseTimerRef = useRef<number | null>(null);
	const fastModeLongPressTimerRef = useRef<number | null>(null);
	const fastModeLongPressFiredRef = useRef(false);

	const clearFastModeSettingsCloseTimer = useCallback(() => {
		if (fastModeSettingsCloseTimerRef.current != null) {
			window.clearTimeout(fastModeSettingsCloseTimerRef.current);
			fastModeSettingsCloseTimerRef.current = null;
		}
	}, []);

	const clearFastModeLongPressTimer = useCallback(() => {
		if (fastModeLongPressTimerRef.current != null) {
			window.clearTimeout(fastModeLongPressTimerRef.current);
			fastModeLongPressTimerRef.current = null;
		}
	}, []);

	const openFastModeSettings = useCallback(() => {
		clearFastModeSettingsCloseTimer();
		setFastModeSettingsOpened(true);
	}, [clearFastModeSettingsCloseTimer]);

	const closeFastModeSettings = useCallback(() => {
		clearFastModeSettingsCloseTimer();
		setFastModeSettingsOpened(false);
	}, [clearFastModeSettingsCloseTimer]);

	const scheduleFastModeSettingsClose = useCallback(() => {
		if (fastModeUsesTapSettings) return;
		clearFastModeSettingsCloseTimer();
		fastModeSettingsCloseTimerRef.current = window.setTimeout(() => {
			setFastModeSettingsOpened(false);
			fastModeSettingsCloseTimerRef.current = null;
		}, 180);
	}, [clearFastModeSettingsCloseTimer, fastModeUsesTapSettings]);

	const startFastModeLongPress = useCallback(
		(event: React.PointerEvent) => {
			fastModeLongPressFiredRef.current = false;
			if (!fastModeUsesTapSettings || event.pointerType === "mouse") return;
			clearFastModeLongPressTimer();
			fastModeLongPressTimerRef.current = window.setTimeout(() => {
				fastModeLongPressFiredRef.current = true;
				fastModeLongPressTimerRef.current = null;
				openFastModeSettings();
			}, 550);
		},
		[clearFastModeLongPressTimer, fastModeUsesTapSettings, openFastModeSettings],
	);

	useEffect(() => {
		return () => {
			clearFastModeSettingsCloseTimer();
			clearFastModeLongPressTimer();
		};
	}, [clearFastModeLongPressTimer, clearFastModeSettingsCloseTimer]);

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
	const planReflectionAutoApproveOverride = normalizeBooleanOverride(
		narrator?.planReflectionAutoApproveOverride,
	);
	const dangerReflectionOverride = normalizeDangerReflectionOverride(
		narrator?.dangerReflectionOverride,
	);
	const planReflectionAutoApproveEffective = resolveBooleanOverride(
		planReflectionAutoApproveOverride,
		planReflectionAutoApproveGlobal,
	);
	const dangerReflectionEffectiveLevel = resolveDangerReflectionLevel(
		dangerReflectionOverride,
		dangerReflectionGlobalLevel,
	);
	const togglePlanMode = useCallback(() => {
		if (!narratorId || !planModeSupported) return;
		if (hasPlanTrait) {
			exitPlanModeMutation.mutate(narratorId);
		} else {
			enterPlanModeMutation.mutate(narratorId);
		}
	}, [enterPlanModeMutation, exitPlanModeMutation, hasPlanTrait, narratorId, planModeSupported]);
	const handlePlanReflectionAutoApproveOverride = useCallback(
		(value: BooleanOverride) => {
			if (!planReflectionSupported) return;
			reflectionOverridesMutation.mutate({
				id: narratorId,
				planReflectionAutoApproveOverride: value,
			});
		},
		[narratorId, planReflectionSupported, reflectionOverridesMutation],
	);
	const handleFollowDefaultPlanReflection = useCallback(() => {
		handlePlanReflectionAutoApproveOverride("inherit");
	}, [handlePlanReflectionAutoApproveOverride]);
	const handleSetPlanReflectionAsDefault = useCallback(() => {
		if (!settingsData || !planReflectionSupported) return;
		updateSettingsMutation.mutate({
			agent: { planReflectionAutoApprove: planReflectionAutoApproveEffective },
		});
		reflectionOverridesMutation.mutate({
			id: narratorId,
			planReflectionAutoApproveOverride: "inherit",
		});
	}, [
		narratorId,
		planReflectionAutoApproveEffective,
		planReflectionSupported,
		reflectionOverridesMutation,
		settingsData,
		updateSettingsMutation,
	]);
	const handleDangerReflectionOverride = useCallback(
		async (value: DangerReflectionOverride) => {
			if (!dangerReflectionSupported) return;
			const nextLevel = resolveDangerReflectionLevel(value, dangerReflectionGlobalLevel);
			if (nextLevel === "off" && dangerReflectionEffectiveLevel !== "off") {
				const ok = await confirm({ message: t("dangerReflectionDisableWarning") });
				if (!ok) return;
			}
			reflectionOverridesMutation.mutate({ id: narratorId, dangerReflectionOverride: value });
		},
		[
			confirm,
			dangerReflectionEffectiveLevel,
			dangerReflectionGlobalLevel,
			dangerReflectionSupported,
			narratorId,
			reflectionOverridesMutation,
			t,
		],
	);
	const handleFollowDefaultDangerReflection = useCallback(() => {
		handleDangerReflectionOverride("inherit");
	}, [handleDangerReflectionOverride]);
	const handleSetDangerReflectionAsDefault = useCallback(async () => {
		if (!settingsData || !dangerReflectionSupported) return;
		if (dangerReflectionEffectiveLevel === "off" && dangerReflectionGlobal) {
			const ok = await confirm({ message: t("dangerReflectionDisableWarning") });
			if (!ok) return;
		}
		updateSettingsMutation.mutate({
			agent: {
				dangerReflectionLevel: dangerReflectionEffectiveLevel,
				dangerReflectionEnabled: dangerReflectionEffectiveLevel !== "off",
			},
		});
		reflectionOverridesMutation.mutate({ id: narratorId, dangerReflectionOverride: "inherit" });
	}, [
		confirm,
		dangerReflectionEffectiveLevel,
		dangerReflectionGlobal,
		dangerReflectionSupported,
		narratorId,
		reflectionOverridesMutation,
		settingsData,
		t,
		updateSettingsMutation,
	]);
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
						autoCompactPruneThreshold: normalized.autoCompactPruneThreshold,
						minPruneRatio: normalized.minPruneRatio,
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

	// True when the composer carries nothing to send and there's a non-question pending
	// permission. Used to show Enter-key hints on permission buttons via PermEnterHintCtx.
	// A staged attachment keeps Enter bound to sending it rather than silently approving
	// the permission.
	const permHintActive =
		!composerSendable &&
		!!renderPermCb.pendingPermission &&
		renderPermCb.pendingPermission.toolName !== "AskUserQuestion";

	// Index-based keyboard navigation for permission buttons.
	// focusIndex tracks which button is highlighted; left/right arrows shift it.
	const [permFocusIndex, setPermFocusIndex] = useState<number | null>(null);
	const [permButtonCount, setPermButtonCount] = useState(0);
	const [permHasFeedback, setPermHasFeedback] = useState(false);

	// Reset when permission changes
	const prevPermIdRef = useRef<string | null>(null);
	const currentPermId = renderPermCb.pendingPermission?.id ?? null;
	if (prevPermIdRef.current !== currentPermId) {
		prevPermIdRef.current = currentPermId;
		if (permFocusIndex !== null) setPermFocusIndex(null);
		if (permHasFeedback) setPermHasFeedback(false);
	}

	const handlePermFeedbackChange = useCallback((has: boolean) => {
		setPermHasFeedback(has);
		// When feedback changes, reset manual override so default kicks in
		setPermFocusIndex(null);
	}, []);

	const handlePermSetButtonCount = useCallback((n: number) => {
		setPermButtonCount(n);
	}, []);

	// Ref holding the onClick handlers for each permission button, registered by the child.
	const permActionsRef = useRef<(() => void)[]>([]);
	const handlePermRegisterActions = useCallback((actions: (() => void)[]) => {
		permActionsRef.current = actions;
	}, []);

	// Effective focus index: when no manual override, default to 0 (first button = Allow)
	// or last button (Deny) when feedback is present.
	const effectiveFocusIndex = permHintActive
		? (permFocusIndex ?? (permHasFeedback ? permButtonCount - 1 : 0))
		: null;

	const permEnterHintCtxValue = useMemo(
		() => ({
			focusIndex: effectiveFocusIndex,
			setFocusIndex: setPermFocusIndex,
			setButtonCount: handlePermSetButtonCount,
			setHasFeedback: handlePermFeedbackChange,
			registerActions: handlePermRegisterActions,
			activePermissionId: renderPermCb.pendingPermission?.id ?? null,
		}),
		[
			effectiveFocusIndex,
			handlePermSetButtonCount,
			handlePermFeedbackChange,
			handlePermRegisterActions,
			renderPermCb.pendingPermission?.id,
		],
	);

	// --- Image management ---
	const [imagePreviewUrls, setImagePreviewUrls] = useState<string[]>([]);
	useEffect(() => {
		const urls = attachedImages.map((file) => URL.createObjectURL(file));
		setImagePreviewUrls(urls);
		return () => {
			for (const url of urls) URL.revokeObjectURL(url);
		};
	}, [attachedImages]);

	// --- Title editing ---
	const {
		editingTitle,
		titleValue,
		setTitleValue,
		generatingTitle,
		titleInputRef,
		startEditingTitle,
		saveTitle,
		handleGenerateTitle,
		handleTitleKeyDown,
	} = useTitleEditing({ narratorId, narrator, t });
	const fileInputRef = useRef<HTMLInputElement>(null);
	// Visible send/upload feedback. `progress` is 0..1 while attachments upload,
	// or null once the request body is sent and we're awaiting the server.
	// `canCancel` gates the cancel button — only meaningful while the upload is
	// still in flight (an AbortController is armed) and not yet handed to the server.
	const [sendingState, setSendingState] = useState<{
		attachmentCount: number;
		progress: number | null;
		canCancel: boolean;
	} | null>(null);
	const isSending = sendingState !== null;
	// AbortController for the in-flight send request; used by the cancel button.
	const sendAbortRef = useRef<AbortController | null>(null);
	// Throttle progress updates to whole-percent changes to avoid re-render storms.
	const lastProgressPercentRef = useRef(-1);
	const reportUploadProgress = useCallback((fraction: number) => {
		const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
		if (percent === lastProgressPercentRef.current) return;
		lastProgressPercentRef.current = percent;
		setSendingState((prev) => (prev ? { ...prev, progress: fraction } : prev));
	}, []);
	const cancelSending = useCallback(() => {
		sendAbortRef.current?.abort();
	}, []);

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

	// --- Fork handler ---
	// Standalone narrators: fork narrator directly (no git involved)
	const handleStandaloneFork = useCallback(
		(messageId: string) => {
			forkNarratorMutation.mutate(
				{ narratorId, forkMessageId: messageId },
				{
					onSuccess: (newNarrator: { id: string }) => {
						navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarrator.id } });
					},
				},
			);
		},
		[narratorId, forkNarratorMutation.mutate, navigate],
	);
	// Chapter-bound: use onForkFromMessage (direct fork with auto-generated name)
	// Standalone: use handleStandaloneFork (direct narrator fork)
	const forkHandler = useMemo(
		() => (narrator?.chapterId ? onForkFromMessage : handleStandaloneFork),
		[narrator?.chapterId, onForkFromMessage, handleStandaloneFork],
	);

	// --- Ask in passing handler ---
	const startAskInPassingMutation = useStartAskInPassing();
	const startAskInPassingMutationRef = useRef(startAskInPassingMutation);
	startAskInPassingMutationRef.current = startAskInPassingMutation;
	const handleAskInPassing = useCallback(
		(messageUuid: string | null, messageId: string) => {
			startAskInPassingMutationRef.current.mutate(
				{
					narratorId,
					sourceMessageId: messageId,
					sourceMessageUuid: messageUuid ?? undefined,
				},
				{
					onError: (error: Error) => {
						notifications.show({
							message: error.message,
							color: "red",
							autoClose: 5000,
						});
					},
				},
			);
		},
		[narratorId],
	);
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

	const [internalFileViewerPath, setInternalFileViewerPath] = useState<string | null>(null);
	const [internalFileViewerTarget, setInternalFileViewerTarget] = useState<
		(FileTarget & { highlightRequestId: string }) | null
	>(null);
	const [localFileSelection, setLocalFileSelection] = useState<FileReferenceEditorSelection | null>(
		null,
	);
	const fileNavigationRef = useRef(0);
	const fileNavigationAbortRef = useRef<AbortController | null>(null);
	const dockOpenFilePanel = useFilePanelNavigation();
	const useInternalFileViewer = !dockOpenFilePanel && !isWorkspacePreview;
	const handleOpenFilePanel = useMemo(() => {
		if (dockOpenFilePanel) return (filePath: string) => dockOpenFilePanel(filePath);
		if (useInternalFileViewer)
			return (filePath: string) => {
				setInternalFileViewerTarget(null);
				setInternalFileViewerPath(filePath);
			};
		return undefined;
	}, [dockOpenFilePanel, useInternalFileViewer]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: cancel navigation when the owning narrator changes
	useEffect(
		() => () => {
			fileNavigationRef.current++;
			fileNavigationAbortRef.current?.abort();
		},
		[narratorId],
	);
	const handleOpenReferencedFile = useCallback(
		async (target: FileTarget) => {
			const request = ++fileNavigationRef.current;
			fileNavigationAbortRef.current?.abort();
			const controller = new AbortController();
			fileNavigationAbortRef.current = controller;
			try {
				const { targets } = await fileReferenceApi.resolve(narratorId, [target], controller.signal);
				if (request !== fileNavigationRef.current || !targets[0]) return;
				const resolved = targets[0];
				const highlightRequestId = nextHighlightRequestId();
				if (dockOpenFilePanel) {
					dockOpenFilePanel(resolved.path, undefined, {
						fileNarratorId: narratorId,
						deviceId: resolved.deviceId,
						selection: resolved.selection,
						highlightRequestId,
						referenceOrigin: true,
					});
				} else if (useInternalFileViewer) {
					setInternalFileViewerTarget({ ...resolved, highlightRequestId });
					setInternalFileViewerPath(resolved.path);
				}
			} catch (error) {
				if (request === fileNavigationRef.current)
					notifications.show({
						color: "red",
						title: t("fileReferences.openFailed"),
						message: error instanceof Error ? error.message : String(error),
					});
			}
		},
		[narratorId, dockOpenFilePanel, useInternalFileViewer, t],
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
			openFile:
				!isWorkspacePreview && (dockOpenFilePanel || useInternalFileViewer)
					? handleOpenReferencedFile
					: undefined,
			addReference: addFileReference,
			selection: dock?.fileReferenceSelection ?? localFileSelection,
			setSelection: dock?.setFileReferenceSelection ?? setLocalFileSelection,
		}),
		[
			narratorId,
			fileReferenceContext,
			isWorkspacePreview,
			dockOpenFilePanel,
			useInternalFileViewer,
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
	const pruneDividerLabel = t("pruneBoundaryLabel");
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

	const applyBufferedSendResult = useCallback(
		(
			result: BufferedSendResult | null | undefined,
			text: string,
			imageCount: number,
			priority?: boolean,
			fileReferences?: FileReference[],
		) => {
			if (!result?.buffered || !result.id) return false;

			const queuedMessage: BufferMessageSummary = {
				id: result.id,
				text,
				bufferedAt: result.bufferedAt ?? new Date().toISOString(),
				imageCount,
				fileReferences,
				creator:
					currentUser?.id && currentUser?.username
						? {
								id: String(currentUser.id),
								username: String(currentUser.username),
								avatarColor: currentUser.avatarColor ?? null,
								avatarImageId: currentUser.avatarImageId ?? null,
							}
						: null,
				priority: priority || undefined,
			};

			setQueuedMessages((prev) => {
				if (prev.some((m) => m.id === queuedMessage.id)) return prev;
				return priority ? [queuedMessage, ...prev] : [...prev, queuedMessage];
			});

			// A busy `/goal` is queued rather than applied immediately; tell the user
			// the protected task will be added once the queued command is consumed.
			if (result.specGoalQueued) {
				notifications.show({
					title: t("spec.specGoalQueued"),
					message: result.objective ?? undefined,
					color: "blue",
					autoClose: 4000,
				});
			}

			// Reconcile with the authoritative queue, but guarded: if the narrator
			// consumed this (priority) message and broadcast buffer_consumed while the
			// GET was in flight, the epoch guard drops the stale pre-consume snapshot
			// so the message doesn't reappear in the "pending" area.
			reconcileBufferedMessages();

			return true;
		},
		[currentUser, setQueuedMessages, reconcileBufferedMessages, t],
	);

	// --- Send / retry message ---
	/**
	 * Send as a new turn on an idle narrator.
	 *
	 * `priority` is not about queue ordering here — an idle narrator has no turn to
	 * cut in front of. It is the explicit "do not wait for the running compaction"
	 * opt-out: the server queues an idle-but-compacting narrator's messages by
	 * default, and this flag makes it start the turn immediately instead. On a
	 * narrator that is neither busy nor compacting it changes nothing.
	 */
	const submitMessage = async (
		msg: string,
		images: File[] = [],
		textFiles: File[] = [],
		signal?: AbortSignal,
		priority?: boolean,
		fileReferences: FileReference[] = [],
	) => {
		const optimisticBlocks: ContentBlock[] = [
			...fileReferences.map((reference) => ({ type: "file_reference", reference })),
			...images.map((f) => ({
				type: "image",
				filename: f.name,
				mediaType: f.type,
				previewUrl: URL.createObjectURL(f),
			})),
			...textFiles.map((f) => ({
				type: "text_file",
				filename: f.name,
				size: f.size,
			})),
			{ type: "text", text: msg },
		];
		scrollToBottom(true);
		try {
			const result = await api.sendNarratorMessage(
				narratorId,
				msg,
				images.length > 0 ? images : undefined,
				textFiles.length > 0 ? textFiles : undefined,
				priority,
				reportUploadProgress,
				signal,
				fileReferences,
			);
			// Handle /load tool response — not a real message, just a tool load confirmation
			if (result?.loaded) {
				const toolName = result.toolName ?? "tool";
				notifications.show({
					title: result.alreadyLoaded ? t("toolAlreadyLoaded") : t("toolLoaded"),
					message: toolName,
					color: result.alreadyLoaded ? "yellow" : "green",
				});
			} else if (result?.type === "bash" && result?.id) {
				// /bash command — WS broadcasts will provide real messages
				scrollToBottom(true);
			} else if (result?.specGoal) {
				// /goal added a protected task; the real user message arrives via WS.
				notifications.show({
					title: result.added ? t("spec.specGoalAdded") : t("spec.specGoalExists"),
					message: result.objective ?? undefined,
					color: result.added ? "green" : "yellow",
					autoClose: 4000,
				});
				// /goal now launches a Spec continuation. Mirror normal sends' optimistic
				// working state so a missed early WS frame cannot make the loop look idle.
				if (result.started) {
					qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
						old && old.status !== "working"
							? { ...old, status: "working", turnStartedAt: new Date().toISOString() }
							: old,
					);
					setTimeout(() => narratorWSManager.checkSync(narratorId), 500);
				}
				scrollToBottom(true);
			} else if (result?.buffered) {
				// Message was buffered — show it in the queue immediately.
				// The WS buffer_set event can be missed when the subscription is not
				// fully caught up, so also reconcile with REST.
				applyBufferedSendResult(result, msg, images.length, priority, fileReferences);
				scrollToBottom(true);
			} else if (result?.id) {
				// Normal message — set narrator status to "working" optimistically.
				// This guards against the race where the WS subscribe message hasn't
				// been processed by the server yet when the backend broadcasts the
				// status_change event.
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old && old.status !== "working"
						? { ...old, status: "working", turnStartedAt: new Date().toISOString() }
						: old,
				);
				// Safety net: trigger a sync_check shortly after sending so that
				// even if the WS subscription was delayed, we catch up on any
				// missed events from the server.
				setTimeout(() => narratorWSManager.checkSync(narratorId), 500);
			}
		} catch (err) {
			// The request may have reached the server even when the response was lost.
			// Never force the narrator back to idle; reconcile from the authoritative session.
			void narratorWSManager.checkSync(narratorId);
			throw err;
		} finally {
			revokeContentBlockPreviewUrls(optimisticBlocks);
		}
	};

	/** Shared logic for sending a buffered message (normal or priority). */
	const doSendBuffered = async (
		msg: string,
		priority?: boolean,
		signal?: AbortSignal,
		references?: FileReference[],
	): Promise<boolean> => {
		const draft = trimFileReferenceInput({
			text: composerRef.current?.getText() ?? "",
			fileReferences: composerRef.current?.getFileReferences() ?? [],
		});
		const fileReferences = references ?? (draft.text === msg ? draft.fileReferences : []);
		const images = [...attachedImages];
		const textFiles = [...attachedTextFiles];
		composerRef.current?.hideTextForSend();
		hideAttachedFilesForSend();
		try {
			const result = await api.sendNarratorMessage(
				narratorId,
				msg,
				images.length > 0 ? images : undefined,
				textFiles.length > 0 ? textFiles : undefined,
				priority,
				reportUploadProgress,
				signal,
				fileReferences,
			);
			const buffered = applyBufferedSendResult(
				result,
				msg,
				images.length,
				priority,
				fileReferences,
			);
			composerRef.current?.commitDraftAfterSend();
			clearAttachedFilesAndDraft();
			// Whether the message was buffered (202) or the backend fell through
			// to a direct send (201), scroll so the new content is visible.
			scrollToBottom(true);
			return buffered;
		} catch (err) {
			// Restore text and its independently tracked file references together.
			composerRef.current?.restoreInput(msg, fileReferences);
			if (images.length > 0) updateAttachedImages(images);
			if (textFiles.length > 0) updateAttachedTextFiles(textFiles);
			throw err; // Re-throw to let caller handle
		}
	};

	/**
	 * Latest `doSendBuffered`, for callers registered once with the dock bridge.
	 *
	 * `doSendBuffered` is redefined every render (it closes over the live
	 * attachments), so a bridge that captured it directly would keep calling a
	 * stale closure with stale attachment state.
	 */
	const doSendBufferedRef = useRef(doSendBuffered);
	doSendBufferedRef.current = doSendBuffered;

	/**
	 * Core send handler. When the narrator is active, `mode` selects the queue
	 * behavior:
	 *   - "turn": normal queue — wait for the current turn to finish
	 *   - "tool": priority queue — cut in after the current tool call completes
	 *   - "interrupt": priority queue + immediate interrupt (auto-resume consumes it)
	 *
	 * An idle narrator that is COMPACTING is a third state, not a busy one: there is
	 * no turn to cut into, but starting one now would race the summary that is about
	 * to replace the history. The server queues it by default and consumes the queue
	 * when the compact settles, so the only meaningful choice is wait-or-not — which
	 * is what the compact queue modes (see SendOptionsSplitButton) offer. `mode` maps
	 * onto it as "turn" = wait, anything else = run now (`priority` opts out of the
	 * server-side queue).
	 *
	 * When the narrator is fully idle, `mode` is ignored and the message is sent
	 * directly (an idle session is never interrupted). `/new` while active always
	 * uses the normal queue regardless of mode — spawning a new narrator should
	 * not interrupt the current turn.
	 */
	const handleSendWithMode = async (mode: "turn" | "tool" | "interrupt") => {
		const composerText = composerRef.current?.getText() ?? "";
		const { text: msg, fileReferences } = trimFileReferenceInput({
			text: composerText,
			fileReferences: composerRef.current?.getFileReferences() ?? [],
		});
		const attachmentCount =
			attachedImages.length + attachedTextFiles.length + fileReferences.length;
		// An attachment-only message is a valid turn: images (and text files) carry the
		// content by themselves, so an empty textarea must not block the send.
		if (
			!hasSendableComposerContent({
				text: composerText,
				imageCount: attachedImages.length,
				textFileCount: attachedTextFiles.length,
				fileReferenceCount: fileReferences.length,
			}) ||
			sendingRef.current
		)
			return;
		sendingRef.current = true;
		lastProgressPercentRef.current = -1;
		const abortController = new AbortController();
		sendAbortRef.current = abortController;
		// Only offer cancellation when there's an upload worth aborting.
		setSendingState({
			attachmentCount,
			progress: attachmentCount > 0 ? 0 : null,
			canCancel: attachmentCount > 0,
		});
		let restoreOnError: {
			msg: string;
			images: File[];
			textFiles: File[];
			fileReferences: FileReference[];
		} | null = null;
		try {
			composerRef.current?.noteSent(msg, fileReferences);

			const newMatch = msg.match(/^\/new(?:\s+([\s\S]*))?$/);
			if (newMatch) {
				if (fileReferences.length) throw new Error(t("fileReferences.newSessionFirst"));
				if (isActive) {
					// /new while active: always normal queue (never interrupt to spawn).
					await doSendBuffered(msg);
					return;
				}

				const initialMessage = newMatch[1]?.trim() ?? "";
				const images = [...attachedImages];
				const textFiles = [...attachedTextFiles];
				restoreOnError = { msg, images, textFiles, fileReferences };
				composerRef.current?.hideTextForSend();
				hideAttachedFilesForSend();

				const currentCwd =
					fetchedNarrator?.cwd ?? narrator?.cwd ?? chapterWorktreePath ?? undefined;
				const newNarrator = await createNarratorMutation.mutateAsync({
					chapterId: null,
					model: fetchedNarrator?.model ?? narrator?.model ?? undefined,
					systemPrompt: fetchedNarrator?.systemPrompt ?? narrator?.systemPrompt ?? undefined,
					permissionMode: fetchedNarrator?.permissionMode ?? narrator?.permissionMode ?? undefined,
					reasoningEffort:
						fetchedNarrator?.reasoningEffort ?? narrator?.reasoningEffort ?? undefined,
					fastModeOverride: normalizeBooleanOverride(
						fetchedNarrator?.fastModeOverride ?? narrator?.fastModeOverride,
					),
					relaxedPlan: fetchedNarrator?.relaxedPlan ?? narrator?.relaxedPlan ?? undefined,
					planReflectionAutoApproveOverride: normalizeBooleanOverride(
						fetchedNarrator?.planReflectionAutoApproveOverride ??
							narrator?.planReflectionAutoApproveOverride,
					),
					dangerReflectionOverride: normalizeDangerReflectionOverride(
						fetchedNarrator?.dangerReflectionOverride ?? narrator?.dangerReflectionOverride,
					),
					cwd: currentCwd,
				});

				if (initialMessage) {
					await api.sendNarratorMessage(
						newNarrator.id,
						initialMessage,
						images.length > 0 ? images : undefined,
						textFiles.length > 0 ? textFiles : undefined,
						undefined,
						reportUploadProgress,
						abortController.signal,
					);
				}

				composerRef.current?.commitDraftAfterSend();
				clearAttachedFilesAndDraft();
				restoreOnError = null;
				navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarrator.id } });
				return;
			}

			if (isActive) {
				// A subagent that is still controlled by its parent must receive user input
				// at the next safe post-tool boundary. Never wait for its whole task turn,
				// and never use the generic interrupt route (which hard-stops subagents).
				if (isSubagent && !isTakenOver) {
					await doSendBuffered(msg, true, abortController.signal);
					return;
				}
				// A taken-over subagent queues without a soft stop, so the "interrupt"
				// mode's follow-up interrupt has nothing to hand over — and the generic
				// interrupt route hard-stops subagents, which would end the takeover.
				// Queue plainly; the runner drains the message when the turn suspends.
				if (isSubagent) {
					await doSendBuffered(msg, mode !== "turn", abortController.signal);
					return;
				}
				if (mode === "turn") {
					await doSendBuffered(msg, false, abortController.signal);
				} else if (mode === "tool") {
					await doSendBuffered(msg, true, abortController.signal);
				} else {
					// "interrupt": insert at the front (await success), then interrupt so
					// the loop's auto-resume immediately consumes the queued message.
					// Only interrupt when the message was actually buffered — if the
					// backend fell through to a direct send (narrator went idle between
					// the status check and this request), interrupting would abort the
					// message we just sent.
					const buffered = await doSendBuffered(msg, true, abortController.signal);
					if (buffered) interruptMutation.mutate(narratorId);
				}
				return;
			}
			// Idle but compacting: the server decides queue-or-send, so this only has to
			// carry the user's intent. "turn" (wait) leaves `priority` off and lets the
			// server queue it; any other mode sets `priority` to run now. The response
			// tells us which happened — a 202 lands in the queued-messages area, a 201
			// starts a turn — so both outcomes are handled by `submitMessage` already.
			if (showCompactQueueChoice) {
				const images = [...attachedImages];
				const textFiles = [...attachedTextFiles];
				restoreOnError = { msg, images, textFiles, fileReferences };
				composerRef.current?.hideTextForSend();
				hideAttachedFilesForSend();
				await submitMessage(
					msg,
					images,
					textFiles,
					abortController.signal,
					mode !== "turn",
					fileReferences,
				);
				composerRef.current?.commitDraftAfterSend();
				clearAttachedFilesAndDraft();
				restoreOnError = null;
				return;
			}
			const images = [...attachedImages];
			const textFiles = [...attachedTextFiles];
			// Remember the draft so a cancelled upload can restore it — submitMessage
			// clears the input/attachments up-front for the optimistic bubble.
			restoreOnError = { msg, images, textFiles, fileReferences };
			composerRef.current?.hideTextForSend();
			hideAttachedFilesForSend();
			await submitMessage(
				msg,
				images,
				textFiles,
				abortController.signal,
				undefined,
				fileReferences,
			);
			composerRef.current?.commitDraftAfterSend();
			clearAttachedFilesAndDraft();
			restoreOnError = null;
		} catch (err) {
			// Restore the drafted input/attachments so the user doesn't lose their
			// message. `doSendBuffered` already restores internally on its own throw;
			// this covers the `/new` and idle direct-send paths.
			if (restoreOnError) {
				composerRef.current?.restoreInput(restoreOnError.msg, restoreOnError.fileReferences);
				if (restoreOnError.images.length > 0) updateAttachedImages(restoreOnError.images);
				if (restoreOnError.textFiles.length > 0) updateAttachedTextFiles(restoreOnError.textFiles);
			}
			// A user-initiated cancel is not a failure — show a gentle notice, not an error.
			if (isAbortError(err)) {
				notifications.show({ message: t("sendCancelled"), color: "gray", autoClose: 2000 });
				return;
			}
			notifications.show({
				title: t("sendFailed"),
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			sendingRef.current = false;
			sendAbortRef.current = null;
			setSendingState(null);
		}
	};

	/**
	 * Default send action for the main send/queue button click.
	 * Follows the queue behavior bound to the Enter key (`enterQueueMode`).
	 */
	const handleSend = async () => {
		await handleSendWithMode(userPrefs?.enterQueueMode ?? "turn");
	};
	const handleSendRef = useRef(handleSend);
	handleSendRef.current = handleSend;

	/**
	 * Submit externally-supplied text as a user message (the user-chat panel's
	 * "send to narrator").
	 *
	 * Routed through `doSendBuffered` — the composer's own send path — rather than
	 * calling the REST endpoint directly, so a forward that lands mid-turn is
	 * QUEUED exactly like anything typed here, and the draft / attachment
	 * bookkeeping stays consistent. The current draft is deliberately preserved:
	 * the forwarded text is its own message, not an edit of what the user was
	 * composing.
	 *
	 * ONE implementation shared by both hosts that offer forwarding: the dock
	 * bridge (`registerSubmitToNarrator`) and the mobile Drawer host's
	 * `onForwardToNarrator` prop. They must not diverge — a host that skipped the
	 * save/restore ritual below would send the user's in-progress draft and staged
	 * attachments out with the forwarded text, then commit an empty draft to the
	 * server.
	 */
	// attachedImagesRef/attachedTextFilesRef are stable RefObjects from
	// useComposerAttachments; their `.current` reads must not be deps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: stable refs from hook
	const forwardTextToNarrator = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			void (async () => {
				const preservedDraft = composerRef.current?.getText() ?? "";
				const preservedFileReferences = composerRef.current?.getFileReferences() ?? [];
				const preservedImages = attachedImagesRef.current;
				const preservedTextFiles = attachedTextFilesRef.current;
				try {
					// Forward-only send: no attachments, and the in-progress draft is put
					// back afterwards so the operator does not lose what they were typing.
					composerRef.current?.restoreInput(trimmed, []);
					updateAttachedImages([]);
					updateAttachedTextFiles([]);
					await doSendBufferedRef.current(trimmed, false);
				} catch (err) {
					notifications.show({
						color: "red",
						title: t("sendFailed", "Failed to send"),
						message: err instanceof Error ? err.message : "",
					});
				} finally {
					composerRef.current?.restoreInput(preservedDraft, preservedFileReferences);
					if (preservedImages.length > 0) updateAttachedImages(preservedImages);
					if (preservedTextFiles.length > 0) updateAttachedTextFiles(preservedTextFiles);
				}
			})();
		},
		[t, updateAttachedImages, updateAttachedTextFiles],
	);

	useEffect(() => {
		const register = dock?.registerSubmitToNarrator;
		if (!register) return;
		return register(forwardTextToNarrator);
	}, [dock, forwardTextToNarrator]);

	// The active queue button mirrors the keyboard shortcuts: a short press uses
	// Enter's mode, while a long press uses Ctrl/Cmd+Enter's mode.
	const handleSendWithModeRef = useRef(handleSendWithMode);
	handleSendWithModeRef.current = handleSendWithMode;
	// Stable entry points handed to <NarratorComposer>: it re-renders per
	// keystroke, so every prop must be referentially stable to keep its own
	// memoized children (popovers) from thrashing.
	const composerSendWithMode = useCallback((mode: "turn" | "tool" | "interrupt") => {
		void handleSendWithModeRef.current(mode);
	}, []);
	const ctrlEnterQueueModeRef = useRef(userPrefs?.ctrlEnterQueueMode ?? "tool");
	ctrlEnterQueueModeRef.current = userPrefs?.ctrlEnterQueueMode ?? "tool";

	const {
		queueHoldProgress,
		startQueueHold,
		cancelQueueHold,
		handleQueuePointerUp,
		handleQueueClick,
		handleCancelAllQueued,
		handleRemoveQueued,
		handleRetryQueued,
		handleDragEndQueued,
		editingQueuedId,
		queueExpanded,
		setQueueExpanded,
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	} = useQueuedMessageActions({
		narratorId,
		queuedMessages,
		setQueuedMessages,
		reconcileBufferedMessages,
		cancelBuffer,
		composerRef,
		handleSendRef,
		handleSendWithModeRef,
		ctrlEnterQueueModeRef,
		t,
	});

	const handleRetry = async () => {
		if (!canRetryLastUserMessage) return;
		try {
			await api.retryLastMessage(narratorId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to retry";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

	const handleContinue = async () => {
		if (!canContinueNarrator) return;
		try {
			await api.continueNarrator(narratorId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to continue";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

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

	const addImages = async (files: File[]) => {
		const valid = files.filter((f) => {
			if (!ACCEPTED_TYPES.includes(f.type)) return false;
			if (f.size > MAX_IMAGE_SIZE) return false;
			return true;
		});
		if (valid.length === 0) return;
		const processed: File[] = [];
		for (const f of valid) {
			// GIF: skip resize (may be animated)
			if (f.type === "image/gif") {
				processed.push(f);
				continue;
			}
			try {
				const resized = await resizeImageIfNeeded(f, MAX_IMAGE_LONG_EDGE);
				processed.push(resized);
			} catch {
				processed.push(f); // fallback to original on error
			}
		}
		updateAttachedImages((prev) => [...prev, ...processed]);
	};

	const addTextFiles = (files: File[]) => {
		const valid = files.filter((f) => {
			if (!isTextFile(f.name)) {
				notifications.show({
					title: t("unsupportedFileType"),
					message: f.name,
					color: "yellow",
				});
				return false;
			}
			if (f.size > MAX_TEXT_FILE_SIZE) {
				notifications.show({
					title: t("textFileTooLarge"),
					message: `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`,
					color: "yellow",
				});
				return false;
			}
			return true;
		});
		if (valid.length > 0) {
			updateAttachedTextFiles((prev) => [...prev, ...valid]);
		}
	};

	// Stable paste bridge for <NarratorComposer> (it re-renders per keystroke, so
	// every callback prop must hold its identity).
	const addImagesRef = useRef(addImages);
	addImagesRef.current = addImages;
	const handleComposerPasteImages = useCallback((files: File[]) => addImagesRef.current(files), []);

	const isFileDragEvent = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

	const handleDragEnter = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current++;
		setIsDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
		if (dragCounterRef.current === 0) {
			setIsDragging(false);
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
	};

	const handleDrop = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = 0;
		setIsDragging(false);
		const files = Array.from(e.dataTransfer.files);
		if (files.length === 0) return;
		const imageFiles: File[] = [];
		const textFileList: File[] = [];
		const unsupported: string[] = [];
		for (const f of files) {
			if (ACCEPTED_TYPES.includes(f.type)) {
				imageFiles.push(f);
			} else if (isTextFile(f.name)) {
				textFileList.push(f);
			} else {
				unsupported.push(f.name);
			}
		}
		if (unsupported.length > 0) {
			notifications.show({
				title: t("unsupportedFileType"),
				message: unsupported.join(", "),
				color: "yellow",
			});
		}
		if (imageFiles.length > 0) addImages(imageFiles);
		if (textFileList.length > 0) addTextFiles(textFileList);
	};

	// Global keyboard shortcuts for permission actions.
	// The textarea's onKeyDown only fires when the textarea has focus, but the user
	// may be looking at the permission UI without focusing the main input.
	// This effect listens at the window level so Enter/ArrowLeft/ArrowRight work
	// regardless of focus, as long as the permission hint is active.
	useEffect(() => {
		if (effectiveFocusIndex == null) return;
		const handler = (e: KeyboardEvent) => {
			// Don't intercept if user is typing in an input/textarea (other than the main one)
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			) {
				// Allow only if it's our main textarea AND it's empty. The composer
				// owns the text now; both checks read its live state through the handle.
				if (!composerRef.current?.ownsTextarea(target)) return;
				if (!composerRef.current.isTextEmpty()) return;
			}

			if (
				(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
				!e.shiftKey &&
				!e.ctrlKey &&
				!e.metaKey
			) {
				e.preventDefault();
				const count = permButtonCount;
				if (count <= 1) return;
				setPermFocusIndex((prev) => {
					const cur = prev ?? effectiveFocusIndex ?? 0;
					if (e.key === "ArrowLeft") return cur <= 0 ? count - 1 : cur - 1;
					return cur >= count - 1 ? 0 : cur + 1;
				});
				return;
			}

			if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
				const action = permActionsRef.current[effectiveFocusIndex];
				if (!action) return;
				e.preventDefault();
				action();
				setPermFocusIndex(null);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [effectiveFocusIndex, permButtonCount]);

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

	/**
	 * Which entries this narrator can actually offer right now, beyond what the
	 * host supports. Distinct from `hosts` in the registry: that answers "can this
	 * surface present the panel at all", this answers "does this narrator have the
	 * thing" (a chapter for git, spec support, a terminal route, remote devices).
	 */
	const toolbarEntryEnabled = useCallback(
		(id: NarratorToolbarId): boolean => {
			switch (id) {
				case "tasks":
					return tasksSupported && tasksButtonEnabled;
				case "spec":
					return specToolAvailable;
				case "terminal":
					// Same condition as `terminalActionAvailable` further down, inlined so
					// this hook does not depend on a value defined after the early return.
					return terminalToolAvailable || !!onOpenTerminalPanel;
				case "git":
					// The git panel needs a chapter; a standalone narrator has none.
					return !!chapterId;
				case "browser":
					return browserSessionsCapability.supported !== false;
				case "device":
					// Only meaningful with at least one remote device — otherwise "local"
					// is the only choice and the control is decoration.
					return (executionDevicesQuery.data?.devices.length ?? 0) > 0;
				case "plugins":
					return !!dock;
				default:
					return true;
			}
		},
		[
			tasksSupported,
			tasksButtonEnabled,
			specToolAvailable,
			terminalToolAvailable,
			onOpenTerminalPanel,
			chapterId,
			browserSessionsCapability.supported,
			executionDevicesQuery.data?.devices.length,
			dock,
		],
	);

	const {
		entries: toolbarEntries,
		visible: toolbarSurfacedDefs,
		overflow: toolbarTuckedDefs,
		saveLayout: saveToolbarLayout,
	} = useNarratorToolbarLayout({
		// Uncapped on purpose: the cap depends on how many entries are SURFACEABLE,
		// which is what this partition computes. Capping here would make the count
		// fed to the measurement depend on the measurement's own result.
		visibleLimit: null,
		hostCapabilities: headerHostCapabilities,
		// Per-narrator availability is applied INSIDE the partition (before the cap),
		// so a capped row back-fills past disabled entries instead of showing fewer
		// buttons than the cap allows.
		entryEnabled: toolbarEntryEnabled,
	});

	/**
	 * Width the title keeps before any entry collapses. Zero when the host draws
	 * the title itself (a graph node), so the entries may claim that space —
	 * previously the only way to stop the icon row from crushing the title was to
	 * hide the title entirely, which is what `hostOwnsTitle` was doing.
	 */
	const headerTitleSlotMinWidth = useMemo(() => {
		if (hostOwnsTitle || isWorkspacePreview) return 0;
		// Plus the pencil / sparkles pair beside the title (ActionIcon size="xs" =
		// 18px each, gap 4).
		return HEADER_TITLE_MIN_WIDTH_PX + 2 * 18 + 2 * 4;
	}, [hostOwnsTitle, isWorkspacePreview]);

	const headerCapacity = useNarratorHeaderToolbarCapacity({
		rowRef: headerRowRef,
		toolbarRef: headerToolbarRef,
		leadingRef: headerLeadingRef,
		titleSlotMinWidth: headerTitleSlotMinWidth,
		itemCount: toolbarSurfacedDefs.length,
		// The measurement may not save a phone from itself: at ~360px a readable
		// title plus two entries is the honest maximum, whatever the arithmetic says.
		maxCapacity: isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT : null,
		enabled: !isWorkspacePreview,
	});

	/**
	 * `null` capacity = no successful measurement yet (first frame, no
	 * ResizeObserver). Falling back to the mobile cap / "show everything" keeps the
	 * previous behaviour rather than briefly emptying the row.
	 */
	const headerVisibleLimit =
		headerCapacity ?? (isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT : null);
	const headerSelection = useMemo(
		() => selectHeaderToolbarEntries(toolbarSurfacedDefs, headerVisibleLimit),
		[toolbarSurfacedDefs, headerVisibleLimit],
	);
	const toolbarVisibleDefs = headerSelection.visible;
	/**
	 * Everything not on the row: entries collapsed for width, plus the ones the
	 * reader tucked away. Layout order is preserved so the menu reads as a
	 * continuation of the row. This is also what the overflow button's aggregate
	 * badge counts — without it, an entry collapsed for width would take its unread
	 * count off screen with no trace.
	 */
	const toolbarHiddenDefs = useMemo(
		() => [...headerSelection.hidden, ...toolbarTuckedDefs],
		[headerSelection.hidden, toolbarTuckedDefs],
	);
	/** Ids collapsed for width — the menu marks these so "shown in header" stays honest. */
	const toolbarNoRoomIds = useMemo(
		() => headerSelection.hidden.map((def) => def.id as string),
		[headerSelection.hidden],
	);

	/** Whether an entry's panel is currently open (drives the active styling). */
	const toolbarEntryActive = useCallback(
		(id: NarratorToolbarId): boolean => {
			switch (id) {
				case "tasks":
					return dock ? dock.openToolTypes.has("tasks") : mobileTasksOpen;
				case "filemod":
					return fileModDrawerOpened;
				case "details":
					return detailsOpened;
				case "terminal":
					return terminalToolOpened;
				case "spec":
					return specToolOpened;
				case "git":
					return dock?.openToolTypes.has("git") ?? false;
				case "search":
					return dock ? dock.openToolTypes.has("search") : mobileToolPanel === "search";
				case "browser":
					return dock ? dock.openToolTypes.has("browser") : mobileToolPanel === "browser";
				case "userchat":
					return dock ? dock.openToolTypes.has("userchat") : mobileToolPanel === "userchat";
				case "filetree":
					return dock?.openToolTypes.has("filetree") ?? false;
				default:
					return false;
			}
		},
		[
			dock,
			mobileTasksOpen,
			fileModDrawerOpened,
			detailsOpened,
			terminalToolOpened,
			specToolOpened,
			mobileToolPanel,
		],
	);

	/**
	 * Activate an entry, preferring the dock panel and falling back to a drawer.
	 *
	 * The fallback is the whole point: on mobile `dock` is null, so git / search /
	 * browser / discussion route into `MobileToolPanelHost` instead of silently
	 * doing nothing.
	 */
	const activateToolbarEntry = useCallback(
		(id: string) => {
			switch (id) {
				case "tasks":
					if (dock) dock.toggleToolPanel("tasks");
					else setMobileTasksOpen((v) => !v);
					return;
				case "filemod":
					setFileModDrawerOpened((v: boolean) => !v);
					return;
				case "details":
					toggleDetails();
					return;
				case "terminal":
					(onOpenTerminalPanel ?? toggleTerminalTool)();
					return;
				case "spec":
					toggleSpecTool();
					return;
				case "git":
				case "search":
				case "browser":
				case "userchat":
					if (dock) dock.toggleToolPanel(id);
					else setMobileToolPanel((current) => (current === id ? null : id));
					return;
				case "filetree":
					dock?.toggleToolPanel("filetree");
					return;
				// Dock-only (registry `hosts: ["dock"]`): the panel exists to sit beside the
				// transcript while a slider moves, so there is no drawer fallback to offer.
				case "appearance":
					dock?.toggleToolPanel("appearance");
					return;
				default:
					return;
			}
		},
		[
			dock,
			setFileModDrawerOpened,
			toggleDetails,
			onOpenTerminalPanel,
			toggleTerminalTool,
			toggleSpecTool,
		],
	);

	/**
	 * Options the overflow menu expands inline for a self-contained control.
	 *
	 * These three render their own Menu in the header, so there is nothing for
	 * `activateToolbarEntry` to toggle. Before this, the menu listed them as a dead
	 * row labelled "header only" — and on a phone the header keeps two icons while
	 * everything else lives in that menu, so the detail level and the execution
	 * device had NO reachable entry point at all. Returning the same option rows the
	 * header's dropdown uses keeps the two surfaces in step by construction.
	 *
	 * Every id whose registry entry is `selfContained` must be handled here; an
	 * unhandled one silently reverts to the informational row.
	 */
	const renderToolbarInlineOptions = useCallback(
		(id: string, close: () => void): ReactNode => {
			switch (id) {
				case "device":
					return (
						<ExecutionDeviceOptions
							label={t("executionDeviceSelector")}
							localLabel={t("executionTargetLocal")}
							offlineLabel={t("executionDeviceOffline")}
							devices={executionDevicesQuery.data?.devices ?? []}
							currentDeviceId={executionDevicesQuery.data?.defaultDeviceId ?? "local"}
							onSelect={(deviceId) => {
								close();
								updateExecutionDeviceMutation.mutate(deviceId);
							}}
							withLabel={false}
						/>
					);
				case "lodlevel":
					return (
						<NarratorLodOptions
							lod={renderLod}
							isDefault={renderLodIsDefault}
							onSelectLod={(next) => {
								close();
								handleSelectLod(next);
							}}
							onSetAsDefault={() => {
								close();
								setAsDefault();
							}}
							withLabel={false}
						/>
					);
				case "plugins":
					return (
						<PluginContributionOptions
							onPick={(pick) => {
								close();
								openPluginPanel(pick);
							}}
						/>
					);
				default:
					return null;
			}
		},
		[
			t,
			executionDevicesQuery.data,
			updateExecutionDeviceMutation,
			renderLod,
			renderLodIsDefault,
			handleSelectLod,
			setAsDefault,
			openPluginPanel,
		],
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

	const contextIndicator = (
		<ContextUsageIndicator
			narratorId={narratorId}
			contextPercent={contextPercent}
			contextStale={contextStale}
			isWorkspacePreview={isWorkspacePreview}
			activePruneStart={activePruneStart}
			activeCompactStart={activeCompactStart}
			modelThresholds={modelThresholds}
			forceCompactPruneThreshold={forceCompactPruneThreshold}
			prunedPercent={prunedPercent}
			promptTokens={promptTokens}
			contextWindow={contextWindow}
			isEstimated={isEstimated}
			pruneEnabledEffective={pruneEnabledEffective}
			pruneEnabledGlobal={pruneEnabledGlobal}
			pruneDiffersFromDefault={pruneDiffersFromDefault}
			onOpenThresholdSettings={handleOpenContextThresholdSettings}
			onCompactError={handleCompactError}
			pruneEnabledMutation={pruneEnabledMutation}
			updateSettingsMutation={updateSettingsMutation}
			t={t}
		/>
	);

	const renderFastModeControl = (position: "top-end" | "bottom-end") => (
		<FastModeControl
			position={position}
			fastModeOverride={fastModeOverride}
			fastModeDefault={fastModeDefault}
			fastModeEnabled={fastModeEnabled}
			fastModeUsesTapSettings={fastModeUsesTapSettings}
			settingsOpened={fastModeSettingsOpened}
			setSettingsOpened={setFastModeSettingsOpened}
			openSettings={openFastModeSettings}
			closeSettings={closeFastModeSettings}
			scheduleSettingsClose={scheduleFastModeSettingsClose}
			startLongPress={startFastModeLongPress}
			clearLongPressTimer={clearFastModeLongPressTimer}
			longPressFiredRef={fastModeLongPressFiredRef}
			narratorId={narratorId}
			fastModeMutation={fastModeMutation}
			updateUserPrefs={updateUserPrefs}
			t={t}
		/>
	);

	// The terminal entry's availability, label and action now live with the header
	// registry (`toolbarEntryEnabled` / `activateToolbarEntry`), which is also what
	// supplies its off-dock fallback.
	// This array is rebuilt every render (a hook is not an option below the
	// skeleton early-return above). NarratorStatusToolbar derives its
	// measurement identity from the action keys, not from array identity.
	const mobileToolbarActions: NarratorStatusToolbarAction[] = [
		{
			key: "path-rules",
			collapsePriority: 10,
			// Inline reserve only. A vertical reserve cannot protect this badge: it is
			// painted inside the ActionIcon, which clips its own overflow, so padding
			// on the wrapper would only push the button off the row's centre line.
			visualOverflow: { inlineEnd: 4 },
			render: (mode) => (
				<PathRulesPopover
					narratorId={narratorId}
					t={t}
					triggerMode={mode === "menu" ? "menu" : "icon"}
				/>
			),
		},
		...(hasPlanTrait
			? ([
					{
						key: "relaxed-plan",
						collapsePriority: 20,
						render: (mode: "inline" | "menu") =>
							mode === "menu" ? (
								<Menu.Item
									key="relaxed-plan"
									leftSection={
										relaxedPlanEnabled ? <IconLockOpen size={16} /> : <IconLock size={16} />
									}
									disabled={relaxedPlanForced || relaxedPlanMutation.isPending}
									onClick={() =>
										relaxedPlanMutation.mutate({
											id: narratorId,
											relaxedPlan: !relaxedPlanEnabled,
										})
									}
								>
									{t("relaxed_plan")}
								</Menu.Item>
							) : (
								<Tooltip
									label={
										relaxedPlanForced ? t("relaxed_plan_forced_tooltip") : t("relaxed_plan_tooltip")
									}
								>
									<ActionIcon
										variant="subtle"
										color={relaxedPlanEnabled ? "teal" : "gray"}
										size="sm"
										aria-label={t("relaxed_plan")}
										disabled={relaxedPlanForced || relaxedPlanMutation.isPending}
										onClick={() =>
											relaxedPlanMutation.mutate({
												id: narratorId,
												relaxedPlan: !relaxedPlanEnabled,
											})
										}
									>
										{relaxedPlanEnabled ? <IconLockOpen size={16} /> : <IconLock size={16} />}
									</ActionIcon>
								</Tooltip>
							),
					},
				] satisfies NarratorStatusToolbarAction[])
			: []),
		...(narrator.isAskInPassing
			? ([
					{
						key: "promote",
						collapsePriority: 30,
						render: (mode: "inline" | "menu") =>
							mode === "menu" ? (
								<Menu.Item
									key="promote"
									leftSection={<IconGitBranch size={16} />}
									disabled={promoteMutation.isPending}
									onClick={handlePromote}
								>
									{t("promote")}
								</Menu.Item>
							) : (
								<Tooltip
									label={
										narrator.chapterId ? t("promote_chapter_hint") : t("promote_standalone_hint")
									}
								>
									<Button
										size="compact-xs"
										variant="light"
										color="teal"
										loading={promoteMutation.isPending}
										onClick={handlePromote}
									>
										{t("promote")}
									</Button>
								</Tooltip>
							),
					},
				] satisfies NarratorStatusToolbarAction[])
			: []),
		/*
		 * The terminal entry deliberately does NOT appear here any more.
		 *
		 * It is a tool entry, so it belongs to the registry-driven header row
		 * (`narrator-toolbar-items.tsx`) together with git / search / browser / the
		 * rest. Keeping a copy here would put the same control in two places at once
		 * on mobile — the header AND this status row — which is precisely the split
		 * that made the old mobile layout confusing to navigate.
		 *
		 * What stays in this row is session CONFIGURATION (path rules, relaxed plan,
		 * promote), which modifies the state shown beside it rather than opening a
		 * panel.
		 */
	];
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
					onDragEnter={handleDragEnter}
					onDragLeave={handleDragLeave}
					onDragOver={handleDragOver}
					onDrop={handleDrop}
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
					{isDragging && (
						<Box
							style={{
								position: "absolute",
								inset: 0,
								zIndex: 100,
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								backgroundColor: "rgba(0, 0, 0, 0.5)",
								border: "2px dashed var(--mantine-color-indigo-5)",
								borderRadius: "var(--mantine-radius-md)",
								pointerEvents: "none",
							}}
						>
							<Stack align="center" gap="xs">
								<IconUpload size={40} color="var(--mantine-color-indigo-4)" />
								<Text size="lg" fw={500} c="white">
									{t("dropFilesHere")}
								</Text>
							</Stack>
						</Box>
					)}
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
							<Group
								{...{ [HEADER_TITLE_SLOT_ATTR]: "" }}
								gap={4}
								style={{ flex: 1, minWidth: 0 }}
								wrap="nowrap"
							>
								{hostOwnsTitle ? null : editingTitle && !isWorkspacePreview ? (
									<TextInput
										ref={titleInputRef}
										value={titleValue}
										onChange={(e) => setTitleValue(e.currentTarget.value)}
										onKeyDown={handleTitleKeyDown}
										onBlur={saveTitle}
										size="xs"
										style={{ flex: 1, maxWidth: 500 }}
									/>
								) : (
									<Text
										size="sm"
										fw={500}
										onDoubleClick={isWorkspacePreview ? undefined : startEditingTitle}
										style={{
											cursor: isWorkspacePreview ? "default" : "pointer",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											maxWidth: 500,
										}}
										title={displayTitle}
									>
										{displayTitle}
									</Text>
								)}
								{!isWorkspacePreview && !hostOwnsTitle && (
									<>
										<ActionIcon
											size="xs"
											variant="subtle"
											onClick={startEditingTitle}
											title={t("editTitle")}
										>
											<IconPencil size={12} />
										</ActionIcon>
										<ActionIcon
											size="xs"
											variant="subtle"
											onClick={handleGenerateTitle}
											loading={generatingTitle}
											title={t("generateTitle")}
										>
											<IconSparkles size={12} />
										</ActionIcon>
									</>
								)}
							</Group>
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
								toolbarVisibleDefs={toolbarVisibleDefs}
								toolbarBadgeCounts={toolbarBadgeCounts}
								toolbarEntries={toolbarEntries}
								toolbarHiddenDefs={toolbarHiddenDefs}
								toolbarNoRoomIds={toolbarNoRoomIds}
								headerHostCapabilities={headerHostCapabilities}
								toolbarEntryActive={toolbarEntryActive}
								activateToolbarEntry={activateToolbarEntry}
								saveToolbarLayout={saveToolbarLayout}
								renderToolbarInlineOptions={renderToolbarInlineOptions}
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
																pruneDividerLabel={pruneDividerLabel}
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
						attachedImages={attachedImages}
						attachedTextFiles={attachedTextFiles}
						imagePreviewUrls={imagePreviewUrls}
						updateAttachedImages={updateAttachedImages}
						updateAttachedTextFiles={updateAttachedTextFiles}
						formatFileSize={formatFileSize}
						openImageViewer={openImageViewer}
						sendingState={sendingState}
						cancelSending={cancelSending}
						queuedMessages={queuedMessages}
						queueExpanded={queueExpanded}
						setQueueExpanded={setQueueExpanded}
						editingQueuedId={editingQueuedId}
						handleDragEndQueued={handleDragEndQueued}
						handleSaveEditQueued={handleSaveEditQueued}
						handleCancelEditQueued={handleCancelEditQueued}
						handleStartEditQueued={handleStartEditQueued}
						handleRemoveQueued={handleRemoveQueued}
						handleRetryQueued={handleRetryQueued}
						handleCancelAllQueued={handleCancelAllQueued}
						chapterId={narrator.chapterId}
						onOpenGitPanel={
							isWorkspacePreview
								? undefined
								: dock
									? () => dock.openToolPanel("git")
									: () => setMobileToolPanel("git")
						}
						isWorkspacePreview={isWorkspacePreview}
						showHumanAttentionInbox={showHumanAttentionInbox}
						narratorId={narratorId}
						isChapterMerged={isChapterMerged}
						statusBar={{
							narratorId,
							narrator,
							ownsHorizontalSafeArea,
							borderTop:
								attachedImages.length > 0 || queuedMessages.length > 0
									? undefined
									: "1px solid var(--mantine-color-default-border)",
							isWorkspacePreview,
							compact,
							isMobileViewport,
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
							reasoning: {
								supported: supportsReasoningEffort,
								displayed: displayedReasoningEffort,
								options: reasoningEffortOptions,
								followsDefault: reasoningFollowsDefault,
								mutation: reasoningEffortMutation,
								onFollowDefault: handleFollowDefaultReasoning,
								onSetAsDefault: handleSetReasoningAsDefault,
							},
							permission: {
								availableModes: availablePermissionModes,
								unavailableReason: permissionModesUnavailableReason,
								mutation: permModeMutation,
								hasPlanTrait,
								togglePlanMode,
								planModePending: enterPlanModeMutation.isPending || exitPlanModeMutation.isPending,
								planModeSupported,
								planModeUnsupportedReason,
								planReflection: {
									supported: planReflectionSupported,
									override: planReflectionAutoApproveOverride,
									effective: planReflectionAutoApproveEffective,
									global: planReflectionAutoApproveGlobal,
									onChange: handlePlanReflectionAutoApproveOverride,
									onFollowDefault: handleFollowDefaultPlanReflection,
									onSetAsDefault: handleSetPlanReflectionAsDefault,
								},
								dangerReflection: {
									supported: dangerReflectionSupported,
									override: dangerReflectionOverride,
									effectiveLevel: dangerReflectionEffectiveLevel,
									globalLevel: dangerReflectionGlobalLevel,
									onChange: handleDangerReflectionOverride,
									onFollowDefault: handleFollowDefaultDangerReflection,
									onSetAsDefault: handleSetDangerReflectionAsDefault,
								},
								reflectionSettingsDisabled,
							},
							codexControls: {
								supportsCodexControls,
								isBuiltInCodexModel,
								renderFastModeControl,
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
						}}
						composerRowProps={{
							fileInputRef,
							composerRef,
							sendingRef,
							appendInputRef,
							interruptBtnRef,
							narratorId,
							isActive,
							composerHasText,
							composerHasAttachments,
							setComposerHasText,
							effectiveFocusIndex,
							enterQueueMode: userPrefs?.enterQueueMode ?? "turn",
							ctrlEnterQueueMode: userPrefs?.ctrlEnterQueueMode ?? "tool",
							onFileInputChange: (e) => {
								if (e.target.files) {
									const files = Array.from(e.target.files);
									const imageFiles: File[] = [];
									const textFileList: File[] = [];
									const unsupported: string[] = [];
									for (const f of files) {
										if (ACCEPTED_TYPES.includes(f.type)) {
											imageFiles.push(f);
										} else if (isTextFile(f.name)) {
											textFileList.push(f);
										} else {
											unsupported.push(f.name);
										}
									}
									if (unsupported.length > 0) {
										notifications.show({
											title: t("unsupportedFileType"),
											message: unsupported.join(", "),
											color: "yellow",
										});
									}
									if (imageFiles.length > 0) addImages(imageFiles);
									if (textFileList.length > 0) addTextFiles(textFileList);
									e.target.value = "";
								}
							},
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
							queueHoldProgress,
							startInterruptPress,
							handleInterruptMouseUp,
							clearInterruptTimer,
							startQueueHold,
							handleQueuePointerUp,
							cancelQueueHold,
							handleQueueClick,
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
