import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import {
	fetchWithNetworkDiagnostics,
	NetworkRequestError,
	sanitizeDiagnosticText,
	sanitizeDiagnosticUrl,
	serializeDiagnosticError,
} from "../diagnostic-fetch";
import { isConnectionClosedError, isRetryableError } from "../error-handling";
import { createUrlCapture } from "../request-url-tracker";

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function startResetServer(): Promise<{
	server: Server;
	url: string;
	connections: () => number;
}> {
	let connectionCount = 0;
	const server = createServer((socket) => {
		connectionCount++;
		socket.destroy();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return {
		server,
		url: `http://127.0.0.1:${address.port}/v1/responses?token=secret-token`,
		connections: () => connectionCount,
	};
}

async function startMidstreamResetServer(): Promise<string> {
	const server = createServer((socket) => {
		socket.write(
			"HTTP/1.1 200 OK\r\n" +
				"Content-Type: text/event-stream\r\n" +
				"Transfer-Encoding: chunked\r\n" +
				"Connection: keep-alive\r\n\r\n",
		);
		const body = "data: first\n\n";
		socket.write(`${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`);
		setTimeout(() => socket.destroy(), 50);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return `http://127.0.0.1:${address.port}/stream`;
}

async function within<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe("diagnostic fetch", () => {
	test("redacts credentials and sensitive query values", () => {
		const url = sanitizeDiagnosticUrl(
			"https://user:password@example.com/v1/responses?token=secret&api-version=2025-01-01#fragment-secret",
		);
		expect(url).not.toContain("user");
		expect(url).not.toContain("password");
		expect(url).not.toContain("secret");
		expect(url).toContain("api-version=2025-01-01");

		const message = sanitizeDiagnosticText(
			"Authorization: Bearer top-secret https://example.com/path?api_key=hidden",
		);
		expect(message).not.toContain("top-secret");
		expect(message).not.toContain("hidden");
		expect(message).toContain("Authorization: ********");
	});

	test("wraps unsupported proxy protocols without leaking proxy credentials", async () => {
		let thrown: unknown;
		try {
			await fetchWithNetworkDiagnostics("https://nug.example.com/v1/responses", undefined, {
				proxy: "ftp://user:secret-password@127.0.0.1:21",
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NetworkRequestError);
		const networkError = thrown as NetworkRequestError;
		expect(networkError.category).toBe("proxy");
		expect(networkError.code).toBe("UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL");
		expect(networkError.message).not.toContain("secret-password");
		expect(networkError.diagnostic.message).toContain("ftp");
	});

	test("enables redacted verbose output only inside the opted-in async capture", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response("ok", {
					headers: {
						"x-request-id": "verbose-test",
						"x-internal-secret": "response-secret",
					},
				}),
		});
		closers.push(() => server.stop(true));
		const verboseCapture = createUrlCapture({ verbose: true });
		const quietCapture = createUrlCapture();
		const originalConsoleError = console.error;
		const output: string[] = [];
		console.error = (...args: unknown[]) => output.push(args.map(String).join(" "));
		try {
			await Promise.all([
				verboseCapture.run(async () => {
					await Promise.resolve();
					await fetchWithNetworkDiagnostics(
						`http://127.0.0.1:${server.port}/verbose?api-version=2025-01-01&token=query-secret#hash-secret`,
						{
							headers: {
								Authorization: "Bearer visible-admin-secret",
								"x-custom-key": "request-secret",
							},
						},
					);
				}),
				quietCapture.run(async () => {
					await Promise.resolve();
					await fetchWithNetworkDiagnostics(`http://127.0.0.1:${server.port}/quiet`);
				}),
			]);
		} finally {
			console.error = originalConsoleError;
		}

		const verboseOutput = output.join("\n");
		expect(verboseOutput).toContain("/verbose");
		expect(verboseOutput).not.toContain("visible-admin-secret");
		expect(verboseOutput).not.toContain("request-secret");
		expect(verboseOutput).not.toContain("response-secret");
		expect(verboseOutput).not.toContain("query-secret");
		expect(verboseOutput).not.toContain("hash-secret");
		expect(verboseOutput).toContain("authorization: ********");
		expect(verboseOutput).toContain("x-request-id: verbose-test");
		expect(verboseOutput).not.toContain("/quiet");
		expect(verboseCapture.requests[0]?.verbose).toBe(true);
		expect(quietCapture.requests[0]?.verbose).toBe(false);
	});

	test("does not replay POST at the transport layer and exposes a transient error", async () => {
		const { url, connections } = await startResetServer();
		const capture = createUrlCapture();
		let thrown: unknown;

		try {
			await capture.run(() =>
				fetchWithNetworkDiagnostics(url, {
					method: "POST",
					headers: { Authorization: "Bearer must-not-leak" },
					body: JSON.stringify({ model: "test" }),
				}),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NetworkRequestError);
		const networkError = thrown as NetworkRequestError;
		expect(networkError.category).toBe("connection_reset");
		expect(networkError.code).toBeDefined();
		expect(["ECONNRESET", "UND_ERR_SOCKET"]).toContain(networkError.code as string);
		expect(networkError.message).toContain("POST http://127.0.0.1:");
		expect(networkError.message).toContain("direct connection");
		expect(networkError.message).not.toContain("must-not-leak");
		expect(networkError.message).not.toContain("secret-token");
		expect(networkError.message).not.toContain("verbose: true");
		expect(isConnectionClosedError(networkError)).toBe(true);
		expect(isRetryableError(networkError)).toBe(true);
		expect(serializeDiagnosticError(networkError)).toMatchObject({
			category: "connection_reset",
			code: networkError.code,
		});
		expect(connections()).toBe(1);

		expect(capture.requests).toHaveLength(1);
		expect(capture.requests[0]).toMatchObject({
			sequence: 1,
			method: "POST",
			route: "direct",
			outcome: "network_error",
			category: "connection_reset",
		});
		expect(capture.requests[0]?.url).not.toContain("secret-token");
		const capturedCode =
			capture.requests[0]?.error?.code ?? capture.requests[0]?.error?.cause?.code;
		expect(capturedCode).toBeDefined();
		expect(["ECONNRESET", "UND_ERR_SOCKET"]).toContain(capturedCode as string);
		expect(capture.requests[0]?.error?.message).not.toContain("verbose: true");
		expect(capture.requests[0]?.requestBodyBytes).toBeGreaterThan(0);
		expect(capture.requests[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("retries one pre-response connection error for an idempotent GET", async () => {
		const { url, connections } = await startResetServer();

		await expect(
			fetchWithNetworkDiagnostics(url, undefined, { retryPolicy: "idempotent-only" }),
		).rejects.toBeInstanceOf(NetworkRequestError);
		expect(connections()).toBe(2);
	});

	test("captures HTTP status and selected response headers", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify({ error: "busy" }), {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "3",
						"x-request-id": "request-123",
						"set-cookie": "must-not-be-captured=1",
					},
				}),
		});
		closers.push(() => server.stop(true));
		const capture = createUrlCapture();
		const response = await capture.run(() =>
			fetchWithNetworkDiagnostics(`http://127.0.0.1:${server.port}/v1/responses`, {
				method: "POST",
				body: "{}",
			}),
		);

		expect(response.status).toBe(429);
		expect(capture.requests[0]).toMatchObject({
			sequence: 1,
			outcome: "http_error",
			category: "http",
			status: 429,
			responseHeaders: {
				"content-type": "application/json",
				"retry-after": "3",
				"x-request-id": "request-123",
			},
		});
		expect(capture.requests[0]?.responseHeaders).not.toHaveProperty("set-cookie");
	});

	test("streams response chunks and aborts a pending body read", async () => {
		const encoder = new TextEncoder();
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: first\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		closers.push(() => server.stop(true));
		const abortController = new AbortController();
		const response = await fetchWithNetworkDiagnostics(`http://127.0.0.1:${server.port}/stream`, {
			signal: abortController.signal,
		});
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) throw new Error("Expected response body reader");

		try {
			const first = await within(reader.read());
			expect(first.done).toBe(false);
			expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
			abortController.abort();
			let thrown: unknown;
			try {
				await within(reader.read());
			} catch (error) {
				thrown = error;
			}
			expect(serializeDiagnosticError(thrown).name).toBe("AbortError");
		} finally {
			abortController.abort();
		}
	});

	test("exposes ECONNRESET when a response stream socket closes mid-flight", async () => {
		const url = await startMidstreamResetServer();
		const response = await fetchWithNetworkDiagnostics(url);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected response body reader");
		const first = await within(reader.read());
		expect(first.done).toBe(false);
		expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");

		let thrown: unknown;
		try {
			await within(reader.read());
		} catch (error) {
			thrown = error;
		}
		expect(serializeDiagnosticError(thrown)).toMatchObject({
			code: "ECONNRESET",
		});
		expect(isConnectionClosedError(thrown)).toBe(true);
	});

	test("preserves abort errors instead of converting them into retryable network errors", async () => {
		const controller = new AbortController();
		controller.abort();
		const capture = createUrlCapture();
		let thrown: unknown;
		try {
			await capture.run(() =>
				fetchWithNetworkDiagnostics("http://127.0.0.1:1/", { signal: controller.signal }),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).not.toBeInstanceOf(NetworkRequestError);
		expect(serializeDiagnosticError(thrown).name).toBe("AbortError");
		expect(capture.requests[0]).toMatchObject({ outcome: "aborted", category: "aborted" });
	});
});
