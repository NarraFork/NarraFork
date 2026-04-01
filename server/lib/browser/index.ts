// Browser module — Playwright-based browser pool, session management, and actions.

export * as actions from "./actions";
export type { FetchPageOptions } from "./pool";
export { closeBrowser, createContext, fetchPage, getBrowser } from "./pool";
export type { BrowserSession } from "./session";
export {
	cleanupNarrator,
	closeSession,
	createSession,
	getSession,
	listSessions,
	touchSession,
} from "./session";
