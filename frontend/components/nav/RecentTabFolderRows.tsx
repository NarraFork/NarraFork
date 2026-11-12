/**
 * Sidebar folder rows: the header (icon, name, member count, collapse chevron), the
 * card behind a whole folder, and the "N more" control under an open folder.
 *
 * The "N more" control (the strip) has two jobs:
 *   - click toggles between "preview" (first N members) and "expanded" (all members);
 *   - dragging it vertically changes N, in whole member rows, saved on release.
 * While expanded it is `position: sticky; bottom: 0`, so a folder longer than the list
 * keeps its collapse control on screen at the bottom of the sidebar until the folder's
 * own end scrolls into view. Sticky only works if no ancestor between the strip and the
 * scroll container clips overflow, which is why the list box uses `overflow: clip`.
 */

import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { Badge, Box, Group, NavLink, Text, Tooltip, UnstyledButton } from "@mantine/core";
import type { RecentTabFolderColor } from "@shared/recent-tabs";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { summarizeFolderMembers } from "../../hooks/recent-tab-folders";
import type { FolderDisplay } from "./recent-tab-drag-model";
import { folderColorVar, folderIconComponent } from "./recent-tab-folder-icons";
import { SwipeMenuHint, useRowSwipe } from "./useRowSwipe";

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Coloured counts for members the user cannot currently see. */
function HiddenStatus({ members, t }: { members: RecentTab[]; t: T }) {
	const summary = useMemo(() => summarizeFolderMembers(members), [members]);
	const items: Array<{ key: string; count: number; color: string }> = [
		{ key: "folderWaitingCount", count: summary.waiting, color: "yellow" },
		{ key: "folderErrorCount", count: summary.error, color: "red" },
		{ key: "folderWorkingCount", count: summary.working, color: "blue" },
		{ key: "folderUnreadCount", count: summary.unread, color: "green" },
	];
	return (
		<>
			{items
				.filter((item) => item.count > 0)
				.map((item) => (
					<Tooltip
						key={item.key}
						label={t(item.key, { count: item.count })}
						withArrow
						position="right"
					>
						<Badge size="xs" circle color={item.color} variant="filled">
							{item.count}
						</Badge>
					</Tooltip>
				))}
		</>
	);
}

export interface RecentTabFolderHeaderProps {
	folder: RecentTab;
	members: RecentTab[];
	/** Members not rendered right now (collapsed folder or beyond the preview). */
	hidden: RecentTab[];
	display: FolderDisplay;
	/** A hidden member is the page currently open. */
	active: boolean;
	onToggle: () => void;
	onContextMenu: (e: React.MouseEvent, tab: RecentTab) => void;
	/** Touch: a left swipe opens the context menu (there is no right-click). */
	onSwipeMenu?: (tab: RecentTab, x: number, y: number) => void;
	isDragging?: boolean;
	outerRef?: (node: HTMLElement | null) => void;
	// biome-ignore lint/suspicious/noExplicitAny: dnd-kit attribute/listener bags are untyped maps
	dragProps?: Record<string, any>;
	consumeClick?: () => boolean;
	t: T;
}

export function RecentTabFolderHeader({
	folder,
	members,
	hidden,
	display,
	active,
	onToggle,
	onContextMenu,
	onSwipeMenu,
	isDragging,
	outerRef,
	dragProps,
	consumeClick,
	t,
}: RecentTabFolderHeaderProps) {
	const collapsed = display === "collapsed";
	const FolderIcon = folderIconComponent(folder.folderIcon);
	const color = folderColorVar(folder.folderColor);
	// Left swipe opens the menu, like a tab row. No close-by-swipe: closing a folder also
	// closes its sessions, which is too much for a gesture that easy to trigger.
	const onMenu = useMemo(
		() => (onSwipeMenu ? (x: number, y: number) => onSwipeMenu(folder, x, y) : undefined),
		[onSwipeMenu, folder],
	);
	const swipe = useRowSwipe({ isDragging: !!isDragging, onMenu });
	return (
		<div
			ref={outerRef}
			{...dragProps}
			data-tab-sort-id={`folder:${folder.id}`}
			style={{ overflow: "hidden", touchAction: "pan-y", position: "relative" }}
		>
			<SwipeMenuHint swipeX={swipe.swipeX} label={t("swipeMenu")} />
			<div style={swipe.style}>
				<NavLink
					{...swipe.handlers}
					component="button"
					type="button"
					active={active}
					onClick={() => {
						if (consumeClick?.()) return;
						onToggle();
					}}
					onContextMenu={(e: React.MouseEvent) => {
						if (swipe.touching()) {
							e.preventDefault();
							return;
						}
						onContextMenu(e, folder);
					}}
					aria-expanded={!collapsed}
					aria-label={t(collapsed ? "expandFolder" : "collapseFolder", { name: folder.title })}
					label={
						<Text size="sm" fw={500} truncate>
							{folder.title}
						</Text>
					}
					leftSection={
						<span style={{ display: "flex" }}>
							<FolderIcon size={16} color={color} />
						</span>
					}
					rightSection={
						<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
							{collapsed && <HiddenStatus members={hidden} t={t} />}
							<Tooltip
								label={t("folderMemberCount", { count: members.length })}
								withArrow
								position="right"
							>
								<Text size="xs" c="dimmed" lh={1}>
									{members.length}
								</Text>
							</Tooltip>
							<IconChevronDown
								size={14}
								style={{
									opacity: 0.5,
									transition: "transform 120ms ease",
									transform: collapsed ? "rotate(-90deg)" : undefined,
								}}
							/>
						</Group>
					}
					styles={{ root: { cursor: "pointer" }, label: { overflow: "hidden" } }}
				/>
			</div>
		</div>
	);
}

/**
 * Background of a whole folder (header, members, "N more"): one rounded card, tinted by
 * the folder's colour when it has one. This is what tells a folder's rows apart from the
 * loose rows above and below it.
 */
export function recentTabFolderCardStyle(
	color: RecentTabFolderColor | undefined,
): React.CSSProperties {
	return {
		// The rows inside are NavLinks at the theme's `sm` radius; the card matches them.
		borderRadius: "var(--mantine-radius-sm)",
		background: folderCardFill(color),
		margin: "2px 0",
	};
}

function folderCardFill(color: RecentTabFolderColor | undefined): string {
	return color ? `var(--mantine-color-${color}-light)` : "var(--mantine-color-default-hover)";
}

/**
 * Thin line between a folder's pinned and unpinned members.
 *
 * Zero height on purpose: drop targeting reads a gap between rows as "between top-level
 * units", so any space here would turn a drop aimed between two members into a drop
 * after the whole folder. The line is painted over the seam instead.
 */
export function RecentTabFolderPinDivider() {
	return (
		<Box aria-hidden data-folder-pin-divider style={{ position: "relative", height: 0 }}>
			<Box
				style={{
					position: "absolute",
					top: 0,
					left: TITLE_COLUMN_PX,
					right: 12,
					height: 1,
					background: "var(--mantine-color-default-border)",
				}}
			/>
		</Box>
	);
}

/** Where every sidebar row's title starts: NavLink padding + 16px icon + icon gap. */
const TITLE_COLUMN_PX = 40;

/** Height of one member row, used to turn strip drag distance into a preview count. */
const MEMBER_ROW_FALLBACK_PX = 44;
/** Pointer travel before a press on the strip counts as a drag instead of a click. */
const STRIP_DRAG_SLOP_PX = 4;

export interface RecentTabFolderStripProps {
	folder: RecentTab;
	members: RecentTab[];
	hidden: RecentTab[];
	display: "preview" | "expanded";
	/** Preview count in effect (the folder's own, or the default). */
	previewCount: number;
	/** Click: switch between preview and expanded. */
	onToggleExpanded: () => void;
	/** Live preview count while dragging (null when a drag is cancelled). */
	onPreviewDrag: (count: number | null) => void;
	/** Release after a drag, or an arrow key: persist this count. */
	onPreviewCommit: (count: number) => void;
	/** The Ctrl+Up / Ctrl+Down highlight is on this row (Enter toggles it). */
	highlighted?: boolean;
	t: T;
}

/**
 * The strip under an open folder.
 *
 * Click (or Enter/Space, or a screen reader's activate) toggles preview/expanded. In
 * preview, dragging it up/down — or ArrowUp/ArrowDown — changes how many members stay
 * visible. Expanded, it only toggles: it is sticky there, and resizing would turn it
 * back into a preview whose end may be far off screen, carrying the strip away from
 * under the pointer.
 */
export function RecentTabFolderStrip({
	folder,
	members,
	hidden,
	display,
	previewCount,
	onToggleExpanded,
	onPreviewDrag,
	onPreviewCommit,
	highlighted = false,
	t,
}: RecentTabFolderStripProps) {
	const gesture = useRef<{ startY: number; base: number; rowPx: number; last: number } | null>(
		null,
	);
	const [dragging, setDragging] = useState(false);
	/** Set when a drag ended, so the click the browser fires right after is ignored. */
	const swallowClick = useRef(false);
	const expanded = display === "expanded";
	const shown = Math.min(previewCount, members.length);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			if (expanded || e.button !== 0) return;
			// The member row rendered right above the strip gives the real row height.
			const above = e.currentTarget.parentElement?.previousElementSibling as HTMLElement | null;
			const rowPx = above?.getBoundingClientRect().height || MEMBER_ROW_FALLBACK_PX;
			gesture.current = { startY: e.clientY, base: shown, rowPx, last: shown };
		},
		[expanded, shown],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			const state = gesture.current;
			if (!state) return;
			const dy = e.clientY - state.startY;
			if (!dragging) {
				if (Math.abs(dy) < STRIP_DRAG_SLOP_PX) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				setDragging(true);
			}
			const next = Math.max(0, Math.min(members.length, state.base + Math.round(dy / state.rowPx)));
			if (next !== state.last) {
				state.last = next;
				onPreviewDrag(next);
			}
		},
		[dragging, members.length, onPreviewDrag],
	);

	const endDrag = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
			const state = gesture.current;
			gesture.current = null;
			if (!dragging || !state) return;
			if (e.currentTarget.hasPointerCapture(e.pointerId)) {
				e.currentTarget.releasePointerCapture(e.pointerId);
			}
			setDragging(false);
			swallowClick.current = true;
			if (commit) onPreviewCommit(state.last);
			else onPreviewDrag(null);
		},
		[dragging, onPreviewCommit, onPreviewDrag],
	);

	// Visible text stays short; the aria-label says exactly what a click does.
	const text = expanded
		? t("folderShowFewer")
		: hidden.length > 0
			? t("folderMoreCount", { count: hidden.length })
			: t("folderShowAll");
	const label = expanded
		? t("folderShowLess", { count: shown })
		: hidden.length > 0
			? t("folderShowMore", { count: hidden.length })
			: t("folderShowAll");
	const color = folderColorVar(folder.folderColor);
	const fill = folderCardFill(folder.folderColor);
	return (
		<Box
			style={
				expanded
					? {
							position: "sticky",
							bottom: 0,
							zIndex: 1,
							// Sticks over other rows while expanded, so it needs an opaque fill: the
							// card's translucent tint layered on the page colour.
							background: `linear-gradient(${fill}, ${fill}), var(--mantine-color-body)`,
							borderBottomLeftRadius: "var(--mantine-radius-sm)",
							borderBottomRightRadius: "var(--mantine-radius-sm)",
						}
					: undefined
			}
		>
			<Tooltip
				label={t(expanded ? "folderStripHintExpanded" : "folderStripHint")}
				position="right"
				openDelay={600}
				withArrow
				disabled={dragging}
			>
				<UnstyledButton
					type="button"
					data-folder-strip={folder.id}
					data-active={highlighted || undefined}
					aria-label={label}
					aria-expanded={expanded}
					onClick={() => {
						if (swallowClick.current) {
							swallowClick.current = false;
							return;
						}
						onToggleExpanded();
					}}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={(e) => endDrag(e, true)}
					onPointerCancel={(e) => endDrag(e, false)}
					onKeyDown={(e) => {
						if (expanded || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
						// Plain arrows only: Ctrl+Up / Ctrl+Down is the sidebar's switch, and this row
						// keeps focus after a click, so it would resize the folder on every switch.
						if (e.ctrlKey || e.metaKey || e.altKey) return;
						e.preventDefault();
						const next = Math.max(
							0,
							Math.min(members.length, shown + (e.key === "ArrowDown" ? 1 : -1)),
						);
						if (next !== shown) onPreviewCommit(next);
					}}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						width: "100%",
						// Lines the text up with every row title: NavLink padding (12) + icon (16) +
						// icon gap (12).
						paddingLeft: TITLE_COLUMN_PX,
						paddingRight: 12,
						height: 28,
						cursor: dragging ? "ns-resize" : "pointer",
						// Vertical drags resize the preview instead of scrolling (preview only).
						touchAction: expanded ? "manipulation" : "none",
						borderRadius: "var(--mantine-radius-sm)",
						// The keyboard highlight, the same fill an active row has.
						background: highlighted ? "var(--mantine-primary-color-light)" : undefined,
						color: highlighted
							? "var(--mantine-primary-color-light-color)"
							: dragging && color
								? color
								: "var(--mantine-color-dimmed)",
					}}
				>
					<Text size="xs" inherit lh={1}>
						{text}
					</Text>
					{expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
					{!expanded && hidden.length > 0 && (
						<Group gap={4} wrap="nowrap" ml="auto" style={{ flexShrink: 0 }}>
							<HiddenStatus members={hidden} t={t} />
						</Group>
					)}
				</UnstyledButton>
			</Tooltip>
		</Box>
	);
}
