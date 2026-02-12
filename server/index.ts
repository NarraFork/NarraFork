import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { app } from "./app";
import "./db"; // Ensure DB is initialized early
import { logger } from "./lib/logger";
import { settings } from "./lib/settings";
import { resolveWSData, wsHandlers, type WSData } from "./websocket/ws-handler";

const port = settings.server.port;
const isProd = process.env.NODE_ENV === "production";

// Production: serve Vite build output via Hono
if (isProd) {
	const staticDir = resolve(import.meta.dir, "..", "dist", "frontend");
	if (existsSync(staticDir)) {
		app.use("/assets/*", serveStatic({ root: staticDir }));
		app.get("*", serveStatic({ root: staticDir, path: "index.html" }));
	}
}

const server = Bun.serve({
	port,
	fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for /ws/narrator and /ws/terminal
		if (url.pathname.startsWith("/ws")) {
			const wsData = resolveWSData(url);
			if (!wsData) {
				return new Response("Unknown WebSocket endpoint", { status: 404 });
			}
			const upgraded = server.upgrade(req, { data: wsData });
			if (upgraded) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// Everything else goes to Hono
		return app.fetch(req);
	},
	websocket: wsHandlers,
});

logger.info(`NarraFork server running on http://localhost:${port}`, { isProd });
