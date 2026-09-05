import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { narratorColumnPlaceholderStyle } from "@frontend/lib/narrator-content-column";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import type { ComboboxData, ComboboxItemGroup } from "@mantine/core";
import {
	ActionIcon,
	Alert,
	Anchor,
	Avatar,
	Badge,
	Box,
	Button,
	Center,
	CloseButton,
	Drawer,
	Group,
	Image,
	Indicator,
	Loader,
	Menu,
	Modal,
	NativeSelect,
	NumberInput,
	Popover,
	Progress,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { tailRoleAllowsContinue } from "@shared/continue-tail";
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
	IconBolt,
	IconCheck,
	IconChevronDown,
	IconChevronUp,
	IconClock,
	IconCopy,
	IconDotsVertical,
	IconEraser,
	IconExternalLink,
	IconFile,
	// TEMPORARY mock-stream harness icon (see ./mock/README-REMOVAL.md).
	IconFlask,
	IconFolderPlus,
	IconGitBranch,
	IconGitFork,
	IconLock,
	IconLockOpen,
	IconNotebook,
	IconPaperclip,
	IconPencil,
	IconPlayerPlay,
	IconPlayerTrackNext,
	IconSettings,
	IconShield,
	IconSparkles,
	IconTerminal,
	IconTool,
	IconTrash,
	IconUpload,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	lazy,
	type ReactNode,
	type SetStateAction,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { resolveSwipeAnchorOffScreen } from "../../hooks/scroll-parent";
import { useCurrentUser } from "../../hooks/useAuth";
import { useChapter } from "../../hooks/useChapters";
import { useChatUnread, useNarratorChatRoom } from "../../hooks/useChat";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useLodIndicatorTrigger } from "../../hooks/useLodIndicatorTrigger";
import { useModelCardIndex } from "../../hooks/useModelCards";
import { useAllModels } from "../../hooks/useModels";
import {
	useArchiveNarrator,
	useBlacklistDirs,
	useBlockDeletePreview,
	useCmdBlacklist,
	useCmdWhitelist,
	useCreateBlacklistDir,
	useCreateCmdBlacklist,
	useCreateCmdWhitelist,
	useCreateNarrator,
	useCreateWhitelistDir,
	useDeleteBlacklistDir,
	useDeleteCmdBlacklist,
	useDeleteCmdWhitelist,
	useDeleteWhitelistDir,
	useEnterPlanMode,
	useExitPlanMode,
	useForkNarrator,
	useInterruptNarrator,
	useNarrator,
	usePromoteNarrator,
	useRollbackPreview,
	useStartAskInPassing,
	useStopTakeoverSubagent,
	useTakeoverSubagent,
	useUpdateBlacklistDir,
	useUpdateCmdBlacklist,
	useUpdateCmdWhitelist,
	useUpdateFastMode,
	useUpdateModel,
	useUpdatePermissionMode,
	useUpdatePruneEnabled,
	useUpdateReasoningEffort,
	useUpdateReflectionOverrides,
	useUpdateRelaxedPlan,
	useUpdateSubagentConclusion,
	useUpdateWhitelistDir,
	useWhitelistDirs,
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
	usePlatform,
	useProviderModelRefreshCapability,
	useProviderRuntimeCapability,
} from "../../hooks/usePlatform";
import { useSpecTasks } from "../../hooks/useSpec";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import { ApiError, api, type BufferMessageSummary, isAbortError } from "../../lib/api";
import type { RevertScope } from "../../lib/api/narrators";
import type { PathFlavor } from "../../lib/api/types";
import {
	AGG_MODEL_PREFIX,
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	type ModelAggregation,
	type ModelOption,
	parseAggModelValue,
	resolveDisplayModel,
	statusRegistry,
} from "../../lib/constants";
import { collectElementTextPreview, compactWhitespacePreview } from "../../lib/dom-text";
import {
	calculateEffectiveTurnElapsedMs,
	formatColonDuration,
	formatFullLocaleDateTime,
} from "../../lib/format";
import { formatLocaleNumber } from "../../lib/intl-format";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { requestNugModelRefreshOnPickerOpen } from "../../lib/nug-model-refresh";
import { formatRevertWarning, formatRevertWarnings } from "../../lib/revert-warnings";
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
import { TruncatedText } from "../common/TruncatedText";
import { PermissionRuleEditor } from "../permissions/PermissionRuleEditor";
import {
	buildPluginDockPanelOpenRequest,
	PluginContributionOptions,
	PluginContributionPicker,
} from "../plugins/PluginContributionPicker";
import { usePluginUiSurface } from "../plugins/PluginUiSurfaceContext";
import { UserAvatar } from "../UserAvatar";
import { BackgroundTasksDrawerHost, useBackgroundTasksButton } from "./BackgroundTasksDrawer";

import { ChapterBar } from "./ChapterBar";
import { CodexQuotaIndicator } from "./CodexQuotaIndicator";
import { ContentViewerEnvironmentProvider, handleRegistry } from "./ContentViewer";
import {
	COMPACTING_MARKER_ATTR,
	CompactSummaryModal,
	CompactSummaryModalCtx,
	type CompactSummaryModalTarget,
} from "./compact-summary-modal";
import { hasSendableComposerContent } from "./composer-send-gate";
import { useNarratorDockContext } from "./dock/NarratorDockContext";
import {
	clearDraftImageAttachments,
	getDraftImageAttachmentKey,
	loadDraftImageAttachments,
	saveDraftImageAttachments,
} from "./draft-image-attachments";
import { EditingMessageCtx, type EditingMessageState } from "./EditingMessageCtx";
import { ExecutionDeviceMenu, ExecutionDeviceOptions } from "./ExecutionDeviceMenu";
import {
	formatKimiBarText,
	formatKimiDetailsText,
	isKimiProviderBaseUrl,
} from "./kimi-usage-format";
import { LeakedToolCallModal } from "./LeakedToolCallModal";
import { LodSwitchToast } from "./LodSwitchToast";
import {
	BLOCK_ID_ATTR,
	collectSelectedText,
	MessageSelectionCtx,
	type MessageSelectionResolver,
	type MessageSelectionState,
	resolveBlockRange,
	resolveSelectedBlockMeta,
	resolveSelectedMessageIds,
} from "./MessageSelectionCtx";
import { MobileToolPanelHost, type MobileToolPanelKind } from "./MobileToolPanelHost";
import { ModelMenuItems } from "./ModelMenuItems";
import { ModelPriceModal } from "./ModelPriceModal";
import type { MessageListHandle, MessageListTailMeta } from "./message-list-handle";
// TEMPORARY: streaming harness activity flag (see ./mock/README-REMOVAL.md).
// Store-only import — the panel component itself is lazy-loaded by the dock.
import { useMockStreamActive } from "./mock/mock-stream-store";
import {
	NarratorComposer,
	type NarratorComposerHandle,
	type NarratorRemoteDraft,
} from "./NarratorComposer";
import { NarratorLodMenu, NarratorLodOptions } from "./NarratorLodMenu";
import { NarratorMessageListSkeleton } from "./NarratorMessageListSkeleton";
import { NarratorPanelSkeleton } from "./NarratorPanelSkeleton";
import {
	NarratorStatusBar,
	NarratorStatusToolbar,
	type NarratorStatusToolbarAction,
} from "./NarratorStatusToolbar";
import { NarratorToolbarOverflowMenu } from "./NarratorToolbarOverflowMenu";
import { NugRechargeDialog } from "./NugRechargeDialog";
import {
	HEADER_TITLE_MIN_WIDTH_PX,
	HEADER_TITLE_SLOT_ATTR,
	HEADER_TOOLBAR_FIXED_ATTR,
	selectHeaderToolbarEntries,
} from "./narrator-header-toolbar-capacity";
import { revokeContentBlockPreviewUrls } from "./narrator-message-helpers";
import type { ContentBlock, NarratorMsg, NarratorPanelProps } from "./narrator-panel-types";
import {
	ACCEPTED_TYPES,
	formatFileSize,
	isTextFile,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	MAX_TEXT_FILE_SIZE,
	PERM_MODE_ICONS,
	PERM_MODES,
	resizeImageIfNeeded,
} from "./narrator-panel-types";
import { getNarratorStatusBarDisplay, planNarratorWorkIndicator } from "./narrator-status-bar";
import {
	type NarratorToolbarBadgeCounts,
	resolveNarratorToolbarBadge,
} from "./narrator-toolbar-badges";
import type { NarratorToolbarHost, NarratorToolbarId } from "./narrator-toolbar-items";
import { compactProgressLabel } from "./progress-label";
import { QueuedAttachmentPreview, QueuedMessageRow } from "./QueuedMessageRow";
import { type RenderLod, RenderLodCtx } from "./RenderLodCtx";
import { RevertScopeConfirmModal } from "./RevertScopeConfirmModal";
import { SwipeAnchorOverlay } from "./SwipeAnchorOverlay";
import { resolveSelectionOverlayBlockId } from "./selection-anchor-overlay";
import { revealSpecFile } from "./spec-file-reveal";
import {
	getGlobalCloseSwipe,
	type SwipeAnchorInfo,
	setGlobalOnSelectionRange,
	setGlobalOnSwipeAnchorInfo,
	setGlobalSwipeAnchor,
	setGlobalToggleBlock,
} from "./swipeState";
import {
	AllowRetryCtx,
	FileModDrawerCtx,
	LatestTodosToolUseIdCtx,
	PermEnterHintCtx,
} from "./tool-call-contexts";
import { type PaymentRequiredInfo, useNarratorPanelWS } from "./useNarratorPanelWS";

type ModelComboboxItem = string | { value: string; label: string };
type ModelComboboxItemGroup = ComboboxItemGroup<ModelComboboxItem, string>;

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

const PERM_MODE_DATA = PERM_MODES.map((m) => ({ value: m, label: `perm_${m}` }));
const BOOLEAN_OVERRIDE_VALUES = ["inherit", "on", "off"] as const;
type BooleanOverride = (typeof BOOLEAN_OVERRIDE_VALUES)[number];
const DANGER_REFLECTION_LEVEL_VALUES = ["off", "light", "standard", "strict"] as const;
type DangerReflectionLevel = (typeof DANGER_REFLECTION_LEVEL_VALUES)[number];
const DANGER_REFLECTION_OVERRIDE_VALUES = [
	"inherit",
	"on",
	...DANGER_REFLECTION_LEVEL_VALUES,
] as const;
type DangerReflectionOverride = (typeof DANGER_REFLECTION_OVERRIDE_VALUES)[number];

type ContextThresholdsDraft = {
	standard: { pruneStart: number; compactStart: number };
	large: { pruneStart: number; compactStart: number };
};

type ContextManagementDraft = {
	contextThresholds: ContextThresholdsDraft;
	autoCompactKeepPairs: number;
	autoCompactPruneThreshold: number;
	minPruneRatio: number;
};

const DEFAULT_CONTEXT_THRESHOLDS_DRAFT: ContextThresholdsDraft = {
	standard: { pruneStart: 95, compactStart: 99 },
	large: { pruneStart: 95, compactStart: 99 },
};
const DEFAULT_AUTO_COMPACT_KEEP_PAIRS = 2;
const DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD = 80;
const DEFAULT_MIN_PRUNE_RATIO = 30;

function normalizeBooleanOverride(value: unknown): BooleanOverride {
	return BOOLEAN_OVERRIDE_VALUES.includes(value as BooleanOverride)
		? (value as BooleanOverride)
		: "inherit";
}

function normalizeDangerReflectionLevel(
	value: unknown,
	legacyEnabled = true,
): DangerReflectionLevel {
	return DANGER_REFLECTION_LEVEL_VALUES.includes(value as DangerReflectionLevel)
		? (value as DangerReflectionLevel)
		: legacyEnabled
			? "standard"
			: "off";
}

function normalizeDangerReflectionOverride(value: unknown): DangerReflectionOverride {
	return DANGER_REFLECTION_OVERRIDE_VALUES.includes(value as DangerReflectionOverride)
		? (value as DangerReflectionOverride)
		: "inherit";
}

function resolveDangerReflectionLevel(
	override: unknown,
	globalLevel: DangerReflectionLevel,
): DangerReflectionLevel {
	const normalizedOverride = normalizeDangerReflectionOverride(override);
	if (normalizedOverride === "inherit") return globalLevel;
	if (normalizedOverride === "on") return globalLevel === "off" ? "standard" : globalLevel;
	return normalizedOverride;
}

function formatDangerReflectionLevel(
	level: DangerReflectionLevel,
	t: (key: string) => string,
): string {
	return t(`dangerReflectionLevel_${level}`);
}

function resolveBooleanOverride(value: unknown, globalDefault: boolean): boolean {
	const override = normalizeBooleanOverride(value);
	if (override === "inherit") return globalDefault;
	return override === "on";
}

/** Number of queued messages before the queue collapses into a summary bar. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

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

/**
 * Modal with a searchable Select to change the global default or summary model.
 * Used from the per-narrator model menu so users with many models can filter by
 * typing instead of scrolling. Excludes meta sentinels (follow-default /
 * follow-summary) to avoid self/circular references.
 */
function SetGlobalModelModal({
	opened,
	mode,
	groupedModels,
	currentValue,
	saving,
	onClose,
	onConfirm,
}: {
	opened: boolean;
	mode: "default" | "summary" | null;
	groupedModels: ComboboxData;
	currentValue: string | null | undefined;
	saving: boolean;
	onClose: () => void;
	onConfirm: (model: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const [selected, setSelected] = useState<string | null>(null);

	// Reset the selection to the current value whenever the modal (re)opens.
	useEffect(() => {
		if (opened) setSelected(currentValue ?? null);
	}, [opened, currentValue]);

	// Default picker must exclude both sentinels (summary follows default →
	// circular); summary picker only excludes the summary sentinel.
	const data = useMemo<ComboboxData>(() => {
		const exclude =
			mode === "default"
				? ["__default__", "__summary__"]
				: mode === "summary"
					? ["__summary__"]
					: [];
		if (exclude.length === 0) return groupedModels;
		return (groupedModels as ModelComboboxItemGroup[]).filter(
			(g) => !g.items?.some?.((i) => exclude.includes(typeof i === "string" ? i : i.value)),
		);
	}, [groupedModels, mode]);

	const title = mode === "summary" ? t("editSummaryModel") : t("editDefaultModel");

	return (
		<Modal opened={opened} onClose={onClose} title={title} centered size="md">
			<Stack gap="md">
				<Select
					data={data}
					searchable
					limit={100}
					placeholder={t("modelFilterPlaceholder")}
					value={selected}
					onChange={setSelected}
					comboboxProps={{ withinPortal: true }}
					nothingFoundMessage={t("noModelMatches")}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose} disabled={saving}>
						{t("cancel")}
					</Button>
					<Button
						onClick={() => selected && onConfirm(selected)}
						disabled={!selected || saving}
						loading={saving}
					>
						{t("confirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/**
 * Inline provider switcher for aggregation models.
 * Shows a SegmentedControl with "Auto" + each member provider.
 */
function AggProviderSwitcher({
	currentModel,
	aggregations,
	providerLabels,
	onSelect,
}: {
	currentModel: string | null | undefined;
	aggregations: ModelAggregation[];
	providerLabels: Record<string, string>;
	onSelect: (model: string) => void;
}) {
	const { t } = useTranslation("settings");
	const parsed = parseAggModelValue(currentModel);
	if (!parsed) return null;

	const agg = aggregations.find((a) => a.id === parsed.aggId);
	if (!agg || agg.models.length === 0) return null;

	// Build segments: "auto" + each member model
	const segments: Array<{ value: string; label: string }> = [
		{ value: "auto", label: t("aggAutoLabel") },
	];
	for (const memberModel of agg.models) {
		const colonIdx = memberModel.indexOf(":");
		const prefix = colonIdx > 0 ? memberModel.slice(0, colonIdx) : memberModel;
		const displayName = providerLabels[prefix] ?? prefix;
		segments.push({ value: memberModel, label: displayName });
	}

	// Determine current value
	const currentValue = parsed.pinnedModel ?? "auto";

	return (
		<SegmentedControl
			size="xs"
			data={segments}
			value={currentValue}
			onChange={(v) => {
				if (v === "auto") {
					onSelect(buildAggModelValue(parsed.aggId));
				} else {
					onSelect(buildAggModelValue(parsed.aggId, v));
				}
			}}
			style={{ flexShrink: 0 }}
		/>
	);
}

function PermModeMenuItems({
	currentMode,
	availableModes,
	unavailableReason,
	onSelect,
	t,
	renderAfterMode,
}: {
	currentMode: string;
	availableModes: string[];
	unavailableReason?: string;
	onSelect: (mode: string) => void;
	t: (key: string) => string;
	renderAfterMode?: (mode: string) => React.ReactNode;
}) {
	const modes = PERM_MODES.filter((mode) => availableModes.includes(mode));
	if (modes.length === 0) {
		return (
			<Menu.Item disabled title={unavailableReason}>
				{t("permissionModesUnavailable")}
			</Menu.Item>
		);
	}

	return (
		<>
			{modes.map((mode) => {
				const selected = currentMode === mode;
				return (
					<span key={mode}>
						<Menu.Item
							leftSection={PERM_MODE_ICONS[mode]}
							onClick={() => onSelect(mode)}
							rightSection={
								<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
							}
							fw={selected ? 600 : 400}
						>
							{t(`perm_${mode}`)}
						</Menu.Item>
						{renderAfterMode?.(mode)}
					</span>
				);
			})}
		</>
	);
}

const QUEUE_MODE_ICONS: Record<string, React.ReactNode> = {
	turn: <IconClock size={14} />,
	tool: <IconTool size={14} />,
	interrupt: <IconPlayerTrackNext size={14} />,
};

type QueueMode = "turn" | "tool" | "interrupt";
const QUEUE_MODES: QueueMode[] = ["turn", "tool", "interrupt"];

/**
 * The queue choices offered while an idle narrator is COMPACTING its context.
 *
 * Only two of the three modes mean anything here. There is no running turn and no
 * running tool call to cut in front of, so "wait for the turn to finish" and
 * "interrupt the turn" would both describe something that does not exist. What the
 * user actually decides is whether to wait for the compaction: waiting keeps the
 * turn on the post-compact summary, running now starts it against the current
 * history while the compaction continues in the background.
 *
 * Each entry maps onto the same `QueueMode` the rest of the composer speaks, so the
 * Enter / Ctrl+Enter bindings and the one-shot triggers keep working unchanged.
 */
const COMPACT_QUEUE_MODES: Array<{ mode: QueueMode; labelKey: string; descKey: string }> = [
	{
		mode: "turn",
		labelKey: "compactQueueMode_wait",
		descKey: "compactQueueMode_wait_desc",
	},
	{
		mode: "interrupt",
		labelKey: "compactQueueMode_now",
		descKey: "compactQueueMode_now_desc",
	},
];

/**
 * A single queue-mode row: icon + label + description, with a right-side marker
 * that is either a check (this mode is the current binding) or a play icon
 * (clicking sends the current input with this mode right now).
 */
function QueueModeMenuItem({
	mode,
	selected,
	action,
	labelKey,
	descriptionKey,
	onClick,
	t,
}: {
	mode: QueueMode;
	selected: boolean;
	/** "configure" shows a check on the active mode; "trigger" shows a play icon. */
	action: "configure" | "trigger";
	/**
	 * Label override. Defaults to the mode's generic name; the compacting menu
	 * passes its own because "wait for the turn to finish" describes a turn that is
	 * not running (see {@link COMPACT_QUEUE_MODES}).
	 */
	labelKey?: string;
	descriptionKey: string;
	onClick: () => void;
	t: (key: string) => string;
}) {
	return (
		<Menu.Item
			leftSection={QUEUE_MODE_ICONS[mode]}
			closeMenuOnClick
			onClick={onClick}
			rightSection={
				action === "trigger" ? (
					<IconPlayerPlay size={14} />
				) : (
					<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
				)
			}
			fw={action === "configure" && selected ? 600 : 400}
		>
			<Stack gap={0}>
				<Text size="sm">{t(labelKey ?? `queueMode_${mode}`)}</Text>
				<Text size="xs" c="dimmed">
					{t(descriptionKey)}
				</Text>
			</Stack>
		</Menu.Item>
	);
}

/**
 * Dropdown content for the send-options menu (the three-dots left segment of the
 * split send button).
 *
 * - When the input is empty, it configures which queue behavior the Enter key
 *   and the Ctrl/Cmd+Enter key are each bound to (also used by short/long press
 *   on the active queue button). Shift+Enter always inserts a native newline.
 * - When the input has content, it becomes a one-shot trigger: each queue mode
 *   sends the current input with that behavior immediately (play icons).
 */
function SendOptionsMenuContent({
	enterQueueMode,
	ctrlEnterQueueMode,
	hasInput,
	compacting,
	onSelectEnterMode,
	onSelectCtrlEnterMode,
	onSendWithMode,
	t,
}: {
	enterQueueMode: QueueMode;
	ctrlEnterQueueMode: QueueMode;
	hasInput: boolean;
	/**
	 * The narrator is idle but compacting, so the menu offers the two-way
	 * wait-for-compaction choice instead of the three turn/tool/interrupt modes.
	 */
	compacting?: boolean;
	onSelectEnterMode: (mode: QueueMode) => void;
	onSelectCtrlEnterMode: (mode: QueueMode) => void;
	onSendWithMode: (mode: QueueMode) => void;
	t: (key: string) => string;
}) {
	// With a draft in hand during a compaction, the menu answers the only question that
	// applies: wait for the compaction, or run now? The generic turn/tool/interrupt
	// names would describe a turn and a tool call that are not running.
	//
	// With an EMPTY composer it falls through to the key-binding config below instead.
	// Those bindings still govern the narrator's later busy turns, and offering send
	// actions with nothing to send would present two items that quietly do nothing.
	if (compacting && hasInput) {
		return (
			<>
				<Menu.Label>{t("compactQueueSection")}</Menu.Label>
				{COMPACT_QUEUE_MODES.map(({ mode, labelKey, descKey }) => (
					<QueueModeMenuItem
						key={mode}
						mode={mode}
						selected={false}
						action="trigger"
						labelKey={labelKey}
						descriptionKey={descKey}
						onClick={() => onSendWithMode(mode)}
						t={t}
					/>
				))}
			</>
		);
	}
	if (hasInput) {
		return (
			<>
				<Menu.Label>{t("sendCurrentInputSection")}</Menu.Label>
				{QUEUE_MODES.map((mode) => (
					<QueueModeMenuItem
						key={mode}
						mode={mode}
						selected={false}
						action="trigger"
						descriptionKey={`queueMode_${mode}_desc`}
						onClick={() => onSendWithMode(mode)}
						t={t}
					/>
				))}
			</>
		);
	}
	return (
		<>
			<Menu.Label>{t("enterKeySection")}</Menu.Label>
			{QUEUE_MODES.map((mode) => (
				<QueueModeMenuItem
					key={mode}
					mode={mode}
					selected={enterQueueMode === mode}
					action="configure"
					descriptionKey={`queueMode_${mode}_desc`}
					onClick={() => onSelectEnterMode(mode)}
					t={t}
				/>
			))}
			<Menu.Divider />
			<Menu.Label>{t("ctrlEnterKeySection")}</Menu.Label>
			{QUEUE_MODES.map((mode) => (
				<QueueModeMenuItem
					key={mode}
					mode={mode}
					selected={ctrlEnterQueueMode === mode}
					action="configure"
					descriptionKey={`queueMode_${mode}_desc`}
					onClick={() => onSelectCtrlEnterMode(mode)}
					t={t}
				/>
			))}
			<Menu.Divider />
			<Menu.Item disabled>{t("shiftEnterNewlineHint")}</Menu.Item>
		</>
	);
}

/**
 * The three-dots send-options trigger rendered as the LEFT segment of a split
 * button that shares its border with the primary send/queue button. Uses
 * `Button.Group` so the two segments merge into one control (inner corners
 * squared, outer corners rounded, single shared border).
 */
function SendOptionsSplitButton({
	primaryButton,
	enterQueueMode,
	ctrlEnterQueueMode,
	hasInput,
	compacting,
	color,
	variant,
	onSelectEnterMode,
	onSelectCtrlEnterMode,
	onSendWithMode,
	t,
}: {
	primaryButton: React.ReactNode;
	enterQueueMode: QueueMode;
	ctrlEnterQueueMode: QueueMode;
	hasInput: boolean;
	/** Show the compaction wait/run-now chooser instead of the queue modes. */
	compacting?: boolean;
	/** Match the primary button's color/variant so the two segments look unified. */
	color?: string;
	variant?: string;
	onSelectEnterMode: (mode: QueueMode) => void;
	onSelectCtrlEnterMode: (mode: QueueMode) => void;
	onSendWithMode: (mode: QueueMode) => void;
	t: (key: string) => string;
}) {
	return (
		<Button.Group>
			<Menu position="top-end" withinPortal>
				<Menu.Target>
					<Button
						color={color}
						variant={variant}
						px={6}
						aria-label={t("sendOptions")}
						onContextMenu={(e) => e.preventDefault()}
					>
						<IconDotsVertical size={16} />
					</Button>
				</Menu.Target>
				<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto", maxWidth: 300 }}>
					<SendOptionsMenuContent
						enterQueueMode={enterQueueMode}
						ctrlEnterQueueMode={ctrlEnterQueueMode}
						hasInput={hasInput}
						compacting={compacting}
						onSelectEnterMode={onSelectEnterMode}
						onSelectCtrlEnterMode={onSelectCtrlEnterMode}
						onSendWithMode={onSendWithMode}
						t={t}
					/>
				</Menu.Dropdown>
			</Menu>
			{primaryButton}
		</Button.Group>
	);
}

function InlineOverrideActions({
	visible,
	disabled,
	onFollowDefault,
	onSetAsDefault,
	t,
}: {
	visible: boolean;
	disabled: boolean;
	onFollowDefault: () => void;
	onSetAsDefault: () => void;
	t: (key: string) => string;
}) {
	if (!visible) return null;
	const linkStyle = {
		textDecoration: "underline",
		opacity: disabled ? 0.45 : 1,
		pointerEvents: disabled ? "none" : "auto",
	} as const;
	return (
		<Group justify="space-between" mt={4} wrap="nowrap" style={{ width: "100%" }}>
			<Anchor
				component="button"
				type="button"
				size="xs"
				c="dimmed"
				style={linkStyle}
				onClick={(event) => {
					event.stopPropagation();
					onFollowDefault();
				}}
			>
				{t("override_followDefault")}
			</Anchor>
			<Anchor
				component="button"
				type="button"
				size="xs"
				c="dimmed"
				style={linkStyle}
				onClick={(event) => {
					event.stopPropagation();
					onSetAsDefault();
				}}
			>
				{t("override_setAsDefault")}
			</Anchor>
		</Group>
	);
}

function PlanReflectionMenuControl({
	visible,
	override,
	effective,
	globalDefault,
	disabled,
	onChange,
	onFollowDefault,
	onSetAsDefault,
	t,
}: {
	visible: boolean;
	override: BooleanOverride;
	effective: boolean;
	globalDefault: boolean;
	disabled: boolean;
	onChange: (value: BooleanOverride) => void;
	onFollowDefault: () => void;
	onSetAsDefault: () => void;
	t: (key: string) => string;
}) {
	if (!visible) return null;
	return (
		<Box px="sm" py={6} onClick={(event) => event.stopPropagation()}>
			<Group justify="space-between" align="center" wrap="nowrap" gap="sm">
				<Text size="xs" fw={600}>
					{t("planReflectionShort")}
				</Text>
				<Switch
					size="xs"
					checked={effective}
					disabled={disabled}
					onChange={(event) => {
						const checked = event.currentTarget.checked;
						onChange(checked === globalDefault ? "inherit" : checked ? "on" : "off");
					}}
				/>
			</Group>
			<InlineOverrideActions
				visible={override !== "inherit"}
				disabled={disabled}
				onFollowDefault={onFollowDefault}
				onSetAsDefault={onSetAsDefault}
				t={t}
			/>
		</Box>
	);
}

function DangerReflectionMenuControl({
	visible,
	override,
	effectiveLevel,
	globalLevel,
	disabled,
	onChange,
	onFollowDefault,
	onSetAsDefault,
	t,
}: {
	visible: boolean;
	override: DangerReflectionOverride;
	effectiveLevel: DangerReflectionLevel;
	globalLevel: DangerReflectionLevel;
	disabled: boolean;
	onChange: (value: DangerReflectionOverride) => void;
	onFollowDefault: () => void;
	onSetAsDefault: () => void;
	t: (key: string) => string;
}) {
	if (!visible) return null;
	return (
		<Box px="sm" pb={8} onClick={(event) => event.stopPropagation()}>
			<Text size="xs" fw={600} mb={4}>
				{t("dangerReflectionShort")}
			</Text>
			<SegmentedControl
				size="xs"
				fullWidth
				value={effectiveLevel}
				onChange={(value) => {
					const level = value as DangerReflectionLevel;
					onChange(level === globalLevel ? "inherit" : level);
				}}
				disabled={disabled}
				data={DANGER_REFLECTION_LEVEL_VALUES.map((level) => ({
					value: level,
					label: formatDangerReflectionLevel(level, t),
				}))}
			/>
			<InlineOverrideActions
				visible={override !== "inherit"}
				disabled={disabled}
				onFollowDefault={onFollowDefault}
				onSetAsDefault={onSetAsDefault}
				t={t}
			/>
		</Box>
	);
}

function PermissionMenuContent({
	currentMode,
	availablePermissionModes,
	permissionModesUnavailableReason,
	onSelectPermissionMode,
	t,
	hasPlanTrait,
	onTogglePlanMode,
	planModePending,
	planModeSupported,
	planModeUnsupportedReason,
	showPlanReflectionAutoApproveToggle,
	planReflectionAutoApproveOverride,
	planReflectionAutoApproveEffective,
	planReflectionAutoApproveGlobal,
	onPlanReflectionAutoApproveChange,
	onFollowDefaultPlanReflection,
	onSetPlanReflectionAsDefault,
	showDangerReflectionToggle,
	dangerReflectionOverride,
	dangerReflectionEffectiveLevel,
	dangerReflectionGlobalLevel,
	onDangerReflectionChange,
	onFollowDefaultDangerReflection,
	onSetDangerReflectionAsDefault,
	reflectionSettingsDisabled,
}: {
	currentMode: string;
	availablePermissionModes: string[];
	permissionModesUnavailableReason?: string;
	onSelectPermissionMode: (mode: string) => void;
	t: (key: string) => string;
	hasPlanTrait: boolean;
	onTogglePlanMode: () => void;
	planModePending: boolean;
	planModeSupported: boolean;
	planModeUnsupportedReason?: string;
	showPlanReflectionAutoApproveToggle: boolean;
	planReflectionAutoApproveOverride: BooleanOverride;
	planReflectionAutoApproveEffective: boolean;
	planReflectionAutoApproveGlobal: boolean;
	onPlanReflectionAutoApproveChange: (value: BooleanOverride) => void;
	onFollowDefaultPlanReflection: () => void;
	onSetPlanReflectionAsDefault: () => void;
	showDangerReflectionToggle: boolean;
	dangerReflectionOverride: DangerReflectionOverride;
	dangerReflectionEffectiveLevel: DangerReflectionLevel;
	dangerReflectionGlobalLevel: DangerReflectionLevel;
	onDangerReflectionChange: (value: DangerReflectionOverride) => void;
	onFollowDefaultDangerReflection: () => void;
	onSetDangerReflectionAsDefault: () => void;
	reflectionSettingsDisabled: boolean;
}) {
	return (
		<>
			<Menu.Label>{t("permissionMode")}</Menu.Label>
			<PermModeMenuItems
				currentMode={currentMode}
				availableModes={availablePermissionModes}
				unavailableReason={permissionModesUnavailableReason}
				onSelect={onSelectPermissionMode}
				t={t}
				renderAfterMode={(mode) =>
					mode === "bypassPermissions" ? (
						<DangerReflectionMenuControl
							visible={showDangerReflectionToggle}
							override={dangerReflectionOverride}
							effectiveLevel={dangerReflectionEffectiveLevel}
							globalLevel={dangerReflectionGlobalLevel}
							disabled={reflectionSettingsDisabled}
							onChange={onDangerReflectionChange}
							onFollowDefault={onFollowDefaultDangerReflection}
							onSetAsDefault={onSetDangerReflectionAsDefault}
							t={t}
						/>
					) : null
				}
			/>
			<Menu.Divider />
			<Menu.Item
				leftSection={<IconNotebook size={14} />}
				onClick={onTogglePlanMode}
				disabled={planModePending || !planModeSupported}
				title={!planModeSupported ? planModeUnsupportedReason : undefined}
			>
				{!planModeSupported
					? t("planModeUnavailable")
					: hasPlanTrait
						? t("exitPlanMode")
						: t("enterPlanMode")}
			</Menu.Item>
			<PlanReflectionMenuControl
				visible={showPlanReflectionAutoApproveToggle}
				override={planReflectionAutoApproveOverride}
				effective={planReflectionAutoApproveEffective}
				globalDefault={planReflectionAutoApproveGlobal}
				disabled={reflectionSettingsDisabled}
				onChange={onPlanReflectionAutoApproveChange}
				onFollowDefault={onFollowDefaultPlanReflection}
				onSetAsDefault={onSetPlanReflectionAsDefault}
				t={t}
			/>
		</>
	);
}

function PathRulesPopover({
	narratorId,
	t,
	triggerMode = "icon",
}: {
	narratorId: string;
	t: (key: string) => string;
	triggerMode?: "icon" | "menu";
}) {
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const platform = usePlatform();
	const serverPathFlavor: PathFlavor = platform === "windows" ? "windows" : "posix";
	const [opened, { toggle, close }] = useDisclosure(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Only fetch rules when the popover is open — avoids 4 API calls on every page load.
	const enabledId = opened ? narratorId : "";
	const { data: wlDirs = [] } = useWhitelistDirs(enabledId);
	const createWl = useCreateWhitelistDir();
	const updateWl = useUpdateWhitelistDir(narratorId);
	const deleteWl = useDeleteWhitelistDir(narratorId);
	const { data: blDirs = [] } = useBlacklistDirs(enabledId);
	const createBl = useCreateBlacklistDir();
	const updateBl = useUpdateBlacklistDir(narratorId);
	const deleteBl = useDeleteBlacklistDir(narratorId);
	const { data: cmdWl = [] } = useCmdWhitelist(enabledId);
	const createCmdWl = useCreateCmdWhitelist();
	const updateCmdWl = useUpdateCmdWhitelist(narratorId);
	const deleteCmdWl = useDeleteCmdWhitelist(narratorId);
	const { data: cmdBl = [] } = useCmdBlacklist(enabledId);
	const createCmdBl = useCreateCmdBlacklist();
	const updateCmdBl = useUpdateCmdBlacklist(narratorId);
	const deleteCmdBl = useDeleteCmdBlacklist(narratorId);
	const { data: execDevices } = useQuery({
		queryKey: ["narratorExecutionDevices", narratorId],
		queryFn: () => api.getNarratorExecutionDevices(narratorId),
		enabled: opened,
	});
	const permissionDevices = useMemo(
		() =>
			(execDevices?.devices ?? []).map((device) => ({
				id: device.id,
				name: device.name || device.id,
				status: device.online ? ("online" as const) : ("offline" as const),
				platformOs: device.platform?.os ?? null,
			})),
		[execDevices],
	);
	const badgeCount = wlDirs.length + blDirs.length + cmdWl.length + cmdBl.length;

	// Popover has no built-in outside-click handling here (closeOnClickOutside is
	// off so nested overlays can't dismiss it), so it is emulated below. The Modal
	// branch has its own overlay dismissal and must not run this.
	const usesPopover = !isMobile && triggerMode !== "menu";

	useEffect(() => {
		if (!opened || !usesPopover) return;
		const handler = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			if (!target || dropdownRef.current?.contains(target)) return;
			// Any nested overlay opened from inside this popover (Select/Combobox
			// dropdowns, the directory-browser Modal, nested Popovers) is rendered
			// into Mantine's portal layer, not into our dropdown's DOM subtree.
			// Matching on portal containers instead of per-component class names
			// keeps this correct when a child switches widget type: enumerating
			// `.mantine-Combobox-dropdown` used to miss `.mantine-Select-dropdown`,
			// so picking a rule target counted as an outside click and tore down
			// the whole popover (losing the in-progress draft rule with it).
			if (target.closest("[data-portal], [data-mantine-shared-portal-node]")) return;
			close();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [opened, usesPopover, close]);

	const trigger =
		triggerMode === "menu" ? (
			<Menu.Item
				key="path-rules"
				leftSection={<IconFolderPlus size={16} />}
				rightSection={badgeCount > 0 ? <Badge size="xs">{badgeCount}</Badge> : undefined}
				onClick={toggle}
			>
				{t("path_rules")}
			</Menu.Item>
		) : (
			<Tooltip label={t("path_rules")}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					aria-label={t("path_rules")}
					onClick={toggle}
				>
					<IconFolderPlus size={16} />
					{badgeCount > 0 && (
						<Text
							size="8px"
							fw={700}
							c="indigo"
							style={{ position: "absolute", top: -2, right: -4 }}
						>
							{badgeCount}
						</Text>
					)}
				</ActionIcon>
			</Tooltip>
		);

	const content = (
		<Stack gap="md">
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("whitelist_dirs_title")}
				</Text>
				<PermissionRuleEditor
					rules={wlDirs}
					kind="directoryWhitelist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("whitelist_dirs_empty")}
					placeholder={t("whitelist_dirs_placeholder")}
					onCreate={(rule) =>
						createWl.mutate({
							narratorId,
							path: rule.path ?? "",
							pathFlavor: rule.pathFlavor ?? undefined,
							accessLevel: rule.accessLevel ?? "readOnly",
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateWl.mutate({
							dirId: rule.id ?? "",
							path: rule.path,
							pathFlavor: rule.pathFlavor ?? undefined,
							accessLevel: rule.accessLevel,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteWl.mutate(rule.id)}
				/>
			</Stack>
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("blacklist_dirs_title")}
				</Text>
				<PermissionRuleEditor
					rules={blDirs}
					kind="directoryBlacklist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("blacklist_dirs_empty")}
					placeholder={t("blacklist_dirs_placeholder")}
					onCreate={(rule) =>
						createBl.mutate({
							narratorId,
							path: rule.path ?? "",
							pathFlavor: rule.pathFlavor ?? undefined,
							denyLevel: rule.denyLevel ?? "denyAll",
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateBl.mutate({
							dirId: rule.id ?? "",
							path: rule.path,
							pathFlavor: rule.pathFlavor ?? undefined,
							denyLevel: rule.denyLevel,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteBl.mutate(rule.id)}
				/>
			</Stack>
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("cmd_whitelist_title")}
				</Text>
				<PermissionRuleEditor
					rules={cmdWl}
					kind="commandWhitelist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("cmd_whitelist_empty")}
					placeholder={t("cmd_whitelist_placeholder")}
					onCreate={(rule) =>
						createCmdWl.mutate({
							narratorId,
							pattern: rule.pattern ?? "",
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateCmdWl.mutate({
							entryId: rule.id ?? "",
							pattern: rule.pattern,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteCmdWl.mutate(rule.id)}
				/>
			</Stack>
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("cmd_blacklist_title")}
				</Text>
				<PermissionRuleEditor
					rules={cmdBl}
					kind="commandBlacklist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("cmd_blacklist_empty")}
					placeholder={t("cmd_blacklist_placeholder")}
					onCreate={(rule) =>
						createCmdBl.mutate({
							narratorId,
							pattern: rule.pattern ?? "",
							denyPrompt: rule.denyPrompt,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateCmdBl.mutate({
							entryId: rule.id ?? "",
							pattern: rule.pattern,
							denyPrompt: rule.denyPrompt,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteCmdBl.mutate(rule.id)}
				/>
			</Stack>
		</Stack>
	);

	if (isMobile || triggerMode === "menu") {
		return (
			<>
				{trigger}
				<Modal
					opened={opened}
					onClose={close}
					title={t("path_rules")}
					fullScreen={isMobile}
					size="lg"
					scrollAreaComponent={ScrollArea.Autosize}
				>
					<Box p="md">{content}</Box>
				</Modal>
			</>
		);
	}

	return (
		<Popover
			opened={opened}
			onClose={close}
			position="top-end"
			width={520}
			shadow="md"
			withinPortal
			closeOnClickOutside={false}
		>
			<Popover.Target>{trigger}</Popover.Target>
			<Popover.Dropdown ref={dropdownRef} mah="70vh" style={{ overflowY: "auto" }}>
				{content}
			</Popover.Dropdown>
		</Popover>
	);
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

/**
 * onto the UI's unified enum. Levels are shown exactly as the gateway reports
 * disable thinking). Returns undefined when the model advertises no effort.
 */
	modelOption?: ModelOption,
): readonly ReasoningEffortValue[] | undefined {
	const levels = modelOption?.effortLevels;
	if (!levels || levels.length === 0) return undefined;
	const order: ReasoningEffortValue[] = ["low", "medium", "high", "xhigh", "max"];
	const present = new Set<ReasoningEffortValue>();
	for (const level of levels) {
		if ((order as string[]).includes(level)) present.add(level as ReasoningEffortValue);
	}
	const ordered = order.filter((l) => present.has(l));
	return ordered.length > 0 ? ordered : undefined;
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

function ReasoningEffortMenuItems({
	currentEffort,
	options,
	onSelect,
	t,
}: {
	currentEffort: string | null | undefined;
	options: readonly ReasoningEffortValue[];
	onSelect: (effort: string) => void;
	t: (key: string) => string;
}) {
	// No "auto" item: follow/override state is expressed by the inline
	// "follow default / set as default" links below (matching the permission
	// and reflection menus). Selecting a tier writes an explicit override.
	return (
		<>
			<Menu.Label>{t("reasoningEffort")}</Menu.Label>
			{options.map((effort) => {
				const selected = currentEffort === effort;
				return (
					<Menu.Item
						key={effort}
						onClick={() => onSelect(effort)}
						rightSection={
							<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
						}
						fw={selected ? 600 : 400}
					>
						{t(`reasoning_${effort}`)}
					</Menu.Item>
				);
			})}
		</>
	);
}

/**
 * Confirmation modal for rollback-to-block.
 *
 * Owns only the preview query and this action's wording; the scope choice, the file
 * list and the three exits live in RevertScopeConfirmModal, shared with
 * edit-and-regenerate so both present the same decision.
 */
function RollbackConfirmModal({
	narratorId,
	pendingRollback,
	onConfirm,
	onCancel,
}: {
	narratorId: string;
	pendingRollback: { messageId: string; blockIndex: number } | null;
	onConfirm: (opts: { skipRevert: boolean; scope?: RevertScope }) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { data, isLoading } = useRollbackPreview(
		narratorId,
		pendingRollback?.messageId ?? null,
		pendingRollback?.blockIndex ?? null,
		!!pendingRollback,
	);

	const blockCount = data?.deletedBlockCount ?? 0;
	const messageCount = data?.deletedMessageCount ?? 0;

	let description: string;
	if (blockCount > 0 && messageCount > 0) {
		description = t("rollbackConfirmDesc", { blockCount, messageCount });
	} else if (blockCount > 0) {
		description = t("rollbackConfirmDescBlocksOnly", { blockCount });
	} else {
		description = t("rollbackConfirmDescMessagesOnly", { messageCount });
	}

	return (
		<RevertScopeConfirmModal
			opened={!!pendingRollback}
			title={t("rollbackConfirmTitle")}
			description={description}
			data={data}
			isLoading={isLoading}
			confirmWithRevertLabel={t("rollbackConfirmWithRevert")}
			confirmNoFilesLabel={t("rollbackConfirm")}
			messagesOnlyLabel={t("rollbackConfirmMessagesOnly")}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

/**
 * Confirmation modal for deleting a single tool_use block.
 *
 * Deleting a block rolls back exactly the files that one call changed, which now
 * includes changes no tool input describes (Bash, build scripts, editors). That
 * makes it a destructive action worth confirming: previously it fired straight from
 * the context menu with no indication of what would be undone.
 *
 * There is no scope picker here — a block IS one recorded call, so the narrow scope
 * is the only meaningful one. A conflict means another actor changed the same
 * regions, so the file rollback is refused and only history-only deletion is left.
 */
function BlockDeleteConfirmModal({
	narratorId,
	pending,
	onConfirm,
	onCancel,
}: {
	narratorId: string;
	pending: { messageId: string; blockIndex: number } | null;
	onConfirm: (opts: { skipRevert: boolean }) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { data, isLoading, isError } = useBlockDeletePreview(
		narratorId,
		pending?.messageId ?? null,
		pending?.blockIndex ?? null,
		!!pending,
	);

	const files = data?.files ?? [];
	const conflicts = data?.conflicts ?? [];
	// A failed preview must not read as "nothing would change": both lists are empty
	// in that case, which would otherwise render as a reassuring "no files affected"
	// next to an enabled rollback button.
	const previewFailed = !isLoading && (isError || !data);
	// A conflict is the one case where the file rollback cannot run at all.
	const revertBlocked = conflicts.length > 0 || previewFailed;
	const subagentWarningText = data?.subagentWarning
		? formatRevertWarning(t, {
				code: "SUBAGENT_CHANGES_REVERTED",
				changeCount: data.subagentWarning.changeCount,
				sampleFilePaths: data.subagentWarning.sampleFiles,
			})
		: null;

	return (
		<Modal
			opened={!!pending}
			onClose={onCancel}
			title={t("blockDeleteConfirmTitle")}
			centered
			size="md"
		>
			<Stack gap="md">
				{isLoading ? (
					<Center py="md">
						<Loader size="sm" />
					</Center>
				) : (
					<>
						<Text size="sm">{t("blockDeleteConfirmDesc")}</Text>

						{previewFailed && (
							<Alert color="red" variant="light" title={t("blockDeletePreviewFailedTitle")}>
								<Text size="xs">{t("blockDeletePreviewFailedDesc")}</Text>
							</Alert>
						)}

						{conflicts.length > 0 && (
							<Alert color="red" variant="light" title={t("revertScopeConflictTitle")}>
								<Text size="xs">
									{t("revertScopeConflictDesc", { files: conflicts.slice(0, 5).join(", ") })}
								</Text>
							</Alert>
						)}

						{subagentWarningText && (
							<Alert color="yellow" variant="light" title={t("revertScopeSubagentTitle")}>
								<Text size="xs">{subagentWarningText}</Text>
							</Alert>
						)}

						{files.length > 0 ? (
							<>
								<Text size="sm" fw={500}>
									{t("rollbackConfirmFiles")}
								</Text>
								<Stack gap={4} mah={260} style={{ overflowY: "auto" }}>
									{files.map((file) => (
										<Group key={file.filePath} gap="xs" wrap="nowrap">
											<TruncatedPath path={file.filePath} />
											<Badge
												size="xs"
												variant="light"
												color={file.willBeDeleted ? "red" : "orange"}
											>
												{file.willBeDeleted
													? t("fileMod_willBeDeleted")
													: t("fileMod_willBeReverted")}
											</Badge>
										</Group>
									))}
								</Stack>
							</>
						) : (
							!previewFailed && (
								<Text size="sm" c="dimmed">
									{conflicts.length > 0
										? t("revertScopeBlocked")
										: data?.reason === "nothing_owned"
											? t("revertScopeNothingOwned")
											: t("blockDeleteConfirmNoFiles")}
								</Text>
							)
						)}
					</>
				)}
				<Group gap="xs" justify="flex-end">
					<Button size="xs" variant="subtle" onClick={onCancel}>
						{tc("cancel")}
					</Button>
					<Button
						size="xs"
						variant="default"
						onClick={() => onConfirm({ skipRevert: true })}
						loading={isLoading}
					>
						{t("blockDeleteHistoryOnly")}
					</Button>
					<Button
						size="xs"
						color="red"
						disabled={revertBlocked}
						onClick={() => onConfirm({ skipRevert: false })}
						loading={isLoading}
					>
						{files.length > 0 ? t("blockDeleteWithRevert") : t("contextMenu_delete")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function TurnElapsedTime({
	text,
	startedAtLabel,
	isMobile,
}: {
	text: string;
	startedAtLabel: string | null;
	isMobile: boolean;
}) {
	const [opened, setOpened] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelClose = useCallback(() => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);
	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			setOpened(false);
			closeTimer.current = null;
		}, 150);
	}, [cancelClose]);
	useEffect(() => () => cancelClose(), [cancelClose]);

	// Without a popover the row has nothing else to reveal the clipped tail, so
	// the text carries its own overflow tooltip. With a popover the full string
	// goes into the dropdown instead — nesting a tooltip inside a popover target
	// would open two overlapping bubbles for the same gesture.
	if (!startedAtLabel)
		return <TruncatedText size="xs" c="dimmed" text={text} style={{ maxWidth: "100%" }} />;

	const elapsedText = (
		<Text size="xs" c="dimmed" truncate style={{ minWidth: 0, maxWidth: "100%" }}>
			{text}
		</Text>
	);

	return (
		<Popover opened={opened} onChange={setOpened} position="top" withArrow withinPortal shadow="md">
			<Popover.Target>
				<UnstyledButton
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						cancelClose();
						setOpened((opened) => !opened);
					}}
					onPointerDown={(event) => event.stopPropagation()}
					onPointerEnter={() => {
						if (!isMobile) {
							cancelClose();
							setOpened(true);
						}
					}}
					onPointerLeave={() => {
						if (!isMobile) scheduleClose();
					}}
					aria-label={`${text}, ${startedAtLabel}`}
					style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%", cursor: "pointer" }}
				>
					{elapsedText}
				</UnstyledButton>
			</Popover.Target>
			<Popover.Dropdown
				onPointerEnter={() => {
					if (!isMobile) cancelClose();
				}}
				onPointerLeave={() => {
					if (!isMobile) scheduleClose();
				}}
			>
				{/* The inline label is the part the row clips, so repeat it in full here:
				    the popover is the only reveal affordance this control has. */}
				<Stack gap={2}>
					<Text size="xs" style={{ overflowWrap: "anywhere" }}>
						{text}
					</Text>
					<Text size="xs" c="dimmed">
						{startedAtLabel}
					</Text>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

export function NarratorPanel({
	narratorId,
	narrator: narratorProp,
	onForkFromMessage,
	highlightMessageId,
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
	// Shared model price popup state. Hoisted here (a stable ancestor outside any
	// Menu.Dropdown) so opening the popup is not unmounted when the model menu closes.
	const [priceModel, setPriceModel] = useState<ModelOption | null>(null);
	// Controlled open state for the two model-selector menus (desktop + mobile).
	// While the price popup is open, ignore close requests so dismissing the
	// popup (a click outside the menu) does not also close the model menu.
	const [modelMenuOpenDesktop, setModelMenuOpenDesktop] = useState(false);
	const [modelMenuOpenMobile, setModelMenuOpenMobile] = useState(false);
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
	const { t: ts } = useTranslation("settings");
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
		// model accepts, and an empty list means it genuinely has none.
		}
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
		// Ahead of cards on purpose — a gateway is first-hand authoritative about
		// the tiers its own channel accepts.
		}
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
	// Deleting a block rolls its file changes back, so it asks first rather than
	// firing straight from the context menu.
	const [pendingBlockDelete, setPendingBlockDelete] = useState<{
		messageId: string;
		blockIndex: number;
	} | null>(null);

	const handleDeleteBlock = useCallback((messageId: string, blockIndex: number) => {
		setPendingBlockDelete({ messageId, blockIndex });
	}, []);

	const confirmBlockDelete = useCallback(
		async ({ skipRevert }: { skipRevert: boolean }) => {
			if (!pendingBlockDelete) return;
			const { messageId, blockIndex } = pendingBlockDelete;
			setPendingBlockDelete(null);
			try {
				await api.deleteMessageBlock(narratorId, messageId, blockIndex, { skipRevert });
				chunkListRef.current?.refreshStructure("full");
			} catch (error) {
				// A rollback refusal (another actor changed the same regions) is not a
				// generic failure: the server explains what happened and the user still has
				// a way forward. Surfacing "please retry" instead would send them into a
				// loop that cannot succeed.
				const isConflict = error instanceof ApiError && error.status === 409;
				notifications.show({
					title: isConflict ? t("blockDeleteConflictTitle") : t("deleteMessageFailed"),
					message: isConflict ? t("blockDeleteConflictDesc") : t("deleteMessageFailedDesc"),
					color: isConflict ? "yellow" : "red",
					autoClose: isConflict ? 10000 : 5000,
				});
			}
		},
		[narratorId, pendingBlockDelete, t],
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
			setPendingRollback({ messageId, blockIndex });
		},
		[rollbackEditRegenerateSupported, rollbackEditRegenerateUnsupportedReason, t],
	);

	const confirmRollback = useCallback(
		async ({ skipRevert, scope }: { skipRevert: boolean; scope?: RevertScope }) => {
			if (!pendingRollback) return;
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
				const result = await api.rollbackToBlock(
					narratorId,
					pendingRollback.messageId,
					pendingRollback.blockIndex,
					{ skipRevert, ...(scope ? { scope } : {}) },
				);
				// A rollback can reach beyond the chosen scope (subagent writes, a
				// workspace restore); surface that so the result is verified, not assumed.
				const warningText = formatRevertWarnings(t, result.warnings);
				if (warningText) {
					notifications.show({
						title: t("rollbackPartialTitle"),
						message: warningText,
						color: "yellow",
						autoClose: false,
					});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to rollback";
				notifications.show({ title: t("rollbackFailed"), message, color: "red" });
			}
			setPendingRollback(null);
		},
		[
			narratorId,
			pendingRollback,
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

	/*
	 * Pending attachments — images and text files.
	 *
	 * Both kinds are persisted, and both share ONE set of bookkeeping refs below
	 * (`attachmentDraftLocalVersionRef` / `attachmentDraftSaveSeqRef` /
	 * `attachmentDraftHydratedKeyRef`) because they are stored in a SINGLE
	 * IndexedDB record per `(user, narrator)`. Two independent version counters
	 * would race on that one record: whichever kind saved last would write its own
	 * fresh list beside the other kind's stale one.
	 */
	const [attachedImages, setAttachedImages] = useState<File[]>([]);
	const openImageViewer = useImageViewer();
	const attachedImagesRef = useRef<File[]>(attachedImages);
	attachedImagesRef.current = attachedImages;
	const attachmentDraftHydratedKeyRef = useRef<string | null>(null);
	const attachmentDraftSaveSeqRef = useRef(0);
	const attachmentDraftLocalVersionRef = useRef(0);
	const [attachedTextFiles, setAttachedTextFiles] = useState<File[]>([]);
	// Mirrors `attachedTextFiles` for the same reason `attachedImagesRef` exists:
	// callers registered once (the user-chat forward bridge) must read the CURRENT
	// attachments without re-registering on every change.
	const attachedTextFilesRef = useRef<File[]>(attachedTextFiles);
	attachedTextFilesRef.current = attachedTextFiles;
	const [isDragging, setIsDragging] = useState(false);
	const dragCounterRef = useRef(0);
	const warnDraftAttachmentsPersistenceFailure = useCallback((action: string, err: unknown) => {
		if (import.meta.env.DEV) {
			console.warn(`[NarratorPanel] Failed to ${action} draft attachments:`, err);
		}
	}, []);
	const updateAttachedImages = useCallback((next: SetStateAction<File[]>) => {
		attachmentDraftLocalVersionRef.current++;
		setAttachedImages((prev) => {
			const resolved = typeof next === "function" ? (next as (prev: File[]) => File[])(prev) : next;
			attachedImagesRef.current = resolved;
			return resolved;
		});
	}, []);
	/**
	 * Text-file counterpart of `updateAttachedImages`.
	 *
	 * Every mutation of `attachedTextFiles` must go through this rather than the
	 * raw setter: it is what bumps the shared local-version counter, without which
	 * an in-flight hydrate would overwrite a file the user just attached.
	 */
	const updateAttachedTextFiles = useCallback((next: SetStateAction<File[]>) => {
		attachmentDraftLocalVersionRef.current++;
		setAttachedTextFiles((prev) => {
			const resolved = typeof next === "function" ? (next as (prev: File[]) => File[])(prev) : next;
			attachedTextFilesRef.current = resolved;
			return resolved;
		});
	}, []);
	const persistCurrentDraftAttachments = useCallback(
		(targetUserId: string, targetNarratorId: string) => {
			const seq = ++attachmentDraftSaveSeqRef.current;
			void saveDraftImageAttachments(
				targetUserId,
				targetNarratorId,
				attachedImagesRef.current,
				attachedTextFilesRef.current,
			).catch((err) => {
				if (seq === attachmentDraftSaveSeqRef.current) {
					warnDraftAttachmentsPersistenceFailure("save", err);
				}
			});
		},
		[warnDraftAttachmentsPersistenceFailure],
	);
	/**
	 * Clear the on-screen attachments for an in-flight send, WITHOUT touching the
	 * stored draft — a failed send restores them, and the record has to still be
	 * there for that to mean anything.
	 */
	const hideAttachedFilesForSend = useCallback(() => {
		attachmentDraftLocalVersionRef.current++;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		setAttachedImages([]);
		setAttachedTextFiles([]);
	}, []);
	const clearAttachedFilesAndDraft = useCallback(() => {
		attachmentDraftLocalVersionRef.current++;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		setAttachedImages([]);
		setAttachedTextFiles([]);
		if (!currentUserId) return;
		const seq = ++attachmentDraftSaveSeqRef.current;
		void clearDraftImageAttachments(currentUserId, narratorId).catch((err) => {
			if (seq === attachmentDraftSaveSeqRef.current) {
				warnDraftAttachmentsPersistenceFailure("clear", err);
			}
		});
	}, [currentUserId, narratorId, warnDraftAttachmentsPersistenceFailure]);

	useEffect(() => {
		let cancelled = false;
		const localVersionAtRequest = attachmentDraftLocalVersionRef.current;
		const draftKey = currentUserId ? getDraftImageAttachmentKey(currentUserId, narratorId) : null;
		attachmentDraftHydratedKeyRef.current = null;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		setAttachedImages([]);
		setAttachedTextFiles([]);
		if (!currentUserId || !draftKey) return;

		const persistLocalChanges = () => {
			if (attachmentDraftLocalVersionRef.current !== localVersionAtRequest) {
				persistCurrentDraftAttachments(currentUserId, narratorId);
			}
		};

		void loadDraftImageAttachments(currentUserId, narratorId)
			.then((loaded) => {
				if (cancelled) return;
				attachmentDraftHydratedKeyRef.current = draftKey;
				if (attachmentDraftLocalVersionRef.current === localVersionAtRequest) {
					attachedImagesRef.current = loaded.images;
					attachedTextFilesRef.current = loaded.textFiles;
					setAttachedImages(loaded.images);
					setAttachedTextFiles(loaded.textFiles);
					// An entry that was stored but cannot be rebuilt (blob evicted by the
					// browser, unreadable record) must be reported: silently restoring
					// two of three attachments looks like the user misremembered.
					if (loaded.droppedCount > 0) {
						notifications.show({
							color: "yellow",
							title: t("draftAttachmentsRestoreFailedTitle"),
							message: t("draftAttachmentsRestoreFailed", { count: loaded.droppedCount }),
						});
					}
				} else {
					persistLocalChanges();
				}
			})
			.catch((err) => {
				if (cancelled) return;
				warnDraftAttachmentsPersistenceFailure("load", err);
				attachmentDraftHydratedKeyRef.current = draftKey;
				persistLocalChanges();
			});

		return () => {
			cancelled = true;
		};
	}, [
		currentUserId,
		narratorId,
		persistCurrentDraftAttachments,
		warnDraftAttachmentsPersistenceFailure,
		t,
	]);

	useEffect(() => {
		if (
			!currentUserId ||
			sendingRef.current ||
			attachmentDraftHydratedKeyRef.current !==
				getDraftImageAttachmentKey(currentUserId, narratorId)
		)
			return;
		const seq = ++attachmentDraftSaveSeqRef.current;
		void saveDraftImageAttachments(
			currentUserId,
			narratorId,
			attachedImages,
			attachedTextFiles,
		).catch((err) => {
			if (seq === attachmentDraftSaveSeqRef.current) {
				warnDraftAttachmentsPersistenceFailure("save", err);
			}
		});
	}, [
		attachedImages,
		attachedTextFiles,
		currentUserId,
		narratorId,
		warnDraftAttachmentsPersistenceFailure,
	]);

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
	const [quotaDetailsOpened, setQuotaDetailsOpened] = useState(false);
	const quotaDetailsCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelQuotaDetailsClose = useCallback(() => {
		if (quotaDetailsCloseTimer.current) {
			clearTimeout(quotaDetailsCloseTimer.current);
			quotaDetailsCloseTimer.current = null;
		}
	}, []);
	const scheduleQuotaDetailsClose = useCallback(() => {
		cancelQuotaDetailsClose();
		quotaDetailsCloseTimer.current = setTimeout(() => {
			setQuotaDetailsOpened(false);
			quotaDetailsCloseTimer.current = null;
		}, 150);
	}, [cancelQuotaDetailsClose]);
	useEffect(() => () => cancelQuotaDetailsClose(), [cancelQuotaDetailsClose]);

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
	const [contextThresholdDraft, setContextThresholdDraft] =
		useState<ContextManagementDraft>(contextThresholdSettings);

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
		setContextThresholdDraft(contextThresholdSettings);
		openContextThresholdSettingsModal();
	}, [contextThresholdSettings, openContextThresholdSettingsModal]);
	const handleSaveContextThresholdSettings = useCallback(() => {
		const normalized: ContextManagementDraft = {
			contextThresholds: {
				standard: {
					pruneStart: Math.max(
						50,
						Math.min(100, Math.round(contextThresholdDraft.contextThresholds.standard.pruneStart)),
					),
					compactStart: Math.max(
						50,
						Math.min(
							100,
							Math.round(contextThresholdDraft.contextThresholds.standard.compactStart),
						),
					),
				},
				large: {
					pruneStart: Math.max(
						10,
						Math.min(100, Math.round(contextThresholdDraft.contextThresholds.large.pruneStart)),
					),
					compactStart: Math.max(
						10,
						Math.min(100, Math.round(contextThresholdDraft.contextThresholds.large.compactStart)),
					),
				},
			},
			autoCompactKeepPairs: Math.max(
				1,
				Math.min(25, Math.round(contextThresholdDraft.autoCompactKeepPairs)),
			),
			autoCompactPruneThreshold: Math.max(
				0,
				Math.min(100, Math.round(contextThresholdDraft.autoCompactPruneThreshold)),
			),
			minPruneRatio: Math.max(0, Math.min(100, Math.round(contextThresholdDraft.minPruneRatio))),
		};
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
					setContextThresholdDraft(normalized);
					closeContextThresholdSettings();
					notifications.show({ message: t("contextThresholdSettingsSaved"), color: "teal" });
				},
			},
		);
	}, [closeContextThresholdSettings, contextThresholdDraft, t, updateSettingsMutation]);
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

	// --- Retry countdown ---
	const [retryCountdown, setRetryCountdown] = useState<number>(0);
	useEffect(() => {
		if (!retryInfo) {
			setRetryCountdown(0);
			return;
		}
		const tick = () => {
			const remaining = Math.max(0, Math.ceil((retryInfo.retryAt - Date.now()) / 1000));
			setRetryCountdown(remaining);
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [retryInfo]);

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
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleValue, setTitleValue] = useState("");
	const [generatingTitle, setGeneratingTitle] = useState(false);
	const titleInputRef = useRef<HTMLInputElement>(null);
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

	const startEditingTitle = () => {
		setTitleValue(narrator?.title || "");
		setEditingTitle(true);
	};
	useEffect(() => {
		if (editingTitle) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		}
	}, [editingTitle]);
	const saveTitle = async () => {
		if (generatingTitle) return;
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== narrator?.title) {
			try {
				await api.updateNarratorTitle(narratorId, trimmed);
			} catch {
				// Stay in edit mode: the text the user typed is only in this input, and
				// leaving it would drop it. Without this the failure was invisible AND
				// unrecoverable — every click-away re-fired the blur handler and failed
				// again, so the field looked stuck for no stated reason.
				notifications.show({ message: t("titleUpdateFailed"), color: "red", autoClose: 4000 });
				return;
			}
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		}
		setEditingTitle(false);
	};
	const handleGenerateTitle = async () => {
		setGeneratingTitle(true);
		try {
			const { title } = await api.generateNarratorTitle(narratorId);
			setTitleValue(title);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		} catch {
			notifications.show({ message: t("generateTitleFailed"), color: "red", autoClose: 4000 });
		} finally {
			setGeneratingTitle(false);
		}
	};
	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		// See AskInPassingCard: Enter during IME composition is the candidate pick,
		// not a submit.
		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			e.preventDefault();
			saveTitle();
		} else if (e.key === "Escape") {
			setEditingTitle(false);
		}
	};

	// --- Long-press interrupt ---
	const [interruptProgress, setInterruptProgress] = useState(0);
	const interruptTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const interruptFiredRef = useRef(false);
	const clearInterruptTimer = useCallback(() => {
		if (interruptTimerRef.current) {
			clearInterval(interruptTimerRef.current);
			interruptTimerRef.current = null;
		}
		setInterruptProgress(0);
		interruptFiredRef.current = false;
	}, []);
	const interruptMutationRef = useRef(interruptMutation);
	interruptMutationRef.current = interruptMutation;
	const narratorIdRef = useRef(narratorId);
	narratorIdRef.current = narratorId;
	const clearInterruptTimerRef = useRef(clearInterruptTimer);
	clearInterruptTimerRef.current = clearInterruptTimer;

	const startInterruptPress = useCallback((_e: React.MouseEvent) => {
		interruptFiredRef.current = false;
		const start = Date.now();
		const duration = 600;
		interruptTimerRef.current = setInterval(() => {
			const elapsed = Date.now() - start;
			const pct = Math.min(elapsed / duration, 1);
			setInterruptProgress(pct);
			if (pct >= 1 && !interruptFiredRef.current) {
				interruptFiredRef.current = true;
				if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
				interruptTimerRef.current = null;
				interruptMutationRef.current.mutate(narratorIdRef.current);
			}
		}, 16);
	}, []);
	const interruptBtnCleanupRef = useRef<(() => void) | null>(null);
	const interruptBtnRef = useCallback((btn: HTMLButtonElement | null) => {
		if (interruptBtnCleanupRef.current) {
			interruptBtnCleanupRef.current();
			interruptBtnCleanupRef.current = null;
		}
		if (!btn) return;
		const onTouchStart = (e: TouchEvent) => {
			e.preventDefault();
			interruptFiredRef.current = false;
			const start = Date.now();
			const duration = 600;
			interruptTimerRef.current = setInterval(() => {
				const elapsed = Date.now() - start;
				const pct = Math.min(elapsed / duration, 1);
				setInterruptProgress(pct);
				if (pct >= 1 && !interruptFiredRef.current) {
					interruptFiredRef.current = true;
					if (interruptTimerRef.current != null) clearInterval(interruptTimerRef.current);
					interruptTimerRef.current = null;
					interruptMutationRef.current.mutate(narratorIdRef.current);
				}
			}, 16);
		};
		const onTouchEnd = () => handleInterruptMouseUpRef.current();
		const onTouchCancel = () => clearInterruptTimerRef.current();
		btn.addEventListener("touchstart", onTouchStart, { passive: false });
		btn.addEventListener("touchend", onTouchEnd);
		btn.addEventListener("touchcancel", onTouchCancel);
		interruptBtnCleanupRef.current = () => {
			btn.removeEventListener("touchstart", onTouchStart);
			btn.removeEventListener("touchend", onTouchEnd);
			btn.removeEventListener("touchcancel", onTouchCancel);
		};
	}, []);
	const handleInterruptMouseUp = useCallback(() => {
		if (!interruptFiredRef.current && interruptTimerRef.current) {
			notifications.show({
				message: t("interruptHoldHint"),
				color: "yellow",
			});
		}
		clearInterruptTimer();
	}, [clearInterruptTimer, t]);
	const handleInterruptMouseUpRef = useRef(handleInterruptMouseUp);
	handleInterruptMouseUpRef.current = handleInterruptMouseUp;

	useEffect(() => clearInterruptTimer, [clearInterruptTimer]);

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

	// --- Multi-select state ---
	const [selectionMode, setSelectionMode] = useState(false);
	const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
	const [anchorBlockId, setAnchorBlockId] = useState<string | null>(null);
	const [chunkSelectionResolver, setChunkSelectionResolver] =
		useState<MessageSelectionResolver | null>(null);

	const exitSelection = useCallback(() => {
		setSelectionMode(false);
		setSelectedBlockIds(new Set());
		setAnchorBlockId(null);
		setGlobalSwipeAnchor(null);
		// Close any open swipe
		const closeFn = getGlobalCloseSwipe();
		if (closeFn) closeFn();
	}, []);

	const deselectBlock = useCallback((blockId: string) => {
		setSelectedBlockIds((prev) => {
			const next = new Set(prev);
			next.delete(blockId);
			if (next.size === 0) {
				setSelectionMode(false);
				setAnchorBlockId(null);
				setGlobalSwipeAnchor(null);
			}
			return next;
		});
	}, []);

	// Desktop: Ctrl/Cmd+Click toggles a single block
	const toggleBlock = useCallback((blockId: string) => {
		setSelectedBlockIds((prev) => {
			const next = new Set(prev);
			if (next.has(blockId)) {
				next.delete(blockId);
				if (next.size === 0) {
					setSelectionMode(false);
					setAnchorBlockId(null);
					return next;
				}
			} else {
				chunkListRef.current?.detachFromBottom();
				next.add(blockId);
				setSelectionMode(true);
				setAnchorBlockId(blockId);
			}
			return next;
		});
	}, []);

	const applyRangeSelection = useCallback(
		(anchor: string, target: string, updateAnchor = false) => {
			const applyDomFallback = () => {
				const container = contentRef.current;
				if (!container) return;
				const range = resolveBlockRange(container, anchor, target);
				if (!range) return;
				chunkListRef.current?.detachFromBottom();
				setSelectionMode(true);
				setSelectedBlockIds(range);
				if (updateAnchor) setAnchorBlockId(anchor);
			};

			const resolver = chunkSelectionResolver;
			const resolved = resolver?.resolveRange?.(anchor, target);
			if (!resolved) {
				applyDomFallback();
				return;
			}
			Promise.resolve(resolved)
				.then((range) => {
					if (!range) {
						applyDomFallback();
						return;
					}
					chunkListRef.current?.detachFromBottom();
					setSelectionMode(true);
					setSelectedBlockIds(range);
					if (updateAnchor) setAnchorBlockId(anchor);
				})
				.catch(applyDomFallback);
		},
		[chunkSelectionResolver],
	);

	// Desktop: Shift+Click range-selects from anchor to target
	const rangeSelectTo = useCallback(
		(blockId: string) => {
			const anchor = anchorBlockId;
			if (!anchor) {
				// No anchor yet — treat as single toggle
				chunkListRef.current?.detachFromBottom();
				setSelectionMode(true);
				setSelectedBlockIds(new Set([blockId]));
				setAnchorBlockId(blockId);
				return;
			}
			applyRangeSelection(anchor, blockId);
		},
		[anchorBlockId, applyRangeSelection],
	);

	// Register the global range-selection callback so useSwipeMenu instances
	// can trigger multi-select without prop drilling.
	useEffect(() => {
		const handler = (anchor: string, target: string) => applyRangeSelection(anchor, target, true);
		setGlobalOnSelectionRange(handler);
		return () => setGlobalOnSelectionRange(null);
	}, [applyRangeSelection]);

	// Register toggle callback so useSwipeMenu can add/remove blocks
	// from the selection when multi-select mode is already active.
	useEffect(() => {
		if (selectionMode) {
			setGlobalToggleBlock(toggleBlock);
			return () => setGlobalToggleBlock(null);
		}
		setGlobalToggleBlock(null);
	}, [selectionMode, toggleBlock]);

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

	// Clear selection when narrator changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId is intentionally a dependency to reset selection on narrator switch
	useEffect(() => {
		exitSelection();
	}, [narratorId, exitSelection]);

	// Escape key exits multi-select mode
	useEffect(() => {
		if (!selectionMode) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				exitSelection();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectionMode, exitSelection]);

	// --- Floating toolbar position — clamp to selected blocks' bounding box ---
	const selectionToolbarRef = useRef<HTMLDivElement>(null);
	const selectionToolbarParentRef = useRef<HTMLDivElement>(null);
	const [selectionToolbarTop, setSelectionToolbarTop] = useState<number | null>(null);

	useEffect(() => {
		if (!selectionMode || selectedBlockIds.size === 0) {
			setSelectionToolbarTop(null);
			return;
		}
		const container = contentRef.current;
		const scrollEl = viewportRef.current;
		const parentEl = selectionToolbarParentRef.current;
		if (!container || !scrollEl) return;

		const reposition = () => {
			const els = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
			let minTop = Number.POSITIVE_INFINITY;
			let maxBottom = Number.NEGATIVE_INFINITY;
			for (const el of els) {
				const bid = el.getAttribute(BLOCK_ID_ATTR);
				if (!bid || !selectedBlockIds.has(bid)) continue;
				const r = el.getBoundingClientRect();
				if (r.top < minTop) minTop = r.top;
				if (r.bottom > maxBottom) maxBottom = r.bottom;
			}
			if (!Number.isFinite(minTop)) return;
			const menuH = selectionToolbarRef.current?.offsetHeight ?? 160;
			const half = menuH / 2;
			// Clamp against the message-area container (not the viewport) so the
			// toolbar never slides under the composer / status bar below it. The
			// toolbar is absolutely positioned inside this container, so the final
			// `top` must be expressed in the container's local coordinate space.
			const parentRect = parentEl?.getBoundingClientRect();
			const boundTop = parentRect?.top ?? 0;
			const boundBottom = parentRect?.bottom ?? scrollEl.getBoundingClientRect().bottom;
			const boundCenter = (boundTop + boundBottom) / 2;
			// Prefer the container's vertical center, but stay within the selected
			// blocks' bounds so the toolbar visually tracks the selection.
			let top = Math.max(minTop + half, Math.min(boundCenter, maxBottom - half));
			// Clamp so the whole menu stays inside the container (above the composer).
			top = Math.max(boundTop + half, Math.min(top, boundBottom - half));
			// Convert from viewport coordinates to the container's local space.
			setSelectionToolbarTop(top - boundTop);
		};

		reposition();
		scrollEl.addEventListener("scroll", reposition, { passive: true });
		window.addEventListener("resize", reposition, { passive: true });
		return () => {
			scrollEl.removeEventListener("scroll", reposition);
			window.removeEventListener("resize", reposition);
		};
	}, [selectionMode, selectedBlockIds]);

	// --- Batch copy ---
	const handleBatchCopy = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let selectedText = chunkSelectionResolver?.collectSelectedText
			? chunkSelectionResolver.collectSelectedText(selectedBlockIds)
			: contentRef.current
				? collectSelectedText(contentRef.current, selectedBlockIds, handleRegistry)
				: { text: "", truncated: false };
		if (!selectedText.text && contentRef.current) {
			selectedText = collectSelectedText(contentRef.current, selectedBlockIds, handleRegistry);
		}
		if (!selectedText.text) return;
		try {
			await navigator.clipboard.writeText(selectedText.text);
			notifications.show({
				message: t(selectedText.truncated ? "batchCopySuccessTruncated" : "batchCopySuccess", {
					count: selectedBlockIds.size,
				}),
				color: selectedText.truncated ? "yellow" : "teal",
			});
		} catch {
			// Fallback: some browsers block clipboard in non-secure contexts
		}
		exitSelection();
	}, [selectedBlockIds, chunkSelectionResolver, exitSelection, t]);

	// --- Batch delete ---
	const handleBatchDelete = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let metas = chunkSelectionResolver?.resolveSelectedMeta
			? chunkSelectionResolver.resolveSelectedMeta(selectedBlockIds)
			: contentRef.current
				? resolveSelectedBlockMeta(contentRef.current, selectedBlockIds)
				: [];
		if (metas.length === 0 && contentRef.current) {
			metas = resolveSelectedBlockMeta(contentRef.current, selectedBlockIds);
		}
		if (metas.length === 0) return;
		// Confirm
		const ok = await confirm({ message: t("batchDeleteConfirm", { count: metas.length }) });
		if (!ok) return;
		exitSelection();
		try {
			const res = await api.deleteMessageBlocks(
				narratorId,
				metas.map((m) => ({ messageId: m.messageId, blockIndex: m.blockIndex })),
			);
			// Always re-fetch from server to ensure consistency
			chunkListRef.current?.refreshStructure("full");
			if (res.failed > 0) {
				notifications.show({ message: t("batchDeleteFailed"), color: "orange" });
			}
		} catch {
			// Network / unexpected error — re-fetch to reflect whatever actually happened
			chunkListRef.current?.refreshStructure("full");
			notifications.show({ message: t("batchDeleteFailed"), color: "red" });
		}
	}, [selectedBlockIds, chunkSelectionResolver, exitSelection, narratorId, t, confirm]);

	// --- Batch fork ---
	const handleBatchFork = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let messageIds = chunkSelectionResolver?.resolveSelectedMessageIds
			? chunkSelectionResolver.resolveSelectedMessageIds(selectedBlockIds)
			: contentRef.current
				? resolveSelectedMessageIds(contentRef.current, selectedBlockIds)
				: [];
		if (messageIds.length === 0 && contentRef.current) {
			messageIds = resolveSelectedMessageIds(contentRef.current, selectedBlockIds);
		}
		if (messageIds.length === 0) return;
		exitSelection();
		try {
			const newNarrator = await api.forkFromMessages(narratorId, messageIds);
			notifications.show({
				message: t("batchForkSuccess", { count: messageIds.length }),
				color: "teal",
			});
			navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarrator.id } });
		} catch {
			notifications.show({ message: t("batchForkFailed"), color: "red" });
		}
	}, [selectedBlockIds, chunkSelectionResolver, exitSelection, narratorId, navigate, t]);

	// --- Segment compact ---
	const handleSegmentCompact = useCallback(async () => {
		if (!compactSupported) {
			notifications.show({
				title: t("compactUnsupportedTitle"),
				message: compactUnsupportedReason,
				color: "yellow",
			});
			return;
		}
		if (selectedBlockIds.size === 0) return;
		let messageIds = chunkSelectionResolver?.resolveSelectedMessageIds
			? chunkSelectionResolver.resolveSelectedMessageIds(selectedBlockIds)
			: contentRef.current
				? resolveSelectedMessageIds(contentRef.current, selectedBlockIds)
				: [];
		if (messageIds.length === 0 && contentRef.current) {
			messageIds = resolveSelectedMessageIds(contentRef.current, selectedBlockIds);
		}
		if (messageIds.length === 0) return;
		const segmentCompactConfirmMessage = compactUsesFallbackSummary
			? `${t("segmentCompactConfirm", { count: messageIds.length })}\n\n${compactFallbackSummaryReason}`
			: t("segmentCompactConfirm", { count: messageIds.length });
		if (!(await confirm({ message: segmentCompactConfirmMessage }))) return;
		exitSelection();
		try {
			// Compacting state will arrive via substatus_change WS event
			await api.triggerSegmentCompact(narratorId, messageIds);
		} catch (err) {
			const isInProgress = err instanceof ApiError && err.status === 409;
			notifications.show({
				title: isInProgress ? t("compactInProgress") : t("segmentCompactFailed"),
				message: isInProgress ? t("compactInProgressDesc") : t("segmentCompactFailedDesc"),
				color: isInProgress ? "yellow" : "red",
				autoClose: 5000,
			});
		}
	}, [
		selectedBlockIds,
		exitSelection,
		chunkSelectionResolver,
		narratorId,
		t,
		confirm,
		compactSupported,
		compactUnsupportedReason,
		compactUsesFallbackSummary,
		compactFallbackSummaryReason,
	]);

	const selectionCtxValue = useMemo<MessageSelectionState>(
		() => ({
			selectionMode,
			selectedBlockIds,
			anchorBlockId,
			exitSelection,
			deselectBlock,
			toggleBlock,
			rangeSelectTo,
		}),
		[
			selectionMode,
			selectedBlockIds,
			anchorBlockId,
			exitSelection,
			deselectBlock,
			toggleBlock,
			rangeSelectTo,
		],
	);

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
	const dockOpenFilePanel = dock?.openFilePanel;
	const useInternalFileViewer = !dockOpenFilePanel && !isWorkspacePreview;
	const handleOpenFilePanel = useMemo(() => {
		if (dockOpenFilePanel) return (filePath: string) => dockOpenFilePanel(filePath);
		if (useInternalFileViewer) return (filePath: string) => setInternalFileViewerPath(filePath);
		return undefined;
	}, [dockOpenFilePanel, useInternalFileViewer]);

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
		) => {
			if (!result?.buffered || !result.id) return false;

			const queuedMessage: BufferMessageSummary = {
				id: result.id,
				text,
				bufferedAt: result.bufferedAt ?? new Date().toISOString(),
				imageCount,
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
	) => {
		const optimisticBlocks: ContentBlock[] = [
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
				applyBufferedSendResult(result, msg, images.length);
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
	): Promise<boolean> => {
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
			);
			const buffered = applyBufferedSendResult(result, msg, images.length, priority);
			composerRef.current?.commitDraftAfterSend();
			clearAttachedFilesAndDraft();
			// Whether the message was buffered (202) or the backend fell through
			// to a direct send (201), scroll so the new content is visible.
			scrollToBottom(true);
			return buffered;
		} catch (err) {
			// Restore input and attachments on error
			composerRef.current?.setText(msg);
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
	 * is what {@link COMPACT_QUEUE_MODES} offers. `mode` maps onto it as "turn" =
	 * wait, anything else = run now (`priority` opts out of the server-side queue).
	 *
	 * When the narrator is fully idle, `mode` is ignored and the message is sent
	 * directly (an idle session is never interrupted). `/new` while active always
	 * uses the normal queue regardless of mode — spawning a new narrator should
	 * not interrupt the current turn.
	 */
	const handleSendWithMode = async (mode: "turn" | "tool" | "interrupt") => {
		const composerText = composerRef.current?.getText() ?? "";
		const msg = composerText.trim();
		const attachmentCount = attachedImages.length + attachedTextFiles.length;
		// An attachment-only message is a valid turn: images (and text files) carry the
		// content by themselves, so an empty textarea must not block the send.
		if (
			!hasSendableComposerContent({
				text: composerText,
				imageCount: attachedImages.length,
				textFileCount: attachedTextFiles.length,
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
		let restoreOnError: { msg: string; images: File[]; textFiles: File[] } | null = null;
		try {
			composerRef.current?.noteSent(msg);

			const newMatch = msg.match(/^\/new(?:\s+([\s\S]*))?$/);
			if (newMatch) {
				if (isActive) {
					// /new while active: always normal queue (never interrupt to spawn).
					await doSendBuffered(msg);
					return;
				}

				const initialMessage = newMatch[1]?.trim() ?? "";
				const images = [...attachedImages];
				const textFiles = [...attachedTextFiles];
				restoreOnError = { msg, images, textFiles };
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
				restoreOnError = { msg, images, textFiles };
				composerRef.current?.hideTextForSend();
				hideAttachedFilesForSend();
				await submitMessage(msg, images, textFiles, abortController.signal, mode !== "turn");
				composerRef.current?.commitDraftAfterSend();
				clearAttachedFilesAndDraft();
				restoreOnError = null;
				return;
			}
			const images = [...attachedImages];
			const textFiles = [...attachedTextFiles];
			// Remember the draft so a cancelled upload can restore it — submitMessage
			// clears the input/attachments up-front for the optimistic bubble.
			restoreOnError = { msg, images, textFiles };
			composerRef.current?.hideTextForSend();
			hideAttachedFilesForSend();
			await submitMessage(msg, images, textFiles, abortController.signal);
			composerRef.current?.commitDraftAfterSend();
			clearAttachedFilesAndDraft();
			restoreOnError = null;
		} catch (err) {
			// Restore the drafted input/attachments so the user doesn't lose their
			// message. `doSendBuffered` already restores internally on its own throw;
			// this covers the `/new` and idle direct-send paths.
			if (restoreOnError) {
				composerRef.current?.setText(restoreOnError.msg);
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
	const forwardTextToNarrator = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			void (async () => {
				const preservedDraft = composerRef.current?.getText() ?? "";
				const preservedImages = attachedImagesRef.current;
				const preservedTextFiles = attachedTextFilesRef.current;
				try {
					// Forward-only send: no attachments, and the in-progress draft is put
					// back afterwards so the operator does not lose what they were typing.
					composerRef.current?.setText(trimmed);
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
					composerRef.current?.setText(preservedDraft);
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
	const [queueHoldProgress, setQueueHoldProgress] = useState(0);
	const queueHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const queueHoldFiredRef = useRef(false);
	const queueClickSuppressedRef = useRef(false);
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
	const clearQueueHoldTimer = useCallback(() => {
		if (queueHoldTimerRef.current) {
			clearInterval(queueHoldTimerRef.current);
			queueHoldTimerRef.current = null;
		}
		setQueueHoldProgress(0);
	}, []);
	const startQueueHold = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			clearQueueHoldTimer();
			queueHoldFiredRef.current = false;
			queueClickSuppressedRef.current = false;
			const start = Date.now();
			const duration = 600;
			queueHoldTimerRef.current = setInterval(() => {
				const elapsed = Date.now() - start;
				const pct = Math.min(elapsed / duration, 1);
				setQueueHoldProgress(pct);
				if (pct >= 1 && !queueHoldFiredRef.current) {
					queueHoldFiredRef.current = true;
					queueClickSuppressedRef.current = true;
					if (queueHoldTimerRef.current != null) {
						clearInterval(queueHoldTimerRef.current);
						queueHoldTimerRef.current = null;
					}
					void handleSendWithModeRef.current(ctrlEnterQueueModeRef.current);
				}
			}, 16);
		},
		[clearQueueHoldTimer],
	);
	const cancelQueueHold = useCallback(() => {
		if (queueHoldFiredRef.current) queueClickSuppressedRef.current = true;
		clearQueueHoldTimer();
		queueHoldFiredRef.current = false;
	}, [clearQueueHoldTimer]);
	const handleQueuePointerUp = useCallback(() => {
		if (queueHoldFiredRef.current) queueClickSuppressedRef.current = true;
		clearQueueHoldTimer();
		queueHoldFiredRef.current = false;
	}, [clearQueueHoldTimer]);
	const handleQueueClick = useCallback(() => {
		if (queueClickSuppressedRef.current) {
			queueClickSuppressedRef.current = false;
			return;
		}
		void handleSendRef.current();
	}, []);
	useEffect(() => cancelQueueHold, [cancelQueueHold]);

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

	const handleCancelAllQueued = () => {
		if (queuedMessages.length > 0) {
			cancelBuffer(narratorId);
			// Restore the first queued message text to the input
			composerRef.current?.setText(queuedMessages[0].text);
			setQueuedMessages([]);
		}
	};

	const handleRemoveQueued = (messageId: string) => {
		const msg = queuedMessages.find((m) => m.id === messageId);
		const snapshot = queuedMessages;
		setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
		// If removing the only message, restore its text to input
		if (queuedMessages.length === 1 && msg) {
			composerRef.current?.setText(msg.text);
		}
		api.removeBufferedMessage(narratorId, messageId).catch(() => {
			// Rollback on failure
			setQueuedMessages(snapshot);
			if (queuedMessages.length === 1 && msg) {
				composerRef.current?.setText("");
			}
		});
	};

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
	);

	const handleDragEndQueued = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const oldIndex = queuedMessages.findIndex((m) => m.id === active.id);
			const newIndex = queuedMessages.findIndex((m) => m.id === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const newOrder = [...queuedMessages];
			const [moved] = newOrder.splice(oldIndex, 1);
			newOrder.splice(newIndex, 0, moved);
			const snapshot = queuedMessages;
			setQueuedMessages(newOrder);
			api
				.reorderBufferedMessages(
					narratorId,
					newOrder.map((m) => m.id),
				)
				.catch(() => {
					setQueuedMessages(snapshot);
				});
		},
		[queuedMessages, narratorId, setQueuedMessages],
	);

	const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
	const [queueExpanded, setQueueExpanded] = useState(false);

	// Auto-reset expanded state when queue shrinks to ≤2
	useEffect(() => {
		if (queuedMessages.length <= QUEUE_COLLAPSE_THRESHOLD) setQueueExpanded(false);
	}, [queuedMessages.length]);

	const handleStartEditQueued = useCallback((msg: { id: string }) => {
		setEditingQueuedId(msg.id);
	}, []);

	const handleCancelEditQueued = useCallback(() => {
		setEditingQueuedId(null);
	}, []);

	/**
	 * Persist an edited queued message.
	 *
	 * Only the text is updated optimistically. Attachments are not: the client
	 * cannot invent the imageId of an upload the server has not accepted yet, and
	 * a wrong guess would render a broken thumbnail. The authoritative
	 * `buffer_set` broadcast that follows a successful edit carries the real set.
	 *
	 * Returns false on failure so the row keeps the draft open with the user's
	 * selected files intact.
	 */
	const handleSaveEditQueued = useCallback(
		async (
			msg: BufferMessageSummary,
			text: string,
			payload: {
				keepImageIds: string[];
				keepTextFiles: { index: number; filename: string }[];
				newImages: File[];
				newTextFiles: File[];
			},
		): Promise<boolean> => {
			const snapshot = queuedMessages;
			setQueuedMessages((prev) =>
				prev.map((m) =>
					m.id === msg.id ? { ...m, text, bufferedAt: new Date().toISOString() } : m,
				),
			);
			try {
				await api.updateBufferedMessage(narratorId, msg.id, text, payload);
				return true;
			} catch (err) {
				setQueuedMessages(snapshot);
				notifications.show({
					color: "red",
					title: t("editQueuedFailed"),
					message: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		},
		[queuedMessages, setQueuedMessages, narratorId, t],
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
	});
	// `compactProgressText` is non-null whenever either compact flag is set; the
	// fallback only keeps the template from interpolating "null".
	const compactProgressFragment = compactProgressText ?? "";

	// The single line the work indicator shows. Kept as a string (not inline JSX)
	// so the status bar can hand the exact same text to the overflow tooltip.
	const workIndicatorText = ((): string => {
		switch (workIndicatorPlan.primary) {
			case "retrying":
				return retryCountdown > 0
					? t("retryingCountdown", {
							count: retryInfo?.retryCount,
							max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
							seconds: retryCountdown,
						})
					: t("retryingNow", {
							count: retryInfo?.retryCount,
							max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
						});
			case "blocking_compact":
				return `${t("compacting")} · ${compactProgressFragment}`;
			case "model_unavailable":
				return t("status_model_unavailable");
			case "spec_task":
				return currentSpecTask?.text ?? t("thinking");
			case "waiting":
				return t("status_waiting");
			case "planning":
				return t("planning");
			case "background_compact":
				return `${t("backgroundCompacting")} · ${compactProgressFragment}`;
			default:
				return t("thinking");
		}
	})();

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
						prune: activePruneStart ?? modelThresholds?.pruneStart,
						compact: activeCompactStart ?? modelThresholds?.compactStart,
						force: forceCompactPruneThreshold,
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
				{prunedPercent != null && (
					<Menu.Label>{t("prunedPercent", { percent: prunedPercent })}</Menu.Label>
				)}
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
				<Tooltip label={t("pruneEnabledTooltip")} multiline w={260} withArrow position="top">
					<Menu.Label>
						<Stack gap={4}>
							<Switch
								size="xs"
								label={t("pruneEnabled")}
								checked={pruneEnabledEffective}
								onChange={(e) => {
									pruneEnabledMutation.mutate({
										id: narratorId,
										pruneEnabled: e.currentTarget.checked,
									});
								}}
							/>
							{pruneEnabledEffective && (
								<Text size="xs" c="orange">
									{t("pruneEnabledWarning")}
								</Text>
							)}
							{pruneDiffersFromDefault && (
								<Group justify="space-between" wrap="nowrap" style={{ width: "100%" }}>
									<Anchor
										component="button"
										type="button"
										size="xs"
										c="dimmed"
										style={{ textDecoration: "underline" }}
										onClick={(event) => {
											event.stopPropagation();
											pruneEnabledMutation.mutate({
												id: narratorId,
												pruneEnabled: pruneEnabledGlobal,
											});
										}}
									>
										{t("pruneEnabledResetDefault")}
									</Anchor>
									<Anchor
										component="button"
										type="button"
										size="xs"
										c="dimmed"
										style={{ textDecoration: "underline" }}
										onClick={(event) => {
											event.stopPropagation();
											updateSettingsMutation.mutate({
												agent: { defaultPruneEnabled: pruneEnabledEffective },
											});
										}}
									>
										{t("pruneEnabledSetDefault")}
									</Anchor>
								</Group>
							)}
						</Stack>
					</Menu.Label>
				</Tooltip>
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

	const renderFastModeControl = (position: "top-end" | "bottom-end") => (
		<Popover
			opened={fastModeSettingsOpened}
			onChange={setFastModeSettingsOpened}
			onClose={closeFastModeSettings}
			position={position}
			width={fastModeUsesTapSettings ? 280 : 320}
			shadow="md"
			withinPortal
		>
			<Popover.Target>
				<Group
					gap={4}
					wrap="nowrap"
					onMouseEnter={fastModeUsesTapSettings ? undefined : openFastModeSettings}
					onMouseLeave={fastModeUsesTapSettings ? undefined : scheduleFastModeSettingsClose}
					style={{ flexShrink: 0 }}
				>
					<Tooltip
						label={
							fastModeOverride === "inherit"
								? t("fast_mode_inherit_tooltip", {
										state: fastModeDefault ? t("fast_mode_on") : t("fast_mode_off"),
									})
								: t("fast_mode_tooltip")
						}
						position={position.startsWith("top") ? "top" : "bottom"}
						disabled={fastModeSettingsOpened}
					>
						<ActionIcon
							variant="subtle"
							color={fastModeEnabled ? "yellow" : "gray"}
							size="sm"
							aria-label={t("fast_mode")}
							onPointerDown={startFastModeLongPress}
							onPointerUp={clearFastModeLongPressTimer}
							onPointerCancel={clearFastModeLongPressTimer}
							onPointerLeave={clearFastModeLongPressTimer}
							onContextMenu={(event) => event.preventDefault()}
							onClick={(event) => {
								if (fastModeLongPressFiredRef.current) {
									event.preventDefault();
									event.stopPropagation();
									fastModeLongPressFiredRef.current = false;
									return;
								}
								// Clicking pins this session against its current effective
								// state; the popover restores "follow default".
								fastModeMutation.mutate({
									id: narratorId,
									fastModeOverride: fastModeEnabled ? "off" : "on",
								});
							}}
						>
							<IconBolt size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Popover.Target>
			<Popover.Dropdown
				onMouseEnter={fastModeUsesTapSettings ? undefined : openFastModeSettings}
				onMouseLeave={fastModeUsesTapSettings ? undefined : scheduleFastModeSettingsClose}
			>
				<Stack gap={8}>
					<Text size="sm" fw={600}>
						{t("fast_mode")}
					</Text>
					<SegmentedControl
						size="xs"
						fullWidth
						value={fastModeOverride}
						onChange={(value) =>
							fastModeMutation.mutate({
								id: narratorId,
								fastModeOverride: value as "inherit" | "on" | "off",
							})
						}
						data={[
							{
								value: "inherit",
								label: t("fast_mode_session_inherit", {
									state: fastModeDefault ? t("fast_mode_on") : t("fast_mode_off"),
								}),
							},
							{ value: "on", label: t("fast_mode_on") },
							{ value: "off", label: t("fast_mode_off") },
						]}
					/>
					<Text size="xs" c="dimmed">
						{t("fast_mode_session_desc")}
					</Text>
					<Switch
						size="sm"
						checked={fastModeDefault}
						onChange={(event) =>
							updateUserPrefs.mutate({ fastModeDefault: event.currentTarget.checked })
						}
						label={t("fast_mode_default_switch")}
					/>
					<Text size="xs" c="dimmed">
						{fastModeDefault ? t("fast_mode_default_on_desc") : t("fast_mode_default_off_desc")}
					</Text>
					<Text size="xs" c="dimmed">
						{fastModeUsesTapSettings ? t("fast_mode_mobile_hint") : t("fast_mode_desktop_hint")}
					</Text>
				</Stack>
			</Popover.Dropdown>
		</Popover>
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
			<ContentViewerEnvironmentProvider value={contentViewerEnvironment}>
				<Stack
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
							<Group ref={headerToolbarRef} gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
								{/*
								 * Registry-driven tool entries. The SET comes from the registry, the
								 * ORDER from the user's saved layout, and how many are surfaced from
								 * the measured width of this row (mobile additionally caps by count).
								 * Entries that do not fit move into the overflow menu instead of
								 * compressing the title, which is what the row used to do. Entries the
								 * host cannot present are absent from both lists rather than rendered
								 * disabled — but they stay in the layout, so they return on a surface
								 * that supports them.
								 */}
								{toolbarVisibleDefs.map((def) => {
									const Icon = def.icon;
									const badge = resolveNarratorToolbarBadge(def.badge, toolbarBadgeCounts);
									const active = toolbarEntryActive(def.id);
									const label = t(def.labelKey, { ns: def.namespace ?? "narrator" });

									// The device entry opens a list of targets rather than toggling a
									// panel, so it renders its own Menu instead of a toggle button.
									if (def.id === "device") {
										return (
											<ExecutionDeviceMenu
												key={def.id}
												label={t("executionDeviceSelector")}
												localLabel={t("executionTargetLocal")}
												offlineLabel={t("executionDeviceOffline")}
												devices={executionDevicesQuery.data?.devices ?? []}
												currentDeviceId={executionDevicesQuery.data?.defaultDeviceId ?? "local"}
												pending={updateExecutionDeviceMutation.isPending}
												onSelect={(deviceId) => updateExecutionDeviceMutation.mutate(deviceId)}
											/>
										);
									}

									if (def.id === "lodlevel") {
										return (
											<NarratorLodMenu
												key={def.id}
												lod={renderLod}
												isDefault={renderLodIsDefault}
												onSelectLod={handleSelectLod}
												onSetAsDefault={setAsDefault}
											/>
										);
									}

									if (def.id === "plugins") {
										return (
											<PluginContributionPicker
												key={def.id}
												onPick={openPluginPanel}
												surface="focus"
												trigger={
													<Tooltip label={label}>
														<ActionIcon size="sm" variant="subtle" color="gray" aria-label={label}>
															<Icon size={16} />
														</ActionIcon>
													</Tooltip>
												}
											/>
										);
									}

									const button = (
										<ActionIcon
											size="sm"
											variant={active ? "light" : "subtle"}
											color={active ? "indigo" : "gray"}
											aria-label={label}
											onClick={() => activateToolbarEntry(def.id)}
										>
											<Icon size={16} />
										</ActionIcon>
									);

									return (
										<Tooltip key={def.id} label={label}>
											{badge.count > 0 ? (
												<Indicator
													inline
													// Running work reads as a state, not a quantity, so it pulses
													// instead of printing a number (matches the old tasks button).
													size={badge.processing ? 8 : 14}
													offset={badge.processing ? 3 : 4}
													label={badge.processing ? undefined : badge.label}
													processing={badge.processing}
													color={badge.processing ? "blue" : "teal"}
													zIndex={1}
													style={{
														height: "var(--ai-size-sm)",
														display: "flex",
														alignItems: "center",
													}}
												>
													{button}
												</Indicator>
											) : (
												button
											)}
										</Tooltip>
									);
								})}
								{/* TEMPORARY mock-stream harness entry — see ./mock/README-REMOVAL.md.
								    Deliberately NOT in the registry: it is debug-only and due for
								    removal, so it must not occupy a persisted layout id. */}
								{dock && mockStreamEnabled && (
									<Tooltip label="Mock stream (debug)">
										<ActionIcon
											{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
											size="sm"
											variant={dock.openToolTypes.has("mock") ? "light" : "subtle"}
											color={dock.openToolTypes.has("mock") ? "indigo" : "gray"}
											onClick={() => dock.toggleToolPanel("mock")}
										>
											<IconFlask size={16} />
										</ActionIcon>
									</Tooltip>
								)}
								{/*
								 * Overflow menu: lists everything not on the row (tucked by the user or
								 * collapsed for width), carries the aggregate badge so a hidden unread
								 * count is not lost, and owns the reorder UI. Archive lives at its
								 * bottom — a destructive action must not sit one mis-tap away from the
								 * panel toggles.
								 */}
								<NarratorToolbarOverflowMenu
									entries={toolbarEntries}
									hiddenDefs={toolbarHiddenDefs}
									noRoomIds={toolbarNoRoomIds}
									onSaveLayout={saveToolbarLayout}
									hostCapabilities={headerHostCapabilities}
									badgeCounts={toolbarBadgeCounts}
									onActivate={activateToolbarEntry}
									renderInlineOptions={renderToolbarInlineOptions}
									onArchive={openArchiveConfirm}
									archiveLoading={archiveMutation.isPending}
								/>
								{onClose && (
									<Tooltip label={t("closePanel")}>
										<ActionIcon
											{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
											size="sm"
											variant="subtle"
											color="red"
											onClick={onClose}
										>
											<IconX size={16} />
										</ActionIcon>
									</Tooltip>
								)}
							</Group>
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

					<Modal
						opened={contextThresholdSettingsOpened}
						onClose={closeContextThresholdSettings}
						title={t("contextThresholdSettingsTitle")}
						centered
						size="lg"
					>
						<Stack gap="md">
							<Text size="sm" c="dimmed">
								{t("contextThresholdSettingsIntro")}
							</Text>
							<Group grow align="flex-start">
								<NumberInput
									label={ts("autoCompactKeepPairs")}
									description={ts("autoCompactKeepPairsDesc")}
									value={contextThresholdDraft.autoCompactKeepPairs}
									onChange={(value) =>
										setContextThresholdDraft((prev) => ({
											...prev,
											autoCompactKeepPairs:
												typeof value === "number" ? value : DEFAULT_AUTO_COMPACT_KEEP_PAIRS,
										}))
									}
									min={1}
									max={25}
									allowDecimal={false}
								/>
								<NumberInput
									label={ts("autoCompactPruneThreshold")}
									description={ts("autoCompactPruneThresholdDesc")}
									value={contextThresholdDraft.autoCompactPruneThreshold}
									onChange={(value) =>
										setContextThresholdDraft((prev) => ({
											...prev,
											autoCompactPruneThreshold:
												typeof value === "number" ? value : DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD,
										}))
									}
									min={0}
									max={100}
									allowDecimal={false}
									suffix="%"
								/>
							</Group>
							<Group grow>
								<NumberInput
									label={ts("minPruneRatio")}
									description={ts("minPruneRatioDesc")}
									value={contextThresholdDraft.minPruneRatio}
									onChange={(value) =>
										setContextThresholdDraft((prev) => ({
											...prev,
											minPruneRatio: typeof value === "number" ? value : DEFAULT_MIN_PRUNE_RATIO,
										}))
									}
									min={0}
									max={100}
									allowDecimal={false}
									suffix="%"
								/>
							</Group>
							<Box style={{ borderTop: "1px solid var(--mantine-color-default-border)" }} />
							<Stack gap="xs">
								<Text size="sm" fw={600}>
									{ts("contextThresholdsStandard")}
								</Text>
								<Text size="xs" c="dimmed">
									{t("contextThresholdSettingsStandardDesc")}
								</Text>
								<Group grow align="flex-start">
									<NumberInput
										label={ts("pruneStart")}
										description={ts("pruneStartDesc")}
										value={contextThresholdDraft.contextThresholds.standard.pruneStart}
										onChange={(value) =>
											setContextThresholdDraft((prev) => ({
												...prev,
												contextThresholds: {
													...prev.contextThresholds,
													standard: {
														...prev.contextThresholds.standard,
														pruneStart: typeof value === "number" ? value : 95,
													},
												},
											}))
										}
										min={50}
										max={100}
										allowDecimal={false}
										suffix="%"
									/>
									<NumberInput
										label={ts("compactStart")}
										description={ts("compactStartDesc")}
										value={contextThresholdDraft.contextThresholds.standard.compactStart}
										onChange={(value) =>
											setContextThresholdDraft((prev) => ({
												...prev,
												contextThresholds: {
													...prev.contextThresholds,
													standard: {
														...prev.contextThresholds.standard,
														compactStart: typeof value === "number" ? value : 99,
													},
												},
											}))
										}
										min={50}
										max={100}
										allowDecimal={false}
										suffix="%"
									/>
								</Group>
							</Stack>
							<Stack gap="xs">
								<Text size="sm" fw={600}>
									{ts("contextThresholdsLarge")}
								</Text>
								<Text size="xs" c="dimmed">
									{t("contextThresholdSettingsLargeDesc")}
								</Text>
								<Group grow align="flex-start">
									<NumberInput
										label={ts("pruneStart")}
										description={ts("pruneStartDesc")}
										value={contextThresholdDraft.contextThresholds.large.pruneStart}
										onChange={(value) =>
											setContextThresholdDraft((prev) => ({
												...prev,
												contextThresholds: {
													...prev.contextThresholds,
													large: {
														...prev.contextThresholds.large,
														pruneStart: typeof value === "number" ? value : 95,
													},
												},
											}))
										}
										min={10}
										max={100}
										allowDecimal={false}
										suffix="%"
									/>
									<NumberInput
										label={ts("compactStart")}
										description={ts("compactStartDesc")}
										value={contextThresholdDraft.contextThresholds.large.compactStart}
										onChange={(value) =>
											setContextThresholdDraft((prev) => ({
												...prev,
												contextThresholds: {
													...prev.contextThresholds,
													large: {
														...prev.contextThresholds.large,
														compactStart: typeof value === "number" ? value : 99,
													},
												},
											}))
										}
										min={10}
										max={100}
										allowDecimal={false}
										suffix="%"
									/>
								</Group>
							</Stack>
							<Group justify="space-between">
								<Anchor
									component="button"
									type="button"
									size="xs"
									onClick={() => navigate({ to: "/settings/agent" })}
									style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
								>
									{t("globalAgentSettings")}
									<IconExternalLink size={12} />
								</Anchor>
								<Group gap="xs">
									<Button variant="default" onClick={closeContextThresholdSettings}>
										{tc("cancel")}
									</Button>
									<Button
										onClick={handleSaveContextThresholdSettings}
										loading={updateSettingsMutation.isPending}
										disabled={!settingsData}
									>
										{tc("save")}
									</Button>
								</Group>
							</Group>
						</Stack>
					</Modal>

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
																permCb={renderPermCb}
																pruneDividerLabel={pruneDividerLabel}
																hasChapter={hasChapter}
																highlightMessageId={highlightMessageId}
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

					{/* Image previews */}
					{attachedImages.length > 0 && (
						<Group
							pt="xs"
							px="md"
							pb={6}
							gap="xs"
							style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
						>
							{attachedImages.map((file, i) => (
								<Box
									key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
									pos="relative"
									style={{ display: "inline-block" }}
								>
									<Image
										src={imagePreviewUrls[i]}
										alt={file.name}
										radius="sm"
										h={60}
										w={60}
										fit="cover"
										style={{ cursor: "pointer" }}
										onClick={() =>
											openImageViewer({
												src: imagePreviewUrls[i],
												filename: file.name,
												alt: file.name,
											})
										}
									/>
									<CloseButton
										size="xs"
										radius="xl"
										variant="filled"
										color="dark"
										style={{ position: "absolute", top: -6, right: -6 }}
										onClick={() => updateAttachedImages((prev) => prev.filter((_, j) => j !== i))}
										title={t("removeImage")}
									/>
								</Box>
							))}
						</Group>
					)}

					{/* Text file previews */}
					{attachedTextFiles.length > 0 && (
						<Group
							pt="xs"
							px="md"
							pb={6}
							gap={6}
							wrap="wrap"
							style={{
								borderTop:
									attachedImages.length > 0
										? undefined
										: "1px solid var(--mantine-color-default-border)",
								flexShrink: 0,
							}}
						>
							{attachedTextFiles.map((file, i) => (
								<Group
									key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
									gap={6}
									px="xs"
									py={4}
									wrap="nowrap"
									style={{
										borderRadius: "var(--mantine-radius-sm)",
										backgroundColor:
											"light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
										fontSize: "var(--mantine-font-size-xs)",
									}}
								>
									<IconFile size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
									<Text size="xs" truncate style={{ maxWidth: 160, minWidth: 0 }}>
										{file.name}
									</Text>
									<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
										{formatFileSize(file.size)}
									</Text>
									<CloseButton
										size={16}
										iconSize={12}
										variant="transparent"
										c="dimmed"
										onClick={() =>
											updateAttachedTextFiles((prev) => prev.filter((_, j) => j !== i))
										}
									/>
								</Group>
							))}
						</Group>
					)}

					{/* Upload / send progress — shown while attachments are being uploaded
					    so the input area doesn't look empty after the draft is cleared. */}
					{sendingState && sendingState.attachmentCount > 0 && (
						<Stack
							gap={4}
							pt="xs"
							px="md"
							pb={6}
							style={{
								borderTop: "1px solid var(--mantine-color-default-border)",
								flexShrink: 0,
							}}
						>
							<Group gap="xs" wrap="nowrap" justify="space-between">
								{sendingState.progress !== null && sendingState.progress < 1 ? (
									<Text size="xs" c="dimmed">
										{t("uploadingAttachments", {
											percent: Math.round(sendingState.progress * 100),
										})}
									</Text>
								) : (
									<Group gap="xs" wrap="nowrap">
										<Loader size="xs" />
										<Text size="xs" c="dimmed">
											{t("sendingMessage")}
										</Text>
									</Group>
								)}
								{sendingState.canCancel && (
									<Anchor
										component="button"
										type="button"
										size="xs"
										c="dimmed"
										style={{ textDecoration: "underline", flexShrink: 0 }}
										onClick={cancelSending}
									>
										{tc("cancel")}
									</Anchor>
								)}
							</Group>
							{sendingState.progress !== null && sendingState.progress < 1 && (
								<Progress
									value={sendingState.progress * 100}
									size="sm"
									radius="xl"
									transitionDuration={150}
								/>
							)}
						</Stack>
					)}

					{/* Queued messages indicator */}
					{queuedMessages.length > 0 && (
						<Stack
							gap={0}
							style={{
								borderTop:
									attachedImages.length > 0
										? undefined
										: "1px solid var(--mantine-color-default-border)",
								flexShrink: 0,
							}}
						>
							{queuedMessages.length > QUEUE_COLLAPSE_THRESHOLD && !queueExpanded ? (
								/* Collapsed summary bar */
								<Group
									component="button"
									px="md"
									py={4}
									gap="xs"
									wrap="nowrap"
									bg="var(--mantine-color-blue-light)"
									style={{ cursor: "pointer", border: "none", width: "100%", textAlign: "left" }}
									onClick={() => setQueueExpanded(true)}
									aria-expanded={false}
									aria-label={t("queuedCount", { count: queuedMessages.length })}
								>
									<IconChevronUp size={14} color="var(--mantine-color-blue-5)" />
									<Text size="xs" c="blue" fw={500} style={{ flexShrink: 0 }}>
										{t("queuedCount", { count: queuedMessages.length })}
									</Text>
									<QueuedAttachmentPreview
										images={queuedMessages[0].images ?? []}
										textFiles={queuedMessages[0].textFiles ?? []}
									/>
									{queuedMessages[0].priority && (
										<Badge
											size="xs"
											color="orange"
											variant="light"
											leftSection={<IconBolt size={10} />}
											style={{ flexShrink: 0 }}
										>
											{t("queuedPriorityNextRequest")}
										</Badge>
									)}
									<Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
										{queuedMessages[0].text}
									</Text>
									<Button
										size="compact-xs"
										variant="subtle"
										color="red"
										onClick={(e) => {
											e.stopPropagation();
											handleCancelAllQueued();
										}}
									>
										{t("clearAllQueued")}
									</Button>
								</Group>
							) : (
								/* Expanded full list */
								<>
									<DndContext
										sensors={sensors}
										collisionDetection={closestCenter}
										onDragEnd={handleDragEndQueued}
									>
										<SortableContext
											items={queuedMessages.map((m) => m.id)}
											strategy={verticalListSortingStrategy}
										>
											{queuedMessages.map((msg, index) => (
												<QueuedMessageRow
													key={msg.id}
													msg={msg}
													index={index}
													isEditing={editingQueuedId === msg.id}
													onSaveEdit={handleSaveEditQueued}
													onCancelEdit={handleCancelEditQueued}
													onStartEdit={handleStartEditQueued}
													onRemove={handleRemoveQueued}
													cancelBufferLabel={t("cancelBuffer")}
													editLabel={tc("edit")}
													priorityLabel={t("queuedPriority")}
													priorityNextRequestLabel={t("queuedPriorityNextRequest")}
												/>
											))}
										</SortableContext>
									</DndContext>
									{queuedMessages.length > 1 && (
										<Group
											px="md"
											py={2}
											justify="flex-end"
											gap="xs"
											style={{ backgroundColor: "var(--mantine-color-blue-light)" }}
										>
											{queuedMessages.length > QUEUE_COLLAPSE_THRESHOLD && (
												<Button
													size="compact-xs"
													variant="subtle"
													color="blue"
													onClick={() => setQueueExpanded(false)}
													leftSection={<IconChevronDown size={12} />}
													style={{ marginRight: "auto" }}
												>
													{t("collapseQueue")}
												</Button>
											)}
											<Button
												size="compact-xs"
												variant="subtle"
												color="red"
												onClick={handleCancelAllQueued}
											>
												{t("clearAllQueued")}
											</Button>
										</Group>
									)}
								</>
							)}
						</Stack>
					)}

					{/* Chapter bar — clicking the info strip opens the Git view; off-dock
					    (mobile) the same gesture routes into the MobileToolPanelHost drawer
					    instead of the dock panel. */}
					{narrator.chapterId && (
						<ChapterBar
							chapterId={narrator.chapterId}
							onOpenGitPanel={
								isWorkspacePreview
									? undefined
									: dock
										? () => dock.openToolPanel("git")
										: () => setMobileToolPanel("git")
							}
						/>
					)}

					{/* Status bar */}
					<NarratorStatusBar
						ownsHorizontalSafeArea={ownsHorizontalSafeArea}
						borderTop={
							attachedImages.length > 0 || queuedMessages.length > 0
								? undefined
								: "1px solid var(--mantine-color-default-border)"
						}
					>
						{showWorkIndicator && !isWorkspacePreview ? (
							<UnstyledButton
								disabled={isRetrying || (!currentSpecTask && !isCompacting)}
								onClick={() => {
									if (isRetrying) return;
									if (isCompacting) {
										if (!compactingMarkerMessageId) return;
										void scrollToMessageTarget({
											domIds: [`msg-${compactingMarkerMessageId}`],
											targetIds: [compactingMarkerMessageId],
											highlightId: compactingMarkerMessageId,
										});
										return;
									}
									if (!currentSpecTask) return;
									// Task state lives in the Dynamic Spec (spec://tasks.json); open the
									// Spec panel instead of jumping to a (now-removed) todo tool call.
									openSpecTool();
								}}
								style={{ minWidth: 0, flex: 1 }}
							>
								<Group gap={6} wrap="nowrap">
									<Loader size={14} color={workIndicatorColor} style={{ flexShrink: 0 }} />
									{/* The current task text can be long (spec task titles especially), so
									    reveal the full string on hover/tap when the row clips it. */}
									<TruncatedText size="xs" c={workIndicatorColor} text={workIndicatorText} />
									{(queuePosition != null || queueMessageValue) && (
										<Text size="xs" c="yellow" style={{ flexShrink: 0 }}>
											·{" "}
											{queueMessageValue ??
												t(
													queueDepthValue != null && queueDepthValue > 0
														? "queuePositionWithDepth"
														: "queuePosition",
													{ position: queuePositionValue, queueDepth: queueDepthValue },
												)}
										</Text>
									)}
									{workIndicatorPlan.showBackgroundCompactSuffix && (
										<Text size="xs" c="orange" style={{ flexShrink: 0 }}>
											· {t("backgroundCompactingShort")} · {compactProgressFragment}
										</Text>
									)}
								</Group>
							</UnstyledButton>
						) : (
							<Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
								<Box
									w={8}
									h={8}
									style={{
										borderRadius: "50%",
										backgroundColor: statusRegistry.accentVar(statusBarDisplay, "filled"),
										flexShrink: 0,
									}}
								/>
								<TruncatedText size="xs" c="dimmed" text={t(statusBarDisplay.labelKey)} />
								{turnElapsedText && !isWorkspacePreview && (
									<TurnElapsedTime
										text={`· ${t("lastTurnDuration", { duration: turnElapsedText })}`}
										startedAtLabel={turnStartedAtLabel}
										isMobile={isMobileViewport}
									/>
								)}
							</Group>
						)}
						{showWorkIndicator && !isWorkspacePreview && turnElapsedText && (
							<TurnElapsedTime
								text={turnElapsedText}
								startedAtLabel={turnStartedAtLabel}
								isMobile={isMobileViewport}
							/>
						)}

						{isWorkspacePreview ? (
							<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
								{contextIndicator}
							</Group>
						) : (
							<>
								{/* Model & Permission selectors */}
								<Group gap={6} wrap="nowrap" style={{ flexShrink: 1, minWidth: 0 }}>
									{/* Viewers */}
									{viewers.length > 1 && (
										<Tooltip
											label={`${t("viewingNow")}: ${viewers.map((v) => v.username).join(", ")}`}
										>
											<Avatar.Group spacing="xs">
												{viewers.slice(0, 3).map((v) => (
													<UserAvatar
														key={v.userId}
														username={v.username}
														avatarColor={v.avatarColor}
														avatarImageId={v.avatarImageId}
														userId={v.userId}
														size={22}
														showTooltip={false}
													/>
												))}
												{viewers.length > 3 && (
													<Avatar size={22} radius="xl">
														+{viewers.length - 3}
													</Avatar>
												)}
											</Avatar.Group>
										</Tooltip>
									)}
									{contextIndicator}
									<CodexQuotaIndicator
										enabled={isBuiltInCodexModel && !isWorkspacePreview}
										isAdmin={currentUser?.role === "admin"}
										compact={isMobileViewport}
									/>
									{/* Generic gateway/API quota balance */}
									{quotaBalance != null &&
										(hasQuotaDetailsPopover ? (
											<Popover
												opened={quotaDetailsOpened}
												onChange={setQuotaDetailsOpened}
												position="top"
												withArrow
												withinPortal
												shadow="md"
											>
												<Popover.Target>
													<UnstyledButton
														onClick={(event) => {
															event.stopPropagation();
															cancelQuotaDetailsClose();
															setQuotaDetailsOpened((opened) => !opened);
														}}
														onPointerEnter={() => {
															if (!isMobileViewport) {
																cancelQuotaDetailsClose();
																setQuotaDetailsOpened(true);
															}
														}}
														onPointerLeave={() => {
															if (!isMobileViewport) scheduleQuotaDetailsClose();
														}}
														style={{ flexShrink: 0, maxWidth: 120 }}
													>
														<Text
															size="xs"
															c="dimmed"
															style={{
																cursor: "pointer",
																maxWidth: 120,
																overflow: "hidden",
																textOverflow: "ellipsis",
																whiteSpace: "nowrap",
															}}
														>
															{quotaBalance}
														</Text>
													</UnstyledButton>
												</Popover.Target>
												<Popover.Dropdown
													maw={360}
													onPointerEnter={() => {
														if (!isMobileViewport) cancelQuotaDetailsClose();
													}}
													onPointerLeave={() => {
														if (!isMobileViewport) scheduleQuotaDetailsClose();
													}}
												>
													<Stack gap={6}>
														{quotaDetailsText && (
															<Text
																size="xs"
																style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
															>
																{quotaDetailsText}
															</Text>
														)}
														{shouldShowNugRechargeInQuotaDetails && (
															<Button
																size="compact-xs"
																variant="light"
																onClick={() => {
																	setQuotaDetailsOpened(false);
																	openNugRecharge();
																}}
															>
																{t("recharge.open")}
															</Button>
														)}
													</Stack>
												</Popover.Dropdown>
											</Popover>
										) : (
											// No details popover here, so the clipped balance needs its own
											// hover/tap reveal.
											<TruncatedText
												size="xs"
												c="dimmed"
												text={quotaBalance}
												style={{ flexShrink: 0, maxWidth: 120 }}
											/>
										))}
									{shouldShowNugRechargeButton && (
										<Button size="compact-xs" variant="subtle" onClick={openNugRecharge}>
											{t("recharge.open")}
										</Button>
									)}
									{/* Desktop selects */}
									{!compact && (
										<Group gap={6} wrap="nowrap" visibleFrom="sm">
											<Tooltip label={t("modelTooltip")}>
												<Menu
													position="top-end"
													opened={modelMenuOpenDesktop}
													onChange={(o) => {
														// Don't let the price popup's outside-click close the menu.
														if (!o && priceModel != null) return;
														setModelMenuOpenDesktop(o);
													}}
												>
													<Menu.Target>
														<NativeSelect
															size="xs"
															data={allModels.map((m) => ({
																value: m.value,
																label:
																	m.value === FOLLOW_DEFAULT_MODEL
																		? t("followDefault", { model: defaultModelValue })
																		: m.provider === "__agg__"
																			? `⚡ ${m.label}`
																			: m.provider
																				? `${m.provider}:${m.label}`
																				: m.label,
															}))}
															value={(() => {
																const raw = narrator.model ?? FOLLOW_DEFAULT_MODEL;
																const agg = parseAggModelValue(raw);
																// For pinned aggregation, map back to the base agg value
																if (agg) return `${AGG_MODEL_PREFIX}${agg.aggId}`;
																return raw;
															})()}
															onChange={() => {}}
															onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
															style={{ pointerEvents: "auto" }}
														/>
													</Menu.Target>
													<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
														<ModelMenuItems
															allModels={allModels}
															currentModel={narrator.model}
															totalCostUsd={narrator.totalCostUsd}
															onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
															onShowPrice={setPriceModel}
															providerLabels={providerLabels}
															onEditDefaultModel={() => setGlobalModelEditTarget("default")}
															onEditSummaryModel={() => setGlobalModelEditTarget("summary")}
															{...modelMenuRefreshProps}
														/>
													</Menu.Dropdown>
												</Menu>
											</Tooltip>
											{parseAggModelValue(narrator.model) && (
												<AggProviderSwitcher
													currentModel={narrator.model}
													aggregations={aggregations}
													providerLabels={providerLabels}
													onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
												/>
											)}
											{/* Reasoning Effort (Codex + Anthropic providers) */}
											{supportsReasoningEffort && (
												<Menu position="top-end">
													<Menu.Target>
														<NativeSelect
															size="xs"
															data={reasoningEffortOptions.map((effort) => ({
																value: effort,
																label: t(`reasoning_${effort}`),
															}))}
															value={displayedReasoningEffort}
															onChange={() => {}}
															onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
															style={{ pointerEvents: "auto" }}
														/>
													</Menu.Target>
													<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
														<ReasoningEffortMenuItems
															currentEffort={displayedReasoningEffort}
															options={reasoningEffortOptions}
															onSelect={(e) =>
																reasoningEffortMutation.mutate({
																	id: narratorId,
																	reasoningEffort: e,
																})
															}
															t={t}
														/>
														{!reasoningFollowsDefault && (
															<Box px="sm" py={4} onClick={(event) => event.stopPropagation()}>
																<InlineOverrideActions
																	visible
																	disabled={reasoningEffortMutation.isPending}
																	onFollowDefault={handleFollowDefaultReasoning}
																	onSetAsDefault={handleSetReasoningAsDefault}
																	t={t}
																/>
															</Box>
														)}
													</Menu.Dropdown>
												</Menu>
											)}
											{/* Fast Mode toggle (only for Codex-mode providers) */}
											{supportsCodexControls &&
												!isMobileViewport &&
												renderFastModeControl("top-end")}
											<Tooltip
												label={
													narrator.isAskInPassing
														? t("askInPassing_readOnlyHint")
														: t("permissionMode")
												}
											>
												{narrator.isAskInPassing ? (
													<NativeSelect
														size="xs"
														leftSection={PERM_MODE_ICONS.readOnly ?? <IconShield size={14} />}
														data={[{ value: "readOnly", label: t("perm_readOnly") }]}
														value="readOnly"
														onChange={() => {}}
														disabled
														style={{ pointerEvents: "auto", opacity: 0.6 }}
													/>
												) : (
													<Menu position="top-end">
														<Menu.Target>
															<NativeSelect
																size="xs"
																leftSection={
																	PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
																		<IconShield size={14} />
																	)
																}
																data={PERM_MODE_DATA.map((d) => ({
																	value: d.value,
																	label: t(d.label),
																}))}
																value={narrator.permissionMode ?? "default"}
																onChange={() => {}}
																onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
																style={{ pointerEvents: "auto" }}
															/>
														</Menu.Target>
														<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
															<PermissionMenuContent
																currentMode={narrator.permissionMode ?? "default"}
																availablePermissionModes={availablePermissionModes}
																permissionModesUnavailableReason={permissionModesUnavailableReason}
																onSelectPermissionMode={(m) =>
																	permModeMutation.mutate({ id: narratorId, permissionMode: m })
																}
																t={t}
																hasPlanTrait={hasPlanTrait}
																onTogglePlanMode={togglePlanMode}
																planModePending={
																	enterPlanModeMutation.isPending || exitPlanModeMutation.isPending
																}
																planModeSupported={planModeSupported}
																planModeUnsupportedReason={planModeUnsupportedReason}
																showPlanReflectionAutoApproveToggle={
																	planReflectionSupported &&
																	((narrator.permissionMode ?? "default") === "acceptEdits" ||
																		(narrator.permissionMode ?? "default") === "bypassPermissions")
																}
																planReflectionAutoApproveOverride={
																	planReflectionAutoApproveOverride
																}
																planReflectionAutoApproveEffective={
																	planReflectionAutoApproveEffective
																}
																planReflectionAutoApproveGlobal={planReflectionAutoApproveGlobal}
																onPlanReflectionAutoApproveChange={
																	handlePlanReflectionAutoApproveOverride
																}
																onFollowDefaultPlanReflection={handleFollowDefaultPlanReflection}
																onSetPlanReflectionAsDefault={handleSetPlanReflectionAsDefault}
																showDangerReflectionToggle={dangerReflectionSupported}
																dangerReflectionOverride={dangerReflectionOverride}
																dangerReflectionEffectiveLevel={dangerReflectionEffectiveLevel}
																dangerReflectionGlobalLevel={dangerReflectionGlobalLevel}
																onDangerReflectionChange={handleDangerReflectionOverride}
																onFollowDefaultDangerReflection={
																	handleFollowDefaultDangerReflection
																}
																onSetDangerReflectionAsDefault={handleSetDangerReflectionAsDefault}
																reflectionSettingsDisabled={reflectionSettingsDisabled}
															/>
														</Menu.Dropdown>
													</Menu>
												)}
											</Tooltip>
											{narrator.isAskInPassing && (
												<Tooltip
													label={
														narrator.chapterId
															? t("promote_chapter_hint")
															: t("promote_standalone_hint")
													}
												>
													<Button
														size="xs"
														variant="light"
														color="teal"
														loading={promoteMutation.isPending}
														onClick={handlePromote}
													>
														{t("promote")}
													</Button>
												</Tooltip>
											)}
											<PathRulesPopover narratorId={narratorId} t={t} />
											{/* Relaxed Plan toggle (only visible in plan mode) */}
											{hasPlanTrait && (
												<Tooltip
													label={
														relaxedPlanForced
															? t("relaxed_plan_forced_tooltip")
															: t("relaxed_plan_tooltip")
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
														{relaxedPlanEnabled ? (
															<IconLockOpen size={16} />
														) : (
															<IconLock size={16} />
														)}
													</ActionIcon>
												</Tooltip>
											)}
											{(terminalToolAvailable || onOpenTerminalPanel) && (
												<Tooltip
													label={
														onOpenTerminalPanel
															? tt("openTerminal")
															: terminalToolOpened
																? tt("closeTerminal")
																: tt("openTerminal")
													}
												>
													<Indicator
														inline
														label={activeTerminalCount}
														size={14}
														disabled={activeTerminalCount === 0}
														offset={2}
														color="blue"
														style={{
															height: "var(--ai-size-sm)",
															display: "flex",
															alignItems: "center",
														}}
													>
														<ActionIcon
															variant="subtle"
															color={terminalToolOpened ? "blue" : "gray"}
															size="sm"
															aria-label={
																onOpenTerminalPanel
																	? tt("openTerminal")
																	: terminalToolOpened
																		? tt("closeTerminal")
																		: tt("openTerminal")
															}
															onClick={onOpenTerminalPanel ?? toggleTerminalTool}
														>
															<IconTerminal size={16} />
														</ActionIcon>
													</Indicator>
												</Tooltip>
											)}
										</Group>
									)}
									{/* Mobile: model & permission */}
									<Box
										style={{ minWidth: 0, width: "100%" }}
										{...(compact ? {} : { hiddenFrom: "sm" as const })}
									>
										<NarratorStatusToolbar
											leading={
												<>
													<Tooltip label={t("modelTooltip")}>
														<Menu
															position="bottom-end"
															withinPortal
															opened={modelMenuOpenMobile}
															onChange={(o) => {
																if (!o && priceModel != null) return;
																setModelMenuOpenMobile(o);
															}}
														>
															<Menu.Target>
																<ActionIcon
																	variant="subtle"
																	color="gray"
																	size="sm"
																	aria-label={t("modelTooltip")}
																>
																	<Text size="xs" fw={600}>
																		{(() => {
																			if (
																				narrator.model === FOLLOW_DEFAULT_MODEL ||
																				!narrator.model
																			)
																				return "D";
																			const m = allModels.find((x) => x.value === narrator.model);
																			// charAt(0) is safe on empty strings ("" → ""); fall back to "?"
																			// so an empty label never produces `undefined.toUpperCase()`.
																			return (
																				(m?.label || narrator.model || "?")
																					.charAt(0)
																					.toUpperCase() || "?"
																			);
																		})()}
																	</Text>
																</ActionIcon>
															</Menu.Target>
															<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
																<ModelMenuItems
																	allModels={allModels}
																	currentModel={narrator.model}
																	totalCostUsd={narrator.totalCostUsd}
																	onSelect={(v) =>
																		modelMutation.mutate({ id: narratorId, model: v })
																	}
																	onShowPrice={setPriceModel}
																	label={t("modelTooltip")}
																	providerLabels={providerLabels}
																	onEditDefaultModel={() => setGlobalModelEditTarget("default")}
																	onEditSummaryModel={() => setGlobalModelEditTarget("summary")}
																	{...modelMenuRefreshProps}
																/>
															</Menu.Dropdown>
														</Menu>
													</Tooltip>
													{parseAggModelValue(narrator.model) && (
														<AggProviderSwitcher
															currentModel={narrator.model}
															aggregations={aggregations}
															providerLabels={providerLabels}
															onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
														/>
													)}
													{/* Reasoning Effort (Codex + Anthropic providers) - Mobile */}
													{supportsReasoningEffort && (
														<Menu position="bottom-end" withinPortal>
															<Menu.Target>
																<ActionIcon
																	variant="subtle"
																	color="gray"
																	size="sm"
																	aria-label={t("reasoningEffort")}
																>
																	<Text size="xs" fw={600}>
																		{(() => {
																			const effortMap = {
																				none: "O",
																				low: "L",
																				medium: "M",
																				high: "H",
																				xhigh: "X",
																				max: "MX",
																			};
																			return (
																				effortMap[
																					displayedReasoningEffort as keyof typeof effortMap
																				] ?? "A"
																			);
																		})()}
																	</Text>
																</ActionIcon>
															</Menu.Target>
															<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
																<ReasoningEffortMenuItems
																	currentEffort={displayedReasoningEffort}
																	options={reasoningEffortOptions}
																	onSelect={(e) =>
																		reasoningEffortMutation.mutate({
																			id: narratorId,
																			reasoningEffort: e,
																		})
																	}
																	t={t}
																/>
																{!reasoningFollowsDefault && (
																	<Box px="sm" py={4} onClick={(event) => event.stopPropagation()}>
																		<InlineOverrideActions
																			visible
																			disabled={reasoningEffortMutation.isPending}
																			onFollowDefault={handleFollowDefaultReasoning}
																			onSetAsDefault={handleSetReasoningAsDefault}
																			t={t}
																		/>
																	</Box>
																)}
															</Menu.Dropdown>
														</Menu>
													)}
													{/* Fast Mode toggle (only for Codex-mode providers) - Mobile */}
													{supportsCodexControls &&
														(compact || isMobileViewport) &&
														renderFastModeControl("bottom-end")}
													<Tooltip
														label={
															narrator.isAskInPassing
																? t("askInPassing_readOnlyHint")
																: t("permissionMode")
														}
													>
														{narrator.isAskInPassing ? (
															<ActionIcon
																variant="subtle"
																color="gray"
																size="sm"
																aria-label={t("askInPassing_readOnlyHint")}
																disabled
																style={{ opacity: 0.6 }}
															>
																{PERM_MODE_ICONS.readOnly ?? <IconShield size={16} />}
															</ActionIcon>
														) : (
															<Menu position="bottom-end" withinPortal>
																<Menu.Target>
																	<ActionIcon
																		variant="subtle"
																		color="gray"
																		size="sm"
																		aria-label={t("permissionMode")}
																	>
																		{PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
																			<IconShield size={16} />
																		)}
																	</ActionIcon>
																</Menu.Target>
																<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
																	<PermissionMenuContent
																		currentMode={narrator.permissionMode ?? "default"}
																		availablePermissionModes={availablePermissionModes}
																		permissionModesUnavailableReason={
																			permissionModesUnavailableReason
																		}
																		onSelectPermissionMode={(m) =>
																			permModeMutation.mutate({ id: narratorId, permissionMode: m })
																		}
																		t={t}
																		hasPlanTrait={hasPlanTrait}
																		onTogglePlanMode={togglePlanMode}
																		planModePending={
																			enterPlanModeMutation.isPending ||
																			exitPlanModeMutation.isPending
																		}
																		planModeSupported={planModeSupported}
																		planModeUnsupportedReason={planModeUnsupportedReason}
																		showPlanReflectionAutoApproveToggle={
																			planReflectionSupported &&
																			((narrator.permissionMode ?? "default") === "acceptEdits" ||
																				(narrator.permissionMode ?? "default") ===
																					"bypassPermissions")
																		}
																		planReflectionAutoApproveOverride={
																			planReflectionAutoApproveOverride
																		}
																		planReflectionAutoApproveEffective={
																			planReflectionAutoApproveEffective
																		}
																		planReflectionAutoApproveGlobal={
																			planReflectionAutoApproveGlobal
																		}
																		onPlanReflectionAutoApproveChange={
																			handlePlanReflectionAutoApproveOverride
																		}
																		onFollowDefaultPlanReflection={
																			handleFollowDefaultPlanReflection
																		}
																		onSetPlanReflectionAsDefault={handleSetPlanReflectionAsDefault}
																		showDangerReflectionToggle={dangerReflectionSupported}
																		dangerReflectionOverride={dangerReflectionOverride}
																		dangerReflectionEffectiveLevel={dangerReflectionEffectiveLevel}
																		dangerReflectionGlobalLevel={dangerReflectionGlobalLevel}
																		onDangerReflectionChange={handleDangerReflectionOverride}
																		onFollowDefaultDangerReflection={
																			handleFollowDefaultDangerReflection
																		}
																		onSetDangerReflectionAsDefault={
																			handleSetDangerReflectionAsDefault
																		}
																		reflectionSettingsDisabled={reflectionSettingsDisabled}
																	/>
																</Menu.Dropdown>
															</Menu>
														)}
													</Tooltip>
												</>
											}
											actions={mobileToolbarActions}
											moreLabel={t("moreActions")}
											measurementKey={mobileToolbarMeasurementKey}
										/>
									</Box>
								</Group>
							</>
						)}
					</NarratorStatusBar>

					{/* Input */}
					{isWorkspacePreview ? null : isChapterMerged ? (
						<Box
							px="md"
							py="sm"
							style={{
								flexShrink: 0,
								backgroundColor:
									"light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
								opacity: 0.7,
							}}
						>
							<Text size="sm" c="dimmed" ta="center">
								{t("chapterMergedHint")}
							</Text>
						</Box>
					) : (
						<Box px="md" pb="xs" style={{ flexShrink: 0 }}>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								style={{ display: "none" }}
								onChange={(e) => {
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
								}}
							/>
							<Group gap="xs" align="end" wrap="nowrap">
								<Tooltip label={t("attachFile")}>
									<ActionIcon
										variant="subtle"
										color="gray"
										onClick={() => fileInputRef.current?.click()}
										mb={4}
									>
										<IconPaperclip size={18} />
									</ActionIcon>
								</Tooltip>
								<NarratorComposer
									ref={composerRef}
									narratorId={narratorId}
									sendingRef={sendingRef}
									appendInputRef={appendInputRef}
									permEnterActive={effectiveFocusIndex != null}
									hasAttachments={composerHasAttachments}
									enterMode={userPrefs?.enterQueueMode ?? "turn"}
									ctrlEnterMode={userPrefs?.ctrlEnterQueueMode ?? "tool"}
									onSendWithMode={composerSendWithMode}
									onTextFlagsChange={setComposerHasText}
									onPasteImages={handleComposerPasteImages}
								/>
								{(() => {
									const hasInput = composerHasText;
									const hasAttachments = composerHasAttachments;

									// Takeover button: shown while a subagent is running and not yet
									// taken over. Clicking it interrupts the current turn and hands
									// direct control to the user (parent tool call stays blocked).
									if (canTakeover && !hasInput && !hasAttachments && !editingMessageState) {
										return (
											<Button
												key="takeover"
												color="grape"
												variant="light"
												onClick={() => takeoverMutation.mutate(narratorId)}
												loading={takeoverMutation.isPending}
											>
												{t("takeover")}
											</Button>
										);
									}

									// The primary action button (send / interrupt / retry / continue /
									// queue / edit-submit). Extracted so it can be reused inside the
									// takeover two-button layout.
									const renderPrimaryActionButton = () => {
										const showInterrupt =
											isActive && !hasInput && !hasAttachments && retryRecoveryAllowsInterrupt;

										// "Cut in line" describes a Stop that hands the turn over to the
										// queued priority message. A taken-over subagent has no cut-in
										// semantics (see `canCutInLine`): its queue is filled without a
										// soft stop, so the label would name an action the server does
										// not perform — and it sat on the one button whose hold gesture
										// interrupts, which is how "cut in" got read as "interrupt".
										const hasCutInMessage = !isTakenOver && !!queuedMessages[0]?.priority;
										const showRetry =
											!showInterrupt && !hasInput && !hasAttachments && canRetryLastUserMessage;
										const showContinue =
											!showInterrupt && !hasInput && !hasAttachments && canContinueNarrator;

										// Wrap a primary button as the right segment of the split
										// send-options control (three-dots menu on the left). Used for
										// every send-flow state so the queue-behavior menu is always
										// reachable. Not used for the modal edit-submit sub-state.
										const withSendOptions = (
											primaryButton: React.ReactNode,
											opts?: { color?: string; variant?: string },
										) => (
											<SendOptionsSplitButton
												enterQueueMode={userPrefs?.enterQueueMode ?? "turn"}
												ctrlEnterQueueMode={userPrefs?.ctrlEnterQueueMode ?? "tool"}
												hasInput={hasInput || hasAttachments}
												compacting={showCompactQueueChoice}
												color={opts?.color}
												variant={opts?.variant}
												onSelectEnterMode={(mode) =>
													updateUserPrefs.mutate({ enterQueueMode: mode })
												}
												onSelectCtrlEnterMode={(mode) =>
													updateUserPrefs.mutate({ ctrlEnterQueueMode: mode })
												}
												onSendWithMode={(mode) => {
													void handleSendWithMode(mode);
												}}
												t={t}
												primaryButton={primaryButton}
											/>
										);

										// When a message is being edited, the send/retry button
										// should trigger the edit submit instead. No send options here —
										// queue behaviors don't apply to editing a message.
										if (editingMessageState && !showInterrupt) {
											return (
												<Button
													key="edit-submit"
													onClick={editingMessageState.submit}
													disabled={!editingMessageState.canSubmit}
													loading={editingMessageState.isSubmitting}
												>
													{t("editSubmit")}
												</Button>
											);
										}
										if (showInterrupt) {
											return withSendOptions(
												<Button
													key="interrupt"
													ref={interruptBtnRef}
													color="red"
													variant="light"
													onMouseDown={startInterruptPress}
													onMouseUp={handleInterruptMouseUp}
													onMouseLeave={clearInterruptTimer}
													onContextMenu={(e) => e.preventDefault()}
													loading={interruptMutation.isPending}
													style={{
														position: "relative",
														overflow: "hidden",
														userSelect: "none",
														touchAction: "none",
													}}
												>
													{interruptProgress > 0 && interruptProgress < 1 && (
														<div
															style={{
																position: "absolute",
																inset: 0,
																background: "var(--mantine-color-red-filled)",
																opacity: 0.25,
																transformOrigin: "left",
																transform: `scaleX(${interruptProgress})`,
																pointerEvents: "none",
															}}
														/>
													)}
													<span style={{ position: "relative" }}>
														{hasCutInMessage ? t("interruptCutInLine") : t("interrupt")}
													</span>
												</Button>,
												{ color: "red", variant: "light" },
											);
										}
										if (showRetry) {
											return withSendOptions(
												<Button key="retry" onClick={handleRetry}>
													{t("retry")}
												</Button>,
											);
										}
										if (showContinue) {
											return withSendOptions(
												<Button key="continue" onClick={handleContinue}>
													{t("continue")}
												</Button>,
											);
										}
										// Idle but compacting: the message will be QUEUED (the server holds
										// it until the compaction settles), so the button says so rather
										// than promising an immediate send. No hold gesture here — the
										// alternative is a single "run now" item in the split menu, and a
										// long-press that silently bypassed the compaction would be a
										// surprising default for a two-way choice.
										if (showCompactQueueChoice) {
											return withSendOptions(
												<Button
													key="send-compact-queue"
													onClick={handleSend}
													disabled={!hasInput && !hasAttachments}
													loading={isSending}
												>
													{queuedMessages.length > 0
														? `${t("queue")} (${queuedMessages.length})`
														: t("queue")}
												</Button>,
											);
										}
										return canCutInLine
											? withSendOptions(
													<Tooltip
														label={t("queueButtonPressHint", {
															shortMode: t(`queueMode_${userPrefs?.enterQueueMode ?? "turn"}`),
															longMode: t(`queueMode_${userPrefs?.ctrlEnterQueueMode ?? "tool"}`),
														})}
														position="top"
													>
														<Button
															key="send-priority"
															disabled={!hasInput && !hasAttachments}
															loading={isSending}
															onPointerDown={(event) => {
																if (!hasInput && !hasAttachments) return;
																startQueueHold(event);
															}}
															onPointerUp={handleQueuePointerUp}
															onPointerCancel={cancelQueueHold}
															onPointerLeave={cancelQueueHold}
															onClick={handleQueueClick}
															onContextMenu={(e) => e.preventDefault()}
															style={{
																position: "relative",
																overflow: "hidden",
																userSelect: "none",
																touchAction: "none",
															}}
														>
															{queueHoldProgress > 0 && queueHoldProgress < 1 && (
																<div
																	style={{
																		position: "absolute",
																		inset: 0,
																		background: "var(--mantine-color-indigo-filled)",
																		opacity: 0.25,
																		transformOrigin: "left",
																		transform: `scaleX(${queueHoldProgress})`,
																		pointerEvents: "none",
																	}}
																/>
															)}
															<span style={{ position: "relative" }}>
																{queuedMessages.length > 0
																	? `${t("queue")} (${queuedMessages.length})`
																	: t("queue")}
															</span>
														</Button>
													</Tooltip>,
												)
											: withSendOptions(
													<Button
														key="send"
														onClick={handleSend}
														disabled={!hasInput && !hasAttachments}
														loading={isSending}
													>
														{tc("send")}
													</Button>,
												);
									};

									// Takeover mode: the user operates the subagent like an
									// independent narrator (send/interrupt/queue/continue) plus a
									// dedicated "Stop takeover" button to hand the result back.
									if (isTakenOver) {
										return (
											<Group gap="xs" align="end" wrap="nowrap">
												{renderPrimaryActionButton()}
												<Tooltip label={t("stopTakeoverHint")} position="top">
													<Button
														key="stop-takeover"
														color="grape"
														variant="outline"
														onClick={() => stopTakeoverMutation.mutate(narratorId)}
														loading={stopTakeoverMutation.isPending}
													>
														{t("stopTakeover")}
													</Button>
												</Tooltip>
											</Group>
										);
									}

									return renderPrimaryActionButton();
								})()}
							</Group>
						</Box>
					)}

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
								<FileViewerContent key={internalFileViewerPath} filePath={internalFileViewerPath} />
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
			<RollbackConfirmModal
				narratorId={narratorId}
				pendingRollback={pendingRollback}
				onConfirm={confirmRollback}
				onCancel={() => setPendingRollback(null)}
			/>
			<BlockDeleteConfirmModal
				narratorId={narratorId}
				pending={pendingBlockDelete}
				onConfirm={confirmBlockDelete}
				onCancel={() => setPendingBlockDelete(null)}
			/>
			<ModelPriceModal
				model={priceModel}
				opened={priceModel != null}
				onClose={() => setPriceModel(null)}
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
