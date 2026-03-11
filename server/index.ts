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
import { mcpManager } from "./lib/mcp/manager";
import { syncMcpTools } from "./lib/mcp/tool-bridge";
import { IS_WINDOWS, initWslFlag } from "./lib/platform";
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

const portExplicit = !!(cliPort || process.env.PORT);
const port = Number(cliPort) || Number(process.env.PORT) || settings.server.port;
const host = cliHost || process.env.HOST || "localhost";
// Compiled single-executable binaries are always treated as production.
// Bun embeds files under $bunfs (Linux/macOS) or ~BUN/%7EBUN (Windows).
const isCompiledBinary = import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/");
// Also treat as production when dist/frontend exists (handles Windows where
// NODE_ENV=production inline syntax doesn't work)
const hasFrontendBuild = existsSync(
	resolve(import.meta.dir, "..", "dist", "frontend", "index.html"),
);
const isProd = isCompiledBinary || process.env.NODE_ENV === "production" || hasFrontendBuild;

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
		const rawAssets = generatedModule.embeddedAssets ?? {};
		// Normalise keys: on Windows the build script may produce backslash
		// keys (e.g. "/assets\\index-abc.js") — convert them to forward slashes
		// so they match browser request paths.
		const embeddedAssets: Record<string, string> = {};
		for (const [key, value] of Object.entries(rawAssets)) {
			embeddedAssets[key.replaceAll("\\", "/")] = value;
		}
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
	} catch (err) {
		// Generated file doesn't exist — fall through to filesystem mode
		logger.debug("Embedded frontend not available, falling back to filesystem", {
			error: String(err),
		});
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

// Try to start the server, with automatic port fallback when the default port is busy.
const MAX_PORT_RETRIES = 10;

function startServer(listenPort: number) {
	return Bun.serve({
		port: listenPort,
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
}

let actualPort = port;
let _server: ReturnType<typeof startServer>;

if (portExplicit) {
	// User explicitly specified a port — fail hard if it's busy
	try {
		_server = startServer(port);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("EADDRINUSE") || msg.includes("address already in use")) {
			logger.error(`Port ${port} is already in use. Cannot start server.`);
			console.error(
				`\x1b[31mError: Port ${port} is already in use.\x1b[0m\nPlease free the port or choose a different one with --port=XXXX.`,
			);
			process.exit(1);
		}
		throw err;
	}
} else {
	// Default port — try fallback ports if busy
	let started = false;
	for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
		const tryPort = port + attempt;
		try {
			_server = startServer(tryPort);
			actualPort = tryPort;
			started = true;
			if (attempt > 0) {
				logger.warn(`Default port ${port} was in use, automatically switched to port ${tryPort}`);
				console.warn(`\x1b[33m⚠ Port ${port} is in use. Using port ${tryPort} instead.\x1b[0m`);
			}
			break;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("EADDRINUSE") || msg.includes("address already in use")) {
				continue;
			}
			throw err;
		}
	}
	if (!started) {
		logger.error(`Could not find an available port (tried ${port}–${port + MAX_PORT_RETRIES}).`);
		console.error(
			`\x1b[31mError: Could not find an available port (tried ${port}–${port + MAX_PORT_RETRIES}).\x1b[0m\nPlease specify a port with --port=XXXX.`,
		);
		process.exit(1);
	}
}

logger.info(`NarraFork server running on http://${host}:${actualPort}`, {
	isProd,
	isCompiledBinary,
	metaUrl: import.meta.url,
});

// Print welcome banner to stdout & auto-open browser on Windows
{
	const { APP_VERSION, GIT_COMMIT } = await import("./lib/version");
	const versionStr = GIT_COMMIT ? `v${APP_VERSION} (${GIT_COMMIT})` : `v${APP_VERSION}`;
	const modeStr = isProd ? "production" : "development";
	const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`;
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;105m⛏  NarraFork\x1b[0m ${versionStr}`);
	console.log(`  \x1b[2m➜\x1b[0m  ${url}`);
	console.log(`  \x1b[2m➜\x1b[0m  mode: ${modeStr}`);
	console.log("");

	if (IS_WINDOWS) {
		try {
			Bun.spawn(["cmd", "/c", "start", url], { stdio: ["ignore", "ignore", "ignore"] });
		} catch {
			// Failed to auto-open browser, not critical
		}
	}
}

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

// Initialize external MCP servers
mcpManager.onToolsChanged = () => syncMcpTools();
mcpManager
	.initialize()
	.then(() => {
		syncMcpTools();
	})
	.catch((err) => {
		logger.error("MCP server initialization failed", { error: String(err) });
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
	mcpManager.shutdown().catch(() => {});
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
