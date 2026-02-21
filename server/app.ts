import { count } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db";
import { users } from "./db/schema";
import { AppError } from "./lib/errors";
import { logger } from "./lib/logger";
import { settings } from "./lib/settings";
import { requireAuth } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { chapterRoutes } from "./routes/chapters";
import { favoriteRoutes } from "./routes/favorites";
import { graphRoutes } from "./routes/graph";
import { mcpRoutes } from "./routes/mcp";
import { narratorRoutes } from "./routes/narrators";
import { projectRoutes } from "./routes/projects";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { terminalRoutes } from "./routes/terminals";
import { uploadRoutes } from "./routes/uploads";
import { userPreferencesRoutes } from "./routes/user-preferences";

const isProd = process.env.NODE_ENV === "production";

const app = new Hono();

app.use(
	"/api/*",
	cors({
		origin: isProd ? `http://localhost:${settings.server.port}` : "http://localhost:5173",
	}),
);

// Public routes (no auth required)
app.route("/api/auth", authRoutes);
app.get("/api/health", (c) => c.json({ status: "ok" }));

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
app.route("/api/narrators", narratorRoutes);
app.route("/api/terminals", terminalRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/favorites", favoriteRoutes);
app.route("/api/user-preferences", userPreferencesRoutes);

// Graph routes are nested under projects for RESTful consistency
app.route("/api/projects", graphRoutes);

app.onError((err, c) => {
	if (err instanceof AppError) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		return c.json({ error: err.message, code: err.code }, err.statusCode as any);
	}
	logger.error("Unhandled error", { error: String(err), stack: (err as Error).stack });
	return c.json({ error: "Internal server error" }, 500);
});

export { app };
