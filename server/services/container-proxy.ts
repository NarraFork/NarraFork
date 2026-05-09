import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { containerInstances, projects } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { safeSpawn } from "../lib/spawn";

interface ProxyTarget {
	containerIp: string;
	containerPort: number;
	chapterId: string;
	serviceName: string;
}

/** In-memory cache: proxyLabel → target */
const cache = new Map<string, ProxyTarget>();

/** Set of registered project proxy domains (for Host header matching) */
const registeredDomains = new Set<string>();

/** The running Bun server instance, if started. */
let proxyServer: ReturnType<typeof Bun.serve> | null = null;

/** Current listen port of the running proxy server. */
let proxyServerPort: number | null = null;

/** Stored reference for eventBus cleanup on stop. */
let eventRefreshHandler: (() => void) | null = null;

/** Debounce timer for cache refresh triggered by lifecycle events. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Load all active proxy targets from DB into cache, reconciling with actual container state. */
export async function refreshCache(): Promise<void> {
	cache.clear();
	registeredDomains.clear();

	// Load all project proxy domains
	const projs = await db
		.select({ id: projects.id, proxyDomain: projects.proxyDomain })
		.from(projects)
		.where(isNotNull(projects.proxyDomain));
	for (const p of projs) {
		if (p.proxyDomain) registeredDomains.add(p.proxyDomain.toLowerCase());
	}

	// Load running container instances with proxy info
	const instances = await db
		.select({
			id: containerInstances.id,
			containerId: containerInstances.containerId,
			proxyLabel: containerInstances.proxyLabel,
			containerIp: containerInstances.containerIp,
			containerPort: containerInstances.containerPort,
			chapterId: containerInstances.chapterId,
			serviceName: containerInstances.serviceName,
		})
		.from(containerInstances)
		.where(
			and(
				eq(containerInstances.status, "running"),
				isNotNull(containerInstances.proxyLabel),
				isNotNull(containerInstances.containerPort),
			),
		);

	for (const inst of instances) {
		if (!inst.proxyLabel || inst.containerPort == null) continue;

		// Reconcile: verify container is actually running and refresh IP
		if (inst.containerId) {
			const live = await inspectContainerState(inst.containerId);
			if (!live.running) {
				// Container is gone or stopped — update DB and skip
				logger.info("Reconcile: container no longer running, updating DB", {
					containerId: inst.containerId,
					chapterId: inst.chapterId,
					serviceName: inst.serviceName,
				});
				await db
					.update(containerInstances)
					.set({ status: "stopped", updatedAt: new Date().toISOString() })
					.where(eq(containerInstances.id, inst.id));
				continue;
			}
			// Update IP if it changed
			if (live.ip && live.ip !== inst.containerIp) {
				logger.info("Reconcile: container IP changed, updating DB", {
					containerId: inst.containerId,
					oldIp: inst.containerIp,
					newIp: live.ip,
				});
				await db
					.update(containerInstances)
					.set({ containerIp: live.ip, updatedAt: new Date().toISOString() })
					.where(eq(containerInstances.id, inst.id));
				inst.containerIp = live.ip;
			}
		}

		if (inst.containerIp) {
			cache.set(inst.proxyLabel.toLowerCase(), {
				containerIp: inst.containerIp,
				containerPort: inst.containerPort,
				chapterId: inst.chapterId,
				serviceName: inst.serviceName,
			});
		}
	}

	logger.info("Proxy cache refreshed", {
		targets: cache.size,
		domains: registeredDomains.size,
	});
}

// ---------------------------------------------------------------------------
// Container state inspection (for reconciliation)
// ---------------------------------------------------------------------------

interface ContainerLiveState {
	running: boolean;
	ip: string | null;
}

/**
 * Inspect a container's actual state via `podman inspect`.
 * Returns running status and current bridge network IP.
 */
async function inspectContainerState(containerId: string): Promise<ContainerLiveState> {
	try {
		const result = await safeSpawn({
			cmd: [
				"podman",
				"inspect",
				"--format",
				"{{.State.Running}}|{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
				containerId,
			],
			timeout: 5_000,
		});
		if (result.exitCode !== 0) {
			// Container doesn't exist anymore
			return { running: false, ip: null };
		}
		const parts = result.stdout.trim().split("|");
		const running = parts[0] === "true";
		// Multiple networks produce space-separated IPs; take the first one.
		const rawIp = parts[1]?.trim() || null;
		const ip = rawIp?.split(/\s+/)[0] || null;
		return { running, ip };
	} catch {
		return { running: false, ip: null };
	}
}

/**
 * Reconcile all DB container states with actual podman state.
 * Intended to be called once at server startup.
 */
export async function reconcileContainerStates(): Promise<void> {
	const running = await db
		.select({
			id: containerInstances.id,
			containerId: containerInstances.containerId,
			chapterId: containerInstances.chapterId,
			serviceName: containerInstances.serviceName,
		})
		.from(containerInstances)
		.where(eq(containerInstances.status, "running"));

	if (running.length === 0) return;

	let staleCount = 0;
	for (const inst of running) {
		if (!inst.containerId) continue;
		const live = await inspectContainerState(inst.containerId);
		if (!live.running) {
			await db
				.update(containerInstances)
				.set({ status: "stopped", updatedAt: new Date().toISOString() })
				.where(eq(containerInstances.id, inst.id));
			staleCount++;
		}
	}

	if (staleCount > 0) {
		logger.info("Startup reconciliation: marked stale containers as stopped", {
			total: running.length,
			stale: staleCount,
		});
	}
}

// ---------------------------------------------------------------------------
// Host header resolution
// ---------------------------------------------------------------------------

/**
 * Extract the proxy label from a Host header value.
 * Host may include port: "abc12345-web-3000.dev.example.com:7780"
 */
function resolveLabel(host: string): string | null {
	// Strip port
	const hostname = host.split(":")[0].toLowerCase();

	for (const domain of registeredDomains) {
		const suffix = `.${domain}`;
		if (hostname.endsWith(suffix)) {
			const label = hostname.slice(0, -suffix.length);
			if (label && !label.includes(".")) return label;
		}
	}
	return null;
}

function resolveTarget(host: string): ProxyTarget | null {
	const label = resolveLabel(host);
	if (!label) return null;
	return cache.get(label) ?? null;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function errorResponse(status: number, title: string, detail: string): Response {
	const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;color:#c9d1d9;background:#0d1117}
h1{color:#f85149}code{background:#161b22;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${detail}</p></body></html>`;
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function handleRequest(req: Request): Promise<Response> {
	const host = req.headers.get("host");
	if (!host) {
		return errorResponse(400, "Bad Request", "Missing Host header.");
	}

	const target = resolveTarget(host);
	if (!target) {
		return errorResponse(
			502,
			"Service Not Found",
			`No container is mapped to <code>${escapeHtml(host)}</code>. The service may not be running.`,
		);
	}

	const url = new URL(req.url);
	const targetUrl = `http://${target.containerIp}:${target.containerPort}${url.pathname}${url.search}`;

	try {
		// Forward the request, preserving method, headers, and body
		const headers = new Headers(req.headers);
		headers.set("X-Forwarded-Host", host);
		headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
		headers.set("X-NarraFork-Chapter", target.chapterId);
		// Remove host header to avoid confusion at the target
		headers.delete("host");

		const resp = await fetch(targetUrl, {
			method: req.method,
			headers,
			body: req.body,
			// @ts-expect-error Bun supports duplex streaming
			duplex: "half",
			redirect: "manual",
		});

		// Copy response headers, pass through status
		const respHeaders = new Headers(resp.headers);
		return new Response(resp.body, {
			status: resp.status,
			statusText: resp.statusText,
			headers: respHeaders,
		});
	} catch (err) {
		logger.warn("Proxy forward failed", {
			host,
			target: targetUrl,
			error: String(err),
		});
		return errorResponse(
			502,
			"Container Unreachable",
			`Could not connect to <code>${escapeHtml(target.containerIp)}:${target.containerPort}</code> (${escapeHtml(target.serviceName)}). The container may have stopped.`,
		);
	}
}

// ---------------------------------------------------------------------------
// WebSocket proxy via Bun.serve websocket handlers
// ---------------------------------------------------------------------------

interface ProxyWSData {
	targetUrl: string;
	upstream: WebSocket | null;
}

const wsHandlers: Bun.WebSocketHandler<ProxyWSData> = {
	open(ws) {
		const upstream = new WebSocket(ws.data.targetUrl);
		ws.data.upstream = upstream;

		upstream.addEventListener("message", (ev) => {
			try {
				if (typeof ev.data === "string") {
					ws.sendText(ev.data);
				} else if (ev.data instanceof ArrayBuffer) {
					ws.sendBinary(new Uint8Array(ev.data));
				}
			} catch {
				// Client may have disconnected
			}
		});
		upstream.addEventListener("close", () => ws.close());
		upstream.addEventListener("error", () => ws.close());
	},
	message(ws, message) {
		if (ws.data.upstream?.readyState === WebSocket.OPEN) {
			ws.data.upstream.send(message);
		}
	},
	close(ws) {
		if (ws.data.upstream?.readyState === WebSocket.OPEN) {
			ws.data.upstream.close();
		}
	},
};

// ---------------------------------------------------------------------------
// Pasta backend detection
// ---------------------------------------------------------------------------

/** Cached result of isPastaBackend() — network backend doesn't change at runtime. */
let _pastaBackendCache: boolean | null = null;

/**
 * Check if the rootless Podman network backend supports direct host→container IP access.
 * Returns true for pasta/passt (Podman 5.0+), false for slirp4netns.
 * Result is cached after first call.
 */
export async function isPastaBackend(): Promise<boolean> {
	if (_pastaBackendCache !== null) return _pastaBackendCache;
	try {
		const result = await safeSpawn({
			cmd: ["podman", "info", "--format", "{{.Host.RootlessNetworkCmd}}"],
			timeout: 5000,
		});
		if (result.exitCode !== 0) {
			_pastaBackendCache = false;
			return _pastaBackendCache;
		}
		// Remove surrounding quotes if present
		const cmd = result.stdout.trim().replace(/^'|'$/g, "").toLowerCase();
		_pastaBackendCache = cmd === "pasta" || cmd === "passt";
	} catch {
		_pastaBackendCache = false;
	}
	return _pastaBackendCache;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ProxyRuntimeAction = "start" | "stop" | "restart" | "noop";

export function decideContainerProxyRuntimeAction(
	current: { running: boolean; port: number | null },
	desired: { enabled: boolean; port: number },
): ProxyRuntimeAction {
	if (!desired.enabled) {
		return current.running ? "stop" : "noop";
	}

	if (!current.running) return "start";
	if (current.port == null) return "restart";
	if (current.port !== desired.port) return "restart";
	return "noop";
}

function scheduleCacheRefresh(): void {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		refreshCache().catch((err) => {
			logger.warn("Proxy cache refresh failed", { error: String(err) });
		});
	}, 500);
}

export function getContainerProxyRuntimeState(): { running: boolean; port: number | null } {
	return { running: !!proxyServer, port: proxyServerPort };
}

export async function ensureContainerProxyRuntime(desired: {
	enabled: boolean;
	port: number;
}): Promise<void> {
	const state = getContainerProxyRuntimeState();
	const action = decideContainerProxyRuntimeAction(state, desired);

	if (action === "noop") return;
	if (action === "start") {
		await startContainerProxy(desired.port);
		return;
	}
	if (action === "stop") {
		stopContainerProxy();
		return;
	}

	const rollbackPort = state.port;
	stopContainerProxy();
	try {
		await startContainerProxy(desired.port);
	} catch (err) {
		logger.error("Container proxy restart failed", {
			targetPort: desired.port,
			rollbackPort,
			error: String(err),
		});
		if (rollbackPort != null) {
			try {
				await startContainerProxy(rollbackPort);
			} catch (rollbackErr) {
				logger.error("Container proxy rollback failed", {
					rollbackPort,
					error: String(rollbackErr),
				});
			}
		}
		throw err;
	}
}

export async function startContainerProxy(port?: number): Promise<void> {
	if (proxyServer) return;

	const listenPort = port ?? settings.containers.proxy.port;

	// Verify pasta backend
	if (!(await isPastaBackend())) {
		logger.warn(
			"Container proxy requires Podman 5.0+ with pasta network backend. " +
				"Current backend does not support direct host→container IP access. " +
				"Proxy will start but connections may fail with slirp4netns.",
		);
	}

	// Load initial cache
	await refreshCache();

	// Listen for container lifecycle events to refresh cache (debounced)
	eventRefreshHandler = () => {
		scheduleCacheRefresh();
	};
	eventBus.on("container:started", eventRefreshHandler);
	eventBus.on("container:stopped", eventRefreshHandler);
	eventBus.on("container:paused", eventRefreshHandler);
	eventBus.on("container:resumed", eventRefreshHandler);

	proxyServer = Bun.serve<ProxyWSData>({
		port: listenPort,
		async fetch(req, server) {
			// WebSocket upgrade
			const upgradeHeader = req.headers.get("upgrade");
			if (upgradeHeader?.toLowerCase() === "websocket") {
				const host = req.headers.get("host");
				if (!host) {
					return errorResponse(400, "Bad Request", "Missing Host header.");
				}
				const target = resolveTarget(host);
				if (!target) {
					return errorResponse(
						502,
						"Service Not Found",
						`No container mapped to <code>${escapeHtml(host)}</code>.`,
					);
				}
				const url = new URL(req.url);
				const targetUrl = `ws://${target.containerIp}:${target.containerPort}${url.pathname}${url.search}`;
				const upgraded = server.upgrade(req, {
					data: { targetUrl, upstream: null },
				});
				if (upgraded) return undefined;
				return errorResponse(400, "WebSocket Upgrade Failed", "Could not upgrade connection.");
			}

			return handleRequest(req);
		},
		websocket: wsHandlers,
	});
	proxyServerPort = listenPort;

	logger.info(`Container proxy started on port ${listenPort}`, {
		port: listenPort,
		cachedTargets: cache.size,
	});
}

export function stopContainerProxy(): void {
	if (proxyServer) {
		proxyServer.stop();
		proxyServer = null;
		proxyServerPort = null;
		if (eventRefreshHandler) {
			eventBus.off("container:started", eventRefreshHandler);
			eventBus.off("container:stopped", eventRefreshHandler);
			eventBus.off("container:paused", eventRefreshHandler);
			eventBus.off("container:resumed", eventRefreshHandler);
			eventRefreshHandler = null;
		}
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		cache.clear();
		registeredDomains.clear();
		logger.info("Container proxy stopped");
	}
}

/** Generate a proxy label for a chapter's service port. */
export function generateProxyLabel(
	chapterShortId: string,
	serviceName: string,
	containerPort: number,
): string {
	const sanitized = serviceName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return `${chapterShortId}-${sanitized}-${containerPort}`;
}

/** Build the full proxy URL for a label + project domain. */
export function buildProxyUrl(proxyLabel: string, proxyDomain: string, proxyPort: number): string {
	return proxyPort === 80
		? `http://${proxyLabel}.${proxyDomain}`
		: `http://${proxyLabel}.${proxyDomain}:${proxyPort}`;
}
