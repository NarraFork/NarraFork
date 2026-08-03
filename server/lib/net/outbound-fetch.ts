import type { Dispatcher } from "undici";
import { ProxyAgent } from "undici/index.js";
import {
	redactDiagnosticHeaders,
	redactDiagnosticText,
	redactDiagnosticUrl,
} from "./diagnostic-redaction";
import { isTransientTlsHandshakeError } from "./tls-transport-error";

const MAX_VERBOSE_OUTPUT_CHARS = 64 * 1024;
type OutboundFetchOverride = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let outboundFetchOverride: OutboundFetchOverride | null = null;

export type OutboundFetchRetryPolicy = "never" | "idempotent-only" | "always";

export interface OutboundFetchOptions {
	proxyUrl?: string;
	tlsRejectUnauthorized?: boolean;
	/** Retry one pre-response transient network failure according to the request replay policy. */
	retryPolicy?: OutboundFetchRetryPolicy;
	/** Admin model-test trace. Values are restricted to a diagnostic-safe allowlist. */
	verbose?: boolean;
}

export class OutboundProxyConfigurationError extends Error {
	readonly code: "INVALID_OUTBOUND_PROXY_URL" | "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL";
	readonly protocol?: string;

	constructor(options: {
		code: "INVALID_OUTBOUND_PROXY_URL" | "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL";
		protocol?: string;
		supportedProtocols?: string[];
	}) {
		const supported = options.supportedProtocols ?? ["http", "https"];
		const message =
			options.code === "INVALID_OUTBOUND_PROXY_URL"
				? "The configured outbound proxy URL is invalid."
				: `Unsupported outbound proxy protocol "${options.protocol ?? "unknown"}". ` +
					`Supported protocols are ${supported.join(", ")}.`;
		super(message);
		this.name = "OutboundProxyConfigurationError";
		this.code = options.code;
		this.protocol = options.protocol;
	}
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

function normalizeProxyUrl(proxyUrl: string, supportedProtocols: Set<string>): URL {
	const trimmed = proxyUrl.trim();
	const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new OutboundProxyConfigurationError({ code: "INVALID_OUTBOUND_PROXY_URL" });
	}
	if (!supportedProtocols.has(parsed.protocol.toLowerCase())) {
		throw new OutboundProxyConfigurationError({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			protocol: parsed.protocol.replace(/:$/, "").toLowerCase(),
			supportedProtocols: [...supportedProtocols].map((protocol) => protocol.replace(/:$/, "")),
		});
	}
	return parsed;
}

function createProxyDispatcher(proxyUrl: string, tlsRejectUnauthorized: boolean): Dispatcher {
	const parsed = normalizeProxyUrl(proxyUrl, SUPPORTED_PROXY_PROTOCOLS);
	return new ProxyAgent({
		uri: parsed.toString(),
		requestTls: { rejectUnauthorized: tlsRejectUnauthorized },
	});
}

function writeVerboseBlock(lines: string[]): void {
	const output = lines.join("\n");
	console.error(
		output.length <= MAX_VERBOSE_OUTPUT_CHARS
			? output
			: `${output.slice(0, MAX_VERBOSE_OUTPUT_CHARS)}\n... [verbose output truncated]`,
	);
}

type BunFetchInit = RequestInit & {
	proxy?: string;
	tls?: { rejectUnauthorized?: boolean };
};

const RETRYABLE_TRANSPORT_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENETDOWN",
	"ENETUNREACH",
	"ECONNREFUSED",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"CONNECTIONREFUSED",
	"CONNECTIONRESET",
	"CONNECTIONABORTED",
]);

const RETRYABLE_TRANSPORT_PATTERNS = [
	"socket connection was closed unexpectedly",
	"connection was closed unexpectedly",
	"socket hang up",
	"connection reset",
	"econnreset",
	"etimedout",
	"eai_again",
	"fetch failed",
	"failed to fetch",
	"network error",
	"unable to connect",
	"the operation timed out",
];

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return error instanceof Error && error.name === "AbortError";
}

function isRetryableTransportError(error: unknown): boolean {
	let current = error;
	let depth = 0;
	const messages: string[] = [];
	while (current && typeof current === "object" && depth < 5) {
		const value = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (typeof value.code === "string" && RETRYABLE_TRANSPORT_CODES.has(value.code.toUpperCase())) {
			return true;
		}
		if (typeof value.message === "string") messages.push(value.message.toLowerCase());
		if (!value.cause || value.cause === current) break;
		current = value.cause;
		depth++;
	}
	return messages.some((message) =>
		RETRYABLE_TRANSPORT_PATTERNS.some((pattern) => message.includes(pattern)),
	);
}

const IDEMPOTENT_HTTP_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]);

function retryPolicyAllowsMethod(policy: OutboundFetchRetryPolicy, method: string): boolean {
	if (policy === "never") return false;
	return policy === "always" || IDEMPOTENT_HTTP_METHODS.has(method);
}

function prepareRetryInput(
	input: string | URL | Request,
	body: BodyInit | null | undefined,
	allowRequestBodyClone: boolean,
): string | URL | Request | undefined {
	// A caller-provided stream may already be consumed when the first fetch fails.
	if (body instanceof ReadableStream) return undefined;
	if (!(input instanceof Request)) return input;
	// A Request body is a stream, so cloning tees it and the unread branch buffers
	// the whole body until it is dropped. Only pay that when the method itself is
	// replayable; a bodyless Request has nothing to tee.
	if (!allowRequestBodyClone && input.body !== null) return undefined;
	try {
		// Clone before the first attempt so a cloneable Request body has an independent replay branch.
		return input.clone();
	} catch {
		return undefined;
	}
}

/**
 * Whether a failed attempt may be replayed on a fresh connection.
 *
 * Two independent grounds, because "is a replay safe?" and "is this failure
 * transient?" are different questions:
 * - A TLS handshake that failed for an unattributable reason never handed a
 *   single request byte to the peer, so replaying it cannot duplicate a side
 *   effect. Method and idempotency are irrelevant; only an explicit
 *   `retryPolicy: "never"` opts out.
 * - Any other transient transport failure may have already delivered the
 *   request, so it stays gated on the method being replayable under the policy.
 */
function shouldReplayTransportFailure(
	error: unknown,
	retryPolicy: OutboundFetchRetryPolicy,
	methodReplayAllowed: boolean,
): boolean {
	if (retryPolicy === "never") return false;
	if (isTransientTlsHandshakeError(error)) return true;
	return methodReplayAllowed && isRetryableTransportError(error);
}

/**
 * Fetch through Bun's native transport so streaming Response bodies and
 * AbortSignal use Bun's supported implementation. Direct requests explicitly
 * set `proxy: ""` to ignore ambient HTTP(S)_PROXY variables; configured proxies
 * are limited to the HTTP(S) protocols supported by Bun fetch.
 */
export async function outboundFetch(
	input: string | URL | Request,
	init?: RequestInit,
	options: OutboundFetchOptions = {},
): Promise<Response> {
	if (outboundFetchOverride) return outboundFetchOverride(input as RequestInfo | URL, init);
	const rawUrl = input instanceof Request ? input.url : String(input);
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const requestHeaders = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	// Avoid reusing a pooled connection across outbound requests. Long-lived NarraFork
	// processes can otherwise inherit a relay/NAT connection that accepts a request but
	// never returns headers before being reset. Each optional retry below therefore also
	// gets a fresh connection; higher agent layers retain their configured backoff retries.
	requestHeaders.set("Connection", "close");
	const proxy = options.proxyUrl
		? normalizeProxyUrl(options.proxyUrl, SUPPORTED_PROXY_PROTOCOLS).toString()
		: "";
	const fetchInit: BunFetchInit = {
		...init,
		headers: requestHeaders,
		proxy,
		...(options.tlsRejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
	};
	const retryPolicy = options.retryPolicy ?? "never";
	// Prepare the replay branch whenever the policy leaves any door open and the
	// body is actually replayable; which failures may walk through it is decided
	// per-error below, since a handshake failure and a mid-flight reset have
	// different safety conditions.
	const methodReplayAllowed = retryPolicyAllowsMethod(retryPolicy, method);
	const retryInput =
		retryPolicy === "never" ? undefined : prepareRetryInput(input, init?.body, methodReplayAllowed);
	const attempts = retryInput === undefined ? [input] : [input, retryInput];
	const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

	for (const [attempt, attemptInput] of attempts.entries()) {
		if (options.verbose) {
			writeVerboseBlock([
				`> ${method} ${redactDiagnosticUrl(rawUrl)}${attempt > 0 ? " [retry]" : ""}`,
				...redactDiagnosticHeaders(requestHeaders).map((header) => `> ${header}`),
			]);
		}
		try {
			const response = await fetch(attemptInput, fetchInit);
			if (options.verbose) {
				writeVerboseBlock([
					`< HTTP ${response.status} ${redactDiagnosticText(response.statusText)}`,
					...redactDiagnosticHeaders(response.headers).map((header) => `< ${header}`),
				]);
			}
			return response;
		} catch (error) {
			const shouldRetry =
				attempt + 1 < attempts.length &&
				!isAbortError(error, signal) &&
				shouldReplayTransportFailure(error, retryPolicy, methodReplayAllowed);
			if (options.verbose) {
				const message = redactDiagnosticText(
					error instanceof Error ? error.message : String(error),
				);
				const code =
					error && typeof error === "object" && "code" in error
						? String((error as { code?: unknown }).code ?? "")
						: "";
				writeVerboseBlock([
					`< NETWORK ERROR${code ? ` ${code}` : ""}: ${message}${shouldRetry ? " [retrying]" : ""}`,
				]);
			}
			if (!shouldRetry) throw error;
		}
	}
	throw new Error("Outbound fetch exhausted without returning a response");
}

/** Explicit test-only injection; production callers must never set this. */
export function setOutboundFetchOverrideForTest(override: OutboundFetchOverride | null): void {
	outboundFetchOverride = override;
}

/** Create a caller-owned proxy dispatcher for non-fetch clients. */
export function createOutboundProxyDispatcher(
	proxyUrl: string,
	tlsRejectUnauthorized = true,
): Dispatcher {
	return createProxyDispatcher(proxyUrl, tlsRejectUnauthorized);
}

/** Backward-compatible dispatcher factory for non-fetch clients. */
export function createHttpProxyDispatcher(proxyUrl: string): Dispatcher {
	return createOutboundProxyDispatcher(proxyUrl);
}

/** No shared dispatchers remain; retained as a compatibility/test teardown hook. */
export function closeOutboundFetchDispatchers(): Promise<void> {
	return Promise.resolve();
}
