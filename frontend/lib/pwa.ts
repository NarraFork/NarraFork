import { apiUrl } from "./base-path";

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
 * Version identity is the entire question. The replacement binary starts serving as soon as it
 * binds the port and reports the new version immediately, so a version match is what proves the
 * replacement — not the old process — is the one answering. Without an explicit target version
 * automatic reload is unsafe, because a still-running old server is indistinguishable from it.
 *
 * Recovery state deliberately does NOT gate the reload, in any of its values:
 *   - `recovering` finishes in the background and only concerns backend continuations;
 *   - `failed` means some narrator could not be restored (typically pinned to a provider prefix
 *     that no longer exists in settings).
 *
 * Neither makes the HTTP surface unusable. The server is explicit about this: `shouldServeRequests`
 * is unconditionally true so the frontend, auth and settings routes stay reachable, precisely
 * because those are what repair the state that made recovery fail. Blocking the reload here
 * inverted that policy — the new server was already up and serving while the user stayed pinned
 * to the old bundle by the very error the new UI is needed to fix.
 */
export function isUpdatedServerReadyForReload(
	health: ServerHealth | null,
	targetVersion: string | undefined,
): boolean {
	const normalizedTarget = normalizeVersion(targetVersion);
	if (!health || !normalizedTarget) return false;
	return normalizeVersion(health.version) === normalizedTarget;
}

const STARTUP_RECOVERY_FAILURE_KEY = "narrafork_startup_recovery_failure";

/**
 * Carry a failed-recovery reason across the reload into the updated build.
 *
 * `sessionStorage` is scoped to this tab and survives exactly one reload, which matches the
 * lifetime of the message. The alternative — reporting the failure in the update dialog and
 * refusing to reload — kept the user on a bundle that cannot reach the repair UI.
 */
export function stashStartupRecoveryFailure(reason: string | undefined): void {
	try {
		sessionStorage.setItem(STARTUP_RECOVERY_FAILURE_KEY, reason?.trim() || "");
	} catch {
		// A blocked or full sessionStorage must not prevent the reload; the failure is also
		// reported over WS and remains visible in the settings migration screen.
	}
}

/**
 * Read and clear the stashed reason. Returns null when startup recovery did not fail, and an
 * empty string when it failed without a reported reason, so the caller can still say so.
 */
export function consumeStartupRecoveryFailure(): string | null {
	try {
		const stored = sessionStorage.getItem(STARTUP_RECOVERY_FAILURE_KEY);
		if (stored === null) return null;
		sessionStorage.removeItem(STARTUP_RECOVERY_FAILURE_KEY);
		return stored;
	} catch {
		return null;
	}
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
		const response = await fetch(`${apiUrl("/health")}?_=${Date.now()}`, {
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
 *
 * A failed startup recovery is reported but never blocks the reload — see
 * `isUpdatedServerReadyForReload`. The reason is stashed first so it survives the reload that
 * is about to discard this page; otherwise letting the reload through would silently drop the
 * only explanation the user ever gets.
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
		if (isUpdatedServerReadyForReload(health, normalizedTarget)) {
			if (health?.readiness === "failed" || health?.status === "failed") {
				stashStartupRecoveryFailure(health?.recoveryError);
			}
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
