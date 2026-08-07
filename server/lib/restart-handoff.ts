/**
 * Replacement-process side of the update handoff.
 *
 * A seamless update spawns the new binary while the old one still owns the port. The new process
 * must therefore ask the old one to shut down (authenticated by a one-time token) and wait for
 * proof that it released the port before importing `./main` and binding.
 *
 * Kept in its own module — free of `./main`, database and settings imports — so it stays testable
 * and so `server/index.ts` can run it before deciding which entrypoint to load.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { logger } from "./logger";
import { APP_VERSION } from "./version";

export const HANDOFF_URL_ENV = "NARRAFORK_GRACEFUL_RESTART_URL";
export const HANDOFF_TOKEN_ENV = "NARRAFORK_GRACEFUL_RESTART_TOKEN";
export const HANDOFF_MARKER_PATH_ENV = "NARRAFORK_GRACEFUL_RESTART_MARKER_PATH";
export const HANDOFF_MARKER_NONCE_ENV = "NARRAFORK_GRACEFUL_RESTART_MARKER_NONCE";
const HANDOFF_TIMEOUT_MS = 60_000;
const HANDOFF_POLL_INTERVAL_MS = 250;
const HANDOFF_CONNECT_TIMEOUT_MS = 750;
/**
 * Socket-level budget for the handoff POST itself. Generous, because the old server only answers
 * after its teardown finished, and bounded so a wedged old process cannot hold the whole deadline
 * without the marker/port evidence paths getting their turn.
 */
const HANDOFF_REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound on the buffered handoff reply; the real one is a small JSON object. */
const HANDOFF_RESPONSE_LIMIT_BYTES = 64 * 1024;

type HandoffAttemptResult =
	| { ok: true }
	| { ok: false; kind: "http"; message: string }
	| { ok: false; kind: "network"; message: string };

type HandoffMarkerResult = { ok: true } | { ok: false; message: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timeout = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function handoffAddress(handoffUrl: string): { host: string; port: number } {
	const url = new URL(handoffUrl);
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
	return { host, port };
}

function canConnectToHandoffPort(handoffUrl: string, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	const { host, port } = handoffAddress(handoffUrl);
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const done = (open: boolean) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			socket.destroy();
			resolve(open);
		};
		const onAbort = () => done(false);

		signal.addEventListener("abort", onAbort, { once: true });
		socket.setTimeout(HANDOFF_CONNECT_TIMEOUT_MS, () => done(true));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function waitForHandoffPortToClose(
	handoffUrl: string,
	deadlineMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	while (Date.now() < deadlineMs && !signal.aborted) {
		if (!(await canConnectToHandoffPort(handoffUrl, signal))) return true;
		await sleep(HANDOFF_POLL_INTERVAL_MS, signal);
	}
	return false;
}

function readHandoffMarker(markerPath: string, expectedNonce: string): HandoffMarkerResult | null {
	if (!existsSync(markerPath)) return null;
	try {
		const payload = JSON.parse(readFileSync(markerPath, "utf8")) as { nonce?: unknown };
		if (payload.nonce !== expectedNonce) {
			return { ok: false, message: "handoff marker nonce mismatch" };
		}
		try {
			unlinkSync(markerPath);
		} catch {
			// Marker is one-shot best-effort cleanup; a stale matching marker is harmless
			// because future handoffs use a fresh nonce and path.
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			message: `failed to read handoff marker: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

async function waitForHandoffMarker(
	markerPath: string,
	markerNonce: string,
	deadlineMs: number,
	signal: AbortSignal,
): Promise<HandoffMarkerResult> {
	while (Date.now() < deadlineMs && !signal.aborted) {
		const marker = readHandoffMarker(markerPath, markerNonce);
		if (marker) return marker;
		await sleep(HANDOFF_POLL_INTERVAL_MS, signal);
	}
	return { ok: false, message: "handoff marker was not written before timeout" };
}

/**
 * POST the handoff request over a raw socket instead of `fetch()`.
 *
 * The handoff target is always this machine's own port, so it must never traverse a proxy. Bun's
 * global `fetch()` cannot guarantee that: it honours ambient HTTP(S)_PROXY / ALL_PROXY even for
 * loopback targets, the per-request `proxy` option does not opt out (`proxy: ""` and
 * `proxy: undefined` are still proxied on Bun 1.3.14), and `NO_PROXY` only takes effect depending
 * on when it is set relative to the first request to that origin. On a machine that exports a
 * system proxy — a very common laptop setup — the handoff POST went to the proxy, which could not
 * read the response the old server intentionally cuts off mid-request and answered with a synthetic
 * empty `502`, making the replacement abort startup even though the old server shut down cleanly.
 *
 * A raw socket removes the entire question: there is no proxy layer to consult. Only the status
 * line is parsed, because that is all the caller needs, and a connection that dies before the
 * headers arrive is reported as a network error rather than a status — the honest distinction,
 * since the old server closes connections before flushing this very response.
 */
export function postHandoffRequest(
	handoffUrl: string,
	payload: unknown,
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<{ status: number; body: string }> {
	const url = new URL(handoffUrl);
	const isTls = url.protocol === "https:";
	const { host, port } = handoffAddress(handoffUrl);
	const body = JSON.stringify(payload);

	return new Promise((resolvePromise, reject) => {
		// The old server may present a self-signed certificate; this request is local-only and
		// authenticated by a one-time token, so certificate identity adds nothing here.
		const socket: Socket = isTls
			? tlsConnect({
					host,
					port,
					rejectUnauthorized: false,
					// TLS forbids an IP literal as SNI.
					...(/^[0-9.]+$/.test(host) || host.includes(":") ? {} : { servername: host }),
				})
			: createConnection({ host, port });

		let received = "";
		let settled = false;
		let truncated = false;
		const finish = (err: Error | null, result?: { status: number; body: string }) => {
			if (settled) return;
			settled = true;
			options.signal.removeEventListener("abort", onAbort);
			socket.destroy();
			if (err) reject(err);
			else resolvePromise(result as { status: number; body: string });
		};
		const onAbort = () => finish(new Error("handoff request aborted"));
		options.signal.addEventListener("abort", onAbort, { once: true });

		socket.setTimeout(options.timeoutMs, () => finish(new Error("handoff request timed out")));
		socket.on("error", (err) => finish(err));
		socket.on(isTls ? "secureConnect" : "connect", () => {
			socket.write(
				`POST ${url.pathname}${url.search} HTTP/1.1\r\n` +
					`Host: ${url.host}\r\n` +
					"Content-Type: application/json\r\n" +
					`Content-Length: ${Buffer.byteLength(body)}\r\n` +
					"Connection: close\r\n\r\n" +
					body,
			);
		});
		socket.on("data", (chunk) => {
			// The expected reply is a small JSON object. Cap what is buffered so a misbehaving or
			// unrelated peer on this port cannot grow memory here, and fail once the cap is hit
			// without the headers having arrived.
			if (received.length < HANDOFF_RESPONSE_LIMIT_BYTES) {
				received += chunk.toString("utf8");
			} else {
				truncated = true;
			}
			const headerEnd = received.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				if (truncated || received.length >= HANDOFF_RESPONSE_LIMIT_BYTES) {
					finish(new Error("handoff response headers exceeded the size limit"));
				}
				return;
			}
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1]);
			if (!Number.isFinite(status)) {
				finish(new Error("malformed handoff response status line"));
				return;
			}
			finish(null, { status, body: received.slice(headerEnd + 4) });
		});
		socket.on("close", () => finish(new Error("connection closed before response headers")));
	});
}

async function requestGracefulShutdown(
	handoffUrl: string,
	token: string,
	signal: AbortSignal,
): Promise<HandoffAttemptResult> {
	try {
		const response = await postHandoffRequest(
			handoffUrl,
			{ token, pid: process.pid, version: APP_VERSION },
			{ signal, timeoutMs: HANDOFF_REQUEST_TIMEOUT_MS },
		);

		if (response.status < 200 || response.status >= 300) {
			return {
				ok: false,
				kind: "http",
				message: `handoff failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`,
			};
		}

		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			kind: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Ask the previous server to shut down and wait for proof that it did.
 *
 * Returns true when this process may proceed to bind the port: either no handoff was requested
 * (normal startup) or the previous server provably released it. Returns false when the handoff
 * could not be confirmed, in which case the caller must abort rather than fall back to another port.
 */
export async function waitForPreviousServerShutdown(): Promise<boolean> {
	const handoffUrl = process.env[HANDOFF_URL_ENV];
	const token = process.env[HANDOFF_TOKEN_ENV];
	const markerPath = process.env[HANDOFF_MARKER_PATH_ENV];
	const markerNonce = process.env[HANDOFF_MARKER_NONCE_ENV];
	if (!handoffUrl || !token) return true;

	console.log("Waiting for previous NarraFork server to shut down gracefully...");
	logger.info("Waiting for previous NarraFork server shutdown", { handoffUrl, markerPath });

	const controller = new AbortController();
	const deadlineMs = Date.now() + HANDOFF_TIMEOUT_MS;
	let handoffSucceeded = false;

	try {
		// A self-signed certificate on the old server is tolerated per-socket inside
		// postHandoffRequest, so no process-wide TLS relaxation is needed here.
		if ((markerPath && !markerNonce) || (!markerPath && markerNonce)) {
			throw new Error("incomplete graceful restart marker environment");
		}

		const handoffAttempt = requestGracefulShutdown(handoffUrl, token, controller.signal);

		if (markerPath && markerNonce) {
			const markerWait = waitForHandoffMarker(
				markerPath,
				markerNonce,
				deadlineMs,
				controller.signal,
			);
			const first = await Promise.race([
				markerWait.then((result) => ({ type: "marker" as const, result })),
				handoffAttempt.then((result) => ({ type: "handoff" as const, result })),
			]);

			if (first.type === "marker") {
				if (!first.result.ok) throw new Error(first.result.message);
				handoffSucceeded = true;
				logger.info("Previous NarraFork server shutdown marker confirmed", { markerPath });
			} else if (first.result.ok) {
				const marker = readHandoffMarker(markerPath, markerNonce);
				if (marker && !marker.ok) {
					logger.warn("Graceful restart marker cleanup failed after HTTP handoff", {
						markerPath,
						error: marker.message,
					});
				}
				handoffSucceeded = true;
				logger.info("Previous NarraFork server accepted graceful shutdown request");
			} else {
				// A failed handoff response never proves the old server is still running. The old
				// process closes its listener before flushing this very response, so a cut-off
				// connection is the normal case; anything in the path that turns that cut-off into a
				// status (an intercepting proxy synthesizing an empty 502) produces an equally
				// meaningless failure. The marker file — written only after teardown finished — is the
				// authoritative signal, so give it the full remaining budget instead of aborting on
				// the response alone.
				logger.warn("Graceful restart handoff response was inconclusive; waiting for marker", {
					kind: first.result.kind,
					error: first.result.message,
					markerPath,
				});
				const marker = await markerWait;
				if (!marker.ok) {
					throw new Error(`${first.result.message}; ${marker.message}`);
				}
				handoffSucceeded = true;
				logger.info("Previous NarraFork server shutdown marker confirmed after failed handoff", {
					markerPath,
				});
			}
		} else {
			// Compatibility path for updates started by older binaries that do not know
			// about marker files yet. Future updates use marker+nonce above.
			const portClosed = waitForHandoffPortToClose(handoffUrl, deadlineMs, controller.signal);
			const first = await Promise.race([
				portClosed.then((closed) => ({ type: "port" as const, closed })),
				handoffAttempt.then((result) => ({ type: "handoff" as const, result })),
			]);

			if (first.type === "port") {
				if (!first.closed) {
					throw new Error("previous server did not release the handoff port before timeout");
				}
				handoffSucceeded = true;
				logger.info("Previous NarraFork server port closed during legacy handoff");
			} else if (first.result.ok) {
				logger.info("Previous NarraFork server accepted graceful shutdown request");
				if (!(await portClosed)) {
					throw new Error("previous server accepted handoff but did not release the port");
				}
				handoffSucceeded = true;
			} else {
				// Same reasoning as the marker path: a lost response or a proxy-synthesized status is
				// not evidence that the old server survived. Port release is the evidence here.
				logger.warn(
					"Legacy graceful restart handoff response was inconclusive; waiting for port release",
					{ kind: first.result.kind, error: first.result.message },
				);
				if (!(await portClosed)) {
					throw new Error(
						`handoff failed and previous server is still reachable: ${first.result.message}`,
					);
				}
				handoffSucceeded = true;
			}
		}

		console.log("Previous NarraFork server reported graceful shutdown complete.");
		logger.info("Previous NarraFork server shutdown confirmed");
	} catch (err) {
		console.error(
			`Graceful restart handoff failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		console.error("Aborting replacement startup to avoid running on a fallback port.");
		logger.error("Graceful restart handoff failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		controller.abort();
		delete process.env[HANDOFF_URL_ENV];
		delete process.env[HANDOFF_TOKEN_ENV];
		delete process.env[HANDOFF_MARKER_PATH_ENV];
		delete process.env[HANDOFF_MARKER_NONCE_ENV];
	}

	return handoffSucceeded;
}
