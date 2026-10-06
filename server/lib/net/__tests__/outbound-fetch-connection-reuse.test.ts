import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { outboundFetch } from "../outbound-fetch";

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/**
 * A plain HTTP listener that records the raw request head of every connection and
 * answers with a minimal response. Reading the wire directly is the only way to
 * assert what actually reached the peer: asserting on the `Headers` object we
 * passed to `fetch` would not prove the header was absent on the socket.
 */
async function startHeaderRecordingServer(): Promise<{
	url: string;
	heads: () => string[];
	connections: () => number;
}> {
	const heads: string[] = [];
	let connectionCount = 0;
	const server: Server = createServer((socket) => {
		connectionCount++;
		let buffered = "";
		socket.on("data", (chunk) => {
			buffered += chunk.toString("utf8");
			if (!buffered.includes("\r\n\r\n")) return;
			heads.push(buffered.slice(0, buffered.indexOf("\r\n\r\n")));
			socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return {
		url: `http://127.0.0.1:${address.port}/v1/chat`,
		heads: () => heads,
		connections: () => connectionCount,
	};
}

/**
 * A listener that accepts the connection and then never answers, imitating a hop
 * that takes the request but never delivers it. This is the failure the removed
 * `Connection: close` header was meant to guard against, so it pins that the
 * replay path still covers it without that header.
 */
async function startSilentServer(): Promise<{ url: string; connections: () => number }> {
	let connectionCount = 0;
	const server: Server = createServer((socket) => {
		connectionCount++;
		socket.on("error", () => {});
		// Deliberately never writes a response and never closes.
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return {
		url: `http://127.0.0.1:${address.port}/v1/chat`,
		connections: () => connectionCount,
	};
}

describe("outboundFetch connection reuse", () => {
	/**
	 * Regression: forcing `Connection: close` made every outbound request perform a
	 * fresh TCP+TLS handshake. A tool-heavy narrator turn issues one request per tool
	 * round-trip, so each turn repeatedly gambled on landing a healthy path; on
	 * multi-hop gateways that raised the rate of streams going silent mid-turn.
	 */
	test("does not force Connection: close on the wire", async () => {
		const server = await startHeaderRecordingServer();

		const response = await outboundFetch(server.url, { method: "POST", body: "{}" });
		expect(response.status).toBe(200);
		await response.text();

		expect(server.heads()).toHaveLength(1);
		const head = server.heads()[0] ?? "";
		const connectionHeader = head
			.split("\r\n")
			.find((line) => line.toLowerCase().startsWith("connection:"));
		expect(connectionHeader?.toLowerCase()).not.toContain("close");
	});

	/** Caller-supplied headers must still reach the peer untouched. */
	test("preserves caller headers", async () => {
		const server = await startHeaderRecordingServer();

		const response = await outboundFetch(server.url, {
			method: "POST",
			headers: { "x-narrafork-test": "kept" },
			body: "{}",
		});
		await response.text();

		expect(server.heads()[0]?.toLowerCase()).toContain("x-narrafork-test: kept");
	});

	/**
	 * An explicit `Connection: close` from a caller is still honoured — removing the
	 * blanket header must not start overriding callers that genuinely want it.
	 */
	test("honours an explicit Connection: close from the caller", async () => {
		const server = await startHeaderRecordingServer();

		const response = await outboundFetch(server.url, {
			method: "POST",
			headers: { Connection: "close" },
			body: "{}",
		});
		await response.text();

		expect(server.heads()[0]?.toLowerCase()).toContain("connection: close");
	});

	/**
	 * Reusing connections must not turn a dead hop into an indefinite wait. This covers
	 * the caller-deadline path specifically: a supplied AbortSignal still tears the
	 * request down promptly without the removed header. It does not exercise
	 * shouldReplayTransportFailure() — a POST is not replayable under
	 * `idempotent-only`, so silence on this path is surfaced to the caller rather than
	 * retried here. Recovering that turn is the agent loop's job, via the
	 * StreamStaleError classification in error-handling.ts.
	 */
	test("a hop that never answers still fails instead of hanging", async () => {
		const server = await startSilentServer();
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 1_000);

		let failed = false;
		try {
			const response = await outboundFetch(
				server.url,
				{ method: "POST", body: "{}", signal: controller.signal },
				{ retryPolicy: "idempotent-only" },
			);
			await response.text();
		} catch {
			failed = true;
		} finally {
			clearTimeout(abortTimer);
		}

		expect(failed).toBe(true);
		expect(server.connections()).toBeGreaterThan(0);
	});
});
