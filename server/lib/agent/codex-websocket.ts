import type { Agent as HttpAgent, IncomingMessage } from "node:http";
import { eq, sql } from "drizzle-orm";
import { HttpsProxyAgent } from "https-proxy-agent";
import type WebSocket from "ws";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";
import { logger } from "../logger";
import { getHttpUserAgent } from "../user-agent";
import { parseGatewayDataEvent } from "./gateway-events";
import {
	type OAIMessage,
	parseResponsesAPIEvent,
	type ResponsesAPIChunk,
	type ResponsesReasoningAccum,
	type ResponsesToolAccum,
} from "./openai-provider";
import type { ParsedStreamEvent } from "./provider";

const RESPONSES_WS_BETA_HEADER = "responses_websockets=2026-02-06";
const TURN_STATE_HEADER = "x-codex-turn-state";
const TURN_METADATA_HEADER = "x-codex-turn-metadata";
const SESSION_ID_HEADER = "session_id";
const CLIENT_REQUEST_ID_HEADER = "x-client-request-id";
const OPENAI_BETA_HEADER = "OpenAI-Beta";
const CONNECTION_IDLE_TIMEOUT_MS = 60_000;
const SESSION_IDLE_TTL_MS = 10 * 60_000;
const SESSION_CLEANUP_INTERVAL_MS = 60_000;
const MAX_SESSION_CACHE_SIZE = 100;
const RECENT_NARRATOR_MESSAGE_WINDOW_MS = 5 * 60_000;
const MAX_PREMATURE_CLOSE_RECONNECTS = 1;

interface PrematureCloseRetryDecision {
	shouldReconnect: boolean;
	shouldFallback: boolean;
}

type PendingFrame =
	| { type: "message"; text: string }
	| { type: "close"; code: number; reason: string }
	| { type: "error"; error: Error };

export interface CodexWrappedErrorEvent {
	type?: string;
	status?: number;
	status_code?: number;
	error?: {
		code?: string;
		message?: string;
		type?: string;
		plan_type?: string;
		resets_at?: number;
	};
	headers?: Record<string, unknown>;
}

export interface CodexResponsesRequestBody extends Record<string, unknown> {
	model: string;
	input: OAIMessage[];
	stream: true;
	instructions?: string;
	previous_response_id?: string;
}

export interface CompletedResponseSnapshot {
	responseId: string;
	itemsAdded: unknown[];
}

interface CachedSession {
	connection: ReusableWebSocketConnection | null;
	disabled: boolean;
	lastRequest: CodexResponsesRequestBody | null;
	lastCompleted: CompletedResponseSnapshot | null;
	turnState: string | null;
	busy: boolean;
	lastUsedAt: number;
}

export interface StreamCodexResponsesWebSocketOptions {
	baseUrl: string;
	apiKey: string;
	accountId?: string;
	proxy?: string;
	sessionKey: string;
	narratorId?: string;
	credentialId: string;
	model: string;
	request: CodexResponsesRequestBody;
	signal: AbortSignal;
	/** Close and clear cached WebSocket response-chain state before dispatching this request. */
	resetSessionBeforeRequest?: boolean;
	turnMetadata?: string;
	/** Override the User-Agent handshake header. Defaults to the narrafork UA. */
	userAgent?: string;
}

export class CodexWebSocketFallbackError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "CodexWebSocketFallbackError";
		this.status = status;
	}
}

const sessionCache = new Map<string, CachedSession>();
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function itemSignature(value: unknown): string {
	return JSON.stringify(value);
}

function isPrefixExtension(baseline: unknown[], input: unknown[]): boolean {
	if (baseline.length > input.length) return false;
	for (let i = 0; i < baseline.length; i++) {
		if (itemSignature(baseline[i]) !== itemSignature(input[i])) {
			return false;
		}
	}
	return true;
}

function requestWithoutInput(
	request: CodexResponsesRequestBody,
): Omit<CodexResponsesRequestBody, "input"> & { input: [] } {
	return {
		...cloneJson(request),
		input: [],
	};
}

function buildSessionCacheKey(options: StreamCodexResponsesWebSocketOptions): string {
	return [options.baseUrl, options.sessionKey, options.credentialId, options.model].join("::");
}

function touchSession(session: CachedSession): void {
	session.lastUsedAt = Date.now();
}

function stopSessionCleanupTimerIfIdle(): void {
	if (sessionCache.size === 0 && sessionCleanupTimer) {
		clearInterval(sessionCleanupTimer);
		sessionCleanupTimer = null;
	}
}

function ensureSessionCleanupTimer(): void {
	if (sessionCleanupTimer) return;
	sessionCleanupTimer = setInterval(() => {
		void evictIdleCodexResponsesWebSocketSessions().catch((error) => {
			logger.warn("Failed to evict idle Codex Responses WebSocket sessions", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, SESSION_CLEANUP_INTERVAL_MS);
	if (
		sessionCleanupTimer &&
		typeof sessionCleanupTimer === "object" &&
		"unref" in sessionCleanupTimer
	) {
		sessionCleanupTimer.unref();
	}
}

export function isCodexResponsesWebSocketSessionExpired(
	session: Pick<CachedSession, "busy" | "lastUsedAt">,
	now = Date.now(),
	idleTtlMs = SESSION_IDLE_TTL_MS,
): boolean {
	return !session.busy && now - session.lastUsedAt > idleTtlMs;
}

export function hasRecentNarratorMessage(
	createdAt?: string | null,
	now = Date.now(),
	windowMs = RECENT_NARRATOR_MESSAGE_WINDOW_MS,
): boolean {
	if (!createdAt) return false;
	const createdAtMs = Date.parse(createdAt);
	if (Number.isNaN(createdAtMs)) return false;
	return now - createdAtMs <= windowMs;
}

export function isCodexWebSocketIdleTimeoutError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message === "Codex WebSocket idle timeout waiting for response event"
	);
}

export function isCodexExpected101StatusError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /Expected\s+101\s+status\s+code/i.test(message);
}

export function isCodexWebSocketConnectionLimitError(error: CodexWrappedErrorEvent): boolean {
	const dynamicError = error as CodexWrappedErrorEvent & { code?: string };
	const code = error.error?.code ?? error.error?.type ?? dynamicError.code;
	return code === "websocket_connection_limit_reached";
}

export function decidePrematureCodexReconnect(
	latestMessageCreatedAt: string | null,
	hasYieldedEvents: boolean,
	reconnectCount: number,
	now = Date.now(),
): PrematureCloseRetryDecision {
	const hasRecentNarratorActivity = hasRecentNarratorMessage(latestMessageCreatedAt, now);
	return {
		shouldReconnect:
			hasRecentNarratorActivity &&
			!hasYieldedEvents &&
			reconnectCount < MAX_PREMATURE_CLOSE_RECONNECTS,
		shouldFallback: hasRecentNarratorActivity && !hasYieldedEvents,
	};
}

async function getLatestNarratorMessageCreatedAt(narratorId?: string): Promise<string | null> {
	if (!narratorId) return null;
	const rows = await db
		.select({ createdAt: narratorMessages.createdAt })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);
	return rows[0]?.createdAt ?? null;
}

export function shouldTreatCodexStreamEventAsYielded(event: ParsedStreamEvent): boolean {
	return Boolean(
		(typeof event.text === "string" && event.text.length > 0) ||
			(typeof event.reasoning === "string" && event.reasoning.length > 0) ||
			(event.toolUses?.length ?? 0) > 0 ||
			event.toolUseChunk != null ||
			event.webSearch?.final === true ||
			event.imageGeneration?.final === true ||
			typeof event.imageGeneration?.partialImageB64 === "string",
	);
}

async function removeSession(cacheKey: string, session: CachedSession): Promise<void> {
	sessionCache.delete(cacheKey);
	await closeSessionConnection(session);
	stopSessionCleanupTimerIfIdle();
}

export async function evictIdleCodexResponsesWebSocketSessions(now = Date.now()): Promise<number> {
	const staleEntries = [...sessionCache.entries()].filter(([, session]) =>
		isCodexResponsesWebSocketSessionExpired(session, now),
	);
	for (const [cacheKey, session] of staleEntries) {
		await removeSession(cacheKey, session);
	}
	return staleEntries.length;
}

async function trimCodexResponsesWebSocketSessions(
	limit = MAX_SESSION_CACHE_SIZE,
): Promise<number> {
	const overflow = sessionCache.size - limit;
	if (overflow <= 0) return 0;
	const evictionCandidates = [...sessionCache.entries()]
		.filter(([, session]) => !session.busy)
		.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
		.slice(0, overflow);
	for (const [cacheKey, session] of evictionCandidates) {
		await removeSession(cacheKey, session);
	}
	return evictionCandidates.length;
}

export async function clearCodexResponsesWebSocketSessions(): Promise<void> {
	for (const [cacheKey, session] of [...sessionCache.entries()]) {
		await removeSession(cacheKey, session);
	}
}

function getOrCreateSession(key: string): CachedSession {
	let session = sessionCache.get(key);
	if (!session) {
		session = {
			connection: null,
			disabled: false,
			lastRequest: null,
			lastCompleted: null,
			turnState: null,
			busy: false,
			lastUsedAt: Date.now(),
		};
		sessionCache.set(key, session);
		ensureSessionCleanupTimer();
		void trimCodexResponsesWebSocketSessions();
	} else {
		touchSession(session);
	}
	return session;
}

function shouldDisableWebSocketForStatus(status?: number): boolean {
	return status === 404 || status === 405 || status === 426 || status === 501;
}

export function buildCodexResponsesWebSocketUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith("/responses")) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

function isOfficialChatGPTDomain(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com");
	} catch {
		return false;
	}
}

function buildHandshakeHeaders(
	options: StreamCodexResponsesWebSocketOptions,
	session: CachedSession,
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.apiKey}`,
		"User-Agent": options.userAgent ?? getHttpUserAgent(),
		originator: "narrafork",
		Origin: isOfficialChatGPTDomain(options.baseUrl) ? "https://chatgpt.com" : options.baseUrl,
		[OPENAI_BETA_HEADER]: RESPONSES_WS_BETA_HEADER,
		[SESSION_ID_HEADER]: options.sessionKey,
		[CLIENT_REQUEST_ID_HEADER]: options.sessionKey,
	};
	if (options.accountId && isOfficialChatGPTDomain(options.baseUrl)) {
		headers["ChatGPT-Account-Id"] = options.accountId;
	}
	if (session.turnState) {
		headers[TURN_STATE_HEADER] = session.turnState;
	}
	if (options.turnMetadata) {
		headers[TURN_METADATA_HEADER] = options.turnMetadata;
	}
	return headers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function coerceWrappedError(value: unknown): CodexWrappedErrorEvent | null {
	const obj = asRecord(value);
	if (!obj) return null;

	const nested = asRecord(obj.error);
	const hasStructuredError =
		nested &&
		(typeof nested.message === "string" ||
			typeof nested.code === "string" ||
			typeof nested.type === "string");
	const hasFlatError =
		typeof obj.message === "string" ||
		typeof obj.code === "string" ||
		typeof obj.status === "number" ||
		typeof obj.status_code === "number";

	if (obj.type === "error") return obj as unknown as CodexWrappedErrorEvent;
	if (hasStructuredError) return { ...(obj as object), type: "error" } as CodexWrappedErrorEvent;
	if (!hasFlatError) return null;

	return {
		type: "error",
		status: typeof obj.status === "number" ? obj.status : undefined,
		status_code: typeof obj.status_code === "number" ? obj.status_code : undefined,
		error: {
			code: typeof obj.code === "string" ? obj.code : undefined,
			type: typeof obj.type === "string" ? obj.type : undefined,
			message: typeof obj.message === "string" ? obj.message : undefined,
		},
	};
}

export function parseCodexWrappedError(text: string): CodexWrappedErrorEvent | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const candidates = [trimmed];
	const jsonStart = trimmed.indexOf("{");
	const jsonEnd = trimmed.lastIndexOf("}");
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		const embeddedJson = trimmed.slice(jsonStart, jsonEnd + 1);
		if (embeddedJson !== trimmed) candidates.push(embeddedJson);
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			const wrapped = coerceWrappedError(parsed);
			if (wrapped) return wrapped;
		} catch {
			// Try the next candidate. Close reasons may include a text prefix before JSON.
		}
	}
	return null;
}

function formatWrappedError(error: CodexWrappedErrorEvent): Error {
	const dynamicError = error as CodexWrappedErrorEvent & { code?: string; message?: string };
	const status = error.status ?? error.status_code;
	const code = error.error?.code ?? error.error?.type ?? dynamicError.code;
	const message = error.error?.message ?? dynamicError.message ?? "Codex WebSocket request failed";
	const suffix = [status ? `status=${status}` : null, code ? `code=${code}` : null]
		.filter(Boolean)
		.join(", ");
	return new Error(suffix ? `${message} (${suffix})` : message);
}

export function buildCodexResponsesWebSocketRequest(
	request: CodexResponsesRequestBody,
	lastRequest: CodexResponsesRequestBody | null,
	lastCompleted: CompletedResponseSnapshot | null,
): Record<string, unknown> {
	const fullRequest = cloneJson(request);
	if (!lastRequest || !lastCompleted?.responseId) {
		return { type: "response.create", ...fullRequest };
	}

	const previousWithoutInput = requestWithoutInput(lastRequest);
	const currentWithoutInput = requestWithoutInput(fullRequest);
	if (itemSignature(previousWithoutInput) !== itemSignature(currentWithoutInput)) {
		return { type: "response.create", ...fullRequest };
	}

	const baseline = [
		...cloneJson(lastRequest.input),
		...cloneJson(lastCompleted.itemsAdded),
	] as unknown[];
	const currentInput = cloneJson(fullRequest.input) as unknown[];
	if (!isPrefixExtension(baseline, currentInput)) {
		return { type: "response.create", ...fullRequest };
	}

	const deltaInput = currentInput.slice(baseline.length) as OAIMessage[];
	return {
		type: "response.create",
		...fullRequest,
		input: deltaInput,
		previous_response_id: lastCompleted.responseId,
	};
}

async function closeSessionConnection(session: CachedSession): Promise<void> {
	if (session.connection) {
		await session.connection.close();
		session.connection = null;
	}
}

async function resetSession(session: CachedSession, disable = false): Promise<void> {
	await closeSessionConnection(session);
	session.lastRequest = null;
	session.lastCompleted = null;
	session.turnState = null;
	session.disabled = disable;
}

function createCodexWebSocketAbortError(): Error {
	return new Error("Codex WebSocket request aborted");
}

function isCodexWebSocketAbortError(error: unknown): boolean {
	return error instanceof Error && error.message === "Codex WebSocket request aborted";
}

class ReusableWebSocketConnection {
	private ws: WebSocket | null = null;
	private queue: PendingFrame[] = [];
	private waiters: Array<(frame: PendingFrame) => void> = [];
	private open = false;

	constructor(
		private readonly url: string,
		private readonly headers: Record<string, string>,
		private readonly proxy?: string,
		private readonly onUpgrade?: (response: IncomingMessage) => void,
	) {}

	async connect(signal: AbortSignal): Promise<void> {
		const { default: WebSocketImpl } = await import("ws");
		if (signal.aborted) {
			throw createCodexWebSocketAbortError();
		}
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const wsOptions: { headers: Record<string, string>; agent?: boolean | HttpAgent } = {
				headers: this.headers,
			};
			if (this.proxy) {
				wsOptions.agent = new HttpsProxyAgent(this.proxy);
			}
			const ws = new WebSocketImpl(this.url, wsOptions);
			this.ws = ws;

			const cleanup = () => {
				signal.removeEventListener("abort", onAbort);
			};
			const finishReject = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				this.open = false;
				if (this.ws === ws) {
					this.ws = null;
				}
				reject(error);
			};
			const finishResolve = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const onAbort = () => {
				try {
					ws.terminate();
				} catch {
					try {
						ws.close();
					} catch {
						// ignore secondary close errors while aborting connection setup
					}
				}
				finishReject(createCodexWebSocketAbortError());
			};

			ws.once("upgrade", (response) => {
				this.onUpgrade?.(response);
			});
			ws.once("unexpected-response", (_request, response) => {
				const status = response.statusCode;
				const message = `Codex WebSocket upgrade failed with status ${status ?? "unknown"}`;
				finishReject(
					shouldDisableWebSocketForStatus(status)
						? new CodexWebSocketFallbackError(message, status)
						: new Error(message),
				);
			});
			ws.once("open", () => {
				this.open = true;
				finishResolve();
			});
			ws.on("error", (error) => {
				if (!settled) {
					const match = error.message.match(/Unexpected server response:\s*(\d+)/);
					const status = match?.[1] ? Number.parseInt(match[1], 10) : undefined;
					finishReject(
						shouldDisableWebSocketForStatus(status)
							? new CodexWebSocketFallbackError(error.message, status)
							: error,
					);
					return;
				}
				this.push({ type: "error", error });
			});
			ws.on("message", (data) => {
				const text = typeof data === "string" ? data : data.toString();
				this.push({ type: "message", text });
			});
			ws.on("close", (code, reason) => {
				this.open = false;
				this.push({ type: "close", code, reason: reason.toString() });
			});
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
		});
	}

	isOpen(): boolean {
		return !!this.ws && this.open;
	}

	isClosed(): boolean {
		return (
			!this.ws || this.ws.readyState === this.ws.CLOSED || this.ws.readyState === this.ws.CLOSING
		);
	}

	async send(text: string): Promise<void> {
		if (!this.ws || !this.open) {
			throw new Error("Codex WebSocket connection is not open");
		}
		await new Promise<void>((resolve, reject) => {
			this.ws?.send(text, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	async nextFrame(timeoutMs: number, signal: AbortSignal): Promise<PendingFrame> {
		if (this.queue.length > 0) {
			return this.queue.shift() as PendingFrame;
		}
		return new Promise<PendingFrame>((resolve, reject) => {
			const onAbort = () => {
				cleanup();
				reject(new Error("Codex WebSocket request aborted"));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Codex WebSocket idle timeout waiting for response event"));
			}, timeoutMs);
			const resolver = (frame: PendingFrame) => {
				cleanup();
				resolve(frame);
			};
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				const index = this.waiters.indexOf(resolver);
				if (index >= 0) this.waiters.splice(index, 1);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(resolver);
		});
	}

	async close(): Promise<void> {
		if (!this.ws) return;
		const ws = this.ws;
		this.ws = null;
		if (ws.readyState === ws.CLOSED) return;
		await new Promise<void>((resolve) => {
			const done = () => resolve();
			ws.once("close", done);
			try {
				ws.close();
			} catch {
				resolve();
			}
			setTimeout(resolve, 1000);
		});
	}

	private push(frame: PendingFrame): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(frame);
			return;
		}
		this.queue.push(frame);
	}
}

async function ensureConnection(
	session: CachedSession,
	options: StreamCodexResponsesWebSocketOptions,
): Promise<ReusableWebSocketConnection> {
	if (options.signal.aborted) {
		throw createCodexWebSocketAbortError();
	}
	if (session.connection?.isOpen()) {
		return session.connection;
	}
	await closeSessionConnection(session);
	if (options.signal.aborted) {
		throw createCodexWebSocketAbortError();
	}
	const url = buildCodexResponsesWebSocketUrl(options.baseUrl);
	const connection = new ReusableWebSocketConnection(
		url,
		buildHandshakeHeaders(options, session),
		options.proxy,
		(response) => {
			const turnState = response.headers[TURN_STATE_HEADER];
			if (typeof turnState === "string" && turnState) {
				session.turnState = turnState;
			}
		},
	);
	await connection.connect(options.signal);
	if (options.signal.aborted) {
		await connection.close();
		throw createCodexWebSocketAbortError();
	}
	session.connection = connection;
	logger.info("Codex Responses WebSocket connected", {
		sessionKey: options.sessionKey,
		credentialId: options.credentialId,
		model: options.model,
		url,
	});
	return connection;
}

export async function* streamCodexResponsesWebSocket(
	options: StreamCodexResponsesWebSocketOptions,
): AsyncGenerator<ParsedStreamEvent> {
	const cacheKey = buildSessionCacheKey(options);
	const session = getOrCreateSession(cacheKey);
	if (session.disabled) {
		throw new CodexWebSocketFallbackError("Codex Responses WebSocket is disabled for this session");
	}
	if (session.busy) {
		throw new Error("Codex Responses WebSocket session is already in use");
	}

	touchSession(session);
	session.busy = true;
	const request = cloneJson(options.request);
	let connection: ReusableWebSocketConnection | null = null;
	let completed = false;
	let responseId = "";
	const itemsAdded: unknown[] = [];
	const toolAccum = new Map<number, ResponsesToolAccum>();
	const reasoningAccum = new Map<number, ResponsesReasoningAccum>();
	let requestDispatched = false;
	const resetAbortedSessionIfNeeded = async () => {
		if (!completed && options.signal.aborted && (requestDispatched || connection)) {
			await resetSession(session, false);
			connection = null;
		}
	};

	try {
		if (options.resetSessionBeforeRequest) {
			await resetSession(session, false);
		}
		const websocketRequest = buildCodexResponsesWebSocketRequest(
			request,
			session.lastRequest,
			session.lastCompleted,
		);
		const requestText = JSON.stringify(websocketRequest);
		let reconnectCount = 0;
		let hasYieldedEvents = false;

		connection = await ensureConnection(session, options);
		if (options.signal.aborted) {
			yield { silentDisconnect: true };
			return;
		}
		await connection.send(requestText);
		requestDispatched = true;

		while (true) {
			if (options.signal.aborted) {
				yield { silentDisconnect: true };
				return;
			}

			let frame: PendingFrame;
			try {
				frame = await connection.nextFrame(CONNECTION_IDLE_TIMEOUT_MS, options.signal);
			} catch (error) {
				if (!isCodexWebSocketIdleTimeoutError(error)) {
					throw error;
				}
				const latestMessageCreatedAt = await getLatestNarratorMessageCreatedAt(options.narratorId);
				if (options.signal.aborted) {
					await resetSession(session, false);
					yield { silentDisconnect: true };
					return;
				}
				const decision = decidePrematureCodexReconnect(
					latestMessageCreatedAt,
					hasYieldedEvents,
					reconnectCount,
				);
				logger.warn("Codex WebSocket timed out before response.completed", {
					sessionKey: options.sessionKey,
					narratorId: options.narratorId,
					credentialId: options.credentialId,
					model: options.model,
					latestMessageCreatedAt,
					shouldReconnect: decision.shouldReconnect,
					shouldFallback: decision.shouldFallback,
					hasYieldedEvents,
					reconnectCount,
				});
				if (decision.shouldReconnect) {
					await closeSessionConnection(session);
					connection = null;
					reconnectCount++;
					touchSession(session);
					connection = await ensureConnection(session, options);
					if (options.signal.aborted) {
						await resetSession(session, false);
						yield { silentDisconnect: true };
						return;
					}
					await connection.send(requestText);
					continue;
				}
				await resetSession(session, false);
				connection = null;
				if (decision.shouldFallback) {
					throw new CodexWebSocketFallbackError(
						error instanceof Error ? error.message : String(error),
					);
				}
				yield { silentDisconnect: true };
				return;
			}
			if (frame.type === "error") {
				throw frame.error;
			}
			if (frame.type === "close") {
				if (options.signal.aborted) {
					await resetSession(session, false);
					yield { silentDisconnect: true };
					return;
				}

				const closeWrappedError = parseCodexWrappedError(frame.reason);
				if (closeWrappedError) {
					const status = closeWrappedError.status ?? closeWrappedError.status_code;
					const errorCode = closeWrappedError.error?.code ?? closeWrappedError.error?.type;
					const error = formatWrappedError(closeWrappedError);
					if (isCodexWebSocketConnectionLimitError(closeWrappedError)) {
						const shouldReconnect =
							!hasYieldedEvents && reconnectCount < MAX_PREMATURE_CLOSE_RECONNECTS;
						const shouldFallback = !hasYieldedEvents;
						logger.warn("Codex WebSocket close reason reached connection lifetime limit", {
							sessionKey: options.sessionKey,
							narratorId: options.narratorId,
							credentialId: options.credentialId,
							model: options.model,
							closeCode: frame.code,
							status,
							shouldReconnect,
							shouldFallback,
							hasYieldedEvents,
							reconnectCount,
						});
						if (shouldReconnect) {
							await closeSessionConnection(session);
							connection = null;
							reconnectCount++;
							touchSession(session);
							connection = await ensureConnection(session, options);
							if (options.signal.aborted) {
								await resetSession(session, false);
								yield { silentDisconnect: true };
								return;
							}
							await connection.send(requestText);
							continue;
						}
						await resetSession(session, false);
						connection = null;
						if (shouldFallback) {
							throw new CodexWebSocketFallbackError(error.message, status);
						}
						throw error;
					}
					logger.warn("Codex WebSocket closed with error reason", {
						sessionKey: options.sessionKey,
						narratorId: options.narratorId,
						credentialId: options.credentialId,
						model: options.model,
						closeCode: frame.code,
						status,
						errorCode,
						error: error.message,
					});
					if (shouldDisableWebSocketForStatus(status)) {
						await resetSession(session, true);
						throw new CodexWebSocketFallbackError(error.message, status);
					}
					throw error;
				}

				const latestMessageCreatedAt = await getLatestNarratorMessageCreatedAt(options.narratorId);
				const decision = decidePrematureCodexReconnect(
					latestMessageCreatedAt,
					hasYieldedEvents,
					reconnectCount,
				);
				logger.warn("Codex WebSocket closed before response.completed", {
					sessionKey: options.sessionKey,
					narratorId: options.narratorId,
					credentialId: options.credentialId,
					model: options.model,
					code: frame.code,
					reason: frame.reason,
					latestMessageCreatedAt,
					shouldReconnect: decision.shouldReconnect,
					shouldFallback: decision.shouldFallback,
					hasYieldedEvents,
					reconnectCount,
				});
				if (decision.shouldReconnect) {
					await closeSessionConnection(session);
					connection = null;
					reconnectCount++;
					touchSession(session);
					connection = await ensureConnection(session, options);
					if (options.signal.aborted) {
						await resetSession(session, false);
						yield { silentDisconnect: true };
						return;
					}
					await connection.send(requestText);
					continue;
				}
				await resetSession(session, false);
				connection = null;
				const closeReason = frame.reason.trim();
				const closeMessage =
					`Codex WebSocket closed before response.completed ` +
					`(code: ${frame.code}, reason: ${frame.reason})`;
				if (decision.shouldFallback) {
					throw new CodexWebSocketFallbackError(closeMessage);
				}
				if (closeReason) {
					throw new Error(closeMessage);
				}
				yield { silentDisconnect: true };
				return;
			}

			const wrappedError = parseCodexWrappedError(frame.text);
			if (wrappedError) {
				const status = wrappedError.status ?? wrappedError.status_code;
				const error = formatWrappedError(wrappedError);
				if (isCodexWebSocketConnectionLimitError(wrappedError)) {
					const shouldReconnect =
						!hasYieldedEvents && reconnectCount < MAX_PREMATURE_CLOSE_RECONNECTS;
					const shouldFallback = !hasYieldedEvents;
					logger.warn("Codex WebSocket reached connection lifetime limit", {
						sessionKey: options.sessionKey,
						narratorId: options.narratorId,
						credentialId: options.credentialId,
						model: options.model,
						status,
						shouldReconnect,
						shouldFallback,
						hasYieldedEvents,
						reconnectCount,
					});
					if (shouldReconnect) {
						await closeSessionConnection(session);
						connection = null;
						reconnectCount++;
						touchSession(session);
						connection = await ensureConnection(session, options);
						if (options.signal.aborted) {
							await resetSession(session, false);
							yield { silentDisconnect: true };
							return;
						}
						await connection.send(requestText);
						continue;
					}
					await resetSession(session, false);
					connection = null;
					if (shouldFallback) {
						throw new CodexWebSocketFallbackError(error.message, status);
					}
					throw error;
				}
				if (shouldDisableWebSocketForStatus(status)) {
					await resetSession(session, true);
					throw new CodexWebSocketFallbackError(error.message, status);
				}
				throw error;
			}

			let chunk: ResponsesAPIChunk;
			try {
				chunk = JSON.parse(frame.text) as ResponsesAPIChunk;
			} catch {
				continue;
			}

			// Gateway-injected events via WebSocket (data-embedded type field)
			const gwEvt = parseGatewayDataEvent(chunk as Record<string, unknown>);
			if (gwEvt) {
				yield gwEvt;
				continue;
			}

			if (chunk.type === "response.created" && chunk.response?.id) {
				responseId = String(chunk.response.id);
			}
			if (chunk.type === "response.output_item.done" && chunk.item) {
				itemsAdded.push(cloneJson(chunk.item));
			}

			for (const event of parseResponsesAPIEvent(chunk, toolAccum, reasoningAccum)) {
				hasYieldedEvents ||= shouldTreatCodexStreamEventAsYielded(event);
				yield event;
			}

			if (chunk.type === "response.completed") {
				completed = true;
				session.lastRequest = cloneJson(request);
				session.lastCompleted = { responseId, itemsAdded: cloneJson(itemsAdded) };
				touchSession(session);
				return;
			}
			if (chunk.type === "response.failed" || chunk.type === "response.incomplete") {
				await resetSession(session, false);
				return;
			}
		}
	} catch (error) {
		if (isCodexWebSocketAbortError(error) && !requestDispatched) {
			throw error;
		}
		if (error instanceof CodexWebSocketFallbackError) {
			throw error;
		}
		await resetSession(session, false);
		throw error;
	} finally {
		await resetAbortedSessionIfNeeded();
		session.busy = false;
		touchSession(session);
		if (!completed && connection?.isClosed()) {
			session.connection = null;
		}
		const canDiscardSession =
			!completed &&
			!session.disabled &&
			session.connection === null &&
			session.lastRequest === null &&
			session.lastCompleted === null &&
			session.turnState === null;
		if (canDiscardSession) {
			sessionCache.delete(cacheKey);
			stopSessionCleanupTimerIfIdle();
		}
	}
}
