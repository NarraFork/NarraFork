import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * Periodically checks the backend version against the frontend build version.
 * Returns `updateAvailable: true` when they differ, plus a `refresh()` helper
 * that clears the service worker cache and reloads the page.
 */
export function useVersionCheck(intervalMs = 5 * 60_000) {
	const [dismissed, setDismissed] = useState(false);

	const { data } = useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		refetchInterval: intervalMs,
		staleTime: intervalMs,
	});

	const serverVersion = data?.version;
	const updateAvailable = !dismissed && !!serverVersion && serverVersion !== __APP_VERSION__;

	// Auto-reset dismissed flag when version changes again
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when serverVersion changes
	useEffect(() => {
		setDismissed(false);
	}, [serverVersion]);

	const refresh = useCallback(async () => {
		try {
			const reg = await navigator.serviceWorker?.getRegistration();
			await reg?.unregister();
			const keys = await caches.keys();
			await Promise.all(keys.map((k) => caches.delete(k)));
		} catch {
			// proceed to reload regardless
		}
		window.location.reload();
	}, []);

	const dismiss = useCallback(() => setDismissed(true), []);

	return { updateAvailable, serverVersion, refresh, dismiss };
}
