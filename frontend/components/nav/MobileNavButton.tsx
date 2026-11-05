/**
 * The phone's menu button.
 *
 * Phones have no header row: the brand and the bell are in the drawer, and each page's own
 * title row is the top of the screen. Pages put `MobileNavButton` at the start of that row.
 * Pages that do not (full-bleed docks, nested settings pages) get `MobileNavFallback`, a
 * small floating button in the top-left corner, so the drawer is always reachable.
 *
 * Both render only on phones (`hiddenFrom`) and only inside the app shell.
 */

import { Burger } from "@mantine/core";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { SAFE_AREA_INSET_LEFT, SAFE_AREA_INSET_TOP } from "../../lib/safe-area";
import { useMobileNav } from "./nav-render-context";

// How many inline buttons are mounted. The fallback shows only while there are none.
let inlineCount = 0;
const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const hasInline = () => inlineCount > 0;

export function MobileNavButton({ size = "sm" }: { size?: "xs" | "sm" }) {
	const nav = useMobileNav();
	const { t } = useTranslation("nav");
	const present = !!nav;
	useEffect(() => {
		if (!present) return;
		inlineCount++;
		notify();
		return () => {
			inlineCount--;
			notify();
		};
	}, [present]);
	if (!nav) return null;
	return (
		<Burger
			opened={nav.opened}
			onClick={nav.toggle}
			hiddenFrom="sm"
			size={size}
			aria-label={t("openNavigation")}
			data-mobile-nav-button
			style={{ flexShrink: 0 }}
		/>
	);
}

/** Floating top-left menu button for pages whose own title row has none. */
export function MobileNavFallback() {
	const nav = useMobileNav();
	const { t } = useTranslation("nav");
	const covered = useSyncExternalStore(subscribe, hasInline, hasInline);
	if (!nav || covered || nav.opened) return null;
	return (
		<Burger
			opened={false}
			onClick={nav.toggle}
			hiddenFrom="sm"
			size="sm"
			aria-label={t("openNavigation")}
			data-mobile-nav-fallback
			style={{
				position: "fixed",
				top: `calc(${SAFE_AREA_INSET_TOP} + 8px)`,
				left: `calc(${SAFE_AREA_INSET_LEFT} + 8px)`,
				zIndex: 150,
				background: "var(--mantine-color-body)",
				borderRadius: "var(--mantine-radius-md)",
				boxShadow: "var(--mantine-shadow-sm)",
			}}
		/>
	);
}
