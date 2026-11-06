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
export type { BrowserSession, BrowserSessionHandoff, BrowserViewport } from "./session";
export {
	cleanupNarrator,
	closeAllSessions,
	closeSession,
	createSession,
	DEFAULT_SESSION_TTL_MS,
	discardHandoffTab,
	getSession,
	listSessions,
	MAX_DEVICE_SCALE_FACTOR,
	MAX_SESSION_TTL_MS,
	MAX_VIEWPORT_SIZE,
	MIN_DEVICE_SCALE_FACTOR,
	MIN_SESSION_TTL_MS,
	MIN_VIEWPORT_SIZE,
	normalizeSessionTtlMs,
	normalizeViewport,
	restoreSessionFromHandoff,
	setSessionTtl,
	setSessionViewport,
	snapshotSessionsForHandoff,
	startNetworkCapture,
	stopNetworkCapture,
	stopTracing,
	touchSession,
	touchSessionVisual,
} from "./session";
