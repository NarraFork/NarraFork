import { afterEach, describe, expect, test } from "bun:test";
import type { AnthropicProviderConfig } from "../../settings";
import { StreamSizeLimitError } from "../../stream-timeout";
import { AnthropicProvider } from "../anthropic-provider";
import { serializeDiagnosticError } from "../diagnostic-fetch";
import {
	MAX_BODY_PREVIEW_CHARS,
	NonJsonResponseError,
	parseJsonResponseWithBody,
	parseJsonTextWithBody,
	readResponseTextWithLimit,
} from "../response-body";

const HTML_ERROR_PAGE =
	"<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title></head>" +
	"<body><h1>502 Bad Gateway</h1><hr><center>nginx/1.24.0</center></body></html>";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

function htmlResponse(body = HTML_ERROR_PAGE, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

describe("non-JSON response bodies", () => {
	test("reports the post-redirect URL the body actually came from", async () => {
		// A captive portal / SSO gateway answers by redirecting elsewhere, so the URL
		// we requested would not show where the HTML came from.
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/sso/login") {
					return new Response("<html><body>Corporate sign-in required</body></html>", {
						headers: { "content-type": "text/html" },
					});
				}
				return new Response(null, { status: 302, headers: { location: "/sso/login" } });
			},
		});
		try {
			const response = await fetch(`http://localhost:${server.port}/v1/messages?beta=true`);
			let thrown: unknown;
			try {
				await parseJsonResponseWithBody(response, "Anthropic API");
			} catch (error) {
				thrown = error;
			}

			const error = thrown as NonJsonResponseError;
			expect(error.url).toContain("/sso/login");
			expect(error.bodyPreview).toContain("Corporate sign-in required");
			expect(error.message).toContain("/sso/login");
			expect(serializeDiagnosticError(error).responseUrl).toContain("/sso/login");
		} finally {
			await server.stop(true);
		}
	});

	test("redacts credentials carried in the reported URL", () => {
		const error = new NonJsonResponseError({
			label: "Anthropic API",
			status: 200,
			bodyText: "<html>nope</html>",
			url: "https://relay.example.com/v1/messages?token=url-secret-value",
		});
		expect(error.url).not.toContain("url-secret-value");
		expect(error.message).not.toContain("url-secret-value");
		expect(error.url).toContain("relay.example.com");
	});

	test("keeps the HTML body when a 200 response is not JSON", async () => {
		let thrown: unknown;
		try {
			await parseJsonResponseWithBody(htmlResponse(), "Anthropic API");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NonJsonResponseError);
		const error = thrown as NonJsonResponseError;
		expect(error.bodyPreview).toContain("502 Bad Gateway");
		expect(error.bodyPreview).toContain("nginx/1.24.0");
		expect(error.contentType).toBe("text/html");
		// The upstream status is preserved separately from the retry-facing status.
		expect(error.httpStatus).toBe(200);
		expect(error.status).toBe(502);
		expect(error.bodyTruncated).toBe(false);
		expect(error.bodyBytes).toBe(Buffer.byteLength(HTML_ERROR_PAGE, "utf8"));
		// A caller that only logs `message` still sees the page.
		expect(error.message).toContain("502 Bad Gateway");
		expect(error.message).toContain("content-type text/html");
		expect(error.message).toContain("HTTP 200");
	});

	test("bounds the preview and flags truncation for a huge body", async () => {
		const huge = `<html>${"x".repeat(MAX_BODY_PREVIEW_CHARS * 3)}</html>`;
		let thrown: unknown;
		try {
			await parseJsonResponseWithBody(htmlResponse(huge), "Anthropic API");
		} catch (error) {
			thrown = error;
		}

		const error = thrown as NonJsonResponseError;
		expect(error.bodyTruncated).toBe(true);
		expect(error.bodyPreview.length).toBeLessThanOrEqual(MAX_BODY_PREVIEW_CHARS);
		expect(error.message).toContain("[...truncated]");
		// Message length stays bounded so logs and DB rows cannot be blown up by it.
		expect(error.message.length).toBeLessThan(MAX_BODY_PREVIEW_CHARS + 500);
		// The reported byte count still reflects the full body that was read.
		expect(error.bodyBytes).toBeGreaterThan(MAX_BODY_PREVIEW_CHARS);
	});

	test("redacts credentials echoed back inside the body", async () => {
		const leaky =
			"<html><body>Request rejected. Authorization: Bearer sk-super-secret-value " +
			"api_key=another-secret-value</body></html>";
		let thrown: unknown;
		try {
			await parseJsonResponseWithBody(htmlResponse(leaky), "Anthropic API");
		} catch (error) {
			thrown = error;
		}

		const error = thrown as NonJsonResponseError;
		expect(error.bodyPreview).not.toContain("sk-super-secret-value");
		expect(error.bodyPreview).not.toContain("another-secret-value");
		expect(error.bodyPreview).toContain("Request rejected");
		expect(error.message).not.toContain("sk-super-secret-value");
	});

	test("aborts reading a body past the hard byte ceiling", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, { headers: { "content-type": "text/html" } });

		let thrown: unknown;
		try {
			await readResponseTextWithLimit(response, 4096);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(StreamSizeLimitError);
		expect(cancelled).toBe(true);
	});

	test("valid JSON still parses through the same path", async () => {
		const response = new Response(JSON.stringify({ ok: true, items: [1, 2] }), {
			headers: { "content-type": "application/json" },
		});
		const parsed = await parseJsonResponseWithBody<{ ok: boolean; items: number[] }>(
			response,
			"Anthropic API",
		);
		expect(parsed.ok).toBe(true);
		expect(parsed.items).toEqual([1, 2]);
	});

	test("serializeDiagnosticError surfaces the body for the diagnostics panel", () => {
		const error = parseAndCatch(HTML_ERROR_PAGE);
		const details = serializeDiagnosticError(error);

		expect(details.bodyPreview).toContain("502 Bad Gateway");
		expect(details.contentType).toBe("text/html");
		expect(details.bodyTruncated).toBe(false);
		// The upstream status, not the synthetic retry status, is what gets shown.
		expect(details.status).toBe(200);
	});

	test("Anthropic generate surfaces an HTML relay page end to end", async () => {
		globalThis.fetch = (async () => htmlResponse()) as unknown as typeof fetch;
		const config: AnthropicProviderConfig = {
			id: "non-json-test",
			name: "Non-JSON test",
			prefix: "nonjson",
			apiKey: "sk-test",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "claude-opus-5",
			officialApi: false,
		};
		const provider = new AnthropicProvider(config);

		let thrown: unknown;
		try {
			await provider.generateWithMeta("hello", "claude-opus-5");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NonJsonResponseError);
		const error = thrown as NonJsonResponseError;
		expect(error.label).toBe("Anthropic API");
		expect(error.bodyPreview).toContain("502 Bad Gateway");
	});
});

function parseAndCatch(bodyText: string): NonJsonResponseError {
	try {
		parseJsonTextWithBody(bodyText, {
			label: "Anthropic API",
			status: 200,
			contentType: "text/html",
		});
	} catch (error) {
		return error as NonJsonResponseError;
	}
	throw new Error("Expected parseJsonTextWithBody to throw");
}
