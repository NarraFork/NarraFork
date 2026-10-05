/**
 * VListContentViewHost.tsx — attaches the viewer affordances to ONE body box.
 *
 * Every capped body in the exact vlist (tool-call details, subagent prompt and
 * result, and the plain markdown / reasoning rows) wraps its own box in this
 * host. The host supplies what `ContentViewer` gives the chunked path:
 *
 *   desktop : hover → the zero-height action bar (source / wrap / copy / fullscreen)
 *   touch   : no hover bar — the only "hover" a tap raises is the browser's
 *             SYNTHESIZED mouseenter, which would pop the bar up under the
 *             reader's finger mid-gesture. Instead: double-tap → fullscreen, and
 *             while a long body's head is scrolled away a persistent finger-sized
 *             "back to the start" button stands in for the bar's — the one action
 *             with no other one-tap route on a pointer that cannot hover.
 *             (`mobile` below is the narrow-viewport subset of this.)
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
 * The host stays mounted even before readable text or controls arrive. Only the
 * toolbar is optional; late metadata never replaces the body's ancestor chain.
 */

import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { TOUCH_POINTER_MEDIA_QUERY, useMatchMedia } from "@frontend/lib/use-match-media";
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
import { useRenderInteractive } from "../lod/RenderLodCtx";
import { useNarratorPanelVisible } from "../narrator-panel-visibility";
import type { ContentViewportSnapshot } from "../scroll/AutoFollowScroll";
import { VListContentViewActions } from "./VListContentViewActions";
import { VListTouchScrollTopButton } from "./VListTouchScrollTopButton";
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
	/**
	 * Fetch this body's un-truncated payload.
	 *
	 * Idempotent and grow-only (see `markVListFullPayloadRequested`), so every
	 * entry point can call it freely: opening the body in fullscreen, and reading
	 * far enough into it (see AUTO_LOAD_SCROLL_RATIO).
	 */
	requestFullPayload?: (target: VListViewTarget) => void;
}

/** Double-tap window (ms) — same threshold ContentViewer uses on mobile. */
const DOUBLE_TAP_MS = 300;

/**
 * How long (ms) the touch scroll-to-top button stays mounted, fading out, after
 * its body leaves the floating state.
 *
 * A fast fling walks short bodies through their floating window in a few frames
 * each; unmounting on the exact state change strobes the button at every body
 * boundary. The linger turns each exit into a fade, and a re-entry within the
 * window reuses the SAME element — the common "scrolled one body too far and
 * right back" case then never blinks at all.
 */
const TOUCH_SCROLL_TOP_LINGER_MS = 250;

/**
 * Bodies shorter than this never raise the touch scroll-to-top button, however
 * far past the fold their head scrolls. Jumping back to the start of a body that
 * is barely a screenful tall is not worth a persistent finger target — and short
 * bodies are exactly the ones a fast fling walks through their floating window
 * in a few frames, which is the strobe this button otherwise lives to avoid.
 */
const TOUCH_SCROLL_TOP_MIN_BODY_HEIGHT = 200;

/**
 * How far into a PREFIX body the reader must scroll before its full payload is
 * fetched.
 *
 * Reading past the halfway mark is the clearest available statement that this
 * body is the one being read, which is what makes the fetch a user action rather
 * than a background one — the same gate a click on a notice line used to be, minus
 * the line. Half also leaves the remaining prefix as runway: by the time the
 * reader reaches the end of it, the rest has usually landed.
 */
const AUTO_LOAD_SCROLL_RATIO = 0.5;

const relative: CSSProperties = { position: "relative" };

const PARKED: FloatState = { mode: "parked", top: 0, right: 0, bodyHeight: 0 };

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
			// `bodyHeight` is part of the comparison: a body that GROWS while floating
			// (a full payload landing) must re-evaluate the touch button's size gate
			// even though the position itself did not move.
			setState((prev) =>
				prev.mode === next.mode &&
				prev.top === next.top &&
				prev.right === next.right &&
				prev.bodyHeight === next.bodyHeight
					? prev
					: next,
			);
		};
		const schedule = () => {
			if (!raf) raf = requestAnimationFrame(evaluate);
		};
		schedule();
		const listenTarget: HTMLElement | Window = scroller ?? window;
		listenTarget.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		// Streaming/full payloads and dock resizes change geometry without either
		// a scroll event or a window resize. Observe both boxes while enabled only;
		// all notifications share the same frame-throttled measurement.
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		if (hostRef.current) observer?.observe(hostRef.current);
		if (scroller) observer?.observe(scroller);
		return () => {
			observer?.disconnect();
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

/** Only the owning viewport may report reader progress, never programmatic scroll echoes. */
function useReaderProgress(
	target: VListViewTarget | undefined,
	controls: VListViewControls | undefined,
	enabled: boolean,
): (node: HTMLElement, snapshot?: ContentViewportSnapshot) => void {
	const currentRef = useRef({ target, controls, enabled });
	currentRef.current = { target, controls, enabled };
	const firedIdRef = useRef<string | null>(null);
	const bodyIdRef = useRef(target?.id);
	useEffect(() => {
		if (bodyIdRef.current === target?.id) return;
		bodyIdRef.current = target?.id;
		firedIdRef.current = null;
	}, [target?.id]);
	return useCallback((node: HTMLElement, snapshot?: ContentViewportSnapshot) => {
		const { target: current, controls: actions, enabled: interactive } = currentRef.current;
		if (!interactive || !current?.truncated || !actions?.requestFullPayload) return;
		if (firedIdRef.current === current.id) return;
		const scrollHeight = snapshot?.scrollHeight ?? node.scrollHeight;
		const viewportHeight = snapshot?.viewportHeight ?? node.clientHeight;
		const scrollTop = snapshot?.scrollTop ?? node.scrollTop;
		const scrollable = scrollHeight - viewportHeight;
		if (scrollable <= 0 || scrollTop / scrollable < AUTO_LOAD_SCROLL_RATIO) return;
		firedIdRef.current = current.id;
		actions.requestFullPayload(current);
	}, []);
}

export interface VListContentViewHostProps {
	/** The body this host decorates; absent only suppresses the toolbar. */
	target: VListViewTarget | undefined;
	controls: VListViewControls | undefined;
	/** Extra styles merged onto the relative wrapper (never height-affecting). */
	style?: CSSProperties;
	/** Pass this callback only to the owning AutoFollowScroll, never a painter. */
	children:
		| ReactNode
		| ((
				onReaderProgress: (node: HTMLElement, snapshot?: ContentViewportSnapshot) => void,
		  ) => ReactNode);
}

export function VListContentViewHost({
	target,
	controls,
	style,
	children,
}: VListContentViewHostProps) {
	const interactive = useRenderInteractive();
	const panelVisible = useNarratorPanelVisible();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	// Own subscription, not Mantine's `useMediaQuery`: vlist test suites stub that
	// hook's whole module, which would silently kill the touch branch (see
	// `use-match-media.ts`).
	const touchPointer = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
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
	// A touch pointer is the exception — its persistent scroll-to-top button needs
	// the float state whether or not anything is hovered, so every ENABLED body on
	// such a device keeps a (rAF-throttled, scroll-invariant) tracker. The list is
	// virtualized, so "every enabled body" is bounded by what is on screen.
	const enabled = !!target && !!controls && interactive && panelVisible;
	const { state: float, scrollToBodyTop } = useFloatState(
		hostRef,
		enabled && ((hovered && !isMobile) || touchPointer),
	);
	const onReaderProgress = useReaderProgress(target, controls, interactive);

	const openFullscreen = useCallback(() => {
		if (target && controls) controls.openFullscreen(target);
	}, [target, controls]);

	// The hover bar, whenever it is (or would be) mounted. A touch pointer never
	// gets one: the only "hover" it could raise is the mouseenter a browser
	// SYNTHESIZES after a tap, which arrives exactly when the standalone touch
	// button unmounts mid-gesture — the bar would pop up under the reader's finger
	// and replace the big button with its own small one, the original complaint.
	const barMounted =
		enabled &&
		!!target &&
		!!controls &&
		hovered &&
		!isMobile &&
		!touchPointer &&
		float.mode !== "hidden";
	// Touch, head gone, enough of the body left to still be reading it: exactly the
	// state the desktop bar would call "floating". Bodies under the minimum height
	// are excluded — see TOUCH_SCROLL_TOP_MIN_BODY_HEIGHT.
	const touchScrollTopFloating =
		touchPointer &&
		enabled &&
		float.mode === "floating" &&
		float.bodyHeight >= TOUCH_SCROLL_TOP_MIN_BODY_HEIGHT;
	// Exit linger: keep the button mounted (fading) briefly after the float state
	// leaves "floating", so fast scrolls fade at body boundaries instead of
	// strobing — see TOUCH_SCROLL_TOP_LINGER_MS.
	const [touchScrollTopLinger, setTouchScrollTopLinger] = useState(false);
	useEffect(() => {
		if (touchScrollTopFloating) {
			setTouchScrollTopLinger(true);
			return;
		}
		if (!touchScrollTopLinger) return;
		const timer = setTimeout(() => setTouchScrollTopLinger(false), TOUCH_SCROLL_TOP_LINGER_MS);
		return () => clearTimeout(timer);
	}, [touchScrollTopFloating, touchScrollTopLinger]);
	// Freeze the last floating coordinates: the parked/hidden float states carry
	// placeholder zeros, which would teleport a lingering button to the viewport's
	// top-left corner mid-fade. (The real coordinates are scroll-invariant, so the
	// frozen pair stays correct for the whole fade.)
	const lastFloatingPosRef = useRef<{ top: number; right: number } | null>(null);
	if (float.mode === "floating") {
		lastFloatingPosRef.current = { top: float.top, right: float.right };
	}
	const touchScrollTopPos =
		float.mode === "floating" ? { top: float.top, right: float.right } : lastFloatingPosRef.current;

	// Touch: the action bar is hidden, so a double-tap on the body is the way in.
	// Handled HERE rather than in VListRowInteraction because a row can host
	// several bodies and the row layer cannot tell which one was tapped.
	const touchSurface = isMobile || touchPointer;
	const handleClick = useCallback(() => {
		if (!touchSurface) return;
		const now = Date.now();
		if (now - lastTapRef.current < DOUBLE_TAP_MS) {
			lastTapRef.current = 0;
			openFullscreen();
		} else {
			lastTapRef.current = now;
		}
	}, [touchSurface, openFullscreen]);

	return (
		// A Mantine Box (not a raw div) keeps the pointer handlers off a static host
		// element — the same pattern RenderSubagent's click-to-toggle header uses.
		// The mobile double-tap is a shortcut only: fullscreen is also reachable from
		// the action bar's button and from the row menu, both keyboard-operable.
		<Box
			ref={hostRef}
			style={{ ...relative, ...style }}
			data-vlist-content-host
			onMouseEnter={!enabled || touchSurface ? undefined : () => setPointerOverBody(true)}
			onMouseLeave={!enabled || touchSurface ? undefined : () => setPointerOverBody(false)}
			onClick={enabled && touchSurface ? handleClick : undefined}
		>
			{/* Mounted only while hovered, so a scrolling list builds no Tooltip /
			    CopyButton trees for bodies the reader is not pointing at. `hidden` drops
			    it entirely: too little of the body is left to host a bar. */}
			{barMounted && target && controls ? (
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
					onPointerOverChange={touchSurface ? undefined : setPointerOverBar}
				/>
			) : null}
			{/* The touch surface's standalone route back to this body's head (the bar it
			    leads on desktop never mounts without hover). Parked or `hidden` means
			    there is nothing useful to scroll back to — but the button lingers
			    briefly, fading out, so fast scrolls don't strobe it. */}
			{touchScrollTopLinger && touchScrollTopPos ? (
				<VListTouchScrollTopButton
					top={touchScrollTopPos.top}
					right={touchScrollTopPos.right}
					visible={touchScrollTopFloating}
					onScrollToTop={scrollToBodyTop}
				/>
			) : null}
			{typeof children === "function" ? children(onReaderProgress) : children}
		</Box>
	);
}
