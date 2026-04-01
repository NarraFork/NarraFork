// Playwright browser pool — singleton, lazy-initialized.
// Replaces the old Puppeteer-based browser.ts with Playwright equivalents.
// Discovers Chrome via env var → Playwright cache → system paths.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { logger } from "../logger";
import { getWebFetchProxy } from "../web-fetch/proxy";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

const PAGE_TIMEOUT_MS = 30_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Media resource types to block when we only need text content. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-gpu",
	"--disable-dev-shm-usage",
	"--disable-extensions",
];

/** Build launch args, appending --proxy-server when a proxy is configured. */
function buildLaunchArgs(): string[] {
	const args = [...LAUNCH_ARGS];
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
 * 1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or PUPPETEER_EXECUTABLE_PATH env var
 * 2. Playwright cache: ~/.cache/ms-playwright/chromium-{version}/
 * 3. Puppeteer cache (legacy): ~/.cache/puppeteer/chrome/
 * 4. System Chrome (google-chrome, chromium, etc.)
 */
function findChromePath(): string | undefined {
	// 1. Explicit env var
	for (const envKey of ["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "PUPPETEER_EXECUTABLE_PATH"]) {
		const envPath = process.env[envKey];
		if (envPath && existsSync(envPath)) {
			logger.info("Using Chrome from env var", { key: envKey, path: envPath });
			return envPath;
		}
	}

	// 2. Scan Playwright cache
	const pwCacheDir = join(homedir(), ".cache", "ms-playwright");
	const pwPath = scanPlaywrightCache(pwCacheDir);
	if (pwPath) return pwPath;

	// 3. Scan Puppeteer cache (legacy support)
	const puppeteerCacheDir =
		process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	const puppeteerPath = scanPuppeteerCache(puppeteerCacheDir);
	if (puppeteerPath) return puppeteerPath;

	// 4. System Chrome on common paths
	const systemPaths = getSystemChromePaths();
	for (const p of systemPaths) {
		if (existsSync(p)) {
			logger.info("Found system Chrome", { path: p });
			return p;
		}
	}

	return undefined;
}

/** Scan Playwright's cache directory for a Chromium executable. */
function scanPlaywrightCache(cacheDir: string): string | undefined {
	if (!existsSync(cacheDir)) return undefined;
	try {
		const entries = readdirSync(cacheDir)
			.filter((e) => e.startsWith("chromium"))
			.sort()
			.reverse(); // newest first
		for (const entry of entries) {
			const candidates = [
				// Linux
				join(cacheDir, entry, "chrome-linux", "chrome"),
				// macOS
				join(cacheDir, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
				// Windows
				join(cacheDir, entry, "chrome-win", "chrome.exe"),
			];
			for (const c of candidates) {
				if (existsSync(c)) {
					logger.info("Found Chromium in Playwright cache", { path: c });
					return c;
				}
			}
		}
	} catch {
		// Not readable
	}
	return undefined;
}

/** Scan Puppeteer's cache directory for a Chrome executable (legacy). */
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
			// Linux
			return [
				"/usr/bin/google-chrome",
				"/usr/bin/google-chrome-stable",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
			];
	}
}

async function launchBrowser(): Promise<Browser> {
	const { chromium } = await import("playwright-core");

	const executablePath = findChromePath();
	const launchArgs = buildLaunchArgs();

	if (executablePath) {
		try {
			const b = await chromium.launch({
				headless: true,
				executablePath,
				args: launchArgs,
			});
			logger.info("Playwright browser launched", {
				chromePath: executablePath,
			});
			return b;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("Chrome found but launch failed, trying default", {
				chromePath: executablePath,
				error: msg.slice(0, 200),
			});
			// Fall through to default launch
		}
	}

	// Default launch (Playwright's own detection)
	const b = await chromium.launch({
		headless: true,
		args: launchArgs,
	});
	logger.info("Playwright browser launched (default)");
	return b;
}

export async function getBrowser(): Promise<Browser> {
	if (browser?.isConnected()) return browser;
	// Prevent concurrent launches
	if (launching) return launching;
	launching = launchBrowser()
		.then((b) => {
			browser = b;
			launching = null;
			return b;
		})
		.catch((err) => {
			launching = null;
			throw err;
		});
	return launching;
}

export interface FetchPageOptions {
	/** Block images/fonts/media to speed up loading (default: false). */
	blockMedia?: boolean;
	/** Navigation timeout in ms (default: 30000). */
	timeout?: number;
	/** Wait condition (default: "domcontentloaded"). */
	waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

/**
 * Open a new page, navigate to `url`, and return the page.
 * Caller is responsible for calling `page.context().close()`.
 */
export async function fetchPage(url: string, options?: FetchPageOptions): Promise<Page> {
	const b = await getBrowser();
	const context = await b.newContext({
		viewport: DEFAULT_VIEWPORT,
		userAgent: USER_AGENT,
	});

	const page = await context.newPage();
	const timeout = options?.timeout ?? PAGE_TIMEOUT_MS;
	page.setDefaultTimeout(timeout);
	page.setDefaultNavigationTimeout(timeout);

	try {
		if (options?.blockMedia) {
			await page.route("**/*", (route) => {
				const type = route.request().resourceType();
				if (BLOCKED_RESOURCE_TYPES.has(type)) {
					return route.abort();
				}
				return route.continue();
			});
		}

		await page.goto(url, {
			waitUntil: options?.waitUntil ?? "domcontentloaded",
			timeout,
		});

		return page;
	} catch (err) {
		await context.close().catch(() => {});
		throw err;
	}
}

/**
 * Create a new browser context with default settings.
 * Used by BrowserSession for persistent multi-page sessions.
 */
export async function createContext(): Promise<BrowserContext> {
	const b = await getBrowser();
	return b.newContext({
		viewport: DEFAULT_VIEWPORT,
		userAgent: USER_AGENT,
	});
}

/** Gracefully close the browser (called on process exit). */
export async function closeBrowser(): Promise<void> {
	if (browser) {
		const b = browser;
		browser = null;
		try {
			await b.close();
			logger.info("Playwright browser closed");
		} catch {
			// Already closed or crashed — ignore
		}
	}
}

// Auto-cleanup on process exit
process.on("beforeExit", () => void closeBrowser());
process.on("SIGINT", () => void closeBrowser());
process.on("SIGTERM", () => void closeBrowser());
