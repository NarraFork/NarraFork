/**
 * VListRowInteraction.tsx — Per-row interaction layer for the pretext vlist.
 *
 * Wraps one rendered row body with the same interaction surface the chunked
 * path gives each block (ContentViewer / ReasoningBlock / ToolCallCard):
 *   - touch left-swipe reveal menu + desktop right-click context menu
 *     (both render the same menu items, via useSwipeMenu)
 *   - Ctrl/Cmd+Click toggle + Shift+Click range multi-select
 *   - selected-state outline (+ mobile selection offset)
 *   - the data-block-id / data-message-id / data-block-index DOM contract the
 *     selection toolbar & DOM fallbacks rely on
 *
 * Menu contents come in two tiers:
 *   1. shared message actions (copy / rollback / fork / ask-in-passing /
 *      compact / delete / edit), built by vlist-row-actions.buildRowCtxActions —
 *      plus "view original" for an edited message, which arrives as its own prop
 *      (the shell owns the single modal instance; this layer only calls back);
 *   2. card-specific command items for tool & subagent rows — open child
 *      session, detach to background, cancel background task, inspect tool
 *      call, copy file path, view file — gated by the row's tool metadata
 *      (vlist-tool-meta.ts) exactly like ToolCallCard / SubagentCard gate them.
 *
 * The inspector & file-preview modals are lazy AND only mounted while open, so
 * scrolling rows pay for neither.
 *
 * It is deliberately a self-contained child component: all swipe/menu state
 * lives inside this row, so interacting with one row never re-renders the
 * parent PretextExactMessageList (which would recompute virtualization). The
 * menu itself is mounted lazily — only while swiping or while the context menu
 * is open — so scrolling rows carry zero menu cost.
 *
 * This lives inside vlist/ (so it may import the outer hooks) and is only ever
 * rendered by PretextExactMessageList, preserving the module-isolation guard.
 */

import { usePlatform } from "@frontend/hooks/usePlatform";
import { useSwipeMenu } from "@frontend/hooks/useSwipeMenu";
import type { ToolCallDetailRef } from "@frontend/lib/api/narrators";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Z } from "@frontend/lib/z-index";
import { Box, Menu } from "@mantine/core";
import { useClipboard, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowBackUp,
	IconArrowsMaximize,
	IconCheck,
	IconCloudOff,
	IconCopy,
	IconEdit,
	IconEye,
	IconFileText,
	IconGitFork,
	IconInfoCircle,
	IconMessageQuestion,
	IconPencil,
	IconPlayerStop,
	IconRefresh,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CompactMenuSub } from "../compact/CompactMenuSub";
import { useRenderInteractive } from "../lod/RenderLodCtx";
import type { MessageContextMenuActions } from "../message/MessageContextMenuCtx";
import {
	BLOCK_ID_ATTR,
	BLOCK_INDICES_ATTR,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "../message/MessageSelectionCtx";
import { useToolEditNavigation } from "../useToolEditNavigation";
import type { VListRowToolActions } from "./vlist-row-actions";
import type { VListToolMeta } from "./vlist-tool-meta";

// The inspector / file preview are only ever needed once a user picks the menu
// item, so both are lazy: a scrolling list never pays for their module graph
// (ToolCallInspector pulls ContentViewer + Timeline; FilePreviewModal pulls the
// fs-preview fetch path and Shiki language resolution).
const ToolCallInspector = lazy(() =>
	import("../tool-call/ToolCallInspector").then((m) => ({ default: m.ToolCallInspector })),
);
const FilePreviewModal = lazy(() =>
	import("../file-panel/FilePreviewModal").then((m) => ({ default: m.FilePreviewModal })),
);
const ContentInspector = lazy(() =>
	import("../content/ContentInspector").then((m) => ({ default: m.ContentInspector })),
);

const SWIPE_REVEAL_WIDTH = 180;
const FIXED_MENU_TRANSITION_PROPS = { duration: 0 };

export interface VListRowInteractionProps {
	/** Selection-system blockId (msg-… | tc-… | sa-…). */
	blockId: string;
	/** Owning message id for the DOM contract. */
	messageId: string;
	/** Primary block index for the DOM contract. */
	blockIndex: number;
	/** All source block indices (reasoning runs); emitted as data-block-indices. */
	blockIndices?: readonly number[];
	/** Text copied by the "copy" menu item; omitted → no copy item. */
	copyText?: string;
	/** Closed-over per-row menu actions (already bound to messageId/blockIndex). */
	actions: MessageContextMenuActions;
	/**
	 * Owning panel narrator id — required by the tool-call inspector. Absent →
	 * the inspect item is hidden.
	 */
	narratorId?: string;
	/**
	 * Tool-call id behind this row (tc-/sa- rows only). Drives the inspect item.
	 */
	toolUseId?: string;
	/** Card-owned request identity; never derive refs from the selection messageId. */
	toolDetailRef?: ToolCallDetailRef & { toolUseId?: string };
	/** Row tool facts (file path, child narrator, background state). */
	toolMeta?: VListToolMeta;
	/** Card-specific actions already bound to this row's tool. */
	toolActions?: VListRowToolActions;
	/**
	 * Reveal the pre-edit text of an EDITED message. Passed straight from the
	 * shell (never through MessageContextMenuActions, which the chunked path
	 * shares) and present only when the row's message carries `editedAt`. This
	 * layer only invokes the callback — the modal itself is a single shell-level
	 * instance, so a scrolling list never mounts one per row.
	 */
	onViewOriginal?: () => void;
	/**
	 * Open this row's MAIN body in the shell's fullscreen viewer.
	 *
	 * A single item on purpose: a row can host several readable bodies (a tool card
	 * has command + output), and one menu entry cannot say which. The per-body
	 * controls — including wrap and source — live on each body's own hover action
	 * bar, where the target is unambiguous. Absent → the item is hidden (aggregate
	 * traces, system cards and anything with no readable text).
	 */
	onOpenFullscreen?: () => void;
	/**
	 * Verbatim model-facing content for the "what the model saw" inspector, for rows
	 * that speak FOR somebody (a system injection) rather than run a tool. Present →
	 * an inspect item opens the generic ContentInspector with this exact text; absent
	 * → the item is hidden. Independent of `toolUseId` (which drives the tool dump).
	 */
	inspectContent?: { title: string; text: string };
	/** Row body (the pure renderer's output). */
	children: ReactNode;
}

/**
 * One interactive vlist row. The wrapper Box carries the swipe transform and
 * selection outline; the menus are portaled to document.body.
 */
export function VListRowInteraction({
	blockId,
	messageId,
	blockIndex,
	blockIndices,
	copyText,
	actions: msgCtx,
	narratorId,
	toolUseId,
	toolDetailRef,
	toolMeta,
	toolActions,
	onViewOriginal,
	onOpenFullscreen,
	inspectContent,
	children,
}: VListRowInteractionProps) {
	const interactive = useRenderInteractive();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const selection = useMessageSelection();
	const { t } = useTranslation("common");
	const { t: tNarrator } = useTranslation("narrator");
	const platform = usePlatform();
	const filePathClipboard = useClipboard({ timeout: 1500 });
	// Both modals stay unmounted until their menu item fires (and are torn down
	// on close), so an idle row carries no modal cost.
	const [inspectorOpened, setInspectorOpened] = useState(false);
	const [previewOpened, setPreviewOpened] = useState(false);
	const [contentInspectorOpened, setContentInspectorOpened] = useState(false);
	const editNavigation = useToolEditNavigation({
		toolName: toolMeta?.toolName,
		narratorId,
		toolUseId: toolDetailRef?.toolUseId ?? toolUseId,
		toolDetailRef,
		filePath: toolMeta?.filePath,
	});

	const isSelected = selection.selectedBlockIds.has(blockId);

	const handleDeselectBlock = useCallback(() => {
		selection.deselectBlock(blockId);
	}, [selection.deselectBlock, blockId]);

	const swipe = useSwipeMenu({
		enabled: interactive,
		touchEnabled: interactive,
		excludeSelectors: [".mantine-Menu-dropdown"],
		blockId,
		onSwipeRight: isSelected ? handleDeselectBlock : undefined,
	});

	// Desktop: right-click opens the context menu (gated on !isMobile like the
	// chunked path; suppressed when a native text selection is active).
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (!interactive || isMobile) return;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 200);
			const flipY = e.clientY > window.innerHeight - 300;
			swipe.setCtxMenuPos({ x, y: e.clientY, flipY });
			swipe.setCtxMenuOpened(true);
		},
		[interactive, isMobile, swipe.setCtxMenuPos, swipe.setCtxMenuOpened],
	);

	// Desktop: Ctrl/Cmd+Click toggles the block, Shift+Click range-selects.
	const handleBlockClick = useCallback(
		(e: React.MouseEvent) => {
			if (!interactive || isMobile) return;
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
				selection.rangeSelectTo(blockId);
			} else {
				selection.toggleBlock(blockId);
			}
		},
		[
			interactive,
			isMobile,
			selection.selectionMode,
			selection.rangeSelectTo,
			selection.toggleBlock,
			blockId,
		],
	);

	// --- Menu items (shared by swipe reveal + context menu) ---
	const hasMessageActions =
		msgCtx.onForkFromMessage ||
		msgCtx.onAskInPassing ||
		msgCtx.onCompactBeforeMessage ||
		msgCtx.onDeleteBlock ||
		msgCtx.onRollbackToBlock ||
		msgCtx.onEditMessage ||
		msgCtx.onCancelQueued ||
		msgCtx.onRetryQueued ||
		onViewOriginal;

	// Card-specific (command-style) items, mirroring what the chunked
	// ToolCallCard / SubagentCard add on top of the shared message menu.
	const canInspect = !!(narratorId && toolUseId);
	const filePath = toolMeta?.filePath;
	const clipboardFilePath = filePath
		? platform === "windows"
			? filePath.replace(/\//g, "\\")
			: filePath
		: "";
	const hasToolActions = !!(
		toolActions?.onViewSubagentSession ||
		toolActions?.onDetachSubagent ||
		toolActions?.onDetachBash ||
		toolActions?.onCancelBackgroundTask ||
		toolActions?.onOpenFilePanel ||
		canInspect ||
		filePath
	);

	// Creating an element still costs work even when no menu mounts it. Keep the
	// closing swipe mounted too: dropping its items early would cut off the fade.
	const showSwipeMenu = interactive && (swipe.swipeOffset > 0 || swipe.swipeClosing);
	const showMenuItems = interactive && (swipe.ctxMenuOpened || showSwipeMenu);
	const showToolMenuItems = showMenuItems && hasToolActions;
	const toolMenuItemsNode = showToolMenuItems ? (
		<>
			{toolActions?.onViewSubagentSession && (
				<Menu.Item
					leftSection={<IconEye size={14} />}
					onClick={() => {
						toolActions.onViewSubagentSession?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("viewSubagentSession")}
				</Menu.Item>
			)}
			{(toolActions?.onDetachSubagent || toolActions?.onDetachBash) && (
				<Menu.Item
					leftSection={<IconCloudOff size={14} />}
					onClick={() => {
						(toolActions.onDetachBash ?? toolActions.onDetachSubagent)?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("detachToBackground")}
				</Menu.Item>
			)}
			{toolActions?.onCancelBackgroundTask && (
				<Menu.Item
					color="red"
					leftSection={<IconPlayerStop size={14} />}
					onClick={() => {
						toolActions.onCancelBackgroundTask?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("backgroundTasks.cancel")}
				</Menu.Item>
			)}
			{canInspect && (
				<Menu.Item
					leftSection={<IconInfoCircle size={14} />}
					onClick={() => {
						setInspectorOpened(true);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("toolCallInspector.inspect")}
				</Menu.Item>
			)}
			{filePath && (
				<Menu.Item
					leftSection={filePathClipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					onClick={() => {
						filePathClipboard.copy(clipboardFilePath);
						swipe.closeSwipe();
					}}
				>
					{filePathClipboard.copied ? t("copied") : tNarrator("contextMenu_copyFilePath")}
				</Menu.Item>
			)}
			{filePath && toolMeta?.isReadTool && (
				<Menu.Item
					leftSection={<IconEye size={14} />}
					onClick={() => {
						setPreviewOpened(true);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_viewFile")}
				</Menu.Item>
			)}
			{(editNavigation.open || toolActions?.onOpenFilePanel) && (
				<Menu.Item
					leftSection={<IconFileText size={14} />}
					onClick={() => {
						if (editNavigation.open) editNavigation.open();
						else toolActions?.onOpenFilePanel?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator(editNavigation.open ? "editPreview.open" : "contextMenu_openFilePanel")}
				</Menu.Item>
			)}
		</>
	) : null;

	const hasViewActions = copyText != null || onOpenFullscreen != null || inspectContent != null;

	const menuItemsNode = showMenuItems ? (
		<>
			{onOpenFullscreen && (
				<Menu.Item
					leftSection={<IconArrowsMaximize size={14} />}
					onClick={() => {
						onOpenFullscreen();
						swipe.closeSwipe();
					}}
				>
					{t("fullscreen")}
				</Menu.Item>
			)}
			{copyText != null && (
				<Menu.Item
					leftSection={<IconCopy size={14} />}
					onClick={() => {
						navigator.clipboard.writeText(copyText);
						swipe.closeSwipe();
					}}
				>
					{t("copy")}
				</Menu.Item>
			)}
			{inspectContent && (
				<Menu.Item
					leftSection={<IconInfoCircle size={14} />}
					onClick={() => {
						setContentInspectorOpened(true);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contentInspector.inspect")}
				</Menu.Item>
			)}
			{hasViewActions && hasToolActions ? <Menu.Divider /> : null}
			{toolMenuItemsNode}
			{(hasViewActions || hasToolActions) && hasMessageActions ? <Menu.Divider /> : null}
			{onViewOriginal && (
				<Menu.Item
					leftSection={<IconPencil size={14} />}
					onClick={() => {
						onViewOriginal();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("viewOriginal")}
				</Menu.Item>
			)}
			{msgCtx.onEditMessage && (
				<Menu.Item
					leftSection={<IconEdit size={14} />}
					onClick={() => {
						msgCtx.onEditMessage?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_edit")}
				</Menu.Item>
			)}
			{msgCtx.onRetryQueued && (
				<Menu.Item
					leftSection={<IconRefresh size={14} />}
					onClick={() => {
						msgCtx.onRetryQueued?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("queuedRetry")}
				</Menu.Item>
			)}
			{msgCtx.onCancelQueued && (
				<Menu.Item
					color="red"
					leftSection={<IconPlayerStop size={14} />}
					onClick={() => {
						msgCtx.onCancelQueued?.();
						swipe.closeSwipe();
					}}
				>
					{tNarrator("cancelBuffer")}
				</Menu.Item>
			)}
			{msgCtx.onRollbackToBlock && blockIndex != null && (
				<Menu.Item
					leftSection={<IconArrowBackUp size={14} />}
					onClick={() => {
						msgCtx.onRollbackToBlock?.(blockIndex);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_rollback")}
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
					{tNarrator("contextMenu_fork")}
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
					{tNarrator("contextMenu_askInPassing")}
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
			{msgCtx.onDeleteBlock && (
				<Menu.Item
					color="red"
					leftSection={<IconTrash size={14} />}
					onClick={() => {
						// Reasoning runs merge several source blocks: delete each.
						for (const bi of blockIndices && blockIndices.length > 0
							? blockIndices
							: [blockIndex]) {
							msgCtx.onDeleteBlock?.(bi);
						}
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_delete")}
				</Menu.Item>
			)}
		</>
	) : null;

	const menuItemsWithCancel = showSwipeMenu ? (
		<>
			{menuItemsNode}
			<Menu.Divider />
			<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
				{t("cancel")}
			</Menu.Item>
		</>
	) : null;

	// Selected visual offset (mobile only) so a selected row matches the anchor's
	// swipe, mirroring ContentViewer's selectionOffset behaviour.
	const showSelectedVisual = isSelected;
	const selectionOffset =
		isMobile && showSelectedVisual && !swipe.swipeRevealed ? SWIPE_REVEAL_WIDTH : 0;
	const effectiveOffset = swipe.swipeOffset > 0 ? swipe.swipeOffset : selectionOffset;

	if (!interactive) return <>{children}</>;

	return (
		<>
			<Box
				ref={swipe.swipeBoxRef as React.RefObject<HTMLDivElement>}
				data-content-block
				{...{ [BLOCK_ID_ATTR]: blockId }}
				data-message-id={messageId}
				data-block-index={String(blockIndex)}
				{...(blockIndices && blockIndices.length > 1
					? { [BLOCK_INDICES_ATTR]: blockIndices.join(",") }
					: {})}
				onContextMenu={handleContextMenu}
				onClick={handleBlockClick}
				style={{
					height: "100%",
					transform: effectiveOffset > 0 ? `translateX(-${effectiveOffset}px)` : undefined,
					transition: swipe.swipeTransition,
					outline: showSelectedVisual ? "2px solid var(--mantine-color-indigo-6)" : undefined,
					outlineOffset: showSelectedVisual ? -2 : undefined,
					borderRadius: showSelectedVisual ? 4 : undefined,
				}}
			>
				{children}
			</Box>

			{/* Swipe-reveal action menu — portal to body, position:fixed. */}
			{showSwipeMenu &&
				(() => {
					const menuEl = swipe.swipeMenuRef.current;
					const pos = swipe.getSwipeMenuPosition(menuEl?.offsetHeight ?? 200);
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
									{menuItemsWithCancel}
								</Menu.Dropdown>
							</Menu>
						</Box>,
						document.body,
					);
				})()}

			{/* Desktop context menu. */}
			{swipe.ctxMenuOpened && (
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
			)}

			{/* Tool-call inspector — mounted only while open (lazy chunk). */}
			{inspectorOpened && narratorId && toolUseId && (
				<Suspense fallback={null}>
					<ToolCallInspector
						narratorId={narratorId}
						toolUseId={toolDetailRef?.toolUseId ?? toolUseId}
						toolCallId={toolDetailRef?.toolCallId}
						messageId={toolDetailRef?.messageId}
						executionAttempt={toolDetailRef?.executionAttempt}
						opened={inspectorOpened}
						onClose={() => setInspectorOpened(false)}
					/>
				</Suspense>
			)}

			{/* Model-facing content inspector (system injections) — lazy, open-only. */}
			{contentInspectorOpened && inspectContent && (
				<Suspense fallback={null}>
					<ContentInspector
						opened={contentInspectorOpened}
						onClose={() => setContentInspectorOpened(false)}
						title={inspectContent.title}
						content={inspectContent.text}
					/>
				</Suspense>
			)}

			{/* File preview (Read tool) — mounted only while open (lazy chunk). */}
			{editNavigation.modal}
			{previewOpened && filePath && (
				<Suspense fallback={null}>
					<FilePreviewModal
						filePath={filePath}
						opened={previewOpened}
						onClose={() => setPreviewOpened(false)}
					/>
				</Suspense>
			)}
		</>
	);
}
