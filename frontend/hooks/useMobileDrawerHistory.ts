import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../lib/history-state";
import { useMobileViewport } from "./useMobileViewport";

/**
 * Give a mobile Drawer one same-URL history entry so the system Back action closes it before
 * navigating away. Desktop drawers deliberately keep the browser's normal Back behavior.
 *
 * Router access is null-guarded: test harnesses and non-router mounts render drawers without
 * a RouterProvider, and evaluating `router.history` in the dependency array threw before the
 * effect body could early-return.
 */
export function useMobileDrawerHistory(opened: boolean, onClose: () => void): void {
	const router = useRouter();
	const isMobile = useMobileViewport();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const history = router?.history;

	useEffect(() => {
		if (!opened || !isMobile || !history) return;
		return pushHistorySentinel(history, APP_HISTORY_SENTINEL.mobileNav, () => {
			onCloseRef.current();
		}).dispose;
	}, [opened, isMobile, history]);
}
