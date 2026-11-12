/**
 * Answering questions from the inbox (P2 PR 7), in Chromium, against a test server running the
 * real outline routes and the human-attention list (the isolated SQLite of `tests/preload.ts`):
 *
 * No recommended answer is selected implicitly. Text overrides options; only an explicit,
 * complete submission reaches the real answer API. Drafts survive failures/unmounts and are
 * shared by inbox, outline and narrator Ask entries without mixing different Ask calls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import {
	narrators,
	outlineCommits,
	outlineQuestions,
	projects,
	users,
} from "../../../server/db/schema";
import { askTool } from "../../../server/lib/agent/tools/outline";
import type { ToolContext } from "../../../server/lib/agent/types";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import {
	getHumanAttentionForPrincipal,
	listHumanAttentionForPrincipal,
} from "../../../server/services/human-attention-service";
import { setOutlineAnswerDelivery } from "../../../server/services/outline/questions";
import { ensureProjectSpace } from "../../../server/services/outline/spaces";
import { outlineStore } from "../../../server/services/outline/store";
import type { OutlineSpaceRow } from "../../../server/services/outline/store/port";
import { writeOutline } from "../../../server/services/outline/write";
import type * as Fixture from "./outline-inbox.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-11-03T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let session: string;
let space: OutlineSpaceRow;
let task: { blockId: string; sid: string };
const told: Array<{ narratorId: string; content: string }> = [];

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
	// The inbox list and a row's detail, as the narrator routes serve them.
	const principal = (token: string) => ({ userId: token, isAdmin: false });
	app.get("/api/narrators/human-attention", async (c) => {
		const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
		return c.json(
			await listHumanAttentionForPrincipal(principal(token), {
				cursor: c.req.query("cursor") || undefined,
				limit: Number(c.req.query("limit") ?? 50),
			}),
		);
	});
	app.get("/api/narrators/human-attention/:id", async (c) => {
		const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
		return c.json(await getHumanAttentionForPrincipal(principal(token), c.req.param("id")));
	});
	app.route("/api/outline", outlineRoutes);
	return app;
}

function toolCtx(): ToolContext {
	return {
		narratorId: session,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId: alice,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-inbox.browser-fixture.tsx", import.meta.url).pathname],
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
					`<!doctype html><html><head><meta charset="utf-8">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
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
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Importer",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	session = generateId();
	await db.insert(narrators).values({
		id: session,
		title: "Importer worker",
		ownerUserId: alice,
		visibility: "private",
		contextProjectId: projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "page", parent: null, content: "Importer" },
			{
				op: "insert",
				parent: { tempId: "page" },
				content: "Ship the importer",
				task: { status: "todo" },
			},
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	task = written.results[1] as { blockId: string; sid: string };
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
		actor: { kind: "agent", id: session },
		narratorId: session,
		responsibleUserId: alice,
	});
	setOutlineAnswerDelivery({
		async deliver(narratorId, message) {
			told.push({ narratorId, content: message.content });
			return { written: true, woke: false };
		},
	});
}, 60_000);

beforeEach(() => {
	// Another suite's teardown may have switched it off in this process.
	settings.outline.enabled = true;
});

afterEach(async () => {
	// Some cases intentionally leave unanswered questions. They must not leak into the next
	// inbox group (all questions under Importer share that same real group).
	const rows = await db
		.select()
		.from(outlineQuestions)
		.where(eq(outlineQuestions.askerNarratorId, session));
	const blocks = await outlineStore.getBlocks(
		rows.filter((q) => q.state === "open").map((q) => q.blockId),
	);
	if (blocks.length) {
		const withdrawn = await askTool.execute(
			{ withdraw: blocks.map((b) => `${space.key}/${b.sid}`) },
			toolCtx(),
		);
		expect(withdrawn.isError).toBeUndefined();
	}
	for (const context of browser.browserContexts()) {
		if (context !== browser.defaultBrowserContext()) await context.close();
	}
	told.length = 0;
});

afterAll(async () => {
	setOutlineAnswerDelivery(null);
	await browser?.close();
	server?.stop(true);
});

async function openInbox(
	options: Parameters<typeof Fixture.open>[0] = {},
	token = alice,
): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: 1240, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((value) => localStorage.setItem("narrafork_token", value), token);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate((opts) => (window as unknown as FixtureWindow).fixture.open(opts), options);
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
			timeout: 15_000,
			polling: 50,
		});
	} catch (error) {
		const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
		throw new Error(`timed out waiting for ${what}: ${String(error)}\n--- page ---\n${text}`);
	}
}

test("a group of questions is one inbox row, answered at once as the person", async () => {
	const asked = await askTool.execute(
		{
			questions: [
				{
					question: "Which export format do we read first?",
					options: ["v1", "v2"],
					recommend: 2,
					reason: "every export since March is v2",
					items: [{ question: "Keep reading v1 at all?", options: ["no", "yes"], recommend: 2 }],
				},
				{ question: "Fail on unknown columns?", recommend: "warn and skip them" },
			],
		},
		toolCtx(),
	);
	expect(asked.isError).toBeUndefined();
	const [q1, q1a, q2] = asked.metadata?.blockIds as [string, string, string];
	const row = `[data-attention-id="outline:q:${task.blockId}"]`;

	const { page, errors } = await openInbox();
	await until(page, "the inbox row", (f, sel) => f.exists(sel as never), row);
	expect(await call(page, (f, sel) => f.count(sel as never), "[data-attention-id]")).toBe(1);
	await call(
		page,
		(f, sel) => f.click(sel as never),
		`${row} [data-testid=outline-attention-review]`,
	);
	await until(
		page,
		"the three questions",
		(f) => f.count("[data-testid=outline-questions] [data-state=open]" as never) === 3,
	);
	// Recommendations are explanatory only; every question needs an explicit answer.
	const option = (id: string, n: number) =>
		`[data-testid=outline-question-${id}] [data-testid=outline-question-option-${n}]`;
	expect(await call(page, (f, sel) => f.checked(sel as never), option(q1, 2))).toBe(false);
	expect(await call(page, (f, sel) => f.checked(sel as never), option(q1a, 2))).toBe(false);
	expect(await call(page, (f) => f.count("[data-testid=outline-question-text]"))).toBe(3);
	expect(await call(page, (f) => f.count("[data-testid=outline-questions-submit]"))).toBe(1);
	expect(await call(page, (f) => f.exists("[data-testid=outline-questions-adopt-all]"))).toBe(
		false,
	);
	expect(await call(page, (f) => f.disabled("[data-testid=outline-questions-submit]"))).toBe(true);
	// The person disagrees on one, writes another answer, and still must answer the child.
	await call(page, (f, sel) => f.click(sel as never), option(q1, 1));
	await until(page, "option 1 checked", (f, sel) => f.checked(sel as never), option(q1, 1));
	await call(
		page,
		(f, sel, text) => f.type(sel as never, text as never),
		`[data-testid=outline-question-${q2}] [data-testid=outline-question-text]`,
		"skip them, and list them in the report",
	);
	expect(await call(page, (f) => f.disabled("[data-testid=outline-questions-submit]"))).toBe(true);
	await call(page, (f, sel) => f.click(sel as never), "[data-testid=outline-questions-submit]");
	expect((await outlineStore.getQuestions([q1, q1a, q2])).every((q) => q.state === "open")).toBe(
		true,
	);
	await call(page, (f, sel) => f.click(sel as never), option(q1a, 2));
	await until(
		page,
		"all answers explicit",
		(f) => !f.disabled("[data-testid=outline-questions-submit]"),
	);
	await call(page, (f, sel) => f.click(sel as never), "[data-testid=outline-questions-submit]");
	await until(page, "the row to go", (f, sel) => !f.exists(sel as never), row);

	const rows = await outlineStore.getQuestions([q1, q1a, q2]);
	expect(rows.map((r) => r.state)).toEqual(["answered", "answered", "answered"]);
	const commits = new Set(rows.map((r) => r.answerCommitId));
	expect(commits.size).toBe(1);
	const [commit] = await db
		.select()
		.from(outlineCommits)
		.where(eq(outlineCommits.id, [...commits][0] as string));
	expect(commit).toMatchObject({ kind: "answer", actorKind: "human", actorId: alice });
	const answers = new Map(
		(await outlineStore.getBlocks([q1, q1a, q2])).map((b) => [b.id, b.askJson?.answer]),
	);
	expect(answers.get(q1)).toMatchObject({ option: 1 });
	expect(answers.get(q1)?.adopted).toBeUndefined();
	expect(answers.get(q1a)).toMatchObject({ option: 2 });
	expect(answers.get(q1a)?.adopted).toBe(true);
	expect(answers.get(q2)).toMatchObject({ text: "skip them, and list them in the report" });
	// The asking session is told once, of all three.
	expect(told.map((t) => t.narratorId)).toEqual([session]);
	expect(told[0]?.content).toContain("Keep reading v1 at all?");
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("custom multiline text overrides a selected recommendation and submits only that text", async () => {
	const asked = await askTool.execute(
		{
			under: "Importer",
			questions: [
				{ question: "Name the flag --strict?", recommend: "yes" },
				{ question: "Log skipped rows?", options: ["no", "yes"], recommend: 2 },
			],
		},
		toolCtx(),
	);
	expect(asked.output).toStartWith("Asked");
	const ids = asked.metadata?.blockIds as string[];
	const group = asked.metadata?.groupBlockId as string;
	const row = `[data-attention-id="outline:q:${group}"]`;
	const { page, errors } = await openInbox();
	await until(page, "the inbox row", (f, sel) => f.exists(sel as never), row);
	await call(
		page,
		(f, sel) => f.click(sel as never),
		`${row} [data-testid=outline-attention-review]`,
	);
	await until(
		page,
		"the answer fields",
		(f) => f.count("[data-testid=outline-question-text]") === 2,
	);
	const text = `Do not adopt the recommendation.\n${"Keep the authored details, 中文与 punctuation. ".repeat(50)}\nFinal line.`;
	const card = `[data-testid=outline-question-${ids[1]}]`;
	const option = `${card} [data-testid=outline-question-option-2]`;
	const input = `${card} [data-testid=outline-question-text]`;
	await call(page, (f, sel) => f.click(sel as never), option);
	await until(
		page,
		"recommendation explicitly selected",
		(f, sel) => f.checked(sel as never),
		option,
	);
	await call(page, (f, sel, value) => f.type(sel as never, value as never), input, text);
	await until(
		page,
		"text takes precedence",
		(f, sel) => f.disabled(sel as never) && !f.checked(sel as never),
		option,
	);
	await call(
		page,
		(f, sel, value) => f.type(sel as never, value as never),
		`[data-testid=outline-question-${ids[0]}] textarea`,
		"Use --validate-only instead.",
	);
	await until(page, "submit enabled", (f) => !f.disabled("[data-testid=outline-questions-submit]"));
	if (process.env.NF_OUTLINE_SCREENSHOT) {
		await page.setViewport({ width: 420, height: 900 });
		await page.screenshot({ path: ".narrafork/outline-inbox-answer.png", fullPage: true });
	}
	await call(page, (f) => f.click("[data-testid=outline-questions-submit]"));
	await until(page, "the row to go", (f, sel) => !f.exists(sel as never), row);
	const answers = new Map(
		(await outlineStore.getBlocks(ids)).map((b) => [b.id, b.askJson?.answer]),
	);
	expect(answers.get(ids[1] as string)).toMatchObject({ text });
	expect(answers.get(ids[1] as string)?.option).toBeUndefined();
	expect(answers.get(ids[1] as string)?.adopted).toBeUndefined();
	expect(answers.get(ids[0] as string)).toMatchObject({ text: "Use --validate-only instead." });
	expect(new Set((await outlineStore.getQuestions(ids)).map((r) => r.answerCommitId)).size).toBe(1);
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("a question changed after it was read is refused and read again; its link opens the outline", async () => {
	const asked = await askTool.execute(
		{
			under: "Importer",
			questions: [{ question: "Delete the STAGING data?", options: ["no", "yes"], recommend: 2 }],
		},
		toolCtx(),
	);
	const [q] = asked.metadata?.blockIds as [string];
	const group = asked.metadata?.groupBlockId as string;
	const row = `[data-attention-id="outline:q:${group}"]`;
	const card = `[data-testid=outline-question-${q}]`;
	const { page, errors } = await openInbox();
	await until(page, "the inbox row", (f, sel) => f.exists(sel as never), row);
	await call(
		page,
		(f, sel) => f.click(sel as never),
		`${row} [data-testid=outline-attention-review]`,
	);
	await until(page, "the question", (f, sel) => f.exists(sel as never), card);
	await call(
		page,
		(f, sel, text) => f.type(sel as never, text as never),
		`${card} textarea`,
		"Only staging, never production.",
	);
	await until(
		page,
		"authored answer ready",
		(f) => !f.disabled("[data-testid=outline-questions-submit]"),
	);
	// The asking session rewrites it while the person has it open.
	await writeOutline({
		spaceId: (await outlineStore.getBlock(q))?.spaceId as string,
		ops: [{ op: "update", block: { id: q }, content: "Delete the PRODUCTION data?" }],
		actor: { kind: "agent", id: session },
		narratorId: session,
		responsibleUserId: alice,
	});
	await call(page, (f, sel) => f.click(sel as never), "[data-testid=outline-questions-submit]");
	await until(
		page,
		"the question read again",
		(f, sel) => (f.textOf(sel as never) ?? "").includes("PRODUCTION"),
		card,
	);
	expect(await call(page, () => document.body.innerText.includes("A question changed"))).toBe(true);
	expect((await outlineStore.getBlock(q))?.askJson?.answer).toBeUndefined();
	expect(await call(page, (f, sel) => f.value(sel as never), `${card} textarea`)).toBe(
		"Only staging, never production.",
	);

	// "Open in the outline" goes to the block through the app's routes, closing the inbox.
	await call(page, (f, sel) => f.click(sel as never), "[data-testid=outline-questions] a");
	await until(page, "the outline route", (f) => f.location().href.startsWith("/outline/"));
	const at = await call(page, (f) => f.location());
	expect(at.href).toContain(`/${group}`);
	expect(at.href).toContain("view=all");
	expect(at.closed).toBeGreaterThan(0);
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

const submit = "[data-testid=outline-questions-submit]";
const cardOf = (id: string) => `[data-testid=outline-question-${id}]`;
const fieldOf = (id: string) => `${cardOf(id)} textarea`;

test("inbox, outline section and narrator Ask slot share drafts and refresh after one answer", async () => {
	const asked = await askTool.execute(
		{
			under: "Importer",
			questions: [{ question: "Which retry policy?", options: ["retry", "fail"], recommend: 1 }],
		},
		toolCtx(),
	);
	expect(asked.isError).toBeUndefined();
	const [q] = asked.metadata?.blockIds as [string];
	const group = asked.metadata?.groupBlockId as string;
	const row = `[data-attention-id="outline:q:${group}"]`;
	const { page, errors } = await openInbox({
		panes: [
			{ id: "outline", entry: "outline", spaceId: space.id, blockId: q },
			{ id: "narrator", entry: "narrator", spaceId: space.id, blockId: q, questionIds: [q] },
		],
	});
	await until(page, "inbox entry", (f, sel) => f.exists(sel as never), row);
	await call(
		page,
		(f, sel) => f.click(sel as never),
		`${row} [data-testid=outline-attention-review]`,
	);
	await until(page, "three real entry forms", (f, sel) => f.count(sel as never) === 3, fieldOf(q));
	const option = `${cardOf(q)} [data-testid=outline-question-option-2]`;
	await call(page, (f, sel) => f.click(sel as never), `[data-pane=outline] ${option}`);
	await until(
		page,
		"selection shared across three entries",
		(_f, sel) =>
			Array.from(document.querySelectorAll<HTMLInputElement>(sel as never)).every(
				(el) => el.checked,
			),
		option,
	);
	const text = "Custom retry policy\nBack off for 7 seconds, then report the original error.";
	await call(
		page,
		(f, sel, value) => f.type(sel as never, value as never),
		`${row} ${fieldOf(q)}`,
		text,
	);
	await until(
		page,
		"custom text shared across three entries",
		(_f, sel, value) =>
			Array.from(document.querySelectorAll<HTMLTextAreaElement>(sel as never)).every(
				(el) => el.value === value,
			),
		fieldOf(q),
		text,
	);
	expect(
		await call(
			page,
			(_f, sel) =>
				Array.from(document.querySelectorAll<HTMLInputElement>(sel as never)).every(
					(el) => !el.checked && el.disabled,
				),
			option,
		),
	).toBe(true);
	await call(page, (f) =>
		f.click(`[data-pane=narrator] ${"[data-testid=outline-questions-submit]"}`),
	);
	await until(page, "inbox answered row removed", (f, sel) => !f.exists(sel as never), row);
	await until(
		page,
		"outline and narrator show readonly answer",
		(f, sel) => f.count(sel as never) === 2,
		`${cardOf(q)} [data-testid=outline-question-answer]`,
	);
	expect(await call(page, (f, sel) => f.count(sel as never), fieldOf(q))).toBe(0);
	expect((await outlineStore.getBlock(q))?.askJson?.answer).toMatchObject({ text });
	expect((await outlineStore.getBlock(q))?.askJson?.answer?.adopted).toBeUndefined();
	expect(told).toHaveLength(1);
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("failed submit and complete form unmount preserve the exact draft for retry", async () => {
	const asked = await askTool.execute(
		{
			under: "Importer",
			questions: [
				{ question: "Describe the rollout", options: ["default", "staged"], recommend: 1 },
			],
		},
		toolCtx(),
	);
	const [q] = asked.metadata?.blockIds as [string];
	const { page, errors } = await openInbox({
		inbox: false,
		panes: [{ id: "draft", entry: "form", spaceId: space.id, blockId: q }],
	});
	await until(page, "draft form", (f, sel) => f.exists(sel as never), fieldOf(q));
	const text = `Rollout notes\n${"Keep every authored line exactly. ".repeat(80)}\nDone.`;
	await call(page, (f, sel, value) => f.type(sel as never, value as never), fieldOf(q), text);
	let requests = 0;
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		if (request.url().endsWith("/api/outline/questions/answer") && request.method() === "POST") {
			requests++;
			if (requests === 1) {
				void request.respond({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "Temporary answer failure" }),
				});
				return;
			}
		}
		void request.continue();
	});
	await until(page, "submit ready", (f, sel) => !f.disabled(sel as never), submit);
	await call(page, (f, sel) => f.click(sel as never), submit);
	await until(page, "failure shown", (f) =>
		(f.textOf("[role=alert]") ?? "").includes("Temporary answer failure"),
	);
	expect(await call(page, (f, sel) => f.value(sel as never), fieldOf(q))).toBe(text);
	expect((await outlineStore.getBlock(q))?.askJson?.answer).toBeUndefined();
	await call(page, (f) => f.hidePanes(["draft"]));
	await until(page, "form unmounted", (f, sel) => !f.exists(sel as never), fieldOf(q));
	await call(page, (f) => f.hidePanes([]));
	await until(
		page,
		"draft restored on remount",
		(f, sel, value) => f.value(sel as never) === value,
		fieldOf(q),
		text,
	);
	await call(page, (f, sel) => f.click(sel as never), submit);
	await until(
		page,
		"retry answered",
		(f, sel) => f.exists(sel as never),
		`${cardOf(q)} [data-testid=outline-question-answer]`,
	);
	expect(requests).toBe(2);
	expect((await outlineStore.getBlock(q))?.askJson?.answer).toMatchObject({ text });
	expect((await outlineStore.getBlock(q))?.askJson?.answer?.adopted).toBeUndefined();
	expect(told).toHaveLength(1);
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("two Ask calls on one task stay isolated and overlapping roots never duplicate child questions", async () => {
	const first = await askTool.execute(
		{
			questions: [
				{
					question: "First Ask parent",
					recommend: "parent default",
					items: [{ question: "First Ask child", recommend: "child default" }],
				},
			],
		},
		toolCtx(),
	);
	const second = await askTool.execute(
		{ questions: [{ question: "Second Ask only", recommend: "second default" }] },
		toolCtx(),
	);
	expect(first.isError).toBeUndefined();
	expect(second.isError).toBeUndefined();
	const [parent, child] = first.metadata?.blockIds as [string, string];
	const [other] = second.metadata?.blockIds as [string];
	const { page, errors } = await openInbox({
		inbox: false,
		panes: [
			{
				id: "first",
				entry: "narrator",
				spaceId: space.id,
				blockId: task.blockId,
				questionRootIds: [task.blockId, parent, child],
				questionIds: [parent, child],
			},
			{
				id: "second",
				entry: "narrator",
				spaceId: space.id,
				blockId: task.blockId,
				questionRootIds: [task.blockId],
				questionIds: [other],
			},
		],
	});
	await until(
		page,
		"first Ask has exactly two questions",
		(f) => f.count("[data-pane=first] [data-state=open]") === 2,
	);
	await until(
		page,
		"second Ask has exactly one question",
		(f) => f.count("[data-pane=second] [data-state=open]") === 1,
	);
	expect(await call(page, (f, sel) => f.count(sel as never), cardOf(child))).toBe(1);
	expect(
		await call(page, (f, sel) => f.exists(sel as never), `[data-pane=first] ${cardOf(other)}`),
	).toBe(false);
	for (const [id, text] of [
		[parent, "Explicit parent"],
		[child, "Explicit child"],
		[other, "Independent second draft"],
	]) {
		await call(
			page,
			(f, sel, value) => f.type(sel as never, value as never),
			fieldOf(id as string),
			text,
		);
	}
	await until(
		page,
		"first Ask ready",
		(f) => !f.disabled("[data-pane=first] [data-testid=outline-questions-submit]"),
	);
	await call(page, (f) => f.click("[data-pane=first] [data-testid=outline-questions-submit]"));
	await until(
		page,
		"first Ask answered",
		(f) => f.count("[data-pane=first] [data-state=answered]") === 2,
	);
	expect((await outlineStore.getQuestions([other]))[0]?.state).toBe("open");
	expect(await call(page, (f, sel) => f.value(sel as never), fieldOf(other))).toBe(
		"Independent second draft",
	);
	expect(told).toHaveLength(1);
	await call(page, (f) => f.click("[data-pane=second] [data-testid=outline-questions-submit]"));
	await until(
		page,
		"second Ask independently answered",
		(f) => f.count("[data-pane=second] [data-state=answered]") === 1,
	);
	const rows = await outlineStore.getQuestions([parent, child, other]);
	expect(new Set(rows.map((q) => q.answerCommitId)).size).toBe(2);
	expect(told).toHaveLength(2);
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("background refresh and remount keep the original version; a delayed conflict preserves newer cross-entry text", async () => {
	const asked = await askTool.execute(
		{
			under: "Importer",
			questions: [{ question: "Apply to STAGING?", options: ["yes", "no"], recommend: 1 }],
		},
		toolCtx(),
	);
	const [q] = asked.metadata?.blockIds as [string];
	const original = await outlineStore.getBlock(q);
	const { page, errors } = await openInbox({
		inbox: false,
		panes: [
			{ id: "outline", entry: "outline", spaceId: space.id, blockId: q },
			{ id: "narrator", entry: "narrator", spaceId: space.id, blockId: q },
		],
	});
	await until(page, "both entries mounted", (f, sel) => f.count(sel as never) === 2, fieldOf(q));
	await call(
		page,
		(f, sel, value) => f.type(sel as never, value as never),
		`[data-pane=narrator] ${fieldOf(q)}`,
		"Only staging.",
	);
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "update", block: { id: q }, content: "Apply to PRODUCTION?" }],
		actor: { kind: "agent", id: session },
		narratorId: session,
		responsibleUserId: alice,
	});
	await call(page, (f) => f.refreshQuestions());
	await until(
		page,
		"background question revision read",
		(f, sel) => (f.textOf(sel as never) ?? "").includes("PRODUCTION"),
		`[data-pane=narrator] ${cardOf(q)}`,
	);
	await call(page, (f) => f.hidePanes(["outline", "narrator"]));
	await until(page, "both entries unmounted", (f, sel) => f.count(sel as never) === 0, fieldOf(q));
	await call(page, (f) => f.hidePanes([]));
	await until(
		page,
		"old draft restored",
		(f, sel) => f.value(sel as never) === "Only staging.",
		`[data-pane=narrator] ${fieldOf(q)}`,
	);

	await page.setRequestInterception(true);
	let held = false;
	const pending = new Promise<HTTPRequest>((resolve) => {
		page.on("request", (request) => {
			if (
				!held &&
				request.url().endsWith("/api/outline/questions/answer") &&
				request.method() === "POST"
			) {
				held = true;
				resolve(request);
			} else void request.continue();
		});
	});
	await call(page, (f) => f.click("[data-pane=narrator] [data-testid=outline-questions-submit]"));
	const request = await pending;
	const payload = JSON.parse(request.postData() ?? "{}");
	expect(payload.answers[0]).toMatchObject({
		blockId: q,
		versionSeq: original?.versionSeq,
		text: "Only staging.",
	});
	const newer = "Only staging.\nAnother entry added: production is explicitly forbidden.";
	await call(
		page,
		(f, sel, value) => f.type(sel as never, value as never),
		`[data-pane=outline] ${fieldOf(q)}`,
		newer,
	);
	await until(
		page,
		"newer shared draft",
		(f, sel) => (f.value(sel as never) ?? "").includes("explicitly forbidden"),
		`[data-pane=narrator] ${fieldOf(q)}`,
	);
	const response = page.waitForResponse((result) =>
		result.url().endsWith("/api/outline/questions/answer"),
	);
	await request.continue();
	expect((await response).status()).toBe(409);
	await until(page, "real version conflict", (f) =>
		(f.textOf("[data-pane=narrator] [role=alert]") ?? "").includes("A question changed"),
	);
	for (const pane of ["outline", "narrator"]) {
		expect(
			await call(page, (f, sel) => f.value(sel as never), `[data-pane=${pane}] ${fieldOf(q)}`),
		).toBe(newer);
	}
	expect((await outlineStore.getBlock(q))?.askJson?.answer).toBeUndefined();
	await call(page, (f) => f.click("[data-pane=narrator] [data-testid=outline-questions-submit]"));
	await until(
		page,
		"explicit retry succeeds",
		(f, sel) => f.count(sel as never) === 2,
		`${cardOf(q)} [data-testid=outline-question-answer]`,
	);
	expect((await outlineStore.getBlock(q))?.askJson?.answer).toMatchObject({ text: newer });
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("answered, withdrawn, explicit read-only and another person's questions have no answer controls", async () => {
	const asked = await askTool.execute(
		{
			under: "Importer",
			questions: [
				{ question: "Already decided", recommend: "yes" },
				{ question: "No longer relevant", recommend: "yes" },
				{ question: "Only Alice can answer", options: ["yes", "no"], recommend: 1 },
			],
		},
		toolCtx(),
	);
	const [answered, withdrawn, open] = asked.metadata?.blockIds as [string, string, string];
	const result = await fetch(`${server.url.origin}/api/outline/questions/answer`, {
		method: "POST",
		headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" },
		body: JSON.stringify({
			answers: [
				{
					blockId: answered,
					versionSeq: (await outlineStore.getBlock(answered))?.versionSeq,
					text: "Already answered explicitly",
				},
			],
		}),
	});
	expect(result.status).toBe(200);
	const withdrawnBlock = await outlineStore.getBlock(withdrawn);
	expect(
		(await askTool.execute({ withdraw: [`${space.key}/${withdrawnBlock?.sid}`] }, toolCtx()))
			.isError,
	).toBeUndefined();
	const owner = await openInbox({
		inbox: false,
		panes: [
			{ id: "answered", entry: "form", spaceId: space.id, blockId: answered },
			{ id: "withdrawn", entry: "form", spaceId: space.id, blockId: withdrawn },
			{ id: "readonly", entry: "form", spaceId: space.id, blockId: open, readOnly: true },
		],
	});
	await until(
		owner.page,
		"terminal questions rendered",
		(f) => f.count("[data-testid=outline-question-answer]") === 2,
	);
	await until(
		owner.page,
		"readonly open question rendered",
		(f, sel) => f.exists(sel as never),
		cardOf(open),
	);
	expect(
		await call(owner.page, (f) =>
			f.count("textarea, input[type=radio], [data-testid=outline-questions-submit]"),
		),
	).toBe(0);
	const bob = generateId();
	await db
		.insert(users)
		.values({ id: bob, username: "bob", passwordHash: "x", role: "user", createdAt: NOW });
	await db
		.update(projects)
		.set({ visibility: "public" })
		.where(eq(projects.id, space.projectId as string));
	try {
		const foreign = await openInbox(
			{ inbox: false, panes: [{ id: "foreign", entry: "form", spaceId: space.id, blockId: open }] },
			bob,
		);
		await until(
			foreign.page,
			"another person's question",
			(f, sel) => (f.textOf(sel as never) ?? "").includes("alice"),
			cardOf(open),
		);
		expect(
			await call(foreign.page, (f) =>
				f.count("textarea, input[type=radio], [data-testid=outline-questions-submit]"),
			),
		).toBe(0);
		expect(foreign.errors).toEqual([]);
		await foreign.page.close();
	} finally {
		await db
			.update(projects)
			.set({ visibility: "private" })
			.where(eq(projects.id, space.projectId as string));
	}
	expect((await outlineStore.getQuestions([open]))[0]?.state).toBe("open");
	expect(owner.errors).toEqual([]);
	await owner.page.close();
}, 60_000);
