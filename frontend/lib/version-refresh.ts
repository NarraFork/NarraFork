import { clearPwaCacheAndReload, fetchServerHealth, stashStartupRecoveryFailure } from "./pwa";

const RELOAD_KEY = "narrafork_version_reload";

/** One automatic attempt per build pair and tab. A stale proxy must not cause a reload loop. */
export function claimVersionReload(appVersion: string, serverVersion: string): boolean {
	const pair = JSON.stringify([appVersion.replace(/^v/, ""), serverVersion.replace(/^v/, "")]);
	try {
		if (sessionStorage.getItem(RELOAD_KEY) === pair) return false;
		sessionStorage.setItem(RELOAD_KEY, pair);
		return true;
	} catch {
		// Without persistent loop protection leave the manual update banner available.
		return false;
	}
}

export function createVersionRefreshMonitor(
	appVersion: string,
	onVersion: (version: string) => void,
	dependencies = {
		fetchHealth: fetchServerHealth,
		reload: clearPwaCacheAndReload,
		claim: claimVersionReload,
	},
) {
	const controller = new AbortController();
	let pending: Promise<void> | undefined;
	let reloadStarted = false;
	const check = (): Promise<void> => {
		if (controller.signal.aborted || reloadStarted) return Promise.resolve();
		if (pending) return pending;
		pending = (async () => {
			const health = await dependencies.fetchHealth(3000, controller.signal);
			if (controller.signal.aborted || !health?.version) return;
			const version = health.version.replace(/^v/, "");
			onVersion(version);
			if (version === appVersion.replace(/^v/, "")) return;
			if (!dependencies.claim(appVersion, version)) return;
			reloadStarted = true;
			if (health.readiness === "failed" || health.status === "failed") {
				stashStartupRecoveryFailure(health.recoveryError);
			}
			await dependencies.reload();
		})()
			.catch((error) => console.warn("[PWA] Version refresh failed:", error))
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
	return { check, stop: () => controller.abort() };
}
