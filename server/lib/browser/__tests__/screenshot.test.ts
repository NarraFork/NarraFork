/**
 * screenshot.test.ts — the Browser screenshot capture path.
 *
 * Regression context: `page.screenshot()` is bounded only by puppeteer's connection-wide 180s
 * protocolTimeout and serializes every capture in a context behind one mutex. When Chrome wedged
 * `Page.captureScreenshot` (occluded headed window, lost GPU surface), the panel's auto-refresh
 * stacked doomed captures behind that mutex and requests returned 500 after 140–235 SECONDS.
 *
 * These tests pin the properties that keep such a stall bounded and non-cumulative:
 * a per-attempt timeout, dedupe of concurrent captures on the same session, and a viewport-sized
 * PNG for the normal path. They run against real Chrome and skip when Chrome is unavailable.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { CDPSession } from "puppeteer-core";
import { actions, type BrowserSession, closeBrowser, closeSession, createSession } from "../index";

let browserChecked = false;
let browserOk = false;

async function canLaunchBrowser(): Promise<boolean> {
	if (browserChecked) return browserOk;
	browserChecked = true;
	try {
		const { getBrowser } = await import("../pool");
		const browser = await getBrowser();
		browserOk = browser.connected;
	} catch {
		browserOk = false;
	}
	return browserOk;
}

async function skipIfNoBrowser(): Promise<boolean> {
	if (await canLaunchBrowser()) return false;
	console.log("Skipping: Chrome not available");
	return true;
}

function dataUrl(body: string): string {
	return `data:text/html,${encodeURIComponent(body)}`;
}

async function withSession<T>(
	body: string,
	run: (session: BrowserSession) => Promise<T>,
): Promise<T> {
	const narratorId = `test-screenshot-${crypto.randomUUID()}`;
	const session = await createSession(narratorId, dataUrl(body), true);
	try {
		return await run(session);
	} finally {
		await closeSession(narratorId, session.id).catch(() => {});
	}
}

/** PNG magic bytes, so we assert on a real image rather than any base64 blob. */
function isPng(base64: string): boolean {
	const header = Buffer.from(base64.slice(0, 16), "base64");
	return header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
}

afterAll(async () => {
	await closeBrowser().catch(() => {});
});

describe("Browser screenshot", () => {
	test("captures a viewport-sized PNG", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body><h1>shot</h1></body></html>", async (session) => {
			const result = await actions.screenshot(session);

			expect(isPng(result.base64)).toBe(true);
			expect(result.width).toBe(session.page.viewport()?.width ?? 1280);
			expect(result.height).toBe(session.page.viewport()?.height ?? 900);
		});
	}, 30_000);

	test("fullPage capture reports the full scroll height, not the viewport height", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession(
			'<html><body style="margin:0"><div style="height:3000px"></div></body></html>',
			async (session) => {
				const viewportHeight = session.page.viewport()?.height ?? 900;
				const result = await actions.screenshot(session, { fullPage: true });

				expect(isPng(result.base64)).toBe(true);
				expect(result.height).toBeGreaterThan(viewportHeight);
			},
		);
	}, 30_000);

	test("concurrent captures of the same session share one Chrome round-trip", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>dedupe</body></html>", async (session) => {
			// Count real CDP captures by intercepting session creation on the page.
			const originalCreate = session.page.createCDPSession.bind(session.page);
			let captures = 0;
			session.page.createCDPSession = async (): Promise<CDPSession> => {
				const client = await originalCreate();
				const originalSend = client.send.bind(client);
				// biome-ignore lint/suspicious/noExplicitAny: test shim mirrors the CDP send overloads
				client.send = ((method: any, ...rest: any[]) => {
					if (method === "Page.captureScreenshot") captures++;
					// biome-ignore lint/suspicious/noExplicitAny: forwarded verbatim to puppeteer
					return (originalSend as any)(method, ...rest);
				}) as typeof client.send;
				return client;
			};

			try {
				const [a, b, c] = await Promise.all([
					actions.screenshot(session),
					actions.screenshot(session),
					actions.screenshot(session),
				]);

				expect(captures).toBe(1);
				expect(a.base64).toBe(b.base64);
				expect(b.base64).toBe(c.base64);
			} finally {
				session.page.createCDPSession = originalCreate;
			}
		});
	}, 30_000);

	test("a wedged capture fails fast instead of hanging until protocolTimeout", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>wedged</body></html>", async (session) => {
			// Simulate Chrome accepting the command and never replying — the exact shape of the
			// reported incident, where the request only failed after 140–235 seconds.
			const originalCreate = session.page.createCDPSession.bind(session.page);
			session.page.createCDPSession = async (): Promise<CDPSession> => {
				const client = await originalCreate();
				const originalSend = client.send.bind(client);
				// biome-ignore lint/suspicious/noExplicitAny: test shim mirrors the CDP send overloads
				client.send = ((method: any, ...rest: any[]) => {
					if (method === "Page.captureScreenshot") return new Promise(() => {});
					// biome-ignore lint/suspicious/noExplicitAny: forwarded verbatim to puppeteer
					return (originalSend as any)(method, ...rest);
				}) as typeof client.send;
				return client;
			};

			try {
				const startedAt = Date.now();
				let message = "";
				try {
					// Two attempts (surface capture, then the fromSurface:false retry) at 150ms each.
					await actions.screenshot(session, { timeout: 150 });
				} catch (err) {
					message = err instanceof Error ? err.message : String(err);
				}
				const elapsed = Date.now() - startedAt;

				expect(message).toContain("timed out");
				expect(elapsed).toBeLessThan(5_000);
			} finally {
				session.page.createCDPSession = originalCreate;
			}
		});
	}, 30_000);

	test("a failed capture does not poison later captures on the same session", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>recover</body></html>", async (session) => {
			const originalCreate = session.page.createCDPSession.bind(session.page);
			// Only the FIRST surface capture fails, so the fromSurface:false retry can succeed —
			// that retry is what makes an occluded window recoverable instead of a hard error.
			let remainingFailures = 1;
			session.page.createCDPSession = async (): Promise<CDPSession> => {
				const client = await originalCreate();
				const originalSend = client.send.bind(client);
				// biome-ignore lint/suspicious/noExplicitAny: test shim mirrors the CDP send overloads
				client.send = ((method: any, ...rest: any[]) => {
					if (method === "Page.captureScreenshot" && remainingFailures > 0) {
						remainingFailures--;
						return Promise.reject(
							new Error("Protocol error (Page.captureScreenshot): Internal error"),
						);
					}
					// biome-ignore lint/suspicious/noExplicitAny: forwarded verbatim to puppeteer
					return (originalSend as any)(method, ...rest);
				}) as typeof client.send;
				return client;
			};

			try {
				const retried = await actions.screenshot(session);
				expect(isPng(retried.base64)).toBe(true);
				expect(remainingFailures).toBe(0);

				const healthy = await actions.screenshot(session);
				expect(isPng(healthy.base64)).toBe(true);
			} finally {
				session.page.createCDPSession = originalCreate;
			}
		});
	}, 30_000);
});
