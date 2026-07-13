import type { Dispatcher } from "undici";
import { ProxyAgent } from "undici/index.js";
import {
	redactDiagnosticHeaders,
	redactDiagnosticText,
	redactDiagnosticUrl,
} from "./diagnostic-redaction";

const MAX_VERBOSE_OUTPUT_CHARS = 64 * 1024;
type OutboundFetchOverride = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let outboundFetchOverride: OutboundFetchOverride | null = null;

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
	const requestHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
	const proxy = options.proxyUrl
		? normalizeProxyUrl(options.proxyUrl, SUPPORTED_PROXY_PROTOCOLS).toString()
		: "";
	const fetchInit: BunFetchInit = {
		...init,
		proxy,
		...(options.tlsRejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
	};
	if (options.verbose) {
		writeVerboseBlock([
			`> ${method} ${redactDiagnosticUrl(rawUrl)}`,
			...redactDiagnosticHeaders(requestHeaders).map((header) => `> ${header}`),
		]);
	}
	try {
		const response = await fetch(input, fetchInit);
		if (options.verbose) {
			writeVerboseBlock([
				`< HTTP ${response.status} ${redactDiagnosticText(response.statusText)}`,
				...redactDiagnosticHeaders(response.headers).map((header) => `< ${header}`),
			]);
		}
		return response;
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
