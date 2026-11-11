/**
 * The task board's 「转交给会话…」 in Chromium (outline P2 PR 10a, design §E.1), against a test
 * server running the real outline routes on the isolated SQLite of `tests/preload.ts`:
 *
 *   - the menu of an open project task offers it; the picker lists the project's sessions the
 *     person may read that could do the task, named ones first, each with 「转交」 and
 *     「转交并开始」, under a line that says a new session is usually the better choice;
 *   - 「转交」 hands the task over (it moves under that session on the board, a task in progress
 *     goes back to to do) and starts nothing; the session is told by a system row;
 *   - 「转交并开始」 starts an idle session on the task (claimed for it), and says why a running one
 *     was not started (the hand-over stands, nothing is claimed);
 *   - in English and Chinese, light and dark, and in a 360 px wide viewport, where the picker
 *     stays inside the viewport and the page does not scroll sideways (containment only: no
 *     assertion depends on how wide a font draws CJK text).
 *
 * A model stand-in answers the one turn that is started (the provider module is replaced for this
 * file and put back after it).
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { ProviderAdapter } from "../../../../server/lib/agent/provider";
import { rowsAsHistory } from "../../../../tests/fixtures/model-input";
import { readTestMessageContent } from "../../../../tests/setup";
import type * as Fixture from "./task-board-transfer.browser-fixture";

const realProviderModule = { ...(await import("../../../../server/lib/agent/provider")) };
let turns = 0;
const testProvider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	async *chat(params) {
		turns++;
		params.onRequestStart?.();
		yield { text: "task turn ran" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
mock.module("../../../../server/lib/agent/provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "openai",
		requestedModel: "openai:test-model",
		provider: "openai",
		adapter: testProvider,
		model: "test-model",
	}),
}));

const { db, sqlite } = await import("../../../../server/db");
const { aclGrants, narratorMessageRefs, narratorMessages, narrators, projects, users } =
	await import("../../../../server/db/schema");
const { AppError } = await import("../../../../server/lib/errors");
const { generateId } = await import("../../../../server/lib/id");
const { settings } = await import("../../../../server/lib/settings");
const { outlineRoutes } = await import("../../../../server/routes/outline");
const { closeNarrator } = await import("../../../../server/services/narrator-session");
const { closePrefixSnapshotStore } = await import(
	"../../../../server/services/narrator-prefix-snapshots"
);
const { ensureProjectSpace } = await import("../../../../server/services/outline/spaces");
const { outlineStore } = await import("../../../../server/services/outline/store");
const { OUTLINE_TEAM_SOURCE, settleOutlineTeamEventsForTests, startOutlineTeamEvents } =
	await import("../../../../server/services/outline/team-events");
const { writeOutline } = await import("../../../../server/services/outline/write");
const { foldHandle } = await import("../../../../shared/narrator-handle");

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
/** Where screenshots go when asked for (`NF_TEST_SHOTS_DIR`); none otherwise. */
const shotsDir = process.env.NF_TEST_SHOTS_DIR ?? "";
const NOW = "2026-11-10T00:00:00.000Z";

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
	app.onError((error) =>
		error instanceof AppError
			? Response.json({ error: error.message, code: error.code }, { status: error.statusCode })
			: Response.json({ error: String(error) }, { status: 500 }),
	);
	app.route("/api/outline", outlineRoutes);
	return app;
}

async function session(
	projectId: string,
	title: string,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		title,
		traits: ["standalone"],
		model: "openai:test-model",
		permissionMode: "bypassPermissions",
		autoContinuationOverride: "off",
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

/** A project with a named session, two plain ones (one running) and three tasks. */
async function world() {
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `Atlas ${projectId.slice(0, 4)}`,
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const space = await ensureProjectSpace(projectId);
	const worker = await session(projectId, "Refresh work");
	const running = await session(projectId, "Long running job", { status: "working" });
	const handle = `Rev${generateId()
		.replace(/[^A-Za-z0-9]/g, "")
		.slice(0, 6)}`;
	const named = await session(projectId, "Reviewer", { handle, handleFold: foldHandle(handle) });
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks", alias: "tasks" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Fix the login bug",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Write the changelog",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Update the docs",
				task: { status: "todo" },
			},
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const [, login, changelog, docs] = written.results.map((r) => r.blockId) as string[];
	// The running session is doing one of them.
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "setTask", block: { id: docs as string }, task: { status: "doing" } }],
		actor: { kind: "agent", id: running },
		narratorId: running,
		responsibleUserId: alice,
	});
	return { projectId, space, worker, running, named, handle, login, changelog, docs } as {
		projectId: string;
		space: typeof space;
		worker: string;
		running: string;
		named: string;
		handle: string;
		login: string;
		changelog: string;
		docs: string;
	};
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	startOutlineTeamEvents();
	const bundle = await Bun.build({
		entrypoints: [new URL("./task-board-transfer.browser-fixture.tsx", import.meta.url).pathname],
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
	await db.insert(users).values({
		id: alice,
		username: `alice${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	if (shotsDir) mkdirSync(shotsDir, { recursive: true });
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
	await closePrefixSnapshotStore();
	mock.module("../../../../server/lib/agent/provider", () => realProviderModule);
	mock.restore();
});

async function openPage(width: number): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), alice);
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

/** Open a task's menu and its session picker; wait until the sessions are listed. */
async function openPicker(page: Page, title: string) {
	await page.click(`[data-testid=task-row][data-title="${title}"] [data-testid=task-row-menu]`);
	await page.waitForSelector("[data-testid=task-action-transfer]", { visible: true });
	const label = await call(page, (f) => f.menuItem("task-action-transfer"));
	await page.click("[data-testid=task-action-transfer]");
	// Listed, and the popover's opening transition over (a screenshot shows it opaque).
	await until(
		page,
		"the sessions",
		(f) => (f.picker()?.sessions.length ?? 0) > 0 && f.picker()?.opacity === 1,
	);
	return label;
}

async function shot(page: Page, name: string) {
	if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) as `${string}.png` });
}

const state = async (blockId: string) => {
	const [claim] = await outlineStore.getTaskClaims([blockId]);
	const task = (await outlineStore.getBlock(blockId))?.taskJson;
	return {
		status: task?.status,
		assignee: task?.assignee ?? null,
		holder: claim?.holderNarratorId ?? null,
	};
};

async function teamRows(narratorId: string): Promise<string[]> {
	await settleOutlineTeamEventsForTests();
	const rows = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		readTestMessageContent(sqlite, row.id)
			.filter((b) => b.type === "system_injection" && b.source === OUTLINE_TEAM_SOURCE)
			.map((b) => String(b.modelText)),
	);
}

/** Relative luminance of a CSS colour (`rgb(…)`, `rgba(…)`, `color(srgb …)`). */
function luminance(color: string): number {
	const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(color);
	const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
	const [r, g, b] = srgb
		? [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])]
		: rgb
			? [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255]
			: [Number.NaN, Number.NaN, Number.NaN];
	const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r as number) + 0.7152 * lin(g as number) + 0.0722 * lin(b as number);
}

test("hand a task to a session, and hand over and start: English, light", async () => {
	const w = await world();
	const { page, errors } = await openPage(900);
	try {
		await call(
			page,
			(f, id: string) => f.open(id, { scheme: "light", width: 720, language: "en" }),
			w.projectId,
		);
		await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 3);
		expect(await openPicker(page, "Fix the login bug")).toBe("Hand to a session…");
		const picker = await call(page, (f) => f.picker());
		expect(picker?.note).toBe(
			"An existing session brings its earlier context along. A new session is usually the better choice.",
		);
		// The named session first, by its title and handle; then the others. All three can take it.
		expect(picker?.sessions[0]).toEqual({
			id: w.named,
			text: `Reviewer@${w.handle}`,
			only: "Hand over",
			start: "Hand over and start",
		});
		expect(picker?.sessions.map((s) => s.id).sort()).toEqual([w.named, w.worker, w.running].sort());
		expect(luminance(picker?.background ?? "")).toBeGreaterThan(0.8);
		await shot(page, "transfer-en-light-900");

		// 「转交」 to the named session: written, shown under it, nothing started.
		const namedIndex = 0;
		await call(page, (f, i: number) => f.click("[data-testid=task-transfer-only]", i), namedIndex);
		await until(
			page,
			"the task under the reviewer",
			(f) => f.row("Fix the login bug")?.group === "Reviewer",
		);
		expect(await state(w.login)).toEqual({
			status: "todo",
			assignee: `agent:${w.named}`,
			holder: null,
		});
		const told = await teamRows(w.named);
		expect(told).toHaveLength(1);
		expect(told[0]).toContain("Fix the login bug");
		expect(turns).toBe(0);
		expect(await call(page, (f) => f.notices())).toEqual([]);

		// 「转交并开始」 to the idle session: started on it, claimed for it.
		await openPicker(page, "Write the changelog");
		const sessions = (await call(page, (f) => f.picker()))?.sessions ?? [];
		const workerIndex = sessions.findIndex((s) => s.id === w.worker);
		await call(
			page,
			(f, i: number) => f.click("[data-testid=task-transfer-start]", i),
			workerIndex,
		);
		await until(page, "the start to be said", (f) =>
			f.notices().includes("Handed over; the session started on it."),
		);
		await until(
			page,
			"the task in progress under the worker",
			(f) =>
				f.row("Write the changelog")?.status === "doing" &&
				f.row("Write the changelog")?.group === "Refresh work",
		);
		expect(await state(w.changelog)).toEqual({
			status: "doing",
			assignee: `agent:${w.worker}`,
			holder: w.worker,
		});
		// The turn it started asks the model once, and ends.
		const deadline = Date.now() + 10_000;
		for (;;) {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, w.worker),
				columns: { status: true },
			});
			if (turns >= 1 && row?.status === "idle") break;
			if (Date.now() > deadline) throw new Error("the started turn did not run");
			await Bun.sleep(10);
		}
		expect(turns).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		closeNarrator(w.worker);
		await page.browserContext().close();
	}
}, 60_000);

test("a task in progress handed to a running session: back to to do, said why it was not started: 中文, dark, 360 px", async () => {
	const w = await world();
	const { page, errors } = await openPage(360);
	const before = turns;
	try {
		await call(
			page,
			(f, id: string) => f.open(id, { scheme: "dark", width: 360, language: "zh-CN" }),
			w.projectId,
		);
		await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 3);
		expect(await openPicker(page, "Fix the login bug")).toBe("转交给会话…");
		const picker = await call(page, (f) => f.picker());
		expect(picker?.note).toBe("旧会话带着以前的上下文；一般让新会话做更合适。");
		expect(picker?.sessions[0]).toMatchObject({ id: w.named, only: "转交", start: "转交并开始" });
		// Inside the 360 px viewport, the page not scrolling sideways, no button's words cut off.
		expect(picker?.viewport).toBe(360);
		expect(picker?.left).toBeGreaterThanOrEqual(0);
		expect(picker?.right).toBeLessThanOrEqual(360);
		expect(picker?.pageScrollWidth).toBeLessThanOrEqual(360);
		for (const button of picker?.buttons ?? []) {
			expect(button.left).toBeGreaterThanOrEqual(0);
			expect(button.right).toBeLessThanOrEqual(360);
			expect(button.scroll).toBeLessThanOrEqual(button.client + 1);
		}
		expect(luminance(picker?.background ?? "")).toBeLessThan(0.2);
		expect(luminance(picker?.color ?? "")).toBeGreaterThan(0.4);
		await shot(page, "transfer-zh-dark-360");

		// The running session: handed over, not started, and the board says why.
		const index = (picker?.sessions ?? []).findIndex((s) => s.id === w.running);
		await call(page, (f, i: number) => f.click("[data-testid=task-transfer-start]", i), index);
		await until(page, "why it was not started", (f) =>
			f.notices().includes("已转交。会话正在运行，没有另外启动；它会读到这次转交。"),
		);
		expect(await state(w.login)).toEqual({
			status: "todo",
			assignee: `agent:${w.running}`,
			holder: null,
		});
		await shot(page, "transfer-zh-dark-360-not-started");

		// A task the running session is doing, handed to another: it stops (back to to do).
		await until(page, "the notice to leave the menu free", (f) => f.picker() === null);
		await openPicker(page, "Update the docs");
		const again = (await call(page, (f) => f.picker()))?.sessions ?? [];
		await call(
			page,
			(f, i: number) => f.click("[data-testid=task-transfer-only]", i),
			again.findIndex((s) => s.id === w.worker),
		);
		await until(
			page,
			"the docs task back to to do",
			(f) => f.row("Update the docs")?.status === "todo",
		);
		expect(await state(w.docs)).toEqual({
			status: "todo",
			assignee: `agent:${w.worker}`,
			holder: null,
		});
		expect(turns).toBe(before);
		expect(errors).toEqual([]);
	} finally {
		await page.browserContext().close();
	}
}, 60_000);

test("the picker in Chinese light at 360 px and English dark: the same sessions and actions; no 「转交并开始」 for a session the person may not write", async () => {
	const w = await world();
	// A teammate's session of the project that alice may read, not write: it can be handed the
	// task, but starting it is not hers to ask.
	const bob = generateId();
	await db.insert(users).values({
		id: bob,
		username: `bob${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const theirs = await session(w.projectId, "A teammate's session", { ownerUserId: bob });
	for (const [scopeType, scopeId, principalId, capability] of [
		["project", w.projectId, bob, "write"],
		["narrator", theirs, alice, "read"],
	] as const)
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType,
			scopeId,
			principalType: "user",
			principalId,
			capability,
			createdAt: NOW,
		});
	for (const [scheme, language, width, words] of [
		["light", "zh-CN", 360, { only: "转交", start: "转交并开始" }],
		["dark", "en", 900, { only: "Hand over", start: "Hand over and start" }],
	] as const) {
		const { page, errors } = await openPage(width);
		try {
			await call(
				page,
				(f, id: string, options: { scheme: "light" | "dark"; width: number; language: string }) =>
					f.open(id, options),
				w.projectId,
				{ scheme, language, width: Math.min(width, 720) },
			);
			await until(page, "the board", (f) => f.count("[data-testid=task-row]") === 3);
			await openPicker(page, "Fix the login bug");
			const picker = await call(page, (f) => f.picker());
			expect(picker?.sessions).toHaveLength(4);
			for (const s of picker?.sessions ?? [])
				expect(s).toMatchObject(s.id === theirs ? { only: words.only, start: "" } : words);
			expect(picker?.left).toBeGreaterThanOrEqual(0);
			expect(picker?.right).toBeLessThanOrEqual(width);
			expect(picker?.pageScrollWidth).toBeLessThanOrEqual(width);
			const light = luminance(picker?.background ?? "");
			if (scheme === "light") expect(light).toBeGreaterThan(0.8);
			else expect(light).toBeLessThan(0.2);
			await shot(page, `transfer-${language === "en" ? "en" : "zh"}-${scheme}-${width}`);
			expect(errors).toEqual([]);
		} finally {
			await page.browserContext().close();
		}
	}
}, 60_000);
