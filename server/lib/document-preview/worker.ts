/**
 * Document preview worker entry.
 *
 * Inflating a ZIP and walking its OOXML parts is CPU- and memory-heavy work on attacker-
 * supplied input, so it must never run on the server's main thread (a large document would
 * stall HTTP, WebSocket and agent traffic for everyone).
 *
 * Protocol: one request per message, exactly one reply carrying the same `requestId`.
 * Registered in `COMPILED_WORKER_ENTRIES` so a compiled binary contains it at all — `new
 * Worker()` specifiers are not followed by the bundler.
 */

import { parentPort } from "node:worker_threads";
import { readDocumentAsset, readDocumentPreview } from "./index";
import type { DocumentParseOutcome } from "./types";

type WorkerRequest =
	| { action: "ping" }
	| { requestId: string; action: "preview"; filePath: string }
	| { requestId: string; action: "asset"; filePath: string; assetId: string };

type WorkerReply =
	| { ready: true }
	| { requestId: string; ok: true; outcome: DocumentParseOutcome }
	| { requestId: string; ok: true; asset: { bytes: Uint8Array; mime: string } | null }
	| { requestId: string; ok: false; error: string };

function post(reply: WorkerReply) {
	parentPort?.postMessage(reply);
}

parentPort?.on("message", (message: WorkerRequest) => {
	if ("action" in message && message.action === "ping") {
		post({ ready: true });
		return;
	}
	if (!("requestId" in message)) return;

	// Every path must answer: a rejected promise here would hang the caller until its timeout.
	void (async () => {
		try {
			if (message.action === "preview") {
				const outcome = await readDocumentPreview(message.filePath);
				post({ requestId: message.requestId, ok: true, outcome });
				return;
			}
			const asset = await readDocumentAsset(message.filePath, message.assetId);
			post({ requestId: message.requestId, ok: true, asset: asset ?? null });
		} catch (error) {
			post({
				requestId: message.requestId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	})();
});
