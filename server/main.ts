import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, rmSync } from "node:fs";
import { extname, resolve } from "node:path";
import { eq } from "drizzle-orm";

// Relative rather than `@frontend/*`: `bun build` (used for the compiled binary) does not
// resolve the tsconfig alias, and this module is dependency-free string constants, so it adds
// nothing but the literals to the server bundle.
import {
	PLUGIN_UI_RUNTIME_CSS_URL,
	PLUGIN_UI_RUNTIME_JS_URL,
} from "../frontend/plugin-runtime/paths";
import { CHROMIUM_PATHS } from "../shared/browser-paths";
import { urlHost } from "../shared/server-host";
import { MAX_IMPORT_BYTES } from "../shared/storage-transfer";
import { app } from "./app";
import "./db"; // Ensure DB is initialized early
import {
	activeDatabaseBackend,
	closePostgresRuntime,
	db,
	markDatabaseCleanShutdown,
	postgresRuntime,
	releaseDatabaseInstanceLockOnly,
	startupShutdownState,
} from "./db";
import {
	cancelBackgroundIntegrityCheck,
	scheduleBackgroundIntegrityCheck,
} from "./db/integrity-check";
import { users } from "./db/schema";
import { registerExternalProviderResolver } from "./lib/agent/provider";
import { verifyToken } from "./lib/auth";
import { isTrustedProxyAddress, resolveClientIp } from "./lib/client-ip";
import { getCodexManager } from "./lib/codex-manager";
import { inspectApplicationDataDirectory } from "./lib/data-directory-security";
import { shutdownDbWorkerPool } from "./lib/db-worker/pool";
import { resolveAdvertisedAppUrl } from "./lib/dev-app-url";
import { startEventLoopMonitor } from "./lib/event-loop-monitor";
import { rebindHttpListener } from "./lib/http-listener-rebind";
import { logger } from "./lib/logger";
import {
	createManagerRebindCoordinator,
	isListenerPortConflict,
	resolveManagerListenHost,
	startManagerListenerGroup,
} from "./lib/manager-control-server";
import { readManagerToken } from "./lib/manager-token";
import { mcpManager } from "./lib/mcp/manager";
import { syncMcpTools } from "./lib/mcp/tool-bridge";
import { getNarraforkHome, getNarraforkPath } from "./lib/narrafork-home";
import { listenWithLanFallback, resolveListenHost } from "./lib/net/listen-host";
import { reconcileNugRelayClients } from "./lib/nug-relay/manager";
import { validateAccessTokenById } from "./lib/oauth-provider";
import { IS_MACOS, IS_WINDOWS, initWslFlag } from "./lib/platform";
import { isProviderUnavailableError } from "./lib/provider-availability-error";
import {
	registerGracefulShutdownHandler,
	registerOperatorShutdownHandler,
	registerRuntimeAddressGetter,
	registerServerRestart,
} from "./lib/server-restart";
import { reloadSettings, reloadSettingsIfChanged, settings } from "./lib/settings";
import { startServerAddressWatcher } from "./lib/settings-address-watcher";
import { startSettingsFileWatcher } from "./lib/settings-file-watcher";
import { shellExecute } from "./lib/shell-exec";
import { preservesRecoveryOnShutdown, ShutdownActivityTracker } from "./lib/shutdown-activity";
import { injectSpaBaseHref, spaIndexHeaders } from "./lib/spa-base-href";
import {
	buildHealthPayload,
	createStartupReadinessGate,
	healthStatusCode,
	shouldServeRequests,
	shouldStartGatedBackgroundWork,
} from "./lib/startup-readiness";
import type { VNetRelayAuth } from "./lib/vnet/types";
import { startVNetUdpRendezvous, stopVNetUdpRendezvous } from "./lib/vnet/udp-rendezvous";
import { clearInheritableHandlesAfterServerBind } from "./lib/win-handle-guard";
import {
	findExcludingRange,
	formatPortRanges,
	NETSH_EXCLUDED_PORT_COMMAND,
	nextAllowedPort,
	readWindowsExcludedPortRanges,
} from "./lib/windows-excluded-ports";
import { pluginManager } from "./services/plugin-manager";
import { pluginPlatformServices } from "./services/plugin-platform-services";
import { listPluginProviderReadiness } from "./services/plugin-provider-readiness";
import { pluginProviderRegistry } from "./services/plugin-provider-registry";
import {
	activatePostgresRuntimeQueue,
	composePostgresStores,
} from "./services/postgres-composition";
import { ensureAllRecentTabsMigrated } from "./services/recent-tabs-service";

// Parse --wsl=true|false CLI flag (default: false — WSL disallowed)
initWslFlag();

import {
	backgroundOccupancyInitializer,
	withBackgroundOccupancyInitialization,
} from "./services/background-occupancy-startup";
import { ensureRootlessEnv } from "./services/container-service";
import { retireLegacyChapterResources } from "./services/legacy-chapter-resource-cleanup";
import {
	failUnownedStartupRecovery,
	recoverOnStartup as recoverNarrators,
	recoverPendingQuestionAnswerDeliveries,
	restorePendingModelOverrides,
} from "./services/narrator-session";
import { scheduleProjectIndexRebuild } from "./services/project-index";
import "./services/notification-service"; // Register notification event listeners
import {
	startNotificationCenterMaintenance,
	stopNotificationCenterMaintenance,
} from "./services/notification-center-maintenance";
import { initNotificationFanout, stopNotificationFanout } from "./services/notification-fanout";
import "./services/attention-hook-bridge"; // Bridge attention events into the hook system
import { killAllBashProcesses } from "./lib/agent/tools/bash";
import { initChatNotify } from "./services/chat-notify";
import { initDeviceConnectionService } from "./services/device-connection-service";
import { initDeviceTransferService } from "./services/device-transfer-service";
import { backfillIntegrationResourceBindingsOnStartup } from "./services/integration-resource-binding-service";
import { initKnowledgeNotify } from "./services/knowledge-notify";
import { materializeLegacyDelegations } from "./services/legacy-delegation-materializer";
import { backfillOAuthGrantAuthoritiesOnStartup } from "./services/oauth-grant-service";
import {
	consumeOAuthWsTicket,
	EXTERNAL_NARRATORS_WS_CHANNEL,
	getExternalWebSocketRolloutSettings,
	isExternalWebSocketOriginAllowed,
} from "./services/oauth-ws-ticket-service";
import { recoverProviderPrefixMigrationOnStartup } from "./services/provider-prefix-migration-service";
import { publicShareConnectionBudget } from "./services/public-narrator-share-connections";
import {
	type VerifiedPublicShare,
	verifyPublicShare,
} from "./services/public-narrator-share-service";
import { beginRecoveryDiscovery, finishRecoveryDiscovery } from "./services/recovery-handoff";
import {
	automaticResumeEnabled,
	mergeStartupProtection,
	prepareOrdinaryRestartRecovery,
	prepareSignalRestartRecovery,
	restoreOrdinaryRestartRecovery,
} from "./services/restart-recovery-service";
import { terminalService } from "./services/terminal-service";
import {
	getPlannedUpdateStartupProtection,
	restoreNarratorsAfterPlannedUpdate,
} from "./services/update-recovery-service";
import { canAcceptExternalNarratorConnection } from "./websocket/oauth-connection-registry";
import {
	closeAllConnections,
	narratorWebSocketBackendRefusal,
	resolveExternalNarratorWSData,
	resolveWSData,
	startHeartbeat,
	stopHeartbeat,
	type WSData,
	waitForWebSocketActivityDrain,
	wsHandlers,
} from "./websocket/ws-handler";

// Startup ownership must be classified before a new shutdown/update may allocate
// an epoch. This is separate from long-running recovery terminal completion.
beginRecoveryDiscovery();

// Builtin/compatible-API providers are resolved first. Only an unregistered plugin
// prefix may decline here; preserve registered providers' actual failure reasons.
const unregisterExternalProviderResolver = registerExternalProviderResolver({
	resolve: (provider, model) => pluginProviderRegistry.resolveExternalProvider(provider, model),
	listReadiness: (signal) =>
		listPluginProviderReadiness(
			pluginProviderRegistry,
			pluginPlatformServices.providerConfigService,
			signal,
		),
});

// Resolve any interrupted cross-store provider prefix migration before accepting requests.
// A mismatched journal intentionally fails startup rather than serving mixed model references.
recoverProviderPrefixMigrationOnStartup();

// When the PostgreSQL backend is active, inject every PG-capable store from the single
// composition seam — one runtime, one client, all-or-nothing. `./db` has already finished
// the fail-fast runtime startup (connect → migrate → FTS) by the time this body runs.
if (postgresRuntime) {
	composePostgresStores(postgresRuntime);
	// Queue activation is a startup GATE, awaited before Bun.serve() accepts work: the
	// information_schema probe and the insert_seq boundary capture run exactly once,
	// here, after the full migration journal. Missing columns, cancellation or a
	// timeout fail the process closed with a diagnosable error — the request hot path
	// never re-probes the catalog, and there is no SQLite fallback.
	await activatePostgresRuntimeQueue();
}

// Ordinary cold continuation recovery requires strict single-instance provenance.
// Register it directly, independently of file history and workspace writes.
if (activeDatabaseBackend === "sqlite") {
	try {
		const { initializeInstanceLockProcessIdentity } = await import("./lib/instance-lock");
		await initializeInstanceLockProcessIdentity();
	} catch (error) {
		logger.warn("Strict instance identity unavailable for cold continuation recovery", {
			error: String(error),
		});
	}
}

// Track event-loop stalls early so blocking operations are visible in logs/diagnostics.
startEventLoopMonitor();

// Diagnose old-install permissions before the first tool call, without blocking
// HTTP/login or the administrator's repair UI. This reads directory metadata only.
void inspectApplicationDataDirectory(getNarraforkHome())
	.then((status) => {
		// "unknown" means the probe did not finish, not that permissions are wrong;
		// logging it as a fault sends operators to inspect a healthy directory.
		if (status.status === "unknown") {
			logger.info("Application data directory check was inconclusive", {
				canRepair: status.canRepair,
				...status.details,
			});
		} else if (status.status !== "ok") {
			logger.warn("Application data directory needs attention; check Settings > Storage", {
				status: status.status,
				canRepair: status.canRepair,
				...status.details,
			});
		}
	})
	.catch((error) => {
		logger.warn("Application data directory preflight failed", { error: String(error) });
	});

// Set rootless podman env vars early so all child processes inherit them
ensureRootlessEnv();

// Verify git is available — it's a hard requirement for NarraFork
// Instead of process.exit(1), we set a global flag so the frontend can show a user-friendly dialog
// (especially important on Windows where console output is invisible).
import { setGitStatus } from "./lib/git-status";
import { refreshWindowsPath } from "./lib/win-env";

{
	let _gitAvailable = false;
	let _gitVersion = "";
	try {
		const gitCheck = Bun.spawnSync(["git", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
			// GUI 模式（管理器托管的后端）下不隐藏会闪出控制台窗口。
			windowsHide: true,
		});
		if (gitCheck.exitCode === 0) {
			_gitAvailable = true;
			_gitVersion = new TextDecoder().decode(gitCheck.stdout).trim();
		}
	} catch {
		// ENOENT — git binary not found
	}
	// On Windows the inherited PATH may be stale (parent shell / Explorer
	// hasn't picked up registry changes from a recent git install).
	// Refresh PATH from the registry and retry.
	if (!_gitAvailable) {
		if (refreshWindowsPath()) {
			try {
				const retry = Bun.spawnSync(["git", "--version"], {
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
				if (retry.exitCode === 0) {
					_gitAvailable = true;
					_gitVersion = new TextDecoder().decode(retry.stdout).trim();
				}
			} catch {
				// still not found
			}
		}
	}
	setGitStatus(_gitAvailable, _gitVersion);
	if (!_gitAvailable) {
		logger.error("git is not available. NarraFork requires git to be installed and in PATH.");
		console.error(
			"\x1b[31mError: git is not available.\x1b[0m\n" +
				"NarraFork requires git to be installed and available in your system PATH.\n" +
				"Please install git and try again: https://git-scm.com/downloads\n" +
				"The server will continue running so the frontend can display an installation guide.",
		);
	} else {
		logger.info(`Git detected: ${_gitVersion}`);
	}
}

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
let configuredHost = cliHost || process.env.HOST || settings.server.host;
let configuredPort = port;
let currentHost = await resolveManagerListenHost(
	resolveListenHost(configuredHost),
	readManagerToken(),
);
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
	".mjs": "text/javascript; charset=utf-8",
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

const NO_CACHE_FRONTEND_PATHS = new Set([
	"/index.html",
	"/src-sw.js",
	"/registerSW.js",
	"/manifest.webmanifest",
	// The plugin UI runtime ships at fixed, UNHASHED paths (the iframe shell references them
	// by constant), so the filename cannot signal a new version. Without these entries the
	// default `max-age=3600` below would keep serving the previous runtime for up to an hour
	// after a host upgrade, while freshly loaded plugin panels expect the new
	// `PLUGIN_UI_RUNTIME_VERSION` — surfacing as HostRuntimeUnavailableError in the panel.
	PLUGIN_UI_RUNTIME_JS_URL,
	PLUGIN_UI_RUNTIME_CSS_URL,
	// Brand assets sit at fixed paths whose MEANING changes when an admin edits the
	// instance icon colour: index.html swings its <link rel="icon"> between these
	// static defaults and /api/branding/*. The bytes here never change, so
	// revalidation is cheap (a 304), but the default `max-age=3600` would delay a
	// brand change by up to an hour with no signal that anything was stale.
	"/favicon.svg",
	"/apple-touch-icon-180x180.png",
	"/pwa-192x192.png",
	"/pwa-512x512.png",
]);

function getFrontendCacheControl(path: string): string {
	if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
	if (NO_CACHE_FRONTEND_PATHS.has(path)) return "no-cache";
	return "public, max-age=3600";
}

/**
 * Answer a SPA navigation with `index.html`, corrected for the mount prefix.
 *
 * Shared by BOTH static-serving branches below (embedded assets in a compiled binary,
 * filesystem in a source run) for the same reason `serveBrandedManifest` is: handling
 * only one would make the app work in dev and silently break in the shipped binary —
 * or the reverse. Here the failure is total (the entry script 404s, so no client code
 * runs at all) and has no client-side recovery path, which is precisely why it must be
 * impossible to fix only half of it.
 *
 * The response body is read into memory rather than streamed because the `<base href>`
 * has to be rewritten. `index.html` is a few KB, and this path is already `no-cache`,
 * so there is no bulk-read hazard here.
 */
async function serveSpaIndex(indexFile: Bun.BunFile, requestPath: string): Promise<Response> {
	const html = injectSpaBaseHref(await indexFile.text(), requestPath);
	return new Response(html, {
		headers: spaIndexHeaders(requestPath),
	});
}

/**
 * Serve the web manifest with the instance name and icons substituted in.
 *
 * Installed as a shared helper because BOTH static-serving branches below
 * (embedded assets in a compiled binary, filesystem in a source run) have to route
 * through it. Handling only one would make branding work in dev and silently stop
 * working in the shipped binary — or the reverse — with no error either way.
 *
 * Returns null when the request is not for the manifest, so callers can fall
 * through to their normal asset handling.
 */
async function serveBrandedManifest(path: string, staticPath: string): Promise<Response | null> {
	if (path !== "/manifest.webmanifest") return null;
	try {
		const file = Bun.file(staticPath);
		if (!(await file.exists())) return null;
		const { brandManifestJson } = await import("./lib/branding");
		return new Response(brandManifestJson(await file.text(), settings), {
			headers: {
				"Content-Type": MIME_TYPES[".webmanifest"],
				"Cache-Control": "no-cache",
			},
		});
	} catch (err) {
		// Fall back to the static manifest rather than failing the request: an
		// unbranded manifest still installs correctly.
		logger.warn("Failed to serve branded web manifest", { error: String(err) });
		return null;
	}
}

// Production: serve Vite build output via Hono
if (isProd) {
	// Try embedded assets only for compiled single-executable mode. Source runs
	// (`bun run start`) should serve dist/frontend from disk so a later
	// `bun run build` with new hashed asset names is visible without restart.
	let hasEmbedded = false;
	if (isCompiledBinary) {
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
						const branded = await serveBrandedManifest(c.req.path, filePath);
						if (branded) return branded;
						const blob = Bun.file(filePath);
						const mime = MIME_TYPES[extname(c.req.path)] ?? "application/octet-stream";
						return new Response(blob, {
							headers: {
								"Content-Type": mime,
								"Cache-Control": getFrontendCacheControl(c.req.path),
							},
						});
					}

					// SPA catch-all: serve index.html for non-file routes
					if (!c.req.path.includes(".")) {
						return serveSpaIndex(Bun.file(indexPath), c.req.path);
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
	}

	// Fallback: serve from filesystem (bundle mode or bun run start)
	if (!hasEmbedded) {
		const staticDir = resolve(import.meta.dir, "..", "dist", "frontend");
		logger.info(
			`Static file serving: filesystem mode, dir=${staticDir}, exists=${existsSync(staticDir)}`,
		);
		// Serve all static files from dist/frontend via a single middleware.
		// Install this even when dist/frontend is currently missing so a later
		// `bun run build` becomes visible to this running process.
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

			const branded = await serveBrandedManifest(c.req.path, filePath);
			if (branded) return branded;

			const file = Bun.file(filePath);
			if (await file.exists()) {
				const ext = extname(c.req.path);
				const mime = MIME_TYPES[ext] ?? "application/octet-stream";
				return new Response(file, {
					headers: {
						"Content-Type": mime,
						"Cache-Control": getFrontendCacheControl(c.req.path),
					},
				});
			}

			// SPA catch-all: serve index.html for non-file routes
			if (!c.req.path.includes(".")) {
				const indexFile = Bun.file(resolve(staticDir, "index.html"));
				if (await indexFile.exists()) {
					return serveSpaIndex(indexFile, c.req.path);
				}
			}

			return next();
		});
	}
}

// ── Windows: forcefully reclaim port from stale TCP connections ──────────────
// Bun on Windows has known issues where the port isn't released after a crash
// or unclean shutdown (see oven-sh/bun#12127, #18003, #26049).  Even after the
// owning process exits, the port can remain in LISTENING state — netstat shows
// a PID but taskkill says "process not found".  This is the Windows "ghost
// port" problem: the original process is gone, but a related process (often
// conhost.exe) still holds the inherited socket handle.
//
// Strategy: try to kill the PID from netstat.  If it's already gone, trace the
// process tree via wmic to find the real handle holder and kill that.
type WindowsProcessInfo = {
	pid: number;
	caption: string;
	commandLine: string;
	depth?: number;
};

function parseWmicProcessCsv(output: string): WindowsProcessInfo[] {
	const processes: WindowsProcessInfo[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("Node,")) continue;
		const cols = trimmed.split(",");
		if (cols.length < 4) continue;
		const pid = Number.parseInt(cols[cols.length - 1] ?? "", 10);
		if (!pid) continue;
		processes.push({
			pid,
			caption: cols[1]?.trim() ?? "",
			commandLine: cols.slice(2, -1).join(",").trim(),
		});
	}
	return processes;
}

function tryReclaimPort(targetPort: number): void {
	if (!IS_WINDOWS) return;
	try {
		// netstat -ano gives lines like:
		//   TCP    0.0.0.0:7778           0.0.0.0:0              LISTENING       12345
		//   TCP    [::]:7778              [::]:0                 LISTENING       12345
		const result = Bun.spawnSync(["netstat", "-ano"], {
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
		if (result.exitCode !== 0) return;
		const output = new TextDecoder().decode(result.stdout);
		const listeningPids = new Set<number>();
		const portPattern = new RegExp(`:${targetPort}\\s`);
		for (const line of output.split("\n")) {
			if (!portPattern.test(line)) continue;
			const parts = line.trim().split(/\s+/);
			const pid = Number.parseInt(parts[parts.length - 1], 10);
			const state = parts[3]; // LISTENING, ESTABLISHED, CLOSE_WAIT, FIN_WAIT_2, TIME_WAIT, etc.
			if (state === "LISTENING" && pid > 0 && pid !== process.pid) {
				listeningPids.add(pid);
			}
		}

		for (const pid of listeningPids) {
			killPortHolder(pid, targetPort);
		}

		if (listeningPids.size > 0) {
			Bun.sleepSync(200);
		}
	} catch {
		// netstat/tasklist not available — skip silently
	}
}

/**
 * Try to kill a process holding a LISTENING socket. If the PID from netstat is
 * already gone (taskkill returns "not found"), trace the process tree via wmic
 * to find related processes (parent, siblings, children) that may still hold the
 * inherited socket handle, and kill those.
 *
 * SEE https://serverfault.com/questions/1169871/how-to-allocate-a-tcp-port-orphaned-by-a-non-existent-process-without-restarting
 */
function killPortHolder(pid: number, port: number): void {
	// Attempt 1: direct kill.
	const directKill = Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], {
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const stderr = new TextDecoder().decode(directKill.stderr).toLowerCase();
	if (directKill.exitCode === 0) {
		logger.warn(`Killed process (PID ${pid}) holding port ${port}`);
		Bun.sleepSync(300);
		return;
	}

	// If the process exists but we lack permissions, nothing more we can do.
	if (!stderr.includes("not found")) return;

	// Attempt 2: the PID is gone but the port is still held. Trace the parent
	// process via wmic and kill related children (the real handle holder, often
	// conhost.exe or similar).
	logger.info(`PID ${pid} not found — tracing process tree to find port ${port} holder`);
	try {
		const childQuery = Bun.spawnSync(
			[
				"wmic",
				"process",
				"where",
				`(ParentProcessId=${pid})`,
				"get",
				"Caption,ProcessId",
				"/FORMAT:CSV",
			],
			{ stdout: "pipe", stderr: "ignore", windowsHide: true },
		);
		const childOutput = new TextDecoder().decode(childQuery.stdout);
		for (const line of childOutput.split("\n")) {
			const cols = line.trim().split(",");
			// CSV format: Node,Caption,ProcessId
			if (cols.length < 3) continue;
			const childPid = Number.parseInt(cols[cols.length - 1] ?? "", 10);
			if (!childPid || childPid === process.pid) continue;
			logger.warn(
				`Killing child process ${cols[1]?.trim()} (PID ${childPid}) — likely holding port ${port}`,
			);
			try {
				Bun.spawnSync(["taskkill", "/F", "/PID", String(childPid)], {
					stdio: ["ignore", "ignore", "ignore"],
					// 隐藏控制台：进程清理在端口被占用时触发，正常请求路径下不应闪窗。
					windowsHide: true,
				});
			} catch {
				// best effort
			}
		}

		// Also check: maybe the ghost PID's parent spawned other children that
		// inherited the handle. Look up the parent first.
		const parentQuery = Bun.spawnSync(
			["wmic", "process", "where", `(ProcessId=${pid})`, "get", "ParentProcessId", "/FORMAT:CSV"],
			{ stdout: "pipe", stderr: "ignore", windowsHide: true },
		);
		const parentOutput = new TextDecoder().decode(parentQuery.stdout);
		for (const line of parentOutput.split("\n")) {
			const cols = line.trim().split(",");
			if (cols.length < 2) continue;
			const parentPid = Number.parseInt(cols[cols.length - 1] ?? "", 10);
			if (!parentPid || parentPid === process.pid || parentPid === pid) continue;

			// Kill siblings (other children of the same parent).
			const siblingQuery = Bun.spawnSync(
				[
					"wmic",
					"process",
					"where",
					`(ParentProcessId=${parentPid})`,
					"get",
					"Caption,ProcessId",
					"/FORMAT:CSV",
				],
				{ stdout: "pipe", stderr: "ignore", windowsHide: true },
			);
			const siblingOutput = new TextDecoder().decode(siblingQuery.stdout);
			for (const sLine of siblingOutput.split("\n")) {
				const sCols = sLine.trim().split(",");
				if (sCols.length < 3) continue;
				const sPid = Number.parseInt(sCols[sCols.length - 1] ?? "", 10);
				if (!sPid || sPid === process.pid || sPid === pid) continue;
				const sName = sCols[1]?.trim().toLowerCase() ?? "";
				// Only kill known "handle holder" processes, not random siblings.
				if (sName === "conhost.exe" || sName === "cmd.exe") {
					logger.warn(`Killing sibling ${sName} (PID ${sPid}) — likely holding port ${port}`);
					try {
						Bun.spawnSync(["taskkill", "/F", "/PID", String(sPid)], {
							stdio: ["ignore", "ignore", "ignore"],
							// 隐藏控制台：进程清理在端口被占用时触发，正常请求路径下不应闪窗。
							windowsHide: true,
						});
					} catch {
						// best effort
					}
				}
			}
		}
		Bun.sleepSync(300);
	} catch {
		// wmic not available or failed — skip
	}
}

function getWindowsChildProcesses(parentPid: number): WindowsProcessInfo[] {
	try {
		const result = Bun.spawnSync(
			[
				"wmic",
				"process",
				"where",
				`(ParentProcessId=${parentPid})`,
				"get",
				"Caption,CommandLine,ProcessId",
				"/FORMAT:CSV",
			],
			{ stdout: "pipe", stderr: "ignore", windowsHide: true },
		);
		if (result.exitCode !== 0) return [];
		return parseWmicProcessCsv(new TextDecoder().decode(result.stdout)).filter((proc) => {
			const caption = proc.caption.toLowerCase();
			return proc.pid !== process.pid && caption !== "wmic.exe" && caption !== "taskkill.exe";
		});
	} catch {
		return [];
	}
}

function collectWindowsDescendantPids(rootPid: number): WindowsProcessInfo[] {
	const descendants: WindowsProcessInfo[] = [];
	const seen = new Set<number>([rootPid]);
	const queue: WindowsProcessInfo[] = getWindowsChildProcesses(rootPid).map((proc) => ({
		...proc,
		depth: 1,
	}));

	while (queue.length > 0) {
		const proc = queue.shift();
		if (!proc || seen.has(proc.pid)) continue;
		seen.add(proc.pid);
		descendants.push(proc);
		for (const child of getWindowsChildProcesses(proc.pid)) {
			if (!seen.has(child.pid)) {
				queue.push({ ...child, depth: (proc.depth ?? 0) + 1 });
			}
		}
	}

	return descendants;
}

function killOwnWindowsChildProcesses(): void {
	if (!IS_WINDOWS) return;
	const descendants = collectWindowsDescendantPids(process.pid).sort(
		(a, b) => (b.depth ?? 0) - (a.depth ?? 0),
	);
	for (const proc of descendants) {
		try {
			logger.warn(
				`Killing child process ${proc.caption || "unknown"} (PID ${proc.pid}) on shutdown`,
			);
			Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
				stdio: ["ignore", "ignore", "ignore"],
				// 隐藏控制台：进程清理在端口被占用时触发，正常请求路径下不应闪窗。
				windowsHide: true,
			});
		} catch {
			// best effort — process may already be gone
		}
	}
}

const startupReadiness = createStartupReadinessGate();

// Try to start the server, with automatic port fallback when the default port is busy.
const MAX_PORT_RETRIES = 10;

/** Advertise the listener's real protocol, including after a TLS rollback. */
function getProtocol(): "https" | "http" {
	return _server.url.protocol === "https:" ? "https" : "http";
}

async function resolveVNetRelayAuth(req: Request, url: URL): Promise<VNetRelayAuth | null> {
	if (!settings.vnet?.enabled) return null;
	const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
	const queryToken = url.searchParams.get("token") ?? undefined;
	const token = bearer || queryToken;
	const relayToken = settings.vnet.relayToken?.trim();

	if (token && relayToken && token === relayToken) {
		return { kind: "relay-token" };
	}
	if (token) {
		try {
			const payload = await verifyToken(token);
			return { kind: "session", userId: payload.sub };
		} catch {
			// Fall through to anonymous only when explicitly enabled.
		}
	}
	if (settings.vnet.allowAnonymousRelay) {
		return { kind: "anonymous" };
	}
	return null;
}

const httpRequestContext = new AsyncLocalStorage<number>();
const activeHttpRequests = new Map<number, Promise<Response | undefined>>();
let nextHttpRequestId = 0;
let acceptingHttpRequests = true;

async function waitForHttpRequestDrain(excludedRequestId?: number): Promise<void> {
	while (true) {
		const pending = [...activeHttpRequests.entries()]
			.filter(([requestId]) => requestId !== excludedRequestId)
			.map(([, request]) => request);
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
	}
}

/**
 * Close the listener without awaiting `Bun.Server.stop()`'s promise.
 *
 * `stop(true)` closes the listening socket and terminates connections synchronously — verified on
 * Bun 1.3.14: the port stops accepting immediately after the call, before any await. Its returned
 * promise, however, resolves only once Bun's internal `pendingWebSockets` counter reaches zero, and
 * that counter is NOT decremented when the server closes a socket itself (`ws.close()` /
 * `ws.terminate()`), even though the `close` callback fires and the peer disconnects. The leak is
 * permanent for the life of the process.
 *
 * NarraFork closes sockets server-side during normal operation (heartbeat timeout, expired session
 * token, connection limits) and again in `closeAllConnections()` at shutdown, so by the time we
 * stop, that counter is essentially always stuck above zero. Awaiting the promise therefore always
 * burned the full step timeout and, because a timed-out step marks the shutdown degraded, EVERY
 * shutdown skipped the clean-shutdown marker — forcing an unnecessary integrity check plus FTS
 * probe on every single startup.
 *
 * Proof that no work is missed by not awaiting it: `stop(true)` is synchronous with respect to
 * accepting work, and the two steps after this one (`httpHandlers.drain` / `websocketHandlers.drain`)
 * await the application's own trackers, which is what actually guarantees no handler can still
 * write to SQLite after the clean marker.
 */
function stopHttpListener(): void {
	// Never await: this promise may never settle (see above). Swallow rejection so an already
	// stopped server cannot turn shutdown into an unhandled rejection.
	void Promise.resolve(_server?.stop(true)).catch((err) => {
		logger.warn("HTTP listener stop reported an error", { error: String(err) });
	});
}

let boundTlsConfig = settings.server.tls;

function startServer(
	listenPort: number,
	tlsCfg: typeof settings.server.tls,
	allowHostFallback = false,
) {
	const tls =
		tlsCfg?.enabled && tlsCfg.certFile && tlsCfg.keyFile
			? {
					cert: Bun.file(tlsCfg.certFile),
					key: Bun.file(tlsCfg.keyFile),
					...(tlsCfg.passphrase && { passphrase: tlsCfg.passphrase }),
					...(tlsCfg.caFile && { ca: Bun.file(tlsCfg.caFile) }),
				}
			: undefined;

	const fetchRequest = (
		req: Request,
		server: Pick<Bun.Server<WSData>, "requestIP" | "upgrade">,
	) => {
		if (!acceptingHttpRequests) {
			return new Response("Server is shutting down", {
				status: 503,
				headers: { "Retry-After": "1" },
			});
		}
		const requestId = ++nextHttpRequestId;
		const execution = httpRequestContext.run(requestId, async () => {
			const url = new URL(req.url);

			// Keep liveness available while exposing whether continuation recovery is still
			// running or has failed. Recovery is considered admitted once every continuation
			// has been protected and mounted in the background; terminal Agent/Await and user
			// permission waits must never hold this barrier.
			if (url.pathname === "/api/health") {
				const healthResponse = await app.fetch(req);
				const healthPayload = (await healthResponse.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				const headers = new Headers(healthResponse.headers);
				headers.delete("content-length");
				headers.set("content-type", "application/json; charset=UTF-8");
				return new Response(
					JSON.stringify({
						...buildHealthPayload(healthPayload, startupReadiness.state),
						// Which database backend this process wired at startup. A monitor that
						// watches a PostgreSQL deployment must be able to tell it actually came
						// up on PostgreSQL — a silent fallback would report a healthy SQLite.
						database: { backend: activeDatabaseBackend },
					}),
					{
						status: healthStatusCode(startupReadiness.state, healthResponse.status),
						headers,
					},
				);
			}

			const narratorWsRefusal = narratorWebSocketBackendRefusal(
				url.pathname,
				activeDatabaseBackend,
			);
			if (narratorWsRefusal) return narratorWsRefusal;

			// Wait for recovery to reach a terminal outcome so restored narrators observe a
			// consistent state, but never turn a recovery failure into a dead server: the
			// frontend, auth and settings routes are what the user needs to repair whatever
			// made recovery fail (e.g. a narrator pinned to a deleted provider prefix).
			await startupReadiness.barrier;
			if (!shouldServeRequests(startupReadiness.state)) {
				return new Response("Startup narrator recovery failed", {
					status: 503,
					headers: { "Retry-After": "5" },
				});
			}

			if (url.pathname === "/ws/external/v1/narrators") {
				const rollout = getExternalWebSocketRolloutSettings();
				const origin = req.headers.get("origin");
				if (!isExternalWebSocketOriginAllowed(origin, rollout.allowedOrigins)) {
					return new Response("WebSocket Origin is not allowed", { status: 403 });
				}
				if (!canAcceptExternalNarratorConnection()) {
					return new Response("External narrator WebSocket capacity reached", { status: 503 });
				}
				const ticket = url.searchParams.get("ticket");
				if (!ticket) return new Response("WebSocket ticket required", { status: 401 });
				const consumed = consumeOAuthWsTicket(ticket, EXTERNAL_NARRATORS_WS_CHANNEL);
				if (!consumed) return new Response("Invalid or expired WebSocket ticket", { status: 401 });
				const live = await validateAccessTokenById(consumed.auth.oauth.tokenId).catch(() => null);
				if (
					!live ||
					live.userId !== consumed.auth.user.sub ||
					live.clientId !== consumed.auth.oauth.clientId ||
					live.oauthClientId !== consumed.auth.oauth.oauthClientId ||
					live.grantId !== consumed.auth.oauth.grantId ||
					live.refreshFamilyId !== consumed.auth.oauth.refreshFamilyId ||
					!live.scopes.includes("narrator.read") ||
					!live.scopes.includes("event.subscribe")
				) {
					return new Response("OAuth authorization is no longer valid", { status: 401 });
				}
				const upgraded = server.upgrade(req, {
					data: resolveExternalNarratorWSData(consumed.auth),
				});
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/ws/vnet") {
				const auth = await resolveVNetRelayAuth(req, url);
				if (!auth) {
					return new Response("VNet relay authentication required", { status: 401 });
				}
				const wsData = resolveWSData(url, undefined, auth);
				if (!wsData) {
					return new Response("Unknown WebSocket endpoint", { status: 404 });
				}
				const upgraded = server.upgrade(req, { data: wsData });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Remote executor devices authenticate via the hello frame (device token),
			// not a JWT, so accept the upgrade here and let the handshake verify.
			if (url.pathname === "/ws/device") {
				const wsData = resolveWSData(url);
				if (!wsData) {
					return new Response("Unknown WebSocket endpoint", { status: 404 });
				}
				const upgraded = server.upgrade(req, { data: wsData });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// WebSocket upgrade for /ws/narrator and /ws/terminal
			if (url.pathname.startsWith("/ws")) {
				// Anonymous public-share reader: `?share=<shareId>&token=<secret>` instead
				// of a session token. Verified once at upgrade, scoped at subscribe time
				// (narrator-ws reads `ws.data.publicShare`), and dropped on revocation.
				const shareId = url.searchParams.get("share");
				if (shareId && url.pathname === "/ws/narrator") {
					const shareToken = url.searchParams.get("token");
					if (!shareToken) {
						return new Response("Authentication required", { status: 401 });
					}
					let share: VerifiedPublicShare;
					try {
						share = verifyPublicShare(shareId, `Share ${shareToken}`);
					} catch {
						return new Response("Share link unavailable", { status: 401 });
					}
					const wsData = resolveWSData(url, undefined, undefined, undefined, share);
					if (!wsData) {
						return new Response("Unknown WebSocket endpoint", { status: 404 });
					}
					const ip = resolveClientIp({
						peerIp: server.requestIP(req)?.address,
						xForwardedFor: req.headers.get("x-forwarded-for"),
						xRealIp: req.headers.get("x-real-ip"),
						trustedProxyCidrs: settings.auth.trustedProxyCidrs ?? ["127.0.0.0/8", "::1/128"],
					});
					if (wsData.channel !== "narrator") {
						return new Response("Unknown WebSocket endpoint", { status: 404 });
					}
					const upgraded = publicShareConnectionBudget.upgrade(share.shareId, ip, (lease) => {
						wsData.publicShareConnectionLease = lease;
						return server.upgrade(req, { data: wsData });
					});
					if (upgraded === null) {
						return new Response("Too many sharing connections", {
							status: 429,
							headers: { "Retry-After": "15" },
						});
					}
					if (upgraded) return undefined;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}

				// Verify the session token from the query param
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
					columns: {
						id: true,
						username: true,
						avatarColor: true,
						avatarImageId: true,
						// Read live, so a demotion applies to the next socket. The narrator
						// subscribe path uses it for the admin short-circuit.
						role: true,
					},
				});
				// `verifyToken` already rejected revoked and expired sessions; a user row that
				// vanished since still fails the upgrade.
				if (!user) {
					return new Response("Invalid or expired token", { status: 401 });
				}
				const userInfo = user
					? {
							userId: user.id,
							username: user.username,
							avatarColor: user.avatarColor,
							avatarImageId: user.avatarImageId,
							role: user.role,
						}
					: undefined;

				// Remember the session so the socket can be re-checked when it lapses or
				// when the user's authorization changes (logout, revocation, role).
				const wsData = resolveWSData(url, userInfo, undefined, {
					sessionExp: payload.exp,
					sessionId: payload.sid,
					sessionUserId: payload.sub,
				});
				if (!wsData) {
					return new Response("Unknown WebSocket endpoint", { status: 404 });
				}

				const upgraded = server.upgrade(req, { data: wsData });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Everything else goes to Hono. Resolve the client IP and whether the immediate
			// socket peer is trusted at the Bun boundary, so routes never trust forwarding
			// headers solely because a caller supplied them.
			const peerIp = server.requestIP(req)?.address;
			const trustedProxyCidrs = settings.auth.trustedProxyCidrs ?? ["127.0.0.0/8", "::1/128"];
			const clientIp = resolveClientIp({
				peerIp,
				xForwardedFor: req.headers.get("x-forwarded-for"),
				xRealIp: req.headers.get("x-real-ip"),
				trustedProxyCidrs,
			});
			return app.fetch(req, {
				clientIp,
				peerIp,
				trustedProxy: isTrustedProxyAddress(peerIp, trustedProxyCidrs),
			});
		});
		activeHttpRequests.set(requestId, execution);
		void execution.then(
			() => activeHttpRequests.delete(requestId),
			() => activeHttpRequests.delete(requestId),
		);
		return execution;
	};
	const group = startManagerListenerGroup({
		bindPublic: () => {
			const bind = (host: string) => ({
				listener: Bun.serve({
					port: listenPort,
					hostname: host,
					idleTimeout: 255,
					// 数据导入上传的是整份导出包（GB 级）；服务端流式落盘，真正的大小上限
					// 由 MAX_IMPORT_BYTES 在读取过程中逐块校验。
					maxRequestBodySize: MAX_IMPORT_BYTES,
					tls,
					fetch: fetchRequest,
					websocket: wsHandlers,
				}),
				host,
			});
			// Only public binding may fall back. A companion collision fails the whole group.
			return allowHostFallback
				? listenWithLanFallback(configuredHost, currentHost, bind)
				: bind(currentHost);
		},
		managerToken: readManagerToken(),
		tls,
		dispatch: (req, server) =>
			fetchRequest(req, {
				requestIP: server.requestIP.bind(server),
				upgrade: () => false,
			}),
	});
	currentHost = group.host;
	boundTlsConfig = tlsCfg;
	clearInheritableHandlesAfterServerBind();
	return group;
}

function startServerWithHostFallback(listenPort: number) {
	return startServer(listenPort, settings.server.tls, true);
}

let actualPort = port;
let _server: ReturnType<typeof startServer>;

// Windows reserves blocks of TCP ports (Hyper-V / WSL / WinNAT) that bind() rejects with
// EADDRINUSE even though no process is listening, and it re-picks those blocks on every boot.
// Reading them first is what makes the difference between a useful startup and a dead one: the
// blocks are ~100 ports wide, so probing consecutive ports can never escape one.
const excludedPortRanges = readWindowsExcludedPortRanges();
const excludedRangeForPort = findExcludingRange(port, excludedPortRanges);

// Only meaningful when a real process holds the port; a reserved range has no owner to kill.
if (!excludedRangeForPort) {
	tryReclaimPort(port);
}

if (portExplicit) {
	// User explicitly specified a port — fail hard rather than silently moving it.
	if (excludedRangeForPort) {
		// Bun surfaces this bind failure asynchronously on Windows, where the catch below never
		// runs and the process dies on an "Is port in use?" uncaught exception that points at the
		// wrong cause. Report the real reason before touching Bun.serve().
		const reserved = `${excludedRangeForPort.start}-${excludedRangeForPort.end}`;
		logger.error(`Port ${port} is inside a Windows reserved TCP port range. Cannot start server.`, {
			port,
			reservedRange: reserved,
			excludedRanges: formatPortRanges(excludedPortRanges),
		});
		console.error(
			`\x1b[31mError: Port ${port} is reserved by Windows (excluded range ${reserved}).\x1b[0m\n` +
				"No process is using it — the Windows TCP stack has reserved the range, and the reserved\n" +
				"ranges change on every reboot. Inspect them with:\n" +
				`  ${NETSH_EXCLUDED_PORT_COMMAND}\n` +
				"Choose a port outside every listed range with --port=XXXX.",
		);
		process.exit(1);
	}
	try {
		_server = startServerWithHostFallback(port);
		actualPort = _server.port ?? port;
	} catch (err) {
		if (isListenerPortConflict(err)) {
			logger.error(`Port ${port} is already in use. Cannot start server.`);
			console.error(
				`\x1b[31mError: Port ${port} is already in use.\x1b[0m\nPlease free the port or choose a different one with --port=XXXX.`,
			);
			process.exit(1);
		}
		throw err;
	}
} else {
	// Default port — try fallback ports if busy, skipping whole reserved ranges.
	let started = false;
	let candidate: number | null = nextAllowedPort(port, excludedPortRanges);
	const attemptedPorts: number[] = [];
	for (let attempt = 0; attempt <= MAX_PORT_RETRIES && candidate !== null; attempt++) {
		const tryPort: number = candidate;
		attemptedPorts.push(tryPort);
		try {
			_server = startServerWithHostFallback(tryPort);
			actualPort = _server.port ?? tryPort;
			started = true;
			if (tryPort !== port) {
				if (excludedRangeForPort) {
					const reserved = `${excludedRangeForPort.start}-${excludedRangeForPort.end}`;
					logger.warn(
						`Port ${port} is reserved by Windows (${reserved}), automatically switched to port ${tryPort}`,
						{ excludedRanges: formatPortRanges(excludedPortRanges) },
					);
					console.warn(
						`\x1b[33m⚠ Port ${port} is reserved by Windows (excluded range ${reserved}), not used by any process.\x1b[0m\n` +
							`  Using port ${tryPort} instead. Reserved ranges change on reboot; list them with:\n` +
							`  ${NETSH_EXCLUDED_PORT_COMMAND}`,
					);
				} else {
					logger.warn(`Default port ${port} was in use, automatically switched to port ${tryPort}`);
					console.warn(`\x1b[33m⚠ Port ${port} is in use. Using port ${tryPort} instead.\x1b[0m`);
				}
			}
			break;
		} catch (err) {
			if (isListenerPortConflict(err)) {
				candidate = nextAllowedPort(tryPort + 1, excludedPortRanges);
				continue;
			}
			throw err;
		}
	}
	if (!started) {
		const attempted = attemptedPorts.length > 0 ? attemptedPorts.join(", ") : String(port);
		logger.error(`Could not find an available port (tried ${attempted}).`, {
			excludedRanges: formatPortRanges(excludedPortRanges),
		});
		const reservedHint =
			excludedPortRanges.length > 0
				? `\nWindows reserved TCP ranges: ${formatPortRanges(excludedPortRanges)} (list them with ${NETSH_EXCLUDED_PORT_COMMAND}).`
				: "";
		console.error(
			`\x1b[31mError: Could not find an available port (tried ${attempted}).\x1b[0m${reservedHint}\nPlease specify a port with --port=XXXX.`,
		);
		process.exit(1);
	}
}

logger.info(
	`NarraFork server running on ${getProtocol()}://${urlHost(currentHost)}:${actualPort}`,
	{
		isProd,
		isCompiledBinary,
		metaUrl: import.meta.url,
		listenHost: currentHost,
	},
);

function runtimeAddress() {
	return {
		protocol: _server.url.protocol === "https:" ? ("https" as const) : ("http" as const),
		host: currentHost,
		port: _server.port ?? actualPort,
	};
}
registerRuntimeAddressGetter(runtimeAddress);

// Startup CLI overrides and default-port fallback are not committed settings intents.
let lastCommittedAddressIntent: { host: string; port: number } | undefined;
// Register server restart handler for hot-reloading host/port from settings
const restartHttpListener = createManagerRebindCoordinator({
	// Resolve before detaching; stale DNS completions must never overwrite a newer rebind.
	resolveHost: (host) => resolveManagerListenHost(resolveListenHost(host), readManagerToken()),
	getCurrentAddress: runtimeAddress,
	isAccepting: () => acceptingHttpRequests,
	rebind: (newHost, newPort, resolvedHost, options) => {
		const oldHost = currentHost;
		const oldConfiguredHost = configuredHost;
		const oldConfiguredPort = configuredPort;
		const oldPort = actualPort;
		const oldTls = boundTlsConfig;
		_server = rebindHttpListener(
			_server,
			() => {
				configuredHost = newHost;
				configuredPort = newPort;
				currentHost = resolvedHost;
				const replacement = startServerWithHostFallback(newPort);
				actualPort = replacement.port ?? newPort;
				lastCommittedAddressIntent = { host: newHost, port: newPort };
				return replacement;
			},
			() => {
				configuredHost = oldConfiguredHost;
				configuredPort = oldConfiguredPort;
				currentHost = oldHost;
				// Restore the TLS options actually used by the previous listener, not newly saved settings.
				const replacement = startServer(oldPort, oldTls);
				actualPort = replacement.port ?? oldPort;
				return replacement;
			},
			options?.preserveResponse === true,
		);
		const address = runtimeAddress();
		// 与启动时同一句式，管理器才能在热重绑后更新面板上的地址。
		logger.info(
			`NarraFork server running on ${address.protocol}://${urlHost(address.host)}:${address.port}`,
			{ rebound: true, listenHost: address.host, port: address.port },
		);
		return address;
	},
});
registerServerRestart(restartHttpListener);

// settings.json 地址热重载：管理器面板或外部编辑直接写文件也能即时生效。
// PATCH /api/settings 的保存路径同样写该文件，isCurrent 比对可避免双重重绑。
startServerAddressWatcher({
	onIntentChanged: (address) => {
		restartHttpListener.invalidatePendingUnless(address.host, address.port);
		return (
			lastCommittedAddressIntent !== undefined &&
			(address.host !== lastCommittedAddressIntent.host ||
				address.port !== lastCommittedAddressIntent.port)
		);
	},
	isCurrent: (address) =>
		(address.host === configuredHost && address.port === configuredPort) ||
		restartHttpListener.isPending(address.host, address.port),
	onChanged: (address) => {
		reloadSettings();
		if (process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART === "1") {
			logger.warn("Server restart suppressed for contract harness", address);
			return;
		}
		// The watcher already debounced and has no HTTP response to flush. Start the intent now;
		// an additional timer would leave queued work that a later no-op intent cannot invalidate.
		void restartHttpListener(address.host, address.port).catch((error) => {
			logger.error("Server restart failed", { error: String(error) });
		});
	},
});

// 其余配置（实例名、主题色、打开方式等）由管理器面板直接写文件，没有地址那样的重绑回路：
// 文件变化时重载配置即可，运行时组件按需读取新值。地址变化由上面的监听单独处理。
// 本进程自己的保存同样会触发文件事件，内容与上次写入一致时无需重载。
startSettingsFileWatcher(() => {
	reloadSettingsIfChanged();
});

/** Open a URL in the user's default browser. */
function openInBrowser(url: string) {
	// Windows 走 ShellExecuteW：不经 cmd start，避免偶尔闪出的控制台窗口。
	if (IS_WINDOWS) {
		if (shellExecute(url)) return;
	}
	try {
		if (IS_MACOS) {
			Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
		} else if (!IS_WINDOWS) {
			Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
		}
	} catch {
		// Not critical — user can open manually
	}
}

async function openAsApp(url: string) {
	// Windows 上 Edge/Chrome 不在 PATH 里（Bun.which 找不到），按标准安装路径探测；
	// 直接 spawn 绝对路径，避免经 cmd start 时参数被重新解析。
	if (IS_WINDOWS) {
		const browser = CHROMIUM_PATHS.find((path) => existsSync(path));
		if (browser) {
			try {
				Bun.spawn([browser, `--app=${url}`], {
					stdio: ["ignore", "ignore", "ignore"],
					windowsHide: true,
				});
				return;
			} catch {
				// 落到默认浏览器兜底
			}
		}
		openInBrowser(url);
		return;
	}

	const candidates: { program: string; args: string[] }[] = IS_MACOS
		? [
				{ program: "open", args: ["-a", "Google Chrome", url, "--args", `--app=${url}`] },
				{ program: "open", args: ["-a", "Microsoft Edge", url, "--args", `--app=${url}`] },
				{ program: "open", args: ["-a", "Chromium", url, "--args", `--app=${url}`] },
			]
		: [
				{ program: "google-chrome", args: [`--app=${url}`] },
				{ program: "google-chrome-stable", args: [`--app=${url}`] },
				{ program: "chromium", args: [`--app=${url}`] },
				{ program: "chromium-browser", args: [`--app=${url}`] },
				{ program: "microsoft-edge", args: [`--app=${url}`] },
			];

	for (const { program, args } of candidates) {
		try {
			const proc = Bun.spawn([program, ...args], {
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			});
			// Give it a moment to fail (e.g. command not found)
			const timeout = new Promise<null>((r) => setTimeout(() => r(null), 300));
			const result = await Promise.race([proc.exited, timeout]);
			if (result !== null && result !== 0) continue;
			return;
		} catch {}
	}
	// All --app candidates failed, fall back to default browser
	openInBrowser(url);
}

// Print welcome banner to stdout & auto-open browser
{
	const { APP_VERSION, GIT_COMMIT } = await import("./lib/version");
	const versionStr = GIT_COMMIT ? `v${APP_VERSION} (${GIT_COMMIT})` : `v${APP_VERSION}`;
	const modeStr = isProd ? "production" : "development";
	const proto = getProtocol();
	const listenUrl = `${proto}://${urlHost(currentHost)}:${runtimeAddress().port}`;
	// dev:all sets NARRAFORK_DEV_APP_URL to the Vite origin. This process is the API
	// (7779); the banner and the browser open must send the user to the frontend.
	const url = resolveAdvertisedAppUrl({
		listenUrl,
		devAppUrl: process.env.NARRAFORK_DEV_APP_URL,
	});
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;105m⛏  NarraFork\x1b[0m ${versionStr}`);
	console.log(`  \x1b[2m➜\x1b[0m  ${url}`);
	console.log(`  \x1b[2m➜\x1b[0m  mode: ${modeStr}`);
	console.log("");

	// 由管理器面板托管的实例：前端窗口交给面板打开 —— 它会先聚焦已有窗口，
	// 这里再开一次就会重复弹窗（同一份逻辑不该有两份实现）。
	if (process.env.NARRAFORK_MANAGER_MANAGED !== "1") {
		const openMode = settings.server.openBrowser;
		if (openMode === "app") {
			openAsApp(url);
		} else if (openMode === "browser") {
			openInBrowser(url);
		}
	}
}

// Verify database integrity in the background, now that the port is bound and requests are being
// served. This used to run synchronously in server/db/index.ts BEFORE Bun.serve(), where a
// whole-database PRAGMA scan on the single JS thread made startup take minutes on a large DB. The
// probe now runs in a read-only subprocess and only records a repair marker; the repair itself
// happens on the next startup, before any request is accepted.
//
// SQLite-only: the probe spawns a `bun:sqlite` read-only subprocess against the local database
// file, which does not exist on the PostgreSQL backend (and `startupShutdownState.wasClean`
// there is the "cannot skip verification" answer). A server-managed engine verifies itself.
if (activeDatabaseBackend === "sqlite") {
	scheduleBackgroundIntegrityCheck(startupShutdownState);
}

// Start WebSocket heartbeat (ping/pong) to detect stale connections
startHeartbeat();

// Wire the remote-executor backend resolver + device lifecycle listeners.
initDeviceConnectionService();
// Wire the file-transfer chunk-frame receiver.
initDeviceTransferService();
// Migrate OAuth authorities first, then stable resource provenance, in bounded yielding batches.
// These services still use the SQLite proxy, so PostgreSQL explicitly gates the legacy path
// instead of letting a fire-and-forget promise hit that proxy and swallow the failure.
if (activeDatabaseBackend === "postgres") {
	logger.warn("OAuth/integration startup backfills are not yet migrated to PostgreSQL; path gated");
} else {
	// Narrators written before runtime registrations store their relations from now on.
	await materializeLegacyDelegations().catch((error) =>
		logger.warn("Legacy delegation materialization failed", { error: String(error) }),
	);
	try {
		await backfillOAuthGrantAuthoritiesOnStartup();
		await backfillIntegrationResourceBindingsOnStartup();
	} catch (error) {
		logger.error("OAuth/integration startup backfill failed", { error: String(error) });
		throw error;
	}
}

startVNetUdpRendezvous(settings.vnet).catch((err) => {
	logger.warn("VNet UDP rendezvous startup failed", { error: String(err) });
});

try {
	getCodexManager().startUsageRefreshScheduler();
} catch (err) {
	logger.warn("Codex usage refresh scheduler startup failed", { error: String(err) });
}

try {
	// One-shot warmup when Kimi providers exist; no periodic timer — refresh is
	// demand-driven (stale-while-revalidate on GET /api/kimi/usages, plus a
	// refresh when provider settings change).
	const { refreshAllKimiUsages } = await import("./lib/kimi-usage-cache");
	void refreshAllKimiUsages().catch(() => {});
} catch (err) {
	logger.warn("Kimi usage startup refresh failed", { error: String(err) });
}

try {
	// Demand-driven warmup, like Kimi; usage is intentionally memory-only, so a
	// restart re-reads it rather than trusting numbers from the previous process.
	const { refreshAllOpencodeUsages } = await import("./lib/opencode-usage-cache");
	void refreshAllOpencodeUsages().catch(() => {});
} catch (err) {
	logger.warn("OpenCode usage startup refresh failed", { error: String(err) });
}

try {
	// Demand-driven warmup, like Kimi; balances are intentionally memory-only.
	const { refreshAllDeepSeekBalances } = await import("./lib/deepseek-balance-cache");
	void refreshAllDeepSeekBalances().catch(() => {});
} catch {
	logger.warn("DeepSeek balance startup refresh failed");
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

// Initialize the plugin control plane after core services are available. Plugin
// activation is feature-flagged and must never prevent the core server from starting.
pluginManager
	.initialize()
	.then((statuses) => {
		logger.info("Plugin manager initialized", {
			enabled: pluginManager.isEnabled(),
			pluginCount: statuses.length,
		});
	})
	.catch((err) => {
		logger.error("Plugin manager initialization failed", { error: String(err) });
	});

function startQuestionAnswerRecovery(): void {
	if (!automaticResumeEnabled()) return;
	void recoverPendingQuestionAnswerDeliveries().catch((error) => {
		logger.error("Pending question answer recovery failed", { error: String(error) });
	});
}

// Keep only targets discovered by this startup. An early discovery failure may leave this empty;
// never compensate by scanning every narrator or interrupting another queue's live owner.
const startupRecoveryNarratorIds = new Set<string>();
const onStartupRecoveryTargetsDiscovered = (ids: readonly string[]): void => {
	for (const id of ids) startupRecoveryNarratorIds.add(id);
};

// Read planned-update protection before generic cleanup can mutate process-owned rows. The
// admission barrier covers generic recovery, browser-session handoff restoration, and mounting the
// ordered continuation queue; terminal Agent/Await work and interactive permissions continue in
// the background after that queue is mounted.
withBackgroundOccupancyInitialization(
	async () => {
		const plannedUpdate = await getPlannedUpdateStartupProtection({
			claimAuthorization: automaticResumeEnabled(),
			onTargetsDiscovered: onStartupRecoveryTargetsDiscovered,
		});
		for (const id of plannedUpdate.protection.narratorIds) startupRecoveryNarratorIds.add(id);
		for (const target of plannedUpdate.snapshot?.narrators ?? [])
			startupRecoveryNarratorIds.add(target.narratorId);
		for (const source of plannedUpdate.snapshot?.sources ?? [])
			for (const target of source.narrators) startupRecoveryNarratorIds.add(target.narratorId);
		// The instance lock is already held. Release only previous-process mailbox claims
		// before planned recovery mounts owners; hot reload preserves the process marker.
		await import("./services/agent-runtime/inbox").then(({ recoverInboxClaimsOnColdStartup }) =>
			recoverInboxClaimsOnColdStartup(),
		);
		const ordinaryRestart = await prepareOrdinaryRestartRecovery(plannedUpdate.protection, {
			onTargetsDiscovered: onStartupRecoveryTargetsDiscovered,
		});
		for (const id of ordinaryRestart.protection.narratorIds) startupRecoveryNarratorIds.add(id);
		for (const target of ordinaryRestart.manifest?.snapshot.narrators ?? [])
			startupRecoveryNarratorIds.add(target.narratorId);
		for (const target of ordinaryRestart.manifest?.targets ?? [])
			startupRecoveryNarratorIds.add(target.narratorId);
		const protection = mergeStartupProtection(plannedUpdate.protection, ordinaryRestart.protection);
		await recoverNarrators(protection);
		return { plannedUpdate, ordinaryRestart };
	},
	activeDatabaseBackend === "sqlite" ? backgroundOccupancyInitializer : undefined,
)
	.then(async ({ plannedUpdate, ordinaryRestart }) => {
		await restorePendingModelOverrides();
		// Browser-backed narrators must see their restored sessions before planned-update continuation
		// starts. Keep failures non-fatal: affected narrators receive a persisted diagnostic instead.
		await import("./services/browser-session-recovery")
			.then(({ restoreBrowserSessionsAfterUpdate }) => restoreBrowserSessionsAfterUpdate())
			.catch((err) => {
				logger.error("Browser session recovery failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		// All sources are now registered. New preparation can reserve them without
		// waiting for an Agent, Await, or human approval to finish (or even mount).
		finishRecoveryDiscovery();
		const recoveryHandles = automaticResumeEnabled()
			? await Promise.all([
					restoreNarratorsAfterPlannedUpdate(plannedUpdate),
					restoreOrdinaryRestartRecovery(ordinaryRestart),
				])
			: [];
		const completions = recoveryHandles.flatMap((handle) => (handle ? [handle.completion] : []));
		if (completions.length) startupReadiness.markRecovering();
		else startupReadiness.markReady();
		startupReadiness.settle({ ok: true });
		// Convert legacy envelopes to block rows in the background, slice by slice (§10.3).
		void import("./services/narrator-block-backfill")
			.then(({ startBlockBackfill }) => startBlockBackfill())
			.catch((err) =>
				logger.warn("Block backfill did not start", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		if (completions.length) {
			Promise.all(completions)
				.then(() => {
					startupReadiness.markReady();
					startQuestionAnswerRecovery();
					logger.info("Planned-update background continuation recovery completed");
				})
				.catch(async (err) => {
					const error = err instanceof Error ? err.message : String(err);
					startupReadiness.markFailed(error);
					logger.error("Planned-update background continuation recovery failed", { error });
					await failUnownedStartupRecovery(startupRecoveryNarratorIds, err);
				});
		} else {
			startQuestionAnswerRecovery();
		}
	})
	.catch(async (err) => {
		const error = err instanceof Error ? err.message : String(err);
		startupReadiness.markFailed(error);
		logger.error("Narrator state recovery failed", { error });
		startupReadiness.settle({ ok: false, error });
		await failUnownedStartupRecovery(startupRecoveryNarratorIds, err);
		// A recovery failure caused by an unusable provider is almost always a persisted
		// narrator pointing at a prefix the user has since removed. Surface which narrators
		// are affected instead of leaving the reason buried in this log line.
		if (isProviderUnavailableError(err)) void reportBrokenModelNarrators(error);
	});

/**
 * Scan for narrators stuck on an unusable model and announce a summary.
 *
 * Only counts and provider prefixes are broadcast — the full narrator list is fetched
 * on demand through `GET /api/narrators/broken-models`, so this never pushes a large
 * payload to every connected client.
 */
async function reportBrokenModelNarrators(recoveryError: string): Promise<void> {
	try {
		const { scanBrokenModelNarrators } = await import("./services/broken-model-migration-service");
		const scan = await scanBrokenModelNarrators();
		if (scan.totalBroken === 0 && scan.totalSuspect === 0) return;

		const providerPrefixes = [
			...new Set(
				scan.groups
					.filter((group) => group.reason === "provider_missing")
					.map((group) => group.providerPrefix)
					.filter((prefix): prefix is string => !!prefix),
			),
		];
		logger.warn("Narrators are pinned to an unusable model", {
			recoveryError,
			totalBroken: scan.totalBroken,
			totalSuspect: scan.totalSuspect,
			providerPrefixes,
			truncated: scan.truncated,
		});
		const { broadcastToAll } = await import("./websocket/narrator-ws");
		broadcastToAll({
			type: "broken_model_narrators_detected",
			totalBroken: scan.totalBroken,
			totalSuspect: scan.totalSuspect,
			providerPrefixes,
			truncated: scan.truncated,
		});
	} catch (scanError) {
		logger.error("Failed to report narrators pinned to an unusable model", {
			error: scanError instanceof Error ? scanError.message : String(scanError),
		});
	}
}

// Clean up leftover share directories from previous server runs
import { cleanupStaleShares } from "./lib/shares";

cleanupStaleShares();

// Request dumps and token repair data from before request evidence unification are discarded.
import { removeLegacyRequestDumpDirs } from "./services/legacy-request-dump-cleanup";

void removeLegacyRequestDumpDirs();

// Clean up leftover pack extraction directories from previous server runs and mark any
// still-"active" pack activations as released (their temp dirs don't survive a restart).
import { packActivationService } from "./services/knowledge-pack-activation-service";

packActivationService.cleanupStalePacks();

// Periodically remove old per-directory skill summary caches.
import { startSkillCacheCleanupTimer } from "./services/skill-service";

startSkillCacheCleanupTimer();

// Periodically remove expired/abandoned WebAuthn (passkey) ceremony challenges.
import { startChallengeCleanupTimer } from "./lib/webauthn";

startChallengeCleanupTimer();

// Periodically delete expired and revoked login sessions.
import { startSessionCleanupTimer } from "./lib/auth";

startSessionCleanupTimer();

// Poll for due scheduled tasks (periodic prompt → narrator). Re-arms on startup.
import {
	startScheduledTaskScheduler,
	stopScheduledTaskScheduler,
} from "./services/scheduled-task-scheduler";

void startupReadiness.barrier.then((recovery) => {
	if (!recovery.ok) {
		// The scheduler owns its own persisted records and skips narrators it cannot start, so a
		// failed recovery pass must not silently disable every future scheduled task.
		logger.warn("Starting scheduled task scheduler despite a failed startup recovery", {
			error: recovery.error,
		});
	}
	if (!shouldStartGatedBackgroundWork(recovery)) return;
	startScheduledTaskScheduler();
	// Stale never-started tool rows (e.g. a subagent Send stuck pending for days)
	// must not keep update checkpoint scans or UI recovery cards looking "busy".
	import("./services/abandoned-tool-cleanup")
		.then(({ cleanupAbandonedToolCalls }) => cleanupAbandonedToolCalls())
		.then((result) => {
			if (result.cleaned > 0) {
				logger.info("Startup abandoned tool-call cleanup finished", result);
			}
		})
		.catch((err) => {
			logger.warn("Startup abandoned tool-call cleanup failed", { error: String(err) });
		});
});

// Outline pages edited live when the previous process ended: commit what their logs hold.
void startupReadiness.barrier.then((recovery) => {
	if (!shouldStartGatedBackgroundWork(recovery)) return;
	import("./services/outline/live/registry")
		.then(({ startLiveReplay }) => startLiveReplay())
		.catch((err) => logger.warn("Outline live log replay failed", { error: String(err) }));
});

// Backfill legacy RecentTabs in bounded background batches. Membership consumers await this
// process-wide singleton before querying the authoritative indexes.
ensureAllRecentTabsMigrated()
	.then(() => logger.info("RecentTabs legacy migration scan completed"))
	.catch((err) => logger.warn("RecentTabs legacy migration scan failed", { error: String(err) }));

// Start IM Gateway (Telegram, Discord, Slack, Feishu, Webhook)
import { gateway } from "./gateway/gateway";

void startupReadiness.barrier.then((recovery) => {
	if (!recovery.ok) {
		logger.warn("Starting IM Gateway despite a failed startup recovery", {
			error: recovery.error,
		});
	}
	if (!shouldStartGatedBackgroundWork(recovery)) return;
	gateway.start().catch((err) => {
		logger.error("IM Gateway startup failed", { error: String(err) });
	});
});

// Clean up orphan workspace records not referenced in any user's recentTabs
import { dissolveOrphanWorkspaces } from "./routes/workspaces";

dissolveOrphanWorkspaces()
	.then((count) => {
		if (count > 0) logger.info(`Dissolved ${count} orphan workspace(s)`);
	})
	.catch((err) => {
		logger.warn("Orphan workspace cleanup failed", { error: String(err) });
	});

// Register knowledge notification bridge (push publish/review state to reviewers + submitters)
initKnowledgeNotify();

// Register chat notification bridge (room messages to viewers, unread badges to the rest)
initChatNotify();

// Activity projections consume source events independently of WebSocket delivery.
initNotificationFanout();
startNotificationCenterMaintenance();

if (activeDatabaseBackend === "sqlite") {
	// Stop containers and release ports that removed chapters left behind.
	retireLegacyChapterResources().catch((err) => {
		logger.warn("Legacy chapter resource cleanup failed", { error: String(err) });
	});
	// Re-derive which project every session belongs to, in bounded background pages.
	void scheduleProjectIndexRebuild();
}

// Establish client-egress relay channels for NUG providers configured with
// local egress (docs/CODEX_CLIENT_RELAY.md). Idempotent; also reconciled after
// every settings save.
reconcileNugRelayClients(settings.nugProviders ?? []);

// One-time cleanup of legacy snapshot shadow repos (replaced by file-snapshot-service)
const legacySnapshotsDir = getNarraforkPath("snapshots");
if (existsSync(legacySnapshotsDir)) {
	try {
		rmSync(legacySnapshotsDir, { recursive: true, force: true });
		logger.info("Removed legacy snapshot directory", { path: legacySnapshotsDir });
	} catch (err) {
		logger.warn("Failed to remove legacy snapshot directory", { error: String(err) });
	}
}

type GracefulShutdownOptions = {
	reason: string;
	skipWindowsProcessTreeKill?: boolean;
	skipBashProcessKill?: boolean;
};

type GracefulShutdownResult = {
	success: boolean;
	reason: string;
	pid: number;
	durationMs: number;
};

let shutdownPromise: Promise<GracefulShutdownResult> | null = null;
let killWindowsProcessTreeOnExit = true;

/**
 * Run a shutdown teardown step with a hard timeout so one hanging await can't stall the entire
 * graceful-shutdown sequence. On timeout or error we log and continue so the process can still
 * reach exit — but we return the outcome so the caller can decide whether the shutdown is still
 * "clean". Never rejects.
 */
async function shutdownStep(
	tracker: ShutdownActivityTracker,
	label: string,
	fn: () => unknown,
	timeoutMs = 4000,
): Promise<"ok" | "timeout" | "failed"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const result = await Promise.race([
			Promise.resolve()
				.then(fn)
				.then(() => "ok" as const)
				.catch((err) => {
					logger.warn(`Shutdown step failed: ${label}`, { error: String(err) });
					return "failed" as const;
				}),
			timeout,
		]);
		if (result === "timeout") {
			logger.warn(`Shutdown step timed out: ${label}`, { timeoutMs });
		}
		tracker.recordStep(label, result);
		return result;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function performGracefulShutdown(
	options: GracefulShutdownOptions,
): Promise<GracefulShutdownResult> {
	if (shutdownPromise) return shutdownPromise;
	const startedAt = Date.now();
	if (options.skipWindowsProcessTreeKill) {
		killWindowsProcessTreeOnExit = false;
	}

	shutdownPromise = (async () => {
		logger.info("Graceful shutdown started", { reason: options.reason });
		backgroundOccupancyInitializer.stop();
		stopHeartbeat();

		// Track every teardown step's outcome. The clean-shutdown marker is a promise that the DB
		// reached a quiescent, consistent state — so it is written ONLY at the very end, and only
		// when requests drained AND every teardown step succeeded. If any step times out or throws,
		// we skip the marker and just release the lock (below), so the next startup runs its
		// integrity check instead of trusting a shutdown we could not prove was consistent.
		const tracker = new ShutdownActivityTracker();

		// Stop accepting work before teardown begins. Bun.Server.stop(true) closes the listener and
		// terminates in-flight HTTP requests and WebSockets synchronously, so no new work can arrive
		// once stopHttpListener() returns; its promise is deliberately not awaited because Bun never
		// settles it after a server-side ws.close() (see stopHttpListener). The authenticated update
		// handoff treats its marker file as authoritative when this intentionally closes the request
		// before its response is flushed, so it is safe to close every connection here. The two drain
		// steps below are what guarantee later teardown cannot race a handler that writes to SQLite
		// after the clean marker.
		acceptingHttpRequests = false;
		if (options.reason === "signal") {
			await shutdownStep(tracker, "restartRecovery.prepare", prepareSignalRestartRecovery, 5_000);
		}
		const shutdownRequestId = httpRequestContext.getStore();
		// Outline pages being edited live: log what arrived and acknowledge it while the sockets
		// are still open, so the editors forget it instead of replaying it after the restart.
		await shutdownStep(
			tracker,
			"outlineLive.persist",
			async () => {
				const live = await import("./services/outline/live/registry");
				await live.persistAllLiveSessions();
			},
			2_000,
		);
		closeAllConnections();
		// A short budget is honest here: stopHttpListener() is synchronous by design
		// (it never awaits stop()'s promise), so anything beyond a moment means the
		// call itself threw or blocked, not that connections are still draining.
		const serverStopOutcome = await shutdownStep(
			tracker,
			"httpServer.stop",
			() => stopHttpListener(),
			1_000,
		);
		const httpDrainOutcome = await shutdownStep(
			tracker,
			"httpHandlers.drain",
			() => waitForHttpRequestDrain(shutdownRequestId),
			10_000,
		);
		const wsDrainOutcome = await shutdownStep(
			tracker,
			"websocketHandlers.drain",
			waitForWebSocketActivityDrain,
			10_000,
		);
		if (serverStopOutcome === "ok" && httpDrainOutcome === "ok" && wsDrainOutcome === "ok") {
			tracker.markDrainComplete();
		}

		// Outline pages being edited live: commit their text, end the sessions.
		await shutdownStep(
			tracker,
			"outlineLive.close",
			async () => {
				const live = await import("./services/outline/live/registry");
				await live.closeAllLiveSessions("ended");
			},
			5_000,
		);
		getCodexManager().stopUsageRefreshScheduler();
		stopScheduledTaskScheduler();
		await shutdownStep(tracker, "notificationFanout.stop", stopNotificationFanout);
		await shutdownStep(tracker, "notificationMaintenance.stop", stopNotificationCenterMaintenance);
		await shutdownStep(tracker, "terminalService.shutdownAll", () => terminalService.shutdownAll());
		if (!options.skipBashProcessKill) {
			await shutdownStep(tracker, "killAllBashProcesses", () => killAllBashProcesses());
		}
		// The background integrity probe is a separate PROCESS holding a read-only handle on the
		// database for up to 10 minutes. Left running it becomes an orphan: it keeps scanning while a
		// replacement process may swap the database file (startup recovery) or rewrite it (admin
		// VACUUM), and its verdict has no parent to report to.
		await shutdownStep(tracker, "integrityProbe.cancel", () => cancelBackgroundIntegrityCheck());
		// Read workers hold their own read-only SQLite connections; terminate them before the clean
		// marker is written so no thread is still touching the database afterwards.
		await shutdownStep(tracker, "dbWorkerPool.shutdown", () => shutdownDbWorkerPool());
		// PostgreSQL: stop accepting new operations and close the client, in drain order — after
		// HTTP/WS handlers have drained, before the lock release below. A no-op on the SQLite
		// backend, so the SQLite teardown sequence is neither extended nor bypassed.
		await shutdownStep(tracker, "postgresRuntime.close", () => closePostgresRuntime());
		await shutdownStep(tracker, "vnetUdpRendezvous.stop", () => stopVNetUdpRendezvous());
		await shutdownStep(tracker, "pluginManager.shutdown", () => pluginManager.shutdown());
		unregisterExternalProviderResolver();
		await shutdownStep(tracker, "mcpManager.shutdown", () => mcpManager.shutdown());
		// Checkpoint-backed update/system shutdown: persist active browser sessions and flip the
		// pool into preserve-on-close mode so browserPool.close disconnects (keeps Chrome alive)
		// for recovery. A normal shutdown skips this and closes the browser as usual.
		if (preservesRecoveryOnShutdown(options.reason)) {
			await shutdownStep(tracker, "browserSessions.persistForUpdate", () =>
				import("./services/browser-session-recovery").then(({ persistBrowserSessionsForUpdate }) =>
					persistBrowserSessionsForUpdate(),
				),
			);
		}
		// Close browser pool if it was started. When preserve mode was set above, this disconnects
		// from Chrome (leaving it running for the replacement process) rather than closing it.
		await shutdownStep(tracker, "browserPool.close", () =>
			import("./lib/browser/pool").then(({ closeBrowser }) => closeBrowser()),
		);
		// Close Codex WebSocket session cache — active outbound WS
		// connections keep the event loop alive and delay exit.
		await shutdownStep(tracker, "codexWebSocket.clear", () =>
			import("./lib/agent/codex-websocket").then(({ clearCodexResponsesWebSocketSessions }) =>
				clearCodexResponsesWebSocketSessions(),
			),
		);
		if (!options.skipWindowsProcessTreeKill) {
			killOwnWindowsChildProcesses();
		}

		// Decide the marker now that teardown is finished. A clean shutdown (requests drained AND
		// every step succeeded) persists the marker and releases the lock; a degraded shutdown skips
		// the marker but still releases the lock so an update-handoff replacement can start.
		const summary = tracker.summary();
		const cleanMarked = summary.clean ? markDatabaseCleanShutdown() : false;
		if (!summary.clean) {
			logger.warn("Graceful shutdown degraded — releasing lock without clean marker", {
				drainComplete: summary.drainComplete,
				degradedSteps: summary.degradedSteps,
			});
			releaseDatabaseInstanceLockOnly();
		}

		const result = {
			success: true,
			reason: options.reason,
			pid: process.pid,
			durationMs: Date.now() - startedAt,
		};
		logger.info("Graceful shutdown completed", { ...result, cleanMarked });
		return result;
	})();

	return shutdownPromise;
}

registerGracefulShutdownHandler(async (request) => {
	logger.info("Replacement server requested graceful shutdown", {
		replacementPid: request.pid,
		replacementVersion: request.version,
	});
	const result = await performGracefulShutdown({
		reason: "replacement_started",
		skipWindowsProcessTreeKill: true,
		skipBashProcessKill: true,
	});
	setTimeout(() => process.exit(0), 250);
	return result;
});

/**
 * Administrator-initiated shutdown with no successor process.
 *
 * Unlike the handoff path above, nothing is coming to take over the port: the user asked to stop
 * this version so they can launch the prepared binary themselves. Ordinary manual-update
 * shutdown runs full teardown. Explicit system preparation instead preserves checkpoint-backed
 * processes and browser sessions for the next manually started server.
 */
registerOperatorShutdownHandler(async ({ reason }) => {
	logger.info("Administrator requested shutdown", { reason });
	const preserveForRecovery = preservesRecoveryOnShutdown(reason);
	const result = await performGracefulShutdown({
		reason,
		skipWindowsProcessTreeKill: preserveForRecovery,
		skipBashProcessKill: preserveForRecovery,
	});
	setTimeout(() => process.exit(0), 250);
	return result;
});

const safeShutdown = () => {
	// The clean-shutdown marker is intentionally NOT written up front. It certifies that teardown
	// fully completed and requests drained, so performGracefulShutdown persists it only at the very
	// end of a clean run. Writing it here (before teardown) would risk certifying a shutdown that a
	// later hang or forced TerminateProcess never actually completed — the exact false-positive this
	// workflow removes. The next-startup integrity check + conditional FTS rebuild remains the safety
	// net for shutdowns that never reach the clean marker.
	performGracefulShutdown({ reason: "signal" })
		.then(() => process.exit(0))
		.catch(() => process.exit(1));
};
process.on("SIGINT", safeShutdown);
process.on("SIGTERM", safeShutdown);
// SIGHUP fires on some Windows terminal emulators when the console window is closed, and Bun
// may also surface Windows CTRL_CLOSE / CTRL_SHUTDOWN / CTRL_LOGOFF events as SIGHUP. Whether
// Bun actually delivers these console-control events to JS is runtime-dependent and unverified.
// When delivered, the normal bounded teardown runs; if Windows terminates the process before it
// completes, no clean marker is written and the next startup correctly runs its integrity checks.
//
// KNOWN LIMITATION: task-manager "End task" / taskkill /F / power loss call TerminateProcess
// directly and deliver NO signal, so none of these handlers run. A Windows-native
// SetConsoleCtrlHandler (via bun:ffi JSCallback) could catch console-close more reliably, but
// it cannot catch TerminateProcess either, adds FFI-callback risk at a fragile exit point, and
// the codebase has no JSCallback precedent — so we intentionally do not use it. The startup
// fallback (quick_check + conditional FTS rebuild) is what protects the unclean cases.
process.on("SIGHUP", safeShutdown);
// On Windows, closing the console window may not deliver SIGINT/SIGTERM.
// "exit" fires when the event loop drains or process.exit() is called elsewhere.
// NOTE: "exit" handlers MUST be synchronous — async work is ignored.
process.on("exit", () => {
	try {
		_server?.stop(true);
	} catch {
		// best effort
	}
	// On Windows, child processes (terminals, agent shells, MCP servers) may
	// outlive the parent even after _server.stop(). Trace and kill our own live
	// descendants while the parent PID is still meaningful, instead of guessing
	// from stale/ghost PIDs on the next startup. During update handoff, skip this
	// so the newly spawned replacement process is not killed as part of the old tree.
	if (IS_WINDOWS && killWindowsProcessTreeOnExit) {
		killOwnWindowsChildProcesses();
	}
});
