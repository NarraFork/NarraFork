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
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { BrowserWindow, Utils } from "electrobun/main";

/** Bundle layout: this module is bundled to `Resources/app/bun/`, copied assets go to `Resources/app/`. */
const BUNDLE_DIR = import.meta.dir;
const APP_ROOT = resolve(BUNDLE_DIR, "..");

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
function configureDesktopPaths(): string {
	const userData = Utils.paths.userData;
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
			// Always talk to the loopback interface: the server may be bound to 0.0.0.0, which is
			// not a connectable destination on every platform.
			const origin = `${address.protocol}://127.0.0.1:${address.port}`;
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

const userDataDir = configureDesktopPaths();
const logPath = join(userDataDir, "server.log");

const window = new BrowserWindow({
	title: "NarraFork",
	url: "views://mainview/index.html",
	frame: { width: 1440, height: 900, x: 80, y: 60 },
});

window.webview.loadHTML(loadingPageHtml());

try {
	// Importing the server starts it: server/index.ts and server/main.ts are top-level
	// side-effect modules, matching how `bun run start` boots.
	const [{ getRuntimeAddress }] = await Promise.all([
		import("../server/lib/server-restart"),
		import("../server/index"),
	]);

	const origin = await waitForServer(getRuntimeAddress);
	window.webview.loadURL(origin);
} catch (err) {
	const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
	window.webview.loadHTML(errorPageHtml(message, logPath));
}
