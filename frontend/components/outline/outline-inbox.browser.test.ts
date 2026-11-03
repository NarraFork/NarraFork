/**
 * Answering questions from the inbox (P2 PR 7), in Chromium, against a test server running the
 * real outline routes and the human-attention list (the isolated SQLite of `tests/preload.ts`):
 *
 *   - a session asks three questions under its task (one a sub-question); the person's inbox
 *     shows them as ONE row; expanded, each starts on the asker's recommendation;
 *   - the person changes one answer, writes a note on another and answers: the three are answered
 *     in one `answer` commit as the person, the asking session is told once, and the row goes;
 *   - a second group is answered with "Adopt all recommendations" in one click.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { narrators, outlineCommits, projects, users } from "../../../server/db/schema";
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

afterEach(() => {
	told.length = 0;
});

afterAll(async () => {
	setOutlineAnswerDelivery(null);
	await browser?.close();
	server?.stop(true);
});

async function openInbox(): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: 1240, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), alice);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.open());
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
	// Each starts on the recommendation.
	const option = (id: string, n: number) =>
		`[data-testid=outline-question-${id}] [data-testid=outline-question-option-${n}]`;
	expect(await call(page, (f, sel) => f.checked(sel as never), option(q1, 2))).toBe(true);
	expect(await call(page, (f, sel) => f.checked(sel as never), option(q1a, 2))).toBe(true);
	// The person disagrees on one, adds a note to another, and answers.
	await call(page, (f, sel) => f.click(sel as never), option(q1, 1));
	await until(page, "option 1 checked", (f, sel) => f.checked(sel as never), option(q1, 1));
	await call(
		page,
		(f, sel, text) => f.type(sel as never, text as never),
		`[data-testid=outline-question-${q2}] [data-testid=outline-question-text]`,
		"skip them, and list them in the report",
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
	expect(answers.get(q1a)).toMatchObject({ option: 2, adopted: true });
	expect(answers.get(q2)).toMatchObject({ text: "skip them, and list them in the report" });
	// The asking session is told once, of all three.
	expect(told.map((t) => t.narratorId)).toEqual([session]);
	expect(told[0]?.content).toContain("Keep reading v1 at all?");
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("Adopt all recommendations answers a group in one click", async () => {
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
	await until(page, "the adopt-all button", (f) =>
		f.exists("[data-testid=outline-questions-adopt-all]" as never),
	);
	expect(
		await call(
			page,
			(f, sel) => f.textOf(sel as never),
			"[data-testid=outline-questions-adopt-all]",
		),
	).toContain("(2)");
	await call(page, (f, sel) => f.click(sel as never), "[data-testid=outline-questions-adopt-all]");
	await until(page, "the row to go", (f, sel) => !f.exists(sel as never), row);
	const answers = (await outlineStore.getBlocks(ids)).map((b) => b.askJson?.answer);
	expect(answers.every((a) => a?.adopted === true)).toBe(true);
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
