import { Hono } from "hono";
import { cors } from "hono/cors";
import { AppError } from "./lib/errors";
import { logger } from "./lib/logger";
import { settings } from "./lib/settings";
import { chapterRoutes } from "./routes/chapters";
import { narratorRoutes } from "./routes/narrators";
import { projectRoutes } from "./routes/projects";
import { settingsRoutes } from "./routes/settings";

const isProd = process.env.NODE_ENV === "production";

const app = new Hono();

app.use(
	"/api/*",
	cors({
		origin: isProd ? `http://localhost:${settings.server.port}` : "http://localhost:5173",
	}),
);

app.route("/api/projects", projectRoutes);
app.route("/api/chapters", chapterRoutes);
app.route("/api/narrators", narratorRoutes);
app.route("/api/settings", settingsRoutes);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.onError((err, c) => {
	if (err instanceof AppError) {
		return c.json({ error: err.message, code: err.code }, err.statusCode as any);
	}
	logger.error("Unhandled error", { error: String(err), stack: (err as Error).stack });
	return c.json({ error: "Internal server error" }, 500);
});

export { app };
