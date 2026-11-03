// Puppeteer browser pool — singleton, lazy-initialized.
// Discovers Chrome/Edge via env var → Puppeteer cache → system paths.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import { logger } from "../logger";
import { getBrowserProxy, getWebFetchProxy } from "../web-fetch/proxy";
import { closeTab } from "./tab-scope";
import { attachUserBrowser } from "./user-browser";

interface PoolEntry {
	browser: Browser;
	/** 由我们启动、可以关闭；用户自己的浏览器只断开连接，绝不关闭。 */
	owned: boolean;
	/** 我们启动的有头浏览器自带的启动页，留给第一个会话使用。 */
	spareTab?: Page;
	/** 在用户浏览器里开的标签页，放手时一并关掉。 */
	userTabs: Set<Page>;
}

/** Browser instances keyed by mode. */
const browsers: Map<boolean, PoolEntry> = new Map();
const launching: Map<boolean, Promise<PoolEntry>> = new Map();

/**
 * When true, closeBrowser() disconnects from Chrome instead of killing it, so the
 * Chrome process survives a seamless-update restart and the replacement process can
 * reconnect via wsEndpoint. Only set during planned-update handoff.
 */
let preserveOnClose = false;
/** Shared close operation so signal hooks and main shutdown cannot race the same browser handles. */
let closingPromise: Promise<void> | null = null;

const PAGE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 30_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
export const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Media resource types to block when we only need text content. */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

const PROXY_BYPASS_LIST = ["localhost", "*.localhost", "127.0.0.0/8", "[::1]", "0.0.0.0"];

/**
 * Windows 上的 Edge 可能经兼容层重启自身，丢掉 Puppeteer 依赖的 stderr（DevTools 地址）与调试管道；
 * 其他 Chromium 会忽略这个开关。
 */
export const EDGE_NO_RELAUNCH_ARG = "--edge-skip-compat-layer-relaunch";

const LAUNCH_ARGS = ["--disable-dev-shm-usage", "--disable-extensions", EDGE_NO_RELAUNCH_ARG];
/** 容器里需要；桌面上只会多出一条「不受支持的命令行标志」提示栏。 */
const NO_SANDBOX_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];
/**
 * 全新 profile 会弹首次运行引导。首次运行与同步已由 Puppeteer 默认参数关掉，
 * 这里补上默认浏览器提示栏，以及 Edge 把 profile 静默登录到 Windows 账户。
 */
const HEADED_PROFILE_ARGS = ["--no-default-browser-check", "--disable-features=msImplicitSignin"];

function buildLaunchArgs(headless: boolean): string[] {
	const sandbox = headless || process.platform === "linux" ? NO_SANDBOX_ARGS : [];
	// 无头会话按 context 设代理，新会话无需打断旧会话就能用上新设置；
	// 有头窗口在默认 context 里，代理只能在启动时给。
	const proxy = headless ? undefined : getBrowserProxy();
	return [
		...LAUNCH_ARGS,
		...sandbox,
		...(proxy
			? [`--proxy-server=${proxy}`, `--proxy-bypass-list=${PROXY_BYPASS_LIST.join(";")}`]
			: ["--no-proxy-server"]),
		...(headless ? ["--disable-gpu"] : HEADED_PROFILE_ARGS),
	];
}

export function browserContextProxyOptions(proxy: string | undefined) {
	return {
		// Explicit direct mode also overrides a proxy on a preserved old Chrome.
		proxyServer: proxy ?? "direct://",
		proxyBypassList: PROXY_BYPASS_LIST,
	};
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
export function findChromePath(): string | undefined {
	// 1. Explicit env var
	for (const envKey of ["PUPPETEER_EXECUTABLE_PATH"]) {
		const envPath = process.env[envKey];
		if (envPath && existsSync(envPath)) {
			logger.info("Using browser from env var", { key: envKey, path: envPath });
			return envPath;
		}
	}

	// 2. Scan Puppeteer cache
	const puppeteerCacheDir =
		process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	const puppeteerPath = scanPuppeteerCache(puppeteerCacheDir);
	if (puppeteerPath) return puppeteerPath;

	// 3. System Chrome/Edge on common paths
	for (const { path } of systemBrowsers()) {
		if (existsSync(path)) {
			logger.info("Found system browser", { path });
			return path;
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

/** 系统安装的浏览器；带 userDataDir 的是用户日常在用、有默认 profile 的那种。 */
export interface SystemBrowser {
	path: string;
	userDataDir?: string;
}

/** Common system Chrome/Edge installations by platform. */
export function systemBrowsers(): SystemBrowser[] {
	const home = homedir();
	switch (process.platform) {
		case "win32": {
			const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
			const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
			const chrome = join(localAppData, "Google", "Chrome", "User Data");
			const edge = join(localAppData, "Microsoft", "Edge", "User Data");
			return [
				{
					path: join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
					userDataDir: chrome,
				},
				{
					path: join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
					userDataDir: chrome,
				},
				{
					path: join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
					userDataDir: chrome,
				},
				// 只装了 Edge 的机器同样要能驱动浏览器工具
				{
					path: join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
					userDataDir: edge,
				},
				{
					path: join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
					userDataDir: edge,
				},
			];
		}
		case "darwin": {
			const support = join(home, "Library", "Application Support");
			return [
				{
					path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					userDataDir: join(support, "Google", "Chrome"),
				},
				{ path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
			];
		}
		default: {
			const chrome = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "google-chrome");
			return [
				{ path: "/usr/bin/google-chrome", userDataDir: chrome },
				{ path: "/usr/bin/google-chrome-stable", userDataDir: chrome },
				{ path: "/usr/bin/chromium" },
				{ path: "/usr/bin/chromium-browser" },
				{ path: "/snap/bin/chromium" },
			];
		}
	}
}

/** 只有装在系统标准位置的浏览器才有用户的默认 profile；Puppeteer 缓存或自定义路径里的没有。 */
function userDataDirOf(executablePath: string): string | undefined {
	return systemBrowsers().find(({ path }) => path === executablePath)?.userDataDir;
}

async function launchBrowser(headless: boolean): Promise<PoolEntry> {
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

	const executablePath = findChromePath();
	// No Chrome found — throw a user-friendly error instead of letting
	// puppeteer-core emit the cryptic "executablePath or channel must be specified" message.
	if (!executablePath) {
		throw new Error(
			"Could not find Chrome/Chromium (Edge is also supported). " +
				"Please install Chrome or Edge, or run: bunx puppeteer browsers install chrome",
		);
	}

	// 有头会话优先进用户自己的浏览器：标签追加到用户窗口，登录态都是现成的。
	const userDataDir = headless ? undefined : userDataDirOf(executablePath);
	if (userDataDir) {
		const userBrowser = await attachUserBrowser(executablePath, userDataDir);
		if (userBrowser) {
			logger.info("Attached to the user's own browser", { chromePath: executablePath });
			return { browser: userBrowser, owned: false, userTabs: new Set() };
		}
	}

	const puppeteer = await import("puppeteer-core");
	let browser: Browser;
	try {
		browser = await puppeteer.default.launch({
			headless,
			executablePath,
			args: buildLaunchArgs(headless),
			// 有头窗口是给人看的：去掉「受自动化软件控制」提示栏，行为与普通浏览器一致。
			ignoreDefaultArgs: headless ? false : ["--enable-automation"],
			timeout: LAUNCH_TIMEOUT_MS,
			// Take full control of Chrome's lifecycle. Puppeteer's default signal/exit
			// hooks kill Chrome when this process exits — which would defeat seamless-update
			// session persistence. NarraFork closes the browser explicitly in every normal
			// path (shutdown step, runtime cleanup, TTL) and deliberately keeps it alive
			// (disconnect, not close) only during a planned-update handoff.
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn("Browser found but launch failed", {
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
			"Chrome/Edge was found but failed to launch. " +
				"Please reinstall Chrome or Edge, or run: bunx puppeteer browsers install chrome",
		);
	}

	// 有头窗口自带一个空白启动页：让第一个会话直接用它，窗口里就不会多出一个空标签。
	const [spareTab] = headless ? [] : await browser.pages().catch(() => []);
	logger.info("Puppeteer browser launched", {
		pid: browser.process()?.pid,
		chromePath: executablePath,
		headless,
	});
	return { browser, owned: true, spareTab, userTabs: new Set() };
}

function getEntry(headless: boolean): Promise<PoolEntry> {
	const existing = browsers.get(headless);
	if (existing?.browser.connected) return Promise.resolve(existing);

	// Prevent concurrent launches for the same mode
	const pending = launching.get(headless);
	if (pending) return pending;

	const promise = launchBrowser(headless)
		.then((entry) => {
			browsers.set(headless, entry);
			return entry;
		})
		.finally(() => launching.delete(headless));
	launching.set(headless, promise);
	return promise;
}

/**
 * Get or launch a browser instance.
 * @param headless - true for headless mode (default), false for headed (GUI) mode.
 */
export async function getBrowser(headless = true): Promise<Browser> {
	return (await getEntry(headless)).browser;
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
	const ctx = await b.createBrowserContext(browserContextProxyOptions(getWebFetchProxy()));
	let page: Page;
	try {
		page = await ctx.newPage();
	} catch (err) {
		await ctx.close().catch(() => {});
		throw err;
	}
	// WebFetch callers close the returned page; dispose its isolated context too.
	page.once("close", () => void ctx.close().catch(() => {}));

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
		await ctx.close().catch(() => {});
		throw err;
	}
}

/** 浏览器会话所用的标签页。 */
export interface BrowserTab {
	context: BrowserContext;
	page: Page;
	/** 标签开在用户自己的浏览器里，而不是我们启动的窗口。 */
	inUserBrowser: boolean;
}

/**
 * 为浏览器会话开一个标签页。
 *
 * 无头会话各用一个隔离 context，cookie 互不相通。有头会话放进默认 context：一个窗口只属于一个
 * profile，隔离 context 的页面必然另开窗口，只有默认 context 能让所有标签并进同一个窗口。
 */
export async function openTab(headless = true): Promise<BrowserTab> {
	const entry = await getEntry(headless);
	if (headless) {
		const context = await entry.browser.createBrowserContext(
			browserContextProxyOptions(getBrowserProxy()),
		);
		const page = await context.newPage().catch(async (error: unknown) => {
			await context.close().catch(() => {});
			throw error;
		});
		return { context, page, inUserBrowser: false };
	}
	const context = entry.browser.defaultBrowserContext();
	const spare = entry.spareTab;
	entry.spareTab = undefined;
	const page = spare && !spare.isClosed() ? spare : await context.newPage();
	if (!entry.owned) {
		entry.userTabs.add(page);
		page.once("close", () => entry.userTabs.delete(page));
	}
	return { context, page, inUserBrowser: !entry.owned };
}

/**
 * Toggle preserve-on-close mode. When enabled, closeBrowser() disconnects from Chrome
 * (keeping the process alive) instead of killing it. Used only during a planned-update
 * handoff so the replacement process can reconnect to the same Chrome instance.
 */
export function setBrowserPreserveMode(on: boolean): void {
	preserveOnClose = on;
}

/**
 * Collect the CDP WebSocket endpoint for each currently connected browser instance.
 * Returns endpoints keyed by headless mode so the replacement process can reconnect.
 * 用户自己的浏览器不参与：重连要用户再点一次允许，而启动恢复会一直等着。
 */
export function getBrowserWsEndpoints(): { headless?: string; headed?: string } {
	const result: { headless?: string; headed?: string } = {};
	for (const [headless, { browser, owned }] of browsers) {
		if (!owned || !browser.connected) continue;
		try {
			const endpoint = browser.wsEndpoint();
			if (headless) result.headless = endpoint;
			else result.headed = endpoint;
		} catch {
			// A browser that cannot report its endpoint cannot be reconnected; skip it.
		}
	}
	return result;
}

/**
 * Reconnect to an existing Chrome instance via its CDP WebSocket endpoint and store it
 * in the pool so subsequent launch/session calls reuse the same instance.
 * 交接只记录我们启动的浏览器，所以重连得到的仍归我们所有。
 * @param headless - Which pool slot this instance occupies.
 * @param browserWSEndpoint - The CDP WebSocket URL captured before the previous process exited.
 */
export async function connectBrowser(
	headless: boolean,
	browserWSEndpoint: string,
): Promise<Browser> {
	const puppeteer = await import("puppeteer-core");
	const browser = await puppeteer.default.connect({
		browserWSEndpoint,
		defaultViewport: DEFAULT_VIEWPORT,
	});
	browsers.set(headless, { browser, owned: true, userTabs: new Set() });
	logger.info("Reconnected to preserved Chrome instance", { headless, browserWSEndpoint });
	return browser;
}

/** Check whether browsers are running and connected. */
export function getBrowserStatus(): {
	headless: { running: boolean; connected: boolean };
	headed: { running: boolean; connected: boolean };
} {
	const h = browsers.get(true)?.browser;
	const d = browsers.get(false)?.browser;
	return {
		headless: h ? { running: true, connected: h.connected } : { running: false, connected: false },
		headed: d ? { running: true, connected: d.connected } : { running: false, connected: false },
	};
}

/**
 * 放开一个浏览器。用户自己的浏览器只关掉我们开的标签再断开（交接也不保留它们）；
 * 我们启动的浏览器在交接时断开、留给新进程，其余情况直接关闭。
 */
async function releaseEntry(headless: boolean, entry: PoolEntry, preserve: boolean): Promise<void> {
	const { browser } = entry;
	try {
		if (!entry.owned) {
			const context = browser.defaultBrowserContext();
			await Promise.all(
				[...entry.userTabs].map((page) => closeTab(context, page.target()).catch(() => {})),
			);
			await browser.disconnect();
			logger.info("Disconnected from the user's browser", { headless });
		} else if (preserve) {
			await browser.disconnect();
			logger.info("Puppeteer browser disconnected for update handoff", { headless });
		} else {
			await browser.close();
			logger.info("Puppeteer browser closed", { headless });
		}
	} catch (err) {
		logger.warn("Failed to release browser", {
			headless,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Gracefully close all browsers (called on process exit).
 *
 * When preserve-on-close mode is active (planned-update handoff), the Chrome process is
 * left running and we only disconnect the CDP transport, so the replacement process can
 * reconnect to the same instance. In every other path the browser is fully closed.
 */
export function closeBrowser(): Promise<void> {
	if (closingPromise) return closingPromise;

	const entries = [...browsers];
	browsers.clear();
	launching.clear();
	const preserve = preserveOnClose;
	closingPromise = Promise.all(
		entries.map(([headless, entry]) => releaseEntry(headless, entry, preserve)),
	)
		.then(() => {})
		.finally(() => {
			closingPromise = null;
		});
	return closingPromise;
}

// Auto-cleanup on process exit. These honor preserve-on-close mode so a planned-update
// handoff keeps Chrome alive; normal exits still close it.
process.on("beforeExit", () => void closeBrowser());
process.on("SIGINT", () => void closeBrowser());
process.on("SIGTERM", () => void closeBrowser());
