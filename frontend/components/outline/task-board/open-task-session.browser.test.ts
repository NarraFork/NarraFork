/**
 * "Open a new session for this" on the project's task board, in Chromium (outline P2 PR 10c-1),
 * against a test server running the real outline routes on the isolated SQLite of
 * `tests/preload.ts`. The session layer's start is replaced (no model runs here); creating the
 * session, claiming the task and writing the brief are the real thing.
 *
 *   - the button is on the project space's startable tasks, for people who may open sessions,
 *     and those tasks are grouped as "Ready to start";
 *   - a click: the button is busy and cannot be clicked twice; then the row names the session
 *     that is on it, which opens that session through the host; nothing navigates;
 *   - the options form (model, working directory, a note) and its note in the session's brief;
 *   - a failure is said on the row and the button works again;
 *   - English and 简体中文, light and dark, at 360 px: nothing overflows.
 *
 * Layout is asserted as containment only (inside the viewport, no sideways scroll), never as
 * widths or line counts: those depend on the fonts installed.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { asc, eq } from "drizzle-orm";
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
import { buildAppErrorResponse } from "../../../../server/lib/app-error-response";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import { narratorService } from "../../../../server/services/narrator-service";
import { ensureProjectSpace } from "../../../../server/services/outline/spaces";
import { outlineStore } from "../../../../server/services/outline/store";
import {
	OUTLINE_TASK_BRIEF_SOURCE,
	type OutlineTaskSessionRuntime,
	resetOutlineTaskSessionsForTests,
	setOutlineTaskSessionRuntime,
} from "../../../../server/services/outline/task-session";
import { writeOutline } from "../../../../server/services/outline/write";
import { readTestMessageContent } from "../../../../tests/setup";
import type * as Fixture from "./task-board.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
/** Where screenshots go when asked for (a review aid; nothing is written otherwise). */
const shots = process.env.NF_TEST_SHOT_DIR;
const NOW = "2026-11-11T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let bob: string;
const dirs: string[] = [];

/** The real session creation, as `task-session.ts` asks for it. */
const createSession: OutlineTaskSessionRuntime["createSession"] = async (input) =>
	(
		await narratorService.create({
			contextProjectId: input.projectId,
			cwd: input.cwd,
			ownerUserId: input.ownerUserId,
			title: input.title,
			taskBackend: "outline",
		})
	).id;

/** No model runs in this file: a start is "started" unless a case says otherwise. */
function sessionRuntime(over: Partial<OutlineTaskSessionRuntime> = {}): void {
	setOutlineTaskSessionRuntime({ createSession, start: async () => true, ...over });
}

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

async function person(username: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

/** A project of alice's (bob reads it) with tasks in its space: two startable, two not. */
async function project() {
	const id = generateId();
	const dir = mkdtempSync(join(tmpdir(), "nf-open-session-"));
	dirs.push(dir);
	await db.insert(projects).values({
		id,
		name: "Sign-in",
		gitPath: dir,
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: id,
		principalType: "user",
		principalId: bob,
		capability: "read",
		createdAt: NOW,
	});
	const space = await ensureProjectSpace(id);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "a",
				parent: { tempId: "p" },
				content: "Fix the refresh logic",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "补全并发刷新的回归测试，覆盖两个标签页同时刷新、令牌刚好过期的情况",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "For Pat",
				task: { status: "todo", assignee: "human:pat" },
			},
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const first = written.results[1] as { blockId: string; sid: string };
	await writeOutline({
		spaceId: space.id,
		ops: [
			{
				op: "insert",
				parent: { id: (written.results[0] as { blockId: string }).blockId },
				content: "Waits for the fix",
				task: { status: "todo", depends: [{ target: `${space.key}/${first.sid}`, label: null }] },
			},
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	return { id, dir, space, taskId: first.blockId };
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	if (shots) mkdirSync(shots, { recursive: true });
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
	alice = await person(`alice${Date.now()}`);
	bob = await person(`bob${Date.now()}`);
}, 60_000);

afterEach(() => {
	setOutlineTaskSessionRuntime(null);
	resetOutlineTaskSessionsForTests();
});

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function openPage(as: string, width = 900): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width, height: 1200 });
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

/** The options form is shown and its popover has finished fading in. */
async function formShown(page: Page): Promise<void> {
	await page.waitForSelector("[data-testid=task-open-session-model]", { visible: true });
	await page.waitForFunction(
		() => {
			const form = document.querySelector("[data-testid=task-open-session-form]");
			for (let el = form?.parentElement; el; el = el.parentElement)
				if (getComputedStyle(el).opacity !== "1") return false;
			return !!form;
		},
		{ timeout: 5_000, polling: 50 },
	);
}

async function shot(page: Page, name: string): Promise<void> {
	if (shots) await page.screenshot({ path: join(shots, `${name}.png`) as `${string}.png` });
}

const ROW = (title: string) => `[data-testid=task-row][data-title="${title}"]`;
const FIX = ROW("Fix the refresh logic");

async function stateOf(taskId: string) {
	const block = await outlineStore.getBlock(taskId);
	const [claim] = await outlineStore.getTaskClaims([taskId]);
	return { status: block?.taskJson?.status, holder: claim?.holderNarratorId ?? null };
}

const sessionsOf = async (projectId: string) =>
	await db
		.select({ id: narrators.id, title: narrators.title, status: narrators.status })
		.from(narrators)
		.where(eq(narrators.contextProjectId, projectId));

/** The model text of the session's first row, and its injection source. */
async function firstRow(narratorId: string) {
	const [row] = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(asc(narratorMessageRefs.seq))
		.limit(1);
	const blocks = row
		? readTestMessageContent<{ source?: string; modelText?: string; text?: string }>(sqlite, row.id)
		: [];
	const injection = blocks.find((block) => typeof block.source === "string");
	return {
		source: injection?.source ?? null,
		text: injection?.modelText ?? blocks.find((block) => block.text)?.text ?? "",
	};
}

test("the button: on startable project tasks, for those who may open sessions; a click opens one session and the row names it", async () => {
	const p = await project();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	sessionRuntime({
		createSession: async (input) => {
			await gate;
			return await createSession(input);
		},
	});
	const reader = await openPage(bob);
	const { page, errors } = await openPage(alice);
	try {
		// A reader of the project sees the tasks and no button.
		await call(reader.page, (f, id: string) => f.openProject(id), p.id);
		await until(reader.page, "the reader's board", (f) => f.count("[data-testid=task-row]") === 4);
		expect(await call(reader.page, (f) => f.count("[data-testid=task-open-session]"))).toBe(0);

		await call(page, (f, id: string) => f.openProject(id), p.id);
		await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 4);
		// The two startable tasks have it; the one waiting and the one handed to a person do not.
		expect(await call(page, (f) => f.count("[data-testid=task-open-session]"))).toBe(2);
		for (const title of ["Waits for the fix", "For Pat"])
			expect(
				await call(
					page,
					(f, s: string) => f.count(`${s} [data-testid=task-open-session]`),
					ROW(title),
				),
			).toBe(0);
		expect(await call(page, (f) => f.row("Fix the refresh logic"))).toMatchObject({
			status: "todo",
			group: "Ready to start",
		});
		expect(
			await call(page, (f, s: string) => f.text(`${s} [data-testid=task-open-session]`), FIX),
		).toBe("Open a new session for this");
		await shot(page, "01-board-en-light");

		// Click: busy until the server answers, and a second click does nothing.
		await page.click(`${FIX} [data-testid=task-open-session]`);
		await until(
			page,
			"the busy button",
			(f, s: string) => f.attr(`${s} [data-testid=task-open-session]`, "data-loading") === "true",
			FIX,
		);
		expect(
			await call(
				page,
				(f, s: string) => f.attr(`${s} [data-testid=task-open-session-options]`, "disabled"),
				FIX,
			),
		).not.toBeNull();
		await shot(page, "02-opening-en-light");
		await page.click(`${FIX} [data-testid=task-open-session]`).catch(() => {});
		release();
		await until(
			page,
			"the session named on the row",
			(f, s: string) => f.count(`${s} [data-testid=task-open-session-doing]`) === 1,
			FIX,
		);

		// One session, in the project, holding the task; its first row is the brief.
		const sessions = await sessionsOf(p.id);
		expect(sessions).toHaveLength(1);
		const narratorId = sessions[0]?.id as string;
		expect(sessions[0]?.title).toBe("Fix the refresh logic");
		expect(await stateOf(p.taskId)).toEqual({ status: "doing", holder: narratorId });
		const brief = await firstRow(narratorId);
		expect(brief.source).toBe(OUTLINE_TASK_BRIEF_SOURCE);
		expect(brief.text).toContain("# Task: Fix the refresh logic");

		// The row: no button any more, the session named; it opens through the host, no navigation.
		const doing = `${FIX} [data-testid=task-open-session-doing]`;
		expect(await call(page, (f, s: string) => f.text(s), doing)).toBe(
			"Session “Fix the refresh logic” is on it",
		);
		expect(await call(page, (f, s: string) => f.attr(s, "href"), doing)).toBe(
			`/narrators/${narratorId}`,
		);
		expect(
			await call(page, (f, s: string) => f.count(`${s} [data-testid=task-open-session]`), FIX),
		).toBe(0);
		// The board read again: in progress, under its session, still named.
		await until(
			page,
			"the board read again",
			(f) => f.row("Fix the refresh logic")?.status === "doing",
		);
		expect((await call(page, (f) => f.row("Fix the refresh logic")))?.group).toBe(
			"Fix the refresh logic",
		);
		await page.click(doing);
		expect(await call(page, (f) => f.openedSessionIds())).toEqual([narratorId]);
		expect(new URL(page.url()).pathname).toBe("/");
		await shot(page, "03-session-on-it-en-light");
		expect(errors).toEqual([]);
	} finally {
		release();
		await page.browserContext().close();
		await reader.page.browserContext().close();
	}
}, 60_000);

test("the options form: model, working directory and a note, which reaches the session's brief", async () => {
	const p = await project();
	const asked: Array<{ model?: string }> = [];
	sessionRuntime({
		createSession: async (input) => {
			asked.push({ model: input.model });
			return await createSession(input);
		},
	});
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, id: string) => f.openProject(id), p.id);
		await until(page, "the board", (f) => f.count("[data-testid=task-open-session]") === 2);
		await page.click(`${FIX} [data-testid=task-open-session-options]`);
		await page.waitForSelector("[data-testid=task-open-session-form]", { visible: true });
		await formShown(page);
		for (const field of ["task-open-session-cwd", "task-open-session-note"])
			expect(await call(page, (f, id: string) => f.count(`[data-testid=${id}]`), field)).toBe(1);
		// It says what a session costs.
		expect(await call(page, (f) => f.text("[data-testid=task-open-session-form]"))).toContain(
			"at least one model request",
		);
		await call(page, (f) => f.type("[data-testid=task-open-session-note]", "Keep the public API."));
		// Picking a model keeps the form open and what was typed in it.
		await page.click("[data-testid=task-open-session-model]");
		const option = '[data-testid=task-open-session-form] [role=option][value="__summary__"]';
		await page.waitForSelector(option, { visible: true });
		await page.click(option);
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLInputElement>("[data-testid=task-open-session-model]")?.value ===
				"__summary__",
			{ timeout: 5_000, polling: 50 },
		);
		expect(await call(page, (f) => f.count("[data-testid=task-open-session-form]"))).toBe(1);
		expect(
			await page.$eval(
				"[data-testid=task-open-session-note]",
				(el) => (el as HTMLTextAreaElement).value,
			),
		).toBe("Keep the public API.");
		await shot(page, "04-options-form-en-light");
		await page.click("[data-testid=task-open-session-submit]");
		await until(
			page,
			"the session named on the row",
			(f, s: string) => f.count(`${s} [data-testid=task-open-session-doing]`) === 1,
			FIX,
		);
		const [session] = await sessionsOf(p.id);
		expect(session?.status).not.toBe("archived");
		const brief = await firstRow(session?.id as string);
		expect(brief.text).toContain("## Further instructions\nKeep the public API.");
		expect(asked).toEqual([{ model: "__summary__" }]);
		// The same from the row's menu.
		await page.click(`${ROW("For Pat")} [data-testid=task-row-menu]`);
		await page.waitForSelector("[data-testid=task-action-open]", { visible: true });
		expect(await call(page, (f) => f.count("[data-testid=task-action-open-session]"))).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 60_000);

test("a failure is said on the row, nothing is left behind, and the button works again", async () => {
	const p = await project();
	sessionRuntime({ start: async () => false });
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, id: string) => f.openProject(id), p.id);
		await until(page, "the board", (f) => f.count("[data-testid=task-open-session]") === 2);
		await page.click(`${FIX} [data-testid=task-open-session]`);
		await until(
			page,
			"the error on the row",
			(f, s: string) => f.count(`${s} [data-testid=task-open-session-error]`) === 1,
			FIX,
		);
		expect(
			await call(page, (f, s: string) => f.text(`${s} [data-testid=task-open-session-error]`), FIX),
		).toBe("The session could not be started. The task is back to do; try again.");
		await shot(page, "05-error-en-light");
		// The task is to do again and nobody holds it; the session that never ran is archived.
		expect(await stateOf(p.taskId)).toEqual({ status: "todo", holder: null });
		expect((await sessionsOf(p.id)).map((s) => s.status)).toEqual(["archived"]);
		// The board is read again (the task's version moved); then the button works.
		await call(page, (f) => f.refreshBoards());
		sessionRuntime();
		await until(
			page,
			"the button again",
			(f, s: string) =>
				f.count(`${s} [data-testid=task-open-session]`) === 1 &&
				f.attr(`${s} [data-testid=task-open-session]`, "data-loading") !== "true",
			FIX,
		);
		// A stale board is answered with a reload, never with a second session: click until it takes.
		await page.waitForFunction(
			async (selector: string) => {
				if (document.querySelector(`${selector} [data-testid=task-open-session-doing]`))
					return true;
				const button = document.querySelector<HTMLButtonElement>(
					`${selector} [data-testid=task-open-session]`,
				);
				if (button && !button.disabled && button.dataset.loading !== "true") button.click();
				return false;
			},
			{ timeout: 10_000, polling: 200 },
			FIX,
		);
		const live = (await sessionsOf(p.id)).filter((s) => s.status !== "archived");
		expect(live).toHaveLength(1);
		expect(await stateOf(p.taskId)).toEqual({ status: "doing", holder: live[0]?.id as string });
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 60_000);

test("English and 简体中文, light and dark, at 360 px: the button, the form and an error stay inside the page", async () => {
	const p = await project();
	sessionRuntime({ start: async () => false });
	const { page, errors } = await openPage(alice, 360);
	const LONG = ROW("补全并发刷新的回归测试，覆盖两个标签页同时刷新、令牌刚好过期的情况");
	try {
		await call(page, (f, id: string) => f.openProject(id), p.id);
		await until(page, "the board", (f) => f.count("[data-testid=task-open-session]") === 2);
		const words = {
			en: {
				button: "Open a new session for this",
				group: "Ready to start",
				submit: "Open session",
			},
			"zh-CN": { button: "开新会话做这个", group: "待开工", submit: "开会话" },
		} as const;
		for (const language of ["en", "zh-CN"] as const) {
			for (const scheme of ["light", "dark"] as const) {
				await call(page, (f, l: string) => f.setLanguage(l), language);
				await call(page, (f, s: "light" | "dark") => f.setFrame(360, s), scheme);
				await until(
					page,
					`${language} ${scheme}`,
					(f, s: string, text: string, mode: string) =>
						f.text(`${s} [data-testid=task-open-session]`) === text &&
						f.attr("html", "data-mantine-color-scheme") === mode,
					LONG,
					words[language].button,
					scheme,
				);
				expect((await call(page, (f) => f.row("Fix the refresh logic")))?.group).toBe(
					words[language].group,
				);
				for (const selector of [
					`${LONG} [data-testid=task-open-session-row]`,
					`${LONG} [data-testid=task-open-session]`,
					`${LONG} [data-testid=task-open-session-options]`,
					LONG,
					`${FIX} [data-testid=task-open-session-row]`,
				])
					expect([selector, await call(page, (f, s: string) => f.fitsWidth(s), selector)]).toEqual([
						selector,
						{ found: true, inside: true, scrolls: false },
					]);
				await shot(page, `10-board-360-${language}-${scheme}`);
				// The form.
				await page.click(`${LONG} [data-testid=task-open-session-options]`);
				await page.waitForSelector("[data-testid=task-open-session-submit]", { visible: true });
				await formShown(page);
				expect(await call(page, (f) => f.text("[data-testid=task-open-session-submit]"))).toBe(
					words[language].submit,
				);
				for (const selector of [
					"[data-testid=task-open-session-form]",
					"[data-testid=task-open-session-submit]",
					"[data-testid=task-open-session-note]",
				])
					expect([selector, await call(page, (f, s: string) => f.fitsWidth(s), selector)]).toEqual([
						selector,
						{ found: true, inside: true, scrolls: false },
					]);
				await shot(page, `11-form-360-${language}-${scheme}`);
				await page.click(`${LONG} [data-testid=task-open-session-options]`);
				await until(
					page,
					"the form closed",
					(f) => f.count("[data-testid=task-open-session-form]") === 0,
				);
			}
		}
		// An error, in 简体中文 and dark: said on the row, inside the page.
		await page.click(`${FIX} [data-testid=task-open-session]`);
		await until(
			page,
			"the error",
			(f, s: string) => f.count(`${s} [data-testid=task-open-session-error]`) === 1,
			FIX,
		);
		expect(
			await call(page, (f, s: string) => f.text(`${s} [data-testid=task-open-session-error]`), FIX),
		).toBe("会话没能启动，任务已放回待办，请再试一次。");
		expect(
			await call(
				page,
				(f, s: string) => f.fitsWidth(`${s} [data-testid=task-open-session-error]`),
				FIX,
			),
		).toEqual({ found: true, inside: true, scrolls: false });
		await shot(page, "12-error-360-zh-CN-dark");
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 90_000);
