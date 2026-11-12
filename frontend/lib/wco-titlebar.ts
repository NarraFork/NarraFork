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

import { useEffect, useState } from "react";
import { WCO_ATTRIBUTE } from "./wco";

/**
 * Rows that can sit in the title bar: chat/panel headers, dockview tab strips, and any
 * page row that opts in with `data-nf-titlebar-candidate` (the workspace toolbar).
 */
export const WCO_TITLEBAR_ROW_SELECTOR =
	"[data-narrator-header-layout], .nf-panel-header, .dv-tabs-and-actions-container, [data-nf-titlebar-candidate]";

export const WCO_BELOW_CONTROLS_ATTRIBUTE = "data-nf-wco-below-controls";

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
			rect.height > 0 && !el.closest(`[${WCO_BELOW_CONTROLS_ATTRIBUTE}]`)
				? titlebarMarksFor(rect, rootRect)
				: { row: false, end: false, start: false };
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

/**
 * Mark `root`'s title-bar rows while `enabled`; returns the ref callback for the root.
 *
 * A ref callback, not a ref object: the session page remounts its root on every switch
 * to another session (its provider is keyed by session), and an effect watching a ref
 * object's `.current` never sees the new element. It kept observing the detached old
 * root, so after the first switch no header was in the title bar any more. Tracking the
 * element in state rebinds to each new root.
 */
export function useWcoTitlebarRows(enabled: boolean): (el: HTMLElement | null) => void {
	const [root, setRoot] = useState<HTMLElement | null>(null);
	useEffect(() => {
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
		mutations.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [WCO_BELOW_CONTROLS_ATTRIBUTE],
		});
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
	}, [root, enabled]);
	return setRoot;
}
