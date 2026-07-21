interface ServerHealth {
	/** Overall health status reported by the replacement server. */
	status: string;
	version?: string;
	/** Explicit recovery state: "recovering" | "ready" | "failed". */
	readiness?: string;
	recoveryError?: string;
}

export interface WaitForUpdatedServerOptions {
	targetVersion?: string;
	requestTimeoutMs?: number;
	intervalMs?: number;
	/** Total bound for replacement startup, including failed requests and polling delays. */
	maxWaitMs?: number;
	signal?: AbortSignal;
}

function normalizeVersion(version: string | undefined): string | undefined {
	return version?.replace(/^v/, "");
}

/**
 * Decide whether the polled server is the updated build we can reload into.
 *
 * The replacement binary starts serving (its reported version flips to the new one) as soon as
 * it binds the port, even while it finishes background narrator-continuation recovery. During
 * that window the health endpoint reports `status: "recovering"` rather than `"ok"`. Recovery is
 * a backend concern and must not block loading the new frontend bundle, so a `recovering` server
 * is reloadable AS LONG AS we can prove it is the target build. Without an explicit target
 * version, automatic reload is unsafe because a still-running old server is indistinguishable
 * from the replacement.
 */
export function isUpdatedServerReadyForReload(
	health: ServerHealth | null,
	targetVersion: string | undefined,
): boolean {
	const normalizedTarget = normalizeVersion(targetVersion);
	if (!health || !normalizedTarget) return false;
	if (health.status === "failed" || health.readiness === "failed") return false;
	const serverVersion = normalizeVersion(health.version);
	if (serverVersion !== normalizedTarget) return false;
	return (
		health.status === "ok" ||
		health.status === "recovering" ||
		health.readiness === "ready" ||
		health.readiness === "recovering"
	);
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
		// The backend intentionally returns HTTP 503 with a JSON health payload when startup
		// recovery failed. Preserve that payload so polling can stop and surface the real error.
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
	maxWaitMs = 5 * 60 * 1000,
	signal,
}: WaitForUpdatedServerOptions = {}): Promise<void> {
	const normalizedTarget = normalizeVersion(targetVersion);
	if (!normalizedTarget) {
		throw new Error("Updated server target version is required before automatic reload.");
	}
	const deadline = Date.now() + maxWaitMs;
	while (!signal?.aborted) {
		const health = await fetchServerHealth(requestTimeoutMs, signal);
		if (signal?.aborted) return;
		if (health?.status === "failed" || health?.readiness === "failed") {
			throw new Error(health.recoveryError || "Updated server startup recovery failed.");
		}
		if (isUpdatedServerReadyForReload(health, normalizedTarget)) {
			await clearPwaCacheAndReload();
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for updated server version ${normalizedTarget} after ${Math.round(maxWaitMs / 1000)} seconds.`,
			);
		}
		await delay(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)), signal);
	}
}
