import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { resolveBranding } from "@shared/branding";
import { Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useAuthenticatedAppearance } from "../hooks/useAuthenticatedAppearance";
import { useAuthenticatedSession } from "../hooks/useAuthenticatedSession";
import { useUserPreferences } from "../hooks/useUserPreferences";
import { clearToken } from "../lib/api";
import { useBrowserLayoutEffect } from "../lib/app-shell-scroll";
import { getCurrentBranding, onBrandingChange } from "../lib/branding";
import { installAppViewportTracking, installAuthenticatedAppShellRootLock } from "../lib/safe-area";
import { isStandaloneWindowPath } from "../lib/standalone-window";
import { installThemeColorSync } from "../lib/theme-color-sync";
import { installWcoTracking } from "../lib/wco";
import classes from "./StandaloneWindowLayout.module.css";

/**
 * Window-title channel between a /windows/* page and the layout's drag strip.
 *
 * The strip (visible only in WCO mode, where the window has no native title bar
 * of its own) shows this title; the layout also mirrors it into `document.title`
 * so OS window switchers name the window. Pages that never set one get the
 * brand name on both.
 */
const WindowTitleSetterContext = createContext<(title: string | null) => void>(() => {});

/** Publish a window title for the WCO drag strip + document.title. */
export function useStandaloneWindowTitle(title: string | null) {
	const setTitle = useContext(WindowTitleSetterContext);
	useEffect(() => {
		setTitle(title);
		return () => setTitle(null);
	}, [title, setTitle]);
}

/** Private content, not a share capability. Navigation and its subscriptions never mount here. */
export function StandaloneWindowLayout() {
	const {
		data: user,
		hasToken,
		sessionLost,
		isLoading,
		fetchStatus,
		error,
		refetch,
	} = useAuthenticatedSession();
	const redirect = useRouterState({
		select: (state) =>
			isStandaloneWindowPath(state.location.pathname) ? state.location.href : undefined,
	});
	const { t } = useTranslation("common");
	useEffect(() => {
		if (sessionLost) clearToken();
	}, [sessionLost]);
	// The router retains outgoing matches during transitions. Never re-redirect a login URL.
	if (!redirect) return null;
	if (!hasToken || sessionLost) return <Navigate to="/login" search={{ redirect }} replace />;
	if (isLoading || (!user && fetchStatus === "fetching"))
		return (
			<Center h="100dvh">
				<Loader />
			</Center>
		);
	// A temporary auth lookup failure must not expose content or destroy the session.
	if (!user)
		return (
			<Center mih="100dvh" p="md">
				<Alert color="red" role="alert">
					<Stack gap="sm">
						{error?.message || t("unknownError")}
						<Button onClick={() => void refetch()}>{t("refresh")}</Button>
					</Stack>
				</Alert>
			</Center>
		);
	return <StandaloneWindowContent />;
}

function StandaloneWindowContent() {
	const { data: prefs } = useUserPreferences();
	// Read the branded name from the module store instead of useBranding(): the
	// standalone layout is mounted without the main app's QueryClient, and the boot
	// script already applied the last known branding before React attaches.
	const brandName = useSyncExternalStore(
		onBrandingChange,
		() => getCurrentBranding().name,
		() => resolveBranding(undefined).name,
	);
	const [windowTitle, setWindowTitle] = useState<string | null>(null);
	useAuthenticatedAppearance(prefs);
	useBrowserLayoutEffect(() => {
		const unlock = installAuthenticatedAppShellRootLock();
		const stopViewportTracking = installAppViewportTracking();
		// WCO awareness for standalone windows: the strip below becomes the drag
		// surface, and the OS buttons' theme-color background must track the theme.
		const stopWcoTracking = installWcoTracking();
		const stopThemeColorSync = installThemeColorSync();
		return () => {
			stopThemeColorSync();
			stopWcoTracking();
			stopViewportTracking();
			unlock();
		};
	}, []);

	useEffect(() => {
		document.title = windowTitle ? `${windowTitle} · ${brandName}` : brandName;
	}, [windowTitle, brandName]);

	// Realtime panels (chat, terminal, …) mount their own WS connection; the
	// layout only owns chrome. See routes/windows/panel.tsx.
	return (
		<WindowTitleSetterContext.Provider value={setWindowTitle}>
			<main className={classes.window} data-standalone-window>
				{/* WCO drag strip: display:none outside WCO (see styles/wco.css), so this
				    costs nothing in browser popups where native chrome already drags. */}
				<div className="nf-wco-window-strip" aria-hidden>
					<span className="nf-wco-window-strip-title">{windowTitle ?? brandName}</span>
				</div>
				<Outlet />
			</main>
		</WindowTitleSetterContext.Provider>
	);
}
