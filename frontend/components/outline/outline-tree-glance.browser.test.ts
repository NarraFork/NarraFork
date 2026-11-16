/**
 * The connected outline at a glance (readability F), in Chromium, against a test server running
 * the real outline routes (the isolated SQLite of `tests/preload.ts`):
 *
 *   - a space's row says what waits for the reader first, then what is in progress, one line of
 *     what is being done, and "read only" where they may not write;
 *   - a big task page opened in the tree is read folded: its open work is all there, a finished
 *     task is one line that says how much is behind it, and opening it reads what was left out;
 *   - the search is drawn as a tree (matches with their ancestors, terms marked); choosing a
 *     match shows it in the tree itself, opening what it is under and scrolling to it;
 *   - a request left by a focused page is located by the tree that mounts next;
 *   - the tree comes back where the reader left it; Alt+Enter opens everything inside a row;
 *   - the same in Chinese, dark, at 360 px, with nothing wider than the page.
 *
 * NF_TREE_SHOTS=<dir> also writes screenshots (device scale 2) of each view there.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { narrators, projects, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import {
	ensurePersonalSpace,
	ensureProjectSpace,
	ensureSessionSpace,
} from "../../../server/services/outline/spaces";
import { outlineStore } from "../../../server/services/outline/store";
import { writeViewState } from "../../../server/services/outline/view-state";
import { type OutlineOp, writeOutline } from "../../../server/services/outline/write";
import { eventually } from "./editor/outline-live-harness.browser-fixture";
import type * as Fixture from "./outline-tree.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const SHOTS = process.env.NF_TREE_SHOTS;
const NOW = "2026-11-03T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let projectSpace: string;
let raceSpace: string;
let tasksPage: string;
let bigPage: string;
let personalSpace: string;
const big = { firstDone: "", open: "", openNote: "", deepTask: "", deepNote: "", deepHit: "" };
let factHit = "";
let projectId = "";
let decisions = { pageId: "", a: "" };
const deep = { hit: "" };
let questions: string[] = [];
/** The test server's hold on the reader's view state: writes counted, reads held, writes failed. */
const viewState = {
	puts: 0,
	hold: null as Promise<void> | null,
	failPut: false,
	failGet: false,
};

async function write(spaceId: string, author: string, ops: OutlineOp[]): Promise<string[]> {
	const written = await writeOutline({
		spaceId,
		ops,
		actor: { kind: "human", id: author },
		responsibleUserId: author,
	});
	return written.results.map((r) => r.blockId);
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
	app.use("/api/outline/view-state/*", async (c, next) => {
		if (c.req.method === "PUT") {
			viewState.puts++;
			if (viewState.failPut) return c.json({ error: "held" }, 500);
		} else {
			if (viewState.hold) await viewState.hold;
			if (viewState.failGet) return c.json({ error: "held" }, 500);
		}
		await next();
	});
	app.route("/api/outline", outlineRoutes);
	return app;
}

async function session(
	title: string,
	owner: string,
	projectId: string,
	visibility: "private" | "project",
) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility,
		writeAudience: "owner",
		contextProjectId: projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return (await ensureSessionSpace(id)).id;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-tree.browser-fixture.tsx", import.meta.url).pathname],
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
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

	alice = generateId();
	const bob = generateId();
	await db.insert(users).values([
		{ id: alice, username: "alice", passwordHash: "x", role: "user", createdAt: NOW },
		{ id: bob, username: "bob", passwordHash: "x", role: "user", createdAt: NOW },
	]);
	// My space: enough pages to scroll.
	personalSpace = (await ensurePersonalSpace(alice)).id;
	await write(
		personalSpace,
		alice,
		Array.from({ length: 40 }, (_, i) => ({
			op: "insert" as const,
			parent: null,
			content: `Note ${String(i + 1).padStart(2, "0")}`,
		})),
	);
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Atlas",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	projectSpace = (await ensureProjectSpace(projectId)).id;
	const facts = await write(projectSpace, alice, [
		{ op: "insert", tempId: "p", parent: null, content: "Facts" },
		{
			op: "insert",
			parent: { tempId: "p" },
			content: "Outline phase two: tasks and teams",
			alias: "summary",
		},
		{ op: "insert", parent: { tempId: "p" }, content: "The zebracorn index is rebuilt nightly" },
	]);
	factHit = facts[2] as string;
	// A page the reader folded themselves: a fact (open by default) they closed.
	const decided = await write(projectSpace, alice, [
		{ op: "insert", tempId: "p", parent: null, content: "Decisions" },
		{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "Decision A" },
		{ op: "insert", parent: { tempId: "a" }, content: "Why A, first" },
		{ op: "insert", parent: { tempId: "a" }, content: "Why A, second" },
	]);
	decisions = { pageId: decided[0] as string, a: decided[1] as string };
	await writeViewState({ userId: alice, isAdmin: false }, decisions.pageId, {
		collapsed: [decisions.a],
		expanded: [],
		layout: "right",
	});

	// Someone else's session of the project, readable through the project, not writable.
	const spike = await session("Bob's spike", bob, projectId, "project");
	await write(spike, bob, [
		{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
		{
			op: "insert",
			parent: { tempId: "p" },
			content: "Measure the cold start",
			task: { status: "doing" },
		},
		// Put to alice, who cannot write here: not hers to answer in this space.
		{
			op: "insert",
			parent: { tempId: "p" },
			content: "Is 300 ms fine?",
			ask: { to: { kind: "human", id: alice }, recommend: {} },
		},
	]);

	raceSpace = await session("Fix the refresh race", alice, projectId, "private");
	const tasks = await write(raceSpace, alice, [
		{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
		{
			op: "insert",
			tempId: "t1",
			parent: { tempId: "p" },
			content: "Read the code",
			task: { status: "done" },
		},
		{ op: "insert", parent: { tempId: "p" }, content: "Write the fix", task: { status: "doing" } },
		{
			op: "insert",
			tempId: "t3",
			parent: { tempId: "p" },
			content: "Add the regression test",
			task: { status: "doing" },
		},
		{
			op: "insert",
			parent: { tempId: "t3" },
			content: "Which lock order?",
			ask: { to: { kind: "human", id: alice }, recommend: {} },
		},
		{
			op: "insert",
			parent: { tempId: "t3" },
			content: "Keep the old flag?",
			ask: { to: { kind: "human", id: alice }, recommend: {} },
		},
	]);
	tasksPage = tasks[0] as string;
	questions = [tasks[4] as string, tasks[5] as string];

	// A big task page: finished tasks with long notes, and the open work last.
	const done = (n: number, notes: number, deepAt = -1): OutlineOp[] => [
		{
			op: "insert",
			tempId: `d${n}`,
			parent: { tempId: "p" },
			content: `Finished task ${n}`,
			task: { status: "done" },
		},
		...Array.from(
			{ length: notes },
			(_, i): OutlineOp => ({
				op: "insert",
				tempId: `d${n}n${i}`,
				parent: { tempId: `d${n}` },
				content: i === 0 ? `Result of task ${n}` : `Step ${i} of task ${n}`,
			}),
		),
		...(deepAt >= 0
			? [
					{
						op: "insert",
						parent: { tempId: `d${n}n${deepAt}` },
						content: "The zebracorn ordering was the cause",
					} as OutlineOp,
				]
			: []),
	];
	// Four closed levels down a finished task: its note, a detail, a detail of that, the block.
	const nested: OutlineOp[] = [
		{ op: "insert", tempId: "x1", parent: { tempId: "d5n2" }, content: "Why the queue" },
		{ op: "insert", tempId: "x2", parent: { tempId: "x1" }, content: "Measured twice" },
		{ op: "insert", tempId: "x3", parent: { tempId: "x2" }, content: "Second run" },
		{ op: "insert", parent: { tempId: "x3" }, content: "The quokkafish trace says so" },
	];
	const first: OutlineOp[] = [{ op: "insert", tempId: "p", parent: null, content: "Big tasks" }];
	for (let n = 1; n <= 12; n++) first.push(...done(n, 14, n === 3 ? 7 : -1));
	first.push(...nested);
	const firstIds = await write(raceSpace, alice, first);
	deep.hit = firstIds.at(-1) as string;
	bigPage = firstIds[0] as string;
	big.firstDone = firstIds[1] as string;
	// Task 3: after the page (1) and tasks 1 and 2 (15 each).
	big.deepTask = firstIds[1 + 15 * 2] as string;
	big.deepNote = firstIds[1 + 15 * 2 + 1 + 7] as string;
	big.deepHit = firstIds[1 + 15 * 2 + 15] as string;
	const second: OutlineOp[] = [];
	for (let n = 13; n <= 17; n++) {
		second.push(
			{
				op: "insert",
				tempId: `e${n}`,
				parent: { id: bigPage },
				content: `Finished task ${n}`,
				task: { status: "done" },
			},
			...Array.from(
				{ length: 30 },
				(_, i): OutlineOp => ({
					op: "insert",
					parent: { tempId: `e${n}` },
					content: `Step ${i} of task ${n}`,
				}),
			),
		);
	}
	second.push(
		{
			op: "insert",
			tempId: "open",
			parent: { id: bigPage },
			content: "Ship the fix behind a flag",
			task: { status: "doing" },
		},
		...Array.from(
			{ length: 5 },
			(_, i): OutlineOp => ({
				op: "insert",
				parent: { tempId: "open" },
				content: `Open note ${i + 1}`,
			}),
		),
	);
	const secondIds = await write(raceSpace, alice, second);
	big.open = secondIds[5 * 31] as string;
	big.openNote = secondIds[5 * 31 + 5] as string;
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 60_000);

beforeEach(() => {
	settings.outline.enabled = true;
});

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function openTree(
	options: Parameters<typeof Fixture.open>[0],
	viewport: { width: number; height: number } = { width: 1100, height: 900 },
): Promise<Page> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
	await page.goto(server.url.origin);
	await page.evaluate((value) => localStorage.setItem("narrafork_token", value), alice);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate((opts) => (window as unknown as FixtureWindow).fixture.open(opts), options);
	return page;
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
	...args: unknown[]
) {
	try {
		await page.waitForFunction(`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`, {
			timeout: 15_000,
			polling: 50,
		});
	} catch (error) {
		const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
		throw new Error(`timed out waiting for ${what}: ${String(error)}\n--- page ---\n${text}`);
	}
}

const hasRow = (f: typeof Fixture, title: string) => f.rows().some((r) => r.title === title);
const hasKey = (f: typeof Fixture, key: string) => f.rows().some((r) => r.key === key);

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function toggle(page: Page, title: string) {
	await until(page, title, hasRow, title);
	expect(await call(page, (f, t: string) => f.toggle(t), title)).toBe(true);
}

async function togglePage(page: Page, pageId: string) {
	await until(page, `page ${pageId}`, hasKey, `page:${pageId}`);
	expect(
		await call(
			page,
			(f, id: string) => f.click(`[data-tree-node="page:${id}"] [data-tree-toggle]`),
			pageId,
		),
	).toBe(true);
}

async function type(page: Page, text: string) {
	expect(
		await call(
			page,
			(f, value: string) => f.type("[data-testid=outline-search-input]", value),
			text,
		),
	).toBe(true);
}

test("a space's row: what waits for the reader first, what is in progress, one line, read only", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await toggle(page, "Atlas");
	await toggle(page, "Sessions (2)");
	await until(page, "the sessions", hasRow, "Bob's spike");
	const rows = await call(page, (f) => f.glance());
	const by = new Map(rows.map((row) => [row.title, row]));
	const race = by.get("Fix the refresh race");
	expect(race?.waiting).toContain("2");
	expect(race?.doing).toBe("3");
	// What waits for the reader comes before what is in progress.
	expect(race?.first).toBe("waiting");
	expect(race?.readOnly).toBe(false);
	expect(race?.summary).toMatch(/^Doing: /);
	// Readable, not writable: marked, and nothing waits for the reader there.
	const spike = by.get("Bob's spike");
	expect(spike?.readOnly).toBe(true);
	expect(spike?.waiting).toBeNull();
	expect(spike?.doing).toBe("1");
	// The project's own line is the block its writers aliased `summary`.
	expect(by.get("Atlas")?.summary).toBe("Outline phase two: tasks and teams");
	expect(by.get("Atlas")?.readOnly).toBe(false);
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	expect(await call(page, (f) => f.ariaOwnedWell())).toBe(true);
	expect(await call(page, (f) => f.hoverRules())).toEqual([]);
	await shot(page, "1-session-rows-counts");

	// "Waiting for you" is a button: it shows the first question in the tree, with its form.
	expect(await call(page, (f) => f.count("button[data-tree-count=waiting]"))).toBe(1);
	expect(await call(page, (f) => f.click("button[data-tree-count=waiting]"))).toBe(true);
	await until(
		page,
		"a question located",
		(f, ids: string[]) => ids.includes(f.located()?.id ?? ""),
		// (Asked in one commit: either is the oldest.)
		questions,
	);
	await until(
		page,
		"its answer form",
		(f) => f.count("[data-testid=outline-tree-questions]") === 1,
	);
	expect(await call(page, (f) => f.navigated().length)).toBe(0);
	await page.browserContext().close();
}, 60_000);

test("a big task page is read folded: open work whole, a finished task one line, opened on demand", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await toggle(page, "Atlas");
	await toggle(page, "Sessions (2)");
	await toggle(page, "Fix the refresh race");
	await togglePage(page, bigPage);
	await until(page, "the page's blocks", (f, id: string) => f.blockRows(id).length > 0, bigPage);
	// Past 400 blocks, and the read holds 200: the open task, written last, is all there.
	expect(await call(page, (f, p: string, b: string) => f.hasBlock(p, b), bigPage, big.open)).toBe(
		true,
	);
	expect(
		await call(page, (f, p: string, b: string) => f.hasBlock(p, b), bigPage, big.openNote),
	).toBe(true);
	const rows = await call(page, (f, id: string) => f.blockRows(id), bigPage);
	// 17 finished tasks, each one row; the open one and its five notes.
	expect(rows).toHaveLength(17 + 1 + 5);
	expect(rows.find((r) => r.id === big.firstDone)?.fold).toBe("closed");
	// The one line of a finished task says how much is behind it, as the server counted it.
	const labels = await call(page, (f, id: string) => f.previewLabels(id), bigPage);
	expect(labels[big.firstDone]).toContain("13");
	// Nothing was cut by the budget: no "only part of this page" note.
	expect(await call(page, (f, id: string) => f.partial(id), bigPage)).toBe(false);
	await shot(page, "2-big-task-page-folded");

	// Opening a finished task reads what was left out behind it.
	await page.evaluate((id) => {
		document
			.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] [data-fold-toggle]`)
			?.click();
	}, big.firstDone);
	await until(
		page,
		"the finished task's notes",
		(f, p: string) => f.blockRows(p).length === 17 + 1 + 5 + 14,
		bigPage,
	);
	await page.browserContext().close();
}, 60_000);

test("the search is drawn as a tree; a match is shown in the tree, what it is under opened", async () => {
	const page = await openTree({ target: { kind: "home" } }, { width: 1100, height: 700 });
	await until(page, "the project row", hasRow, "Atlas");
	await type(page, "zebracorn");
	await until(page, "the matches", (f) => f.searchRows().filter((r) => r.hit).length === 2);
	expect(await call(page, (f) => f.treeShown())).toBe(false);
	const rows = await call(page, (f) => f.searchRows());
	// Each match under its space, its page and its ancestors; the terms marked.
	const deep = rows.findIndex((r) => r.hit === big.deepHit);
	expect(rows.slice(deep - 4, deep + 1).map((r) => `${r.level} ${r.kind} ${r.title}`)).toEqual([
		"1 space Fix the refresh race",
		"2 page Big tasks",
		"3 block Finished task 3",
		"4 block Step 7 of task 3",
		"5 block The zebracorn ordering was the cause",
	]);
	expect(rows[deep]?.marks).toContain("zebracorn");
	const fact = rows.findIndex((r) => r.hit === factHit);
	expect(rows.slice(fact - 2, fact).map((r) => `${r.level} ${r.kind} ${r.title}`)).toEqual([
		"1 space Atlas",
		"2 page Facts",
	]);
	expect(await call(page, (f) => f.arrowsDrawn("[data-testid=outline-search-tree]"))).toBe(true);
	expect(await call(page, (f) => f.ariaOwnedWell())).toBe(true);
	await shot(page, "3-search-as-tree");

	// The keyboard moves through it like the tree.
	expect(await call(page, (f) => f.focusTitle("Big tasks"))).toBe(true);
	await page.keyboard.press("ArrowDown");
	expect(await call(page, (f) => f.focusedTitle())).toBe("Finished task 3");

	// Choosing the match: the search goes, the tree opens down to it (through a finished task
	// the folded read had closed) and scrolls to it.
	expect(await call(page, (f, id: string) => f.chooseHit(id), big.deepHit)).toBe(true);
	await until(page, "the tree back", (f) => f.treeShown());
	await until(page, "the match located", (f, id: string) => f.located()?.id === id, big.deepHit);
	expect((await call(page, (f) => f.located()))?.inView).toBe(true);
	const open = (await call(page, (f) => f.rows())).filter((r) => r.open).map((r) => r.key);
	expect(open).toContain(`space:${projectSpace}`);
	expect(open).toContain(`space:${raceSpace}`);
	expect(open).toContain(`page:${bigPage}`);
	// Nothing navigated: the tree showed it.
	expect(await call(page, (f) => f.navigated().length)).toBe(0);
	await shot(page, "3b-located");
	await page.browserContext().close();
}, 60_000);

test("a request left by a focused page is located by the tree that mounts next", async () => {
	const page = await openTree({ target: { kind: "space", spaceId: personalSpace } });
	await until(page, "a page of my space", hasRow, "Note 01");
	await call(
		page,
		(f, target: Parameters<typeof Fixture.requestLocate>[0]) => f.requestLocate(target),
		{
			spaceId: raceSpace,
			pageId: tasksPage,
			blockId: tasksPage,
			pathIds: [],
			pageTitle: "Tasks",
		},
	);
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.open({ target: { kind: "home" } }),
	);
	await until(
		page,
		"the page's row located",
		(f, key: string) => f.located()?.id === key,
		`page:${tasksPage}`,
	);
	const open = (await call(page, (f) => f.rows())).filter((r) => r.open).map((r) => r.key);
	expect(open).toContain(`space:${projectSpace}`);
	expect(open).toContain(`space:${raceSpace}`);
	await page.browserContext().close();
}, 60_000);

test("the tree comes back where the reader left it", async () => {
	const page = await openTree({ target: { kind: "home" } }, { width: 900, height: 500 });
	await toggle(page, "My notes");
	await until(page, "my pages", hasRow, "Note 40");
	await call(page, (f) => f.scrollToY(700));
	await until(page, "scrolled", (f) => f.scrollY() >= 600);
	const before = await call(page, (f) => f.topRow());
	expect(before?.key.startsWith("page:")).toBe(true);
	// Away (a space), and back.
	await page.evaluate(
		(spaceId) =>
			(window as unknown as FixtureWindow).fixture.open({ target: { kind: "space", spaceId } }),
		projectSpace,
	);
	await until(page, "the space", (f) => f.count("[data-testid=outline-space-home]") === 1);
	// Taken as the tree went.
	expect(await call(page, (f) => f.storedAnchor())).not.toBeNull();
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.open({ target: { kind: "home" } }),
	);
	await until(
		page,
		"the same row at the top again",
		(f, key: string, top: number) => {
			const now = f.topRow();
			return now?.key === key && Math.abs(now.top - top) <= 2;
		},
		before?.key,
		before?.top,
	);
	await page.browserContext().close();
}, 60_000);

test("Alt+Enter on a row: everything inside it, a level at a time; on a page, all its blocks", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await until(page, "the project row", hasRow, "Atlas");
	expect(await call(page, (f) => f.focusTitle("Atlas"))).toBe(true);
	await page.keyboard.down("Alt");
	await page.keyboard.press("Enter");
	await page.keyboard.up("Alt");
	// The project and, as it loads, its group of sessions.
	await until(page, "the sessions", hasRow, "Fix the refresh race");
	expect(await call(page, (f) => f.focusedTitle())).toBe("Atlas");
	await page.keyboard.down("Alt");
	await page.keyboard.press("Enter");
	await page.keyboard.up("Alt");
	// One level further: the sessions open (their pages are listed, none opened).
	await until(page, "a session's pages", hasKey, `page:${bigPage}`);
	expect((await call(page, (f) => f.openPages())).shown).toEqual([]);
	await page.keyboard.down("Alt");
	await page.keyboard.press("Enter");
	await page.keyboard.up("Alt");
	// All open: everything inside closes.
	await until(page, "the project closed", (f) => f.rows().every((r) => !r.open));

	// A page: all of its blocks, then back to its default.
	await toggle(page, "Atlas");
	await toggle(page, "Sessions (2)");
	await toggle(page, "Fix the refresh race");
	await until(page, "the tasks page", hasKey, `page:${tasksPage}`);
	await page.evaluate((id) => {
		document.querySelector<HTMLElement>(`[data-tree-node="page:${id}"] [data-tree-title]`)?.focus();
	}, tasksPage);
	await page.keyboard.down("Alt");
	await page.keyboard.press("Enter");
	await page.keyboard.up("Alt");
	await until(
		page,
		"the page open, everything inside shown",
		(f, id: string) =>
			f.blockRows(id).length === 5 && f.blockRows(id).every((r) => r.fold !== "closed"),
		tasksPage,
	);
	// Alt+Enter did not follow the title's link.
	expect(await call(page, (f) => f.navigated().length)).toBe(0);
	await page.browserContext().close();
}, 60_000);

const storedFolding = async (pageId: string) => {
	const row = await outlineStore.getViewState(alice, pageId);
	return { collapsed: row?.collapsed ?? [], expanded: row?.expanded ?? [] };
};

async function openDecisions(page: Page) {
	await toggle(page, "Atlas");
	await togglePage(page, decisions.pageId);
	await until(
		page,
		"the page's blocks",
		(f, id: string) => f.blockRows(id).length > 0,
		decisions.pageId,
	);
}

const closedRow = (f: typeof Fixture, pageId: string, id: string) =>
	f.blockRows(pageId).some((r) => r.id === id && r.fold === "closed");

test("opening a page keeps what the reader stored: nothing is written before it is read", async () => {
	viewState.puts = 0;
	const page = await openTree({ target: { kind: "home" } });
	await openDecisions(page);
	// The row the reader closed is closed here too, once their folding has been read.
	await until(page, "the stored folding applied", closedRow, decisions.pageId, decisions.a);
	expect(await storedFolding(decisions.pageId)).toEqual({
		collapsed: [decisions.a],
		expanded: [],
	});
	expect(viewState.puts).toBe(0);
	await page.browserContext().close();
}, 60_000);

test("the same while the stored folding is slow to arrive", async () => {
	viewState.puts = 0;
	let release = () => {};
	viewState.hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const page = await openTree({ target: { kind: "home" } });
		await openDecisions(page);
		// The read is folded by the stored state; the page's own state has not arrived: the row
		// shows open over the one block that came. Nothing may be written from that.
		await until(
			page,
			"the row as the default has it",
			(f, pageId: string, id: string) =>
				f.blockRows(pageId).some((r) => r.id === id && r.fold === "open"),
			decisions.pageId,
			decisions.a,
		);
		// A round trip later (anything sent before it has reached the server), still nothing.
		await page.evaluate(() => fetch("/api/settings").then((r) => r.json()));
		expect(viewState.puts).toBe(0);
		release();
		viewState.hold = null;
		await until(page, "the stored folding applied", closedRow, decisions.pageId, decisions.a);
		await page.evaluate(() => fetch("/api/settings").then((r) => r.json()));
		expect(viewState.puts).toBe(0);
		expect(await storedFolding(decisions.pageId)).toEqual({
			collapsed: [decisions.a],
			expanded: [],
		});
		// Opened by the reader now: stored, with what was there, and its blocks read.
		await page.evaluate((id) => {
			document
				.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] [data-fold-toggle]`)
				?.click();
		}, decisions.a);
		await until(
			page,
			"its blocks",
			(f, id: string) => f.blockRows(id).length === 3,
			decisions.pageId,
		);
		expect((await storedFolding(decisions.pageId)).collapsed).toEqual([]);
		// Put back as the reader had it, for the tests after this one.
		await writeViewState({ userId: alice, isAdmin: false }, decisions.pageId, {
			collapsed: [decisions.a],
			expanded: [],
			layout: "right",
		});
		await page.browserContext().close();
	} finally {
		release();
		viewState.hold = null;
	}
}, 60_000);

test("folding before the stored state arrives lays it under what the reader did, and writes after", async () => {
	const mine = { userId: alice, isAdmin: false };
	await writeViewState(mine, bigPage, { collapsed: [big.open], expanded: [], layout: "right" });
	viewState.puts = 0;
	let release = () => {};
	viewState.hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const page = await openTree({ target: { kind: "home" } });
		await toggle(page, "Atlas");
		await toggle(page, "Sessions (2)");
		await toggle(page, "Fix the refresh race");
		await togglePage(page, bigPage);
		await until(page, "the page's blocks", (f, id: string) => f.blockRows(id).length > 0, bigPage);
		// The reader opens a finished task while their stored folding is still on its way.
		await page.evaluate((id) => {
			document
				.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] [data-fold-toggle]`)
				?.click();
		}, big.firstDone);
		await page.evaluate(() => fetch("/api/settings").then((r) => r.json()));
		expect(viewState.puts).toBe(0);
		release();
		viewState.hold = null;
		// What they stored is kept, with what they just did on top; and the task's blocks come.
		await eventually(async () => {
			const stored = await storedFolding(bigPage);
			return stored.collapsed.includes(big.open) && stored.expanded.includes(big.firstDone);
		}, "the stored folding with the reader's change on top");
		await until(
			page,
			"the open work closed as stored, the finished task's notes read",
			(f, pageId: string, open: string, done: string) => {
				const rows = f.blockRows(pageId);
				return (
					rows.some((r) => r.id === open && r.fold === "closed") &&
					rows.some((r) => r.id === done && r.fold === "open") &&
					rows.length === 17 + 1 + 14
				);
			},
			bigPage,
			big.open,
			big.firstDone,
		);
		await page.browserContext().close();
	} finally {
		release();
		viewState.hold = null;
		await writeViewState(mine, bigPage, { collapsed: [], expanded: [], layout: "right" });
	}
}, 60_000);

test("when the stored folding cannot be read, nothing is written over it", async () => {
	viewState.puts = 0;
	viewState.failGet = true;
	try {
		const page = await openTree({ target: { kind: "home" } });
		await openDecisions(page);
		// The reader folds here (the row shows open: its stored folding never came).
		await page.evaluate((id) => {
			document
				.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] [data-fold-toggle]`)
				?.click();
		}, decisions.a);
		await until(page, "folded locally", closedRow, decisions.pageId, decisions.a);
		// Leaving the page writes at once whatever is waiting to be written: nothing is.
		await page.evaluate(
			(spaceId) =>
				(window as unknown as FixtureWindow).fixture.open({ target: { kind: "space", spaceId } }),
			personalSpace,
		);
		await until(page, "away", (f) => f.count("[data-testid=outline-space-home]") === 1);
		await page.evaluate(() => fetch("/api/settings").then((r) => r.json()));
		expect(viewState.puts).toBe(0);
		expect(await storedFolding(decisions.pageId)).toEqual({
			collapsed: [decisions.a],
			expanded: [],
		});
		await page.browserContext().close();
	} finally {
		viewState.failGet = false;
	}
}, 60_000);

test("a block behind four closed rows is located: every ancestor opened in one stored folding", async () => {
	const page = await openTree({ target: { kind: "home" } }, { width: 1100, height: 700 });
	await until(page, "the project row", hasRow, "Atlas");
	await type(page, "quokkafish");
	await until(page, "the match", (f) => f.searchRows().filter((r) => r.hit).length === 1);
	viewState.puts = 0;
	expect(await call(page, (f, id: string) => f.chooseHit(id), deep.hit)).toBe(true);
	await until(page, "the match located", (f, id: string) => f.located()?.id === id, deep.hit);
	expect((await call(page, (f) => f.located()))?.inView).toBe(true);
	expect(await call(page, (f) => f.count("[data-testid=outline-locate-failed]"))).toBe(0);
	// One stored folding brought it (the usual delayed write of the same may follow).
	expect(viewState.puts).toBeLessThanOrEqual(2);
	await page.browserContext().close();
}, 60_000);

test("a row whose blocks cannot be brought says so, with the way to the page", async () => {
	viewState.failPut = true;
	try {
		const page = await openTree({ target: { kind: "home" } });
		await toggle(page, "Atlas");
		await toggle(page, "Sessions (2)");
		await toggle(page, "Fix the refresh race");
		await togglePage(page, bigPage);
		await until(page, "the page's blocks", (f, id: string) => f.blockRows(id).length > 0, bigPage);
		const stuck = `[data-tree-page="${bigPage}"] [data-tree-partial="stuck"]`;
		expect(await call(page, (f, sel: string) => f.count(sel), stuck)).toBe(0);
		const task9 = await page.evaluate(() => {
			const row = [...document.querySelectorAll<HTMLElement>("[data-block-id]")].find((r) =>
				r.textContent?.includes("Finished task 9"),
			);
			row?.querySelector<HTMLButtonElement>("[data-fold-toggle]")?.click();
			return row?.dataset.blockId ?? "";
		});
		expect(task9).not.toBe("");
		// The folding could not be stored, so the read still leaves the blocks out: the page
		// says it shows only part, and links to the page focused.
		await until(page, "the note", (f, sel: string) => f.count(sel) === 1, stuck);
		expect(await call(page, (f, sel: string) => f.count(`${sel} a`), stuck)).toBe(1);
		await page.browserContext().close();
	} finally {
		viewState.failPut = false;
	}
}, 60_000);

test("what cannot be located is said, not waited for in silence", async () => {
	const page = await openTree({ target: { kind: "space", spaceId: personalSpace } });
	await until(page, "a page of my space", hasRow, "Note 01");
	await call(
		page,
		(f, target: Parameters<typeof Fixture.requestLocate>[0]) => f.requestLocate(target),
		{
			spaceId: "nosuchspace",
			pageId: "nosuchpage",
			blockId: "nosuchpage",
			pathIds: [],
			pageTitle: "",
		},
	);
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.open({ target: { kind: "home" } }),
	);
	await until(page, "the note", (f) => f.count("[data-testid=outline-locate-failed]") === 1);
	expect(await call(page, (f) => f.click("[data-testid=outline-locate-failed] button"))).toBe(true);
	await until(page, "dismissed", (f) => f.count("[data-testid=outline-locate-failed]") === 0);
	await page.browserContext().close();
}, 60_000);

test("in Chinese, dark, at 360 px: the rows say the same, nothing wider than the page", async () => {
	const page = await openTree(
		{ target: { kind: "home" }, lang: "zh-CN", scheme: "dark" },
		{ width: 360, height: 780 },
	);
	await toggle(page, "Atlas");
	await toggle(page, "会话（2）");
	await toggle(page, "Fix the refresh race");
	await togglePage(page, tasksPage);
	await until(page, "the page's blocks", (f, id: string) => f.blockRows(id).length > 0, tasksPage);
	const rows = await call(page, (f) => f.glance());
	const by = new Map(rows.map((row) => [row.title, row]));
	expect(by.get("Fix the refresh race")?.waiting).toBe("2");
	expect(by.get("Fix the refresh race")?.doing).toBe("3");
	expect(by.get("Fix the refresh race")?.first).toBe("waiting");
	expect(by.get("Bob's spike")?.readOnly).toBe(true);
	expect(by.get("Atlas")?.summary).toBe("Outline phase two: tasks and teams");
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	expect(await call(page, (f) => f.overflowsX())).toBe(false);
	await shot(page, "4-zh-dark-360");

	// The search as a tree holds at this width too.
	await type(page, "zebracorn");
	await until(page, "the matches", (f) => f.searchRows().filter((r) => r.hit).length === 2);
	expect(await call(page, (f) => f.overflowsX())).toBe(false);
	await shot(page, "4b-zh-dark-360-search");
	await page.browserContext().close();
}, 60_000);

test("a session is located although its project is past the first page of the root", async () => {
	// Thirty projects committed to after Atlas: the root's first page ends before it.
	for (let i = 0; i < 30; i++) {
		const id = generateId();
		await db.insert(projects).values({
			id,
			name: `Filler ${String(i + 1).padStart(2, "0")}`,
			ownerUserId: alice,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const space = await ensureProjectSpace(id);
		await write(space.id, alice, [{ op: "insert", parent: null, content: "Notes" }]);
	}
	const page = await openTree({ target: { kind: "space", spaceId: personalSpace } });
	await until(page, "a page of my space", hasRow, "Note 01");
	await call(
		page,
		(f, target: Parameters<typeof Fixture.requestLocate>[0]) => f.requestLocate(target),
		{ spaceId: raceSpace, pageId: tasksPage, blockId: tasksPage, pathIds: [], pageTitle: "Tasks" },
	);
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.open({ target: { kind: "home" } }),
	);
	await until(page, "the fillers", hasRow, "Filler 30");
	await until(
		page,
		"the page's row located",
		(f, key: string) => f.located()?.id === key,
		`page:${tasksPage}`,
	);
	const rows = await call(page, (f) => f.rows());
	// Its project is shown (pinned first among the projects), once.
	expect(rows.filter((r) => r.title === "Atlas")).toHaveLength(1);
	expect(rows.filter((r) => r.kind === "space" && r.title.startsWith("Filler"))).toHaveLength(30);
	expect(await call(page, (f) => f.count("[data-testid=outline-locate-failed]"))).toBe(0);
	await page.browserContext().close();
}, 60_000);
