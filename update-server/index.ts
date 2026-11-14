/**
 * NarraFork Update Server — Bun.serve() entry point.
 *
 * Usage:
 *   bun update-server/index.ts [--config=path] [--port=7780]
 */
import { resolve } from "node:path";
import { MAX_MIRROR_MAIN_BINARY_BYTES } from "../shared/independent-update-mirror";
import { createApp } from "./app";
import { getConfig, initConfig } from "./lib/config";
import { logger } from "./lib/logger";
import { resolveMirrorRelaySettings } from "./lib/mirror-relay-config";
import { MirrorIngestService } from "./services/mirror-ingest";
import { MirrorRelayPuller } from "./services/mirror-relay-pull";
import { LocalStorage } from "./storage/local";

// Parse CLI args
const args = process.argv.slice(2);
let configPath = resolve("config.json");
let portOverride: number | undefined;

for (const arg of args) {
	if (arg.startsWith("--config=")) {
		configPath = resolve(arg.slice(9));
	} else if (arg.startsWith("--port=")) {
		portOverride = Number.parseInt(arg.slice(7), 10);
	} else if (arg === "--debug") {
		logger.setLevel("debug");
	}
}

// Initialize config
const { adminToken } = await initConfig(configPath);

if (adminToken) {
	console.log("\n╔══════════════════════════════════════════════════════════════╗");
	console.log("║  First run — admin token generated (save it now!):         ║");
	console.log(`║  ${adminToken.padEnd(58)}║`);
	console.log("╚══════════════════════════════════════════════════════════════╝\n");
}

const config = getConfig();
const port = portOverride ?? config.port;
const host = config.host;

// Initialize storage
const dataDir = resolve(configPath, "..", config.dataDir);
const storage = new LocalStorage(dataDir);

// Both direct HTTP and optional pull delivery share exactly the same ingest locks and validation.
const ingest = new MirrorIngestService(storage);
const relaySettings = resolveMirrorRelaySettings(config);
const relay = relaySettings
	? new MirrorRelayPuller(storage, ingest, relaySettings, {
			onEvent: (event) => logger.info("Mirror relay pull", { ...event }),
		})
	: undefined;
const app = createApp(storage, ingest);

// Start server
const server = Bun.serve({
	port,
	hostname: host,
	// Exact per-kind limits and deadlines remain enforced by authenticated streaming admission.
	maxRequestBodySize: MAX_MIRROR_MAIN_BINARY_BYTES,
	idleTimeout: 30,
	fetch(request, server) {
		// These handlers impose their own absolute upload/verification/download deadlines.
		// Bun's socket idle timeout must not cut off a healthy long verification with no output.
		if (
			/^\/api\/v3\/products\/[A-Za-z0-9_-]+\/mirror\/(assets\/[a-f0-9]{64}|snapshot)$/.test(
				new URL(request.url).pathname,
			)
		)
			server.timeout(request, 0);
		return app.fetch(request, server);
	},
});

logger.info(`Update server listening on http://${host}:${server.port}`);
logger.info(`Data directory: ${dataDir}`);

// Disabled relay configurations create no worker and no timer.
relay?.start();

// Only this standalone server's ordinary signal lifecycle is affected. Never reload NarraFork.
let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("Shutting down...");
	const deadline = setTimeout(() => process.exit(1), 5000);
	deadline.unref();
	await relay?.stop();
	server.stop();
	clearTimeout(deadline);
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
