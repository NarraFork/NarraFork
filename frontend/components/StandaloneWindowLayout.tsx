import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuthenticatedAppearance } from "../hooks/useAuthenticatedAppearance";
import { useAuthenticatedSession } from "../hooks/useAuthenticatedSession";
import { useUserPreferences } from "../hooks/useUserPreferences";
import { clearToken } from "../lib/api";
import { useBrowserLayoutEffect } from "../lib/app-shell-scroll";
import { installAppViewportTracking, installAuthenticatedAppShellRootLock } from "../lib/safe-area";
import { isStandaloneWindowPath } from "../lib/standalone-window";
import classes from "./StandaloneWindowLayout.module.css";

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
	useAuthenticatedAppearance(prefs);
	useBrowserLayoutEffect(() => {
		const unlock = installAuthenticatedAppShellRootLock();
		const stopViewportTracking = installAppViewportTracking();
		return () => {
			stopViewportTracking();
			unlock();
		};
	}, []);
	// Read-only commit windows need no global WS. Future realtime panels own their subscriptions.
	return (
		<main className={classes.window} data-standalone-window>
			<Outlet />
		</main>
	);
}
