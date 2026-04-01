import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { count } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db";
import { users } from "./db/schema";
import { AppError } from "./lib/errors";
import { gitAvailable, recheckGit } from "./lib/git-status";
import { logger } from "./lib/logger";
import { settings } from "./lib/settings";
import { APP_VERSION, GIT_COMMIT } from "./lib/version";
import { requireAuth } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { anthropicRoutes } from "./routes/anthropic";
import { authRoutes } from "./routes/auth";
import changelogRoutes from "./routes/changelog";
import chapterEdgeRoutes from "./routes/chapter-edges";
import { chapterRoutes } from "./routes/chapters";
import { clineRoutes } from "./routes/cline";
import { codexRoutes } from "./routes/codex";
import { customSubagentRoutes } from "./routes/custom-subagents";
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
import { overseerRoutes } from "./routes/overseers";
import { projectDbRoutes } from "./routes/project-db";
import { projectRoutes } from "./routes/projects";
import { reviewsRouter } from "./routes/reviews";
import { routineRoutes } from "./routes/routines";
import { rulerRoutes } from "./routes/ruler";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { shareRoutes } from "./routes/shares";
import { skillRoutes } from "./routes/skills";
import { storageRoutes } from "./routes/storage";
import { terminalRoutes } from "./routes/terminals";
import { updateRoutes } from "./routes/update";
import { uploadRoutes } from "./routes/uploads";
import { userPreferencesRoutes } from "./routes/user-preferences";
import { volumeSnapshotRoutes } from "./routes/volume-snapshots";
import { workspaceRoutes } from "./routes/workspaces";

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
app.get("/api/health", (c) => {
	// Re-check git when it was previously unavailable so the frontend
	// "recheck" button works without a server restart.
	const gitOk = gitAvailable || recheckGit();
	return c.json({
		status: "ok",
		version: APP_VERSION,
		commit: GIT_COMMIT,
		platform:
			process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
		gitAvailable: gitOk,
	});
});

app.get("/api/auth/status", async (c) => {
	const [{ value: userCount }] = await db.select({ value: count() }).from(users);
	return c.json({
		hasUsers: userCount > 0,
		registrationOpen: settings.auth.registrationOpen,
	});
});

// Public: share download links (no auth — the share ID itself is the secret)
app.route("/api/shares", shareRoutes);

// Public: changelog (no sensitive data)
app.route("/api/changelog", changelogRoutes);

// All routes below require authentication
app.use("/api/*", requireAuth);

// When git is not installed, block routes that depend on git operations.
// Configuration / provider / notification routes remain accessible so the
// frontend can still render the "install git" dialog and settings pages.
const GIT_FREE_PREFIXES = [
	"/api/settings",
	"/api/admin",
	"/api/storage",
	"/api/user-preferences",
	"/api/notification",
	"/api/update",
	"/api/routines",
	"/api/skills",
	"/api/custom-subagents",
	"/api/openai",
	"/api/codex",
	"/api/cline",
	"/api/anthropic",
];
app.use("/api/*", async (c, next) => {
	if (gitAvailable) return next();
	const path = c.req.path;
	if (GIT_FREE_PREFIXES.some((p) => path.startsWith(p))) return next();
	return c.json({ error: "Git is not installed. Please install git and restart NarraFork." }, 503);
});

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
app.route("/api/cline", clineRoutes);
app.route("/api/anthropic", anthropicRoutes);
app.route("/api/skills", skillRoutes);
app.route("/api/storage", storageRoutes);
app.route("/api/custom-subagents", customSubagentRoutes);
app.route("/api/routines", routineRoutes);
app.route("/api/reviews", reviewsRouter);
app.route("/api/overseers", overseerRoutes);
app.route("/api/update", updateRoutes);
app.route("/api/workspaces", workspaceRoutes);

// Graph routes are nested under projects for RESTful consistency
app.route("/api/projects", graphRoutes);
// Ruler routes (new NarraFlow) nested under projects
app.route("/api/projects", rulerRoutes);
// Project DB backup/import routes
app.route("/api/projects", projectDbRoutes);
// Volume snapshot routes (nested under projects for list/create, standalone for single-item ops)
app.route("/api/projects", volumeSnapshotRoutes);
app.route("/api/volume-snapshots", volumeSnapshotRoutes);

app.onError((err, c) => {
	if (err instanceof AppError) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		return c.json({ error: err.message, code: err.code }, err.statusCode as any);
	}
	logger.error("Unhandled error", { error: String(err), stack: (err as Error).stack });
	return c.json({ error: "Internal server error" }, 500);
});

export { app };
