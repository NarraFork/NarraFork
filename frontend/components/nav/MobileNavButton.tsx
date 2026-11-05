/**
 * The phone's menu button.
 *
 * Phones have no header row: the brand and the bell are in the drawer, and each page's own
 * title row is the top of the screen. Pages put `MobileNavButton` at the start of that row.
 * Pages that do not (full-bleed docks, nested settings pages) get `MobileNavFallback`, a
 * small floating button in the top-left corner, so the drawer is always reachable.
 *
 * Both render only on phones (the `nf-mobile-only` class, safe-area.css) and only inside
 * the app shell.
 *
 * Plain elements, not Mantine's `Burger`: route pages import this, and several of their
 * test suites replace `@mantine/core` with a partial mock (`mock.module` leaks across
 * files under `bun test`), where a new named export from it does not exist.
 */

import { type CSSProperties, useEffect, useSyncExternalStore } from "react";
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

/** Three bars, 18px wide: Mantine's `Burger size="sm"` look without the import. */
function MenuIcon() {
	return (
		<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
			<path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="2" />
		</svg>
	);
}

const BUTTON_STYLE: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 28,
	height: 28,
	padding: 0,
	flexShrink: 0,
	border: 0,
	borderRadius: "var(--mantine-radius-sm)",
	background: "transparent",
	color: "var(--mantine-color-text)",
	cursor: "pointer",
};

export function MobileNavButton() {
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
		<button
			type="button"
			className="nf-mobile-only"
			onClick={nav.toggle}
			aria-label={t("openNavigation")}
			aria-expanded={nav.opened}
			data-mobile-nav-button
			style={BUTTON_STYLE}
		>
			<MenuIcon />
		</button>
	);
}

/** Floating top-left menu button for pages whose own title row has none. */
export function MobileNavFallback() {
	const nav = useMobileNav();
	const { t } = useTranslation("nav");
	const covered = useSyncExternalStore(subscribe, hasInline, hasInline);
	if (!nav || covered || nav.opened) return null;
	return (
		<button
			type="button"
			className="nf-mobile-only"
			onClick={nav.toggle}
			aria-label={t("openNavigation")}
			aria-expanded={false}
			data-mobile-nav-fallback
			style={{
				...BUTTON_STYLE,
				position: "fixed",
				top: `calc(${SAFE_AREA_INSET_TOP} + 8px)`,
				left: `calc(${SAFE_AREA_INSET_LEFT} + 8px)`,
				zIndex: 150,
				width: 32,
				height: 32,
				background: "var(--mantine-color-body)",
				borderRadius: "var(--mantine-radius-md)",
				boxShadow: "var(--mantine-shadow-sm)",
			}}
		>
			<MenuIcon />
		</button>
	);
}
