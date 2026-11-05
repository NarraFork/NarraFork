/**
 * The sidebar's content box, and the collapsed rail's hover expansion.
 *
 * Collapsed, the sidebar is a 60px column of icons. Resting the mouse on it opens the
 * full sidebar as an overlay at the last expanded width: this box becomes absolutely
 * positioned over the page, so the page itself does not reflow, and the 60px column
 * underneath stays put. Moving away closes it again (see `nav-hover-expand.ts` for the
 * timing and what keeps it open). Touch and the phone drawer are not affected: a phone
 * drawer always renders expanded.
 *
 * Owning the hover state here, and passing the rendered state down by context, keeps a
 * hover from re-rendering the app shell that hosts this box.
 */

import { getNavExpandedWidth, startNavResize } from "@frontend/hooks/useResizableNav";
import { Box } from "@mantine/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMobileViewport } from "../../hooks/useMobileViewport";
import {
	createNavHoverIntent,
	hasVisibleLayer,
	isOwnedTarget,
	OPEN_POPUP_SELECTOR,
} from "./nav-hover-expand";
import { NavRenderContext, type NavRenderState } from "./nav-render-context";

export function NavHoverPanel({
	collapsed,
	expandedPadding,
	expandedBottomGutter,
	children,
}: {
	/** The stored preference: the sidebar is the collapsed rail. */
	collapsed: boolean;
	/** Padding of the open overlay (the expanded sidebar's own padding). */
	expandedPadding: string;
	/** Bottom gutter of the open overlay (home-indicator clearance included). */
	expandedBottomGutter: string;
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
				if (pressedRef.current) return true;
				const focused = document.activeElement;
				if (focused instanceof HTMLInputElement && panel.contains(focused)) return true;
				return panel.querySelector(OPEN_POPUP_SELECTOR) !== null || hasVisibleLayer();
			},
		}),
	);

	useEffect(() => {
		if (!canHover) intent.reset();
	}, [canHover, intent]);
	useEffect(() => () => intent.reset(), [intent]);
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

	const overlay = canHover && hoverOpen;
	const renderCollapsed = canHover && !hoverOpen;
	const state = useMemo<NavRenderState>(
		() => ({ collapsed: renderCollapsed, storedCollapsed: collapsed, openPanel: intent.open }),
		[renderCollapsed, collapsed, intent],
	);

	return (
		<NavRenderContext.Provider value={state}>
			<Box
				ref={panelRef}
				data-nav-hover-panel={overlay ? "open" : undefined}
				data-collapsed={renderCollapsed || undefined}
				onPointerEnter={(e) => {
					if (e.pointerType === "mouse" && canHover) intent.enter();
				}}
				onPointerLeave={(e) => {
					if (e.pointerType === "mouse") intent.leave();
				}}
				onPointerDown={() => {
					pressedRef.current = true;
				}}
				style={
					overlay
						? {
								position: "absolute",
								top: 0,
								left: 0,
								bottom: 0,
								zIndex: 1,
								width: getNavExpandedWidth(),
								display: "flex",
								flexDirection: "column",
								padding: expandedPadding,
								paddingBottom: expandedBottomGutter,
								background: "var(--mantine-color-body)",
								borderInlineEnd: "1px solid var(--mantine-color-default-border)",
								boxShadow: "var(--mantine-shadow-xl)",
							}
						: {
								flex: 1,
								minHeight: 0,
								display: "flex",
								flexDirection: "column",
								// A phone drawer always renders expanded, also under a collapsed
								// preference whose navbar padding is the rail's 4px.
								...(collapsed && isMobile
									? { paddingInline: "calc(var(--mantine-spacing-md) - 4px)" }
									: {}),
							}
				}
			>
				{overlay ? (
					// The WCO traffic-light spacer, which the overlay covers in the column below.
					<Box className="nf-wco-nav-spacer" aria-hidden />
				) : (
					// Resize handle on the sidebar's edge. Not on the overlay: it measures from the
					// stored (collapsed) width, so a drag from the overlay's edge would jump.
					// Pointer events so touch drags work; `touch-action: none` keeps the browser
					// from claiming the gesture as a scroll.
					<Box
						visibleFrom="sm"
						onPointerDown={startNavResize}
						style={{
							position: "absolute",
							top: 0,
							right: -3,
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
