import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
// Relative rather than `@frontend/*`: `bun build` (used for the compiled binary) does not
// resolve the tsconfig alias, and this module is dependency-free string constants, so it adds
// nothing but the literals to the server bundle.
import {
	PLUGIN_UI_RUNTIME_CSS_URL,
	PLUGIN_UI_RUNTIME_JS_URL,
} from "../frontend/plugin-runtime/paths";
import { urlHost } from "../shared/server-host";
import { MAX_IMPORT_BYTES } from "../shared/storage-transfer";
import { app } from "./app";
import { getDbPath } from "./db/connection";
import { gateway } from "./gateway/gateway";
import { createServerRequestDispatcher } from "./http-dispatcher";
import { createServerRequestLifecycle } from "./http-request-lifecycle";
import { sweepStagedAttachments } from "./lib/attachment-staging";
import { startSessionCleanupTimer, stopSessionCleanupTimer } from "./lib/auth";
import { createDatabaseReaderReadiness, databaseReadersAvailable } from "./lib/db-reader-readiness";
import { createDatabaseReaderStartup } from "./lib/db-reader-startup";
import {
	assertDbReadersReady,
	getDbWorkerAvailability,
	shutdownDbWorkerPool,
} from "./lib/db-worker/pool";
import { cleanupStaleShares } from "./lib/shares";
import { startChallengeCleanupTimer } from "./lib/webauthn";
import { packActivationService } from "./services/knowledge-pack-activation-service";
import { removeLegacyRequestDumpDirs } from "./services/legacy-request-dump-cleanup";
import {
	closePrefixSnapshotStore,
	startPrefixSnapshotMaintenance,
} from "./services/narrator-prefix-snapshots";
import { attachRemoteAccessRuntime } from "./services/remote-access-runtime";
import {
	isScheduledTaskTickActive,
	startScheduledTaskScheduler,
	stopScheduledTaskScheduler,
} from "./services/scheduled-task-scheduler";
import { startSkillCacheCleanupTimer } from "./services/skill-service";
import "./db"; // Ensure DB is initialized early
import {
	activeDatabaseBackend,
	closePostgresRuntime,
	markDatabaseCleanShutdown,
	postgresRuntime,
	releaseDatabaseInstanceLockOnly,
	startupShutdownState,
} from "./db";
import {
	cancelBackgroundIntegrityCheck,
	getIntegrityCheckShutdownSnapshot,
	scheduleBackgroundIntegrityCheck,
} from "./db/integrity-check";
import { registerExternalProviderResolver } from "./lib/agent/provider";
import { claimBrowserShutdownOwnership } from "./lib/browser/pool";
import { getCodexManager } from "./lib/codex-manager";
import {
	drainContextCharacterRefreshes,
	getContextCharacterRefreshStatus,
	quiesceContextCharacterRefreshes,
} from "./lib/context-characters";
import { inspectApplicationDataDirectory } from "./lib/data-directory-security";
import { resolveAdvertisedAppUrl } from "./lib/dev-app-url";
import { startEventLoopMonitor } from "./lib/event-loop-monitor";
import { hotOnce, hotSafe } from "./lib/hot-safe";
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
import { prepareMcpTools } from "./lib/mcp/tool-bridge";
import { getNarraforkHome } from "./lib/narrafork-home";
import { listenWithLanFallback, resolveListenHost } from "./lib/net/listen-host";
import { reconcileNugRelayClients } from "./lib/nug-relay/manager";
import { openFrontendOnce } from "./lib/open-frontend";
import { IS_WINDOWS, initWslFlag } from "./lib/platform";
import { runPostShutdownHooks } from "./lib/post-shutdown-hooks";
import { isProviderUnavailableError } from "./lib/provider-availability-error";
import { IS_LOCAL_RUNTIME, isCompiledRuntime } from "./lib/runtime-target";
import {
	registerGracefulShutdownHandler,
	registerOperatorShutdownHandler,
	registerRuntimeAddressGetter,
	registerServerRestart,
} from "./lib/server-restart";
import { reloadSettings, reloadSettingsIfChanged, settings } from "./lib/settings";
import { startServerAddressWatcher } from "./lib/settings-address-watcher";
import { startSettingsFileWatcher } from "./lib/settings-file-watcher";
import {
	canRunCleanShutdownHooks,
	fenceUnattendedShutdown,
	preservesRecoveryOnShutdown,
	ShutdownActivityTracker,
} from "./lib/shutdown-activity";
import { injectSpaBaseHref, spaIndexHeaders } from "./lib/spa-base-href";
import { createStartupReadinessGate } from "./lib/startup-readiness";
import { closeStartupStatus } from "./lib/startup-status";
import { noPortAvailable, portUnavailable } from "./lib/startup-status/startup-problems";
import { reissueBuiltinTlsOnStartup } from "./lib/tls";
import { startVNetUdpRendezvous, stopVNetUdpRendezvous } from "./lib/vnet/udp-rendezvous";
import { clearInheritableHandlesAfterServerBind } from "./lib/win-handle-guard";
import { terminateWindowsChildren } from "./lib/windows-child-job";
import {
	findExcludingRange,
	formatPortRanges,
	NETSH_EXCLUDED_PORT_COMMAND,
	nextAllowedPort,
	readWindowsExcludedPortRanges,
} from "./lib/windows-excluded-ports";
import {
	drainCommunicationWork,
	getCommunicationWorkStatus,
	trackCommunicationWork,
} from "./services/agent-runtime/async-work";
import { stopInboxWakes } from "./services/agent-runtime/inbox";
import { stopRuntimePublications } from "./services/agent-runtime/publication";
import {
	drainNarratorRunCompletions,
	getNarratorRunShutdownSnapshot,
	stopNarratorRunAdmission,
} from "./services/agent-runtime/run";
import { backgroundTaskService } from "./services/background-task-service";
import { stopBlockBackgroundJobs } from "./services/narrator-block-backfill";
import {
	drainBufferedFilePreparations,
	getBufferedFilePreparationStatus,
	hasPendingBufferedFilePreparations,
	stopBufferedFilePreparations,
} from "./services/narrator-buffer";
import { stopOutlineLiveReplay } from "./services/outline/live/replay";
import { pluginManager } from "./services/plugin-manager";
import { pluginPlatformServices } from "./services/plugin-platform-services";
import { listPluginProviderReadiness } from "./services/plugin-provider-readiness";
import { pluginProviderRegistry } from "./services/plugin-provider-registry";
import {
	activatePostgresRuntimeQueue,
	composePostgresStores,
} from "./services/postgres-composition";
import { ensureAllRecentTabsMigrated } from "./services/recent-tabs-service";
import {
	getResourceProtectionShutdownSnapshot,
	stopResourceProtectionIndex,
} from "./services/resource-protection-index";
import { TOKEN_RECALCULATION_BATCH_TIMEOUT_MS } from "./services/token-recalculation";
import { stopCheckpointedNarratorRuns } from "./services/update-coordinator";

// Parse --wsl=true|false CLI flag (default: false — WSL disallowed)
initWslFlag();

import {
	backgroundOccupancyInitializer,
	withBackgroundOccupancyInitialization,
} from "./services/background-occupancy-startup";
import { stopBackgroundOccupancy } from "./services/background-occupancy-store";
import { ensureRootlessEnv } from "./services/container-service";
import { cpuProfiler } from "./services/cpu-profiler";
import { retireLegacyChapterResources } from "./services/legacy-chapter-resource-cleanup";
import {
	drainNarratorSessionTails,
	failUnownedStartupRecovery,
	getNarratorSessionTailStatus,
	recoverOnStartup as recoverNarrators,
	recoverPendingQuestionAnswerDeliveries,
	restorePendingModelOverrides,
} from "./services/narrator-session";
import {
	startNotificationCenterMaintenance,
	stopNotificationCenterMaintenance,
} from "./services/notification-center-maintenance";
import { initNotificationFanout, stopNotificationFanout } from "./services/notification-fanout";
import {
	drainNotificationBackgroundWork,
	getNotificationBackgroundWorkSnapshot,
	stopNotificationBackgroundWork,
} from "./services/notification-service";
import { scheduleProjectIndexRebuild, stopProjectIndexRebuild } from "./services/project-index";
import "./services/attention-hook-bridge"; // Bridge attention events into the hook system
import { installAutoRouteSignals } from "./lib/agent/auto-route-signals";
import { killAllBashProcesses } from "./lib/agent/tools/bash";
import { startCommandCodeModelCatalog } from "./lib/commandcode-models";
import { migrateAggregationsOnStartup } from "./services/aggregation-migration-service";
import { initChatNotify } from "./services/chat-notify";
import { initDeviceConnectionService } from "./services/device-connection-service";
import { initDeviceTransferService } from "./services/device-transfer-service";
import { backfillIntegrationResourceBindingsOnStartup } from "./services/integration-resource-binding-service";
import { initKnowledgeNotify } from "./services/knowledge-notify";
import { materializeLegacyDelegations } from "./services/legacy-delegation-materializer";
import { setMigrationPgHandle } from "./services/migration-db";
import { backfillOAuthGrantAuthoritiesOnStartup } from "./services/oauth-grant-service";
import {
	migrateReservedAutoPrefixOnStartup,
	recoverProviderPrefixMigrationOnStartup,
} from "./services/provider-prefix-migration-service";
import { beginRecoveryDiscovery, finishRecoveryDiscovery } from "./services/recovery-handoff";
import {
	automaticResumeEnabled,
	mergeStartupProtection,
	prepareOrdinaryRestartRecovery,
	prepareSignalRestartRecovery,
	restoreOrdinaryRestartRecovery,
} from "./services/restart-recovery-service";
import {
	getStorageHistoryShutdownSnapshot,
	stopStorageHistoryRetention,
} from "./services/storage-history-runtime";
import { terminalService } from "./services/terminal-service";
import { UNATTENDED_SHUTDOWN_REASON, unattendedMode } from "./services/unattended-mode";
import { markUpdateRestarting } from "./services/update-coordinator";
import {
	getPlannedUpdateStartupProtection,
	restoreNarratorsAfterPlannedUpdate,
} from "./services/update-recovery-service";
import {
	drainNarratorWsReadTasks,
	hasPendingNarratorWsReadTasks,
	quiesceNarratorWsReadTasks,
} from "./websocket/narrator-ws";
import {
	closeAllConnections,
	hasActiveWebSocketHandlers,
	startHeartbeat,
	stopHeartbeat,
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

// The startup migrations below read and rewrite narrator rows; give them the PG handle
// before they run (composePostgresStores sets it again, harmlessly).
if (postgresRuntime) setMigrationPgHandle(postgresRuntime.client.db);
// Resolve any interrupted cross-store provider prefix migration before accepting requests.
// A journal that no longer matches the settings is kept and logged; startup continues.
await recoverProviderPrefixMigrationOnStartup().catch((error) => {
	logger.error("Could not recover an interrupted provider prefix migration", {
		error: String(error),
	});
});
// auto:<model> routing reads live source availability (Codex accounts, key cooldowns).
installAutoRouteSignals();
// Publish the real Command Code directory before unattended/recovered Auto work can run.
const stopCommandCodeModelCatalog = await startCommandCodeModelCatalog();
// `auto` is reserved for auto:<model>; an older provider using it is renamed. A failure is
// logged and leaves it working as an ordinary prefix, so startup never depends on it.
// Runs on both backends (services/migration-db.ts picks the active handle).
await migrateReservedAutoPrefixOnStartup().catch((error) => {
	logger.error("Could not rename the provider prefixed `auto`", { error: String(error) });
});

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

// Catch unhandled errors once, including across --hot evaluations.
if (hotOnce("narrafork.main.errorHooks")) {
	process.on("uncaughtException", (err) => {
		logger.error("Uncaught exception", { error: String(err), stack: err?.stack });
	});
	process.on("unhandledRejection", (reason) => {
		logger.error("Unhandled rejection", { error: String(reason), stack: (reason as Error)?.stack });
	});
}

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
const isCompiledBinary = isCompiledRuntime();
// Also treat as production when dist/frontend exists (handles Windows where
// NODE_ENV=production inline syntax doesn't work)
const hasFrontendBuild =
	!isCompiledBinary && existsSync(resolve(import.meta.dir, "..", "dist", "frontend", "index.html"));
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
	// Compiled processes only serve their frozen assets. Explicit source runs
	// keep serving dist/frontend from disk so a later frontend build is visible.
	if (isCompiledBinary) {
		try {
			// Dynamic import so it doesn't fail when the generated file doesn't exist (dev / bundle mode)
			const generatedModule = (await import("@server/generated/embedded-frontend")) as {
				embeddedAssets?: Record<string, string>;
			};
			if (!generatedModule.embeddedAssets) {
				throw new Error("Embedded frontend asset map is unavailable in this build");
			}
			const rawAssets = generatedModule.embeddedAssets;
			// Normalise keys: on Windows the build script may produce backslash
			// keys (e.g. "/assets\\index-abc.js") — convert them to forward slashes
			// so they match browser request paths.
			const embeddedAssets: Record<string, string> = {};
			for (const [key, value] of Object.entries(rawAssets)) {
				embeddedAssets[key.replaceAll("\\", "/")] = value;
			}
			const indexPath = embeddedAssets["/index.html"];
			if (!indexPath && !IS_LOCAL_RUNTIME) {
				throw new Error("Embedded frontend index is unavailable in this build");
			}
			// Local backend-only launches use Vite for navigation, but still serve
			// their frozen brand/GenUI assets. Never borrow a checkout's dist.
			logger.info("Serving frontend from embedded assets", { hasIndex: !!indexPath });

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
				if (indexPath && !c.req.path.includes(".")) {
					return serveSpaIndex(Bun.file(indexPath), c.req.path);
				}

				return next();
			});
		} catch (cause) {
			throw new Error("Embedded frontend assets are unavailable in this build", { cause });
		}
	}

	// Mutable filesystem assets belong only to explicit source runs.
	if (!isCompiledBinary) {
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

// ── Windows: own child processes ──────────────────────────────────────────────
// Children that outlive an unclean exit keep files and ports busy, so the exit path ends the
// whole tree below this process. Uses wmic, which recent Windows builds no longer ship; there
// this finds nothing. A Job Object would replace it.
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
	// Job Object + taskkill on the tracked roots needs no wmic (absent on recent Windows) and
	// covers grandchildren. The wmic walk stays as a backstop for anything never tracked; on
	// machines without wmic it simply finds nothing.
	terminateWindowsChildren();
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
const databaseReaderReadiness = createDatabaseReaderReadiness({
	backend: activeDatabaseBackend,
	probe: (options) => assertDbReadersReady(getDbPath(), options),
	availability: getDbWorkerAvailability,
	databaseAvailability: () => getDbWorkerAvailability(getDbPath()),
});

// Try to start the server, with automatic port fallback when the default port is busy.
const MAX_PORT_RETRIES = 10;

/** Advertise the listener's real protocol, including after a TLS rollback. */
function getProtocol(): "https" | "http" {
	return _server.url.protocol === "https:" ? "https" : "http";
}

const httpLifecycle = createServerRequestLifecycle();
const httpRequestContext = httpLifecycle.context;
const waitForHttpRequestDrain = httpLifecycle.drain;
const fetchRequest = createServerRequestDispatcher({
	app,
	lifecycle: httpLifecycle,
	startupReadiness,
	activeDatabaseBackend,
	databaseReaderReadiness,
});

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

	const group = startManagerListenerGroup({
		bindPublic: () => {
			const bind = (host: string) => ({
				listener: Bun.serve({
					port: listenPort,
					hostname: host,
					idleTimeout: 255,
					// Bun 只能设一个全局请求体上限。导入预览要收最大 4 GB 的包，所以这里取
					// MAX_IMPORT_BYTES；其它请求在 limitOrdinaryRequestBody 里按 128 MB 拒绝，
					// 流式附件上传（≤ 1 GiB）在暂存层按实际字节自行限流。
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

// Refresh the built-in certificate before the listener reads it, without a restart.
try {
	await reissueBuiltinTlsOnStartup(settings.server.tls);
} catch (error) {
	logger.warn("Could not update TLS certificate on startup; check TLS settings", { error });
}

let actualPort = port;
let _server: ReturnType<typeof startServer>;

// Windows reserves blocks of TCP ports (Hyper-V / WSL / WinNAT) that bind() rejects with
// EADDRINUSE even though no process is listening, and it re-picks those blocks on every boot.
// Reading them first is what makes the difference between a useful startup and a dead one: the
// blocks are ~100 ports wide, so probing consecutive ports can never escape one.
const excludedPortRanges = readWindowsExcludedPortRanges();
const excludedRangeForPort = findExcludingRange(port, excludedPortRanges);

// The startup page holds the port until here; from now on the real server answers.
await closeStartupStatus();

if (portExplicit) {
	// User explicitly specified a port — fail hard rather than silently moving it.
	if (excludedRangeForPort) {
		// Bun surfaces this bind failure asynchronously on Windows, where the catch below never
		// runs and the process dies on an "Is port in use?" uncaught exception that points at the
		// wrong cause. Report the real reason before touching Bun.serve().
		throw portUnavailable(port, `${excludedRangeForPort.start}-${excludedRangeForPort.end}`);
	}
	try {
		_server = startServerWithHostFallback(port);
		actualPort = _server.port ?? port;
	} catch (err) {
		if (isListenerPortConflict(err)) throw portUnavailable(port);
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
		throw noPortAvailable(
			attemptedPorts.length > 0 ? attemptedPorts.join(", ") : String(port),
			excludedPortRanges.length > 0 ? formatPortRanges(excludedPortRanges) : undefined,
		);
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
	isAccepting: () => httpLifecycle.accepting,
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

const stopRemoteAccess = attachRemoteAccessRuntime({
	dispatch: fetchRequest,
	lifecycle: httpLifecycle,
	readiness: startupReadiness,
});

// Print welcome banner to stdout & auto-open browser
{
	const { APP_VERSION, GIT_COMMIT } = await import("./lib/version");
	const versionStr = GIT_COMMIT ? `v${APP_VERSION} (${GIT_COMMIT})` : `v${APP_VERSION}`;
	const modeStr = isProd ? "production" : "development";
	const proto = getProtocol();
	const listenUrl = `${proto}://${urlHost(currentHost)}:${runtimeAddress().port}`;
	// dev:all sets NARRAFORK_DEV_APP_URL to the Vite origin. This process is the API
	// (7778); the banner and the browser open must send the user to the frontend.
	const url = resolveAdvertisedAppUrl({
		listenUrl,
		devAppUrl: process.env.NARRAFORK_DEV_APP_URL,
	});
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;105m⛏  NarraFork\x1b[0m ${versionStr}`);
	console.log(`  \x1b[2m➜\x1b[0m  ${url}`);
	console.log(`  \x1b[2m➜\x1b[0m  mode: ${modeStr}`);
	console.log("");
	// No-op when the startup page already opened it.
	openFrontendOnce(url);
}

// Outline pages edited live when the previous process ended: commit what their logs hold.
const outlineLiveDatabaseWork = hotSafe(
	"outline.live.database-work.v1",
	() => new Set<Promise<unknown>>(),
);
let outlineLiveReplay: Promise<unknown> | undefined;

const teamDatabaseMaintenance = hotSafe("teams.database-maintenance.v1", () => ({
	stopped: false,
	failed: false,
	pending: new Set<Promise<unknown>>(),
	started: new Set<string>(),
	stops: new Set<() => void | Promise<void>>(),
}));

function trackTeamDatabaseMaintenance<T>(work: Promise<T>): Promise<T> {
	teamDatabaseMaintenance.pending.add(work);
	void work.then(
		() => teamDatabaseMaintenance.pending.delete(work),
		() => {
			teamDatabaseMaintenance.failed = true;
			teamDatabaseMaintenance.pending.delete(work);
		},
	);
	return trackCommunicationWork(work);
}

function startTeamDatabaseMaintenance(
	name: string,
	load: () => Promise<() => () => void | Promise<void>>,
): void {
	void trackTeamDatabaseMaintenance(
		load().then((start) => {
			if (
				teamDatabaseMaintenance.stopped ||
				teamDatabaseMaintenance.started.has(name) ||
				!httpLifecycle.accepting ||
				!databaseReadersAvailable(databaseReaderReadiness.state)
			)
				return;
			teamDatabaseMaintenance.stops.add(start());
			teamDatabaseMaintenance.started.add(name);
		}),
	).catch((error) => logger.warn("Team maintenance failed to start", { error: String(error) }));
}

function getTeamDatabaseMaintenanceStatus() {
	return {
		stopped: teamDatabaseMaintenance.stopped,
		pending: teamDatabaseMaintenance.pending.size,
		failed: teamDatabaseMaintenance.failed,
	};
}

async function stopTeamDatabaseMaintenance(): Promise<void> {
	teamDatabaseMaintenance.stopped = true;
	for (const stop of teamDatabaseMaintenance.stops) {
		try {
			void trackTeamDatabaseMaintenance(Promise.resolve(stop())).catch(() => {});
		} catch (error) {
			teamDatabaseMaintenance.failed = true;
			logger.warn("Team maintenance failed to stop", { error: String(error) });
		}
	}
	teamDatabaseMaintenance.stops.clear();
	while (teamDatabaseMaintenance.pending.size)
		await Promise.allSettled([...teamDatabaseMaintenance.pending]);
	if (teamDatabaseMaintenance.failed)
		throw new Error("Team maintenance did not drain successfully");
}

let stopPrefixSnapshotMaintenance = () => Promise.resolve();

// Request dumps and token repair data from before request evidence unification are discarded.
void removeLegacyRequestDumpDirs();

// Periodically remove old per-directory skill summary caches.
startSkillCacheCleanupTimer();

// Periodically remove expired/abandoned WebAuthn (passkey) ceremony challenges.
startChallengeCleanupTimer();

// Reclaim abandoned uploads without overlapping sweeps.
let attachmentSweepRunning = false;
setInterval(
	async () => {
		if (attachmentSweepRunning) return;
		attachmentSweepRunning = true;
		try {
			await sweepStagedAttachments();
		} catch (error) {
			logger.warn("Attachment staging sweep failed", { error: String(error) });
		} finally {
			attachmentSweepRunning = false;
		}
	},
	30 * 60 * 1000,
).unref();

// No startup workspace cleanup: workspaces used to be deleted when no sidebar tab
// referenced them, but the sidebar no longer lists workspaces at all (folders replaced
// that grouping), so every workspace would look orphaned. They are deleted explicitly.
// Register knowledge notification bridge (push publish/review state to reviewers + submitters)
initKnowledgeNotify();

// Register chat notification bridge (room messages to viewers, unread badges to the rest)
initChatNotify();

function cancelDatabaseStartup(): void {
	const error = "SERVER_SHUTTING_DOWN";
	startupReadiness.markFailed(error);
	startupReadiness.settle({ ok: false, error });
}

async function initializeDatabaseStartup(): Promise<void> {
	if (!httpLifecycle.accepting) return cancelDatabaseStartup();
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
	// 旧版 /modeltrace 每跑一次就留下一个 primary 叙述者；启动时把它们隐藏并把每个模型
	// 最近的一个收编成该模型的 ModelTrace 舱，保证旧历史仍能从模型入口打开。
	await import("./services/modeltrace-compat")
		.then(({ adoptLegacyModelTraceNarrators }) => adoptLegacyModelTraceNarrators())
		.catch((error) => logger.warn("Legacy ModelTrace adoption failed", { error: String(error) }));
	if (!httpLifecycle.accepting) return cancelDatabaseStartup();
	// Migrate OAuth authorities first, then stable resource provenance, in bounded yielding batches.
	// These services still use the SQLite proxy, so PostgreSQL explicitly gates the legacy path
	// instead of letting a fire-and-forget promise hit that proxy and swallow the failure.
	if (activeDatabaseBackend === "postgres") {
		logger.warn(
			"OAuth/integration startup backfills are not yet migrated to PostgreSQL; path gated",
		);
	} else {
		// Narrators written before runtime registrations store their relations from now on.
		await materializeLegacyDelegations().catch((error) =>
			logger.warn("Legacy delegation materialization failed", { error: String(error) }),
		);
		if (!httpLifecycle.accepting) return cancelDatabaseStartup();
		// The server is already serving here, so a failure is logged rather than thrown. It fails
		// closed: a grant without its authority row is rejected as invalid_grant, and a resource
		// without its binding is not listed for the client. The next startup retries the backfill.
		try {
			await backfillOAuthGrantAuthoritiesOnStartup();
			if (!httpLifecycle.accepting) return cancelDatabaseStartup();
			await backfillIntegrationResourceBindingsOnStartup();
		} catch (error) {
			logger.error(
				"OAuth/integration startup backfill failed; affected legacy grants stay denied",
				{
					error: String(error),
				},
			);
		}
	}

	if (!httpLifecycle.accepting) return cancelDatabaseStartup();
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
		// demand-driven (stale-while-revalidate on GET /api/quota-snapshots, plus a
		// refresh when provider settings change).
		const { refreshAllKimiUsages } = await import("./lib/kimi-usage-cache");
		void refreshAllKimiUsages().catch(() => {});
	} catch (err) {
		logger.warn("Kimi usage startup refresh failed", { error: String(err) });
	}
	if (!httpLifecycle.accepting) return cancelDatabaseStartup();

	try {
		// Demand-driven warmup, like Kimi; usage is intentionally memory-only, so a
		// restart re-reads it rather than trusting numbers from the previous process.
		const { refreshAllOpencodeUsages } = await import("./lib/opencode-usage-cache");
		void refreshAllOpencodeUsages().catch(() => {});
	} catch (err) {
		logger.warn("OpenCode usage startup refresh failed", { error: String(err) });
	}
	if (!httpLifecycle.accepting) return cancelDatabaseStartup();

	try {
		// Demand-driven warmup, like Kimi; balances are intentionally memory-only.
		const { refreshAllDeepSeekBalances } = await import("./lib/deepseek-balance-cache");
		void refreshAllDeepSeekBalances().catch(() => {});
	} catch {
		logger.warn("DeepSeek balance startup refresh failed");
	}
	if (!httpLifecycle.accepting) return cancelDatabaseStartup();

	// A user's template in a built-in's directory moves aside without losing its contents.
	void import("./services/custom-subagent-service")
		.then(({ moveAsideReservedTemplates }) => moveAsideReservedTemplates())
		.catch((err) => logger.warn("Reserved subagent template check failed", { error: String(err) }));

	// Mark any stale terminals from a previous run as exited
	terminalService.recoverOnStartup().catch((err) => {
		logger.error("Terminal recovery failed", { error: String(err) });
	});

	// Prepare tools before publishing each initialized MCP server's capabilities.
	mcpManager.prepareTools = prepareMcpTools;
	mcpManager.initialize().catch((err) => {
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
	const narratorRecovery = withBackgroundOccupancyInitialization(
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
			const protection = mergeStartupProtection(
				plannedUpdate.protection,
				ordinaryRestart.protection,
			);
			await recoverNarrators(protection, { heldRunIds: ordinaryRestart.heldRunIds });
			return { plannedUpdate, ordinaryRestart };
		},
		activeDatabaseBackend === "sqlite" ? backgroundOccupancyInitializer : undefined,
	)
		.then(async ({ plannedUpdate, ordinaryRestart }) => {
			if (!httpLifecycle.accepting) return cancelDatabaseStartup();
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
			// A notice can be durable in the mailbox while its post-commit wake was lost to
			// the previous process. Re-probe those recipients once recovery owners are mounted.
			if (automaticResumeEnabled())
				void import("./services/agent-runtime/inbox")
					.then(({ wakeQueuedTaskNoticeRecipientsOnStartup }) =>
						wakeQueuedTaskNoticeRecipientsOnStartup(),
					)
					.catch((err) =>
						logger.warn("Startup task-notice wake reconciliation failed", { error: String(err) }),
					);
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
			void import("./services/storage-history-runtime")
				.then(({ startStorageHistoryRetention }) => startStorageHistoryRetention())
				.catch((err) => logger.warn("History retention did not start", { error: String(err) }));
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
			const { scanBrokenModelNarrators } = await import(
				"./services/broken-model-migration-service"
			);
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
	cleanupStaleShares();

	// Clean up leftover pack extraction directories from previous server runs and mark any
	// still-"active" pack activations as released (their temp dirs don't survive a restart).
	packActivationService.cleanupStalePacks();

	// Small worker-owned batches reclaim unpublished or no-longer-referenced prefix snapshots.
	stopPrefixSnapshotMaintenance = startPrefixSnapshotMaintenance();

	// Periodically delete expired and revoked login sessions.
	startSessionCleanupTimer();

	// Poll for due scheduled tasks (periodic prompt → narrator). Re-arms on startup.
	void startupReadiness.barrier.then((recovery) => {
		if (!httpLifecycle.accepting || !databaseReadersAvailable(databaseReaderReadiness.state))
			return;
		if (!recovery.ok) {
			// The scheduler owns its own persisted records and skips narrators it cannot start, so a
			// failed recovery pass must not silently disable every future scheduled task.
			logger.warn("Starting scheduled task scheduler despite a failed startup recovery", {
				error: recovery.error,
			});
		}
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

	void startupReadiness.barrier.then(() => {
		if (!httpLifecycle.accepting || !databaseReadersAvailable(databaseReaderReadiness.state))
			return;
		outlineLiveReplay = trackOutlineLiveDatabaseWork(
			import("./services/outline/live/registry").then(({ startLiveReplay }) => {
				if (!httpLifecycle.accepting || !databaseReadersAvailable(databaseReaderReadiness.state))
					return;
				return startLiveReplay();
			}),
		);
		void outlineLiveReplay.catch((err) =>
			logger.warn("Outline live log replay failed", { error: String(err) }),
		);
		// Outline tasks: reopen tasks whose session's lease ran out (every minute, bounded) or whose
		// session was archived or deleted (on those events), and derive the in-process flag of
		// blocks written before it existed (once, page by page).
		import("./services/outline/tasks")
			.then(({ startOutlineTaskLeaseJob }) => {
				if (!httpLifecycle.accepting || !databaseReadersAvailable(databaseReaderReadiness.state))
					return;
				startOutlineTaskLeaseJob();
			})
			.catch((err) => logger.warn("Outline lease job failed to start", { error: String(err) }));
		import("./services/outline/in-process")
			.then(({ scheduleOutlineInProcessRebuild }) => {
				if (!httpLifecycle.accepting || !databaseReadersAvailable(databaseReaderReadiness.state))
					return;
				return scheduleOutlineInProcessRebuild();
			})
			.catch((err) => logger.warn("Outline in-process rebuild failed", { error: String(err) }));
		// Outline reports: each person's day, made in the background (a sweep every 5 minutes,
		// in bounded slices), and "today so far" when asked.
		import("./services/outline/digest-job")
			.then(({ startOutlineDigestJob }) => startOutlineDigestJob())
			.catch((err) => logger.warn("Outline report job failed to start", { error: String(err) }));
		// Outline team events: a session is told when a task is assigned to it by name, when a
		// prerequisite of its task ends, and when a task it created ends. The commits of the last
		// minutes are pushed again in the background (what a stop between a commit and its rows left
		// untold; a row written before is found and not written twice).
		import("./services/outline/team-events")
			.then(({ startOutlineTeamEvents, repushRecentOutlineTeamEvents }) => {
				startOutlineTeamEvents();
				return repushRecentOutlineTeamEvents();
			})
			.catch((err) => logger.warn("Outline team events failed to start", { error: String(err) }));
		// Sessions that still keep their tasks in Dynamic Spec are imported into the outline while
		// they are idle (a pass a minute after start, then at intervals; one session at a time).
		import("./services/outline/spec-import/triggers")
			.then(({ startSpecImportJob }) => startSpecImportJob())
			.catch((err) =>
				logger.warn("Dynamic Spec import job failed to start", { error: String(err) }),
			);
		// What the old Spec panel may have swallowed is looked for in the background (read-only; a
		// pass a while after start, then at intervals) and shown to people, never repaired.
		import("./services/outline/spec-import/loss-scan")
			.then(({ startSpecLossScanJob }) => startSpecLossScanJob())
			.catch((err) =>
				logger.warn("Swallowed-content scan failed to start", { error: String(err) }),
			);
		// Outline sessions' task changes, for plugins (narrafork.narrator.tasks.changed).
		import("./services/outline/plugin-task-events")
			.then(({ startOutlinePluginTaskEvents }) => startOutlinePluginTaskEvents())
			.catch((err) =>
				logger.warn("Outline plugin task events failed to start", { error: String(err) }),
			);
	});

	// Backfill legacy RecentTabs in bounded background batches. Membership consumers await this
	// process-wide singleton before querying the authoritative indexes.
	ensureAllRecentTabsMigrated()
		.then(() => logger.info("RecentTabs legacy migration scan completed"))
		.catch((err) => logger.warn("RecentTabs legacy migration scan failed", { error: String(err) }));

	// Start IM Gateway (Telegram, Discord, Slack, Feishu, Webhook)
	void startupReadiness.barrier.then((recovery) => {
		if (!httpLifecycle.accepting || !databaseReadersAvailable(databaseReaderReadiness.state))
			return;
		if (!recovery.ok) {
			logger.warn("Starting IM Gateway despite a failed startup recovery", {
				error: recovery.error,
			});
		}
		gateway.start().catch((err) => {
			logger.error("IM Gateway startup failed", { error: String(err) });
		});
	});

	// Activity projections consume source events independently of WebSocket delivery.
	initNotificationFanout();
	startNotificationCenterMaintenance();

	if (activeDatabaseBackend === "sqlite") {
		// Follow coordinator archive changes, saved-output ownership and finite work-item tails.
		startTeamDatabaseMaintenance("status", () =>
			import("./services/teams/team-service").then(
				({ startTeamStatusSync }) => startTeamStatusSync,
			),
		);
		startTeamDatabaseMaintenance("outputs", () =>
			import("./services/teams/coordinator-maintenance").then(
				({ startCoordinatorMaintenance }) => startCoordinatorMaintenance,
			),
		);
		startTeamDatabaseMaintenance("work", () =>
			import("./services/teams/work-items").then(
				({ startTeamWorkLifecycle }) => startTeamWorkLifecycle,
			),
		);
		// Keep changed paths and exclusive-path overlaps current under the same shutdown owner.
		startTeamDatabaseMaintenance("overlap", () =>
			import("./services/teams/team-overlap").then(
				({ startTeamOverlapJob }) => startTeamOverlapJob,
			),
		);
		// Stop containers and release ports that removed chapters left behind.
		retireLegacyChapterResources().catch((err) => {
			logger.warn("Legacy chapter resource cleanup failed", { error: String(err) });
		});
		// Re-derive which project every session belongs to, in bounded background pages.
		void scheduleProjectIndexRebuild();
		// Model aggregations become auto:/provider values; batched, logs and retries on failure.
		// SQLite only, like the provider prefix migration: it rewrites narrator rows through the
		// SQLite handle. On PostgreSQL the aggregation values keep resolving as before.
		void migrateAggregationsOnStartup();
	}
	await narratorRecovery;
}

const databaseStartup = createDatabaseReaderStartup({
	readiness: databaseReaderReadiness,
	initialize: initializeDatabaseStartup,
	onStop: cancelDatabaseStartup,
	onUnavailable: (result) => {
		logger.error("Database readers unavailable; database startup work is gated", {
			code: result.code,
		});
	},
	onError: (error) => {
		const message = error instanceof Error ? error.message : String(error);
		startupReadiness.markFailed(message);
		startupReadiness.settle({ ok: false, error: message });
		logger.error("Database startup initialization failed", { error: message });
	},
});
const databaseStartupPromise = databaseStartup.start();

// Establish client-egress relay channels for NUG providers configured with
// local egress (docs/CODEX_CLIENT_RELAY.md). Idempotent; also reconciled after
// every settings save.
reconcileNugRelayClients(settings.nugProviders ?? []);

type GracefulShutdownOptions = {
	reason: string;
	skipWindowsProcessTreeKill?: boolean;
	skipBashProcessKill?: boolean;
};

type GracefulShutdownResult = {
	success: boolean;
	clean: boolean;
	reason: string;
	pid: number;
	durationMs: number;
};

// Keep a single shutdown owner across --hot evaluations; hooks below delegate to the latest main.
const shutdownState = hotSafe<{
	promise: Promise<GracefulShutdownResult> | null;
	killWindowsProcessTreeOnExit: boolean;
	onSignal?: () => void;
	onExit?: () => void;
}>("narrafork.mainShutdown", () => ({ promise: null, killWindowsProcessTreeOnExit: true }));

/** Retain real ownership after a stage timeout, including delayed imports and live session writes. */
function trackOutlineLiveDatabaseWork<T>(work: Promise<T>): Promise<T> {
	outlineLiveDatabaseWork.add(work);
	void work.then(
		() => outlineLiveDatabaseWork.delete(work),
		() => outlineLiveDatabaseWork.delete(work),
	);
	return trackCommunicationWork(work);
}

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
	ownsDeadline = false,
	globalLimitMs?: number,
): Promise<"ok" | "timeout" | "failed"> {
	const startedAt = performance.now();
	if (timeoutMs <= 0) {
		tracker.recordStep(label, "timeout");
		try {
			logger.warn("Shutdown step skipped after deadline", { step: label, timeoutMs });
		} catch {
			/* diagnostics cannot prevent degraded shutdown */
		}
		return "timeout";
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expired = false;
	try {
		const work = Promise.resolve()
			.then(fn)
			.then(() => "ok" as const)
			.catch(() => {
				// A timed-out operation remains owned by its subsystem and final audit.
				// Diagnostic fields are fixed scalars and cannot expose worker inputs or secrets.
				if (!expired) {
					try {
						logger.warn("Shutdown step failed", { step: label, outcome: "failed" });
					} catch {
						/* diagnostic sinks cannot prevent recording the outcome */
					}
				}
				return "failed" as const;
			});
		// Self-deadline work owns the business timeout. Only the later, monotonic
		// global watchdog bounds a broken subsystem; it never races that same deadline.
		const hardLimitMs = ownsDeadline ? globalLimitMs : timeoutMs;
		const outcome =
			hardLimitMs === undefined
				? await work
				: await Promise.race([
						work,
						new Promise<"timeout">((resolve) => {
							timer = setTimeout(() => {
								expired = true;
								resolve("timeout");
							}, hardLimitMs);
						}),
					]);
		if (outcome === "timeout") {
			try {
				logger.warn("Shutdown step timed out", { step: label, outcome: "timeout", timeoutMs });
			} catch {
				/* diagnostic sinks cannot prevent recording the outcome */
			}
		}
		tracker.recordStep(label, outcome);
		try {
			logger.info("Shutdown stage settled", {
				stage: label,
				outcome,
				durationMs: Math.round(performance.now() - startedAt),
			});
		} catch {
			/* the outcome remains authoritative when diagnostics fail */
		}
		return outcome;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** One monotonic budget; epoch deadlines are converted only at subsystem boundaries. */
function createShutdownBudget() {
	const startedAt = performance.now();
	const globalDeadline = startedAt + 50_000;
	const businessDeadline = Math.min(startedAt + 30_000, globalDeadline - 10_000);
	return {
		businessRemaining: () => Math.max(0, businessDeadline - performance.now()),
		globalRemaining: () => Math.max(0, globalDeadline - performance.now()),
		readerRemaining: () => Math.min(10_000, Math.max(0, globalDeadline - performance.now())),
	};
}

/** Derived work can enqueue another collection; reach a shared fixed point before reader closure. */
async function drainShutdownDatabaseWork(deadlineAt: number): Promise<void> {
	let failure: { error: unknown } | undefined;
	let websocketFailed = false;
	let contextFailed = false;
	const ensureRemaining = () => {
		if (Date.now() >= deadlineAt) {
			throw failure?.error ?? new Error("Shutdown database work did not drain");
		}
	};
	for (;;) {
		ensureRemaining();
		try {
			await drainNarratorRunCompletions({ deadlineAt });
			await drainNarratorSessionTails({ deadlineAt });
		} catch (error) {
			failure ??= { error };
		}
		ensureRemaining();
		try {
			await backgroundTaskService.drainBashCollectors({ deadlineAt });
		} catch (error) {
			failure ??= { error };
		}
		ensureRemaining();
		try {
			await drainContextCharacterRefreshes({ deadlineAt });
		} catch (error) {
			contextFailed = true;
			failure ??= { error };
		}
		ensureRemaining();
		try {
			await drainNarratorWsReadTasks({ deadlineAt });
		} catch (error) {
			websocketFailed = true;
			failure ??= { error };
		}
		ensureRemaining();
		try {
			await drainBufferedFilePreparations({ deadlineAt });
		} catch (error) {
			failure ??= { error };
		}
		ensureRemaining();
		try {
			await drainCommunicationWork({ deadlineAt });
		} catch (error) {
			failure ??= { error };
		}
		ensureRemaining();
		try {
			await drainNotificationBackgroundWork({ deadlineAt });
		} catch (error) {
			failure ??= { error };
		}
		// Retained failures remain audit state, rather than work to retry in a tight loop.
		const context = getContextCharacterRefreshStatus();
		const contextPending =
			context.running ||
			context.scheduled ||
			(context.pending > 0 && (!contextFailed || !context.failed));
		const pending =
			getNarratorRunShutdownSnapshot().pending > 0 ||
			getNarratorSessionTailStatus().pending > 0 ||
			backgroundTaskService.getBashShutdownSnapshot().pending > 0 ||
			contextPending ||
			getCommunicationWorkStatus().pending > 0 ||
			getNotificationBackgroundWorkSnapshot().pending > 0 ||
			outlineLiveDatabaseWork.size > 0 ||
			hasPendingBufferedFilePreparations() ||
			(!websocketFailed && hasPendingNarratorWsReadTasks());
		if (!pending) break;
		if (Date.now() >= deadlineAt) {
			throw failure?.error ?? new Error("Shutdown database work did not drain");
		}
	}
	if (failure) throw failure.error;
}

/** After reader closure, inspect state only: no query, new work, or renewed deadline. */
function auditShutdownDatabaseWork(tracker: ShutdownActivityTracker): "ok" | "failed" {
	let outcome: "ok" | "failed" = "failed";
	try {
		const narrator = getNarratorSessionTailStatus();
		const runs = getNarratorRunShutdownSnapshot();
		const bash = backgroundTaskService.getBashShutdownSnapshot();
		const context = getContextCharacterRefreshStatus();
		const communication = getCommunicationWorkStatus();
		const notification = getNotificationBackgroundWorkSnapshot();
		const storageHistory = getStorageHistoryShutdownSnapshot();
		const teamMaintenance = getTeamDatabaseMaintenanceStatus();
		const buffered = getBufferedFilePreparationStatus();
		const bufferedPending = Boolean(
			buffered.pending || buffered.active || buffered.waiting || buffered.batches,
		);
		const websocketPending = hasPendingNarratorWsReadTasks();
		const outlineLivePending = outlineLiveDatabaseWork.size;
		const maintenance = getResourceProtectionShutdownSnapshot();
		const integrity = getIntegrityCheckShutdownSnapshot();
		const maintenancePending =
			!maintenance.stopped ||
			maintenance.pendingTasks > 0 ||
			maintenance.pendingReceiptImports > 0 ||
			maintenance.maintenanceScheduled;
		const integrityPending =
			!integrity.stopped ||
			integrity.pendingProcesses > 0 ||
			integrity.pendingTasks > 0 ||
			integrity.scheduled;
		if (
			!runs.stopped ||
			runs.pending ||
			runs.failed ||
			!bash.stopped ||
			bash.pending ||
			bash.failed ||
			narrator.pending ||
			narrator.failed ||
			context.pending ||
			context.running ||
			context.scheduled ||
			context.failed ||
			!context.quiescing ||
			communication.pending ||
			communication.failed ||
			!notification.stopped ||
			notification.pending ||
			notification.failed ||
			!storageHistory.stopped ||
			storageHistory.pending ||
			storageHistory.failed ||
			!teamMaintenance.stopped ||
			teamMaintenance.pending ||
			teamMaintenance.failed ||
			bufferedPending ||
			buffered.failed ||
			maintenancePending ||
			integrityPending ||
			databaseStartup.pending ||
			outlineLivePending ||
			websocketPending
		) {
			logger.warn("Shutdown database work is not quiescent", {
				runs,
				bash,
				narratorSessionPending: narrator.pending,
				narratorSessionFailed: narrator.failed,
				contextPending: context.pending,
				contextRunning: context.running,
				contextScheduled: context.scheduled,
				contextFailed: context.failed,
				contextQuiescing: context.quiescing,
				communicationPending: communication.pending,
				communicationFailed: communication.failed,
				notification,
				storageHistory,
				teamMaintenance,
				bufferedPending,
				bufferedPreparationPending: buffered.pending,
				bufferedPreparationActive: buffered.active,
				bufferedPreparationWaiting: buffered.waiting,
				bufferedPreparationBatches: buffered.batches,
				bufferedPreparationFailed: buffered.failed,
				websocketPending,
				outlineLivePending,
				maintenance,
				integrity,
				databaseStartupPending: databaseStartup.pending,
			});
		} else {
			outcome = "ok";
		}
	} catch (error) {
		logger.warn("Shutdown database work audit failed", { error: String(error) });
	}
	tracker.recordStep("databaseWork.finalAudit", outcome);
	return outcome;
}

async function performGracefulShutdown(
	options: GracefulShutdownOptions,
): Promise<GracefulShutdownResult> {
	if (shutdownState.promise) return shutdownState.promise;
	const startedAt = Date.now();
	const budget = createShutdownBudget();
	if (options.skipWindowsProcessTreeKill) {
		shutdownState.killWindowsProcessTreeOnExit = false;
	}

	shutdownState.promise = (async () => {
		try {
			logger.info("Graceful shutdown started", { reason: options.reason });
		} catch {
			// Observational sinks cannot prevent producers from stopping.
		}
		databaseStartup.stop();
		backgroundOccupancyInitializer.stop();
		stopHeartbeat();

		// Track every teardown step's outcome. The clean-shutdown marker is a promise that the DB
		// reached a quiescent, consistent state — so it is written ONLY at the very end, and only
		// when requests drained AND every teardown step succeeded. If any step times out or throws,
		// we skip the marker and just release the lock (below), so the next startup runs its
		// integrity check instead of trusting a shutdown we could not prove was consistent.
		const tracker = new ShutdownActivityTracker();
		const step = (label: string, fn: () => unknown, limit = 4_000, ownsDeadline = false) =>
			shutdownStep(
				tracker,
				label,
				fn,
				Math.min(limit, budget.businessRemaining()),
				ownsDeadline,
				budget.globalRemaining(),
			);

		// Stop accepting work before teardown begins. Bun.Server.stop(true) closes the listener and
		// terminates in-flight HTTP requests and WebSockets synchronously, so no new work can arrive
		// once stopHttpListener() returns; its promise is deliberately not awaited because Bun never
		// settles it after a server-side ws.close() (see stopHttpListener). The authenticated update
		// handoff treats its marker file as authoritative when this intentionally closes the request
		// before its response is flushed, so it is safe to close every connection here. The two drain
		// steps below are what guarantee later teardown cannot race a handler that writes to SQLite
		// after the clean marker.
		httpLifecycle.stopAccepting();
		const cpuProfilerStop = cpuProfiler.shutdown();
		quiesceNarratorWsReadTasks();
		const producerLabel = "databaseProducers.stop";
		let producerFailure: { error: unknown } | undefined;
		for (const stop of [
			() =>
				backgroundTaskService.stopBashCollectors({
					preserveProcesses: options.skipBashProcessKill,
				}),
			stopNarratorRunAdmission,
			stopRuntimePublications,
			stopInboxWakes,
			stopBufferedFilePreparations,
			stopOutlineLiveReplay,
			quiesceContextCharacterRefreshes,
			stopSessionCleanupTimer,
		]) {
			try {
				stop();
			} catch (error) {
				producerFailure ??= { error };
			}
		}
		const producerOutcome = producerFailure ? "failed" : "ok";
		tracker.recordStep(producerLabel, producerOutcome);
		if (producerFailure)
			logger.warn("Shutdown producer admission failed", { error: String(producerFailure.error) });
		const ownerDeadlineAt = Date.now() + budget.businessRemaining();
		// Freeze synchronous admission and initiate asynchronous teardown before any await below.
		const maintenanceStop = stopResourceProtectionIndex({ deadlineAt: ownerDeadlineAt });
		const integrityStop = cancelBackgroundIntegrityCheck({
			permanent: true,
			deadlineAt: ownerDeadlineAt,
		});
		const projectIndexStop = stopProjectIndexRebuild();
		const blockJobsStop = stopBlockBackgroundJobs({ deadlineAt: ownerDeadlineAt });
		const storageHistoryStop = stopStorageHistoryRetention({ deadlineAt: ownerDeadlineAt });
		const occupancyStop = stopBackgroundOccupancy();
		const scheduledStop = stopScheduledTaskScheduler();
		const teamMaintenanceStop = stopTeamDatabaseMaintenance();
		const prefixSnapshotsStop = stopPrefixSnapshotMaintenance();
		const outlineTaskLeasesStop = Promise.all([
			import("./services/outline/tasks").then(({ stopOutlineTaskLeaseJob }) =>
				stopOutlineTaskLeaseJob(),
			),
			import("./services/outline/in-process").then(({ stopOutlineInProcessRebuild }) =>
				stopOutlineInProcessRebuild(),
			),
			import("./services/outline/digest-job").then(({ stopOutlineDigestJob }) =>
				stopOutlineDigestJob(),
			),
			import("./services/outline/spec-import/triggers").then(({ stopSpecImportJob }) =>
				stopSpecImportJob(),
			),
			import("./services/outline/spec-import/loss-scan").then(({ stopSpecLossScanJob }) =>
				stopSpecLossScanJob(),
			),
		]);
		const fanoutStop = stopNotificationFanout();
		const notificationMaintenanceStop = stopNotificationCenterMaintenance();
		const notificationBackgroundStop = stopNotificationBackgroundWork({
			deadlineAt: ownerDeadlineAt,
		});
		getCodexManager().stopUsageRefreshScheduler();
		for (const stopping of [
			maintenanceStop,
			integrityStop,
			projectIndexStop,
			blockJobsStop,
			storageHistoryStop,
			occupancyStop,
			scheduledStop,
			teamMaintenanceStop,
			prefixSnapshotsStop,
			outlineTaskLeasesStop,
			fanoutStop,
			notificationMaintenanceStop,
			notificationBackgroundStop,
		])
			void Promise.resolve(stopping).catch(() => {});
		await step("remoteAccess.stop", stopRemoteAccess, 5_000);
		httpLifecycle.abortAll();
		let preserveAgentRuns = false;
		if (options.reason === "signal") {
			const prepared = await step("restartRecovery.prepare", prepareSignalRestartRecovery, 5_000);
			if (prepared === "ok") {
				preserveAgentRuns = true;
				// Worker teardown must not turn checkpointed runs into task failures.
				markUpdateRestarting();
			}
		}
		// Prepared maintenance runs stay parked until the gate enters restarting. Signal
		// recovery must make that transition before checkpoint stop can unwind their tails.
		if (producerOutcome === "ok") await step("checkpointRuns.pause", stopCheckpointedNarratorRuns);
		const shutdownRequestId = httpRequestContext.getStore();
		// Outline pages being edited live: log what arrived and acknowledge it while the sockets
		// are still open, so the editors forget it instead of replaying it after the restart.
		const outlineLivePersist = trackOutlineLiveDatabaseWork(
			import("./services/outline/live/registry").then((live) => live.persistAllLiveSessions()),
		);
		await step("outlineLive.persist", () => outlineLivePersist, 2_000);
		await step("cpuProfiler.stop", () => cpuProfilerStop);
		closeAllConnections();
		// A short budget is honest here: stopHttpListener() is synchronous by design
		// (it never awaits stop()'s promise), so anything beyond a moment means the
		// call itself threw or blocked, not that connections are still draining.
		const serverStopOutcome = await step("httpServer.stop", () => stopHttpListener(), 1_000);
		const httpDrainOutcome = await step(
			"httpHandlers.drain",
			() => waitForHttpRequestDrain(shutdownRequestId),
			10_000,
		);
		const wsDrainOutcome = await step(
			"websocketHandlers.drain",
			waitForWebSocketActivityDrain,
			10_000,
		);
		if (serverStopOutcome === "ok" && httpDrainOutcome === "ok" && wsDrainOutcome === "ok") {
			tracker.markDrainComplete();
		}
		await step("databaseStartup.drain", () => databaseStartup.drain(), budget.businessRemaining());

		// Sandboxed host-tool callers stop before their outline/editor/compute dependencies.
		await step(
			"programmaticServices.close",
			() =>
				import("./lib/agent/programmatic/service").then((owner) =>
					owner.closeProgrammaticServices(),
				),
			155_000,
		);

		// Finish startup replay and commit live editor text before closing their dependencies.
		const outlineLiveClose = trackOutlineLiveDatabaseWork(
			(async () => {
				try {
					await outlineLiveReplay;
				} finally {
					const live = await import("./services/outline/live/registry");
					await live.closeAllLiveSessions("ended");
				}
			})(),
		);
		await step("outlineLive.close", () => outlineLiveClose, 5_000);
		await step("outlineTaskLeases.stop", () => outlineTaskLeasesStop, 5_000);
		await step("scheduledTasks.stop", () => scheduledStop);
		await step("teamMaintenance.stop", () => teamMaintenanceStop, budget.businessRemaining());
		await step("authSessions.stop", () => {});
		await step("gateway.stop", () => gateway.shutdown());
		await step("prefixSnapshots.stop", () => prefixSnapshotsStop);
		await step("notificationFanout.stop", () => fanoutStop);
		await step("notificationMaintenance.stop", () => notificationMaintenanceStop);
		await step(
			"notificationBackground.stop",
			() => notificationBackgroundStop,
			budget.businessRemaining(),
			true,
		);
		await step(
			"outlineTextWorkers.close",
			() =>
				import("./services/outline/edit-text-runner").then((owner) => owner.closeEditTextWorkers()),
			35_000,
		);
		// Finish an already-committing token batch through its original owner before closing helpers.
		await step(
			"tokenWorkers.close",
			() =>
				import("./services/token-recalculation-worker-client").then((owner) =>
					owner.closeTokenRecalculationWorkers(),
				),
			TOKEN_RECALCULATION_BATCH_TIMEOUT_MS + 5_000,
		);
		await step("terminalService.shutdownAll", () => terminalService.shutdownAll());
		// The built-in apikey-quota plugin's process is owned by the shared plugin runtime
		// supervisor, so `pluginManager.shutdown()` below stops it along with every other
		// plugin. Keeping a dedicated teardown step here would imply a second owner.
		if (!options.skipBashProcessKill) {
			await step("killAllBashProcesses", () =>
				killAllBashProcesses({ preserveAgents: preserveAgentRuns }),
			);
		}
		await step("integrityProbe.cancel", () => integrityStop, budget.businessRemaining(), true);
		await step(
			"resourceProtectionIndex.stop",
			() => maintenanceStop,
			budget.businessRemaining(),
			true,
		);
		await step("vnetUdpRendezvous.stop", () => stopVNetUdpRendezvous());
		await step("pluginPlatformProducers.stop", () =>
			import("./services/plugin-platform-services").then((owner) =>
				owner.stopPluginPlatformProducers(),
			),
		);
		await step("pluginManager.shutdown", () => pluginManager.shutdown(), 125_000);
		await step("commandCode.models.stop", stopCommandCodeModelCatalog);
		unregisterExternalProviderResolver();
		await step("mcpManager.shutdown", () => mcpManager.shutdown());
		// Checkpoint-backed update/system shutdown: persist active browser sessions and flip the
		// pool into preserve-on-close mode so browserPool.close disconnects (keeps Chrome alive)
		// for recovery. A normal shutdown skips this and closes the browser as usual.
		if (preservesRecoveryOnShutdown(options.reason)) {
			await step(
				"browserSessions.persistForUpdate",
				() =>
					import("./services/browser-session-recovery").then(
						({ persistBrowserSessionsForUpdate }) => persistBrowserSessionsForUpdate(),
					),
				35_000,
			);
		}
		// Finalize/cleanup/reply grace and real native exit precede Chrome close or preserve detach.
		await step(
			"browserMemoryWorkers.close",
			() =>
				import("./lib/browser/memory-job").then((owner) => owner.closeMemoryDiagnosticWorkers()),
			35_000,
		);
		// Close browser pool if it was started. When preserve mode was set above, this disconnects
		// from Chrome (leaving it running for the replacement process) rather than closing it.
		await step("browserPool.close", () =>
			import("./lib/browser/pool").then(({ closeBrowser }) => closeBrowser()),
		);
		// Close Codex WebSocket session cache — active outbound WS
		// connections keep the event loop alive and delay exit.
		await step("codexWebSocket.clear", () =>
			import("./lib/agent/codex-websocket").then(({ clearCodexResponsesWebSocketSessions }) =>
				clearCodexResponsesWebSocketSessions(),
			),
		);
		// Keep the existing 30s IO/ACK phases and still allow actual exit to be observed.
		await step(
			"editorDocuments.close",
			() =>
				import("./services/editor-document-runtime").then((owner) =>
					owner.closeEditorDocumentService(),
				),
			70_000,
		);
		await step("computeWorkers.close", async () => {
			const results = await Promise.allSettled([
				import("./services/revert-transaction-worker").then((owner) =>
					owner.closeRevertManifestWorkers(),
				),
				import("./services/revert-selection-service").then((owner) =>
					owner.closeRevertBodyWorkers(),
				),
				import("./services/revert-history-commit").then((owner) =>
					owner.closeRevertRewriteWorkers(),
				),
				import("./lib/share-preview-html").then((owner) => owner.closeSharePreviewHtmlWorkers()),
				import("./lib/agent/request-json").then((owner) => owner.closeRequestJsonWorkers()),
				import("./lib/agent/structural/worker-client").then((owner) =>
					owner.closeStructuralWorkers(),
				),
				import("./services/gen-ui/compiler").then((owner) => owner.closeGenUiCompilerWorkers()),
				import("./lib/agent/execution/local-backend").then((owner) =>
					owner.closeLocalGlobWorkers(),
				),
				import("./lib/agent/image-generation-response").then((owner) =>
					owner.closeImageGenerationResponseWorkers(),
				),
			]);
			const failures = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (failures.length) throw new AggregateError(failures, "Compute workers did not all close");
		});
		await step(
			"gitWorkers.close",
			async () => {
				const results = await Promise.allSettled([
					import("./services/git-current-baseline").then((owner) =>
						owner.closeGitCurrentBaselineWorkers(),
					),
					import("./services/git-line-stats").then((owner) => owner.closeGitLineStatsWorkers()),
				]);
				const failures = results.flatMap((result) =>
					result.status === "rejected" ? [result.reason] : [],
				);
				if (failures.length)
					throw new AggregateError(failures, "Git worker helpers did not all close");
			},
			35_000,
		);
		// Preserve the existing 65s archive ACK and subsequent 120s download lease, plus cleanup.
		await step(
			"requestRecorderWorkers.close",
			() => import("./lib/request-recorder").then((owner) => owner.closeRequestRecorderWorkers()),
			200_000,
		);
		await step("modelHistoryWorkers.close", () =>
			import("./services/agent-runtime/model-history-source").then((owner) =>
				owner.closeModelHistoryWorkers(),
			),
		);
		await step(
			"toolInputHistoryWorkers.close",
			() =>
				import("./services/tool-input-stream-source").then((owner) =>
					owner.closeToolInputHistoricalWorkers(),
				),
			15_000,
		);
		await step("fsScanWorkers.close", () =>
			import("./lib/fs-scan-worker/client").then((owner) => owner.closeFsScanWorkers()),
		);
		// The background integrity probe is a separate PROCESS holding a read-only handle on the
		// database for up to 10 minutes. Left running it becomes an orphan: it keeps scanning while a
		// replacement process may swap the database file (startup recovery) or rewrite it (admin
		// VACUUM), and its verdict has no parent to report to.
		await step(
			"maintenanceWorkers.close",
			async () => {
				const results = await Promise.allSettled([
					import("./db/snapshot-build").then((owner) => owner.closeSnapshotBuilds()),
					import("./services/file-change-physical-audit").then((owner) =>
						owner.closeFileChangePhysicalAudits(),
					),
				]);
				const failures = results.flatMap((result) =>
					result.status === "rejected" ? [result.reason] : [],
				);
				if (failures.length)
					throw new AggregateError(failures, "Maintenance workers did not all close");
			},
			35_000,
		);
		if (!options.skipWindowsProcessTreeKill) {
			killOwnWindowsChildProcesses();
		}

		// All producer admission was frozen before awaiting request teardown.
		const businessDeadlineAt = ownerDeadlineAt;
		const remaining = budget.businessRemaining;
		await step("backgroundOccupancy.stop", () => occupancyStop, remaining());
		await step("projectIndex.stop", () => projectIndexStop, remaining(), true);
		await step("blockBackgroundJobs.stop", () => blockJobsStop, remaining(), true);
		await step("storageHistory.stop", () => storageHistoryStop, remaining(), true);
		await step(
			"databaseWork.drain",
			() => drainShutdownDatabaseWork(businessDeadlineAt),
			remaining(),
			true,
		);
		// History cleanup may still be finishing its current transaction after cancellation.
		const storageHistory = getStorageHistoryShutdownSnapshot();
		if (storageHistory.pending) {
			tracker.recordStep("storageHistory.quiescence", "failed");
			auditShutdownDatabaseWork(tracker);
			logger.warn("History cleanup did not drain; retaining database ownership until exit", {
				pending: storageHistory.pending,
			});
			return {
				success: false,
				clean: false,
				reason: options.reason,
				pid: process.pid,
				durationMs: Date.now() - startedAt,
			};
		}
		// A timed-out live writer still owns the database. Keep its readers and instance lock
		// until process exit rather than handing the database to a replacement while it can write.
		if (outlineLiveDatabaseWork.size) {
			tracker.recordStep("outlineLive.quiescence", "failed");
			auditShutdownDatabaseWork(tracker);
			logger.warn("Outline live work did not drain; retaining database ownership until exit", {
				pending: outlineLiveDatabaseWork.size,
			});
			return {
				success: false,
				clean: false,
				reason: options.reason,
				pid: process.pid,
				durationMs: Date.now() - startedAt,
			};
		}
		if (getTeamDatabaseMaintenanceStatus().pending) {
			tracker.recordStep("teamMaintenance.quiescence", "failed");
			auditShutdownDatabaseWork(tracker);
			logger.warn("Team maintenance did not drain; retaining database ownership until exit");
			return {
				success: false,
				clean: false,
				reason: options.reason,
				pid: process.pid,
				durationMs: Date.now() - startedAt,
			};
		}
		if (databaseStartup.pending) {
			tracker.recordStep("databaseStartup.quiescence", "failed");
			auditShutdownDatabaseWork(tracker);
			logger.warn("Startup initialization did not drain; retaining database ownership until exit");
			return {
				success: false,
				clean: false,
				reason: options.reason,
				pid: process.pid,
				durationMs: Date.now() - startedAt,
			};
		}
		// Native reader exit owns a separate slice even when the business drain expired.
		const readerBudget = budget.readerRemaining();
		await shutdownStep(
			tracker,
			"dbWorkerPool.shutdown",
			async () => {
				await shutdownDbWorkerPool({ permanent: true });
			},
			readerBudget,
			true,
			budget.globalRemaining(),
		);
		await shutdownStep(
			tracker,
			"prefixSnapshots.close",
			() => closePrefixSnapshotStore({ permanent: true }),
			Math.min(4_000, budget.globalRemaining()),
		);
		await shutdownStep(
			tracker,
			"postgresRuntime.close",
			() => closePostgresRuntime(),
			Math.min(4_000, budget.globalRemaining()),
		);
		auditShutdownDatabaseWork(tracker);

		// Decide the marker now that teardown is finished. A clean shutdown (requests drained AND
		// every step succeeded) persists the marker and releases the lock; a degraded shutdown skips
		// the marker but still releases the lock so an update-handoff replacement can start.
		if (budget.globalRemaining() <= 0) tracker.recordStep("shutdown.deadline", "timeout");
		const summary = tracker.summary();
		const cleanMarked = summary.clean ? markDatabaseCleanShutdown() : false;
		if (!summary.clean) {
			try {
				logger.warn("Graceful shutdown degraded — releasing lock without clean marker", {
					drainComplete: summary.drainComplete,
					degradedStepCount: summary.degradedSteps.length,
				});
			} catch {
				// Diagnostic failure cannot suppress the unclean lock-release path.
			}
			releaseDatabaseInstanceLockOnly();
		}

		const result = {
			success: !getTeamDatabaseMaintenanceStatus().failed,
			clean: summary.clean && (activeDatabaseBackend === "postgres" || cleanMarked),
			reason: options.reason,
			pid: process.pid,
			durationMs: Date.now() - startedAt,
		};
		try {
			logger.info("Graceful shutdown completed", {
				...result,
				cleanMarked,
				outcome: cleanMarked ? "clean" : "degraded",
				degradedSteps: summary.degradedSteps,
			});
		} catch {
			// Cleanup has completed; keep its result even if diagnostics are unavailable.
		}
		return result;
	})();

	return shutdownState.promise;
}

registerGracefulShutdownHandler(async () => {
	try {
		logger.info("Replacement server requested graceful shutdown", {
			phase: "replacement",
			outcome: "requested",
		});
	} catch {
		// A diagnostic sink cannot prevent the registered shutdown sequence.
	}
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
	if (reason === UNATTENDED_SHUTDOWN_REASON) {
		let ready = false;
		try {
			ready = await fenceUnattendedShutdown(
				() =>
					shutdownState.promise !== null ||
					httpLifecycle.activeCount > 0 ||
					hasActiveWebSocketHandlers() ||
					isScheduledTaskTickActive(),
				unattendedMode.revalidateIdle,
			);
		} catch (error) {
			logger.warn("Unattended shutdown revalidation failed", { error: String(error) });
		}
		if (!ready) {
			unattendedMode.deferShutdown();
			return null;
		}
	}
	try {
		logger.info("Administrator requested shutdown", { phase: "operator", outcome: "requested" });
	} catch {
		// Operators must still reach cleanup when diagnostics are unavailable.
	}
	const preserveForRecovery = preservesRecoveryOnShutdown(reason);
	const result = await performGracefulShutdown({
		reason,
		skipWindowsProcessTreeKill: preserveForRecovery,
		skipBashProcessKill: preserveForRecovery,
	});
	if (canRunCleanShutdownHooks(reason, result)) await runPostShutdownHooks(reason);
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
shutdownState.onSignal = safeShutdown;
if (hotOnce("narrafork.mainShutdown.signals")) {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => shutdownState.onSignal?.());
	}
}
// Only the registered main sequence may decide when preserve metadata and Chrome are closed.
// Standalone browser scripts retain their own signal cleanup until this synchronous claim.
claimBrowserShutdownOwnership();
// On Windows, closing the console window may not deliver SIGINT/SIGTERM.
// "exit" fires when the event loop drains or process.exit() is called elsewhere.
// NOTE: "exit" handlers MUST be synchronous — async work is ignored.
shutdownState.onExit = () => {
	try {
		_server?.stop(true);
	} catch {
		// best effort
	}
	// The current main owns the current listener/process tree; preserve handoff intent across HMR.
	if (IS_WINDOWS && shutdownState.killWindowsProcessTreeOnExit) {
		killOwnWindowsChildProcesses();
	}
};
if (hotOnce("narrafork.mainShutdown.exit")) {
	process.on("exit", () => shutdownState.onExit?.());
}
await databaseStartupPromise;
