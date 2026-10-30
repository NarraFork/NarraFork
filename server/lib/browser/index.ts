// Browser module — browser pool, session management, and actions.

export * as actions from "./actions";
export type { BrowserTab, FetchPageOptions } from "./pool";
export {
	closeBrowser,
	connectBrowser,
	fetchPage,
	getBrowser,
	getBrowserWsEndpoints,
	openTab,
	setBrowserPreserveMode,
} from "./pool";
export type { BrowserSession, BrowserSessionHandoff } from "./session";
export {
	cleanupNarrator,
	closeAllSessions,
	closeSession,
	createSession,
	DEFAULT_SESSION_TTL_MS,
	discardHandoffTab,
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
