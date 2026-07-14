import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ComboboxData, ComboboxItemGroup } from "@mantine/core";
import {
	ActionIcon,
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
	Skeleton,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { MAX_NARRATOR_DRAFT_CHARS } from "@shared/narrator-limits";
import { clampReasoningEffort, type ReasoningEffort } from "@shared/reasoning-effort";
import {
	IconArchive,
	IconArrowDown,
	IconArrowLeft,
	IconArrowsMinimize,
	IconBolt,
	IconCheck,
	IconChevronDown,
	IconChevronUp,
	IconClock,
	IconCopy,
	IconDeviceDesktop,
	IconDevices,
	IconDotsVertical,
	IconEraser,
	IconExternalLink,
	IconFile,
	IconFileCode,
	IconFolderPlus,
	IconGitBranch,
	IconGitFork,
	IconGripVertical,
	IconInfoCircle,
	IconLock,
	IconLockOpen,
	IconNotebook,
	IconPaperclip,
	IconPencil,
	IconPhoto,
	IconPlayerPlay,
	IconPlayerTrackNext,
	IconRobot,
	IconSearch,
	IconSettings,
	IconShield,
	IconSparkles,
	IconTerminal,
	IconTool,
	IconTrash,
	IconUpload,
	IconWorldWww,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	lazy,
	type SetStateAction,
	Suspense,
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useChapter } from "../../hooks/useChapters";
import { useNamedNarrators } from "../../hooks/useChatGroup";
import { useNarratorCommands } from "../../hooks/useCommands";
import { useInputHistory } from "../../hooks/useInputHistory";
import { useAllModels } from "../../hooks/useModels";
import {
	useArchiveNarrator,
	useBlacklistDirs,
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
import {
	useNarratorBrowserSessionsCapability,
	useNarratorCompactCapability,
	useNarratorPermissionsCapability,
	useNarratorPlanModeCapability,
	useNarratorRetryRecoveryCapability,
	useNarratorRollbackEditRegenerateCapability,
} from "../../hooks/usePlatform";
import { useSpecTasks } from "../../hooks/useSpec";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";
import {
	ApiError,
	api,
	type BufferMessageSummary,
	isAbortError,
	type TreeMessage,
} from "../../lib/api";
import {
	AGG_MODEL_PREFIX,
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	type ModelAggregation,
	type ModelOption,
	parseAggModelValue,
	resolveDisplayModel,
} from "../../lib/constants";
import { collectElementTextPreview, compactWhitespacePreview } from "../../lib/dom-text";
import { calculateEffectiveTurnElapsedMs, formatColonDuration } from "../../lib/format";
import { formatLocaleDateTime, formatLocaleNumber } from "../../lib/intl-format";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { Z } from "../../lib/z-index";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";
import { useImageViewer } from "../common/ImageViewerProvider";
import { PathInputWithBrowse } from "../common/PathInputWithBrowse";
import { SelectionPopover } from "../common/SelectionPopover";
import { TruncatedPath } from "../common/TruncatedPath";
import { UserAvatar } from "../UserAvatar";
import { BackgroundTasksDrawer, useBackgroundTasksButton } from "./BackgroundTasksDrawer";
import type { BroadMessageListHandle } from "./BroadMessageList";
import { ChapterBar } from "./ChapterBar";
import {
	ChunkedMessageList,
	type ChunkedMessageListHandle,
	type ChunkTailMeta,
} from "./ChunkedMessageList";
import { CodexQuotaIndicator } from "./CodexQuotaIndicator";
import { CommandParamHelper } from "./CommandParamHelper";
import { type CommandItem, CommandPopover } from "./CommandPopover";
import { ContentViewerEnvironmentProvider, handleRegistry } from "./ContentViewer";
import { useNarratorDockContext } from "./dock/NarratorDockContext";
import {
	clearDraftImageAttachments,
	getDraftImageAttachmentKey,
	loadDraftImageAttachments,
	saveDraftImageAttachments,
} from "./draft-image-attachments";
import { FileModificationsDrawer } from "./FileModificationsDrawer";
import { LeakedToolCallModal } from "./LeakedToolCallModal";
import { getMentionQuery, type MentionCandidate, MentionPopover } from "./MentionPopover";
import {
	COMPACTING_MARKER_ATTR,
	CompactSummaryModal,
	CompactSummaryModalCtx,
	type CompactSummaryModalTarget,
	EditingMessageCtx,
	type EditingMessageState,
} from "./MessageBubble";
import {
	type RenderedTreeElementMeta,
	RenderProgress,
	renderTreeMessagesWithKeys,
} from "./MessageRenderer";
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
import { ModelPriceModal } from "./ModelPriceModal";
import { getRenderableMessageOrder } from "./message-order-utils";
import { buildStreamingMsg, segmentMessages } from "./message-segments";
import { evictOldestPages } from "./message-tree-utils";
import { NarratorPanelSkeleton } from "./NarratorPanelSkeleton";
import { NugRechargeDialog } from "./NugRechargeDialog";
import {
	cleanupLegacyNarratorInputStorage,
	getNarratorInputHistoryKey,
	persistNarratorInputDraft,
	readNarratorInputDraft,
	resolveHydratedNarratorDraft,
} from "./narrator-draft-storage";
import {
	insertTopLevelMessageBySeq,
	resolvePendingPerm,
	revokeContentBlockPreviewUrls,
} from "./narrator-message-helpers";
import type {
	ContentBlock,
	MessagesPage,
	MessagesQueryData,
	NarratorMsg,
	NarratorPanelProps,
	PermissionCallbacks,
} from "./narrator-panel-types";
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
	STREAMING_CHUNKS_MSG_ID,
} from "./narrator-panel-types";
import { getNarratorStatusBarDisplay } from "./narrator-status-bar";
import { SwipeAnchorOverlay } from "./SwipeAnchorOverlay";
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
	type ToolCallData,
} from "./ToolCallCard";
import { useNarratorChunks } from "./useNarratorChunks";
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

interface WorkspaceChunkPreviewProps {
	narratorId: string;
	isSubagent?: boolean;
	permCb: PermissionCallbacks;
	expandedToolUseId?: string | null;
	showTokenUsage?: boolean;
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	lastUserMessageId?: string;
	hasChapter?: boolean;
	resolvePerm?: (tc: ToolCallData) => ReturnType<typeof resolvePendingPerm>;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
}

function WorkspaceChunkPreview({
	narratorId,
	isSubagent,
	permCb,
	expandedToolUseId,
	showTokenUsage,
	pruneBoundaryMessageId,
	pruneDividerLabel,
	lastUserMessageId,
	hasChapter,
	resolvePerm,
	onAskInPassing,
}: WorkspaceChunkPreviewProps) {
	const { chunks, streamingMsg } = useNarratorChunks(narratorId, { isSubagent });
	const rendered = useMemo(() => {
		const tailMessages = (chunks[chunks.length - 1]?.messages ?? []) as NarratorMsg[];
		const messages = tailMessages.slice(-8);
		if (messages.length === 0 && !streamingMsg) return { elements: [], keys: [] };
		return renderTreeMessagesWithKeys(
			messages,
			narratorId,
			undefined,
			null,
			permCb,
			expandedToolUseId,
			showTokenUsage,
			pruneBoundaryMessageId,
			pruneDividerLabel,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lastUserMessageId,
			hasChapter,
			undefined,
			streamingMsg,
			resolvePerm,
			onAskInPassing,
			false,
		);
	}, [
		chunks,
		expandedToolUseId,
		hasChapter,
		lastUserMessageId,
		narratorId,
		onAskInPassing,
		permCb,
		pruneBoundaryMessageId,
		pruneDividerLabel,
		resolvePerm,
		showTokenUsage,
		streamingMsg,
	]);

	return (
		<Box h="100%" style={{ position: "relative", overflow: "hidden" }}>
			<Box
				px="md"
				pt="md"
				style={{
					position: "absolute",
					left: 0,
					right: 0,
					bottom: 0,
					display: "flex",
					flexDirection: "column",
					gap: 12,
				}}
			>
				{rendered.elements.map((element, index) => (
					<Box
						key={rendered.keys[index] ?? `preview-${index}`}
						style={{ flex: "0 0 auto", minWidth: 0 }}
					>
						{element}
					</Box>
				))}
			</Box>
		</Box>
	);
}

/* ── Shared menu-item renderers (desktop NativeSelect + mobile ActionIcon share these) ── */

const NarratorDetailsPanel = lazy(() =>
	import("./NarratorDetailsPanel").then((module) => ({ default: module.NarratorDetailsPanel })),
);

const SpecPanel = lazy(() =>
	import("./SpecPanel").then((module) => ({ default: module.SpecPanel })),
);

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

const ENABLE_MESSAGE_RENDER_WINDOW = true;
const MESSAGE_RENDER_WINDOW_THRESHOLD = 260;
const MESSAGE_RENDER_WINDOW_SIZE = 180;
const MESSAGE_RENDER_TARGET_RADIUS = 40;
const MESSAGE_MOUNT_CACHE_LIMIT = MESSAGE_RENDER_WINDOW_SIZE;
const MESSAGE_UNMOUNT_CACHE_LIMIT = MESSAGE_RENDER_WINDOW_THRESHOLD * 2;
const MAX_PAGE_RENDER_CACHE_ENTRIES = 6;
const INPUT_DRAFT_SYNC_DEBOUNCE_MS = 800;

type MessageRenderWindow = {
	start: number;
	end: number;
	reason: "tail" | "target" | "manual";
};

type MessageScrollAlign = NonNullable<
	NonNullable<Parameters<BroadMessageListHandle["scrollToIndex"]>[1]>["align"]
>;

type ScrollToFullIndexOptions = {
	align?: MessageScrollAlign;
	domIds?: string[];
	highlightId?: string;
	highlightDelayMs?: number;
};

type PendingMessageScroll = {
	fullIndex: number;
	align: MessageScrollAlign;
	domIds?: string[];
	highlightId?: string;
	highlightDelayMs?: number;
};

function createDraftSourceId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

function isDraftWithinSyncLimit(input: string): boolean {
	return input.length <= MAX_NARRATOR_DRAFT_CHARS;
}

function getTailMessageRenderWindow(totalCount: number): MessageRenderWindow {
	return {
		start: Math.max(0, totalCount - MESSAGE_RENDER_WINDOW_SIZE),
		end: totalCount,
		reason: "tail",
	};
}

function centerMessageRenderWindowAround(
	fullIndex: number,
	totalCount: number,
): MessageRenderWindow {
	const maxStart = Math.max(0, totalCount - MESSAGE_RENDER_WINDOW_SIZE);
	const centeredStart = fullIndex - Math.floor(MESSAGE_RENDER_WINDOW_SIZE / 2);
	const minStartForRadius =
		fullIndex + MESSAGE_RENDER_TARGET_RADIUS + 1 - MESSAGE_RENDER_WINDOW_SIZE;
	const maxStartForRadius = fullIndex - MESSAGE_RENDER_TARGET_RADIUS;
	const lowerBound = Math.max(0, Math.min(maxStart, minStartForRadius));
	const upperBound = Math.max(0, Math.min(maxStart, maxStartForRadius));
	const clampedCenteredStart = Math.max(0, Math.min(maxStart, centeredStart));
	const start = Math.max(lowerBound, Math.min(upperBound, clampedCenteredStart));
	return {
		start,
		end: Math.min(totalCount, start + MESSAGE_RENDER_WINDOW_SIZE),
		reason: "target",
	};
}

function isSameMessageRenderWindow(a: MessageRenderWindow, b: MessageRenderWindow) {
	return a.start === b.start && a.end === b.end && a.reason === b.reason;
}

type CompactingMarkerKind = "context" | "segment";

function getCompactingMarkerKind(
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

function getMessageViewportDistanceFromBottom(scroller: HTMLElement) {
	return getMessageViewportScrollBottom(scroller) - scroller.scrollTop;
}

type PageRenderCacheEntry = {
	messageRefs: readonly NarratorMsg[];
	secondaryKey: string;
	elements: React.ReactNode[];
	keys: string[];
	targets: string[][];
	meta: RenderedTreeElementMeta[];
};

function touchPageRenderCacheEntry(
	cache: Map<string, PageRenderCacheEntry>,
	key: string,
	entry: PageRenderCacheEntry,
): PageRenderCacheEntry {
	cache.delete(key);
	cache.set(key, entry);
	return entry;
}

function prunePageRenderCache(cache: Map<string, PageRenderCacheEntry>): void {
	while (cache.size > MAX_PAGE_RENDER_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) return;
		cache.delete(oldestKey);
	}
}

function hasSamePageMessageRefs(
	prevMessages: readonly NarratorMsg[],
	nextMessages: readonly NarratorMsg[],
) {
	if (prevMessages.length !== nextMessages.length) return false;
	for (let i = 0; i < prevMessages.length; i++) {
		if (prevMessages[i] !== nextMessages[i]) return false;
	}
	return true;
}

function getPageRenderCacheKey(
	page: MessagesPage,
	pageParam: unknown,
	narratorId: string,
	highlightMessageId?: string,
) {
	const pageCursor =
		typeof pageParam === "object" && pageParam && "cursor" in pageParam
			? String(pageParam.cursor)
			: typeof pageParam === "string"
				? pageParam
				: undefined;
	const pageDirection =
		typeof pageParam === "object" && pageParam && "direction" in pageParam
			? String(pageParam.direction)
			: "older";
	const firstMessageId = page.messages[0]?.id ?? "none";
	const lastMessageId = page.messages[page.messages.length - 1]?.id ?? "none";
	return pageParam == null
		? `initial:${narratorId}:${highlightMessageId ?? "latest"}:${firstMessageId}:${lastMessageId}`
		: `${pageDirection}:${pageCursor ?? firstMessageId}:${lastMessageId}`;
}

function ModelMenuItems({
	allModels,
	currentModel,
	totalCostUsd,
	onSelect,
	onShowPrice,
	label,
	providerLabels,
	onEditDefaultModel,
	onEditSummaryModel,
}: {
	allModels: ModelOption[];
	currentModel: string | null | undefined;
	totalCostUsd: number | null | undefined;
	onSelect: (model: string) => void;
	onShowPrice?: (model: ModelOption) => void;
	label?: string;
	/** Provider prefix → display name, used to label provider groups. */
	providerLabels?: Record<string, string>;
	/** When provided, an edit button on the "Default" group opens the global default model picker. */
	onEditDefaultModel?: () => void;
	/** When provided, an edit button on the "Summary" group opens the global summary model picker. */
	onEditSummaryModel?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [filter, setFilter] = useState("");
	const filterInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const id = window.setTimeout(() => filterInputRef.current?.focus({ preventScroll: true }));
		return () => window.clearTimeout(id);
	}, []);
	const groups = new Map<string, ModelOption[]>();
	for (const m of allModels) {
		if (!groups.has(prov)) groups.set(prov, []);
		groups.get(prov)?.push(m);
	}
	const provLabels: Record<string, string> = {
		openai: "OpenAI",
		...providerLabels,
		__default__: t("modelGroupDefault"),
		__summary__: t("modelGroupSummary"),
		__agg__: t("modelGroupAggregations"),
	};
	const entries = [...groups.entries()];
	const normalizedFilter = filter.trim().toLowerCase();
	const filteredEntries = normalizedFilter
		? entries
				.map(([prov, models]) => {
					const providerLabel = provLabels[prov] ?? prov;
					const filteredModels = models.filter((m) => {
						const haystack = [
							m.label,
							m.value,
							m.provider ?? "",
							providerLabel,
							m.rateMultiplier != null ? String(m.rateMultiplier) : "",
						]
							.join(" ")
							.toLowerCase();
						return haystack.includes(normalizedFilter);
					});
					return [prov, filteredModels] as const;
				})
				.filter(([, models]) => models.length > 0)
		: entries;
	// For aggregation selection check: parse current model to see if it's an aggregation
	const currentAgg = currentModel ? parseAggModelValue(currentModel) : null;
	return (
		<>
			{totalCostUsd != null && totalCostUsd > 0 && (
				<>
					<Menu.Label ta="right">${totalCostUsd.toFixed(4)}</Menu.Label>
					<Menu.Divider />
				</>
			)}
			{label && <Menu.Label>{label}</Menu.Label>}
			{filteredEntries.length === 0 ? (
				<Text c="dimmed" p="xs" size="xs">
					{t("noModelMatches")}
				</Text>
			) : (
				filteredEntries.map(([prov, models], gi) => {
					const isDefaultGroup = prov === "__default__";
					const isSummaryGroup = prov === "__summary__";
					const editHandler = isDefaultGroup
						? onEditDefaultModel
						: isSummaryGroup
							? onEditSummaryModel
							: undefined;
					return (
						<span key={prov}>
							{gi > 0 && <Menu.Divider />}
							{editHandler ? (
								<Menu.Label
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: 4,
									}}
								>
									<span>{provLabels[prov] ?? prov}</span>
									<ActionIcon
										component="div"
										role="button"
										tabIndex={0}
										variant="subtle"
										color="gray"
										size="sm"
										aria-label={isDefaultGroup ? t("editDefaultModel") : t("editSummaryModel")}
										title={isDefaultGroup ? t("editDefaultModel") : t("editSummaryModel")}
										onClick={(e) => {
											e.stopPropagation();
											e.preventDefault();
											editHandler();
										}}
									>
										<IconPencil size={12} />
									</ActionIcon>
								</Menu.Label>
							) : (
								<Menu.Label>{provLabels[prov] ?? prov}</Menu.Label>
							)}
							{models.map((m) => {
								// For aggregation items, check if the current model's aggId matches
								const isAggItem = m.provider === "__agg__";
								const aggId = isAggItem ? m.value.slice(AGG_MODEL_PREFIX.length) : null;
								const selected = isAggItem ? currentAgg?.aggId === aggId : currentModel === m.value;
								return (
									<Menu.Item
										key={m.value}
										onClick={() => onSelect(m.value)}
										rightSection={
											<Group gap={4} wrap="nowrap">
												{m.rateMultiplier != null && (
													<Badge size="xs" variant="outline" color="gray">
														×{m.rateMultiplier}
													</Badge>
												)}
												{m.pricing && (
													<ActionIcon
														component="div"
														role="button"
														tabIndex={0}
														variant="subtle"
														color="gray"
														size="sm"
														aria-label={t("viewModelPrice")}
														onClick={(e) => {
															e.stopPropagation();
															e.preventDefault();
															onShowPrice?.(m);
														}}
													>
														<IconInfoCircle size={14} />
													</ActionIcon>
												)}
												<IconCheck
													size={14}
													style={{ visibility: selected ? "visible" : "hidden" }}
												/>
											</Group>
										}
										fw={selected ? 600 : 400}
									>
										{m.label}
									</Menu.Item>
								);
							})}
						</span>
					);
				})
			)}
			<Menu.Divider />
			<Box
				p={4}
				style={{
					position: "sticky",
					bottom: 0,
					zIndex: 2,
					background: "var(--mantine-color-body)",
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<TextInput
					ref={filterInputRef}
					leftSection={<IconSearch size={14} />}
					onChange={(e) => setFilter(e.currentTarget.value)}
					onKeyDown={(e) => e.stopPropagation()}
					placeholder={t("modelFilterPlaceholder")}
					rightSection={
						filter ? (
							<CloseButton
								aria-label={t("clearModelFilter")}
								onClick={(e) => {
									e.stopPropagation();
									setFilter("");
								}}
								size="xs"
							/>
						) : undefined
					}
					size="xs"
					value={filter}
				/>
			</Box>
		</>
	);
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
 * A single queue-mode row: icon + label + description, with a right-side marker
 * that is either a check (this mode is the current binding) or a play icon
 * (clicking sends the current input with this mode right now).
 */
function QueueModeMenuItem({
	mode,
	selected,
	action,
	descriptionKey,
	onClick,
	t,
}: {
	mode: QueueMode;
	selected: boolean;
	/** "configure" shows a check on the active mode; "trigger" shows a play icon. */
	action: "configure" | "trigger";
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
				<Text size="sm">{t(`queueMode_${mode}`)}</Text>
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
 *   and the Ctrl/Cmd+Enter key are each bound to (two sections, check marks the
 *   current binding). Shift+Enter always inserts a native newline.
 * - When the input has content, it becomes a one-shot trigger: each queue mode
 *   sends the current input with that behavior immediately (play icons).
 */
function SendOptionsMenuContent({
	enterQueueMode,
	ctrlEnterQueueMode,
	hasInput,
	onSelectEnterMode,
	onSelectCtrlEnterMode,
	onSendWithMode,
	t,
}: {
	enterQueueMode: QueueMode;
	ctrlEnterQueueMode: QueueMode;
	hasInput: boolean;
	onSelectEnterMode: (mode: QueueMode) => void;
	onSelectCtrlEnterMode: (mode: QueueMode) => void;
	onSendWithMode: (mode: QueueMode) => void;
	t: (key: string) => string;
}) {
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

const ACCESS_LEVELS = ["readOnly", "readWrite", "full"] as const;
const DENY_LEVELS = ["denyWrite", "denyAll"] as const;

/**
 * Resize an image file using an offscreen canvas if its long edge exceeds maxEdge.
 * Returns the original file if no resize is needed.
 */
function CmdPatternInput({
	placeholder,
	onConfirm,
}: {
	placeholder: string;
	onConfirm: (pattern: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<>
			<TextInput
				size="xs"
				placeholder={placeholder}
				value={value}
				onChange={(e) => setValue(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.trim()) {
						onConfirm(value.trim());
						setValue("");
					}
				}}
				style={{ flex: 1 }}
			/>
			<Button
				size="xs"
				variant="light"
				disabled={!value.trim()}
				onClick={() => {
					if (value.trim()) {
						onConfirm(value.trim());
						setValue("");
					}
				}}
			>
				+
			</Button>
		</>
	);
}

function PathRulesPopover({ narratorId, t }: { narratorId: string; t: (key: string) => string }) {
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const [opened, { toggle, close }] = useDisclosure(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Only fetch rules when the popover is open — avoids 4 API calls on every page load
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

	const badgeCount = wlDirs.length + blDirs.length + cmdWl.length + cmdBl.length;

	// Custom click-outside handler that ignores clicks on portal children
	// (Combobox dropdowns, Modals) which live outside the Popover DOM tree.
	useEffect(() => {
		if (!opened) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			// Ignore clicks inside the popover dropdown itself
			if (dropdownRef.current?.contains(target)) return;
			// Ignore clicks inside any Mantine portal overlay (Modal, Combobox dropdown, etc.)
			if (target.closest(".mantine-Modal-root, .mantine-Modal-overlay, .mantine-Combobox-dropdown"))
				return;
			close();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [opened, close]);

	const trigger = (
		<Tooltip label={t("path_rules")}>
			<ActionIcon variant="subtle" color="gray" size="sm" onClick={toggle}>
				<IconFolderPlus size={16} />
				{badgeCount > 0 && (
					<Text size="8px" fw={700} c="indigo" style={{ position: "absolute", top: -2, right: -4 }}>
						{badgeCount}
					</Text>
				)}
			</ActionIcon>
		</Tooltip>
	);

	const content = (
		<Stack gap={10}>
			{/* ── Whitelist ── */}
			<Text size="xs" fw={600}>
				{t("whitelist_dirs_title")}
			</Text>
			{wlDirs.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("whitelist_dirs_empty")}
				</Text>
			)}
			{wlDirs.map((dir) => (
				<Group key={dir.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={dir.enabled}
						onChange={(e) => updateWl.mutate({ dirId: dir.id, enabled: e.currentTarget.checked })}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: dir.enabled ? 1 : 0.5,
						}}
						title={dir.path}
					>
						{dir.path}
					</Text>
					<SegmentedControl
						size="xs"
						value={dir.accessLevel}
						onChange={(v) =>
							updateWl.mutate({
								dirId: dir.id,
								accessLevel: v as (typeof ACCESS_LEVELS)[number],
							})
						}
						data={ACCESS_LEVELS.map((l) => ({
							value: l,
							label: t(`whitelist_access_${l}`),
						}))}
						style={{ flexShrink: 0 }}
					/>
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteWl.mutate(dir.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<PathInputWithBrowse
				placeholder={t("whitelist_dirs_placeholder")}
				onConfirm={(path) => createWl.mutate({ narratorId, path })}
			/>

			{/* ── Blacklist ── */}
			<Text size="xs" fw={600} mt={4}>
				{t("blacklist_dirs_title")}
			</Text>
			{blDirs.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("blacklist_dirs_empty")}
				</Text>
			)}
			{blDirs.map((dir) => (
				<Group key={dir.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={dir.enabled}
						onChange={(e) => updateBl.mutate({ dirId: dir.id, enabled: e.currentTarget.checked })}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: dir.enabled ? 1 : 0.5,
						}}
						title={dir.path}
					>
						{dir.path}
					</Text>
					<SegmentedControl
						size="xs"
						value={dir.denyLevel}
						onChange={(v) =>
							updateBl.mutate({
								dirId: dir.id,
								denyLevel: v as (typeof DENY_LEVELS)[number],
							})
						}
						data={DENY_LEVELS.map((l) => ({
							value: l,
							label: t(`blacklist_deny_${l}`),
						}))}
						style={{ flexShrink: 0 }}
					/>
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteBl.mutate(dir.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<PathInputWithBrowse
				placeholder={t("blacklist_dirs_placeholder")}
				onConfirm={(path) => createBl.mutate({ narratorId, path })}
			/>

			{/* ── Command Whitelist ── */}
			<Text size="xs" fw={600} mt={4}>
				{t("cmd_whitelist_title")}
			</Text>
			{cmdWl.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("cmd_whitelist_empty")}
				</Text>
			)}
			{cmdWl.map((cmd) => (
				<Group key={cmd.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={cmd.enabled}
						onChange={(e) =>
							updateCmdWl.mutate({ entryId: cmd.id, enabled: e.currentTarget.checked })
						}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: cmd.enabled ? 1 : 0.5,
						}}
						title={cmd.pattern}
					>
						{cmd.pattern}
					</Text>
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteCmdWl.mutate(cmd.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<Group gap={4} wrap="nowrap">
				<CmdPatternInput
					placeholder={t("cmd_whitelist_placeholder")}
					onConfirm={(pattern) => createCmdWl.mutate({ narratorId, pattern })}
				/>
			</Group>

			{/* ── Command Blacklist ── */}
			<Text size="xs" fw={600} mt={4}>
				{t("cmd_blacklist_title")}
			</Text>
			{cmdBl.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("cmd_blacklist_empty")}
				</Text>
			)}
			{cmdBl.map((cmd) => (
				<Group key={cmd.id} gap={6} wrap="nowrap" align="center">
					<Switch
						size="xs"
						checked={cmd.enabled}
						onChange={(e) =>
							updateCmdBl.mutate({ entryId: cmd.id, enabled: e.currentTarget.checked })
						}
					/>
					<Text
						size="xs"
						style={{
							flex: 1,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							opacity: cmd.enabled ? 1 : 0.5,
						}}
						title={cmd.pattern}
					>
						{cmd.pattern}
					</Text>
					{cmd.denyPrompt && (
						<Text size="xs" c="dimmed" title={cmd.denyPrompt}>
							💬
						</Text>
					)}
					<ActionIcon
						variant="subtle"
						color="red"
						size="xs"
						onClick={() => deleteCmdBl.mutate(cmd.id)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}
			<Group gap={4} wrap="nowrap">
				<CmdPatternInput
					placeholder={t("cmd_blacklist_placeholder")}
					onConfirm={(pattern) => createCmdBl.mutate({ narratorId, pattern })}
				/>
			</Group>
		</Stack>
	);

	if (isMobile) {
		return (
			<>
				{trigger}
				<Modal
					opened={opened}
					onClose={close}
					title={t("path_rules")}
					fullScreen
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
			width={420}
			shadow="md"
			withinPortal
			closeOnClickOutside={false}
		>
			<Popover.Target>{trigger}</Popover.Target>
			<Popover.Dropdown ref={dropdownRef}>{content}</Popover.Dropdown>
		</Popover>
	);
}

type ReasoningEffortValue = "none" | "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
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
 * Anthropic effort API tiers (Opus 4.6 / Sonnet 4.6 and Anthropic-compatible
 * relays). Anthropic has no "xhigh" tier — it exposes low/medium/high/max, plus
 * "none" to disable thinking.
 */
const ANTHROPIC_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
	"max",
];

const CODEX_REASONING_OPTIONS_BY_MODEL: Record<string, readonly ReasoningEffortValue[]> = {
	// Extracted from codex-reversed model catalog (supported_reasoning_levels).
	// Includes "none" for UI display (disables reasoning). The backend counterpart
	// (openai-provider CODEX_MODEL_REASONING_LEVELS) omits "none" because it is
	// handled separately before the table lookup.
	// gpt-5.6 family supports a real "max" tier (ultra exists upstream for
	// Sol/Terra but is not surfaced in NarraFork's UI enum).
	"gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.3-codex-spark": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.3-codex": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.2-codex": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1-codex-max": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1-codex": ["none", "low", "medium", "high"],
	"gpt-5.1-codex-mini": ["none", "medium", "high"],
	"gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["none", "low", "medium", "high", "xhigh"],
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
	return CODEX_REASONING_OPTIONS_BY_MODEL[bareModel] ?? DEFAULT_REASONING_EFFORT_OPTIONS;
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

function SortableQueuedMessageItem({
	msg,
	index,
	isEditing,
	editingText,
	onEditTextChange,
	onSaveEdit,
	onCancelEdit,
	onStartEdit,
	onRemove,
	cancelBufferLabel,
	editLabel,
	priorityLabel,
	priorityNextRequestLabel,
}: {
	msg: BufferMessageSummary;
	index: number;
	isEditing: boolean;
	editingText: string;
	onEditTextChange: (text: string) => void;
	onSaveEdit: () => void;
	onCancelEdit: () => void;
	onStartEdit: (msg: { id: string; text: string }) => void;
	onRemove: (id: string) => void;
	cancelBufferLabel: string;
	editLabel: string;
	priorityLabel: string;
	priorityNextRequestLabel: string;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: msg.id,
	});
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};
	const priorityText = index === 0 ? priorityNextRequestLabel : priorityLabel;

	return (
		<Group
			ref={setNodeRef}
			style={style}
			px="md"
			py={4}
			gap="xs"
			wrap="nowrap"
			bg="var(--mantine-color-blue-light)"
		>
			{isEditing ? (
				<>
					<div
						{...attributes}
						{...listeners}
						style={{
							cursor: "grab",
							display: "flex",
							alignItems: "center",
							flexShrink: 0,
							touchAction: "none",
							minWidth: 24,
							minHeight: 24,
							justifyContent: "center",
						}}
					>
						<Text size="xs" c="dimmed" w={16} ta="center">
							{index + 1}
						</Text>
					</div>
					<Textarea
						size="xs"
						value={editingText}
						onChange={(e) => onEditTextChange(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								onSaveEdit();
							}
							if (e.key === "Escape") onCancelEdit();
						}}
						autosize
						minRows={1}
						maxRows={4}
						style={{ flex: 1 }}
						autoFocus
					/>
					<ActionIcon size="xs" variant="subtle" color="green" onClick={onSaveEdit}>
						<IconCheck size={12} />
					</ActionIcon>
					<ActionIcon size="xs" variant="subtle" color="gray" onClick={onCancelEdit}>
						<IconX size={12} />
					</ActionIcon>
				</>
			) : (
				<>
					<div
						{...attributes}
						{...listeners}
						style={{
							cursor: "grab",
							display: "flex",
							alignItems: "center",
							flexShrink: 0,
							touchAction: "none",
							minWidth: 24,
							minHeight: 24,
							justifyContent: "center",
						}}
					>
						<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />
					</div>
					{msg.creator ? (
						<UserAvatar
							username={msg.creator.username}
							avatarColor={msg.creator.avatarColor}
							avatarImageId={msg.creator.avatarImageId}
							userId={msg.creator.id}
							size={16}
							showTooltip={false}
						/>
					) : (
						<Box w={16} h={16} style={{ flexShrink: 0 }} />
					)}
					{msg.imageCount > 0 && (
						<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
							<IconPhoto size={14} color="var(--mantine-color-blue-5)" />
							<Text size="xs" c="blue">
								{msg.imageCount}
							</Text>
						</Group>
					)}
					{msg.priority && (
						<Badge
							size="xs"
							color="orange"
							variant="light"
							leftSection={<IconBolt size={10} />}
							style={{ flexShrink: 0 }}
						>
							{priorityText}
						</Badge>
					)}
					<Text size="xs" c="blue" truncate style={{ flex: 1 }}>
						{msg.text}
					</Text>
					<ActionIcon
						size="xs"
						variant="subtle"
						color="blue"
						onClick={() => onStartEdit(msg)}
						title={editLabel}
					>
						<IconPencil size={12} />
					</ActionIcon>
					<CloseButton size="xs" onClick={() => onRemove(msg.id)} title={cancelBufferLabel} />
				</>
			)}
		</Group>
	);
}

/** Confirmation modal for rollback-to-block with file revert preview */
function RollbackConfirmModal({
	narratorId,
	pendingRollback,
	onConfirm,
	onCancel,
}: {
	narratorId: string;
	pendingRollback: { messageId: string; blockIndex: number } | null;
	onConfirm: () => void;
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
	const affectedFiles = data?.affectedFiles ?? [];

	let description: string;
	if (blockCount > 0 && messageCount > 0) {
		description = t("rollbackConfirmDesc", { blockCount, messageCount });
	} else if (blockCount > 0) {
		description = t("rollbackConfirmDescBlocksOnly", { blockCount });
	} else {
		description = t("rollbackConfirmDescMessagesOnly", { messageCount });
	}

	return (
		<Modal
			opened={!!pendingRollback}
			onClose={onCancel}
			title={t("rollbackConfirmTitle")}
			centered
			size="sm"
		>
			<Stack gap="md">
				{isLoading ? (
					<Center py="md">
						<Loader size="sm" />
					</Center>
				) : (
					<>
						<Text size="sm">{description}</Text>
						{affectedFiles.length > 0 ? (
							<>
								<Text size="sm" fw={500}>
									{t("rollbackConfirmFiles")}
								</Text>
								<Stack gap={4}>
									{affectedFiles.map((file) => (
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
							<Text size="sm" c="dimmed">
								{t("rollbackConfirmNoFiles")}
							</Text>
						)}
					</>
				)}
				<Group gap="xs" justify="flex-end">
					<Button size="xs" variant="subtle" onClick={onCancel}>
						{t("cancel")}
					</Button>
					<Button size="xs" color="red" onClick={onConfirm} loading={isLoading}>
						{t("rollbackConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
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
	onMinimize,
	onBack,
	onOpenStandalonePage,
	onViewSubagentSession,
	isResizing,
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

	// Unified dockview surface (optional): when present, the chat panel publishes
	// its cross-panel state (file-mod / details / browser) into the context and
	// bridges chat input to it, so sibling tool panels can consume it. Outside a
	// provider these all fall back to the legacy prop callbacks.
	const dock = useNarratorDockContext();
	// Effective sidebar callbacks: prefer explicit props, else route through dock.
	const effOnFileModPropsChange = onFileModPropsChange ?? dock?.setFileModProps;
	const effOnDetailsPropsChange = onDetailsPropsChange ?? dock?.setDetailsProps;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const chapterId = (narrator as any)?.chapterId as string | null | undefined;
	const { data: chapterData } = useChapter(chapterId ?? "");
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
	// Chunk mode is now the only live message-list implementation. Workspace
	// previews use a separate lightweight tail-chunk query below instead of the
	// old Query page model.
	const usesChunkMessageList = true;
	const messagesData = useMemo<MessagesQueryData | undefined>(() => undefined, []);
	const deferredMessagesData = messagesData;
	const hasNextPage = false;
	const hasPreviousPage = false;
	const isFetchingNextPage = false;
	const isFetchingPreviousPage = false;
	const fetchNextPage = useCallback(async () => undefined, []);
	const fetchPreviousPage = useCallback(async () => undefined, []);
	const canRenderMessageArea = true;
	const [chunkTailMeta, setChunkTailMeta] = useState<ChunkTailMeta>({ lastRealMessage: null });
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		setChunkTailMeta({ lastRealMessage: null });
	}, [narratorId]);
	const handleChunkTailMetaChange = useCallback((meta: ChunkTailMeta) => {
		setChunkTailMeta((prev) => {
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
	const [messageRenderPhase, setMessageRenderPhase] = useState<"tail" | "full">(() =>
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
	} = useAllModels();
	const { data: currentUser } = useCurrentUser();
	const currentUserId = currentUser?.id ? String(currentUser.id) : null;
	const { data: userPrefs } = useUserPreferences();
	const updateUserPrefs = useUpdateUserPreferences();
	const fastModeDefault = userPrefs?.fastModeDefault ?? false;
	const autoLoadEnabled = userPrefs?.autoLoadOlderMessages ?? true;
	const isMobileViewport = useMediaQuery("(max-width: 768px)") ?? false;
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
	const { t } = useTranslation("narrator");
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
	const qc = useQueryClient();
	const executionDevicesQuery = useQuery({
		queryKey: ["narratorExecutionDevices", narratorId],
		queryFn: () => api.getNarratorExecutionDevices(narratorId),
		enabled: !isWorkspacePreview,
		refetchInterval: 10_000,
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

	// Reasoning effort is supported by Codex, Anthropic, and OpenAI providers
	// (DeepSeek models via completions mode also support it)
	const supportsReasoningEffort = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		if (!providerPrefix) return false;
		if (codexCapableProviders.has(providerPrefix) || isCodexChannelModel) return true;
		if (
		) {
			return true;
		}
		// Check Anthropic providers
		const anthropicProviders = settingsData?.anthropicProviders ?? [];
		if (anthropicProviders.some((p: { prefix?: string }) => p.prefix === providerPrefix)) {
			return true;
		}
		// Check Gemini providers (gemini-compatible) — Gemini models support thinking
		const geminiProviders = settingsData?.geminiProviders ?? [];
		if (geminiProviders.some((p: { prefix?: string }) => p.prefix === providerPrefix)) {
			return true;
		}
		// Check OpenAI providers (completions mode) — DeepSeek models support thinking
		if (isDeepSeekModel(resolvedModel)) {
			const openaiProviders = settingsData?.openaiProviders ?? [];
			return openaiProviders.some((p: { prefix?: string }) => p.prefix === providerPrefix);
		}
		return false;
	}, [
		codexCapableProviders,
		isCodexChannelModel,
		resolvedModelOption,
		settingsData?.anthropicProviders,
		settingsData?.geminiProviders,
		settingsData?.openaiProviders,
		resolvedModel,
	]);
	const reasoningEffortOptions = useMemo(() => {
		if (!resolvedModel) return DEFAULT_REASONING_EFFORT_OPTIONS;
		// DeepSeek: only two effective tiers (high / max mapped from xhigh)
		if (isDeepSeekModel(resolvedModel)) return DEEPSEEK_REASONING_EFFORT_OPTIONS;
		}
		const providerPrefix = resolvedModel.split(":")[0];
		if (providerPrefix && (codexCapableProviders.has(providerPrefix) || isCodexChannelModel)) {
			return getCodexReasoningEffortOptions(resolvedModel, resolvedModelOption);
		}
		// Anthropic (official, compatible/cc relay, or NUG anthropic channel):
		// low/medium/high/max plus none. No xhigh tier upstream.
		const isAnthropic =
			resolvedModelOption?.channelType === "anthropic" ||
			(!!providerPrefix &&
				(settingsData?.anthropicProviders ?? []).some(
					(p: { prefix?: string }) => p.prefix === providerPrefix,
				));
		if (isAnthropic) {
			return ANTHROPIC_REASONING_EFFORT_OPTIONS;
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
		return DEFAULT_REASONING_EFFORT_OPTIONS;
	}, [
		codexCapableProviders,
		isCodexChannelModel,
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

	const messagesQueryKey = useMemo(
		() => ["narrators", narratorId, "messages", "legacy-disabled"] as const,
		[narratorId],
	);

	// --- Message operations ---
	const setUnreadCountRef = useRef<React.Dispatch<React.SetStateAction<number>>>(undefined);
	const handleDeleteBlock = useCallback(
		async (messageId: string, blockIndex: number) => {
			if (usesChunkMessageList) {
				try {
					await api.deleteMessageBlock(narratorId, messageId, blockIndex);
					chunkListRef.current?.refreshStructure("full");
				} catch {
					notifications.show({
						title: t("deleteMessageFailed"),
						message: t("deleteMessageFailedDesc"),
						color: "red",
						autoClose: 5000,
					});
				}
				return;
			}

			const prev = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
			qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length) return old;
				const pages = old.pages.map((page) => ({
					...page,
					messages: page.messages
						.map((m: NarratorMsg) => {
							if (m.id !== messageId) return m;
							const blocks = Array.isArray(m.contentJson) ? [...m.contentJson] : [];
							blocks.splice(blockIndex, 1);
							if (blocks.length === 0) return null;
							return { ...m, contentJson: blocks };
						})
						.filter(Boolean) as NarratorMsg[],
				}));
				return { ...old, pages };
			});
			try {
				await api.deleteMessageBlock(narratorId, messageId, blockIndex);
			} catch {
				qc.setQueryData(messagesQueryKey, prev);
				notifications.show({
					title: t("deleteMessageFailed"),
					message: t("deleteMessageFailedDesc"),
					color: "red",
					autoClose: 5000,
				});
			}
		},
		[qc, messagesQueryKey, narratorId, t],
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

	const confirmRollback = useCallback(async () => {
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
			await api.rollbackToBlock(narratorId, pendingRollback.messageId, pendingRollback.blockIndex);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to rollback";
			notifications.show({ title: t("rollbackFailed"), message, color: "red" });
		}
		setPendingRollback(null);
	}, [
		narratorId,
		pendingRollback,
		rollbackEditRegenerateSupported,
		rollbackEditRegenerateUnsupportedReason,
		t,
	]);

	const handleEditAndRegenerate = useCallback(
		async (
			messageId: string,
			newContent: string,
			rollback: boolean,
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
				return await api.editAndRegenerate(narratorId, messageId, newContent, rollback, opts);
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

	// --- Input management ---
	const [input, setInput] = useState("");
	const [draftHydrated, setDraftHydrated] = useState(false);
	const [draftSyncState, setDraftSyncState] = useState<"loading" | "ready" | "error" | "conflict">(
		"loading",
	);
	const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
	const inputRef = useRef(input);
	inputRef.current = input;
	const sendingRef = useRef(false);
	const draftSourceIdRef = useRef(createDraftSourceId());
	const lastSyncedDraftRef = useRef("");
	const lastDraftRevisionRef = useRef<number | null>(null);
	const lastDraftUpdatedAtRef = useRef<string | null>(null);
	const draftConflictRef = useRef<{
		hasDraft: boolean;
		text: string;
		revision: number;
		updatedAt: string | null;
		updatedBy: string | null;
		sourceId: string | null;
	} | null>(null);
	const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const draftSyncSeqRef = useRef(0);
	const inputHistory = useInputHistory(
		currentUserId
			? getNarratorInputHistoryKey(currentUserId, narratorId)
			: `narrafork_input_history_pending_${narratorId}`,
	);
	useEffect(() => {
		if (!currentUserId || !draftHydrated || sendingRef.current) return;
		persistNarratorInputDraft(
			currentUserId,
			narratorId,
			input,
			lastDraftRevisionRef.current,
			lastDraftUpdatedAtRef.current,
		);
	}, [currentUserId, draftHydrated, input, narratorId]);

	const syncDraftNow = useCallback(
		async (text: string, baseRevision = lastDraftRevisionRef.current) => {
			if (!currentUserId) throw new Error("Current user is unavailable");
			if (baseRevision == null) throw new Error("Draft has not been loaded from the server");
			if (!isDraftWithinSyncLimit(text)) {
				throw new Error(`Draft exceeds the ${MAX_NARRATOR_DRAFT_CHARS} character sync limit`);
			}
			if (draftSyncTimerRef.current) {
				clearTimeout(draftSyncTimerRef.current);
				draftSyncTimerRef.current = null;
			}
			const seq = ++draftSyncSeqRef.current;
			try {
				const result = await api.updateNarratorDraft(
					narratorId,
					text,
					baseRevision,
					draftSourceIdRef.current,
				);
				if (seq === draftSyncSeqRef.current) {
					lastSyncedDraftRef.current = result.text;
					lastDraftRevisionRef.current = result.revision;
					lastDraftUpdatedAtRef.current = result.updatedAt;
					draftConflictRef.current = null;
					setDraftSyncState("ready");
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						inputRef.current,
						result.revision,
						result.updatedAt,
					);
					qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
						old ? { ...old, traits: result.traits, hasDraft: result.hasDraft } : old,
					);
				}
				return result;
			} catch (err) {
				const current =
					err instanceof ApiError && err.status === 409
						? (err.data?.current as
								| {
										hasDraft?: unknown;
										text?: unknown;
										revision?: unknown;
										updatedAt?: unknown;
										updatedBy?: unknown;
										sourceId?: unknown;
								  }
								| undefined)
						: undefined;
				if (current && typeof current.text === "string" && typeof current.revision === "number") {
					draftConflictRef.current = {
						hasDraft: !!current.hasDraft,
						text: current.text,
						revision: current.revision,
						updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : null,
						updatedBy: typeof current.updatedBy === "string" ? current.updatedBy : null,
						sourceId: typeof current.sourceId === "string" ? current.sourceId : null,
					};
					setDraftSyncState("conflict");
				}
				throw err;
			}
		},
		[currentUserId, narratorId, qc],
	);

	const clearInputAndDraft = useCallback(() => {
		setInput("");
		if (draftSyncState === "ready") void syncDraftNow("").catch(() => {});
	}, [draftSyncState, syncDraftNow]);

	const hideInputForSend = useCallback(() => {
		setInput("");
	}, []);

	useEffect(() => {
		void draftLoadAttempt;
		if (!currentUserId) {
			setDraftHydrated(false);
			setDraftSyncState("loading");
			return;
		}
		let cancelled = false;
		setDraftHydrated(false);
		setDraftSyncState("loading");
		draftConflictRef.current = null;
		lastSyncedDraftRef.current = "";
		lastDraftRevisionRef.current = null;
		if (draftSyncTimerRef.current) {
			clearTimeout(draftSyncTimerRef.current);
			draftSyncTimerRef.current = null;
		}
		cleanupLegacyNarratorInputStorage(narratorId);
		const localDraft = readNarratorInputDraft(currentUserId, narratorId);
		lastDraftRevisionRef.current = localDraft.serverRevision;
		lastDraftUpdatedAtRef.current = localDraft.serverUpdatedAt;
		inputRef.current = localDraft.text;
		setInput(localDraft.text);
		setDraftHydrated(true);
		const localDraftAtRequest = localDraft.text;

		api
			.getNarratorDraft(narratorId)
			.then((draft) => {
				if (cancelled) return;
				const serverText = draft.hasDraft ? draft.text : "";
				const currentInput = inputRef.current;
				const resolved = resolveHydratedNarratorDraft({
					local: localDraft,
					serverText,
					serverRevision: draft.revision,
					currentInput,
					localChangedSinceRequest: currentInput !== localDraftAtRequest,
				});
				lastSyncedDraftRef.current = serverText;
				lastDraftRevisionRef.current = resolved.conflict
					? localDraft.serverRevision
					: draft.revision;
				lastDraftUpdatedAtRef.current = resolved.conflict
					? localDraft.serverUpdatedAt
					: draft.updatedAt;
				inputRef.current = resolved.text;
				setInput(resolved.text);
				persistNarratorInputDraft(
					currentUserId,
					narratorId,
					resolved.text,
					resolved.conflict ? localDraft.serverRevision : draft.revision,
					resolved.conflict ? localDraft.serverUpdatedAt : draft.updatedAt,
				);
				if (resolved.conflict) {
					draftConflictRef.current = draft;
					setDraftSyncState("conflict");
				} else {
					setDraftSyncState("ready");
				}
			})
			.catch(() => {
				if (!cancelled) setDraftSyncState("error");
			});
		return () => {
			cancelled = true;
		};
	}, [currentUserId, draftLoadAttempt, narratorId]);

	useEffect(() => {
		if (!draftHydrated || !currentUserId || draftSyncState !== "ready" || sendingRef.current)
			return;
		if (!isDraftWithinSyncLimit(input)) return;
		if (input === lastSyncedDraftRef.current) return;
		if (draftSyncTimerRef.current) clearTimeout(draftSyncTimerRef.current);
		draftSyncTimerRef.current = setTimeout(() => {
			draftSyncTimerRef.current = null;
			void syncDraftNow(inputRef.current).catch((err) => {
				if (import.meta.env.DEV) console.warn("[NarratorPanel] draft sync failed:", err);
			});
		}, INPUT_DRAFT_SYNC_DEBOUNCE_MS);
		return () => {
			if (draftSyncTimerRef.current) {
				clearTimeout(draftSyncTimerRef.current);
				draftSyncTimerRef.current = null;
			}
		};
	}, [currentUserId, draftHydrated, draftSyncState, input, syncDraftNow]);

	const retryDraftHydration = useCallback(() => {
		setDraftLoadAttempt((attempt) => attempt + 1);
	}, []);

	const acceptServerDraft = useCallback(() => {
		const remote = draftConflictRef.current;
		if (!remote || !currentUserId) return;
		const remoteText = remote.hasDraft ? remote.text : "";
		lastSyncedDraftRef.current = remoteText;
		lastDraftRevisionRef.current = remote.revision;
		lastDraftUpdatedAtRef.current = remote.updatedAt;
		draftConflictRef.current = null;
		inputRef.current = remoteText;
		setInput(remoteText);
		setDraftSyncState("ready");
		persistNarratorInputDraft(
			currentUserId,
			narratorId,
			remoteText,
			remote.revision,
			remote.updatedAt,
		);
	}, [currentUserId, narratorId]);

	const commitInputDraftAfterSend = useCallback(() => {
		if (draftSyncState === "ready") {
			setDraftSyncState("loading");
			void syncDraftNow("").catch(() => setDraftSyncState("error"));
		} else if (draftSyncState === "conflict") {
			// The local text was sent, but another client owns a newer draft. Keep that
			// remote draft rather than clearing it as a side effect of this send.
			acceptServerDraft();
		}
	}, [draftSyncState, syncDraftNow, acceptServerDraft]);

	const overwriteServerDraft = useCallback(() => {
		const remote = draftConflictRef.current;
		if (!remote) return;
		void syncDraftNow(inputRef.current, remote.revision).catch((err) => {
			notifications.show({
				title: t("draftSyncFailed"),
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		});
	}, [syncDraftNow, t]);

	const handleDraftChanged = useCallback(
		(draft: {
			hasDraft: boolean;
			text: string;
			revision: number;
			updatedAt: string | null;
			updatedBy: string | null;
			sourceId: string | null;
		}) => {
			const currentRevision = lastDraftRevisionRef.current;
			if (currentRevision != null && draft.revision < currentRevision) return;
			const remoteText = draft.hasDraft ? draft.text : "";
			const hasLocalUnsyncedChanges = inputRef.current !== lastSyncedDraftRef.current;
			if (
				draft.sourceId !== draftSourceIdRef.current &&
				hasLocalUnsyncedChanges &&
				remoteText !== inputRef.current
			) {
				draftConflictRef.current = draft;
				setDraftSyncState("conflict");
				return;
			}
			lastSyncedDraftRef.current = remoteText;
			lastDraftRevisionRef.current = draft.revision;
			lastDraftUpdatedAtRef.current = draft.updatedAt;
			draftConflictRef.current = null;
			setDraftSyncState("ready");
			const shouldApplyRemote = draft.sourceId !== draftSourceIdRef.current;
			const nextInput = shouldApplyRemote ? remoteText : inputRef.current;
			if (currentUserId) {
				persistNarratorInputDraft(
					currentUserId,
					narratorId,
					nextInput,
					draft.revision,
					draft.updatedAt,
				);
			}
			if (shouldApplyRemote) setInput(remoteText);
		},
		[currentUserId, narratorId],
	);

	// --- Command popover ---
	// Only fetch commands when user starts typing "/" to avoid unnecessary API call on page load
	const { data: commandsList } = useNarratorCommands(
		input.startsWith("/") ? narratorId : undefined,
	);
	// Show command popover only when typing command name (no space yet),
	// or when typing optional tool sub-completion (/load <tool>, /unload <tool>).
	// Suppress when browsing input history so arrow keys keep navigating history.
	const commandPopoverVisible =
		input.startsWith("/") &&
		!input.includes("\n") &&
		(!input.includes(" ") ||
			// /load <tool>, /unload <tool>, and the skill sub-completions
			// (/load skill <name>, /unload all_skills, ...).
			/^\/(?:load|unload)\s(?:skill(?:\s\S*)?|\S*)$/i.test(input)) &&
		(commandsList?.length ?? 0) > 0 &&
		!inputHistory.isBrowsing;
	// Matched command for param helper (after space is typed)
	const matchedCommand = useMemo(() => {
		if (!input.startsWith("/") || !commandsList?.length) return null;
		const spaceIdx = input.indexOf(" ");
		if (spaceIdx === -1) return null;
		const cmdName = input.slice(1, spaceIdx);
		return (
			commandsList.find(
				(c) => c.name.toLowerCase() === cmdName.toLowerCase() && c.type === "command",
			) ?? null
		);
	}, [input, commandsList]);
	const handleCommandSelect = useCallback((cmd: CommandItem) => {
		if (cmd.type === "skill") {
			// Skill selected — use /skill command so backend injects content directly
			setInput(`/skill ${cmd.name} `);
		} else if (cmd.type === "tool" && !cmd.name.includes(" ")) {
			// Parent /load entry — expand to show sub-items
			setInput(`/${cmd.name} `);
		} else {
			// Always keep command format — user can continue typing or press space for params
			setInput(`/${cmd.name}`);
		}
	}, []);
	const closeCommandPopover = useCallback(() => {
		clearInputAndDraft();
	}, [clearInputAndDraft]);

	// === @mention of named narrators ===========================================
	const { data: namedNarrators } = useNamedNarrators();
	const [mentionCaret, setMentionCaret] = useState<number | null>(null);
	const mentionQuery = useMemo(() => {
		if (mentionCaret === null) return null;
		// Don't compete with the slash-command popover.
		if (input.startsWith("/")) return null;
		return getMentionQuery(input, mentionCaret);
	}, [input, mentionCaret]);
	const mentionCandidates = useMemo<MentionCandidate[]>(() => {
		if (!namedNarrators) return [];
		return namedNarrators
			.filter((n: { handle?: string | null }) => !!n.handle)
			.map((n: { id: string; handle: string; title?: string | null; status?: string }) => ({
				id: n.id,
				handle: n.handle,
				title: n.title,
				status: n.status,
			}));
	}, [namedNarrators]);
	const mentionPopoverVisible =
		mentionQuery !== null && !inputHistory.isBrowsing && mentionCandidates.length > 0;
	const handleMentionSelect = useCallback(
		(candidate: MentionCandidate) => {
			const caret = mentionCaret;
			if (caret === null) return;
			const upto = input.slice(0, caret);
			const at = upto.lastIndexOf("@");
			if (at === -1) return;
			const before = input.slice(0, at);
			const after = input.slice(caret);
			const insert = `@${candidate.handle} `;
			const next = before + insert + after;
			setInput(next);
			// Move caret to just after the inserted handle.
			const nextCaret = before.length + insert.length;
			requestAnimationFrame(() => {
				const ta = textareaRef.current;
				if (ta) {
					ta.focus();
					ta.setSelectionRange(nextCaret, nextCaret);
				}
				setMentionCaret(nextCaret);
			});
		},
		[input, mentionCaret],
	);
	const closeMentionPopover = useCallback(() => setMentionCaret(null), []);

	useEffect(() => {
		const append = (text: string) => setInput((prev) => (prev ? `${prev}\n${text}` : text));
		if (appendInputRef) {
			appendInputRef.current = append;
		}
		// In dock mode also register the appender so a sibling terminal panel can
		// push selected text into this chat input without a shared React parent.
		const unregister = dock?.registerAppendChatInput(append);
		return () => {
			if (appendInputRef) appendInputRef.current = null;
			unregister?.();
		};
	}, [appendInputRef, dock]);
	const [attachedImages, setAttachedImages] = useState<File[]>([]);
	const openImageViewer = useImageViewer();
	const attachedImagesRef = useRef<File[]>(attachedImages);
	attachedImagesRef.current = attachedImages;
	const imageDraftHydratedKeyRef = useRef<string | null>(null);
	const imageDraftSaveSeqRef = useRef(0);
	const imageDraftLocalVersionRef = useRef(0);
	const [attachedTextFiles, setAttachedTextFiles] = useState<File[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const dragCounterRef = useRef(0);
	const warnDraftImagesPersistenceFailure = useCallback((action: string, err: unknown) => {
		if (import.meta.env.DEV) {
			console.warn(`[NarratorPanel] Failed to ${action} draft images:`, err);
		}
	}, []);
	const updateAttachedImages = useCallback((next: SetStateAction<File[]>) => {
		imageDraftLocalVersionRef.current++;
		setAttachedImages((prev) => {
			const resolved = typeof next === "function" ? (next as (prev: File[]) => File[])(prev) : next;
			attachedImagesRef.current = resolved;
			return resolved;
		});
	}, []);
	const persistCurrentDraftImages = useCallback(
		(targetUserId: string, targetNarratorId: string) => {
			const seq = ++imageDraftSaveSeqRef.current;
			void saveDraftImageAttachments(
				targetUserId,
				targetNarratorId,
				attachedImagesRef.current,
			).catch((err) => {
				if (seq === imageDraftSaveSeqRef.current) {
					warnDraftImagesPersistenceFailure("save", err);
				}
			});
		},
		[warnDraftImagesPersistenceFailure],
	);
	const hideAttachedImagesForSend = useCallback(() => {
		imageDraftLocalVersionRef.current++;
		attachedImagesRef.current = [];
		setAttachedImages([]);
	}, []);
	const clearAttachedImagesAndDraft = useCallback(() => {
		imageDraftLocalVersionRef.current++;
		attachedImagesRef.current = [];
		setAttachedImages([]);
		if (!currentUserId) return;
		const seq = ++imageDraftSaveSeqRef.current;
		void clearDraftImageAttachments(currentUserId, narratorId).catch((err) => {
			if (seq === imageDraftSaveSeqRef.current) {
				warnDraftImagesPersistenceFailure("clear", err);
			}
		});
	}, [currentUserId, narratorId, warnDraftImagesPersistenceFailure]);

	useEffect(() => {
		let cancelled = false;
		const localVersionAtRequest = imageDraftLocalVersionRef.current;
		const draftKey = currentUserId ? getDraftImageAttachmentKey(currentUserId, narratorId) : null;
		imageDraftHydratedKeyRef.current = null;
		attachedImagesRef.current = [];
		setAttachedImages([]);
		if (!currentUserId || !draftKey) return;

		const persistLocalChanges = () => {
			if (imageDraftLocalVersionRef.current !== localVersionAtRequest) {
				persistCurrentDraftImages(currentUserId, narratorId);
			}
		};

		void loadDraftImageAttachments(currentUserId, narratorId)
			.then((files) => {
				if (cancelled) return;
				imageDraftHydratedKeyRef.current = draftKey;
				if (imageDraftLocalVersionRef.current === localVersionAtRequest) {
					attachedImagesRef.current = files;
					setAttachedImages(files);
				} else {
					persistLocalChanges();
				}
			})
			.catch((err) => {
				if (cancelled) return;
				warnDraftImagesPersistenceFailure("load", err);
				imageDraftHydratedKeyRef.current = draftKey;
				persistLocalChanges();
			});

		return () => {
			cancelled = true;
		};
	}, [currentUserId, narratorId, persistCurrentDraftImages, warnDraftImagesPersistenceFailure]);

	useEffect(() => {
		if (
			!currentUserId ||
			sendingRef.current ||
			imageDraftHydratedKeyRef.current !== getDraftImageAttachmentKey(currentUserId, narratorId)
		)
			return;
		const seq = ++imageDraftSaveSeqRef.current;
		void saveDraftImageAttachments(currentUserId, narratorId, attachedImages).catch((err) => {
			if (seq === imageDraftSaveSeqRef.current) {
				warnDraftImagesPersistenceFailure("save", err);
			}
		});
	}, [attachedImages, currentUserId, narratorId, warnDraftImagesPersistenceFailure]);

	// --- Scroll state ---
	const [isAtBottom, setIsAtBottom] = useState(true);
	const viewportRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const chunkListRef = useRef<ChunkedMessageListHandle>(null);
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;
	const isTailRenderWindowRef = useRef(true);
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
	const resizingRef = useRef(false);

	const lastFollowScrollTop = useRef(0);

	const startFollowing = useCallback(() => {
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
				if (isTailRenderWindowRef.current && !isAtBottomRef.current) {
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

	const detachFromFullBottom = useCallback(() => {
		stopFollowing();
		if (isAtBottomRef.current) {
			isAtBottomRef.current = false;
			setIsAtBottom(false);
		}
	}, [stopFollowing]);

	const scrollToBottom = useCallback(
		(instant?: boolean) => {
			if (usesChunkMessageList) {
				chunkListRef.current?.scrollToBottom(instant);
				return;
			}
			const vp = viewportRef.current;
			if (!vp) return;
			if (isTailRenderWindowRef.current) {
				if (!isAtBottomRef.current) {
					isAtBottomRef.current = true;
					setIsAtBottom(true);
				}
				setUnreadCountRef.current?.(0);
			}
			if (instant) {
				programmaticScrollRef.current = true;
				vp.scrollTop = getMessageViewportScrollBottom(vp);
			} else {
				startFollowing();
			}
		},
		[startFollowing],
	);
	scrollToBottomRef.current = scrollToBottom;
	const wasWorkspacePreviewRef = useRef(isWorkspacePreview);
	useEffect(() => {
		const wasWorkspacePreview = wasWorkspacePreviewRef.current;
		if (wasWorkspacePreview && !isWorkspacePreview) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					scrollToBottom(true);
					if (!suppressAutoFocusOnPromote) {
						textareaRef.current?.focus();
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
	}, [resolvedModel, settingsData?.customApiProviders, settingsData?.customApiQuotas]);

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
		messagesData: undefined,
		messagesQueryKey,
		legacyMessageCacheUpdatesEnabled: false,
		initialMessageStatus: chunkTailMeta,
		isAtBottomRef,
		scrollToBottom,
		isSubagent,
		narratorSubstatus,
		initialQuotaBalance: customApiProviderInfo?.quotaBalance ?? nugProviderInfo?.quotaBalance,
		initialDetailedQuotaBalance:
			customApiProviderInfo?.detailedQuotaBalance ?? nugProviderInfo?.detailedQuotaBalance,
		customApiProviderId: customApiProviderInfo?.providerId,
		nugProviderId: nugProviderInfo?.providerId,
		quotaProviderKey: customApiProviderInfo?.providerId ?? nugProviderInfo?.providerId,
		onDraftChanged: handleDraftChanged,
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
		streamingVersion,
		topLevelStreamingChunks,
		streamingBlocksRef,
		renderPermCb,
		queuedMessages,
		setQueuedMessages,
		substatus,
		contextPercent,
		promptTokens,
		contextWindow,
		isEstimated,
		contextStale,
		activePruneStart,
		activeCompactStart,
		pruneBoundaryMessageId,
		prunedPercent,
		quotaBalance,
		detailedQuotaBalance,
		retryInfo,
		paymentRequired,
		setPaymentRequired,
		leakedToolEvent,
		setLeakedToolEvent,
		expandedToolUseId,
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

	// Stable resolvePerm callback for renderTreeMessages — uses a ref to avoid
	// recreating on every permission state change, which would break memo on
	// MessageBubble and cascade re-renders through all reasoning summaries.
	const renderPermCbRef = useRef(renderPermCb);
	renderPermCbRef.current = renderPermCb;
	const resolvePermForRender = useCallback((tc: import("./ToolCallCard").ToolCallData) => {
		const p = renderPermCbRef.current;
		return resolvePendingPerm(tc, p.pendingPermission, p.pendingPermsMap);
	}, []);

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
	const tasksToolOpened = dock ? dock.openToolTypes.has("tasks") : false;
	const toggleTasksTool = useCallback(() => {
		dock?.toggleToolPanel("tasks");
	}, [dock]);

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
	const [deletePreviewMessageId, setDeletePreviewMessageId] = useState<string | null>(null);
	const [pendingDeleteCallback, setPendingDeleteCallback] = useState<(() => void) | null>(null);
	// Get the first pending Write/Edit permission for the drawer
	const firstEditPermission = useMemo(() => {
		for (const perm of renderPermCb.pendingPermsMap.values()) {
			if (perm.toolName === "Write" || perm.toolName === "Edit") {
				return perm;
			}
		}
		return null;
	}, [renderPermCb.pendingPermsMap]);

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
	const isActive = narrator?.status === "working" || narrator?.status === "waiting";
	const isWaiting = narrator?.status === "waiting";
	// Takeover: the user is operating this subagent directly while the parent
	// tool call stays blocked. canTakeover is shown only while the subagent is
	// running and not already taken over.
	const isTakenOver = isSubagent && substatus.includes("taken_over");
	const canTakeover = isSubagent && isActive && !isTakenOver && retryRecoveryAllowsInterrupt;
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
	// Derive compacting flags from substatus. "compacting" is blocking; background compact
	// can run alongside an active turn or after the turn has become idle.
	const isBlockingCompacting = substatus.includes("compacting");
	const isBackgroundCompacting = substatus.includes("background_compacting");
	const isCompacting = isBlockingCompacting || isBackgroundCompacting;
	const queuePosition = substatus.find((s) => s.startsWith("queue_position:"));
	const queueDepth = substatus.find((s) => s.startsWith("queue_depth:"));
	const queueMessage = substatus.find((s) => s.startsWith("queue_message:"));
	const queuePositionValue = queuePosition ? Number(queuePosition.split(":")[1]) : null;
	const queueDepthValue = queueDepth ? Number(queueDepth.split(":")[1]) : null;
	const queueMessageValue = queueMessage
		? decodeURIComponent(queueMessage.slice("queue_message:".length))
		: null;
	const showWorkIndicator = !!(isWorking || isWaiting || isCompacting || isRetrying);

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
		const formatted = formatLocaleDateTime(turnStartedAt, {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		return formatted ? t("toolStartedAt", { time: formatted }) : null;
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

	// True when the main input is empty and there's a non-question pending permission.
	// Used to show Enter-key hints on permission buttons via PermEnterHintCtx.
	const permHintActive =
		!input.trim() &&
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
	const textareaRef = useRef<HTMLTextAreaElement>(null);
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

	// Force react-textarea-autosize to recalculate after viewport width
	// changes (e.g. DevTools mobile↔desktop toggle). The library recalculates
	// on window "resize" but can read stale layout during rapid toggles.
	// Bumping a counter triggers a React re-render → useLayoutEffect inside
	// TextareaAutosize fires resizeTextarea() with the final layout values.
	const [, setTextareaResizeTick] = useState(0);
	useEffect(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		let prevWidth = ta.clientWidth;
		let timer = 0;
		const ro = new ResizeObserver(() => {
			const w = ta.clientWidth;
			if (w !== prevWidth) {
				prevWidth = w;
				clearTimeout(timer);
				// Wait for layout to settle before triggering re-render
				timer = window.setTimeout(() => {
					setTextareaResizeTick((n) => n + 1);
				}, 100);
			}
		});
		ro.observe(ta);
		return () => {
			clearTimeout(timer);
			ro.disconnect();
		};
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
			await api.updateNarratorTitle(narratorId, trimmed);
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
		} finally {
			setGeneratingTitle(false);
		}
	};
	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
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

	// --- Hydration & message counting ---
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => {
			startTransition(() => setHydrated(true));
		});
		return () => cancelAnimationFrame(id);
	}, []);
	// Lightweight derived values — avoid full reverse().flatMap() on every update.
	const totalMessageCount = useMemo(() => {
		if (!hydrated || !deferredMessagesData?.pages) return 0;
		return deferredMessagesData.pages.reduce((sum, p) => sum + (p.messages?.length ?? 0), 0);
	}, [hydrated, deferredMessagesData]);

	const lastMessage = useMemo<NarratorMsg | null>(() => {
		if (!hydrated || !deferredMessagesData?.pages?.length) return null;
		const orderedMessages = getRenderableMessageOrder(deferredMessagesData.pages).messages;
		for (let i = orderedMessages.length - 1; i >= 0; i--) {
			const msg = orderedMessages[i];
			if (!msg || msg.id === STREAMING_CHUNKS_MSG_ID) continue;
			// Skip error system messages so they don't hide the retry button
			if (
				msg.role === "system" &&
				Array.isArray(msg.contentJson) &&
				msg.contentJson.some((b: { type: string }) => b.type === "error")
			) {
				continue;
			}
			return msg;
		}
		return null;
	}, [hydrated, deferredMessagesData]);

	const narratorIsIdle = narrator?.status === "idle";
	const effectiveLastMessage = usesChunkMessageList ? chunkTailMeta.lastRealMessage : lastMessage;

	const canRetryLastUserMessage =
		!!effectiveLastMessage &&
		effectiveLastMessage.role === "user" &&
		!String(effectiveLastMessage.id).startsWith("optimistic-") &&
		narratorIsIdle &&
		retryRecoveryAllowsRetry;

	const canContinueNarrator =
		!!effectiveLastMessage &&
		effectiveLastMessage.role === "assistant" &&
		!String(effectiveLastMessage.id).startsWith("optimistic-") &&
		narratorIsIdle &&
		retryRecoveryAllowsContinue;

	// Find the last user message ID for edit confirmation logic
	const legacyLastUserMessageId = useMemo(() => {
		if (!hydrated || !deferredMessagesData?.pages) return undefined;
		const orderedMessages = getRenderableMessageOrder(deferredMessagesData.pages).messages;
		for (let i = orderedMessages.length - 1; i >= 0; i--) {
			const msg = orderedMessages[i];
			if (msg?.role === "user" && !String(msg.id).startsWith("optimistic-")) {
				return msg.id;
			}
		}
		return undefined;
	}, [hydrated, deferredMessagesData]);
	const lastUserMessageId = usesChunkMessageList
		? chunkTailMeta.lastUserMessageId
		: legacyLastUserMessageId;

	const hasChapter = !!narrator?.chapterId;

	// --- Fork handler ---
	// Standalone narrators: fork narrator directly (no git involved)
	const handleStandaloneFork = useCallback(
		(messageUuid: string) => {
			forkNarratorMutation.mutate(
				{ narratorId, forkMessageUuid: messageUuid },
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
	const highlightScrolledRef = useRef(false);
	const highlightStartTimerRef = useRef<number | null>(null);
	const highlightClearTimerRef = useRef<number | null>(null);
	const initialScrollDoneRef = useRef(false);
	const [initialScrollDone, setInitialScrollDone] = useState(false);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const usePixiRenderer = false;
	const virtualListRef = useRef<BroadMessageListHandle>(null);

	const clearHighlightTimers = useCallback(() => {
		if (highlightStartTimerRef.current != null) {
			window.clearTimeout(highlightStartTimerRef.current);
			highlightStartTimerRef.current = null;
		}
		if (highlightClearTimerRef.current != null) {
			window.clearTimeout(highlightClearTimerRef.current);
			highlightClearTimerRef.current = null;
		}
	}, []);

	const scheduleHighlight = useCallback(
		(messageId: string, delayMs: number) => {
			clearHighlightTimers();
			highlightStartTimerRef.current = window.setTimeout(() => {
				setHighlightedId(messageId);
				highlightClearTimerRef.current = window.setTimeout(() => {
					setHighlightedId((current) => (current === messageId ? null : current));
					highlightClearTimerRef.current = null;
				}, 1600);
				highlightStartTimerRef.current = null;
			}, delayMs);
		},
		[clearHighlightTimers],
	);

	const stableToolRunKeyByTargetIdRef = useRef<Map<string, string>>(new Map());
	const nextStableToolRunKeyRef = useRef(1);
	const pageCacheRef = useRef(new Map<string, PageRenderCacheEntry>());
	const prevNarratorIdRef = useRef(narratorId);
	if (prevNarratorIdRef.current !== narratorId) {
		prevNarratorIdRef.current = narratorId;
		if (initialScrollDoneRef.current) {
			initialScrollDoneRef.current = false;
			setInitialScrollDone(false);
		}
		stableToolRunKeyByTargetIdRef.current.clear();
		nextStableToolRunKeyRef.current = 1;
		pageCacheRef.current.clear();
	}

	useEffect(() => {
		return () => {
			stableToolRunKeyByTargetIdRef.current.clear();
			nextStableToolRunKeyRef.current = 1;
			pageCacheRef.current.clear();
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId/highlightMessageId are used to reset one-shot highlight state when the active target changes
	useEffect(() => {
		highlightScrolledRef.current = false;
		clearHighlightTimers();
		setHighlightedId(null);
	}, [narratorId, highlightMessageId, clearHighlightTimers]);

	useEffect(() => clearHighlightTimers, [clearHighlightTimers]);

	const getStableRenderElementKey = useCallback(
		(rawKey: string, targetIds: string[], pageKey?: string, usedKeys?: Set<string>) => {
			if (!rawKey.includes("tool-run-")) {
				return pageKey ? `${pageKey}-${rawKey}` : rawKey;
			}
			if (targetIds.length === 0) {
				return pageKey ? `${pageKey}-${rawKey}` : rawKey;
			}

			let stableKey: string | undefined;
			for (const targetId of targetIds) {
				stableKey = stableToolRunKeyByTargetIdRef.current.get(targetId);
				if (stableKey) break;
			}
			// If the found key is already used in this render batch (e.g. same msg.id
			// produced multiple tool-run segments split by content blocks), allocate
			// a fresh key to avoid duplicate React keys.
			if (stableKey && usedKeys?.has(stableKey)) {
				stableKey = undefined;
			}
			if (!stableKey) {
				stableKey = `tool-run-stable-${nextStableToolRunKeyRef.current++}`;
			}
			for (const targetId of targetIds) {
				stableToolRunKeyByTargetIdRef.current.set(targetId, stableKey);
			}
			return stableKey;
		},
		[],
	);

	// Pre-render trim: on mount (key={narratorId} causes full remount on switch),
	// if the incoming narrator already has too many cached pages from a previous
	// visit, drop the oldest ones before the first paint to avoid a heavy render.
	const mountTrimmedRef = useRef(false);
	if (!mountTrimmedRef.current) {
		mountTrimmedRef.current = true;
		const cached = qc.getQueryData<MessagesQueryData>(messagesQueryKey);
		if (cached?.pages && cached.pages.length > 1) {
			const trimmed = evictOldestPages(cached, MESSAGE_MOUNT_CACHE_LIMIT);
			if (trimmed !== cached) {
				qc.setQueryData(messagesQueryKey, trimmed);
			}
		}
	}

	// The list component handles rendering; no extra progressive phase here.
	const renderDone = true;

	// Trim message cache on unmount / narrator switch
	useEffect(() => {
		const keyToTrim = messagesQueryKey;
		return () => {
			qc.setQueryData(keyToTrim, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length || old.pages.length <= 1) return old;
				return evictOldestPages(old, MESSAGE_UNMOUNT_CACHE_LIMIT) as MessagesQueryData;
			});
		};
	}, [messagesQueryKey, qc]);

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

			const resolver = usesChunkMessageList ? chunkSelectionResolver : null;
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
	const [selectionToolbarTop, setSelectionToolbarTop] = useState<number | null>(null);

	useEffect(() => {
		if (!selectionMode || selectedBlockIds.size === 0) {
			setSelectionToolbarTop(null);
			return;
		}
		const container = contentRef.current;
		const scrollEl = viewportRef.current;
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
			const screenCenter = window.innerHeight / 2;
			// Clamp: prefer screen center, but stay within selected blocks' bounds
			let top = Math.max(minTop + half, Math.min(screenCenter, maxBottom - half));
			// Also clamp to viewport
			top = Math.max(half, Math.min(top, window.innerHeight - half));
			setSelectionToolbarTop(top);
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
		let selectedText =
			usesChunkMessageList && chunkSelectionResolver?.collectSelectedText
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
		let metas =
			usesChunkMessageList && chunkSelectionResolver?.resolveSelectedMeta
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
		// Optimistic update: remove blocks from cache
		const prevData = usesChunkMessageList ? undefined : qc.getQueryData(messagesQueryKey);
		if (prevData) {
			// Build a set of messageId:blockIndex for quick lookup
			const toDelete = new Set(metas.map((m) => `${m.messageId}:${m.blockIndex}`));
			qc.setQueryData(messagesQueryKey, (old: typeof prevData) => {
				if (!old || typeof old !== "object" || !("pages" in old)) return old;
				return {
					...old,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic page structure
					pages: (old as any).pages.map((page: any) => ({
						...page,
						messages: page.messages
							// biome-ignore lint/suspicious/noExplicitAny: dynamic message structure
							.map((msg: any) => {
								if (!Array.isArray(msg.contentJson)) return msg;
								const filtered = msg.contentJson.filter(
									(_: unknown, i: number) => !toDelete.has(`${msg.id}:${i}`),
								);
								if (filtered.length === 0) return null; // whole message removed
								if (filtered.length === msg.contentJson.length) return msg; // unchanged
								return { ...msg, contentJson: filtered };
							})
							.filter(Boolean),
					})),
				};
			});
		}
		exitSelection();
		try {
			const res = await api.deleteMessageBlocks(
				narratorId,
				metas.map((m) => ({ messageId: m.messageId, blockIndex: m.blockIndex })),
			);
			// Always re-fetch from server to ensure consistency (best-effort delete
			// may have partially succeeded, so optimistic cache may be inaccurate)
			if (usesChunkMessageList) {
				chunkListRef.current?.refreshStructure("full");
			} else {
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			}
			if (res.failed > 0) {
				notifications.show({ message: t("batchDeleteFailed"), color: "orange" });
			}
		} catch {
			// Network / unexpected error — re-fetch to reflect whatever actually happened
			if (usesChunkMessageList) {
				chunkListRef.current?.refreshStructure("full");
			} else {
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			}
			notifications.show({ message: t("batchDeleteFailed"), color: "red" });
		}
	}, [
		selectedBlockIds,
		chunkSelectionResolver,
		exitSelection,
		narratorId,
		messagesQueryKey,
		qc,
		t,
		confirm,
	]);

	// --- Batch fork ---
	const handleBatchFork = useCallback(async () => {
		if (selectedBlockIds.size === 0) return;
		let messageIds =
			usesChunkMessageList && chunkSelectionResolver?.resolveSelectedMessageIds
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
		let messageIds =
			usesChunkMessageList && chunkSelectionResolver?.resolveSelectedMessageIds
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

	// --- Flat message elements ---
	const showTokenUsage = userPrefs?.showTokenUsage ?? false;
	// Keep message element wrappers stable across narrator status changes.
	// Re-enabling blur-in when a user sends a message changes the rendered element
	// tree for existing history and can make the broad list lose its scroll anchor.
	const enableMessageBlurIn = false;
	// Page-level cache: keyed by page reference → rendered elements/keys/targets/meta.
	// Build a synthetic streaming message from the current streaming state.
	// All streaming content (reasoning, text, web_search, tool chunks) is combined
	// into a single message so segmentMessages can apply canonical ordering and
	// merge tool-runs correctly.
	const streamingReasoningCreatedAtRef = useRef<string | null>(null);
	const hasStreamingContent = streamingBlocksRef.current.length > 0 || !!topLevelStreamingChunks;
	if (hasStreamingContent) {
		if (!streamingReasoningCreatedAtRef.current) {
			streamingReasoningCreatedAtRef.current = new Date().toISOString();
		}
	} else {
		streamingReasoningCreatedAtRef.current = null;
	}

	// Build the streaming message inside useMemo so it only produces a new
	// reference when the actual streaming content changes, not on every render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are read intentionally — streamingVersion forces re-evaluation
	const streamingMsg = useMemo(() => {
		// streamingVersion forces re-read of streamingBlocksRef
		void streamingVersion;
		return buildStreamingMsg({
			streamingBlocks:
				streamingBlocksRef.current.length > 0 ? streamingBlocksRef.current : undefined,
			toolChunksMsg: topLevelStreamingChunks,
			narratorId,
		});
	}, [streamingVersion, topLevelStreamingChunks, narratorId]);

	// Page-level render cache.
	// Use a stable page key + message reference equality instead of WeakMap page
	// object identity, because React Query frequently replaces page wrapper
	// objects even when the message list for that page is unchanged.
	const pruneDividerLabel = t("pruneBoundaryLabel");

	const { flatElements, flatTargets } = useMemo(() => {
		if (usesChunkMessageList || isResizing || !deferredMessagesData?.pages) {
			return {
				flatElements: [],
				flatKeys: [],
				flatTargets: [],
			};
		}
		const pages = deferredMessagesData.pages;
		const pageParams = deferredMessagesData.pageParams ?? [];
		const ordered = getRenderableMessageOrder(pages);
		const reversed = ordered.normalized
			? [
					{
						page: {
							...(pages[0] ?? { hasMore: false, nextCursor: null }),
							messages: ordered.messages,
						},
						pageParam: { direction: "normalized", cursor: ordered.messages.at(0)?.seq ?? "none" },
					},
				]
			: pages
					.map((page, originalIndex) => ({ page, pageParam: pageParams[originalIndex] }))
					.reverse();
		const cache = pageCacheRef.current;
		const activePageKeys = new Set<string>();
		const allElements: React.ReactNode[] = [];
		const allKeys: string[] = [];
		const allTargets: string[][] = [];
		const usedKeys = new Set<string>();

		// Build a secondary cache key for render-affecting props outside the page
		// message references themselves.
		const permsKey = `${renderPermCb.pendingPermsMap.size}:${[...renderPermCb.pendingPermsMap.keys()].join(",")}`;
		const secondaryKey = `${narratorId}|${highlightedId}|${expandedToolUseId}|${showTokenUsage}|${pruneBoundaryMessageId}|${lastUserMessageId}|${hasChapter}|${planModeSupported}|${retryRecoverySupported}|${compactSupported}|${rollbackEditRegenerateSupported}|${permsKey}`;

		for (let ri = 0; ri < reversed.length; ri++) {
			const { page, pageParam } = reversed[ri];
			if (!page?.messages?.length) continue;
			const pageKey = getPageRenderCacheKey(page, pageParam, narratorId, highlightMessageId);
			activePageKeys.add(pageKey);

			// The last page in the reversed array (= first/newest page) receives
			// the streaming message so it participates in normal segmentation.
			const isNewestPage = ri === reversed.length - 1;
			const pageStreamingMsg = isNewestPage ? streamingMsg : null;

			// Check cache for non-streaming pages.
			const cachedEntry = cache.get(pageKey);
			const cached = cachedEntry
				? touchPageRenderCacheEntry(cache, pageKey, cachedEntry)
				: undefined;
			if (
				!pageStreamingMsg &&
				cached &&
				cached.secondaryKey === secondaryKey &&
				hasSamePageMessageRefs(cached.messageRefs, page.messages)
			) {
				for (let j = 0; j < cached.elements.length; j++) {
					const targetIds = cached.targets[j] ?? [];
					allElements.push(cached.elements[j]);
					const key = getStableRenderElementKey(cached.keys[j], targetIds, pageKey, usedKeys);
					usedKeys.add(key);
					allKeys.push(key);
					allTargets.push(targetIds);
				}
				continue;
			}

			const renderPage = (sm: NarratorMsg | null) =>
				renderTreeMessagesWithKeys(
					page.messages,
					narratorId,
					forkHandler,
					highlightedId,
					renderPermCb,
					expandedToolUseId,
					showTokenUsage,
					pruneBoundaryMessageId,
					pruneDividerLabel,
					compactSupported ? handleCompactBefore : undefined,
					compactSupported ? handleClearContextBefore : undefined,
					compactSupported ? handleManualSummarize : undefined,
					handleDeleteBlock,
					rollbackEditRegenerateSupported ? handleRollback : undefined,
					rollbackEditRegenerateSupported ? handleEditAndRegenerate : undefined,
					handleEditAssistantMessage,
					handleRestoreAssistantMessage,
					lastUserMessageId,
					hasChapter,
					onViewSubagentSession,
					sm,
					resolvePermForRender,
					handleAskInPassing,
					enableMessageBlurIn,
				);

			const collectResults = (
				result: ReturnType<typeof renderTreeMessagesWithKeys>,
				startIdx = 0,
			) => {
				for (let j = startIdx; j < result.elements.length; j++) {
					const targetIds = result.targets[j] ?? [];
					allElements.push(result.elements[j]);
					const key = getStableRenderElementKey(result.keys[j], targetIds, pageKey, usedKeys);
					usedKeys.add(key);
					allKeys.push(key);
					allTargets.push(targetIds);
				}
			};

			if (pageStreamingMsg) {
				// Streaming page: reuse as many cached non-streaming elements as
				// possible.  segmentMessages appends streamingMsg to the message
				// array, which can either (a) add new segments (when streaming
				// content is text/reasoning that forms its own segment) or
				// (b) merge into the last existing segment (when streaming
				// tool_use blocks extend the existing tool-run).
				//
				// Instead of rendering twice to compare element counts, we call
				// segmentMessages (pure computation, no React element creation)
				// to determine which case applies, then render only once.
				const cachedNoStreamingEntry = cache.get(pageKey);
				let cachedNoStreaming = cachedNoStreamingEntry
					? touchPageRenderCacheEntry(cache, pageKey, cachedNoStreamingEntry)
					: undefined;
				if (
					!cachedNoStreaming ||
					!hasSamePageMessageRefs(cachedNoStreaming.messageRefs, page.messages) ||
					cachedNoStreaming.secondaryKey !== secondaryKey
				) {
					const noStreamResult = renderPage(null);
					cache.set(pageKey, {
						...noStreamResult,
						messageRefs: page.messages,
						secondaryKey,
					});
					cachedNoStreaming = cache.get(pageKey);
				}

				if (cachedNoStreaming && cachedNoStreaming.elements.length > 0) {
					// Cheap segment count comparison (no React element creation).
					const noStreamSegs = segmentMessages(page.messages).length;
					const withStreamSegs = segmentMessages(page.messages, {
						streamingMsg: pageStreamingMsg,
					}).length;
					const streamingAddsSegs = withStreamSegs > noStreamSegs;

					const cachedLen = cachedNoStreaming.elements.length;

					// When streamingMsg only adds new segments (e.g. pure
					// text/reasoning after a tool-run), all cached elements are
					// still valid — reuse them all and only render the new ones.
					//
					// When streamingMsg modifies the last segment (e.g. a
					// streaming tool_use merges into the existing tool-run),
					// reuse the first (N-1) cached elements and re-render the
					// last one from the streaming result.
					const reuseCount = streamingAddsSegs ? cachedLen : Math.max(0, cachedLen - 1);

					// Collect cached elements up to reuseCount.
					for (let j = 0; j < reuseCount; j++) {
						const targetIds = cachedNoStreaming.targets[j] ?? [];
						allElements.push(cachedNoStreaming.elements[j]);
						const key = getStableRenderElementKey(
							cachedNoStreaming.keys[j],
							targetIds,
							pageKey,
							usedKeys,
						);
						usedKeys.add(key);
						allKeys.push(key);
						allTargets.push(targetIds);
					}

					// Single render with streamingMsg, collect from reuseCount onward.
					const streamResult = renderPage(pageStreamingMsg);
					collectResults(streamResult, reuseCount);
				} else {
					// Fallback: cache lookup failed, render everything from the streaming result.
					collectResults(renderPage(pageStreamingMsg));
				}
			} else {
				// Non-streaming page not in cache: compute and cache.
				const result = renderPage(null);

				cache.set(pageKey, {
					...result,
					messageRefs: page.messages,
					secondaryKey,
				});

				collectResults(result);
			}
		}

		for (const cachedPageKey of cache.keys()) {
			if (!activePageKeys.has(cachedPageKey)) {
				cache.delete(cachedPageKey);
			}
		}
		prunePageRenderCache(cache);

		return {
			flatElements: allElements,
			flatKeys: allKeys,
			flatTargets: allTargets,
		};
	}, [
		isResizing,
		deferredMessagesData,
		narratorId,
		forkHandler,
		renderPermCb,
		expandedToolUseId,
		highlightedId,
		highlightMessageId,
		showTokenUsage,
		getStableRenderElementKey,
		handleDeleteBlock,
		handleCompactBefore,
		handleClearContextBefore,
		handleManualSummarize,
		planModeSupported,
		retryRecoverySupported,
		compactSupported,
		handleRollback,
		handleEditAndRegenerate,
		handleEditAssistantMessage,
		handleRestoreAssistantMessage,
		rollbackEditRegenerateSupported,
		pruneBoundaryMessageId,
		pruneDividerLabel,
		lastUserMessageId,
		hasChapter,
		onViewSubagentSession,
		streamingMsg,
		resolvePermForRender,
		handleAskInPassing,
	]);

	// All streaming content is now handled by segmentMessages via streamingMsg.
	// Prepend a manual "load older" button when auto-load is disabled and more pages exist.
	const showManualLoadOlder = !autoLoadEnabled && hasNextPage;
	const loadOlderBtnRef = useRef<() => void>(undefined);
	const showConclusionBtn =
		isSubagent &&
		narrator &&
		narrator.status === "idle" &&
		!isTakenOver &&
		substatus.includes("manual_override") &&
		!isActive;
	const finalElements = useMemo(() => {
		if (!showManualLoadOlder && !showConclusionBtn) return flatElements;
		const elements = showManualLoadOlder
			? [
					<Box ta="center" py={4} key="__load-older-btn__">
						<Button
							size="compact-xs"
							variant="light"
							onClick={() => loadOlderBtnRef.current?.()}
							loading={isFetchingNextPage}
						>
							{t("loadOlderMessages")}
						</Button>
					</Box>,
					...flatElements,
				]
			: [...flatElements];

		// Only a suspended original foreground runner needs explicit conclusion handoff.
		if (showConclusionBtn) {
			elements.push(
				<Box ta="center" py="sm" key="__update-conclusion-btn__">
					<Button
						size="compact-sm"
						variant="light"
						color="indigo"
						onClick={() => updateConclusionMutation.mutate(narratorId)}
						loading={updateConclusionMutation.isPending}
					>
						{t("updateConclusion")}
					</Button>
				</Box>,
			);
		}

		return elements;
	}, [
		showManualLoadOlder,
		flatElements,
		t,
		showConclusionBtn,
		narratorId,
		updateConclusionMutation,
	]);
	const finalTargets = useMemo(() => {
		if (!showManualLoadOlder && !showConclusionBtn) return flatTargets;
		const targets = showManualLoadOlder ? [[], ...flatTargets] : [...flatTargets];
		if (showConclusionBtn) targets.push([]);
		return targets;
	}, [showManualLoadOlder, flatTargets, showConclusionBtn]);
	const [messageRenderWindow, setMessageRenderWindow] = useState<MessageRenderWindow>(() =>
		getTailMessageRenderWindow(0),
	);
	const shouldWindowMessages =
		ENABLE_MESSAGE_RENDER_WINDOW &&
		!isWorkspacePreview &&
		!usePixiRenderer &&
		!selectionMode &&
		finalElements.length > MESSAGE_RENDER_WINDOW_THRESHOLD;
	const prevWindowStateRef = useRef({ enabled: false, finalLength: 0 });

	useLayoutEffect(() => {
		const prev = prevWindowStateRef.current;
		if (shouldWindowMessages) {
			const justEnabled = !prev.enabled;
			const lengthIncreased = finalElements.length > prev.finalLength;
			setMessageRenderWindow((current) => {
				const tailWindow = getTailMessageRenderWindow(finalElements.length);
				const wasAtFullBottom = isAtBottomRef.current && current.end >= prev.finalLength;
				if (justEnabled || (lengthIncreased && wasAtFullBottom)) {
					return isSameMessageRenderWindow(current, tailWindow) ? current : tailWindow;
				}
				if (current.start >= finalElements.length || current.end > finalElements.length) {
					return isSameMessageRenderWindow(current, tailWindow) ? current : tailWindow;
				}
				return current;
			});
		}
		prevWindowStateRef.current = {
			enabled: shouldWindowMessages,
			finalLength: finalElements.length,
		};
	}, [shouldWindowMessages, finalElements.length]);

	const activeMessageRenderWindow = useMemo(() => {
		if (!shouldWindowMessages) return null;
		const maxStart = Math.max(0, finalElements.length - MESSAGE_RENDER_WINDOW_SIZE);
		const start = Math.max(0, Math.min(maxStart, messageRenderWindow.start));
		const end = Math.min(finalElements.length, Math.max(start, messageRenderWindow.end));
		if (end <= start) return getTailMessageRenderWindow(finalElements.length);
		return { start, end, reason: messageRenderWindow.reason };
	}, [shouldWindowMessages, finalElements.length, messageRenderWindow]);
	const hasHiddenNewerLoadedWindow =
		shouldWindowMessages &&
		activeMessageRenderWindow != null &&
		activeMessageRenderWindow.end < finalElements.length;
	isTailRenderWindowRef.current = !hasHiddenNewerLoadedWindow;
	const showScrollToBottomButton = usesChunkMessageList
		? !isAtBottom || unreadCount > 0
		: !isAtBottom || hasPreviousPage || hasHiddenNewerLoadedWindow;
	useLayoutEffect(() => {
		if (hasHiddenNewerLoadedWindow) {
			detachFromFullBottom();
		}
	}, [detachFromFullBottom, hasHiddenNewerLoadedWindow]);
	const latestMessageWindowStateRef = useRef({ shouldWindowMessages: false, finalLength: 0 });
	latestMessageWindowStateRef.current = {
		shouldWindowMessages,
		finalLength: finalElements.length,
	};
	const scrollToLatestMessageWindow = useCallback(
		(instant?: boolean) => {
			if (messageRenderPhase !== "full") {
				startTransition(() => setMessageRenderPhase("full"));
			}
			const setTailWindowIfNeeded = () => {
				const state = latestMessageWindowStateRef.current;
				if (!state.shouldWindowMessages) return false;
				const tailWindow = getTailMessageRenderWindow(state.finalLength);
				setMessageRenderWindow((current) =>
					isSameMessageRenderWindow(current, tailWindow) ? current : tailWindow,
				);
				return true;
			};

			if (!setTailWindowIfNeeded()) {
				scrollToBottom(instant);
				return;
			}

			requestAnimationFrame(() => {
				setTailWindowIfNeeded();
				requestAnimationFrame(() => scrollToBottom(instant));
			});
		},
		[messageRenderPhase, scrollToBottom],
	);

	const fullIndexToVisibleIndexMap = useMemo(() => {
		const indexMap = new Map<number, number>();
		if (!shouldWindowMessages || !activeMessageRenderWindow) return indexMap;
		const visibleOffset = activeMessageRenderWindow.start > 0 ? 1 : 0;
		for (let i = activeMessageRenderWindow.start; i < activeMessageRenderWindow.end; i++) {
			indexMap.set(i, i - activeMessageRenderWindow.start + visibleOffset);
		}
		return indexMap;
	}, [activeMessageRenderWindow, shouldWindowMessages]);

	const targetIndexMap = useMemo(() => {
		const indexMap = new Map<string, number>();
		for (let i = 0; i < finalTargets.length; i++) {
			for (const targetId of finalTargets[i] ?? []) {
				if (targetId && !indexMap.has(targetId)) {
					indexMap.set(targetId, i);
				}
			}
		}
		return indexMap;
	}, [finalTargets]);

	const pendingMessageScrollRef = useRef<PendingMessageScroll | null>(null);
	const pendingMessageScrollRafRef = useRef(0);
	const scrollDomIdsIntoView = useCallback((domIds: string[] | undefined) => {
		if (!domIds?.length) return false;
		for (const domId of domIds) {
			const el = document.getElementById(domId);
			if (el) {
				el.scrollIntoView({ block: "center" });
				return true;
			}
		}
		return false;
	}, []);

	useEffect(() => {
		return () => cancelAnimationFrame(pendingMessageScrollRafRef.current);
	}, []);

	useLayoutEffect(() => {
		const pending = pendingMessageScrollRef.current;
		if (!pending) return;
		const visibleIndex = shouldWindowMessages
			? fullIndexToVisibleIndexMap.get(pending.fullIndex)
			: pending.fullIndex;
		if (visibleIndex == null) return;
		pendingMessageScrollRef.current = null;
		cancelAnimationFrame(pendingMessageScrollRafRef.current);
		pendingMessageScrollRafRef.current = requestAnimationFrame(() => {
			virtualListRef.current?.scrollToIndex(visibleIndex, { align: pending.align });
			if (pending.domIds?.length || pending.highlightId) {
				requestAnimationFrame(() => {
					scrollDomIdsIntoView(pending.domIds);
					if (pending.highlightId) {
						scheduleHighlight(pending.highlightId, pending.highlightDelayMs ?? 300);
					}
				});
			}
		});
	}, [shouldWindowMessages, fullIndexToVisibleIndexMap, scrollDomIdsIntoView, scheduleHighlight]);

	const scrollToFullIndex = useCallback(
		(fullIndex: number, options: ScrollToFullIndexOptions = {}) => {
			if (messageRenderPhase !== "full") {
				startTransition(() => setMessageRenderPhase("full"));
			}
			if (fullIndex < 0 || fullIndex >= finalElements.length) return false;
			const align = options.align ?? "start";
			const runDomCorrection = () => {
				if (options.domIds?.length) {
					window.setTimeout(() => scrollDomIdsIntoView(options.domIds), 80);
				}
				if (options.highlightId) {
					scheduleHighlight(options.highlightId, options.highlightDelayMs ?? 300);
				}
			};

			if (!shouldWindowMessages) {
				if (!virtualListRef.current) return false;
				virtualListRef.current.scrollToIndex(fullIndex, { align });
				runDomCorrection();
				return true;
			}

			const visibleIndex = fullIndexToVisibleIndexMap.get(fullIndex);
			if (visibleIndex != null) {
				if (!virtualListRef.current) return false;
				if (activeMessageRenderWindow && activeMessageRenderWindow.end < finalElements.length) {
					detachFromFullBottom();
				}
				virtualListRef.current.scrollToIndex(visibleIndex, { align });
				runDomCorrection();
				return true;
			}

			pendingMessageScrollRef.current = {
				fullIndex,
				align,
				domIds: options.domIds,
				highlightId: options.highlightId,
				highlightDelayMs: options.highlightDelayMs,
			};
			const nextWindow = centerMessageRenderWindowAround(fullIndex, finalElements.length);
			if (nextWindow.end < finalElements.length) {
				detachFromFullBottom();
			}
			setMessageRenderWindow((current) =>
				isSameMessageRenderWindow(current, nextWindow) ? current : nextWindow,
			);
			return true;
		},
		[
			activeMessageRenderWindow,
			detachFromFullBottom,
			finalElements.length,
			fullIndexToVisibleIndexMap,
			messageRenderPhase,
			scheduleHighlight,
			scrollDomIdsIntoView,
			shouldWindowMessages,
		],
	);

	// --- Load older / newer ---
	const handleLoadOlder = useCallback(() => {
		if (isFetchingNextPage) return;
		if (messageRenderPhase !== "full") {
			startTransition(() => setMessageRenderPhase("full"));
		}
		fetchNextPage();
	}, [fetchNextPage, messageRenderPhase]);
	loadOlderBtnRef.current = handleLoadOlder;

	const handleLoadNewer = useCallback(async () => {
		if (isFetchingPreviousPage) return;
		await fetchPreviousPage();
	}, [fetchPreviousPage]);

	const revealLatestMessages = useCallback(async () => {
		for (let attempt = 0; attempt < 20; attempt++) {
			const firstPage = qc.getQueryData<MessagesQueryData>(messagesQueryKey)?.pages?.[0];
			if (!firstPage?.hasMoreAfter || !firstPage.prevCursor) break;
			await fetchPreviousPage();
		}
		scrollToLatestMessageWindow(true);
	}, [fetchPreviousPage, messagesQueryKey, qc, scrollToLatestMessageWindow]);

	const handleLoadOlderRef = useRef(handleLoadOlder);
	handleLoadOlderRef.current = handleLoadOlder;
	const loadOlderArmedRef = useRef(false);
	const loadOlderNearTopRef = useRef(false);
	const hasHiddenOlderLoadedWindow =
		shouldWindowMessages && (activeMessageRenderWindow?.start ?? 0) > 0;
	useEffect(() => {
		if (
			usesChunkMessageList ||
			!autoLoadEnabled ||
			!hasNextPage ||
			!initialScrollDone ||
			isFetchingNextPage ||
			hasHiddenOlderLoadedWindow
		) {
			return;
		}
		const vp = viewportRef.current;
		if (!vp) return;
		// Reset the "already triggered" gate when the effect re-runs after a fetch completes.
		// Without this, the shift logic keeps the viewport near the top after prepending,
		// and loadOlderNearTopRef stays true indefinitely (its reset requires scrollTop > 3×viewport).
		loadOlderNearTopRef.current = false;
		const check = () => {
			// Normal scroll direction: scrollTop near 0 = near visual top (older messages).
			// Trigger only once per deliberate upward entry into the top band. After a page
			// is prepended, browser anchoring may briefly report a near-top scrollTop again;
			// keep the gate closed until the viewport clearly leaves the top band.
			const nearTop = vp.scrollTop < vp.clientHeight * 2 && vp.scrollHeight > vp.clientHeight;
			if (!nearTop) {
				if (vp.scrollTop > vp.clientHeight * 3 || vp.scrollHeight <= vp.clientHeight) {
					loadOlderNearTopRef.current = false;
				}
				return;
			}
			if (loadOlderNearTopRef.current || !loadOlderArmedRef.current) return;
			loadOlderNearTopRef.current = true;
			loadOlderArmedRef.current = false;
			handleLoadOlderRef.current();
		};
		check();
		vp.addEventListener("scroll", check, { passive: true });
		return () => vp.removeEventListener("scroll", check);
	}, [autoLoadEnabled, hasHiddenOlderLoadedWindow, initialScrollDone]);

	const handleLoadNewerRef = useRef(handleLoadNewer);
	handleLoadNewerRef.current = handleLoadNewer;
	useEffect(() => {
		if (
			usesChunkMessageList ||
			!autoLoadEnabled ||
			!hasPreviousPage ||
			!initialScrollDone ||
			isFetchingPreviousPage ||
			hasHiddenNewerLoadedWindow
		) {
			return;
		}
		const vp = viewportRef.current;
		if (!vp) return;
		const check = () => {
			// Normal scroll direction: scrollTop near max = at visual bottom (newest messages).
			// Trigger load-newer when near the bottom.
			const distFromBottom = getMessageViewportDistanceFromBottom(vp);
			if (distFromBottom <= 24) {
				handleLoadNewerRef.current();
			}
		};
		vp.addEventListener("scroll", check, { passive: true });
		return () => vp.removeEventListener("scroll", check);
	}, [autoLoadEnabled, hasHiddenNewerLoadedWindow, initialScrollDone]);

	// --- Scroll state ---
	const cleanupRef = useRef<(() => void) | null>(null);
	const chunkViewportRef = useCallback((node: HTMLDivElement | null) => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		(viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		if (!node) return;
		// The spec carryover / spec_goal_added cards bubble a "spec-open-tasks"
		// CustomEvent up to this scroll viewport (their DOM ancestor) to open the
		// Spec task board. In chunk-list mode the legacy auto-scroll effect that used
		// to host this listener is short-circuited (usesChunkMessageList === true), so
		// register it here on the live viewport node instead — this ties the listener
		// to the node's mount lifecycle and never depends on the disabled effect.
		const onSpecOpenTasks = () => openSpecToolRef.current();
		node.addEventListener("spec-open-tasks", onSpecOpenTasks);
		cleanupRef.current = () => {
			node.removeEventListener("spec-open-tasks", onSpecOpenTasks);
		};
	}, []);

	// --- Initial scroll ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: renderDone is a state trigger — effect must re-run when it flips to true
	useEffect(() => {
		if (usesChunkMessageList) return;
		if (
			!initialScrollDoneRef.current &&
			totalMessageCount > 0 &&
			renderDone &&
			!highlightMessageId &&
			isAtBottomRef.current
		) {
			initialScrollDoneRef.current = true;
			setInitialScrollDone(true);
			scrollToBottom(true);
		}
		if (
			!initialScrollDoneRef.current &&
			totalMessageCount > 0 &&
			renderDone &&
			!isAtBottomRef.current
		) {
			initialScrollDoneRef.current = true;
			setInitialScrollDone(true);
		}
	}, [totalMessageCount, renderDone, scrollToBottom, highlightMessageId, usesChunkMessageList]);

	// --- Auto-scroll via MutationObserver + ResizeObserver ---
	// MutationObserver detects DOM changes (new messages added) in the scroll
	// container and triggers the follow loop. ResizeObserver on the viewport
	// handles viewport resize (e.g. DevTools toggle).
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialScrollDone is a trigger dep, not read inside
	useEffect(() => {
		if (usesChunkMessageList) return;
		const vp = viewportRef.current;
		if (!vp) return;

		// Track whether the *viewport* itself is being resized (e.g. DevTools
		// mobile↔desktop toggle). During a viewport resize both observers fire
		// in rapid succession; using the RAF-based follow loop in that situation
		// causes continuous scrollTop writes that force layout thrashing, block
		// the main thread, and can trigger React's "Maximum update depth" error.
		let vpResizeTimer = 0;

		// Use MutationObserver to detect content changes (new messages, streaming
		// content growth, etc.) instead of ResizeObserver on contentRef.
		let mutationRafId = 0;
		const mutationObserver = new MutationObserver(() => {
			if (!initialScrollDoneRef.current) return;
			// Debounce via rAF to batch rapid DOM mutations (e.g. streaming)
			cancelAnimationFrame(mutationRafId);
			mutationRafId = requestAnimationFrame(() => {
				const canUseVisibleBottomAsFullBottom =
					isTailRenderWindowRef.current && !highlightMessageId;
				if (resizingRef.current) {
					if (isAtBottomRef.current && canUseVisibleBottomAsFullBottom) {
						programmaticScrollRef.current = true;
						vp.scrollTop = getMessageViewportScrollBottom(vp);
					}
					return;
				}
				if (isAtBottomRef.current && canUseVisibleBottomAsFullBottom) {
					startFollowing();
				} else if (!isAtBottomRef.current && canUseVisibleBottomAsFullBottom) {
					if (getMessageViewportDistanceFromBottom(vp) < 30) {
						isAtBottomRef.current = true;
						setIsAtBottom(true);
					}
				}
			});
		});
		mutationObserver.observe(vp, { childList: true, subtree: true });

		// ResizeObserver on the content wrapper detects height changes that
		// don't add/remove DOM nodes (e.g. text content updates, image loads,
		// code block expansion). Without this, the MutationObserver alone
		// misses cases where existing elements grow taller.
		let contentResizeRafId = 0;
		const contentObserver = new ResizeObserver(() => {
			if (!initialScrollDoneRef.current || resizingRef.current) return;
			cancelAnimationFrame(contentResizeRafId);
			contentResizeRafId = requestAnimationFrame(() => {
				const canUseVisibleBottomAsFullBottom =
					isTailRenderWindowRef.current && !highlightMessageId;
				if (resizingRef.current) {
					if (isAtBottomRef.current && canUseVisibleBottomAsFullBottom) {
						programmaticScrollRef.current = true;
						vp.scrollTop = getMessageViewportScrollBottom(vp);
					}
					return;
				}
				if (isAtBottomRef.current && canUseVisibleBottomAsFullBottom) {
					startFollowing();
				}
			});
		});
		// Observe the list wrapper (contentRef) — its height changes when
		// any child element grows/shrinks without DOM node count changing.
		const listWrapper = contentRef.current;
		if (listWrapper) {
			contentObserver.observe(listWrapper);
		}

		const vpObserver = new ResizeObserver(() => {
			// Mark that a viewport resize is in progress so the mutation
			// observer takes the synchronous-snap path, and onScroll
			// suppresses all detach checks for the duration.
			resizingRef.current = true;
			clearTimeout(vpResizeTimer);
			vpResizeTimer = window.setTimeout(() => {
				resizingRef.current = false;
			}, 150);

			if (isAtBottomRef.current && isTailRenderWindowRef.current && !highlightMessageId) {
				programmaticScrollRef.current = true;
				vp.scrollTop = getMessageViewportScrollBottom(vp);
			}
		});
		vpObserver.observe(vp);

		// Listen for subagent card auto-expand events (e.g. permission request
		// causes a collapsed card to expand). The Collapse animation changes the
		// content height gradually; by the time this event fires (~300ms after
		// expand) the animation is done and we can reliably scroll to bottom.
		const onSubagentExpand = () => {
			if (isAtBottomRef.current && isTailRenderWindowRef.current && !highlightMessageId) {
				startFollowing();
			}
		};
		vp.addEventListener("subagent-auto-expand", onSubagentExpand);
		// A spec_goal_added card ("View task list →") bubbles this event up to the
		// viewport; open the Spec panel (which hosts the tasks.json board).
		// NOTE: this whole effect is short-circuited in chunk-list mode (the default);
		// there the same listener is registered in `chunkViewportRef` on the live
		// scroll node. This branch only runs for the legacy VirtualMessageList path.
		const onSpecOpenTasks = () => openSpecToolRef.current();
		vp.addEventListener("spec-open-tasks", onSpecOpenTasks);

		return () => {
			clearTimeout(vpResizeTimer);
			cancelAnimationFrame(mutationRafId);
			cancelAnimationFrame(contentResizeRafId);
			resizingRef.current = false;
			mutationObserver.disconnect();
			contentObserver.disconnect();
			vpObserver.disconnect();
			vp.removeEventListener("subagent-auto-expand", onSubagentExpand);
			vp.removeEventListener("spec-open-tasks", onSpecOpenTasks);
			stopFollowing();
		};
	}, [highlightMessageId, initialScrollDone, startFollowing, stopFollowing, usesChunkMessageList]);

	const scrollToMessageTarget = useCallback(
		({
			domIds,
			targetIds,
			highlightId,
		}: {
			domIds: string[];
			targetIds: string[];
			highlightId?: string;
		}) => {
			for (const domId of domIds) {
				const el = document.getElementById(domId);
				if (el) {
					requestAnimationFrame(() => {
						el.scrollIntoView({ behavior: "smooth", block: "center" });
						if (highlightId) {
							scheduleHighlight(highlightId, 400);
						}
					});
					return true;
				}
			}
			if (usesChunkMessageList) {
				const handle = chunkListRef.current;
				if (!handle) return false;
				handle.scrollToMessageTarget({ domIds, targetIds, highlightId });
				return true;
			}
			const targetIndex = targetIds
				.map((targetId) => targetIndexMap.get(targetId))
				.find((index): index is number => index != null);
			if (targetIndex != null) {
				return scrollToFullIndex(targetIndex, {
					align: "center",
					domIds,
					highlightId,
					highlightDelayMs: 300,
				});
			}
			return false;
		},
		[scheduleHighlight, scrollToFullIndex, targetIndexMap],
	);

	const compactingMarkerInfo = useMemo(() => {
		if (!deferredMessagesData?.pages?.length) return null;
		const orderedMessages = getRenderableMessageOrder(deferredMessagesData.pages).messages;
		for (const message of orderedMessages) {
			if (!message.id) continue;
			const kind = getCompactingMarkerKind(message);
			if (kind) return { messageId: message.id, kind };
		}
		return null;
	}, [deferredMessagesData]);
	const compactingMarkerMessageId = compactingMarkerInfo?.messageId ?? null;
	const compactingMarkerKind = compactingMarkerInfo?.kind ?? "context";

	useEffect(() => {
		if (!compactingMarkerMessageId || isWorkspacePreview || usePixiRenderer) {
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
			scrollToMessageTarget({
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
			const markerIndex = targetIndexMap.get(compactingMarkerMessageId);
			if (markerIndex == null) return null;
			if (shouldWindowMessages && activeMessageRenderWindow) {
				if (markerIndex < activeMessageRenderWindow.start) return "top";
				if (markerIndex >= activeMessageRenderWindow.end) return "bottom";
			}
			const viewportRect = scrollEl.getBoundingClientRect();
			let minVisibleIndex = Number.POSITIVE_INFINITY;
			let maxVisibleIndex = Number.NEGATIVE_INFINITY;
			const messageNodes = contentEl.querySelectorAll<HTMLElement>("[id^='msg-']");
			for (const node of messageNodes) {
				const rect = node.getBoundingClientRect();
				if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom) continue;
				const id = node.id.startsWith("msg-") ? node.id.slice(4) : node.id;
				const index = targetIndexMap.get(id);
				if (index == null) continue;
				minVisibleIndex = Math.min(minVisibleIndex, index);
				maxVisibleIndex = Math.max(maxVisibleIndex, index);
			}
			if (!Number.isFinite(minVisibleIndex)) return null;
			if (markerIndex < minVisibleIndex) return "top";
			if (markerIndex > maxVisibleIndex) return "bottom";
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
	}, [
		activeMessageRenderWindow,
		compactingMarkerKind,
		compactingMarkerMessageId,
		isWorkspacePreview,
		scrollToMessageTarget,
		shouldWindowMessages,
		t,
		targetIndexMap,
	]);

	// --- Scroll to highlighted message ---
	useEffect(() => {
		if (!highlightMessageId || totalMessageCount === 0 || highlightScrolledRef.current) return;
		highlightScrolledRef.current = scrollToMessageTarget({
			domIds: [`msg-${highlightMessageId}`],
			targetIds: [highlightMessageId],
			highlightId: highlightMessageId,
		});
	}, [highlightMessageId, totalMessageCount, scrollToMessageTarget]);

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

			void api
				.getBufferedMessages(narratorId)
				.then((messages) => setQueuedMessages(messages ?? []))
				.catch(() => {});

			return true;
		},
		[narratorId, currentUser, setQueuedMessages, t],
	);

	// --- Send / retry message ---
	const submitMessage = async (
		msg: string,
		images: File[] = [],
		textFiles: File[] = [],
		signal?: AbortSignal,
	) => {
		streamingBlocksRef.current = [];

		// Detect slash command for optimistic display
		const isSlashCommand = msg.startsWith("/") && /^\/[a-zA-Z0-9_-]+(\s|$)/.test(msg);
		const commandText = isSlashCommand ? msg : null;

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
		const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const optimisticMsg: TreeMessage = {
			id: optimisticId,
			narratorId,
			parentToolUseId: null,
			role: "user",
			contentJson: optimisticBlocks,
			contentText: msg,
			commandText,
			toolCalls: [],
			createdAt: new Date().toISOString(),
			children: [],
		};
		qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
			if (!old?.pages?.length) {
				return {
					pages: [{ messages: [optimisticMsg], hasMore: false, nextCursor: null }],
					pageParams: [undefined],
				};
			}
			const pages = [...old.pages];
			const firstPage = { ...pages[0] };
			firstPage.messages = [...firstPage.messages, optimisticMsg];
			pages[0] = firstPage;
			return { ...old, pages };
		});
		scrollToLatestMessageWindow(true);
		try {
			const result = await api.sendNarratorMessage(
				narratorId,
				msg,
				images.length > 0 ? images : undefined,
				textFiles.length > 0 ? textFiles : undefined,
				undefined,
				reportUploadProgress,
				signal,
			);
			// Handle /load tool response — not a real message, just a tool load confirmation
			if (result?.loaded) {
				// Remove optimistic message since no real message was created
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					firstPage.messages = firstPage.messages.filter((m: NarratorMsg) => m.id !== optimisticId);
					pages[0] = firstPage;
					return { ...old, pages };
				});
				const toolName = result.toolName ?? "tool";
				notifications.show({
					title: result.alreadyLoaded ? t("toolAlreadyLoaded") : t("toolLoaded"),
					message: toolName,
					color: result.alreadyLoaded ? "yellow" : "green",
				});
			} else if (result?.type === "bash" && result?.id) {
				// /bash command — remove optimistic message, WS broadcasts will provide real messages
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					firstPage.messages = firstPage.messages.filter((m: NarratorMsg) => m.id !== optimisticId);
					pages[0] = firstPage;
					return { ...old, pages };
				});
				scrollToLatestMessageWindow(true);
			} else if (result?.specGoal) {
				// /goal added a protected task; the real user message arrives via WS, so
				// drop the optimistic bubble.
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					firstPage.messages = firstPage.messages.filter((m: NarratorMsg) => m.id !== optimisticId);
					pages[0] = firstPage;
					return { ...old, pages };
				});
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
				scrollToLatestMessageWindow(true);
			} else if (result?.buffered) {
				// Message was buffered — remove optimistic chat history entry and show it
				// in the queue immediately.  The WS buffer_set event can be missed when
				// the subscription is not fully caught up, so also reconcile with REST.
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					firstPage.messages = firstPage.messages.filter((m: NarratorMsg) => m.id !== optimisticId);
					pages[0] = firstPage;
					return { ...old, pages };
				});
				applyBufferedSendResult(result, msg, images.length);
				scrollToLatestMessageWindow(true);
			} else if (result?.id) {
				// Normal message — replace optimistic message with the real server message
				// so we don't depend solely on WS onUserMessage for dedup.
				const serverMsg: NarratorMsg = {
					...result,
					children: result.children ?? [],
					toolCalls: result.toolCalls ?? [],
				};
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					const idx = firstPage.messages.findIndex((m: NarratorMsg) => m.id === optimisticId);
					if (idx !== -1) {
						// Optimistic message still present — replace it by seq so any concurrently
						// broadcast tool cards stay after the real user message.
						const updated = [...firstPage.messages];
						revokeContentBlockPreviewUrls(updated[idx].contentJson);
						updated.splice(idx, 1);
						firstPage.messages = insertTopLevelMessageBySeq(updated, serverMsg);
					} else if (!firstPage.messages.some((m: NarratorMsg) => m.id === serverMsg.id)) {
						// Optimistic was already replaced by WS, but server msg not yet in cache
						firstPage.messages = insertTopLevelMessageBySeq(firstPage.messages, serverMsg);
					}
					pages[0] = firstPage;
					return { ...old, pages };
				});
				// Optimistically set narrator status to "working" so the UI shows
				// the work indicator immediately.  This guards against the race where
				// the WS subscribe message hasn't been processed by the server yet
				// when the backend broadcasts the status_change event — without this,
				// the frontend stays stuck on "idle" until the user navigates away
				// and back.
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
			qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
				if (!old?.pages?.length) return old;
				const pages = [...old.pages];
				const firstPage = { ...pages[0] };
				const nextMessages = firstPage.messages.filter(
					(existing: NarratorMsg) => existing.id !== optimisticId,
				);
				if (nextMessages.length === firstPage.messages.length) return old;
				firstPage.messages = nextMessages;
				pages[0] = firstPage;
				return { ...old, pages };
			});
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
		hideInputForSend();
		hideAttachedImagesForSend();
		setAttachedTextFiles([]);
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
			commitInputDraftAfterSend();
			clearAttachedImagesAndDraft();
			// Whether the message was buffered (202) or the backend fell through
			// to a direct send (201), scroll so the new content is visible.
			scrollToLatestMessageWindow(true);
			return buffered;
		} catch (err) {
			// Restore input and attachments on error
			setInput(msg);
			if (images.length > 0) updateAttachedImages(images);
			if (textFiles.length > 0) setAttachedTextFiles(textFiles);
			throw err; // Re-throw to let caller handle
		}
	};

	/**
	 * Core send handler. When the narrator is active, `mode` selects the queue
	 * behavior:
	 *   - "turn": normal queue — wait for the current turn to finish
	 *   - "tool": priority queue — cut in after the current tool call completes
	 *   - "interrupt": priority queue + immediate interrupt (auto-resume consumes it)
	 * When the narrator is idle, `mode` is ignored and the message is sent
	 * directly (an idle session is never interrupted). `/new` while active always
	 * uses the normal queue regardless of mode — spawning a new narrator should
	 * not interrupt the current turn.
	 */
	const handleSendWithMode = async (mode: "turn" | "tool" | "interrupt") => {
		const msg = input.trim();
		if (!msg || sendingRef.current) return;
		sendingRef.current = true;
		const attachmentCount = attachedImages.length + attachedTextFiles.length;
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
			inputHistory.push(msg);

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
				hideInputForSend();
				hideAttachedImagesForSend();
				setAttachedTextFiles([]);

				const currentCwd =
					fetchedNarrator?.cwd ?? narrator?.cwd ?? chapterWorktreePath ?? undefined;
				const newNarrator = await createNarratorMutation.mutateAsync({
					chapterId: null,
					model: fetchedNarrator?.model ?? narrator?.model ?? undefined,
					systemPrompt: fetchedNarrator?.systemPrompt ?? narrator?.systemPrompt ?? undefined,
					permissionMode: fetchedNarrator?.permissionMode ?? narrator?.permissionMode ?? undefined,
					reasoningEffort:
						fetchedNarrator?.reasoningEffort ?? narrator?.reasoningEffort ?? undefined,
					fastMode: fetchedNarrator?.fastMode ?? narrator?.fastMode ?? undefined,
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

				commitInputDraftAfterSend();
				clearAttachedImagesAndDraft();
				restoreOnError = null;
				navigate({ to: "/narrators/$narratorId", params: { narratorId: newNarrator.id } });
				return;
			}

			if (isActive) {
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
			const images = [...attachedImages];
			const textFiles = [...attachedTextFiles];
			// Remember the draft so a cancelled upload can restore it — submitMessage
			// clears the input/attachments up-front for the optimistic bubble.
			restoreOnError = { msg, images, textFiles };
			hideInputForSend();
			hideAttachedImagesForSend();
			setAttachedTextFiles([]);
			await submitMessage(msg, images, textFiles, abortController.signal);
			commitInputDraftAfterSend();
			clearAttachedImagesAndDraft();
			restoreOnError = null;
		} catch (err) {
			// Restore the drafted input/attachments so the user doesn't lose their
			// message. `doSendBuffered` already restores internally on its own throw;
			// this covers the `/new` and idle direct-send paths.
			if (restoreOnError) {
				setInput(restoreOnError.msg);
				if (restoreOnError.images.length > 0) updateAttachedImages(restoreOnError.images);
				if (restoreOnError.textFiles.length > 0) setAttachedTextFiles(restoreOnError.textFiles);
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
			setInput(queuedMessages[0].text);
			setQueuedMessages([]);
		}
	};

	const handleRemoveQueued = (messageId: string) => {
		const msg = queuedMessages.find((m) => m.id === messageId);
		const snapshot = queuedMessages;
		setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
		// If removing the only message, restore its text to input
		if (queuedMessages.length === 1 && msg) {
			setInput(msg.text);
		}
		api.removeBufferedMessage(narratorId, messageId).catch(() => {
			// Rollback on failure
			setQueuedMessages(snapshot);
			if (queuedMessages.length === 1 && msg) {
				setInput("");
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
	const [editingQueuedText, setEditingQueuedText] = useState("");
	const [queueExpanded, setQueueExpanded] = useState(false);

	// Auto-reset expanded state when queue shrinks to ≤2
	useEffect(() => {
		if (queuedMessages.length <= QUEUE_COLLAPSE_THRESHOLD) setQueueExpanded(false);
	}, [queuedMessages.length]);

	const handleStartEditQueued = (msg: { id: string; text: string }) => {
		setEditingQueuedId(msg.id);
		setEditingQueuedText(msg.text);
	};

	const handleSaveEditQueued = () => {
		if (!editingQueuedId || !editingQueuedText.trim()) return;
		const trimmed = editingQueuedText.trim();
		const snapshot = queuedMessages;
		setQueuedMessages((prev) =>
			prev.map((m) =>
				m.id === editingQueuedId
					? { ...m, text: trimmed, bufferedAt: new Date().toISOString() }
					: m,
			),
		);
		setEditingQueuedId(null);
		setEditingQueuedText("");
		api.updateBufferedMessage(narratorId, editingQueuedId, trimmed).catch(() => {
			// Rollback on failure
			setQueuedMessages(snapshot);
		});
	};

	const handleCancelEditQueued = () => {
		setEditingQueuedId(null);
		setEditingQueuedText("");
	};

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
			setAttachedTextFiles((prev) => [...prev, ...valid]);
		}
	};

	const handlePaste = (e: React.ClipboardEvent) => {
		const items = e.clipboardData.items;
		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			addImages(imageFiles);
		}
	};

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

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Let CommandPopover handle arrow/tab/escape keys when visible,
		// but still allow Enter to reach our send handler (CommandPopover
		// calls stopPropagation when it consumes Enter for selection).
		if (commandPopoverVisible && e.key !== "Enter") return;
		// Same for the @mention popover: it consumes arrow/tab/escape/enter via a
		// capture-phase listener; guard here so navigation keys don't double-handle.
		if (mentionPopoverVisible && e.key !== "Enter") return;

		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			// Permission shortcut: when input is empty and a permission is pending,
			// the global keydown handler (useEffect above) handles Enter.
			// preventDefault here to stop the textarea from inserting a newline.
			if (effectiveFocusIndex != null && !input.trim() && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				return; // action handled by global handler
			}

			// Enter and Ctrl/Cmd+Enter each send with their own configured queue
			// behavior. Shift+Enter is left to the browser for a native newline.
			if (e.ctrlKey || e.metaKey) {
				if (!e.shiftKey) {
					e.preventDefault();
					void handleSendWithMode(userPrefs?.ctrlEnterQueueMode ?? "tool");
				}
			} else if (!e.shiftKey) {
				e.preventDefault();
				void handleSendWithMode(userPrefs?.enterQueueMode ?? "turn");
			}
			return;
		}
		// 上下箭头翻阅输入历史
		// 需要处理 soft-wrap（长文本自动折行）的情况：
		// 先让浏览器执行默认的光标移动，如果光标位置没变说明已在首/末视觉行，
		// 此时才触发历史导航。
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			const textarea = e.currentTarget as HTMLTextAreaElement;
			const posBefore = textarea.selectionStart;
			const direction = e.key === "ArrowUp" ? "up" : "down";
			// 让浏览器先处理默认行为，下一帧再检查光标是否移动
			requestAnimationFrame(() => {
				const posAfter = textarea.selectionStart;
				if (posBefore !== posAfter) return; // 光标移动了，说明还在文本中间行
				const result = inputHistory.navigate(direction, input);
				if (result !== null) {
					setInput(result);
					// 将光标移到末尾
					requestAnimationFrame(() => {
						textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
					});
				}
			});
		}
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
				// Allow only if it's our main textarea AND it's empty
				if (target !== textareaRef.current) return;
				if (input.trim()) return;
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
	}, [effectiveFocusIndex, permButtonCount, input]);

	if (!narrator) return <NarratorPanelSkeleton />;

	const statusBarDisplay = getNarratorStatusBarDisplay({
		panelNarratorId: narratorId,
		narrator,
		liveSubstatus: substatus,
	});

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
						label={t("fast_mode_tooltip")}
						position={position.startsWith("top") ? "top" : "bottom"}
						disabled={fastModeSettingsOpened}
					>
						<ActionIcon
							variant="subtle"
							color={narrator.fastMode ? "yellow" : "gray"}
							size="sm"
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
								fastModeMutation.mutate({
									id: narratorId,
									fastMode: !narrator.fastMode,
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
						justify="space-between"
						py="xs"
						px="md"
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
						<Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
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
							<Group gap={4} style={{ flex: 1, minWidth: 0 }} wrap="nowrap">
								{editingTitle && !isWorkspacePreview ? (
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
								{!isWorkspacePreview && (
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
							<Group gap="xs">
								{(() => {
									const deviceData = executionDevicesQuery.data;
									// Only surface the selector when at least one remote device
									// exists — otherwise "local" is the only option and the
									// control would just waste toolbar space.
									if (!deviceData || deviceData.devices.length === 0) return null;
									const currentDeviceId = deviceData.defaultDeviceId ?? "local";
									const currentDevice =
										currentDeviceId === "local"
											? null
											: deviceData.devices.find((d) => d.id === currentDeviceId);
									const isRemote = currentDeviceId !== "local";
									const currentLabel = currentDevice
										? currentDevice.name
										: t("executionTargetLocal");
									return (
										<Menu position="bottom-end" withinPortal>
											<Menu.Target>
												<Tooltip label={`${t("executionDeviceSelector")}: ${currentLabel}`}>
													<ActionIcon
														size="sm"
														variant={isRemote ? "light" : "subtle"}
														color={isRemote ? "indigo" : "gray"}
														loading={updateExecutionDeviceMutation.isPending}
														aria-label={t("executionDeviceSelector")}
													>
														{isRemote ? <IconDevices size={16} /> : <IconDeviceDesktop size={16} />}
													</ActionIcon>
												</Tooltip>
											</Menu.Target>
											<Menu.Dropdown>
												<Menu.Label>{t("executionDeviceSelector")}</Menu.Label>
												<Menu.Item
													leftSection={<IconDeviceDesktop size={14} />}
													rightSection={
														<IconCheck
															size={14}
															style={{
																visibility: currentDeviceId === "local" ? "visible" : "hidden",
															}}
														/>
													}
													onClick={() => updateExecutionDeviceMutation.mutate(null)}
												>
													{t("executionTargetLocal")}
												</Menu.Item>
												{deviceData.devices.map((device) => (
													<Menu.Item
														key={device.id}
														leftSection={<IconDevices size={14} />}
														disabled={!device.online}
														rightSection={
															<IconCheck
																size={14}
																style={{
																	visibility: currentDeviceId === device.id ? "visible" : "hidden",
																}}
															/>
														}
														onClick={() => updateExecutionDeviceMutation.mutate(device.id)}
													>
														{device.online
															? device.name
															: `${device.name} (${t("executionDeviceOffline")})`}
													</Menu.Item>
												))}
											</Menu.Dropdown>
										</Menu>
									);
								})()}
								{dock ? (
									tasksSupported && (
										<Tooltip label={t("backgroundTasks.title")}>
											<Indicator
												inline
												size={8}
												color="blue"
												processing
												disabled={tasksRunningCount === 0}
												offset={3}
												zIndex={1}
												style={{
													height: "var(--ai-size-sm)",
													display: "flex",
													alignItems: "center",
												}}
											>
												<ActionIcon
													size="sm"
													variant={tasksToolOpened ? "light" : "subtle"}
													color={tasksToolOpened ? "indigo" : "gray"}
													onClick={toggleTasksTool}
												>
													<IconRobot size={16} />
												</ActionIcon>
											</Indicator>
										</Tooltip>
									)
								) : (
									<BackgroundTasksDrawer narratorId={narratorId} />
								)}
								<Tooltip label={t("fileMod_title")}>
									<ActionIcon
										size="sm"
										variant={fileModDrawerOpened ? "light" : "subtle"}
										color={fileModDrawerOpened ? "indigo" : "gray"}
										onClick={() => setFileModDrawerOpened((v) => !v)}
									>
										<IconFileCode size={16} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label={t("details.title")}>
									<ActionIcon
										size="sm"
										variant={detailsOpened ? "light" : "subtle"}
										color={detailsOpened ? "indigo" : "gray"}
										onClick={toggleDetails}
									>
										<IconInfoCircle size={16} />
									</ActionIcon>
								</Tooltip>
								{specToolAvailable && (
									<Tooltip
										label={
											specToolOpened
												? t("spec.close", "Close Outline")
												: t("spec.open", "Open Outline")
										}
									>
										<ActionIcon
											size="sm"
											variant={specToolOpened ? "light" : "subtle"}
											color={specToolOpened ? "indigo" : "gray"}
											onClick={toggleSpecTool}
										>
											<IconNotebook size={16} />
										</ActionIcon>
									</Tooltip>
								)}
								{dock && (
									<Tooltip label={t("git.title", "Git")}>
										<ActionIcon
											size="sm"
											variant={dock.openToolTypes.has("git") ? "light" : "subtle"}
											color={dock.openToolTypes.has("git") ? "indigo" : "gray"}
											onClick={() => dock.toggleToolPanel("git")}
										>
											<IconGitBranch size={16} />
										</ActionIcon>
									</Tooltip>
								)}
								{dock && browserSessionsCapability.supported !== false && (
									<Tooltip label={t("browser.title")}>
										<Indicator
											size={14}
											offset={4}
											label={wsState.browserSessionCount}
											color="teal"
											disabled={wsState.browserSessionCount === 0}
											style={{ display: "flex", alignItems: "center" }}
										>
											<ActionIcon
												size="sm"
												variant={dock.openToolTypes.has("browser") ? "light" : "subtle"}
												color={dock.openToolTypes.has("browser") ? "indigo" : "gray"}
												onClick={() => dock.toggleToolPanel("browser")}
											>
												<IconWorldWww size={16} />
											</ActionIcon>
										</Indicator>
									</Tooltip>
								)}
								<Tooltip label={t("archiveNarrator")}>
									<ActionIcon
										size="sm"
										variant="subtle"
										color="orange"
										loading={archiveMutation.isPending}
										onClick={() => {
											openArchiveConfirm();
										}}
									>
										<IconArchive size={16} />
									</ActionIcon>
								</Tooltip>
								{onClose && (
									<Tooltip label={t("closePanel")}>
										<ActionIcon size="sm" variant="subtle" color="red" onClick={onClose}>
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
						pos="relative"
						style={{ flex: 1, minHeight: 0, overflow: "hidden", isolation: "isolate" }}
					>
						{isFetchingNextPage && (
							<Box pos="absolute" top={0} left={0} right={0} style={{ zIndex: 1 }}>
								<RenderProgress indeterminate />
							</Box>
						)}

						{/* Skeleton overlay during node resize to prevent jitter */}
						{isResizing && (
							<Box
								pos="absolute"
								top={0}
								left={0}
								right={0}
								bottom={0}
								py="sm"
								px="md"
								style={{
									zIndex: 2,
									backgroundColor: "var(--mantine-color-body)",
								}}
							>
								<Stack gap="md">
									<Group align="flex-start" gap="sm">
										<Skeleton height={28} width={28} circle />
										<Box style={{ flex: 1 }}>
											<Skeleton height={14} width={60} mb={6} radius="sm" />
											<Skeleton height={36} radius="sm" />
										</Box>
									</Group>
									<Group align="flex-start" gap="sm">
										<Skeleton height={28} width={28} circle />
										<Box style={{ flex: 1 }}>
											<Skeleton height={14} width={80} mb={6} radius="sm" />
											<Skeleton height={16} width="95%" mb={4} radius="sm" />
											<Skeleton height={16} width="88%" mb={4} radius="sm" />
											<Skeleton height={16} width="72%" mb={4} radius="sm" />
											<Skeleton height={80} width="100%" mt={8} radius="sm" />
											<Skeleton height={16} width="90%" mt={8} radius="sm" />
											<Skeleton height={16} width="60%" radius="sm" />
										</Box>
									</Group>
									<Group align="flex-start" gap="sm">
										<Skeleton height={28} width={28} circle />
										<Box style={{ flex: 1 }}>
											<Skeleton height={14} width={60} mb={6} radius="sm" />
											<Skeleton height={24} width="70%" radius="sm" />
										</Box>
									</Group>
									<Group align="flex-start" gap="sm">
										<Skeleton height={28} width={28} circle />
										<Box style={{ flex: 1 }}>
											<Skeleton height={14} width={80} mb={6} radius="sm" />
											<Skeleton height={16} width="92%" mb={4} radius="sm" />
											<Skeleton height={16} width="85%" mb={4} radius="sm" />
											<Skeleton height={16} width="45%" radius="sm" />
										</Box>
									</Group>
								</Stack>
							</Box>
						)}
						<Box
							h="100%"
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
													{!canRenderMessageArea ? (
														<Box h="100%" py="sm" px="md">
															<Stack gap="md">
																<Group align="flex-start" gap="sm">
																	<Skeleton height={28} width={28} circle />
																	<Box style={{ flex: 1 }}>
																		<Skeleton height={14} width={60} mb={6} radius="sm" />
																		<Skeleton height={36} radius="sm" />
																	</Box>
																</Group>
																<Group align="flex-start" gap="sm">
																	<Skeleton height={28} width={28} circle />
																	<Box style={{ flex: 1 }}>
																		<Skeleton height={14} width={80} mb={6} radius="sm" />
																		<Skeleton height={16} width="95%" mb={4} radius="sm" />
																		<Skeleton height={16} width="88%" mb={4} radius="sm" />
																		<Skeleton height={16} width="72%" mb={4} radius="sm" />
																		<Skeleton height={80} width="100%" mt={8} radius="sm" />
																		<Skeleton height={16} width="90%" mt={8} radius="sm" />
																		<Skeleton height={16} width="60%" radius="sm" />
																	</Box>
																</Group>
																<Group align="flex-start" gap="sm">
																	<Skeleton height={28} width={28} circle />
																	<Box style={{ flex: 1 }}>
																		<Skeleton height={14} width={60} mb={6} radius="sm" />
																		<Skeleton height={24} width="70%" radius="sm" />
																	</Box>
																</Group>
																<Group align="flex-start" gap="sm">
																	<Skeleton height={28} width={28} circle />
																	<Box style={{ flex: 1 }}>
																		<Skeleton height={14} width={80} mb={6} radius="sm" />
																		<Skeleton height={16} width="92%" mb={4} radius="sm" />
																		<Skeleton height={16} width="85%" mb={4} radius="sm" />
																		<Skeleton height={16} width="45%" radius="sm" />
																	</Box>
																</Group>
															</Stack>
														</Box>
													) : isWorkspacePreview ? (
														<WorkspaceChunkPreview
															narratorId={narratorId}
															isSubagent={isSubagent}
															permCb={renderPermCb}
															expandedToolUseId={expandedToolUseId}
															showTokenUsage={showTokenUsage}
															pruneBoundaryMessageId={pruneBoundaryMessageId}
															pruneDividerLabel={pruneDividerLabel}
															lastUserMessageId={lastUserMessageId}
															hasChapter={hasChapter}
															resolvePerm={resolvePermForRender}
															onAskInPassing={handleAskInPassing}
														/>
													) : (
														<ChunkedMessageList
															ref={chunkListRef}
															narratorId={narratorId}
															isSubagent={isSubagent}
															permCb={renderPermCb}
															hasChapter={hasChapter}
															onForkFromMessage={forkHandler}
															highlightedId={highlightedId}
															highlightMessageId={highlightMessageId}
															onHighlightTarget={scheduleHighlight}
															expandedToolUseId={expandedToolUseId}
															showTokenUsage={showTokenUsage}
															pruneBoundaryMessageId={pruneBoundaryMessageId}
															pruneDividerLabel={pruneDividerLabel}
															onCompactBeforeMessage={
																compactSupported ? handleCompactBefore : undefined
															}
															onClearContextBefore={
																compactSupported ? handleClearContextBefore : undefined
															}
															onManualSummarize={
																compactSupported ? handleManualSummarize : undefined
															}
															onDeleteBlock={handleDeleteBlock}
															onRollbackToBlock={
																rollbackEditRegenerateSupported ? handleRollback : undefined
															}
															onEditAndRegenerate={
																rollbackEditRegenerateSupported
																	? handleEditAndRegenerate
																	: undefined
															}
															onEditAssistantMessage={handleEditAssistantMessage}
															onRestoreAssistantMessage={handleRestoreAssistantMessage}
															lastUserMessageId={lastUserMessageId}
															onViewSubagentSession={onViewSubagentSession}
															resolvePerm={resolvePermForRender}
															onAskInPassing={handleAskInPassing}
															scrollRef={chunkViewportRef}
															contentRef={contentRef}
															onSelectionResolverChange={setChunkSelectionResolver}
															onAtBottomChange={setIsAtBottom}
															onUnreadCountChange={setUnreadCount}
															onTailMetaChange={handleChunkTailMetaChange}
														/>
													)}
												</EditingMessageCtx.Provider>
											</LatestTodosToolUseIdCtx.Provider>
										</FileModDrawerCtx.Provider>
									</AllowRetryCtx.Provider>
								</MessageSelectionCtx.Provider>
							</CompactSummaryModalCtx.Provider>
						</Box>

						{/* Off-screen swipe/compacting anchor overlay — cloned message preview */}
						{(swipeAnchorOverlay ?? compactingMarkerOverlay) && (
							<SwipeAnchorOverlay
								info={(swipeAnchorOverlay ?? compactingMarkerOverlay) as SwipeAnchorInfo}
							/>
						)}

						{/* Multi-select floating toolbar — fixed center, similar to swipe menu style */}
						{selectionMode && (
							<Box
								ref={selectionToolbarRef}
								style={{
									position: "fixed",
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
										if (usesChunkMessageList) {
											chunkListRef.current?.scrollToBottom(true);
											return;
										}
										if (hasPreviousPage) {
											void revealLatestMessages();
											return;
										}
										scrollToLatestMessageWindow(true);
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
									<Text size="xs" truncate style={{ maxWidth: 160 }}>
										{file.name}
									</Text>
									<Text size="xs" c="dimmed">
										{formatFileSize(file.size)}
									</Text>
									<CloseButton
										size={16}
										iconSize={12}
										variant="transparent"
										c="dimmed"
										onClick={() => setAttachedTextFiles((prev) => prev.filter((_, j) => j !== i))}
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
									{queuedMessages[0].imageCount > 0 && (
										<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
											<IconPhoto size={14} color="var(--mantine-color-blue-5)" />
											<Text size="xs" c="blue">
												{queuedMessages[0].imageCount}
											</Text>
										</Group>
									)}
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
												<SortableQueuedMessageItem
													key={msg.id}
													msg={msg}
													index={index}
													isEditing={editingQueuedId === msg.id}
													editingText={editingQueuedText}
													onEditTextChange={setEditingQueuedText}
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

					{/* Chapter bar */}
					{narrator.chapterId && <ChapterBar chapterId={narrator.chapterId} />}

					{/* Status bar */}
					<Group
						px="md"
						pt="xs"
						pb="xs"
						gap="xs"
						justify="space-between"
						wrap="nowrap"
						style={{
							borderTop:
								attachedImages.length > 0 || queuedMessages.length > 0
									? undefined
									: "1px solid var(--mantine-color-default-border)",
							flexShrink: 0,
						}}
					>
						{showWorkIndicator && !isWorkspacePreview ? (
							<UnstyledButton
								disabled={isRetrying || !currentSpecTask}
								onClick={() => {
									if (isRetrying || !currentSpecTask) return;
									// Task state lives in the Dynamic Spec (spec://tasks.json); open the
									// Spec panel instead of jumping to a (now-removed) todo tool call.
									openSpecTool();
								}}
								style={{ minWidth: 0, flex: 1 }}
							>
								<Group gap={6} wrap="nowrap">
									<Loader
										size={14}
										color={
											isRetrying
												? "yellow"
												: isBlockingCompacting || (isBackgroundCompacting && !isWorking)
													? "orange"
													: isWaiting
														? "yellow"
														: isPlanning
															? "green"
															: "blue"
										}
										style={{ flexShrink: 0 }}
									/>
									<Text
										size="xs"
										c={
											isRetrying
												? "yellow"
												: isBlockingCompacting || (isBackgroundCompacting && !isWorking)
													? "orange"
													: isWaiting
														? "yellow"
														: isPlanning
															? "green"
															: "blue"
										}
										truncate
									>
										{isRetrying
											? retryCountdown > 0
												? t("retryingCountdown", {
														count: retryInfo?.retryCount,
														max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
														seconds: retryCountdown,
													})
												: t("retryingNow", {
														count: retryInfo?.retryCount,
														max: retryInfo?.maxRetries === -1 ? "∞" : retryInfo?.maxRetries,
													})
											: isBlockingCompacting
												? t("compacting")
												: currentSpecTask
													? currentSpecTask.text
													: isWaiting
														? t("status_waiting")
														: isPlanning
															? t("planning")
															: isBackgroundCompacting
																? t("backgroundCompacting")
																: t("thinking")}
									</Text>
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
									{isBackgroundCompacting && isWorking && !isBlockingCompacting && (
										<Text size="xs" c="orange" style={{ flexShrink: 0 }}>
											· {t("backgroundCompactingShort")}
										</Text>
									)}
									{turnElapsedText &&
										(turnStartedAtLabel ? (
											<Tooltip label={turnStartedAtLabel} position="top" withArrow>
												<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
													{turnElapsedText}
												</Text>
											</Tooltip>
										) : (
											<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
												{turnElapsedText}
											</Text>
										))}
								</Group>
							</UnstyledButton>
						) : (
							<Group gap={6} wrap="nowrap" style={{ flexShrink: 0, minWidth: 0 }}>
								<Box
									w={8}
									h={8}
									style={{
										borderRadius: "50%",
										backgroundColor: `var(--mantine-color-${statusBarDisplay.color}-filled)`,
										flexShrink: 0,
									}}
								/>
								<Text size="xs" c="dimmed" truncate>
									{t(statusBarDisplay.labelKey)}
								</Text>
								{turnElapsedText &&
									!isWorkspacePreview &&
									(turnStartedAtLabel ? (
										<Tooltip label={turnStartedAtLabel} position="top" withArrow>
											<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
												· {t("lastTurnDuration", { duration: turnElapsedText })}
											</Text>
										</Tooltip>
									) : (
										<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
											· {t("lastTurnDuration", { duration: turnElapsedText })}
										</Text>
									))}
							</Group>
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
											<Text
												size="xs"
												c="dimmed"
												style={{
													flexShrink: 0,
													cursor: "default",
													maxWidth: 120,
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{quotaBalance}
											</Text>
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
												<Tooltip label={t("relaxed_plan_tooltip")}>
													<ActionIcon
														variant="subtle"
														color={narrator.relaxedPlan ? "teal" : "gray"}
														size="sm"
														onClick={() =>
															relaxedPlanMutation.mutate({
																id: narratorId,
																relaxedPlan: !narrator.relaxedPlan,
															})
														}
													>
														{narrator.relaxedPlan ? (
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
									<Group gap={4} wrap="nowrap" {...(compact ? {} : { hiddenFrom: "sm" as const })}>
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
													<ActionIcon variant="subtle" color="gray" size="sm">
														<Text size="xs" fw={600}>
															{(() => {
																if (narrator.model === FOLLOW_DEFAULT_MODEL || !narrator.model)
																	return "D";
																const m = allModels.find((x) => x.value === narrator.model);
																// charAt(0) is safe on empty strings ("" → ""); fall back to "?"
																// so an empty label never produces `undefined.toUpperCase()`.
																return (
																	(m?.label || narrator.model || "?").charAt(0).toUpperCase() || "?"
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
														onSelect={(v) => modelMutation.mutate({ id: narratorId, model: v })}
														onShowPrice={setPriceModel}
														label={t("modelTooltip")}
														providerLabels={providerLabels}
														onEditDefaultModel={() => setGlobalModelEditTarget("default")}
														onEditSummaryModel={() => setGlobalModelEditTarget("summary")}
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
													<ActionIcon variant="subtle" color="gray" size="sm">
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
																	effortMap[displayedReasoningEffort as keyof typeof effortMap] ??
																	"A"
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
															reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: e })
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
													disabled
													style={{ opacity: 0.6 }}
												>
													{PERM_MODE_ICONS.readOnly ?? <IconShield size={16} />}
												</ActionIcon>
											) : (
												<Menu position="bottom-end" withinPortal>
													<Menu.Target>
														<ActionIcon variant="subtle" color="gray" size="sm">
															{PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
																<IconShield size={16} />
															)}
														</ActionIcon>
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
															planReflectionAutoApproveOverride={planReflectionAutoApproveOverride}
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
															onFollowDefaultDangerReflection={handleFollowDefaultDangerReflection}
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
													size="compact-xs"
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
										{/* Relaxed Plan toggle (compact layout, only in plan mode) */}
										{hasPlanTrait && (
											<Tooltip label={t("relaxed_plan_tooltip")}>
												<ActionIcon
													variant="subtle"
													color={narrator.relaxedPlan ? "teal" : "gray"}
													size="sm"
													onClick={() =>
														relaxedPlanMutation.mutate({
															id: narratorId,
															relaxedPlan: !narrator.relaxedPlan,
														})
													}
												>
													{narrator.relaxedPlan ? (
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
													label={activeTerminalCount}
													size={14}
													disabled={activeTerminalCount === 0}
													offset={2}
													color="blue"
												>
													<ActionIcon
														variant="subtle"
														color={terminalToolOpened ? "blue" : "gray"}
														size="sm"
														onClick={onOpenTerminalPanel ?? toggleTerminalTool}
													>
														<IconTerminal size={16} />
													</ActionIcon>
												</Indicator>
											</Tooltip>
										)}
									</Group>
								</Group>
							</>
						)}
					</Group>

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
								<Box style={{ position: "relative", flex: 1 }}>
									<CommandPopover
										commands={commandsList ?? []}
										input={input}
										visible={commandPopoverVisible}
										onSelect={handleCommandSelect}
										onClose={closeCommandPopover}
									/>
									<MentionPopover
										candidates={mentionCandidates}
										query={mentionQuery}
										visible={mentionPopoverVisible}
										onSelect={handleMentionSelect}
										onClose={closeMentionPopover}
									/>
									{matchedCommand && (
										<CommandParamHelper
											command={matchedCommand}
											input={input}
											visible={!commandPopoverVisible}
										/>
									)}
									{draftSyncState === "error" && (
										<Group gap="xs" mb={4} wrap="nowrap">
											<Text size="xs" c="orange" style={{ flex: 1 }}>
												{t("draftLoadFailed")}
											</Text>
											<Button size="compact-xs" variant="light" onClick={retryDraftHydration}>
												{t("draftRetry")}
											</Button>
										</Group>
									)}
									{draftSyncState === "conflict" && (
										<Stack gap={4} mb={4}>
											<Text size="xs" c="orange">
												{t("draftConflict")}
											</Text>
											<Group gap="xs">
												<Button size="compact-xs" variant="light" onClick={acceptServerDraft}>
													{t("draftUseServer")}
												</Button>
												<Button size="compact-xs" color="orange" onClick={overwriteServerDraft}>
													{t("draftUseLocal")}
												</Button>
											</Group>
										</Stack>
									)}
									{!isDraftWithinSyncLimit(input) && (
										<Text size="xs" c="orange" mb={4}>
											{t("draftTooLong", {
												limit: formatLocaleNumber(MAX_NARRATOR_DRAFT_CHARS),
											})}
										</Text>
									)}
									<Textarea
										ref={textareaRef}
										placeholder={t("sendPlaceholder")}
										value={input}
										onChange={(e) => {
											setInput(e.currentTarget.value);
											setMentionCaret(e.currentTarget.selectionStart);
											inputHistory.reset();
										}}
										onKeyDown={handleKeyDown}
										onKeyUp={(e) => setMentionCaret(e.currentTarget.selectionStart)}
										onClick={(e) => setMentionCaret(e.currentTarget.selectionStart)}
										onBlur={() => setMentionCaret(null)}
										onPaste={handlePaste}
										autosize
										minRows={1}
										maxRows={6}
									/>
								</Box>
								{(() => {
									const hasInput = !!input.trim();
									const hasAttachments = attachedImages.length > 0 || attachedTextFiles.length > 0;

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

										const hasCutInMessage = !!queuedMessages[0]?.priority;
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
										return isActive
											? withSendOptions(
													<Tooltip
														label={t(`queueMode_${userPrefs?.enterQueueMode ?? "turn"}`)}
														position="top"
													>
														<Button
															key="send-priority"
															disabled={!hasInput && !hasAttachments}
															loading={isSending}
															onClick={handleSend}
															onContextMenu={(e) => e.preventDefault()}
														>
															{queuedMessages.length > 0
																? `${t("queue")} (${queuedMessages.length})`
																: t("queue")}
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

					{/* Only render Drawer when NOT in dock/external sidebar mode (i.e. mobile / workspace) */}
					{!dock && !onToggleFileModPanel && (
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
								body: {
									height: "calc(100% - 60px)",
									padding: 0,
									display: "flex",
									flexDirection: "column",
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
				</Stack>
			</ContentViewerEnvironmentProvider>
			<RollbackConfirmModal
				narratorId={narratorId}
				pendingRollback={pendingRollback}
				onConfirm={confirmRollback}
				onCancel={() => setPendingRollback(null)}
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
