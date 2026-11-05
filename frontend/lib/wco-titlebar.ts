/**
 * Window Controls Overlay: let a page's own top row be the title bar.
 *
 * By default a page sits below `.nf-wco-main-strip`, an empty drag strip as tall as the
 * overlay (styles/wco.css). Pages whose top edge is already a row of headers (the session
 * page: its chat header, tool panel headers and dockview tab strips) opt out with
 * `data-nf-wco-titlebar` on their root and call this hook. It marks every header that
 * touches the root's top edge:
 *
 *   - `data-nf-titlebar-row`: the header is in the title bar; its blank area drags the
 *     window, its controls stay clickable (CSS in wco.css);
 *   - `data-nf-titlebar-end`: it also reaches the right edge, so it pads itself clear of
 *     the window buttons there;
 *   - `data-nf-titlebar-start`: it reaches the left edge (macOS buttons over a collapsed
 *     sidebar).
 *
 * Panels move, split and resize, so the marks are recomputed (once per frame at most)
 * on layout changes inside the root. Everything is inert without the overlay.
 */

import { type RefObject, useEffect } from "react";
import { WCO_ATTRIBUTE } from "./wco";

/** Rows that can sit in the title bar: chat/panel headers and dockview tab strips. */
export const WCO_TITLEBAR_ROW_SELECTOR =
	"[data-narrator-header-layout], .nf-panel-header, .dv-tabs-and-actions-container";

const MARKS = ["data-nf-titlebar-row", "data-nf-titlebar-end", "data-nf-titlebar-start"] as const;
/** Sub-pixel layout tolerance. */
const EDGE_EPSILON_PX = 1;

interface Rect {
	top: number;
	left: number;
	right: number;
}

/** Which marks a row gets, from its rect and the root's. Pure, for tests. */
export function titlebarMarksFor(
	row: Rect,
	root: Rect,
): { row: boolean; end: boolean; start: boolean } {
	const atTop = Math.abs(row.top - root.top) <= EDGE_EPSILON_PX;
	return {
		row: atTop,
		end: atTop && row.right >= root.right - EDGE_EPSILON_PX,
		start: atTop && row.left <= root.left + EDGE_EPSILON_PX,
	};
}

function apply(root: HTMLElement): void {
	const rootRect = root.getBoundingClientRect();
	for (const el of root.querySelectorAll<HTMLElement>(WCO_TITLEBAR_ROW_SELECTOR)) {
		// A tab strip nested in a hidden group, or a header of a parked panel.
		const rect = el.getBoundingClientRect();
		const marks =
			rect.height > 0 ? titlebarMarksFor(rect, rootRect) : { row: false, end: false, start: false };
		el.toggleAttribute("data-nf-titlebar-row", marks.row);
		el.toggleAttribute("data-nf-titlebar-end", marks.end);
		el.toggleAttribute("data-nf-titlebar-start", marks.start);
	}
}

function clear(root: HTMLElement): void {
	for (const mark of MARKS) {
		for (const el of root.querySelectorAll(`[${mark}]`)) el.removeAttribute(mark);
	}
}

export function useWcoTitlebarRows(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
	useEffect(() => {
		const root = rootRef.current;
		if (!enabled || !root || typeof window === "undefined") return;
		const html = document.documentElement;
		let frame: number | null = null;
		const schedule = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				if (html.hasAttribute(WCO_ATTRIBUTE)) apply(root);
				else clear(root);
			});
		};
		schedule();

		const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		resize?.observe(root);
		// Panels mount, split and move without the root resizing.
		const mutations = new MutationObserver(schedule);
		mutations.observe(root, { childList: true, subtree: true });
		// The overlay turning on or off (fullscreen, display-mode change).
		const overlay = new MutationObserver(schedule);
		overlay.observe(html, { attributes: true, attributeFilter: [WCO_ATTRIBUTE] });
		window.addEventListener("resize", schedule);
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			resize?.disconnect();
			mutations.disconnect();
			overlay.disconnect();
			window.removeEventListener("resize", schedule);
			clear(root);
		};
	}, [rootRef, enabled]);
}
