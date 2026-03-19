/**
 * NarraFork Update Server — Bun.serve() entry point.
 *
 * Usage:
 *   bun update-server/index.ts [--config=path] [--port=7780]
 */
import { resolve } from "node:path";
import { createApp } from "./app";
import { getConfig, initConfig } from "./lib/config";
import { logger } from "./lib/logger";
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

// Create app
const app = createApp(storage);

// Start server
const server = Bun.serve({
	port,
	hostname: host,
	fetch: app.fetch,
});

logger.info(`Update server listening on http://${host}:${server.port}`);
logger.info(`Data directory: ${dataDir}`);

// Graceful shutdown
process.on("SIGINT", () => {
	logger.info("Shutting down...");
	server.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	logger.info("Shutting down...");
	server.stop();
	process.exit(0);
});
