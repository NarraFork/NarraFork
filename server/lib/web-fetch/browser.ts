// Playwright browser adapter for WebFetch — thin wrapper around server/lib/browser/pool.
// Maintains the same export interface as the old Puppeteer-based browser.ts
// so that http-fetch.ts, screenshot.ts, dom.ts can import without changes.

export type { FetchPageOptions } from "../browser/pool";
export {
	closeBrowser,
	fetchPage,
	getBrowser,
} from "../browser/pool";
