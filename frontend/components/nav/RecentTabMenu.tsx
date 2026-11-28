/**
 * The recent-tab row menu (right-click, or a left swipe on touch) and the pinned/unpinned
 * divider with its clear button. Split out of `RecentTabs.tsx` so both mount in a test
 * without the list's drag sensors, router and query cache.
 */

import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { Z } from "@frontend/lib/z-index";
import {
	ActionIcon,
	Box,
	Divider,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArchive,
	IconArrowUp,
	IconChevronDown,
	IconChevronRight,
	IconClearAll,
	IconCopy,
	IconFolder,
	IconFolderOff,
	IconFolderPlus,
	IconPencil,
	IconPin,
	IconPinnedOff,
	IconWindowMaximize,
	IconX,
} from "@tabler/icons-react";
import { useLayoutEffect, useState } from "react";
import { useGitIdentityVisibility } from "../../hooks/useGitIdentityVisibility";
import { preloadCreateNarratorModal } from "../narrator/CreateNarratorLazyModal";
import { FolderGitIdentityMenu } from "./FolderGitIdentityMenu";
import { RecentTabDetails } from "./RecentTabDetailCard";
import { TabGitIdentityMenu } from "./TabGitIdentityMenu";

/**
 * The line between pinned and unpinned rows. Always drawn, so the unpinned list starts at
 * a fixed place whether or not anything is pinned. Its right end clears idle sessions:
 * revealed on hover with a mouse, always visible on touch (which cannot hover).
 */
export function RecentTabPinDivider({
	clearable,
	onClear,
	touch,
	t,
}: {
	clearable: boolean;
	onClear: () => void;
	touch: boolean;
	t: (key: string) => string;
}) {
	const [hovered, setHovered] = useState(false);
	const showClear = clearable && (touch || hovered);
	return (
		<Group
			data-recent-tab-pin-divider
			gap={6}
			wrap="nowrap"
			h={20}
			px={4}
			my={2}
			onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
			onPointerLeave={() => setHovered(false)}
		>
			<Divider style={{ flex: 1 }} />
			{showClear && (
				<Tooltip label={t("clearNarrators")} position="right" withArrow>
					<ActionIcon
						size={20}
						variant="subtle"
						color="gray"
						onClick={onClear}
						aria-label={t("clearNarrators")}
						data-recent-tab-clear
					>
						<IconClearAll size={14} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	);
}

export interface TabContextMenuProps {
	x: number;
	y: number;
	onClose: () => void;
	onMoveToTop: () => void;
	onPin: () => void;
	isPinned: boolean;
	onRemove: () => void;
	onReveal: () => void;
	canReveal: boolean;
	onNewNarratorHere: () => void;
	canNewNarratorHere: boolean;
	/** 文件夹没有目录可继承，文案不同于「在此目录新建」；缺省用会话版本。 */
	newNarratorHereLabel?: string;
	onCopyCwd: () => void;
	canCopyCwd: boolean;
	onOpenInWindow: () => void;
	canOpenInWindow: boolean;
	onRename: () => void;
	canRename: boolean;
	onArchive: () => void;
	canArchive: boolean;
	isFirst: boolean;
	/** "folder": pinning a folder member pins it inside its folder. */
	pinScope: "list" | "folder";
	/** Folder-only actions; null for any other row. */
	folder: {
		collapsed: boolean;
		onEdit: () => void;
		onToggle: () => void;
		onDissolve: () => void;
	} | null;
	/** Folder member: take it out of its folder. */
	onLeaveFolder: (() => void) | null;
	/** The narrator this tab stands for, when the per-narrator git identity pick applies. */
	gitIdentityNarratorId: string | null;
	/** The folder this row is, when the per-folder git identity pick applies. */
	gitIdentityFolderId: string | null;
	/**
	 * Touch only: the row's details, shown above the actions. Touch has no hover card, and
	 * the menu (opened with a left swipe) is where a touch user can reach them.
	 */
	detailsTab?: RecentTab | null;
	t: (key: string) => string;
}

const MENU_EDGE_GAP = 8;

/**
 * Where a menu goes for a pointer at (`x`, `y`): at the pointer, flipped left when it would pass
 * the right edge and up when it would pass the bottom, then clamped so the whole menu (its height
 * capped at the viewport) stays inside. `maxHeight` is the room from `top` to the bottom edge, so
 * a menu taller than that scrolls and its last action stays reachable.
 */
export function placeRecentTabMenu(p: {
	x: number;
	y: number;
	width: number;
	/** The menu's natural height (its content, even past a current cap). */
	height: number;
	viewWidth: number;
	viewHeight: number;
}): { left: number; top: number; maxHeight: number } {
	const gap = MENU_EDGE_GAP;
	const height = Math.min(p.height, Math.max(0, p.viewHeight - 2 * gap));
	const maxLeft = p.viewWidth - p.width - gap;
	const left = Math.max(gap, p.x <= maxLeft ? p.x : p.x - p.width);
	const fitsBelow = p.y + height <= p.viewHeight - gap;
	const wanted = fitsBelow ? p.y : p.y - height;
	const top = Math.max(gap, Math.min(wanted, p.viewHeight - gap - height));
	return { left, top, maxHeight: Math.max(0, p.viewHeight - gap - top) };
}

/**
 * Place a menu at the pointer (a right-click near the bottom, a swipe released near the screen
 * edge) with {@link placeRecentTabMenu}, and again whenever its size changes: the touch details
 * at its top grow when a project's details arrive while it is open, and a menu placed for its
 * first height would push its last actions off screen. A `ResizeObserver` watches the menu and
 * its content (the content can grow past the menu's own capped box); disconnected on cleanup.
 */
function useMenuPosition(x: number, y: number) {
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [position, setPosition] = useState<{
		left: number;
		top: number;
		maxHeight: number;
	} | null>(null);
	useLayoutEffect(() => {
		if (!node) return;
		const view = node.ownerDocument.defaultView;
		const measure = () => {
			const rect = node.getBoundingClientRect();
			const height = Math.max(rect.height, node.scrollHeight || 0);
			const next = placeRecentTabMenu({
				x,
				y,
				width: rect.width,
				height,
				viewWidth: view?.innerWidth ?? x + rect.width + MENU_EDGE_GAP,
				viewHeight: view?.innerHeight ?? y + height + MENU_EDGE_GAP,
			});
			setPosition((previous) =>
				previous &&
				previous.left === next.left &&
				previous.top === next.top &&
				previous.maxHeight === next.maxHeight
					? previous
					: next,
			);
		};
		measure();
		const Observer =
			(view as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver ??
			(typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
		if (!Observer) return;
		const observer = new Observer(() => measure());
		observer.observe(node);
		if (node.firstElementChild) observer.observe(node.firstElementChild);
		return () => observer.disconnect();
	}, [node, x, y]);
	return {
		ref: setNode,
		left: position?.left ?? x,
		top: position?.top ?? y,
		maxHeight: position?.maxHeight,
		measured: position !== null,
	};
}

export function TabContextMenu({
	x,
	y,
	onClose,
	onMoveToTop,
	onPin,
	isPinned,
	onRemove,
	onReveal,
	canReveal,
	onNewNarratorHere,
	canNewNarratorHere,
	newNarratorHereLabel,
	onCopyCwd,
	canCopyCwd,
	onOpenInWindow,
	canOpenInWindow,
	onRename,
	canRename,
	onArchive,
	canArchive,
	isFirst,
	pinScope,
	folder,
	onLeaveFolder,
	gitIdentityNarratorId,
	gitIdentityFolderId,
	detailsTab,
	t,
}: TabContextMenuProps) {
	const gitIdentityVisibility = useGitIdentityVisibility();
	const position = useMenuPosition(x, y);
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: Z.contextMenuBackdrop }}
				// Must take the click even inside the closed sidebar, which passes the pointer
				// through everything not marked (nav-collapsed.css).
				data-nav-pointer
				onClick={onClose}
				onContextMenu={(e) => {
					e.preventDefault();
					onClose();
				}}
				onKeyDown={() => {}}
				role="presentation"
			/>
			<Paper
				ref={position.ref}
				shadow="md"
				p={4}
				withBorder
				data-nav-keep-open
				style={{
					position: "fixed",
					left: position.left,
					top: position.top,
					zIndex: Z.contextMenu,
					minWidth: 140,
					// The room below its top once measured, so its last action stays reachable.
					maxHeight:
						position.maxHeight !== undefined
							? position.maxHeight
							: `calc(100dvh - ${2 * MENU_EDGE_GAP}px)`,
					overflowY: "auto",
					// Hidden for the one frame before it is measured, so it never flashes off-screen.
					visibility: position.measured ? "visible" : "hidden",
				}}
			>
				<Stack gap={2}>
					{detailsTab && (
						<>
							<Box px="xs" py={6} maw={280}>
								<RecentTabDetails tab={detailsTab} />
							</Box>
							<Divider />
						</>
					)}
					{folder && (
						<>
							<UnstyledButton px="xs" py={4} onClick={folder.onEdit} style={{ borderRadius: 4 }}>
								<Group gap={8} wrap="nowrap">
									<IconPencil size={14} />
									<Text size="sm">{t("editFolder")}</Text>
								</Group>
							</UnstyledButton>
							<UnstyledButton px="xs" py={4} onClick={folder.onToggle} style={{ borderRadius: 4 }}>
								<Group gap={8} wrap="nowrap">
									{folder.collapsed ? (
										<IconChevronDown size={14} />
									) : (
										<IconChevronRight size={14} />
									)}
									<Text size="sm">
										{t(folder.collapsed ? "expandFolderMenu" : "collapseFolderMenu")}
									</Text>
								</Group>
							</UnstyledButton>
						</>
					)}
					{!isFirst && !isPinned && (
						<UnstyledButton px="xs" py={4} onClick={onMoveToTop} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconArrowUp size={14} />
								<Text size="sm">{t(pinScope === "folder" ? "moveToFolderTop" : "moveToTop")}</Text>
							</Group>
						</UnstyledButton>
					)}
					<UnstyledButton px="xs" py={4} onClick={onPin} style={{ borderRadius: 4 }}>
						<Group gap={8} wrap="nowrap">
							{isPinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
							<Text size="sm">
								{t(
									pinScope === "folder"
										? isPinned
											? "unpinInFolder"
											: "pinInFolder"
										: isPinned
											? "unpinTab"
											: "pinTab",
								)}
							</Text>
						</Group>
					</UnstyledButton>
					{onLeaveFolder && (
						<UnstyledButton px="xs" py={4} onClick={onLeaveFolder} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconFolderOff size={14} />
								<Text size="sm">{t("leaveFolder")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{folder && (
						<UnstyledButton px="xs" py={4} onClick={folder.onDissolve} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconFolderOff size={14} />
								<Text size="sm">{t("dissolveFolder")}</Text>
							</Group>
						</UnstyledButton>
					)}
					<UnstyledButton px="xs" py={4} onClick={onRemove} style={{ borderRadius: 4 }}>
						<Group gap={8} wrap="nowrap">
							<IconX size={14} />
							<Text size="sm">{t(folder ? "closeFolder" : "closeTab")}</Text>
						</Group>
					</UnstyledButton>
					{canCopyCwd && (
						<UnstyledButton px="xs" py={4} onClick={onCopyCwd} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconCopy size={14} />
								<Text size="sm">{t("copyCwd")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canOpenInWindow && (
						<UnstyledButton px="xs" py={4} onClick={onOpenInWindow} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconWindowMaximize size={14} />
								<Text size="sm">{t("openInWindow")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canRename && (
						<UnstyledButton px="xs" py={4} onClick={onRename} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconPencil size={14} />
								<Text size="sm">{t("rename")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{canArchive && (
						<UnstyledButton px="xs" py={4} onClick={onArchive} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconArchive size={14} />
								<Text size="sm">{t("archive")}</Text>
							</Group>
						</UnstyledButton>
					)}
					{gitIdentityNarratorId && gitIdentityVisibility.contextMenu && (
						<TabGitIdentityMenu narratorId={gitIdentityNarratorId} onClose={onClose} />
					)}
					{gitIdentityFolderId && gitIdentityVisibility.folderContextMenu && (
						<FolderGitIdentityMenu folderId={gitIdentityFolderId} onClose={onClose} />
					)}
					{canReveal && (
						<UnstyledButton px="xs" py={4} onClick={onReveal} style={{ borderRadius: 4 }}>
							<Group gap={8} wrap="nowrap">
								<IconFolder size={14} />
								<Text size="sm">{t("revealInExplorer")}</Text>
							</Group>
						</UnstyledButton>
					)}{" "}
					{canNewNarratorHere && (
						<UnstyledButton
							px="xs"
							py={4}
							onPointerEnter={preloadCreateNarratorModal}
							onFocus={preloadCreateNarratorModal}
							onPointerDown={preloadCreateNarratorModal}
							onClick={onNewNarratorHere}
							style={{ borderRadius: 4 }}
						>
							<Group gap={8} wrap="nowrap">
								<IconFolderPlus size={14} />
								<Text size="sm">{newNarratorHereLabel ?? t("newNarratorHere")}</Text>
							</Group>
						</UnstyledButton>
					)}
				</Stack>
			</Paper>
		</>
	);
}
