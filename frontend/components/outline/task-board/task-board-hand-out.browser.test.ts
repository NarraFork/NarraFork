/**
 * The task board's 「交给团队」 in Chromium (outline P2 PR 10c-3, design v2 §E.2), against a test
 * server running the real outline routes on the isolated SQLite of `tests/preload.ts`:
 *
 *   - the menu of an open task of a session's own space offers it to the session's owner; it
 *     hands the task out (a copy goes to the project's task page), says so, and the task stays on
 *     the board waiting for its prerequisite; nothing is started;
 *   - a session of no project, and someone who may write the session but does not own it, are
 *     not offered it;
 *   - a task changed since the board read it is refused with its reason and the board reloads;
 *   - in English and Chinese, light and dark, and in a 360 px wide viewport, where the menu stays
 *     inside the viewport and the page does not scroll sideways (containment only: no assertion
 *     depends on how wide a font draws CJK text).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./task-board-hand-out.browser-fixture";

const { db } = await import("../../../../server/db");
const { aclGrants, narrators, projects, users } = await import("../../../../server/db/schema");
const { buildAppErrorResponse } = await import("../../../../server/lib/app-error-response");
const { generateId } = await import("../../../../server/lib/id");
const { settings } = await import("../../../../server/lib/settings");
const { outlineRoutes } = await import("../../../../server/routes/outline");
const { ensureSessionSpace, ensureProjectSpace } = await import(
	"../../../../server/services/outline/spaces"
);
const { outlineStore } = await import("../../../../server/services/outline/store");
const { OUTLINE_TASKS_PAGE_ALIAS } = await import("../../../../server/services/outline/model");
const { writeOutline } = await import("../../../../server/services/outline/write");

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
/** Where screenshots go when asked for (`NF_TEST_SHOTS_DIR`); none otherwise. */
const shotsDir = process.env.NF_TEST_SHOTS_DIR ?? "";
const NOW = "2026-11-12T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;

function api() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
		c.set("user", { sub: token, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500),
	);
	app.route("/api/outline", outlineRoutes);
	return app;
}

async function user(name: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${name}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(
	projectId: string | null,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		title: "Parser work",
		traits: ["standalone"],
		model: "openai:test-model",
		ownerUserId: alice,
		visibility: "private",
		contextProjectId: projectId,
		taskBackend: "outline",
		status: "idle",
		cwd: process.cwd(),
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

/** A project of alice's, her session in it with two to-dos of its own space. */
async function world(options: { project?: boolean } = {}) {
	let projectId: string | null = null;
	if (options.project !== false) {
		projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: `Atlas ${projectId.slice(0, 4)}`,
			ownerUserId: alice,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
	}
	const narratorId = await session(projectId);
	const space = await ensureSessionSpace(narratorId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Work" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Port the parser",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Write the docs",
				task: { status: "todo" },
			},
		],
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: alice,
	});
	const [, parser, docs] = written.results.map((r) => r.blockId) as string[];
	return { projectId, narratorId, space, parser: parser as string, docs: docs as string };
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./task-board-hand-out.browser-fixture.tsx", import.meta.url).pathname],
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
	alice = await user("alice");
	if (shotsDir) mkdirSync(shotsDir, { recursive: true });
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function openPage(width: number, token = alice): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((value) => localStorage.setItem("narrafork_token", value), token);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
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
	...args: unknown[]
) {
	try {
		await page.waitForFunction(`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`, {
			timeout: 10_000,
			polling: 50,
		});
	} catch (error) {
		const text = await page
			.evaluate(() => document.body.innerText.slice(0, 3000))
			.catch(() => "page gone");
		throw new Error(`until ${what}: ${text}: ${String(error)}`);
	}
}

async function mount(
	page: Page,
	narratorId: string,
	options: { scheme: "light" | "dark"; width: number; language: string },
) {
	await call(
		page,
		(f, id: string, o: { scheme: "light" | "dark"; width: number; language: string }) =>
			f.open(id, o),
		narratorId,
		options,
	);
	await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 2);
}

/** Open a task's menu; wait until it is shown, its opening transition over. */
async function openMenu(page: Page, title: string) {
	await page.click(`[data-testid=task-row][data-title="${title}"] [data-testid=task-row-menu]`);
	await until(page, "the menu", (f) => f.menu()?.opacity === 1);
	return await call(page, (f) => f.menu());
}

async function shot(page: Page, name: string) {
	if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) as `${string}.png` });
}

/** The tasks on the project's task page (the copies). */
async function copiesIn(projectId: string) {
	const space = await ensureProjectSpace(projectId);
	const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (!page) return [];
	return (await outlineStore.listChildMetas(space.id, [page.id], 50)).filter((m) => m.taskJson);
}

test("「交给团队」 hands the task out: the copy in the project, the task waiting for it; English, light", async () => {
	const w = await world();
	const { page, errors } = await openPage(900);
	try {
		await mount(page, w.narratorId, { scheme: "light", width: 720, language: "en" });
		const menu = await openMenu(page, "Port the parser");
		const item = menu?.items.find((i) => i.id === "task-action-team");
		expect(item?.text).toBe("Hand to the team");
		// Next to the other ways of giving it away.
		expect(menu?.items.map((i) => i.id)).toContain("task-action-transfer");
		await shot(page, "hand-out-en-light-menu");
		await call(page, (f) => f.click("[data-testid=task-action-team]"));
		await until(page, "the notice", (f) =>
			f.notices().some((n) => n.text.startsWith("Handed to the team: a copy is on the project's")),
		);
		await until(page, "the task waiting", (f) =>
			(f.row("Port the parser")?.text ?? "").includes("Waits for 1 prerequisite(s)"),
		);
		const [copy, ...more] = await copiesIn(w.projectId as string);
		expect(more).toHaveLength(0);
		expect(copy?.taskJson).toMatchObject({ status: "todo", assignee: null, claimable: true });
		const notice = (await call(page, (f) => f.notices())).find((n) =>
			n.text.startsWith("Handed to the team"),
		);
		const projectSpace = await ensureProjectSpace(w.projectId as string);
		expect(notice?.text).toBe(
			`Handed to the team: a copy is on the project's task page (${projectSpace.key}/${copy?.sid}). This task waits for it.`,
		);
		expect((await outlineStore.getBlock(w.parser))?.taskJson).toMatchObject({
			status: "todo",
			depends: [{ target: `${projectSpace.key}/${copy?.sid}`, label: null }],
		});
		await shot(page, "hand-out-en-light-after");
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 60_000);

test("中文、暗色、360 px: the item, the notice; the menu inside the viewport, no sideways scroll", async () => {
	const w = await world();
	const { page, errors } = await openPage(360);
	try {
		await mount(page, w.narratorId, { scheme: "dark", width: 360, language: "zh-CN" });
		const menu = await openMenu(page, "Write the docs");
		expect(menu?.items.find((i) => i.id === "task-action-team")?.text).toBe("交给团队");
		expect(menu?.viewport).toBe(360);
		expect(menu?.left).toBeGreaterThanOrEqual(0);
		expect(menu?.right).toBeLessThanOrEqual(360);
		expect(menu?.pageScrollWidth).toBeLessThanOrEqual(360);
		await shot(page, "hand-out-zh-dark-360-menu");
		await call(page, (f) => f.click("[data-testid=task-action-team]"));
		await until(page, "the notice", (f) =>
			f.notices().some((n) => n.text.startsWith("已交给团队：项目的任务页上有一份副本")),
		);
		await until(page, "the task waiting", (f) =>
			(f.row("Write the docs")?.text ?? "").includes("等 1 个前置任务"),
		);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			360,
		);
		await shot(page, "hand-out-zh-dark-360-after");
		expect(await copiesIn(w.projectId as string)).toHaveLength(1);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 60_000);

test("not offered without a project or to someone who does not own the session (they assign in place); a task changed meanwhile is refused with its reason", async () => {
	// A session of no project: nowhere to hand it to.
	const loner = await world({ project: false });
	const { page, errors } = await openPage(900);
	try {
		await mount(page, loner.narratorId, { scheme: "light", width: 720, language: "en" });
		const menu = await openMenu(page, "Port the parser");
		expect(menu?.items.map((i) => i.id)).not.toContain("task-action-team");
		expect(menu?.items.map((i) => i.id)).not.toContain("task-action-transfer");
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}

	// A teammate who may write the session: offered what assigns in place, never 「交给团队」 (the
	// owner's); 「交给我」 gives it to them where it is, no copy (owner decision 2026-11-13).
	const w = await world();
	const bob = await user("bob");
	for (const [scopeType, scopeId] of [
		["project", w.projectId as string],
		["narrator", w.narratorId],
	] as const)
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType,
			scopeId,
			principalType: "user",
			principalId: bob,
			capability: "write",
			createdAt: NOW,
		});
	const theirs = await openPage(900, bob);
	try {
		await mount(theirs.page, w.narratorId, { scheme: "dark", width: 720, language: "en" });
		const menu = await openMenu(theirs.page, "Port the parser");
		const ids = menu?.items.map((i) => i.id) ?? [];
		expect(ids).toContain("task-action-done");
		expect(ids).toContain("task-action-me");
		expect(ids).toContain("task-action-transfer");
		expect(ids).not.toContain("task-action-team");
		await call(theirs.page, (f) => f.click("[data-testid=task-action-me]"));
		await until(theirs.page, "handed to bob, in place", (f) =>
			(f.row("Port the parser")?.text ?? "").includes("@human:bob"),
		);
		expect(theirs.errors).toEqual([]);
	} finally {
		await theirs.page.browserContext().close();
	}

	// The owner, on a board read before the task changed: refused, said why, the board reloaded.
	const own = await openPage(900);
	try {
		await mount(own.page, w.narratorId, { scheme: "light", width: 720, language: "zh-CN" });
		await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "update", block: { id: w.parser }, content: "Port the parser (v2)" }],
			actor: { kind: "agent", id: w.narratorId },
			narratorId: w.narratorId,
			responsibleUserId: alice,
		});
		await openMenu(own.page, "Port the parser");
		await call(own.page, (f) => f.click("[data-testid=task-action-team]"));
		await until(own.page, "the refusal", (f) =>
			f
				.notices()
				.some((n) => n.title === "没能交出这个任务" && n.text === "任务刚被改过，看板已重新加载。"),
		);
		await until(own.page, "the board reloaded", (f) => f.row("Port the parser (v2)") !== null);
		expect(await copiesIn(w.projectId as string)).toHaveLength(0);
		expect(own.errors).toEqual([]);
	} finally {
		await own.page.browserContext().close();
	}
}, 60_000);
