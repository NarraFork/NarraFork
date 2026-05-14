import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

function normalizeVersion(version: string | undefined): string | undefined {
	return version?.replace(/^v/, "");
}

/**
 * Periodically checks the backend version against the frontend build version.
 * Returns `updateAvailable: true` when they differ, plus a `refresh()` helper
 * that clears the service worker cache and reloads the page.
 *
 * Also listens for VERSION_MISMATCH messages from the service worker,
 * which performs its own version check on activation.
 */
export function useVersionCheck(intervalMs = 5 * 60_000) {
	const [dismissed, setDismissed] = useState(false);
	const [swServerVersion, setSwServerVersion] = useState<string | undefined>();

	const { data } = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		refetchInterval: intervalMs,
		staleTime: intervalMs,
	});

	const appVersion = normalizeVersion(__APP_VERSION__);
	const healthVersion = normalizeVersion(data?.version);
	const serverVersion =
		healthVersion === appVersion ? data?.version : (swServerVersion ?? data?.version);
	const updateAvailable =
		!dismissed &&
		!!normalizeVersion(serverVersion) &&
		normalizeVersion(serverVersion) !== appVersion;

	// Listen for VERSION_MISMATCH from service worker. The message only provides
	// another source of the backend version; the banner is still gated by comparing
	// the backend version to the current frontend build version.
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			if (event.data?.type === "VERSION_MISMATCH") {
				setSwServerVersion(event.data.serverVersion);
			}
		};
		navigator.serviceWorker?.addEventListener("message", handler);
		return () => navigator.serviceWorker?.removeEventListener("message", handler);
	}, []);

	useEffect(() => {
		if (healthVersion === appVersion) {
			setSwServerVersion(undefined);
		}
	}, [appVersion, healthVersion]);

	// Auto-reset dismissed flag when version changes again
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when serverVersion changes
	useEffect(() => {
		setDismissed(false);
	}, [serverVersion]);

	const refresh = useCallback(async () => {
		const { clearPwaCacheAndReload } = await import("../lib/pwa");
		await clearPwaCacheAndReload();
	}, []);

	const dismiss = useCallback(() => setDismissed(true), []);

	return { updateAvailable, serverVersion, refresh, dismiss };
}
