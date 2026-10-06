import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	getObservedRestartHandoff,
	HANDOFF_MARKER_NONCE_ENV,
	HANDOFF_MARKER_PATH_ENV,
	HANDOFF_TOKEN_ENV,
	HANDOFF_URL_ENV,
	postHandoffRequest,
	setObservedRestartHandoffForTests,
	waitForPreviousServerShutdown,
} from "../restart-handoff";

const HANDOFF_ENV_KEYS = [
	HANDOFF_URL_ENV,
	HANDOFF_TOKEN_ENV,
	HANDOFF_MARKER_PATH_ENV,
	HANDOFF_MARKER_NONCE_ENV,
] as const;

type Cleanup = () => void;
const cleanups: Cleanup[] = [];

function snapshotEnv(keys: readonly string[]): Cleanup {
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

function tempMarkerDir(): string {
	const dir = mkdtempSync(resolve(tmpdir(), "nf-handoff-test-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeMarker(path: string, nonce: string): void {
	writeFileSync(path, JSON.stringify({ nonce, pid: 4242, reason: "replacement_started" }));
}

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("postHandoffRequest", () => {
	// Proxy env vars are deliberately set only inside a child process. Bun snapshots its proxy
	// configuration process-wide on first use, so merely assigning HTTP_PROXY in this process
	// would silently reroute unrelated test files' fetches even after the value is restored.
	test("reaches the target directly even when every proxy env var points elsewhere", async () => {
		let proxySawRequest = false;
		// Stands in for a system proxy: it answers everything with the empty 502 that made the
		// replacement abort startup in the field.
		const proxy = Bun.serve({
			port: 0,
			fetch: () => {
				proxySawRequest = true;
				return new Response("", { status: 502 });
			},
		});
		const origin = Bun.serve({
			port: 0,
			fetch: async (req) => new Response(JSON.stringify({ success: true, seen: await req.json() })),
		});
		cleanups.push(() => {
			proxy.stop(true);
			origin.stop(true);
		});

		const proxyUrl = `http://127.0.0.1:${proxy.port}`;
		const child = Bun.spawn(
			[
				"bun",
				"-e",
				`const { postHandoffRequest } = await import(process.env.HANDOFF_MODULE);
				const result = await postHandoffRequest(
					process.env.HANDOFF_TARGET,
					{ token: "token" },
					{ signal: new AbortController().signal, timeoutMs: 5000 },
				);
				console.log(JSON.stringify(result));`,
			],
			{
				env: {
					...process.env,
					HTTP_PROXY: proxyUrl,
					http_proxy: proxyUrl,
					HTTPS_PROXY: proxyUrl,
					https_proxy: proxyUrl,
					ALL_PROXY: proxyUrl,
					all_proxy: proxyUrl,
					NO_PROXY: "",
					no_proxy: "",
					HANDOFF_MODULE: resolve(import.meta.dir, "../restart-handoff.ts"),
					HANDOFF_TARGET: `http://127.0.0.1:${origin.port}/api/gracefully_shutdown`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = (await new Response(child.stdout).text()).trim();
		const stderr = (await new Response(child.stderr).text()).trim();

		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			status: 200,
			body: JSON.stringify({ success: true, seen: { token: "token" } }),
		});
		expect(proxySawRequest).toBe(false);
	});

	test("reports a connection cut off before headers as an error, not a status", async () => {
		// Mirrors performGracefulShutdown, which closes connections before flushing this response.
		let dying: ReturnType<typeof Bun.serve>;
		dying = Bun.serve({
			port: 0,
			async fetch() {
				dying.stop(true);
				await Bun.sleep(1_000);
				return new Response("late");
			},
		});
		cleanups.push(() => dying.stop(true));

		const controller = new AbortController();
		const attempt = postHandoffRequest(
			`http://127.0.0.1:${dying.port}/api/gracefully_shutdown`,
			{ token: "token" },
			{ signal: controller.signal, timeoutMs: 5_000 },
		);

		await expect(attempt).rejects.toThrow(/closed before response headers/);
	});

	test("completes over https against a self-signed certificate", async () => {
		// The old server may serve TLS with a certificate no store trusts. This request is
		// loopback-only and authenticated by a one-time token, so the handoff deliberately does
		// not verify identity — if that stopped working, an HTTPS instance could never hand off
		// and every update would abort startup instead.
		const { generate } = await import("selfsigned");
		const { createServer: createTlsServer } = await import("node:tls");
		const generated = await generate([{ name: "commonName", value: "localhost" }], {
			keySize: 2048,
			algorithm: "sha256",
		});

		let seenBody = "";
		const server = createTlsServer({ cert: generated.cert, key: generated.private }, (socket) => {
			socket.on("data", (chunk: Buffer) => {
				seenBody += chunk.toString("utf8");
				// Answer once the request body has arrived (it follows the blank line).
				if (!seenBody.includes("\r\n\r\n")) return;
				socket.end(
					'HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{"success":true}',
				);
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
		const port = (server.address() as { port: number }).port;
		cleanups.push(() => server.close());

		const controller = new AbortController();
		const result = await postHandoffRequest(
			`https://127.0.0.1:${port}/api/gracefully_shutdown`,
			{ token: "token", pid: 1234 },
			{ signal: controller.signal, timeoutMs: 5_000 },
		);

		expect(result).toEqual({ status: 200, body: '{"success":true}' });
		// The payload really crossed the TLS connection rather than the status being synthesised.
		expect(seenBody).toContain('"token":"token"');
		expect(seenBody).toContain("POST /api/gracefully_shutdown");
	});

	test("fails instead of buffering forever when headers never terminate", async () => {
		// Something other than NarraFork listening on this port must not be able to grow memory
		// here. A raw TCP server is used because Bun.serve always terminates the header block.
		const { createServer } = await import("node:net");
		const flood = createServer((socket) => {
			socket.write("HTTP/1.1 200 OK\r\n");
			// Endless header bytes, never the blank line that ends the header block.
			const pump = setInterval(() => socket.write(`x-pad: ${"y".repeat(8 * 1024)}\r\n`), 5);
			socket.on("close", () => clearInterval(pump));
			socket.on("error", () => clearInterval(pump));
		});
		await new Promise<void>((ready) => flood.listen(0, "127.0.0.1", () => ready()));
		const floodPort = (flood.address() as { port: number }).port;
		cleanups.push(() => flood.close());

		const controller = new AbortController();
		const attempt = postHandoffRequest(
			`http://127.0.0.1:${floodPort}/api/gracefully_shutdown`,
			{ token: "token" },
			{ signal: controller.signal, timeoutMs: 5_000 },
		);

		await expect(attempt).rejects.toThrow(/size limit/);
	});

	test("aborting the wait rejects instead of hanging", async () => {
		const silent = Bun.serve({
			port: 0,
			fetch: async () => {
				await Bun.sleep(10_000);
				return new Response("never");
			},
		});
		cleanups.push(() => silent.stop(true));

		const controller = new AbortController();
		const attempt = postHandoffRequest(
			`http://127.0.0.1:${silent.port}/api/gracefully_shutdown`,
			{ token: "token" },
			{ signal: controller.signal, timeoutMs: 10_000 },
		);
		controller.abort();

		await expect(attempt).rejects.toThrow(/aborted/);
	});
});

describe("waitForPreviousServerShutdown", () => {
	test("proceeds without a handoff when no restart env is present", async () => {
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));
		for (const key of HANDOFF_ENV_KEYS) delete process.env[key];
		setObservedRestartHandoffForTests(null);

		expect(await waitForPreviousServerShutdown()).toBe(true);
		// An ordinary startup must not look like a replacement process, or planned-update recovery
		// would claim a leftover manifest and resume narrators nobody asked to continue.
		expect(getObservedRestartHandoff()).toBeNull();
	});

	test("accepts a successful handoff response and consumes the marker", async () => {
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));
		cleanups.push(() => setObservedRestartHandoffForTests(null));
		const dir = tempMarkerDir();
		const markerPath = resolve(dir, "marker.json");
		const nonce = "nonce-success";

		const old = Bun.serve({
			port: 0,
			fetch: () => {
				writeMarker(markerPath, nonce);
				return new Response(JSON.stringify({ success: true }));
			},
		});
		cleanups.push(() => old.stop(true));

		process.env[HANDOFF_URL_ENV] = `http://127.0.0.1:${old.port}/api/gracefully_shutdown`;
		process.env[HANDOFF_TOKEN_ENV] = "token";
		process.env[HANDOFF_MARKER_PATH_ENV] = markerPath;
		process.env[HANDOFF_MARKER_NONCE_ENV] = nonce;

		expect(await waitForPreviousServerShutdown()).toBe(true);
		// Handoff env is one-shot: it must never leak into a later in-process restart.
		for (const key of HANDOFF_ENV_KEYS) expect(process.env[key]).toBeUndefined();
		// The nonce is latched before that cleanup, because planned-update recovery runs later and
		// must still be able to prove which update attempt spawned this process.
		expect(getObservedRestartHandoff()).toEqual({ markerNonce: nonce });
	});

	test("treats a marker written after an HTTP error response as success", async () => {
		// Regression: an intercepting proxy answered the cut-off handoff with an empty 502 while the
		// old server shut down cleanly and wrote its marker ~150ms later. The replacement used to
		// abort on the status alone and the machine was left with no server running. The marker is
		// the authoritative evidence, so any failure status must still fall back to waiting for it.
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));
		const dir = tempMarkerDir();
		const markerPath = resolve(dir, "marker.json");
		const nonce = "nonce-http-error";

		const old = Bun.serve({
			port: 0,
			fetch: () => {
				setTimeout(() => writeMarker(markerPath, nonce), 150);
				return new Response("", { status: 502 });
			},
		});
		cleanups.push(() => old.stop(true));

		process.env[HANDOFF_URL_ENV] = `http://127.0.0.1:${old.port}/api/gracefully_shutdown`;
		process.env[HANDOFF_TOKEN_ENV] = "token";
		process.env[HANDOFF_MARKER_PATH_ENV] = markerPath;
		process.env[HANDOFF_MARKER_NONCE_ENV] = nonce;

		expect(await waitForPreviousServerShutdown()).toBe(true);
	});

	test("treats a marker written after a lost response as success", async () => {
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));
		const dir = tempMarkerDir();
		const markerPath = resolve(dir, "marker.json");
		const nonce = "nonce-network-error";

		let old: ReturnType<typeof Bun.serve>;
		old = Bun.serve({
			port: 0,
			async fetch() {
				// Mirrors performGracefulShutdown: connections are closed before the response is
				// flushed, so the client only ever sees a socket error.
				old.stop(true);
				setTimeout(() => writeMarker(markerPath, nonce), 120);
				await Bun.sleep(1_000);
				return new Response(JSON.stringify({ success: true }));
			},
		});
		cleanups.push(() => old.stop(true));

		process.env[HANDOFF_URL_ENV] = `http://127.0.0.1:${old.port}/api/gracefully_shutdown`;
		process.env[HANDOFF_TOKEN_ENV] = "token";
		process.env[HANDOFF_MARKER_PATH_ENV] = markerPath;
		process.env[HANDOFF_MARKER_NONCE_ENV] = nonce;

		expect(await waitForPreviousServerShutdown()).toBe(true);
	});

	test("rejects a marker whose nonce belongs to a different handoff", async () => {
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));
		const dir = tempMarkerDir();
		const markerPath = resolve(dir, "marker.json");

		// A stale marker from an earlier restart must not authorize this one.
		writeMarker(markerPath, "some-other-nonce");
		const old = Bun.serve({ port: 0, fetch: () => new Response("", { status: 502 }) });
		cleanups.push(() => old.stop(true));

		process.env[HANDOFF_URL_ENV] = `http://127.0.0.1:${old.port}/api/gracefully_shutdown`;
		process.env[HANDOFF_TOKEN_ENV] = "token";
		process.env[HANDOFF_MARKER_PATH_ENV] = markerPath;
		process.env[HANDOFF_MARKER_NONCE_ENV] = "expected-nonce";

		expect(await waitForPreviousServerShutdown()).toBe(false);
		// A foreign marker must be left untouched for whoever owns it.
		expect(JSON.parse(readFileSync(markerPath, "utf8")).nonce).toBe("some-other-nonce");
	});

	test("aborts when the marker environment is only half configured", async () => {
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));
		process.env[HANDOFF_URL_ENV] = "http://127.0.0.1:1/api/gracefully_shutdown";
		process.env[HANDOFF_TOKEN_ENV] = "token";
		process.env[HANDOFF_MARKER_PATH_ENV] = "/nonexistent/marker.json";
		delete process.env[HANDOFF_MARKER_NONCE_ENV];

		expect(await waitForPreviousServerShutdown()).toBe(false);
	});

	test("legacy handoff without a marker accepts port release after an HTTP error", async () => {
		cleanups.push(snapshotEnv(HANDOFF_ENV_KEYS));

		let old: ReturnType<typeof Bun.serve>;
		old = Bun.serve({
			port: 0,
			fetch: () => {
				// Release the port shortly after answering with a failure status.
				setTimeout(() => old.stop(true), 100);
				return new Response("", { status: 502 });
			},
		});
		cleanups.push(() => old.stop(true));

		process.env[HANDOFF_URL_ENV] = `http://127.0.0.1:${old.port}/api/gracefully_shutdown`;
		process.env[HANDOFF_TOKEN_ENV] = "token";
		delete process.env[HANDOFF_MARKER_PATH_ENV];
		delete process.env[HANDOFF_MARKER_NONCE_ENV];

		expect(await waitForPreviousServerShutdown()).toBe(true);
	});
});
