// Browser session management for the Browser tool.
// Each narrator can hold multiple named sessions with automatic TTL cleanup.

import type {
	BrowserContext,
	ConsoleMessage,
	HTTPRequest,
	HTTPResponse,
	Page,
} from "puppeteer-core";
import { eventBus } from "../event-bus";
import { generateShortId } from "../id";
import { logger } from "../logger";
import { createContext, DEFAULT_VIEWPORT, USER_AGENT } from "./pool";
import { redactHeaders, redactPostData, redactUrl } from "./redaction";
import { serializeBrowserValue } from "./serialization";

/** Default session TTL: 10 minutes of inactivity. */
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Cleanup check interval. */
const CLEANUP_INTERVAL_MS = 60 * 1000;
/** Maximum console messages kept per session. */
const MAX_CONSOLE_MESSAGES = 200;
/** Maximum network requests kept per session. */
const MAX_NETWORK_REQUESTS = 500;
/** Maximum request body characters kept per request. */
const MAX_POST_DATA_LENGTH = 4_000;

export interface BrowserConsoleMessage {
	type: string;
	text: string;
	/** Serialized console arguments, when available. Falls back to text otherwise. */
	args?: string[];
	/** Monotonic per-session sequence number, stable even when the ring buffer rotates. */
	seq: number;
	timestamp: number;
	location?: {
		url?: string;
		lineNumber?: number;
		columnNumber?: number;
	};
}

export interface BrowserNetworkRequest {
	id: string;
	url: string;
	method: string;
	resourceType: string;
	startedAt: number;
	requestHeaders: Record<string, string>;
	postData?: string;
	status?: number;
	statusText?: string;
	responseHeaders?: Record<string, string>;
	finishedAt?: number;
	durationMs?: number;
	failed?: boolean;
	failureText?: string;
}

export interface BrowserSession {
	id: string;
	context: BrowserContext;
	/** The currently active page. */
	page: Page;
	/** URL the session was launched with. */
	url: string;
	/** Last activity timestamp (ms). */
	lastActivity: number;
	/** Whether this session uses headless (true) or headed/GUI (false) browser. */
	headless: boolean;
	/** Recent console output and page errors captured from the page. */
	consoleMessages: BrowserConsoleMessage[];
	/** Monotonic counter for console messages, independent of the capped buffer size. */
	consoleMessageSeq: number;
	/** Pending async console argument serialization tasks. */
	pendingConsoleCaptures: Set<Promise<void>>;
	/** Recent network requests captured from the page. */
	networkRequests: BrowserNetworkRequest[];
	/** Internal lookup for in-flight network requests. */
	networkRequestMap: WeakMap<HTTPRequest, BrowserNetworkRequest>;
	/** Performance tracing state. */
	tracing?: { active: boolean; startedAt: number };
}

/**
 * narratorId → Map<sessionId, BrowserSession>
 */
const sessions = new Map<string, Map<string, BrowserSession>>();

/** Start periodic cleanup of expired sessions. */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
	if (cleanupTimer) return;
	cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [narratorId, map] of sessions) {
			for (const [sessionId, session] of map) {
				if (now - session.lastActivity > SESSION_TTL_MS) {
					logger.info("Browser session expired", { narratorId, sessionId });
					if (session.tracing?.active) {
						void session.page.tracing.stop().catch(() => {});
						session.tracing = undefined;
					}
					void session.context.close().catch(() => {});
					map.delete(sessionId);
					eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
				}
			}
			if (map.size === 0) sessions.delete(narratorId);
		}
		if (sessions.size === 0 && cleanupTimer) {
			clearInterval(cleanupTimer);
			cleanupTimer = null;
		}
	}, CLEANUP_INTERVAL_MS);
	// Don't keep the process alive just for cleanup
	if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
		cleanupTimer.unref();
	}
}

function pushConsoleMessage(
	session: BrowserSession,
	message: Omit<BrowserConsoleMessage, "seq" | "timestamp">,
): BrowserConsoleMessage {
	const entry = { ...message, seq: ++session.consoleMessageSeq, timestamp: Date.now() };
	session.consoleMessages.push(entry);
	if (session.consoleMessages.length > MAX_CONSOLE_MESSAGES) {
		session.consoleMessages.splice(0, session.consoleMessages.length - MAX_CONSOLE_MESSAGES);
	}
	return entry;
}

function trackConsoleCapture(session: BrowserSession, capture: Promise<void>): void {
	session.pendingConsoleCaptures.add(capture);
	capture
		.finally(() => {
			session.pendingConsoleCaptures.delete(capture);
		})
		.catch(() => {
			// The capture promise has its own fallback path; this avoids unhandled rejections.
		});
}

function isLowInformationConsoleArg(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed === "" ||
		trimmed === "{}" ||
		trimmed === "[]" ||
		trimmed === "null" ||
		trimmed === "(undefined)" ||
		trimmed.startsWith("JSHandle@")
	);
}

function hasConsoleDiagnosticText(text: string): boolean {
	return /\b(?:Error|Exception|DOMException|TypeError|ReferenceError|SyntaxError|RangeError|URIError)\b|JSHandle@/.test(
		text,
	);
}

function mergeConsoleArgText(originalText: string, serializedParts: string[]): string {
	const serializedText = serializedParts.join(" ").trim();
	const original = originalText.trim();
	if (!serializedText) return originalText;
	if (!original || serializedText === original) return serializedText;
	if (serializedParts.every(isLowInformationConsoleArg)) return originalText;
	if (serializedParts.some(isLowInformationConsoleArg) && hasConsoleDiagnosticText(original)) {
		return `${originalText} | args: ${serializedText}`;
	}
	return serializedText;
}

async function populateConsoleMessageArgs(
	entry: BrowserConsoleMessage,
	msg: ConsoleMessage,
): Promise<void> {
	const handles = msg.args();
	if (handles.length === 0) return;

	const parts: string[] = [];
	for (const handle of handles) {
		try {
			const value = await handle.jsonValue();
			parts.push(serializeBrowserValue(value, { fallbackText: entry.text }));
		} catch {
			try {
				parts.push(handle.toString());
			} catch {
				parts.push(entry.text);
			}
		} finally {
			await handle.dispose().catch(() => {});
		}
	}

	if (parts.length > 0) {
		entry.args = parts;
		entry.text = mergeConsoleArgText(entry.text, parts);
	}
}

export async function drainConsoleCaptures(
	session: BrowserSession,
	timeoutMs = 1000,
): Promise<void> {
	const pending = Array.from(session.pendingConsoleCaptures);
	if (pending.length === 0) return;

	await Promise.race([
		Promise.allSettled(pending).then(() => {}),
		new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
	]);
}

function normalizeHeaders(
	headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			Array.isArray(value) ? value.join(", ") : (value ?? ""),
		]),
	);
}

function truncatePostData(postData: string | undefined): string | undefined {
	if (postData === undefined) return undefined;
	if (postData.length <= MAX_POST_DATA_LENGTH) return postData;
	return `${postData.slice(0, MAX_POST_DATA_LENGTH)}\n\n[Post data truncated at ${MAX_POST_DATA_LENGTH} characters]`;
}

function pushNetworkRequest(
	session: BrowserSession,
	request: HTTPRequest,
	entry: BrowserNetworkRequest,
): void {
	session.networkRequests.push(entry);
	session.networkRequestMap.set(request, entry);
	if (session.networkRequests.length > MAX_NETWORK_REQUESTS) {
		session.networkRequests.splice(0, session.networkRequests.length - MAX_NETWORK_REQUESTS);
	}
}

function finalizeNetworkRequest(
	session: BrowserSession,
	request: HTTPRequest,
	updates: Partial<BrowserNetworkRequest>,
): void {
	const item = session.networkRequestMap.get(request);
	if (!item) return;
	const finishedAt = Date.now();
	Object.assign(item, {
		...updates,
		finishedAt,
		durationMs: finishedAt - item.startedAt,
	});
}

function attachConsoleListeners(page: Page, session: BrowserSession): void {
	page.on("console", (msg: ConsoleMessage) => {
		const location = msg.location();
		const entry = pushConsoleMessage(session, {
			type: msg.type(),
			text: msg.text(),
			location: {
				url: location.url,
				lineNumber: location.lineNumber,
				columnNumber: location.columnNumber,
			},
		});
		trackConsoleCapture(
			session,
			populateConsoleMessageArgs(entry, msg).catch((err) => {
				logger.debug("Failed to serialize browser console arguments", {
					error: err instanceof Error ? err.message : String(err),
				});
			}),
		);
	});

	page.on("pageerror", (err: unknown) => {
		const text = err instanceof Error ? err.stack || err.message : String(err);
		pushConsoleMessage(session, {
			type: "pageerror",
			text,
		});
	});
}

function attachNetworkListeners(page: Page, session: BrowserSession): void {
	page.on("request", (request: HTTPRequest) => {
		const requestHeaders = normalizeHeaders(request.headers());
		pushNetworkRequest(session, request, {
			id: generateShortId(),
			url: redactUrl(request.url()),
			method: request.method(),
			resourceType: request.resourceType(),
			startedAt: Date.now(),
			requestHeaders: redactHeaders(requestHeaders),
			postData: truncatePostData(redactPostData(request.postData(), requestHeaders)),
		});
	});

	page.on("response", (response: HTTPResponse) => {
		finalizeNetworkRequest(session, response.request(), {
			status: response.status(),
			statusText: response.statusText(),
			responseHeaders: redactHeaders(normalizeHeaders(response.headers())),
		});
	});

	page.on("requestfailed", (request: HTTPRequest) => {
		finalizeNetworkRequest(session, request, {
			failed: true,
			failureText: request.failure()?.errorText ?? "Request failed",
		});
	});
}

/** Touch a session to reset its TTL. */
export function touchSession(session: BrowserSession): void {
	session.lastActivity = Date.now();
}

/** Create a new browser session for a narrator. */
export async function createSession(
	narratorId: string,
	url: string,
	headless = true,
): Promise<BrowserSession> {
	const context = await createContext(headless);
	const page = await context.newPage();

	// Puppeteer doesn't support viewport/userAgent at context level (unlike Playwright),
	// so we set them per-page to match fetchPage() defaults.
	await page.setViewport(DEFAULT_VIEWPORT);
	await page.setUserAgent(USER_AGENT);

	const sessionId = generateShortId();
	const session: BrowserSession = {
		id: sessionId,
		context,
		page,
		url,
		lastActivity: Date.now(),
		headless,
		consoleMessages: [],
		consoleMessageSeq: 0,
		pendingConsoleCaptures: new Set(),
		networkRequests: [],
		networkRequestMap: new WeakMap(),
	};
	attachConsoleListeners(page, session);
	attachNetworkListeners(page, session);

	try {
		await page.goto(url, { waitUntil: "domcontentloaded" });
	} catch (err) {
		await context.close().catch((closeErr) => {
			logger.warn("Failed to close browser context after initial navigation failure", {
				narratorId,
				sessionId,
				error: String(closeErr),
			});
		});
		throw err;
	}

	let map = sessions.get(narratorId);
	if (!map) {
		map = new Map();
		sessions.set(narratorId, map);
	}
	map.set(sessionId, session);

	ensureCleanupTimer();
	logger.info("Browser session created", { narratorId, sessionId, url, headless });
	eventBus.emit({ type: "browser:session_created", sessionId, narratorId, url });
	return session;
}

/** Get an existing session. Returns undefined if not found or expired. */
export function getSession(narratorId: string, sessionId: string): BrowserSession | undefined {
	const map = sessions.get(narratorId);
	if (!map) return undefined;
	const session = map.get(sessionId);
	if (!session) return undefined;

	// Check if context is still alive
	try {
		// Accessing pages will throw if context is closed
		session.context.pages();
	} catch {
		map.delete(sessionId);
		if (map.size === 0) sessions.delete(narratorId);
		return undefined;
	}

	return session;
}

/** Close a specific session. */
export async function closeSession(narratorId: string, sessionId: string): Promise<boolean> {
	const map = sessions.get(narratorId);
	if (!map) return false;
	const session = map.get(sessionId);
	if (!session) return false;

	if (session.tracing?.active) {
		await session.page.tracing.stop().catch(() => {});
		session.tracing = undefined;
	}
	await session.context.close().catch(() => {});
	map.delete(sessionId);
	if (map.size === 0) sessions.delete(narratorId);

	logger.info("Browser session closed", { narratorId, sessionId });
	eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
	return true;
}

/** Close all sessions for a narrator (called when narrator ends). */
export async function cleanupNarrator(narratorId: string): Promise<void> {
	const map = sessions.get(narratorId);
	if (!map) return;

	const sessionIds = Array.from(map.keys());
	const promises: Promise<void>[] = [];
	for (const session of map.values()) {
		if (session.tracing?.active) {
			promises.push(
				session.page.tracing
					.stop()
					.then(() => {})
					.catch(() => {}),
			);
			session.tracing = undefined;
		}
		promises.push(session.context.close().catch(() => {}));
	}
	await Promise.all(promises);

	sessions.delete(narratorId);
	for (const sessionId of sessionIds) {
		eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
	}
	logger.info("All browser sessions cleaned up", {
		narratorId,
		count: promises.length,
	});
}

/** List active sessions for a narrator. */
export function listSessions(narratorId: string): Array<{
	id: string;
	url: string;
	lastActivity: number;
	headless: boolean;
	tracing: { active: boolean; startedAt: number } | null;
	networkRequestCount: number;
}> {
	const map = sessions.get(narratorId);
	if (!map) return [];
	return Array.from(map.values()).map((s) => ({
		id: s.id,
		url: s.page.url(),
		lastActivity: s.lastActivity,
		headless: s.headless,
		tracing: s.tracing ? { active: s.tracing.active, startedAt: s.tracing.startedAt } : null,
		networkRequestCount: s.networkRequests.length,
	}));
}

/** Stop active tracing on a session (discards trace data). Returns false if no active tracing. */
export async function stopTracing(narratorId: string, sessionId: string): Promise<boolean> {
	const session = getSession(narratorId, sessionId);
	if (!session?.tracing?.active) return false;
	await session.page.tracing.stop().catch(() => {});
	session.tracing = undefined;
	return true;
}

/** Get stats for all active browser sessions across all narrators. */
export function getAllSessionStats(): {
	totalSessions: number;
	narrators: Array<{ narratorId: string; sessionCount: number }>;
} {
	let totalSessions = 0;
	const narratorStats: Array<{ narratorId: string; sessionCount: number }> = [];
	for (const [narratorId, map] of sessions) {
		totalSessions += map.size;
		narratorStats.push({ narratorId, sessionCount: map.size });
	}
	return { totalSessions, narrators: narratorStats };
}

/** Close all browser sessions across all narrators. */
export async function closeAllSessions(): Promise<number> {
	let closed = 0;
	const promises: Promise<void>[] = [];
	for (const [, map] of sessions) {
		for (const session of map.values()) {
			promises.push(session.context.close().catch(() => {}));
			closed++;
		}
	}
	await Promise.all(promises);
	sessions.clear();
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
	logger.info("All browser sessions closed", { count: closed });
	return closed;
}
