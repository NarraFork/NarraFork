/**
 * Outline P2 PR 9b in Chromium, against a test server running the real outline routes on the
 * isolated SQLite of `tests/preload.ts`, at phone width (360 px), in English and Chinese, light
 * and dark:
 *
 *   - the Agent tool card of an agent sent with an outline task: a "Task: <title>" row under the
 *     description, measured exactly as painted; the title opens the task in the outline (the server
 *     resolves it with the reader's permissions: someone who may not read it gets nothing); a late
 *     result carries the late badge with its reason;
 *   - the task board's 「新完成」: a task the reader manages that an agent finished is marked for
 *     them, not for another reader; once it has been on screen the board records it (the mark
 *     stays while the board is open, even after a read), and the next board no longer marks it;
 *     another person's mark is untouched; a board mounted but hidden (a dock tab behind another,
 *     the panel saying it is hidden while still painted, or a host's `visibility: hidden`)
 *     records nothing until it is shown.
 * Nothing scrolls sideways.
 *
 * NF_9B_SHOTS=<dir> also writes a screenshot of each view there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { aclGrants, narrators, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import { addPersonTask } from "../../../server/services/outline/person-tasks";
import { ensureSessionSpace } from "../../../server/services/outline/spaces";
import { outlineStore } from "../../../server/services/outline/store";
import { writeOutline } from "../../../server/services/outline/write";
import en from "../../locales/en/narrator.json";
import enOutline from "../../locales/en/outline.json";
import zh from "../../locales/zh-CN/narrator.json";
import zhOutline from "../../locales/zh-CN/outline.json";
import type * as Fixture from "./delegation.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_9B_SHOTS;
const NOW = "2026-11-06T00:00:00.000Z";
const WIDTH = 360;

const VIEWS: Fixture.View[] = [
	{ lang: "en", scheme: "light", width: WIDTH },
	{ lang: "en", scheme: "dark", width: WIDTH },
	{ lang: "zh-CN", scheme: "light", width: WIDTH },
	{ lang: "zh-CN", scheme: "dark", width: WIDTH },
];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let bob: string;

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
	app.route("/api/outline", outlineRoutes);
	return app;
}

async function person(username: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function session(title: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: alice,
		visibility: "private",
		taskBackend: "outline",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	if (shots) mkdirSync(shots, { recursive: true });
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "delegation.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("fixture bundle missing");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`;
	const app = api();
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/api/")) {
				settings.outline.enabled = true;
				return app.fetch(request);
			}
			if (url.pathname === "/")
				return new Response(html, { headers: { "content-type": "text/html" } });
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	alice = await person(`alice9b${Date.now()}`);
	bob = await person(`bob9b${Date.now()}`);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function openPage(as: string): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: WIDTH, height: 900, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), as);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready(), {
		timeout: 20_000,
	});
	return { page, errors };
}

function call<T>(page: Page, fn: (f: typeof Fixture, ...args: never[]) => T, ...args: unknown[]) {
	return page.evaluate(`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`) as Promise<
		Awaited<T>
	>;
}

async function until(
	page: Page,
	what: string,
	fn: (f: typeof Fixture, ...args: never[]) => boolean,
	...args: unknown[]
) {
	try {
		await page.waitForFunction(`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`, {
			timeout: 10_000,
			polling: 50,
		});
	} catch (error) {
		const text = await page
			.evaluate(() => document.body.innerText.slice(0, 2000))
			.catch(() => "page gone");
		throw new Error(`until ${what}: ${text}: ${String(error)}`);
	}
}

/** Poll the server side (this process) until `check` holds. */
async function serverUntil(what: string, check: () => Promise<boolean>) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

async function shoot(page: Page, name: string) {
	if (!shots) return;
	const element = await page.$("#shot");
	await element?.screenshot({ path: join(shots, `${name}.png`) });
}

const viewName = (view: Fixture.View) => `${view.lang}-${view.scheme}`;

test("the Agent card: the task row links the task, a late result is marked; 360 px, both languages and schemes", async () => {
	const id = await session("Release work");
	const space = await ensureSessionSpace(id);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Auth work" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Fix the refresh race in the token cache",
				task: { status: "doing" },
			},
		],
		actor: { kind: "agent", id },
		narratorId: id,
		responsibleUserId: alice,
	});
	const task = written.results[1];
	if (!task) throw new Error("seed");
	const { page, errors } = await openPage(alice);
	try {
		for (const view of VIEWS) {
			const labels = view.lang === "en" ? en : zh;
			await call(
				page,
				(f, address: string, v: Fixture.View) => f.renderCards(address, v),
				task.address,
				view,
			);
			await until(page, "the cards", (f) => f.cards().filter((c) => c.row !== null).length === 2);
			const [current, late] = await call(page, (f) => f.cards());
			const row = labels.subagentDelegatedTask.replace(
				"{{title}}",
				"Fix the refresh race in the token cache",
			);
			expect(current).toMatchObject({
				kind: "subagent-card",
				row,
				rowFits: true,
				link: "Fix the refresh race in the token cache",
				late: null,
			});
			expect(late).toMatchObject({
				row,
				link: "Fix the refresh race in the token cache",
				late: labels.subagentLateBadge,
				lateReason: labels.subagentLateReason.taken_over,
			});
			// The extra row is measured exactly as Chromium paints it: the card's height, and the
			// row's own box inside the header (whose height is fixed, so the card alone would not
			// show a row spilling past it).
			for (const card of [current, late]) {
				expect(Math.abs((card?.painted ?? 0) - (card?.measured ?? 0))).toBeLessThanOrEqual(0.5);
				expect(card?.rowInHeader).toBe(true);
				expect(Math.abs((card?.rowHeight ?? 0) - (card?.lineXs ?? 0))).toBeLessThanOrEqual(0.05);
			}
			expect(await call(page, (f) => f.horizontalOverflow())).toBeLessThanOrEqual(0);
			await shoot(page, `card-${viewName(view)}`);
		}
		// At a typography the reader changed (smaller text, tighter lines, then larger and looser),
		// the row still takes the line the measure counts.
		for (const typography of [
			{ fontScalePercent: 70, lineHeightScalePercent: 60 },
			{ fontScalePercent: 130, lineHeightScalePercent: 140 },
		]) {
			await call(
				page,
				(f, address: string, v: Fixture.View, t: never) => f.renderCards(address, v, t),
				task.address,
				VIEWS[0],
				typography,
			);
			await until(page, "the cards", (f) => f.cards().filter((c) => c.row !== null).length === 2);
			for (const card of await call(page, (f) => f.cards())) {
				expect(Math.abs(card.painted - card.measured)).toBeLessThanOrEqual(0.5);
				expect(card.rowInHeader).toBe(true);
				expect(Math.abs((card.rowHeight ?? 0) - card.lineXs)).toBeLessThanOrEqual(0.05);
			}
		}
		await call(
			page,
			(f, address: string, v: Fixture.View) => f.renderCards(address, v),
			task.address,
			VIEWS[0],
		);
		// The title opens the task: the server resolved it for this reader.
		const resolved = page.waitForResponse((r) => r.url().includes("/api/outline/resolve"));
		expect(await call(page, (f) => f.clickTaskLink(0))).toBe(true);
		expect((await resolved).status()).toBe(200);
		await until(page, "the task opened", (f) => f.openedPlaces().length === 1);
		expect(await call(page, (f) => f.openedPlaces())).toEqual([
			{ spaceId: space.id, blockId: task.blockId },
		]);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}

	// Someone who may not read the session's space: the link resolves to nothing, nothing opens.
	const other = await openPage(bob);
	try {
		await call(
			other.page,
			(f, address: string, v: Fixture.View) => f.renderCards(address, v),
			task.address,
			VIEWS[0],
		);
		await until(other.page, "the cards", (f) => f.cards().length === 2);
		const resolved = other.page.waitForResponse((r) => r.url().includes("/api/outline/resolve"));
		expect(await call(other.page, (f) => f.clickTaskLink(0))).toBe(true);
		expect((await resolved).status()).toBe(404);
		expect(await call(other.page, (f) => f.openedPlaces())).toEqual([]);
	} finally {
		await other.page.browserContext().close();
	}
}, 120_000);

test("the board's 「新完成」: the person who manages it until they have seen it; another reader's untouched", async () => {
	for (const view of VIEWS) {
		const id = await session(`Board ${viewName(view)}`);
		// Bob may read the session: its board is his to read too.
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: id,
			principalType: "user",
			principalId: bob,
			capability: "read",
			createdAt: NOW,
		});
		const space = await ensureSessionSpace(id);
		const mine = await addPersonTask({
			narratorId: id,
			userId: alice,
			text: "Ship the importer",
			lock: false,
		});
		const theirs = await addPersonTask({
			narratorId: id,
			userId: bob,
			text: "Bob's report",
			lock: false,
		});
		const agent = {
			actor: { kind: "agent" as const, id },
			narratorId: id,
			responsibleUserId: alice,
		};
		for (const status of ["doing", "done"] as const)
			await writeOutline({
				spaceId: space.id,
				ops: [mine.blockId, theirs.blockId].map((blockId) => ({
					op: "setTask" as const,
					block: { id: blockId },
					task: { status },
				})),
				...agent,
			});
		const mark = view.lang === "en" ? enOutline.board.newlyDone : zhOutline.board.newlyDone;

		const { page, errors } = await openPage(alice);
		try {
			await call(
				page,
				(f, narratorId: string, v: Fixture.View) => f.openBoard(narratorId, v),
				id,
				view,
			);
			await until(page, "the board", (f) => f.boardRows().length === 2);
			const rows = async () =>
				Object.fromEntries((await call(page, (f) => f.boardRows())).map((r) => [r.title, r.mark]));
			expect(await rows()).toEqual({ "Ship the importer": mark, "Bob's report": null });
			expect(await call(page, (f) => f.horizontalOverflow())).toBeLessThanOrEqual(0);
			await shoot(page, `board-${viewName(view)}`);
			// On screen: the board records it for her (and only that task).
			await serverUntil(
				"the mark to be recorded",
				async () => (await outlineStore.getTaskSeen(alice, [mine.blockId])).length === 1,
			);
			expect(await outlineStore.getTaskSeen(alice, [theirs.blockId])).toEqual([]);
			// Still marked while this board is open, even after a read.
			await call(page, (f) => f.refetchBoard());
			expect(await rows()).toEqual({ "Ship the importer": mark, "Bob's report": null });
			// The next board no longer marks it.
			await call(
				page,
				(f, narratorId: string, v: Fixture.View) => f.openBoard(narratorId, v),
				id,
				view,
			);
			await until(page, "the board again", (f) => f.boardRows().length === 2);
			expect(await rows()).toEqual({ "Ship the importer": null, "Bob's report": null });
			expect(errors).toEqual([]);
		} finally {
			await page.browserContext().close();
		}

		// Bob's own mark is untouched by Alice having seen hers.
		const other = await openPage(bob);
		try {
			await call(
				other.page,
				(f, narratorId: string, v: Fixture.View) => f.openBoard(narratorId, v),
				id,
				view,
			);
			await until(other.page, "his board", (f) => f.boardRows().length === 2);
			expect(
				Object.fromEntries(
					(await call(other.page, (f) => f.boardRows())).map((r) => [r.title, r.mark]),
				),
			).toEqual({ "Ship the importer": null, "Bob's report": mark });
		} finally {
			await other.page.browserContext().close();
		}
	}
}, 180_000);

test("the board's 「新完成」 is seen once shown: hidden in a dock tab or by its host, nothing is recorded", async () => {
	for (const hidden of ["dock", "panel", "css"] as const) {
		const id = await session(`Hidden board ${hidden}`);
		const space = await ensureSessionSpace(id);
		const task = await addPersonTask({
			narratorId: id,
			userId: alice,
			text: "Ship the importer",
			lock: false,
		});
		for (const status of ["doing", "done"] as const)
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { status } }],
				actor: { kind: "agent", id },
				narratorId: id,
				responsibleUserId: alice,
			});
		const seen = async () => (await outlineStore.getTaskSeen(alice, [task.blockId])).length;
		const { page, errors } = await openPage(alice);
		try {
			const open = async () => {
				await call(
					page,
					(f, narratorId: string, v: Fixture.View, h: Fixture.HiddenHost) =>
						f.openBoard(narratorId, v, h),
					id,
					VIEWS[0],
					hidden,
				);
				await until(
					page,
					`the board hidden (${hidden})`,
					(f) => f.boardRows().length === 1 && f.boardRows()[0]?.mark !== null,
				);
				// In the viewport all along: the observer and the frame after it have had their turn.
				await call(page, (f) => f.frames(10));
			};
			await open();
			// Unmounted, the board tells the server whatever it saw: nothing.
			await call(page, (f) => f.close());
			await page.waitForNetworkIdle({ idleTime: 200, timeout: 5_000 });
			expect(await seen()).toBe(0);
			// Hidden again, then shown: now it is seen.
			await open();
			expect(await seen()).toBe(0);
			await call(page, (f) => f.showBoard());
			await serverUntil(
				`the mark to be recorded once shown (${hidden})`,
				async () => (await seen()) === 1,
			);
			expect(errors).toEqual([]);
		} finally {
			await page.browserContext().close();
		}
	}
}, 120_000);
