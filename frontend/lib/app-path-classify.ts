/**
 * app-path-classify.ts — Which app-relative paths are API/WebSocket traffic.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Two callers need this answer and they cannot share code any other way:
 *
 *   - the app (`lib/base-path.ts`), which knows the mount prefix from `document.baseURI`;
 *   - the Service Worker (`src-sw.ts`), which has no `document` and derives the prefix
 *     from its own registration scope.
 *
 * ⚠️ The two MUST agree, and a disagreement is silent in both directions: if the worker
 * thinks `/api/…` is not API traffic it caches API responses (stale data, no error), and
 * if it misjudges the other way asset caching quietly stops. `base-path.ts` cannot be
 * imported by the worker — it touches `document` and `location` at module scope — so the
 * shared part is the part that takes an ALREADY-STRIPPED path and nothing else. That
 * keeps the one rule in one place while leaving each side its own prefix arithmetic.
 *
 * Nothing here may reference `document`, `location` or `self`.
 */

/** The path segments that address the backend rather than a static asset. */
export const API_WS_PREFIXES = ["api", "ws"] as const;

/**
 * Whether an app-relative path (no leading slash, mount prefix already removed)
 * addresses the API or WebSocket surface.
 *
 * The bare segment counts as well as the sub-path: `api` is the API root, and treating
 * only `api/` as API traffic would let a request to the root be cached.
 */
export function isApiOrWsRelativePath(relative: string): boolean {
	return API_WS_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}
