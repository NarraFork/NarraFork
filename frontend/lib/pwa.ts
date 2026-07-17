interface ServerHealth {
	status: string;
	version?: string;
}

export interface WaitForUpdatedServerOptions {
	targetVersion?: string;
	requestTimeoutMs?: number;
	intervalMs?: number;
	signal?: AbortSignal;
}

function normalizeVersion(version: string | undefined): string | undefined {
	return version?.replace(/^v/, "");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			window.clearTimeout(timeout);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timeout = window.setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

async function fetchServerHealth(
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ServerHealth | null> {
	if (signal?.aborted) return null;
	const controller = new AbortController();
	const abortFromParent = () => controller.abort();
	signal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`/api/health?_=${Date.now()}`, {
			cache: "no-store",
			headers: { "Cache-Control": "no-cache" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		return (await response.json()) as ServerHealth;
	} catch {
		return null;
	} finally {
		window.clearTimeout(timeout);
		signal?.removeEventListener("abort", abortFromParent);
	}
}

/**
 * Clear all PWA caches and unregister service workers.
 * Used when applying updates to ensure fresh assets are loaded.
 */
export async function clearPwaCache(): Promise<void> {
	try {
		// Unregister all service workers controlling this origin.
		if ("serviceWorker" in navigator) {
			const registrations =
				typeof navigator.serviceWorker.getRegistrations === "function"
					? await navigator.serviceWorker.getRegistrations()
					: [await navigator.serviceWorker.getRegistration()].filter(
							(reg): reg is ServiceWorkerRegistration => !!reg,
						);

			if (registrations.length > 0) {
				await Promise.allSettled(registrations.map((reg) => reg.unregister()));
				console.log(`[PWA] Unregistered ${registrations.length} service workers`);
			}
		}

		// Clear all Cache Storage entries.
		if ("caches" in window) {
			const keys = await caches.keys();
			if (keys.length > 0) {
				await Promise.allSettled(keys.map((k) => caches.delete(k)));
				console.log(`[PWA] Cleared ${keys.length} caches`);
			}
		}
	} catch (err) {
		console.warn("[PWA] Failed to clear cache:", err);
		// Continue anyway - the reload will still work
	}
}

/**
 * Clear PWA cache and reload the page.
 */
export async function clearPwaCacheAndReload(): Promise<void> {
	await clearPwaCache();
	window.location.reload();
}

/**
 * Poll the backend until the updated server is responding, then clear stale PWA
 * state and reload into the new frontend bundle.
 */
export async function waitForUpdatedServerAndReload({
	targetVersion,
	requestTimeoutMs = 3000,
	intervalMs = 1000,
	signal,
}: WaitForUpdatedServerOptions = {}): Promise<void> {
	const normalizedTarget = normalizeVersion(targetVersion);

	while (!signal?.aborted) {
		const health = await fetchServerHealth(requestTimeoutMs, signal);
		if (signal?.aborted) return;
		const serverVersion = normalizeVersion(health?.version);
		const serverReady =
			health?.status === "ok" && (!normalizedTarget || serverVersion === normalizedTarget);

		if (serverReady) {
			await clearPwaCacheAndReload();
			return;
		}

		await delay(intervalMs, signal);
	}
}
