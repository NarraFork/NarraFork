import { useMediaQuery } from "@mantine/hooks";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../lib/history-state";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../lib/responsive";

/**
 * Give a mobile Drawer one same-URL history entry so the system Back action closes it before
 * navigating away. Desktop drawers deliberately keep the browser's normal Back behavior.
 */
export function useMobileDrawerHistory(opened: boolean, onClose: () => void): void {
	const router = useRouter();
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!opened || !isMobile) return;
		return pushHistorySentinel(router.history, APP_HISTORY_SENTINEL.mobileNav, () => {
			onCloseRef.current();
		}).dispose;
	}, [opened, isMobile, router.history]);
}
