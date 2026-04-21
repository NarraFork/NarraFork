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
	IconArrowsMinimize,
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconEye,
	IconEyeCheck,
	IconFile,
	IconGitFork,
	IconGitMerge,
	IconLanguage,
	IconListCheck,
	IconMessageQuestion,
	IconRepeat,
	IconTrash,
	IconWorldSearch,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useSwipeMenu } from "../../hooks/useSwipeMenu";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api, getToken } from "../../lib/api";
import { UserAvatar } from "../UserAvatar";
import { AskInPassingPendingCard, AskInPassingResolvedCard } from "./AskInPassingCard";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import { MarkdownContent } from "./MarkdownContent";
import {
	type MessageContextMenuActions,
	MessageContextMenuCtx,
	useMessageContextMenu,
} from "./MessageContextMenuCtx";
import { BLOCK_ID_ATTR, useMessageSelection } from "./MessageSelectionCtx";
import { generateBlockKeys } from "./message-segments";
import {
	getCategory,
	getCategoryColor,
	getCategoryIcon,
	type PendingPermission,
	ToolCallCard,
} from "./ToolCallCard";

// Module-level map that persists reasoning expand/collapse state across
// component remounts (e.g. when streaming __streaming__ → real message).
// Key: `${narratorId}:${blockIndex}`, Value: expanded (true) or collapsed (false).
// Only written when the user explicitly toggles — blocks without an entry
// always follow the global preference (narrafork_expand_reasoning).
const reasoningExpandState = new Map<string, boolean>();

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
		messageUuid?: string | null;
		commandText?: string | null;
		createdAt?: string | null;
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
	onQuestionDeny?: (requestId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	onEditAndRegenerate?: (messageId: string, newContent: string, rollback: boolean) => void;
	/** Whether this is the last user message in the conversation */
	isLastUserMessage?: boolean;
	/** Whether the narrator is bound to a chapter (has git support) */
	hasChapter?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
function WebSearchBlock({
	block,
	blockIndex,
	messageId,
}: {
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
	const blockIdStr = `ws-${wsInstanceId.current}`;
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
			if (sel && sel.toString().trim().length > 0) return;
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
			if (!selection.selectionMode) {
				const sel = window.getSelection();
				if (sel && sel.toString().trim().length > 0) return;
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
		msgCtx.onDeleteBlock
	);
	const menuItemsNode = (
		<>
			{hasMenuActions && (
				<>
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
						<Menu.Item
							leftSection={<IconArrowsMinimize size={14} />}
							onClick={() => {
								msgCtx.onCompactBeforeMessage?.();
								swipe.closeSwipe();
							}}
						>
							{t("contextMenu_compactBefore")}
						</Menu.Item>
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
						zIndex: 1000,
						transition: swipe.swipeMenuTransition,
						pointerEvents: swipe.swipeClosing ? "none" : "auto",
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

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function ImageBlock({ block, imageNarratorId }: { block: any; imageNarratorId?: string }) {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);

	useEffect(() => {
		if (block.previewUrl || !imageNarratorId || !block.imageId) return;

		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;

		let cancelled = false;
		let objectUrl: string | null = null;
		fetch(`/api/uploads/${imageNarratorId}/${block.imageId}`, { headers })
			.then((res) => (res.ok ? res.blob() : null))
			.then((blob) => {
				if (blob && !cancelled) {
					objectUrl = URL.createObjectURL(blob);
					setBlobUrl(objectUrl);
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [imageNarratorId, block.imageId, block.previewUrl]);

	const src = block.previewUrl ?? blobUrl;

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
				onClick={() => window.open(src, "_blank")}
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
		const persistedState = persistKey != null ? reasoningExpandState.get(persistKey) : undefined;
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
		const blockIdStr = `rb-${rbInstanceId.current}`;
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
				if (sel && sel.toString().trim().length > 0) return;
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
				// Don't interfere with text selection — but when block selection
				// is already active, Shift+Click should always do range-select.
				if (!selection.selectionMode) {
					const sel = window.getSelection();
					if (sel && sel.toString().trim().length > 0) return;
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
				if (persistKey) reasoningExpandState.set(persistKey, next);
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
					<Menu.Item
						leftSection={<IconArrowsMinimize size={14} />}
						onClick={() => {
							msgCtx.onCompactBeforeMessage?.();
							swipe.closeSwipe();
						}}
					>
						{t("contextMenu_compactBefore")}
					</Menu.Item>
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
							zIndex: 1000,
							transition: swipe.swipeMenuTransition,
							pointerEvents: swipe.swipeClosing ? "none" : "auto",
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
						<Collapse in={opened}>{content}</Collapse>
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
			await api.dismissErrorMessage(narratorId, messageId);
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
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);

	const canClick = !isCompacting && narratorId && messageId;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["compact-summary", narratorId, messageId],
		queryFn: () => api.getCompactSummary(narratorId ?? "", messageId ?? ""),
		enabled: opened && !!narratorId && !!messageId,
	});

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
				style={canClick ? { cursor: "pointer" } : undefined}
				onClick={canClick ? open : undefined}
			>
				{isCompacting ? (
					<Loader size={14} color="orange" />
				) : (
					<IconArrowsMinimize size={14} style={{ color: "var(--mantine-color-orange-6)" }} />
				)}
				<Text size="xs" c="orange" td={canClick ? "underline" : undefined}>
					{isCompacting ? t("compacting") : t("compacted")}
				</Text>
			</Group>

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
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const [expanded, setExpanded] = useState(false);

	const canClick = !isCompacting && narratorId && messageId;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["segment-compact-summary", narratorId, messageId],
		queryFn: () => api.getSegmentCompactSummary(narratorId ?? "", messageId ?? ""),
		enabled: opened && !!narratorId && !!messageId,
	});

	const {
		data: hiddenData,
		isLoading: hiddenLoading,
		error: hiddenError,
	} = useQuery({
		queryKey: ["segment-compact-messages", narratorId, messageId],
		queryFn: () => api.getSegmentCompactMessages(narratorId ?? "", messageId ?? ""),
		enabled: expanded && !!narratorId && !!messageId,
	});

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

	return (
		<>
			<Group gap={6} justify="center" py={4}>
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
					onClick={canClick ? open : undefined}
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

			<Collapse in={expanded}>
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
							{hiddenMessages.map((msg) => {
								const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
								const textParts = blocks
									.filter((b) => b.type === "text")
									.map((b) => b.text ?? "")
									.join("\n\n");
								if (!textParts) return null;
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
											{textParts.length > 800 ? `${textParts.slice(0, 800)}…` : textParts}
										</Text>
									</Box>
								);
							})}
						</Stack>
					)}
				</Paper>
			</Collapse>

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

// --- Overseer permission request block (rendered inside user messages) ---

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
function OverseerPermissionRequestBlock({ block }: { block: any }) {
	const { t } = useTranslation("narrator");
	const toolName = block.toolName as string;
	const cat = getCategory(toolName);
	const ToolIcon = getCategoryIcon(cat);
	const color = getCategoryColor(cat);
	const inputJson = block.inputJson as Record<string, unknown> | undefined;
	const inputPreview = inputJson ? JSON.stringify(inputJson, null, 2).slice(0, 1500) : "";

	return (
		<Paper
			p="sm"
			radius="sm"
			withBorder
			style={{ borderColor: "var(--mantine-color-indigo-light)" }}
		>
			<Group gap="xs" mb="xs">
				<ThemeIcon size="sm" variant="light" color="indigo" radius="xl">
					<IconEye size={12} />
				</ThemeIcon>
				<Text size="xs" fw={600} c="indigo">
					{t("overseer_permissionRequest")}
				</Text>
			</Group>
			<Stack gap={6}>
				<Group gap="xs">
					<Text size="xs" c="dimmed" style={{ width: 60 }}>
						{t("overseer_narrator")}
					</Text>
					<Text size="xs">{block.narratorTitle ?? block.narratorId}</Text>
				</Group>
				<Group gap="xs">
					<Text size="xs" c="dimmed" style={{ width: 60 }}>
						{t("overseer_tool")}
					</Text>
					<Badge size="xs" variant="light" color={color} leftSection={<ToolIcon size={10} />}>
						{toolName}
					</Badge>
				</Group>
				<Group gap="xs">
					<Text size="xs" c="dimmed" style={{ width: 60 }}>
						{t("overseer_request")}
					</Text>
					<Code style={{ fontSize: 10 }}>{block.requestId}</Code>
				</Group>
				{inputPreview && (
					<Code block style={{ fontSize: 10, maxHeight: 200, overflow: "auto" }}>
						{inputPreview}
					</Code>
				)}
			</Stack>
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
	onQuestionDeny,
	onCompactBeforeMessage,
	onDeleteBlock,
	onRollbackToBlock,
	onEditAndRegenerate,
	isLastUserMessage,
	hasChapter,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const blockKeys = useMemo(() => generateBlockKeys(blocks), [blocks]);
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const _msgId = message.id;

	// User preferences for send mode
	const { data: userPrefs } = useUserPreferences();

	// Edit mode state for user messages
	const [isEditing, setIsEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [showConfirmModal, setShowConfirmModal] = useState(false);

	// Initialize edit content when entering edit mode
	const startEditing = useCallback(() => {
		const textBlocks = blocks.filter((b: { type: string }) => b.type === "text");
		const fullText = textBlocks
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n\n");
		setEditContent(fullText);
		setIsEditing(true);
	}, [blocks]);

	const cancelEditing = useCallback(() => {
		setIsEditing(false);
		setEditContent("");
		setShowConfirmModal(false);
	}, []);

	const handleConfirmClick = useCallback(() => {
		if (!editContent.trim()) return;
		// If this is the last user message, no confirmation needed
		if (isLastUserMessage) {
			if (!message.id || !onEditAndRegenerate) return;
			onEditAndRegenerate(message.id, editContent.trim(), false);
			setIsEditing(false);
			setEditContent("");
			return;
		}
		setShowConfirmModal(true);
	}, [editContent, isLastUserMessage, message.id, onEditAndRegenerate]);

	const submitEdit = useCallback(
		(rollback: boolean) => {
			if (!message.id || !onEditAndRegenerate || !editContent.trim()) return;
			onEditAndRegenerate(message.id, editContent.trim(), rollback);
			setIsEditing(false);
			setEditContent("");
			setShowConfirmModal(false);
		},
		[message.id, onEditAndRegenerate, editContent],
	);

	// Handle keyboard shortcuts in edit mode
	const handleEditKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== "Enter" || e.nativeEvent.isComposing) return;

			const ctrlEnterMode = (userPrefs?.sendMode ?? "enter") === "ctrl+enter";

			if (ctrlEnterMode) {
				// Ctrl+Enter mode: Ctrl/Cmd+Enter submits, plain Enter inserts newline
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					handleConfirmClick();
				}
			} else {
				// Enter mode (default): Enter submits, Shift/Ctrl/Cmd+Enter inserts newline
				if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
					e.preventDefault();
					handleConfirmClick();
				} else if (e.ctrlKey || e.metaKey) {
					// Ctrl/Cmd+Enter: browsers don't insert a newline by default, do it manually
					e.preventDefault();
					const textarea = e.currentTarget;
					const { selectionStart, selectionEnd } = textarea;
					const before = editContent.slice(0, selectionStart);
					const after = editContent.slice(selectionEnd);
					const newValue = `${before}\n${after}`;
					setEditContent(newValue);
					requestAnimationFrame(() => {
						textarea.selectionStart = textarea.selectionEnd = selectionStart + 1;
					});
				}
			}
		},
		[userPrefs?.sendMode, editContent, handleConfirmClick],
	);

	// Lightweight cache refresh for CompactIndicator/PlanCard — they already
	// call their own delete API, so we only need to invalidate the messages
	// query instead of firing another delete request via onDeleteBlock.
	const invalidateMessages = useCallback(
		() => qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] }),
		[qc, narratorId],
	);

	// Build message-level context menu actions for ContentViewer to consume
	const navigate = useNavigate();

	// Detect overseer permission request blocks
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const overseerBlock = blocks.find((b: any) => b.type === "overseer_permission_request");
	const isOverseerMessage = !!overseerBlock;

	const ctxActions = useMemo<MessageContextMenuActions>(() => {
		// Overseer messages: only show "jump to source narrator"
		if (isOverseerMessage && overseerBlock?.narratorId) {
			return {
				onJumpToSource: () => {
					navigate({
						to: "/narrators/$narratorId",
						params: { narratorId: overseerBlock.narratorId },
					});
				},
			};
		}

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
		if (msgId && onDeleteBlock) {
			actions.onDeleteBlock = (blockIndex: number) => onDeleteBlock(msgId, blockIndex);
		}
		if (msgId && onRollbackToBlock) {
			actions.onRollbackToBlock = (blockIndex: number) => onRollbackToBlock(msgId, blockIndex);
		}
		if (isUser && msgId && onEditAndRegenerate) {
			actions.onEditMessage = startEditing;
		}
		return actions;
	}, [
		isUser,
		isOverseerMessage,
		overseerBlock,
		navigate,
		message.id,
		message.messageUuid,
		onForkFromMessage,
		onAskInPassing,
		onCompactBeforeMessage,
		onDeleteBlock,
		onRollbackToBlock,
		onEditAndRegenerate,
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
				messageId={canNavigate ? message.id : undefined}
				messageCount={segmentCompactBlock.messageCount}
				onDelete={canNavigate ? invalidateMessages : undefined}
			/>
		);
	}

	// System / display messages (compact indicators / plan cards / error notices / info notices)
	if (message.role === "system" || message.role === "disp") {
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
					narratorId={canNavigate ? narratorId : undefined}
					messageId={canNavigate ? message.id : undefined}
					onDelete={canNavigate ? invalidateMessages : undefined}
				/>
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
		const infoBlock = blocks.find((b: any) => b.type === "info");
		if (infoBlock) {
			return (
				<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-dark-6)" }}>
					<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
						{infoBlock.message}
					</Text>
				</Paper>
			);
		}
		return null;
	}

	// User messages — wrap entire bubble in ContentViewer for context menu / swipe
	if (isUser) {
		// Tool-loaded notification — render like an info message, not a user bubble
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const toolLoadedBlock = blocks.find((b: any) => b.type === "tool_loaded");
		if (toolLoadedBlock) {
			return (
				<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-dark-6)" }}>
					<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
						{toolLoadedBlock.text}
					</Text>
				</Paper>
			);
		}

		const fullText = blocks
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.filter((b: any) => b.type === "text" && b.text)
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n\n");
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
								value={editContent}
								onChange={(e) => setEditContent(e.currentTarget.value)}
								onKeyDown={handleEditKeyDown}
								autosize
								minRows={2}
								maxRows={10}
							/>
							<Group gap="xs" justify="flex-end">
								<Button size="xs" variant="subtle" onClick={cancelEditing}>
									{t("editCancel")}
								</Button>
								<Button size="xs" onClick={handleConfirmClick} disabled={!editContent.trim()}>
									{t("editSubmit")}
								</Button>
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
										if (block.type === "overseer_permission_request") {
											return <OverseerPermissionRequestBlock key={key} block={block} />;
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
	return (
		<MessageContextMenuCtx.Provider value={ctxActions}>
			<Stack gap={4} style={{ minWidth: 0 }}>
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
								onQuestionDeny={onQuestionDeny}
								blockIndex={realIndex}
							/>
						);
					}
					return null;
				})}
			</Stack>
		</MessageContextMenuCtx.Provider>
	);
});
