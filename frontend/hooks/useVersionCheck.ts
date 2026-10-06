import { useCallback, useEffect, useState } from "react";
import { clearPwaCacheAndReload } from "../lib/pwa";
import { createVersionRefreshMonitor } from "../lib/version-refresh";
import { hasDisconnected, onWSStatusChange } from "../lib/ws-status";

/** Confirm the live server version before automatically replacing a stale frontend. */
export function useVersionCheck(intervalMs = 60_000) {
	const [dismissed, setDismissed] = useState(false);
	const [serverVersion, setServerVersion] = useState<string>();
	const appVersion = __APP_VERSION__.replace(/^v/, "");
	const updateAvailable = !dismissed && !!serverVersion && serverVersion !== appVersion;

	useEffect(() => {
		const monitor = createVersionRefreshMonitor(appVersion, setServerVersion);
		const check = () => void monitor.check();
		const onVisible = () => {
			if (document.visibilityState === "visible") check();
		};
		const onMessage = (event: MessageEvent) => {
			// A stale worker is only a hint; always confirm with the live server.
			if (event.data?.type === "VERSION_MISMATCH") check();
		};
		let disconnected = hasDisconnected();
		const unsubscribe = onWSStatusChange(() => {
			const next = hasDisconnected();
			if (disconnected && !next) check();
			disconnected = next;
		});
		const timer = window.setInterval(check, intervalMs);
		window.addEventListener("online", check);
		window.addEventListener("pageshow", onVisible);
		document.addEventListener("visibilitychange", onVisible);
		navigator.serviceWorker?.addEventListener("message", onMessage);
		check();
		return () => {
			monitor.stop();
			unsubscribe();
			window.clearInterval(timer);
			window.removeEventListener("online", check);
			window.removeEventListener("pageshow", onVisible);
			document.removeEventListener("visibilitychange", onVisible);
			navigator.serviceWorker?.removeEventListener("message", onMessage);
		};
	}, [appVersion, intervalMs]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset dismissal for each server build
	useEffect(() => setDismissed(false), [serverVersion]);

	const refresh = useCallback(() => clearPwaCacheAndReload(), []);
	const dismiss = useCallback(() => setDismissed(true), []);
	return { updateAvailable, serverVersion, refresh, dismiss };
}
