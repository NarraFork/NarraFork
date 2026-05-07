import { afterAll, describe, expect, test } from "bun:test";
import {
	actions,
	type BrowserSession,
	closeBrowser,
	closeSession,
	createSession,
	listSessions,
	setSessionTtl,
} from "../index";

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

function dataUrl(body: string): string {
	return `data:text/html,${encodeURIComponent(body)}`;
}

async function withSession<T>(
	body: string,
	run: (session: BrowserSession) => Promise<T>,
): Promise<T> {
	const narratorId = `test-browser-${crypto.randomUUID()}`;
	const session = await createSession(narratorId, dataUrl(body), true);
	try {
		return await run(session);
	} finally {
		await closeSession(narratorId, session.id).catch(() => {});
	}
}

async function skipIfNoBrowser(): Promise<boolean> {
	if (await canLaunchBrowser()) return false;
	console.log("Skipping: Chrome not available");
	return true;
}

afterAll(async () => {
	await closeBrowser().catch(() => {});
});

describe("Browser actions — evaluate and console capture", () => {
	test("session TTL can be configured and updated", async () => {
		if (await skipIfNoBrowser()) return;

		const narratorId = `test-browser-${crypto.randomUUID()}`;
		const session = await createSession(
			narratorId,
			dataUrl("<html><body>ok</body></html>"),
			true,
			60_000,
		);
		try {
			expect(session.ttlMs).toBe(60_000);
			expect(listSessions(narratorId)[0]?.ttlMs).toBe(60_000);

			const updated = setSessionTtl(narratorId, session.id, 120_000);
			expect(updated?.ttlMs).toBe(120_000);
			const listed = listSessions(narratorId)[0];
			expect(listed?.ttlMs).toBe(120_000);
			expect(listed?.expiresAt).toBe(session.lastActivity + 120_000);
		} finally {
			await closeSession(narratorId, session.id).catch(() => {});
		}
	}, 30_000);

	test("evaluate returns pretty JSON for objects", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>ok</body></html>", async (session) => {
			const result = await actions.evaluate(session, "({ ok: true, count: 2 })");

			expect(result.result).toContain('"ok": true');
			expect(result.result).toContain('"count": 2');
		});
	}, 30_000);

	test("evaluate handles undefined and no-return IIFEs", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>ok</body></html>", async (session) => {
			const undefinedResult = await actions.evaluate(session, "undefined");
			const noReturnResult = await actions.evaluate(session, "(() => { window.__ran = true; })()");

			expect(undefinedResult.result).toBe("(undefined)");
			expect(noReturnResult.result).toBe("(undefined)");
		});
	}, 30_000);

	test("captures initial and structured console messages", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession(
			`<html><body><script>console.log("initial", { a: 1, nested: { ok: true } })</script></body></html>`,
			async (session) => {
				const result = await actions.getConsole(session, { clear: true });

				expect(result.count).toBe(1);
				expect(result.output).toContain("initial");
				expect(result.output).toContain('"a":1');
				expect(result.output).toContain('"ok":true');

				const afterClear = await actions.getConsole(session);
				expect(afterClear.count).toBe(0);
				expect(afterClear.output).toContain("No console messages captured");
			},
		);
	}, 30_000);

	test("console capture preserves Error diagnostics when structured args are empty", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession(
			`<html><body><script>console.error(new Error("boom diagnostic"))</script></body></html>`,
			async (session) => {
				const result = await actions.getConsole(session);

				expect(result.count).toBe(1);
				expect(result.output).toContain("boom diagnostic");
				expect(result.output).not.toMatch(/ERROR\\s+\{\}\s*$/);
			},
		);
	}, 30_000);

	test("evaluateCapture returns only current run console and return value", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession(
			`<html><body><script>console.log("old message")</script></body></html>`,
			async (session) => {
				const result = await actions.evaluateCapture(
					session,
					`(() => {
						console.log("current", { ok: true });
						return { value: 42 };
					})()`,
				);

				expect(result.isError).toBe(false);
				expect(result.result).toContain('"value": 42');
				expect(result.consoleCount).toBe(1);
				expect(result.consoleOutput).toContain("current");
				expect(result.consoleOutput).toContain('"ok":true');
				expect(result.consoleOutput).not.toContain("old message");
			},
		);
	}, 30_000);

	test("evaluateCapture captures async page errors", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>ok</body></html>", async (session) => {
			const result = await actions.evaluateCapture(
				session,
				`(() => {
					setTimeout(() => { throw new Error("boom from timeout"); }, 0);
					return "scheduled";
				})()`,
				{ waitAfterMs: 100 },
			);

			expect(result.result).toBe("scheduled");
			expect(result.consoleOutput).toContain("PAGEERROR");
			expect(result.consoleOutput).toContain("boom from timeout");
		});
	}, 30_000);

	test("evaluateCapture captures current logs when console buffer rotates", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>ok</body></html>", async (session) => {
			await actions.evaluate(
				session,
				`(() => {
					for (let i = 0; i < 200; i++) console.log("old", i);
				})()`,
			);
			const before = await actions.getConsole(session);
			expect(before.count).toBe(200);

			const result = await actions.evaluateCapture(
				session,
				`(() => {
					console.log("current", "a");
					console.log("current", "b");
					return "done";
				})()`,
				{ clear: false },
			);

			expect(result.result).toBe("done");
			expect(result.consoleCount).toBe(2);
			expect(result.consoleOutput).toContain("current a");
			expect(result.consoleOutput).toContain("current b");
			expect(result.consoleOutput).not.toContain("old");
		});
	}, 30_000);

	test("evaluate reports timeout errors clearly", async () => {
		if (await skipIfNoBrowser()) return;

		await withSession("<html><body>ok</body></html>", async (session) => {
			let message = "";
			try {
				await actions.evaluate(session, "new Promise(() => {})", { timeout: 50 });
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}

			expect(message).toBe("Browser evaluate timed out after 50ms");
		});
	}, 30_000);
});
