/**
 * The forest in read mode (pageless outline, F1), in Chromium, against a test server running
 * the real outline routes and the real block watch (the isolated SQLite of `tests/preload.ts`):
 *
 *   - the home is one tree: spaces, and under a space its top-level blocks, one line each,
 *     opened in place by their arrows (always drawn). No pages anywhere;
 *   - a block's levels load lazily; what the reader opens and closes is stored per block and is
 *     there after a reload;
 *   - a long level continues with "more" in place, and past 2,000 children is paged in place;
 *   - a commit re-reads only the levels it concerns, through the block watch: a new sibling
 *     appears, a leaf that gains its first child gets its arrow; nothing reloads;
 *   - locate, the search drawn as a tree by ancestor path, the quick switcher (top-level blocks
 *     first);
 *   - 10,000 loaded rows scroll with a bounded DOM (frame times printed);
 *   - a focused block is the same list with one root; 「编辑」 and F2 enter editing;
 *   - in Chinese, dark, at 360 px: nothing wider than the screen, no "页".
 *
 * NF_FOREST_SHOTS=<dir> also writes screenshots (device scale 2) there.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../../server/db";
import { narrators, outlineFoldState, projects, users } from "../../../../server/db/schema";
import { AppError } from "../../../../server/lib/errors";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import {
	ensurePersonalSpace,
	ensureProjectSpace,
	ensureSessionSpace,
} from "../../../../server/services/outline/spaces";
import { type OutlineOp, writeOutline } from "../../../../server/services/outline/write";
import {
	handleOutlineBlockMessage,
	type OutlineBlockSocket,
	releaseOutlineBlockSubscriptions,
} from "../../../../server/websocket/outline-block-ws";
import type * as Fixture from "./outline-forest.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const SHOTS = process.env.NF_FOREST_SHOTS;
const NOW = "2026-11-15T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let projectSpace: string;
let sessionSpace: string;
let bigSpace: string;
let tasks: Seeded;
let facts: Seeded;
let long: { id: string };
let tenK: { id: string };

interface Seeded {
	id: string;
	idOf: (text: string) => string;
}

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
];

async function write(spaceId: string, ops: OutlineOp[]) {
	return (
		await writeOutline({
			spaceId,
			ops,
			actor: { kind: "human", id: alice },
			responsibleUserId: alice,
		})
	).results.map((r) => r.blockId);
}

/** A top-level block with the lines under it (two spaces per level, `[x] ` marks a task). */
async function seed(spaceId: string, title: string, lines: string[]): Promise<Seeded> {
	const ops: OutlineOp[] = [{ op: "insert", tempId: "p", parent: null, content: title }];
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
	const ids = await write(spaceId, ops);
	return {
		id: ids[0] as string,
		idOf: (text) => {
			const at = lines.findIndex((line) => line.trim().replace(/^\[.\] /, "") === text);
			if (at < 0) throw new Error(`no line ${text}`);
			return ids[at + 1] as string;
		},
	};
}

/** `count` children under a parent, in writes of 200. */
async function fill(
	spaceId: string,
	parentId: string,
	prefix: string,
	count: number,
): Promise<string[]> {
	const out: string[] = [];
	for (let from = 0; from < count; from += 200) {
		out.push(
			...(await write(
				spaceId,
				Array.from({ length: Math.min(200, count - from) }, (_, i) => ({
					op: "insert" as const,
					parent: { id: parentId },
					content: `${prefix} ${from + i + 1}`,
				})),
			)),
		);
	}
	return out;
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
		entrypoints: [new URL("./outline-forest.browser-fixture.tsx", import.meta.url).pathname],
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
	server = Bun.serve<{ userId: string; userRole: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/ws") {
				const userId = url.searchParams.get("user") ?? "";
				if (srv.upgrade(request, { data: { userId, userRole: "user" } })) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
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
		websocket: {
			message(ws, message) {
				if (typeof message !== "string") return;
				settings.outline.enabled = true;
				void handleOutlineBlockMessage(ws as unknown as OutlineBlockSocket, JSON.parse(message));
			},
			close(ws) {
				releaseOutlineBlockSubscriptions(ws as unknown as OutlineBlockSocket);
			},
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

	alice = generateId();
	await db
		.insert(users)
		.values({ id: alice, username: "alice", passwordHash: "x", role: "user", createdAt: NOW });
	const personal = await ensurePersonalSpace(alice);
	await seed(personal.id, "Reading list", ["Outline design notes"]);
	const project = async (name: string) => {
		const id = generateId();
		await db.insert(projects).values({
			id,
			name,
			ownerUserId: alice,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return { id, space: (await ensureProjectSpace(id)).id };
	};
	const main = await project("NarraFork");
	projectSpace = main.space;
	facts = await seed(projectSpace, "Facts: the outline system", [
		"Writes go through one queue",
		"  The queue is per space",
		"Reads are bounded",
		"A quiet leaf",
	]);
	await seed(projectSpace, "Race conditions", ["Known races"]);
	const sessionId = generateId();
	await db.insert(narrators).values({
		id: sessionId,
		title: "Fix the refresh race",
		ownerUserId: alice,
		visibility: "private",
		contextProjectId: main.id,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	sessionSpace = (await ensureSessionSpace(sessionId)).id;
	tasks = await seed(sessionSpace, "Tasks", TASK_LINES);
	const big = await project("Big");
	bigSpace = big.space;
	long = {
		id: (
			await write(bigSpace, [{ op: "insert", parent: null, content: "A long level" }])
		)[0] as string,
	};
	await fill(bigSpace, long.id, "Entry", 2300);
	tenK = {
		id: (
			await write(bigSpace, [{ op: "insert", parent: null, content: "Ten thousand" }])
		)[0] as string,
	};
	const parents = await fill(bigSpace, tenK.id, "Chapter", 56);
	for (const parent of parents) await fill(bigSpace, parent, "Line", 180);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 600_000);

beforeEach(async () => {
	settings.outline.enabled = true;
	// Every case starts from the default folding.
	await db.delete(outlineFoldState).where(eq(outlineFoldState.userId, alice));
});

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function openView(
	options: Omit<Parameters<typeof Fixture.open>[0], "user">,
	viewport: { width: number; height: number } = { width: 1100, height: 900 },
): Promise<Page & { requests: string[] }> {
	const context = await browser.createBrowserContext();
	const page = (await context.newPage()) as Page & { requests: string[] };
	await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
	page.requests = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/outline/")) page.requests.push(url.pathname + url.search);
	});
	await page.goto(server.url.origin);
	await page.evaluate((value) => localStorage.setItem("narrafork_token", value), alice);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate((opts) => (window as unknown as FixtureWindow).fixture.open(opts), {
		...options,
		user: alice,
	});
	return page;
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
			timeout: 20_000,
			polling: 50,
		});
	} catch (error) {
		const text = await page.evaluate(() => document.body.innerText.slice(0, 2500));
		throw new Error(`timed out waiting for ${what}: ${String(error)}\n--- page ---\n${text}`);
	}
}

const hasRow = (f: typeof Fixture, title: string) => f.rows().some((r) => r.title === title);

async function open(page: Page, ...titles: string[]) {
	for (const title of titles) {
		await until(page, title, hasRow, title);
		expect(await call(page, (f, t: string) => f.toggle(t), title)).toBe(true);
	}
}

async function shot(page: Page, name: string, fullPage = true) {
	if (!SHOTS) return;
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

test("the home is one tree of spaces and their top-level blocks; nothing is a page", async () => {
	const page = await openView({ target: { kind: "home" } });
	await until(page, "the project row", hasRow, "NarraFork");
	let rows = await call(page, (f) => f.rows());
	expect(rows.map((r) => r.title)).toEqual(
		["My notes", "NarraFork", "Big"].sort(
			(a, b) => rows.findIndex((r) => r.title === a) - rows.findIndex((r) => r.title === b),
		),
	);
	expect(rows.every((r) => !r.open && r.kind === "space")).toBe(true);
	await shot(page, "1-landing-home");
	await open(page, "NarraFork");
	await until(page, "a top-level block", hasRow, "Facts: the outline system");
	rows = await call(page, (f) => f.rows());
	const top = rows.filter((r) => r.kind === "block");
	// Top-level blocks: one line each, closed until opened, each with its arrow.
	expect(top.map((r) => r.title)).toEqual(["Facts: the outline system", "Race conditions"]);
	expect(top.every((r) => !r.open)).toBe(true);
	expect(rows.some((r) => r.kind === "page")).toBe(false);
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	expect(await call(page, (f) => f.count("[data-tree-kind=page], [data-tree-page]"))).toBe(0);
	expect((await call(page, (f) => f.text())).toLowerCase()).not.toContain("page");
	// Any block opens in place.
	await open(page, "Facts: the outline system");
	await until(page, "its children", hasRow, "Writes go through one queue");
	// … and what is open by default under it comes with the next read.
	await until(page, "the level below", hasRow, "The queue is per space");
	rows = await call(page, (f) => f.rows());
	expect(rows.find((r) => r.title === "Writes go through one queue")?.open).toBe(true);
	expect(await call(page, (f) => f.arrowOf("A quiet leaf"))).toBe("leaf");
	expect(await call(page, (f) => f.arrowOf("Writes go through one queue"))).toBe("arrow");
	expect(await call(page, (f) => f.hoverRules())).toEqual([]);
	await shot(page, "2-expanded");
	await page.browserContext().close();
}, 90_000);

test("levels load lazily, folded by default; the reader's folding is stored per block and survives a reload", async () => {
	await db.delete(outlineFoldState).where(eq(outlineFoldState.userId, alice));
	const page = await openView({ target: { kind: "space", spaceId: sessionSpace } });
	await until(page, "the top-level block", hasRow, "Tasks");
	// Nothing under it was read for the landing view but its one preview line.
	expect((await call(page, (f) => f.blockRows())).map((r) => r.text)).toEqual(["Tasks"]);
	await open(page, "Tasks");
	await until(page, "the open task", hasRow, "Add the concurrency regression test");
	await until(
		page,
		"a finished task's line",
		(f, id: string) => id in f.previews(),
		tasks.idOf("Reproduce the race"),
	);
	let rows = await call(page, (f) => f.blockRows());
	const fold = (text: string) => rows.find((r) => r.text === text)?.fold;
	// An open task shows its direct children, each closed; a finished one is its title and a line.
	expect(fold("Add the concurrency regression test")).toBe("open");
	expect(fold("Conclusion: a fake clock reproduces it reliably")).toBe("closed");
	expect(fold("Reproduce the race")).toBe("closed");
	expect(rows.some((r) => r.text === "Evidence: run.ts:784 delivery order")).toBe(false);
	const previews = await call(page, (f) => f.previews());
	expect(previews[tasks.idOf("Reproduce the race")]?.text).toBe(
		"Two tabs refreshing at once still accept the old token",
	);
	// The reader opens a finished task and closes the open one.
	expect(await call(page, (f) => f.toggle("Reproduce the race"))).toBe(true);
	await until(page, "its result", hasRow, "Two tabs refreshing at once still accept the old token");
	expect(await call(page, (f) => f.toggle("Add the concurrency regression test"))).toBe(true);
	await until(page, "the write", () => true);
	const stored = async () =>
		new Map(
			(
				await db
					.select({ id: outlineFoldState.blockId, open: outlineFoldState.open })
					.from(outlineFoldState)
					.where(
						and(eq(outlineFoldState.userId, alice), eq(outlineFoldState.spaceId, sessionSpace)),
					)
			).map((row) => [row.id, row.open]),
		);
	const deadline = Date.now() + 10_000;
	while ((await stored()).size < 3 && Date.now() < deadline) await Bun.sleep(50);
	expect(await stored()).toEqual(
		new Map([
			[tasks.id, true],
			[tasks.idOf("Reproduce the race"), true],
			[tasks.idOf("Add the concurrency regression test"), false],
		]),
	);
	await page.browserContext().close();

	// A reload (a new browser context): the same folding, read in one folded read.
	const again = await openView({ target: { kind: "space", spaceId: sessionSpace } });
	await until(
		again,
		"the stored folding",
		hasRow,
		"Two tabs refreshing at once still accept the old token",
	);
	rows = await call(again, (f) => f.blockRows());
	expect(rows.find((r) => r.text === "Tasks")?.fold).toBe("open");
	expect(rows.find((r) => r.text === "Reproduce the race")?.fold).toBe("open");
	expect(rows.find((r) => r.text === "Add the concurrency regression test")?.fold).toBe("closed");
	expect(again.requests.filter((r) => r.includes("/children")).length).toBe(0);
	await again.browserContext().close();
	await db.delete(outlineFoldState).where(eq(outlineFoldState.userId, alice));
}, 90_000);

test('a long level continues with "more" in place; past 2,000 children it is paged in place', async () => {
	const page = await openView({ target: { kind: "space", spaceId: bigSpace } });
	await open(page, "A long level");
	await until(page, "the first chunk", hasRow, "Entry 1");
	const loaded = () => call(page, (f) => f.forests()[0]?.rows ?? 0);
	const bottom = async () => {
		await call(page, (f) => f.scrollToY(10_000_000));
	};
	const first = await loaded();
	// 2 top-level rows, 200 entries, the "more" row.
	expect(first).toBe(2 + 200 + 1);
	await bottom();
	await until(page, "the more row", (f) => f.moreRows().some((r) => r.mode === "more"));
	expect(await call(page, (f) => f.useMore("more"))).toBe(true);
	await until(
		page,
		"the next chunk",
		(f, n: number) => (f.forests()[0]?.rows ?? 0) === n + 200,
		first,
	);
	// In place: the rows before it are still there, and nothing was read again from the start.
	expect(page.requests.filter((r) => r.includes("/subtree")).length).toBe(1);
	// On to the cap.
	for (let i = 0; i < 12; i++) {
		await bottom();
		await until(page, "a more or next row", (f) => f.moreRows().length > 0);
		if ((await call(page, (f) => f.moreRows())).some((r) => r.mode === "next")) break;
		const before = await loaded();
		expect(await call(page, (f) => f.useMore("more"))).toBe(true);
		await until(page, "more rows", (f, n: number) => (f.forests()[0]?.rows ?? 0) > n, before);
	}
	expect(await loaded()).toBe(2 + 2000 + 1);
	await shot(page, "7-long-level-cap", false);
	// The level is paged from here: the next window replaces this one.
	expect(await call(page, (f) => f.useMore("next"))).toBe(true);
	await until(page, "the next window", (f) => f.moreRows().some((r) => r.mode === "prev"));
	await until(page, "its rows", hasRow, "Entry 2001");
	expect(await loaded()).toBe(2 + 1 + 300);
	const prev = (await call(page, (f) => f.moreRows())).find((r) => r.mode === "prev");
	expect(prev?.text).toContain("2001");
	expect(prev?.text).toContain("2300");
	expect(await call(page, hasRow as never, "Entry 1")).toBe(false);
	await shot(page, "8-long-level-paged", false);
	// And back.
	expect(await call(page, (f) => f.useMore("prev"))).toBe(true);
	await until(page, "the first window", hasRow, "Entry 1");
	expect(await loaded()).toBe(2 + 2000 + 1);
	await page.browserContext().close();
}, 120_000);

test("a commit re-reads only the levels it concerns: a new sibling appears, a leaf gains its arrow", async () => {
	const page = await openView({ target: { kind: "space", spaceId: projectSpace } });
	await open(page, "Facts: the outline system");
	await until(page, "the leaf", hasRow, "A quiet leaf");
	expect(await call(page, (f) => f.arrowOf("A quiet leaf"))).toBe("leaf");
	// The watch is up for the open levels.
	await until(page, "the watch", (f) =>
		f.watchFrames().received.some((m) => m.type === "outline_watching"),
	);
	await until(
		page,
		"the open level watched",
		(f, id: string) =>
			f
				.watchFrames()
				.sent.some((m) => m.type === "outline_watch" && (m.levels as string[]).includes(id)),
		facts.id,
	);
	const sent = (await call(page, (f) => f.watchFrames())).sent.filter(
		(m) => m.type === "outline_watch",
	);
	expect(new Set(sent.map((m) => m.subscriptionId)).size).toBe(1);
	const before = page.requests.length;

	// Someone adds a sibling.
	await write(projectSpace, [{ op: "insert", parent: { id: facts.id }, content: "A new fact" }]);
	await until(page, "the new sibling", hasRow, "A new fact");
	// A leaf gains its first child: its row gets an arrow (the level it is in is told).
	await write(projectSpace, [
		{ op: "insert", parent: { id: facts.idOf("A quiet leaf") }, content: "No longer a leaf" },
	]);
	await until(page, "the arrow", (f) => f.arrowOf("A quiet leaf") === "arrow");
	// A change of text.
	await write(projectSpace, [
		{
			op: "update",
			block: { id: facts.idOf("Reads are bounded") },
			content: "Reads are bounded and paged",
		},
	]);
	await until(page, "the new text", hasRow, "Reads are bounded and paged");

	const after = page.requests.slice(before);
	// Levels were read again, by parent; the tree was never read again from its root.
	expect(after.filter((r) => r.includes("/subtree")).length).toBe(0);
	const levels = after.filter((r) => r.includes("/children"));
	expect(levels.length).toBeGreaterThan(0);
	expect(levels.every((r) => r.includes("parents="))).toBe(true);
	// Marks are asked for the screen, not per row.
	const marks = after.filter((r) => r.includes("/marks"));
	expect(marks.length).toBeLessThanOrEqual(4);
	const frames = await call(page, (f) => f.watchFrames());
	expect(frames.received.some((m) => m.type === "outline_watch_changed")).toBe(true);
	expect(frames.received.some((m) => m.type === "outline_watch_error")).toBe(false);

	// The socket drops and comes back: the set is sent again, and what changed meanwhile is read.
	await write(projectSpace, [{ op: "insert", parent: { id: facts.id }, content: "While away" }]);
	await call(page, (f) => f.reconnect());
	await until(page, "what changed meanwhile", hasRow, "While away");
	await page.browserContext().close();
}, 90_000);

test("locate: a request left by a focused view; the search as a tree by ancestor path", async () => {
	const deep = tasks.idOf("Evidence: run.ts:784 delivery order");
	const page = await openView({ target: { kind: "home" } });
	await until(page, "the tree", hasRow, "NarraFork");
	// The search, drawn as a tree: the space, the ancestors, the hit.
	expect(
		await call(page, (f) => f.type("[data-testid=outline-search-input]", "delivery order")),
	).toBe(true);
	await until(page, "the hit", (f, id: string) => f.searchRows().some((r) => r.hit === id), deep);
	const found = await call(page, (f) => f.searchRows());
	expect(found.map((r) => `${r.level} ${r.kind} ${r.title}`)).toEqual([
		"1 space Fix the refresh race",
		"2 block Tasks",
		"3 block Add the concurrency regression test",
		"4 block Conclusion: a fake clock reproduces it reliably",
		"5 block Evidence: run.ts:784 delivery order",
	]);
	await shot(page, "4-search-tree");
	// Choosing it shows it in the tree: what it is under opens, behind three closed rows.
	expect(await call(page, (f, id: string) => f.chooseHit(id), deep)).toBe(true);
	await until(
		page,
		"the located row",
		(f, id: string) => f.located()?.id === id && f.located()?.inView === true,
		deep,
	);
	expect(await call(page, (f) => f.treeShown())).toBe(true);
	const rows = await call(page, (f) => f.rows());
	expect(rows.find((r) => r.title === "Fix the refresh race")?.open).toBe(true);
	expect(
		rows.find((r) => r.title === "Conclusion: a fake clock reproduces it reliably")?.open,
	).toBe(true);
	// For this visit only: nothing was stored as the reader's folding.
	await Bun.sleep(700);
	expect(
		(await db.select().from(outlineFoldState).where(eq(outlineFoldState.userId, alice))).length,
	).toBe(0);
	await page.browserContext().close();

	// What cannot be located is said.
	const other = await openView({ target: { kind: "space", spaceId: projectSpace } });
	await until(other, "the tree", hasRow, "Race conditions");
	await call(other, (f, id: string) => f.chooseHit(id), "x");
	await other.browserContext().close();
}, 90_000);

test("the quick switcher jumps to any block by title, top-level blocks first", async () => {
	const page = await openView({ target: { kind: "space", spaceId: projectSpace } });
	await until(page, "the tree", hasRow, "Race conditions");
	expect(
		await call(page, (f) => f.key("[data-testid=outline-search-input]", "k", { ctrl: true })),
	).toBe(true);
	await until(page, "the switcher", (f) => f.count("[data-testid=outline-switcher]") === 1);
	expect(await call(page, (f) => f.type("[data-testid=outline-switcher-input]", "race"))).toBe(
		true,
	);
	await until(page, "hits", (f) => f.switcherHits().length >= 2);
	const hits = await call(page, (f) => f.switcherHits());
	// "Race conditions" is a top-level block of this space: before "Known races" under it.
	expect(hits[0]?.text).toContain("Race conditions");
	expect(hits.findIndex((h) => h.text.includes("Known races"))).toBeGreaterThan(0);
	expect(
		hits
			.map((h) => h.text)
			.join(" ")
			.toLowerCase(),
	).not.toContain("page");
	const target = hits[0]?.id as string;
	expect(await call(page, (f) => f.key("[data-testid=outline-switcher-input]", "Enter"))).toBe(
		true,
	);
	await until(page, "the jump", (f) => f.navigated().length > 0);
	expect((await call(page, (f) => f.navigated())).at(-1)).toMatchObject({
		kind: "block",
		spaceId: projectSpace,
		blockId: target,
	});
	await page.browserContext().close();
}, 60_000);

test("10,000 loaded rows scroll with a bounded DOM", async () => {
	const page = await openView({ target: { kind: "space", spaceId: bigSpace } });
	await open(page, "Ten thousand");
	await until(page, "its chapters", hasRow, "Chapter 1");
	// Everything inside it: the chapters past the reader's budget are read too.
	expect(await call(page, (f) => f.toggle("Ten thousand", true))).toBe(true);
	await page.waitForFunction(
		() => ((window as unknown as FixtureWindow).fixture.forests()[0]?.rows ?? 0) >= 10_000,
		{ timeout: 120_000, polling: 200 },
	);
	const loaded = await call(page, (f) => f.forests()[0]?.rows ?? 0);
	await call(page, (f) => f.measureScroll(40));
	const before = page.requests.length;
	const measured = await call(page, (f) => f.measureScroll(240));
	// Marks are asked once per screen, debounced: scrolling past 10,000 rows is a handful of
	// reads, never one per row or per frame; nothing else is read again.
	// Back to the top, where the chapters' rows are on screen: the marks of what is now in
	// view are read (once the scroll stops: debounced; waited for, bounded).
	await call(page, (f) => f.scrollToY(0));
	const deadline = Date.now() + 10_000;
	while (!page.requests.slice(before).some((r) => r.includes("/marks")) && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 50));
	const during = page.requests.slice(before);
	const marks = during.filter((r) => r.includes("/marks")).length;
	console.log(`[forest perf] requests while scrolling: ${during.length} (marks ${marks})`);
	expect(marks).toBeGreaterThanOrEqual(1);
	expect(marks).toBeLessThanOrEqual(12);
	expect(during.filter((r) => r.includes("/children") || r.includes("/subtree")).length).toBe(0);
	console.log(
		`[forest perf] rows=${loaded} scrollHeight=${measured.height}px frames=${measured.frames} ` +
			`frame p50=${measured.p50.toFixed(1)}ms p95=${measured.p95.toFixed(1)}ms max=${measured.max.toFixed(1)}ms ` +
			`maxDomNodes=${measured.maxDom} maxDrawnRows=${measured.maxRows} blankFrames=${measured.blank}`,
	);
	expect(loaded).toBeGreaterThanOrEqual(10_000);
	// The window, not the tree: a couple of screens of rows whatever is loaded.
	expect(measured.maxRows).toBeLessThan(160);
	expect(measured.maxDom).toBeLessThan(4000);
	expect(measured.blank).toBe(0);
	// Generous: a shared CI machine; the printed line is the measurement.
	expect(measured.p50).toBeLessThan(50);
	await page.browserContext().close();
}, 240_000);

test("a focused block is the same list with one root, its ancestors above; 「编辑」 and F2 enter editing", async () => {
	const focused = tasks.idOf("Add the concurrency regression test");
	const page = await openView({
		target: { kind: "block", spaceId: sessionSpace, blockId: focused, view: "all" },
		follow: true,
	});
	await until(page, "its children", hasRow, "Conclusion: a fake clock reproduces it reliably");
	const rows = await call(page, (f) => f.rows());
	// The root is the heading, not a row; its children are the first level.
	expect(rows.map((r) => `${r.level} ${r.title}`)).toEqual([
		"1 Conclusion: a fake clock reproduces it reliably",
		"1 Wire into the 4 CI shards",
	]);
	const text = await call(page, (f) => f.text());
	expect(text).toContain("Add the concurrency regression test");
	// The path of its ancestors: the space, then the top-level block.
	const crumbs = await page.$eval("[data-testid=outline-crumbs]", (nav) => nav.textContent ?? "");
	expect(crumbs).toContain("Fix the refresh race");
	expect(crumbs).toContain("Tasks");
	expect(await call(page, (f) => f.count("[data-testid=outline-enter-edit]"))).toBe(1);
	await shot(page, "3-focused-block");
	// A bullet focuses a block: the same view, one level down.
	expect(await call(page, (f) => f.click("[data-block-id] a[data-tree-title]"))).toBe(true);
	await until(page, "the focus", (f) => f.navigated().length > 0);
	expect((await call(page, (f) => f.navigated())).at(-1)).toMatchObject({
		kind: "block",
		blockId: tasks.idOf("Conclusion: a fake clock reproduces it reliably"),
	});
	await until(page, "the new root's children", hasRow, "Evidence: run.ts:784 delivery order");
	// F2 enters editing; 「完成」 comes back to reading.
	expect(await call(page, (f) => f.key("[data-testid=outline-surface]", "F2"))).toBe(true);
	await until(
		page,
		"the editor's control",
		(f) => f.count("[data-testid=outline-leave-edit]") === 1,
	);
	expect(await call(page, (f) => f.click("[data-testid=outline-leave-edit]"))).toBe(true);
	await until(page, "reading again", (f) => f.count("[data-testid=outline-enter-edit]") === 1);
	await until(page, "the list again", hasRow, "Evidence: run.ts:784 delivery order");
	await page.browserContext().close();
}, 90_000);

test("in Chinese, dark, at 360 px: the same forest, nothing wider than the screen, no 页", async () => {
	const page = await openView(
		{ target: { kind: "space", spaceId: sessionSpace }, lang: "zh-CN", scheme: "dark" },
		{ width: 360, height: 760 },
	);
	await open(page, "Tasks");
	await until(page, "the open task", hasRow, "Add the concurrency regression test");
	await open(page, "Conclusion: a fake clock reproduces it reliably");
	await until(page, "a deep row", hasRow, "Evidence: run.ts:784 delivery order");
	expect(await call(page, (f) => f.overflowsX())).toBe(false);
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	const text = await call(page, (f) => f.text());
	expect(text).not.toContain("页");
	expect(text).toContain("箭头就地展开阅读");
	await shot(page, "5-phone-dark-zh");
	await page.browserContext().close();

	const light = await openView(
		{ target: { kind: "space", spaceId: projectSpace } },
		{ width: 360, height: 760 },
	);
	await open(light, "Facts: the outline system");
	await until(light, "its children", hasRow, "Writes go through one queue");
	expect(await call(light, (f) => f.overflowsX())).toBe(false);
	await shot(light, "5-phone-light");
	await light.browserContext().close();

	await db.delete(outlineFoldState).where(eq(outlineFoldState.userId, alice));
	const dark = await openView({ target: { kind: "home" }, scheme: "dark" });
	await open(dark, "NarraFork", "Facts: the outline system");
	await until(dark, "its children", hasRow, "Writes go through one queue");
	await shot(dark, "6-dark");
	await dark.browserContext().close();
}, 90_000);

// ── Coverage of the old tree, ported (space rows, keys, scroll, locate past the first page) ──

async function session(title: string, owner: string, projectId: string, visibility: string) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: visibility as "private",
		writeAudience: "owner",
		contextProjectId: projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return (await ensureSessionSpace(id)).id;
}

let atlas: { space: string; race: string; notes: string } | null = null;

/** A project with a summary line, a session of the reader's and a readable one of Bob's. */
async function seedAtlas() {
	if (atlas) return atlas;
	const bob = generateId();
	await db
		.insert(users)
		.values({ id: bob, username: "bob", passwordHash: "x", role: "user", createdAt: NOW });
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Atlas",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const space = (await ensureProjectSpace(projectId)).id;
	await write(space, [
		{
			op: "insert",
			parent: null,
			content: "Outline phase two: tasks and teams",
			alias: "summary",
		},
	]);
	const spike = await session("Bob's spike", bob, projectId, "project");
	await writeOutline({
		spaceId: spike,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Measure the cold start",
				task: { status: "doing" },
			},
		],
		actor: { kind: "human", id: bob },
		responsibleUserId: bob,
	});
	const race = await session("Fix the refresh race", alice, projectId, "private");
	const ids = await write(race, [
		{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
		{ op: "insert", parent: { tempId: "p" }, content: "Write the fix", task: { status: "doing" } },
		{
			op: "insert",
			parent: { tempId: "p" },
			content: "Which token wins?",
			ask: { to: { kind: "human", id: alice }, recommend: {} },
		},
		{
			op: "insert",
			parent: { tempId: "p" },
			content: "Ship on Friday?",
			ask: { to: { kind: "human", id: alice }, recommend: {} },
		},
		{ op: "insert", tempId: "n", parent: null, content: "Notes" },
		{ op: "insert", tempId: "f", parent: { tempId: "n" }, content: "Refresh flow" },
		{
			op: "insert",
			parent: { tempId: "f" },
			content: "Rotate the token",
			task: { status: "todo" },
		},
		{
			op: "insert",
			parent: { tempId: "f" },
			content: "Retry the refresh",
			task: { status: "doing" },
		},
		{ op: "insert", parent: { tempId: "f" }, content: "Document it", task: { status: "todo" } },
	] as OutlineOp[]);
	atlas = { space, race, notes: ids[4] as string };
	return atlas;
}

test("a space's row: what waits for the reader first, what is in progress, one line, read only", async () => {
	await seedAtlas();
	const page = await openView({ target: { kind: "home" } });
	await open(page, "Atlas");
	await until(page, "the sessions group", (f) =>
		f.rows().some((r) => r.kind === "group" && r.title.startsWith("Sessions")),
	);
	const group = (await call(page, (f) => f.rows())).find(
		(r) => r.kind === "group" && r.title.startsWith("Sessions"),
	);
	await open(page, group?.title as string);
	await until(page, "the sessions", hasRow, "Bob's spike");
	const by = new Map((await call(page, (f) => f.glance())).map((row) => [row.title, row]));
	const race = by.get("Fix the refresh race");
	expect(race?.waiting).toContain("2");
	expect(Number(race?.doing)).toBeGreaterThanOrEqual(1);
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
	expect(await call(page, (f) => f.arrowsDrawn())).toBe(true);
	await shot(page, "7-space-rows");
	// "Waiting for you" shows the first question in the tree, with its form.
	expect(await call(page, (f) => f.click("button[data-tree-count=waiting]"))).toBe(true);
	await until(page, "a question located", (f) => f.located() !== null);
	await until(
		page,
		"its answer form",
		(f) => f.count("[data-testid=outline-tree-questions]") === 1,
	);
	await page.browserContext().close();
}, 90_000);

test('"in progress · N" opens the list of which tasks, read when it opens', async () => {
	const seeded = await seedAtlas();
	const page = await openView({
		target: { kind: "block", spaceId: seeded.race, blockId: seeded.notes, view: "facts" },
	});
	await until(page, "the fact", hasRow, "Refresh flow");
	await until(page, "its count", (f) => f.count("[data-testid=outline-in-progress]") === 1);
	expect(page.requests.some((r) => r.includes("/open-tasks"))).toBe(false);
	expect(await call(page, (f) => f.click("[data-testid=outline-in-progress]"))).toBe(true);
	await until(page, "the list", (f) => f.inProgressItems().length === 3);
	const items = await call(page, (f) => f.inProgressItems());
	// In progress first.
	expect(items[0]).toContain("Retry the refresh");
	expect(items.slice(1).sort()).toEqual(["Document it", "Rotate the token"]);
	expect(page.requests.filter((r) => r.includes("/open-tasks")).length).toBe(1);
	// (Once the dropdown's transition has ended.)
	await page.waitForFunction(() => {
		const list = document.querySelector("[data-testid=outline-in-progress-list]");
		return !!list && getComputedStyle(list).opacity === "1";
	});
	await shot(page, "8-in-progress-list", false);
	await page.browserContext().close();
}, 90_000);

test("the keyboard: the tree is one tab stop; the arrow keys move between rows, open and close", async () => {
	const page = await openView({ target: { kind: "space", spaceId: projectSpace } });
	await open(page, "Facts: the outline system");
	await until(page, "the level below", hasRow, "The queue is per space");
	await until(page, "one tab stop", (f) => f.tabStops().every((n) => n === 1));
	// (An earlier case edited and added rows here: the order is read, not assumed.)
	const titles = (await call(page, (f) => f.rows())).map((r) => r.title);
	const from = titles.indexOf("Writes go through one queue");
	expect(titles[from + 1]).toBe("The queue is per space");
	const third = titles[from + 2] as string;
	expect(await call(page, (f) => f.focusTitle("Writes go through one queue"))).toBe(true);
	const active = () => call(page, (f) => f.activeRow());
	await page.keyboard.press("ArrowDown");
	expect(await active()).toBe("The queue is per space");
	await page.keyboard.press("ArrowDown");
	expect(await active()).toBe(third);
	// A leaf: ← goes to the row it is under.
	await page.keyboard.press("ArrowLeft");
	expect(await active()).toBe("Facts: the outline system");
	// Open: ← closes it, → opens it again.
	await page.keyboard.press("ArrowLeft");
	await until(page, "closed", (f, t: string) => !f.rows().some((r) => r.title === t), third);
	await page.keyboard.press("ArrowRight");
	await until(page, "open again", hasRow, third);
	await page.keyboard.press("End");
	expect(await active()).not.toBe("Facts: the outline system");
	// Still one stop: the row the reader is on.
	await until(page, "one tab stop", (f) => f.tabStops().every((n) => n === 1));
	await page.keyboard.press("Home");
	expect(await active()).toBe("Facts: the outline system");
	await page.browserContext().close();
}, 90_000);

test("the tree comes back where the reader left it", async () => {
	const page = await openView({ target: { kind: "home" } }, { width: 900, height: 500 });
	await open(page, "Big", "A long level");
	await until(page, "the long level", hasRow, "Entry 10");
	await call(page, (f) => f.scrollToY(700));
	await until(page, "scrolled", (f) => f.scrollY() >= 600);
	const before = await call(page, (f) => f.topRow());
	expect(before?.key.startsWith("block:")).toBe(true);
	// Away (a space), and back.
	await page.evaluate(
		(spaceId) =>
			(window as unknown as FixtureWindow).fixture.open({
				target: { kind: "space", spaceId },
				user: "",
			}),
		projectSpace,
	);
	await until(page, "the space", hasRow, "Facts: the outline system");
	expect(await call(page, (f) => f.storedAnchor())).not.toBeNull();
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.open({ target: { kind: "home" }, user: "" }),
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
}, 90_000);

test("the keyboard reaches a row's counts: 「in progress」 and 「waiting for you」 open from it", async () => {
	const seeded = await seedAtlas();
	const page = await openView({
		target: { kind: "block", spaceId: seeded.race, blockId: seeded.notes, view: "facts" },
	});
	await until(page, "the count", (f) => f.count("[data-testid=outline-in-progress]") === 1);
	expect(await call(page, (f) => f.focusTitle("Refresh flow"))).toBe(true);
	await page.keyboard.press("ArrowDown");
	expect(await call(page, (f) => f.activeControl())).toBe("outline-in-progress");
	await page.keyboard.press("Enter");
	await until(page, "the list", (f) => f.inProgressItems().length === 3);
	await page.keyboard.press("Escape");
	await until(page, "closed", (f) => f.count("[data-testid=outline-in-progress-list]") === 0);
	expect(await call(page, (f) => f.activeControl())).toBe("outline-in-progress");
	await page.browserContext().close();

	const home = await openView({ target: { kind: "home" } });
	await open(home, "Atlas");
	await until(home, "the sessions group", (f) =>
		f.rows().some((r) => r.kind === "group" && r.title.startsWith("Sessions")),
	);
	const group = (await call(home, (f) => f.rows())).find(
		(r) => r.kind === "group" && r.title.startsWith("Sessions"),
	);
	await open(home, group?.title as string);
	await until(home, "the session", hasRow, "Fix the refresh race");
	expect(await call(home, (f) => f.focusTitle("Fix the refresh race"))).toBe(true);
	await home.keyboard.press("ArrowDown");
	expect(await call(home, (f) => f.activeControl())).toBe("count:waiting");
	await home.keyboard.press("Enter");
	await until(home, "a question located", (f) => f.located() !== null);
	await until(
		home,
		"its answer form",
		(f) => f.count("[data-testid=outline-tree-questions]") === 1,
	);
	await home.browserContext().close();
}, 90_000);

test("answering in the tree's form closes it; the tree did not leave itself", async () => {
	await seedAtlas();
	const page = await openView({ target: { kind: "home" } });
	await open(page, "Atlas");
	await until(page, "the sessions group", (f) =>
		f.rows().some((r) => r.kind === "group" && r.title.startsWith("Sessions")),
	);
	const group = (await call(page, (f) => f.rows())).find(
		(r) => r.kind === "group" && r.title.startsWith("Sessions"),
	);
	await open(page, group?.title as string);
	await until(page, "the waiting count", (f) => f.count("button[data-tree-count=waiting]") === 1);
	expect(await call(page, (f) => f.click("button[data-tree-count=waiting]"))).toBe(true);
	await until(
		page,
		"the answer form",
		(f) => f.count("[data-testid=outline-tree-questions] textarea") >= 1,
	);
	await call(page, (f) =>
		f.typeAll("[data-testid=outline-tree-questions] textarea", "The newer one, always"),
	);
	await until(
		page,
		"submit enabled",
		(f) => f.count("[data-testid=outline-questions-submit]:not(:disabled)") === 1,
	);
	expect(await call(page, (f) => f.click("[data-testid=outline-questions-submit]"))).toBe(true);
	await until(page, "the form gone", (f) => f.count("[data-testid=outline-tree-questions]") === 0);
	expect(await call(page, (f) => f.navigated().length)).toBe(0);
	await page.browserContext().close();
}, 90_000);

test("a session is located although its project is past the first page of the root", async () => {
	// Thirty projects committed to later: the root's first page ends before NarraFork.
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
		await write(space.id, [{ op: "insert", parent: null, content: "Notes" }]);
	}
	const first = await openView({ target: { kind: "home" } });
	await until(first, "a filler", hasRow, "Filler 30");
	const listed = (await call(first, (f) => f.rows())).map((r) => r.title);
	await first.browserContext().close();
	const page = await openView({ target: { kind: "space", spaceId: projectSpace } });
	await until(page, "a top-level block", hasRow, "Facts: the outline system");
	await call(
		page,
		(f, target: Parameters<typeof Fixture.requestLocate>[0]) => f.requestLocate(target),
		{ spaceId: sessionSpace, blockId: tasks.idOf("Wire into the 4 CI shards") },
	);
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.open({ target: { kind: "home" }, user: "" }),
	);
	await until(
		page,
		"the block located",
		(f, id: string) => f.located()?.id === id,
		tasks.idOf("Wire into the 4 CI shards"),
	);
	const rows = await call(page, (f) => f.rows());
	// Its project is shown (pinned first among the projects), once; it was not on the first page.
	expect(rows.filter((r) => r.title === "NarraFork")).toHaveLength(1);
	expect(listed).not.toContain("NarraFork");
	expect(await call(page, (f) => f.count("[data-testid=outline-locate-failed]"))).toBe(0);
	await page.browserContext().close();
}, 120_000);
