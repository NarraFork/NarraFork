/**
 * The handoff mark and "continue in the previous session's directory" on the project's task
 * board, in Chromium (outline P2 PR 10c-2), against a test server running the real outline routes
 * on the isolated SQLite of `tests/preload.ts`. The handoffs are the real thing: a session takes
 * the task and its run's end gives it back (`release.ts`). No model runs here.
 *
 *   - a task a session gave back carries 「有交接 · N 次」, for everyone who reads the project;
 *     a task never given back carries none;
 *   - the options form offers the previous session's directory when the server found one, and a
 *     session opened with it works there;
 *   - English and 简体中文, light and dark, at 360 px: the mark and the option stay inside the page.
 *
 * Layout is asserted as containment only, never as widths or line counts.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../../server/db";
import { aclGrants, narrators, projects, users } from "../../../../server/db/schema";
import { buildAppErrorResponse } from "../../../../server/lib/app-error-response";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import { narratorService } from "../../../../server/services/narrator-service";
import { settleOutlineTaskClaimsAtRunEnd } from "../../../../server/services/outline/release";
import { ensureProjectSpace } from "../../../../server/services/outline/spaces";
import { outlineStore } from "../../../../server/services/outline/store";
import {
	type OutlineTaskSessionRuntime,
	resetOutlineTaskSessionsForTests,
	setOutlineTaskSessionRuntime,
} from "../../../../server/services/outline/task-session";
import { writeOutline } from "../../../../server/services/outline/write";
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

/**
 * A project of alice's (bob reads it) with two tasks in its space; a session working in
 * `.worktrees/fix` took the first `times` times and gave it back each time.
 */
async function project(times: number) {
	const id = generateId();
	const dir = mkdtempSync(join(tmpdir(), "nf-handoff-"));
	dirs.push(dir);
	const worktree = join(dir, ".worktrees", "fix");
	mkdirSync(worktree, { recursive: true });
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
				parent: { tempId: "p" },
				content: "Fix the refresh logic",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "p" }, content: "Never started", task: { status: "todo" } },
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const taskId = (written.results[1] as { blockId: string }).blockId;
	for (let round = 0; round < times; round++) {
		const session = await narratorService.create({
			contextProjectId: id,
			cwd: worktree,
			ownerUserId: alice,
			title: `Earlier session ${round + 1}`,
			taskBackend: "outline",
		});
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: taskId }, task: { status: "doing" } }],
			actor: { kind: "agent", id: session.id },
			narratorId: session.id,
			responsibleUserId: alice,
		});
		const done = await settleOutlineTaskClaimsAtRunEnd(session.id, { natural: true });
		if (done.released !== 1) throw new Error("the fixture's session did not give the task back");
	}
	return { id, dir, worktree, space, taskId };
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
const PLAIN = ROW("Never started");
const BADGE = "[data-testid=task-badge-handoffs]";
const PREVIOUS = "[data-testid=task-open-session-previous-directory]";

test("the mark is on the task that was given back, for a reader too; the form offers the previous directory and the session opens there", async () => {
	const p = await project(1);
	sessionRuntime();
	const reader = await openPage(bob);
	const { page, errors } = await openPage(alice);
	try {
		await call(reader.page, (f, id: string) => f.openProject(id), p.id);
		await until(reader.page, "the reader's board", (f) => f.count("[data-testid=task-row]") === 2);
		expect(await call(reader.page, (f, s: string) => f.text(s), `${FIX} ${BADGE}`)).toBe(
			"Handoff · 1 time",
		);
		expect(await call(reader.page, (f, s: string) => f.count(s), `${PLAIN} ${BADGE}`)).toBe(0);
		expect(await call(reader.page, (f) => f.count("[data-testid=task-open-session]"))).toBe(0);

		await call(page, (f, id: string) => f.openProject(id), p.id);
		await until(page, "the board", (f) => f.count("[data-testid=task-open-session]") === 2);
		expect(await call(page, (f, s: string) => f.text(s), `${FIX} ${BADGE}`)).toBe(
			"Handoff · 1 time",
		);
		expect(await call(page, (f, s: string) => f.count(s), `${PLAIN} ${BADGE}`)).toBe(0);

		// A task never given back: the form has no such option.
		await page.click(`${PLAIN} [data-testid=task-open-session-options]`);
		await formShown(page);
		expect(await call(page, (f, s: string) => f.count(s), PREVIOUS)).toBe(0);
		await page.click(`${PLAIN} [data-testid=task-open-session-options]`);
		await until(
			page,
			"the form closed",
			(f) => f.count("[data-testid=task-open-session-form]") === 0,
		);

		// The task given back: the option names the directory; choosing it turns the free field off.
		await page.click(`${FIX} [data-testid=task-open-session-options]`);
		await formShown(page);
		await page.waitForSelector(PREVIOUS);
		expect(
			await page.evaluate(
				() => document.querySelector("[data-testid=task-open-session-form]")?.textContent ?? "",
			),
		).toContain(".worktrees/fix");
		expect(
			await page.$eval(
				"[data-testid=task-open-session-cwd]",
				(el) => (el as HTMLInputElement).disabled,
			),
		).toBe(false);
		await page.$eval(PREVIOUS, (el) => (el as HTMLInputElement).click());
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLInputElement>("[data-testid=task-open-session-cwd]")
					?.disabled === true,
		);
		await shot(page, "20-handoff-form");
		await page.click("[data-testid=task-open-session-submit]");
		await until(
			page,
			"the row names the session",
			(f, s: string) => f.count(`${s} [data-testid=task-open-session-doing]`) === 1,
			FIX,
		);
		const opened = (
			await db
				.select({ id: narrators.id, cwd: narrators.cwd, title: narrators.title })
				.from(narrators)
				.where(eq(narrators.contextProjectId, p.id))
		).filter((row) => row.title === "Fix the refresh logic");
		expect(opened).toHaveLength(1);
		expect(opened[0]?.cwd).toBe(p.worktree);
		const [claim] = await outlineStore.getTaskClaims([p.taskId]);
		expect(claim).toMatchObject({ holderNarratorId: opened[0]?.id as string, epoch: 2 });
		expect(errors).toEqual([]);
	} finally {
		await reader.page.browserContext().close();
		await page.browserContext().close();
	}
}, 60_000);

test("given back three times: the count; English and 简体中文, light and dark, at 360 px: the mark and the option stay inside the page", async () => {
	const p = await project(3);
	sessionRuntime();
	const { page, errors } = await openPage(alice, 360);
	try {
		await call(page, (f, id: string) => f.openProject(id), p.id);
		await until(page, "the board", (f) => f.count("[data-testid=task-open-session]") === 2);
		const words = {
			en: { badge: "Handoff · 3 times", option: "Continue in the previous session's directory" },
			"zh-CN": { badge: "有交接 · 3 次", option: "接着用上一个会话的目录" },
		} as const;
		for (const language of ["en", "zh-CN"] as const) {
			for (const scheme of ["light", "dark"] as const) {
				await call(page, (f, l: string) => f.setLanguage(l), language);
				await call(page, (f, s: "light" | "dark") => f.setFrame(360, s), scheme);
				await until(
					page,
					`${language} ${scheme}`,
					(f, s: string, text: string, mode: string) =>
						f.text(s) === text && f.attr("html", "data-mantine-color-scheme") === mode,
					`${FIX} ${BADGE}`,
					words[language].badge,
					scheme,
				);
				for (const selector of [`${FIX} ${BADGE}`, FIX])
					expect([selector, await call(page, (f, s: string) => f.fitsWidth(s), selector)]).toEqual([
						selector,
						{ found: true, inside: true, scrolls: false },
					]);
				await shot(page, `21-handoff-360-${language}-${scheme}`);
				await page.click(`${FIX} [data-testid=task-open-session-options]`);
				await formShown(page);
				await page.waitForSelector(PREVIOUS);
				expect(
					await page.evaluate(
						() => document.querySelector("[data-testid=task-open-session-form]")?.textContent ?? "",
					),
				).toContain(words[language].option);
				for (const selector of [
					"[data-testid=task-open-session-form]",
					"[data-testid=task-open-session-submit]",
				])
					expect([selector, await call(page, (f, s: string) => f.fitsWidth(s), selector)]).toEqual([
						selector,
						{ found: true, inside: true, scrolls: false },
					]);
				await shot(page, `22-handoff-form-360-${language}-${scheme}`);
				await page.click(`${FIX} [data-testid=task-open-session-options]`);
				await until(
					page,
					"the form closed",
					(f) => f.count("[data-testid=task-open-session-form]") === 0,
				);
			}
		}
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 90_000);
