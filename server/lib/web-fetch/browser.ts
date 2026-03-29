// Puppeteer browser pool — singleton, lazy-initialized.
// Automatically discovers Chrome installed via `npx puppeteer browsers install chrome`
// even when the bundled Puppeteer version doesn't match the installed Chrome version.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger";
import { getWebFetchProxy } from "./proxy";

// Dynamic import to avoid hard dependency at module load time.
type PuppeteerBrowser = import("puppeteer").Browser;
type PuppeteerPage = import("puppeteer").Page;

let browser: PuppeteerBrowser | null = null;
let launching: Promise<PuppeteerBrowser> | null = null;

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
 * Find a Chrome executable in the Puppeteer cache directory.
 * Handles version mismatches between bundled Puppeteer and user-installed Chrome.
 *
 * Search order:
 * 1. PUPPETEER_EXECUTABLE_PATH env var
 * 2. Puppeteer cache: ~/.cache/puppeteer/chrome/<platform>-<version>/
 * 3. System Chrome (google-chrome, chromium, etc.)
 */
function findChromePath(): string | undefined {
	// 1. Explicit env var
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath && existsSync(envPath)) {
		logger.info("Using Chrome from PUPPETEER_EXECUTABLE_PATH", { path: envPath });
		return envPath;
	}

	// 2. Scan Puppeteer cache for any installed Chrome version
	const cacheDir = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	const chromeDir = join(cacheDir, "chrome");

	if (existsSync(chromeDir)) {
		try {
			const platforms = readdirSync(chromeDir).sort().reverse(); // newest version first
			for (const platform of platforms) {
				const candidates = getCandidatePaths(join(chromeDir, platform));
				for (const candidate of candidates) {
					if (existsSync(candidate)) {
						logger.info("Found Chrome in Puppeteer cache", {
							path: candidate,
							platform,
						});
						return candidate;
					}
				}
			}
		} catch {
			// Cache dir not readable — continue
		}
	}

	// 3. System Chrome on common paths
	const systemPaths = getSystemChromePaths();
	for (const p of systemPaths) {
		if (existsSync(p)) {
			logger.info("Found system Chrome", { path: p });
			return p;
		}
	}

	return undefined;
}

/** Get candidate Chrome executable paths within a Puppeteer cache platform dir. */
function getCandidatePaths(platformDir: string): string[] {
	const paths: string[] = [];
	try {
		const entries = readdirSync(platformDir);
		for (const entry of entries) {
			// Windows: chrome-win64/chrome.exe
			paths.push(join(platformDir, entry, "chrome.exe"));
			// Linux: chrome-linux64/chrome
			paths.push(join(platformDir, entry, "chrome"));
			// macOS: chrome-mac-arm64/Google Chrome for Testing.app/.../Google Chrome for Testing
			paths.push(
				join(
					platformDir,
					entry,
					"Google Chrome for Testing.app",
					"Contents",
					"MacOS",
					"Google Chrome for Testing",
				),
			);
		}
	} catch {
		// Not a directory or not readable
	}
	return paths;
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

async function launchBrowser(): Promise<PuppeteerBrowser> {
	const puppeteer = await import("puppeteer");

	// Search for Chrome first — avoids slow timeout when default Puppeteer can't find its version
	const customChromePath = findChromePath();

	const launchArgs = buildLaunchArgs();

	if (customChromePath) {
		// Found a Chrome binary — launch with explicit path
		try {
			const b = await puppeteer.default.launch({
				headless: true,
				executablePath: customChromePath,
				args: launchArgs,
			});
			logger.info("Puppeteer browser launched", {
				pid: b.process()?.pid,
				chromePath: customChromePath,
			});
			return b;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("Chrome found but launch failed", {
				chromePath: customChromePath,
				error: msg.slice(0, 200),
			});
			// Fall through to default Puppeteer launch
		}
	}

	// Default Puppeteer launch (uses its own bundled Chrome version detection)
	const b = await puppeteer.default.launch({
		headless: true,
		args: launchArgs,
	});
	logger.info("Puppeteer browser launched (default)", { pid: b.process()?.pid });
	return b;
}

export async function getBrowser(): Promise<PuppeteerBrowser> {
	if (browser?.connected) return browser;
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
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
}

/**
 * Open a new page, navigate to `url`, and return the page.
 * Caller is responsible for calling `page.close()`.
 */
export async function fetchPage(url: string, options?: FetchPageOptions): Promise<PuppeteerPage> {
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

/** Gracefully close the browser (called on process exit). */
export async function closeBrowser(): Promise<void> {
	if (browser) {
		const b = browser;
		browser = null;
		try {
			await b.close();
			logger.info("Puppeteer browser closed");
		} catch {
			// Already closed or crashed — ignore
		}
	}
}

// Auto-cleanup on process exit
process.on("beforeExit", () => void closeBrowser());
process.on("SIGINT", () => void closeBrowser());
process.on("SIGTERM", () => void closeBrowser());
