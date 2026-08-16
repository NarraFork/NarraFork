/**
 * Public URL paths of the shared plugin UI runtime.
 *
 * A module of its own because the two sides that need these strings cannot import each
 * other: the build helper (`frontend/build/plugin-ui-runtime.ts`) runs under Bun and calls
 * `Bun.build`, while the iframe shell is browser code. Duplicating the literals instead
 * would mean a rename silently breaks runtime injection — the panel would 404 the runtime
 * and render unstyled.
 *
 * The paths are unhashed on purpose: the shell references them by constant, and freshness is
 * handled by revalidation (`Cache-Control: no-cache`) rather than by the filename. That is a
 * requirement on BOTH servers, not a property of these strings — the dev middleware in
 * `vite.config.ts` sets the header itself, and `server/main.ts` imports the two URLs below
 * into `NO_CACHE_FRONTEND_PATHS`. Serving them under the default `max-age` instead would keep
 * handing out the previous runtime after a host upgrade, which panels report as
 * `HostRuntimeUnavailableError` rather than as a caching problem.
 */

export const PLUGIN_UI_RUNTIME_JS_PATH = "plugin-runtime/vendor.js";
export const PLUGIN_UI_RUNTIME_CSS_PATH = "plugin-runtime/vendor.css";

/** Absolute, same-origin URLs the iframe shell injects. */
export const PLUGIN_UI_RUNTIME_JS_URL = `/${PLUGIN_UI_RUNTIME_JS_PATH}`;
export const PLUGIN_UI_RUNTIME_CSS_URL = `/${PLUGIN_UI_RUNTIME_CSS_PATH}`;
