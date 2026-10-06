// Browser adapter for WebFetch — thin wrapper around server/lib/browser/pool.

export type { FetchPageOptions } from "../browser/pool";
export { closeBrowser, fetchPage, getBrowser } from "../browser/pool";
