import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
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
	test("direct mode ignores process HTTP proxy variables", async () => {
		process.env.HTTP_PROXY = "socks5://127.0.0.1:1";
		process.env.http_proxy = "socks5://127.0.0.1:1";
		const origin = startOrigin(() => new Response("direct-ok"));

		const response = await outboundFetch(`http://127.0.0.1:${origin.port}/direct`);

		expect(await response.text()).toBe("direct-ok");
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

	test("preserves AbortError", async () => {
		const origin = startOrigin(async () => {
			await new Promise((resolve) => setTimeout(resolve, 500));
			return new Response("late");
		});
		const controller = new AbortController();
		controller.abort();

		await expect(
			outboundFetch(`http://127.0.0.1:${origin.port}/abort`, {
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
