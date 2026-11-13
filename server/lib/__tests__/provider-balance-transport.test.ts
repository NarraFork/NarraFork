import { describe, expect, test } from "bun:test";
import type { outboundFetch } from "../net/outbound-fetch";
import { probeProviderBalance } from "../provider-balance-adapters";
import {
	BALANCE_MAX_RESPONSE_BYTES,
	balanceRequestHeaders,
	createBalanceRequest,
} from "../provider-balance-transport";
import type { CustomApiProviderConfig } from "../settings";

const config: CustomApiProviderConfig = {
	id: "balance-transport-test",
	name: "Relay",
	prefix: "relay",
	baseUrl: "https://balance-transport.invalid/deployment/v1",
	apiKey: "private-api-key",
	defaultModel: "test-model",
	protocol: "completions-compatible",
	proxy: { mode: "direct" },
};
const endpoint = "https://balance-transport.invalid/deployment/v1/usage";
type Fetch = typeof outboundFetch;
const encoder = new TextEncoder();
const jsonResponse = (value: unknown = { test: true }) =>
	new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const requestWith = (fetch: Fetch, options: { requestTimeoutMs?: number } = {}) =>
	createBalanceRequest(config, new AbortController().signal, { fetch, ...options });

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function chunkedResponse(chunks: Uint8Array[], headers: HeadersInit = {}) {
	let cancelled = false;
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[pulls++];
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(stream, { headers: { "content-type": "application/json", ...headers } }),
		get cancelled() {
			return cancelled;
		},
		get pulls() {
			return pulls;
		},
	};
}

describe("balance request headers and transport policy", () => {
	test("uses GET, rejects redirects, honors proxy/TLS, and disables transport retries", async () => {
		let captured: Parameters<Fetch> | undefined;
		const request = createBalanceRequest(
			{
				...config,
				proxy: { mode: "custom", url: "http://proxy.invalid:8888" },
				tlsRejectUnauthorized: false,
			},
			new AbortController().signal,
			{
				fetch: async (...args) => {
					captured = args;
					return jsonResponse();
				},
			},
		);
		expect(await request(endpoint)).toEqual({ test: true });
		expect(captured?.[0]).toBe(endpoint);
		expect(captured?.[1]?.method).toBe("GET");
		expect(captured?.[1]?.redirect).toBe("error");
		expect(captured?.[1]?.signal).toBeInstanceOf(AbortSignal);
		expect(captured?.[2]).toEqual({
			proxyUrl: "http://proxy.invalid:8888",
			tlsRejectUnauthorized: false,
			retryPolicy: "never",
		});
	});

	test("authenticated is true by default; custom headers replace case-insensitively", async () => {
		let headers = new Headers();
		const request = createBalanceRequest(
			{
				...config,
				extraHeaders: {
					authorization: "Bearer custom-secret",
					"USER-AGENT": "custom-agent",
					"X-API-Key": "custom-key",
					accept: "text/html",
				},
			},
			new AbortController().signal,
			{
				fetch: async (_url, init) => {
					headers = new Headers(init?.headers);
					return jsonResponse();
				},
			},
		);
		await request(endpoint);
		expect(headers.get("authorization")).toBe("Bearer custom-secret");
		expect(headers.get("user-agent")).toBe("custom-agent");
		expect(headers.get("x-api-key")).toBe("custom-key");
		expect(headers.get("accept")).toBe("application/json");
		expect([...headers.keys()].filter((name) => name === "authorization")).toHaveLength(1);
	});

	test("standard bearer is present without custom overrides", () => {
		expect(balanceRequestHeaders(config, "provider-key").get("authorization")).toBe(
			"Bearer private-api-key",
		);
	});

	test("metadata drops every custom header and credential, not just Authorization", async () => {
		let headers = new Headers();
		const request = createBalanceRequest(
			{
				...config,
				extraHeaders: {
					Authorization: "custom-secret",
					"X-API-Key": "another-secret",
					Cookie: "session=secret",
					"Anthropic-Api-Key": "secret",
					"X-Any-Header": "could-be-a-credential",
					"User-Agent": "sensitive-agent",
				},
			},
			new AbortController().signal,
			{
				fetch: async (_url, init) => {
					headers = new Headers(init?.headers);
					return jsonResponse();
				},
			},
		);
		await request("https://balance-transport.invalid/deployment/api/status", "none");
		expect([...headers.entries()]).toEqual([["accept", "application/json"]]);
	});

	test("removes hop-by-hop and framing overrides irrespective of header casing", () => {
		const names = [
			"HOST",
			"Connection",
			"Content-Length",
			"Transfer-Encoding",
			"Proxy-Authorization",
			"Proxy-Connection",
			"Upgrade",
			"Keep-Alive",
			"Trailer",
			"TE",
		];
		const headers = balanceRequestHeaders(
			{
				...config,
				extraHeaders: {
					...Object.fromEntries(names.map((name) => [name, "private-value"])),
					"X-End-To-End": "preserved",
				},
			},
			"provider-key",
		);
		for (const name of names) expect(headers.has(name)).toBe(false);
		expect(headers.get("X-End-To-End")).toBe("preserved");
	});

	test.each([
		"X-Hop-One, x-hop-two",
		", X-Hop-One, x-hop-two, ,",
	])("also removes custom headers nominated by Connection %#", (connection) => {
		const headers = balanceRequestHeaders(
			{
				...config,
				extraHeaders: {
					Connection: connection,
					"X-Hop-One": "hop-1",
					"X-HOP-TWO": "hop-2",
					"X-End-To-End": "preserved",
				},
			},
			"provider-key",
		);
		expect(headers.has("connection")).toBe(false);
		expect(headers.has("x-hop-one")).toBe(false);
		expect(headers.has("x-hop-two")).toBe(false);
		expect(headers.get("x-end-to-end")).toBe("preserved");
	});
});

describe("same-origin validation", () => {
	test.each([
		"https://other.invalid/v1/usage",
		"http://balance-transport.invalid/v1/usage",
		"https://balance-transport.invalid:444/v1/usage",
		"https://balance-transport.invalid.evil.invalid/v1/usage",
		"https://user:password@balance-transport.invalid/v1/usage",
		"https://balance-transport.invalid/v1/usage?api_key=secret",
		"https://balance-transport.invalid/v1/usage#fragment",
		`https://balance-transport.invalid/${"x".repeat(4096)}`,
	])("rejects unsafe target %# before sending any credentials", async (target) => {
		let calls = 0;
		const request = requestWith(async () => {
			calls++;
			return jsonResponse();
		});
		await expect(request(target)).rejects.toMatchObject({ kind: "unsupported" });
		expect(calls).toBe(0);
	});

	test("retains same-origin deployment path", async () => {
		const calls: unknown[] = [];
		const request = requestWith(async (url) => {
			calls.push(url);
			return jsonResponse();
		});
		await request(endpoint);
		expect(calls).toEqual([endpoint]);
	});
});

describe("response byte caps", () => {
	test("rejects a declared oversized body without consuming its contents", async () => {
		const body = chunkedResponse([encoder.encode('{"small":true}')], {
			"content-length": String(BALANCE_MAX_RESPONSE_BYTES + 1),
		});
		const request = requestWith(async () => body.response);
		await expect(request(endpoint)).rejects.toMatchObject({ kind: "transient" });
		expect(body.cancelled).toBe(true);
		expect(body.response.body?.locked).toBe(false);
	});

	test.each([
		"",
		"1",
	])("enforces cumulative chunk bytes even with missing or dishonest length %#", async (declaredLength) => {
		const body = chunkedResponse(
			[
				new Uint8Array(BALANCE_MAX_RESPONSE_BYTES / 2).fill(32),
				new Uint8Array(BALANCE_MAX_RESPONSE_BYTES / 2).fill(32),
				encoder.encode("0"),
				encoder.encode("must-not-be-fully-buffered"),
			],
			declaredLength ? { "content-length": declaredLength } : {},
		);
		await expect(requestWith(async () => body.response)(endpoint)).rejects.toMatchObject({
			kind: "transient",
		});
		expect(body.cancelled).toBe(true);
		expect(body.response.body?.locked).toBe(false);
		expect(body.pulls).toBeLessThanOrEqual(4);
	});

	test("accepts exactly the byte cap", async () => {
		const text = `"${"x".repeat(BALANCE_MAX_RESPONSE_BYTES - 2)}"`;
		const bytes = encoder.encode(text);
		expect(bytes.byteLength).toBe(BALANCE_MAX_RESPONSE_BYTES);
		const body = chunkedResponse([bytes]);
		expect(await requestWith(async () => body.response)(endpoint)).toBe(
			"x".repeat(BALANCE_MAX_RESPONSE_BYTES - 2),
		);
	});

	test("counts UTF-8 bytes rather than JS character length", async () => {
		const text = `"${"你".repeat(24_000)}"`;
		expect(text.length).toBeLessThan(BALANCE_MAX_RESPONSE_BYTES);
		const body = chunkedResponse([encoder.encode(text)]);
		await expect(requestWith(async () => body.response)(endpoint)).rejects.toMatchObject({
			kind: "transient",
		});
	});
});

describe("timeouts and cancellation cannot be held by abort-ignoring I/O", () => {
	test("bounds an indefinitely hanging fetch and aborts its signal", async () => {
		let signal: AbortSignal | null | undefined;
		const request = requestWith(
			async (_url, init) => {
				signal = init?.signal;
				return new Promise<Response>(() => {});
			},
			{ requestTimeoutMs: 5 },
		);
		await expect(request(endpoint)).rejects.toMatchObject({ kind: "transient" });
		expect(signal?.aborted).toBe(true);
	});

	test("bounds a hanging body and cancels its reader even if cancel itself never settles", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => {});
			},
			cancel() {
				cancelled = true;
				return new Promise<void>(() => {});
			},
		});
		const response = new Response(stream, { headers: { "content-type": "application/json" } });
		await expect(
			requestWith(async () => response, { requestTimeoutMs: 5 })(endpoint),
		).rejects.toMatchObject({ kind: "transient" });
		expect(cancelled).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	test("external cancellation rejects a hanging fetch promptly and cleans up its late body", async () => {
		const controller = new AbortController();
		const started = deferred<void>();
		const fetched = deferred<Response>();
		const cancelled = deferred<void>();
		const request = createBalanceRequest(config, controller.signal, {
			fetch: async () => {
				started.resolve();
				return fetched.promise;
			},
			requestTimeoutMs: 1_000,
		});
		const pending = request(endpoint);
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "transient" });
		fetched.resolve(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled.resolve();
					},
				}),
			),
		);
		await cancelled.promise;
	});

	test("external cancellation rejects a hanging stream without waiting for pull", async () => {
		const controller = new AbortController();
		const reading = deferred<void>();
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull() {
					reading.resolve();
					return new Promise<void>(() => {});
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
		const request = createBalanceRequest(config, controller.signal, {
			fetch: async () => response,
			requestTimeoutMs: 1_000,
		});
		const pending = request(endpoint);
		await reading.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "transient" });
		expect(cancelled).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	test("a pre-cancelled round does not initiate fetch", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const request = createBalanceRequest(config, controller.signal, {
			fetch: async () => {
				calls++;
				return jsonResponse();
			},
		});
		await expect(request(endpoint)).rejects.toMatchObject({ kind: "transient" });
		expect(calls).toBe(0);
	});

	test("late rejection after abort is consumed and does not leak upstream text", async () => {
		const controller = new AbortController();
		const fetched = deferred<Response>();
		const started = deferred<void>();
		const request = createBalanceRequest(config, controller.signal, {
			fetch: async () => {
				started.resolve();
				return fetched.promise;
			},
		});
		const pending = request(endpoint);
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({
			kind: "transient",
			message: "Balance request failed",
		});
		fetched.reject(new Error("secret body / private-api-key"));
		await Promise.resolve();
	});
});

describe("HTTP and payload classification", () => {
	test.each([
		[401, "transient"],
		[403, "transient"],
		[404, "unsupported"],
		[405, "unsupported"],
		[429, "transient"],
		[500, "transient"],
		[502, "transient"],
		[503, "transient"],
		[302, "transient"],
	] as const)("HTTP %s is %s and its body is cancelled", async (status, kind) => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{
				status,
				headers: { "content-type": "application/json" },
			},
		);
		await expect(requestWith(async () => response)(endpoint)).rejects.toMatchObject({ kind });
		expect(cancelled).toBe(true);
	});

	test.each([
		["text/html", "<html>login required</html>"],
		["application/json", "<html>not really JSON</html>"],
		["application/json", '{"unterminated":'],
		["text/plain", '{"looks":"like JSON"}'],
	])("rejects HTML/non-JSON payload %# as unsupported", async (contentType, body) => {
		const request = requestWith(
			async () =>
				new Response(body, {
					headers: { "content-type": contentType },
				}),
		);
		await expect(request(endpoint)).rejects.toMatchObject({ kind: "unsupported" });
	});

	test("accepts structured JSON content types with charset", async () => {
		expect(
			await requestWith(
				async () =>
					new Response('{"ok":true}', {
						headers: { "content-type": "application/vnd.relay+json; charset=utf-8" },
					}),
			)(endpoint),
		).toEqual({ ok: true });
	});

	test("200 JSON business errors are not protocol success", async () => {
		const request = requestWith(async () =>
			jsonResponse({ success: false, message: "private error" }),
		);
		expect(await probeProviderBalance(config.baseUrl, request)).toBeNull();
	});

	test("empty successful response is unsupported", async () => {
		await expect(
			requestWith(async () => new Response(null, { status: 204 }))(endpoint),
		).rejects.toMatchObject({ kind: "unsupported" });
	});

	test("transport/redirect rejection is a fixed safe transient error", async () => {
		await expect(
			requestWith(async () => {
				throw new TypeError("private redirect target/key");
			})(endpoint),
		).rejects.toMatchObject({
			name: "BalanceProbeRequestError",
			kind: "transient",
			message: "Balance request failed",
		});
	});
});

describe("site-account authentication", () => {
	// The site root is a different host than the inference base URL, as on some relay deployments.
	const siteConfig: CustomApiProviderConfig = {
		...config,
		baseUrl: "https://inference.invalid/v1",
		quotaSiteUrl: "https://site.invalid",
		quotaAccessToken: "site-access-token",
		quotaUserId: "4242",
	};
	const siteEndpoint = "https://site.invalid/api/user/self";
	const siteRequest = (fetch: Fetch) =>
		createBalanceRequest(siteConfig, new AbortController().signal, { fetch });

	test("sends the site token and the New-Api-User header, never the inference key", async () => {
		let headers = new Headers();
		await siteRequest(async (_url, init) => {
			headers = new Headers(init?.headers);
			return jsonResponse({ success: true, data: { quota: 1, used_quota: 0 } });
		})(siteEndpoint, "site-token");
		expect(headers.get("authorization")).toBe("Bearer site-access-token");
		expect(headers.get("new-api-user")).toBe("4242");
		expect([...headers.values()]).not.toContain("Bearer private-api-key");
	});

	test("allows the separately configured site origin and nothing else", async () => {
		let seen = "";
		const request = siteRequest(async (url) => {
			seen = String(url);
			return jsonResponse();
		});
		await request(siteEndpoint, "site-token");
		expect(seen).toBe(siteEndpoint);
		await expect(
			request("https://other.invalid/api/user/self", "site-token"),
		).rejects.toMatchObject({ kind: "unsupported" });
	});

	test("keeps rejecting an arbitrary origin when no site root is configured", async () => {
		await expect(
			requestWith(async () => jsonResponse())("https://other.invalid/api/user/self"),
		).rejects.toMatchObject({ kind: "unsupported" });
	});

	test.each([401, 403])("HTTP %s is a deterministic auth failure", async (status) => {
		await expect(
			siteRequest(async () => new Response(null, { status }))(siteEndpoint, "site-token"),
		).rejects.toMatchObject({ kind: "auth" });
	});

	test.each([429, 500, 503])("HTTP %s is transient for the site endpoint", async (status) => {
		await expect(
			siteRequest(async () => new Response(null, { status }))(siteEndpoint, "site-token"),
		).rejects.toMatchObject({ kind: "transient" });
	});

	test.each([400, 404, 422])("HTTP %s is a deterministic invalid answer", async (status) => {
		await expect(
			siteRequest(async () => new Response(null, { status }))(siteEndpoint, "site-token"),
		).rejects.toMatchObject({ kind: "invalid_response" });
	});

	test("a non-JSON 200 is a deterministic invalid answer for the site endpoint", async () => {
		await expect(
			siteRequest(
				async () =>
					new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }),
			)(siteEndpoint, "site-token"),
		).rejects.toMatchObject({ kind: "invalid_response" });
		const json = siteRequest(
			async () => new Response("{not json", { headers: { "content-type": "application/json" } }),
		);
		await expect(json(siteEndpoint, "site-token")).rejects.toMatchObject({
			kind: "invalid_response",
		});
	});
});
