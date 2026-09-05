import type { Agent as HttpAgent, IncomingMessage } from "node:http";
import { eq, sql } from "drizzle-orm";
import { HttpsProxyAgent } from "https-proxy-agent";
import type WebSocket from "ws";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";
import { logger } from "../logger";
import {
	getHttpCodexUserAgent,
	mergeExtraHeaders,
	ORIGINATOR_CODEX,
	stripResponsesLiteHeader,
} from "../user-agent";
import { deriveCodexWindowId } from "./codex-request";
import { parseUpstreamErrorEnvelope } from "./error-diagnostics";
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
const CLIENT_REQUEST_ID_HEADER = "x-client-request-id";
const OPENAI_BETA_HEADER = "OpenAI-Beta";
/**
 * Idle budget once the response has started producing events.
 *
 * Matches codex-rs's `stream_idle_timeout` default (300s). The previous 60s was
 * a local invention that fired on ordinary upstream queueing — and because each
 * expiry costs a reconnect + full resend, a busy backend turned into a retry
 * storm rather than a slow response.
 */
const CONNECTION_IDLE_TIMEOUT_MS = 300_000;
/**
 * Idle budget while still waiting for the FIRST frame of a response.
 *
 * Kept shorter than {@link CONNECTION_IDLE_TIMEOUT_MS} because silence before
 * any event is the signature of a socket that was accepted and then abandoned,
 * which only a reconnect can resolve. Once frames are flowing the longer budget
 * applies: silence there means the model is working, not that the socket died.
 */
const FIRST_EVENT_IDLE_TIMEOUT_MS = 60_000;
/** Upgrade handshake budget. Mirrors codex-rs `websocket_connect_timeout` (15s). */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * Bound on `ws.send()`.
 *
 * codex-rs wraps its send in the same idle timeout for a reason: a half-open TCP
 * path accepts writes into a buffer that never drains, so an unbounded send
 * parks the caller forever. On this transport that caller is the narrator event
 * loop, so the session appears frozen with no error ever surfacing.
 */
const SEND_TIMEOUT_MS = 60_000;
/**
 * Proactive connection recycling threshold.
 *
 * Upstream closes a Responses WebSocket after 60 minutes and reports
 * `websocket_connection_limit_reached`. Recovering from that mid-stream costs a
 * reconnect and a full resend, so retire the socket while it is idle instead:
 * rebuilding between requests is invisible, rebuilding mid-response is not.
 */
const CONNECTION_MAX_LIFETIME_MS = 55 * 60_000;
const SESSION_IDLE_TTL_MS = 10 * 60_000;
const SESSION_CLEANUP_INTERVAL_MS = 60_000;
const MAX_SESSION_CACHE_SIZE = 100;
const RECENT_NARRATOR_MESSAGE_WINDOW_MS = 5 * 60_000;
const MAX_PREMATURE_CLOSE_RECONNECTS = 1;
/**
 * Reconnects granted after upstream explicitly says the connection is spent.
 *
 * Budgeted separately from {@link MAX_PREMATURE_CLOSE_RECONNECTS}: a silent close
 * is a guess about a possibly-broken socket, while `websocket_connection_limit_reached`
 * is an instruction ("Create a new websocket connection to continue"). Sharing one
 * counter let a speculative reconnect earlier in the request consume the budget
 * that this documented, always-recoverable case needs.
 */
const MAX_CONNECTION_LIMIT_RECONNECTS = 1;
/**
 * Full-request resends granted after `previous_response_not_found`.
 *
 * One is enough: the retry drops `previous_response_id` and resends everything, so
 * a second attempt would send an identical payload and fail identically.
 */
const MAX_PREVIOUS_RESPONSE_RETRIES = 1;

const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

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

/**
 * Whether a still-open connection is close enough to the upstream 60-minute cap
 * that it should be replaced before dispatching another request.
 *
 * Exported for tests: getting this wrong is invisible until a long-lived
 * narrator hits the cap mid-response an hour into a session.
 */
export function isCodexWebSocketConnectionExpiring(
	connectedAt: number,
	now = Date.now(),
	maxLifetimeMs = CONNECTION_MAX_LIFETIME_MS,
): boolean {
	return now - connectedAt >= maxLifetimeMs;
}

export interface StreamCodexResponsesWebSocketOptions {
	baseUrl: string;
	apiKey: string;
	/**
	 * Full Authorization header value overriding the default `Bearer ${apiKey}`
	 * (e.g. Agent Identity's `AgentAssertion ...`).
	 */
	authorization?: string;
	accountId?: string;
	proxy?: string;
	sessionKey: string;
	/** Stable conversation/thread identity sent in headers and request metadata. */
	conversationId: string;
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
	/**
	 * Extra handshake headers (client fingerprint: originator,
	 * x-codex-installation-id, session/thread ids, user-configured headers).
	 * Applied last so they can override the built-in defaults.
	 */
	extraHeaders?: Record<string, string>;
	/** Observe the exact request envelope and effective handshake headers. */
	onRequestPrepared?: (request: {
		url: string;
		headers: Record<string, string>;
		body: Record<string, unknown>;
	}) => void;
}

export class CodexWebSocketFallbackError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "CodexWebSocketFallbackError";
		this.status = status;
	}
}

/**
 * A transport fault upstream told us to recover from, raised only once this
 * generator has run out of ways to recover on its own.
 *
 * The `retryable` field is the point of the class. `isRetryableError` reads a
 * structured `retryable: true` before any keyword heuristic, and none of those
 * heuristics match the wording upstream actually uses — "Responses websocket
 * connection limit reached (60 minutes). Create a new websocket connection to
 * continue." contains no "overload", no "try again", no 5xx status. Thrown as a
 * plain Error it was classified NON-retryable and killed the turn, which is the
 * exact opposite of what the message asks for.
 *
 * `resumable` marks the case where output already reached the client: replaying
 * the request would duplicate it, so the agent loop must continue from the
 * partial turn instead of re-sending.
 */
export class CodexWebSocketRetryableError extends Error {
	readonly retryable = true;
	readonly status?: number;
	readonly code?: string;
	readonly resumable: boolean;

	constructor(
		message: string,
		options: { status?: number; code?: string; resumable?: boolean } = {},
	) {
		super(message);
		this.name = "CodexWebSocketRetryableError";
		this.status = options.status;
		this.code = options.code;
		this.resumable = options.resumable ?? false;
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

/**
 * Project a request down to the fields that decide whether the previous
 * websocket response can be continued with `previous_response_id`.
 *
 * `input` is blanked because it is compared separately as a prefix extension,
 * and `client_metadata` is dropped entirely: it carries per-request runtime
 * values (notably `x-codex-turn-state`, which only exists after the first
 * response of a turn) that change between otherwise identical requests. Leaving
 * it in would make every request after the first look like a different request,
 * silently degrading continuation into full resends and losing the prompt cache.
 *
 * codex-rs draws the same line in `responses_request_properties_match`:
 * "request equality includes `input` and `client_metadata`, while websocket
 * reuse compares the input separately and ignores metadata."
 */
function requestWithoutInput(
	request: CodexResponsesRequestBody,
): Omit<CodexResponsesRequestBody, "input"> & { input: [] } {
	const { client_metadata: _clientMetadata, ...rest } = cloneJson(request);
	return {
		...rest,
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

function wrappedErrorCodes(error: CodexWrappedErrorEvent): string[] {
	const dynamicError = error as CodexWrappedErrorEvent & { code?: string };
	return [error.error?.code, error.error?.type, dynamicError.code].filter(
		(code): code is string => typeof code === "string" && code.length > 0,
	);
}

/**
 * Upstream retired this connection after its 60-minute lifetime.
 *
 * Reads `code` AND `type` (plus the flat `code`) because the observed payload puts
 * `invalid_request_error` in `type` and the real signal in `code`; a single-field
 * lookup silently misses it and the error becomes terminal. Always recoverable —
 * upstream's own message says "Create a new websocket connection to continue."
 */
export function isCodexWebSocketConnectionLimitError(error: CodexWrappedErrorEvent): boolean {
	return wrappedErrorCodes(error).includes(CONNECTION_LIMIT_REACHED_CODE);
}

/**
 * Upstream no longer holds the response this request chained onto.
 *
 * Recoverable by dropping `previous_response_id` and resending the full input —
 * the delta we sent references a baseline the server has forgotten, so the delta
 * itself is meaningless but the conversation is not lost.
 */
export function isCodexWebSocketPreviousResponseMissingError(
	error: CodexWrappedErrorEvent,
): boolean {
	return wrappedErrorCodes(error).includes(PREVIOUS_RESPONSE_NOT_FOUND_CODE);
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

/**
 * Build the WebSocket handshake headers.
 *
 * Exported for tests: a typo or a wrong conditional here only shows up as a
 * silent fallback to HTTP, which is hard to diagnose from logs.
 *
 * Depends only on `options` — nothing session- or turn-scoped reaches the
 * handshake, matching codex-rs's `build_websocket_headers`, which takes no turn
 * state either. Anything learned mid-turn (the turn-state token) must travel in
 * the request body instead; see {@link applyTurnStateToRequest}.
 *
 * See docs/codex-websocket.md for the documented header contract.
 */
export function buildHandshakeHeaders(
	options: StreamCodexResponsesWebSocketOptions,
): Record<string, string> {
	// No x-openai-internal-codex-responses-lite here: the lite opt-in is a body
	// contract (no top-level instructions/tools, additional_tools spliced into
	// input, parallel_tool_calls off) that this transport does not implement, and
	// upstream rejects the header outright when `tools` carries hosted tools.
	const headers: Record<string, string> = {
		Authorization: options.authorization?.trim() || `Bearer ${options.apiKey}`,
		"User-Agent": options.userAgent ?? getHttpCodexUserAgent(),
		originator: ORIGINATOR_CODEX,
		"session-id": options.conversationId,
		"thread-id": options.conversationId,
		// Window id is conversation-stable, mirroring codex-rs build_websocket_headers,
		// which inserts x-codex-window-id directly (compatibility_headers) rather than
		// only through the client fingerprint.
		"x-codex-window-id": deriveCodexWindowId(options.conversationId),
		Origin: isOfficialChatGPTDomain(options.baseUrl) ? "https://chatgpt.com" : options.baseUrl,
		[OPENAI_BETA_HEADER]: RESPONSES_WS_BETA_HEADER,
		[CLIENT_REQUEST_ID_HEADER]: options.conversationId,
	};
	if (options.accountId && isOfficialChatGPTDomain(options.baseUrl)) {
		headers["ChatGPT-Account-Id"] = options.accountId;
	}
	// No x-codex-turn-state here. The token only exists after the first response of
	// a turn, by which point this connection's handshake is long since sent — and the
	// connection is reused for every later request in the turn, so a handshake header
	// could never carry it. It travels in each response.create's client_metadata
	// instead (see applyTurnStateToRequest). codex-rs makes the same split: its
	// build_websocket_headers passes `/*turn_state*/ None` and puts the token in the
	// websocket client_metadata, while the HTTP path sends it as a request header.
	if (options.turnMetadata) {
		headers[TURN_METADATA_HEADER] = options.turnMetadata;
	}
	// Client fingerprint (originator, x-codex-installation-id, session-id/thread-id,
	// user-configured headers) applied last so it overrides built-in defaults such as
	// originator. The session-id/thread-id pair (matching the real Codex CLI's hyphenated
	// header names) is supplied here rather than hardcoded above.
	//
	// `"User-Agent"` matches the casing written above, so an operator UA override
	// replaces that key rather than adding a second differently-cased one that the
	// handshake would send alongside it.
	mergeExtraHeaders(headers, options.extraHeaders, "User-Agent");
	// extraHeaders is merged last, so it is also the one place that could put the
	// lite opt-in back on the wire. Strip it for the same reason it is not set above.
	stripResponsesLiteHeader(headers);
	return headers;
}

/**
 * Read `x-codex-turn-state` out of a streamed metadata event.
 *
 * Both `response.metadata` and `codex.response.metadata` are accepted because the
 * gateway and the direct backend disagree on the prefix, and the header lookup is
 * case-insensitive — HTTP header names are, and matching only the lowercase form
 * would drop the token silently, degrading sticky routing with no error anywhere.
 *
 * Exported for tests: a miss here is invisible until same-turn requests start
 * landing on different backends.
 */
export function extractTurnStateFromEvent(chunk: Record<string, unknown>): string | null {
	const type = chunk.type;
	if (type !== "response.metadata" && type !== "codex.response.metadata") return null;
	const headers = asRecord(chunk.headers);
	if (!headers) return null;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== TURN_STATE_HEADER) continue;
		if (typeof value === "string" && value) return value;
		if (typeof value === "number") return String(value);
	}
	return null;
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

	if (!hasFlatError) {
		// The checks above only look at `message`/`code`/`type`. Fall back to the shared
		// envelope recognizer, which also reads `detail` / `description` and a
		// string-valued `error`. Without it those payloads returned null here and the
		// frame was treated as ordinary content — so the upstream explanation was
		// dropped and the turn ended up reported as having produced nothing.
		const envelope = parseUpstreamErrorEnvelope(obj);
		if (!envelope) return null;
		return {
			type: "error",
			status: envelope.statusCode,
			error: { code: envelope.code, message: envelope.message },
		};
	}

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

/**
 * Recover a known recoverable error code from a close reason that could not be
 * parsed as JSON.
 *
 * RFC 6455 caps a close reason at 123 bytes, and the payload upstream puts there
 * is longer than that — the connection-limit JSON alone is ~230 bytes. So the
 * reason arrives truncated mid-string, `JSON.parse` fails on every candidate, and
 * a close-delivered connection limit is indistinguishable from an anonymous
 * disconnect. It then took the "closed before response.completed" path and threw a
 * plain, non-retryable Error.
 *
 * Substring matching is safe here precisely because these codes are the signal:
 * they do not occur in prose, and the alternative is discarding the only
 * identifying information the frame still carries.
 */
export function findCodexRecoverableCloseCode(
	text: string,
): typeof CONNECTION_LIMIT_REACHED_CODE | typeof PREVIOUS_RESPONSE_NOT_FOUND_CODE | null {
	if (text.includes(CONNECTION_LIMIT_REACHED_CODE)) return CONNECTION_LIMIT_REACHED_CODE;
	if (text.includes(PREVIOUS_RESPONSE_NOT_FOUND_CODE)) return PREVIOUS_RESPONSE_NOT_FOUND_CODE;
	return null;
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

/**
 * Attach the turn's sticky-routing token to an outgoing `response.create`.
 *
 * The server hands `x-codex-turn-state` back on the first response of a turn and
 * expects it replayed on every later request of that same turn (retries,
 * incremental appends, continuations) so they land on the same backend. On this
 * transport it cannot ride a handshake header — the connection is established
 * before the token exists and is then reused — so it goes in the request body,
 * mirroring codex-rs's websocket path.
 *
 * Must run AFTER buildCodexResponsesWebSocketRequest: that function compares the
 * previous and current request to decide on continuation, and this key changes
 * between turns. Injecting first would defeat the comparison.
 */
export function applyTurnStateToRequest(
	websocketRequest: Record<string, unknown>,
	turnState: string | null,
): void {
	if (!turnState) return;
	const existing = websocketRequest.client_metadata;
	const metadata = (
		existing && typeof existing === "object" ? { ...(existing as Record<string, string>) } : {}
	) as Record<string, string>;
	metadata[TURN_STATE_HEADER] = turnState;
	websocketRequest.client_metadata = metadata;
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

/**
 * Close the socket and forget the `previous_response_id` chain, keeping the
 * session entry itself alive.
 *
 * Distinct from {@link resetSession} only in that `turnState` survives: the
 * sticky-routing token belongs to the TURN, not to the connection, and upstream
 * expects it replayed on every request of that turn — including the ones sent
 * over a replacement socket after a reconnect. Clearing it on reconnect would
 * silently drop same-turn backend affinity.
 */
async function discardResponseChain(session: CachedSession): Promise<void> {
	await closeSessionConnection(session);
	session.lastRequest = null;
	session.lastCompleted = null;
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
	/** Wall-clock time the upgrade completed, for the 60-minute lifetime cap. */
	private connectedAt = 0;

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

			// A TCP connect that neither completes nor errors (silent drop by a proxy or
			// firewall) leaves `ws` emitting nothing at all. Without this timer the await
			// below never settles and the caller — the narrator event loop — hangs with no
			// error to report.
			const handshakeTimer = setTimeout(() => {
				finishReject(
					new Error(`Codex WebSocket handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`),
				);
			}, HANDSHAKE_TIMEOUT_MS);

			const cleanup = () => {
				clearTimeout(handshakeTimer);
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
				// The socket may still be mid-handshake; leaving it dangling leaks an fd and,
				// worse, counts against the upstream per-account connection budget.
				try {
					ws.terminate();
				} catch {
					// ignore: already dead, nothing to release
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
				this.connectedAt = Date.now();
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

	/** True once this socket is old enough that upstream may retire it mid-response. */
	isExpiring(now = Date.now()): boolean {
		return this.connectedAt > 0 && isCodexWebSocketConnectionExpiring(this.connectedAt, now);
	}

	async send(text: string): Promise<void> {
		if (!this.ws || !this.open) {
			throw new Error("Codex WebSocket connection is not open");
		}
		// Bounded, because a half-open path swallows writes without ever invoking the
		// callback (see SEND_TIMEOUT_MS). The timeout is cleared on both outcomes so a
		// completed send never leaves a stray timer holding the event loop.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Codex WebSocket send timed out after ${SEND_TIMEOUT_MS}ms`));
			}, SEND_TIMEOUT_MS);
			this.ws?.send(text, (error) => {
				clearTimeout(timer);
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
	handshakeHeaders?: Record<string, string>,
): Promise<ReusableWebSocketConnection> {
	if (options.signal.aborted) {
		throw createCodexWebSocketAbortError();
	}
	if (session.connection?.isOpen() && !session.connection.isExpiring()) {
		return session.connection;
	}
	// Any new socket invalidates the response chain. `previous_response_id` is
	// connection-scoped upstream, which is precisely what `previous_response_not_found`
	// reports — codex-rs draws the same line by calling `reset_websocket_session()`
	// (clearing last_request/last_response) every time `websocket_connection()` decides
	// it needs a new connection. Dropping the chain costs a full resend; keeping it
	// costs a guaranteed round-trip failure first.
	await discardResponseChain(session);
	if (options.signal.aborted) {
		throw createCodexWebSocketAbortError();
	}
	const url = buildCodexResponsesWebSocketUrl(options.baseUrl);
	const connection = new ReusableWebSocketConnection(
		url,
		handshakeHeaders ?? buildHandshakeHeaders(options),
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
	let itemsAdded: unknown[] = [];
	let toolAccum = new Map<number, ResponsesToolAccum>();
	let reasoningAccum = new Map<number, ResponsesReasoningAccum>();
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
		let reconnectCount = 0;
		let connectionLimitReconnects = 0;
		let previousResponseRetries = 0;
		let hasYieldedEvents = false;
		const handshakeHeaders = buildHandshakeHeaders(options);
		let requestReported = false;

		/**
		 * Serialize the request against the session's CURRENT chain state.
		 *
		 * Rebuilt per dispatch rather than captured once, because every reconnect path
		 * below drops the chain: a cached delta still carrying `previous_response_id`
		 * would reference a response the new socket has never heard of, so the resend
		 * that was supposed to recover the turn fails with `previous_response_not_found`
		 * instead. Turn state is injected last (see applyTurnStateToRequest) since it is
		 * only learned after the first response and must ride every later request.
		 */
		const buildRequestFrame = (): { body: Record<string, unknown>; text: string } => {
			const body = buildCodexResponsesWebSocketRequest(
				request,
				session.lastRequest,
				session.lastCompleted,
			);
			applyTurnStateToRequest(body, session.turnState);
			return { body, text: JSON.stringify(body) };
		};

		const dispatchRequest = async (): Promise<void> => {
			const frame = buildRequestFrame();
			// Only the first dispatch is reported: the dump records what we sent for this
			// logical request, and overwriting it with a recovery resend would erase the
			// payload that actually triggered the failure being diagnosed.
			if (!requestReported) {
				requestReported = true;
				options.onRequestPrepared?.({
					url: buildCodexResponsesWebSocketUrl(options.baseUrl),
					headers: handshakeHeaders,
					body: frame.body,
				});
			}
			await connection?.send(frame.text);
			requestDispatched = true;
		};

		/**
		 * Rebuild the transport and resend, discarding anything the dead attempt left.
		 *
		 * Resetting the accumulators is not bookkeeping: `toolAccum` and `reasoningAccum`
		 * are keyed by output index, so a half-written tool call from the abandoned
		 * response would merge with the replacement response's index 0 and emit a tool
		 * call whose arguments are two different JSON fragments concatenated.
		 *
		 * Returns false when the abort signal fired while reconnecting, so the caller
		 * ends the stream instead of sending into a socket nobody is reading.
		 */
		const reconnectAndResend = async (): Promise<boolean> => {
			await discardResponseChain(session);
			connection = null;
			responseId = "";
			itemsAdded = [];
			toolAccum = new Map();
			reasoningAccum = new Map();
			touchSession(session);
			connection = await ensureConnection(session, options, handshakeHeaders);
			if (options.signal.aborted) {
				await resetSession(session, false);
				return false;
			}
			await dispatchRequest();
			return true;
		};

		/**
		 * Recover from `websocket_connection_limit_reached`.
		 *
		 * Upstream retires a Responses WebSocket after 60 minutes and says so explicitly:
		 * "Create a new websocket connection to continue." That instruction is always
		 * actionable, so a reconnect is attempted regardless of whether output already
		 * streamed — the previous code only reconnected when nothing had been yielded,
		 * which meant the failure mode that actually happens in practice (the cap firing
		 * mid-response on a long-lived narrator) was never recovered.
		 *
		 * When output DID already reach the client, the resend must not be silent: the
		 * caller has persisted that partial turn, so recovery is surfaced as a resumable
		 * error and the agent loop continues from the partial output rather than
		 * duplicating it. Only a genuinely exhausted budget falls through to an error,
		 * and that error is retryable so the loop still has a path forward.
		 */
		const handleConnectionLimitReached = async (detail: {
			status?: number;
			message: string;
			closeCode?: number;
		}): Promise<"reconnected" | "aborted"> => {
			const canReconnect =
				!hasYieldedEvents && connectionLimitReconnects < MAX_CONNECTION_LIMIT_RECONNECTS;
			logger.warn("Codex WebSocket reached its connection lifetime limit", {
				sessionKey: options.sessionKey,
				narratorId: options.narratorId,
				credentialId: options.credentialId,
				model: options.model,
				status: detail.status,
				closeCode: detail.closeCode,
				hasYieldedEvents,
				connectionLimitReconnects,
				canReconnect,
			});
			if (canReconnect) {
				connectionLimitReconnects++;
				if (await reconnectAndResend()) return "reconnected";
				return "aborted";
			}
			// Drop the chain either way: this socket is gone, so a later request must not
			// try to continue from a response it held.
			await discardResponseChain(session);
			connection = null;
			throw new CodexWebSocketRetryableError(detail.message, {
				status: detail.status,
				code: CONNECTION_LIMIT_REACHED_CODE,
				// Output already delivered means a replay would duplicate it; the loop
				// resumes from the partial turn instead.
				resumable: hasYieldedEvents,
			});
		};

		/**
		 * Recover from `previous_response_not_found`.
		 *
		 * The delta we sent chained onto a response upstream no longer holds. Clearing
		 * the chain makes the rebuilt request a full resend (buildCodexResponsesWebSocketRequest
		 * emits a plain `response.create` once lastCompleted is gone), which is exactly
		 * the retry codex-rs performs for this code. One attempt only: a second would
		 * rebuild the identical full request and fail identically.
		 */
		const handlePreviousResponseMissing = async (detail: {
			status?: number;
			message: string;
			closeCode?: number;
		}): Promise<"reconnected" | "aborted"> => {
			const canRetry = !hasYieldedEvents && previousResponseRetries < MAX_PREVIOUS_RESPONSE_RETRIES;
			logger.warn("Codex WebSocket previous response no longer available", {
				sessionKey: options.sessionKey,
				narratorId: options.narratorId,
				credentialId: options.credentialId,
				model: options.model,
				status: detail.status,
				closeCode: detail.closeCode,
				hasYieldedEvents,
				previousResponseRetries,
				canRetry,
			});
			if (canRetry) {
				previousResponseRetries++;
				if (await reconnectAndResend()) return "reconnected";
				return "aborted";
			}
			await discardResponseChain(session);
			connection = null;
			throw new CodexWebSocketRetryableError(detail.message, {
				status: detail.status,
				code: PREVIOUS_RESPONSE_NOT_FOUND_CODE,
				resumable: hasYieldedEvents,
			});
		};

		connection = await ensureConnection(session, options, handshakeHeaders);
		if (options.signal.aborted) {
			yield { silentDisconnect: true };
			return;
		}
		await dispatchRequest();

		while (true) {
			if (options.signal.aborted) {
				yield { silentDisconnect: true };
				return;
			}

			let frame: PendingFrame;
			try {
				// Two budgets, because silence means different things before and after the
				// first event: pre-first-event silence points at an abandoned socket, while
				// mid-stream silence is usually the model working. See the constants.
				frame = await connection.nextFrame(
					hasYieldedEvents ? CONNECTION_IDLE_TIMEOUT_MS : FIRST_EVENT_IDLE_TIMEOUT_MS,
					options.signal,
				);
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
					reconnectCount++;
					if (!(await reconnectAndResend())) {
						yield { silentDisconnect: true };
						return;
					}
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
						const outcome = await handleConnectionLimitReached({
							status,
							message: error.message,
							closeCode: frame.code,
						});
						if (outcome === "reconnected") continue;
						if (outcome === "aborted") {
							yield { silentDisconnect: true };
							return;
						}
						return;
					}
					if (isCodexWebSocketPreviousResponseMissingError(closeWrappedError)) {
						const outcome = await handlePreviousResponseMissing({
							status,
							message: error.message,
							closeCode: frame.code,
						});
						if (outcome === "reconnected") continue;
						if (outcome === "aborted") {
							yield { silentDisconnect: true };
							return;
						}
						return;
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

				// The reason was not parseable JSON — most often because RFC 6455 truncated
				// it at 123 bytes. Salvage the error code before treating this as an
				// anonymous disconnect; see findCodexRecoverableCloseCode.
				const truncatedCode = findCodexRecoverableCloseCode(frame.reason);
				if (truncatedCode === CONNECTION_LIMIT_REACHED_CODE) {
					const outcome = await handleConnectionLimitReached({
						message: frame.reason.trim() || CONNECTION_LIMIT_REACHED_CODE,
						closeCode: frame.code,
					});
					if (outcome === "reconnected") continue;
					yield { silentDisconnect: true };
					return;
				}
				if (truncatedCode === PREVIOUS_RESPONSE_NOT_FOUND_CODE) {
					const outcome = await handlePreviousResponseMissing({
						message: frame.reason.trim() || PREVIOUS_RESPONSE_NOT_FOUND_CODE,
						closeCode: frame.code,
					});
					if (outcome === "reconnected") continue;
					yield { silentDisconnect: true };
					return;
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
					reconnectCount++;
					if (!(await reconnectAndResend())) {
						yield { silentDisconnect: true };
						return;
					}
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
					const outcome = await handleConnectionLimitReached({
						status,
						message: error.message,
					});
					if (outcome === "reconnected") continue;
					yield { silentDisconnect: true };
					return;
				}
				if (isCodexWebSocketPreviousResponseMissingError(wrappedError)) {
					const outcome = await handlePreviousResponseMissing({
						status,
						message: error.message,
					});
					if (outcome === "reconnected") continue;
					yield { silentDisconnect: true };
					return;
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

			// Turn state arrives on a metadata EVENT, not only on the handshake response.
			// The handshake header is the lesser source: it exists only on a brand-new
			// connection, so a reused connection (the normal case for every request after
			// the first in a turn) learned the token nowhere and dropped sticky routing.
			const eventTurnState = extractTurnStateFromEvent(chunk as Record<string, unknown>);
			if (eventTurnState) {
				session.turnState = eventTurnState;
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
				// The chain is dead, but the CALLER must still learn why. `parseResponsesAPIEvent`
				// has already turned this chunk into an `invalidState` event above, which carries
				// the upstream code/message and lets the agent loop classify it (retryable
				// server_error vs. terminal refusal vs. context overflow).
				//
				// Returning without that distinction — as this did — presented a failed response
				// as a successful empty turn, so a transient upstream error looked like the model
				// choosing to say nothing.
				await discardResponseChain(session);
				connection = null;
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
		if (error instanceof CodexWebSocketRetryableError) {
			// Recovery handlers already discarded the socket and response chain. Keep
			// the turn's sticky token for the caller's next chat invocation, whether it
			// resumes partial output or retries after exhausting the reconnect budget.
			// The finally block still fully resets a request that was aborted.
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
