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
import { getRuntimeEnvironment } from "./lib/platform";
import { handleGracefullyShutdownRequest } from "./lib/server-restart";
import { settings } from "./lib/settings";
import { APP_VERSION, GIT_COMMIT } from "./lib/version";
import { requireAuth } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { anthropicRoutes } from "./routes/anthropic";
import { authRoutes } from "./routes/auth";
import { benchmarkRoutes } from "./routes/benchmarks";
import changelogRoutes from "./routes/changelog";
import chapterEdgeRoutes from "./routes/chapter-edges";
import { chapterRoutes } from "./routes/chapters";
import { chatGroupRoutes } from "./routes/chat-groups";
import { clineRoutes } from "./routes/cline";
import { codexRoutes } from "./routes/codex";
import { customSubagentRoutes } from "./routes/custom-subagents";
import { dependencyRoutes } from "./routes/dependencies";
import { favoriteRoutes } from "./routes/favorites";
import { fsRoutes } from "./routes/fs";
import { gatewayRoutes, handleWebhookRequest } from "./routes/gateway";
import { gitRoutes } from "./routes/git";
import { graphRoutes } from "./routes/graph";
import { hookRoutes } from "./routes/hooks";
import { knowledgeRoutes } from "./routes/knowledge";
import { knowledgePackRoutes } from "./routes/knowledge-packs";
import { learningRoutes } from "./routes/learning";
import { mcpRoutes } from "./routes/mcp";
import { narratorRoutes } from "./routes/narrators";
import { notificationSoundRoutes } from "./routes/notification-sounds";
import { notificationRoutes } from "./routes/notifications";
import { handleNugOAuthCallback, nugRoutes } from "./routes/nug";
import { openaiRoutes } from "./routes/openai";
import { projectDbRoutes } from "./routes/project-db";
import { projectRoutes } from "./routes/projects";
import { reviewsRouter } from "./routes/reviews";
import { routineRoutes } from "./routes/routines";
import { rulerRoutes } from "./routes/ruler";
import { runtimeRoutes } from "./routes/runtime";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { shareRoutes } from "./routes/shares";
import { skillRoutes } from "./routes/skills";
import { specRoutes } from "./routes/spec";
import { handleSsoCallback, ssoRoutes } from "./routes/sso";
import { storageRoutes } from "./routes/storage";
import { terminalRoutes } from "./routes/terminals";
import { updateRoutes } from "./routes/update";
import { uploadRoutes } from "./routes/uploads";
import usageHistoryRoutes from "./routes/usage-history";
import { userPreferencesRoutes } from "./routes/user-preferences";
import { vnetRoutes } from "./routes/vnet";
import { volumeSnapshotRoutes } from "./routes/volume-snapshots";
import { workspaceRoutes } from "./routes/workspaces";

const isCompiledBinary = import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/");
const hasFrontendBuild = existsSync(
	resolve(import.meta.dir, "..", "dist", "frontend", "index.html"),
);
const isProd = isCompiledBinary || process.env.NODE_ENV === "production" || hasFrontendBuild;

const app = new Hono();

const SLOW_API_REQUEST_MS = 1_000;

app.use(
	"/api/*",
	cors({
		origin: isProd ? `http://localhost:${settings.server.port}` : "http://localhost:5173",
	}),
);

app.use("/api/*", async (c, next) => {
	const startedAt = performance.now();
	try {
		await next();
	} finally {
		const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
		if (durationMs >= SLOW_API_REQUEST_MS) {
			logger.warn("Slow API request", {
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				durationMs,
			});
		}
	}
});

// Public routes (no auth required)
app.route("/api/auth", authRoutes);
// Dependency status is needed before login when Git is missing. Installing is
// still restricted to authenticated admins by the dependency route itself.
app.route("/api/dependencies", dependencyRoutes);
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
		runtimeEnvironment: getRuntimeEnvironment(),
	});
});

app.post("/api/gracefully_shutdown", async (c) => {
	let body: { token?: string; pid?: number; version?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		// Empty or invalid JSON falls through to token validation below.
	}

	const result = await handleGracefullyShutdownRequest({
		token: body.token ?? "",
		pid: body.pid,
		version: body.version,
	});
	return c.json(result.body, result.status);
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

// Public: gateway webhook endpoint (HMAC-verified, no JWT needed)
app.post("/api/gateway/webhook", async (c) => {
	return handleWebhookRequest(c);
});

// Public: NUG OAuth callback (state-verified, no JWT — browser redirect from external provider)
app.get("/api/nug/oauth/callback", handleNugOAuthCallback);

// Public: SSO/OIDC. The callback is a browser redirect from the IdP (no JWT);
// /providers, /:id/start and /exchange are public; /:id/link/start guards itself
// with an inline requireAuth. All must be mounted before the global auth gate.
app.get("/api/auth/sso/callback", handleSsoCallback);
app.route("/api/auth/sso", ssoRoutes);

// All routes below require authentication
app.use("/api/*", requireAuth);

// When git is not installed, only block routes that are known to execute git.
// Most settings, account, AI provider, standalone narrator, search, upload, and
// database-only routes should remain usable so first-time setup is not blocked by Git.
type GitRequiredRule = {
	methods?: readonly string[];
	pattern: RegExp;
};

const GIT_REQUIRED_RULES: readonly GitRequiredRule[] = [
	// Creating a project invokes git init/clone/repository detection.
	{ methods: ["POST"], pattern: /^\/api\/projects$/ },
	// Ruler/NarraFlow routes are backed by git log/rev-list/rebase operations.
	{ pattern: /^\/api\/projects\/[^/]+\/ruler(?:\/|$)/ },
	// Chapter lifecycle and merge operations create/remove branches and worktrees.
	{ methods: ["POST"], pattern: /^\/api\/chapters$/ },
	{ methods: ["DELETE"], pattern: /^\/api\/chapters\/[^/]+$/ },
	{ methods: ["POST"], pattern: /^\/api\/chapters\/(?:cleanup|batch-merge)$/ },
	{
		methods: ["GET", "POST"],
		pattern:
			/^\/api\/chapters\/[^/]+\/(?:fork|review|merge-check|merge|ai-resolve|unmerge|dormant|wake|git-status)(?:\/|$)/,
	},
	// Git panel endpoints are explicitly git-backed.
	{ pattern: /^\/api\/chapters\/[^/]+\/git(?:\/|$)/ },
	// Commit file diff endpoints need git diff-tree. Commit list/details can fall
	// back to database records, so they are intentionally not blocked here.
	{ methods: ["GET"], pattern: /^\/api\/chapters\/[^/]+\/commits\/[^/]+\/files(?:\/|$)/ },
];

function requiresGit(method: string, path: string): boolean {
	const upperMethod = method.toUpperCase();
	return GIT_REQUIRED_RULES.some((rule) => {
		if (rule.methods && !rule.methods.includes(upperMethod)) return false;
		return rule.pattern.test(path);
	});
}

app.use("/api/*", async (c, next) => {
	const path = c.req.path;
	if (!requiresGit(c.req.method, path)) return next();
	if (gitAvailable || recheckGit()) return next();
	return c.json(
		{
			error: "Git is not installed. Please install git and retry this Git-dependent action.",
			code: "GIT_NOT_INSTALLED",
		},
		503,
	);
});

app.route("/api/projects", projectRoutes);
app.route("/api/chapters", chapterRoutes);
app.route("/api/chapters", gitRoutes);
app.route("/api/chapter-edges", chapterEdgeRoutes);
app.route("/api/narrators", narratorRoutes);
app.route("/api/narrators", specRoutes);
app.route("/api/chat-groups", chatGroupRoutes);
app.route("/api/terminals", terminalRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/learning", learningRoutes);
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
app.route("/api/nug", nugRoutes);
app.route("/api/skills", skillRoutes);
app.route("/api/knowledge/packs", knowledgePackRoutes);
app.route("/api/knowledge", knowledgeRoutes);
app.route("/api/storage", storageRoutes);
app.route("/api/runtime", runtimeRoutes);
app.route("/api/custom-subagents", customSubagentRoutes);
app.route("/api/routines", routineRoutes);
app.route("/api/hooks", hookRoutes);
app.route("/api/reviews", reviewsRouter);
app.route("/api/update", updateRoutes);
app.route("/api/vnet", vnetRoutes);
app.route("/api/usage-history", usageHistoryRoutes);
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/benchmarks", benchmarkRoutes);

// IM Gateway management routes (status, sessions, etc.)
app.route("/api/gateway", gatewayRoutes);

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
