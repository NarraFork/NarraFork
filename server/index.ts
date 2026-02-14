import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { app } from "./app";
import "./db"; // Ensure DB is initialized early
import { verifyToken } from "./lib/auth";
import { logger } from "./lib/logger";
import { settings } from "./lib/settings";
import { recoverOnStartup as recoverNarrators } from "./services/narrator-session";
import { terminalService } from "./services/terminal-service";
import { resolveWSData, wsHandlers } from "./websocket/ws-handler";

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

const _server = Bun.serve({
	port,
	idleTimeout: 255,
	async fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for /ws/narrator and /ws/terminal
		if (url.pathname.startsWith("/ws")) {
			const wsData = resolveWSData(url);
			if (!wsData) {
				return new Response("Unknown WebSocket endpoint", { status: 404 });
			}

			// Verify JWT from query param
			const token = url.searchParams.get("token");
			if (!token) {
				return new Response("Authentication required", { status: 401 });
			}
			try {
				await verifyToken(token);
			} catch {
				return new Response("Invalid or expired token", { status: 401 });
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

// Recover terminals that survived a server restart (dtach sessions persist)
terminalService.recoverOnStartup().catch((err) => {
	logger.error("Terminal recovery failed", { error: String(err) });
});

// Clean up stale narrator states from previous server run
recoverNarrators().catch((err) => {
	logger.error("Narrator state recovery failed", { error: String(err) });
});
