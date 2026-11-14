// Browser session management for the Browser tool.
// Each narrator can hold multiple named sessions with automatic TTL cleanup.

import type {
	Browser,
	BrowserContext,
	ConsoleMessage,
	HTTPRequest,
	HTTPResponse,
	Page,
	Target,
} from "puppeteer-core";
import { eventBus } from "../event-bus";
import { generateShortId } from "../id";
import { logger } from "../logger";
import { installDialogProtection } from "./dialogs";
import { type BrowserMemoryJob, cancelMemoryJob } from "./memory-job";
import type { MemoryProfileHandle } from "./memory-profiler";
import { finishPerformanceTrace, type PerformanceTracingState } from "./performance-tracing";
import { DEFAULT_VIEWPORT, openTab, USER_AGENT } from "./pool";
import { redactHeaders, redactPostData, redactUrl } from "./redaction";
import { serializeBrowserValue } from "./serialization";
import { closeTab, isSharedContext, targetIdOf } from "./tab-scope";

function safeLog(
	level: "info" | "warn" | "debug",
	message: string,
	fields: Record<
		string,
		| number
		| boolean
		| "console-serialization"
		| "initial-navigation-close"
		| "closed"
		| "capture-stopped"
		| "handoff-target"
		| "restore-viewport"
		| "restored"
	>,
) {
	try {
		const scalars = Object.fromEntries(
			Object.entries(fields).filter(
				([, value]) => typeof value !== "number" || Number.isFinite(value),
			),
		);
		logger[level](message, scalars);
	} catch {}
}

/** Default session TTL: 10 minutes of inactivity. */
export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
/** Minimum configurable session TTL: 1 second. */
export const MIN_SESSION_TTL_MS = 1_000;
/** Maximum configurable session TTL: 24 hours. */
export const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
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
	/** The narrator that owns this session. */
	narratorId: string;
	context: BrowserContext;
	/** The currently active page. */
	page: Page;
	/** URL the session was launched with. */
	url: string;
	/** Last activity timestamp (ms). */
	lastActivity: number;
	/** Inactivity TTL before automatic cleanup (ms). */
	ttlMs: number;
	/** Whether this session uses headless (true) or headed/GUI (false) browser. */
	headless: boolean;
	/** 是否开在用户自己的浏览器里（而不是我们启动的窗口）。 */
	inUserBrowser: boolean;
	/** Whether network request capture is currently enabled for this session. */
	networkCaptureEnabled: boolean;
	/** Viewport currently emulated on the session page. */
	viewport: BrowserViewport;
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
	tracing?: PerformanceTracingState;
	/** Process-local profile recorder; never transferred in restart handoff. */
	memoryProfile?: MemoryProfileHandle;
	/** Process-local diagnostic cancellation; excluded from stats and restart handoff. */
	memoryJob?: BrowserMemoryJob;
	/** Prevent new diagnostics from racing session shutdown. */
	memoryDiagnosticsClosed?: boolean;
}

/**
 * Serializable snapshot of a browser session, captured before a planned-update restart so the
 * replacement process can reconnect to the same Chrome instance and rebuild the live session.
 * Only JSON-safe fields are kept; puppeteer objects are re-resolved via contextId after reconnect.
 */
export interface BrowserSessionHandoff {
	sessionId: string;
	narratorId: string;
	/** URL the session was originally launched with. */
	url: string;
	/** Current page URL at snapshot time (best-effort, for matching/logging). */
	currentPageUrl: string;
	/** 隔离 context 的 BrowserContext.id，重连后据此找回会话。 */
	contextId?: string;
	/** 共享 context 里根标签的 CDP target id（默认 context 没有 id）。 */
	targetId?: string;
	/** Only an interruption marker; no recorder, endpoint, summary or artifact is persisted. */
	interruptedProfileId?: string;
	headless: boolean;
	ttlMs: number;
	networkCaptureEnabled: boolean;
	/** Emulated viewport; absent in handoff files written before viewport support. */
	viewport?: BrowserViewport;
}

/** Viewport emulated on a session page (CSS pixels). */
export interface BrowserViewport {
	width: number;
	height: number;
	deviceScaleFactor?: number;
	isMobile?: boolean;
}

export const MIN_VIEWPORT_SIZE = 100;
export const MAX_VIEWPORT_SIZE = 4096;
export const MIN_DEVICE_SCALE_FACTOR = 0.5;
export const MAX_DEVICE_SCALE_FACTOR = 4;

/** Validate a viewport, throwing a readable error for out-of-range values. */
export function normalizeViewport(viewport: BrowserViewport): BrowserViewport {
	const dimension = (name: string, value: number) => {
		if (!Number.isFinite(value) || value < MIN_VIEWPORT_SIZE || value > MAX_VIEWPORT_SIZE) {
			throw new Error(
				`Viewport ${name} must be between ${MIN_VIEWPORT_SIZE} and ${MAX_VIEWPORT_SIZE} pixels`,
			);
		}
		return Math.round(value);
	};
	const result: BrowserViewport = {
		width: dimension("width", viewport.width),
		height: dimension("height", viewport.height),
	};
	if (viewport.deviceScaleFactor !== undefined) {
		const dsf = viewport.deviceScaleFactor;
		if (!Number.isFinite(dsf) || dsf < MIN_DEVICE_SCALE_FACTOR || dsf > MAX_DEVICE_SCALE_FACTOR) {
			throw new Error(
				`Device scale factor must be between ${MIN_DEVICE_SCALE_FACTOR} and ${MAX_DEVICE_SCALE_FACTOR}`,
			);
		}
		result.deviceScaleFactor = dsf;
	}
	if (viewport.isMobile !== undefined) result.isMobile = viewport.isMobile;
	return result;
}

/** Drop undefined fields so a partial viewport spread does not erase existing values. */
function definedOnly(viewport: Partial<BrowserViewport> | undefined): Partial<BrowserViewport> {
	if (!viewport) return {};
	return Object.fromEntries(
		Object.entries(viewport).filter(([, value]) => value !== undefined),
	) as Partial<BrowserViewport>;
}

/** Puppeteer viewport including the touch flag that matches mobile emulation. */
function toPuppeteerViewport(viewport: BrowserViewport) {
	return {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
		isMobile: viewport.isMobile ?? false,
		hasTouch: viewport.isMobile ?? false,
	};
}

export function normalizeSessionTtlMs(ttlMs: number | undefined): number {
	const value = ttlMs ?? DEFAULT_SESSION_TTL_MS;
	if (!Number.isFinite(value)) {
		throw new Error("Browser session TTL must be a finite number of milliseconds");
	}
	if (value < MIN_SESSION_TTL_MS || value > MAX_SESSION_TTL_MS) {
		throw new Error(
			`Browser session TTL must be between ${MIN_SESSION_TTL_MS}ms and ${MAX_SESSION_TTL_MS}ms`,
		);
	}
	return Math.floor(value);
}

/**
 * narratorId → Map<sessionId, BrowserSession>
 */
interface SessionOwner {
	version: 1;
	sessions: Map<string, Map<string, BrowserSession>>;
	cleanupTimer: ReturnType<typeof setInterval> | null;
}
const SESSION_OWNER = Symbol.for("narrafork.browser.sessions");
const sessionGlobals = globalThis as typeof globalThis & { [SESSION_OWNER]?: SessionOwner };
const oldOwner = sessionGlobals[SESSION_OWNER];
if (oldOwner && (oldOwner.version !== 1 || !(oldOwner.sessions instanceof Map)))
	throw new Error("Browser session ownership cannot be recovered");
const sessionOwner: SessionOwner = oldOwner ?? {
	version: 1,
	sessions: new Map(),
	cleanupTimer: null,
};
sessionGlobals[SESSION_OWNER] = sessionOwner;
const sessions = sessionOwner.sessions;

function isSessionExpired(session: BrowserSession, now = Date.now()): boolean {
	return now - session.lastActivity > session.ttlMs;
}

function closeSessionTab(session: BrowserSession): Promise<void> {
	return closeTab(session.context, session.page.target());
}

function expireSession(
	narratorId: string,
	map: Map<string, BrowserSession>,
	sessionId: string,
	session: BrowserSession,
): void {
	safeLog("info", "Browser session expired", { ttlMs: session.ttlMs });
	if (session.tracing?.active) void finishPerformanceTrace(session).catch(() => {});
	void cancelMemoryJob(session)
		.then(() => closeSessionTab(session))
		.catch(() => {});
	map.delete(sessionId);
	if (map.size === 0) sessions.delete(narratorId);
	eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
}

function ensureCleanupTimer(): void {
	if (sessionOwner.cleanupTimer) return;
	sessionOwner.cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [narratorId, map] of sessions) {
			for (const [sessionId, session] of map) {
				if (isSessionExpired(session, now)) {
					expireSession(narratorId, map, sessionId, session);
				}
			}
			if (map.size === 0) sessions.delete(narratorId);
		}
		if (sessions.size === 0 && sessionOwner.cleanupTimer) {
			clearInterval(sessionOwner.cleanupTimer);
			sessionOwner.cleanupTimer = null;
		}
	}, CLEANUP_INTERVAL_MS);
	// Don't keep the process alive just for cleanup
	if (
		sessionOwner.cleanupTimer &&
		typeof sessionOwner.cleanupTimer === "object" &&
		"unref" in sessionOwner.cleanupTimer
	) {
		sessionOwner.cleanupTimer.unref();
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
			populateConsoleMessageArgs(entry, msg).catch(() => {
				safeLog("debug", "Failed to serialize browser console arguments", {
					stage: "console-serialization",
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
		if (!session.networkCaptureEnabled) return;
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

/**
 * Touch a session AND emit a visual-change event.
 * Call this for actions that modify the visible page state (click, fill, navigate, scroll, etc.).
 */
export function touchSessionVisual(session: BrowserSession): void {
	session.lastActivity = Date.now();
	eventBus.emit({
		type: "browser:session_visual_change",
		sessionId: session.id,
		narratorId: session.narratorId,
	});
}

/** Create a new browser session for a narrator. */
export async function createSession(
	narratorId: string,
	url: string,
	headless = true,
	ttlMs?: number,
	captureNetwork = false,
	viewport?: Partial<BrowserViewport>,
): Promise<BrowserSession> {
	const normalizedTtlMs = normalizeSessionTtlMs(ttlMs);
	const normalizedViewport = normalizeViewport({ ...DEFAULT_VIEWPORT, ...definedOnly(viewport) });
	const { context, page, inUserBrowser } = await openTab(headless);
	const sessionId = generateShortId();
	const session: BrowserSession = {
		id: sessionId,
		narratorId,
		context,
		page,
		url,
		lastActivity: Date.now(),
		ttlMs: normalizedTtlMs,
		headless,
		inUserBrowser,
		networkCaptureEnabled: captureNetwork,
		viewport: normalizedViewport,
		consoleMessages: [],
		consoleMessageSeq: 0,
		pendingConsoleCaptures: new Set(),
		networkRequests: [],
		networkRequestMap: new WeakMap(),
	};
	attachConsoleListeners(page, session);
	attachNetworkListeners(page, session);

	try {
		// Puppeteer doesn't support viewport/userAgent at context level (unlike Playwright),
		// so we set them per-page to match fetchPage() defaults.
		await page.setViewport(toPuppeteerViewport(normalizedViewport));
		// 用户的浏览器带着真实登录态，伪造的 UA 容易触发站点的异常登录风控
		if (!inUserBrowser) await page.setUserAgent(USER_AGENT);
		await installDialogProtection(
			context,
			(text) => pushConsoleMessage(session, { type: "dialog", text }),
			isSharedContext(context) ? page.target() : undefined,
		);
		await page.goto(url, { waitUntil: "domcontentloaded" });
	} catch (err) {
		await closeSessionTab(session).catch(() => {
			safeLog("warn", "Failed to close browser tab after initial navigation failure", {
				stage: "initial-navigation-close",
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
	safeLog("info", "Browser session created", {
		headless,
		inUserBrowser,
		ttlMs: normalizedTtlMs,
		networkCaptureEnabled: captureNetwork,
		viewportWidth: normalizedViewport.width,
		viewportHeight: normalizedViewport.height,
	});
	eventBus.emit({ type: "browser:session_created", sessionId, narratorId, url });
	return session;
}

/**
 * Change the emulated viewport of a live session. Omitted fields keep their current value.
 * Mobile emulation changes require a reload for the page to pick up the new UA metrics,
 * which Puppeteer performs automatically.
 */
export async function setSessionViewport(
	narratorId: string,
	sessionId: string,
	viewport: Partial<BrowserViewport>,
): Promise<BrowserSession | undefined> {
	const session = getSession(narratorId, sessionId);
	if (!session) return undefined;
	const next = normalizeViewport({ ...session.viewport, ...definedOnly(viewport) });
	await session.page.setViewport(toPuppeteerViewport(next));
	session.viewport = next;
	touchSession(session);
	safeLog("info", "Browser session viewport updated", {
		viewportWidth: next.width,
		viewportHeight: next.height,
	});
	eventBus.emit({ type: "browser:session_updated", sessionId, narratorId });
	return session;
}

/** Get an existing session. Returns undefined if not found or expired. */
export function getSession(narratorId: string, sessionId: string): BrowserSession | undefined {
	const map = sessions.get(narratorId);
	if (!map) return undefined;
	const session = map.get(sessionId);
	if (!session) return undefined;

	if (isSessionExpired(session)) {
		expireSession(narratorId, map, sessionId, session);
		return undefined;
	}

	// 标签或整个浏览器可能已被用户关掉
	if (session.page.isClosed() || !session.context.browser().connected) {
		void cancelMemoryJob(session);
		map.delete(sessionId);
		if (map.size === 0) sessions.delete(narratorId);
		eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
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

	await cancelMemoryJob(session);
	if (session.tracing?.active) await finishPerformanceTrace(session).catch(() => {});
	await closeSessionTab(session).catch(() => {});
	map.delete(sessionId);
	if (map.size === 0) sessions.delete(narratorId);

	safeLog("info", "Browser session closed", { stage: "closed" });
	eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
	return true;
}

/** Update automatic inactivity cleanup time for a specific session. */
export function setSessionTtl(
	narratorId: string,
	sessionId: string,
	ttlMs: number,
): BrowserSession | undefined {
	const session = getSession(narratorId, sessionId);
	if (!session) return undefined;
	const normalizedTtlMs = normalizeSessionTtlMs(ttlMs);
	session.ttlMs = normalizedTtlMs;
	// Treat a manual/agent TTL update as activity, so the new countdown starts now.
	touchSession(session);
	ensureCleanupTimer();
	safeLog("info", "Browser session TTL updated", { ttlMs: normalizedTtlMs });
	eventBus.emit({ type: "browser:session_updated", sessionId, narratorId });
	return session;
}

/** Enable network request capture for a specific session. */
export function startNetworkCapture(
	narratorId: string,
	sessionId: string,
	opts?: { clear?: boolean },
): BrowserSession | undefined {
	const session = getSession(narratorId, sessionId);
	if (!session) return undefined;
	if (opts?.clear) {
		session.networkRequests.length = 0;
		session.networkRequestMap = new WeakMap();
	}
	session.networkCaptureEnabled = true;
	touchSession(session);
	safeLog("info", "Browser network capture started", { clear: opts?.clear ?? false });
	eventBus.emit({ type: "browser:session_updated", sessionId, narratorId });
	return session;
}

/** Disable network request capture for a specific session. */
export function stopNetworkCapture(
	narratorId: string,
	sessionId: string,
): BrowserSession | undefined {
	const session = getSession(narratorId, sessionId);
	if (!session) return undefined;
	session.networkCaptureEnabled = false;
	touchSession(session);
	safeLog("info", "Browser network capture stopped", { stage: "capture-stopped" });
	eventBus.emit({ type: "browser:session_updated", sessionId, narratorId });
	return session;
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
				finishPerformanceTrace(session)
					.then(() => {})
					.catch(() => {}),
			);
		}
		promises.push(
			cancelMemoryJob(session)
				.then(() => closeSessionTab(session))
				.catch(() => {}),
		);
	}
	await Promise.all(promises);

	sessions.delete(narratorId);
	for (const sessionId of sessionIds) {
		eventBus.emit({ type: "browser:session_closed", sessionId, narratorId });
	}
	safeLog("info", "All browser sessions cleaned up", { count: promises.length });
}

/** List active sessions for a narrator. */
export function listSessions(narratorId: string): Array<{
	id: string;
	url: string;
	lastActivity: number;
	ttlMs: number;
	expiresAt: number;
	headless: boolean;
	viewport: BrowserViewport;
	tracing: { active: boolean; startedAt: number } | null;
	memoryProfile: {
		profileId?: string;
		state: string;
		mode?: string;
		startedAt?: string;
		deadline?: string;
	} | null;
	networkRequestCount: number;
	networkCaptureEnabled: boolean;
}> {
	const map = sessions.get(narratorId);
	if (!map) return [];
	const now = Date.now();
	for (const [sessionId, session] of map) {
		if (isSessionExpired(session, now)) {
			expireSession(narratorId, map, sessionId, session);
		}
	}
	return Array.from(map.values()).map((s) => ({
		id: s.id,
		url: s.page.url(),
		lastActivity: s.lastActivity,
		ttlMs: s.ttlMs,
		expiresAt: s.lastActivity + s.ttlMs,
		headless: s.headless,
		viewport: s.viewport,
		tracing: s.tracing ? { active: s.tracing.active, startedAt: s.tracing.startedAt } : null,
		memoryProfile: s.memoryProfile
			? {
					profileId: s.memoryProfile.view.profileId,
					state: s.memoryProfile.view.state,
					mode: s.memoryProfile.view.config?.mode,
					startedAt: s.memoryProfile.view.startedAt,
					deadline: s.memoryProfile.view.deadline,
				}
			: null,
		networkRequestCount: s.networkRequests.length,
		networkCaptureEnabled: s.networkCaptureEnabled,
	}));
}

/** Stop active tracing on a session (discards trace data). Returns false if no active tracing. */
export async function stopTracing(narratorId: string, sessionId: string): Promise<boolean> {
	const session = getSession(narratorId, sessionId);
	if (!session?.tracing?.active) return false;
	await finishPerformanceTrace(session).catch(() => {});
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

/**
 * Close all browser sessions across all narrators.
 *
 * @param options.preserve - When true, the underlying BrowserContexts are NOT closed; only the
 *   in-memory session registry is cleared. Used during a planned-update handoff so the Chrome
 *   process (and its contexts) survive for the replacement process to reconnect and rebuild.
 */
export async function closeAllSessions(options: { preserve?: boolean } = {}): Promise<number> {
	const preserve = options.preserve ?? false;
	let closed = 0;
	const promises: Promise<void>[] = [];
	for (const [, map] of sessions) {
		for (const session of map.values()) {
			if (session.tracing?.active) {
				// Tracing is process-local; preserve handoff must also end the owned trace.
				promises.push(
					finishPerformanceTrace(session)
						.then(() => {})
						.catch(() => {}),
				);
			}
			promises.push(
				cancelMemoryJob(session, { waitForCleanup: true })
					.then(() => (preserve ? undefined : closeSessionTab(session)))
					.catch(() => {}),
			);
			closed++;
		}
	}
	await Promise.all(promises);
	sessions.clear();
	if (sessionOwner.cleanupTimer) {
		clearInterval(sessionOwner.cleanupTimer);
		sessionOwner.cleanupTimer = null;
	}
	safeLog("info", "All browser sessions closed", { count: closed, preserve });
	return closed;
}

/**
 * Capture a serializable snapshot of every active session across all narrators, for
 * planned-update handoff. Best-effort: sessions whose context/page cannot be read are skipped.
 */
export function snapshotSessionsForHandoff(): BrowserSessionHandoff[] {
	const snapshots: BrowserSessionHandoff[] = [];
	for (const [narratorId, map] of sessions) {
		for (const session of map.values()) {
			const shared = isSharedContext(session.context);
			const contextId = shared ? undefined : session.context.id;
			const targetId = shared ? targetIdOf(session.page.target()) : undefined;
			if (!contextId && !targetId) {
				safeLog("warn", "Skipping browser session that cannot be located after handoff", {
					stage: "handoff-target",
				});
				continue;
			}
			let currentPageUrl = session.url;
			try {
				currentPageUrl = session.page.url();
			} catch {
				// Fall back to the launch URL if the page is not readable.
			}
			snapshots.push({
				sessionId: session.id,
				narratorId,
				url: session.url,
				currentPageUrl,
				contextId,
				targetId,
				...(["starting", "recording", "finalizing"].includes(
					session.memoryProfile?.view.state ?? "",
				)
					? { interruptedProfileId: session.memoryProfile?.view.profileId }
					: {}),
				headless: session.headless,
				ttlMs: session.ttlMs,
				networkCaptureEnabled: session.networkCaptureEnabled,
				viewport: session.viewport,
			});
		}
	}
	return snapshots;
}

/**
 * Rebuild a live session from a handoff snapshot after reconnecting to the preserved Chrome.
 * Re-resolves the BrowserContext by id and its active Page, re-attaches listeners, and registers
 * the session so the narrator can keep using the same session_id.
 */
export async function restoreSessionFromHandoff(
	browser: Browser,
	handoff: BrowserSessionHandoff,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const located = locateHandoffTab(browser, handoff);
	if (!located)
		return { ok: false, reason: handoff.contextId ? "context_missing" : "page_missing" };
	const { context, root } = located;

	// Rehydrating Page objects can itself wait on renderer commands behind an open dialog.
	// Install at the target level first, retaining only a bounded diagnostic buffer until
	// the session exists. A second install below redirects the sink without duplicating listeners.
	const earlyDialogMessages: string[] = [];
	try {
		await installDialogProtection(
			context,
			(text) => {
				earlyDialogMessages.push(text);
				if (earlyDialogMessages.length > MAX_CONSOLE_MESSAGES) earlyDialogMessages.shift();
			},
			root,
		);
	} catch (error) {
		// A dialog opened while disconnected may belong to another CDP client. Chrome
		// cannot replay that dialog to us: leave the context intact and fail promptly.
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	const page = root ? await root.page() : await isolatedSessionPage(context, handoff);
	if (!page) return { ok: false, reason: "page_missing" };

	const session: BrowserSession = {
		id: handoff.sessionId,
		narratorId: handoff.narratorId,
		context,
		page,
		url: handoff.url,
		lastActivity: Date.now(),
		ttlMs: handoff.ttlMs,
		headless: handoff.headless,
		// 交接只保留我们启动的浏览器
		inUserBrowser: false,
		networkCaptureEnabled: handoff.networkCaptureEnabled,
		viewport: restoredViewport(handoff.viewport),
		consoleMessages: [],
		consoleMessageSeq: 0,
		pendingConsoleCaptures: new Set(),
		networkRequests: [],
		networkRequestMap: new WeakMap(),
	};
	if (handoff.interruptedProfileId && /^[A-Za-z0-9_-]{1,64}$/.test(handoff.interruptedProfileId)) {
		session.memoryProfile = {
			view: {
				profileId: handoff.interruptedProfileId,
				state: "cancelled",
				stage: "restart_interrupted",
				warnings: ["Recording was interrupted by server restart and was not resumed."],
			},
			done: Promise.resolve(),
			stop: () => {},
			cancel: () => {},
		};
	}
	for (const text of earlyDialogMessages) pushConsoleMessage(session, { type: "dialog", text });
	await installDialogProtection(
		context,
		(text) => pushConsoleMessage(session, { type: "dialog", text }),
		root,
	);
	attachConsoleListeners(page, session);
	attachNetworkListeners(page, session);
	// Reconnecting re-applies connect()'s defaultViewport, so restore a customized size.
	// Skip the CDP round-trip for default sessions to keep restore unchanged for them.
	if (!isDefaultViewport(session.viewport)) {
		try {
			await page.setViewport(toPuppeteerViewport(session.viewport));
		} catch {
			safeLog("warn", "Failed to restore browser session viewport after update", {
				stage: "restore-viewport",
			});
		}
	}

	let map = sessions.get(handoff.narratorId);
	if (!map) {
		map = new Map();
		sessions.set(handoff.narratorId, map);
	}
	map.set(handoff.sessionId, session);
	ensureCleanupTimer();

	safeLog("info", "Browser session restored after update", { stage: "restored" });
	eventBus.emit({
		type: "browser:session_created",
		sessionId: handoff.sessionId,
		narratorId: handoff.narratorId,
		url: page.url(),
	});
	return { ok: true };
}

function isDefaultViewport(viewport: BrowserViewport): boolean {
	return (
		viewport.width === DEFAULT_VIEWPORT.width &&
		viewport.height === DEFAULT_VIEWPORT.height &&
		(viewport.deviceScaleFactor ?? 1) === 1 &&
		!viewport.isMobile
	);
}

/** Viewport recorded in a handoff; invalid or missing (older handoff files) → default. */
function restoredViewport(viewport: BrowserViewport | undefined): BrowserViewport {
	if (!viewport) return { ...DEFAULT_VIEWPORT };
	try {
		return normalizeViewport(viewport);
	} catch {
		return { ...DEFAULT_VIEWPORT };
	}
}

/** Prefer a page matching the captured URL; otherwise take the first available page. */
async function isolatedSessionPage(
	context: BrowserContext,
	handoff: BrowserSessionHandoff,
): Promise<Page | undefined> {
	const pages = await context.pages();
	return pages.find((p) => p.url() === handoff.currentPageUrl) ?? pages[0];
}

/** 找回交接前的会话所在：隔离 context 按 id，共享 context 里的根标签按 target id。 */
function locateHandoffTab(
	browser: Browser,
	handoff: BrowserSessionHandoff,
): { context: BrowserContext; root?: Target } | undefined {
	if (handoff.contextId) {
		const context = browser.browserContexts().find((ctx) => ctx.id === handoff.contextId);
		return context && { context };
	}
	const root = browser.targets().find((target) => targetIdOf(target) === handoff.targetId);
	return root && { context: browser.defaultBrowserContext(), root };
}

/** 关掉一个无法恢复的交接会话留下的标签：交接只读一次，之后不会再有人引用它们。 */
export async function discardHandoffTab(
	browser: Browser,
	handoff: BrowserSessionHandoff,
): Promise<void> {
	const located = locateHandoffTab(browser, handoff);
	if (located) await closeTab(located.context, located.root);
}
