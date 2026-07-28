/**
 * HeaderPullToRefresh — pull-down-to-refresh on the app header.
 *
 * WHY THE HEADER AND NOT THE PAGE BODY
 *
 * Almost every screen in the app owns its own scroll container (the narrator
 * virtual list, terminals, the story-network canvas), and several of them are
 * pinned to the viewport. A document-level pull gesture would either fight those
 * containers for the same touch or never fire at all, because the body is not what
 * scrolls. The header is the one strip that is always present, never scrolls, and
 * has no competing vertical gesture — so the gesture is scoped to it.
 *
 * WHAT "REFRESH" MEANS HERE
 *
 * A full page reload, matching what the gesture means everywhere else on mobile:
 * the browser chrome is hidden in a PWA, so this IS the reload button. A softer
 * `invalidateQueries()` would refetch server state but keep a stale bundle, a
 * wedged WebSocket, and any corrupted client state — exactly the situations the
 * user pulls down to escape.
 *
 * The service worker and Cache Storage are torn down first, so a stale bundle
 * cannot be served back: an installed PWA otherwise answers the reload from its
 * own cache and nothing appears to change.
 *
 * The gesture is deliberately hard to trigger by accident (64px of travel, aborted
 * by any sideways drift) because a reload does discard in-page state.
 *
 * TOUCH ONLY
 *
 * The caller gates `enabled` on `(pointer: coarse)`. A mouse drag across the
 * header already has a meaning (the sidebar resize handle / collapse toggle), and
 * this must not take it over.
 *
 * HEIGHT SAFETY
 *
 * The indicator is absolutely positioned inside the header and never participates
 * in layout, so arming the gesture cannot shift the header's contents or change
 * any measured height elsewhere in the app.
 */

import { clearPwaCache } from "@frontend/lib/pwa";
import { SAFE_AREA_INSET_TOP } from "@frontend/lib/safe-area";
import { Box, Loader, Text } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Vertical distance (px) the finger must travel before the gesture is armed. */
const ARM_DISTANCE_PX = 64;
/**
 * Horizontal slop (px) tolerated before the touch is treated as a horizontal
 * swipe and abandoned. The header hosts a horizontally scrollable tab strip, so a
 * sideways drag must never be mistaken for a pull.
 */
const HORIZONTAL_ABORT_PX = 24;
/** How far the indicator travels; the pull is damped so it feels elastic. */
const MAX_INDICATOR_OFFSET_PX = 48;
/**
 * Cap on how long the cache teardown may delay the reload.
 *
 * Unregistering service workers and emptying Cache Storage is usually instant, but
 * a wedged service worker is exactly the state a user pulls down to escape — so
 * the reload must not be held hostage by it. On timeout we navigate anyway.
 */
const CACHE_CLEAR_TIMEOUT_MS = 2500;

/**
 * `reloading` is TERMINAL: the page is on its way out, so there is no transition
 * back to `idle` from it.
 */
export type GesturePhase = "idle" | "pulling" | "armed" | "reloading";

/** What one touchmove means for the gesture. */
export type PullStep =
	| { kind: "abort" }
	| { kind: "track"; phase: "pulling" | "armed"; offsetPx: number };

/**
 * Classify a finger movement relative to where the touch started.
 *
 * Extracted as a pure function so the thresholds are testable without a DOM and a
 * synthetic touch stream: the geometry (when a pull arms, when a sideways drag
 * wins) is the part worth pinning down, and it is invisible in a render test.
 */
export function classifyPullStep(dx: number, dy: number): PullStep {
	// Upward or sideways → not this gesture. The caller ABANDONS the touch rather
	// than merely resetting, so a horizontal tab-strip swipe cannot re-arm halfway.
	if (dy <= 0 || Math.abs(dx) > HORIZONTAL_ABORT_PX) return { kind: "abort" };
	// Damped travel: the indicator approaches its limit asymptotically, so the pull
	// keeps responding past the arm threshold without running away.
	const offsetPx = MAX_INDICATOR_OFFSET_PX * (1 - Math.exp(-dy / ARM_DISTANCE_PX));
	return { kind: "track", phase: dy >= ARM_DISTANCE_PX ? "armed" : "pulling", offsetPx };
}

export interface HeaderPullToRefreshProps {
	/** The header element the gesture is scoped to. */
	targetRef: RefObject<HTMLElement | null>;
	/** Touch-capable pointer and no modal wizard in the way. */
	enabled: boolean;
}

export function HeaderPullToRefresh({ targetRef, enabled }: HeaderPullToRefreshProps) {
	const { t } = useTranslation("nav");
	const [phase, setPhase] = useState<GesturePhase>("idle");
	const [pullPx, setPullPx] = useState(0);

	// Touch bookkeeping lives in refs: these update on every touchmove and must not
	// re-render the header. Only the damped offset and the phase reach state.
	const startRef = useRef<{ x: number; y: number; id: number } | null>(null);
	const abortedRef = useRef(false);
	// The touch listeners are registered once per enable/disable, so reading `phase`
	// directly inside them would capture a stale value from that render.
	const phaseRef = useRef(phase);
	phaseRef.current = phase;
	// A reload is one-way: once armed, further pulls must not queue a second
	// navigation while the cache teardown runs.
	const reloadingRef = useRef(false);

	/**
	 * Tear down the PWA cache, then navigate.
	 *
	 * There is no path back to `idle` — the page goes away, so the spinner stays up
	 * until the document is replaced. The one thing that must not happen is getting
	 * stuck showing it forever, hence the timeout.
	 *
	 * `clearPwaCache` (not `clearPwaCacheAndReload`) so the navigation stays in one
	 * place here and can be raced against that timeout. It swallows its own errors
	 * and never rejects, so the timeout genuinely only covers a teardown that hangs.
	 */
	const runReload = useCallback(() => {
		if (reloadingRef.current) return;
		reloadingRef.current = true;
		setPhase("reloading");
		setPullPx(0);

		let navigated = false;
		const navigate = () => {
			if (navigated) return;
			navigated = true;
			window.location.reload();
		};
		const timer = setTimeout(navigate, CACHE_CLEAR_TIMEOUT_MS);
		void clearPwaCache().finally(() => {
			clearTimeout(timer);
			navigate();
		});
	}, []);

	useEffect(() => {
		const target = targetRef.current;
		if (!enabled || !target) return;

		const reset = () => {
			startRef.current = null;
			abortedRef.current = false;
			setPullPx(0);
			// Never clobber a pending reload's own phase — its spinner stays up until
			// the document is replaced.
			if (!reloadingRef.current) setPhase("idle");
		};

		const onTouchStart = (event: TouchEvent) => {
			// Multi-touch is a pinch/zoom, not a pull. Once a reload is pending, further
			// pulls are ignored.
			if (reloadingRef.current || event.touches.length !== 1) return;
			const touch = event.touches[0];
			if (!touch) return;
			startRef.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
			abortedRef.current = false;
		};

		const onTouchMove = (event: TouchEvent) => {
			const start = startRef.current;
			if (!start || abortedRef.current) return;
			const touch = Array.from(event.touches).find((c) => c.identifier === start.id);
			if (!touch) return;

			const step = classifyPullStep(touch.clientX - start.x, touch.clientY - start.y);
			if (step.kind === "abort") {
				abortedRef.current = true;
				setPullPx(0);
				setPhase("idle");
				return;
			}
			setPullPx(step.offsetPx);
			setPhase(step.phase);
		};

		const onTouchEnd = () => {
			const armed = !abortedRef.current && startRef.current != null && phaseRef.current === "armed";
			startRef.current = null;
			abortedRef.current = false;
			if (armed) {
				runReload();
				return;
			}
			reset();
		};

		// `passive: true` throughout: the gesture never calls preventDefault (the
		// header does not scroll, so there is nothing to suppress) and a passive
		// listener cannot stall scrolling elsewhere.
		const options = { passive: true } as const;
		target.addEventListener("touchstart", onTouchStart, options);
		target.addEventListener("touchmove", onTouchMove, options);
		target.addEventListener("touchend", onTouchEnd, options);
		target.addEventListener("touchcancel", onTouchEnd, options);
		return () => {
			target.removeEventListener("touchstart", onTouchStart);
			target.removeEventListener("touchmove", onTouchMove);
			target.removeEventListener("touchend", onTouchEnd);
			target.removeEventListener("touchcancel", onTouchEnd);
			reset();
		};
	}, [enabled, targetRef, runReload]);

	if (!enabled || phase === "idle") return null;

	const isReloading = phase === "reloading";
	const label = isReloading
		? t("pullToRefreshLoading")
		: phase === "armed"
			? t("pullToRefreshRelease")
			: t("pullToRefreshPullDown");

	return (
		<Box
			// Absolutely positioned and pointer-transparent: the indicator must not
			// take part in the header's layout or intercept the touch driving it.
			style={{
				position: "absolute",
				top: `calc(${SAFE_AREA_INSET_TOP} + 4px)`,
				left: 0,
				right: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 6,
				pointerEvents: "none",
				zIndex: 3,
				transform: `translateY(${isReloading ? MAX_INDICATOR_OFFSET_PX / 2 : pullPx}px)`,
				// Settle under animation on release, but follow the finger 1:1 while it
				// is down.
				transition: isReloading ? "transform 150ms ease-out" : undefined,
			}}
		>
			{isReloading ? (
				<Loader size={14} />
			) : (
				<IconArrowDown
					size={14}
					style={{
						transition: "transform 150ms ease-out",
						// Flipping the arrow is the "you can let go now" signal.
						transform: phase === "armed" ? "rotate(180deg)" : undefined,
					}}
				/>
			)}
			<Text size="xs" c="dimmed">
				{label}
			</Text>
		</Box>
	);
}
