import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, rmSync } from "node:fs";
import { extname, resolve } from "node:path";

import { eq } from "drizzle-orm";

import { app } from "./app";
import "./db"; // Ensure DB is initialized early
import { db, markDatabaseCleanShutdown, releaseDatabaseInstanceLockOnly } from "./db";
import { users } from "./db/schema";
import { registerExternalProviderResolver } from "./lib/agent/provider";
import { verifyToken } from "./lib/auth";
import { resolveClientIp } from "./lib/client-ip";
import { getCodexManager } from "./lib/codex-manager";
import { startEventLoopMonitor } from "./lib/event-loop-monitor";
import {
import { logger } from "./lib/logger";
import { mcpManager } from "./lib/mcp/manager";
import { syncMcpTools } from "./lib/mcp/tool-bridge";
import { getNarraforkPath } from "./lib/narrafork-home";
import { validateAccessTokenById } from "./lib/oauth-provider";
import { IS_MACOS, IS_WINDOWS, initWslFlag } from "./lib/platform";
import { projectDbManager } from "./lib/project-db";
import {
	registerGracefulShutdownHandler,
	registerRuntimeAddressGetter,
	registerServerRestart,
} from "./lib/server-restart";
import { saveSettings, settings } from "./lib/settings";
import { ShutdownActivityTracker } from "./lib/shutdown-activity";
import type { VNetRelayAuth } from "./lib/vnet/types";
import { startVNetUdpRendezvous, stopVNetUdpRendezvous } from "./lib/vnet/udp-rendezvous";
import { clearInheritableHandlesAfterServerBind } from "./lib/win-handle-guard";
import { pluginManager } from "./services/plugin-manager";
import { pluginProviderRegistry } from "./services/plugin-provider-registry";
import { ensureAllRecentTabsMigrated } from "./services/recent-tabs-service";

// Parse --wsl=true|false CLI flag (default: false — WSL disallowed)
initWslFlag();

import { chapterBatchMerge } from "./services/chapter-batch-merge";
import { chapterCleanup } from "./services/chapter-cleanup";
import {
	reconcileContainerStates,
	startContainerProxy,
	stopContainerProxy,
} from "./services/container-proxy";
import { ensureRootlessEnv } from "./services/container-service";
import {
	recoverOnStartup as recoverNarrators,
	restorePendingModelOverrides,
} from "./services/narrator-session";
import "./services/notification-service"; // Register notification event listeners
import "./services/attention-hook-bridge"; // Bridge attention events into the hook system
import { killAllBashProcesses } from "./lib/agent/tools/bash";
import { registerChatGroupEventListeners } from "./services/chat-group-service";
import { initContainerEventHandler } from "./services/container-event-handler";
import { initDeviceConnectionService } from "./services/device-connection-service";
import { initDeviceTransferService } from "./services/device-transfer-service";
import { backfillIntegrationResourceBindingsOnStartup } from "./services/integration-resource-binding-service";
import { backfillOAuthGrantAuthoritiesOnStartup } from "./services/oauth-grant-service";
import {
	consumeOAuthWsTicket,
	EXTERNAL_NARRATORS_WS_CHANNEL,
	getExternalWebSocketRolloutSettings,
	isExternalWebSocketOriginAllowed,
} from "./services/oauth-ws-ticket-service";
import { registerProjectDbSync } from "./services/project-db-sync";
import { recoverProviderPrefixMigrationOnStartup } from "./services/provider-prefix-migration-service";
import { initReviewEventHandler } from "./services/review-event-handler";
import { terminalService } from "./services/terminal-service";
import {
	getPlannedUpdateStartupProtection,
	restoreNarratorsAfterPlannedUpdate,
} from "./services/update-recovery-service";
import { worktreeWatcher } from "./services/worktree-watcher";
import { canAcceptExternalNarratorConnection } from "./websocket/oauth-connection-registry";
import {
	closeAllConnections,
	resolveExternalNarratorWSData,
	resolveWSData,
	startHeartbeat,
	stopHeartbeat,
	waitForWebSocketActivityDrain,
	wsHandlers,
} from "./websocket/ws-handler";

// Register the optional executable-plugin provider bridge. Builtin and compatible-API
// providers remain the fallback; an unavailable plugin provider returns null and
// preserves the existing resolution error semantics.
const unregisterExternalProviderResolver = registerExternalProviderResolver((_provider, model) => {
	return pluginProviderRegistry.tryResolveProvider(model)?.adapter ?? null;
});

// Resolve any interrupted cross-store provider prefix migration before accepting requests.
// A mismatched journal intentionally fails startup rather than serving mixed model references.
recoverProviderPrefixMigrationOnStartup();

// Track event-loop stalls early so blocking operations are visible in logs/diagnostics.
startEventLoopMonitor();

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
let currentHost = cliHost || process.env.HOST || settings.server.host;
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
]);

function getFrontendCacheControl(path: string): string {
	if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
	if (NO_CACHE_FRONTEND_PATHS.has(path)) return "no-cache";
	return "public, max-age=3600";
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
					return new Response(indexFile, {
						headers: {
							"Content-Type": "text/html; charset=utf-8",
							"Cache-Control": "no-cache",
						},
					});
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
		const result = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe", stderr: "ignore" });
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
			{ stdout: "pipe", stderr: "ignore" },
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
				});
			} catch {
				// best effort
			}
		}

		// Also check: maybe the ghost PID's parent spawned other children that
		// inherited the handle. Look up the parent first.
		const parentQuery = Bun.spawnSync(
			["wmic", "process", "where", `(ProcessId=${pid})`, "get", "ParentProcessId", "/FORMAT:CSV"],
			{ stdout: "pipe", stderr: "ignore" },
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
				{ stdout: "pipe", stderr: "ignore" },
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
			{ stdout: "pipe", stderr: "ignore" },
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
			});
		} catch {
			// best effort — process may already be gone
		}
	}
}

type StartupRecoveryResult = { ok: true } | { ok: false; error: string };
type StartupRecoveryState =
	| { status: "recovering" }
	| { status: "ready" }
	| { status: "failed"; error: string };

let startupRecoveryState: StartupRecoveryState = { status: "recovering" };
let resolveStartupRecovery: (result: StartupRecoveryResult) => void = () => {};
const startupRecoveryBarrier = new Promise<StartupRecoveryResult>((resolve) => {
	resolveStartupRecovery = resolve;
});

// Try to start the server, with automatic port fallback when the default port is busy.
const MAX_PORT_RETRIES = 10;

/** Return the URL protocol based on current TLS config. */
function getProtocol(): "https" | "http" {
	return settings.server.tls?.enabled ? "https" : "http";
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
			return { kind: "jwt", userId: payload.sub };
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

function startServer(listenPort: number) {
	const tlsCfg = settings.server.tls;
	const tls =
		tlsCfg?.enabled && tlsCfg.certFile && tlsCfg.keyFile
			? {
					cert: Bun.file(tlsCfg.certFile),
					key: Bun.file(tlsCfg.keyFile),
					...(tlsCfg.passphrase && { passphrase: tlsCfg.passphrase }),
					...(tlsCfg.caFile && { ca: Bun.file(tlsCfg.caFile) }),
				}
			: undefined;

	const server = Bun.serve({
		port: listenPort,
		hostname: currentHost,
		idleTimeout: 255,
		tls,
		fetch(req, server) {
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
							...healthPayload,
							status:
								startupRecoveryState.status === "ready"
									? healthPayload.status
									: startupRecoveryState.status,
							readiness: startupRecoveryState.status,
							...(startupRecoveryState.status === "failed"
								? { recoveryError: startupRecoveryState.error }
								: {}),
						}),
						{
							status: startupRecoveryState.status === "failed" ? 503 : healthResponse.status,
							headers,
						},
					);
				}
				const recovery = await startupRecoveryBarrier;
				if (!recovery.ok) {
					return new Response("Startup narrator recovery failed", {
						status: 503,
						headers: { "Retry-After": "5" },
					});
				}

				if (url.pathname === "/ws/external/v1/narrators") {
					const rollout = getExternalWebSocketRolloutSettings();
					if (!rollout.enabled || !rollout.readEnabled) {
						return new Response("External narrator WebSocket is disabled", { status: 403 });
					}
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
					if (!consumed)
						return new Response("Invalid or expired WebSocket ticket", { status: 401 });
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

				// Everything else goes to Hono. Resolve the client IP at the Bun socket
				// boundary so auth throttling never trusts a caller-supplied header directly.
				const clientIp = resolveClientIp({
					peerIp: server.requestIP(req)?.address,
					xForwardedFor: req.headers.get("x-forwarded-for"),
					xRealIp: req.headers.get("x-real-ip"),
					trustedProxyCidrs: settings.auth.trustedProxyCidrs ?? ["127.0.0.0/8", "::1/128"],
				});
				return app.fetch(req, { clientIp });
			});
			activeHttpRequests.set(requestId, execution);
			void execution.then(
				() => activeHttpRequests.delete(requestId),
				() => activeHttpRequests.delete(requestId),
			);
			return execution;
		},
		websocket: wsHandlers,
	});

	clearInheritableHandlesAfterServerBind();
	return server;
}

let actualPort = port;
let _server: ReturnType<typeof startServer>;

// On Windows, try to reclaim the port from stale bun processes before binding.
tryReclaimPort(port);

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

logger.info(`NarraFork server running on ${getProtocol()}://${currentHost}:${actualPort}`, {
	isProd,
	isCompiledBinary,
	metaUrl: import.meta.url,
});

registerRuntimeAddressGetter(() => ({
	protocol: getProtocol(),
	host: currentHost,
	port: actualPort,
}));

// Register server restart handler for hot-reloading host/port from settings
registerServerRestart(async (newHost: string, newPort: number) => {
	const oldHost = currentHost;
	const oldPort = actualPort;
	try {
		await _server.stop(true);
		currentHost = newHost;
		_server = startServer(newPort);
		actualPort = newPort;
		logger.info(
			`Server restarted: ${getProtocol()}://${oldHost}:${oldPort} → ${getProtocol()}://${currentHost}:${actualPort}`,
		);
	} catch (err) {
		// Rollback: try to restart on the old address
		logger.error("Failed to restart server on new address, rolling back", {
			newHost,
			newPort,
			error: String(err),
		});
		try {
			currentHost = oldHost;
			_server = startServer(oldPort);
			actualPort = oldPort;
			logger.info(`Server rolled back to ${getProtocol()}://${oldHost}:${oldPort}`);
		} catch (rollbackErr) {
			logger.error("Rollback also failed — server is down", {
				error: String(rollbackErr),
			});
		}
		throw err;
	}
});

/** Open a URL in the user's default browser. */
function openInBrowser(url: string) {
	try {
		if (IS_WINDOWS) {
			Bun.spawn(["cmd", "/c", "start", url], { stdio: ["ignore", "ignore", "ignore"] });
		} else if (IS_MACOS) {
			Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
		} else {
			Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
		}
	} catch {
		// Not critical — user can open manually
	}
}

/** Try to open the URL in Chromium's --app mode (frameless window); fall back to default browser. */
async function openAsApp(url: string) {
	const candidates: string[][] = IS_WINDOWS
		? [
				["cmd", "/c", "start", "", "msedge", `--app=${url}`],
				["cmd", "/c", "start", "", "chrome", `--app=${url}`],
			]
		: IS_MACOS
			? [
					["open", "-a", "Google Chrome", url, "--args", `--app=${url}`],
					["open", "-a", "Microsoft Edge", url, "--args", `--app=${url}`],
					["open", "-a", "Chromium", url, "--args", `--app=${url}`],
				]
			: [
					["google-chrome", `--app=${url}`],
					["google-chrome-stable", `--app=${url}`],
					["chromium", `--app=${url}`],
					["chromium-browser", `--app=${url}`],
					["microsoft-edge", `--app=${url}`],
				];

	for (const cmd of candidates) {
		try {
			const proc = Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
			// On Unix, check if the process exits immediately with an error
			if (!IS_WINDOWS) {
				// Give it a moment to fail (e.g. command not found)
				const exited = proc.exited;
				const timeout = new Promise<null>((r) => setTimeout(() => r(null), 300));
				const result = await Promise.race([exited, timeout]);
				if (result !== null && result !== 0) continue;
			}
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
	const url = `${proto}://${currentHost === "0.0.0.0" ? "localhost" : currentHost}:${actualPort}`;
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;105m⛏  NarraFork\x1b[0m ${versionStr}`);
	console.log(`  \x1b[2m➜\x1b[0m  ${url}`);
	console.log(`  \x1b[2m➜\x1b[0m  mode: ${modeStr}`);
	console.log("");

	const openMode = settings.server.openBrowser;
	if (openMode === "app") {
		openAsApp(url);
	} else if (openMode === "browser") {
		openInBrowser(url);
	}
}

// Start WebSocket heartbeat (ping/pong) to detect stale connections
startHeartbeat();

// Wire the remote-executor backend resolver + device lifecycle listeners.
initDeviceConnectionService();
// Wire the file-transfer chunk-frame receiver.
initDeviceTransferService();
// Migrate OAuth authorities first, then stable resource provenance, in bounded yielding batches.
backfillOAuthGrantAuthoritiesOnStartup()
	.then(() => backfillIntegrationResourceBindingsOnStartup())
	.catch((err) => {
		logger.warn("Integration startup backfill failed", { error: String(err) });
	});

startVNetUdpRendezvous(settings.vnet).catch((err) => {
	logger.warn("VNet UDP rendezvous startup failed", { error: String(err) });
});

try {
	getCodexManager().startUsageRefreshScheduler();
} catch (err) {
	logger.warn("Codex usage refresh scheduler startup failed", { error: String(err) });
}

	if (configuredCredentialsPath) {
		return {
			credentialsPath: configuredCredentialsPath,
			configPath:
				configuredCredentialsPath.replace("credentials.json", "config.json"),
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		};
	}

	if (!existsSync(defaultCredentialsPath)) return null;

		credentialsPath: defaultCredentialsPath,
	};
	saveSettings(settings);
		credentialsPath: defaultCredentialsPath,
	});

	return {
		credentialsPath: defaultCredentialsPath,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	};
}

	try {
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

// Read planned-update protection before generic cleanup can mutate process-owned rows. The
// admission barrier covers only generic recovery plus mounting the ordered continuation queue;
// terminal Agent/Await work and interactive permissions continue in the background.
getPlannedUpdateStartupProtection()
	.then(async (plannedUpdate) => {
		await recoverNarrators(plannedUpdate.protection);
		await restorePendingModelOverrides();
		const plannedRecovery = await restoreNarratorsAfterPlannedUpdate(plannedUpdate);
		startupRecoveryState = plannedRecovery ? { status: "recovering" } : { status: "ready" };
		resolveStartupRecovery({ ok: true });
		if (plannedRecovery) {
			plannedRecovery.completion
				.then(() => {
					startupRecoveryState = { status: "ready" };
					logger.info("Planned-update background continuation recovery completed");
				})
				.catch((err) => {
					const error = err instanceof Error ? err.message : String(err);
					startupRecoveryState = { status: "failed", error };
					logger.error("Planned-update background continuation recovery failed", { error });
				});
		}
	})
	.catch((err) => {
		const error = err instanceof Error ? err.message : String(err);
		startupRecoveryState = { status: "failed", error };
		logger.error("Narrator state recovery failed", { error });
		resolveStartupRecovery({ ok: false, error });
	});

// Reconnect browser sessions preserved across a seamless-update restart. This runs independently
// of narrator continuation recovery (it must neither block it nor be blocked by it) and never
// throws — a failure only means affected narrators are notified their sessions were lost.
import("./services/browser-session-recovery")
	.then(({ restoreBrowserSessionsAfterUpdate }) => restoreBrowserSessionsAfterUpdate())
	.catch((err) => {
		logger.error("Browser session recovery failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	});

// Mark interrupted merge sessions as error
chapterBatchMerge.cleanupStaleSessions().catch((err) => {
	logger.error("Merge session cleanup failed", { error: String(err) });
});

// Clean up leftover share directories from previous server runs
import { cleanupStaleShares } from "./lib/shares";

cleanupStaleShares();

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

// Poll for due scheduled tasks (periodic prompt → narrator). Re-arms on startup.
import {
	startScheduledTaskScheduler,
	stopScheduledTaskScheduler,
} from "./services/scheduled-task-scheduler";

void startupRecoveryBarrier.then((recovery) => {
	if (!recovery.ok) {
		logger.error("Scheduled task scheduler disabled because startup recovery failed", {
			error: recovery.error,
		});
		return;
	}
	startScheduledTaskScheduler();
});

// Backfill legacy RecentTabs in bounded background batches. Membership consumers await this
// process-wide singleton before querying the authoritative indexes.
ensureAllRecentTabsMigrated()
	.then(() => logger.info("RecentTabs legacy migration scan completed"))
	.catch((err) => logger.warn("RecentTabs legacy migration scan failed", { error: String(err) }));

// Start IM Gateway (Telegram, Discord, Slack, Feishu, Webhook)
import { gateway } from "./gateway/gateway";

void startupRecoveryBarrier.then((recovery) => {
	if (!recovery.ok) {
		logger.error("IM Gateway disabled because startup recovery failed", { error: recovery.error });
		return;
	}
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

// Register project DB backup sync (event-driven dual-write)
registerProjectDbSync();

// Register review event handler (inject feedback into source narrator on conclude)
initReviewEventHandler();

// Register container event handler (inject access info + auto-enable Browser on container start)
initContainerEventHandler();

// Register chat-group event handler (notify controlling named narrators of permission requests)
registerChatGroupEventListeners();

// Reconcile container states on startup (mark stale DB records as stopped)
reconcileContainerStates().catch((err) => {
	logger.warn("Container state reconciliation failed", { error: String(err) });
});

// Start container proxy if enabled
if (settings.containers.proxy?.enabled) {
	startContainerProxy().catch((err) => {
		logger.error("Container proxy startup failed", { error: String(err) });
	});
}

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
		stopHeartbeat();

		// Track every teardown step's outcome. The clean-shutdown marker is a promise that the DB
		// reached a quiescent, consistent state — so it is written ONLY at the very end, and only
		// when requests drained AND every teardown step succeeded. If any step times out or throws,
		// we skip the marker and just release the lock (below), so the next startup runs its
		// integrity check instead of trusting a shutdown we could not prove was consistent.
		const tracker = new ShutdownActivityTracker();

		// Stop accepting work before teardown begins. Bun.Server.stop(true) immediately terminates
		// in-flight HTTP requests and WebSockets and resolves once the listener is closed. The
		// authenticated update handoff treats its marker file as authoritative when this intentionally
		// closes the request before its response is flushed, so it is safe to close every connection
		// here. Only after this promise resolves can later teardown steps be guaranteed not to race a
		// request that writes to SQLite after the clean marker.
		acceptingHttpRequests = false;
		const shutdownRequestId = httpRequestContext.getStore();
		closeAllConnections();
		const serverStopOutcome = await shutdownStep(
			tracker,
			"httpServer.stop",
			() => _server?.stop(true),
			10_000,
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

		getCodexManager().stopUsageRefreshScheduler();
		stopScheduledTaskScheduler();
		await shutdownStep(tracker, "containerProxy.stop", () => stopContainerProxy());
		await shutdownStep(tracker, "terminalService.shutdownAll", () => terminalService.shutdownAll());
		if (!options.skipBashProcessKill) {
			await shutdownStep(tracker, "killAllBashProcesses", () => killAllBashProcesses());
		}
		chapterCleanup.clearAllTimers();
		worktreeWatcher.shutdown();
		projectDbManager.closeAll();
		await shutdownStep(tracker, "vnetUdpRendezvous.stop", () => stopVNetUdpRendezvous());
		await shutdownStep(tracker, "pluginManager.shutdown", () => pluginManager.shutdown());
		unregisterExternalProviderResolver();
		await shutdownStep(tracker, "mcpManager.shutdown", () => mcpManager.shutdown());
		// Seamless-update handoff only: persist active browser sessions and flip the pool into
		// preserve-on-close mode so the following browserPool.close disconnects (keeps Chrome alive)
		// instead of killing it. A normal shutdown skips this and closes the browser as usual.
		if (options.reason === "replacement_started") {
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
