/**
 * Electrobun desktop shell entrypoint.
 *
 * This file is a launcher, not a second implementation of anything. It:
 *   1. points NarraFork at a desktop-specific data directory,
 *   2. opens a window immediately with a local loading page,
 *   3. starts the existing server in-process,
 *   4. navigates the window to the server once it answers /api/health.
 *
 * The window opens *before* the server is ready on purpose: a cold start initialises the
 * database, runs migrations and builds the whole service graph, which takes tens of seconds.
 * Showing a loading state is the difference between "starting up" and "the app is broken".
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DB_INTEGRITY_WORKER_FLAG } from "../server/db/integrity-protocol";
import { WATCHER_WORKER_FLAG } from "../server/lib/watcher/worker-protocol";
import { createDesktopLifecycle, desktopServerOrigin } from "./lifecycle";

/** Bundle layout: this module is bundled to `Resources/app/bun/`, copied assets go to `Resources/app/`. */
const BUNDLE_DIR = import.meta.dir;
const APP_ROOT = resolve(BUNDLE_DIR, "..");

/**
 * Flags that mean "this process is a worker, not the app".
 *
 * The server spawns helper processes (the read-only integrity probe, the file watcher) by
 * re-invoking its own entrypoint with a flag. In a packaged desktop build that entrypoint is
 * THIS file, so those children must never reach the window code — see the dynamic import below.
 */
const WORKER_FLAGS = [DB_INTEGRITY_WORKER_FLAG, WATCHER_WORKER_FLAG];

function isWorkerInvocation(): boolean {
	return WORKER_FLAGS.some((flag) => process.argv.includes(flag));
}

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 250;

/**
 * Route NarraFork's state to the per-app user data directory.
 *
 * Without this the desktop build would use `~/.narrafork` and collide with a development
 * server on the same machine — the database instance lock is exclusive, so whichever process
 * starts second fails outright. `Utils.paths.userData` already includes the app identifier.
 *
 * Set before importing the server: `narrafork-home.ts` reads this lazily, but every module that
 * derives a path from it captures the value on first use.
 */
function configureDesktopPaths(userData: string): string {
	process.env.NARRAFORK_HOME ??= userData;

	// The server serves the frontend from `<server module dir>/../dist/frontend` and looks up
	// migrations at the cwd-relative `./drizzle`. electrobun.config.ts copies both into the app
	// root, so anchoring the cwd there makes both resolve without changing the server.
	process.chdir(APP_ROOT);

	// Desktop packages are always production: there is no Vite dev server in front of them.
	process.env.NODE_ENV ??= "production";

	// bun-pty resolves librust_pty through Bun FFI, so the bundler cannot rewrite the path.
	// electrobun.config.ts copies the libraries here; point the loader at them explicitly.
	// Only the Windows terminal backend needs this — Bun.Terminal covers Linux and macOS.
	const ptyLib = join(APP_ROOT, "native", "bun-pty", ptyLibraryFileName());
	if (existsSync(ptyLib)) process.env.BUN_PTY_LIB ??= ptyLib;

	return userData;
}

/** The librust_pty filename bun-pty expects for this platform and architecture. */
function ptyLibraryFileName(): string {
	if (process.platform === "win32") return "rust_pty.dll";
	if (process.platform === "darwin") {
		return process.arch === "arm64" ? "librust_pty_arm64.dylib" : "librust_pty.dylib";
	}
	return process.arch === "arm64" ? "librust_pty_arm64.so" : "librust_pty.so";
}

/** Minimal self-contained loading page. Inlined so it works before any server exists. */
function loadingPageHtml(): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>NarraFork</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #1a1b1e; color: #c1c2c5;
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .box { text-align: center; }
  .spinner { width: 28px; height: 28px; margin: 0 auto 16px;
             border: 3px solid #373a40; border-top-color: #7c7fe8;
             border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .detail { margin-top: 8px; color: #6c6f75; font-size: 12px; }
</style></head>
<body><div class="box">
  <div class="spinner"></div>
  <div>Starting NarraFork…</div>
  <div class="detail">Preparing the database and services</div>
</div></body></html>`;
}

/** Failure page. Shows why startup failed instead of letting the window vanish silently. */
function errorPageHtml(message: string, logPath: string): string {
	const escapeHtml = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>NarraFork failed to start</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #1a1b1e; color: #c1c2c5; padding: 32px;
         font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .box { max-width: 640px; }
  h1 { font-size: 16px; margin: 0 0 12px; color: #ff8787; font-weight: 600; }
  pre { background: #25262b; border: 1px solid #373a40; border-radius: 6px;
        padding: 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
  .hint { margin-top: 16px; color: #6c6f75; font-size: 12px; }
</style></head>
<body><div class="box">
  <h1>NarraFork could not start</h1>
  <pre>${escapeHtml(message)}</pre>
  <div class="hint">Log file: ${escapeHtml(logPath)}</div>
</div></body></html>`;
}

/**
 * Wait until the server answers /api/health.
 *
 * `getRuntimeAddress()` reports the address only after Bun.serve() has bound, and the port may
 * differ from the configured one because the server retries on conflict. So the address is read
 * on every attempt rather than once up front.
 */
async function waitForServer(
	getAddress: () => { protocol: string; host: string; port: number } | null,
): Promise<string> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	let lastError = "server did not bind to a port";

	while (Date.now() < deadline) {
		const address = getAddress();
		if (address) {
			const origin = desktopServerOrigin(address);
			try {
				const response = await fetch(`${origin}/api/health`, {
					signal: AbortSignal.timeout(5_000),
				});
				if (response.ok) return origin;
				lastError = `/api/health returned ${response.status}`;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
		}
		await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
	}

	throw new Error(
		`Timed out after ${HEALTH_TIMEOUT_MS / 1000}s waiting for the server to become ready ` +
			`(last error: ${lastError}).`,
	);
}

if (isWorkerInvocation()) {
	// A helper subprocess, not the app. `electrobun/main` must NOT be imported here: it opens the
	// window during module evaluation (its `BrowserWindow` module calls `setExitOnLastWindowClosed`
	// through FFI at import time), which in a worker either dies on a missing native library or
	// leaves a stray window behind. Both shapes break the parent, which is waiting on this
	// process's stdout for a report.
	//
	// The worker cannot ask Electrobun for the userData path for the same reason, so it inherits
	// NARRAFORK_HOME from the parent that spawned it.
	const inheritedHome = process.env.NARRAFORK_HOME;
	if (inheritedHome) configureDesktopPaths(inheritedHome);
	else process.chdir(APP_ROOT);

	// server/index.ts dispatches on the same flags and runs the matching worker.
	await import("../server/index");
} else {
	const { BrowserWindow, Tray, Utils } = await import("electrobun/main");
	const userDataDir = configureDesktopPaths(Utils.paths.userData);
	const logPath = join(userDataDir, "server.log");
	const zh = /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en");
	const labels = zh
		? {
				open: "打开主窗口",
				quit: "退出 NarraFork",
				unavailable: "系统托盘不可用，关闭窗口将退出应用。",
			}
		: {
				open: "Open main window",
				quit: "Quit NarraFork",
				unavailable: "System tray unavailable. Closing the window will quit the app.",
			};
	let tray: InstanceType<typeof Tray> | undefined;
	let serverBoot: Promise<unknown> | undefined;
	const lifecycle = createDesktopLifecycle({
		createWindow: () =>
			new BrowserWindow({
				title: "NarraFork",
				url: "views://mainview/index.html",
				frame: { width: 1440, height: 900, x: 80, y: 60 },
			}),
		loadingHtml: loadingPageHtml(),
		shutdown: async () => {
			// Do not exit while startup may still acquire the database lock.
			await serverBoot?.catch(() => {});
			const { shutdownDesktopServer } = await import("../server/lib/server-restart");
			await shutdownDesktopServer();
		},
		disposeTray: () => tray?.remove(),
		exit: () => Utils.quit(),
		onError: (error) => {
			lifecycle.setError(errorPageHtml(String(error), logPath));
			lifecycle.openWindow();
		},
	});
	lifecycle.openWindow();
	serverBoot = import("../server/index");
	// Observe early rejection while the tray host probe is in flight.
	void serverBoot.catch(() => {});
	// On Linux, a successful native createTray does not prove a tray host exists.
	// Fail closed rather than leave an invisible process with no way to reopen it.
	let trayHost = process.platform !== "linux";
	if (process.platform === "linux") {
		try {
			const { stdout } = await promisify(execFile)(
				"gdbus",
				[
					"call",
					"--session",
					"--dest",
					"org.kde.StatusNotifierWatcher",
					"--object-path",
					"/StatusNotifierWatcher",
					"--method",
					"org.freedesktop.DBus.Properties.Get",
					"org.kde.StatusNotifierWatcher",
					"IsStatusNotifierHostRegistered",
				],
				{ timeout: 2000, maxBuffer: 4096 },
			);
			trayHost = stdout.includes("true");
		} catch {
			/* Missing session bus or gdbus: keep normal close-to-quit behavior. */
		}
	}
	if (trayHost) {
		tray = new Tray({
			title: "NarraFork",
			image: join(APP_ROOT, "dist/frontend/pwa-192x192.png"),
			template: false,
		});
		tray.setMenu([
			{ label: labels.open, action: "open" },
			{ type: "separator" },
			{ label: labels.quit, action: "quit" },
		]);
		tray.on("tray-clicked", (event) => {
			const action = (event as { data?: { action?: string } }).data?.action;
			if (action === "quit")
				void lifecycle.quit().catch((error) => {
					lifecycle.setError(errorPageHtml(String(error), logPath));
					lifecycle.openWindow();
				});
			else lifecycle.openWindow();
		});
	}
	lifecycle.setBackgroundAvailable(Boolean(tray?.visible));
	if (!tray?.visible) {
		console.warn(labels.unavailable);
		// Native modal dialogs may block the JS thread while the server is booting.
		// A visible title warning preserves both startup and the normal close-to-quit path.
		const window = lifecycle.openWindow() as InstanceType<typeof BrowserWindow> | null;
		window?.setTitle(`NarraFork — ${labels.unavailable}`);
	}
	try {
		await serverBoot;
		const { getRuntimeAddress } = await import("../server/lib/server-restart");
		lifecycle.setReady(await waitForServer(getRuntimeAddress));
	} catch (error) {
		lifecycle.setError(errorPageHtml(String(error), logPath));
	}
}
