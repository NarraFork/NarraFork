/**
 * VListContentViewHost.tsx — attaches the viewer affordances to ONE body box.
 *
 * Every capped body in the exact vlist (tool-call details, subagent prompt and
 * result, and the plain markdown / reasoning rows) wraps its own box in this
 * host. The host supplies what `ContentViewer` gives the chunked path:
 *
 *   desktop : hover → the zero-height action bar (source / wrap / copy / fullscreen)
 *   mobile  : double-tap → fullscreen (the bar is hidden there, same as ContentViewer)
 *
 * FLOATING THE BAR (why not `position: sticky`)
 *
 * ContentViewer pins its bar with `sticky; top:0`, which works because the bar's
 * nearest scrollport IS the chat scroller. Here the chain differs: the virtual
 * canvas and every row box are fixed-height `overflow:hidden` boxes, so a sticky
 * bar would stick to the row's own clipped box — a box that never scrolls — and
 * slide out of view together with the body's head. The offset is therefore
 * tracked in JS (`vlist-content-view-float.ts`) against the real scroller and
 * applied as a plain `top`, so the bar keeps following the viewport edge while
 * the reader scrolls through a long body. Once it is floating, a "back to the
 * start of this body" button joins the bar — the same affordance ContentViewer
 * surfaces when its own bar is stuck.
 *
 * The wrapper adds `position:relative` and NOTHING else — no padding, no border,
 * no min-height — so the box it wraps keeps the exact geometry the measure layer
 * reserved. The bar itself stays a zero-height absolute overlay; only its `top`
 * moves, so none of this can affect a measured height.
 *
 * Bodies with no readable text pass `target === undefined`; the host then renders
 * its children verbatim and costs nothing.
 */

import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Box } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useRenderInteractive } from "../RenderLodCtx";
import { VListContentViewActions } from "./VListContentViewActions";
import {
	type FloatState,
	resolveFloatState,
	resolveScrollToBodyTop,
} from "./vlist-content-view-float";
import type { VListViewTarget } from "./vlist-content-view-target";

/** Per-body view state + the callbacks that change it, owned by the shell. */
export interface VListViewControls {
	/** Current wrap state for a body (defaults come from user preferences). */
	isWrapped: (target: VListViewTarget) => boolean;
	/** Whether a markdown body currently shows its raw source. */
	isSourceShown: (target: VListViewTarget) => boolean;
	toggleWrap: (target: VListViewTarget) => void;
	toggleSource: (target: VListViewTarget) => void;
	/** Open the shell's single fullscreen modal on this target. */
	openFullscreen: (target: VListViewTarget) => void;
}

/** Double-tap window (ms) — same threshold ContentViewer uses on mobile. */
const DOUBLE_TAP_MS = 300;

const relative: CSSProperties = { position: "relative" };

const PARKED: FloatState = { mode: "parked", top: 0, right: 0 };

/** The vlist scroll viewport (the element the bar must stay pinned to). */
const LIST_VIEWPORT_SELECTOR = "[data-pretext-exact-message-list]";

/** Nearest scrollable ancestor, else the list viewport, else null. */
function resolveScroller(node: HTMLElement | null): HTMLElement | null {
	if (!node) return null;
	let el: HTMLElement | null = node.parentElement;
	while (el) {
		const overflowY = getComputedStyle(el).overflowY;
		if (overflowY === "scroll" || overflowY === "auto") return el;
		el = el.parentElement;
	}
	// The exact shell's rows sit inside `overflow:hidden` boxes, so the walk above
	// usually reaches the document without finding one. Fall back to the known
	// viewport rather than giving up (which would leave the bar unpinned).
	const viewport = node.closest(LIST_VIEWPORT_SELECTOR);
	return viewport instanceof HTMLElement ? viewport : null;
}

/**
 * Track which MODE this body's bar is in, while the bar is mounted (i.e. while
 * hovered). Recomputed on scroll / resize through rAF, so a scroll frame costs one
 * `getBoundingClientRect` pair for the ONE body the reader is pointing at — never
 * for the whole list.
 *
 * The floating coordinates it produces do not depend on scroll depth (see
 * `resolveFloatState`), so during a plain vertical scroll this settles on one
 * value and the state stops changing — which is why the bar no longer jitters.
 */
function useFloatState(
	hostRef: React.RefObject<HTMLDivElement | null>,
	enabled: boolean,
): { state: FloatState; scrollToBodyTop: () => void } {
	const [state, setState] = useState<FloatState>(PARKED);

	const readGeometry = useCallback(() => {
		const node = hostRef.current;
		const scroller = resolveScroller(node);
		if (!node || !scroller) return null;
		const body = node.getBoundingClientRect();
		return {
			bodyTop: body.top,
			bodyBottom: body.bottom,
			bodyRight: body.right,
			scrollerTop: scroller.getBoundingClientRect().top,
			viewportWidth: window.innerWidth,
			scroller,
		};
	}, [hostRef]);

	useEffect(() => {
		if (!enabled) {
			setState(PARKED);
			return;
		}
		const scroller = resolveScroller(hostRef.current);
		let raf = 0;
		const evaluate = () => {
			raf = 0;
			const geometry = readGeometry();
			if (!geometry) return;
			const next = resolveFloatState(geometry);
			// Bail on an unchanged result so a scroll through a floating body commits
			// nothing at all (the position is scroll-invariant by construction).
			setState((prev) =>
				prev.mode === next.mode && prev.top === next.top && prev.right === next.right ? prev : next,
			);
		};
		const schedule = () => {
			if (!raf) raf = requestAnimationFrame(evaluate);
		};
		schedule();
		const listenTarget: HTMLElement | Window = scroller ?? window;
		listenTarget.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			listenTarget.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, [enabled, hostRef, readGeometry]);

	const scrollToBodyTop = useCallback(() => {
		const geometry = readGeometry();
		if (!geometry) return;
		geometry.scroller.scrollTo({
			top: resolveScrollToBodyTop(geometry, geometry.scroller.scrollTop),
			behavior: "smooth",
		});
	}, [readGeometry]);

	return { state, scrollToBodyTop };
}

export interface VListContentViewHostProps {
	/** The body this host decorates; absent → children render untouched. */
	target: VListViewTarget | undefined;
	controls: VListViewControls | undefined;
	/** Extra styles merged onto the relative wrapper (never height-affecting). */
	style?: CSSProperties;
	children: ReactNode;
}

export function VListContentViewHost({
	target,
	controls,
	style,
	children,
}: VListContentViewHostProps) {
	const interactive = useRenderInteractive();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [pointerOverBody, setPointerOverBody] = useState(false);
	const [pointerOverBar, setPointerOverBar] = useState(false);
	const lastTapRef = useRef(0);
	const hostRef = useRef<HTMLDivElement | null>(null);
	// A FLOATING bar is portaled to <body>, so it is no longer a DOM descendant of
	// the host: moving the pointer onto it fires `mouseleave` on the host. Without
	// tracking the bar's own hover the bar would unmount the instant the reader
	// reached for a button. Either surface keeps it alive.
	const hovered = pointerOverBody || pointerOverBar;
	// Only tracked while the bar is actually on screen: an idle body pays nothing.
	const { state: float, scrollToBodyTop } = useFloatState(hostRef, hovered && !isMobile);

	const openFullscreen = useCallback(() => {
		if (target && controls) controls.openFullscreen(target);
	}, [target, controls]);

	// Mobile: the action bar is hidden, so a double-tap on the body is the way in.
	// Handled HERE rather than in VListRowInteraction because a row can host
	// several bodies and the row layer cannot tell which one was tapped.
	const handleClick = useCallback(() => {
		if (!isMobile) return;
		const now = Date.now();
		if (now - lastTapRef.current < DOUBLE_TAP_MS) {
			lastTapRef.current = 0;
			openFullscreen();
		} else {
			lastTapRef.current = now;
		}
	}, [isMobile, openFullscreen]);

	if (!target || !controls || !interactive) {
		return <>{children}</>;
	}

	return (
		// A Mantine Box (not a raw div) keeps the pointer handlers off a static host
		// element — the same pattern RenderSubagent's click-to-toggle header uses.
		// The mobile double-tap is a shortcut only: fullscreen is also reachable from
		// the action bar's button and from the row menu, both keyboard-operable.
		<Box
			ref={hostRef}
			style={{ ...relative, ...style }}
			onMouseEnter={isMobile ? undefined : () => setPointerOverBody(true)}
			onMouseLeave={isMobile ? undefined : () => setPointerOverBody(false)}
			onClick={isMobile ? handleClick : undefined}
		>
			{/* Mounted only while hovered, so a scrolling list builds no Tooltip /
			    CopyButton trees for bodies the reader is not pointing at. `hidden` drops
			    it entirely: too little of the body is left to host a bar. */}
			{hovered && float.mode !== "hidden" ? (
				<VListContentViewActions
					target={target}
					wordWrap={controls.isWrapped(target)}
					showSource={controls.isSourceShown(target)}
					onToggleWrap={() => controls.toggleWrap(target)}
					onToggleSource={() => controls.toggleSource(target)}
					onOpenFullscreen={openFullscreen}
					float={float.mode === "floating" ? { top: float.top, right: float.right } : undefined}
					// The jump-back button only makes sense once the head is gone.
					onScrollToTop={float.mode === "floating" ? scrollToBodyTop : undefined}
					onPointerOverChange={isMobile ? undefined : setPointerOverBar}
				/>
			) : null}
			{children}
		</Box>
	);
}
