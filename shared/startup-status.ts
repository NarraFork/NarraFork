/**
 * Set on every response from the startup status page (`server/lib/startup-status`), which
 * answers on NarraFork's port until the server itself is up. The page polls for its absence to
 * know when to reload into the app.
 */
export const STARTUP_STATUS_HEADER = "x-narrafork-starting";

/**
 * Logged once the startup page listens. The Windows manager reads it (`server/manager/listen-log.ts`)
 * to open the browser on the page instead of waiting for the server.
 */
export const STARTUP_PAGE_LOG = "NarraFork startup page on";
