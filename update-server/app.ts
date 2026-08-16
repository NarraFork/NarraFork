/**
 * Hono application with all routes registered.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getConfig } from "./lib/config";
import { logger } from "./lib/logger";
import { createCheckRoutes } from "./routes/check";
import { createDownloadRoutes } from "./routes/download";
import { healthRoutes } from "./routes/health";
import { createReleaseRoutes } from "./routes/releases";
import { tokenRoutes } from "./routes/tokens";
import { createToolRoutes } from "./routes/tools";
import type { StorageBackend } from "./storage/types";

export function createApp(storage: StorageBackend): Hono {
	const app = new Hono();

	// CORS
	const config = getConfig();
	if (config.cors.enabled) {
		app.use(
			"*",
			cors({
				origin: config.cors.origins,
				allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
				allowHeaders: ["Authorization", "Content-Type"],
			}),
		);
	}

	// Request logging
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		const ms = Date.now() - start;
		logger.debug(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
	});

	// Health check
	app.route("/health", healthRoutes);

	// Public endpoints
	app.route("/api/v2/products", createCheckRoutes(storage));
	app.route("/api/v2/products", createDownloadRoutes(storage));

	// Tools endpoints — public download plus authenticated publish for helper
	// binaries (zstd, ripgrep, the remote executor and its manifest).
	app.route("/api/v2/tools", createToolRoutes(storage));

	// Authenticated endpoints
	app.route("/api/v2/products", createReleaseRoutes(storage));
	app.route("/api/v2/tokens", tokenRoutes);

	// Global error handler
	app.onError((err, c) => {
		logger.error("Unhandled error", { error: String(err), path: c.req.path });
		return c.json({ error: "Internal server error" }, 500);
	});

	// 404 fallback
	app.notFound((c) => {
		return c.json({ error: "Not found" }, 404);
	});

	return app;
}
