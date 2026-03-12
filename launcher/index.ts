/**
 * NarraFork Launcher - 守护进程
 *
 * 负责：
 * 1. 检查并应用更新
 * 2. 启动 worker 进程
 * 3. 监听 worker 的重启信号
 * 4. worker 崩溃时自动重启
 *
 * 使用方式：
 * - 将 launcher 和 worker 放在同一目录
 * - launcher 会自动查找同目录下的 narrafork-worker 或 narrafork
 * - 更新文件放在 ~/.narrafork/updates/ 目录
 */

import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Subprocess, spawn } from "bun";

const NARRAFORK_DIR = join(homedir(), ".narrafork");
const UPDATES_DIR = join(NARRAFORK_DIR, "updates");

// Get the directory where launcher is located
const LAUNCHER_DIR = dirname(process.execPath);

// Worker can be named either narrafork-worker or narrafork
function findWorkerPath(): string | null {
	const isWindows = process.platform === "win32";
	const candidates = isWindows
		? ["narrafork-worker.exe", "narrafork.exe"]
		: ["narrafork-worker", "narrafork"];

	for (const name of candidates) {
		const path = join(LAUNCHER_DIR, name);
		if (existsSync(path) && path !== process.execPath) {
			return path;
		}
	}
	return null;
}

let workerPath = findWorkerPath();
let worker: Subprocess | null = null;
let isRestarting = false;
let restartCount = 0;
const MAX_RESTART_COUNT = 5;
const RESTART_WINDOW_MS = 60000;
let lastRestartTime = 0;

/**
 * Check for and apply pending updates
 */
function applyPendingUpdate(): boolean {
	if (!existsSync(UPDATES_DIR)) {
		return false;
	}

	const files = readdirSync(UPDATES_DIR);
	const updateFile = files.find(
		(f) => f.startsWith("narrafork") && !f.endsWith(".blockmap") && !f.endsWith(".tmp"),
	);

	if (!updateFile) {
		return false;
	}

	const updatePath = join(UPDATES_DIR, updateFile);

	// Verify the update file exists and is not empty
	try {
		const stat = statSync(updatePath);
		if (stat.size < 1000) {
			console.log(`[Launcher] Update file too small, skipping: ${updateFile}`);
			unlinkSync(updatePath);
			return false;
		}
	} catch {
		return false;
	}

	console.log(`[Launcher] Applying update: ${updateFile}`);

	if (!workerPath) {
		console.error("[Launcher] No worker found to update");
		return false;
	}

	try {
		// Backup current worker
		const backupPath = `${workerPath}.backup`;
		if (existsSync(backupPath)) {
			unlinkSync(backupPath);
		}
		renameSync(workerPath, backupPath);

		// Move update to worker location
		renameSync(updatePath, workerPath);

		// Make executable on Unix
		if (process.platform !== "win32") {
			Bun.spawnSync(["chmod", "+x", workerPath]);
		}

		console.log("[Launcher] Update applied successfully");

		// Clean up other files in updates directory
		for (const file of files) {
			const filePath = join(UPDATES_DIR, file);
			try {
				unlinkSync(filePath);
			} catch {
				// Ignore cleanup errors
			}
		}

		return true;
	} catch (err) {
		console.error("[Launcher] Failed to apply update:", err);

		// Restore backup if available
		const backupPath = `${workerPath}.backup`;
		if (existsSync(backupPath) && !existsSync(workerPath)) {
			renameSync(backupPath, workerPath);
		}

		return false;
	}
}

/**
 * Start the worker process
 */
function startWorker(): void {
	// Re-check worker path in case it was created by update
	if (!workerPath) {
		workerPath = findWorkerPath();
	}

	if (!workerPath) {
		console.error("[Launcher] Worker not found in:", LAUNCHER_DIR);
		console.log("[Launcher] Expected: narrafork-worker or narrafork");
		process.exit(1);
	}

	console.log(`[Launcher] Starting worker: ${workerPath}`);

	// Pass through all command line arguments
	const args = process.argv.slice(2);

	worker = spawn({
		cmd: [workerPath, ...args],
		env: {
			...process.env,
			NARRAFORK_LAUNCHER_PID: String(process.pid),
		},
		stdio: ["inherit", "inherit", "inherit"],
		ipc: handleWorkerMessage,
	});

	worker.exited.then((exitCode) => {
		console.log(`[Launcher] Worker exited with code: ${exitCode}`);
		worker = null;

		if (isRestarting) {
			// Intentional restart, apply update and start again
			isRestarting = false;
			applyPendingUpdate();
			startWorker();
		} else if (exitCode !== 0) {
			// Crash - check restart limit
			const now = Date.now();
			if (now - lastRestartTime > RESTART_WINDOW_MS) {
				restartCount = 0;
			}
			lastRestartTime = now;
			restartCount++;

			if (restartCount > MAX_RESTART_COUNT) {
				console.error(`[Launcher] Worker crashed too many times (${restartCount}), giving up`);
				process.exit(1);
			}

			console.log(
				`[Launcher] Worker crashed, restarting (attempt ${restartCount}/${MAX_RESTART_COUNT})...`,
			);
			setTimeout(startWorker, 1000);
		}
	});
}

/**
 * Handle IPC messages from worker
 */
function handleWorkerMessage(message: unknown): void {
	if (typeof message !== "object" || message === null) {
		return;
	}

	const msg = message as { type?: string; [key: string]: unknown };

	switch (msg.type) {
		case "restart":
			console.log("[Launcher] Received restart request from worker");
			isRestarting = true;
			worker?.kill();
			break;

		case "ping":
			worker?.send({ type: "pong" });
			break;

		default:
			console.log("[Launcher] Unknown message from worker:", msg);
	}
}

/**
 * Handle shutdown signals
 */
function handleShutdown(signal: string): void {
	console.log(`[Launcher] Received ${signal}, shutting down...`);

	if (worker) {
		worker.kill();
	}

	process.exit(0);
}

// Main
console.log("[Launcher] NarraFork Launcher starting...");
console.log(`[Launcher] Launcher directory: ${LAUNCHER_DIR}`);
console.log(`[Launcher] Updates directory: ${UPDATES_DIR}`);

// Apply any pending updates before starting
applyPendingUpdate();

// Start worker
startWorker();

// Handle signals
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

console.log(`[Launcher] Launcher ready, PID: ${process.pid}`);
