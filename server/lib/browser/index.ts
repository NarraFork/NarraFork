// Browser module — browser pool, session management, and actions.

export * as actions from "./actions";
export type { FetchPageOptions } from "./pool";
export {
	closeBrowser,
	connectBrowser,
	createContext,
	fetchPage,
	getBrowser,
	getBrowserWsEndpoints,
	setBrowserPreserveMode,
} from "./pool";
export type { BrowserSession, BrowserSessionHandoff } from "./session";
export {
	cleanupNarrator,
	closeAllSessions,
	closeSession,
	createSession,
	DEFAULT_SESSION_TTL_MS,
	getSession,
	listSessions,
	MAX_SESSION_TTL_MS,
	MIN_SESSION_TTL_MS,
	normalizeSessionTtlMs,
	restoreSessionFromHandoff,
	setSessionTtl,
	snapshotSessionsForHandoff,
	startNetworkCapture,
	stopNetworkCapture,
	stopTracing,
	touchSession,
	touchSessionVisual,
} from "./session";
