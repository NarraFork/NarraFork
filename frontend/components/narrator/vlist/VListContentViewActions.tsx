/**
 * VListContentViewActions.tsx — the hover action bar for ONE vlist content body.
 *
 * The chunked path gets this from `ContentViewer`: a sticky, zero-height bar in
 * the body's top-right corner offering source/rendered, wrap, copy and
 * fullscreen. The exact vlist painted its bodies as bare `maxHeight +
 * overflow:auto` boxes, so a capped body's hidden remainder could only be
 * reached by scrolling a 200px window.
 *
 * Height neutrality (the CONTRACT's first iron law):
 *  - the bar is `position:absolute; height:0` — it is outside the measured block
 *    flow entirely, so it cannot move anything;
 *  - it mounts only while the body is hovered (desktop), exactly like
 *    ContentViewer's lazy action bar, so a scrolling list pays nothing;
 *  - wrap only changes `white-space` INSIDE a fixed-height scrolling box, so it
 *    changes what the reader sees, never the box. (In the chunked path wrap DOES
 *    change the row height; here it cannot.)
 *
 * Every control is marked `data-message-selection-ignore` so a Ctrl/Cmd-click on
 * a button cannot double as a block-selection toggle.
 */

import { Z } from "@frontend/lib/z-index";
import { ActionIcon, Box, Group, Tooltip } from "@mantine/core";
import {
	IconArrowBarToUp,
	IconArrowsMaximize,
	IconCode,
	IconCopy,
	IconMarkdown,
	IconTextWrap,
	IconTextWrapDisabled,
} from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../../common/CopyButton";
import { DocumentCopyButton } from "../content/DocumentCopyButton";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../message/MessageSelectionCtx";
import { isMarkdownTarget } from "./vlist-content-view-body";
import type { VListViewTarget } from "./vlist-content-view-target";

/**
 * PARKED overlay: pinned to the body's top-right corner while its head is on
 * screen. `pointerEvents` is off on the wrapper and re-enabled per button, so the
 * strip never swallows a click aimed at the text under it.
 *
 * `alignItems:"flex-start"` is load-bearing. The wrapper is deliberately
 * zero-height (it must not occupy a single measured pixel), and a zero-height flex
 * box with Mantine's default `align-items:center` centres its children ACROSS the
 * body's top edge — so the buttons' upper half sat outside the body and the row's
 * `overflow:hidden` cut it off. Aligning to the start drops the whole bar below
 * the edge, inside the box, where it is fully visible.
 */
const overlayStyle: CSSProperties = {
	position: "absolute",
	top: 0,
	right: 0,
	height: 0,
	zIndex: 2,
	pointerEvents: "none",
	display: "flex",
	justifyContent: "flex-end",
	alignItems: "flex-start",
	padding: 4,
};

/**
 * FLOATING bar: a `position: fixed` strip portaled out of the list once the
 * body's head has scrolled away.
 *
 * Fixed rather than an absolute `top` recomputed per scroll frame: the scroll
 * paints immediately while a React-committed `top` lands a frame later, which is
 * what made the bar jitter. These coordinates come from the scroller's rect and
 * the body's horizontal bounds, both invariant under vertical scrolling, so the
 * bar simply does not move while the reader scrolls.
 *
 * Being fixed and portaled also takes it out of the row's `overflow:hidden`, so
 * it cannot be clipped either.
 *
 * Z-INDEX: `Z.stickyHeader`, not `Z.popover`. This strip is content-edge chrome,
 * not a selection popover — it must not cover body-level `<Menu>`s the reader
 * opens (toolbar overflow, context menus). `Z.popover` (3000) would; 100 does
 * not. Same tier as `VListTouchScrollTopButton`, its touch counterpart.
 */
function fixedBarStyle(top: number, right: number, zIndex: number): CSSProperties {
	return {
		position: "fixed",
		top,
		right,
		zIndex,
		pointerEvents: "none",
		display: "flex",
		justifyContent: "flex-end",
		alignItems: "flex-start",
	};
}

const buttonStyle: CSSProperties = { pointerEvents: "auto" };

const ICON_SIZE = 12;
const BUTTON_SIZE = "xs" as const;

export interface VListContentViewActionsProps {
	target: VListViewTarget;
	/** Current soft-wrap state for this body. */
	wordWrap: boolean;
	/** Markdown bodies: whether the raw source is shown instead of the render. */
	showSource: boolean;
	onToggleWrap: () => void;
	onToggleSource: () => void;
	onOpenFullscreen: () => void;
	/**
	 * Viewport coordinates for the FLOATING bar. Present only while the body's head
	 * is off screen; absent → the bar renders parked inside the body.
	 */
	float?: { top: number; right: number };
	/**
	 * Scroll the body's head back into view. Supplied ONLY while the bar is
	 * floating (the head is gone), which is exactly when the button is useful —
	 * mirroring ContentViewer's stuck-only "read from the start" affordance.
	 */
	onScrollToTop?: () => void;
	/**
	 * Report whether the pointer is over the BAR itself.
	 *
	 * A floating bar is portaled to `<body>`, so it is not a DOM descendant of the
	 * body it belongs to: reaching for a button fires `mouseleave` on the host and
	 * would tear the bar down mid-reach. The host keeps it alive while this is true.
	 */
	onPointerOverChange?: (over: boolean) => void;
}

export function VListContentViewActions({
	target,
	wordWrap,
	showSource,
	onToggleWrap,
	onToggleSource,
	onOpenFullscreen,
	float,
	onScrollToTop,
	onPointerOverChange,
}: VListContentViewActionsProps) {
	const { t } = useTranslation("common");
	const { t: tNarrator } = useTranslation("narrator");
	// Offered only when the ROW can actually swap its body for the raw source.
	// Flipping shell state that the row's renderer ignores would leave the reader
	// clicking a lit-up button with nothing changing on screen — the toggle is not
	// "always available for markdown", it is available where a renderer honours it.
	const canShowSource = isMarkdownTarget(target) && target.sourceInline === true;
	// A diff body has its own two-column gutter and always soft-wraps per row;
	// offering a wrap toggle there would suggest a control the diff renderer's
	// own `wordWrap` already owns via the modal.
	const canWrap = target.kind !== "diff";
	const ignore = { [MESSAGE_SELECTION_IGNORE_ATTR]: "" };

	const bar = (
		// A Mantine Box (not a raw div) keeps the pointer handlers off a static host
		// element. The handlers only keep the bar alive while the pointer is on it —
		// every action inside is a real, keyboard-reachable button.
		<Box
			style={float ? fixedBarStyle(float.top, float.right, Z.stickyHeader) : overlayStyle}
			data-vlist-view-actions={float ? "floating" : "parked"}
			onMouseEnter={onPointerOverChange ? () => onPointerOverChange(true) : undefined}
			onMouseLeave={onPointerOverChange ? () => onPointerOverChange(false) : undefined}
			{...ignore}
		>
			<Group gap={2} wrap="nowrap">
				{/* Leads the bar while floating: the reader has scrolled past this body's
				    head and this is the way back to it. */}
				{onScrollToTop ? (
					<Tooltip label={tNarrator("readFromStart")} withArrow position="top">
						<ActionIcon
							size={BUTTON_SIZE}
							variant="filled"
							color="gray"
							onClick={onScrollToTop}
							aria-label={tNarrator("readFromStart")}
							style={buttonStyle}
						>
							<IconArrowBarToUp size={ICON_SIZE} />
						</ActionIcon>
					</Tooltip>
				) : null}
				{canShowSource ? (
					<Tooltip label={showSource ? t("rendered") : t("source")} withArrow position="top">
						<ActionIcon
							size={BUTTON_SIZE}
							variant="filled"
							color={showSource ? "indigo" : "gray"}
							onClick={onToggleSource}
							aria-label={showSource ? t("rendered") : t("source")}
							style={buttonStyle}
						>
							{showSource ? <IconMarkdown size={ICON_SIZE} /> : <IconCode size={ICON_SIZE} />}
						</ActionIcon>
					</Tooltip>
				) : null}
				{canWrap ? (
					<Tooltip label={wordWrap ? t("noWrap") : t("wordWrap")} withArrow position="top">
						<ActionIcon
							size={BUTTON_SIZE}
							variant="filled"
							color={wordWrap ? "indigo" : "gray"}
							onClick={onToggleWrap}
							aria-label={wordWrap ? t("noWrap") : t("wordWrap")}
							style={buttonStyle}
						>
							{wordWrap ? (
								<IconTextWrap size={ICON_SIZE} />
							) : (
								<IconTextWrapDisabled size={ICON_SIZE} />
							)}
						</ActionIcon>
					</Tooltip>
				) : null}
				{target.textDocument ? (
					<DocumentCopyButton document={target.textDocument} />
				) : target.model?.textDocumentSource ? (
					<Tooltip
						label={tNarrator(
							target.model.textDocumentError ? "documentLoadFailed" : "documentLoading",
						)}
						withArrow
						position="top"
					>
						<ActionIcon
							size={BUTTON_SIZE}
							disabled
							aria-label={tNarrator("documentLoading")}
							style={buttonStyle}
						>
							<IconCopy size={ICON_SIZE} />
						</ActionIcon>
					</Tooltip>
				) : (
					<CopyButton value={target.text}>
						{({ copied, copy }) => (
							<Tooltip label={copied ? t("copied") : t("copy")} withArrow position="top">
								<ActionIcon
									size={BUTTON_SIZE}
									variant="filled"
									color={copied ? "teal" : "gray"}
									onClick={copy}
									aria-label={copied ? t("copied") : t("copy")}
									style={buttonStyle}
								>
									<IconCopy size={ICON_SIZE} />
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
				)}
				<Tooltip label={t("fullscreen")} withArrow position="top">
					<ActionIcon
						size={BUTTON_SIZE}
						variant="filled"
						color="gray"
						onClick={onOpenFullscreen}
						aria-label={t("fullscreen")}
						style={buttonStyle}
					>
						<IconArrowsMaximize size={ICON_SIZE} />
					</ActionIcon>
				</Tooltip>
			</Group>
		</Box>
	);

	// A floating bar must escape the row's `overflow:hidden` (and the canvas's), so
	// it is portaled to the body element; a parked one stays in place, inside the
	// body it decorates.
	return float ? createPortal(bar, document.body) : bar;
}
