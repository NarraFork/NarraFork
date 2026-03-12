import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { clearPwaCacheAndReload } from "../lib/pwa";

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
	const [swMismatch, setSwMismatch] = useState(false);
	const [swServerVersion, setSwServerVersion] = useState<string | undefined>();

	const { data } = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		refetchInterval: intervalMs,
		staleTime: intervalMs,
	});

	const serverVersion = swServerVersion ?? data?.version;
	const updateAvailable =
		!dismissed && (swMismatch || (!!serverVersion && serverVersion !== __APP_VERSION__));

	// Listen for VERSION_MISMATCH from service worker
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			if (event.data?.type === "VERSION_MISMATCH") {
				setSwMismatch(true);
				setSwServerVersion(event.data.serverVersion);
			}
		};
		navigator.serviceWorker?.addEventListener("message", handler);
		return () => navigator.serviceWorker?.removeEventListener("message", handler);
	}, []);

	// Auto-reset dismissed flag when version changes again
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when serverVersion changes
	useEffect(() => {
		setDismissed(false);
	}, [serverVersion]);

	const refresh = useCallback(async () => {
		await clearPwaCacheAndReload();
	}, []);

	const dismiss = useCallback(() => setDismissed(true), []);

	return { updateAvailable, serverVersion, refresh, dismiss };
}
