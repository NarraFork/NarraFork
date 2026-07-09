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
	NumberInput,
	Paper,
	ScrollArea,
	Skeleton,
	Spoiler,
	Stack,
	Text,
	Textarea,
	TextInput,
	ThemeIcon,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
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
	IconEyeCheck,
	IconFile,
	IconGitFork,
	IconGitMerge,
	IconLanguage,
	IconListCheck,
	IconLock,
	IconMessageQuestion,
	IconNotebook,
	IconPencil,
	IconPhoto,
	IconRepeat,
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
import { useFileSystemCapability, useUploadCapability } from "../../hooks/usePlatform";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import {
	ApiError,
	api,
	clearToken,
	getToken,
	readFetchError,
	type SideCarRecord,
} from "../../lib/api";
import { Z } from "../../lib/z-index";
import { useImageViewer } from "../common/ImageViewerProvider";
import { UserAvatar } from "../UserAvatar";
import { AskInPassingPendingCard, AskInPassingResolvedCard } from "./AskInPassingCard";
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
import {
	BLOCK_ID_ATTR,
	makeMessageBlockSelectionId,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "./MessageSelectionCtx";
import { generateBlockKeys } from "./message-segments";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	resizeImageIfNeeded,
} from "./narrator-panel-types";
import { useRenderLod } from "./RenderLodCtx";
import { hasVisibleSideCars, SideCarNotice } from "./SideCarNotice";
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
const MAX_USER_MESSAGE_DISPLAY_CHARS = 120_000;
const MAX_USER_MESSAGE_EDIT_CHARS = 200_000;
const MAX_ASSISTANT_MESSAGE_EDIT_CHARS = 100_000;

function collectTextBlocksPreview(
	blocks: Array<{ type?: string; text?: unknown }>,
	maxChars: number,
): { text: string; truncated: boolean } {
	let result = "";
	let truncated = false;
	for (const block of blocks) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		const separator = result ? "\n\n" : "";
		const remaining = maxChars - result.length - separator.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		result += separator;
		if (block.text.length > remaining) {
			result += block.text.slice(0, remaining);
			truncated = true;
			break;
		}
		result += block.text;
	}
	return { text: result, truncated };
}

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
// Allows MessageBubble to register its active editing state so that the
// parent NarratorPanel can wire the bottom send/retry button to trigger
// the edit-and-regenerate flow instead of the default action.
export interface EditingMessageState {
	/** Submit the current edit (equivalent to clicking "Save & Retry") */
	submit: () => void;
	/** Whether the edit content is non-empty and submittable */
	canSubmit: boolean;
}

export const EditingMessageCtx = createContext<{
	register: (state: EditingMessageState) => void;
	unregister: () => void;
}>({
	register: () => {},
	unregister: () => {},
});

export type CompactSummaryKind = "context" | "segment";

export interface CompactSummaryModalTarget {
	kind: CompactSummaryKind;
	narratorId: string;
	messageId: string;
	onDelete?: () => void;
	/** Open directly in edit mode (e.g. for the manual summarize flow). */
	autoEdit?: boolean;
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

function hasEncryptedReasoningMetadata(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const providerMetadata = (block as Record<string, unknown>).providerMetadata;
	if (!providerMetadata || typeof providerMetadata !== "object") return false;

	return Object.values(providerMetadata as Record<string, unknown>).some((metadata) => {
		if (!metadata || typeof metadata !== "object") return false;
		const encrypted = (metadata as Record<string, unknown>).reasoningEncryptedContent;
		return typeof encrypted === "string" && encrypted.length > 0;
	});
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
		sideCars?: SideCarRecord[];
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
		/** Maps each index in the (possibly filtered/reordered) contentJson back to its index in the original contentJson. */
		_blockOriginalIndices?: number[];
	};
	onForkFromMessage?: (messageUuid: string) => void;
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
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		rollback: boolean,
		opts?: { keepImageIds: string[]; newImages: File[] },
	) => void;
	/** Edit assistant message text without deleting later messages or regenerating. */
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	/** Restore an edited assistant message back to its original text, clearing the edit marker. */
	onRestoreAssistantMessage?: (messageId: string) => void;
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
		(prev.id === next.id &&
			prev.narratorId === next.narratorId &&
			prev.role === next.role &&
			prev.contentJson === next.contentJson &&
			prev.contentText === next.contentText &&
			prev.toolCalls === next.toolCalls &&
			prev.sideCars === next.sideCars &&
			prev.messageUuid === next.messageUuid &&
			prev.commandText === next.commandText &&
			prev.createdAt === next.createdAt &&
			prev.editedAt === next.editedAt &&
			prev.originalContentJson === next.originalContentJson &&
			prev._blockOriginalIndices === next._blockOriginalIndices &&
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
		prev.onEditAndRegenerate === next.onEditAndRegenerate &&
		prev.onEditAssistantMessage === next.onEditAssistantMessage &&
		prev.onRestoreAssistantMessage === next.onRestoreAssistantMessage &&
		prev.isLastUserMessage === next.isLastUserMessage &&
		prev.hasChapter === next.hasChapter &&
		sameMessagePayload(prev.message, next.message)
	);
}

/**
 * Small "edited" badge shown above an assistant message whose text was manually
 * edited. Clicking it opens a modal that reveals the original (unedited) text.
 * The edited text is persisted and used for later history; only this edit marker
 * and original-text metadata stay outside the AI provider payload.
 */
function EditedBadge({
	originalContentJson,
	editedAt,
	onRestore,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	originalContentJson?: any[] | null;
	editedAt: string;
	onRestore?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const originalText = useMemo(() => {
		if (!Array.isArray(originalContentJson)) return "";
		return originalContentJson
			.filter((b: { type?: string }) => b?.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("\n\n");
	}, [originalContentJson]);

	const editedTime = useMemo(() => {
		try {
			return new Date(editedAt).toLocaleString();
		} catch {
			return editedAt;
		}
	}, [editedAt]);

	const canViewOriginal = originalText.trim().length > 0;

	const handleRestore = useCallback(() => {
		if (!onRestore) return;
		onRestore();
		close();
	}, [onRestore, close]);

	return (
		<>
			<Tooltip label={canViewOriginal ? t("viewOriginal") : editedTime} withArrow>
				<Badge
					size="xs"
					variant="light"
					color="gray"
					leftSection={<IconPencil size={10} />}
					style={{ cursor: canViewOriginal ? "pointer" : "default", textTransform: "none" }}
					onClick={canViewOriginal ? open : undefined}
				>
					{t("messageEdited")}
				</Badge>
			</Tooltip>
			<Modal opened={opened} onClose={close} title={t("originalContentTitle")} size="lg" centered>
				<Stack gap="xs">
					<Text size="xs" c="dimmed">
						{t("editedAtLabel", { time: editedTime })}
					</Text>
					<Paper p="sm" radius="md" withBorder>
						<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
							{originalText}
						</Text>
					</Paper>
					{onRestore && (
						<Group justify="flex-end">
							<Button
								size="xs"
								variant="light"
								leftSection={<IconArrowBackUp size={14} />}
								onClick={handleRestore}
							>
								{t("restoreOriginal")}
							</Button>
						</Group>
					)}
				</Stack>
			</Modal>
		</>
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
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;

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
	const lod = useRenderLod();
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
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
			if (isMobile || lod === "preview" || !hasMenuActions) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 220);
			const flipY = e.clientY > window.innerHeight - 300;
			setCtxMenuPos({ x, y: e.clientY, flipY });
			setCtxMenuOpened(true);
		},
		[hasMenuActions, isMobile, lod],
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
	const lod = useRenderLod();
	const { t } = useTranslation("narrator");
	const [ctxMenuOpened, setCtxMenuOpened] = useState(false);
	const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0, flipY: false });
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;

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

	if (!hasActions || lod === "preview") return <>{children}</>;

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
	const lod = useRenderLod();
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;

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

	// preview LOD: render the bare card without interaction chrome.
	if (lod === "preview") return <>{children}</>;

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
			.then((res) => {
				if (!res.ok) {
					if (res.status === 401) clearToken();
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
		return <Skeleton h={200} w={300} radius="sm" />;
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

/**
 * Compact 60×60 thumbnail of an already-persisted image, used inside the user
 * message edit mode so the editor can see (and remove) existing attachments.
 * Reuses the same `/api/uploads/:narratorId/:imageId` blob fetch as ImageBlock.
 */
function EditExistingImageThumb({
	block,
	imageNarratorId,
	onRemove,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
	block: any;
	imageNarratorId?: string;
	onRemove: () => void;
}) {
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
			.then((res) => {
				if (!res.ok) {
					if (res.status === 401) clearToken();
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

	return (
		<Box pos="relative" style={{ display: "inline-block" }}>
			{src ? (
				<Image
					src={src}
					alt={block.filename ?? "image"}
					radius="sm"
					h={60}
					w={60}
					fit="cover"
					style={{ cursor: "pointer" }}
					onClick={() => openImageViewer({ src, filename: block.filename, alt: block.filename })}
				/>
			) : (
				<Skeleton h={60} w={60} radius="sm" />
			)}
			<CloseButton
				size="xs"
				radius="xl"
				variant="filled"
				color="dark"
				style={{ position: "absolute", top: -6, right: -6 }}
				onClick={onRemove}
				title={t("removeImage")}
			/>
		</Box>
	);
}

/**
 * 60×60 preview of a freshly-selected (not yet uploaded) image File during edit
 * mode. Manages its own object URL lifecycle.
 */
function EditNewImageThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		const objectUrl = URL.createObjectURL(file);
		setUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [file]);
	return (
		<Box pos="relative" style={{ display: "inline-block" }}>
			{url ? (
				<Image
					src={url}
					alt={file.name}
					radius="sm"
					h={60}
					w={60}
					fit="cover"
					style={{ cursor: "pointer" }}
					onClick={() => url && openImageViewer({ src: url, filename: file.name, alt: file.name })}
				/>
			) : (
				<Skeleton h={60} w={60} radius="sm" />
			)}
			<CloseButton
				size="xs"
				radius="xl"
				variant="filled"
				color="dark"
				style={{ position: "absolute", top: -6, right: -6 }}
				onClick={onRemove}
				title={t("removeImage")}
			/>
		</Box>
	);
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
function TextFileBlock({ block }: { block: any }) {
	return (
		<Group gap={6} py={2}>
			<ThemeIcon size="sm" variant="light" color="gray">
				<IconFile size={14} />
			</ThemeIcon>
			<Text size="sm" fw={500}>
				{block.filename}
			</Text>
			<Text size="xs" c="dimmed">
				({formatFileSize(block.size)})
			</Text>
		</Group>
	);
}

export const ReasoningBlock = memo(
	function ReasoningBlock({
		block,
		streaming,
		narratorId,
		blockIndex,
		messageId,
	}: {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
		block: any;
		streaming?: boolean;
		narratorId?: string;
		blockIndex?: number;
		messageId?: string;
	}) {
		const { t } = useTranslation("narrator");
		const { t: tc } = useTranslation("common");
		const [expandReasoning] = useLocalPref("narrafork_expand_reasoning");

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

		const rawText: string = block.text || block.thinking || "";
		const translatedText: string | undefined = block.translatedText;
		const hasEncryptedReasoning = hasEncryptedReasoningMetadata(block);
		const encryptedPlaceholder = t("reasoningEncryptedPlaceholder");
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

		// --- Block ID, selection, swipe & context menu state ---
		const rbInstanceId = useRef(nextRbInstanceId++);
		const blockIdStr =
			messageId && blockIndex != null
				? makeMessageBlockSelectionId(messageId, blockIndex)
				: `rb-${rbInstanceId.current}`;
		const rootRef = useRef<HTMLDivElement>(null);
		const selection = useMessageSelection();
		const msgCtx = useMessageContextMenu();
		const isMobile = useMediaQuery("(max-width: 768px)") ?? false;

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
			navigator.clipboard.writeText(displayText);
		}, [displayText]);

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
							{opened ? (
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
								{t("reasoningChars", { formatted: displayText.length.toLocaleString() })}
							</Text>
						)}
						{!opened && (
							<Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0, opacity: 0.6 }}>
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
					{!hasToggled.current && opened ? (
						<Collapse expanded={opened}>{content}</Collapse>
					) : (
						<LazyCollapse in={opened}>{content}</LazyCollapse>
					)}
				</Box>
				{swipeMenu}
				{ctxMenu}
			</>
		);
	},
	(prev, next) => {
		return (
			prev.block === next.block &&
			prev.streaming === next.streaming &&
			prev.narratorId === next.narratorId &&
			prev.blockIndex === next.blockIndex &&
			prev.messageId === next.messageId
		);
	},
);

type MessagesCacheMessage = { id?: string };
type MessagesCachePage = { messages?: MessagesCacheMessage[] } & Record<string, unknown>;
type MessagesCacheData = { pages?: MessagesCachePage[] } & Record<string, unknown>;

function removeMessagesFromCache(qc: QueryClient, narratorId: string, deletedMessageIds: string[]) {
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
	const { t: ts } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const [dismissing, setDismissing] = useState(false);
	const [ruleModalOpened, { open: openRuleModal, close: closeRuleModal }] = useDisclosure(false);
	const [ruleDomain, setRuleDomain] = useState("");
	const [ruleStatusCode, setRuleStatusCode] = useState<number | string>("");
	const [ruleKeyword, setRuleKeyword] = useState(message);
	const [ruleNote, setRuleNote] = useState("");
	const [ruleSubmitting, setRuleSubmitting] = useState(false);
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

	const handleAddRule = async () => {
		const code = typeof ruleStatusCode === "number" ? ruleStatusCode : undefined;
		const domain = ruleDomain.trim() || undefined;
		const keyword = ruleKeyword.trim() || undefined;
		if (!domain && !code && !keyword) {
			notifications.show({
				message: ts("retryRuleAtLeastOne"),
				color: "yellow",
			});
			return;
		}
		setRuleSubmitting(true);
		try {
			await api.addRetryRule({
				domain,
				statusCode: code,
				keyword,
				note: ruleNote.trim() || undefined,
			});
			qc.invalidateQueries({ queryKey: ["settings"] });
			notifications.show({
				message: t("markRetryableSuccess"),
				color: "green",
				autoClose: 5000,
			});
			closeRuleModal();
		} catch (err) {
			notifications.show({
				title: t("narratorError"),
				message: err instanceof Error ? err.message : tc("unknownError"),
				color: "red",
			});
		} finally {
			setRuleSubmitting(false);
		}
	};

	return (
		<>
			<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-red-light)" }}>
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
			</Paper>

			<Modal
				opened={ruleModalOpened}
				onClose={closeRuleModal}
				title={t("markRetryableTitle")}
				size="sm"
			>
				<Stack gap="sm">
					<TextInput
						label={ts("retryRuleDomain")}
						placeholder={ts("retryRuleDomainPlaceholder")}
						value={ruleDomain}
						onChange={(e) => setRuleDomain(e.currentTarget.value)}
					/>
					<NumberInput
						label={ts("retryRuleStatusCode")}
						placeholder={ts("retryRuleStatusCodePlaceholder")}
						value={ruleStatusCode}
						onChange={setRuleStatusCode}
						min={100}
						max={599}
						allowDecimal={false}
					/>
					<TextInput
						label={ts("retryRuleKeyword")}
						placeholder={ts("retryRuleKeywordPlaceholder")}
						value={ruleKeyword}
						onChange={(e) => setRuleKeyword(e.currentTarget.value)}
					/>
					<TextInput
						label={ts("retryRuleNote")}
						placeholder={ts("retryRuleNotePlaceholder")}
						value={ruleNote}
						onChange={(e) => setRuleNote(e.currentTarget.value)}
					/>
					<Button onClick={handleAddRule} loading={ruleSubmitting} fullWidth>
						{ts("retryRuleAdd")}
					</Button>
				</Stack>
			</Modal>
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
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const isSegment = target?.kind === "segment";
	const queryKey = target
		? [
				isSegment ? "segment-compact-summary" : "compact-summary",
				target.narratorId,
				target.messageId,
			]
		: ["compact-summary", "closed"];
	const targetKey = target ? `${target.kind}:${target.narratorId}:${target.messageId}` : null;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey,
		queryFn: () => {
			if (!target) return Promise.resolve({ summary: "" });
			return isSegment
				? api.getSegmentCompactSummary(target.narratorId, target.messageId)
				: api.getCompactSummary(target.narratorId, target.messageId);
		},
		enabled: !!target,
		gcTime: COMPACT_DETAIL_QUERY_GC_TIME_MS,
	});

	useEffect(() => {
		if (!targetKey) {
			setEditing(false);
			setEditText("");
			setDeleting(false);
			setSaving(false);
			return;
		}
		setEditing(false);
		setEditText("");
		setDeleting(false);
		setSaving(false);
	}, [targetKey]);

	// Manual-summarize flow: open directly in edit mode once the (usually empty)
	// summary has loaded.
	useEffect(() => {
		if (!target?.autoEdit || isLoading) return;
		setEditText(data?.summary ?? "");
		setEditing(true);
	}, [target?.autoEdit, isLoading, data?.summary]);

	const handleClose = () => {
		onClose();
		setEditing(false);
	};

	const handleDelete = async () => {
		if (!target) return;
		const currentTarget = target;
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
				title:
					currentTarget.kind === "segment" ? t("segmentCompactFailed") : t("deleteMessageFailed"),
				message:
					currentTarget.kind === "segment"
						? t("segmentCompactFailedDesc")
						: t("deleteMessageFailedDesc"),
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
		if (!target) return;
		const currentTarget = target;
		setSaving(true);
		try {
			if (currentTarget.kind === "segment") {
				await api.updateSegmentCompactSummary(
					currentTarget.narratorId,
					currentTarget.messageId,
					editText,
				);
			} else {
				await api.updateCompactSummary(currentTarget.narratorId, currentTarget.messageId, editText);
			}
			queryClient.setQueryData(queryKey, { summary: editText });
			setEditing(false);
			refetch();
		} finally {
			setSaving(false);
		}
	};

	const color = isSegment ? "teal" : "orange";

	return (
		<Modal
			opened={!!target}
			onClose={handleClose}
			title={
				<Group gap="xs">
					<IconArrowsMinimize size={18} style={{ color: `var(--mantine-color-${color}-6)` }} />
					<Text fw={600}>
						{t(isSegment ? "segmentCompactSummaryTitle" : "compactSummaryTitle")}
					</Text>
				</Group>
			}
			size="lg"
		>
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
				data?.summary && (
					<ScrollArea.Autosize mah="70vh">
						<MarkdownContent text={data.summary} />
					</ScrollArea.Autosize>
				)
			)}
			{target && (
				<Group justify="flex-end" mt="md">
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
								{t(isSegment ? "deleteSegmentCompact" : "deleteCompact")}
							</Button>
							<Button variant="light" size="xs" onClick={handleEdit}>
								{t("editCompact")}
							</Button>
						</>
					)}
				</Group>
			)}
		</Modal>
	);
}

function CompactIndicator({
	isCompacting,
	narratorId,
	messageId,
	onDelete,
}: {
	isCompacting: boolean;
	narratorId?: string;
	messageId?: string;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
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
				) : (
					<IconArrowsMinimize size={14} style={{ color: "var(--mantine-color-orange-6)" }} />
				)}
				<Text size="xs" c="orange" td={canClick || canCancel ? "underline" : undefined}>
					{isCompacting ? t("compacting") : t("compacted")}
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
				>
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
						data?.summary && (
							<ScrollArea.Autosize mah="70vh">
								<MarkdownContent text={data.summary} />
							</ScrollArea.Autosize>
						)
					)}
					{canClick && (
						<Group justify="flex-end" mt="md">
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
	onDelete,
}: {
	isCompacting: boolean;
	narratorId?: string;
	messageId?: string;
	messageCount?: number;
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
						? t("segmentCompacting")
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
				>
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
						data?.summary && (
							<ScrollArea.Autosize mah="70vh">
								<MarkdownContent text={data.summary} />
							</ScrollArea.Autosize>
						)
					)}
					{canClick && (
						<Group justify="flex-end" mt="md">
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
		onSuccess: () => {
			closeConfirm();
			close();
			// The backend deletes the merge_summary message during unmerge,
			// so invalidating messages will remove this card from the list.
			onDelete?.();
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
			qc.invalidateQueries({ queryKey: ["chapters"] });
			notifications.show({
				title: t("unmergeSuccess"),
				message: t("unmergeSuccessDesc"),
				color: "green",
			});
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
	isLastUserMessage,
	hasChapter,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const blockKeys = useMemo(() => generateBlockKeys(blocks), [blocks]);
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const _msgId = message.id;

	// Edit mode state for user messages
	const [isEditing, setIsEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [showConfirmModal, setShowConfirmModal] = useState(false);
	// Existing image blocks kept during editing (user can remove some) + newly
	// added image files. Only meaningful for user messages.
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON image blocks
	const [editKeptImages, setEditKeptImages] = useState<any[]>([]);
	const [editNewImages, setEditNewImages] = useState<File[]>([]);
	// Mirror the kept-image count in a ref so the async add-images flow reads the
	// LATEST value (the user may remove a kept image mid-resize) instead of a stale
	// closure capture when computing remaining room.
	const editKeptCountRef = useRef(0);
	editKeptCountRef.current = editKeptImages.length;
	const editFileInputRef = useRef<HTMLInputElement | null>(null);
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const editImageNarratorId = message.narratorId ?? narratorId;
	const hasEditImages = editKeptImages.length > 0 || editNewImages.length > 0;
	const canSubmitEdit = !!editContent.trim() || hasEditImages;

	// Initialize edit content when entering edit mode
	const startEditing = useCallback(() => {
		const maxEditChars = isUser ? MAX_USER_MESSAGE_EDIT_CHARS : MAX_ASSISTANT_MESSAGE_EDIT_CHARS;
		const editPreview = collectTextBlocksPreview(blocks, maxEditChars);
		if (editPreview.truncated) {
			notifications.show({ color: "yellow", message: t("editMessageTooLarge") });
			return;
		}
		setEditContent(editPreview.text);
		// Seed kept-images from the message's existing image blocks (user-only).
		if (isUser) {
			setEditKeptImages(
				blocks.filter(
					(b: { type?: string; imageId?: unknown }) =>
						b.type === "image" && typeof b.imageId === "string",
				),
			);
		} else {
			setEditKeptImages([]);
		}
		setEditNewImages([]);
		setIsEditing(true);
	}, [blocks, isUser, t]);

	const cancelEditing = useCallback(() => {
		setIsEditing(false);
		setEditContent("");
		setShowConfirmModal(false);
		setEditKeptImages([]);
		setEditNewImages([]);
	}, []);

	const resetEditState = useCallback(() => {
		setIsEditing(false);
		setEditContent("");
		setEditKeptImages([]);
		setEditNewImages([]);
	}, []);

	const removeKeptImage = useCallback((imageId: string) => {
		setEditKeptImages((prev) => prev.filter((b) => b.imageId !== imageId));
	}, []);

	const removeNewImage = useCallback((index: number) => {
		setEditNewImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleAddEditImages = useCallback(
		async (files: File[]) => {
			const valid = files.filter(
				(f) => ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_IMAGE_SIZE,
			);
			if (valid.length === 0) return;
			const processed: File[] = [];
			for (const f of valid) {
				// GIF: skip resize (may be animated)
				if (f.type === "image/gif") {
					processed.push(f);
					continue;
				}
				try {
					processed.push(await resizeImageIfNeeded(f, MAX_IMAGE_LONG_EDGE));
				} catch {
					processed.push(f);
				}
			}
			setEditNewImages((prev) => {
				// Read the kept count from the ref so a removal during the await above
				// is reflected here rather than using the stale closure value.
				const room = Math.max(0, 10 - editKeptCountRef.current - prev.length);
				if (processed.length > room) {
					notifications.show({ color: "yellow", message: t("editTooManyImages") });
				}
				return [...prev, ...processed.slice(0, room)];
			});
		},
		[t],
	);

	// Paste images directly into the edit textarea (user messages only).
	const handleEditPaste = useCallback(
		(e: React.ClipboardEvent) => {
			if (!isUser) return;
			const imageFiles: File[] = [];
			for (const item of e.clipboardData.items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) imageFiles.push(file);
				}
			}
			if (imageFiles.length > 0) {
				e.preventDefault();
				void handleAddEditImages(imageFiles);
			}
		},
		[isUser, handleAddEditImages],
	);

	const buildEditImageOpts = useCallback(
		() => ({
			keepImageIds: editKeptImages
				.map((b) => b.imageId)
				.filter((id): id is string => typeof id === "string"),
			newImages: editNewImages,
		}),
		[editKeptImages, editNewImages],
	);

	const handleConfirmClick = useCallback(() => {
		// Assistant messages: persist the edited text without truncating later messages or regenerating.
		if (!isUser) {
			if (!editContent.trim()) return;
			if (!message.id || !onEditAssistantMessage) return;
			onEditAssistantMessage(message.id, editContent.trim());
			setIsEditing(false);
			setEditContent("");
			return;
		}
		// User messages: allow submitting with text and/or at least one image.
		if (!canSubmitEdit) return;
		// If this is the last user message, no confirmation needed
		if (isLastUserMessage) {
			if (!message.id || !onEditAndRegenerate) return;
			onEditAndRegenerate(message.id, editContent.trim(), false, buildEditImageOpts());
			resetEditState();
			return;
		}
		setShowConfirmModal(true);
	}, [
		editContent,
		canSubmitEdit,
		isUser,
		isLastUserMessage,
		message.id,
		onEditAndRegenerate,
		onEditAssistantMessage,
		buildEditImageOpts,
		resetEditState,
	]);

	const submitEdit = useCallback(
		(rollback: boolean) => {
			if (!message.id || !onEditAndRegenerate || !canSubmitEdit) return;
			onEditAndRegenerate(message.id, editContent.trim(), rollback, buildEditImageOpts());
			resetEditState();
			setShowConfirmModal(false);
		},
		[
			message.id,
			onEditAndRegenerate,
			editContent,
			canSubmitEdit,
			buildEditImageOpts,
			resetEditState,
		],
	);

	// Handle keyboard shortcuts in edit mode. Editing a message has no queue
	// semantics, so Enter and Ctrl/Cmd+Enter both submit; Shift+Enter inserts a
	// native newline.
	const handleEditKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
			if (e.shiftKey) return; // native newline
			e.preventDefault();
			handleConfirmClick();
		},
		[handleConfirmClick],
	);

	// Register/unregister editing state with parent NarratorPanel so the
	// bottom send/retry button can trigger the edit submit.
	const editingCtx = useContext(EditingMessageCtx);
	const handleConfirmClickRef = useRef(handleConfirmClick);
	handleConfirmClickRef.current = handleConfirmClick;
	useEffect(() => {
		if (isEditing) {
			editingCtx.register({
				submit: () => handleConfirmClickRef.current(),
				canSubmit: canSubmitEdit,
				// Focus the textarea when editing starts
			});
			const timer = setTimeout(() => {
				editTextareaRef.current?.focus();
			}, 50);
			return () => {
				clearTimeout(timer);
				editingCtx.unregister();
			};
		}
	}, [isEditing, canSubmitEdit, editingCtx]);

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
		if (msgUuid && onForkFromMessage && !isUser) {
			actions.onForkFromMessage = () => onForkFromMessage(msgUuid);
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
			const isCompacting = compactBlock.status === "compacting";
			const isFailed = compactBlock.status === "failed";
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
									{t("compactFailed")}
								</Text>
								<Text size="xs" c="red.9" style={{ whiteSpace: "pre-wrap" }}>
									{compactBlock.error ?? compactBlock.summary ?? t("compactFailedDesc")}
								</Text>
							</Stack>
							<Group gap={4} style={{ flexShrink: 0 }}>
								{narratorId && (
									<Button
										size="compact-xs"
										variant="light"
										color="red"
										onClick={() => {
											api.triggerCompact(narratorId).catch(() => {});
										}}
									>
										{t("retryCompact")}
									</Button>
								)}
								{narratorId && message.id && (
									<Button
										size="compact-xs"
										variant="subtle"
										color="dimmed"
										onClick={() => {
											const messageId = message.id;
											if (!messageId) return;
											api.deleteCompactMessage(narratorId, messageId).then(
												() => invalidateMessages(),
												() => {},
											);
										}}
									>
										{t("dismiss")}
									</Button>
								)}
							</Group>
						</Group>
					</Paper>
				);
			}
			const canNavigate = !isCompacting && narratorId && message.id;
			return (
				<CompactIndicator
					isCompacting={isCompacting}
					narratorId={narratorId}
					messageId={message.id}
					onDelete={canNavigate ? invalidateMessages : undefined}
				/>
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

		// Edit mode UI
		if (isEditing) {
			return (
				<>
					<Paper
						p="sm"
						radius="md"
						style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}
					>
						<Stack gap="xs">
							<Group gap={6}>
								{message.creator && (
									<UserAvatar
										username={message.creator.username}
										avatarColor={message.creator.avatarColor}
										avatarImageId={message.creator.avatarImageId}
										userId={message.creator.id}
										size={20}
										showTooltip={false}
									/>
								)}
								<Text size="xs" fw={600} c="indigo">
									{message.creator?.username ?? t("you")}
								</Text>
							</Group>
							<Textarea
								ref={editTextareaRef}
								value={editContent}
								onChange={(e) => setEditContent(e.currentTarget.value)}
								onKeyDown={handleEditKeyDown}
								onPaste={handleEditPaste}
								autosize
								minRows={2}
								maxRows={10}
							/>
							{hasEditImages && (
								<Group gap="xs">
									{editKeptImages.map((imgBlock) => (
										<EditExistingImageThumb
											key={`kept-${imgBlock.imageId}`}
											block={imgBlock}
											imageNarratorId={editImageNarratorId}
											onRemove={() => removeKeptImage(imgBlock.imageId)}
										/>
									))}
									{editNewImages.map((file, i) => (
										<EditNewImageThumb
											// biome-ignore lint/suspicious/noArrayIndexKey: new images have no stable id
											key={`new-${i}-${file.name}-${file.size}`}
											file={file}
											onRemove={() => removeNewImage(i)}
										/>
									))}
								</Group>
							)}
							<input
								ref={editFileInputRef}
								type="file"
								accept={ACCEPTED_TYPES.join(",")}
								multiple
								style={{ display: "none" }}
								onChange={(e) => {
									const files = Array.from(e.target.files ?? []);
									if (files.length > 0) void handleAddEditImages(files);
									e.target.value = "";
								}}
							/>
							<Group gap="xs" justify="space-between">
								<Tooltip label={t("attachImage")}>
									<ActionIcon
										variant="subtle"
										color="gray"
										onClick={() => editFileInputRef.current?.click()}
										aria-label={t("attachImage")}
									>
										<IconPhoto size={18} />
									</ActionIcon>
								</Tooltip>
								<Group gap="xs">
									<Button size="xs" variant="subtle" onClick={cancelEditing}>
										{t("editCancel")}
									</Button>
									<Button size="xs" onClick={handleConfirmClick} disabled={!canSubmitEdit}>
										{t("editSubmit")}
									</Button>
								</Group>
							</Group>
						</Stack>
					</Paper>
					<Modal
						opened={showConfirmModal}
						onClose={() => setShowConfirmModal(false)}
						title={t("editConfirmTitle")}
						centered
						size="sm"
					>
						<Stack gap="md">
							{hasChapter ? (
								<>
									<Text size="sm">{t("editConfirmDesc")}</Text>
									<Stack gap="xs">
										<Button fullWidth onClick={() => submitEdit(false)}>
											{t("editConfirmKeep")}
										</Button>
										<Button
											fullWidth
											variant="light"
											color="orange"
											onClick={() => submitEdit(true)}
										>
											{t("editConfirmRollback")}
										</Button>
										<Button fullWidth variant="subtle" onClick={() => setShowConfirmModal(false)}>
											{t("editCancel")}
										</Button>
									</Stack>
								</>
							) : (
								<>
									<Text size="sm">{t("editConfirmStandaloneDesc")}</Text>
									<Stack gap="xs">
										<Button fullWidth onClick={() => submitEdit(false)}>
											{t("editConfirmProceed")}
										</Button>
										<Button fullWidth variant="subtle" onClick={() => setShowConfirmModal(false)}>
											{t("editCancel")}
										</Button>
									</Stack>
								</>
							)}
						</Stack>
					</Modal>
				</>
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
								{message.creator && (
									<UserAvatar
										username={message.creator.username}
										avatarColor={message.creator.avatarColor}
										avatarImageId={message.creator.avatarImageId}
										userId={message.creator.id}
										size={20}
										showTooltip={false}
									/>
								)}
								<Text size="xs" fw={600} c="indigo">
									{message.creator?.username ?? t("you")}
								</Text>
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
												? d.toLocaleTimeString([], {
														hour: "2-digit",
														minute: "2-digit",
													})
												: d.toLocaleString([], {
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
											return <TextFileBlock key={key} block={block} />;
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
			<Paper p="sm" radius="md" withBorder>
				<Stack gap="xs">
					<Text size="xs" fw={600} c="dimmed">
						{t("editAssistantTitle")}
					</Text>
					<Textarea
						ref={editTextareaRef}
						value={editContent}
						onChange={(e) => setEditContent(e.currentTarget.value)}
						onKeyDown={handleEditKeyDown}
						autosize
						minRows={3}
						maxRows={16}
					/>
					<Text size="xs" c="dimmed">
						{t("editAssistantHint")}
					</Text>
					<Group gap="xs" justify="flex-end">
						<Button size="xs" variant="subtle" onClick={cancelEditing}>
							{t("editCancel")}
						</Button>
						<Button size="xs" onClick={handleConfirmClick} disabled={!editContent.trim()}>
							{t("editAssistantSubmit")}
						</Button>
					</Group>
				</Stack>
			</Paper>
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
							<ContentViewer
								key={key}
								content={block.text}
								markdown
								contentType="markdown"
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
								<TextFileBlock block={block} />
							</BlockMenuWrapper>
						);
					}
					if (block.type === "reasoning" || block.type === "thinking") {
						return (
							<ReasoningBlock
								key={key}
								block={block}
								streaming={isStreaming}
								narratorId={narratorId}
								blockIndex={realIndex}
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
							errorMessage: tc?.errorMessage,
							permissionDecisionReason: tc?.permissionDecisionReason,
							permissionSuggestions: tc?.permissionSuggestions,
							// startedAt: 工具开始执行的时间戳（由 mergeFieldsByIndex 写入），
							// 用于 BashTerminateButton 本地计时器计算已运行时长
							startedAt: tc?.startedAt,
							_metadata: tc?._metadata,
							// _longRunning: 由 WS tool_long_running 事件通过 mergeFieldsByIndex 设置
							_longRunning: tc?._longRunning,
							_streamingOutput: tc?._streamingOutput,
							_resolvedModel: tc?._resolvedModel,
							_timeoutMs: tc?._timeoutMs,
							sideCars: Array.isArray(tc?.sideCars)
								? tc.sideCars
								: Array.isArray(block.sideCars)
									? block.sideCars
									: undefined,
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
								blockIndex={realIndex}
							/>
						);
					}
					return null;
				})}
				{(() => {
					const userSideCars = message.sideCars?.filter(
						(sideCar: SideCarRecord) => sideCar.target === "user_message",
					);
					return hasVisibleSideCars(userSideCars) ? (
						<SideCarNotice sideCars={userSideCars} />
					) : null;
				})()}
			</div>
		</MessageContextMenuCtx.Provider>
	);
}, messageBubbleAreEqual);
