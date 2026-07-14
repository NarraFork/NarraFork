import {
	redactDiagnosticHeaders,
	redactDiagnosticText,
	redactDiagnosticUrl,
	selectSafeDiagnosticHeaders,
} from "../net/diagnostic-redaction";
import { type OutboundFetchRetryPolicy, outboundFetch } from "../net/outbound-fetch";
import {
	type CapturedErrorDetails,
	isVerboseRequestCaptureEnabled,
	type NetworkErrorCategory,
	recordRequestAttempt,
} from "./request-url-tracker";

const MAX_ERROR_CAUSE_DEPTH = 4;
const MAX_VERBOSE_OUTPUT_CHARS = 64 * 1024;
const NETWORK_ERROR_CATEGORIES = new Set<NetworkErrorCategory>([
	"http",
	"dns",
	"connection_refused",
	"connection_reset",
	"timeout",
	"tls",
	"proxy",
	"aborted",
	"network",
]);
export interface DiagnosticFetchOptions {
	proxy?: string;
	tls?: {
		rejectUnauthorized?: boolean;
	};
	/** Default is idempotent-only; use always only when the request body is safe to replay. */
	retryPolicy?: OutboundFetchRetryPolicy;
}

/** Backward-compatible exports for existing diagnostic callers. */
export const sanitizeDiagnosticUrl = redactDiagnosticUrl;
export const sanitizeDiagnosticText = redactDiagnosticText;

function readScalar(value: Record<string, unknown>, key: string): string | number | undefined {
	const candidate = value[key];
	if (typeof candidate === "string" || typeof candidate === "number") return candidate;
	return undefined;
}

function normalizeTransportCode(code: string | number, message: string): string {
	const normalized = String(code).toUpperCase();
	if (
		normalized === "UND_ERR_SOCKET" &&
		/other side closed|socket hang up|connection reset/i.test(message)
	) {
		return "ECONNRESET";
	}
	if (normalized === "UNSUPPORTEDPROXYPROTOCOL") {
		return "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL";
	}
	return String(code);
}

/** Serialize only a small allow-list of safe transport fields and a bounded cause chain. */
export function serializeDiagnosticError(
	error: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
): CapturedErrorDetails {
	if (depth >= MAX_ERROR_CAUSE_DEPTH) {
		return { message: "[Further error causes omitted]" };
	}

	if (!error || typeof error !== "object") {
		return { message: sanitizeDiagnosticText(String(error)) };
	}
	if (seen.has(error)) {
		return { message: "[Circular error cause]" };
	}
	seen.add(error);

	const value = error as Record<string, unknown>;
	const rawMessage =
		typeof value.message === "string" && value.message
			? value.message
			: error instanceof Error
				? error.message
				: String(error);
	const details: CapturedErrorDetails = {
		name:
			typeof value.name === "string" && value.name
				? value.name
				: error instanceof Error
					? error.name
					: undefined,
		message: sanitizeDiagnosticText(rawMessage),
	};

	const code = readScalar(value, "code");
	const errno = readScalar(value, "errno");
	const syscall = readScalar(value, "syscall");
	const address = readScalar(value, "address");
	const port = readScalar(value, "port");
	const hostname = readScalar(value, "hostname");
	const status = readScalar(value, "status") ?? readScalar(value, "statusCode");
	const reason = readScalar(value, "reason");
	const category = readScalar(value, "category");
	const path = readScalar(value, "path");

	if (
		typeof category === "string" &&
		NETWORK_ERROR_CATEGORIES.has(category as NetworkErrorCategory)
	) {
		details.category = category as NetworkErrorCategory;
	}
	if (code !== undefined) details.code = normalizeTransportCode(code, rawMessage);
	if (errno !== undefined) details.errno = errno;
	if (syscall !== undefined) details.syscall = String(syscall);
	if (address !== undefined) details.address = String(address);
	if (port !== undefined) details.port = port;
	if (hostname !== undefined) details.hostname = String(hostname);
	if (typeof status === "number") details.status = status;
	if (reason !== undefined) details.reason = sanitizeDiagnosticText(String(reason));
	if (path !== undefined) details.path = sanitizeDiagnosticUrl(String(path));

	const nested = value.cause ?? (value.error instanceof Error ? value.error : undefined);
	if (nested !== undefined && nested !== error) {
		details.cause = serializeDiagnosticError(nested, depth + 1, seen);
		if (details.code === undefined && details.cause.code !== undefined) {
			details.code = details.cause.code;
		}
		if (details.category === undefined && details.cause.category !== undefined) {
			details.category = details.cause.category;
		}
	}
	return details;
}

function upperErrorCode(error: CapturedErrorDetails): string {
	return error.code?.trim().toUpperCase() ?? "";
}

export function classifyNetworkError(error: CapturedErrorDetails): NetworkErrorCategory {
	const causeCategory = error.cause ? classifyNetworkError(error.cause) : undefined;
	const code = upperErrorCode(error);
	const message = `${error.message} ${error.reason ?? ""}`.toLowerCase();

	if (error.name === "AbortError" || code === "ABORT_ERR" || message.includes("aborted")) {
		return "aborted";
	}
	if (
		["EAI_AGAIN", "ENOTFOUND", "DNSERROR", "DNSNOTFOUND"].includes(code) ||
		message.includes("dns") ||
		message.includes("name resolution") ||
		message.includes("could not resolve host")
	) {
		return "dns";
	}
	if (
		["ECONNREFUSED", "CONNECTIONREFUSED", "UND_ERR_CONNECT"].includes(code) ||
		message.includes("connection refused") ||
		message.includes("unable to connect")
	) {
		return "connection_refused";
	}
	if (
		["ECONNRESET", "EPIPE", "CONNECTIONRESET", "CONNECTIONABORTED", "UND_ERR_SOCKET"].includes(
			code,
		) ||
		message.includes("socket connection was closed") ||
		message.includes("connection was closed unexpectedly") ||
		message.includes("socket hang up") ||
		message.includes("connection reset") ||
		message.includes("other side closed")
	) {
		return "connection_reset";
	}
	if (
		["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code) ||
		message.includes("timed out") ||
		message.includes("timeout")
	) {
		return "timeout";
	}
	if (
		code.startsWith("CERT_") ||
		code.includes("TLS") ||
		code.includes("SSL") ||
		message.includes("certificate") ||
		message.includes("tls") ||
		message.includes("ssl")
	) {
		return "tls";
	}
	if (message.includes("proxy")) return "proxy";
	return causeCategory && causeCategory !== "network" ? causeCategory : "network";
}

function categoryExplanation(category: NetworkErrorCategory): string {
	switch (category) {
		case "dns":
			return "DNS lookup failed before a connection could be established.";
		case "connection_refused":
			return "The target host or configured proxy refused the TCP connection.";
		case "connection_reset":
			return "The upstream server or an intermediary closed the connection before returning an HTTP response.";
		case "timeout":
			return "The connection or response exceeded the network timeout.";
		case "tls":
			return "The TLS handshake or certificate verification failed.";
		case "proxy":
			return "The configured proxy could not complete the request.";
		case "aborted":
			return "The request was cancelled.";
		default:
			return "The request failed before an HTTP response was received.";
	}
}

function requestBodyBytes(body: BodyInit | null | undefined): number | undefined {
	if (body == null) return undefined;
	if (typeof body === "string") return Buffer.byteLength(body);
	if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
	if (body instanceof Blob) return body.size;
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	return undefined;
}

function isAbortError(error: unknown, signal?: AbortSignal | null): boolean {
	if (signal?.aborted) return true;
	if (!error || typeof error !== "object") return false;
	const value = error as Record<string, unknown>;
	return value.name === "AbortError" || String(value.code ?? "").toUpperCase() === "ABORT_ERR";
}

function writeSafeVerboseBlock(lines: string[]): void {
	const output = lines.join("\n");
	console.error(
		output.length <= MAX_VERBOSE_OUTPUT_CHARS
			? output
			: `${output.slice(0, MAX_VERBOSE_OUTPUT_CHARS)}\n... [verbose output truncated]`,
	);
}

export class NetworkRequestError extends Error {
	readonly category: NetworkErrorCategory;
	readonly code?: string;
	readonly errno?: string | number;
	readonly path?: string;
	readonly hostname?: string;
	readonly address?: string;
	readonly port?: string | number;
	readonly method: string;
	readonly url: string;
	readonly proxyUrl?: string;
	readonly durationMs: number;
	readonly diagnostic: CapturedErrorDetails;

	constructor(options: {
		cause: unknown;
		category: NetworkErrorCategory;
		diagnostic: CapturedErrorDetails;
		method: string;
		url: string;
		proxyUrl?: string;
		durationMs: number;
	}) {
		const transportDiagnostic = options.diagnostic.code
			? options.diagnostic
			: (options.diagnostic.cause ?? options.diagnostic);
		const codeSuffix = transportDiagnostic.code ? `/${transportDiagnostic.code}` : "";
		const route = options.proxyUrl ? `proxy ${options.proxyUrl}` : "direct connection";
		super(
			`Network request failed [${options.category}${codeSuffix}] after ${options.durationMs} ms: ` +
				`${options.method} ${options.url} via ${route}. ${categoryExplanation(options.category)}`,
			{ cause: options.cause },
		);
		this.name = "NetworkRequestError";
		this.category = options.category;
		this.code = transportDiagnostic.code;
		this.errno = transportDiagnostic.errno;
		this.path = transportDiagnostic.path ?? options.diagnostic.path;
		this.hostname = transportDiagnostic.hostname ?? options.diagnostic.hostname;
		this.address = transportDiagnostic.address ?? options.diagnostic.address;
		this.port = transportDiagnostic.port ?? options.diagnostic.port;
		this.method = options.method;
		this.url = options.url;
		this.proxyUrl = options.proxyUrl;
		this.durationMs = options.durationMs;
		this.diagnostic = options.diagnostic;
	}
}

/**
 * Unified outbound fetch wrapper that adds actionable transport errors without
 * enabling raw `verbose: true` (which prints secrets such as Authorization headers).
 */
export async function fetchWithNetworkDiagnostics(
	input: string | URL | Request,
	init?: RequestInit,
	options: DiagnosticFetchOptions = {},
): Promise<Response> {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = sanitizeDiagnosticUrl(rawUrl);
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const proxyUrl = options.proxy ? sanitizeDiagnosticUrl(options.proxy) : undefined;
	const verbose = isVerboseRequestCaptureEnabled();
	const startedAt = performance.now();
	const finishCapture = recordRequestAttempt({
		url,
		method,
		route: proxyUrl ? "proxy" : "direct",
		proxyUrl,
		requestBodyBytes: requestBodyBytes(init?.body),
		verbose,
	});
	// The unified transport uses Bun's native fetch so streaming and AbortSignal
	// stay on Bun's supported path. Raw transport verbose remains disabled because
	// it may print credentials; opted-in traces below are redacted.
	if (verbose) {
		const requestHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		writeSafeVerboseBlock([
			`> ${method} ${url}`,
			...redactDiagnosticHeaders(requestHeaders).map((header) => `> ${header}`),
		]);
	}
	try {
		const response = await outboundFetch(input, init, {
			proxyUrl: options.proxy,
			tlsRejectUnauthorized: options.tls?.rejectUnauthorized,
			retryPolicy: options.retryPolicy ?? "idempotent-only",
		});

		const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
		const responseHeaders = selectSafeDiagnosticHeaders(response.headers);
		finishCapture?.({
			outcome: response.ok ? "success" : "http_error",
			category: response.ok ? undefined : "http",
			durationMs,
			status: response.status,
			statusText: sanitizeDiagnosticText(response.statusText),
			responseHeaders,
		});
		if (verbose) {
			writeSafeVerboseBlock([
				`< HTTP ${response.status} ${sanitizeDiagnosticText(response.statusText)}`,
				...Object.entries(responseHeaders ?? {}).map(([name, value]) => `< ${name}: ${value}`),
			]);
		}
		return response;
	} catch (error) {
		const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
		const diagnostic = serializeDiagnosticError(error);
		const category = classifyNetworkError(diagnostic);
		if (verbose) {
			writeSafeVerboseBlock([
				`< NETWORK ERROR${diagnostic.code ? ` ${diagnostic.code}` : ""}: ${diagnostic.message}`,
			]);
		}
		finishCapture?.({
			outcome: category === "aborted" ? "aborted" : "network_error",
			category,
			durationMs,
			error: diagnostic,
		});
		if (isAbortError(error, init?.signal)) throw error;
		throw new NetworkRequestError({
			cause: error,
			category,
			diagnostic,
			method,
			url,
			proxyUrl,
			durationMs,
		});
	}
}
