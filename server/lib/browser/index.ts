// Browser module — browser pool, session management, and actions.

export * as actions from "./actions";
export type { FetchPageOptions } from "./pool";
export { closeBrowser, createContext, fetchPage, getBrowser } from "./pool";
export type { BrowserSession } from "./session";
export {
	cleanupNarrator,
	closeSession,
	createSession,
	DEFAULT_SESSION_TTL_MS,
	getSession,
	listSessions,
	MAX_SESSION_TTL_MS,
	MIN_SESSION_TTL_MS,
	normalizeSessionTtlMs,
	setSessionTtl,
	startNetworkCapture,
	stopNetworkCapture,
	stopTracing,
	touchSession,
} from "./session";
