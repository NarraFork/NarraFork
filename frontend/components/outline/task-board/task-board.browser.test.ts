/**
 * The task board in Chromium (outline P2 PR 5), against a test server running the real outline
 * routes on the isolated SQLite of `tests/preload.ts`:
 *
 *   - a session's board: a person adds a task (person-created, locked), finishes and reopens one,
 *     hands one the session was doing to themselves (the session stops) and back, opens a task in
 *     the outline; every change is a person's commit, and the session is told of them;
 *   - a goal the agent ticked done waits for its person: the board shows it (after the server's
 *     `outline_tasks_changed` over the narrator socket) and confirming it there finishes it;
 *     rejecting it there (with a reason) leaves it open and tells the agent; meanwhile the menu
 *     offers neither finishing nor cancelling it;
 *   - a task handed to someone by username (an unknown name is refused), a task cancelled and
 *     folded under its count;
 *   - a project's board: the project space and the sessions' spaces the person may read, grouped
 *     by executor; a reader sees no actions; more sessions load a page at a time.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db, sqlite } from "../../../../server/db";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	users,
} from "../../../../server/db/schema";
import { AppError } from "../../../../server/lib/errors";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import { addPersonTask } from "../../../../server/services/outline/person-tasks";
import { ensureProjectSpace, ensureSessionSpace } from "../../../../server/services/outline/spaces";
import { outlineStore } from "../../../../server/services/outline/store";
import { writeOutline } from "../../../../server/services/outline/write";
import { settleOutlineTaskEditsForTests } from "../../../../server/services/outline-task-edits";
import { OUTLINE_TASK_BOARD_LIMITS } from "../../../../shared/outline-task-board";
import { readTestMessageContent } from "../../../../tests/setup";
import type * as Fixture from "./task-board.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-11-03T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let bob: string;
/** The narrator sockets connected to the test server. */
const sockets = new Set<{ send(data: string): unknown }>();

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

async function session(options: {
	title: string;
	projectId?: string;
	visibility?: "private" | "project";
}): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: options.title,
		ownerUserId: alice,
		visibility: options.visibility ?? "private",
		contextProjectId: options.projectId ?? null,
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
	const bundle = await Bun.build({
		entrypoints: [new URL("./task-board.browser-fixture.tsx", import.meta.url).pathname],
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
	server = Bun.serve<{ userId: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/ws/narrator") {
				const userId = url.searchParams.get("token") ?? "";
				if (srv.upgrade(request, { data: { userId } })) return undefined;
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
			open(ws) {
				sockets.add(ws);
			},
			message() {
				// The board only listens on this socket.
			},
			close(ws) {
				sockets.delete(ws);
			},
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
	alice = await person(`alice${Date.now()}`);
	bob = await person(`bob${Date.now()}`);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function openPage(as: string): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: 900, height: 1400 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), as);
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
			.evaluate(() => document.body.innerText.slice(0, 3000))
			.catch(() => "page gone");
		throw new Error(`until ${what}: ${text}: ${String(error)}`);
	}
}

/** Open a row's menu and pick an action. */
async function act(page: Page, title: string, action: string) {
	await page.click(`[data-testid=task-row][data-title="${title}"] [data-testid=task-row-menu]`);
	await page.waitForSelector(`[data-testid=${action}]`, { visible: true, timeout: 5_000 });
	await page.click(`[data-testid=${action}]`);
}

async function taskByTitle(spaceId: string, title: string) {
	for (const page of await outlineStore.listChildMetas(spaceId, [null], 100)) {
		const blocks = (await outlineStore.listPageBlocks(page.id, 500)).blocks;
		const found = blocks.find((b) => b.content === title);
		if (found) return found;
	}
	return null;
}

/** What the session was told of people's changes to its tasks. */
async function notes(narratorId: string): Promise<string> {
	const rows = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows
		.flatMap((row) => readTestMessageContent(sqlite, row.id))
		.filter((b) => b.source === "outline_task_edit")
		.map((b) => String(b.modelText))
		.join("\n");
}

test("a session's board: add, finish, reopen, hand over and back, confirm a goal, open in the outline", async () => {
	const id = await session({ title: "Release work" });
	const space = await ensureSessionSpace(id);
	// The agent's own plan: one to do, one it is doing.
	await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Plan" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Write the docs",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "p" }, content: "Fix the bug", task: { status: "doing" } },
		],
		actor: { kind: "agent", id },
		narratorId: id,
		responsibleUserId: alice,
	});
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, narratorId: string) => f.openSession(narratorId), id);
		await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 2);
		expect(await call(page, (f) => f.row("Fix the bug"))).toMatchObject({
			status: "doing",
			group: "This session",
		});

		// Add a task: the person's, locked by default.
		await call(page, (f) => f.type("[data-testid=task-board-add-input]", "Ship the release"));
		await page.click("[data-testid=task-board-add]");
		await until(page, "the added task", (f) => f.row("Ship the release") !== null);
		expect((await call(page, (f) => f.row("Ship the release")))?.badges).toEqual([
			"task-badge-human",
			"task-badge-locked",
		]);
		const goal = await taskByTitle(space.id, "Ship the release");
		expect(goal?.taskJson).toMatchObject({
			humanCreated: true,
			lock: { by: { kind: "human", id: alice } },
		});

		// Finish one, then reopen it.
		await act(page, "Write the docs", "task-action-done");
		await until(page, "done", (f) => f.row("Write the docs")?.status === "done");
		await act(page, "Write the docs", "task-action-reopen");
		await until(page, "reopened", (f) => f.row("Write the docs")?.status === "todo");

		// Hand what the session is doing to me: it stops; then back to the session.
		await act(page, "Fix the bug", "task-action-me");
		await until(page, "handed to me", (f) => (f.row("Fix the bug")?.group ?? "").includes("(you)"));
		const bug = await taskByTitle(space.id, "Fix the bug");
		expect(bug?.taskJson?.status).toBe("todo");
		expect(bug?.taskJson?.assignee).toStartWith("human:alice");
		await act(page, "Fix the bug", "task-action-session");
		await until(page, "handed back", (f) => f.row("Fix the bug")?.group === "This session");

		// Open in the outline: the host is asked.
		await act(page, "Write the docs", "task-action-open");
		await until(page, "opened", (f) => f.openedTasks().length === 1);

		// The agent ticks the goal done: it waits for the person, who confirms it on the board.
		const done = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: goal?.id as string }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: alice,
		});
		expect(done.pending).toBeDefined();
		// What the server broadcasts to the session's subscribers on such a change.
		await until(page, "the narrator socket", (f) => f.socketConnected());
		for (const ws of sockets)
			ws.send(JSON.stringify({ type: "outline_tasks_changed", narratorId: id }));
		await until(
			page,
			"the completion",
			(f) => f.count("[data-testid=task-completion-confirm]") === 1,
		);
		expect(await call(page, (f) => f.textOf("task-completion"))).toContain(
			"waiting for your confirmation",
		);
		await page.click("[data-testid=task-completion-confirm]");
		await until(page, "confirmed", (f) => f.row("Ship the release")?.status === "done");
		expect((await outlineStore.getBlock(goal?.id as string))?.taskJson?.status).toBe("done");

		// Every change was the person's, and the session was told, in one merged note (not of the
		// agent's own writes, nor of the confirmation, which is written as the agent's change).
		await settleOutlineTaskEditsForTests();
		const told = await notes(id);
		expect(told).toContain("Ship the release (set by a person, locked): added");
		expect(told).toContain("Write the docs: reopened (back to to do)");
		expect(told).toContain("Fix the bug: set to to do; handed back to this session");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 90_000);

test("a session's board: reject a goal's completion, hand to a username, cancel and fold", async () => {
	const id = await session({ title: "Review work" });
	const space = await ensureSessionSpace(id);
	// Bob may write the session: he can be handed its tasks.
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: id,
		principalType: "user",
		principalId: bob,
		capability: "write",
		createdAt: NOW,
	});
	const bobName = (await db.query.users.findFirst({ where: eq(users.id, bob) }))?.username ?? "";
	const goal = await addPersonTask({
		narratorId: id,
		userId: alice,
		text: "Ship the docs",
		lock: true,
	});
	await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", parent: null, content: "Review the PR", task: { status: "todo" } },
			{ op: "insert", parent: null, content: "Drop the flag", task: { status: "todo" } },
		],
		actor: { kind: "agent", id },
		narratorId: id,
		responsibleUserId: alice,
	});
	// The agent ticks the goal done: it waits for Alice.
	const done = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "setTask", block: { id: goal.blockId }, task: { status: "done" } }],
		actor: { kind: "agent", id },
		narratorId: id,
		responsibleUserId: alice,
	});
	expect(done.pending).toBeDefined();
	await settleOutlineTaskEditsForTests();
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, narratorId: string) => f.openSession(narratorId), id);
		await until(page, "the board", (f) => f.count("[data-testid=task-completion-reject]") === 1);

		// While its completion waits, the menu offers neither finishing nor cancelling it.
		await page.click(
			'[data-testid=task-row][data-title="Ship the docs"] [data-testid=task-row-menu]',
		);
		await page.waitForSelector("[data-testid=task-action-open]", { visible: true });
		expect(await call(page, (f) => f.count("[data-testid=task-action-done]"))).toBe(0);
		expect(await call(page, (f) => f.count("[data-testid=task-action-cancel]"))).toBe(0);
		await page.keyboard.press("Escape");

		// Reject, with a reason: the goal stays open and the agent is told who and why.
		await call(page, (f) => f.type("[data-testid=task-completion-reason]", "the smoke tests fail"));
		await page.click("[data-testid=task-completion-reject]");
		await until(page, "rejected", (f) => f.count("[data-testid=task-completion]") === 0);
		expect((await outlineStore.getBlock(goal.blockId))?.taskJson?.status).toBe("todo");
		await settleOutlineTaskEditsForTests();
		expect(await notes(id)).toContain(
			"rejected your marking it done; reason: the smoke tests fail",
		);

		// Hand a task to someone by username: unknown first (refused, nothing changes), then Bob.
		await act(page, "Review the PR", "task-action-user");
		await page.waitForSelector("[data-testid=task-assign-username]", { visible: true });
		await call(page, (f) => f.type("[data-testid=task-assign-username]", "nobody-here"));
		await page.click("[data-testid=task-assign-submit]");
		await until(
			page,
			"refused",
			(f) =>
				document.querySelector("[data-testid=task-assign-submit]")?.getAttribute("data-loading") !==
					"true" && f.row("Review the PR")?.group === "This session",
		);
		expect((await taskByTitle(space.id, "Review the PR"))?.taskJson?.assignee ?? null).toBeNull();
		await call(
			page,
			(f, name: string) => f.type("[data-testid=task-assign-username]", name),
			bobName,
		);
		await page.click("[data-testid=task-assign-submit]");
		await until(
			page,
			"handed to Bob",
			(f, name: string) => f.row("Review the PR")?.group === name,
			10_000,
			bobName,
		);
		expect((await taskByTitle(space.id, "Review the PR"))?.taskJson?.assignee).toBe(
			`human:${bobName}`,
		);

		// Cancel one: it goes under Cancelled, folded until opened.
		await act(page, "Drop the flag", "task-action-cancel");
		await until(
			page,
			"folded",
			(f) =>
				f.count("[data-testid=task-board-status][data-status=cancelled][data-folded=true]") === 1,
		);
		expect(await call(page, (f) => f.row("Drop the flag"))).toBeNull();
		await page.click("[data-testid=task-board-cancelled-toggle]");
		await until(page, "unfolded", (f) => f.row("Drop the flag")?.status === "cancelled");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 90_000);

test("a project's board: readable sessions only, grouped by executor, no actions for a reader, more sessions on demand", async () => {
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Board project",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: bob,
		capability: "read",
		createdAt: NOW,
	});
	const projectSpace = await ensureProjectSpace(projectId);
	await writeOutline({
		spaceId: projectSpace.id,
		ops: [{ op: "insert", parent: null, content: "Team task", task: { status: "todo" } }],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const shared = await session({ title: "Shared session", projectId, visibility: "project" });
	const hidden = await session({ title: "Private session", projectId, visibility: "private" });
	await addPersonTask({ narratorId: shared, userId: alice, text: "Shared task", lock: false });
	await addPersonTask({ narratorId: hidden, userId: alice, text: "Private task", lock: false });

	const reader = await openPage(bob);
	try {
		await call(reader.page, (f, p: string) => f.openProject(p), projectId);
		await until(reader.page, "the project board", (f) => f.count("[data-testid=task-row]") === 2);
		const rows = await call(reader.page, (f) => f.rows());
		expect(rows.map((r) => [r.title, r.group]).sort()).toEqual([
			["Shared task", "Shared session"],
			["Team task", "Unassigned"],
		]);
		// A reader may open a task but not change it.
		await reader.page.click(
			'[data-testid=task-row][data-title="Team task"] [data-testid=task-row-menu]',
		);
		await reader.page.waitForSelector("[data-testid=task-action-open]", { visible: true });
		expect(await call(reader.page, (f) => f.count("[data-testid=task-action-done]"))).toBe(0);
		expect(reader.errors).toEqual([]);
	} finally {
		await reader.page.close();
	}

	// More sessions than one page holds: the rest load on demand.
	for (let i = 0; i < OUTLINE_TASK_BOARD_LIMITS.projectSpaces; i++) {
		const extra = await session({ title: `Extra ${i}`, projectId, visibility: "project" });
		await addPersonTask({ narratorId: extra, userId: alice, text: `Extra task ${i}`, lock: false });
	}
	const owner = await openPage(alice);
	try {
		await call(owner.page, (f, p: string) => f.openProject(p), projectId);
		await until(
			owner.page,
			"the first page",
			(f) => f.count("[data-testid=task-board-more-spaces]") === 1,
		);
		const firstPage = await call(owner.page, (f) => f.count("[data-testid=task-row]"));
		// The project space and a page of sessions.
		expect(firstPage).toBe(1 + OUTLINE_TASK_BOARD_LIMITS.projectSpaces);
		await owner.page.click("[data-testid=task-board-more-spaces]");
		await until(
			owner.page,
			"every session",
			(f, total: number) =>
				f.count("[data-testid=task-row]") === total &&
				f.count("[data-testid=task-board-more-spaces]") === 0,
			10_000,
			3 + OUTLINE_TASK_BOARD_LIMITS.projectSpaces,
		);
		// The owner may act: finish the team's task.
		await act(owner.page, "Team task", "task-action-done");
		await until(owner.page, "team task done", (f) => f.row("Team task")?.status === "done");
		expect(owner.errors).toEqual([]);
	} finally {
		await owner.page.close();
	}
}, 90_000);

test("task text uses the conversation's typography and follows the setting", async () => {
	const id = await session({ title: "Typography" });
	const space = await ensureSessionSpace(id);
	await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Plan" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "修复：排查中断后无重试按钮 Mixed English",
				task: { status: "doing" },
			},
		],
		actor: { kind: "agent", id },
		narratorId: id,
		responsibleUserId: alice,
	});
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, narratorId: string) => f.openSession(narratorId), id);
		await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 1);
		const title = "修复：排查中断后无重试按钮 Mixed English";
		for (const setting of [
			{ fontScalePercent: 100, lineHeightScalePercent: 100, letterSpacingPercent: 0 },
			{ fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 },
		]) {
			await call(page, (f, s: never) => f.applyTypography(s), setting);
			const got = await call(page, (f, t: string) => f.rowTypography(t), title);
			expect(got.title?.size).toBeCloseTo(got.expected.body.size, 2);
			expect(got.title?.line).toBe(got.expected.body.line);
			expect(got.address?.size).toBeCloseTo(got.expected.xs.size, 2);
		}
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);
