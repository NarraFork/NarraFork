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
import { narrators, projects, users } from "../../../server/db/schema";
import { askTool } from "../../../server/lib/agent/tools/outline";
import type { ToolContext } from "../../../server/lib/agent/types";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import {
	closeAllLiveSessions,
	liveSessionOf,
	outlineLiveQuiet,
} from "../../../server/services/outline/live/registry";
import { setOutlineAnswerDelivery } from "../../../server/services/outline/questions";
import { ensureProjectSpace } from "../../../server/services/outline/spaces";
import { outlineStore } from "../../../server/services/outline/store";
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
/** A page like the owner's screenshot: a task with notes, a heading and a subagent report. */
let tidy: {
	pageId: string;
	task: string;
	note: string;
	heading: string;
	report: string;
	plain: string;
	/** A chain of blocks, each the next one's parent. */
	deep: string[];
	/** A task of each status. */
	statuses: Record<"todo" | "doing" | "done" | "cancelled", string>;
	/** The commit the page was written in. */
	seq: number;
};
/** A report container's line exactly as the server stores it (`delegation-text.ts`). */
const STORED_REPORT = "报告（第 2 代 · 2025-03-04 17:38 UTC）";
const DEEP_TITLES = [
	"Level one with a rather long title that has to be cut short",
	"Level two is long as well and would not fit either",
	"Level three keeps going for quite a while too",
	"Level four is the parent of the focused block",
	"Level five is what the panel focuses",
];

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
	for (let i = 0; i < 30; i++) {
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: { id: pageId }, content: `Later block ${i}` }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
	}
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
	const tidied = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "tp", parent: null, content: "Tidy page" },
			{
				op: "insert",
				tempId: "task",
				parent: { tempId: "tp" },
				content: "Fix the refresh race",
				task: { status: "doing" },
			},
			{
				op: "insert",
				tempId: "note",
				parent: { tempId: "task" },
				content: "Conclusion: a fake clock reproduces it",
			},
			{ op: "insert", parent: { tempId: "note" }, content: "Evidence: run.ts:784" },
			{ op: "insert", parent: { tempId: "task" }, content: "## Delivery and conclusions" },
			{ op: "insert", tempId: "report", parent: { tempId: "task" }, content: STORED_REPORT },
			{ op: "insert", parent: { tempId: "report" }, content: "Changed 3 files, 41 tests pass" },
			{ op: "insert", tempId: "plain", parent: { tempId: "tp" }, content: "Plain parent" },
			{ op: "insert", parent: { tempId: "plain" }, content: "plain child" },
			...DEEP_TITLES.map((content, i) => ({
				op: "insert" as const,
				tempId: `d${i}`,
				parent: { tempId: i === 0 ? "tp" : `d${i - 1}` },
				content,
			})),
			// One task of each remaining status (the first task above is in progress).
			...(["todo", "done", "cancelled"] as const).map((status) => ({
				op: "insert" as const,
				parent: { tempId: "tp" },
				content: `A ${status} task`,
				task: { status },
			})),
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const at = (i: number) => tidied.results[i]?.blockId as string;
	tidy = {
		pageId: at(0),
		task: at(1),
		note: at(2),
		heading: at(4),
		report: at(5),
		plain: at(7),
		deep: DEEP_TITLES.map((_, i) => at(9 + i)),
		statuses: {
			doing: at(1),
			todo: at(9 + DEEP_TITLES.length),
			done: at(10 + DEEP_TITLES.length),
			cancelled: at(11 + DEEP_TITLES.length),
		},
		seq: tidied.commit?.seq as number,
	};
}, 60_000);

afterAll(async () => {
	await closeAllLiveSessions("ended");
	await browser?.close();
	server?.stop(true);
});

async function openDock(
	options: { width?: number; timezone?: string } = {},
): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: options.width ?? 1240, height: 800 });
	if (options.timezone) await page.emulateTimezone(options.timezone);
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

test("a narrow live panel answers a focused question and the remaining questions under its task", async () => {
	settings.outline.enabled = true;
	const session = generateId();
	await db.insert(narrators).values({
		id: session,
		title: "Question worker",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: space.projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "questions", parent: null, content: "Question page" },
			{
				op: "insert",
				parent: { tempId: "questions" },
				content: "Choose exports",
				task: { status: "todo" },
			},
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const questionPage = written.results[0]?.blockId as string;
	const taskId = written.results[1]?.blockId as string;
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "setTask", block: { id: taskId }, task: { status: "doing" } }],
		actor: { kind: "agent", id: session },
		narratorId: session,
		responsibleUserId: owner,
	});
	const asked = await askTool.execute(
		{
			questions: [
				{ question: "Which format should we export?", options: ["CSV", "JSON"], recommend: 2 },
				{ question: "Which encoding should we use?", options: ["UTF-8", "ASCII"], recommend: 1 },
			],
		},
		{
			narratorId: session,
			cwd: "/",
			signal: new AbortController().signal,
			locale: "en",
			userId: owner,
			requestPermission: async () => ({ behavior: "allow" }),
		} as ToolContext,
	);
	if (asked.isError) throw new Error(JSON.stringify(asked));
	const [first, second] = asked.metadata?.blockIds as [string, string];
	const previousDelivery = setOutlineAnswerDelivery({
		async deliver() {
			return { written: true, woke: false };
		},
	});
	const { page, errors } = await openDock();
	try {
		await page.setViewport({ width: 900, height: 800 });
		for (const [focusId, questionId] of [
			[first, first],
			[taskId, second],
		]) {
			await call(
				page,
				(f, s, b, p) => f.openOutline({ spaceId: s, blockId: b, pageId: p }),
				space.id,
				focusId,
				questionPage,
			);
			await until(page, (f) => f.liveEditors() === 1);
			const card = `[data-testid="outline-question-${questionId}"][data-state="open"]`;
			try {
				await page.waitForSelector(`${card} input[type=radio]`, { visible: true, timeout: 10_000 });
			} catch (error) {
				throw new Error(
					`${String(error)}; focus=${focusId}; ${await page.evaluate(() => document.body.innerText.slice(0, 4000))}`,
				);
			}
			const placement = await page.evaluate(() => {
				const form = document.querySelector('[data-testid="outline-questions-section"]');
				return {
					count: document.querySelectorAll('[data-testid="outline-questions-section"]').length,
					main: !!form?.parentElement?.querySelector('[data-testid="outline-editor"]'),
					compact: form?.closest('[data-testid="outline-surface"]')?.getAttribute("data-compact"),
					text: form?.textContent,
				};
			});
			expect(placement.count).toBe(1);
			expect(placement.main).toBe(true);
			expect(placement.compact).toBe("true");
			if (focusId === first) expect(placement.text).not.toContain("Which format should we export?");
			else expect(placement.text).toContain("Which encoding should we use?");
			await page.click(`${card} input[type=radio][value="1"]`);
			const response = page.waitForResponse(
				(r) => r.url().endsWith("/api/outline/questions/answer") && r.request().method() === "POST",
			);
			await page.click('[data-testid="outline-questions-submit"]');
			expect((await response).status()).toBe(200);
			// When the last question is answered the parent's one-block read may remove the form.
			await page.waitForFunction((selector) => !document.querySelector(selector), {}, card);
		}
		expect((await outlineStore.getQuestions([first, second])).map((q) => q.state)).toEqual([
			"answered",
			"answered",
		]);
		expect(errors).toEqual([]);
	} finally {
		setOutlineAnswerDelivery(previousDelivery);
		await page.browserContext().close();
	}
}, 60_000);

test("opening an outline timeline never scrolls the enclosing dock while geometry settles", async () => {
	const { page, errors } = await openDock();
	try {
		const heights = () =>
			page.evaluate(() => {
				const host = document.getElementById("dock-host");
				const surface = host?.querySelector("[data-dockview-surface]");
				const composer = document.getElementById("composer-panel");
				if (!host || !surface || !composer) throw new Error("Dock fixture not mounted");
				return {
					host: host.getBoundingClientRect().height,
					top: host.getBoundingClientRect().top,
					scroll: [
						...document.querySelectorAll(
							"html, body, #root, .nf-app-shell, .nf-app-shell-main, [data-dockview-surface], .dv-react, .dv-shell",
						),
					].map((el) => ({ class: el.className, scrollTop: el.scrollTop })),
					surface: surface.getBoundingClientRect().height,
					composer: composer.getBoundingClientRect().height,
				};
			});
		await page.setViewport({ width: 900, height: 800 });
		// During a dock resize/restore its last measured height can exceed the shell's new height.
		await page.evaluate(() => {
			const host = document.getElementById("dock-host");
			const main = document.querySelector<HTMLElement>(".nf-app-shell-main");
			if (!host || !main) throw new Error("Dock host not mounted");
			host.style.height = "740px";
			main.style.height = "400px";
		});
		const before = await heights();
		await call(
			page,
			(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }),
			space.id,
			pageId,
		);
		await until(page, (f) => f.liveEditors() === 1);
		await page.waitForSelector("[data-testid=outline-surface] [data-seq]");
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		expect(await heights()).toEqual(before);
		expect(before.surface).toBe(before.host);
		const tickVisible = () =>
			page.evaluate(() => {
				const tick = document.querySelector("[data-testid=outline-surface] [aria-current=true]");
				const strip = tick?.closest(".mantine-ScrollArea-viewport");
				if (!tick || !strip) return false;
				const target = tick.getBoundingClientRect();
				const bounds = strip.getBoundingClientRect();
				return target.left >= bounds.left - 1 && target.right <= bounds.right + 1;
			});
		expect(await tickVisible()).toBe(true);
		// Returning to an older commit must scroll left without moving any ancestor either.
		await call(
			page,
			(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p, asOf: 1 }),
			space.id,
			pageId,
		);
		await page.waitForSelector("[data-seq='1'][aria-current=true]");
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		expect(await tickVisible()).toBe(true);
		expect(await heights()).toEqual(before);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
});

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

/** Where a text is shown as the whole text of an element on screen (innermost elements only). */
function shownAs(page: Page, text: string): Promise<string[]> {
	return page.evaluate((wanted) => {
		const where: string[] = [];
		for (const el of document.querySelectorAll<HTMLElement>("body *")) {
			if (el.textContent?.trim() !== wanted) continue;
			if ([...el.children].some((child) => child.textContent?.trim() === wanted)) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			// On screen, not clipped away: the live editor keeps the whole page in its document and
			// shows the focused block's part of it.
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			if (!hit || !(el.contains(hit) || hit.contains(el))) continue;
			where.push(
				el.closest(".dv-tab, .dv-default-tab")
					? "tab"
					: el.closest("[data-testid=outline-crumbs]")
						? "breadcrumbs"
						: el.closest("[data-testid=outline-surface]")
							? "page"
							: "panel header",
			);
		}
		return where.sort();
	}, text);
}

/** `shownAs`, once it reads `expected` (a focus change animates: the old root leaves in a frame or two). */
async function expectShownAs(page: Page, text: string, expected: string[]): Promise<void> {
	const end = Date.now() + 5000;
	let got = await shownAs(page, text);
	while (Date.now() < end && JSON.stringify(got) !== JSON.stringify(expected)) {
		await page.evaluate(
			() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
		got = await shownAs(page, text);
	}
	expect({ text, where: got }).toEqual({ text, where: expected });
}

test("a page's title is shown twice at most in the dock: the tab and the page's own title", async () => {
	const { page, errors } = await openDock();
	try {
		await call(
			page,
			(f, s, p) => f.openOutline({ spaceId: s, blockId: p, pageId: p }),
			space.id,
			tidy.pageId,
		);
		await until(page, (f) => f.liveEditors() === 1);
		await until(page, (f) => f.outlinePanels()[0]?.title === "Tidy page");
		await page.waitForSelector("[data-testid=outline-crumbs]");
		// Live editor: the tab and the editor's title. Not the panel's header, not the breadcrumbs.
		await expectShownAs(page, "Tidy page", ["page", "tab"]);
		// The header says what the panel is; the breadcrumbs say where the page is.
		expect(await shownAs(page, "Outline")).toEqual(
			expect.arrayContaining(["breadcrumbs", "panel header"]),
		);

		// A block focused inside the page: its title, not the page's, twice; the page's title is
		// now an ancestor, once, in the breadcrumbs.
		await call(
			page,
			(f, s, b, p) => f.openOutline({ spaceId: s, blockId: b, pageId: p }),
			space.id,
			tidy.task,
			tidy.pageId,
		);
		await until(page, (f) => f.outlinePanels()[0]?.title === "Fix the refresh race");
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll("[data-testid=outline-crumbs] a")].some(
					(a) => a.textContent?.trim() === "Tidy page",
				),
			{ timeout: 10_000 },
		);
		await expectShownAs(page, "Fix the refresh race", ["page", "tab"]);
		await expectShownAs(page, "Tidy page", ["breadcrumbs"]);

		// A report container focused: the tab and the page read it as people do, but what is
		// remembered ("recent", later shown days on) is the stored text, decoded when shown.
		await call(
			page,
			(f, s, b, p) => f.openOutline({ spaceId: s, blockId: b, pageId: p }),
			space.id,
			tidy.report,
			tidy.pageId,
		);
		await until(page, (f) => (f.outlinePanels()[0]?.title ?? "").startsWith("Subagent report · "));
		expect((await call(page, (f) => f.outlinePanels()))[0]?.title).not.toMatch(/UTC|generation|代/);
		await until(page, (f) => f.recents().length > 0);
		const remembered = await call(page, (f) => f.recents());
		expect(remembered.find((r) => r.blockId === tidy.report)).toEqual({
			blockId: tidy.report,
			title: STORED_REPORT,
		});
		expect(remembered.map((r) => r.title).join("\n")).not.toContain("Subagent report");

		// Read only (as of a commit): the same count with the tree's own title.
		await call(
			page,
			(f, s, p, q) => f.openOutline({ spaceId: s, blockId: p, pageId: p, asOf: q, view: "all" }),
			space.id,
			tidy.pageId,
			tidy.seq,
		);
		await page.waitForSelector(`[data-block-id="${tidy.task}"]`, { timeout: 10_000 });
		await until(page, (f) => f.outlinePanels()[0]?.title === "Tidy page");
		await expectShownAs(page, "Tidy page", ["page", "tab"]);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 60_000);

test("the read-only tree: one marker per row, body-size headings, the report line in the reader's words, statuses as badges", async () => {
	const { page, errors } = await openDock({ timezone: "Asia/Tokyo" });
	try {
		await call(
			page,
			(f, s, p, q) => f.openOutline({ spaceId: s, blockId: p, pageId: p, asOf: q, view: "all" }),
			space.id,
			tidy.pageId,
			tidy.seq,
		);
		await page.waitForSelector(`[data-block-id="${tidy.task}"]`, { timeout: 10_000 });
		const row = (id: string) =>
			page.evaluate((x) => {
				const el = document.querySelector<HTMLElement>(`[data-block-id="${x}"]`);
				if (!el) return null;
				const on = (sel: string) => {
					const part = el.querySelector<HTMLElement>(sel);
					return !!part && part.getBoundingClientRect().width > 0;
				};
				const body = el.querySelector<HTMLElement>(":scope > div .nf-type-scope");
				return {
					marker: el.dataset.marker,
					arrow: on(":scope > span button[aria-expanded] svg"),
					bullet: on(":scope > a > span[data-collapsed]"),
					icon: on(":scope > [role=img] svg"),
					handle: on(':scope > a[aria-label="Focus on this block"] svg'),
					textLeft: body ? Math.round(body.getBoundingClientRect().left) : null,
				};
			}, id);
		// A task: arrow + checkbox, no bullet, and a focus handle for what the bullet did.
		expect(await row(tidy.task)).toMatchObject({
			marker: "task",
			arrow: true,
			bullet: false,
			icon: true,
			handle: true,
		});
		// A plain row: arrow + bullet (the bullet focuses), nothing else.
		expect(await row(tidy.plain)).toMatchObject({
			marker: "bullet",
			arrow: true,
			bullet: true,
			icon: false,
			handle: false,
		});
		// The checkbox stands where the bullet would: both rows' text starts in one column.
		expect((await row(tidy.task))?.textLeft).toBe((await row(tidy.plain))?.textLeft as number);

		// A heading inside a block: the body's size and line box, bold; the title is larger.
		const type = (selector: string) =>
			page.evaluate((sel) => {
				const el = document.querySelector<HTMLElement>(sel);
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { size: cs.fontSize, line: cs.lineHeight, weight: cs.fontWeight };
			}, selector);
		const body = await type(`[data-block-id="${tidy.note}"] .nf-type-scope`);
		const heading = await type(`[data-block-id="${tidy.heading}"] h2`);
		expect(heading).toEqual({
			size: body?.size as string,
			line: body?.line as string,
			weight: "700",
		});
		expect(await type(`[data-block-id="${tidy.task}"] .nf-type-scope`)).toMatchObject({
			size: body?.size,
		});
		const title = await type("[data-testid=outline-surface] h3");
		expect(Number.parseFloat(title?.size ?? "0")).toBeGreaterThan(
			Number.parseFloat(body?.size ?? "0"),
		);

		// The report container: the reader's language and time zone, no generation, no UTC.
		const reportLine = () =>
			page.evaluate(
				(x) =>
					document.querySelector(`[data-block-id="${x}"] [data-testid=outline-report-line]`)
						?.textContent ?? null,
				tidy.report,
			);
		expect(await reportLine()).toBe("Subagent report · Mar 5, 2025, 02:38");
		await call(page, (f) => f.setLanguage("zh-CN"));
		await page.waitForFunction(
			(x) =>
				document
					.querySelector(`[data-block-id="${x}"] [data-testid=outline-report-line]`)
					?.textContent?.startsWith("子代理报告"),
			{ timeout: 10_000 },
			tidy.report,
		);
		expect(await reportLine()).toBe("子代理报告 · 2025年3月5日 02:38");
		expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/第 2 代|17:38 UTC/);
		await call(page, (f) => f.setLanguage("en"));

		// A task's status is a badge: the state's icon on a tinted background, named for
		// assistive technology in the reader's language, in both schemes.
		const badges = () =>
			page.evaluate((byStatus) => {
				const out: Record<string, unknown> = {};
				for (const [status, id] of Object.entries(byStatus)) {
					const mark = document.querySelector<HTMLElement>(`[data-block-id="${id}"] > [role=img]`);
					const svg = mark?.querySelector<SVGSVGElement>("svg");
					const cs = svg ? getComputedStyle(svg) : null;
					const box = svg?.getBoundingClientRect();
					const rgba = /rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/.exec(cs?.backgroundColor ?? "");
					const parts = (rgba?.[1] ?? rgba?.[2] ?? "").split(/[\s,/]+/).filter(Boolean);
					out[status] = {
						label: mark?.getAttribute("aria-label") ?? null,
						status: svg?.dataset.status ?? null,
						badge: svg?.classList.contains("nf-status") ?? false,
						shapes: svg?.childElementCount ?? 0,
						text: mark?.textContent ?? null,
						tinted: parts.length >= 4 && Number(parts[3]) > 0.05 && Number(parts[3]) < 0.5,
						color: cs?.color ?? null,
						radius: cs?.borderTopLeftRadius ?? null,
						size: box ? [Math.round(box.width), Math.round(box.height)] : null,
					};
				}
				return out as Record<
					string,
					{ label: string; status: string; color: string; [key: string]: unknown }
				>;
			}, tidy.statuses);
		const LABELS = {
			en: { todo: "To do", doing: "In progress", done: "Done", cancelled: "Cancelled" },
			"zh-CN": { todo: "待办", doing: "进行中", done: "完成", cancelled: "已取消" },
		} as const;
		const colours: Record<string, string> = {};
		for (const scheme of ["light", "dark"] as const) {
			await page.evaluate(
				(s) => document.documentElement.setAttribute("data-mantine-color-scheme", s),
				scheme,
			);
			for (const language of ["en", "zh-CN"] as const) {
				await call(page, (f, l) => f.setLanguage(l as never), language);
				await page.waitForFunction(
					(id, label) =>
						document
							.querySelector(`[data-block-id="${id}"] > [role=img]`)
							?.getAttribute("aria-label") === label,
					{ timeout: 10_000 },
					tidy.statuses.done,
					LABELS[language].done,
				);
				const got = await badges();
				for (const status of ["todo", "doing", "done", "cancelled"] as const) {
					expect(got[status], `${scheme} ${language} ${status}`).toMatchObject({
						label: LABELS[language][status],
						status,
						badge: true,
						text: "",
						tinted: true,
						radius: "4px",
						size: [16, 16],
					});
					expect(got[status]?.shapes, `${scheme} ${status}`).toBeGreaterThan(0);
				}
				expect(new Set(["todo", "doing", "done"].map((s) => got[s]?.color)).size).toBe(3);
				colours[scheme] = got.doing?.color as string;
			}
			// The focus handle is the only pointer route to focusing a task: plainly visible.
			expect(
				await call(
					page,
					(f, id: string) => f.contrastOnPage(`[data-block-id="${id}"] > a:last-child`),
					tidy.task,
				),
				`${scheme} focus handle`,
			).toBeGreaterThanOrEqual(3);
		}
		expect(colours.light).not.toBe(colours.dark);
		await page.evaluate(() =>
			document.documentElement.setAttribute("data-mantine-color-scheme", "light"),
		);
		await call(page, (f) => f.setLanguage("en"));
		await page.waitForFunction(
			(id) =>
				document
					.querySelector(`[data-block-id="${id}"] > [role=img]`)
					?.getAttribute("aria-label") === "Done",
			{ timeout: 10_000 },
			tidy.statuses.done,
		);

		// With larger text the badge grows; the bullet's column grows with it, so a task's text
		// and a plain row's still start in one column.
		await call(page, (f) => f.applyTypography({ fontScalePercent: 150 }));
		await page.waitForFunction(
			(id) =>
				(document.querySelector(`[data-block-id="${id}"] > [role=img] svg`)?.getBoundingClientRect()
					.width ?? 0) > 18,
			{ timeout: 10_000 },
			tidy.task,
		);
		expect((await row(tidy.task))?.textLeft).toBe((await row(tidy.plain))?.textLeft as number);
		await call(page, (f) => f.applyTypography({ fontScalePercent: 100 }));
		await page.waitForFunction(
			(id) =>
				document.querySelector(`[data-block-id="${id}"] > [role=img] svg`)?.getBoundingClientRect()
					.width === 16,
			{ timeout: 10_000 },
			tidy.task,
		);

		// What the bullet did, on a task: the handle focuses it (a real click).
		const handle = await page.$(
			`[data-block-id="${tidy.task}"] > a[aria-label="Focus on this block"]`,
		);
		await handle?.click();
		await until(page, (f) => f.outlinePanels()[0]?.title === "Fix the refresh race");
		expect((await call(page, (f) => f.outlinePanels()))[0]?.params).toMatchObject({
			blockId: tidy.task,
			pageId: tidy.pageId,
			asOf: tidy.seq,
		});
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 60_000);

test("the breadcrumbs stay on one line in a narrow panel: ancestors only, the middle folded", async () => {
	// A narrow window: the outline panel beside the composer is a few hundred pixels wide.
	const { page, errors } = await openDock({ width: 720 });
	try {
		const focused = tidy.deep.at(-1) as string;
		await call(
			page,
			(f, s, b, p) => f.openOutline({ spaceId: s, blockId: b, pageId: p }),
			space.id,
			focused,
			tidy.pageId,
		);
		await until(
			page,
			(f) => f.outlinePanels()[0]?.title === "Level five is what the panel focuses",
		);
		await page.waitForSelector("[data-testid=outline-crumbs-more]", { timeout: 10_000 });
		const bar = () =>
			page.evaluate(() => {
				const nav = document.querySelector<HTMLElement>("[data-testid=outline-crumbs]");
				const surface = document.querySelector<HTMLElement>("[data-testid=outline-surface]");
				if (!nav || !surface) return null;
				const items = [...nav.children] as HTMLElement[];
				const tops = new Set(items.map((el) => Math.round(el.getBoundingClientRect().top / 4)));
				const first = items[0]?.getBoundingClientRect();
				return {
					// The crumbs (the bar's last control, "show in the outline tree", is not one).
					links: [...nav.querySelectorAll("a:not([data-testid=outline-locate])")].map(
						(a) => a.textContent?.trim() ?? "",
					),
					locate: nav.querySelector("a[data-testid=outline-locate]") === nav.lastElementChild,
					// One line: every crumb and separator starts on the same row…
					rows: tops.size,
					// …and the bar is no taller than a line and a half of its first crumb.
					oneLine: !!first && nav.getBoundingClientRect().height < first.height * 1.5,
					// Nothing reaches past the panel.
					inside: items.every(
						(el) => el.getBoundingClientRect().right <= surface.getBoundingClientRect().right + 0.5,
					),
					panelWidth: Math.round(surface.getBoundingClientRect().width),
					surfaceScrolls: surface.scrollWidth > surface.clientWidth + 1,
					// The long crumbs were cut, not wrapped.
					cut: [...nav.querySelectorAll("a")].filter((a) => a.scrollWidth > a.clientWidth).length,
				};
			});
		const shown = await bar();
		expect(shown?.panelWidth).toBeLessThan(480);
		// Outline › space › page › [Level one] … [Level four]: the focused block is not among them.
		expect(shown?.links.slice(0, 1)).toEqual(["Outline"]);
		expect(shown?.links.slice(2)).toEqual(["Tidy page", DEEP_TITLES[3] as string]);
		expect(shown?.links).not.toContain(DEEP_TITLES[4] as string);
		expect(shown).toMatchObject({
			rows: 1,
			oneLine: true,
			inside: true,
			surfaceScrolls: false,
			locate: true,
		});
		expect(shown?.cut).toBeGreaterThan(0);

		// The fold lists what it stands for, outermost first, and each entry focuses its block.
		await page.click("[data-testid=outline-crumbs-more]");
		await page.waitForSelector("[role=menu] [role=menuitem]", { timeout: 10_000 });
		const folded = await page.evaluate(() =>
			[...document.querySelectorAll("[role=menu] [role=menuitem]")].map(
				(el) => el.textContent?.trim() ?? "",
			),
		);
		expect(folded).toEqual(DEEP_TITLES.slice(0, 3));
		await page.evaluate(() => {
			(
				document.querySelectorAll("[role=menu] [role=menuitem]")[1] as HTMLElement | undefined
			)?.click();
		});
		await until(
			page,
			(f) => f.outlinePanels()[0]?.title === "Level two is long as well and would not fit either",
		);
		expect((await call(page, (f) => f.outlinePanels()))[0]?.params.blockId).toBe(tidy.deep[1]);
		// One level up there is less to fold: page and parent, no "…".
		expect((await bar())?.links.slice(2)).toEqual(["Tidy page", DEEP_TITLES[0] as string]);
		expect(await page.$("[data-testid=outline-crumbs-more]")).toBeNull();
		expect((await bar())?.rows).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
		await closeAllLiveSessions("ended");
	}
}, 60_000);
