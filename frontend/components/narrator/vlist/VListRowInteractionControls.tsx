/** Deferred menus, navigation and inspector state; the shell owns the first gesture. */
import { usePlatform } from "@frontend/hooks/usePlatform";
import type { useSwipeMenu } from "@frontend/hooks/useSwipeMenu";
import { Z } from "@frontend/lib/z-index";
import { Box, Menu } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
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
import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CompactMenuSub } from "../compact/CompactMenuSub";
import { useToolEditNavigation } from "../useToolEditNavigation";
import type { VListRowInteractionProps } from "./VListRowInteraction";

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

type VListRowInteractionControlsProps = Omit<
	VListRowInteractionProps,
	"children" | "blockId" | "messageId" | "selected" | "onToggleSelect"
> & { swipe: ReturnType<typeof useSwipeMenu> };

export function VListRowInteractionControls({
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
	swipe,
}: VListRowInteractionControlsProps) {
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
	const showSwipeMenu = swipe.swipeOffset > 0 || swipe.swipeClosing;
	const showMenuItems = swipe.ctxMenuOpened || showSwipeMenu;
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
			{msgCtx.customItems && msgCtx.customItems.length > 0 ? (
				<>
					<Menu.Divider />
					{msgCtx.customItems.map((item) => (
						<Menu.Item
							key={item.key}
							color={item.danger ? "red" : undefined}
							leftSection={item.icon}
							onClick={() => {
								item.onClick();
								swipe.closeSwipe();
							}}
						>
							{item.label}
						</Menu.Item>
					))}
				</>
			) : null}
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

	return (
		<>
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
