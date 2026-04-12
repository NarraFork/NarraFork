// Puppeteer browser pool — singleton, lazy-initialized.
// Discovers Chrome via env var → Puppeteer cache → system paths.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import { logger } from "../logger";
import { getWebFetchProxy } from "../web-fetch/proxy";

/** Browser instances keyed by mode. */
const browsers: Map<boolean, Browser> = new Map();
const launching: Map<boolean, Promise<Browser>> = new Map();

const PAGE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 30_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
export const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Media resource types to block when we only need text content. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-extensions",
];

/** Build launch args, appending --proxy-server when a proxy is configured. */
function buildLaunchArgs(headless: boolean): string[] {
	const args = [...LAUNCH_ARGS];
	if (headless) {
		args.push("--disable-gpu");
	}
	const proxy = getWebFetchProxy();
	if (proxy) {
		args.push(`--proxy-server=${proxy}`);
	}
	return args;
}

/**
 * Find a Chrome/Chromium executable.
 *
 * Search order:
 * 1. PUPPETEER_EXECUTABLE_PATH env var
 * 2. Puppeteer cache: ~/.cache/puppeteer/chrome/
 * 3. System Chrome (google-chrome, chromium, etc.)
 * 4. Flatpak Chrome/Chromium installations
 */
function findChromePath(): string | undefined {
	// 1. Explicit env var
	for (const envKey of ["PUPPETEER_EXECUTABLE_PATH"]) {
		const envPath = process.env[envKey];
		if (envPath && existsSync(envPath)) {
			logger.info("Using Chrome from env var", { key: envKey, path: envPath });
			return envPath;
		}
	}

	// 2. Scan Puppeteer cache
	const puppeteerCacheDir =
		process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	const puppeteerPath = scanPuppeteerCache(puppeteerCacheDir);
	if (puppeteerPath) return puppeteerPath;

	// 3. System Chrome on common paths
	const systemPaths = getSystemChromePaths();
	for (const p of systemPaths) {
		if (existsSync(p)) {
			logger.info("Found system Chrome", { path: p });
			return p;
		}
	}

	// 4. Flatpak Chrome/Chromium
	if (process.platform === "linux") {
		const flatpakPath = scanFlatpakChrome();
		if (flatpakPath) return flatpakPath;
	}

	return undefined;
}

/** Scan Puppeteer's cache directory for a Chrome executable. */
function scanPuppeteerCache(cacheDir: string): string | undefined {
	const chromeDir = join(cacheDir, "chrome");
	if (!existsSync(chromeDir)) return undefined;
	try {
		const platforms = readdirSync(chromeDir).sort().reverse();
		for (const platform of platforms) {
			const platformDir = join(chromeDir, platform);
			try {
				const entries = readdirSync(platformDir);
				for (const entry of entries) {
					const candidates = [
						join(platformDir, entry, "chrome.exe"),
						join(platformDir, entry, "chrome"),
						join(
							platformDir,
							entry,
							"Google Chrome for Testing.app",
							"Contents",
							"MacOS",
							"Google Chrome for Testing",
						),
					];
					for (const c of candidates) {
						if (existsSync(c)) {
							logger.info("Found Chrome in Puppeteer cache", { path: c });
							return c;
						}
					}
				}
			} catch {
				// Not a directory
			}
		}
	} catch {
		// Not readable
	}
	return undefined;
}

/** Scan Flatpak Chrome/Chromium installations. */
function scanFlatpakChrome(): string | undefined {
	const xdgDataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");

	// Flatpak app IDs and their binary paths relative to <install-dir>/current/active/files/
	const flatpakApps = [
		{ id: "com.google.Chrome", binary: join("extra", "chrome") },
		{ id: "org.chromium.Chromium", binary: join("extra", "chromium") },
	];

	// Installation roots: user-level first, then system-wide
	const installRoots = [join(xdgDataHome, "flatpak", "app"), "/var/lib/flatpak/app"];

	for (const root of installRoots) {
		for (const app of flatpakApps) {
			const candidate = join(root, app.id, "current", "active", "files", app.binary);
			if (existsSync(candidate)) {
				logger.info("Found Flatpak Chrome", { appId: app.id, path: candidate });
				return candidate;
			}
		}
	}

	return undefined;
}

/** Common system Chrome paths by platform. */
function getSystemChromePaths(): string[] {
	switch (process.platform) {
		case "win32":
			return [
				join(
					process.env.PROGRAMFILES ?? "C:\\Program Files",
					"Google",
					"Chrome",
					"Application",
					"chrome.exe",
				),
				join(
					process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
					"Google",
					"Chrome",
					"Application",
					"chrome.exe",
				),
				join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
			];
		case "darwin":
			return [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Applications/Chromium.app/Contents/MacOS/Chromium",
			];
		default:
			return [
				"/usr/bin/google-chrome",
				"/usr/bin/google-chrome-stable",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
			];
	}
}

async function launchBrowser(headless: boolean): Promise<Browser> {
	// Headed mode requires a display server (X11 or Wayland)
	if (
		!headless &&
		process.platform !== "win32" &&
		!process.env.DISPLAY &&
		!process.env.WAYLAND_DISPLAY
	) {
		throw new Error(
			"Cannot launch headed browser: no DISPLAY or WAYLAND_DISPLAY environment variable found. " +
				"Headed mode requires a graphical environment (X11 or Wayland). " +
				"Use headless mode on servers.",
		);
	}

	const puppeteer = await import("puppeteer-core");

	const executablePath = findChromePath();
	const launchArgs = buildLaunchArgs(headless);

	if (executablePath) {
		try {
			const b = await puppeteer.default.launch({
				headless,
				executablePath,
				args: launchArgs,
				timeout: LAUNCH_TIMEOUT_MS,
			});
			logger.info("Puppeteer browser launched", {
				pid: b.process()?.pid,
				chromePath: executablePath,
				headless,
			});
			return b;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("Chrome found but launch failed", {
				chromePath: executablePath,
				error: msg.slice(0, 500),
			});

			// Flatpak Chrome can't be launched directly — give a specific hint
			if (executablePath.includes("/flatpak/")) {
				throw new Error(
					"Chrome was found at a Flatpak path but cannot be launched directly. " +
						"Please install Chrome natively (deb/rpm), or run: " +
						"bunx puppeteer browsers install chrome",
				);
			}

			throw new Error(
				"Chrome was found but failed to launch. " +
					"Please install Chrome or run: bunx puppeteer browsers install chrome",
			);
		}
	}

	// No Chrome found — throw a user-friendly error instead of letting
	// puppeteer-core emit the cryptic "executablePath or channel must be specified" message.
	throw new Error(
		"Could not find Chrome/Chromium. " +
			"Please install Chrome or run: bunx puppeteer browsers install chrome",
	);
}

/**
 * Get or launch a browser instance.
 * @param headless - true for headless mode (default), false for headed (GUI) mode.
 */
export async function getBrowser(headless = true): Promise<Browser> {
	const existing = browsers.get(headless);
	if (existing?.connected) return existing;

	// Prevent concurrent launches for the same mode
	const pending = launching.get(headless);
	if (pending) return pending;

	const promise = launchBrowser(headless)
		.then((b) => {
			browsers.set(headless, b);
			launching.delete(headless);
			return b;
		})
		.catch((err) => {
			launching.delete(headless);
			throw err;
		});
	launching.set(headless, promise);
	return promise;
}

export interface FetchPageOptions {
	/** Block images/fonts/media to speed up loading (default: false). */
	blockMedia?: boolean;
	/** Navigation timeout in ms (default: 30000). */
	timeout?: number;
	/** Wait condition (default: "domcontentloaded"). */
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
}

/**
 * Open a new page, navigate to `url`, and return the page.
 * Caller is responsible for calling `page.close()`.
 */
export async function fetchPage(url: string, options?: FetchPageOptions): Promise<Page> {
	const b = await getBrowser();
	const page = await b.newPage();

	try {
		await page.setViewport(DEFAULT_VIEWPORT);
		await page.setUserAgent(USER_AGENT);

		const timeout = options?.timeout ?? PAGE_TIMEOUT_MS;
		page.setDefaultNavigationTimeout(timeout);
		page.setDefaultTimeout(timeout);

		if (options?.blockMedia) {
			await page.setRequestInterception(true);
			page.on("request", (req) => {
				if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
					void req.abort();
				} else {
					void req.continue();
				}
			});
		}

		await page.goto(url, {
			waitUntil: options?.waitUntil ?? "domcontentloaded",
			timeout,
		});

		return page;
	} catch (err) {
		await page.close().catch(() => {});
		throw err;
	}
}

/**
 * Create a new incognito browser context.
 * Used by BrowserSession for persistent multi-page sessions.
 * @param headless - true for headless mode (default), false for headed (GUI) mode.
 */
export async function createContext(headless = true): Promise<BrowserContext> {
	const b = await getBrowser(headless);
	const ctx = await b.createBrowserContext();
	return ctx;
}

/** Check whether browsers are running and connected. */
export function getBrowserStatus(): {
	headless: { running: boolean; connected: boolean };
	headed: { running: boolean; connected: boolean };
} {
	const h = browsers.get(true);
	const d = browsers.get(false);
	return {
		headless: h ? { running: true, connected: h.connected } : { running: false, connected: false },
		headed: d ? { running: true, connected: d.connected } : { running: false, connected: false },
	};
}

/** Gracefully close all browsers (called on process exit). */
export async function closeBrowser(): Promise<void> {
	const promises: Promise<void>[] = [];
	for (const [headless, b] of browsers) {
		promises.push(
			b
				.close()
				.then(() => logger.info("Puppeteer browser closed", { headless }))
				.catch(() => {}),
		);
	}
	browsers.clear();
	launching.clear();
	await Promise.all(promises);
}

// Auto-cleanup on process exit
process.on("beforeExit", () => void closeBrowser());
process.on("SIGINT", () => void closeBrowser());
process.on("SIGTERM", () => void closeBrowser());
