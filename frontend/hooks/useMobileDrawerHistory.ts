import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../lib/history-state";
import { useMobileViewport } from "./useMobileViewport";

/**
 * Give a mobile Drawer one same-URL history entry so the system Back action closes it before
 * navigating away. Desktop drawers keep normal Back navigation, subject to an optional draft guard.
 *
 * Router access is null-guarded: test harnesses and non-router mounts render drawers without
 * a RouterProvider, and evaluating `router.history` in the dependency array threw before the
 * effect body could early-return.
 */
/** Return false from onClose to keep the drawer open and re-arm its Back entry. */
export function useMobileDrawerHistory(
	opened: boolean,
	onClose: (() => void) | (() => boolean),
	canNavigate?: () => boolean,
): void {
	const router = useRouter();
	const isMobile = useMobileViewport();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const canNavigateRef = useRef(canNavigate);
	canNavigateRef.current = canNavigate;
	const history = router?.history;
	const [backAttempt, setBackAttempt] = useState(0);
	const sentinelArmedRef = useRef(false);

	useEffect(() => {
		if (!opened || !history) return;
		// The draft outlives a viewport change. Register before the mobile sentinel's
		// blocker, which replays accepted PUSH/REPLACE with ignoreBlocker.
		return history.block({
			enableBeforeUnload: false,
			blockerFn: ({ action, currentLocation, nextLocation }) => {
				// Only one step off the live same-URL sentinel is a drawer-close attempt.
				// Its observer calls onClose after POP; real route traversals use the guard
				// on both desktop and mobile (including GO that skips over the sentinel).
				if (
					action !== "PUSH" &&
					action !== "REPLACE" &&
					sentinelArmedRef.current &&
					currentLocation.state.__NF_sentinel_id &&
					currentLocation.state.__NF_sentinel_id !== nextLocation.state.__NF_sentinel_id &&
					currentLocation.href === nextLocation.href &&
					currentLocation.state.__TSR_index - nextLocation.state.__TSR_index === 1
				) {
					return false;
				}
				return canNavigateRef.current?.() === false;
			},
		});
	}, [opened, history]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a rejected POP must re-arm the consumed sentinel
	useEffect(() => {
		if (!opened || !isMobile || !history) return;
		sentinelArmedRef.current = true;
		const sentinel = pushHistorySentinel(history, APP_HISTORY_SENTINEL.mobileNav, () => {
			sentinelArmedRef.current = false;
			// POP already consumed this entry. A rejected close needs a new entry,
			// otherwise the next hardware Back would navigate away from the draft.
			if (onCloseRef.current() === false) setBackAttempt((attempt) => attempt + 1);
		});
		return () => {
			sentinelArmedRef.current = false;
			sentinel.dispose();
		};
	}, [opened, isMobile, history, backAttempt]);
}
