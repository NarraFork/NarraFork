/**
 * The history of any block (pageless outline, F2), in Chromium, against a test server running
 * the real outline routes (H2's timeline, H3's diff / restore / move-back) on the isolated
 * SQLite of `tests/preload.ts`. No pages anywhere: every case is on a block's subtree, or on
 * the whole space.
 *
 *   - the timeline of a block's subtree is paged ("load older"), and the side panel lists the
 *     same commits; picking a point shows the forest read only as of then, under a bar that
 *     says so, and "Back to now" returns;
 *   - the comparison lists added / deleted / moved in / moved away / changed rows with what
 *     changed, pages with "more", compares two points, and marks the rows of the forest as of
 *     then;
 *   - a restore previews its change list (grouped; what moves out takes its blocks along; what
 *     moved away is listed with its own "Move back"), confirms, and ends in its result; the
 *     outline is then as owner rule D58 says;
 *   - "Move back" puts a moved-away block back and the list is worked out again;
 *   - someone changing the subtree after the preview: 409, said plainly, previewed again;
 *   - a reader who may not write sees the timeline and the comparison, never a restore;
 *   - the history not ready: said, not a wrong tree;
 *   - the whole space's history from the space's own page;
 *   - Chinese, dark, 360 px: nothing wider than the screen, no "页", no hover rules.
 *
 * NF_HISTORY_SHOTS=<dir> also writes screenshots (device scale 2) there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../../server/db";
import { outlineSpaces, projects, users } from "../../../../server/db/schema";
import { buildAppErrorResponse } from "../../../../server/lib/app-error-response";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import { ensureProjectSpace } from "../../../../server/services/outline/spaces";
import { outlineStore } from "../../../../server/services/outline/store";
import { type OutlineOp, writeOutline } from "../../../../server/services/outline/write";
import {
	handleOutlineBlockMessage,
	type OutlineBlockSocket,
	releaseOutlineBlockSubscriptions,
} from "../../../../server/websocket/outline-block-ws";
import type * as Fixture from "./outline-history.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const SHOTS = process.env.NF_HISTORY_SHOTS;
const NOW = "2026-11-16T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let bob: string;
let spaceId: string;
let scenarios = 0;

async function write(ops: OutlineOp[], user = alice) {
	const result = await writeOutline({
		spaceId,
		ops,
		actor: { kind: "human", id: user },
		responsibleUserId: user,
	});
	return { ids: result.results.map((r) => r.blockId as string), seq: result.commit?.seq ?? 0 };
}

/**
 * A subtree with a history: at `then`, R holds Alpha, Beta, Gamma; E (elsewhere) holds Xray
 * (with a child). After `then`: Alpha's text changes, Delta is added, Gamma moves to E, Xray
 * moves into R, Beta is deleted.
 */
async function scenario() {
	const n = ++scenarios;
	const made = await write([
		{ op: "insert", tempId: "r", parent: null, content: `Plan ${n}` },
		{ op: "insert", tempId: "a", parent: { tempId: "r" }, content: "Alpha" },
		{ op: "insert", tempId: "b", parent: { tempId: "r" }, content: "Beta" },
		{ op: "insert", tempId: "c", parent: { tempId: "r" }, content: "Gamma" },
		{ op: "insert", tempId: "e", parent: null, content: `Elsewhere ${n}` },
		{ op: "insert", tempId: "x", parent: { tempId: "e" }, content: "Xray" },
		{ op: "insert", tempId: "y", parent: { tempId: "x" }, content: "Xray child" },
	]);
	const [r, a, b, c, e, x, y] = made.ids as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	const then = made.seq;
	await write([{ op: "update", block: { id: a }, content: "Alpha v2" }]);
	const d = (await write([{ op: "insert", parent: { id: r }, content: "Delta" }])).ids[0] as string;
	await write([{ op: "move", block: { id: c }, parent: { id: e } }]);
	await write([{ op: "move", block: { id: x }, parent: { id: r } }]);
	const last = await write([{ op: "delete", block: { id: b } }]);
	return { r, a, b, c, d, e, x, y, then, last: last.seq };
}

function api() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
		c.set("user", { sub: token, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) =>
			buildAppErrorResponse(error, c) ?? Response.json({ error: String(error) }, { status: 500 }),
	);
	app.get("/api/settings", (c) => c.json({ outline: { enabled: true } }));
	app.route("/api/outline", outlineRoutes);
	return app;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-history.browser-fixture.tsx", import.meta.url).pathname],
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
	bob = generateId();
	await db.insert(users).values([
		{ id: alice, username: "alice", passwordHash: "x", role: "user", createdAt: NOW },
		{ id: bob, username: "bob", passwordHash: "x", role: "user", createdAt: NOW },
	]);
	// A public project: bob reads it, only alice (its owner) writes it.
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "History",
		ownerUserId: alice,
		visibility: "public",
		createdAt: NOW,
		updatedAt: NOW,
	});
	spaceId = (await ensureProjectSpace(projectId)).id;
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function openView(
	options: Omit<Parameters<typeof Fixture.open>[0], "user">,
	viewport: { width: number; height: number } = { width: 1100, height: 900 },
	user = alice,
): Promise<Page> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
	await page.goto(server.url.origin);
	await page.evaluate((value) => localStorage.setItem("narrafork_token", value), user);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate((opts) => (window as unknown as FixtureWindow).fixture.open(opts), {
		follow: true,
		...options,
		user,
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
		const text = await page.evaluate(
			() =>
				`${document.body.innerText.slice(0, 3000)}\nticks: ${JSON.stringify((window as unknown as FixtureWindow).fixture.ticks())}`,
		);
		throw new Error(`timed out waiting for ${what}: ${String(error)}\n--- page ---\n${text}`);
	}
}

const titles = (f: typeof Fixture) => f.rows().map((r) => r.title);
const hasRow = (f: typeof Fixture, title: string) => f.rows().some((r) => r.title === title);

async function shot(page: Page, name: string, fullPage = true) {
	if (!SHOTS) return;
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

async function focus(s: { r: string }, user = alice, asOf?: number) {
	const page = await openView(
		{
			target: { kind: "block", spaceId, blockId: s.r, view: "all", ...(asOf ? { asOf } : {}) },
		},
		undefined,
		user,
	);
	return page;
}

/** Open the restore dialog from a view as of a point and wait for its change list. */
async function preview(page: Page) {
	expect(await call(page, (f) => f.clickTestId("outline-history-restore"))).toBe(true);
	await until(page, "the change list", (f) => f.restorePhase() === "preview");
	await until(page, "the dialog shown", (f) => f.dialogSettled());
}

test("the timeline of a block's subtree is paged; a point shows the forest as of then; back to now", async () => {
	const s = await scenario();
	// More commits under it than one page of the timeline holds (50).
	for (let i = 0; i < 55; i++)
		await write([{ op: "update", block: { id: s.d }, content: `Delta ${i}` }]);
	// A commit elsewhere is not on this block's timeline.
	const outside = await write([{ op: "update", block: { id: s.e }, content: "Elsewhere, edited" }]);
	const page = await focus(s);
	await until(page, "the subtree now", hasRow, "Delta 54");
	await until(page, "the timeline", (f) => f.ticks().seqs.length > 0);
	let ticks = await call(page, (f) => f.ticks());
	expect(ticks.seqs).toHaveLength(50);
	expect(ticks.seqs).not.toContain(outside.seq);
	// Showing now: the newest is current.
	expect(ticks.current).toBe(ticks.seqs.at(-1) ?? -1);
	// Older commits load on demand, down to the block's creation.
	expect(
		await call(page, (f) =>
			f.click('[data-testid=outline-timeline] button[aria-label="Load older commits"]'),
		),
	).toBe(true);
	await until(page, "older commits", (f, then: number) => f.ticks().seqs.includes(then), s.then);
	ticks = await call(page, (f) => f.ticks());
	expect(ticks.seqs[0]).toBe(s.then);
	expect(ticks.seqs).toHaveLength(61);
	await shot(page, "1-timeline");

	// The side panel lists the same commits, newest first, paged.
	expect(await call(page, (f) => f.clickText("History"))).toBe(true);
	await until(page, "the side panel's history", (f) => f.historyItems().length > 0);
	const items = await call(page, (f) => f.historyItems());
	expect(items[0]).toBe(ticks.seqs.at(-1) ?? -1);
	expect([...items].sort((x, y) => x - y)).toEqual(ticks.seqs.slice(-items.length));

	// Pick the point before everything changed: the forest as of then, read only, under the bar.
	expect(await call(page, (f, seq: number) => f.clickTick(seq), s.then)).toBe(true);
	await until(page, "the bar", (f) => f.bar() !== null);
	expect(await call(page, (f) => f.bar())).toMatchObject({
		banner: `Viewing history: as it was at #${s.then}`,
		restore: true,
		compare: true,
	});
	await until(page, "the subtree as of then", hasRow, "Beta");
	expect(await call(page, titles)).toEqual(["Alpha", "Beta", "Gamma"]);
	expect(await call(page, (f) => f.ticks().current)).toBe(s.then);
	// Read only: no way into editing.
	expect(await call(page, (f) => f.count("[data-testid=outline-enter-edit]"))).toBe(0);
	expect((await call(page, (f) => f.navigated())).at(-1)).toMatchObject({
		kind: "block",
		blockId: s.r,
		asOf: s.then,
	});
	await shot(page, "2-as-of");

	// Back to now.
	expect(await call(page, (f) => f.clickTestId("outline-history-now"))).toBe(true);
	await until(page, "now again", (f) => f.bar() === null);
	await until(page, "the subtree now", hasRow, "Delta 54");
	expect((await call(page, (f) => f.navigated())).at(-1)?.asOf).toBeUndefined();
	await page.browserContext().close();
}, 120_000);

test("the comparison lists what changed, with what, pages, compares two points, and marks the forest as of then", async () => {
	const s = await scenario();
	const page = await focus(s, alice, s.then);
	await until(page, "the subtree as of then", hasRow, "Gamma");
	expect(await call(page, (f) => f.clickTestId("outline-history-compare"))).toBe(true);
	await until(page, "the comparison", (f) => f.diffEntries().length >= 5);
	const entries = await call(page, (f) => f.diffEntries());
	const kindOf = Object.fromEntries(entries.map((e) => [e.id, e.kind]));
	expect(kindOf).toEqual({
		[s.a]: "changed",
		[s.b]: "removed",
		[s.c]: "moved-away",
		[s.d]: "added",
		[s.x]: "moved-in",
	});
	// What came along with a moved-in block is not listed: it came with it.
	expect(entries.some((e) => e.id === s.y)).toBe(false);
	const alpha = entries.find((e) => e.id === s.a);
	expect(alpha?.fields).toBe("text");
	expect(alpha?.text).toContain("Alpha v2");
	expect(alpha?.text).toContain("Then");
	// The rows of the forest as of then that the comparison names are marked (icons, not text).
	await until(page, "the marks", (f) => Object.keys(f.forestMarks()).length === 3);
	expect(await call(page, (f) => f.forestMarks())).toEqual({
		[s.a]: "changed",
		[s.b]: "removed",
		[s.c]: "moved-away",
	});
	expect(await call(page, (f) => f.count("[data-testid=outline-diff-mark] svg"))).toBeGreaterThan(
		5,
	);
	await shot(page, "3-diff");

	// Two points: from then to the commit that added Delta (Alpha's edit and Delta only).
	expect(await call(page, (f, seq: number) => f.compareWith(String(seq)), s.then + 2)).toBe(true);
	await until(page, "the shorter comparison", (f) => f.diffEntries().length === 2);
	expect((await call(page, (f) => f.diffEntries())).map((e) => e.kind).sort()).toEqual([
		"added",
		"changed",
	]);
	expect(await call(page, (f) => f.text())).toContain(
		`What changed from #${s.then} to #${s.then + 2}`,
	);
	await page.browserContext().close();

	// A long comparison pages: 130 blocks added under a fresh block.
	const big = await write([{ op: "insert", parent: null, content: "Big list" }]);
	const bigId = big.ids[0] as string;
	await write(
		Array.from({ length: 130 }, (_, i) => ({
			op: "insert" as const,
			parent: { id: bigId },
			content: `Item ${i}`,
		})),
	);
	const long = await focus({ r: bigId }, alice, big.seq);
	await until(long, "the bar", (f) => f.bar() !== null);
	expect(await call(long, (f) => f.clickTestId("outline-history-compare"))).toBe(true);
	// A page holds what one bounded read found (at most 100 entries); "more" reads on.
	await until(long, "the first page", (f) => f.has("[data-testid=outline-diff-more]"));
	const first = (await call(long, (f) => f.diffEntries())).length;
	expect(first).toBeGreaterThan(0);
	expect(first).toBeLessThanOrEqual(100);
	for (let i = 0; i < 10; i++) {
		if (!(await call(long, (f) => f.has("[data-testid=outline-diff-more]")))) break;
		const shown = (await call(long, (f) => f.diffEntries())).length;
		expect(await call(long, (f) => f.clickTestId("outline-diff-more"))).toBe(true);
		await until(
			long,
			"the next page",
			(f, n: number) => f.diffEntries().length > n || !f.has("[data-testid=outline-diff-more]"),
			shown,
		);
	}
	await until(long, "all of it", (f) => f.diffEntries().length === 130);
	expect(await call(long, (f) => f.has("[data-testid=outline-diff-more]"))).toBe(false);
	await long.browserContext().close();
}, 120_000);

test("restore: the change list first, then confirm, then the result; the subtree is as it was (D58)", async () => {
	const s = await scenario();
	const page = await focus(s, alice, s.then);
	await until(page, "the subtree as of then", hasRow, "Gamma");
	await preview(page);
	const groups = await call(page, (f) => f.restoreGroups());
	expect(groups.map((g) => [g.group, g.entries.map((e) => e.id)])).toEqual([
		["delete", [s.d]],
		["restore", [s.b]],
		["move-out", [s.x]],
		["put-back", [s.a]],
		["moved-away", [s.c]],
	]);
	// What moves out takes what is under it along, and says so.
	expect(groups[2]?.entries[0]?.text).toContain("takes the 1 block under it along");
	// What moved away is listed only, with its own "Move back".
	expect(await call(page, (f) => f.count("[data-testid=outline-move-back]"))).toBe(1);
	expect(
		await call(page, (f) => f.has("[data-testid=outline-restore-confirm]:not([disabled])")),
	).toBe(true);
	await shot(page, "4-restore-preview");
	// Nothing was written by the preview.
	expect((await outlineStore.getBlock(s.b))?.deleted).toBe(true);

	expect(await call(page, (f) => f.clickTestId("outline-restore-confirm"))).toBe(true);
	await until(page, "the result", (f) => f.restorePhase() === "done");
	const result = await call(page, (f) => f.restoreResult());
	expect(result?.text).toContain(`Restored to #${s.then}.`);
	expect(result?.skipped).toEqual([]);
	expect(result?.movedAway).toEqual([s.c]);
	await shot(page, "5-restore-result");

	// The outline: what was under R then is as it was; Gamma (moved away) was not pulled back.
	const block = async (id: string) => outlineStore.getBlock(id);
	expect((await block(s.a))?.content).toBe("Alpha");
	expect((await block(s.b))?.deleted).toBe(false);
	expect((await block(s.b))?.parentId).toBe(s.r);
	expect((await block(s.d))?.deleted).toBe(true);
	expect((await block(s.x))?.parentId).toBe(s.e);
	expect((await block(s.y))?.parentId).toBe(s.x);
	expect((await block(s.c))?.parentId).toBe(s.e);

	// Closing the result goes back to now, where the forest shows it.
	expect(await call(page, (f) => f.clickTestId("outline-restore-close"))).toBe(true);
	await until(page, "now again", (f) => f.bar() === null);
	await until(page, "Beta back", hasRow, "Beta");
	await until(page, "Delta gone", (f) => !f.rows().some((r) => r.title === "Delta"));
	expect(await call(page, titles)).toEqual(["Alpha", "Beta"]);
	await page.browserContext().close();
}, 120_000);

test("move back: a moved-away block goes back where it was, and the list is worked out again", async () => {
	const s = await scenario();
	const page = await focus(s, alice, s.then);
	await until(page, "the subtree as of then", hasRow, "Gamma");
	await preview(page);
	expect(await call(page, (f, id: string) => f.moveBack(id), s.c)).toBe(true);
	await until(page, "the list again", (f) => f.has("[data-testid=outline-restore-refreshed]"));
	await until(page, "the new list", (f) => f.restorePhase() === "preview");
	const groups = await call(page, (f) => f.restoreGroups());
	// Gamma is under R again: no longer moved away, nothing to do for it.
	expect(groups.map((g) => g.group)).not.toContain("moved-away");
	expect(groups.flatMap((g) => g.entries.map((e) => e.id))).not.toContain(s.c);
	expect((await outlineStore.getBlock(s.c))?.parentId).toBe(s.r);
	// The new preview confirms without a conflict.
	expect(await call(page, (f) => f.clickTestId("outline-restore-confirm"))).toBe(true);
	await until(page, "the result", (f) => f.restorePhase() === "done");
	expect((await outlineStore.getBlock(s.d))?.deleted).toBe(true);
	expect((await outlineStore.getBlock(s.c))?.parentId).toBe(s.r);
	await page.browserContext().close();
}, 120_000);

test("someone changes the subtree after the preview: 409 said plainly, previewed again, then done", async () => {
	const s = await scenario();
	const page = await focus(s, alice, s.then);
	await until(page, "the subtree as of then", hasRow, "Gamma");
	await preview(page);
	// Bob is not a writer here; alice writes from another tab.
	const other = await write([
		{ op: "update", block: { id: s.d }, content: "Delta, edited meanwhile" },
	]);
	expect(await call(page, (f) => f.clickTestId("outline-restore-confirm"))).toBe(true);
	await until(page, "the conflict", (f) => f.restoreProblem() === "conflict");
	expect(await call(page, (f) => f.text())).toContain(
		`Someone changed this part of the outline after the preview (commit #${other.seq})`,
	);
	// Nothing was written.
	expect((await outlineStore.getBlock(s.b))?.deleted).toBe(true);
	await shot(page, "6-conflict");
	expect(await call(page, (f) => f.clickTestId("outline-restore-again"))).toBe(true);
	await until(page, "a new list", (f) => f.restorePhase() === "preview");
	expect(await call(page, (f) => f.clickTestId("outline-restore-confirm"))).toBe(true);
	await until(page, "the result", (f) => f.restorePhase() === "done");
	expect((await outlineStore.getBlock(s.b))?.deleted).toBe(false);
	expect((await outlineStore.getBlock(s.d))?.deleted).toBe(true);
	await page.browserContext().close();
}, 120_000);

test("a reader who may not write sees the timeline and the comparison, never a restore", async () => {
	const s = await scenario();
	const page = await focus(s, bob);
	await until(page, "the subtree", hasRow, "Delta");
	await until(page, "the timeline", (f, last: number) => f.ticks().seqs.includes(last), s.last);
	expect(await call(page, (f, seq: number) => f.clickTick(seq), s.then)).toBe(true);
	await until(page, "the bar", (f) => f.bar() !== null);
	expect(await call(page, (f) => f.bar())).toMatchObject({
		restore: false,
		compare: true,
		readOnly: true,
	});
	// No per-commit revert either.
	expect(await call(page, (f) => f.text())).not.toContain("Revert");
	expect(await call(page, (f) => f.clickTestId("outline-history-compare"))).toBe(true);
	await until(page, "the comparison", (f) => f.diffEntries().length === 5);
	expect(await call(page, (f) => f.count("[data-testid=outline-move-back]"))).toBe(0);
	await shot(page, "7-read-only");
	await page.browserContext().close();
}, 120_000);

test("history not ready yet: the timeline and the view as of then say so", async () => {
	const s = await scenario();
	await db.update(outlineSpaces).set({ edgesReady: false }).where(eq(outlineSpaces.id, spaceId));
	try {
		const page = await focus(s, alice, s.then);
		await until(page, "the forest's word", (f) => f.has("[data-forest-status=unavailable]"));
		await until(page, "the timeline's word", (f) =>
			f.has("[data-testid=outline-timeline-problem]"),
		);
		expect(await call(page, (f) => f.text())).toContain(
			"The history here cannot be read yet: it is still being prepared.",
		);
		await page.browserContext().close();
	} finally {
		await db.update(outlineSpaces).set({ edgesReady: true }).where(eq(outlineSpaces.id, spaceId));
	}
}, 60_000);

test("the whole space's history: its timeline on the space's page, and the space as of a point", async () => {
	const s = await scenario();
	const page = await openView({ target: { kind: "space", spaceId } });
	await until(page, "the space's blocks", hasRow, `Plan ${scenarios}`);
	expect(await call(page, (f) => f.clickTestId("outline-space-history"))).toBe(true);
	await until(
		page,
		"the space's timeline",
		(f, last: number) => f.ticks().seqs.includes(last),
		s.last,
	);
	expect(await call(page, (f, seq: number) => f.clickTick(seq), s.then)).toBe(true);
	await until(page, "the bar", (f) => f.bar() !== null);
	// The whole space as of then, in the forest's focused list (no root block): this subtree's
	// top-level blocks are there, Delta (added later) is not.
	await until(
		page,
		"the space as of then",
		(f, id: string) => f.has(`[data-testid=outline-block-tree] [data-block-id="${id}"]`),
		s.e,
	);
	expect(
		await call(
			page,
			(f, id: string) => f.has(`[data-testid=outline-block-tree] [data-block-id="${id}"]`),
			s.r,
		),
	).toBe(true);
	expect(await call(page, (f) => f.clickTestId("outline-history-compare"))).toBe(true);
	await until(page, "the comparison", (f) => f.diffEntries().length > 0);
	expect(await call(page, (f) => f.clickTestId("outline-history-now"))).toBe(true);
	await until(page, "now again", (f) => f.bar() === null);
	await page.browserContext().close();
}, 120_000);

test("Chinese, dark, 360 px: the bar, the comparison and the restore fit; no 页; no hover rules", async () => {
	const s = await scenario();
	const page = await openView(
		{
			target: { kind: "block", spaceId, blockId: s.r, view: "all", asOf: s.then },
			lang: "zh-CN",
			scheme: "dark",
		},
		{ width: 360, height: 760 },
	);
	await until(page, "the subtree as of then", hasRow, "Gamma");
	await until(page, "the bar", (f) => f.bar() !== null);
	expect((await call(page, (f) => f.bar()))?.banner).toBe(`正在查看历史：#${s.then} 时的样子`);
	expect(await call(page, (f) => f.clickTestId("outline-history-compare"))).toBe(true);
	await until(page, "the comparison", (f) => f.diffEntries().length === 5);
	expect(await call(page, (f) => f.widest())).toEqual({ over: 0, what: "" });
	expect(await call(page, (f) => f.overflowsX())).toBe(false);
	await shot(page, "8-phone-dark-diff");
	await preview(page);
	expect(await call(page, (f) => f.widest())).toEqual({ over: 0, what: "" });
	const text = await call(page, (f) => f.text());
	expect(text).toContain("恢复到 #");
	expect(text).not.toContain("页");
	await shot(page, "9-phone-dark-restore", false);
	expect(await call(page, (f) => f.clickTestId("outline-restore-confirm"))).toBe(true);
	await until(page, "the result", (f) => f.restorePhase() === "done");
	expect(await call(page, (f) => f.widest())).toEqual({ over: 0, what: "" });
	await shot(page, "10-phone-dark-result", false);
	expect(await call(page, (f) => f.hoverRules())).toEqual([]);
	await page.browserContext().close();
}, 120_000);
