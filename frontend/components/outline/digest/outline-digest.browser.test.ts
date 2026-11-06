/**
 * The reports in the browser (汇报, P2 PR 11b), in Chromium, against a test server running the real
 * outline routes, the human-attention list and the report job (the isolated SQLite of
 * `tests/preload.ts`). The reports are made by the job from real commits, two days back, in the
 * person's zone (UTC); sixteen older, empty days are stored before them, so the list has a second
 * page.
 *
 *   - the drawer's digest row, expanded: the latest unread report in short (every section's count,
 *     at most three items of each, every decision made in the person's name with undo), the other
 *     unread report, the confirmations not yet acknowledged (without the one the report lists), undo
 *     of one of them (which acknowledges it), "Open the full report", and "Got it";
 *   - the page: sections and their links (block, the page as of the commit, the session), opening
 *     marks read, day paging (a day on the list's second page, by address and by "Earlier"), the
 *     space filter, "Make today so far" (the job makes it; the page polls until it is there);
 *   - undo from the page: done (the question opens again), refused because it was undone since
 *     (409) and because the person may no longer write there (403), said in the reader's language;
 *   - English and Chinese; no horizontal scroll at 360 px, for the drawer and the page.
 *
 * `NF_DIGEST_SHOTS=<dir>` also saves screenshots of the drawer and the page (light and dark,
 * desktop and 360 px).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { OutlineDigestDetailResponse, OutlineDigestStored } from "@shared/outline-digest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../../server/db";
import {
	aclGrants,
	narrators,
	outlinePending,
	projects,
	userPreferences,
	users,
} from "../../../../server/db/schema";
import { AppError } from "../../../../server/lib/errors";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import {
	getHumanAttentionForPrincipal,
	listHumanAttentionForPrincipal,
} from "../../../../server/services/human-attention-service";
import {
	resetOutlineDigestJobForTests,
	runOutlineDigestSlice,
	startOutlineDigestSweepForTests,
} from "../../../../server/services/outline/digest-job";
import { readOutlineDigestDetail } from "../../../../server/services/outline/digest-view";
import type { OutlineAskJson } from "../../../../server/services/outline/model";
import {
	confirmOutlinePending,
	lockOutlineTask,
} from "../../../../server/services/outline/pending";
import {
	decideOutlinePlan,
	ensurePlanRoot,
	OUTLINE_PLAN_REVIEW_ACTOR,
} from "../../../../server/services/outline/plans";
import { revertCommit } from "../../../../server/services/outline/revert";
import { outlineStore } from "../../../../server/services/outline/store";
import type { OutlineSpaceRow } from "../../../../server/services/outline/store/port";
import { type OutlineOp, writeOutline } from "../../../../server/services/outline/write";
import type * as Fixture from "./outline-digest.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const SHOTS = process.env.NF_DIGEST_SHOTS ?? null;
const store = outlineStore;

const DAY_MS = 86_400_000;
/** A UTC date `days` from today, `YYYY-MM-DD`. */
function dayKey(days: number): string {
	return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}
function at(days: number, time: string): string {
	return `${dayKey(days)}T${time}:00.000Z`;
}
const TODAY = dayKey(0);
const D2 = dayKey(-1);
const D1 = dayKey(-2);
/** The older, empty days stored before the job runs: 3 to 18 days ago. */
const OLDEST = -18;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const listRequests: string[] = [];

let alice: string;
let agent: string;
let delegate: string;
let planner: string;
let p: OutlineSpaceRow;
let q: OutlineSpaceRow;
let r: OutlineSpaceRow;
let rProject: string;
let aliceOnR: string;
let task: string;
let question: string;
let relayed1: { question: string; commit: string };
let relayed2: { question: string; commit: string };
let relayed3: { question: string; commit: string };
let planCommit: string;
let reportConfirm: { pendingId: string; commit: string };
let liveConfirm: { pendingId: string; commit: string };
let d1Id: string;
let d2Id: string;

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
	app.get("/api/auth/me", (c) => c.json({ id: c.get("user").sub, username: "alice" }));
	const principal = (token: string) => ({ userId: token, isAdmin: false });
	app.get("/api/narrators/human-attention", async (c) => {
		const token = c.get("user").sub;
		return c.json(
			await listHumanAttentionForPrincipal(principal(token), {
				cursor: c.req.query("cursor") || undefined,
				limit: Number(c.req.query("limit") ?? 50),
			}),
		);
	});
	app.get("/api/narrators/human-attention/:id", async (c) =>
		c.json(await getHumanAttentionForPrincipal(principal(c.get("user").sub), c.req.param("id"))),
	);
	app.use("/api/outline/digests", async (c, next) => {
		if (c.req.method === "GET") listRequests.push(new URL(c.req.url).search);
		await next();
	});
	app.route("/api/outline", outlineRoutes);
	return app;
}

async function write(
	space: OutlineSpaceRow,
	actor: { kind: "human" | "agent"; id: string },
	when: string,
	ops: OutlineOp[],
	extra: Partial<Parameters<typeof writeOutline>[1]> = {},
) {
	return await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor,
			responsibleUserId: alice,
			narratorId: actor.kind === "agent" ? actor.id : null,
		},
		{ store, now: () => new Date(when), ...extra },
	);
}

function ask(to: string): OutlineAskJson {
	return { to: { kind: "human", id: to }, options: ["No", "Yes"], recommend: { option: 2 } };
}

/** A question an agent asks alice, and her answer it relays from the conversation. */
async function relayedAnswer(space: OutlineSpaceRow, parent: string, text: string, when: string) {
	const asked = await write(
		space,
		{ kind: "agent", id: agent },
		when,
		[{ op: "insert", parent: { id: parent }, content: text, ask: ask(alice) }],
		{ question: { askerNarratorId: agent, askerUserId: alice, askerToolCallId: "call" } },
	);
	const id = asked.results[0]?.blockId as string;
	const answered = await write(
		space,
		{ kind: "agent", id: agent },
		when.replace(":00.000Z", ":30.000Z"),
		[
			{
				op: "update",
				block: { id },
				ask: {
					...ask(alice),
					answer: {
						option: 2,
						adopted: true,
						by: { kind: "human", id: alice },
						at: when,
						relayed: { narratorId: agent, messageId: null },
					},
				},
			},
		],
		{
			kind: "answer",
			question: {
				askerNarratorId: null,
				askerUserId: null,
				askerToolCallId: null,
				delivered: true,
			},
		},
	);
	return { question: id, commit: answered.commit?.id as string };
}

/** A change to the locked plan that the delegate session confirms in alice's name. */
async function delegateConfirms(step: string, content: string, when: string, confirmAt: string) {
	const proposed = await write(p, { kind: "agent", id: agent }, when, [
		{ op: "update", block: { id: step }, content },
	]);
	const pendingId = proposed.pending?.id as string;
	await confirmOutlinePending({
		pendingId,
		by: { kind: "agent", narratorId: delegate, responsibleUserId: alice },
		store,
		now: () => new Date(confirmAt),
	});
	const [row] = await store.getPending([pendingId]);
	return { pendingId, commit: row?.decisionCommitId as string };
}

function emptyItems(): OutlineDigestStored {
	const none = { delegated: 0, knowledge: 0, tasks: 0, plans: 0, questions: 0, other: 0 };
	return {
		v: 1,
		spaces: [],
		moreSpaces: 0,
		delegated: [],
		knowledge: [],
		tasks: [],
		plans: [],
		questions: [],
		other: [],
		more: none,
	};
}

async function user(name: string) {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${name}-${id.slice(0, 4)}`,
		passwordHash: "x",
		role: "user",
		createdAt: at(-20, "00:00"),
	});
	return id;
}

async function project(owner: string, name: string) {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name,
		ownerUserId: owner,
		visibility: "private",
		createdAt: at(-20, "00:00"),
		updatedAt: at(-20, "00:00"),
	});
	return {
		id,
		space: await store.ensureSpace({ kind: "project", projectId: id }, at(-20, "00:00")),
	};
}

async function narrator(owner: string, title: string) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: "private",
		createdAt: at(-20, "00:00"),
		updatedAt: at(-20, "00:00"),
	});
	return id;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	resetOutlineDigestJobForTests();
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-digest.browser-fixture.tsx", import.meta.url).pathname],
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
					`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

	// People, projects, sessions. Alice's reports are cut in UTC.
	alice = await user("alice");
	const carol = await user("carol");
	await db.insert(userPreferences).values({
		id: generateId(),
		userId: alice,
		createdAt: at(-20, "00:00"),
		updatedAt: at(-20, "00:00"),
		outlineDigestTimeZone: "UTC",
	});
	const importer = await project(alice, "Importer");
	const billing = await project(alice, "Billing");
	const partner = await project(carol, "Partner API");
	p = importer.space;
	q = billing.space;
	r = partner.space;
	rProject = partner.id;
	aliceOnR = generateId();
	await db.insert(aclGrants).values({
		id: aliceOnR,
		scopeType: "project",
		scopeId: partner.id,
		principalType: "user",
		principalId: alice,
		capability: "write",
		createdAt: at(-20, "00:00"),
	});
	agent = await narrator(alice, "Importer worker");
	delegate = await narrator(alice, "Plan keeper");
	planner = await narrator(alice, "Planner");

	// Before the two days: the pages, a task alice made, a plan she locks.
	const made = await write(p, { kind: "human", id: alice }, at(-3, "10:00"), [
		{ op: "insert", tempId: "page", parent: null, content: "Importer" },
		{ op: "insert", parent: { tempId: "page" }, content: "Formats we read" },
		{
			op: "insert",
			tempId: "task",
			parent: { tempId: "page" },
			content: "Ship the importer",
			task: { status: "todo" },
		},
		{
			op: "insert",
			tempId: "locked",
			parent: { tempId: "page" },
			content: "Migrate the rows",
			task: { status: "todo" },
		},
		{
			op: "insert",
			tempId: "step",
			parent: { tempId: "locked" },
			content: "Copy",
			task: { status: "todo" },
		},
	]);
	const [page, , taskId, locked, step] = made.results.map((x) => x.blockId) as string[];
	task = taskId as string;
	const qPage = (
		await write(q, { kind: "human", id: alice }, at(-3, "10:00"), [
			{ op: "insert", parent: null, content: "Billing" },
		])
	).results[0]?.blockId as string;
	const rPage = (
		await writeOutline(
			{
				spaceId: r.id,
				ops: [{ op: "insert", parent: null, content: "Partner API" }],
				actor: { kind: "human", id: carol },
				responsibleUserId: carol,
			},
			{ store, now: () => new Date(at(-3, "10:00")) },
		)
	).results[0]?.blockId as string;

	// Day one: knowledge in two projects, a task an agent finished for alice, a question for her.
	const A = { kind: "agent" as const, id: agent };
	await write(p, A, at(-2, "10:00"), [
		{ op: "insert", parent: { id: page as string }, content: "The parser handles a BOM" },
	]);
	await write(q, A, at(-2, "10:30"), [
		{ op: "insert", parent: { id: qPage }, content: "Invoices are monthly" },
	]);
	await write(p, A, at(-2, "11:00"), [
		{ op: "setTask", block: { id: task }, task: { status: "doing" } },
	]);
	await write(p, A, at(-2, "11:10"), [
		{ op: "setTask", block: { id: task }, task: { status: "done" } },
	]);
	question = (
		await write(
			p,
			A,
			at(-2, "12:00"),
			[{ op: "insert", parent: { id: task }, content: "Which format first?", ask: ask(alice) }],
			{ question: { askerNarratorId: agent, askerUserId: alice, askerToolCallId: "c1" } },
		)
	).results[0]?.blockId as string;

	// Day two: more knowledge in both projects, three answers relayed in her name (one in carol's
	// project), a plan the plan review approved for her, a confirmation the delegate made for her.
	await write(p, A, at(-1, "09:00"), [
		{ op: "insert", parent: { id: page as string }, content: "Imports stop at the first bad row" },
	]);
	for (let i = 0; i < 4; i++)
		await write(q, A, at(-1, `09:1${i}`), [
			{ op: "insert", parent: { id: qPage }, content: `Billing note ${i}` },
		]);
	relayed1 = await relayedAnswer(p, page as string, "Keep the v1 reader?", at(-1, "10:00"));
	relayed2 = await relayedAnswer(p, page as string, "Name the flag --strict?", at(-1, "10:30"));
	relayed3 = await relayedAnswer(r, rPage, "Which auth header?", at(-1, "11:00"));
	const root = await ensurePlanRoot({
		session: planner,
		userId: alice,
		title: "Plan the importer",
		locale: "en",
		store,
		now: () => new Date(at(-1, "12:00")),
	});
	const approval = await decideOutlinePlan({
		session: planner,
		rootId: root.root.blockId,
		round: 1,
		action: "draft",
		decider: {
			kind: "system",
			id: OUTLINE_PLAN_REVIEW_ACTOR,
			responsibleUserId: alice,
			approvedBy: { kind: "system", id: OUTLINE_PLAN_REVIEW_ACTOR },
		},
		locale: "en",
		store,
		now: () => new Date(at(-1, "12:10")),
	});
	planCommit = approval.result?.commit?.id as string;
	await lockOutlineTask({
		blockId: locked as string,
		userId: alice,
		delegate,
		store,
		now: () => new Date(at(-1, "13:00")),
	});
	reportConfirm = await delegateConfirms(
		step as string,
		"Copy the rows",
		at(-1, "13:10"),
		at(-1, "13:20"),
	);

	// Sixteen older days with nothing in them, then the job, at 08:00 today, makes the two days.
	for (let days = OLDEST; days <= -3; days++)
		await store.insertDigest({
			id: generateId(),
			userId: alice,
			kind: "daily",
			periodKey: dayKey(days),
			timeZone: "UTC",
			periodStart: at(days, "00:00"),
			periodEnd: at(days + 1, "00:00"),
			counts: {
				delegated: 0,
				knowledge: 0,
				tasks: 0,
				plans: 0,
				questions: 0,
				other: 0,
				spaces: 0,
				ownEdits: 0,
			},
			itemCount: 0,
			items: emptyItems(),
			ranges: {},
			truncated: false,
			createdAt: at(days + 1, "07:00"),
			seenAt: at(days + 1, "07:00"),
		});
	startOutlineDigestSweepForTests();
	for (let i = 0; i < 200; i++) {
		const slice = await runOutlineDigestSlice({
			store,
			now: () => new Date(at(0, "08:00")),
			serverTimeZone: "UTC",
		});
		if (!slice.more) break;
	}
	const heads = await store.listDigestHeads(alice, { kind: "daily", limit: 3 });
	expect(heads.map((h) => h.periodKey)).toEqual([D2, D1, dayKey(-3)]);
	d2Id = heads[0]?.id as string;
	d1Id = heads[1]?.id as string;

	// Today, after the report: another confirmation in her name.
	liveConfirm = await delegateConfirms(
		step as string,
		"Copy the rows in batches",
		new Date(Date.now() - 2000).toISOString(),
		new Date(Date.now() - 1000).toISOString(),
	);
}, 120_000);

beforeEach(() => {
	settings.outline.enabled = true;
});

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function open(
	path: string,
	options: { lang?: "en" | "zh-CN"; width?: number; scheme?: "light" | "dark" } = {},
): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: options.width ?? 1240, height: 900 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), alice);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await call(page, (f, o) => f.mount(o as never), {
		path,
		lang: options.lang ?? "en",
		scheme: options.scheme ?? "light",
		userId: alice,
	});
	return { page, errors };
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
		const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
		throw new Error(`timed out waiting for ${what}: ${String(error)}\n--- page ---\n${text}`);
	}
}

const has = (f: typeof Fixture, sel: string) => f.exists(sel);

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	// The drawer scrolls inside itself: grow the window to its content for the picture.
	const viewport = page.viewport() ?? { width: 1240, height: 900 };
	const height = await page.evaluate(() =>
		Math.max(
			document.documentElement.scrollHeight,
			(document.querySelector(".mantine-Drawer-body")?.scrollHeight ?? 0) + 80,
		),
	);
	await page.setViewport({ width: viewport.width, height: Math.min(height, 4000) });
	await new Promise((resolve) => setTimeout(resolve, 400));
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
	await page.setViewport(viewport);
}

async function expectNoSideScroll(page: Page, scope: string) {
	const over = await call(page, (f, s) => f.overflow(s as never), scope);
	expect(over).toEqual({ page: 0, drawer: 0, past: [] });
}

async function detailOf(id: string): Promise<OutlineDigestDetailResponse> {
	return await readOutlineDigestDetail({ userId: alice, isAdmin: false }, id);
}

const ROW = '[data-attention-id="outline:d:digest"]';
const REPORT = "[data-testid=outline-report]";

describe("the inbox's digest row", () => {
	test("the latest unread report in short, the other one, the confirmations since, and undo", async () => {
		const expected = await detailOf(d2Id);
		const { page, errors } = await open("/");
		await until(page, "the digest row", has, ROW);
		expect(await call(page, (f, s) => f.textOf(s as never), ROW)).toContain("2 report(s) to read");
		await call(
			page,
			(f, s) => f.click(s as never),
			`${ROW} [data-testid=outline-attention-review]`,
		);
		await until(page, "the report in short", has, `${REPORT}[data-compact=true]`);
		expect(
			await call(page, (f, s) => f.attrs(s as never, "data-report-id" as never), REPORT),
		).toEqual([d2Id]);
		// Every section's count, as the report has it.
		const counts = await call(page, (f) =>
			Object.fromEntries(
				f
					.attrs(
						"[data-testid=outline-report-counts] [data-section]" as never,
						"data-section" as never,
					)
					.map((s, i) => [
						s,
						Number(
							f.attrs(
								"[data-testid=outline-report-counts] [data-section]" as never,
								"data-count" as never,
							)[i],
						),
					]),
			),
		);
		expect(counts).toEqual({
			delegated: expected.digest.counts.delegated,
			knowledge: expected.digest.counts.knowledge,
			tasks: expected.digest.counts.tasks,
			plans: expected.digest.counts.plans,
			questions: expected.digest.counts.questions,
			other: expected.digest.counts.other,
		});
		// Knowledge in two projects, more than three pages' worth of items is not the point: at most
		// three of each section are listed, and every decision is.
		expect(expected.delegated.map((d) => d.kind).sort()).toEqual([
			"confirmation",
			"plan_review_approval",
			"relayed_answer",
			"relayed_answer",
			"relayed_answer",
		]);
		for (const section of ["knowledge", "tasks", "plans", "questions", "other"])
			expect(
				await call(
					page,
					(f, s) => f.count(s as never),
					`[data-testid=outline-report-section-${section}] [data-testid^=outline-report-${section === "tasks" ? "task" : section === "plans" ? "plan" : section === "questions" ? "question" : section}-]`,
				),
			).toBeLessThanOrEqual(3);
		expect(
			await call(page, (f, s) => f.count(s as never), "[data-testid^=outline-report-delegated-]"),
		).toBe(5);
		expect(
			await call(
				page,
				(f, s) => f.exists(s as never),
				`[data-testid=outline-report-delegated-${planCommit}]`,
			),
		).toBe(true);
		expect(
			await call(
				page,
				(f, s) => f.count(s as never),
				`${REPORT} [data-testid=outline-report-undo]`,
			),
		).toBe(5);
		// The confirmation the report lists is not listed again; today's is.
		expect(
			await call(
				page,
				(f, s) => f.attrs(s as never, "data-testid" as never),
				"[data-testid=outline-digest-live] [data-testid^=outline-digest-]",
			),
		).toEqual([`outline-digest-${liveConfirm.pendingId}`]);
		expect(
			await call(page, (f, s) => f.textOf(s as never), "[data-testid=outline-report-other-unread]"),
		).toContain("1 more unread report");
		await shot(page, "drawer-light-desktop");

		// Undo today's confirmation: asked first, then done; the change is taken back.
		const live = `[data-testid=outline-digest-${liveConfirm.pendingId}]`;
		await call(page, (f, s) => f.click(s as never), `${live} [data-testid=outline-report-undo]`);
		await until(
			page,
			"the confirmation of undo",
			has,
			`${live} [data-testid=outline-report-undo-confirm]`,
		);
		expect(
			await call(
				page,
				(f, s) => f.textOf(s as never),
				`${live} [data-testid=outline-report-undo-confirm]`,
			),
		).toContain("The confirmed change is taken back");
		await call(
			page,
			(f, s) => f.click(s as never),
			`${live} [data-testid=outline-report-undo-yes]`,
		);
		await until(page, "undone", has, `${live} [data-testid=outline-report-undone]`);
		const [pending] = await db
			.select()
			.from(outlinePending)
			.where(eq(outlinePending.id, liveConfirm.pendingId));
		expect(pending?.decisionCommitId).toBe(liveConfirm.commit);
		const undoneStep = await store.getBlock(
			(await store.getPending([liveConfirm.pendingId]))[0]?.blockIdsJson[0] as string,
		);
		expect(undoneStep?.content).toBe("Copy the rows");
		// Undone, so acknowledged: it stays shown here as undone.
		expect((await store.getPending([liveConfirm.pendingId]))[0]?.digestSeenAt).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(
			await call(
				page,
				(f, s) => f.exists(s as never),
				`${live} [data-testid=outline-report-undone]`,
			),
		).toBe(true);

		// "Open the full report" goes to the page, on that day, closing the drawer.
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-report-open-full]");
		await until(page, "the page", (f) => f.location().href.startsWith("/outline/digest"));
		const where = await call(page, (f) => f.location());
		expect(where.href).toBe(`/outline/digest?d=${D2}`);
		expect(where.closed).toBeGreaterThan(0);
		expect(errors).toEqual([]);
		await page.close();
	}, 90_000);

	test("at 360 px, in Chinese and dark: no horizontal scroll", async () => {
		for (const scheme of ["light", "dark"] as const) {
			const { page, errors } = await open("/", { lang: "zh-CN", width: 360, scheme });
			await until(page, "the digest row", has, ROW);
			await call(
				page,
				(f, s) => f.click(s as never),
				`${ROW} [data-testid=outline-attention-review]`,
			);
			await until(page, "the report in short", has, `${REPORT}[data-compact=true]`);
			expect(await call(page, (f, s) => f.textOf(s as never), REPORT)).toContain("代你做的");
			await expectNoSideScroll(page, ".mantine-Drawer-content");
			await shot(page, `drawer-${scheme}-360`);
			expect(errors).toEqual([]);
			await page.close();
		}
		const { page } = await open("/", { scheme: "dark" });
		await until(page, "the digest row", has, ROW);
		await call(
			page,
			(f, s) => f.click(s as never),
			`${ROW} [data-testid=outline-attention-review]`,
		);
		await until(page, "the report in short", has, `${REPORT}[data-compact=true]`);
		await shot(page, "drawer-dark-desktop");
		await page.close();
	}, 90_000);
});

describe("the outline home's entry", () => {
	test("the latest day's report, its items and unread, linking to the page", async () => {
		const { page, errors } = await open("/outline");
		await until(
			page,
			"the entry",
			(f, s) => (f.textOf(s as never) ?? "").includes("items"),
			"[data-testid=outline-report-entry]",
		);
		const text =
			(await call(page, (f, s) => f.textOf(s as never), "[data-testid=outline-report-entry]")) ??
			"";
		expect(text).toContain("Report of");
		expect(text).toContain(`${(await store.getDigest(d2Id))?.itemCount} items`);
		expect(
			await call(
				page,
				(f, s) => f.attrs(s as never, "href" as never),
				"[data-testid=outline-report-entry]",
			),
		).toEqual(["/outline/digest"]);
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-report-entry]");
		await until(page, "the page", has, "[data-testid=outline-report-page]");
		expect(errors).toEqual([]);
		await page.close();
	}, 60_000);
});

describe("the reports page", () => {
	test("sections and their links; opening marks read", async () => {
		const expected = await detailOf(d2Id);
		const { page, errors } = await open("/outline/digest");
		await until(
			page,
			"the latest day",
			has,
			`[data-testid=outline-report-day-view][data-day="${D2}"]`,
		);
		await until(page, "the report", has, `${REPORT}[data-compact=false]`);
		for (const section of [
			"delegated",
			"knowledge",
			"tasks",
			"plans",
			"questions",
			"other",
		] as const) {
			const n = expected.digest.counts[section];
			if (n === 0) continue;
			expect(
				await call(
					page,
					(f, s) => f.attrs(s as never, "data-count" as never),
					`[data-testid=outline-report-section-${section}]`,
				),
			).toEqual([String(n)]);
		}
		// Every listed block links to itself, every item to its commit's moment.
		const blockHrefs = await call(
			page,
			(f, s) => f.attrs(s as never, "href" as never),
			`${REPORT} [data-testid=outline-report-block-link]`,
		);
		const expectedBlocks = [
			...expected.delegated.map((d) => d.link),
			...expected.knowledge.flatMap((k) => [k.link, ...k.blocks.map((b) => b.link)]),
			...expected.tasks.map((t) => t.link),
			...expected.plans.map((x) => x.link),
			...expected.questions.map((x) => x.link),
			...expected.other.map((x) => x.link),
		].filter((l) => l.blockId);
		expect(blockHrefs.length).toBe(expectedBlocks.length);
		for (const l of expectedBlocks)
			expect(blockHrefs.some((href) => href.startsWith(`/outline/${l.spaceId}/${l.blockId}`))).toBe(
				true,
			);
		const commitHrefs = await call(
			page,
			(f, s) => f.attrs(s as never, "href" as never),
			`${REPORT} [data-testid=outline-report-commit-link]`,
		);
		expect(commitHrefs.length).toBeGreaterThan(0);
		for (const href of commitHrefs)
			expect(href).toMatch(/^\/outline\/ref\?space=[^&]+&commit=\d+$/);
		const relayed = expected.delegated.find((d) => d.link.commitId === relayed1.commit);
		expect(commitHrefs).toContain(
			`/outline/ref?space=${relayed?.link.spaceKey}&commit=${relayed?.link.seq}`,
		);
		// The session that relayed it, which alice may open.
		expect(
			await call(
				page,
				(f, s) => f.attrs(s as never, "href" as never),
				`[data-testid=outline-report-delegated-${relayed1.commit}] [data-testid=outline-report-session-link]`,
			),
		).toEqual([`/narrators/${agent}`]);
		// The question asked of her on day one waits for her now.
		expect(
			await call(page, (f, s) => f.exists(s as never), "[data-testid=outline-report-waiting]"),
		).toBe(true);
		// Opened, so read: in the store, and the badge goes.
		await until(
			page,
			"read",
			(f, s) => !f.exists(s as never),
			"[data-testid=outline-report-unread]",
		);
		expect((await store.getDigest(d2Id))?.seenAt).not.toBeNull();
		await shot(page, "page-light-desktop");
		// A block link goes to the block, in the view of everything for a decision.
		await call(
			page,
			(f, s) => f.click(s as never),
			`[data-testid=outline-report-delegated-${relayed1.commit}] [data-testid=outline-report-block-link]`,
		);
		await until(page, "the block route", (f) => !f.location().href.startsWith("/outline/digest"));
		expect((await call(page, (f) => f.location())).href).toBe(
			`/outline/${p.id}/${relayed1.question}?view=all`,
		);
		expect(errors).toEqual([]);
		await page.close();

		// A commit link goes to the page as of the commit.
		const again = await open(`/outline/digest?d=${D2}`);
		await until(again.page, "the report", has, `${REPORT}[data-compact=false]`);
		await call(
			again.page,
			(f, s) => f.click(s as never),
			`[data-testid=outline-report-delegated-${relayed1.commit}] [data-testid=outline-report-commit-link]`,
		);
		await until(again.page, "the ref route", (f) => f.location().href.startsWith("/outline/ref"));
		expect((await call(again.page, (f) => f.location())).href).toBe(
			`/outline/ref?space=${relayed?.link.spaceKey}&commit=${relayed?.link.seq}`,
		);
		await again.page.close();
	}, 90_000);

	test("day one: a task an agent finished for her is newly done; days page by cursor", async () => {
		const { page, errors } = await open(`/outline/digest?d=${D1}`);
		await until(page, "day one", has, `[data-testid=outline-report-day-view][data-day="${D1}"]`);
		await until(page, "the report", has, `${REPORT}[data-compact=false]`);
		const tasks = await call(
			page,
			(f, s) => f.textOf(s as never),
			"[data-testid=outline-report-section-tasks]",
		);
		expect(tasks ?? "").toContain("Ship the importer");
		expect(tasks ?? "").toContain("worked on by Importer worker");
		expect(
			await call(page, (f, s) => f.count(s as never), "[data-testid=outline-report-newly-done]"),
		).toBe(1);
		const questions = await call(
			page,
			(f, s) => f.textOf(s as never),
			"[data-testid=outline-report-section-questions]",
		);
		expect(questions ?? "").toContain("Which format first?");
		expect(
			await call(
				page,
				(f, s) => f.attrs(s as never, "href" as never),
				"[data-testid=outline-report-section-questions] [data-testid=outline-report-block-link]",
			),
		).toContain(`/outline/${p.id}/${question}?view=all`);
		// Later: day two; later again: none.
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-report-newer]");
		await until(page, "day two", has, `[data-testid=outline-report-day-view][data-day="${D2}"]`);
		expect((await call(page, (f) => f.location())).href).toBe(`/outline/digest?d=${D2}`);
		// The oldest day of the first page, then Earlier: the second page is read for the day before.
		listRequests.length = 0;
		await page.close();
		const first = await open(`/outline/digest?d=${dayKey(-14)}`);
		await until(
			first.page,
			"the 14th day",
			has,
			`[data-testid=outline-report-day-view][data-day="${dayKey(-14)}"]`,
		);
		await until(first.page, "its empty report", has, "[data-testid=outline-report-empty]");
		expect(
			await call(first.page, (f, s) => f.textOf(s as never), "[data-testid=outline-report-empty]"),
		).toBe("Nothing to list for this day.");
		await call(first.page, (f, s) => f.click(s as never), "[data-testid=outline-report-older]");
		await until(
			first.page,
			"the 15th day",
			has,
			`[data-testid=outline-report-day-view][data-day="${dayKey(-15)}"]`,
		);
		expect(listRequests.some((s) => s.includes(`before=${dayKey(-14)}`))).toBe(true);
		await first.page.close();
		// By address, a day on the second page.
		const deep = await open(`/outline/digest?d=${dayKey(OLDEST)}`);
		await until(
			deep.page,
			"the oldest day",
			has,
			`[data-testid=outline-report-day-view][data-day="${dayKey(OLDEST)}"]`,
		);
		expect(
			await call(
				deep.page,
				(f, s) => f.exists(s as never),
				"[data-testid=outline-report-older][disabled]",
			),
		).toBe(true);
		await deep.page.close();
		// A day there is no report of.
		const missing = await open("/outline/digest?d=2020-01-01");
		await until(missing.page, "no such day", has, "[data-testid=outline-report-missing]");
		await missing.page.close();
		expect(errors).toEqual([]);
	}, 90_000);

	test("the space filter", async () => {
		const expected = await detailOf(d2Id);
		const qKnowledge = expected.knowledge.filter((k) => k.link.spaceId === q.id).length;
		expect(qKnowledge).toBeGreaterThan(0);
		const { page, errors } = await open(`/outline/digest?d=${D2}`);
		await until(page, "the report", has, `${REPORT}[data-compact=false]`);
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-report-space]");
		await until(page, "the spaces", (f) => f.options().length > 1);
		expect(await call(page, (f) => f.options())).toEqual(
			expect.arrayContaining(["All spaces", "Importer", "Billing", "Partner API"]),
		);
		await call(page, (f, s) => f.choose(s as never), "Billing");
		await until(page, "filtered", (f) => f.location().href.includes(`space=`));
		expect((await call(page, (f) => f.location())).href).toBe(
			`/outline/digest?d=${D2}&space=${q.id}`,
		);
		await until(
			page,
			"only billing",
			(f, n) =>
				f.attrs(
					"[data-testid=outline-report-section-knowledge]" as never,
					"data-count" as never,
				)[0] === String(n),
			qKnowledge,
		);
		expect(
			await call(
				page,
				(f, s) => f.exists(s as never),
				"[data-testid=outline-report-section-delegated]",
			),
		).toBe(false);
		const text = (await call(page, (f, s) => f.textOf(s as never), REPORT)) ?? "";
		expect(text).toContain("Billing note");
		expect(text).not.toContain("Imports stop at the first bad row");
		expect(errors).toEqual([]);
		await page.close();
	}, 60_000);

	test("undo from the page: done, and refused (undone since, no longer writable) in Chinese", async () => {
		const en = await open(`/outline/digest?d=${D2}`);
		const item = `[data-testid=outline-report-delegated-${relayed1.commit}]`;
		await until(en.page, "the decision", has, `${item} [data-testid=outline-report-undo]`);
		await call(en.page, (f, s) => f.click(s as never), `${item} [data-testid=outline-report-undo]`);
		await until(en.page, "asked first", has, `${item} [data-testid=outline-report-undo-confirm]`);
		expect(
			await call(
				en.page,
				(f, s) => f.textOf(s as never),
				`${item} [data-testid=outline-report-undo-confirm]`,
			),
		).toContain("The question opens again");
		expect((await store.getQuestions([relayed1.question]))[0]?.state).toBe("answered");
		await call(
			en.page,
			(f, s) => f.click(s as never),
			`${item} [data-testid=outline-report-undo-yes]`,
		);
		await until(en.page, "undone", has, `${item} [data-testid=outline-report-undone]`);
		expect((await store.getQuestions([relayed1.question]))[0]?.state).toBe("open");
		// Read again: it no longer stands, so no undo is offered for it.
		const after = await detailOf(d2Id);
		expect(after.delegated.find((d) => d.link.commitId === relayed1.commit)).toMatchObject({
			stands: false,
			canUndo: false,
		});
		await until(
			en.page,
			"no undo offered",
			(f, s) => !f.exists(s as never),
			`${item} [data-testid=outline-report-undo]`,
		);
		expect(en.errors).toEqual([]);
		await en.page.close();

		const zh = await open(`/outline/digest?d=${D2}`, { lang: "zh-CN" });
		const two = `[data-testid=outline-report-delegated-${relayed2.commit}]`;
		const three = `[data-testid=outline-report-delegated-${relayed3.commit}]`;
		await until(
			zh.page,
			"both decisions",
			(f, a, b) => f.exists(a as never) && f.exists(b as never),
			`${two} [data-testid=outline-report-undo]`,
			`${three} [data-testid=outline-report-undo]`,
		);
		expect(
			await call(
				zh.page,
				(f, s) => f.textOf(s as never),
				"[data-testid=outline-report-section-delegated]",
			),
		).toContain("代你做的");
		// Undone elsewhere after the page read it: 409.
		await revertCommit(
			{ commitId: relayed2.commit, actor: { kind: "human", id: alice }, responsibleUserId: alice },
			{ store },
		);
		await call(zh.page, (f, s) => f.click(s as never), `${two} [data-testid=outline-report-undo]`);
		await until(zh.page, "asked", has, `${two} [data-testid=outline-report-undo-yes]`);
		await call(
			zh.page,
			(f, s) => f.click(s as never),
			`${two} [data-testid=outline-report-undo-yes]`,
		);
		await until(
			zh.page,
			"refused",
			has,
			`${two} [data-testid=outline-report-undo-refused][data-reason=gone]`,
		);
		expect(
			await call(
				zh.page,
				(f, s) => f.textOf(s as never),
				`${two} [data-testid=outline-report-undo-refused]`,
			),
		).toContain("撤不回了：它已经被撤回过，或者之后又被改过。");
		// Alice may only read carol's project now: 403.
		await db.delete(aclGrants).where(eq(aclGrants.id, aliceOnR));
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: rProject,
			principalType: "user",
			principalId: alice,
			capability: "read",
			createdAt: new Date().toISOString(),
		});
		await call(
			zh.page,
			(f, s) => f.click(s as never),
			`${three} [data-testid=outline-report-undo]`,
		);
		await until(zh.page, "asked", has, `${three} [data-testid=outline-report-undo-yes]`);
		await call(
			zh.page,
			(f, s) => f.click(s as never),
			`${three} [data-testid=outline-report-undo-yes]`,
		);
		await until(
			zh.page,
			"refused",
			has,
			`${three} [data-testid=outline-report-undo-refused][data-reason=readOnly]`,
		);
		expect(
			await call(
				zh.page,
				(f, s) => f.textOf(s as never),
				`${three} [data-testid=outline-report-undo-refused]`,
			),
		).toContain("你现在不能写这个空间，所以撤不回。");
		expect((await store.getQuestions([relayed3.question]))[0]?.state).toBe("answered");
		expect(zh.errors).toEqual([]);
		await zh.page.close();
	}, 90_000);

	test("make today so far: the job makes it and the page opens it", async () => {
		await writeOutline(
			{
				spaceId: p.id,
				ops: [{ op: "insert", parent: null, content: "Written this afternoon" }],
				actor: { kind: "agent", id: agent },
				responsibleUserId: alice,
				narratorId: agent,
			},
			{ store },
		);
		const { page, errors } = await open(`/outline/digest?d=${D2}`);
		await until(page, "the report", has, `${REPORT}[data-compact=false]`);
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-report-now]");
		await until(page, "today so far", has, `[data-testid=outline-report-day-view][data-day=today]`);
		await until(
			page,
			"its report",
			(f, s) => (f.textOf(s as never) ?? "").includes("Written this afternoon"),
			REPORT,
		);
		expect((await call(page, (f) => f.location())).href).toBe(`/outline/digest?d=today`);
		const [preview] = await store.listDigestHeads(alice, { kind: "today", limit: 1 });
		expect(preview?.periodKey).toBe(TODAY);
		expect(preview?.periodStart).toBe(at(0, "00:00"));
		// Asked again within the minute: the one there is stands, and the page says so.
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-report-now]");
		await until(
			page,
			"the notice",
			has,
			"[data-testid=outline-report-notice][data-notice=madeRecently]",
		);
		expect(errors).toEqual([]);
		await page.close();
	}, 90_000);

	test("at 360 px and on a wide screen, light and dark, English and Chinese: no horizontal scroll", async () => {
		for (const [lang, width, scheme] of [
			["en", 360, "light"],
			["zh-CN", 360, "dark"],
			["en", 360, "dark"],
			["zh-CN", 1240, "dark"],
		] as const) {
			const { page, errors } = await open(`/outline/digest?d=${D2}`, { lang, width, scheme });
			await until(page, "the report", has, `${REPORT}[data-compact=false]`);
			if (lang === "zh-CN")
				expect(
					await call(page, (f, s) => f.textOf(s as never), "[data-testid=outline-report-page]"),
				).toContain("汇报");
			await expectNoSideScroll(page, "[data-testid=outline-report-page]");
			await shot(
				page,
				`page-${scheme}-${width === 360 ? "360" : "desktop"}${lang === "zh-CN" ? "-zh" : ""}`,
			);
			expect(errors).toEqual([]);
			await page.close();
		}
	}, 120_000);
});

describe("Got it", () => {
	test("marks every unread report and the confirmations read: the row goes", async () => {
		const { page, errors } = await open("/");
		await until(page, "the digest row", has, ROW);
		await call(
			page,
			(f, s) => f.click(s as never),
			`${ROW} [data-testid=outline-attention-review]`,
		);
		await until(page, "the row's view", has, "[data-testid=outline-digest-seen]");
		await call(page, (f, s) => f.click(s as never), "[data-testid=outline-digest-seen]");
		await until(page, "the row to go", (f, s) => !f.exists(s as never), ROW);
		expect((await store.getDigest(d1Id))?.seenAt).not.toBeNull();
		const [row] = await store.getPending([reportConfirm.pendingId]);
		expect(row?.digestSeenAt ?? null).not.toBeNull();
		expect(errors).toEqual([]);
		await page.close();
	}, 60_000);
});
