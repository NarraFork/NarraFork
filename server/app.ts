import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { count } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db";
import { users } from "./db/schema";
import { AppError } from "./lib/errors";
import { logger } from "./lib/logger";
import { settings } from "./lib/settings";
import { APP_VERSION, GIT_COMMIT } from "./lib/version";
import { requireAuth } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { anthropicRoutes } from "./routes/anthropic";
import { authRoutes } from "./routes/auth";
import chapterEdgeRoutes from "./routes/chapter-edges";
import { chapterRoutes } from "./routes/chapters";
import { codexRoutes } from "./routes/codex";
import { dependencyRoutes } from "./routes/dependencies";
import { favoriteRoutes } from "./routes/favorites";
import { fsRoutes } from "./routes/fs";
import { gitRoutes } from "./routes/git";
import { graphRoutes } from "./routes/graph";
import { mcpRoutes } from "./routes/mcp";
import { narratorRoutes } from "./routes/narrators";
import { notificationSoundRoutes } from "./routes/notification-sounds";
import { notificationRoutes } from "./routes/notifications";
import { openaiRoutes } from "./routes/openai";
import { projectDbRoutes } from "./routes/project-db";
import { projectRoutes } from "./routes/projects";
import { reviewsRouter } from "./routes/reviews";
import { routineRoutes } from "./routes/routines";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { skillRoutes } from "./routes/skills";
import { terminalRoutes } from "./routes/terminals";
import { uploadRoutes } from "./routes/uploads";
import { userPreferencesRoutes } from "./routes/user-preferences";

const isCompiledBinary = import.meta.url.startsWith("file:///$bunfs/");
const hasFrontendBuild = existsSync(
	resolve(import.meta.dir, "..", "dist", "frontend", "index.html"),
);
const isProd = isCompiledBinary || process.env.NODE_ENV === "production" || hasFrontendBuild;

const app = new Hono();

app.use(
	"/api/*",
	cors({
		origin: isProd ? `http://localhost:${settings.server.port}` : "http://localhost:5173",
	}),
);

// Public routes (no auth required)
app.route("/api/auth", authRoutes);
app.get("/api/health", (c) =>
	c.json({
		status: "ok",
		version: APP_VERSION,
		commit: GIT_COMMIT,
		platform:
			process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
	}),
);

app.get("/api/auth/status", async (c) => {
	const [{ value: userCount }] = await db.select({ value: count() }).from(users);
	return c.json({
		hasUsers: userCount > 0,
		registrationOpen: settings.auth.registrationOpen,
	});
});

// All routes below require authentication
app.use("/api/*", requireAuth);

app.route("/api/projects", projectRoutes);
app.route("/api/chapters", chapterRoutes);
app.route("/api/chapters", gitRoutes);
app.route("/api/chapter-edges", chapterEdgeRoutes);
app.route("/api/narrators", narratorRoutes);
app.route("/api/terminals", terminalRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/dependencies", dependencyRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/favorites", favoriteRoutes);
app.route("/api/fs", fsRoutes);
app.route("/api/user-preferences", userPreferencesRoutes);
app.route("/api/notification-sounds", notificationSoundRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/openai", openaiRoutes);
app.route("/api/codex", codexRoutes);
app.route("/api/anthropic", anthropicRoutes);
app.route("/api/skills", skillRoutes);
app.route("/api/routines", routineRoutes);
app.route("/api/reviews", reviewsRouter);

// Graph routes are nested under projects for RESTful consistency
app.route("/api/projects", graphRoutes);
// Project DB backup/import routes
app.route("/api/projects", projectDbRoutes);

app.onError((err, c) => {
	if (err instanceof AppError) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		return c.json({ error: err.message, code: err.code }, err.statusCode as any);
	}
	logger.error("Unhandled error", { error: String(err), stack: (err as Error).stack });
	return c.json({ error: "Internal server error" }, 500);
});

export { app };
