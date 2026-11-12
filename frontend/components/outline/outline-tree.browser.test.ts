/**
 * The connected outline (readability E), in Chromium, against a test server running the real
 * outline routes (the isolated SQLite of `tests/preload.ts`):
 *
 *   - the home is one tree: my space, the projects, a project's pages and its sessions, a
 *     session's pages, each opened in place by its arrow (always drawn);
 *   - a page opened in place is read-only, folded by the page's default (a finished task is its
 *     title and one preview line), and the reader's folding is stored per page;
 *   - a space's URL is the tree focused on it, a session naming its project;
 *   - the same in Chinese, dark, at 360 px, with nothing wider than the page.
 *
 * NF_TREE_SHOTS=<dir> also writes screenshots (device scale 2) of each view there.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { narrators, outlineViewState, projects, users } from "../../../server/db/schema";
import { askTool } from "../../../server/lib/agent/tools/outline";
import type { ToolContext } from "../../../server/lib/agent/types";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import { setOutlineAnswerDelivery } from "../../../server/services/outline/questions";
import {
	ensurePersonalSpace,
	ensureProjectSpace,
	ensureSessionSpace,
} from "../../../server/services/outline/spaces";
import { outlineStore } from "../../../server/services/outline/store";
import { writeOutline } from "../../../server/services/outline/write";
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
let sessionSpace: string;
let taskPage: { pageId: string; idOf: (text: string) => string };
let questionPage: { pageId: string; idOf: (text: string) => string };
let raceSession: string;
const notes: string[] = [];

/** A session's task page: a task in progress with notes, finished tasks with their results. */
const TASK_LINES = [
	"[/] Add the concurrency regression test",
	"  Conclusion: a fake clock reproduces it reliably",
	"    Evidence: run.ts:784 delivery order",
	"    Detail two",
	"  [ ] Wire into the 4 CI shards",
	"[x] Reproduce the race",
	"  Two tabs refreshing at once still accept the old token",
	"    Seen in the logs",
	"[x] Clean up the old retry logic",
	"  Removed in favour of the queue",
	"[-] Fixed-time rejection",
	"  Superseded by the queue",
];

async function seedPage(
	spaceId: string,
	title: string,
	lines: string[],
): Promise<{ pageId: string; idOf: (text: string) => string }> {
	const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [
		{ op: "insert", tempId: "p", parent: null, content: title },
	];
	const stack = ["p"];
	lines.forEach((line, i) => {
		const depth = (line.length - line.trimStart().length) / 2;
		let content = line.trim();
		let task: { status: "todo" | "doing" | "done" | "cancelled" } | null = null;
		const mark = /^\[([ x/-])\] /.exec(content);
		if (mark) {
			const status = { " ": "todo", "/": "doing", x: "done", "-": "cancelled" } as const;
			task = { status: status[mark[1] as keyof typeof status] };
			content = content.slice(4);
		}
		stack.length = depth + 1;
		ops.push({
			op: "insert",
			tempId: `b${i}`,
			parent: { tempId: stack[depth] as string },
			content,
			task,
		});
		stack.push(`b${i}`);
	});
	const written = await writeOutline({
		spaceId,
		ops,
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const ids = written.results.map((r) => r.blockId);
	return {
		pageId: ids[0] as string,
		idOf: (text) => {
			const at = lines.findIndex((line) => line.trim().replace(/^\[.\] /, "") === text);
			if (at < 0) throw new Error(`no line ${text}`);
			return ids[at + 1] as string;
		},
	};
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
	app.route("/api/outline", outlineRoutes);
	return app;
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
	await db
		.insert(users)
		.values({ id: alice, username: "alice", passwordHash: "x", role: "user", createdAt: NOW });
	const personal = await ensurePersonalSpace(alice);
	await seedPage(personal.id, "Reading list", ["Outline design notes"]);
	// More pages than the tree shows open at once.
	for (let i = 1; i <= 13; i++) {
		notes.push((await seedPage(personal.id, `Note ${i}`, [`Line of note ${i}`])).pageId);
	}
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "NarraFork",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	projectSpace = (await ensureProjectSpace(projectId)).id;
	await seedPage(projectSpace, "Facts: the outline system", [
		"Writes go through one queue",
		"Reads are bounded",
	]);
	const sessions: string[] = [];
	for (const title of ["Board drag", "Fix the refresh race"]) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			title,
			ownerUserId: alice,
			visibility: "private",
			contextProjectId: projectId,
			taskBackend: "outline",
			createdAt: NOW,
			updatedAt: NOW,
		});
		sessions.push(id);
	}
	const board = await ensureSessionSpace(sessions[0] as string);
	await seedPage(board.id, "Tasks", ["[x] Drag between columns"]);
	sessionSpace = (await ensureSessionSpace(sessions[1] as string)).id;
	taskPage = await seedPage(sessionSpace, "Tasks", TASK_LINES);
	raceSession = sessions[1] as string;
	questionPage = await seedPage(sessionSpace, "Questions", ["[/] Pick the export format"]);
	setOutlineAnswerDelivery({
		async deliver() {
			return { written: true, woke: false };
		},
	});
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 60_000);

beforeEach(() => {
	settings.outline.enabled = true;
});

afterAll(async () => {
	setOutlineAnswerDelivery(null);
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
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((value) => localStorage.setItem("narrafork_token", value), alice);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate((opts) => (window as unknown as FixtureWindow).fixture.open(opts), options);
	(page as Page & { errors?: string[] }).errors = errors;
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

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function openTaskPage(page: Page) {
	for (const title of ["NarraFork", "Sessions (2)", "Fix the refresh race"]) {
		await until(page, title, hasRow, title);
		expect(await call(page, (f, t: string) => f.toggle(t), title)).toBe(true);
	}
	// The session's one page is its "Tasks"; the project's sessions each have one.
	await until(
		page,
		"the session's pages",
		(f) => f.rows().filter((r) => r.title === "Tasks").length >= 1,
	);
	await page.evaluate(() => {
		const rows = [...document.querySelectorAll<HTMLElement>("[data-tree-node]")];
		const at = rows.findIndex((r) => r.textContent?.includes("Fix the refresh race"));
		const tasks = rows.slice(at + 1).find((r) => r.dataset.treeKind === "page");
		tasks?.querySelector<HTMLButtonElement>("[data-tree-toggle]")?.click();
	});
	await until(
		page,
		"the open page",
		(f, id: string) => f.blockRows(id).length > 0,
		taskPage.pageId,
	);
}

test("the home is one tree: my space, then projects; every row has its arrow", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await until(page, "the project row", hasRow, "NarraFork");
	const rows = await call(page, (f) => f.rows());
	expect(rows.map((r) => r.title)).toEqual(["My notes", "NarraFork"]);
	expect(rows.every((r) => !r.open)).toBe(true);
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	await shot(page, "1-top-level");

	expect(await call(page, (f) => f.toggle("NarraFork"))).toBe(true);
	await until(page, "the project's page", hasRow, "Facts: the outline system");
	await until(page, "the sessions group", hasRow, "Sessions (2)");
	expect(await call(page, (f) => f.toggle("Sessions (2)"))).toBe(true);
	await until(page, "the sessions", hasRow, "Fix the refresh race");
	const titles = (await call(page, (f) => f.rows())).map((r) => r.title);
	// The project's pages, then its sessions, latest commit first.
	expect(titles.indexOf("Facts: the outline system")).toBeLessThan(titles.indexOf("Sessions (2)"));
	expect(titles.indexOf("Fix the refresh race")).toBeLessThan(titles.indexOf("Board drag"));
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	await shot(page, "2-project-expanded");
	await page.browserContext().close();
}, 60_000);

test("a page opens in place, read-only and folded by default; the folding is stored", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await openTaskPage(page);
	const rows = await call(page, (f, id: string) => f.blockRows(id), taskPage.pageId);
	const byId = new Map(rows.map((r) => [r.id, r]));
	// A finished task is closed behind one preview line; the one in progress shows its children.
	expect(byId.get(taskPage.idOf("Reproduce the race"))?.fold).toBe("closed");
	expect(byId.get(taskPage.idOf("Add the concurrency regression test"))?.fold).toBe("open");
	expect(byId.has(taskPage.idOf("Seen in the logs"))).toBe(false);
	const previews = await call(page, (f, id: string) => f.previews(id), taskPage.pageId);
	expect(previews).toContain(taskPage.idOf("Reproduce the race"));
	// Nothing in the tree edits: no editor, no editable text.
	expect(await call(page, (f) => f.count("[contenteditable='true']"))).toBe(0);
	await shot(page, "3-page-folded-tasks");

	// Opening a finished task is the reader's own, stored for the page.
	const done = taskPage.idOf("Reproduce the race");
	await page.evaluate((id) => {
		document
			.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] [data-fold-toggle]`)
			?.click();
	}, done);
	await until(
		page,
		"the task opened",
		(f, pageId: string, id: string) =>
			f.blockRows(pageId).some((r) => r.id === id && r.fold === "open"),
		taskPage.pageId,
		done,
	);
	const stored = async () =>
		(
			await db
				.select()
				.from(outlineViewState)
				.where(eq(outlineViewState.pageBlockId, taskPage.pageId))
		)[0]?.expandedJson ?? [];
	await eventually(async () => (await stored()).includes(done), "the folding stored");

	// The page's title focuses it (where the live editor is); the tree itself never navigates.
	expect(await call(page, (f) => f.navigated().length)).toBe(0);
	expect(
		await call(
			page,
			(f, id: string) => f.click(`[data-tree-node="page:${id}"] [data-tree-title]`),
			taskPage.pageId,
		),
	).toBe(true);
	const went = await call(page, (f) => f.navigated());
	expect(went).toEqual([{ kind: "block", spaceId: sessionSpace, blockId: taskPage.pageId }]);
	// Back to the page's default: nothing of the reader's is stored for it any more.
	await page.evaluate((id) => {
		document
			.querySelector<HTMLButtonElement>(`[data-block-id="${id}"] [data-fold-toggle]`)
			?.click();
	}, done);
	await eventually(async () => !(await stored()).includes(done), "the default stored");
	await page.browserContext().close();
}, 60_000);

test("a space's URL is the tree focused on it; a session names its project", async () => {
	const page = await openTree({ target: { kind: "space", spaceId: sessionSpace } });
	await until(page, "the session's page", hasRow, "Tasks");
	expect(await call(page, (f) => f.count("[data-testid='outline-crumb-project']"))).toBe(1);
	expect(await call(page, (f) => f.text())).toContain("NarraFork");
	await page.browserContext().close();

	const project = await openTree({ target: { kind: "space", spaceId: projectSpace } });
	await until(project, "the project's sessions", hasRow, "Sessions");
	expect(await call(project, (f) => f.count("[data-testid='outline-crumb-project']"))).toBe(0);
	await project.browserContext().close();
}, 60_000);

test("in Chinese, dark, at 360 px: the same tree, nothing wider than the page", async () => {
	const page = await openTree(
		{ target: { kind: "home" }, lang: "zh-CN", scheme: "dark" },
		{ width: 360, height: 780 },
	);
	await until(page, "the project row", hasRow, "NarraFork");
	expect(await call(page, (f) => f.toggle("NarraFork"))).toBe(true);
	await until(page, "the sessions group", hasRow, "会话（2）");
	expect(await call(page, (f) => f.toggle("会话（2）"))).toBe(true);
	await until(page, "the session", hasRow, "Fix the refresh race");
	expect(await call(page, (f) => f.toggle("Fix the refresh race"))).toBe(true);
	await until(
		page,
		"the session's page",
		(f, id: string) => f.rows().some((r) => r.key === `page:${id}`),
		taskPage.pageId,
	);
	await page.evaluate(() => {
		const rows = [...document.querySelectorAll<HTMLElement>("[data-tree-node]")];
		const at = rows.findIndex((r) => r.textContent?.includes("Fix the refresh race"));
		rows
			.slice(at + 1)
			.find((r) => r.dataset.treeKind === "page")
			?.querySelector<HTMLButtonElement>("[data-tree-toggle]")
			?.click();
	});
	await until(
		page,
		"the open page",
		(f, id: string) => f.blockRows(id).length > 0,
		taskPage.pageId,
	);
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	expect(await call(page, (f) => f.overflowsX())).toBe(false);
	// Narrow: the tree and the page together indent at most four levels, plus the one a page
	// already that deep keeps so its rows still nest (12 px a level).
	expect(await call(page, (f, id: string) => f.maxIndent(id), taskPage.pageId)).toBeLessThanOrEqual(
		5 * 12,
	);
	await shot(page, "4-zh-dark-360");
	await page.browserContext().close();
}, 60_000);

function toolCtx(): ToolContext {
	return {
		narratorId: raceSession,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId: alice,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

test("a closed row's question count opens the answer form in the tree; answering closes it", async () => {
	// Asked under the task in progress of the Questions page.
	const task = questionPage.idOf("Pick the export format");
	const space = await outlineStore.getSpace(sessionSpace);
	const block = await outlineStore.getBlock(task);
	const asked = await askTool.execute(
		{
			under: `${space?.key}/${block?.sid}`,
			questions: [{ question: "Which export format first?", recommend: "v2" }],
		},
		toolCtx(),
	);
	expect(asked.isError).toBeUndefined();
	const [question] = asked.metadata?.blockIds as [string];

	const page = await openTree({ target: { kind: "space", spaceId: sessionSpace } });
	await until(
		page,
		"the Questions page",
		(f, id: string) => f.rows().some((r) => r.key === `page:${id}`),
		questionPage.pageId,
	);
	await call(
		page,
		(f, id: string) => f.click(`[data-tree-node="page:${id}"] [data-tree-toggle]`),
		questionPage.pageId,
	);
	// An unanswered question is never folded away by default: its task is open.
	await until(
		page,
		"the question's row",
		(f, pageId: string, id: string) => f.blockRows(pageId).some((r) => r.id === id),
		questionPage.pageId,
		question,
	);
	// The reader closes the task: the row counts the question it hides.
	await call(page, (f, id: string) => f.click(`[data-block-id="${id}"] [data-fold-toggle]`), task);
	const chip = `[data-block-id="${task}"] [data-testid=outline-fold-hidden][data-kind=question]`;
	await until(page, "the question count", (f, sel: string) => f.count(sel) === 1, chip);
	await call(page, (f, sel: string) => f.click(sel), chip);
	await until(
		page,
		"the answer form, focused",
		(f, id: string) =>
			f.count(`[data-testid=outline-tree-questions] [data-testid=outline-question-${id}]`) === 1 &&
			f.activeInside(`[data-testid=outline-question-${id}]`),
		question,
	);
	// The tree did not leave itself.
	expect(await call(page, (f) => f.navigated().length)).toBe(0);
	await call(
		page,
		(f, sel: string) => f.type(sel, "v2, then v1 if asked"),
		`[data-testid=outline-question-${question}] textarea`,
	);
	await until(
		page,
		"submit enabled",
		(f) => f.count("[data-testid=outline-questions-submit]:not(:disabled)") === 1,
	);
	await call(page, (f) => f.click("[data-testid=outline-questions-submit]"));
	await until(page, "the form gone", (f) => f.count("[data-testid=outline-tree-questions]") === 0);
	await page.browserContext().close();
}, 60_000);

test("at most 12 pages are open with content, the newest 8 kept fresh; hidden ones do not count", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await until(page, "my space", hasRow, "My notes");
	expect(await call(page, (f) => f.toggle("My notes"))).toBe(true);
	for (let i = 1; i <= 13; i++) {
		const title = `Note ${i}`;
		await until(page, title, hasRow, title);
		expect(await call(page, (f, t: string) => f.toggle(t), title)).toBe(true);
		await until(
			page,
			`${title} open`,
			(f, id: string) => f.openPages().shown.includes(id),
			notes[i - 1],
		);
	}
	const open = await call(page, (f) => f.openPages());
	expect(open.shown).toHaveLength(12);
	// The page opened longest ago closed; the newest eight are subscribed.
	expect(open.shown).not.toContain(notes[0]);
	expect(open.live).toHaveLength(8);
	expect(new Set(open.live)).toEqual(new Set(notes.slice(5)));
	expect((await call(page, (f) => f.rows())).find((r) => r.title === "Note 1")?.open).toBe(false);

	// Closing my space hides its pages: they stay open but neither count nor subscribe.
	expect(await call(page, (f) => f.toggle("My notes"))).toBe(true);
	await until(page, "nothing shown", (f) => f.openPages().shown.length === 0);
	expect(await call(page, (f) => f.toggle("NarraFork"))).toBe(true);
	await until(page, "the project's page", hasRow, "Facts: the outline system");
	expect(await call(page, (f) => f.toggle("Facts: the outline system"))).toBe(true);
	await until(page, "the facts page shown and live", (f) => f.openPages().live.length === 1);
	// Shown again: twelve and one is thirteen, so the oldest shown goes; still at most 8 live.
	expect(await call(page, (f) => f.toggle("My notes"))).toBe(true);
	await until(page, "twelve shown again", (f) => f.openPages().shown.length === 12);
	expect((await call(page, (f) => f.openPages())).live).toHaveLength(8);
	await page.browserContext().close();
}, 60_000);

test("the keyboard: one tab stop per row; arrows move, open and close", async () => {
	const page = await openTree({ target: { kind: "home" } });
	await until(page, "the project row", hasRow, "NarraFork");
	expect(await call(page, (f) => f.count("[data-tree-toggle][tabindex='-1']"))).toBe(
		await call(page, (f) => f.count("[data-tree-toggle]")),
	);
	expect(
		await call(page, (f) => f.count("[role=tree] [role=treeitem][aria-level]")),
	).toBeGreaterThan(0);
	expect(await call(page, (f) => f.focusTitle("My notes"))).toBe(true);
	await page.keyboard.press("ArrowDown");
	expect(await call(page, (f) => f.focusedTitle())).toBe("NarraFork");
	await page.keyboard.press("ArrowRight");
	await until(page, "the project open", hasRow, "Facts: the outline system");
	await page.keyboard.press("ArrowRight");
	expect(await call(page, (f) => f.focusedTitle())).toBe("Facts: the outline system");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowLeft");
	await until(
		page,
		"the project closed",
		(f) => !f.rows().some((r) => r.title === "Facts: the outline system"),
	);
	await page.browserContext().close();
}, 60_000);
