/**
 * TraceRowInteraction.tsx — Interaction surface for ONE folded trace row.
 *
 * At low LOD a tool-run collapses into a trace of single-line rows (the L1/L2
 * ActivityTrace). Those rows had no interaction surface,
 * so this wrapper gives each one the same affordances an expanded card has:
 *   - desktop right-click context menu
 *   - touch left-swipe reveal menu (+ swipe range-select, right-swipe deselect)
 *   - Ctrl/Cmd+Click toggle and Shift+Click range multi-select
 *   - selected-state outline (+ mobile selection offset)
 *   - the data-block-id / data-message-id / data-block-index DOM contract the
 *     selection toolbar and DOM fallbacks rely on
 *
 * Menu contents mirror the expanded card: the shared message actions from
 * MessageContextMenuActions, plus tool-specific items (inspect / copy file path /
 * view file / view subagent session) gated on the row's TraceRowIdentity.
 *
 * ── Height neutrality (load-bearing for the vlist path) ──
 * The vlist predicts every row's height arithmetically with zero DOM measurement,
 * so this wrapper must not change layout: selection uses `outline` (which does not
 * occupy space), both menus are portaled to document.body, and the inspector /
 * preview modals are lazy AND mounted only while open. An idle row therefore pays
 * nothing and measures exactly as before.
 *
 * ── Placement ──
 * Deliberately OUTSIDE vlist/ so BOTH render paths can use it: the isolation guard
 * forbids non-vlist files from statically importing vlist/, but not the reverse.
 * Structurally this mirrors vlist/VListRowInteraction (which wraps a whole list
 * element); this one wraps a single row inside a trace.
 */

import { usePlatform } from "@frontend/hooks/usePlatform";
import { useSwipeMenu } from "@frontend/hooks/useSwipeMenu";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Z } from "@frontend/lib/z-index";
import { Box, Menu } from "@mantine/core";
import { useClipboard, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowBackUp,
	IconCheck,
	IconCloudOff,
	IconCopy,
	IconEye,
	IconFileText,
	IconGitFork,
	IconInfoCircle,
	IconMessageQuestion,
	IconPlayerStop,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CompactMenuSub } from "./CompactMenuSub";
import type { MessageContextMenuActions } from "./MessageContextMenuCtx";
import {
	BLOCK_ID_ATTR,
	BLOCK_INDICES_ATTR,
	shouldIgnoreMessageBlockSelection,
	useMessageSelection,
} from "./MessageSelectionCtx";
import { useRenderInteractive } from "./RenderLodCtx";
import type { TraceRowIdentity } from "./trace-row-identity";

// Both modals are only needed once a menu item fires, so both are lazy: a
// scrolling trace never pays for their module graph (ToolCallInspector pulls
// ContentViewer + Timeline; FilePreviewModal pulls the fs-preview fetch path).
const ToolCallInspector = lazy(() =>
	import("./ToolCallInspector").then((m) => ({ default: m.ToolCallInspector })),
);
const FilePreviewModal = lazy(() =>
	import("./FilePreviewModal").then((m) => ({ default: m.FilePreviewModal })),
);

const SWIPE_REVEAL_WIDTH = 180;
const FIXED_MENU_TRANSITION_PROPS = { duration: 0 };

/**
 * True when a click carries a selection modifier. Trace rows are also toggles
 * (chevron expand), so callers must consult this BEFORE running their own
 * toggle: a modified click selects instead of expanding.
 */
export function isTraceRowSelectionClick(e: {
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
}): boolean {
	return !!(e.metaKey || e.ctrlKey || e.shiftKey);
}

export interface TraceRowInteractionProps {
	/** Resolved row identity (blockId / message coords / tool facts). */
	identity: TraceRowIdentity;
	/** Closed-over message-level actions for this row's message. */
	actions: MessageContextMenuActions;
	/** Owning panel narrator id — required by the inspector; absent → item hidden. */
	narratorId?: string;
	/**
	 * Open a child narrator's session (subagent rows + resolved Await-agent rows);
	 * absent → item hidden.
	 */
	onViewSubagentSession?: (narratorId: string) => void;
	/**
	 * Detach a running subagent to a background task. Supplied by the panel (which
	 * owns the capability gating and the api call, exactly as it does for the vlist
	 * path); absent → item hidden.
	 */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task; absent → item hidden. */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/**
	 * Open a file-oriented tool's path in a read-only dock panel. Supplied only by
	 * hosts that own a dockview surface; absent → item hidden.
	 */
	onOpenFilePanel?: (filePath: string) => void;
	/** Row body (the trace row's own markup). */
	children: ReactNode;
}

/**
 * One interactive trace row. The wrapper Box carries the swipe transform and the
 * selection outline; menus and modals are portaled / lazily mounted.
 */
export function TraceRowInteraction({
	identity,
	actions: msgCtx,
	narratorId,
	onViewSubagentSession,
	onDetachSubagent,
	onCancelBackgroundTask,
	onOpenFilePanel,
	children,
}: TraceRowInteractionProps) {
	const interactive = useRenderInteractive();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const selection = useMessageSelection();
	const { t } = useTranslation("common");
	const { t: tNarrator } = useTranslation("narrator");
	const platform = usePlatform();
	const filePathClipboard = useClipboard({ timeout: 1500 });
	const [inspectorOpened, setInspectorOpened] = useState(false);
	const [previewOpened, setPreviewOpened] = useState(false);

	const { blockId, messageId, blockIndex, blockIndices, copyText, tool } = identity;
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

	// Desktop: right-click opens the context menu (suppressed while a native text
	// selection is active, matching the card paths).
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

	// Desktop: Ctrl/Cmd+Click toggles this row, Shift+Click range-selects. The
	// click is stopped here so the row's own expand toggle does not also fire.
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
			e.stopPropagation();
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
		msgCtx.onRollbackToBlock;

	const canInspect = !!(narratorId && tool?.toolUseId);
	const filePath = tool?.filePath;
	const clipboardFilePath = filePath
		? platform === "windows"
			? filePath.replace(/\//g, "\\")
			: filePath
		: "";
	// A subagent card knows its child directly; an Await-agent row knows it only
	// once its target resolved. Both open the same session.
	const sessionNarratorId = tool?.subagentNarratorId ?? tool?.awaitAgentNarratorId;
	const canViewSession = !!(sessionNarratorId && onViewSubagentSession);
	// Background lifecycle actions only ever apply to a real child narrator, and
	// only while it is still running (the gating the chunked subagent menu used).
	const childNarratorId = tool?.subagentNarratorId;
	const canDetach = !!(
		childNarratorId &&
		onDetachSubagent &&
		!tool?.isBackground &&
		!tool?.isTerminal
	);
	const canCancelBackground = !!(
		childNarratorId &&
		onCancelBackgroundTask &&
		tool?.isBackground &&
		!tool?.isTerminal
	);
	// The file panel opens for any file-oriented tool (Read / Write / Edit): it
	// shows the file's CURRENT on-disk content, so a write is a valid entry point.
	const canOpenFilePanel = !!(filePath && tool?.isFileTool && onOpenFilePanel);
	const hasToolActions = !!(
		canViewSession ||
		canDetach ||
		canCancelBackground ||
		canInspect ||
		canOpenFilePanel ||
		filePath
	);

	const toolMenuItemsNode = hasToolActions ? (
		<>
			{canViewSession && (
				<Menu.Item
					leftSection={<IconEye size={14} />}
					onClick={() => {
						if (sessionNarratorId) onViewSubagentSession?.(sessionNarratorId);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("viewSubagentSession")}
				</Menu.Item>
			)}
			{canDetach && (
				<Menu.Item
					leftSection={<IconCloudOff size={14} />}
					onClick={() => {
						if (childNarratorId) onDetachSubagent?.(childNarratorId);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("detachToBackground")}
				</Menu.Item>
			)}
			{canCancelBackground && (
				<Menu.Item
					color="red"
					leftSection={<IconPlayerStop size={14} />}
					onClick={() => {
						if (childNarratorId) onCancelBackgroundTask?.(childNarratorId);
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
			{filePath && tool?.isReadTool && (
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
			{canOpenFilePanel && (
				<Menu.Item
					leftSection={<IconFileText size={14} />}
					onClick={() => {
						if (filePath) onOpenFilePanel?.(filePath);
						swipe.closeSwipe();
					}}
				>
					{tNarrator("contextMenu_openFilePanel")}
				</Menu.Item>
			)}
		</>
	) : null;

	const menuItemsNode = (
		<>
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
			{copyText != null && hasToolActions ? <Menu.Divider /> : null}
			{toolMenuItemsNode}
			{(copyText != null || hasToolActions) && hasMessageActions ? <Menu.Divider /> : null}
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
						// A reasoning run folds several source blocks into these rows:
						// delete each one it represents.
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
	);

	const menuItemsWithCancel = (
		<>
			{menuItemsNode}
			<Menu.Divider />
			<Menu.Item leftSection={<IconX size={14} />} onClick={() => swipe.closeSwipe()}>
				{t("cancel")}
			</Menu.Item>
		</>
	);

	// Selected rows shift with the anchor's swipe on mobile, mirroring the card paths.
	const selectionOffset = isMobile && isSelected && !swipe.swipeRevealed ? SWIPE_REVEAL_WIDTH : 0;
	const effectiveOffset = swipe.swipeOffset > 0 ? swipe.swipeOffset : selectionOffset;

	if (!interactive) return <>{children}</>;

	return (
		<>
			<Box
				ref={swipe.swipeBoxRef as React.RefObject<HTMLDivElement>}
				data-content-block
				data-trace-row
				{...{ [BLOCK_ID_ATTR]: blockId }}
				data-message-id={messageId}
				data-block-index={String(blockIndex)}
				{...(blockIndices && blockIndices.length > 1
					? { [BLOCK_INDICES_ATTR]: blockIndices.join(",") }
					: {})}
				onContextMenu={handleContextMenu}
				onClick={handleBlockClick}
				style={{
					// `outline` (not border) keeps the row's box model — and therefore the
					// vlist's predicted height — untouched while selected.
					transform: effectiveOffset > 0 ? `translateX(-${effectiveOffset}px)` : undefined,
					transition: swipe.swipeTransition,
					outline: isSelected ? "2px solid var(--mantine-color-indigo-6)" : undefined,
					outlineOffset: isSelected ? -1 : undefined,
					borderRadius: isSelected ? 4 : undefined,
				}}
			>
				{children}
			</Box>

			{/* Swipe-reveal action menu — portal to body, position:fixed. */}
			{(swipe.swipeOffset > 0 || swipe.swipeClosing) &&
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
			{inspectorOpened && narratorId && tool?.toolUseId && (
				<Suspense fallback={null}>
					<ToolCallInspector
						narratorId={narratorId}
						toolUseId={tool.toolUseId}
						opened={inspectorOpened}
						onClose={() => setInspectorOpened(false)}
					/>
				</Suspense>
			)}

			{/* File preview (Read tool) — mounted only while open (lazy chunk). */}
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
