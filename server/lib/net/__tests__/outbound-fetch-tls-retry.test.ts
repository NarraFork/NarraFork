import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Server } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { generate } from "selfsigned";
import { outboundFetch } from "../outbound-fetch";

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/**
 * A TLS listener that swallows the ClientHello and drops the connection without
 * ever answering. Bun reports this as UNKNOWN_CERTIFICATE_VERIFICATION_ERROR:
 * the handshake was disturbed and no X509 verify code explains why — exactly the
 * shape produced by a relay/VPN/interception box interfering mid-handshake.
 */
async function startHandshakeDroppingServer(): Promise<{
	url: string;
	connections: () => number;
}> {
	let connectionCount = 0;
	const server: Server = createServer((socket) => {
		connectionCount++;
		socket.once("data", () => socket.destroy());
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
		url: `https://127.0.0.1:${address.port}/v1/chat`,
		connections: () => connectionCount,
	};
}

/** A real TLS server whose self-signed chain fails verification deterministically. */
async function startSelfSignedServer(): Promise<{ url: string; connections: () => number }> {
	const generated = await generate([{ name: "commonName", value: "localhost" }], {
		keySize: 2048,
		algorithm: "sha256",
		extensions: [
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "localhost" },
					{ type: 7, ip: "127.0.0.1" },
				],
			},
		],
	});
	let connectionCount = 0;
	const server = Bun.serve({
		port: 0,
		tls: { cert: generated.cert, key: generated.private },
		fetch: () => {
			connectionCount++;
			return new Response("ok");
		},
	});
	closers.push(() => server.stop(true));
	return {
		url: `https://127.0.0.1:${server.port}/v1/chat`,
		connections: () => connectionCount,
	};
}

describe("outbound fetch TLS handshake replay", () => {
	test("replays a disturbed handshake even for a non-idempotent POST", async () => {
		const { url, connections } = await startHandshakeDroppingServer();

		let thrown: unknown;
		try {
			await outboundFetch(
				url,
				{ method: "POST", body: JSON.stringify({ model: "test" }) },
				{ retryPolicy: "idempotent-only" },
			);
		} catch (error) {
			thrown = error;
		}

		// The handshake never delivered a request byte, so the replay cannot
		// duplicate a side effect — POST is replayed despite the idempotent-only policy.
		expect((thrown as { code?: string })?.code).toBe("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR");
		expect(connections()).toBe(2);
	});

	test("does not replay when the caller opted out of retries", async () => {
		const { url, connections } = await startHandshakeDroppingServer();

		await expect(
			outboundFetch(url, { method: "POST", body: "{}" }, { retryPolicy: "never" }),
		).rejects.toThrow();
		expect(connections()).toBe(1);
	});

	test("does not replay a deterministic certificate rejection", async () => {
		const { url } = await startSelfSignedServer();
		const attempts: string[] = [];

		let thrown: unknown;
		try {
			await outboundFetch(
				url,
				{ method: "GET", headers: { "x-attempt": "1" } },
				{ retryPolicy: "always" },
			);
		} catch (error) {
			thrown = error;
			attempts.push(String((error as { code?: string })?.code));
		}

		// A self-signed chain is a configuration fault: retrying only delays the
		// real error, so it must surface on the first attempt.
		expect(attempts).toEqual(["DEPTH_ZERO_SELF_SIGNED_CERT"]);
		expect(thrown).toBeInstanceOf(Error);
	});

	test("succeeds on the replay when the handshake recovers", async () => {
		const generated = await generate([{ name: "commonName", value: "localhost" }], {
			keySize: 2048,
			algorithm: "sha256",
		});
		// The real TLS endpoint that answers once the handshake gets through.
		const tlsServer = createTlsServer(
			{ cert: generated.cert, key: generated.private },
			(socket) => {
				socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
			},
		);
		await new Promise<void>((resolve, reject) => {
			tlsServer.once("error", reject);
			tlsServer.listen(0, "127.0.0.1", resolve);
		});
		const tlsAddress = tlsServer.address();
		if (!tlsAddress || typeof tlsAddress === "string") throw new Error("Expected TCP address");
		closers.push(() => new Promise<void>((resolve) => tlsServer.close(() => resolve())));

		// A relay in front of it that interferes with the first handshake, then
		// forwards bytes untouched — the shape of a NAT/VPN disturbing one attempt.
		let connectionCount = 0;
		const server: Server = createServer((socket) => {
			connectionCount++;
			socket.on("error", () => {});
			if (connectionCount === 1) {
				socket.once("data", () => socket.destroy());
				return;
			}
			const upstream = createConnection({ host: "127.0.0.1", port: tlsAddress.port });
			upstream.on("error", () => socket.destroy());
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP address");
		closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const response = await outboundFetch(
			`https://127.0.0.1:${address.port}/v1/chat`,
			{ method: "POST", body: "{}" },
			{ retryPolicy: "idempotent-only", tlsRejectUnauthorized: false },
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(connectionCount).toBe(2);
	});
});
