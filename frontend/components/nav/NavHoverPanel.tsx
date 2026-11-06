/**
 * The sidebar's content box, and the collapsed sidebar's hover expansion.
 *
 * Collapsed and expanded are ONE layout. The content box always lays out at the
 * expanded width; collapsed, the navbar is narrower and clips the box's right side.
 * Opening on hover only lifts the clip and paints the box over the page, so no row, icon
 * or title moves between the two states: where the mouse pointed while collapsed is
 * exactly what it points at once open.
 *
 * Resting the mouse on the collapsed sidebar opens it; moving away closes it again (see
 * `nav-hover-expand.ts` for the timing and what keeps it open). Ctrl+Up / Ctrl+Down opens
 * it too, for as long as the highlight moves. Touch and the phone drawer are not affected:
 * a phone drawer always renders expanded.
 *
 * Owning the hover state here, and passing it down by context, keeps a hover from
 * re-rendering the app shell that hosts this box.
 */

import {
	getNavExpandedWidth,
	NAV_WIDTH_CONSTANTS,
	startNavResize,
} from "@frontend/hooks/useResizableNav";
import { Box } from "@mantine/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMobileViewport } from "../../hooks/useMobileViewport";
import { usePendingTabKey } from "../../hooks/useRecentTabKeyboardNav";
import {
	createNavHoverIntent,
	hasFocusVisibleWithin,
	hasVisibleLayer,
	isOwnedTarget,
	matchesFocusVisible,
	OPEN_POPUP_SELECTOR,
} from "./nav-hover-expand";
import { NavRenderContext, type NavRenderState } from "./nav-render-context";

/** After a Ctrl+Up / Ctrl+Down switch: long enough to see which row it landed on. */
const NAV_SWITCH_LINGER_MS = 600;
const { COLLAPSED_WIDTH } = NAV_WIDTH_CONSTANTS;

/** Is the pointer on the resize handle (a control, not part of the rail)? */
function isResizeHandleTarget(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[data-nav-resize-handle]") !== null;
}

export function NavHoverPanel({
	collapsed,
	children,
}: {
	/** The stored preference: the sidebar is collapsed. */
	collapsed: boolean;
	children: ReactNode;
}) {
	const isMobile = useMobileViewport();
	const canHover = collapsed && !isMobile;
	const [hoverOpen, setHoverOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const pressedRef = useRef(false);

	const [intent] = useState(() =>
		createNavHoverIntent({
			onChange: setHoverOpen,
			isHeld: () => {
				const panel = panelRef.current;
				if (!panel) return false;
				if (pressedRef.current || switchingRef.current) return true;
				if (hasFocusVisibleWithin(panel)) return true;
				return panel.querySelector(OPEN_POPUP_SELECTOR) !== null || hasVisibleLayer();
			},
		}),
	);
	useEffect(() => {
		if (!canHover) intent.reset();
	}, [canHover, intent]);
	useEffect(() => () => intent.reset(), [intent]);
	// Ctrl+Up / Ctrl+Down: open while the highlight moves, so every title it passes is
	// readable, and close a moment after the switch, unless the pointer is resting here.
	const switching = usePendingTabKey() !== null;
	const switchingRef = useRef(false);
	switchingRef.current = switching;
	useEffect(() => {
		if (!canHover) return;
		if (switching) {
			intent.open();
			return;
		}
		const panel = panelRef.current;
		if (intent.isExpanded() && !panel?.matches(":hover")) intent.leaveAfter(NAV_SWITCH_LINGER_MS);
	}, [switching, canHover, intent]);
	// Safety net: a click on the page itself always closes the open panel, whatever is
	// holding it (a layer the visibility check misjudges must never pin it open).
	useEffect(() => {
		if (!hoverOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const panel = panelRef.current;
			if (panel && !isOwnedTarget(panel, e.target)) intent.reset();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, [hoverOpen, intent]);
	useEffect(() => {
		const release = () => {
			pressedRef.current = false;
		};
		// A release outside the window delivers no pointerup; blur covers it.
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", release);
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", release);
			window.removeEventListener("blur", release);
		};
	}, []);

	const open = canHover && hoverOpen;
	const state = useMemo<NavRenderState>(() => ({ storedCollapsed: collapsed }), [collapsed]);
	const expandedWidth = getNavExpandedWidth();

	return (
		<NavRenderContext.Provider value={state}>
			<Box
				ref={panelRef}
				// "closed" also clips each row to its icon (nav-collapsed.css).
				data-nav-hover-panel={open ? "open" : canHover ? "closed" : undefined}
				className={canHover ? "nf-nav-hover-panel" : undefined}
				onPointerEnter={(e) => {
					if (e.pointerType !== "mouse" || !canHover) return;
					// The resize handle is a control, not the rail: resting on it must not open
					// the sidebar, or reaching for it would move the edge out from under the
					// pointer.
					if (isResizeHandleTarget(e.target)) return;
					intent.enter();
				}}
				onPointerMove={(e) => {
					if (e.pointerType !== "mouse" || !canHover) return;
					// Moving onto the handle cancels an open already scheduled by the rows
					// (pointerenter fired before the pointer got here), and moving back off it
					// arms the rail again.
					if (isResizeHandleTarget(e.target)) intent.leave();
					else intent.enter();
				}}
				onPointerLeave={(e) => {
					if (e.pointerType === "mouse") intent.leave();
				}}
				onPointerDown={() => {
					pressedRef.current = true;
				}}
				// Tab onto something the collapsed width clips: open, so it is visible.
				onFocus={(e) => {
					if (canHover && matchesFocusVisible(e.target)) intent.open();
				}}
				onBlur={(e) => {
					const next = e.relatedTarget;
					if (!canHover || (next instanceof Node && e.currentTarget.contains(next))) return;
					// The mouse may still be resting on it; then the pointer decides.
					if (!e.currentTarget.matches(":hover")) intent.leave();
				}}
				style={{
					flex: 1,
					minHeight: 0,
					display: "flex",
					flexDirection: "column",

					// Collapsed (desktop): the width this box has in the expanded navbar, i.e.
					// the expanded width less the navbar's inline padding and its 1px border.
					// Not positioned, so the backdrop and the resize handle below place
					// themselves against the navbar.
					...(canHover
						? { width: `calc(${expandedWidth}px - 2 * var(--mantine-spacing-md) - 1px)` }
						: {}),
				}}
			>
				{canHover && (
					// What the expanded navbar paints: the page colour and its edge, over the full
					// height from the window edge, behind every row (z-index -1 in the navbar's
					// isolated stacking context). Always there, clipped to the rail while closed,
					// so opening and closing slide its edge along with the rows' clips. Part of
					// this box, so the pointer on its blank strips is still "inside".
					<Box
						aria-hidden
						style={{
							position: "absolute",
							top: 0,
							bottom: 0,
							left: 0,
							width: expandedWidth,
							zIndex: -1,
							background: "var(--mantine-color-body)",
							borderInlineEnd: "1px solid var(--mantine-color-default-border)",
							boxShadow: open ? "var(--mantine-shadow-xl)" : "none",
							// The shadow sits outside the box, so the open inset reaches past it.
							clipPath: open
								? "inset(0 -32px 0 0)"
								: `inset(0 ${expandedWidth - COLLAPSED_WIDTH}px 0 0)`,
							transition:
								"clip-path var(--nf-nav-open-duration) var(--nf-nav-open-ease), box-shadow var(--nf-nav-open-duration) ease",
							// Closed, it is the rail itself, out to the window edge through the navbar's
							// padding: what makes a mouse pushed against the screen edge open it.
							// Pointer events are clipped with it (clip-path also clips hit testing).
							pointerEvents: "auto",
						}}
					/>
				)}
				{!open && (
					// Resize handle on the navbar's edge. Not while open: it measures from the
					// stored (collapsed) width, so a drag from the open panel's edge would jump.
					// Collapsed it sits fully inside the edge, which clips anything past it.
					// Pointer events so touch drags work; `touch-action: none` keeps the browser
					// from claiming the gesture as a scroll.
					<Box
						visibleFrom="sm"
						data-nav-resize-handle
						className="nf-nav-resize-handle"
						onPointerDown={startNavResize}
						style={{
							position: "absolute",
							top: 0,
							right: canHover ? 0 : -3,
							width: 6,
							height: "100%",
							cursor: "col-resize",
							touchAction: "none",
							zIndex: 100,
						}}
					/>
				)}
				{children}
			</Box>
		</NavRenderContext.Provider>
	);
}
