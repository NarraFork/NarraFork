import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

import { eq } from "drizzle-orm";

import { app } from "./app";
import "./db"; // Ensure DB is initialized early
import { db } from "./db";
import { users } from "./db/schema";
import { verifyToken } from "./lib/auth";
import {
import { logger } from "./lib/logger";
import { initWslFlag } from "./lib/platform";
import { projectDbManager } from "./lib/project-db";
import { settings } from "./lib/settings";

// Parse --wsl=true|false CLI flag (default: false — WSL disallowed)
initWslFlag();

import { chapterBatchMerge } from "./services/chapter-batch-merge";
import { chapterCleanup } from "./services/chapter-cleanup";
import { startContainerProxy, stopContainerProxy } from "./services/container-proxy";
import { ensureRootlessEnv } from "./services/container-service";
import { recoverOnStartup as recoverNarrators } from "./services/narrator-session";
import "./services/notification-service"; // Register notification event listeners
import { registerProjectDbSync } from "./services/project-db-sync";
import { snapshot } from "./services/snapshot";
import { terminalService } from "./services/terminal-service";
import { worktreeWatcher } from "./services/worktree-watcher";
import { resolveWSData, startHeartbeat, stopHeartbeat, wsHandlers } from "./websocket/ws-handler";

// Set rootless podman env vars early so all child processes inherit them
ensureRootlessEnv();

// Catch unhandled errors to prevent silent crashes
process.on("uncaughtException", (err) => {
	logger.error("Uncaught exception", { error: String(err), stack: err?.stack });
});
process.on("unhandledRejection", (reason) => {
	logger.error("Unhandled rejection", { error: String(reason), stack: (reason as Error)?.stack });
});

// CLI flags: --port=XXXX --host=XXXX
const cliPort = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
const cliHost = process.argv.find((a) => a.startsWith("--host="))?.split("=")[1];

const port = Number(cliPort) || Number(process.env.PORT) || settings.server.port;
const host = cliHost || process.env.HOST || "localhost";
// Compiled single-executable binaries are always treated as production.
// Bun embeds files under $bunfs — if our entry point lives there, we're compiled.
const isCompiledBinary = import.meta.url.startsWith("file:///$bunfs/");
const isProd = isCompiledBinary || process.env.NODE_ENV === "production";

// MIME type lookup for embedded static files
const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json",
};

// Production: serve Vite build output via Hono
if (isProd) {
	// Try embedded assets first (compiled single-executable mode)
	let hasEmbedded = false;
	try {
		// Dynamic import so it doesn't fail when the generated file doesn't exist (dev / bundle mode)
		const generatedFrontendModulePath = "./generated/embedded-frontend";
		const generatedModule = (await import(generatedFrontendModulePath)) as {
			embeddedAssets?: Record<string, string>;
		};
		const embeddedAssets = generatedModule.embeddedAssets ?? {};
		const indexPath = embeddedAssets["/index.html"];
		if (indexPath) {
			hasEmbedded = true;
			logger.info("Serving frontend from embedded assets");

			// Serve exact-match embedded files
			app.use("*", async (c, next) => {
				// Skip API and WebSocket routes
				if (c.req.path.startsWith("/api") || c.req.path.startsWith("/ws")) {
					return next();
				}

				const filePath = embeddedAssets[c.req.path];
				if (filePath) {
					const blob = Bun.file(filePath);
					const mime = MIME_TYPES[extname(c.req.path)] ?? "application/octet-stream";
					const isHashed = c.req.path.startsWith("/assets/");
					return new Response(blob, {
						headers: {
							"Content-Type": mime,
							"Cache-Control": isHashed
								? "public, max-age=31536000, immutable"
								: "public, max-age=3600",
						},
					});
				}

				// SPA catch-all: serve index.html for non-file routes
				if (!c.req.path.includes(".")) {
					const blob = Bun.file(indexPath);
					return new Response(blob, {
						headers: {
							"Content-Type": "text/html; charset=utf-8",
							"Cache-Control": "no-cache",
						},
					});
				}

				return next();
			});
		}
	} catch {
		// Generated file doesn't exist — fall through to filesystem mode
	}

	// Fallback: serve from filesystem (bundle mode or bun run start)
	if (!hasEmbedded) {
		const staticDir = resolve(import.meta.dir, "..", "dist", "frontend");
		logger.info(
			`Static file serving: filesystem mode, dir=${staticDir}, exists=${existsSync(staticDir)}`,
		);
		if (existsSync(staticDir)) {
			// Serve all static files from dist/frontend via a single middleware
			app.use("*", async (c, next) => {
				// Skip API and WebSocket routes
				if (c.req.path.startsWith("/api") || c.req.path.startsWith("/ws")) {
					return next();
				}

				const filePath = resolve(staticDir, `.${c.req.path}`);
				// Security: ensure resolved path is within staticDir
				if (!filePath.startsWith(staticDir)) {
					return next();
				}

				const file = Bun.file(filePath);
				if (await file.exists()) {
					const ext = extname(c.req.path);
					const mime = MIME_TYPES[ext] ?? "application/octet-stream";
					const isHashed = c.req.path.startsWith("/assets/");
					return new Response(file, {
						headers: {
							"Content-Type": mime,
							"Cache-Control": isHashed
								? "public, max-age=31536000, immutable"
								: "public, max-age=3600",
						},
					});
				}

				// SPA catch-all: serve index.html for non-file routes
				if (!c.req.path.includes(".")) {
					const indexFile = Bun.file(resolve(staticDir, "index.html"));
					return new Response(indexFile, {
						headers: {
							"Content-Type": "text/html; charset=utf-8",
							"Cache-Control": "no-cache",
						},
					});
				}

				return next();
			});
		}
	}
}

const _server = Bun.serve({
	port,
	hostname: host,
	idleTimeout: 255,
	async fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for /ws/narrator and /ws/terminal
		if (url.pathname.startsWith("/ws")) {
			// Verify JWT from query param
			const token = url.searchParams.get("token");
			if (!token) {
				return new Response("Authentication required", { status: 401 });
			}
			let payload: Awaited<ReturnType<typeof verifyToken>>;
			try {
				payload = await verifyToken(token);
			} catch {
				return new Response("Invalid or expired token", { status: 401 });
			}

			// Look up user info for presence tracking
			const user = await db.query.users.findFirst({
				where: eq(users.id, payload.sub),
				columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
			});
			const userInfo = user
				? {
						userId: user.id,
						username: user.username,
						avatarColor: user.avatarColor,
						avatarImageId: user.avatarImageId,
					}
				: undefined;

			const wsData = resolveWSData(url, userInfo);
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

logger.info(`NarraFork server running on http://${host}:${port}`, { isProd });

// Start WebSocket heartbeat (ping/pong) to detect stale connections
startHeartbeat();

	try {
			configPath:
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		});
		});
			if (cached.length > 0) {
			} else {
					.then((models) =>
					)
			}
		}
	} catch (err) {
	}
}

// Mark any stale terminals from a previous run as exited
terminalService.recoverOnStartup().catch((err) => {
	logger.error("Terminal recovery failed", { error: String(err) });
});

// Clean up stale narrator states from previous server run
recoverNarrators().catch((err) => {
	logger.error("Narrator state recovery failed", { error: String(err) });
});

// Mark interrupted merge sessions as error
chapterBatchMerge.cleanupStaleSessions().catch((err) => {
	logger.error("Merge session cleanup failed", { error: String(err) });
});

// Register project DB backup sync (event-driven dual-write)
registerProjectDbSync();

	.catch((err) => {
	});

// Start container proxy if enabled
if (settings.containers.proxy?.enabled) {
	startContainerProxy().catch((err) => {
		logger.error("Container proxy startup failed", { error: String(err) });
	});
}

// Periodic snapshot GC — run once at startup then every 24 hours
const SNAPSHOT_GC_INTERVAL = 24 * 60 * 60 * 1000;
snapshot.gcAll().catch((err) => {
	logger.warn("Initial snapshot GC failed", { error: String(err) });
});
const snapshotGcTimer = setInterval(() => {
	snapshot.gcAll().catch((err) => {
		logger.warn("Periodic snapshot GC failed", { error: String(err) });
	});
}, SNAPSHOT_GC_INTERVAL);

// Graceful shutdown
const shutdown = () => {
	stopHeartbeat();
	stopContainerProxy();
	clearInterval(snapshotGcTimer);
	chapterCleanup.clearAllTimers();
	worktreeWatcher.shutdown();
	projectDbManager.closeAll();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
