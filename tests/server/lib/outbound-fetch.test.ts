import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { GeminiProvider } from "@server/lib/agent/gemini-provider";
import { closeOutboundFetchDispatchers, outboundFetch } from "@server/lib/net/outbound-fetch";

const PROXY_ENV_KEYS = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

const closers: Array<() => void | Promise<void>> = [];
let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
	savedEnv = {} as typeof savedEnv;
	for (const key of PROXY_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(async () => {
	for (const key of PROXY_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const close of closers.splice(0)) await close();
	await closeOutboundFetchDispatchers();
});

function startOrigin(
	fetch: (request: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
	closers.push(() => server.stop(true));
	return server;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return address.port;
}

async function startConnectProxy(): Promise<{ url: string; connectCount: () => number }> {
	let connections = 0;
	const server = createServer((request, response) => {
		connections++;
		const target = new URL(request.url ?? "/");
		const upstream = httpRequest(
			target,
			{ method: request.method, headers: request.headers },
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			},
		);
		request.pipe(upstream);
	});
	server.on("connect", (request, clientSocket, head) => {
		connections++;
		const [hostname, rawPort] = (request.url ?? "").split(":");
		const upstream = connect(Number(rawPort || 80), hostname, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			clientSocket.pipe(upstream);
			upstream.pipe(clientSocket);
		});
		upstream.on("error", () => clientSocket.destroy());
	});
	const port = await listen(server);
	return { url: `http://127.0.0.1:${port}`, connectCount: () => connections };
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

describe("outbound fetch", () => {
	test("direct mode ignores process proxies and avoids connection reuse", async () => {
		process.env.HTTP_PROXY = "socks5://127.0.0.1:1";
		process.env.http_proxy = "socks5://127.0.0.1:1";
		const captured = { connectionHeader: null as string | null };
		const origin = startOrigin((request) => {
			captured.connectionHeader = request.headers.get("connection");
			return new Response("direct-ok");
		});

		const response = await outboundFetch(`http://127.0.0.1:${origin.port}/direct`, {
			headers: { Connection: "keep-alive" },
		});

		expect(await response.text()).toBe("direct-ok");
		expect(captured.connectionHeader).toBe("close");
	});

	test("always retries one replayable pre-response transport reset with a fresh connection", async () => {
		let hits = 0;
		const connectionHeaders: Array<string | undefined> = [];
		const requestBodies: string[] = [];
		const server = createServer((request, response) => {
			const hit = ++hits;
			connectionHeaders.push(request.headers.connection);
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				requestBodies.push(body);
				if (hit === 1) {
					request.socket.destroy();
					return;
				}
				response.end("retry-ok");
			});
		});
		const port = await listen(server);
		const request = new Request(`http://127.0.0.1:${port}/retry`, {
			method: "POST",
			body: "payload",
		});

		const response = await outboundFetch(request, undefined, {
			retryPolicy: "always",
		});

		expect(await response.text()).toBe("retry-ok");
		expect(hits).toBe(2);
		expect(connectionHeaders).toEqual(["close", "close"]);
		expect(requestBodies).toEqual(["payload", "payload"]);
	});

	test("idempotent-only does not replay POST or PATCH after a pre-response reset", async () => {
		let hits = 0;
		const server = createServer((request) => {
			hits++;
			request.socket.destroy();
		});
		const port = await listen(server);

		for (const method of ["POST", "PATCH"]) {
			await expect(
				outboundFetch(
					`http://127.0.0.1:${port}/no-replay`,
					{ method, body: "payload" },
					{ retryPolicy: "idempotent-only" },
				),
			).rejects.toBeDefined();
		}
		expect(hits).toBe(2);
	});

	test("never is the default even for idempotent methods", async () => {
		let hits = 0;
		const server = createServer((request) => {
			hits++;
			request.socket.destroy();
		});
		const port = await listen(server);

		await expect(outboundFetch(`http://127.0.0.1:${port}/default-never`)).rejects.toBeDefined();
		expect(hits).toBe(1);
	});

	test("always does not retry a caller-provided ReadableStream body", async () => {
		let attempts = 0;
		const server = createServer((request) => {
			attempts++;
			request.resume();
			request.on("end", () => request.socket.destroy());
		});
		const port = await listen(server);

		await expect(
			outboundFetch(
				`http://127.0.0.1:${port}/stream-body`,
				{
					method: "POST",
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("payload"));
							controller.close();
						},
					}),
				},
				{ retryPolicy: "always" },
			),
		).rejects.toBeDefined();
		expect(attempts).toBe(1);
	});

	test("does not retry HTTP error responses at the transport layer", async () => {
		let hits = 0;
		const origin = startOrigin(() => {
			hits++;
			return new Response("busy", { status: 503 });
		});

		const response = await outboundFetch(`http://127.0.0.1:${origin.port}/busy`, undefined, {
			retryPolicy: "always",
		});

		expect(response.status).toBe(503);
		expect(hits).toBe(1);
	});

	test("routes HTTP requests through an explicit HTTP proxy", async () => {
		const origin = startOrigin(() => new Response("proxied-ok"));
		const proxy = await startConnectProxy();

		const response = await outboundFetch(`http://127.0.0.1:${origin.port}/proxied`, undefined, {
			proxyUrl: proxy.url,
		});

		expect(await response.text()).toBe("proxied-ok");
		expect(proxy.connectCount()).toBeGreaterThan(0);
	});

	test("rejects SOCKS proxies without contacting the origin", async () => {
		let originHits = 0;
		const origin = startOrigin(() => {
			originHits++;
			return new Response("must-not-run");
		});

		await expect(
			outboundFetch(`http://127.0.0.1:${origin.port}/blocked`, undefined, {
				proxyUrl: "socks5://127.0.0.1:1080",
			}),
		).rejects.toMatchObject({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			protocol: "socks5",
		});
		expect(originHits).toBe(0);
	});

	test("fails closed for unknown proxy protocols without contacting the origin", async () => {
		let originHits = 0;
		const origin = startOrigin(() => {
			originHits++;
			return new Response("must-not-run");
		});

		await expect(
			outboundFetch(`http://127.0.0.1:${origin.port}/blocked`, undefined, {
				proxyUrl: "ftp://user:secret@127.0.0.1:21",
			}),
		).rejects.toMatchObject({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			protocol: "ftp",
		});
		expect(originHits).toBe(0);
	});

	test("preserves streaming responses and clone support", async () => {
		const origin = startOrigin(() => {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: one\n\n"));
					controller.enqueue(new TextEncoder().encode("data: two\n\n"));
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		});

		const response = await outboundFetch(`http://127.0.0.1:${origin.port}/events`);
		const clone = response.clone();
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		let streamed = "";
		if (reader) {
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				streamed += decoder.decode(value, { stream: true });
			}
		}
		expect(streamed).toBe("data: one\n\ndata: two\n\n");
		expect(await clone.text()).toBe(streamed);
	});

	test("streams an ongoing response and aborts a pending body read", async () => {
		const encoder = new TextEncoder();
		const origin = startOrigin(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: first\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const controller = new AbortController();
		const response = await outboundFetch(`http://127.0.0.1:${origin.port}/ongoing`, {
			signal: controller.signal,
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected response body reader");

		try {
			const first = await within(reader.read());
			expect(first.done).toBe(false);
			expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
			controller.abort();
			let thrown: unknown;
			try {
				await within(reader.read());
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({ name: "AbortError" });
		} finally {
			controller.abort();
		}
	});

	test("expands Bun Request inputs without losing body or headers", async () => {
		const origin = startOrigin(async (request) =>
			Response.json({
				method: request.method,
				header: request.headers.get("x-test"),
				body: await request.text(),
			}),
		);
		const request = new Request(`http://127.0.0.1:${origin.port}/request`, {
			method: "POST",
			headers: { "x-test": "preserved" },
			body: "payload",
		});

		const response = await outboundFetch(request);

		expect(await response.json()).toEqual({
			method: "POST",
			header: "preserved",
			body: "payload",
		});
	});

	test("preserves AbortError without retrying", async () => {
		let hits = 0;
		const origin = startOrigin(async () => {
			hits++;
			await new Promise((resolve) => setTimeout(resolve, 500));
			return new Response("late");
		});
		const controller = new AbortController();
		controller.abort();

		await expect(
			outboundFetch(
				`http://127.0.0.1:${origin.port}/abort`,
				{ signal: controller.signal },
				{ retryPolicy: "always" },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(hits).toBe(0);
	});

	test("routes Gemini generation through the unified model transport", async () => {
		const originalFetch = globalThis.fetch;
		const captured = { url: "", connectionHeader: null as string | null };
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			const [input, init] = args;
			captured.url = input instanceof Request ? input.url : String(input);
			captured.connectionHeader = new Headers(init?.headers).get("connection");
			return Response.json({
				candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }],
			});
		}) as typeof fetch;

		try {
			const provider = new GeminiProvider({
				id: "gemini-test",
				name: "Gemini Test",
				prefix: "gemini-test",
				apiKey: "test-key",
				baseUrl: "https://gemini.example.test/v1beta",
				defaultModel: "gemini-test-model",
			});
			const result = await provider.generate("hello", "gemini-test:gemini-test-model");
			expect(result).toBe("gemini-ok");
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(captured.url).toContain(":streamGenerateContent?alt=sse");
		expect(captured.connectionHeader).toBe("close");
	});
});
