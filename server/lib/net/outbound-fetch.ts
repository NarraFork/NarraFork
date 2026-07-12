import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import type { AgentConnectOpts } from "agent-base";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici/index.js";
import {
	redactDiagnosticHeaders,
	redactDiagnosticText,
	redactDiagnosticUrl,
} from "./diagnostic-redaction";

const MAX_PROXY_DISPATCHERS = 32;
const MAX_VERBOSE_OUTPUT_CHARS = 64 * 1024;
const directDispatchers = new Map<boolean, Dispatcher>();
type OutboundFetchOverride = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let outboundFetchOverride: OutboundFetchOverride | null = null;
const proxyDispatchers = new Map<string, Dispatcher>();

export interface OutboundFetchOptions {
	proxyUrl?: string;
	tlsRejectUnauthorized?: boolean;
	/** Admin model-test trace. Values are restricted to a diagnostic-safe allowlist. */
	verbose?: boolean;
}

export class OutboundProxyConfigurationError extends Error {
	readonly code: "INVALID_OUTBOUND_PROXY_URL" | "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL";
	readonly protocol?: string;

	constructor(options: {
		code: "INVALID_OUTBOUND_PROXY_URL" | "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL";
		protocol?: string;
	}) {
		const message =
			options.code === "INVALID_OUTBOUND_PROXY_URL"
				? "The configured outbound proxy URL is invalid."
				: `Unsupported outbound proxy protocol "${options.protocol ?? "unknown"}". ` +
					"Supported protocols are http, https, socks, socks4, socks4a, socks5, and socks5h.";
		super(message);
		this.name = "OutboundProxyConfigurationError";
		this.code = options.code;
		this.protocol = options.protocol;
	}
}

const SUPPORTED_PROXY_PROTOCOLS = new Set([
	"http:",
	"https:",
	"socks:",
	"socks4:",
	"socks4a:",
	"socks5:",
	"socks5h:",
]);

function normalizeProxyUrl(proxyUrl: string): URL {
	const trimmed = proxyUrl.trim();
	const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new OutboundProxyConfigurationError({ code: "INVALID_OUTBOUND_PROXY_URL" });
	}
	if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
		throw new OutboundProxyConfigurationError({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			protocol: parsed.protocol.replace(/:$/, "").toLowerCase(),
		});
	}
	return parsed;
}

function directDispatcher(tlsRejectUnauthorized: boolean): Dispatcher {
	const cached = directDispatchers.get(tlsRejectUnauthorized);
	if (cached) return cached;
	const dispatcher = new Agent({ connect: { rejectUnauthorized: tlsRejectUnauthorized } });
	directDispatchers.set(tlsRejectUnauthorized, dispatcher);
	return dispatcher;
}

function createSocksDispatcher(proxyUrl: string, tlsRejectUnauthorized: boolean): Dispatcher {
	const socksAgent = new SocksProxyAgent(proxyUrl);
	return new Agent({
		connect(options, callback) {
			const request = new EventEmitter() as ClientRequest;
			request.destroy = () => request;
			const secureEndpoint = options.protocol === "https:";
			const connectOptions = {
				host: options.hostname,
				hostname: options.hostname,
				port: Number(options.port),
				protocol: options.protocol,
				secureEndpoint,
				servername: options.servername ?? options.hostname,
				rejectUnauthorized: tlsRejectUnauthorized,
				localAddress: options.localAddress ?? undefined,
			} as AgentConnectOpts;
			void socksAgent.connect(request, connectOptions).then(
				(socket) => callback(null, socket as never),
				(error) => callback(error instanceof Error ? error : new Error(String(error)), null),
			);
		},
	});
}

function createProxyDispatcher(proxyUrl: string, tlsRejectUnauthorized: boolean): Dispatcher {
	const parsed = normalizeProxyUrl(proxyUrl);
	const normalizedUrl = parsed.toString();
	if (parsed.protocol === "http:" || parsed.protocol === "https:") {
		return new ProxyAgent({
			uri: normalizedUrl,
			requestTls: { rejectUnauthorized: tlsRejectUnauthorized },
		});
	}
	return createSocksDispatcher(normalizedUrl, tlsRejectUnauthorized);
}

function proxyDispatcher(proxyUrl: string, tlsRejectUnauthorized: boolean): Dispatcher {
	const parsed = normalizeProxyUrl(proxyUrl);
	const normalizedUrl = parsed.toString();
	const key = `${tlsRejectUnauthorized ? "verify" : "insecure"}\n${normalizedUrl}`;
	const cached = proxyDispatchers.get(key);
	if (cached) {
		proxyDispatchers.delete(key);
		proxyDispatchers.set(key, cached);
		return cached;
	}

	const dispatcher = createProxyDispatcher(normalizedUrl, tlsRejectUnauthorized);
	proxyDispatchers.set(key, dispatcher);
	if (proxyDispatchers.size > MAX_PROXY_DISPATCHERS) {
		const oldestKey = proxyDispatchers.keys().next().value;
		if (typeof oldestKey === "string") {
			const oldest = proxyDispatchers.get(oldestKey);
			proxyDispatchers.delete(oldestKey);
			if (oldest) void oldest.close().catch(() => {});
		}
	}
	return dispatcher;
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): boolean {
	return Object.hasOwn(value, key);
}

function requestBodyRequiresDuplex(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	return (
		typeof (body as { getReader?: unknown }).getReader === "function" ||
		typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
	);
}

function writeVerboseBlock(lines: string[]): void {
	const output = lines.join("\n");
	console.error(
		output.length <= MAX_VERBOSE_OUTPUT_CHARS
			? output
			: `${output.slice(0, MAX_VERBOSE_OUTPUT_CHARS)}\n... [verbose output truncated]`,
	);
}

function toUndiciRequest(
	input: string | URL | Request,
	init?: RequestInit,
): { input: string | URL; init: UndiciRequestInit } {
	if (!(input instanceof Request)) {
		const body = init?.body;
		return {
			input,
			init: {
				...(init as unknown as UndiciRequestInit),
				...(requestBodyRequiresDuplex(body) ? { duplex: "half" as const } : {}),
			},
		};
	}

	const method = (init?.method ?? input.method).toUpperCase();
	const inputBody = method === "GET" || method === "HEAD" ? undefined : input.body;
	const body = init && hasOwn(init, "body") ? init.body : inputBody;
	const requestInit: UndiciRequestInit = {
		method,
		headers: (init?.headers ?? input.headers) as unknown as UndiciRequestInit["headers"],
		body: body as unknown as UndiciRequestInit["body"],
		signal: init?.signal ?? input.signal,
		redirect: init?.redirect ?? input.redirect,
		credentials: init?.credentials ?? input.credentials,
		integrity: init?.integrity ?? input.integrity,
		keepalive: init?.keepalive ?? input.keepalive,
		mode: init?.mode ?? input.mode,
		referrer: init?.referrer ?? input.referrer,
		referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
		...(requestBodyRequiresDuplex(body) ? { duplex: "half" as const } : {}),
	};
	return { input: input.url, init: requestInit };
}

/** Fetch using real npm undici so direct/NO_PROXY routes never inherit Bun proxy env implicitly. */
export async function outboundFetch(
	input: string | URL | Request,
	init?: RequestInit,
	options: OutboundFetchOptions = {},
): Promise<Response> {
	if (outboundFetchOverride) return outboundFetchOverride(input as RequestInfo | URL, init);
	const tlsRejectUnauthorized = options.tlsRejectUnauthorized !== false;
	const dispatcher = options.proxyUrl
		? proxyDispatcher(options.proxyUrl, tlsRejectUnauthorized)
		: directDispatcher(tlsRejectUnauthorized);
	const request = toUndiciRequest(input, init);
	if (options.verbose) {
		writeVerboseBlock([
			`> ${String(request.init.method ?? "GET").toUpperCase()} ${redactDiagnosticUrl(request.input)}`,
			...redactDiagnosticHeaders(request.init.headers as HeadersInit | undefined).map(
				(header) => `> ${header}`,
			),
		]);
	}
	try {
		const response = await undiciFetch(request.input, { ...request.init, dispatcher });
		if (options.verbose) {
			writeVerboseBlock([
				`< HTTP ${response.status} ${redactDiagnosticText(response.statusText)}`,
				...redactDiagnosticHeaders(response.headers as unknown as Headers).map(
					(header) => `< ${header}`,
				),
			]);
		}
		return response as unknown as Response;
	} catch (error) {
		if (options.verbose) {
			const message = redactDiagnosticText(error instanceof Error ? error.message : String(error));
			const code =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: unknown }).code ?? "")
					: "";
			writeVerboseBlock([`< NETWORK ERROR${code ? ` ${code}` : ""}: ${message}`]);
		}
		throw error;
	}
}

/** Explicit test-only injection; production callers must never set this. */
export function setOutboundFetchOverrideForTest(override: OutboundFetchOverride | null): void {
	outboundFetchOverride = override;
}

/** Create a caller-owned proxy dispatcher. Unsupported protocols fail closed. */
export function createOutboundProxyDispatcher(
	proxyUrl: string,
	tlsRejectUnauthorized = true,
): Dispatcher {
	return createProxyDispatcher(proxyUrl, tlsRejectUnauthorized);
}

/** Backward-compatible HTTP(S)-named factory; now supports all configured proxy protocols. */
export function createHttpProxyDispatcher(proxyUrl: string): Dispatcher {
	return createOutboundProxyDispatcher(proxyUrl);
}

/** Close shared dispatchers; intended for tests and orderly shutdown. */
export async function closeOutboundFetchDispatchers(): Promise<void> {
	const dispatchers = [...directDispatchers.values(), ...proxyDispatchers.values()];
	directDispatchers.clear();
	proxyDispatchers.clear();
	await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.close()));
}
