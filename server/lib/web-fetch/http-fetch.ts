// Lightweight HTTP fetch — fallback when browser is not available.
// Uses native fetch() + linkedom for HTML parsing, no browser needed.

import type { Page } from "puppeteer-core";
import { logger } from "../logger";
import { getWebFetchProxy } from "./proxy";

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Error patterns that indicate browser is not installed (not a transient failure). */
const BROWSER_UNAVAILABLE_PATTERNS = [
	"Could not find",
	"Failed to launch",
	"not installed",
	"ENOENT",
	"cannot open shared object",
	"Executable doesn't exist",
	"browserType.launch",
	"executablePath",
	"channel must be specified",
];

/** Check if an error message indicates the browser is simply not available. */
function isBrowserUnavailableError(msg: string): boolean {
	return BROWSER_UNAVAILABLE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Fetch a URL via HTTP and return the raw HTML body.
 * Works without a browser — suitable for static pages, APIs, raw files.
 */
export async function httpFetchHtml(url: string, timeout = DEFAULT_TIMEOUT_MS): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const proxy = getWebFetchProxy();
		const res = await fetch(url, {
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			signal: controller.signal,
			redirect: "follow",
			...(proxy ? { proxy } : {}),
		});

		if (!res.ok) {
			throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		}

		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Try to get HTML via browser. If browser is unavailable, returns null
 * so the caller can fall back to HTTP fetch.
 *
 * Does NOT cache failures — if the user installs Chrome mid-session,
 * the next call will pick it up.
 */
export async function tryBrowserFetch(
	url: string,
	options?: {
		blockMedia?: boolean;
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	},
): Promise<string | null> {
	try {
		const { fetchPage } = await import("./browser");
		const page = await fetchPage(url, {
			blockMedia: options?.blockMedia ?? true,
			waitUntil: options?.waitUntil ?? "domcontentloaded",
		});
		try {
			return await page.content();
		} finally {
			await page.close().catch(() => {});
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isBrowserUnavailableError(msg)) {
			logger.info("Browser unavailable, falling back to HTTP fetch", {
				error: msg.slice(0, 200),
			});
			return null;
		}
		throw err;
	}
}

/**
 * Try to launch browser and get a live page for screenshot/interaction.
 * Returns null if browser is unavailable (caller should show a clear error).
 */
export async function tryBrowserPage(
	url: string,
	options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
): Promise<Page | null> {
	try {
		const { fetchPage } = await import("./browser");
		return await fetchPage(url, {
			blockMedia: false,
			waitUntil: options?.waitUntil ?? "networkidle0",
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isBrowserUnavailableError(msg)) {
			logger.info("Browser unavailable for page", { error: msg.slice(0, 200) });
			return null;
		}
		throw err;
	}
}
