import { ApiError, api } from "./api";

/**
 * Tab-local guard in front of the server's opportunistic NUG model refresh.
 *
 * The authoritative cooldown is server-side (shared by every client), so this
 * module is purely about not making pointless HTTP round-trips: a model picker
 * can be opened repeatedly, and several pickers can mount at once, and none of
 * that should produce more than one request per cooldown window per tab.
 *
 * Module-level state is what makes the guard shared across every component
 * instance in the tab.
 */

/**
 * Fallback window used before the server has told us its cooldown, and after a
 * failure. Intentionally the same order as the server's cooldown so a client
 * that never gets a successful response still backs off sensibly.
 */
const FALLBACK_COOLDOWN_MS = 60_000;

let nextAllowedAt = 0;
let inflight: Promise<boolean> | null = null;
/** Set when the backend has no such route, so we stop asking for this session. */
let unsupported = false;

/**
 * Ask the server to refresh stale NUG model catalogs, at most once per cooldown
 * window per tab.
 *
 * Resolves true only when the server actually refreshed at least one gateway —
 * i.e. when the caller should re-read the model list. Never rejects: a failed
 * opportunistic refresh must not surface as an error to the user, since the
 * picker still renders the cached catalog.
 */
export function requestNugModelRefreshOnPickerOpen(): Promise<boolean> {
	if (unsupported) return Promise.resolve(false);
	// Join an in-flight request instead of issuing a second one.
	if (inflight) return inflight;
	if (Date.now() < nextAllowedAt) return Promise.resolve(false);

	// Consume the window before awaiting, so a slow or failing request cannot be
	// re-entered by the next picker open.
	nextAllowedAt = Date.now() + FALLBACK_COOLDOWN_MS;
	const request = api
		.nugRefreshStaleModels()
		.then((result) => {
			// Trust the server's cooldown accounting over the local fallback: it knows
			// how long ago *another* client refreshed. Wait only until the soonest
			// provider becomes refreshable again — waiting for the slowest one would
			// keep a recovered model looking unavailable longer than necessary.
			// Providers that are skipped as "not-configured" are never refreshable, so
			// their zero would otherwise defeat the guard entirely.
			const waits = result.results
				.filter((r) => r.skipped !== "not-configured")
				.map((r) => (Number.isFinite(r.retryAfterMs) ? Math.max(0, r.retryAfterMs) : 0));
			const fallbackMs = Number.isFinite(result.cooldownMs)
				? Math.max(0, result.cooldownMs)
				: FALLBACK_COOLDOWN_MS;
			// No refreshable provider at all → back off a full window.
			const waitMs = waits.length > 0 ? Math.min(...waits) : fallbackMs;
			nextAllowedAt = Date.now() + waitMs;
			return result.refreshed;
		})
		.catch((error: unknown) => {
			// An older backend without this route: stop trying for the session rather
			// than retrying on every picker open.
			if (error instanceof ApiError && error.status === 404) unsupported = true;
			if (import.meta.env.DEV) {
				console.debug("[nug] opportunistic model refresh failed", error);
			}
			return false;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = request;
	return request;
}

/** Test helper: clear the tab-local cooldown/in-flight/unsupported state. */
export function resetNugModelRefreshGuardForTests(): void {
	nextAllowedAt = 0;
	inflight = null;
	unsupported = false;
}
