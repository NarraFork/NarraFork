// High-level browser actions for the Browser tool.
// Each action operates on a BrowserSession and returns a ToolResult-compatible output.

import { writeFile } from "node:fs/promises";
import type { KeyInput, Page } from "puppeteer-core";
import { cleanHtml } from "../web-fetch/dom";
import type { BrowserConsoleMessage, BrowserSession } from "./session";
import { touchSession } from "./session";

const DEFAULT_MAX_LENGTH = 20_000;
const DEFAULT_ACTION_TIMEOUT = 10_000;

/** Snapshot of page state returned after most actions. */
export interface PageSnapshot {
	url: string;
	title: string;
}

async function snapshot(page: Page): Promise<PageSnapshot> {
	return {
		url: page.url(),
		title: await page.title(),
	};
}

function formatConsoleLocation(message: BrowserConsoleMessage): string {
	const { location } = message;
	if (!location?.url) return "";
	const line = location.lineNumber !== undefined ? `:${location.lineNumber}` : "";
	const column = location.columnNumber !== undefined ? `:${location.columnNumber}` : "";
	return ` (${location.url}${line}${column})`;
}

/** Navigate to a URL or go back/forward. */
export async function navigate(
	session: BrowserSession,
	opts: { url?: string; direction?: "back" | "forward" },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	const { page } = session;

	if (opts.direction === "back") {
		await page.goBack({ waitUntil: "domcontentloaded" });
	} else if (opts.direction === "forward") {
		await page.goForward({ waitUntil: "domcontentloaded" });
	} else if (opts.url) {
		await page.goto(opts.url, { waitUntil: "domcontentloaded" });
	}

	return { snapshot: await snapshot(page) };
}

/** Click an element by selector. */
export async function click(
	session: BrowserSession,
	selector: string,
	opts?: { coordinate?: { x: number; y: number }; timeout?: number },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	const { page } = session;

	// Set up a navigation listener BEFORE clicking — if the click triggers a
	// navigation (form submit, link follow, SPA route change) we want to wait
	// for it to settle instead of returning stale state.
	const navPromise = page
		.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1500 })
		.catch(() => null);

	if (opts?.coordinate && !selector) {
		await page.mouse.click(opts.coordinate.x, opts.coordinate.y);
	} else {
		await page.click(selector, { delay: 50 });
	}

	// Give the page a moment: either navigation completes or we move on after
	// a short grace period (covers SPA state updates that don't trigger
	// full navigation).
	await Promise.race([navPromise, new Promise((r) => setTimeout(r, 500))]);

	return { snapshot: await snapshot(page) };
}

/** Fill a form field. */
export async function fill(
	session: BrowserSession,
	selector: string,
	value: string,
	_opts?: { timeout?: number },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	// Click to focus, Ctrl+A to select all (works for both inputs and textareas),
	// then Backspace to clear, then type new value.
	await session.page.click(selector);
	await session.page.keyboard.down("Control");
	await session.page.keyboard.press("a");
	await session.page.keyboard.up("Control");
	await session.page.keyboard.press("Backspace");
	await session.page.type(selector, value, { delay: 20 });
	return { snapshot: await snapshot(session.page) };
}

/** Select an option from a <select> element. */
export async function select(
	session: BrowserSession,
	selector: string,
	value: string,
	_opts?: { timeout?: number },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	await session.page.select(selector, value);
	return { snapshot: await snapshot(session.page) };
}

/** Type text or press special keys. */
export async function type(
	session: BrowserSession,
	opts: { selector?: string; value?: string; key?: string; timeout?: number },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	const { page } = session;

	if (opts.key) {
		if (opts.selector) {
			await page.focus(opts.selector);
			await page.keyboard.press(opts.key as KeyInput);
		} else {
			await page.keyboard.press(opts.key as KeyInput);
		}
	} else if (opts.value) {
		if (opts.selector) {
			await page.type(opts.selector, opts.value, { delay: 50 });
		} else {
			await page.keyboard.type(opts.value, { delay: 50 });
		}
	}

	return { snapshot: await snapshot(page) };
}

/** Hover over an element. */
export async function hover(
	session: BrowserSession,
	selector: string,
	_opts?: { timeout?: number },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	await session.page.hover(selector);
	return { snapshot: await snapshot(session.page) };
}

/** Take a screenshot of the current page. */
export async function screenshot(
	session: BrowserSession,
	opts?: { fullPage?: boolean },
): Promise<{ base64: string; width: number; height: number }> {
	touchSession(session);
	const { page } = session;
	const viewport = page.viewport();
	const buffer = await page.screenshot({
		type: "png",
		fullPage: opts?.fullPage ?? false,
		encoding: "binary",
	});
	return {
		base64: Buffer.from(buffer as Uint8Array).toString("base64"),
		width: viewport?.width ?? 1280,
		height: viewport?.height ?? 900,
	};
}

/** Get text content of an element. */
export async function getText(
	session: BrowserSession,
	selector: string,
	opts?: { maxLength?: number; timeout?: number },
): Promise<{ text: string; snapshot: PageSnapshot }> {
	touchSession(session);
	const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH;

	let text = (await session.page.$eval(selector, (el) => el.textContent).catch(() => null)) ?? "";
	if (text.length > maxLength) {
		text = `${text.slice(0, maxLength)}\n\n[Text truncated at ${maxLength} characters]`;
	}

	return { text, snapshot: await snapshot(session.page) };
}

/** Get an attribute value of an element. */
export async function getAttribute(
	session: BrowserSession,
	selector: string,
	attribute: string,
	_opts?: { timeout?: number },
): Promise<{ value: string | null; snapshot: PageSnapshot }> {
	touchSession(session);
	const value = await session.page
		.$eval(selector, (el, attr) => el.getAttribute(attr), attribute)
		.catch(() => null);
	return { value, snapshot: await snapshot(session.page) };
}

/** Get captured console output and page errors. */
export async function getConsole(
	session: BrowserSession,
	opts?: { maxLength?: number; clear?: boolean },
): Promise<{ output: string; count: number; snapshot: PageSnapshot }> {
	touchSession(session);
	const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH;
	const messages = session.consoleMessages;
	const count = messages.length;
	const lines = messages.map((message) => {
		const time = new Date(message.timestamp).toISOString();
		return `[${time}] ${message.type.toUpperCase()}${formatConsoleLocation(message)} ${message.text}`;
	});
	let output = lines.join("\n");
	if (!output) output = "No console messages captured.";
	if (output.length > maxLength) {
		output = `${output.slice(0, maxLength)}\n\n[Console output truncated at ${maxLength} characters]`;
	}
	if (opts?.clear) {
		session.consoleMessages.length = 0;
	}
	return {
		output,
		count,
		snapshot: await snapshot(session.page),
	};
}

/** Execute JavaScript in the page context. */
export async function evaluate(
	session: BrowserSession,
	expression: string,
	opts?: { maxLength?: number },
): Promise<{ result: string; snapshot: PageSnapshot }> {
	touchSession(session);
	const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH;

	const raw = await session.page.evaluate(expression);
	let result = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
	if (result.length > maxLength) {
		result = `${result.slice(0, maxLength)}\n\n[Output truncated at ${maxLength} characters]`;
	}

	return { result, snapshot: await snapshot(session.page) };
}

/** Wait for an element to appear or a condition. */
export async function wait(
	session: BrowserSession,
	opts: { selector?: string; state?: "visible" | "hidden" | "attached"; timeout?: number },
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	const { page } = session;
	const timeout = opts.timeout ?? DEFAULT_ACTION_TIMEOUT;

	if (opts.selector) {
		if (opts.state === "hidden") {
			await page.waitForSelector(opts.selector, { hidden: true, timeout });
		} else if (opts.state === "visible") {
			await page.waitForSelector(opts.selector, { visible: true, timeout });
		} else {
			// "attached" (default) — just wait for element to exist in DOM
			await page.waitForSelector(opts.selector, { timeout });
		}
	} else {
		await new Promise((r) => setTimeout(r, timeout));
	}

	return { snapshot: await snapshot(session.page) };
}

/** Scroll the page. */
export async function scroll(
	session: BrowserSession,
	opts: {
		direction?: "up" | "down";
		amount?: number;
		selector?: string;
		coordinate?: { x: number; y: number };
	},
): Promise<{ snapshot: PageSnapshot }> {
	touchSession(session);
	const { page } = session;
	const amount = opts.amount ?? 500;
	const deltaY = opts.direction === "up" ? -amount : amount;

	if (opts.selector) {
		await page.$eval(opts.selector, (el, dy) => el.scrollBy(0, dy), deltaY);
	} else {
		const x = opts.coordinate?.x ?? 640;
		const y = opts.coordinate?.y ?? 450;
		await page.mouse.move(x, y);
		await page.mouse.wheel({ deltaY });
	}

	return { snapshot: await snapshot(page) };
}

// ── Performance tracing ──

/** Default trace categories for performance profiling. */
const DEFAULT_PERF_CATEGORIES = [
	"devtools.timeline",
	"v8.execute",
	"disabled-by-default-devtools.timeline",
	"disabled-by-default-devtools.timeline.frame",
	"toplevel",
	"blink.console",
	"blink.user_timing",
	"loading",
];

/** Start performance tracing on the session's page. */
export async function perfStart(
	session: BrowserSession,
	opts?: { categories?: string[]; screenshots?: boolean },
): Promise<void> {
	touchSession(session);
	if (session.tracing?.active) {
		throw new Error("Tracing is already active on this session");
	}
	const categories = opts?.categories?.length ? opts.categories : DEFAULT_PERF_CATEGORIES;
	await session.page.tracing.start({
		categories,
		screenshots: opts?.screenshots ?? false,
	});
	session.tracing = { active: true, startedAt: Date.now() };
}

/** Stop performance tracing and write the trace buffer to `savePath`. */
export async function perfStop(
	session: BrowserSession,
	savePath: string,
): Promise<{ fileSize: number; durationMs: number }> {
	touchSession(session);
	if (!session.tracing?.active) {
		throw new Error("No active tracing on this session");
	}
	const durationMs = Date.now() - session.tracing.startedAt;
	const buffer = await session.page.tracing.stop();
	if (!buffer) {
		session.tracing = undefined;
		throw new Error("Tracing returned empty buffer");
	}
	await writeFile(savePath, buffer);
	session.tracing = undefined;
	return { fileSize: buffer.byteLength, durationMs };
}

/** Get cleaned DOM of the current page or a selector. */
export async function getDom(
	session: BrowserSession,
	opts?: { selector?: string; maxLength?: number },
): Promise<{ dom: string; snapshot: PageSnapshot }> {
	touchSession(session);
	const { page } = session;
	const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH;

	let html: string;
	if (opts?.selector) {
		const elements = await page
			.$$eval(opts.selector, (els) => els.map((el) => el.outerHTML).join("\n"))
			.catch(() => "");
		html = elements || `No elements found matching selector: ${opts.selector}`;
	} else {
		html = await page.evaluate(() => document.body?.innerHTML ?? "");
	}

	let cleaned = cleanHtml(html);
	if (cleaned.length > maxLength) {
		cleaned = `${cleaned.slice(0, maxLength)}\n\n[DOM truncated at ${maxLength} characters]`;
	}

	return { dom: cleaned, snapshot: await snapshot(page) };
}
