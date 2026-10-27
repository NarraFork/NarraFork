/**
 * The outline dock panel in Chromium, beside a session composer in a dockview, against a test
 * server running the real outline routes and live sessions (the isolated SQLite of
 * `tests/preload.ts`):
 *
 *   - a place opened the way a tool card or chat link opens it mounts the live editor in a
 *     panel next to the composer, and the panel learns its page and title;
 *   - navigating inside the panel (focus, view, time, Ctrl-click) changes the panel's params,
 *     never the URL (neither the router's nor the window's);
 *   - typing in the composer, including the editor's own keys, never reaches the outline;
 *   - two panels on one page share one live session, and opening a block of an open page
 *     reuses that page's panel;
 *   - a panel joins its page's live session only while on screen: a background tab leaves it
 *     (after the grace period) and joins again when shown, so opening more pages one after
 *     another than the socket takes never runs into the server's limit.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { projects, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import {
	closeAllLiveSessions,
	liveSessionOf,
	outlineLiveQuiet,
} from "../../../server/services/outline/live/registry";
import { ensureProjectSpace } from "../../../server/services/outline/spaces";
import type { OutlineSpaceRow } from "../../../server/services/outline/store/port";
import { writeOutline } from "../../../server/services/outline/write";
import {
	drainOutlineLive,
	handleOutlineLiveBinary,
	type OutlineLiveWS,
	releaseOutlineLive,
} from "../../../server/websocket/outline-live-ws";
import type * as Fixture from "./outline-dock.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-10-27T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let owner: string;
let space: OutlineSpaceRow;
let pageId: string;
let ids: string[];
/** More pages than one socket may have live at once. */
let morePages: string[];

function api() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
		c.set("user", { sub: token, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		error instanceof AppError
			? Response.json({ error: error.message, code: error.code }, { status: error.statusCode })
			: Response.json({ error: String(error) }, { status: 500 }),
	);
	app.get("/api/settings", (c) => c.json({ outline: { enabled: true } }));
	app.route("/api/outline", outlineRoutes);
	return app;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-dock.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("fixture bundle missing");
	const script = `/${basename(entry.path)}`;
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const app = api();
	server = Bun.serve<{ userId: string; username: string; userRole: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/live") {
				const userId = url.searchParams.get("user") ?? "";
				if (srv.upgrade(request, { data: { userId, username: "alice", userRole: "user" } }))
					return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname.startsWith("/api/")) {
				// Settings settle every test (the preload restores them after each).
				settings.outline.enabled = true;
				return app.fetch(request);
			}
			if (url.pathname === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				if (typeof message === "string") return;
				const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
				handleOutlineLiveBinary(ws as unknown as OutlineLiveWS, bytes);
			},
			drain(ws) {
				drainOutlineLive(ws as unknown as OutlineLiveWS);
			},
			close(ws) {
				releaseOutlineLive(ws as unknown as OutlineLiveWS);
			},
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
	owner = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: "alice", passwordHash: "x", role: "user", createdAt: NOW });
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Dock",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Dock page" },
			{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "first block" },
			{ op: "insert", parent: { tempId: "a" }, content: "child block" },
			{ op: "insert", parent: { tempId: "p" }, content: "second block" },
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	ids = written.results.map((result) => result.blockId);
	pageId = ids[0] as string;
	const more = await writeOutline({
		spaceId: space.id,
		ops: Array.from({ length: 10 }, (_, i) => ({
			op: "insert" as const,
			parent: null,
			content: `Page ${i + 1}`,
		})),
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	morePages = more.results.map((result) => result.blockId);
}, 60_000);

afterAll(async () => {
	await closeAllLiveSessions("ended");
	await browser?.close();
	server?.stop(true);
});

async function openDock(): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: 1240, height: 800 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), owner);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	const wsUrl = `${server.url.origin.replace("http", "ws")}/live?user=${encodeURIComponent(owner)}`;
	await page.evaluate(
		(url) => (window as unknown as FixtureWindow).fixture.open({ wsUrl: url }),
		wsUrl,
	);
	await page.waitForSelector("#composer-panel [contenteditable=true]", { timeout: 10_000 });
	return { page, errors };
}

function call<T>(page: Page, fn: (f: typeof Fixture, ...args: never[]) => T, ...args: unknown[]) {
	return page.evaluate(
		`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`,
	) as Promise<T>;
}

async function until(page: Page, fn: (f: typeof Fixture) => boolean, timeout = 10_000) {
	try {
		await page.waitForFunction(`(${fn.toString()})(window.fixture)`, { timeout, polling: 25 });
	} catch (error) {
		const state = await page
			.evaluate(() => ({
				panels: (window as unknown as FixtureWindow).fixture.panels(),
				text: document.body.innerText.slice(0, 1500),
			}))
			.catch(() => "page gone");
		throw new Error(`until ${fn.toString()}: ${JSON.stringify(state)}: ${String(error)}`);
	}
}

async function quiet(): Promise<void> {
	const end = Date.now() + 5000;
	while (Date.now() < end && !outlineLiveQuiet()) await new Promise((r) => setTimeout(r, 20));
}

test("an outline panel beside the composer navigates in place and keeps the keyboard to itself", async () => {
	const { page, errors } = await openDock();
	try {
		const before = await call(page, (f) => f.locations());

		// Opened the way a tool card does: the place, with its page already known.
		expect(
			await call(
				page,
				(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }),
				space.id,
				pageId,
			),
		).toBe(true);
		await until(page, (f) => f.liveEditors() === 1);
		await until(page, (f) => f.outlinePanels()[0]?.title === "Dock page");
		let [panel] = await call(page, (f) => f.outlinePanels());
		expect(panel?.params).toMatchObject({ spaceId: space.id, blockId: pageId, pageId });
		// The tab is named after the page, but the name is not stored with the panel.
		expect(panel?.params.title).toBeUndefined();
		expect((await call(page, (f) => f.panels())).map((p) => p.id)).toContain("ndock-chat");

		// Focus a block (its bullet): the panel's params follow, the URL does not.
		const first = ids[1] as string;
		await page.evaluate((id) => {
			const bullet = document.querySelector(`[data-id="${id}"] .ob-bullet`);
			bullet?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		}, first);
		await until(
			page,
			(f) => f.outlinePanels()[0]?.params.blockId !== f.outlinePanels()[0]?.params.pageId,
		);
		[panel] = await call(page, (f) => f.outlinePanels());
		expect(panel?.params).toMatchObject({ spaceId: space.id, blockId: first });
		await until(page, (f) => f.outlinePanels()[0]?.title === "first block");
		expect((await call(page, (f) => f.outlinePanels()))[0]?.params.pageId).toBe(pageId);

		// The view switch and the timeline are navigations of the panel too.
		await page.evaluate(() => {
			const all = [...document.querySelectorAll("[data-testid=outline-surface] label")].find(
				(label) => label.textContent?.trim().startsWith("All"),
			) as HTMLElement | undefined;
			all?.click();
		});
		await until(page, (f) => f.outlinePanels()[0]?.params.view === "all");
		await page.evaluate(() => {
			(
				document.querySelector("[data-testid=outline-surface] [data-seq]") as HTMLElement | null
			)?.click();
		});
		await until(page, (f) => typeof f.outlinePanels()[0]?.params.asOf === "number");
		// A view or time change keeps the page the panel is on (its identity).
		expect((await call(page, (f) => f.outlinePanels()))[0]?.params.pageId).toBe(pageId);
		expect(await call(page, (f) => f.locations())).toEqual(before);

		// Ctrl-click on a breadcrumb opens the page in a new panel (and still no URL change).
		await page.evaluate(() => {
			(
				document.querySelector(
					"[data-testid=outline-surface] [aria-label='Now']",
				) as HTMLElement | null
			)?.click();
			const now = [...document.querySelectorAll("[data-testid=outline-surface] button")].find(
				(b) => b.textContent?.trim() === "Now",
			) as HTMLElement | undefined;
			now?.click();
		});
		await until(page, (f) => f.outlinePanels()[0]?.params.asOf === undefined);
		await page.evaluate(() => {
			const crumb = [...document.querySelectorAll("[data-testid=outline-surface] a")].find(
				(a) => a.textContent?.trim() === "Dock page",
			);
			crumb?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }),
			);
		});
		await until(page, (f) => f.outlinePanels().length === 2);
		expect(await call(page, (f) => f.locations())).toEqual(before);

		// Keys typed in the composer stay there, the outline editor's own keys included.
		const outlineBefore = liveSessionOf(pageId)?.textOf(first);
		const press = async (keys: string) => {
			const parts = keys.split("+");
			const key = parts.pop() as string;
			for (const m of parts) await page.keyboard.down(m as never);
			await page.keyboard.press(key as never);
			for (const m of parts.reverse()) await page.keyboard.up(m as never);
		};
		await page.click("#composer-panel [contenteditable=true]");
		await page.keyboard.type("hello outline");
		for (const keys of ["Enter", "Escape", "Alt+ArrowUp", "Alt+ArrowRight", "Control+b"])
			await press(keys);
		await page.keyboard.type("again");
		await quiet();
		const typed = await call(page, (f) => f.composer());
		expect(typed).toContain("hello outline");
		expect(typed).toContain("again");
		// Undo in the composer undoes the composer, not the outline.
		await press("Control+z");
		await quiet();
		expect(liveSessionOf(pageId)?.textOf(first)).toBe(outlineBefore);
		expect(liveSessionOf(pageId)?.textOf(pageId)).toBe("Dock page");
		expect((await call(page, (f) => f.outlinePanels()))[0]?.params.blockId).toBe(first);
		expect(await call(page, (f) => f.locations())).toEqual(before);

		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 60_000);

test("two panels on one page share one live session; a block of an open page reuses its panel", async () => {
	const { page, errors } = await openDock();
	try {
		await call(
			page,
			(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }),
			space.id,
			pageId,
		);
		await call(
			page,
			(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }, true),
			space.id,
			pageId,
		);
		await until(page, (f) => f.outlinePanels().length === 2);
		// Both on screen (the second one split off into its own group): both editors live.
		const [, b] = await call(page, (f) => f.outlinePanels());
		await call(page, (f, id) => f.splitRight(id), b?.id);
		await until(page, (f) => f.liveEditors() === 2);
		const session = liveSessionOf(pageId);
		expect(session).toBeDefined();
		expect(session?.participants.size).toBe(1);

		// A block of that page (from a link that does not know its page) opens in an existing panel.
		const second = ids[3] as string;
		await call(
			page,
			(f, s, id, p) => f.openOutline({ spaceId: s, blockId: id, pageId: p }),
			space.id,
			second,
			pageId,
		);
		await until(page, (f) => f.outlinePanels().some((x) => x.params.blockId !== x.params.pageId));
		expect(await call(page, (f) => f.outlinePanels().length)).toBe(2);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 60_000);

/** Participants of a page's live session on the server (none when it has no session). */
function participants(id: string): number {
	return liveSessionOf(id)?.participants.size ?? 0;
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
	const end = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out: ${check.toString()}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("a panel is live only on screen; more pages than the socket takes, one after another, all go live", async () => {
	const { page, errors } = await openDock();
	try {
		await call(page, (f) => f.setGrace(300));
		const [p1, p2, p3] = morePages as [string, string, string];

		// A panel restored behind another never joins its page.
		await call(
			page,
			(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }),
			space.id,
			p1,
		);
		await until(page, (f) => f.liveEditors() === 1);
		await waitFor(() => participants(p1) === 1);
		await call(
			page,
			(f, s, p) => f.openInBackground({ spaceId: s, blockId: p, pageId: p }, "bg-panel"),
			space.id,
			p2,
		);
		await new Promise((r) => setTimeout(r, 600));
		expect(participants(p2)).toBe(0);
		expect(participants(p1)).toBe(1);
		expect((await call(page, (f) => f.liveState())).sessions.map((x) => x.pageId)).not.toContain(
			p2,
		);

		// Shown, it joins; the panel it hid leaves after the grace period.
		await call(page, (f) => f.activate("bg-panel"));
		await waitFor(() => participants(p2) === 1);
		await waitFor(() => participants(p1) === 0);
		// Shown again, the first one joins again.
		const [first] = await call(page, (f) => f.outlinePanels());
		await call(page, (f, id) => f.activate(id), first?.id);
		await waitFor(() => participants(p1) === 1);
		await waitFor(() => participants(p2) === 0);

		// Opened one after another faster than the grace period: the hidden ones give their slots
		// to the new ones, and the server never refuses a join.
		await call(page, (f) => f.setGrace(null));
		for (const id of [p3, ...morePages.slice(3)]) {
			await call(
				page,
				(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }),
				space.id,
				id,
			);
			await waitFor(() => participants(id) === 1);
			const state = await call(page, (f) => f.liveState());
			expect(state.sessions.length).toBeLessThanOrEqual(8);
		}
		const live = morePages.reduce((sum, id) => sum + participants(id), 0);
		expect(live).toBeLessThanOrEqual(8);
		const state = await call(page, (f) => f.liveState());
		expect(state.closed.filter((code) => code === "unavailable")).toEqual([]);
		expect(state.tabLimitNotices).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await call(page, (f) => f.setGrace(null)).catch(() => {});
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 90_000);

test("a panel that cannot read its place shows the generic tab name, not one it was given", async () => {
	const { page, errors } = await openDock();
	try {
		// As a stale link or another person's restored layout would name it.
		await call(
			page,
			(f, s) => f.openOutline({ spaceId: s, blockId: "noSuchBlock01", title: "Someone's page" }),
			space.id,
		);
		await until(page, (f) => f.outlinePanels().length === 1);
		await until(page, (f) => f.outlinePanels()[0]?.title === "Outline");
		expect((await call(page, (f) => f.outlinePanels()))[0]?.params.title).toBeUndefined();
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 60_000);
