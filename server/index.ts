import { APP_VERSION } from "./lib/version";

const HANDOFF_URL_ENV = "NARRAFORK_GRACEFUL_RESTART_URL";
const HANDOFF_TOKEN_ENV = "NARRAFORK_GRACEFUL_RESTART_TOKEN";
const HANDOFF_TIMEOUT_MS = 60_000;

async function waitForPreviousServerShutdown(): Promise<boolean> {
	const handoffUrl = process.env[HANDOFF_URL_ENV];
	const token = process.env[HANDOFF_TOKEN_ENV];
	if (!handoffUrl || !token) return true;

	console.log("Waiting for previous NarraFork server to shut down gracefully...");

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS);
	const originalTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	let handoffSucceeded = false;

	try {
		// Handoff requests are local-only and authenticated by a one-time token. When the
		// old server uses a self-signed TLS certificate, allow this single local request
		// to complete so the new process can wait before binding the port.
		if (handoffUrl.startsWith("https://")) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		}

		const response = await fetch(handoffUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token,
				pid: process.pid,
				version: APP_VERSION,
			}),
			signal: controller.signal,
		});

		const responseText = await response.text();
		let payload: unknown = responseText;
		try {
			payload = JSON.parse(responseText);
		} catch {
			// Keep plain text payload for diagnostics.
		}

		if (!response.ok) {
			throw new Error(`handoff failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
		}

		handoffSucceeded = true;
		console.log("Previous NarraFork server reported graceful shutdown complete.");
	} catch (err) {
		console.error(
			`Graceful restart handoff failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		console.error("Aborting replacement startup to avoid running on a fallback port.");
	} finally {
		clearTimeout(timeout);
		if (originalTlsRejectUnauthorized === undefined) {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		} else {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsRejectUnauthorized;
		}
		delete process.env[HANDOFF_URL_ENV];
		delete process.env[HANDOFF_TOKEN_ENV];
	}

	return handoffSucceeded;
}

const handoffOk = await waitForPreviousServerShutdown();
if (!handoffOk) {
	process.exit(1);
}
await import("./main");
