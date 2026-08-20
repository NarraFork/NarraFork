import type { RevertScope } from "@frontend/lib/api/narrators";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	CloseButton,
	Code,
	Collapse,
	Group,
	Image,
	Loader,
	Menu,
	Modal,
	Paper,
	ScrollArea,
	Select,
	Skeleton,
	Spoiler,
	Stack,
	Text,
	Textarea,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	type CompactMessageDetail,
	type CompactMessageStatus,
	isCompactRetryableDetail,
} from "@shared/compact-message";
import { isHumanOrigin } from "@shared/message-origin";
import { isLiveStreamingRun } from "@shared/pretext-layout/streaming-live-blocks";
import { coerceProgressSnapshot, type ProgressSnapshot } from "@shared/progress-phase";
import { readSideCarBody } from "@shared/sidecar-body";
import { formatFileSize } from "@shared/text-file-types";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconArrowsMinimize,
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconDownload,
	IconEraser,
	IconExternalLink,
	IconEyeCheck,
	IconFile,
	IconGitFork,
	IconGitMerge,
	IconLanguage,
	IconListCheck,
	IconLock,
	IconMessageQuestion,
	IconNotebook,
	IconPhoto,
	IconRepeat,
	IconRestore,
	IconTrash,
	IconWorldSearch,
	IconX,
} from "@tabler/icons-react";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useAllModels } from "../../hooks/useModels";
import { useFileSystemCapability, useUploadCapability } from "../../hooks/usePlatform";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import {
	ApiError,
	absorbRenewedToken,
	api,
	clearTokenOnSessionFailure,
	getToken,
	readFetchError,
} from "../../lib/api";
import type { RetryFailedCompactResponse } from "../../lib/api/narrators";
import { formatLocaleDateTime, formatLocaleNumber, formatLocaleTime } from "../../lib/intl-format";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { notifyResultWarnings } from "../../lib/operation-warnings";
import { Z } from "../../lib/z-index";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";
import { DirectoryPicker } from "../common/DirectoryPicker";
import { useImageViewer } from "../common/ImageViewerProvider";
import { UserAvatar } from "../UserAvatar";
import { AskInPassingPendingCard, AskInPassingResolvedCard } from "./AskInPassingCard";
import { ClampableText } from "./ClampableText";
import { CompactMenuSub } from "./CompactMenuSub";
import { ContentViewer } from "./ContentViewer";
import {
	copyGeneratedImageToClipboard,
	MAX_IMAGE_CLIPBOARD_BLOB_BYTES,
	MAX_INLINE_IMAGE_SOURCE_CHARS,
} from "./image-clipboard";
import { LazyCollapse } from "./LazyCollapse";
import { MarkdownContent } from "./MarkdownContent";
import {
	type MessageContextMenuActions,
	MessageContextMenuCtx,
	useMessageContextMenu,
} from "./MessageContextMenuCtx";
import { MessageEditorPanel } from "./MessageEditorPanel";
import { EditedBadge } from "./MessageOriginalContent";
import {
	MessageOriginBadge,
	OriginAvatar,
	resolveUserBubbleName,
	SystemOriginNotice,
} from "./MessageOriginBadge";
import {
	BLOCK_ID_ATTR,
	BLOCK_INDICES_ATTR,
	makeMessageBlockSelectionId,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "./MessageSelectionCtx";
import { collectTextBlocksPreview, resolveEditorInitialText } from "./message-edit-text";
import { generateBlockKeys } from "./message-segments";
import { NarratorImageGenFixAction } from "./NarratorImageGenFixAction";
import { NarratorModelTestAction } from "./NarratorModelTestAction";
import { compactProgressLabel } from "./progress-label";
import { ReasoningCountLine } from "./ReasoningCountLine";
import { ReasoningStepsTrace } from "./ReasoningStepsTrace";
import { useRenderInteractive, useRenderLod } from "./RenderLodCtx";
import { RetryRuleModal } from "./RetryRuleModal";
import {
	getReasoningEncryptionState,
	groupReasoningRuns,
	hasStructuredReasoning,
	parseReasoningSegments,
	resolveReasoningRunActionIndices,
} from "./reasoning-segments";
import {
	type SubagentRecoveryEntry,
	SubagentRecoveryPendingCard,
	SubagentRecoveryResolvedCard,
} from "./SubagentRecoveryCard";
import { SystemInjectionNotice } from "./SystemInjectionNotice";
import { type PendingPermission, ToolCallCard } from "./ToolCallCard";

const FIXED_MENU_TRANSITION_PROPS = { duration: 0 };
const SYSTEM_MESSAGE_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";
export const COMPACTING_MARKER_ATTR = "data-compacting-marker";
const COMPACT_DETAIL_QUERY_GC_TIME_MS = 30_000;
const MAX_HIDDEN_COMPACT_MESSAGES = 100;
const HIDDEN_COMPACT_MESSAGE_PREVIEW_CHARS = 800;
const MAX_MESSAGE_IMAGE_PREVIEW_BLOB_BYTES = MAX_IMAGE_CLIPBOARD_BLOB_BYTES;
const MAX_INLINE_IMAGE_RESULT_CHARS = MAX_INLINE_IMAGE_SOURCE_CHARS;
const GENERATED_IMAGE_MAX_DISPLAY_WIDTH = 512;
/**
 * Height cap for a dimensioned chat image. Images with persisted intrinsic
 * dimensions render at their aspect ratio up to this height; without dimensions
 * the legacy fixed 200px box is used.
 *
 * Keep in sync with `vlist/measure/measure-media.ts`'s IMAGE_MAX_DISPLAY_HEIGHT,
 * which is the source of the value. It cannot be imported here: this file is on
 * the CHUNKED path, outside `vlist/`, and any static import into vlist/ trips the
 * isolation guard (CONTRACT §0 铁律 1 — the flag-off path must not even load the
 * vlist chunk). Same arrangement as tool-detail.ts's MEDIA_IMAGE_CONTENT_PX.
 */
const CHAT_IMAGE_MAX_HEIGHT = 400;
const MAX_USER_MESSAGE_DISPLAY_CHARS = 120_000;

/**
 * Compact-summary dialogs render arbitrarily long markdown. With Mantine's
 * default layout the whole body scrolls, so the action bar (revoke / edit /
 * retry) ends up far below the fold and the user has to scroll a long summary
 * to reach it. Instead the content shell becomes a flex column that never
 * scrolls: the sticky header stays put, only the summary column scrolls, and
 * the actions stay docked at the bottom edge.
 */
const COMPACT_SUMMARY_MODAL_STYLES = {
	content: {
		display: "flex",
		flexDirection: "column" as const,
		// Mantine's own `overflow-y: auto` here would let the footer scroll away.
		overflow: "hidden",
	},
	// Flex items shrink by default; the title row must keep its full height even
	// when a long summary fills the dialog.
	header: { flexShrink: 0 },
	body: {
		// `1 1 auto` (not `flex: 1`) so a short summary still yields a short modal:
		// the base size stays content-driven and only shrinks once the content
		// shell hits its max-height.
		flex: "1 1 auto",
		minHeight: 0,
		display: "flex",
		flexDirection: "column" as const,
		overflow: "hidden",
		// The scroll column and footer carry their own padding so the divider can
		// span the full modal width.
		padding: 0,
	},
};
const COMPACT_SUMMARY_SCROLL_STYLE = {
	flex: 1,
	minHeight: 0,
	overflowY: "auto" as const,
	overscrollBehavior: "contain" as const,
	padding: "var(--mantine-spacing-md)",
	paddingTop: 0,
};
const COMPACT_SUMMARY_FOOTER_STYLE = {
	flexShrink: 0,
	borderTop: "1px solid var(--mantine-color-default-border)",
	padding: "var(--mantine-spacing-sm) var(--mantine-spacing-md)",
};

function collectHiddenCompactMessagePreview(blocks: { type: string; text?: string }[]): {
	text: string;
	truncated: boolean;
} {
	let result = "";
	let truncated = false;
	for (const block of blocks) {
		if (block.type !== "text" || !block.text) continue;
		const separator = result ? "\n\n" : "";
		const remaining = HIDDEN_COMPACT_MESSAGE_PREVIEW_CHARS - result.length - separator.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		result += separator + block.text.slice(0, remaining);
		if (block.text.length > remaining || result.length >= HIDDEN_COMPACT_MESSAGE_PREVIEW_CHARS) {
			truncated = true;
			break;
		}
	}
	return { text: result, truncated };
}

// --- Editing message context ---
// Defined in its own module (so MessageEditorPanel can use it without a circular
// import) and re-exported here for the existing importers.
export { EditingMessageCtx, type EditingMessageState } from "./EditingMessageCtx";

export type CompactSummaryKind = "context" | "segment";

export interface CompactSummaryModalTarget {
	kind: CompactSummaryKind;
	narratorId: string;
	messageId: string;
	onDelete?: () => void;
	/** Open directly in edit mode (e.g. for the manual summarize flow). */
	autoEdit?: boolean;
}

export function compactSummaryQueryKey(narratorId: string, messageId: string) {
	return ["compact-summary", narratorId, messageId] as const;
}

export interface CompactRetryTargetMigration {
	nextMessageId: string;
	retiredMessageIds: string[];
	changed: boolean;
}

export function resolveCompactRetryTargetMigration(
	currentMessageId: string,
	response: Partial<RetryFailedCompactResponse>,
): CompactRetryTargetMigration {
	const nextMessageId =
		typeof response.messageId === "string" && response.messageId.length > 0
			? response.messageId
			: currentMessageId;
	const retiredMessageIds = new Set<string>();
	for (const messageId of [currentMessageId, response.oldMessageId, response.replacedMessageId]) {
		if (typeof messageId === "string" && messageId.length > 0 && messageId !== nextMessageId) {
			retiredMessageIds.add(messageId);
		}
	}
	return {
		nextMessageId,
		retiredMessageIds: [...retiredMessageIds],
		changed: nextMessageId !== currentMessageId,
	};
}

/**
 * Resolve a COW replacement directly from a WS frame. The HTTP response is not
 * required: old IDs may be listed as deletion aliases while the replacement is
 * exposed as `messageId`, `newMessageId`, `replacementMessageId`, or the updated
 * message's own ID. Frames without both sides are ordinary deletions/updates.
 */
export function resolveCompactReplacementEvent(
	currentMessageId: string,
	event: Record<string, unknown>,
): CompactRetryTargetMigration | null {
	const oldIds = new Set<string>();
	for (const value of [event.oldMessageId, event.replacedMessageId]) {
		if (typeof value === "string" && value) oldIds.add(value);
	}
	if (Array.isArray(event.deletedMessageIds)) {
		for (const value of event.deletedMessageIds) {
			if (typeof value === "string" && value) oldIds.add(value);
		}
	}
	const message = event.message;
	const nestedMessageId =
		message && typeof message === "object" && !Array.isArray(message)
			? (message as { id?: unknown }).id
			: undefined;
	if (!oldIds.has(currentMessageId)) {
		// Once the modal has already switched, a duplicate WS frame should still
		// clean the retired key, but unrelated narrator deletions must be ignored.
		const currentIsCandidate = [
			event.messageId,
			event.newMessageId,
			event.replacementMessageId,
			nestedMessageId,
		].some((value) => value === currentMessageId);
		if (!currentIsCandidate) return null;
	}

	const candidates: string[] = [];
	for (const value of [
		event.newMessageId,
		event.replacementMessageId,
		event.messageId,
		nestedMessageId,
	]) {
		if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value);
	}
	const nextMessageId = candidates.find((value) => !oldIds.has(value));
	if (!nextMessageId || (nextMessageId === currentMessageId && oldIds.size === 0)) return null;

	const retiredMessageIds = [...oldIds].filter((value) => value !== nextMessageId);
	return {
		nextMessageId,
		retiredMessageIds,
		changed: nextMessageId !== currentMessageId,
	};
}

export const CompactSummaryModalCtx = createContext<{
	open: (target: CompactSummaryModalTarget) => void;
} | null>(null);

// Module-level map that persists reasoning expand/collapse state across
// component remounts (e.g. when streaming __streaming__ → real message).
// Key: `${narratorId}:${blockIndex}`, Value: expanded (true) or collapsed (false).
// Only written when the user explicitly toggles — blocks without an entry
// always follow the global preference (narrafork_expand_reasoning).
const MAX_REASONING_EXPAND_STATE_ENTRIES = 500;
const reasoningExpandState = new Map<string, boolean>();

function getReasoningExpandState(key: string): boolean | undefined {
	const value = reasoningExpandState.get(key);
	if (value !== undefined) {
		reasoningExpandState.delete(key);
		reasoningExpandState.set(key, value);
	}
	return value;
}

function setReasoningExpandState(key: string, value: boolean) {
	reasoningExpandState.delete(key);
	reasoningExpandState.set(key, value);
	while (reasoningExpandState.size > MAX_REASONING_EXPAND_STATE_ENTRIES) {
		const oldestKey = reasoningExpandState.keys().next().value;
		if (oldestKey === undefined) break;
		reasoningExpandState.delete(oldestKey);
	}
}

let nextRbInstanceId = 0;
let nextWsInstanceId = 0;

interface MessageBubbleProps {
	narratorId?: string;
	message: {
		id?: string;
		narratorId?: string;
		role: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentJson: any[];
		contentText?: string | null;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		toolCalls?: any[];
		messageUuid?: string | null;
		commandText?: string | null;
		createdAt?: string | null;
		/** Set when this assistant message's text was manually edited and persisted. */
		editedAt?: string | null;
		editedBy?: string | null;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		originalContentJson?: any[] | null;
		creator?: {
			id: string;
			username: string;
			avatarColor?: string | null;
			avatarImageId?: string | null;
		} | null;
		/**
		 * Who authored the content, independent of `role`. Null on rows written
		 * before this column existed, which normalizes to "user".
		 */
		origin?: string | null;
		/** Display-only source label (see @shared/message-origin). */
		originLabel?: string | null;
		/** Maps each index in the filtered contentJson back to the complete message. */
		_blockOriginalIndices?: number[];
		/** Complete unfiltered contentJson retained when rendering one visual segment. */
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		_allContentJson?: any[];
		/**
		 * Live row only: index of the block still being written (see
		 * `@shared/pretext-layout/streaming-live-blocks`). Indexes the COMPLETE block
		 * array, so it pairs with `_allContentJson`.
		 */
		liveBlockIndex?: number;
	};
	onForkFromMessage?: (messageId: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	/** Resolve a PendingPermission for a given tool call record */
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	resolvePerm?: (tc: any) => PendingPermission | null;
	onPermissionDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionReflect?: (requestId: string) => Promise<void> | void;
	onQuestionDeny?: (requestId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => Promise<void> | void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: { skipRevert: boolean; scope?: RevertScope },
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
		},
	) => Promise<boolean>;
	/** Edit assistant message text without deleting later messages or regenerating. */
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	/** Restore an edited assistant message back to its original text, clearing the edit marker. */
	onRestoreAssistantMessage?: (messageId: string) => void;
	/** Open an awaited child-agent session in the host's side panel. */
	onViewSubagentSession?: (narratorId: string) => void;
	/**
	 * Open a file path in a read-only dock panel. Used by this message's tool cards
	 * and by its text-file attachments; absent (no dockview host) → not clickable.
	 */
	onOpenFilePanel?: (filePath: string) => void;
	/** Whether this is the last user message in the conversation */
	isLastUserMessage?: boolean;
	/** Whether the narrator is bound to a chapter (has git support) */
	hasChapter?: boolean;
}

type MessageBubbleMessage = MessageBubbleProps["message"];

function sameMessageCreator(
	prev: MessageBubbleMessage["creator"],
	next: MessageBubbleMessage["creator"],
): boolean {
	if (prev === next) return true;
	if (!prev || !next) return false;
	return (
		prev.id === next.id &&
		prev.username === next.username &&
		prev.avatarColor === next.avatarColor &&
		prev.avatarImageId === next.avatarImageId
	);
}

function sameMessagePayload(prev: MessageBubbleMessage, next: MessageBubbleMessage): boolean {
	return (
		prev === next ||
		(prev.origin === next.origin &&
			prev.originLabel === next.originLabel &&
			prev.id === next.id &&
			prev.narratorId === next.narratorId &&
			prev.role === next.role &&
			prev.contentJson === next.contentJson &&
			prev.contentText === next.contentText &&
			prev.toolCalls === next.toolCalls &&
			prev.messageUuid === next.messageUuid &&
			prev.commandText === next.commandText &&
			prev.createdAt === next.createdAt &&
			prev.editedAt === next.editedAt &&
			prev.originalContentJson === next.originalContentJson &&
			prev._blockOriginalIndices === next._blockOriginalIndices &&
			prev._allContentJson === next._allContentJson &&
			sameMessageCreator(prev.creator, next.creator))
	);
}

function messageBubbleAreEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
	return (
		prev.narratorId === next.narratorId &&
		prev.onForkFromMessage === next.onForkFromMessage &&
		prev.onAskInPassing === next.onAskInPassing &&
		prev.resolvePerm === next.resolvePerm &&
		prev.onPermissionDecision === next.onPermissionDecision &&
		prev.onQuestionSubmit === next.onQuestionSubmit &&
		prev.onQuestionReflect === next.onQuestionReflect &&
		prev.onQuestionDeny === next.onQuestionDeny &&
		prev.onCompactBeforeMessage === next.onCompactBeforeMessage &&
		prev.onClearContextBefore === next.onClearContextBefore &&
		prev.onManualSummarize === next.onManualSummarize &&
		prev.onDeleteBlock === next.onDeleteBlock &&
		prev.onRollbackToBlock === next.onRollbackToBlock &&
		prev.onViewSubagentSession === next.onViewSubagentSession &&
		prev.onOpenFilePanel === next.onOpenFilePanel &&
		prev.onEditAndRegenerate === next.onEditAndRegenerate &&
		prev.onEditAssistantMessage === next.onEditAssistantMessage &&
		prev.onRestoreAssistantMessage === next.onRestoreAssistantMessage &&
		prev.isLastUserMessage === next.isLastUserMessage &&
		prev.hasChapter === next.hasChapter &&
		sameMessagePayload(prev.message, next.message)
	);
}

function WebSearchBlock({
	block,
	blockIndex,
	messageId,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
	block: any;
	blockIndex?: number;
	messageId?: string;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	const query = block.query ?? (block.queries as string[] | undefined)?.join(", ");
	const isSearching = block.status && block.status !== "completed";

	// --- Block ID, selection, swipe & context menu state ---
	const wsInstanceId = useRef(nextWsInstanceId++);
	const blockIdStr =
		messageId && blockIndex != null
			? makeMessageBlockSelectionId(messageId, blockIndex)
			: `ws-${wsInstanceId.current}`;
	const rootRef = useRef<HTMLDivElement>(null);
	const selection = useMessageSelection();
	const msgCtx = useMessageContextMenu();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

	const isSelected = !!(selection.selectionMode && selection.selectedBlockIds.has(blockIdStr));

	const handleDeselect = useCallback(() => {
		selection.deselectBlock(blockIdStr);
	}, [selection.deselectBlock, blockIdStr]);

	const swipe = useSwipeMenu({
		enabled: true,
		externalBoxRef: rootRef,
		excludeSelectors: [".mantine-Menu-dropdown"],
		blockId: blockIdStr,
		onSwipeRight: isSelected ? handleDeselect : undefined,
	});

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (isMobile) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 200);
			const flipY = e.clientY > window.innerHeight - 300;
			swipe.setCtxMenuPos({ x, y: e.clientY, flipY });
			swipe.setCtxMenuOpened(true);
		},
		[isMobile, swipe],
	);

	const handleBlockClick = useCallback(
		(e: React.MouseEvent) => {
			if (isMobile) return;
			const isModKey = e.metaKey || e.ctrlKey;
			const isShift = e.shiftKey;
			if (!isModKey && !isShift) return;
			if (shouldIgnoreMessageBlockSelection(e.target)) return;
			if (!selection.selectionMode) {
				const sel = window.getSelection();
				if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			}
			e.preventDefault();
			if (isShift) {
				window.getSelection()?.removeAllRanges();
				selection.rangeSelectTo(blockIdStr);
			} else {
				selection.toggleBlock(blockIdStr);
			}
		},
		[isMobile, blockIdStr, selection],
	);

	const SWIPE_REVEAL_WIDTH = 180;

	const hasMenuActions = !!(
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		msgCtx.onRollbackToBlock ||
		msgCtx.onDeleteBlock
	);
	const menuItemsNode = (
		<>
			{hasMenuActions && (
				<>
					{msgCtx.onRollbackToBlock && blockIndex != null && (
						<Menu.Item
							leftSection={<IconArrowBackUp size={14} />}
							onClick={() => {
								msgCtx.onRollbackToBlock?.(blockIndex);
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_rollback")}
						</Menu.Item>
					)}
					{msgCtx.onForkFromMessage && (
						<Menu.Item
							leftSection={<IconGitFork size={14} />}
							onClick={() => {
								msgCtx.onForkFromMessage?.();
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_fork")}
						</Menu.Item>
					)}
					{msgCtx.onAskInPassing && (
						<Menu.Item
							leftSection={<IconMessageQuestion size={14} />}
							onClick={() => {
								msgCtx.onAskInPassing?.();
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_askInPassing")}
						</Menu.Item>
					)}
					{msgCtx.onCompactBeforeMessage && (
						<CompactMenuSub
							onCompact={msgCtx.onCompactBeforeMessage}
							onClearContext={msgCtx.onClearContextBefore}
							onManualSummarize={msgCtx.onManualSummarize}
							onClose={() => swipe.closeSwipe()}
						/>
					)}
					{msgCtx.onDeleteBlock && blockIndex != null && (
						<Menu.Item
							color="red"
							leftSection={<IconTrash size={14} />}
							onClick={() => {
								msgCtx.onDeleteBlock?.(blockIndex);
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_delete")}
						</Menu.Item>
					)}
				</>
			)}
			<Menu.Divider />
			<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
				{tc("cancel")}
			</Menu.Item>
		</>
	);

	const ctxMenu = (
		<Menu
			opened={swipe.ctxMenuOpened}
			onChange={swipe.setCtxMenuOpened}
			position="bottom-start"
			withinPortal
			transitionProps={FIXED_MENU_TRANSITION_PROPS}
			styles={{
				dropdown: {
					position: "fixed",
					left: swipe.ctxMenuPos.x,
					...(swipe.ctxMenuPos.flipY
						? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
						: { top: swipe.ctxMenuPos.y }),
				},
			}}
		>
			<Menu.Target>
				<div
					style={{
						position: "fixed",
						left: swipe.ctxMenuPos.x,
						top: swipe.ctxMenuPos.y,
						pointerEvents: "none",
					}}
				/>
			</Menu.Target>
			<Menu.Dropdown>{menuItemsNode}</Menu.Dropdown>
		</Menu>
	);

	const swipeMenu =
		(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
		(() => {
			const menuEl = swipe.swipeMenuRef.current;
			const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
			return createPortal(
				<Box
					ref={swipe.swipeMenuRef}
					style={{
						position: "fixed",
						left: pos.left,
						top: pos.top,
						transform: "translateY(-50%)",
						zIndex: Z.popover,
						transition: swipe.swipeMenuTransition,
						pointerEvents: swipe.swipeClosing ? "none" : "auto",
						opacity: swipe.swipeClosing ? 0 : 1,
					}}
				>
					<Menu opened withinPortal={false} position="bottom-start">
						<Menu.Dropdown style={{ position: "relative", width: SWIPE_REVEAL_WIDTH }}>
							{menuItemsNode}
						</Menu.Dropdown>
					</Menu>
				</Box>,
				document.body,
			);
		})();

	return (
		<>
			<Box
				ref={rootRef}
				data-content-block
				{...(blockIdStr ? { [BLOCK_ID_ATTR]: blockIdStr } : {})}
				{...(messageId ? { "data-message-id": messageId } : {})}
				{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
				onContextMenu={handleContextMenu}
				onClick={handleBlockClick}
				style={{
					outline: isSelected ? "2px solid var(--mantine-color-indigo-6)" : undefined,
					outlineOffset: isSelected ? -2 : undefined,
					borderRadius: isSelected ? 4 : undefined,
					transform: swipe.swipeOffset > 0 ? `translateX(-${swipe.swipeOffset}px)` : undefined,
					transition: swipe.swipeTransition,
				}}
			>
				<Paper withBorder radius="sm" p="xs">
					<Group gap={6} wrap="nowrap" align="center">
						<ThemeIcon size={18} variant="light" color="teal" radius="sm">
							<IconWorldSearch size={12} />
						</ThemeIcon>
						{isSearching && <Loader size={12} color="teal" type="dots" />}
						<Text size="xs" c="dimmed">
							{isSearching
								? block.status === "searching"
									? t("webSearching")
									: t("webSearchPreparing")
								: t("webSearched")}
							{query && (
								<Text span fw={500} c="teal" ml={4}>
									{query}
								</Text>
							)}
						</Text>
					</Group>
				</Paper>
			</Box>
			{swipeMenu}
			{ctxMenu}
		</>
	);
}

interface ImageGenerationBlockData {
	type: "image_generation";
	id: string;
	status?: string;
	revisedPrompt?: string;
	result?: string;
	savedPath?: string;
	partialSavedPath?: string;
	partialImageIndex?: number;
	outputIndex?: number;
	width?: number;
	height?: number;
}

function generatedImageFilename(block: ImageGenerationBlockData): string {
	const sourcePath = block.savedPath ?? block.partialSavedPath;
	const savedName = sourcePath?.split(/[\\/]/).pop();
	if (savedName?.trim()) return savedName.endsWith(".png") ? savedName : `${savedName}.png`;
	const safeId = (block.id || "generated-image").replace(/[^A-Za-z0-9_-]/g, "_");
	return `${safeId || "generated-image"}.png`;
}

function downloadUrl(url: string, filename: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
}

function getImageGenerationDisplayMetrics(block: ImageGenerationBlockData): {
	width: number;
	height: number;
	displayWidth: number;
} | null {
	const { width, height } = block;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return null;
	}
	return {
		width,
		height,
		displayWidth: Math.min(width, GENERATED_IMAGE_MAX_DISPLAY_WIDTH),
	};
}

function ImageGenerationBlock({
	block,
	blockIndex,
}: {
	block: ImageGenerationBlockData;
	blockIndex?: number;
}) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const msgCtx = useMessageContextMenu();
	const fsCapability = useFileSystemCapability();
	const fsPreviewSupported = fsCapability.preview.supported;
	const interactive = useRenderInteractive();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const isGenerating = block.status && block.status !== "completed";
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
	const [ctxMenuOpened, setCtxMenuOpened] = useState(false);
	const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0, flipY: false });

	const getPreviewHeaders = useCallback(() => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}, []);
	const previewPath = block.savedPath ?? block.partialSavedPath;

	// Fetch image from savedPath / partialSavedPath via /api/fs/preview (blob URL)
	useEffect(() => {
		if (!previewPath || !fsPreviewSupported) return;
		let cancelled = false;
		let objectUrl: string | null = null;
		setLoadError(false);
		setLoadErrorMessage(null);
		fetch(`/api/fs/preview?path=${encodeURIComponent(previewPath)}`, {
			headers: getPreviewHeaders(),
		})
			.then(async (r) => {
				if (!r.ok) {
					const error = await readFetchError(r, "Request failed");
					throw new ApiError(error.message, r.status, error.data);
				}
				return r.blob();
			})
			.then((blob) => {
				if (!cancelled) {
					if (blob.size > MAX_MESSAGE_IMAGE_PREVIEW_BLOB_BYTES) throw new Error("Image too large");
					objectUrl = URL.createObjectURL(blob);
					setBlobUrl(objectUrl);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setLoadError(true);
					setLoadErrorMessage(err instanceof Error ? err.message : null);
				}
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [previewPath, fsPreviewSupported, getPreviewHeaders]);

	// Determine image source: final savedPath blob > partial preview blob > bounded inline base64 > none
	const inlineImageSrc =
		block.result && block.result.length <= MAX_INLINE_IMAGE_RESULT_CHARS
			? block.result.startsWith("data:")
				? block.result
				: `data:image/png;base64,${block.result}`
			: null;
	const imageSrc = blobUrl ?? inlineImageSrc;
	const inlineResultUnavailable =
		!previewPath && !!block.result && block.result.length > MAX_INLINE_IMAGE_RESULT_CHARS;
	const savedPathPreviewUnavailable = !!previewPath && !fsPreviewSupported && !inlineImageSrc;
	const imageUnavailable = loadError || inlineResultUnavailable || savedPathPreviewUnavailable;
	const hasImage = !!imageSrc && !imageUnavailable;
	const imageMetrics = getImageGenerationDisplayMetrics(block);
	const shouldReserveImageFrame =
		!!imageMetrics && (!!previewPath || !!block.result || imageUnavailable);
	const imageFrameStyle: React.CSSProperties | undefined = imageMetrics
		? {
				width: `min(100%, ${imageMetrics.displayWidth}px)`,
				aspectRatio: `${imageMetrics.width} / ${imageMetrics.height}`,
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
				backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}
		: undefined;
	const canCopyImage = hasImage || (!!previewPath && fsPreviewSupported);
	const canCopyImagePath = !!previewPath;
	const canSaveImage = hasImage;
	const hasMenuActions = !!(
		canCopyImage ||
		canCopyImagePath ||
		canSaveImage ||
		msgCtx.onRollbackToBlock ||
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		msgCtx.onDeleteBlock
	);

	const handleCopyImage = useCallback(async () => {
		if (!imageSrc && (!previewPath || !fsPreviewSupported)) return;
		try {
			await copyGeneratedImageToClipboard({
				imageSrc,
				savedPath: fsPreviewSupported ? previewPath : null,
			});
			notifications.show({ color: "teal", message: t("copyImageSuccess") });
		} catch {
			notifications.show({ color: "red", message: t("copyImageFailed") });
		}
	}, [fsPreviewSupported, imageSrc, previewPath, t]);

	const handleCopyImagePath = useCallback(async () => {
		if (!previewPath) return;
		try {
			await navigator.clipboard.writeText(previewPath);
			notifications.show({ color: "teal", message: t("copyImagePathSuccess") });
		} catch {
			notifications.show({ color: "red", message: t("copyImagePathFailed") });
		}
	}, [previewPath, t]);

	const handleSaveImageAs = useCallback(() => {
		if (!imageSrc) return;
		try {
			downloadUrl(imageSrc, generatedImageFilename(block));
		} catch {
			notifications.show({ color: "red", message: t("saveImageFailed") });
		}
	}, [block, imageSrc, t]);

	const handleOpenViewer = useCallback(() => {
		if (!hasImage || !imageSrc) return;
		openImageViewer({
			src: imageSrc,
			savedPath: fsPreviewSupported ? previewPath : null,
			filename: generatedImageFilename(block),
			alt: block.revisedPrompt ?? "Generated image",
		});
	}, [block, fsPreviewSupported, hasImage, imageSrc, openImageViewer, previewPath]);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (isMobile || !interactive || !hasMenuActions) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 220);
			const flipY = e.clientY > window.innerHeight - 300;
			setCtxMenuPos({ x, y: e.clientY, flipY });
			setCtxMenuOpened(true);
		},
		[hasMenuActions, isMobile, interactive],
	);

	const closeMenu = useCallback(() => setCtxMenuOpened(false), []);

	return (
		<>
			<Paper withBorder radius="sm" p="xs" onContextMenu={handleContextMenu}>
				<Group
					gap={6}
					wrap="nowrap"
					align="center"
					mb={hasImage || shouldReserveImageFrame ? "xs" : 0}
				>
					<ThemeIcon size={18} variant="light" color="violet" radius="sm">
						<IconPhoto size={12} />
					</ThemeIcon>
					{isGenerating && <Loader size={12} color="violet" type="dots" />}
					<Text size="xs" c="dimmed">
						{isGenerating
							? block.status === "generating"
								? t("imageGenerating")
								: t("imageGenerationPreparing")
							: t("imageGenerated")}
						{block.revisedPrompt && (
							<Text span fw={500} c="violet" ml={4}>
								{block.revisedPrompt}
							</Text>
						)}
					</Text>
				</Group>
				{imageMetrics && shouldReserveImageFrame ? (
					<Box style={imageFrameStyle}>
						{hasImage ? (
							<Image
								src={imageSrc}
								alt={block.revisedPrompt ?? "Generated image"}
								radius="sm"
								w="100%"
								h="100%"
								fit="contain"
								style={{ display: "block", cursor: "pointer" }}
								onClick={handleOpenViewer}
							/>
						) : imageUnavailable ? (
							<Text size="xs" c="dimmed">
								{savedPathPreviewUnavailable
									? (fsCapability.preview.reason ?? t("filePreview_unsupported"))
									: (loadErrorMessage ??
										t("imageLoadFailed", { defaultValue: "Failed to load image" }))}
							</Text>
						) : (
							<Skeleton h="100%" w="100%" radius="sm" />
						)}
					</Box>
				) : hasImage ? (
					<Image
						src={imageSrc}
						alt={block.revisedPrompt ?? "Generated image"}
						radius="sm"
						maw={512}
						fit="contain"
						style={{ cursor: "pointer" }}
						onClick={handleOpenViewer}
					/>
				) : null}
			</Paper>
			{ctxMenuOpened && (
				<Menu
					opened={ctxMenuOpened}
					onChange={setCtxMenuOpened}
					position="bottom-start"
					withinPortal
					transitionProps={FIXED_MENU_TRANSITION_PROPS}
					styles={{
						dropdown: {
							position: "fixed",
							left: ctxMenuPos.x,
							...(ctxMenuPos.flipY
								? { bottom: window.innerHeight - ctxMenuPos.y, top: "auto" }
								: { top: ctxMenuPos.y }),
						},
					}}
				>
					<Menu.Target>
						<div
							style={{
								position: "fixed",
								left: ctxMenuPos.x,
								top: ctxMenuPos.y,
								pointerEvents: "none",
							}}
						/>
					</Menu.Target>
					<Menu.Dropdown>
						{canCopyImage && (
							<Menu.Item
								leftSection={<IconPhoto size={14} />}
								onClick={() => {
									void handleCopyImage();
									closeMenu();
								}}
							>
								{t("contextMenu_copyImage")}
							</Menu.Item>
						)}
						{canCopyImagePath && (
							<Menu.Item
								leftSection={<IconCopy size={14} />}
								onClick={() => {
									void handleCopyImagePath();
									closeMenu();
								}}
							>
								{t("contextMenu_copyImagePath")}
							</Menu.Item>
						)}
						{canSaveImage && (
							<Menu.Item
								leftSection={<IconDownload size={14} />}
								onClick={() => {
									void handleSaveImageAs();
									closeMenu();
								}}
							>
								{t("contextMenu_saveImageAs")}
							</Menu.Item>
						)}
						{(canCopyImage || canCopyImagePath || canSaveImage) &&
							(msgCtx.onRollbackToBlock ||
								msgCtx.onForkFromMessage ||
								msgCtx.onAskInPassing ||
								msgCtx.onCompactBeforeMessage ||
								msgCtx.onDeleteBlock) && <Menu.Divider />}
						{msgCtx.onRollbackToBlock && blockIndex != null && (
							<Menu.Item
								leftSection={<IconArrowBackUp size={14} />}
								onClick={() => {
									msgCtx.onRollbackToBlock?.(blockIndex);
									closeMenu();
								}}
							>
								{t("contextMenu_rollback")}
							</Menu.Item>
						)}
						{msgCtx.onForkFromMessage && (
							<Menu.Item
								leftSection={<IconGitFork size={14} />}
								onClick={() => {
									msgCtx.onForkFromMessage?.();
									closeMenu();
								}}
							>
								{t("contextMenu_fork")}
							</Menu.Item>
						)}
						{msgCtx.onAskInPassing && (
							<Menu.Item
								leftSection={<IconMessageQuestion size={14} />}
								onClick={() => {
									msgCtx.onAskInPassing?.();
									closeMenu();
								}}
							>
								{t("contextMenu_askInPassing")}
							</Menu.Item>
						)}
						{msgCtx.onCompactBeforeMessage && (
							<CompactMenuSub
								onCompact={msgCtx.onCompactBeforeMessage}
								onClearContext={msgCtx.onClearContextBefore}
								onManualSummarize={msgCtx.onManualSummarize}
								onClose={closeMenu}
							/>
						)}
						{msgCtx.onDeleteBlock && blockIndex != null && (
							<Menu.Item
								color="red"
								leftSection={<IconTrash size={14} />}
								onClick={() => {
									msgCtx.onDeleteBlock?.(blockIndex);
									closeMenu();
								}}
							>
								{t("contextMenu_delete")}
							</Menu.Item>
						)}
					</Menu.Dropdown>
				</Menu>
			)}
		</>
	);
}

/**
 * Lightweight wrapper that provides a right-click context menu (with rollback,
 * fork, compact, delete, etc.) for block types that don't have their own menu
 * (e.g. ImageBlock, TextFileBlock).
 */
function BlockMenuWrapper({
	blockIndex,
	children,
}: {
	blockIndex?: number;
	children: React.ReactNode;
}) {
	const msgCtx = useMessageContextMenu();
	const interactive = useRenderInteractive();
	const { t } = useTranslation("narrator");
	const [ctxMenuOpened, setCtxMenuOpened] = useState(false);
	const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0, flipY: false });
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

	const hasActions = !!(
		msgCtx.onRollbackToBlock ||
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		msgCtx.onDeleteBlock
	);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (isMobile || !hasActions) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 200);
			const flipY = e.clientY > window.innerHeight - 300;
			setCtxMenuPos({ x, y: e.clientY, flipY });
			setCtxMenuOpened(true);
		},
		[isMobile, hasActions],
	);

	if (!hasActions || !interactive) return <>{children}</>;

	return (
		<>
			<Box onContextMenu={handleContextMenu}>{children}</Box>
			{ctxMenuOpened && (
				<Menu
					opened={ctxMenuOpened}
					onChange={setCtxMenuOpened}
					position="bottom-start"
					withinPortal
					transitionProps={FIXED_MENU_TRANSITION_PROPS}
					styles={{
						dropdown: {
							position: "fixed",
							left: ctxMenuPos.x,
							...(ctxMenuPos.flipY
								? { bottom: window.innerHeight - ctxMenuPos.y, top: "auto" }
								: { top: ctxMenuPos.y }),
						},
					}}
				>
					<Menu.Target>
						<div
							style={{
								position: "fixed",
								left: ctxMenuPos.x,
								top: ctxMenuPos.y,
								pointerEvents: "none",
							}}
						/>
					</Menu.Target>
					<Menu.Dropdown>
						{msgCtx.onRollbackToBlock && blockIndex != null && (
							<Menu.Item
								leftSection={<IconArrowBackUp size={14} />}
								onClick={() => msgCtx.onRollbackToBlock?.(blockIndex)}
							>
								{t("contextMenu_rollback")}
							</Menu.Item>
						)}
						{msgCtx.onForkFromMessage && (
							<Menu.Item
								leftSection={<IconGitFork size={14} />}
								onClick={() => msgCtx.onForkFromMessage?.()}
							>
								{t("contextMenu_fork")}
							</Menu.Item>
						)}
						{msgCtx.onAskInPassing && (
							<Menu.Item
								leftSection={<IconMessageQuestion size={14} />}
								onClick={() => msgCtx.onAskInPassing?.()}
							>
								{t("contextMenu_askInPassing")}
							</Menu.Item>
						)}
						{msgCtx.onCompactBeforeMessage && (
							<CompactMenuSub
								onCompact={msgCtx.onCompactBeforeMessage}
								onClearContext={msgCtx.onClearContextBefore}
								onManualSummarize={msgCtx.onManualSummarize}
								onClose={() => setCtxMenuOpened(false)}
							/>
						)}
						{msgCtx.onDeleteBlock && blockIndex != null && (
							<Menu.Item
								color="red"
								leftSection={<IconTrash size={14} />}
								onClick={() => msgCtx.onDeleteBlock?.(blockIndex)}
							>
								{t("contextMenu_delete")}
							</Menu.Item>
						)}
					</Menu.Dropdown>
				</Menu>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// SelectableSystemNotice — wraps a simple system-notice card (info /
// spec_continuation) to give it the same affordances as content blocks:
// right-click context menu (delete / rollback / fork / ask / compact),
// single-select (Ctrl/Cmd+Click), range-select (Shift+Click) and mobile swipe.
// Modeled on WebSearchBlock; it only renders the menu/selection chrome and
// leaves the visual card to `children`.
// ---------------------------------------------------------------------------
let nextSnInstanceId = 0;
function SelectableSystemNotice({
	blockIndex,
	messageId,
	children,
}: {
	blockIndex?: number;
	messageId?: string;
	children: React.ReactNode;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const msgCtx = useMessageContextMenu();
	const interactive = useRenderInteractive();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

	const snInstanceId = useRef(nextSnInstanceId++);
	const blockIdStr =
		messageId && blockIndex != null
			? makeMessageBlockSelectionId(messageId, blockIndex)
			: `sn-${snInstanceId.current}`;
	const rootRef = useRef<HTMLDivElement>(null);
	const selection = useMessageSelection();

	const isSelected = !!(selection.selectionMode && selection.selectedBlockIds.has(blockIdStr));

	const handleDeselect = useCallback(() => {
		selection.deselectBlock(blockIdStr);
	}, [selection.deselectBlock, blockIdStr]);

	const swipe = useSwipeMenu({
		enabled: true,
		externalBoxRef: rootRef,
		excludeSelectors: [".mantine-Menu-dropdown"],
		blockId: blockIdStr,
		onSwipeRight: isSelected ? handleDeselect : undefined,
	});

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (isMobile) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 200);
			const flipY = e.clientY > window.innerHeight - 300;
			swipe.setCtxMenuPos({ x, y: e.clientY, flipY });
			swipe.setCtxMenuOpened(true);
		},
		[isMobile, swipe],
	);

	const handleBlockClick = useCallback(
		(e: React.MouseEvent) => {
			if (isMobile) return;
			const isModKey = e.metaKey || e.ctrlKey;
			const isShift = e.shiftKey;
			if (!isModKey && !isShift) return;
			if (shouldIgnoreMessageBlockSelection(e.target)) return;
			if (!selection.selectionMode) {
				const sel = window.getSelection();
				if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			}
			e.preventDefault();
			if (isShift) {
				window.getSelection()?.removeAllRanges();
				selection.rangeSelectTo(blockIdStr);
			} else {
				selection.toggleBlock(blockIdStr);
			}
		},
		[isMobile, blockIdStr, selection],
	);

	const SWIPE_REVEAL_WIDTH = 180;

	const hasMenuActions = !!(
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		msgCtx.onRollbackToBlock ||
		msgCtx.onDeleteBlock
	);

	const menuItemsNode = (
		<>
			{hasMenuActions && (
				<>
					{msgCtx.onRollbackToBlock && blockIndex != null && (
						<Menu.Item
							leftSection={<IconArrowBackUp size={14} />}
							onClick={() => {
								msgCtx.onRollbackToBlock?.(blockIndex);
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_rollback")}
						</Menu.Item>
					)}
					{msgCtx.onForkFromMessage && (
						<Menu.Item
							leftSection={<IconGitFork size={14} />}
							onClick={() => {
								msgCtx.onForkFromMessage?.();
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_fork")}
						</Menu.Item>
					)}
					{msgCtx.onAskInPassing && (
						<Menu.Item
							leftSection={<IconMessageQuestion size={14} />}
							onClick={() => {
								msgCtx.onAskInPassing?.();
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_askInPassing")}
						</Menu.Item>
					)}
					{msgCtx.onCompactBeforeMessage && (
						<CompactMenuSub
							onCompact={msgCtx.onCompactBeforeMessage}
							onClearContext={msgCtx.onClearContextBefore}
							onManualSummarize={msgCtx.onManualSummarize}
							onClose={() => swipe.closeSwipe()}
						/>
					)}
					{msgCtx.onDeleteBlock && blockIndex != null && (
						<Menu.Item
							color="red"
							leftSection={<IconTrash size={14} />}
							onClick={() => {
								msgCtx.onDeleteBlock?.(blockIndex);
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_delete")}
						</Menu.Item>
					)}
				</>
			)}
			<Menu.Divider />
			<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
				{tc("cancel")}
			</Menu.Item>
		</>
	);

	const ctxMenu = (
		<Menu
			opened={swipe.ctxMenuOpened}
			onChange={swipe.setCtxMenuOpened}
			position="bottom-start"
			withinPortal
			transitionProps={FIXED_MENU_TRANSITION_PROPS}
			styles={{
				dropdown: {
					position: "fixed",
					left: swipe.ctxMenuPos.x,
					...(swipe.ctxMenuPos.flipY
						? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
						: { top: swipe.ctxMenuPos.y }),
				},
			}}
		>
			<Menu.Target>
				<div
					style={{
						position: "fixed",
						left: swipe.ctxMenuPos.x,
						top: swipe.ctxMenuPos.y,
						pointerEvents: "none",
					}}
				/>
			</Menu.Target>
			<Menu.Dropdown>{menuItemsNode}</Menu.Dropdown>
		</Menu>
	);

	const swipeMenu =
		(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
		(() => {
			const menuEl = swipe.swipeMenuRef.current;
			const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
			return createPortal(
				<Box
					ref={swipe.swipeMenuRef}
					style={{
						position: "fixed",
						left: pos.left,
						top: pos.top,
						transform: "translateY(-50%)",
						zIndex: Z.popover,
						transition: swipe.swipeMenuTransition,
						pointerEvents: swipe.swipeClosing ? "none" : "auto",
						opacity: swipe.swipeClosing ? 0 : 1,
					}}
				>
					<Menu opened withinPortal={false} position="bottom-start">
						<Menu.Dropdown style={{ position: "relative", width: SWIPE_REVEAL_WIDTH }}>
							{menuItemsNode}
						</Menu.Dropdown>
					</Menu>
				</Box>,
				document.body,
			);
		})();

	// Non-interactive surface: render the bare card without interaction chrome.
	if (!interactive) return <>{children}</>;

	return (
		<>
			<Box
				ref={rootRef}
				data-content-block
				{...(blockIdStr ? { [BLOCK_ID_ATTR]: blockIdStr } : {})}
				{...(messageId ? { "data-message-id": messageId } : {})}
				{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
				onContextMenu={handleContextMenu}
				onClick={handleBlockClick}
				style={{
					outline: isSelected ? "2px solid var(--mantine-color-indigo-6)" : undefined,
					outlineOffset: isSelected ? -2 : undefined,
					borderRadius: isSelected ? 4 : undefined,
					transform: swipe.swipeOffset > 0 ? `translateX(-${swipe.swipeOffset}px)` : undefined,
					transition: swipe.swipeTransition,
				}}
			>
				{children}
			</Box>
			{swipeMenu}
			{ctxMenu}
		</>
	);
}

// ---------------------------------------------------------------------------
// SpecForkCarryoverCard — shown when a narrator has a non-empty tasks.json that
// the user may want to review after a context-boundary event. Two variants:
// - "fork": a freshly forked narrator inherited tasks from its parent.
// - "contextCleared": the narrator's context was cleared but tasks.json (a
//   separate Dynamic Spec namespace) was left intact.
// In both cases the narrator has an independent Dynamic Spec namespace, so
// clearing tasks or resetting the spec here never touches any other narrator.
// Rendered as a UI-only `disp` message (never in model history).
// ---------------------------------------------------------------------------
function SpecForkCarryoverCard({
	narratorId,
	messageId,
	total,
	open,
	protectedOpen,
	variant = "fork",
}: {
	narratorId?: string;
	messageId?: string;
	total: number;
	open: number;
	protectedOpen: number;
	variant?: "fork" | "contextCleared";
}) {
	const { t } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();
	const [busy, setBusy] = useState<null | "clear" | "reset">(null);

	const invalidateSpec = useCallback(() => {
		if (!narratorId) return;
		qc.invalidateQueries({ queryKey: ["narrators", narratorId, "spec"] });
	}, [qc, narratorId]);

	const dismissCard = useCallback(async () => {
		if (!narratorId || !messageId) return;
		const result = await api.dismissSpecCarryoverMessage(narratorId, messageId);
		removeMessagesFromCache(qc, narratorId, result.deletedMessageIds ?? [messageId]);
	}, [messageId, narratorId, qc]);

	const handleClear = useCallback(async () => {
		if (!narratorId || busy) return;
		setBusy("clear");
		try {
			await api.clearSpecTasks(narratorId);
			await dismissCard();
			invalidateSpec();
			notifications.show({ message: t("specForkClearedToast"), color: "green", autoClose: 2000 });
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			setBusy(null);
		}
	}, [narratorId, busy, dismissCard, invalidateSpec, t]);

	const handleReset = useCallback(async () => {
		if (!narratorId || busy) return;
		const ok = await confirm({
			title: t("specForkResetConfirmTitle"),
			message: t("specForkResetConfirmMessage"),
			confirmLabel: t("specForkResetSpec"),
			confirmColor: "red",
		});
		if (!ok) return;
		setBusy("reset");
		try {
			await api.resetSpec(narratorId);
			await dismissCard();
			invalidateSpec();
			notifications.show({ message: t("specForkResetToast"), color: "green", autoClose: 2000 });
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			setBusy(null);
		}
	}, [narratorId, busy, confirm, dismissCard, invalidateSpec, t]);

	return (
		<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}>
			<Stack gap={6}>
				<Group gap="xs" wrap="nowrap">
					<Badge
						size="xs"
						color="indigo"
						variant="light"
						leftSection={
							variant === "contextCleared" ? <IconEraser size={10} /> : <IconGitFork size={10} />
						}
					>
						{variant === "contextCleared"
							? t("specClearedCarryoverTitle")
							: t("specForkCarryoverTitle")}
					</Badge>
					<Text size="xs" c="indigo" style={{ flex: 1 }}>
						{variant === "contextCleared"
							? t("specClearedCarryoverDesc", { count: total, open, protectedOpen })
							: t("specForkCarryoverDesc", { count: total, open, protectedOpen })}
					</Text>
				</Group>
				<Group gap={6} wrap="wrap">
					<Button
						size="compact-xs"
						variant="subtle"
						color="indigo"
						leftSection={<IconListCheck size={12} />}
						// Bubbles a DOM CustomEvent caught by the NarratorPanel viewport listener
						// (see NarratorPanel "spec-open-tasks"), which opens the Spec task board.
						// This decoupling avoids threading an onOpenTasks callback through every
						// message-render layer. NOTE: the button only works while rendered inside
						// that viewport; if this card is ever reused outside NarratorPanel, wire an
						// explicit handler instead of relying on the ambient listener.
						onClick={(e) => {
							e.currentTarget.dispatchEvent(new CustomEvent("spec-open-tasks", { bubbles: true }));
						}}
					>
						{t("specGoalViewTasks")}
					</Button>
					<Button
						size="compact-xs"
						variant="light"
						color="orange"
						leftSection={<IconTrash size={12} />}
						loading={busy === "clear"}
						disabled={!narratorId || !messageId || busy !== null}
						onClick={handleClear}
					>
						{t("specForkClearTasks")}
					</Button>
					<Button
						size="compact-xs"
						variant="light"
						color="red"
						leftSection={<IconRestore size={12} />}
						loading={busy === "reset"}
						disabled={!narratorId || !messageId || busy !== null}
						onClick={handleReset}
					>
						{t("specForkResetSpec")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function ImageBlock({ block, imageNarratorId }: { block: any; imageNarratorId?: string }) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const uploadCapability = useUploadCapability();
	const narratorImageServing = uploadCapability.serveNarratorImages;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const uploadNarratorId =
		typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : imageNarratorId;

	useEffect(() => {
		if (block.previewUrl || !narratorImageServing.supported || !uploadNarratorId || !block.imageId)
			return;

		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;

		let cancelled = false;
		let objectUrl: string | null = null;
		fetch(`/api/uploads/${uploadNarratorId}/${block.imageId}`, { headers })
			.then(async (res) => {
				absorbRenewedToken(res, token);
				if (!res.ok) {
					await clearTokenOnSessionFailure(res);
					return null;
				}
				return res.blob();
			})
			.then((blob) => {
				if (blob && !cancelled && blob.size <= MAX_MESSAGE_IMAGE_PREVIEW_BLOB_BYTES) {
					objectUrl = URL.createObjectURL(blob);
					setBlobUrl(objectUrl);
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [uploadNarratorId, block.imageId, block.previewUrl, narratorImageServing.supported]);

	const src = block.previewUrl ?? blobUrl;

	// Intrinsic pixel size persisted at upload time (server parses the header).
	// With it the box follows the picture's real aspect ratio — a wide banner is
	// short, a tall capture is capped — instead of everything occupying a fixed
	// 200px band. Blocks persisted before dimensions were recorded keep the
	// legacy fixed-height rendering below.
	const imageDims =
		typeof block.width === "number" &&
		Number.isFinite(block.width) &&
		block.width > 0 &&
		typeof block.height === "number" &&
		Number.isFinite(block.height) &&
		block.height > 0
			? { width: block.width, height: block.height }
			: null;

	if (!src && !narratorImageServing.supported) {
		return (
			<Paper p="sm" radius="sm" withBorder>
				<Text size="sm" c="dimmed">
					{narratorImageServing.reason ?? t("imagePreviewUnsupported")}
				</Text>
			</Paper>
		);
	}

	if (!src) {
		if (imageDims) {
			// Same box the loaded image will occupy (width-capped by the column,
			// height-capped by MAX height via the pre-computed width bound), so the
			// swap from skeleton to picture does not shift anything.
			const skeletonWidth = Math.min(
				imageDims.width,
				Math.round((CHAT_IMAGE_MAX_HEIGHT * imageDims.width) / imageDims.height),
			);
			return (
				<Box
					w={`min(100%, ${skeletonWidth}px)`}
					style={{ aspectRatio: `${imageDims.width} / ${imageDims.height}`, margin: "0 auto" }}
				>
					<Skeleton w="100%" h="100%" radius="sm" />
				</Box>
			);
		}
		return <Skeleton h={200} w={300} radius="sm" />;
	}
	if (imageDims) {
		return (
			<Box
				style={{
					maxWidth: "100%",
					width: "fit-content",
					borderRadius: "var(--mantine-radius-sm)",
					overflow: "hidden",
					margin: "0 auto",
				}}
			>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: opens the shared fullscreen viewer (keys handled there) */}
				<img
					src={src}
					alt={block.filename ?? "image"}
					style={{
						display: "block",
						maxWidth: "100%",
						maxHeight: CHAT_IMAGE_MAX_HEIGHT,
						width: "auto",
						height: "auto",
						objectFit: "contain",
						borderRadius: "var(--mantine-radius-sm)",
						cursor: "pointer",
					}}
					loading="lazy"
					onClick={() => openImageViewer({ src, filename: block.filename, alt: block.filename })}
				/>
			</Box>
		);
	}
	return (
		<Box
			style={{
				maxWidth: "100%",
				width: "fit-content",
				height: 200,
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
				margin: "0 auto",
			}}
		>
			<Image
				src={src}
				alt={block.filename ?? "image"}
				radius="sm"
				h={200}
				w="auto"
				fit="contain"
				loading="lazy"
				style={{ cursor: "pointer", maxWidth: "100%" }}
				onClick={() => openImageViewer({ src, filename: block.filename, alt: block.filename })}
			/>
		</Box>
	);
}

function TextFileBlock({
	block,
	onOpen,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
	block: any;
	/** Open this attachment in a read-only file panel; absent → not clickable. */
	onOpen?: (filePath: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const filePath = typeof block.filePath === "string" ? block.filePath : "";
	const row = (
		<Group gap={6} py={2} wrap="nowrap">
			<ThemeIcon size="sm" variant="light" color="gray">
				<IconFile size={14} />
			</ThemeIcon>
			<Text size="sm" fw={500} style={{ minWidth: 0 }}>
				{block.filename}
			</Text>
			{/* The size must absorb none of the squeeze: with the default shrink a long
			    filename compresses this box until "(1.5 KB)" wraps mid-value. Shrink is
			    pushed entirely onto the filename, which wraps readably instead. */}
			<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
				({formatFileSize(block.size)})
			</Text>
			{filePath && onOpen ? <IconExternalLink size={12} opacity={0.6} /> : null}
		</Group>
	);

	if (!filePath || !onOpen) return row;
	return (
		<Tooltip label={t("contextMenu_openFilePanel")} openDelay={400} withinPortal>
			<UnstyledButton
				onClick={() => onOpen(filePath)}
				style={{ borderRadius: "var(--mantine-radius-sm)", width: "fit-content" }}
			>
				{row}
			</UnstyledButton>
		</Tooltip>
	);
}

export const ReasoningBlock = memo(
	function ReasoningBlock({
		blocks,
		blockIndices,
		isLastContent = true,
		streaming,
		narratorId,
		messageId,
	}: {
		// One or more adjacent reasoning/thinking blocks merged into a single
		// trace. gpt-5.6 interleaved reasoning emits several adjacent blocks.
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON blocks
		blocks: any[];
		/** Original block indices of `blocks`, aligned by position. */
		blockIndices: number[];
		/** True when this is the message's latest visible reasoning run (gates shimmer). */
		isLastContent?: boolean;
		streaming?: boolean;
		narratorId?: string;
		messageId?: string;
	}) {
		const { t } = useTranslation("narrator");
		const { t: tc } = useTranslation("common");
		const [expandReasoning] = useLocalPref("narrafork_expand_reasoning");

		// The first block is the stable visual/selection anchor. Destructive actions
		// use the whole run: rollback keeps its final block, while deletion proceeds
		// from the highest index down so earlier indices never shift underneath us.
		const runActionIndices = useMemo(
			() => resolveReasoningRunActionIndices(blockIndices),
			[blockIndices],
		);
		const blockIndex = runActionIndices.anchorIndex;
		const rollbackBlockIndex = runActionIndices.rollbackIndex;
		const deleteBlockIndices = runActionIndices.deleteIndices;

		// Build a stable persistence key from narratorId + blockIndex.
		// This key survives component remounts (streaming → real message transition).
		const persistKey =
			narratorId != null && blockIndex != null ? `${narratorId}:${blockIndex}` : undefined;

		// Initialize from persisted state (if user toggled before remount) or global pref.
		const persistedState = persistKey != null ? getReasoningExpandState(persistKey) : undefined;
		const [opened, setOpened] = useState(
			persistedState !== undefined ? persistedState : expandReasoning,
		);

		// Track whether this instance has ever been toggled by the user.
		// On the very first render with opened=true, we bypass LazyCollapse
		// and render Mantine's Collapse directly — this avoids the LazyCollapse
		// effect cascade (setMounted → rAF → setReveal) that causes "Maximum
		// update depth exceeded" when many ReasoningBlock instances mount
		// simultaneously (e.g. loading a long conversation with expand=true).
		const hasToggled = useRef(persistedState !== undefined);

		// Merge the adjacent reasoning blocks' text with a blank-line separator
		// so the segment parser treats each block as its own part(s).
		const rawText: string = useMemo(
			() =>
				blocks
					.map((b) => b.text || b.thinking || "")
					.filter((s) => s.length > 0)
					.join("\n\n"),
			[blocks],
		);
		// Offer translation only when every text-bearing block is translated,
		// keeping the merged original / translated views aligned.
		const translatedText: string | undefined = useMemo(() => {
			const textBearing = blocks.filter((b) => (b.text || b.thinking || "").length > 0);
			if (textBearing.length === 0) return undefined;
			if (!textBearing.every((b) => typeof b.translatedText === "string" && b.translatedText))
				return undefined;
			return textBearing.map((b) => b.translatedText as string).join("\n\n");
		}, [blocks]);
		const encryptedPlaceholder = t("reasoningEncryptedPlaceholder");
		const encryptionState = useMemo(() => getReasoningEncryptionState(blocks), [blocks]);
		const hasEncryptedReasoning = encryptionState === "only";
		const hasPartiallyEncryptedReasoning = encryptionState === "partial";
		const text = rawText || (hasEncryptedReasoning ? encryptedPlaceholder : "");
		const [showTranslation, setShowTranslation] = useState(!!translatedText);
		const prevTranslatedRef = useRef(translatedText);
		// Auto-switch to translation when it arrives via WS update
		useEffect(() => {
			if (translatedText && !prevTranslatedRef.current) {
				setShowTranslation(true);
			}
			prevTranslatedRef.current = translatedText;
		}, [translatedText]);
		const displayText = showTranslation && translatedText ? translatedText : text;

		// Parse codex/gpt-5.6-style reasoning ("**Title**" + "<!-- -->" parts)
		// into titled steps. When at least one title is present we render a
		// compact step trace instead of the single collapsible block below.
		const segments = useMemo(
			() => (hasEncryptedReasoning ? [] : parseReasoningSegments(displayText)),
			[displayText, hasEncryptedReasoning],
		);
		const structured = useMemo(() => hasStructuredReasoning(segments), [segments]);

		// Render LOD layering. Streaming reasoning is always shown in full (live
		// feedback); completed reasoning compresses by level:
		//   L5/L4/L3 → structured: a step trace whose steps expand on click;
		//              non-structured: header only (body collapsed / per user pref).
		//   L2/L1    → a single "🧠 reasoning ×N" count line (click to expand).
		//
		// A structured trace is shape-identical at L3..L5 on purpose: a level that
		// showed step titles whose bodies could not be opened gave the reader a list
		// of promises.
		const renderLod = useRenderLod();
		const [lodReasoningOverride, setLodReasoningOverride] = useState(false);
		// Reset on level change via compare-during-render (lint-clean, synchronous).
		const [prevRenderLod, setPrevRenderLod] = useState(renderLod);
		if (prevRenderLod !== renderLod) {
			setPrevRenderLod(renderLod);
			setLodReasoningOverride(false);
		}
		const reasoningStepCount = structured ? segments.length : blocks.length;
		const showReasoningCountLine = !streaming && renderLod <= 2 && !lodReasoningOverride;
		// A NON-structured run has no step titles to show, so the collapsing level
		// leaves only its header. Structured runs are unaffected: their trace shows
		// the titles and each step opens on its own (see the note above).
		const reasoningCollapsedByLod = !streaming && renderLod === 3;

		// --- Block ID, selection, swipe & context menu state ---
		const rbInstanceId = useRef(nextRbInstanceId++);
		const blockIdStr =
			messageId && blockIndex != null
				? makeMessageBlockSelectionId(messageId, blockIndex)
				: `rb-${rbInstanceId.current}`;
		const rootRef = useRef<HTMLDivElement>(null);
		const selection = useMessageSelection();
		const msgCtx = useMessageContextMenu();
		const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

		const isSelected = !!(selection.selectionMode && selection.selectedBlockIds.has(blockIdStr));

		const handleDeselect = useCallback(() => {
			selection.deselectBlock(blockIdStr);
		}, [selection.deselectBlock, blockIdStr]);

		const swipe = useSwipeMenu({
			enabled: true,
			externalBoxRef: rootRef,
			excludeSelectors: [".mantine-Menu-dropdown"],
			blockId: blockIdStr,
			onSwipeRight: isSelected ? handleDeselect : undefined,
		});

		// Desktop: right-click opens context menu
		const handleContextMenu = useCallback(
			(e: React.MouseEvent) => {
				if (isMobile) return;
				const sel = window.getSelection();
				if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
				e.preventDefault();
				e.stopPropagation();
				const x = Math.min(e.clientX, window.innerWidth - 200);
				const flipY = e.clientY > window.innerHeight - 300;
				swipe.setCtxMenuPos({ x, y: e.clientY, flipY });
				swipe.setCtxMenuOpened(true);
			},
			[isMobile, swipe],
		);

		// Desktop: Ctrl/Cmd+Click toggles block, Shift+Click range-selects
		const handleBlockClick = useCallback(
			(e: React.MouseEvent) => {
				if (isMobile) return;
				const isModKey = e.metaKey || e.ctrlKey;
				const isShift = e.shiftKey;
				if (!isModKey && !isShift) return;
				if (shouldIgnoreMessageBlockSelection(e.target)) return;
				// Don't interfere with text selection — but when block selection
				// is already active, Shift+Click should always do range-select.
				if (!selection.selectionMode) {
					const sel = window.getSelection();
					if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
				}
				e.preventDefault();
				if (isShift) {
					window.getSelection()?.removeAllRanges();
					selection.rangeSelectTo(blockIdStr);
				} else {
					selection.toggleBlock(blockIdStr);
				}
			},
			[isMobile, blockIdStr, selection],
		);

		const handleToggle = () => {
			// Under a collapsing level (a non-structured run at L3), an explicit tap is
			// an override, not a change to the persisted preference — otherwise the
			// level would just re-collapse the body on the next render.
			if (reasoningCollapsedByLod) {
				setLodReasoningOverride((v) => !v);
				return;
			}
			hasToggled.current = true;
			setOpened((v) => {
				const next = !v;
				// Persist to module-level map so the state survives component remounts
				// (e.g. when streaming __streaming__ message is replaced by real message).
				if (persistKey) setReasoningExpandState(persistKey, next);
				return next;
			});
		};

		const copyText = useCallback(() => {
			const value = hasPartiallyEncryptedReasoning
				? `${displayText}\n\n${encryptedPlaceholder}`
				: displayText;
			navigator.clipboard.writeText(value);
		}, [displayText, encryptedPlaceholder, hasPartiallyEncryptedReasoning]);

		const deleteReasoningRun = useCallback(async () => {
			for (const index of deleteBlockIndices) {
				await msgCtx.onDeleteBlock?.(index);
			}
		}, [deleteBlockIndices, msgCtx.onDeleteBlock]);

		// During streaming with no content yet, show a minimal "thinking" indicator
		if (streaming && !displayText) {
			return (
				<Group
					ref={rootRef}
					gap={0}
					py={2}
					wrap="nowrap"
					align="center"
					data-content-block
					{...(blockIdStr ? { [BLOCK_ID_ATTR]: blockIdStr } : {})}
					{...(messageId ? { "data-message-id": messageId } : {})}
					{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
					{...(blockIndices.length > 1 ? { [BLOCK_INDICES_ATTR]: blockIndices.join(",") } : {})}
					onContextMenu={handleContextMenu}
					onClick={handleBlockClick}
					style={{
						outline: isSelected ? "2px solid var(--mantine-color-indigo-6)" : undefined,
						outlineOffset: isSelected ? -2 : undefined,
						borderRadius: isSelected ? 4 : undefined,
						transform: swipe.swipeOffset > 0 ? `translateX(-${swipe.swipeOffset}px)` : undefined,
						transition: swipe.swipeTransition,
					}}
				>
					<Box
						style={{ display: "flex", alignItems: "center", width: 11, justifyContent: "center" }}
					>
						<IconChevronRight
							size={12}
							style={{ color: "var(--mantine-color-dimmed)", opacity: 0.5 }}
						/>
					</Box>
					<ThemeIcon size={16} variant="light" color="grape" radius="sm">
						<IconBrain size={10} />
					</ThemeIcon>
					<Text size="xs" c="dimmed" fs="italic" ml={4}>
						{t("thinking")}…
					</Text>
				</Group>
			);
		}

		if (!displayText) return null;

		const partialEncryptedNotice = hasPartiallyEncryptedReasoning ? (
			<Group gap={4} mt={2} wrap="nowrap" c="dimmed">
				<IconLock size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
				<Text size="xs" c="dimmed" fs="italic">
					{encryptedPlaceholder}
				</Text>
			</Group>
		) : null;

		const content = (
			<Box
				pl="md"
				py={4}
				style={{
					borderLeft: "2px solid var(--mantine-color-grape-9)",
					opacity: 0.75,
					fontSize: "var(--mantine-font-size-xs)",
				}}
			>
				<MarkdownContent text={displayText} streaming={streaming} />
				{partialEncryptedNotice}
				{translatedText && rawText && (
					<Group
						gap={4}
						mt={4}
						style={{ cursor: "pointer", display: "inline-flex" }}
						onClick={(e) => {
							e.stopPropagation();
							setShowTranslation((v) => !v);
						}}
					>
						<IconLanguage size={12} style={{ opacity: 0.5 }} />
						<Text size="xs" c="dimmed">
							{showTranslation ? t("showOriginal") : t("showTranslated")}
						</Text>
					</Group>
				)}
			</Box>
		);

		const SWIPE_REVEAL_WIDTH = 180;

		// Menu items shared between context menu (desktop) and swipe menu (mobile)
		const hasMenuActions = !!(
			msgCtx.onForkFromMessage ||
			msgCtx.onAskInPassing ||
			msgCtx.onCompactBeforeMessage ||
			msgCtx.onRollbackToBlock ||
			msgCtx.onDeleteBlock
		);
		const menuItemsNode = (
			<>
				<Menu.Item
					leftSection={<IconCopy size={14} />}
					onClick={() => {
						copyText();
						swipe.closeSwipe();
					}}
				>
					{tc("copy")}
				</Menu.Item>
				{hasMenuActions && <Menu.Divider />}
				{msgCtx.onRollbackToBlock && rollbackBlockIndex != null && (
					<Menu.Item
						leftSection={<IconArrowBackUp size={14} />}
						onClick={() => {
							msgCtx.onRollbackToBlock?.(rollbackBlockIndex);
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_rollback")}
					</Menu.Item>
				)}
				{msgCtx.onForkFromMessage && (
					<Menu.Item
						leftSection={<IconGitFork size={14} />}
						onClick={() => {
							msgCtx.onForkFromMessage?.();
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_fork")}
					</Menu.Item>
				)}
				{msgCtx.onAskInPassing && (
					<Menu.Item
						leftSection={<IconMessageQuestion size={14} />}
						onClick={() => {
							msgCtx.onAskInPassing?.();
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_askInPassing")}
					</Menu.Item>
				)}
				{msgCtx.onCompactBeforeMessage && (
					<CompactMenuSub
						onCompact={msgCtx.onCompactBeforeMessage}
						onClearContext={msgCtx.onClearContextBefore}
						onManualSummarize={msgCtx.onManualSummarize}
						onClose={() => swipe.closeSwipe()}
					/>
				)}
				{msgCtx.onDeleteBlock && deleteBlockIndices.length > 0 && (
					<Menu.Item
						color="red"
						leftSection={<IconTrash size={14} />}
						onClick={() => {
							swipe.closeSwipe();
							void deleteReasoningRun();
						}}
					>
						{t("contextMenu_delete")}
					</Menu.Item>
				)}
				<Menu.Divider />
				<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
					{tc("cancel")}
				</Menu.Item>
			</>
		);

		// Right-click context menu (desktop)
		const ctxMenu = (
			<Menu
				opened={swipe.ctxMenuOpened}
				onChange={swipe.setCtxMenuOpened}
				position="bottom-start"
				withinPortal
				transitionProps={FIXED_MENU_TRANSITION_PROPS}
				styles={{
					dropdown: {
						position: "fixed",
						left: swipe.ctxMenuPos.x,
						...(swipe.ctxMenuPos.flipY
							? { bottom: window.innerHeight - swipe.ctxMenuPos.y, top: "auto" }
							: { top: swipe.ctxMenuPos.y }),
					},
				}}
			>
				<Menu.Target>
					<div
						style={{
							position: "fixed",
							left: swipe.ctxMenuPos.x,
							top: swipe.ctxMenuPos.y,
							pointerEvents: "none",
						}}
					/>
				</Menu.Target>
				<Menu.Dropdown>{menuItemsNode}</Menu.Dropdown>
			</Menu>
		);

		// Swipe-reveal action menu (mobile, portal to body)
		const swipeMenu =
			(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
			(() => {
				const menuEl = swipe.swipeMenuRef.current;
				const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight);
				return createPortal(
					<Box
						ref={swipe.swipeMenuRef}
						style={{
							position: "fixed",
							left: pos.left,
							top: pos.top,
							transform: "translateY(-50%)",
							zIndex: Z.popover,
							transition: swipe.swipeMenuTransition,
							pointerEvents: swipe.swipeClosing ? "none" : "auto",
							opacity: swipe.swipeClosing ? 0 : 1,
						}}
					>
						<Menu opened withinPortal={false} position="bottom-start">
							<Menu.Dropdown style={{ position: "relative", width: SWIPE_REVEAL_WIDTH }}>
								{menuItemsNode}
							</Menu.Dropdown>
						</Menu>
					</Box>,
					document.body,
				);
			})();

		// Structured (codex/gpt-5.6) reasoning: render a step trace with titles
		// always visible instead of a single collapsible block.
		// Shimmer the latest step only while streaming AND the reasoning run is
		// still the message's last content — once real output follows, stop it.
		const traceStreaming = streaming && isLastContent;
		const structuredInner = structured ? (
			<>
				<ReasoningStepsTrace
					segments={segments}
					streaming={traceStreaming}
					persistKeyBase={persistKey}
				/>
				{partialEncryptedNotice}
				{translatedText && rawText && (
					<Group
						gap={4}
						mt={2}
						ml="lg"
						style={{ cursor: "pointer", display: "inline-flex" }}
						onClick={(e) => {
							e.stopPropagation();
							setShowTranslation((v) => !v);
						}}
					>
						<IconLanguage size={12} style={{ opacity: 0.5 }} />
						<Text size="xs" c="dimmed">
							{showTranslation ? t("showOriginal") : t("showTranslated")}
						</Text>
					</Group>
				)}
			</>
		) : null;

		// Non-structured reasoning: the header/body collapse follows the level —
		// L5/L4 honour the user's `opened` pref, L3 collapses to the header only
		// unless the user explicitly toggles back open (`lodReasoningOverride`).
		const effectiveReasoningOpened = reasoningCollapsedByLod ? lodReasoningOverride : opened;

		return (
			<>
				<Box
					ref={rootRef}
					data-content-block
					{...(blockIdStr ? { [BLOCK_ID_ATTR]: blockIdStr } : {})}
					{...(messageId ? { "data-message-id": messageId } : {})}
					{...(blockIndex != null ? { "data-block-index": String(blockIndex) } : {})}
					{...(blockIndices.length > 1 ? { [BLOCK_INDICES_ATTR]: blockIndices.join(",") } : {})}
					onContextMenu={handleContextMenu}
					onClick={handleBlockClick}
					style={{
						outline: isSelected ? "2px solid var(--mantine-color-indigo-6)" : undefined,
						outlineOffset: isSelected ? -2 : undefined,
						borderRadius: isSelected ? 4 : undefined,
						transform: swipe.swipeOffset > 0 ? `translateX(-${swipe.swipeOffset}px)` : undefined,
						transition: swipe.swipeTransition,
					}}
				>
					{showReasoningCountLine ? (
						<ReasoningCountLine
							steps={reasoningStepCount}
							onExpand={() => setLodReasoningOverride(true)}
						/>
					) : structured ? (
						structuredInner
					) : (
						<>
							<Group
								gap={0}
								py={2}
								wrap="nowrap"
								align="center"
								style={{ cursor: "pointer", userSelect: "none" }}
								onClick={handleToggle}
							>
								<Box
									style={{
										display: "flex",
										alignItems: "center",
										width: 11,
										justifyContent: "center",
									}}
								>
									{effectiveReasoningOpened ? (
										<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
									) : (
										<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
									)}
								</Box>
								<ThemeIcon size={16} variant="light" color="grape" radius="sm">
									<IconBrain size={10} />
								</ThemeIcon>
								<Text size="xs" c="dimmed" ml={4} style={{ flexShrink: 0 }}>
									{t("reasoning")}
								</Text>
								{!hasEncryptedReasoning && (
									<Text size="xs" c="dimmed" ml={6} style={{ flexShrink: 0, opacity: 0.5 }}>
										{t("reasoningChars", { formatted: formatLocaleNumber(displayText.length) })}
									</Text>
								)}
								{!effectiveReasoningOpened && (
									<Text
										size="xs"
										c="dimmed"
										truncate
										style={{ flex: 1, minWidth: 0, opacity: 0.6 }}
									>
										— {displayText.slice(0, 80)}
										{displayText.length > 80 ? "…" : ""}
									</Text>
								)}
							</Group>
							{/*
							Initial mount with opened=true: render Collapse directly to avoid
							LazyCollapse's effect cascade (setMounted → rAF → setReveal) that
							triggers "Maximum update depth exceeded" in Mantine's Transition
							when many instances mount at once.
							After first user toggle: switch to LazyCollapse for proper
							expand/collapse animation with content unmount.
						*/}
							{!hasToggled.current && effectiveReasoningOpened ? (
								<Collapse expanded={effectiveReasoningOpened}>{content}</Collapse>
							) : (
								<LazyCollapse in={effectiveReasoningOpened}>{content}</LazyCollapse>
							)}
						</>
					)}
				</Box>
				{swipeMenu}
				{ctxMenu}
			</>
		);
	},
	(prev, next) => {
		return (
			prev.blocks === next.blocks &&
			prev.blockIndices === next.blockIndices &&
			prev.isLastContent === next.isLastContent &&
			prev.streaming === next.streaming &&
			prev.narratorId === next.narratorId &&
			prev.messageId === next.messageId
		);
	},
);

type MessagesCacheMessage = { id?: string };
type MessagesCachePage = { messages?: MessagesCacheMessage[] } & Record<string, unknown>;
type MessagesCacheData = { pages?: MessagesCachePage[] } & Record<string, unknown>;

/**
 * Prune deleted messages from the paged messages query cache.
 *
 * Exported because the exact vlist's error-notice dismissal needs the same cache
 * pruning (its rows are zero-DOM copies and cannot own this logic themselves) —
 * one implementation keeps both list renderers consistent.
 */
export function removeMessagesFromCache(
	qc: QueryClient,
	narratorId: string,
	deletedMessageIds: string[],
) {
	if (deletedMessageIds.length === 0) return;
	const deletedSet = new Set(deletedMessageIds);
	qc.setQueriesData({ queryKey: ["narrators", narratorId, "messages"] }, (old: unknown) => {
		if (!old || typeof old !== "object") return old;
		const data = old as MessagesCacheData;
		if (!Array.isArray(data.pages)) return old;
		let changed = false;
		const pages = data.pages.map((page) => {
			if (!Array.isArray(page.messages)) return page;
			const messages = page.messages.filter((msg) => !msg.id || !deletedSet.has(msg.id));
			if (messages.length === page.messages.length) return page;
			changed = true;
			return { ...page, messages };
		});
		return changed ? { ...data, pages } : old;
	});
}

// KnowledgeHintNotice — renders the persisted passive knowledge-injection sys
// message (blocks: [{type:"text"}, {type:"knowledge_hint", entries}]). The text
// block is what the model actually received; here we surface a compact, dimmed
// card listing the injected entries with links to their knowledge pages so the
// injection isn't invisible to the user.
function KnowledgeHintNotice({
	entries,
}: {
	entries: Array<{ entryId: string; title?: string; summary?: string }>;
}) {
	const { t } = useTranslation("narrator");
	const navigate = useNavigate();
	if (entries.length === 0) return null;
	return (
		<Paper p="xs" radius="sm" style={{ backgroundColor: SYSTEM_MESSAGE_BG }}>
			<Group gap={6} wrap="nowrap" align="flex-start">
				<IconNotebook
					size={14}
					style={{ flexShrink: 0, marginTop: 2, color: "var(--mantine-color-dimmed)" }}
				/>
				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Text size="xs" c="dimmed" fw={600}>
						{t("knowledgeHintHeading", { count: entries.length })}
					</Text>
					{entries.map((e) => (
						<Tooltip
							key={e.entryId}
							label={e.summary || e.title || e.entryId}
							multiline
							maw={360}
							withinPortal
							openDelay={300}
						>
							<Text
								size="xs"
								c="indigo"
								truncate
								style={{ cursor: "pointer" }}
								onClick={() =>
									navigate({ to: "/knowledge/$entryId", params: { entryId: e.entryId } })
								}
							>
								{e.title || e.entryId}
							</Text>
						</Tooltip>
					))}
				</Stack>
			</Group>
		</Paper>
	);
}

function WorkingDirectoryRecoveryNotice({
	narratorId,
	messageId,
	missingCwd,
	suggestedCwd,
}: {
	narratorId: string;
	messageId: string;
	missingCwd: string;
	suggestedCwd: string;
}) {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const [cwd, setCwd] = useState(suggestedCwd);
	const [error, setError] = useState<string | undefined>();
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		setCwd(suggestedCwd);
		setError(undefined);
	}, [suggestedCwd]);

	const handleContinue = async () => {
		const nextCwd = cwd.trim();
		if (!nextCwd) {
			setError(t("cwdRecoveryRequired"));
			return;
		}

		setSubmitting(true);
		setError(undefined);
		try {
			await api.updateNarratorCwd(narratorId, nextCwd);
			const result = await api.continueNarrator(narratorId, messageId);
			removeMessagesFromCache(queryClient, narratorId, result.deletedMessageIds ?? [messageId]);
			queryClient.invalidateQueries({ queryKey: ["narrators", narratorId] });
			notifications.show({
				message: t("cwdRecoveryContinued"),
				color: "green",
				autoClose: 5000,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : t("cwdRecoveryContinueError"));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Paper p="sm" radius="sm" style={{ backgroundColor: "var(--mantine-color-orange-light)" }}>
			<Stack gap="xs">
				<Group gap={6} wrap="nowrap" align="flex-start">
					<IconAlertTriangle
						size={16}
						style={{ flexShrink: 0, marginTop: 1, color: "var(--mantine-color-orange-7)" }}
					/>
					<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
						<Text size="xs" fw={600} c="orange.9">
							{t("cwdRecoveryTitle")}
						</Text>
						<Text size="xs" c="orange.9" style={{ whiteSpace: "pre-wrap" }}>
							{t("cwdRecoveryDescription")}
						</Text>
					</Stack>
				</Group>
				<Text size="xs" ff="monospace" c="orange.9" style={{ overflowWrap: "anywhere" }}>
					{t("cwdRecoveryMissing", { path: missingCwd })}
				</Text>
				<DirectoryPicker
					value={cwd}
					onChange={(value) => {
						setCwd(value);
						setError(undefined);
					}}
					label={t("cwdRecoveryDirectoryLabel")}
					placeholder={t("cwdRecoveryDirectoryPlaceholder")}
					description={t("cwdRecoveryDirectoryDescription")}
					error={error}
					disabled={submitting}
				/>
				<Group justify="flex-end">
					<Button size="compact-sm" color="orange" loading={submitting} onClick={handleContinue}>
						{t("cwdRecoveryContinue")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}

function ErrorNotice({
	message,
	narratorId,
	messageId,
	onDismiss,
}: {
	message: string;
	narratorId: string;
	messageId: string;
	onDismiss?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [dismissing, setDismissing] = useState(false);
	const [ruleModalOpened, { open: openRuleModal, close: closeRuleModal }] = useDisclosure(false);
	const qc = useQueryClient();

	const handleDismiss = async () => {
		setDismissing(true);
		try {
			const result = await api.dismissErrorMessage(narratorId, messageId);
			removeMessagesFromCache(qc, narratorId, result.deletedMessageIds ?? [messageId]);
			onDismiss?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setDismissing(false);
		}
	};

	return (
		<>
			<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-red-light)" }}>
				<Stack gap={6}>
					<Group gap={6} wrap="nowrap" align="flex-start">
						<IconAlertTriangle
							size={16}
							style={{ flexShrink: 0, marginTop: 1, color: "var(--mantine-color-red-7)" }}
						/>
						<Text
							size="xs"
							c="red.9"
							style={{ whiteSpace: "pre-wrap", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
						>
							{message}
						</Text>
						<NarratorModelTestAction narratorId={narratorId} errorMessage={message} />
						<Tooltip label={t("markRetryable")} withArrow>
							<ActionIcon
								size="xs"
								variant="subtle"
								color="red.7"
								style={{ flexShrink: 0 }}
								onClick={openRuleModal}
							>
								<IconRepeat size={14} />
							</ActionIcon>
						</Tooltip>
						<CloseButton
							size="xs"
							variant="subtle"
							c="red.7"
							style={{ flexShrink: 0 }}
							disabled={dismissing}
							onClick={handleDismiss}
						/>
					</Group>
					{/* Its own row, below the message: a labelled button is the only form
					    a touch user can read (a tooltip never opens for them), and the
					    action strip above has no room for words. */}
					<NarratorImageGenFixAction narratorId={narratorId} errorMessage={message} />
				</Stack>
			</Paper>

			<RetryRuleModal opened={ruleModalOpened} onClose={closeRuleModal} errorMessage={message} />
		</>
	);
}

export function CompactSummaryModal({
	target,
	onClose,
}: {
	target: CompactSummaryModalTarget | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const { visibleModels, summaryModelValue } = useAllModels();
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const [retryModel, setRetryModel] = useState<string | null>(null);
	const sourceTargetKey = target ? `${target.kind}:${target.narratorId}:${target.messageId}` : null;
	const [retryTargetOverride, setRetryTargetOverride] = useState<{
		sourceTargetKey: string;
		messageId: string;
	} | null>(null);
	const pendingRetryMigrationRef = useRef<{
		narratorId: string;
		nextMessageId: string;
		retiredMessageIds: string[];
		onDelete?: () => void;
	} | null>(null);
	const activeTarget =
		target && retryTargetOverride?.sourceTargetKey === sourceTargetKey
			? { ...target, messageId: retryTargetOverride.messageId }
			: target;
	const activeTargetKind = activeTarget?.kind;
	const activeTargetNarratorId = activeTarget?.narratorId;
	const activeTargetMessageId = activeTarget?.messageId;
	const isSegment = activeTargetKind === "segment";
	const queryKey = activeTarget
		? isSegment
			? (["segment-compact-summary", activeTarget.narratorId, activeTarget.messageId] as const)
			: compactSummaryQueryKey(activeTarget.narratorId, activeTarget.messageId)
		: (["compact-summary", "closed"] as const);
	const targetKey = activeTarget
		? `${activeTarget.kind}:${activeTarget.narratorId}:${activeTarget.messageId}`
		: null;
	const activeTargetRef = useRef<CompactSummaryModalTarget | null>(activeTarget);
	activeTargetRef.current = activeTarget;
	const sourceTargetKeyRef = useRef(sourceTargetKey);
	sourceTargetKeyRef.current = sourceTargetKey;

	const applyCompactReplacement = useCallback(
		(event: Record<string, unknown>) => {
			const currentTarget = activeTargetRef.current;
			if (!currentTarget || currentTarget.kind !== "context") return;
			const migration = resolveCompactReplacementEvent(currentTarget.messageId, event);
			if (!migration) return;
			const currentQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				currentTarget.messageId,
			);
			const currentDetail = queryClient.getQueryData<CompactMessageDetail>(currentQueryKey);
			const retiredMessageIds = new Set(migration.retiredMessageIds);
			if (migration.changed) retiredMessageIds.add(currentTarget.messageId);
			for (const retiredMessageId of retiredMessageIds) {
				void queryClient.cancelQueries({
					queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
					exact: true,
				});
				queryClient.removeQueries({
					queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
					exact: true,
				});
			}

			const nextQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				migration.nextMessageId,
			);
			const existingNextDetail = queryClient.getQueryData<CompactMessageDetail>(nextQueryKey);
			if (migration.changed || existingNextDetail?.status !== "compacted") {
				queryClient.setQueryData<CompactMessageDetail>(nextQueryKey, {
					...currentDetail,
					...existingNextDetail,
					status: "compacting",
					summary: existingNextDetail?.summary ?? currentDetail?.summary ?? "",
					error: undefined,
					attempts: existingNextDetail?.attempts ?? currentDetail?.attempts ?? [],
					canRetry: false,
				});
			}

			if (!migration.changed) {
				// A duplicate frame after the HTTP response has already migrated the
				// modal must still clean stale aliases. Do not regress a completed
				// detail back to `compacting` or issue a second fetch.
				if (existingNextDetail?.status !== "compacted") {
					void queryClient.invalidateQueries({ queryKey: nextQueryKey, exact: true });
				}
				return;
			}

			const sourceKey =
				sourceTargetKeyRef.current ??
				`${currentTarget.kind}:${currentTarget.narratorId}:${currentTarget.messageId}`;
			const pending = pendingRetryMigrationRef.current;
			if (
				!pending ||
				pending.narratorId !== currentTarget.narratorId ||
				pending.nextMessageId !== migration.nextMessageId
			) {
				pendingRetryMigrationRef.current = {
					narratorId: currentTarget.narratorId,
					nextMessageId: migration.nextMessageId,
					retiredMessageIds: [...retiredMessageIds],
					onDelete: currentTarget.onDelete,
				};
			} else {
				pending.retiredMessageIds = [
					...new Set([...pending.retiredMessageIds, ...retiredMessageIds]),
				];
			}
			setRetryTargetOverride((previous) =>
				previous?.sourceTargetKey === sourceKey && previous.messageId === migration.nextMessageId
					? previous
					: { sourceTargetKey: sourceKey, messageId: migration.nextMessageId },
			);
		},
		[queryClient],
	);

	useEffect(() => {
		const narratorId = target?.narratorId;
		if (!narratorId) return;
		const listener = narratorWSManager.addListener(
			{
				narratorIds: [narratorId],
				types: [
					"messages_deleted",
					"message_replaced",
					"message_updated",
					"compact_done",
					"compact_failed",
				],
			},
			applyCompactReplacement,
		);
		return () => narratorWSManager.removeListener(listener);
	}, [applyCompactReplacement, target?.narratorId]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey,
		queryFn: async () => {
			if (!activeTarget) return { summary: "" };
			return isSegment
				? api.getSegmentCompactSummary(activeTarget.narratorId, activeTarget.messageId)
				: api.getCompactSummary(activeTarget.narratorId, activeTarget.messageId);
		},
		enabled: !!activeTarget,
		gcTime: COMPACT_DETAIL_QUERY_GC_TIME_MS,
		refetchInterval: (query) =>
			!isSegment && (query.state.data as CompactMessageDetail | undefined)?.status === "compacting"
				? 1_000
				: false,
	});
	const compactDetail = !isSegment ? (data as CompactMessageDetail | undefined) : undefined;
	const failed = compactDetail?.status === "failed";
	const canRetry = compactDetail ? isCompactRetryableDetail(compactDetail) : false;
	const retryModelOptions = useMemo(
		() => visibleModels.map((model) => ({ value: model.value, label: model.label })),
		[visibleModels],
	);
	const previousSourceTargetKeyRef = useRef(sourceTargetKey);

	useEffect(() => {
		if (previousSourceTargetKeyRef.current === sourceTargetKey) return;
		previousSourceTargetKeyRef.current = sourceTargetKey;
		setRetryTargetOverride(null);
	}, [sourceTargetKey]);

	useEffect(() => {
		const pending = pendingRetryMigrationRef.current;
		if (
			!pending ||
			activeTargetKind !== "context" ||
			activeTargetNarratorId !== pending.narratorId ||
			activeTargetMessageId !== pending.nextMessageId
		) {
			return;
		}
		pendingRetryMigrationRef.current = null;
		for (const retiredMessageId of pending.retiredMessageIds) {
			queryClient.removeQueries({
				queryKey: compactSummaryQueryKey(pending.narratorId, retiredMessageId),
				exact: true,
			});
		}
		pending.onDelete?.();
		void queryClient.invalidateQueries({
			queryKey: compactSummaryQueryKey(pending.narratorId, pending.nextMessageId),
			exact: true,
		});
	}, [activeTargetKind, activeTargetNarratorId, activeTargetMessageId, queryClient]);

	useEffect(() => {
		if (!targetKey) {
			setEditing(false);
			setEditText("");
			setDeleting(false);
			setSaving(false);
			setRetrying(false);
			setRetryModel(null);
			return;
		}
		setEditing(false);
		setEditText("");
		setDeleting(false);
		setSaving(false);
		setRetrying(false);
		setRetryModel(null);
	}, [targetKey]);

	useEffect(() => {
		if (!canRetry) return;
		const availableModels = new Set(retryModelOptions.map((model) => model.value));
		if (retryModel && availableModels.has(retryModel)) return;
		const lastAttemptModel = compactDetail?.attempts.at(-1)?.model;
		const preferredModel = [lastAttemptModel, summaryModelValue].find(
			(model): model is string => typeof model === "string" && availableModels.has(model),
		);
		setRetryModel(preferredModel ?? retryModelOptions[0]?.value ?? null);
	}, [canRetry, compactDetail?.attempts, retryModel, retryModelOptions, summaryModelValue]);

	useEffect(() => {
		if (!activeTarget?.autoEdit || isLoading) return;
		setEditText(data?.summary ?? "");
		setEditing(true);
	}, [activeTarget?.autoEdit, isLoading, data?.summary]);

	const handleClose = () => {
		pendingRetryMigrationRef.current = null;
		setRetryTargetOverride(null);
		onClose();
		setEditing(false);
	};

	const handleDelete = async () => {
		if (!activeTarget) return;
		const currentTarget = activeTarget;
		setDeleting(true);
		try {
			if (currentTarget.kind === "segment") {
				await api.deleteSegmentCompact(currentTarget.narratorId, currentTarget.messageId);
			} else {
				await api.deleteCompactMessage(currentTarget.narratorId, currentTarget.messageId);
			}
			handleClose();
			currentTarget.onDelete?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
			});
		} finally {
			setDeleting(false);
		}
	};

	const handleSave = async () => {
		if (!activeTarget) return;
		setSaving(true);
		try {
			if (activeTarget.kind === "segment") {
				await api.updateSegmentCompactSummary(
					activeTarget.narratorId,
					activeTarget.messageId,
					editText,
				);
			} else {
				await api.updateCompactSummary(activeTarget.narratorId, activeTarget.messageId, editText);
			}
			queryClient.setQueryData(queryKey, { ...data, summary: editText });
			setEditing(false);
			refetch();
		} finally {
			setSaving(false);
		}
	};

	const handleRetry = async () => {
		if (!activeTarget || activeTarget.kind === "segment" || !canRetry) return;
		const currentTarget = activeTarget;
		setRetrying(true);
		try {
			const response = await api.retryFailedCompact(
				currentTarget.narratorId,
				currentTarget.messageId,
				retryModel ?? undefined,
			);
			const migration = resolveCompactRetryTargetMigration(currentTarget.messageId, response);
			await Promise.all(
				migration.retiredMessageIds.map((retiredMessageId) =>
					queryClient.cancelQueries({
						queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
						exact: true,
					}),
				),
			);
			const nextQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				migration.nextMessageId,
			);
			queryClient.setQueryData<CompactMessageDetail>(nextQueryKey, {
				...compactDetail,
				status: "compacting",
				summary: compactDetail?.summary ?? "",
				error: undefined,
				attempts: compactDetail?.attempts ?? [],
				canRetry: false,
			});
			if (migration.changed) {
				const retrySourceTargetKey =
					sourceTargetKey ??
					`${currentTarget.kind}:${currentTarget.narratorId}:${currentTarget.messageId}`;
				pendingRetryMigrationRef.current = {
					narratorId: currentTarget.narratorId,
					nextMessageId: migration.nextMessageId,
					retiredMessageIds: migration.retiredMessageIds,
					onDelete: currentTarget.onDelete,
				};
				setRetryTargetOverride({
					sourceTargetKey: retrySourceTargetKey,
					messageId: migration.nextMessageId,
				});
			} else {
				// WS may already have switched the modal before the POST response arrives.
				// Treat the response as an idempotent refresh, not a second deletion callback.
				for (const retiredMessageId of migration.retiredMessageIds) {
					queryClient.removeQueries({
						queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
						exact: true,
					});
				}
				await queryClient.invalidateQueries({ queryKey: nextQueryKey, exact: true });
			}
		} catch (err) {
			notifications.show({
				title: t("retryCompactFailed"),
				message: err instanceof Error ? err.message : t("compactFailedDesc"),
				color: "red",
			});
		} finally {
			setRetrying(false);
		}
	};

	return (
		<Modal
			opened={!!activeTarget}
			onClose={handleClose}
			title={
				<Group gap="xs">
					<IconArrowsMinimize size={18} />
					<Text fw={600}>
						{t(isSegment ? "segmentCompactSummaryTitle" : "compactSummaryTitle")}
					</Text>
				</Group>
			}
			size="lg"
			styles={COMPACT_SUMMARY_MODAL_STYLES}
		>
			<Box data-compact-summary-scroll style={COMPACT_SUMMARY_SCROLL_STYLE}>
				{isLoading && (
					<Group justify="center" py="xl">
						<Loader size="sm" />
					</Group>
				)}
				{error && (
					<Text c="red" size="sm">
						{error instanceof Error ? error.message : String(error)}
					</Text>
				)}
				{failed && compactDetail ? (
					<Stack gap="md">
						<Text c="red" size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
							{compactDetail.error || t("compactFailedDesc")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("compactLifecycleMeta", {
								mode: compactDetail.mode ?? "-",
								trigger: compactDetail.trigger ?? "-",
								before: compactDetail.contextPercentBefore ?? "-",
								after: compactDetail.contextPercentAfter ?? "-",
							})}
						</Text>
						{compactDetail.summary && <MarkdownContent text={compactDetail.summary} />}
						<Stack gap="xs">
							<Text fw={600} size="sm">
								{t("compactAttempts")}
							</Text>
							{compactDetail.attempts.slice(-10).map((attempt) => (
								<Paper key={`${attempt.attempt}:${attempt.startedAt}`} p="xs" withBorder>
									<Text size="xs" fw={600}>
										{t("compactAttempt", { attempt: attempt.attempt, model: attempt.model })}
									</Text>
									<Text
										size="xs"
										c={attempt.status === "failed" ? "red" : "dimmed"}
										style={{ whiteSpace: "pre-wrap" }}
									>
										{attempt.error || t(`compactAttemptStatus.${attempt.status}`)}
									</Text>
								</Paper>
							))}
						</Stack>
						{canRetry && (
							<Select
								label={t("compactRetryModel")}
								data={retryModelOptions}
								value={retryModel}
								onChange={setRetryModel}
								searchable
							/>
						)}
					</Stack>
				) : editing ? (
					<Textarea
						value={editText}
						onChange={(e) => setEditText(e.currentTarget.value)}
						autosize
						minRows={8}
						maxRows={20}
					/>
				) : data?.summary || compactDetail?.status === "compacting" ? (
					<Stack gap="md">
						{compactDetail?.status === "compacting" && (
							<Group gap="xs">
								<Loader size="xs" />
								<Text size="sm">{t("compacting")}</Text>
							</Group>
						)}
						{data?.summary && <MarkdownContent text={data.summary} />}
						{compactDetail && compactDetail.status !== "compacting" && (
							<>
								<Text size="xs" c="dimmed">
									{t("compactLifecycleMeta", {
										mode: compactDetail.mode ?? "-",
										trigger: compactDetail.trigger ?? "-",
										before: compactDetail.contextPercentBefore ?? "-",
										after: compactDetail.contextPercentAfter ?? "-",
									})}
								</Text>
								{compactDetail.attempts.length > 0 && (
									<Stack gap="xs">
										<Text fw={600} size="sm">
											{t("compactAttempts")}
										</Text>
										{compactDetail.attempts.slice(-10).map((attempt) => (
											<Paper key={`${attempt.attempt}:${attempt.startedAt}`} p="xs" withBorder>
												<Text size="xs" fw={600}>
													{t("compactAttempt", {
														attempt: attempt.attempt,
														model: attempt.model,
													})}
												</Text>
												<Text
													size="xs"
													c={attempt.status === "failed" ? "red" : "dimmed"}
													style={{ whiteSpace: "pre-wrap" }}
												>
													{attempt.error || t(`compactAttemptStatus.${attempt.status}`)}
												</Text>
											</Paper>
										))}
									</Stack>
								)}
							</>
						)}
					</Stack>
				) : null}
			</Box>
			{activeTarget && (
				<Group data-compact-summary-actions justify="flex-end" style={COMPACT_SUMMARY_FOOTER_STYLE}>
					{editing ? (
						<>
							<Button variant="subtle" size="xs" onClick={() => setEditing(false)}>
								{t("cancelEdit")}
							</Button>
							<Button size="xs" loading={saving} onClick={handleSave}>
								{t("saveEdit")}
							</Button>
						</>
					) : (
						<>
							<Button
								color="red"
								variant="light"
								size="xs"
								loading={deleting}
								onClick={handleDelete}
							>
								{t(failed ? "dismiss" : isSegment ? "deleteSegmentCompact" : "deleteCompact")}
							</Button>
							{canRetry ? (
								<Button size="xs" loading={retrying} disabled={!retryModel} onClick={handleRetry}>
									{t("retryCompact")}
								</Button>
							) : !failed && compactDetail?.status !== "compacting" ? (
								<Button
									variant="light"
									size="xs"
									onClick={() => {
										setEditText(data?.summary ?? "");
										setEditing(true);
									}}
								>
									{t("editCompact")}
								</Button>
							) : null}
						</>
					)}
				</Group>
			)}
		</Modal>
	);
}

function CompactIndicator({
	status,
	narratorId,
	messageId,
	progress,
	onDelete,
}: {
	status: CompactMessageStatus;
	narratorId?: string;
	messageId?: string;
	/** Live two-phase progress while compacting; null once finished. */
	progress?: ProgressSnapshot | null;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const isCompacting = status === "compacting";
	const isFailed = status === "failed";
	const [opened, { open, close }] = useDisclosure(false);
	const compactSummaryModal = useContext(CompactSummaryModalCtx);
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const queryClient = useQueryClient();

	const canClick = !isCompacting && !!narratorId && !!messageId;
	// While compacting, the indicator is clickable to cancel the in-progress compact.
	const canCancel = isCompacting && !!narratorId;

	const handleCancel = useCallback(async () => {
		if (!narratorId) return;
		setCancelling(true);
		try {
			const res = await api.cancelCompact(narratorId);
			// Rollback + UI reset arrive via WS (messages_deleted / compact_done).
			if (!res.ok) {
				notifications.show({
					message: t("cancelCompactFailedDesc"),
					color: "yellow",
					autoClose: 4000,
				});
			}
			setCancelConfirmOpen(false);
		} catch {
			notifications.show({
				title: t("cancelCompactFailed"),
				message: t("cancelCompactFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setCancelling(false);
		}
	}, [narratorId, t]);

	const handleOpen = useCallback(() => {
		if (!narratorId || !messageId) return;
		if (compactSummaryModal) {
			compactSummaryModal.open({ kind: "context", narratorId, messageId, onDelete });
			return;
		}
		open();
	}, [compactSummaryModal, messageId, narratorId, onDelete, open]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["compact-summary", narratorId, messageId],
		queryFn: () => api.getCompactSummary(narratorId ?? "", messageId ?? ""),
		enabled: !compactSummaryModal && opened && !!narratorId && !!messageId,
		gcTime: COMPACT_DETAIL_QUERY_GC_TIME_MS,
	});

	useEffect(() => {
		if (compactSummaryModal || opened || !narratorId || !messageId) return;
		queryClient.removeQueries({
			queryKey: ["compact-summary", narratorId, messageId],
			exact: true,
		});
	}, [compactSummaryModal, opened, narratorId, messageId, queryClient]);

	const handleDelete = async () => {
		if (!narratorId || !messageId) return;
		setDeleting(true);
		try {
			await api.deleteCompactMessage(narratorId, messageId);
			close();
			onDelete?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setDeleting(false);
		}
	};

	const handleEdit = () => {
		setEditText(data?.summary ?? "");
		setEditing(true);
	};

	const handleSave = async () => {
		if (!narratorId || !messageId) return;
		setSaving(true);
		try {
			await api.updateCompactSummary(narratorId, messageId, editText);
			setEditing(false);
			refetch();
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<Group
				gap={6}
				justify="center"
				py={4}
				{...(isCompacting ? { [COMPACTING_MARKER_ATTR]: "context" } : {})}
				{...(messageId ? { "data-message-id": messageId } : {})}
				style={canClick || canCancel ? { cursor: "pointer" } : undefined}
				onClick={canCancel ? () => setCancelConfirmOpen(true) : canClick ? handleOpen : undefined}
				title={canCancel ? t("cancelCompactTitle") : undefined}
			>
				{isCompacting ? (
					<Loader size={14} color="orange" />
				) : isFailed ? (
					<IconAlertTriangle size={14} style={{ color: "var(--mantine-color-red-6)" }} />
				) : (
					<IconArrowsMinimize size={14} style={{ color: "var(--mantine-color-orange-6)" }} />
				)}
				<Text
					size="xs"
					c={isFailed ? "red" : "orange"}
					td={canClick || canCancel ? "underline" : undefined}
				>
					{isCompacting
						? `${t("compacting")} · ${compactProgressLabel(t, progress ?? null)}`
						: isFailed
							? t("compactFailed")
							: t("compacted")}
				</Text>
				{canCancel && <IconX size={12} style={{ color: "var(--mantine-color-orange-6)" }} />}
			</Group>

			{canCancel && (
				<Modal
					opened={cancelConfirmOpen}
					onClose={() => setCancelConfirmOpen(false)}
					title={
						<Group gap="xs">
							<IconX size={18} style={{ color: "var(--mantine-color-orange-6)" }} />
							<Text fw={600}>{t("cancelCompactTitle")}</Text>
						</Group>
					}
					centered
					size="sm"
				>
					<Stack gap="md">
						<Text size="sm">{t("cancelCompactConfirmDesc")}</Text>
						<Group justify="flex-end" gap="xs">
							<Button variant="subtle" size="xs" onClick={() => setCancelConfirmOpen(false)}>
								{t("cancelCompactKeep")}
							</Button>
							<Button color="orange" size="xs" loading={cancelling} onClick={handleCancel}>
								{t("cancelCompactConfirm")}
							</Button>
						</Group>
					</Stack>
				</Modal>
			)}

			{!compactSummaryModal && (
				<Modal
					opened={opened}
					onClose={() => {
						close();
						setEditing(false);
					}}
					title={
						<Group gap="xs">
							<IconArrowsMinimize size={18} style={{ color: "var(--mantine-color-orange-6)" }} />
							<Text fw={600}>{t("compactSummaryTitle")}</Text>
						</Group>
					}
					size="lg"
					styles={COMPACT_SUMMARY_MODAL_STYLES}
				>
					<Box data-compact-summary-scroll style={COMPACT_SUMMARY_SCROLL_STYLE}>
						{isLoading && (
							<Group justify="center" py="xl">
								<Loader size="sm" />
							</Group>
						)}
						{error && (
							<Text c="red" size="sm">
								{error instanceof Error ? error.message : String(error)}
							</Text>
						)}
						{editing ? (
							<Textarea
								value={editText}
								onChange={(e) => setEditText(e.currentTarget.value)}
								autosize
								minRows={8}
								maxRows={20}
							/>
						) : (
							data?.summary && <MarkdownContent text={data.summary} />
						)}
					</Box>
					{canClick && (
						<Group
							data-compact-summary-actions
							justify="flex-end"
							style={COMPACT_SUMMARY_FOOTER_STYLE}
						>
							{editing ? (
								<>
									<Button variant="subtle" size="xs" onClick={() => setEditing(false)}>
										{t("cancelEdit")}
									</Button>
									<Button size="xs" loading={saving} onClick={handleSave}>
										{t("saveEdit")}
									</Button>
								</>
							) : (
								<>
									<Button
										color="red"
										variant="light"
										size="xs"
										loading={deleting}
										onClick={handleDelete}
									>
										{t("deleteCompact")}
									</Button>
									<Button variant="light" size="xs" onClick={handleEdit}>
										{t("editCompact")}
									</Button>
								</>
							)}
						</Group>
					)}
				</Modal>
			)}
		</>
	);
}

function SegmentCompactIndicator({
	isCompacting,
	narratorId,
	messageId,
	messageCount,
	progress,
	onDelete,
}: {
	isCompacting: boolean;
	narratorId?: string;
	messageId?: string;
	messageCount?: number;
	/** Live two-phase progress while compacting; null once finished. */
	progress?: ProgressSnapshot | null;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const compactSummaryModal = useContext(CompactSummaryModalCtx);
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const queryClient = useQueryClient();

	const canClick = !isCompacting && !!narratorId && !!messageId;

	const handleOpenSummary = useCallback(() => {
		if (!narratorId || !messageId) return;
		if (compactSummaryModal) {
			compactSummaryModal.open({ kind: "segment", narratorId, messageId, onDelete });
			return;
		}
		open();
	}, [compactSummaryModal, messageId, narratorId, onDelete, open]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["segment-compact-summary", narratorId, messageId],
		queryFn: () => api.getSegmentCompactSummary(narratorId ?? "", messageId ?? ""),
		enabled: !compactSummaryModal && opened && !!narratorId && !!messageId,
		gcTime: COMPACT_DETAIL_QUERY_GC_TIME_MS,
	});

	const {
		data: hiddenData,
		isLoading: hiddenLoading,
		error: hiddenError,
	} = useQuery({
		queryKey: ["segment-compact-messages", narratorId, messageId],
		queryFn: () => api.getSegmentCompactMessages(narratorId ?? "", messageId ?? ""),
		enabled: expanded && !!narratorId && !!messageId,
		gcTime: COMPACT_DETAIL_QUERY_GC_TIME_MS,
	});

	useEffect(() => {
		if (!narratorId || !messageId) return;
		if (!compactSummaryModal && !opened) {
			queryClient.removeQueries({
				queryKey: ["segment-compact-summary", narratorId, messageId],
				exact: true,
			});
		}
		if (!expanded) {
			queryClient.removeQueries({
				queryKey: ["segment-compact-messages", narratorId, messageId],
				exact: true,
			});
		}
	}, [compactSummaryModal, opened, expanded, narratorId, messageId, queryClient]);

	const handleDelete = async () => {
		if (!narratorId || !messageId) return;
		setDeleting(true);
		try {
			await api.deleteSegmentCompact(narratorId, messageId);
			close();
			onDelete?.();
		} catch {
			notifications.show({
				title: t("segmentCompactFailed"),
				message: t("segmentCompactFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setDeleting(false);
		}
	};

	const handleEdit = () => {
		setEditText(data?.summary ?? "");
		setEditing(true);
	};

	const handleSave = async () => {
		if (!narratorId || !messageId) return;
		setSaving(true);
		try {
			await api.updateSegmentCompactSummary(narratorId, messageId, editText);
			setEditing(false);
			refetch();
		} finally {
			setSaving(false);
		}
	};

	interface HiddenMessage {
		id: string;
		role: string;
		contentJson: { type: string; text?: string }[];
	}

	const hiddenMessages = (hiddenData?.messages ?? []) as HiddenMessage[];
	const visibleHiddenMessages = hiddenMessages.slice(0, MAX_HIDDEN_COMPACT_MESSAGES);
	const hiddenMessageOverflowCount = Math.max(
		0,
		hiddenMessages.length - visibleHiddenMessages.length,
	);

	return (
		<>
			<Group
				gap={6}
				justify="center"
				py={4}
				{...(isCompacting ? { [COMPACTING_MARKER_ATTR]: "segment" } : {})}
				{...(messageId ? { "data-message-id": messageId } : {})}
			>
				{isCompacting ? (
					<Loader size={14} color="teal" />
				) : (
					<IconArrowsMinimize size={14} style={{ color: "var(--mantine-color-teal-6)" }} />
				)}
				<Text
					size="xs"
					c="teal"
					td={canClick ? "underline" : undefined}
					style={canClick ? { cursor: "pointer" } : undefined}
					onClick={canClick ? handleOpenSummary : undefined}
				>
					{isCompacting
						? `${t("segmentCompacting")} · ${compactProgressLabel(t, progress ?? null)}`
						: t("segmentCompacted", { count: messageCount ?? 0 })}
				</Text>
				{canClick && (
					<Text
						size="xs"
						c="dimmed"
						style={{ cursor: "pointer" }}
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? (
							<Group gap={2}>
								<IconChevronDown size={12} />
								{t("collapseHiddenMessages")}
							</Group>
						) : (
							<Group gap={2}>
								<IconChevronRight size={12} />
								{t("expandHiddenMessages")}
							</Group>
						)}
					</Text>
				)}
			</Group>

			<Collapse expanded={expanded}>
				<Paper
					p="xs"
					radius="sm"
					withBorder
					style={{
						borderColor: "var(--mantine-color-teal-3)",
						opacity: 0.75,
						marginBottom: 4,
					}}
				>
					{hiddenLoading && (
						<Group justify="center" py="sm">
							<Loader size="xs" />
						</Group>
					)}
					{hiddenError && (
						<Text c="red" size="xs">
							{hiddenError instanceof Error ? hiddenError.message : String(hiddenError)}
						</Text>
					)}
					{hiddenMessages.length > 0 && (
						<Stack gap={6}>
							{visibleHiddenMessages.map((msg) => {
								const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
								const preview = collectHiddenCompactMessagePreview(blocks);
								if (!preview.text) return null;
								return (
									<Box
										key={msg.id}
										style={{
											borderLeft: `2px solid var(--mantine-color-${msg.role === "user" ? "blue" : "gray"}-4)`,
											paddingLeft: 8,
										}}
									>
										<Text size="xs" c="dimmed" fw={600} mb={2}>
											{msg.role === "user" ? "User" : "Assistant"}
										</Text>
										<Text
											size="xs"
											style={{
												whiteSpace: "pre-wrap",
												wordBreak: "break-word",
												maxHeight: 200,
												overflow: "auto",
											}}
										>
											{preview.truncated ? `${preview.text}…` : preview.text}
										</Text>
									</Box>
								);
							})}
							{hiddenMessageOverflowCount > 0 && (
								<Text size="xs" c="dimmed" ta="center">
									{t("segmentHiddenMessagesTruncated", {
										shown: visibleHiddenMessages.length,
										hidden: hiddenMessageOverflowCount,
									})}
								</Text>
							)}
						</Stack>
					)}
				</Paper>
			</Collapse>

			{!compactSummaryModal && (
				<Modal
					opened={opened}
					onClose={() => {
						close();
						setEditing(false);
					}}
					title={
						<Group gap="xs">
							<IconArrowsMinimize size={18} style={{ color: "var(--mantine-color-teal-6)" }} />
							<Text fw={600}>{t("segmentCompactSummaryTitle")}</Text>
						</Group>
					}
					size="lg"
					styles={COMPACT_SUMMARY_MODAL_STYLES}
				>
					<Box data-compact-summary-scroll style={COMPACT_SUMMARY_SCROLL_STYLE}>
						{isLoading && (
							<Group justify="center" py="xl">
								<Loader size="sm" />
							</Group>
						)}
						{error && (
							<Text c="red" size="sm">
								{error instanceof Error ? error.message : String(error)}
							</Text>
						)}
						{editing ? (
							<Textarea
								value={editText}
								onChange={(e) => setEditText(e.currentTarget.value)}
								autosize
								minRows={8}
								maxRows={20}
							/>
						) : (
							data?.summary && <MarkdownContent text={data.summary} />
						)}
					</Box>
					{canClick && (
						<Group
							data-compact-summary-actions
							justify="flex-end"
							style={COMPACT_SUMMARY_FOOTER_STYLE}
						>
							{editing ? (
								<>
									<Button variant="subtle" size="xs" onClick={() => setEditing(false)}>
										{t("cancelEdit")}
									</Button>
									<Button size="xs" loading={saving} onClick={handleSave}>
										{t("saveEdit")}
									</Button>
								</>
							) : (
								<>
									<Button
										color="red"
										variant="light"
										size="xs"
										loading={deleting}
										onClick={handleDelete}
									>
										{t("deleteSegmentCompact")}
									</Button>
									<Button variant="light" size="xs" onClick={handleEdit}>
										{t("editCompact")}
									</Button>
								</>
							)}
						</Group>
					)}
				</Modal>
			)}
		</>
	);
}

function MergeSummaryCard({
	block,
	creator,
	onDelete,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	block: any;
	creator?: {
		id: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const [confirmOpen, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);
	const qc = useQueryClient();

	const unmergeMutation = useMutation({
		mutationFn: () => api.unmergeChapter(block.sourceChapterId),
		onSuccess: (result) => {
			closeConfirm();
			close();
			// The backend deletes the merge_summary message during unmerge,
			// so invalidating messages will remove this card from the list.
			onDelete?.();
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
			qc.invalidateQueries({ queryKey: ["chapters"] });
			// Warnings replace the plain success toast rather than stacking on top of it:
			// "it worked, but ..." is the whole message, and a green "successful" beside a
			// yellow caveat reads as though the caveat were incidental.
			if (!notifyResultWarnings(t("unmergeWarning"), result)) {
				notifications.show({
					title: t("unmergeSuccess"),
					message: t("unmergeSuccessDesc"),
					color: "green",
				});
			}
		},
		onError: (err) => {
			notifications.show({
				title: t("unmergeFailed"),
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		},
	});

	const header = block.mergedBy
		? `${block.sourceBranch} → ${block.targetBranch} (${block.mergedBy})`
		: `${block.sourceBranch} → ${block.targetBranch}`;

	return (
		<>
			<Paper
				p="xs"
				radius="sm"
				style={{
					backgroundColor: "var(--mantine-color-indigo-light)",
					cursor: "pointer",
				}}
				onClick={open}
				onContextMenu={(e) => {
					if (!block.sourceChapterId) return;
					e.preventDefault();
					open();
				}}
			>
				<Group gap={6} wrap="nowrap">
					{creator && (
						<UserAvatar
							username={creator.username}
							avatarColor={creator.avatarColor}
							avatarImageId={creator.avatarImageId}
							userId={creator.id}
							size={16}
							showTooltip={false}
						/>
					)}
					<IconGitMerge
						size={16}
						style={{ flexShrink: 0, color: "var(--mantine-color-indigo-6)" }}
					/>
					<Text size="xs" c="indigo" lineClamp={1}>
						{t("mergeSummaryLabel")}
						{block.mergeRound > 1 && ` #${block.mergeRound}`} — {header}
					</Text>
				</Group>
			</Paper>

			<Modal
				opened={opened}
				onClose={close}
				title={
					<Group gap="xs">
						<IconGitMerge size={18} style={{ color: "var(--mantine-color-indigo-6)" }} />
						<Text fw={600}>
							{t("mergeSummaryTitle")}
							{block.mergeRound > 1 && ` #${block.mergeRound}`}
						</Text>
					</Group>
				}
				size="lg"
			>
				<Stack gap="xs" mb="md">
					<Group gap="xs">
						<Text size="sm" c="dimmed">
							{t("mergeSummaryBranch")}:
						</Text>
						{creator && (
							<UserAvatar
								username={creator.username}
								avatarColor={creator.avatarColor}
								avatarImageId={creator.avatarImageId}
								userId={creator.id}
								size={20}
								showTooltip
							/>
						)}
						<Text size="sm" fw={500}>
							{header}
						</Text>
					</Group>
					{block.strategy && (
						<Group gap="xs">
							<Text size="sm" c="dimmed">
								{t("mergeSummaryStrategy")}:
							</Text>
							<Text size="sm">{block.strategy}</Text>
						</Group>
					)}
					{block.commitSha && (
						<Group gap="xs">
							<Text size="sm" c="dimmed">
								Commit:
							</Text>
							<Text size="sm" ff="monospace">
								{block.commitSha.slice(0, 8)}
							</Text>
						</Group>
					)}
				</Stack>

				{block.summary && (
					<ScrollArea.Autosize mah="60vh">
						<MarkdownContent text={block.summary} />
					</ScrollArea.Autosize>
				)}

				{block.sourceChapterId && block.isLatest !== false && (
					<Group justify="flex-end" mt="md">
						<Button color="orange" variant="light" size="xs" onClick={openConfirm}>
							{t("unmerge")}
						</Button>
					</Group>
				)}
			</Modal>

			{/* Confirmation dialog for unmerge */}
			<Modal opened={confirmOpen} onClose={closeConfirm} title={t("unmergeConfirmTitle")} size="sm">
				<Text size="sm" mb="md">
					{t("unmergeConfirmDesc", { branch: block.sourceBranch })}
				</Text>
				<Group justify="flex-end">
					<Button variant="default" size="xs" onClick={closeConfirm}>
						{t("cancel")}
					</Button>
					<Button
						color="orange"
						size="xs"
						loading={unmergeMutation.isPending}
						onClick={() => unmergeMutation.mutate()}
					>
						{t("unmerge")}
					</Button>
				</Group>
			</Modal>
		</>
	);
}

const VERDICT_COLORS: Record<string, string> = {
	approve: "green",
	request_changes: "orange",
	comment_only: "blue",
};

const VERDICT_ICONS: Record<string, string> = {
	approve: "\u2705",
	request_changes: "\u{1F527}",
	comment_only: "\u{1F4AC}",
};

function ReviewFeedbackCard({
	block,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	block: any;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const verdict: string = block.verdict ?? "comment_only";
	const findings: Array<{
		severity: string;
		file?: string;
		line?: number;
		message: string;
	}> = Array.isArray(block.findings) ? block.findings : [];
	const color = VERDICT_COLORS[verdict] ?? "gray";
	const icon = VERDICT_ICONS[verdict] ?? "\u{1F4AC}";

	return (
		<>
			<Paper
				p="xs"
				radius="sm"
				style={{
					backgroundColor: `var(--mantine-color-${color}-light)`,
					cursor: findings.length > 0 ? "pointer" : undefined,
				}}
				onClick={findings.length > 0 ? open : undefined}
			>
				<Group gap={6} wrap="nowrap">
					<IconEyeCheck
						size={16}
						style={{ flexShrink: 0, color: `var(--mantine-color-${color}-6)` }}
					/>
					<Text size="xs" c={color} lineClamp={1}>
						{icon} {t("reviewFeedbackLabel")} — {t(`reviewVerdict_${verdict}`)}
						{findings.length > 0 && ` (${findings.length})`}
					</Text>
				</Group>
			</Paper>

			{findings.length > 0 && (
				<Modal
					opened={opened}
					onClose={close}
					title={
						<Group gap="xs">
							<IconEyeCheck size={18} style={{ color: `var(--mantine-color-${color}-6)` }} />
							<Text fw={600}>
								{t("reviewFeedbackTitle")} — {t(`reviewVerdict_${verdict}`)}
							</Text>
						</Group>
					}
					size="lg"
				>
					<Stack gap="xs">
						{findings.map((f) => (
							<Paper
								key={`${f.severity}-${f.file ?? ""}-${f.line ?? ""}-${f.message.slice(0, 40)}`}
								p="xs"
								radius="sm"
								withBorder
								style={{ borderColor: `var(--mantine-color-${color}-4)` }}
							>
								<Group gap={4} mb={4}>
									<Badge size="xs" variant="light" color={color}>
										{f.severity}
									</Badge>
									{f.file && (
										<Code fz="xs">
											{f.file}
											{f.line ? `:${f.line}` : ""}
										</Code>
									)}
								</Group>
								<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
									{f.message}
								</Text>
							</Paper>
						))}
					</Stack>
				</Modal>
			)}
		</>
	);
}

function PlanCard({
	summary,
	narratorId,
	messageId,
	onDelete,
}: {
	summary: string;
	narratorId?: string;
	messageId?: string;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [displaySummary, setDisplaySummary] = useState(summary);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);

	// Sync if parent re-renders with a new summary (e.g. after query refetch)
	useEffect(() => {
		setDisplaySummary(summary);
	}, [summary]);

	const handleEdit = () => {
		setEditText(displaySummary);
		setEditing(true);
	};

	const handleSave = async () => {
		if (!narratorId || !messageId) return;
		setSaving(true);
		try {
			await api.updateCompactSummary(narratorId, messageId, editText);
			setDisplaySummary(editText);
			setEditing(false);
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async () => {
		if (!narratorId || !messageId) return;
		setDeleting(true);
		try {
			await api.deleteCompactMessage(narratorId, messageId);
			onDelete?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setDeleting(false);
		}
	};

	return (
		<Paper
			p="sm"
			radius="md"
			withBorder
			style={{
				borderColor: "var(--mantine-color-teal-light-color)",
				backgroundColor: "var(--mantine-color-teal-light)",
			}}
		>
			<Group gap={6} mb={6}>
				<IconListCheck size={16} style={{ color: "var(--mantine-color-teal-6)" }} />
				<Text size="xs" fw={600} c="teal">
					{t("plan")}
				</Text>
				{narratorId && messageId && (
					<Group gap={4} ml="auto">
						{editing ? (
							<>
								<Button variant="subtle" size="compact-xs" onClick={() => setEditing(false)}>
									{t("cancelEdit")}
								</Button>
								<Button size="compact-xs" loading={saving} onClick={handleSave}>
									{t("saveEdit")}
								</Button>
							</>
						) : (
							<>
								<Button variant="subtle" size="compact-xs" c="dimmed" onClick={handleEdit}>
									{t("editCompact")}
								</Button>
								<Button
									variant="subtle"
									size="compact-xs"
									c="red"
									loading={deleting}
									onClick={handleDelete}
								>
									{t("deleteCompact")}
								</Button>
							</>
						)}
					</Group>
				)}
			</Group>
			{editing ? (
				<Textarea
					value={editText}
					onChange={(e) => setEditText(e.currentTarget.value)}
					autosize
					minRows={4}
					maxRows={20}
				/>
			) : (
				<MarkdownContent text={displaySummary} />
			)}
		</Paper>
	);
}

export const MessageBubble = memo(function MessageBubble({
	narratorId,
	message,
	onForkFromMessage,
	onAskInPassing,
	resolvePerm,
	onPermissionDecision,
	onQuestionSubmit,
	onQuestionReflect,
	onQuestionDeny,
	onCompactBeforeMessage,
	onClearContextBefore,
	onManualSummarize,
	onDeleteBlock,
	onRollbackToBlock,
	onEditAndRegenerate,
	onEditAssistantMessage,
	onRestoreAssistantMessage,
	onViewSubagentSession,
	onOpenFilePanel,
	isLastUserMessage,
	hasChapter,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const blockKeys = useMemo(() => generateBlockKeys(blocks), [blocks]);
	// Merge adjacent reasoning/thinking blocks into runs. `reasoningRunByStart`
	// maps a run's first block index to the merged sub-arrays (stable refs so
	// ReasoningBlock's memo holds); `reasoningSkip` marks absorbed indices.
	const { reasoningRunByStart, reasoningSkip } = useMemo(() => {
		const { runs, skip } = groupReasoningRuns(blocks, {
			originalIndices: message._blockOriginalIndices,
			allBlocks: message._allContentJson,
		});
		const byStart = new Map<
			number,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON blocks
			{ runBlocks: any[]; runRealIndices: number[]; isLastContent: boolean }
		>();
		for (const run of runs) {
			byStart.set(run.startIndex, {
				runBlocks: run.indices.map((i) => blocks[i]),
				runRealIndices: run.indices.map((i) => message._blockOriginalIndices?.[i] ?? i),
				isLastContent: run.isLastContent,
			});
		}
		return { reasoningRunByStart: byStart, reasoningSkip: skip };
	}, [blocks, message._blockOriginalIndices, message._allContentJson]);
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const _msgId = message.id;

	// Edit mode. The editor itself (state machine, attachments, submit flow) lives
	// in the shared MessageEditorPanel — mounted only while editing, and seeded
	// from `editorInitialText` below.
	const [isEditing, setIsEditing] = useState(false);
	const [editorInitialText, setEditorInitialText] = useState("");

	// Initialize edit content when entering edit mode
	const startEditing = useCallback(() => {
		const editPreview = resolveEditorInitialText(blocks, isUser ? "user" : "assistant");
		if (editPreview.truncated) {
			notifications.show({ color: "yellow", message: t("editMessageTooLarge") });
			return;
		}
		setEditorInitialText(editPreview.text);
		setIsEditing(true);
	}, [blocks, isUser, t]);

	const closeEditing = useCallback(() => {
		setIsEditing(false);
		setEditorInitialText("");
	}, []);

	// Lightweight cache refresh for CompactIndicator/PlanCard — they already
	// call their own delete API, so we only need to invalidate the messages
	// query instead of firing another delete request via onDeleteBlock.
	const invalidateMessages = useCallback(
		() => qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] }),
		[qc, narratorId],
	);

	// Build message-level context menu actions for ContentViewer to consume

	const ctxActions = useMemo<MessageContextMenuActions>(() => {
		const actions: MessageContextMenuActions = { messageId: message.id };
		const msgId = message.id;
		const msgUuid = message.messageUuid;
		if (msgId && onForkFromMessage) {
			actions.onForkFromMessage = () => onForkFromMessage(msgId);
		}
		if (msgId && onAskInPassing) {
			actions.onAskInPassing = () => onAskInPassing(msgUuid ?? null, msgId);
		}
		if (msgId && onCompactBeforeMessage) {
			actions.onCompactBeforeMessage = () => onCompactBeforeMessage(msgId);
		}
		if (msgId && onClearContextBefore) {
			actions.onClearContextBefore = () => onClearContextBefore(msgId);
		}
		if (msgId && onManualSummarize) {
			actions.onManualSummarize = () => onManualSummarize(msgId);
		}
		if (msgId && onDeleteBlock) {
			actions.onDeleteBlock = (blockIndex: number) => onDeleteBlock(msgId, blockIndex);
		}
		if (msgId && onRollbackToBlock) {
			actions.onRollbackToBlock = (blockIndex: number) => onRollbackToBlock(msgId, blockIndex);
		}
		if (isUser && msgId && onEditAndRegenerate) {
			actions.onEditMessage = startEditing;
		}
		// Assistant messages: allow persisted text edits when there is editable text.
		if (
			!isUser &&
			msgId &&
			onEditAssistantMessage &&
			blocks.some((b: { type?: string }) => b.type === "text")
		) {
			actions.onEditMessage = startEditing;
		}
		return actions;
	}, [
		isUser,
		message.id,
		message.messageUuid,
		blocks,
		onForkFromMessage,
		onAskInPassing,
		onCompactBeforeMessage,
		onClearContextBefore,
		onManualSummarize,
		onDeleteBlock,
		onRollbackToBlock,
		onEditAndRegenerate,
		onEditAssistantMessage,
		startEditing,
	]);

	// Merge summary cards — rendered for both role="system" (legacy) and role="user"
	// (new: persistSystemMessage uses role="user" so the SDK includes it in context).
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const mergeSummaryBlock = blocks.find((b: any) => b.type === "merge_summary");
	if (mergeSummaryBlock) {
		return (
			<MergeSummaryCard
				block={mergeSummaryBlock}
				creator={message.creator}
				onDelete={invalidateMessages}
			/>
		);
	}

	// Review feedback cards — injected by review-event-handler when a review concludes
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const reviewFeedbackBlock = blocks.find((b: any) => b.type === "review_feedback");
	if (reviewFeedbackBlock) {
		return <ReviewFeedbackCard block={reviewFeedbackBlock} />;
	}

	// Ask-in-passing cards — pending (input box) or resolved (link to new narrator)
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const askInPassingBlock = blocks.find((b: any) => b.type === "ask_in_passing");
	if (askInPassingBlock) {
		if (askInPassingBlock.status === "pending") {
			if (!message.id || !narratorId) return null;
			return <AskInPassingPendingCard messageId={message.id} narratorId={narratorId} />;
		}
		return <AskInPassingResolvedCard block={askInPassingBlock} />;
	}

	// Segment compact indicators — rendered for both role="user" (new) and role="system" (legacy)
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const segmentCompactBlock = blocks.find((b: any) => b.type === "segment_compact");
	if (segmentCompactBlock) {
		const isSegCompacting = segmentCompactBlock.status === "compacting";
		const isFailed = segmentCompactBlock.status === "failed";
		if (isFailed) {
			return (
				<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-red-light)" }}>
					<Group gap={6} wrap="nowrap" align="flex-start">
						<IconAlertTriangle
							size={16}
							style={{ flexShrink: 0, color: "var(--mantine-color-red-7)" }}
						/>
						<Stack gap={2} style={{ flex: 1 }}>
							<Text size="xs" fw={600} c="red.8">
								{t("segmentCompactFailed")}
							</Text>
							<Text size="xs" c="red.9" style={{ whiteSpace: "pre-wrap" }}>
								{segmentCompactBlock.error ??
									segmentCompactBlock.summary ??
									t("segmentCompactFailedDesc")}
							</Text>
						</Stack>
						{narratorId && message.id && (
							<Button
								size="compact-xs"
								variant="subtle"
								color="dimmed"
								style={{ flexShrink: 0 }}
								onClick={() => {
									const messageId = message.id;
									if (!messageId) return;
									api.deleteSegmentCompact(narratorId, messageId).then(
										() => invalidateMessages(),
										() => {},
									);
								}}
							>
								{t("dismiss")}
							</Button>
						)}
					</Group>
				</Paper>
			);
		}
		const canNavigate = !isSegCompacting && narratorId && message.id;
		return (
			<SegmentCompactIndicator
				isCompacting={isSegCompacting}
				narratorId={canNavigate ? narratorId : undefined}
				messageId={message.id}
				messageCount={segmentCompactBlock.messageCount}
				progress={isSegCompacting ? coerceProgressSnapshot(segmentCompactBlock) : null}
				onDelete={canNavigate ? invalidateMessages : undefined}
			/>
		);
	}

	// System / display messages (compact indicators / plan cards / error notices / info notices)
	if (message.role === "system" || message.role === "sys" || message.role === "disp") {
		// Regular compact indicators / plan cards
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact");
		if (compactBlock) {
			if (compactBlock.subtype === "plan") {
				return (
					<PlanCard
						summary={compactBlock.summary ?? ""}
						narratorId={narratorId}
						messageId={message.id}
						onDelete={invalidateMessages}
					/>
				);
			}
			const status: CompactMessageStatus =
				compactBlock.status === "compacting" ||
				compactBlock.status === "failed" ||
				compactBlock.status === "compacted"
					? compactBlock.status
					: "compacted";
			return (
				<CompactIndicator
					status={status}
					narratorId={narratorId}
					messageId={message.id}
					progress={status === "compacting" ? coerceProgressSnapshot(compactBlock) : null}
					onDelete={status !== "compacting" ? invalidateMessages : undefined}
				/>
			);
		}
		// Spec carryover card (Dynamic Spec) — shown when a narrator has a
		// non-empty tasks.json after a context-boundary event: either a fresh fork
		// that inherited tasks (`spec_fork_carryover`), or a full context clear that
		// left tasks.json intact (`spec_context_cleared`). Offers to clear the tasks
		// or reset the whole spec (this narrator's namespace only; others untouched).
		const forkCarryIndex = blocks.findIndex(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "spec_fork_carryover" || b.type === "spec_context_cleared",
		);
		const forkCarryBlock = forkCarryIndex >= 0 ? blocks[forkCarryIndex] : undefined;
		if (forkCarryBlock) {
			const forkCarryRealIndex = message._blockOriginalIndices?.[forkCarryIndex] ?? forkCarryIndex;
			const carryVariant =
				forkCarryBlock.type === "spec_context_cleared" ? "contextCleared" : "fork";
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={forkCarryRealIndex} messageId={message.id}>
						<SpecForkCarryoverCard
							narratorId={narratorId}
							messageId={message.id}
							variant={carryVariant}
							total={typeof forkCarryBlock.total === "number" ? forkCarryBlock.total : 0}
							open={typeof forkCarryBlock.open === "number" ? forkCarryBlock.open : 0}
							protectedOpen={
								typeof forkCarryBlock.protectedOpen === "number" ? forkCarryBlock.protectedOpen : 0
							}
						/>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		// Spec /goal confirmation card (Dynamic Spec) — a durable record that a
		// protected task was added (or already existed) via the /goal command.
		const goalIndex = blocks.findIndex(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "spec_goal_added",
		);
		const goalBlock = goalIndex >= 0 ? blocks[goalIndex] : undefined;
		if (goalBlock) {
			const goalRealIndex = message._blockOriginalIndices?.[goalIndex] ?? goalIndex;
			const added = goalBlock.added !== false;
			const taskText = goalBlock.task ?? message.contentText;
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={goalRealIndex} messageId={message.id}>
						<Paper
							p="xs"
							radius="sm"
							style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}
						>
							<Stack gap={6}>
								<Group gap="xs" wrap="nowrap">
									<Badge
										size="xs"
										color="yellow"
										variant="light"
										leftSection={<IconLock size={10} />}
									>
										{t("specProtectedBadge")}
									</Badge>
									<Badge size="xs" color={added ? "green" : "gray"} variant="light">
										{added ? t("specGoalAddedBadge") : t("specGoalExistsBadge")}
									</Badge>
									<Text size="xs" c="indigo" style={{ flex: 1, whiteSpace: "pre-wrap" }}>
										{taskText}
									</Text>
								</Group>
								<Button
									size="compact-xs"
									variant="subtle"
									color="indigo"
									leftSection={<IconListCheck size={12} />}
									style={{ alignSelf: "flex-start" }}
									onClick={(e) => {
										e.currentTarget.dispatchEvent(
											new CustomEvent("spec-open-tasks", { bubbles: true }),
										);
									}}
								>
									{t("specGoalViewTasks")}
								</Button>
							</Stack>
						</Paper>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		// Spec task continuation / blocked reminders (Dynamic Spec sidecar messages).
		const specIndex = blocks.findIndex(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "spec_continuation" || b.type === "spec_blocked_continuation",
		);
		const specBlock = specIndex >= 0 ? blocks[specIndex] : undefined;
		if (specBlock) {
			const specRealIndex = message._blockOriginalIndices?.[specIndex] ?? specIndex;
			const isBlocked = specBlock.type === "spec_blocked_continuation";
			const color = isBlocked ? "orange" : "indigo";
			const labelKey = isBlocked ? "specBlockedContinuation" : "specContinuation";
			const taskText = specBlock.task ?? message.contentText;
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={specRealIndex} messageId={message.id}>
						<Paper
							p="xs"
							radius="sm"
							style={{ backgroundColor: `var(--mantine-color-${color}-light)` }}
						>
							<Group gap="xs" wrap="nowrap">
								<Badge size="xs" color={color} variant="light">
									{t(labelKey)}
								</Badge>
								{specBlock.protected && (
									<Badge
										size="xs"
										color="yellow"
										variant="light"
										leftSection={<IconLock size={10} />}
									>
										{t("specProtectedBadge")}
									</Badge>
								)}
								<Text size="xs" c={color} truncate style={{ flex: 1 }}>
									{taskText}
								</Text>
							</Group>
						</Paper>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		const cwdRecoveryIndex = blocks.findIndex(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "cwd_recovery",
		);
		const cwdRecoveryBlock = cwdRecoveryIndex >= 0 ? blocks[cwdRecoveryIndex] : undefined;
		if (
			cwdRecoveryBlock &&
			narratorId &&
			message.id &&
			typeof cwdRecoveryBlock.missingCwd === "string" &&
			cwdRecoveryBlock.missingCwd
		) {
			const cwdRecoveryRealIndex =
				message._blockOriginalIndices?.[cwdRecoveryIndex] ?? cwdRecoveryIndex;
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={cwdRecoveryRealIndex} messageId={message.id}>
						<WorkingDirectoryRecoveryNotice
							narratorId={narratorId}
							messageId={message.id}
							missingCwd={cwdRecoveryBlock.missingCwd}
							suggestedCwd={
								typeof cwdRecoveryBlock.suggestedCwd === "string"
									? cwdRecoveryBlock.suggestedCwd
									: ""
							}
						/>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		const recoveryIndex = blocks.findIndex(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "subagent_recovery",
		);
		const recoveryBlock = recoveryIndex >= 0 ? blocks[recoveryIndex] : undefined;
		if (recoveryBlock && narratorId && message.id) {
			const recoveryRealIndex = message._blockOriginalIndices?.[recoveryIndex] ?? recoveryIndex;
			const entries = Array.isArray(recoveryBlock.subagents)
				? (recoveryBlock.subagents as SubagentRecoveryEntry[])
				: [];
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={recoveryRealIndex} messageId={message.id}>
						{recoveryBlock.status === "resolved" ? (
							<SubagentRecoveryResolvedCard
								resumedCount={
									typeof recoveryBlock.resumedCount === "number"
										? recoveryBlock.resumedCount
										: entries.length
								}
								mode={recoveryBlock.mode === "await" ? "await" : "notify"}
							/>
						) : (
							<SubagentRecoveryPendingCard
								narratorId={narratorId}
								messageId={message.id}
								subagents={entries}
							/>
						)}
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const errorBlock = blocks.find((b: any) => b.type === "error");
		if (errorBlock && narratorId && message.id) {
			return (
				<ErrorNotice
					message={errorBlock.message ?? t("unknownError")}
					narratorId={narratorId}
					messageId={message.id}
					onDismiss={invalidateMessages}
				/>
			);
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const knowledgeHintIndex = blocks.findIndex((b: any) => b.type === "knowledge_hint");
		const knowledgeHintBlock = knowledgeHintIndex >= 0 ? blocks[knowledgeHintIndex] : undefined;
		if (knowledgeHintBlock) {
			const hintRealIndex =
				message._blockOriginalIndices?.[knowledgeHintIndex] ?? knowledgeHintIndex;
			const entries = Array.isArray(knowledgeHintBlock.entries)
				? (knowledgeHintBlock.entries as Array<{
						entryId: string;
						title?: string;
						summary?: string;
					}>)
				: [];
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={hintRealIndex} messageId={message.id}>
						<KnowledgeHintNotice entries={entries} />
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const infoIndex = blocks.findIndex((b: any) => b.type === "info");
		const infoBlock = infoIndex >= 0 ? blocks[infoIndex] : undefined;
		if (infoBlock) {
			const infoRealIndex = message._blockOriginalIndices?.[infoIndex] ?? infoIndex;
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={infoRealIndex} messageId={message.id}>
						<Paper p="xs" radius="sm" style={{ backgroundColor: SYSTEM_MESSAGE_BG }}>
							<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
								{infoBlock.message}
							</Text>
						</Paper>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		// Server-authored injected content on its own row (narrator-injection.ts).
		// Checked BEFORE the plain-text branch below: the row also carries a text
		// block — the model-facing copy, boilerplate included — and falling through to
		// that branch would show the reader the prompt engineering instead of the
		// projected summary.
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const injectionIndex = blocks.findIndex((b: any) => b.type === "system_injection");
		if (injectionIndex >= 0) {
			const injectionBlock = blocks[injectionIndex];
			const injectionRealIndex = message._blockOriginalIndices?.[injectionIndex] ?? injectionIndex;
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={injectionRealIndex} messageId={message.id}>
						<SystemInjectionNotice
							source={injectionBlock.source ?? ""}
							body={readSideCarBody(injectionBlock)}
							// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
							fallbackText={blocks.find((b: any) => b.type === "text")?.text ?? ""}
							createdAt={message.createdAt}
						/>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		// Plain-text `sys` messages (browser/container notices, plan-mode exits).
		// These carry only a `text` block, so before this branch existed they fell
		// through to `return null` and were invisible in the UI even though the
		// model saw them.
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const sysTextIndex = blocks.findIndex((b: any) => b.type === "text" && b.text?.trim());
		if (sysTextIndex >= 0) {
			const sysTextRealIndex = message._blockOriginalIndices?.[sysTextIndex] ?? sysTextIndex;
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={sysTextRealIndex} messageId={message.id}>
						<SystemOriginNotice
							text={blocks[sysTextIndex].text}
							origin={message.origin}
							originLabel={message.originLabel}
						/>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}
		return null;
	}

	// User messages — wrap entire bubble in ContentViewer for context menu / swipe
	if (isUser) {
		// Tool load/unload notifications — render like info messages, not user bubbles
		const toolLoadedBlock = blocks.find(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "tool_loaded" || b.type === "tool_unloaded",
		);
		if (toolLoadedBlock) {
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<BlockMenuWrapper blockIndex={0}>
						<Paper p="xs" radius="sm" style={{ backgroundColor: SYSTEM_MESSAGE_BG }}>
							<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
								{toolLoadedBlock.text}
							</Text>
						</Paper>
					</BlockMenuWrapper>
				</MessageContextMenuCtx.Provider>
			);
		}

		// /bash command — render as a compact command indicator
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const bashCommandBlock = blocks.find((b: any) => b.type === "bash_command");
		if (bashCommandBlock) {
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<BlockMenuWrapper blockIndex={0}>
						<Paper p="xs" radius="sm" style={{ backgroundColor: SYSTEM_MESSAGE_BG }}>
							<Text size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
								$ {bashCommandBlock.command}
							</Text>
						</Paper>
					</BlockMenuWrapper>
				</MessageContextMenuCtx.Provider>
			);
		}

		const userTextPreview = collectTextBlocksPreview(blocks, MAX_USER_MESSAGE_DISPLAY_CHARS);
		const fullText = userTextPreview.text;
		const hasCommand = !!message.commandText;

		// Stored as `role: "user"` for protocol/scheduling reasons but not written
		// by a human (auto-continuation, review kickoff, AI-initiated sends).
		// Rendering these as user bubbles is what made attribution ambiguous, so
		// they get the low-contrast system-notice treatment instead. Checked after
		// the specialized cards above so those keep their own rendering.
		if (!isHumanOrigin(message.origin)) {
			const noticeText = fullText.trim() ? fullText : (message.contentText ?? "");
			return (
				<MessageContextMenuCtx.Provider value={ctxActions}>
					<SelectableSystemNotice blockIndex={0} messageId={message.id}>
						<SystemOriginNotice
							text={noticeText}
							origin={message.origin}
							originLabel={message.originLabel}
							createdAt={message.createdAt}
						/>
					</SelectableSystemNotice>
				</MessageContextMenuCtx.Provider>
			);
		}

		// Edit mode UI — the shared editor panel owns the whole editing interaction.
		if (isEditing) {
			return (
				<MessageEditorPanel
					messageRole="user"
					narratorId={narratorId}
					messageId={message.id ?? ""}
					imageNarratorId={message.narratorId ?? narratorId}
					blocks={blocks}
					creator={message.creator}
					initialText={editorInitialText}
					isLastUserMessage={isLastUserMessage}
					hasChapter={hasChapter}
					onEditAndRegenerate={onEditAndRegenerate}
					onClose={closeEditing}
				/>
			);
		}

		return (
			<MessageContextMenuCtx.Provider value={ctxActions}>
				<ContentViewer content={fullText} markdown contentType="markdown" blockIndex={0}>
					<Paper
						p="sm"
						radius="md"
						style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}
					>
						<Stack gap={4}>
							<Group gap={6}>
								{message.creator ? (
									<UserAvatar
										username={message.creator.username}
										avatarColor={message.creator.avatarColor}
										avatarImageId={message.creator.avatarImageId}
										userId={message.creator.id}
										size={20}
										showTooltip={false}
									/>
								) : (
									<OriginAvatar originLabel={message.originLabel} size={20} />
								)}
								<Text size="xs" fw={600} c="indigo">
									{resolveUserBubbleName(message, t)}
								</Text>
								<MessageOriginBadge origin={message.origin} originLabel={message.originLabel} />
								{message.createdAt && (
									<Text size="xs" c="dimmed" ml="auto">
										{(() => {
											const d = new Date(message.createdAt);
											const now = new Date();
											const isToday =
												d.getFullYear() === now.getFullYear() &&
												d.getMonth() === now.getMonth() &&
												d.getDate() === now.getDate();
											return isToday
												? formatLocaleTime(d, {
														hour: "2-digit",
														minute: "2-digit",
													})
												: formatLocaleDateTime(d, {
														month: "2-digit",
														day: "2-digit",
														hour: "2-digit",
														minute: "2-digit",
													});
										})()}
									</Text>
								)}
							</Group>
							{userTextPreview.truncated && (
								<Text size="xs" c="orange">
									{t("userMessagePreviewTruncated")}
								</Text>
							)}
							{hasCommand ? (
								<>
									<Text size="sm" fw={500} c="indigo.4" style={{ fontFamily: "monospace" }}>
										{message.commandText}
									</Text>
									<Spoiler
										maxHeight={0}
										showLabel={t("showExpandedPrompt")}
										hideLabel={t("hideExpandedPrompt")}
										styles={{
											control: { fontSize: "var(--mantine-font-size-xs)" },
										}}
									>
										<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
											{fullText}
										</Text>
									</Spoiler>
									{blocks
										.filter(
											// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
											(b: any) => b.type === "image",
										)
										.map(
											// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
											(block: any, i: number) => (
												<ImageBlock
													// biome-ignore lint/suspicious/noArrayIndexKey: filtered image blocks have no stable id
													key={`cmd-img-${i}`}
													block={block}
													imageNarratorId={message.narratorId ?? narratorId}
												/>
											),
										)}
								</>
							) : (
								<>
									{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
									{blocks.map((block: any, i: number) => {
										const key = block.id ?? `${block.type}-${i}`;
										if (block.type === "text") {
											return (
												<Text key={key} size="sm" style={{ whiteSpace: "pre-wrap" }}>
													{block.text}
												</Text>
											);
										}
										if (block.type === "image") {
											return (
												<ImageBlock
													key={key}
													block={block}
													imageNarratorId={message.narratorId ?? narratorId}
												/>
											);
										}
										if (block.type === "text_file") {
											return <TextFileBlock key={key} block={block} onOpen={onOpenFilePanel} />;
										}
										return null;
									})}
								</>
							)}
						</Stack>
					</Paper>
				</ContentViewer>
			</MessageContextMenuCtx.Provider>
		);
	}

	// Assistant messages — wrap in context provider so all ContentViewers
	// (including those inside ToolCallCard) can access message-level actions
	const isStreaming = message.id === "__streaming__";

	// Assistant edit mode UI: save edited text without deleting later messages or regenerating.
	if (isEditing && !isUser) {
		return (
			<MessageEditorPanel
				messageRole="assistant"
				narratorId={narratorId}
				messageId={message.id ?? ""}
				imageNarratorId={message.narratorId ?? narratorId}
				blocks={blocks}
				creator={message.creator}
				initialText={editorInitialText}
				onEditAssistantMessage={onEditAssistantMessage}
				onClose={closeEditing}
			/>
		);
	}

	return (
		<MessageContextMenuCtx.Provider value={ctxActions}>
			<div
				style={{
					minWidth: 0,
					display: "flex",
					flexDirection: "column",
					gap: "calc(0.25rem * var(--mantine-scale))",
				}}
			>
				{message.editedAt && (
					<EditedBadge
						originalContentJson={message.originalContentJson}
						editedAt={message.editedAt}
						onRestore={
							message.id && onRestoreAssistantMessage
								? () => onRestoreAssistantMessage(message.id as string)
								: undefined
						}
					/>
				)}
				{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
				{blocks.map((block: any, i: number) => {
					const key = blockKeys[i];
					const realIndex = message._blockOriginalIndices?.[i] ?? i;
					if (block.type === "text") {
						if (!block.text?.trim()) return null;
						return (
							<ClampableText
								key={key}
								text={block.text}
								citations={block.citations}
								blockIndex={realIndex}
								streaming={isStreaming}
							/>
						);
					}
					if (block.type === "image") {
						return (
							<BlockMenuWrapper key={key} blockIndex={realIndex}>
								<ImageBlock block={block} imageNarratorId={message.narratorId ?? narratorId} />
							</BlockMenuWrapper>
						);
					}
					if (block.type === "text_file") {
						return (
							<BlockMenuWrapper key={key} blockIndex={realIndex}>
								<TextFileBlock block={block} onOpen={onOpenFilePanel} />
							</BlockMenuWrapper>
						);
					}
					if (block.type === "reasoning" || block.type === "thinking") {
						// Absorbed into an earlier run's merged trace — skip.
						if (reasoningSkip.has(i)) return null;
						const run = reasoningRunByStart.get(i);
						const runBlocks = run?.runBlocks ?? [block];
						const runRealIndices = run?.runRealIndices ?? [realIndex];
						return (
							<ReasoningBlock
								key={key}
								blocks={runBlocks}
								blockIndices={runRealIndices}
								isLastContent={run?.isLastContent ?? true}
								// Per-RUN, not per-message: the live row accumulates the whole turn,
								// so a reasoning run that answer text or a tool call already
								// followed is finished and must settle now rather than stay
								// force-expanded until the turn persists.
								streaming={isLiveStreamingRun(
									isStreaming,
									{
										contentJson: message._allContentJson ?? blocks,
										liveBlockIndex: message.liveBlockIndex,
									},
									runRealIndices,
								)}
								narratorId={narratorId}
								messageId={message.id}
							/>
						);
					}
					if (block.type === "web_search") {
						return (
							<WebSearchBlock
								key={key}
								block={block}
								blockIndex={realIndex}
								messageId={message.id}
							/>
						);
					}
					if (block.type === "image_generation") {
						return (
							<ImageGenerationBlock
								key={key}
								block={block as ImageGenerationBlockData}
								blockIndex={realIndex}
							/>
						);
					}
					if (block.type === "tool_use") {
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						const tc = message.toolCalls?.find((t: any) => t.toolUseId === block.id);
						const toolCallData = {
							id: tc?.id,
							toolName: block.name,
							toolUseId: block.id,
							inputJson: tc?.inputJson ?? block.input,
							outputJson: tc?.outputJson,
							status: tc?.status ?? "running",
							durationMs: tc?.durationMs,
							streamStartedAt: block.streamStartedAt ?? tc?.streamStartedAt,
							permissionStartedAt: block.permissionStartedAt ?? tc?.permissionStartedAt,
							executionStartedAt: block.executionStartedAt ?? tc?.executionStartedAt,
							completedAt: block.completedAt ?? tc?.completedAt,
							createdAt: block.tcCreatedAt ?? tc?.createdAt,
							errorMessage: tc?.errorMessage,
							permissionDecisionReason: tc?.permissionDecisionReason,
							permissionSuggestions: tc?.permissionSuggestions,
							// startedAt: 工具开始执行的时间戳（由 mergeFieldsByIndex 写入），
							// 用于 BashTerminateButton 本地计时器计算已运行时长
							startedAt:
								typeof block.startedAt === "number" && Number.isFinite(block.startedAt)
									? block.startedAt
									: tc?.startedAt,
							_metadata: tc?._metadata,
							// _longRunning: 由 WS tool_long_running 事件通过 mergeFieldsByIndex 设置
							_longRunning: tc?._longRunning,
							_streamingOutput: tc?._streamingOutput,
							_timeoutMs: tc?._timeoutMs,
						};
						const perm = resolvePerm?.(toolCallData) ?? null;
						return (
							<ToolCallCard
								key={key}
								toolCall={toolCallData}
								narratorId={narratorId}
								pendingPermission={perm}
								onPermissionDecision={onPermissionDecision}
								onQuestionSubmit={onQuestionSubmit}
								onQuestionReflect={onQuestionReflect}
								onQuestionDeny={onQuestionDeny}
								onViewSubagentSession={onViewSubagentSession}
								onOpenFilePanel={onOpenFilePanel}
								blockIndex={realIndex}
							/>
						);
					}
					return null;
				})}
			</div>
		</MessageContextMenuCtx.Provider>
	);
}, messageBubbleAreEqual);
