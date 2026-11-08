/**
 * Locks and pending confirmation in the page's UI (P2 PR 6), in Chromium, against a test server
 * running the real outline routes and live sessions (the isolated SQLite of `tests/preload.ts`):
 *
 *   - the side panel of a focused task locks its plan (naming a session to confirm on the
 *     person's behalf) and unlocks it; the live editor shows the lock's badge on the task;
 *   - an agent's change to the locked plan is held: the page learns of it over its narrator
 *     socket subscription (`outline_page_pending`, then a re-read; nothing is refreshed by hand),
 *     the touched block shows "Waiting for confirmation" in the editor, the side panel grows a
 *     "To confirm" tab with the change's diff, and confirming it there writes it (the editor
 *     shows the confirmed text) and the tab goes;
 *   - a change rewriting a step and adding one marks the step and the new step's parent;
 *     rejecting it there, with a reason, writes nothing and the marks go;
 *   - the facts view's "in progress" marker lists the open tasks under a fact and focuses one;
 *     a fact with only done tasks under it shows how many blocks are left out instead.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { narrators, projects, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import { closeAllLiveSessions } from "../../../server/services/outline/live/registry";
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
import {
	handleOutlinePageMessage,
	type OutlinePageSocket,
	releaseOutlinePageSubscriptions,
} from "../../../server/websocket/outline-page-ws";
import type * as Fixture from "./outline-pending.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-11-02T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let owner: string;
let projectId: string;
let space: OutlineSpaceRow;
let agent: string;
let lead: string;
/** Pages a narrator socket subscribed to (the server answered the subscription). */
const subscribedPages = new Set<string>();

/** Wait until the page's subscription is in place, so a change hint reaches it. */
async function subscribed(pageId: string): Promise<void> {
	const until = Date.now() + 10_000;
	while (!subscribedPages.has(pageId)) {
		if (Date.now() > until) throw new Error(`page ${pageId} never subscribed`);
		await Bun.sleep(20);
	}
}

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
	// The sessions the lock's delegate picker offers (the project's).
	app.get("/api/narrators", (c) =>
		c.json({
			items: [{ id: lead, title: "Lead session", type: "primary" }],
			hasMore: false,
			nextCursor: null,
			totalCount: 1,
		}),
	);
	app.route("/api/outline", outlineRoutes);
	return app;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-pending.browser-fixture.tsx", import.meta.url).pathname],
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
	server = Bun.serve<{
		userId: string;
		username: string;
		userRole: string;
		kind: "live" | "narrator";
	}>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/live" || url.pathname === "/ws/narrator") {
				// The live editor's socket names its person; the narrator socket (the page's change
				// hints) carries the token, which this server takes as the user id.
				const kind = url.pathname === "/live" ? "live" : "narrator";
				const userId = url.searchParams.get(kind === "live" ? "user" : "token") ?? "";
				if (srv.upgrade(request, { data: { userId, username: "alice", userRole: "user", kind } }))
					return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname.startsWith("/api/")) {
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
				if (ws.data.kind === "narrator") {
					// Only the outline page subscription is served on the narrator socket here.
					if (typeof message !== "string") return;
					const frame = JSON.parse(message) as { type?: string; pageId?: string };
					if (frame.type === "outline_page_subscribe" || frame.type === "outline_page_unsubscribe")
						void handleOutlinePageMessage(
							ws as unknown as OutlinePageSocket,
							frame as Parameters<typeof handleOutlinePageMessage>[1],
						).then(() => {
							if (frame.type === "outline_page_subscribe" && frame.pageId)
								subscribedPages.add(frame.pageId);
						});
					return;
				}
				if (typeof message === "string") return;
				const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
				handleOutlineLiveBinary(ws as unknown as OutlineLiveWS, bytes);
			},
			drain(ws) {
				if (ws.data.kind === "live") drainOutlineLive(ws as unknown as OutlineLiveWS);
			},
			close(ws) {
				if (ws.data.kind === "narrator")
					releaseOutlinePageSubscriptions(ws as unknown as OutlinePageSocket);
				else releaseOutlineLive(ws as unknown as OutlineLiveWS);
			},
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
	owner = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: "alice", passwordHash: "x", role: "user", createdAt: NOW });
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Locks",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	agent = generateId();
	lead = generateId();
	for (const [id, title] of [
		[agent, "Worker"],
		[lead, "Lead session"],
	] as const) {
		await db.insert(narrators).values({
			id,
			title,
			ownerUserId: owner,
			visibility: "private",
			contextProjectId: projectId,
			createdAt: NOW,
			updatedAt: NOW,
		});
	}
	space = await ensureProjectSpace(projectId);
}, 60_000);

afterAll(async () => {
	await closeAllLiveSessions("ended");
	await browser?.close();
	server?.stop(true);
});

async function openPage(
	blockId: string,
	view?: "facts" | "all",
): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: 1240, height: 800 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), owner);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	const wsUrl = `${server.url.origin.replace("http", "ws")}/live?user=${encodeURIComponent(owner)}`;
	await page.evaluate((options) => (window as unknown as FixtureWindow).fixture.open(options), {
		wsUrl,
		spaceId: space.id,
		blockId,
		...(view ? { view } : {}),
	});
	await page.waitForSelector("[data-testid=outline-editor] .ProseMirror[contenteditable=true]", {
		timeout: 15_000,
	});
	await until(page, "the narrator socket", (f) => f.socketConnected());
	return { page, errors };
}

function call<T>(page: Page, fn: (f: typeof Fixture, ...args: never[]) => T, ...args: unknown[]) {
	return page.evaluate(
		`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`,
	) as Promise<T>;
}

async function until(
	page: Page,
	what: string,
	fn: (f: typeof Fixture, ...args: never[]) => boolean,
	timeout = 10_000,
	...args: unknown[]
) {
	try {
		await page.waitForFunction(`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`, {
			timeout,
			polling: 50,
		});
	} catch (error) {
		const text = await page
			.evaluate(() => document.body.innerText.slice(0, 2000))
			.catch(() => "page gone");
		throw new Error(`until ${what}: ${text}: ${String(error)}`);
	}
}

/** A plan in its own page: the task to lock, two steps and a plain note. */
async function plan(title: string) {
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "r", parent: null, content: title, task: { status: "todo" } },
			{
				op: "insert",
				parent: { tempId: "r" },
				content: "Parse the header",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "r" }, content: "Load the rows", task: { status: "todo" } },
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const [root, one, two] = written.results.map((r) => r.blockId) as [string, string, string];
	return { root, one, two };
}

test("the side panel locks a focused task's plan with a delegate and unlocks it; the editor shows the lock", async () => {
	const p = await plan("Ship the importer");
	const { page, errors } = await openPage(p.root, "all");
	try {
		await until(page, "the lock section", (f) => f.count("[data-testid=outline-lock]") === 1);
		// Pick the session confirming on the person's behalf, then lock.
		await page.click(
			"[data-testid=outline-lock-delegate] input, input[data-testid=outline-lock-delegate]",
		);
		await page.waitForSelector("[role=option]", { timeout: 5000 });
		await page.evaluate(() => {
			const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) =>
				o.textContent?.includes("Lead session"),
			);
			option?.click();
		});
		await call(page, (f) => f.click("[data-testid=outline-lock]"));
		await until(page, "locked", (f) => f.count("[data-testid=outline-unlock]") === 1);
		const lock = (await outlineStore.getBlock(p.root))?.taskJson?.lock;
		expect(lock).toMatchObject({ by: { kind: "human", id: owner }, delegate: lead });
		expect(await call(page, (f) => f.textOf("outline-lock-section"))).toContain("Locked by alice");
		expect(await call(page, (f) => f.textOf("outline-lock-section"))).toContain(
			"the session Lead session may confirm",
		);
		// The live editor shows the lock on the task.
		await until(page, "the editor's lock badge", (f) =>
			(f.textOf("outline-lock-badge") ?? "").includes("Locked · alice"),
		);

		await call(page, (f) => f.click("[data-testid=outline-unlock]"));
		await until(page, "unlocked", (f) => f.count("[data-testid=outline-lock]") === 1);
		expect((await outlineStore.getBlock(p.root))?.taskJson?.lock).toBeUndefined();
		await until(page, "the badge gone", (f) => f.count("[data-testid=outline-lock-badge]") === 0);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("an agent's change to the locked plan waits: marked in the editor, confirmed from the side panel's To confirm tab", async () => {
	const p = await plan("Ship the exporter");
	const { page, errors } = await openPage(p.root, "all");
	try {
		await until(page, "the lock section", (f) => f.count("[data-testid=outline-lock]") === 1);
		await call(page, (f) => f.click("[data-testid=outline-lock]"));
		await until(page, "locked", (f) => f.count("[data-testid=outline-unlock]") === 1);
		expect(await call(page, (f) => f.count("[data-testid=outline-pending-tab]"))).toBe(0);
		await subscribed(p.root);

		// An agent rewrites a step of the locked plan: held for confirmation.
		const held = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: p.one }, content: "Parse the header and the footer" }],
			actor: { kind: "agent", id: agent },
			narratorId: agent,
			responsibleUserId: owner,
		});
		expect(held.pending).toBeDefined();
		// No refresh by hand: the page hears of it over its subscription and reads again.
		await until(
			page,
			"the step marked",
			(f) => f.count("[data-testid=outline-pending-badge]") >= 1,
		);
		await until(
			page,
			"the To confirm tab",
			(f) => f.count("[data-testid=outline-pending-tab]") === 1,
		);
		expect(await call(page, (f, id: string) => f.blockText(id), p.one)).toBe("Parse the header");

		await call(page, (f) => f.click("[data-testid=outline-pending-tab]"));
		await until(
			page,
			"the change's diff",
			(f) => f.count("[data-testid=outline-pending-entry]") === 1,
		);
		const diff = (await call(page, (f) => f.textOf("outline-pending-list"))) ?? "";
		expect(diff).toContain(`P${held.pending?.id}`);
		expect(diff).toContain("Before: Parse the header");
		expect(diff).toContain("Proposed: Parse the header and the footer");
		expect(diff).toContain("Proposed by the session Worker");
		// The agent said nothing about it: the list says how big it is.
		expect(diff).toContain("1 change");

		await call(page, (f) => f.click("[data-testid=outline-pending-confirm]"));
		await until(page, "the tab gone", (f) => f.count("[data-testid=outline-pending-tab]") === 0);
		expect((await outlineStore.getPending([held.pending?.id as string]))[0]?.status).toBe(
			"confirmed",
		);
		// The confirmed text reaches the live page.
		await until(page, "the confirmed text", (f) =>
			(f.textOf("outline-editor") ?? "").includes("Parse the header and the footer"),
		);
		await until(page, "the mark gone", (f) => f.count("[data-testid=outline-pending-badge]") === 0);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("rejecting an agent's change from the To confirm tab, with a reason, writes nothing and the marks go", async () => {
	const p = await plan("Ship the validator");
	const { page, errors } = await openPage(p.root, "all");
	try {
		await until(page, "the lock section", (f) => f.count("[data-testid=outline-lock]") === 1);
		await call(page, (f) => f.click("[data-testid=outline-lock]"));
		await until(page, "locked", (f) => f.count("[data-testid=outline-unlock]") === 1);
		await subscribed(p.root);

		// A rewrite of a step, and a new step: the step and the new step's parent are marked.
		const held = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "update", block: { id: p.two }, content: "Load the rows twice" },
				{ op: "insert", parent: { id: p.root }, content: "Validate", task: { status: "todo" } },
			],
			actor: { kind: "agent", id: agent },
			narratorId: agent,
			responsibleUserId: owner,
		});
		expect(held.pending?.opIndexes).toEqual([0, 1]);
		await until(
			page,
			"the To confirm tab",
			(f) => f.count("[data-testid=outline-pending-tab]") === 1,
		);
		await until(
			page,
			"the step and the plan marked",
			(f, ids: string[]) =>
				ids.every(
					(id) =>
						f.count(
							`.ob-block[data-id="${id}"] > .ob-marks [data-testid=outline-pending-badge]`,
						) === 1,
				),
			10_000,
			[p.two, p.root],
		);
		await call(page, (f) => f.click("[data-testid=outline-pending-tab]"));
		await until(
			page,
			"the change's diff",
			(f) => f.count("[data-testid=outline-pending-entry]") === 2,
		);
		await call(page, (f) =>
			f.type(
				"textarea[data-testid=outline-pending-reason], [data-testid=outline-pending-reason] textarea",
				"Keep it to one pass",
			),
		);
		await call(page, (f) => f.click("[data-testid=outline-pending-reject]"));
		await until(page, "the tab gone", (f) => f.count("[data-testid=outline-pending-tab]") === 0);
		const row = (await outlineStore.getPending([held.pending?.id as string]))[0];
		expect(row?.status).toBe("rejected");
		expect(row?.reason).toBe("Keep it to one pass");
		await until(page, "the mark gone", (f) => f.count("[data-testid=outline-pending-badge]") === 0);
		// Nothing was written: the step reads as before, in the editor and in the store.
		expect(await call(page, (f, id: string) => f.blockText(id), p.two)).toBe("Load the rows");
		expect((await outlineStore.getBlock(p.two))?.content).toBe("Load the rows");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("the facts view's in-progress marker lists the open tasks under a fact and focuses one", async () => {
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Importer facts" },
			{ op: "insert", tempId: "f", parent: { tempId: "p" }, content: "Exports are CSV" },
			{
				op: "insert",
				parent: { tempId: "f" },
				content: "Check quoting",
				task: { status: "doing" },
			},
			{ op: "insert", parent: { tempId: "f" }, content: "Old files", task: { status: "done" } },
			{ op: "insert", parent: { tempId: "f" }, content: "Encoding", task: { status: "todo" } },
			{ op: "insert", tempId: "g", parent: { tempId: "p" }, content: "Imports are JSON" },
			{
				op: "insert",
				parent: { tempId: "g" },
				content: "Old importer",
				task: { status: "done" },
			},
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const [pageId, fact, quoting] = written.results.map((r) => r.blockId) as string[];
	const { page, errors } = await openPage(pageId as string);
	try {
		await until(page, "the marker", (f) =>
			(f.textOf("outline-editor") ?? "").includes("In progress · 2"),
		);
		// Only a done task under the other fact: no marker to open, how many blocks are left out.
		expect(await call(page, (f) => f.textOf("outline-editor"))).toContain("+1 under a task");
		await call(
			page,
			(f, id: string) => f.click(`.ob-block[data-id="${id}"] > .ob-hidden`, "mousedown"),
			fact,
		);
		await until(
			page,
			"the list",
			(f) => f.count("[data-testid=outline-in-progress-list] .ob-task-item") === 2,
		);
		const listed = await call(page, (f) => f.textOf("outline-in-progress-list"));
		expect(listed).toContain("Check quoting");
		expect(listed).toContain("Encoding");
		expect(listed).not.toContain("Old files");
		// Each task: its checkbox icon, labelled with its status, then its title (no glyph in it).
		expect(
			await page.evaluate(() =>
				[...document.querySelectorAll("[data-testid=outline-in-progress-list] .ob-task-item")].map(
					(item) => [
						item.querySelector(".ob-task-icon")?.getAttribute("aria-label"),
						item.querySelector(".ob-task-icon svg")?.getAttribute("class"),
						item.querySelector(".ob-task-title")?.textContent,
					],
				),
			),
		).toEqual([
			["In progress", "tabler-icon tabler-icon-square-half", "Check quoting"],
			["To do", "tabler-icon tabler-icon-square", "Encoding"],
		]);
		await call(
			page,
			(f, id: string) => f.click(`.ob-task-item[data-task-id="${id}"]`, "mousedown"),
			quoting,
		);
		await until(page, "focused", (f) => f.navigations().length > 0);
		expect(await call(page, (f) => f.navigations().at(-1))).toBe(quoting);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);
