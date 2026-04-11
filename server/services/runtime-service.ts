import { eq } from "drizzle-orm";
import { db } from "../db";
import { containerInstances } from "../db/schema";
import { closeBrowser, getBrowserStatus } from "../lib/browser/pool";
import { closeAllSessions, getAllSessionStats } from "../lib/browser/session";
import { logger } from "../lib/logger";
import { terminalService } from "./terminal-service";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RuntimeTerminalInfo {
	running: number;
	exited: number;
	orphanSockets: number;
}

export interface RuntimeContainerInfo {
	running: number;
	stopped: number;
	podmanAvailable: boolean;
}

export interface RuntimeBrowserInfo {
	processRunning: boolean;
	connected: boolean;
	headedRunning: boolean;
	headedConnected: boolean;
	activeSessions: number;
}

export interface RuntimeScanResult {
	terminals: RuntimeTerminalInfo;
	containers: RuntimeContainerInfo;
	browsers: RuntimeBrowserInfo;
	scannedAt: number;
}

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 1000; // 30 seconds (runtime state changes fast)
let cachedResult: RuntimeScanResult | null = null;

function getCachedResult(): RuntimeScanResult | null {
	if (!cachedResult) return null;
	if (Date.now() - cachedResult.scannedAt > CACHE_TTL_MS) {
		cachedResult = null;
		return null;
	}
	return cachedResult;
}

// ── Scan ───────────────────────────────────────────────────────────────────

async function scanTerminals(): Promise<RuntimeTerminalInfo> {
	const all = await terminalService.listAll();
	const orphans = await terminalService.listOrphanSockets();
	return {
		running: all.filter((t) => t.status === "running").length,
		exited: all.filter((t) => t.status === "exited").length,
		orphanSockets: orphans.length,
	};
}

async function scanContainers(): Promise<RuntimeContainerInfo> {
	let podmanAvailable = false;
	try {
		const proc = Bun.spawn(["podman", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		podmanAvailable = (await proc.exited) === 0;
	} catch {
		// Podman not installed
	}

	const instances = db.select().from(containerInstances).all();
	return {
		running: instances.filter((c) => c.status === "running").length,
		stopped: instances.filter((c) => c.status === "stopped" || c.status === "paused").length,
		podmanAvailable,
	};
}

function scanBrowsers(): RuntimeBrowserInfo {
	const status = getBrowserStatus();
	const sessionStats = getAllSessionStats();
	return {
		processRunning: status.headless.running,
		connected: status.headless.connected,
		headedRunning: status.headed.running,
		headedConnected: status.headed.connected,
		activeSessions: sessionStats.totalSessions,
	};
}

async function scanRuntime(): Promise<RuntimeScanResult> {
	const [terminalInfo, containerInfo] = await Promise.all([scanTerminals(), scanContainers()]);
	const browserInfo = scanBrowsers();

	const result: RuntimeScanResult = {
		terminals: terminalInfo,
		containers: containerInfo,
		browsers: browserInfo,
		scannedAt: Date.now(),
	};
	cachedResult = result;
	return result;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

async function cleanupTerminals(): Promise<{ killed: number }> {
	const all = await terminalService.listAll();
	const exited = all.filter((t) => t.status === "exited");
	let killed = 0;

	for (const t of exited) {
		try {
			await terminalService.kill(t.id);
			killed++;
		} catch {
			// already gone
		}
	}

	// Also kill orphan sockets
	const orphans = await terminalService.listOrphanSockets();
	for (const o of orphans) {
		try {
			await terminalService.killOrphanSocket(o.terminalId);
			killed++;
		} catch {
			// already gone
		}
	}

	cachedResult = null;
	logger.info("Runtime cleanup: terminals", { killed });
	return { killed };
}

async function cleanupContainers(): Promise<{ stopped: number }> {
	let stopped = 0;
	try {
		// Get running containers from DB
		const running = db
			.select()
			.from(containerInstances)
			.where(eq(containerInstances.status, "running"))
			.all();

		for (const c of running) {
			if (!c.containerId) continue;
			try {
				const proc = Bun.spawn(["podman", "stop", c.containerId], {
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				// Update DB status
				db.update(containerInstances)
					.set({ status: "stopped", updatedAt: new Date().toISOString() })
					.where(eq(containerInstances.id, c.id))
					.run();
				stopped++;
			} catch {
				// container may already be stopped
			}
		}
	} catch (err) {
		logger.error("Failed to cleanup containers", { error: String(err) });
	}

	cachedResult = null;
	logger.info("Runtime cleanup: containers", { stopped });
	return { stopped };
}

async function cleanupBrowsers(): Promise<{ closedSessions: number; browserClosed: boolean }> {
	const closedSessions = await closeAllSessions();
	await closeBrowser();

	cachedResult = null;
	logger.info("Runtime cleanup: browsers", { closedSessions });
	return { closedSessions, browserClosed: true };
}

export const runtimeService = {
	getCachedResult,
	scanRuntime,
	cleanupTerminals,
	cleanupContainers,
	cleanupBrowsers,
};
