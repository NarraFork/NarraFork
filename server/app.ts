import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SESSION_RENEWAL_HEADER } from "@shared/session-auth";
import { count } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db";
import { users } from "./db/schema";
import { buildAppErrorResponse } from "./lib/app-error-response";
import { gitAvailable, recheckGit } from "./lib/git-status";
import { logger } from "./lib/logger";
import { getRuntimeEnvironment } from "./lib/platform";
import { handleGracefullyShutdownRequest } from "./lib/server-restart";
import { settings } from "./lib/settings";
import { APP_VERSION, GIT_COMMIT } from "./lib/version";
import { requireSessionAuth } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { anthropicRoutes } from "./routes/anthropic";
import { authRoutes } from "./routes/auth";
import { benchmarkRoutes } from "./routes/benchmarks";
import changelogRoutes from "./routes/changelog";
import chapterEdgeRoutes from "./routes/chapter-edges";
import { chapterRoutes } from "./routes/chapters";
import { chatRoutes } from "./routes/chat";
import { clineRoutes } from "./routes/cline";
import { codexRoutes } from "./routes/codex";
import { customSubagentRoutes } from "./routes/custom-subagents";
import { dashboardRoutes } from "./routes/dashboard";
import { dependencyRoutes } from "./routes/dependencies";
import { deviceRoutes } from "./routes/devices";
import executionLogRoutes from "./routes/execution-log";
import { executorBootstrapRoutes } from "./routes/executor-bootstrap";
import { externalV1Routes } from "./routes/external-v1";
import { favoriteRoutes } from "./routes/favorites";
import { fsRoutes } from "./routes/fs";
import { gatewayRoutes, handleWebhookRequest } from "./routes/gateway";
import { geminiRoutes } from "./routes/gemini";
import { gitRoutes } from "./routes/git";
import { graphRoutes } from "./routes/graph";
import { hookRoutes } from "./routes/hooks";
import { integrationRoutes } from "./routes/integrations";
import { knowledgeRoutes } from "./routes/knowledge";
import { knowledgePackRoutes } from "./routes/knowledge-packs";
import { learningRoutes } from "./routes/learning";
import licenseRoutes from "./routes/licenses";
import { mcpRoutes } from "./routes/mcp";
import { modelCardRoutes } from "./routes/model-cards";
import { narratorRoutes } from "./routes/narrators";
import { notificationSoundRoutes } from "./routes/notification-sounds";
import { notificationRoutes } from "./routes/notifications";
import { handleNugOAuthCallback, nugRoutes } from "./routes/nug";
import { oauthRoutes } from "./routes/oauth";
import { oauthAppRoutes } from "./routes/oauth-apps";
import { oauthGrantRoutes } from "./routes/oauth-grants";
import { openaiRoutes } from "./routes/openai";
import { pluginUiRoutes } from "./routes/plugin-ui";
import { pluginRoutes } from "./routes/plugins";
import { projectDbRoutes } from "./routes/project-db";
import { projectRoutes } from "./routes/projects";
import { reviewsRouter } from "./routes/reviews";
import { routineRoutes } from "./routes/routines";
import { rulerRoutes } from "./routes/ruler";
import { runtimeRoutes } from "./routes/runtime";
import { scheduledTaskRoutes } from "./routes/scheduled-tasks";
import { searchRoutes } from "./routes/search";
import { settingsRoutes } from "./routes/settings";
import { shareRoutes } from "./routes/shares";
import { skillRoutes } from "./routes/skills";
import { specRoutes } from "./routes/spec";
import { handleSsoCallback, ssoRoutes } from "./routes/sso";
import { storageRoutes } from "./routes/storage";
import { terminalRoutes } from "./routes/terminals";
import { tlsRoutes } from "./routes/tls";
import { traitLayerRoutes } from "./routes/trait-layers";
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

export interface AppEnv {
	Bindings: {
		clientIp?: string;
		trustedProxy?: boolean;
	};
}

const app = new Hono<AppEnv>();

const SLOW_API_REQUEST_MS = 1_000;

app.use(
	"/api/*",
	cors({
		origin: isProd ? `http://localhost:${settings.server.port}` : "http://localhost:5173",
		// The sliding-renewal token rides on a custom response header, which is
		// invisible to cross-origin readers unless explicitly exposed.
		exposeHeaders: [SESSION_RENEWAL_HEADER],
	}),
);

// A 401 must never carry a renewed session token. Auth middleware sets the
// header before the route runs, so a later 401 (a failed second factor, an
// OAuth-only boundary, a vanished user) would otherwise ship a fresh credential
// alongside the rejection — and the client would race between storing it and
// clearing the session it belongs to.
app.use("/api/*", async (c, next) => {
	await next();
	if (c.res.status === 401) {
		// `c.header(name, undefined)` is the supported delete path and also handles
		// an already-finalized response.
		c.header(SESSION_RENEWAL_HEADER, undefined);
	}
});

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

// Public: third-party license attribution. Required to reach whoever receives the
// software, and /licenses is linked from the login page.
app.route("/api/licenses", licenseRoutes);

// Public: remote executor binary download. A machine being enrolled has no
// session yet, so this authorizes with a single-use, platform-bound ticket
// issued from the admin-only device settings page.
app.route("/api/executor", executorBootstrapRoutes);

// Public: gateway webhook endpoint (HMAC-verified, no JWT needed)
app.post("/api/gateway/webhook", async (c) => {
	return handleWebhookRequest(c);
});

// Public: NUG OAuth callback (state-verified, no JWT — browser redirect from external provider)
app.get("/api/nug/oauth/callback", handleNugOAuthCallback);

// Public: SSO/OIDC. The callback is a browser redirect from the IdP (no JWT);
// /providers, /:id/start and /exchange are public; /:id/link/start guards itself
// with an inline session-only check. All must be mounted before the global auth gate.
app.get("/api/auth/sso/callback", handleSsoCallback);
app.route("/api/auth/sso", ssoRoutes);

// Plugin UI asset/shell routes use short-lived, session-bound capabilities; control
// endpoints inside pluginUiRoutes still apply session-only authentication explicitly.
app.route("/api/plugins", pluginUiRoutes);

// Public: OAuth 2.0 provider endpoints. NarraFork is the authorization server
// here — external apps fetch metadata, exchange codes and revoke tokens without
// a NarraFork session. Consent explicitly requires a first-party session.
app.route("/api/oauth", oauthRoutes);

// Versioned external resource facade. It is mounted before the session-only gate,
// but the router itself requires an OAuth principal and enforces scope + resource ownership.
app.route("/api/external/v1", externalV1Routes);

// All ordinary routes below require a first-party session. OAuth access tokens
// must opt into an explicitly mounted external route and can never fall through
// to the internal UI/API surface.
app.use("/api/*", requireSessionAuth);

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
app.route("/api/chat", chatRoutes);
app.route("/api/narrators", narratorRoutes);
app.route("/api/narrators", specRoutes);
app.route("/api/terminals", terminalRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/settings/tls", tlsRoutes);
app.route("/api/learning", learningRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/model-cards", modelCardRoutes);
app.route("/api/plugins", pluginRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/favorites", favoriteRoutes);
app.route("/api/devices", deviceRoutes);
// Project/user trait layers. Narrator-level traits live under /api/narrators.
app.route("/api/trait-layers", traitLayerRoutes);
app.route("/api/integrations", integrationRoutes);
app.route("/api/oauth-apps", oauthAppRoutes);
app.route("/api/oauth/grants", oauthGrantRoutes);
app.route("/api/fs", fsRoutes);
app.route("/api/user-preferences", userPreferencesRoutes);
app.route("/api/notification-sounds", notificationSoundRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/openai", openaiRoutes);
app.route("/api/codex", codexRoutes);
app.route("/api/cline", clineRoutes);
app.route("/api/gemini", geminiRoutes);
app.route("/api/anthropic", anthropicRoutes);
app.route("/api/nug", nugRoutes);
app.route("/api/skills", skillRoutes);
app.route("/api/knowledge/packs", knowledgePackRoutes);
app.route("/api/knowledge", knowledgeRoutes);
app.route("/api/storage", storageRoutes);
app.route("/api/runtime", runtimeRoutes);
app.route("/api/custom-subagents", customSubagentRoutes);
app.route("/api/routines", routineRoutes);
app.route("/api/scheduled-tasks", scheduledTaskRoutes);
app.route("/api/hooks", hookRoutes);
app.route("/api/reviews", reviewsRouter);
app.route("/api/update", updateRoutes);
app.route("/api/vnet", vnetRoutes);
app.route("/api/usage-history", usageHistoryRoutes);
app.route("/api/execution-log", executionLogRoutes);
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/benchmarks", benchmarkRoutes);
app.route("/api/dashboard", dashboardRoutes);

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
	const knownErrorResponse = buildAppErrorResponse(err, c);
	if (knownErrorResponse) return knownErrorResponse;
	logger.error("Unhandled error", { error: String(err), stack: (err as Error).stack });
	return c.json({ error: "Internal server error" }, 500);
});

export { app };
