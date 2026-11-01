// Run with: bun test --isolate server/lib/browser/__tests__/dialogs.integration.test.ts
// No mocks: only the Chrome launched by this isolated test process is closed.
import { afterAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import * as actions from "../actions";
import { installDialogProtection } from "../dialogs";
import { connectBrowser, getBrowser } from "../pool";
import {
	type BrowserSession,
	closeAllSessions,
	closeSession,
	createSession,
	getSession,
	restoreSessionFromHandoff,
	snapshotSessionsForHandoff,
} from "../session";
import { closeTab, targetIdOf } from "../tab-scope";

const TIMEOUT = 8_000;
let ownedBrowser: Browser | undefined;
try {
	ownedBrowser = await getBrowser(true);
} catch (error) {
	// A broken installed Chrome is a failure, not a skipped test.
	if (!(error instanceof Error) || !error.message.startsWith("Could not find Chrome/Chromium")) {
		throw error;
	}
	console.warn("Skipping real-Chrome dialog integration tests: Chrome/Chromium not installed");
}
const chromeTest = ownedBrowser ? test : test.skip;
const endpoint = ownedBrowser?.wsEndpoint();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		const body =
			path === "/initial"
				? '<script>alert("initial-alert");document.documentElement.dataset.ready="yes"</script>'
				: path === "/popup"
					? '<script>alert("popup-first-script");document.documentElement.dataset.ready="yes"</script><title>popup-ready</title>'
					: `<title>dialog-fixture</title>
<button id="dialogs" onclick="alert('click-alert');this.dataset.confirm=String(confirm('click-confirm'));this.dataset.prompt=String(prompt('click-prompt'));this.dataset.done='yes'">dialogs</button>
<button id="next" onclick="this.dataset.done='yes'">next</button>
<button id="open" onclick="window.open('/popup')">window.open</button>
<a id="blank" href="/popup" target="_blank">new window</a>
<a id="leave" href="/destination">leave</a>`;
		return new Response(`<!doctype html><html>${body}</html>`, {
			headers: { "Content-Type": "text/html" },
		});
	},
});
const url = (path = "/") => new URL(path, server.url).href;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${TIMEOUT}ms`)), TIMEOUT);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Required Chrome test fixture missing");
	return value;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + TIMEOUT;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`${label} exceeded ${TIMEOUT}ms`);
		await Bun.sleep(20);
	}
}

async function assertDialog(session: BrowserSession, text: string): Promise<void> {
	await waitFor(
		() =>
			session.consoleMessages.some(
				(entry) =>
					entry.type === "dialog" &&
					entry.text.includes("Automatically dismissed") &&
					entry.text.includes(text),
			),
		text,
	);
	expect(
		session.consoleMessages.filter(
			(entry) => entry.type === "dialog" && entry.text.includes("Failed"),
		),
	).toEqual([]);
}

async function withSession(run: (session: BrowserSession) => Promise<void>, path = "/") {
	const session = await bounded(
		createSession(`test-dialog-${crypto.randomUUID()}`, url(path), true),
		"create session",
	);
	try {
		await run(session);
	} finally {
		await closeSession(session.narratorId, session.id);
	}
}

async function subsequentAction(session: BrowserSession) {
	await bounded(actions.click(session, "#next"), "subsequent click");
	expect(
		(
			await actions.evaluate(session, "document.querySelector('#next').dataset.done", {
				timeout: TIMEOUT,
			})
		).result,
	).toBe("yes");
}

afterAll(async () => {
	server.stop(true);
	// Reconnect only to our captured endpoint if a handoff test failed while disconnected.
	if (ownedBrowser && !ownedBrowser.connected && endpoint) {
		ownedBrowser = await puppeteer.connect({ browserWSEndpoint: endpoint });
	}
	await ownedBrowser?.close();
});

describe("native dialogs against real Chrome", () => {
	chromeTest(
		"dismisses an alert in the initial navigation script",
		async () => {
			await withSession(async (session) => {
				expect(await session.page.evaluate(() => document.documentElement.dataset.ready)).toBe(
					"yes",
				);
				await assertDialog(session, "initial-alert");
				await session.page.goto(url());
				await subsequentAction(session);
			}, "/initial");
		},
		30_000,
	);

	chromeTest(
		"click and evaluate dismiss alert/confirm/prompt and leave tools usable",
		async () => {
			await withSession(async (session) => {
				await bounded(actions.click(session, "#dialogs"), "dialog click");
				expect(
					await session.page.$eval("#dialogs", (element) => ({
						...(element as HTMLElement).dataset,
					})),
				).toEqual({ confirm: "false", prompt: "null", done: "yes" });
				for (const kind of ["alert", "confirm", "prompt"])
					await assertDialog(session, `click-${kind}`);
				const result = await actions.evaluate(
					session,
					`(() => { alert('evaluate-alert'); return [confirm('evaluate-confirm'), prompt('evaluate-prompt')]; })()`,
					{ timeout: TIMEOUT },
				);
				expect(JSON.parse(result.result)).toEqual([false, null]);
				for (const kind of ["alert", "confirm", "prompt"])
					await assertDialog(session, `evaluate-${kind}`);
				await subsequentAction(session);
			});
		},
		30_000,
	);

	for (const selector of ["#open", "#blank"]) {
		chromeTest(
			`${selector} popup dismisses its earliest script alert`,
			async () => {
				await withSession(async (session) => {
					const targetPromise = session.context.waitForTarget(
						(target) => target.url() === url("/popup"),
						{ timeout: TIMEOUT },
					);
					await bounded(actions.click(session, selector), "open popup");
					const target = await targetPromise;
					const popup = await bounded(target.page(), "popup page initialization");
					expect(popup).not.toBeNull();
					await bounded(
						required(popup).waitForFunction(() => document.documentElement.dataset.ready === "yes"),
						"popup resumed",
					);
					// Popup attachment may win after the opening event was emitted.
					await assertDialog(session, "native dialog (");
					expect(
						session.consoleMessages.some(
							(entry) =>
								entry.type === "dialog" &&
								(entry.text.includes("alert: popup-first-script") ||
									entry.text.includes("already open at attachment; type and message unavailable")),
						),
					).toBe(true);
					expect(await required(popup).title()).toBe("popup-ready");
					await required(popup).close();
					await subsequentAction(session);
				});
			},
			30_000,
		);
	}

	chromeTest(
		"beforeunload is cancelled and keeps the original document interactive",
		async () => {
			await withSession(async (session) => {
				await session.page.evaluate(() => {
					window.onbeforeunload = (event) => {
						event.preventDefault();
						event.returnValue = "stay";
					};
				});
				// Trusted click supplies sticky user activation required by Chrome.
				await bounded(actions.click(session, "#leave"), "beforeunload click");
				await assertDialog(session, "beforeunload:");
				expect(session.page.url()).toBe(url());
				await subsequentAction(session);
				await session.page.evaluate(() => {
					window.onbeforeunload = null;
				});
			});
		},
		30_000,
	);

	chromeTest(
		"attachment dismisses an already-open dialog without relying on Page.enable replay",
		async () => {
			const context = await required(ownedBrowser).createBrowserContext();
			try {
				const page = await context.newPage();
				await page.goto(url());
				const opened = new Promise<string>((resolve) =>
					page.once("dialog", (dialog) => resolve(dialog.message())),
				);
				// Listening without dismissing ensures the native dialog really exists first.
				const evaluation = page.evaluate(() => {
					alert("already-open");
					return "resumed";
				});
				void evaluation.catch(() => {});
				expect(await bounded(opened, "native dialog opening")).toBe("already-open");
				const records: string[] = [];
				await bounded(
					installDialogProtection(context, (text) => records.push(text)),
					"install protection after opening",
				);
				expect(
					await bounded(
						evaluation,
						`existing dialog dismissed; records=${JSON.stringify(records)}`,
					),
				).toBe("resumed");
				await waitFor(
					() =>
						records.some((text) =>
							text.includes(
								"Automatically dismissed native dialog (already open at attachment; type and message unavailable)",
							),
						),
					"replayed dialog record",
				);
			} finally {
				await context.close();
			}
		},
		30_000,
	);

	chromeTest(
		"dialog logging keeps only the newest 200 entries",
		async () => {
			await withSession(async (session) => {
				await actions.evaluate(
					session,
					"(() => { for (let i = 0; i < 205; i++) alert('bounded-' + i); return 'finished'; })()",
					{ timeout: TIMEOUT },
				);
				await assertDialog(session, "alert: bounded-204)");
				const entries = session.consoleMessages;
				expect(entries).toHaveLength(200);
				expect(entries.every((entry) => entry.type === "dialog")).toBe(true);
				expect(required(entries[0]).text).toContain("alert: bounded-5)");
				expect(required(entries[199]).text).toContain("alert: bounded-204)");
				expect(entries.map((entry) => entry.seq)).toEqual(
					Array.from({ length: 200 }, (_, index) => index + 6),
				);
				await subsequentAction(session);
			});
		},
		30_000,
	);

	chromeTest(
		"restores protection after a normal disconnect/reconnect handoff",
		async () => {
			await withSession(async (session) => {
				const handoff = required(
					snapshotSessionsForHandoff().find((entry) => entry.sessionId === session.id),
				);
				await session.page.evaluate(() => {
					document.documentElement.dataset.handoff = "survived";
				});
				await closeAllSessions({ preserve: true });
				await required(ownedBrowser).disconnect();
				ownedBrowser = await connectBrowser(true, required(endpoint));
				expect(
					await bounded(restoreSessionFromHandoff(ownedBrowser, handoff), "normal restore"),
				).toEqual({ ok: true });
				const restored = required(getSession(session.narratorId, session.id));
				expect(await restored.page.evaluate(() => document.documentElement.dataset.handoff)).toBe(
					"survived",
				);
				const result = await actions.evaluate(
					restored,
					"(() => { alert('restored-alert'); return [confirm('restored-confirm'), prompt('restored-prompt')]; })()",
					{ timeout: TIMEOUT },
				);
				expect(JSON.parse(result.result)).toEqual([false, null]);
				for (const kind of ["alert", "confirm", "prompt"])
					await assertDialog(restored, `restored-${kind}`);
				await subsequentAction(restored);
			});
		},
		30_000,
	);

	chromeTest(
		"fails promptly for a dialog owned by another connection and restores after manual dismissal",
		async () => {
			const session = await createSession(
				`test-dialog-handoff-${crypto.randomUUID()}`,
				url(),
				true,
			);
			const handoff = snapshotSessionsForHandoff().find((entry) => entry.sessionId === session.id);
			expect(handoff).toBeDefined();
			let observer: Browser | undefined;
			let context: BrowserContext | undefined;
			try {
				await session.page.evaluate(() => {
					document.documentElement.dataset.handoff = "survived";
				});
				// Independent connection owns the pending dialog; dismiss only after bounded restore failure.
				observer = await puppeteer.connect({ browserWSEndpoint: required(endpoint) });
				context = required(
					observer.browserContexts().find((item) => item.id === required(handoff).contextId),
				);
				const page: Page = required((await context.pages())[0]);
				await closeAllSessions({ preserve: true });
				await required(ownedBrowser).disconnect();
				expect(getSession(session.narratorId, session.id)).toBeUndefined();
				const opened = new Promise<import("puppeteer-core").Dialog>((resolve) =>
					page.once("dialog", resolve),
				);
				const evaluation = page.evaluate(() => {
					alert("handoff-already-open");
					return "resumed";
				});
				void evaluation.catch(() => {});
				const pendingDialog = await bounded(opened, "handoff native dialog opening");
				expect(pendingDialog.message()).toBe("handoff-already-open");
				ownedBrowser = await bounded(
					puppeteer.connect({ browserWSEndpoint: required(endpoint) }),
					"reconnect Chrome",
				);
				const started = Date.now();
				const failed = await bounded(
					restoreSessionFromHandoff(ownedBrowser, required(handoff)),
					"restore with foreign open dialog",
				);
				expect(Date.now() - started).toBeLessThan(TIMEOUT);
				expect(failed.ok).toBe(false);
				if (failed.ok) throw new Error("Foreign dialog must require manual dismissal");
				expect(failed.reason).toContain("Dismiss any existing browser dialog and retry");
				expect(getSession(session.narratorId, session.id)).toBeUndefined();
				expect(
					ownedBrowser.browserContexts().some((item) => item.id === required(handoff).contextId),
				).toBe(true);
				expect(page.isClosed()).toBe(false);
				expect(page.url()).toBe(required(handoff).currentPageUrl);
				await bounded(pendingDialog.dismiss(), "manual dismissal on original connection");
				expect(await bounded(evaluation, "original page resumes after manual dismissal")).toBe(
					"resumed",
				);
				expect(
					await bounded(
						restoreSessionFromHandoff(ownedBrowser, required(handoff)),
						"retry restore after dismissal",
					),
				).toEqual({ ok: true });
				const restored = required(getSession(session.narratorId, session.id));
				expect(restored).toBeDefined();
				expect(await bounded(evaluation, "handoff dialog dismissed")).toBe("resumed");
				expect(await restored.page.evaluate(() => document.documentElement.dataset.handoff)).toBe(
					"survived",
				);
				expect(
					(await actions.evaluate(restored, "confirm('after-restore')", { timeout: TIMEOUT }))
						.result,
				).toBe("false");
				await assertDialog(restored, "after-restore");
				await subsequentAction(restored);
			} finally {
				await context?.close();
				await observer?.disconnect();
				await closeSession(session.narratorId, session.id);
			}
		},
		40_000,
	);
});

// 有头会话与用户标签共处默认 context；无头浏览器里同样的默认 context 足以验证归属边界。
describe("sessions sharing the default context", () => {
	async function sharedPage(path = "/"): Promise<Page> {
		const page = await required(ownedBrowser).defaultBrowserContext().newPage();
		await page.goto(url(path));
		return page;
	}

	chromeTest(
		"protects the session's tab tree and leaves other tabs' dialogs alone",
		async () => {
			const context = required(ownedBrowser).defaultBrowserContext();
			const ours = await sharedPage();
			const theirs = await sharedPage();
			const records: string[] = [];
			try {
				await installDialogProtection(context, (text) => records.push(text), ours.target());
				// 后台标签不渲染，直接用 page.click 时要先把它切到前台
				await ours.bringToFront();
				for (const selector of ["#open", "#blank"]) {
					const popupTarget = context.waitForTarget((t) => t.url() === url("/popup"), {
						timeout: TIMEOUT,
					});
					await bounded(ours.click(selector), `open ${selector}`);
					const popup = required(await bounded((await popupTarget).page(), "popup page"));
					await bounded(
						popup.waitForFunction(() => document.documentElement.dataset.ready === "yes"),
						`${selector} popup resumed`,
					);
					await popup.close();
				}
				await waitFor(
					() => records.filter((text) => text.includes("Automatically dismissed")).length >= 2,
					"popup dialogs dismissed",
				);

				const dialog = new Promise<import("puppeteer-core").Dialog>((resolve) =>
					theirs.once("dialog", resolve),
				);
				const evaluation = theirs.evaluate(() => alert("theirs-alert"));
				const pending = await bounded(dialog, "foreign dialog opening");
				// 我们的保护若越界，这里会因对话框已被关掉而失败
				await bounded(pending.dismiss(), "foreign dialog left for its owner");
				await evaluation;
				expect(records.some((text) => text.includes("theirs-alert"))).toBe(false);
			} finally {
				await closeTab(context, ours.target());
				expect(ours.isClosed()).toBe(true);
				expect(theirs.isClosed()).toBe(false);
				await theirs.close();
			}
		},
		30_000,
	);

	chromeTest(
		"retains popup ownership and protection after an intermediate tab closes",
		async () => {
			const context = required(ownedBrowser).defaultBrowserContext();
			const ours = await sharedPage();
			const theirs = await sharedPage();
			const records: string[] = [];
			const popups: Page[] = [];
			async function openPopup(opener: Page): Promise<Page> {
				const pending = new Promise<Page | null>((resolve) => opener.once("popup", resolve));
				await opener.evaluate(() => window.open("about:blank"));
				const popup = required(await bounded(pending, "nested popup"));
				popups.push(popup);
				return popup;
			}
			try {
				await installDialogProtection(context, (text) => records.push(text), ours.target());
				const middle = await openPopup(ours);
				const leaf = await openPopup(middle);
				await middle.close();
				expect(leaf.target().opener()).toBeUndefined();
				const descendant = await openPopup(leaf);
				expect(
					await bounded(
						descendant.evaluate(() => confirm("orphan-descendant")),
						"dialog",
					),
				).toBe(false);
				await waitFor(
					() => records.some((text) => text.includes("orphan-descendant")),
					"descendant dialog protected",
				);
				await closeTab(context, ours.target());
				expect(ours.isClosed()).toBe(true);
				expect(leaf.isClosed()).toBe(true);
				expect(descendant.isClosed()).toBe(true);
				expect(theirs.isClosed()).toBe(false);
			} finally {
				await Promise.all([ours, theirs, ...popups].map((page) => page.close().catch(() => {})));
			}
		},
		30_000,
	);

	chromeTest(
		"restores a shared-context session by its root tab after reconnect",
		async () => {
			const ours = await sharedPage();
			const theirs = await sharedPage();
			const theirsId = targetIdOf(theirs.target());
			await ours.evaluate(() => {
				document.documentElement.dataset.handoff = "survived";
			});
			const handoff = {
				sessionId: `shared-${crypto.randomUUID().slice(0, 8)}`,
				narratorId: `test-shared-handoff-${crypto.randomUUID()}`,
				url: url(),
				currentPageUrl: url(),
				targetId: targetIdOf(ours.target()),
				headless: false,
				ttlMs: 60_000,
				networkCaptureEnabled: false,
			};
			await required(ownedBrowser).disconnect();
			ownedBrowser = await connectBrowser(true, required(endpoint));
			expect(await bounded(restoreSessionFromHandoff(ownedBrowser, handoff), "restore")).toEqual({
				ok: true,
			});
			const restored = required(getSession(handoff.narratorId, handoff.sessionId));
			expect(await restored.page.evaluate(() => document.documentElement.dataset.handoff)).toBe(
				"survived",
			);
			expect(
				(await actions.evaluate(restored, "confirm('shared')", { timeout: TIMEOUT })).result,
			).toBe("false");
			await assertDialog(restored, "shared");
			// 另一个标签占了前台时，会话动作仍能完成
			const foreground = await required(ownedBrowser).defaultBrowserContext().newPage();
			expect(await restored.page.evaluate(() => document.visibilityState)).toBe("hidden");
			await bounded(subsequentAction(restored), "click in a background tab");
			await foreground.close();
			await closeSession(handoff.narratorId, handoff.sessionId);
			const remaining = required(ownedBrowser)
				.targets()
				.map((target) => targetIdOf(target));
			expect(remaining).not.toContain(handoff.targetId);
			expect(remaining).toContain(theirsId);
			const theirsAgain = required(ownedBrowser)
				.targets()
				.find((t) => targetIdOf(t) === theirsId);
			await (await theirsAgain?.page())?.close();
		},
		30_000,
	);
});
