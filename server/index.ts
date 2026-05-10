import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { logger } from "./lib/logger";
import { APP_VERSION } from "./lib/version";
import { WATCHER_WORKER_FLAG } from "./lib/watcher/worker-protocol";

const HANDOFF_URL_ENV = "NARRAFORK_GRACEFUL_RESTART_URL";
const HANDOFF_TOKEN_ENV = "NARRAFORK_GRACEFUL_RESTART_TOKEN";
const HANDOFF_MARKER_PATH_ENV = "NARRAFORK_GRACEFUL_RESTART_MARKER_PATH";
const HANDOFF_MARKER_NONCE_ENV = "NARRAFORK_GRACEFUL_RESTART_MARKER_NONCE";
const HANDOFF_TIMEOUT_MS = 60_000;
const HANDOFF_POLL_INTERVAL_MS = 250;
const HANDOFF_CONNECT_TIMEOUT_MS = 750;

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

async function requestGracefulShutdown(
	handoffUrl: string,
	token: string,
	signal: AbortSignal,
): Promise<HandoffAttemptResult> {
	try {
		const response = await fetch(handoffUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token,
				pid: process.pid,
				version: APP_VERSION,
			}),
			signal,
		});

		const responseText = await response.text();
		let payload: unknown = responseText;
		try {
			payload = JSON.parse(responseText);
		} catch {
			// Keep plain text payload for diagnostics.
		}

		if (!response.ok) {
			return {
				ok: false,
				kind: "http",
				message: `handoff failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
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

async function waitForPreviousServerShutdown(): Promise<boolean> {
	const handoffUrl = process.env[HANDOFF_URL_ENV];
	const token = process.env[HANDOFF_TOKEN_ENV];
	const markerPath = process.env[HANDOFF_MARKER_PATH_ENV];
	const markerNonce = process.env[HANDOFF_MARKER_NONCE_ENV];
	if (!handoffUrl || !token) return true;

	console.log("Waiting for previous NarraFork server to shut down gracefully...");
	logger.info("Waiting for previous NarraFork server shutdown", { handoffUrl, markerPath });

	const controller = new AbortController();
	const deadlineMs = Date.now() + HANDOFF_TIMEOUT_MS;
	const originalTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	let handoffSucceeded = false;

	try {
		// Handoff requests are local-only and authenticated by a one-time token. When the
		// old server uses a self-signed TLS certificate, allow this single local request
		// to complete so the new process can wait before binding the port.
		if (handoffUrl.startsWith("https://")) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		}

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
			} else if (first.result.kind === "network") {
				// On Windows the old process can close its HTTP listener before the handoff
				// response is flushed. The marker file is the authoritative success signal.
				logger.warn("Graceful restart handoff response was lost; waiting for marker", {
					error: first.result.message,
					markerPath,
				});
				const marker = await markerWait;
				if (!marker.ok) {
					throw new Error(`${first.result.message}; ${marker.message}`);
				}
				handoffSucceeded = true;
			} else {
				throw new Error(first.result.message);
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
			} else if (first.result.kind === "network") {
				logger.warn("Legacy graceful restart handoff response was lost; waiting for port release", {
					error: first.result.message,
				});
				if (!(await portClosed)) {
					throw new Error(
						`handoff failed and previous server is still reachable: ${first.result.message}`,
					);
				}
				handoffSucceeded = true;
			} else {
				throw new Error(first.result.message);
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
		if (originalTlsRejectUnauthorized === undefined) {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		} else {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsRejectUnauthorized;
		}
		delete process.env[HANDOFF_URL_ENV];
		delete process.env[HANDOFF_TOKEN_ENV];
		delete process.env[HANDOFF_MARKER_PATH_ENV];
		delete process.env[HANDOFF_MARKER_NONCE_ENV];
	}

	return handoffSucceeded;
}

if (process.argv.includes(WATCHER_WORKER_FLAG)) {
	await import("./lib/watcher/parcel-watcher-worker");
} else {
	const handoffOk = await waitForPreviousServerShutdown();
	if (!handoffOk) {
		process.exit(1);
	}
	await import("./main");
}
