/**
 * Preserving the raw response body when a "successful" HTTP response is not JSON.
 *
 * `Response.json()` consumes the body while parsing it, so a parse failure
 * destroys the only copy of what the upstream actually sent — leaving nothing but
 * the JSON parser's wording (e.g. `Failed to parse JSON`). That is the least
 * useful sentence available: the body is what identifies the sender as a
 * Cloudflare challenge page, an nginx 502, or a corporate proxy login redirect,
 * and it is exactly what gets thrown away.
 *
 * These cases arrive as HTTP 2xx, so the `!response.ok` branches that already
 * retain an error body never run. Read the text first, parse second, and attach a
 * bounded, redacted excerpt to the thrown error.
 */

import { redactDiagnosticText, redactDiagnosticUrl } from "../net/diagnostic-redaction";
import { readWithTimeout, StreamByteBudget } from "../stream-timeout";
import { ApiError } from "./types";

/**
 * Hard read ceiling for a body we intend to JSON.parse. Error pages are small;
 * anything past this is a stream we should not be buffering on the main thread.
 */
export const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Excerpt length carried in error messages and diagnostics. */
export const MAX_BODY_PREVIEW_CHARS = 4000;

/** Bytes rendered as a human-readable size for the error message. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Redact credentials, then bound the length. Redaction runs first so a secret
 * cannot survive by sitting just past the cut. */
function buildBodyPreview(bodyText: string): { preview: string; truncated: boolean } {
	const redacted = redactDiagnosticText(bodyText);
	if (redacted.length <= MAX_BODY_PREVIEW_CHARS) {
		return { preview: redacted, truncated: false };
	}
	return { preview: redacted.slice(0, MAX_BODY_PREVIEW_CHARS), truncated: true };
}

export interface NonJsonResponseInit {
	/** Label naming the upstream, e.g. "Anthropic API". */
	label: string;
	/** HTTP status of the response that carried the non-JSON body. */
	status: number;
	/** Raw (unredacted) body text; redaction happens here. */
	bodyText: string;
	/**
	 * URL the body actually came from. Taken from `Response.url`, so it is the
	 * final URL after redirects — which is the point: a captive portal or SSO
	 * gateway answers by redirecting elsewhere, and the URL we requested would not
	 * show that. Redacted here.
	 */
	url?: string;
	contentType?: string;
	/** Parser message, kept for the rare case where the body itself looks fine. */
	parseError?: string;
	/** Set when the read stopped at a byte ceiling rather than end-of-body. */
	readTruncated?: boolean;
}

/**
 * An upstream returned a non-error HTTP status with a body that is not the JSON
 * we require. Status is reported as 502 so the existing 5xx retry heuristics
 * treat it as the transient gateway failure it usually is; `httpStatus` keeps
 * what the upstream actually said.
 */
export class NonJsonResponseError extends ApiError {
	readonly label: string;
	readonly httpStatus: number;
	/** Redacted final URL the body came from (post-redirect), when known. */
	readonly url?: string;
	readonly contentType?: string;
	/** Redacted, length-bounded excerpt of the response body. */
	readonly bodyPreview: string;
	/** Byte length of the body text we read. */
	readonly bodyBytes: number;
	/** True when `bodyPreview` is shorter than the body we read. */
	readonly bodyTruncated: boolean;
	readonly parseError?: string;

	constructor(init: NonJsonResponseInit) {
		const bodyBytes = Buffer.byteLength(init.bodyText, "utf8");
		const { preview, truncated } = buildBodyPreview(init.bodyText);
		const url = init.url ? redactDiagnosticUrl(init.url) : undefined;
		const descriptors = [
			`HTTP ${init.status}`,
			url ? `from ${url}` : undefined,
			init.contentType ? `content-type ${init.contentType}` : undefined,
			formatBytes(bodyBytes),
		].filter((value): value is string => value !== undefined);
		// The preview is inlined into the message so it survives callers that only
		// log `error.message` — the structured fields below are the richer path.
		const body = preview.length > 0 ? preview : "(empty body)";
		super(
			502,
			`${init.label} returned a non-JSON body (${descriptors.join(", ")}): ${body}` +
				`${truncated || init.readTruncated ? " [...truncated]" : ""}`,
		);
		this.name = "NonJsonResponseError";
		this.label = init.label;
		this.httpStatus = init.status;
		this.url = url;
		this.contentType = init.contentType;
		this.bodyPreview = preview;
		this.bodyBytes = bodyBytes;
		this.bodyTruncated = truncated || init.readTruncated === true;
		this.parseError = init.parseError;
	}
}

/**
 * Read a response body as text with a hard byte ceiling, cancelling the stream
 * rather than buffering an unbounded payload on the main thread.
 */
export async function readResponseTextWithLimit(
	response: Response,
	maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const budget = new StreamByteBudget(maxBytes, "Response body");
	let output = "";
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			budget.add(value.byteLength);
			output += decoder.decode(value, { stream: true });
		}
		return output + decoder.decode();
	} catch (error) {
		await reader
			.cancel(error instanceof Error ? error.message : "Response body limit")
			.catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

/** Content-type header, lowercased, with parameters stripped. */
function contentTypeOf(response: Response): string | undefined {
	const raw = response.headers.get("content-type");
	if (!raw) return undefined;
	return raw.split(";")[0]?.trim().toLowerCase() || undefined;
}

/**
 * Parse a JSON response, keeping the raw body when parsing fails.
 *
 * Use this instead of `response.json()` anywhere a relay, proxy, or WAF can sit
 * between us and the upstream: those intermediaries answer 200 with HTML, and
 * `response.json()` would discard the page while reporting only that JSON
 * parsing failed.
 */
export async function parseJsonResponseWithBody<T>(response: Response, label: string): Promise<T> {
	const bodyText = await readResponseTextWithLimit(response);
	return parseJsonTextWithBody<T>(bodyText, {
		label,
		status: response.status,
		// Empty for synthetically constructed responses; omit rather than report "".
		url: response.url || undefined,
		contentType: contentTypeOf(response),
	});
}

/**
 * Same guarantee for callers that already hold the body text (providers that read
 * it under their own byte budget before deciding how to parse it).
 */
export function parseJsonTextWithBody<T>(
	bodyText: string,
	init: {
		label: string;
		status: number;
		url?: string;
		contentType?: string;
		readTruncated?: boolean;
	},
): T {
	try {
		return JSON.parse(bodyText) as T;
	} catch (error) {
		throw new NonJsonResponseError({
			...init,
			bodyText,
			parseError: error instanceof Error ? error.message : String(error),
		});
	}
}
