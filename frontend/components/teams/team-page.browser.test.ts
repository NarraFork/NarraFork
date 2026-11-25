/**
 * The team page in Chromium (docs/PROJECT_TEAMS-PLAN.md §二.11, §二.12; the redesign R), against a
 * test server running the real team, project and narrator routes on the isolated SQLite of
 * `tests/preload.ts`:
 *
 *   - a new team starts with what to tell the coordinator; an example fills the composer, and the
 *     work column explains where items will appear;
 *   - the work list reflects work item state changes, picked up through the coordinator's
 *     narrator socket; the activity tab lists them;
 *   - 等你处理: a member approves a tool call and answers a question in place through the
 *     ordinary permission routes; hovering a card highlights its item; an onlooker sees none and
 *     reads 「你是只读成员」-style gating (no pause all);
 *   - the work item drawer opens from a card; 退回 needs a reason and sends the item back;
 *   - "pause all" stops the tree's running sessions through the ordinary Stop route;
 *   - two columns when the frame has room, 对话 | 工作 tabs otherwise, the conversation never
 *     remounted; the page is about one team; on a phone the header carries the menu button so
 *     nothing floats over it;
 *   - an archived team says so and offers no "pause all"; at 360 px nothing scrolls sideways, in
 *     light and dark; the project page's teams section creates a team;
 *   - dependencies (D): a blocked queued row names what it waits for, the drawer lists the
 *     dependencies (a title opens that item) and its dependents, and warns about a cancelled one.
 *
 * Set `TEAMS_P4_SHOTS` to a directory to keep screenshots.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import {
	aclGrants,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	teamWorkEvents,
	teamWorkItemDependencies,
	teamWorkItems,
	users,
} from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { narratorRoutes } from "../../../server/routes/narrators";
import { projectTeamRoutes } from "../../../server/routes/project-teams";
import { projectRoutes } from "../../../server/routes/projects";
import { narratorService } from "../../../server/services/narrator-service";
import { pendingPermissions } from "../../../server/services/narrator-session-state";
import { initTeamRepo } from "../../../server/services/teams/__tests__/team-repo.fixture";
import { archiveTeam, createTeam } from "../../../server/services/teams/team-service";
import { setReturnDeliveryForTests } from "../../../server/services/teams/work-items";
import type * as Fixture from "./team-page.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.TEAMS_P4_SHOTS;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let bob: string;
let projectId: string;
let teamId: string;
let workerId: string;
const decisions: string[] = [];
/** What each decision handed the waiting call (its answers among it). */
const resolutions = new Map<string, unknown>();
/** Notes a return sent the coordinator (captured; no turn is started in tests). */
const returnNotes: string[] = [];
/** The narrator sockets connected to the test server. */
const sockets = new Set<{ send(data: string): unknown }>();

function api() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const token =
			c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("token") ?? "";
		c.set("user", { sub: token, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		error instanceof AppError
			? Response.json({ error: error.message, code: error.code }, { status: error.statusCode })
			: Response.json({ error: String(error) }, { status: 500 }),
	);
	app.route("/api/projects", projectTeamRoutes);
	app.route("/api/projects", projectRoutes);
	app.route("/api/narrators", narratorRoutes);
	return app;
}

async function person(username: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

let clock = Date.now() + 60_000;
function tick(): string {
	clock += 1000;
	return new Date(clock).toISOString();
}

/** Tell the page's narrator socket that the coordinator's tree changed (what the server does). */
function nudge() {
	for (const ws of sockets)
		ws.send(JSON.stringify({ type: "status_change", narratorId: teamId, status: "working" }));
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./team-page.browser-fixture.tsx", import.meta.url).pathname],
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
			if (url.pathname.startsWith("/api/")) return app.fetch(request);
			if (url.pathname === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
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
				// The page only listens on this socket.
			},
			close(ws) {
				sockets.delete(ws);
			},
		},
	});
	setReturnDeliveryForTests(async ({ text }) => {
		returnNotes.push(text);
		return true;
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

	alice = await person(`alice${Date.now()}`);
	bob = await person(`bob${Date.now()}`);
	const repo = initTeamRepo(mkdtempSync(join(tmpdir(), "nf-team-page-")));
	projectId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: "Team page project",
		gitPath: repo,
		defaultBranch: "main",
		ownerUserId: alice,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: bob,
		capability: "read",
		createdAt: now,
	});
	const team = await createTeam(
		{ projectId, name: "Release crew" },
		{ userId: alice, isAdmin: false },
	);
	teamId = team.id;
	const worker = await narratorService.create({ title: "Board worker", cwd: repo });
	workerId = worker.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: teamId })
		.where(eq(narrators.id, workerId));
}, 60_000);

afterAll(async () => {
	setReturnDeliveryForTests(null);
	for (const [id, pending] of pendingPermissions)
		if (pending.narratorId === workerId) pendingPermissions.delete(id);
	await browser?.close();
	server?.stop(true);
});

async function openPage(
	as: string,
	viewport: { width: number; height: number },
): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport(viewport);
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
		const body = await page
			.evaluate(() => document.body.innerText.slice(0, 3000))
			.catch(() => "page gone");
		throw new Error(`until ${what}: ${body}: ${String(error)}`);
	}
}

async function shot(page: Page, name: string) {
	if (!shots) return;
	mkdirSync(shots, { recursive: true });
	await page.screenshot({ path: join(shots, `${name}.png`) as `${string}.png` });
}

async function seedItem(title: string, state: string, extra: Record<string, unknown> = {}) {
	const id = generateId();
	const at = tick();
	await db.insert(teamWorkItems).values({
		id,
		teamId,
		projectId,
		title,
		state: state as "queued",
		createdAt: at,
		updatedAt: at,
		...extra,
	});
	await db.insert(teamWorkEvents).values({
		id: generateId(),
		teamId,
		workItemId: id,
		kind: "work.created",
		actorKind: "agent",
		actorId: teamId,
		detailJson: { branch: extra.branchName ?? null },
		createdAt: at,
	});
	return id;
}

async function seedApproval(
	command: string,
	toolName = "Bash",
	input: Record<string, unknown> = { command },
	narratorId = workerId,
) {
	const requestId = generateId();
	const messageId = generateId();
	const at = tick();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: at,
	});
	await db.insert(narratorToolCalls).values({
		id: requestId,
		narratorId,
		messageId,
		toolUseId: `use-${requestId}`,
		toolName,
		status: "pending",
		inputJson: input,
		permissionStartedAt: at,
		createdAt: at,
	});
	pendingPermissions.set(requestId, {
		narratorId,
		broadcastTargetId: teamId,
		toolName,
		toolUseId: `use-${requestId}`,
		input,
		cwd: "/work",
		locale: "en",
		signal: new AbortController().signal,
		resolve: (result) => {
			decisions.push(`${requestId}:${result.behavior}`);
			resolutions.set(requestId, result);
		},
		cleanup: () => {
			pendingPermissions.delete(requestId);
		},
	});
	return requestId;
}

let movingId: string;
let readyId: string;

test("a new team starts with what to tell the coordinator; an example fills the composer", async () => {
	const owner = { userId: alice, isAdmin: false };
	const fresh = await createTeam({ projectId, name: "Fresh crew" }, owner);
	const { page, errors } = await openPage(alice, { width: 1440, height: 900 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, fresh.id);
		await until(page, "start", (f) => f.count("[data-testid=team-start-example]") === 3);
		await until(page, "empty work", (f) => f.count("[data-testid=team-work-empty]") === 1);
		expect(await call(page, (f) => f.attr("[data-testid=team-status]", "data-tone"))).toBe("idle");
		expect(await call(page, (f) => f.count("[data-testid=team-attention]"))).toBe(0);
		await call(page, (f) => f.click("[data-testid=team-start-example]"));
		await until(
			page,
			"composer filled",
			(f) => (f.value("[data-testid=composer-stand-in]") ?? "").length > 20,
		);
		// The composer itself stays usable under the prompt.
		expect(await call(page, (f) => f.tappable("[data-testid=composer-stand-in]"))).toBe(true);
		await shot(page, "desktop-starting");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
	// A read-only member cannot tell the coordinator anything: a plain line, no prompts.
	const reader = await openPage(bob, { width: 1440, height: 900 });
	try {
		await call(reader.page, (f, p: string, t: string) => f.openTeam(p, t), projectId, fresh.id);
		await until(
			reader.page,
			"plain line",
			(f) => f.count("[data-testid=team-start-read-only]") === 1,
		);
		expect(await call(reader.page, (f) => f.count("[data-testid=team-start-example]"))).toBe(0);
		expect(reader.errors).toEqual([]);
	} finally {
		await reader.page.close();
		// Out of the project's active list the last test counts.
		await archiveTeam(fresh.id, owner, projectId);
	}
}, 60_000);

test("the work list reflects work item state changes", async () => {
	movingId = await seedItem("Wire the board", "queued", { branchName: "team/wire-the-board-1a2b" });
	readyId = await seedItem("Write the docs", "ready", {
		branchName: "team/write-the-docs-9f9f",
		reviewRounds: 2,
		lastReview: "clear",
	});
	const { page, errors } = await openPage(alice, { width: 1600, height: 900 });
	const boardReads: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.endsWith("/board")) boardReads.push(url.searchParams.get("column") ?? "");
	});
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		await until(page, "the list", (f) => f.count("[data-testid=team-work-row]") === 2);
		expect(await call(page, (f) => f.attr("[data-testid=team-workspace]", "data-layout"))).toBe(
			"split",
		);
		// The coordinator's column has one compact line above the conversation, not its toolbar;
		// 完整会话 opens the coordinator's own session page.
		await until(
			page,
			"coordinator line",
			(f) => f.count("[data-testid=team-coordinator-line]") === 1,
		);
		expect(
			await call(page, (f) =>
				f.above("[data-testid=team-coordinator-header]", "[data-testid=conversation-stand-in]"),
			),
		).toBe(true);
		await call(page, (f) => f.click("[data-testid=team-coordinator-full-session]"));
		expect(await call(page, (f) => f.openedTargets())).toContain(`full:${teamId}`);
		// Finished items are counts until opened: only the open columns are read.
		expect([...new Set(boardReads)].sort()).toEqual(["in_progress", "queued", "review"]);
		expect(await call(page, (f, id: string) => f.groupOf(id), movingId)).toBe("inProgress");
		// A ready item waits for the member: in 需要你, and as a card in 等你处理.
		expect(await call(page, (f, id: string) => f.groupOf(id), readyId)).toBe("needsYou");
		await until(
			page,
			"merge card",
			(f) => f.count("[data-testid=team-attention-card][data-kind=merge]") === 1,
		);
		expect(await call(page, (f) => f.text("[data-testid=team-title]"))).toBe("Release crew");
		await until(page, "the socket", (f) => f.socketConnected());

		// The coordinator hands the item to a worker: state and worker change, an event is logged,
		// and the tree's socket frame reaches the page.
		await db
			.update(teamWorkItems)
			.set({ state: "in_progress", workerNarratorId: workerId, updatedAt: tick() })
			.where(eq(teamWorkItems.id, movingId));
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, workerId));
		await db.insert(teamWorkEvents).values({
			id: generateId(),
			teamId,
			workItemId: movingId,
			kind: "work.started",
			actorKind: "agent",
			actorId: teamId,
			detailJson: { worker: workerId, from: "queued" },
			createdAt: tick(),
		});
		nudge();
		await until(
			page,
			"the row works",
			(f, id: string) =>
				f.attr(`[data-testid=team-work-row][data-item-id="${id}"]`, "data-state") === "in_progress",
			10_000,
			movingId,
		);
		await until(
			page,
			"the worker shows",
			(f, id: string) =>
				f.attr(
					`[data-testid=team-work-row][data-item-id="${id}"] [data-testid=team-work-line]`,
					"data-line",
				) === "working",
			10_000,
			movingId,
		);
		await shot(page, "desktop-light-work");

		// The worker stops: the row follows from the summary, the board is not re-read.
		const readsBefore = boardReads.length;
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, workerId));
		nudge();
		await until(
			page,
			"the worker stopped",
			(f, id: string) =>
				f.attr(
					`[data-testid=team-work-row][data-item-id="${id}"] [data-testid=team-work-line]`,
					"data-line",
				) === "workerIdle",
			10_000,
			movingId,
		);
		expect(boardReads.length).toBe(readsBefore);

		// The activity tab lists the change, quietly.
		expect(
			await call(page, (f) => f.click("[data-testid=team-side-switch] input[value=activity]")),
		).toBe(true);
		await until(
			page,
			"activity",
			(f) => f.count("[data-testid=team-event][data-kind='work.started']") === 1,
		);
		await shot(page, "desktop-light-activity");
		await call(page, (f) => f.setScheme("dark"));
		await until(page, "dark", (f) => f.colors().scheme === "dark");
		await call(page, (f) => f.click("[data-testid=team-side-switch] input[value=work]"));
		await until(page, "work again", (f) => f.count("[data-testid=team-work-row]") === 2);
		await shot(page, "desktop-dark-work");
		expect(errors).toEqual([]);
	} finally {
		await call(page, (f) => f.setScheme("light")).catch(() => {});
		await page.close();
	}
}, 60_000);

test("等你处理: approve a tool call and answer a question in place; onlookers see none", async () => {
	await db
		.update(teamWorkItems)
		.set({ workerNarratorId: workerId })
		.where(eq(teamWorkItems.id, movingId));
	const requestId = await seedApproval("bun test --isolate server/routes");
	// An option longer than any label is drawn: its whole title is the answer.
	const longOption =
		`Merge the docs branch first, then rebase nothing: ${"keep both sides ".repeat(6)}`.trim();
	const questionId = await seedApproval("", "AskUserQuestion", {
		questions: [
			{
				question: "Which branch first?",
				header: "Order",
				options: [{ label: longOption }, { label: "B" }],
			},
		],
	});
	const { page, errors } = await openPage(alice, { width: 1600, height: 900 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		const tool = `[data-testid=team-attention-card][data-request-id="${requestId}"]`;
		const question = `[data-testid=team-attention-card][data-request-id="${questionId}"]`;
		await until(page, "cards", (f) => f.text("[data-testid=team-attention-count]") === "3");
		expect(
			await call(page, (f, c: string) => f.text(`${c} [data-testid=team-approval-preview]`), tool),
		).toBe("bun test --isolate server/routes");
		// The call belongs to the worker's item: in 需要你, highlighted while the card is hovered.
		expect(await call(page, (f, id: string) => f.groupOf(id), movingId)).toBe("needsYou");
		await page.hover(tool);
		await until(
			page,
			"highlight",
			(f, id: string) =>
				f.attr(`[data-testid=team-work-row][data-item-id="${id}"]`, "data-highlighted") === "true",
			10_000,
			movingId,
		);
		await shot(page, "desktop-light-attention");
		await call(page, (f, c: string) => f.click(`${c} [data-testid=team-approval-approve]`), tool);
		await until(page, "approved", (f, c: string) => f.count(c) === 0, 10_000, tool);
		expect(decisions).toContain(`${requestId}:allow`);
		// The question: its text and options, answered right here.
		expect(
			await call(
				page,
				(f, q: string) => f.text(`${q} [data-testid=team-approval-questions]`),
				question,
			),
		).toBe("Which branch first?");
		expect(
			await call(
				page,
				(f, q: string) => f.count(`${q} [data-testid=team-question-option]`),
				question,
			),
		).toBe(2);
		await call(
			page,
			(f, q: string) => f.click(`${q} [data-testid=team-question-option]`),
			question,
		);
		await until(page, "answered", (f, q: string) => f.count(q) === 0, 10_000, question);
		expect(decisions).toContain(`${questionId}:allow`);
		expect(longOption.length).toBeGreaterThan(80);
		expect(JSON.stringify(resolutions.get(questionId))).toContain(longOption);
		expect(pendingPermissions.has(requestId)).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}

	// An onlooker: the list, but no 等你处理 and no pause.
	const hidden = await seedApproval("echo hidden");
	const reader = await openPage(bob, { width: 1600, height: 900 });
	try {
		await call(reader.page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		await until(reader.page, "list", (f) => f.count("[data-testid=team-work-row]") === 2);
		await until(reader.page, "header", (f) => f.count("[data-testid=team-status]") === 1);
		expect(await call(reader.page, (f) => f.count("[data-testid=team-attention]"))).toBe(0);
		expect(await call(reader.page, (f) => f.count("[data-testid=team-pause-all]"))).toBe(0);
		expect(await call(reader.page, (f) => f.count("[data-testid=new-team]"))).toBe(0);
		expect(
			await call(reader.page, () => document.body.innerText.includes("Waiting on members")),
		).toBe(true);
		expect(reader.errors).toEqual([]);
	} finally {
		await reader.page.close();
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.id, hidden));
		pendingPermissions.delete(hidden);
	}
}, 60_000);

const BLOCKER_FINDINGS =
	"Missing the day-boundary case: an order placed after 16:00 UTC belongs to the next day in UTC+8. " +
	"The export also reads the server's zone when the user has none set; use the team default. " +
	"Add a test for each.\n" +
	"1. Orders at 15:59 and 16:00 UTC land on different days.\n" +
	"2. A user without a zone gets the team default, not the server's.\n" +
	"3. The CSV header names the zone it used.";

test("the drawer opens from a card; 退回 needs a reason and sends the item back", async () => {
	// Two review rounds with their findings, as the coordinator records them.
	for (const [round, verdict, summary] of [
		[1, "blocker", BLOCKER_FINDINGS],
		[2, "clear", "Added three day-boundary tests; the export suite passes."],
	] as const)
		await db.insert(teamWorkEvents).values({
			id: generateId(),
			teamId,
			workItemId: readyId,
			kind: "work.review",
			actorKind: "agent",
			actorId: teamId,
			detailJson: { round, verdict, findings: verdict === "blocker" ? 2 : 0, summary },
			createdAt: tick(),
		});
	const { page, errors } = await openPage(alice, { width: 1440, height: 900 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		const card = `[data-testid=team-attention-card][data-item-id="${readyId}"]`;
		await until(page, "merge card", (f, c: string) => f.count(c) === 1, 10_000, card);
		// The server never merges: 合并 is there, disabled.
		expect(
			await call(page, (f, c: string) => f.attr(`${c} [data-testid=team-merge]`, "disabled"), card),
		).toBe("");
		await call(page, (f, c: string) => f.click(`${c} [data-testid=team-merge-view]`), card);
		await until(
			page,
			"drawer",
			(f) => f.text("[data-testid=team-drawer-title]") === "Write the docs",
		);
		await until(page, "bar", (f) => f.count("[data-testid=team-drawer-return]") === 1);
		expect(await call(page, (f) => f.text("[data-testid=team-drawer-branch]"))).toBe(
			"team/write-the-docs-9f9f",
		);
		expect(await call(page, (f) => f.attr("[data-testid=team-drawer-merge]", "disabled"))).toBe("");
		// Each round shows its findings; the long one is clamped until 展开.
		await until(page, "findings", (f) => f.count("[data-testid=team-review-findings]") === 2);
		expect(await call(page, (f) => f.texts("[data-testid=team-review-findings] p"))).toEqual([
			BLOCKER_FINDINGS,
			"Added three day-boundary tests; the export suite passes.",
		]);
		expect(await call(page, (f) => f.count("[data-testid=team-review-findings-toggle]"))).toBe(1);
		const clamped = await call(page, (f) => f.height("[data-testid=team-review-findings] p"));
		await shot(page, "desktop-light-drawer");
		await call(page, (f) => f.click("[data-testid=team-review-findings-toggle]"));
		await until(
			page,
			"expanded",
			(f, before: number) => f.height("[data-testid=team-review-findings] p") > before,
			5_000,
			clamped,
		);
		expect(await call(page, (f) => f.text("[data-testid=team-review-findings-toggle]"))).toBe(
			"Show less",
		);
		await call(page, (f) => f.click("[data-testid=team-drawer-return]"));
		await until(page, "reason", (f) => f.count("[data-testid=team-return-reason]") === 1);
		// No reason, no return.
		expect(await call(page, (f) => f.attr("[data-testid=team-return-confirm]", "disabled"))).toBe(
			"",
		);
		await call(page, (f) => f.type("[data-testid=team-return-reason]", "Name the config file."));
		await until(
			page,
			"enabled",
			(f) => f.attr("[data-testid=team-return-confirm]", "disabled") === null,
		);
		await shot(page, "desktop-light-return");
		await call(page, (f) => f.click("[data-testid=team-return-confirm]"));
		await until(page, "returned", (f) => f.count("[data-testid=team-return-form]") === 0);
		const row = await db.query.teamWorkItems.findFirst({ where: eq(teamWorkItems.id, readyId) });
		expect(row).toMatchObject({ state: "in_progress", lastReview: "blocker", reviewRounds: 3 });
		expect(returnNotes.at(-1)).toContain("Name the config file.");
		await until(page, "card gone", (f, c: string) => f.count(c) === 0, 10_000, card);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("pause all reads the running sessions now and stops every one", async () => {
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, workerId));
	const { page, errors } = await openPage(alice, { width: 1600, height: 900 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		await until(page, "pause", (f) => f.count("[data-testid=team-pause-all]") === 1);
		// The coordinator starts working after the summary was read: pause still stops it.
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, teamId));
		await call(page, (f) => f.click("[data-testid=team-pause-all]"));
		await until(page, "confirm", (f) => f.count("[data-testid=team-pause-confirm]") === 1);
		await call(page, (f) => f.click("[data-testid=team-pause-confirm]"));
		await until(page, "notice", (f) => (f.text(".mantine-Notification-description") ?? "") !== "");
		expect(await call(page, (f) => f.text(".mantine-Notification-description"))).toBe(
			"Stopped 2 sessions",
		);
		for (const id of [teamId, workerId]) {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: { status: true },
			});
			expect(row?.status).toBe("idle");
		}
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("two columns when the frame has room beside the app sidebar, tabs otherwise", async () => {
	const cases = [
		{ viewport: 992, sidebar: 250, layout: "tabs" },
		{ viewport: 1280, sidebar: 250, layout: "split" },
		{ viewport: 1280, sidebar: 480, layout: "tabs" },
		{ viewport: 1600, sidebar: 250, layout: "split" },
		{ viewport: 1400, sidebar: 480, layout: "split" },
		{ viewport: 1600, sidebar: 480, layout: "split" },
	];
	for (const { viewport, sidebar, layout } of cases) {
		const { page, errors } = await openPage(alice, { width: viewport, height: 800 });
		try {
			await call(
				page,
				(f, p: string, t: string, w: number) => f.openTeam(p, t, w),
				projectId,
				teamId,
				sidebar,
			);
			await until(
				page,
				`layout at ${viewport}/${sidebar}`,
				(f) => f.attr("[data-testid=team-workspace]", "data-layout") !== "measuring",
			);
			const seen = {
				viewport,
				sidebar,
				layout: await call(page, (f) => f.attr("[data-testid=team-workspace]", "data-layout")),
				sidebarShown: await call(page, (f) => f.widthOf("[data-testid=app-sidebar]")),
			};
			expect(seen).toEqual({ viewport, sidebar, layout, sidebarShown: sidebar });
			if (layout !== "tabs") {
				// The conversation is the wider column (about 60%) and the two share the frame.
				const conversation = await call(page, (f) => f.widthOf("[data-testid=team-conversation]"));
				const side = await call(page, (f) => f.widthOf("[data-testid=team-side]"));
				const frame = await call(page, (f) => f.widthOf("[data-testid=team-workspace]"));
				expect(conversation).toBeGreaterThanOrEqual(480);
				expect(conversation).toBeGreaterThan(side);
				expect(Math.abs(conversation + side - frame)).toBeLessThanOrEqual(1);
			} else expect(await call(page, (f) => f.count("[data-testid=team-phone-tabs]"))).toBe(1);
			expect(await call(page, (f) => f.count("[data-testid=project-teams]"))).toBe(0);
			const fit = await call(page, (f) => f.fitsWidth("[data-testid=team-top-bar]"));
			expect(fit).toEqual({ found: true, inside: true, scrolls: false });
			if (viewport === 1280 && sidebar === 250) await shot(page, "laptop-sidebar-split");
			expect(errors).toEqual([]);
		} finally {
			await page.close();
		}
	}
}, 90_000);

test("the conversation is never remounted across split and tabs", async () => {
	const { page, errors } = await openPage(alice, { width: 1300, height: 800 });
	try {
		await call(
			page,
			(f, p: string, t: string, w: number) => f.openTeam(p, t, w),
			projectId,
			teamId,
			250,
		);
		// The frame is the viewport less the 250 px sidebar: split from 860.
		await until(
			page,
			"split",
			(f) => f.attr("[data-testid=team-workspace]", "data-layout") === "split",
		);
		await call(page, (f) => f.markConversation());
		const steps: Array<[number, string]> = [
			[1600, "split"],
			[1110, "split"],
			[1100, "tabs"],
			[1300, "split"],
			[900, "tabs"],
			[1600, "split"],
			[1000, "tabs"],
		];
		for (const [width, layout] of steps) {
			await page.setViewport({ width, height: 800 });
			await until(
				page,
				`${layout} at ${width}`,
				(f, want: string) => f.attr("[data-testid=team-workspace]", "data-layout") === want,
				10_000,
				layout,
			);
			expect({ width, layout, kept: await call(page, (f) => f.conversationKept()) }).toEqual({
				width,
				layout,
				kept: true,
			});
		}
		// Switching tabs keeps it too.
		await call(page, (f) => f.click("[data-testid=team-phone-tabs] input[value=work]"));
		await until(page, "work tab", (f) => f.count("[data-testid=team-work-row]") > 0);
		await call(page, (f) => f.click("[data-testid=team-phone-tabs] input[value=conversation]"));
		expect(await call(page, (f) => f.conversationKept())).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("a call the coordinator asks in its session brings its conversation forward", async () => {
	const requestId = await seedApproval(
		"",
		"RequestPermissionRule",
		{ rule: "Bash(bun test:*)" },
		teamId,
	);
	const { page, errors } = await openPage(alice, { width: 360, height: 780 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		await until(
			page,
			"tabs",
			(f) => f.attr("[data-testid=team-workspace]", "data-layout") === "tabs",
		);
		await call(page, (f) => f.markConversation());
		await call(page, (f) => f.click("[data-testid=team-phone-tabs] input[value=work]"));
		await until(page, "work", (f) => f.gone("[data-testid=conversation-stand-in]"));
		const open = `[data-testid=team-attention-card][data-request-id="${requestId}"] [data-testid=team-approval-open]`;
		await until(page, "the coordinator's call", (f, o: string) => f.count(o) === 1, 10_000, open);
		await call(page, (f, o: string) => f.click(o), open);
		await until(page, "conversation shown", (f) => !f.gone("[data-testid=conversation-stand-in]"));
		await until(page, "composer focused", (f) => f.focused() === "composer-stand-in");
		expect(await call(page, (f) => f.conversationKept())).toBe(true);
		expect(await call(page, (f) => f.openedTargets())).not.toContain(`session:${teamId}`);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.id, requestId));
		pendingPermissions.delete(requestId);
	}
}, 60_000);

test("the page is about one team: no teams list, no new team, at desktop and phone widths", async () => {
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
		{ width: 360, height: 780 },
	]) {
		const { page, errors } = await openPage(alice, viewport);
		try {
			await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
			await until(page, "title", (f) => f.text("[data-testid=team-title]") === "Release crew");
			const seen = {
				width: viewport.width,
				lists: await call(page, (f) => f.count("[data-testid=project-teams]")),
				rows: await call(page, (f) => f.count("[data-testid=project-team-card]")),
				newTeam: await call(page, (f) => f.count("[data-testid=new-team]")),
				newTeamText: await call(page, () => document.body.innerText.includes("New team")),
			};
			expect(seen).toEqual({
				width: viewport.width,
				lists: 0,
				rows: 0,
				newTeam: 0,
				newTeamText: false,
			});
			await call(page, (f) => f.setLanguage("zh-CN"));
			await until(page, "Chinese", (f) => f.text("[data-testid=team-title]") === "Release crew");
			expect(await call(page, () => document.body.innerText.includes("新建团队"))).toBe(false);
			await call(page, (f) => f.setLanguage("en"));
			// Nothing floats over the header: on a phone it carries the menu button (two rows) and
			// the floating fallback stays away; on a desktop the back arrow leads to the project.
			const phone = viewport.width < 768;
			expect(await call(page, (f) => f.count("[data-mobile-nav-fallback]"))).toBe(0);
			expect(await call(page, (f) => !f.gone("[data-mobile-nav-button]"))).toBe(phone);
			expect(await call(page, (f) => f.attr("[data-testid=team-top-bar]", "data-phone"))).toBe(
				phone ? "true" : "false",
			);
			if (phone) {
				const menu = await call(page, (f) =>
					f.fitsWidth("[data-testid=team-top-bar] [data-mobile-nav-button]"),
				);
				expect(menu).toEqual({ found: true, inside: true, scrolls: false });
				expect(await call(page, (f) => f.tappable("[data-mobile-nav-button]"))).toBe(true);
				expect(await call(page, (f) => f.tappable("[data-testid=team-more-menu]"))).toBe(true);
			} else {
				expect(await call(page, (f) => f.tappable("[data-testid=team-back]"))).toBe(true);
				await call(page, (f) => f.click("[data-testid=team-back]"));
				expect(await call(page, (f) => f.openedTargets())).toContain("back");
			}
			expect(errors).toEqual([]);
		} finally {
			await page.close();
		}
	}
}, 60_000);

test("at 360 px a read-only user opens team communications and Back closes only the drawer", async () => {
	const { page, errors } = await openPage(bob, { width: 360, height: 780 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		await until(page, "members loaded", (f) => f.count("[data-testid=team-members-button]") === 1);
		await until(
			page,
			"phone header",
			(f) => f.attr("[data-testid=team-top-bar]", "data-phone") === "true",
		);
		await page.click("[data-testid=team-more-menu]");
		const entrySelector = "[data-testid=team-communication-button]";
		await page.waitForSelector(entrySelector, { visible: true });
		const entry = await page.$eval(entrySelector, (el) => ({
			text: el.textContent,
			role: el.getAttribute("role"),
			iconHidden: el.querySelector("svg")?.getAttribute("aria-hidden"),
			height: el.getBoundingClientRect().height,
		}));
		expect(entry).toMatchObject({
			text: "Communication topology",
			role: "menuitem",
			iconHidden: "true",
		});
		expect(entry.height).toBeGreaterThanOrEqual(48);
		expect(await call(page, (f) => f.count("[data-testid=team-pause-all]"))).toBe(0);
		await page.click(entrySelector);
		await until(page, "topology drawer", (f) => {
			const fit = f.fitsWidth("[data-testid=communication-topology]");
			return fit.found && fit.inside && !fit.scrolls;
		});
		await page.waitForFunction(() => typeof history.state?.__NF_sentinel_id === "string");
		const teamPageUrl = page.url();
		await page.evaluate(() => history.back());
		await until(page, "topology drawer closed", (f) => f.gone(".mantine-Drawer-content"));
		expect(page.url()).toBe(teamPageUrl);
		expect(await call(page, (f) => f.text("[data-testid=team-title]"))).toBe("Release crew");
		expect(await call(page, (f) => f.openedTargets())).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("an archived team says so in the header and offers no pause all", async () => {
	const owner = { userId: alice, isAdmin: false };
	const old = await createTeam({ projectId, name: "Old crew" }, owner);
	await archiveTeam(old.id, owner, projectId);
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 360, height: 780 },
	]) {
		const { page, errors } = await openPage(alice, viewport);
		try {
			await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, old.id);
			await until(page, "archived", (f) => f.count("[data-testid=team-archived]") === 1);
			expect(await call(page, (f) => f.text("[data-testid=team-archived]"))).toBe("Archived");
			expect(await call(page, (f) => f.text("[data-testid=team-title]"))).toBe("Old crew");
			expect(await call(page, (f) => f.attr("[data-testid=team-status]", "data-tone"))).toBe(
				"archived",
			);
			expect(await call(page, (f) => f.count("[data-testid=team-pause-all]"))).toBe(0);
			// No starting prompt on an archived team.
			expect(await call(page, (f) => f.count("[data-testid=team-start]"))).toBe(0);
			// The people list stays (the owner still manages access).
			expect(await call(page, (f) => f.count("[data-testid=team-members-button]"))).toBe(1);
			const fit = await call(page, (f) => f.fitsWidth("[data-testid=team-archived]"));
			expect(fit).toEqual({ found: true, inside: true, scrolls: false });
			await call(page, (f) => f.setLanguage("zh-CN"));
			await until(page, "Chinese", (f) => f.text("[data-testid=team-archived]") === "已归档");
			await shot(page, `archived-${viewport.width}`);
			await call(page, (f) => f.setLanguage("en"));
			expect(errors).toEqual([]);
		} finally {
			await page.close();
		}
	}
}, 60_000);

test("360 px: tabs without sideways scrolling, light and dark, English and Chinese", async () => {
	const pending = await seedApproval("bun run build");
	const { page, errors } = await openPage(alice, { width: 360, height: 780 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, teamId);
		await until(
			page,
			"tabs",
			(f) => f.attr("[data-testid=team-workspace]", "data-layout") === "tabs",
		);
		await until(page, "title", (f) => f.text("[data-testid=team-title]") === "Release crew");
		await until(page, "cards", (f) => f.count("[data-testid=team-attention-card]") > 0);
		for (const selector of [
			"[data-testid=team-top-bar]",
			"[data-testid=team-status]",
			"[data-testid=team-members-button]",
			"[data-testid=team-more-menu]",
			"[data-testid=team-attention-card]",
			"[data-testid=team-phone-tabs]",
			"[data-testid=conversation-stand-in]",
		]) {
			const fit = await call(page, (f, s: string) => f.fitsWidth(s), selector);
			expect({ selector, ...fit }).toEqual({ selector, found: true, inside: true, scrolls: false });
		}
		// 全部暂停 lives in the 「…」 menu on a phone.
		expect(
			await call(page, (f) => f.count("[data-testid=team-top-bar] [data-testid=team-pause-all]")),
		).toBe(0);
		await shot(page, "phone-light-conversation");
		await call(page, (f) => f.click("[data-testid=team-phone-tabs] input[value=work]"));
		await until(page, "rows", (f) => f.count("[data-testid=team-work-row]") > 0);
		const fit = await call(page, (f) => f.fitsWidth("[data-testid=team-work-row]"));
		expect(fit).toEqual({ found: true, inside: true, scrolls: false });
		await shot(page, "phone-light-work");

		await call(page, (f) => f.setScheme("dark"));
		await until(page, "dark", (f) => f.colors().scheme === "dark");
		const dark = await call(page, (f) => f.colors());
		await call(page, (f) => f.setScheme("light"));
		await until(page, "light", (f) => f.colors().scheme === "light");
		const light = await call(page, (f) => f.colors());
		expect(dark.background).not.toBe(light.background);
		await call(page, (f) => f.setScheme("dark"));
		await until(page, "dark again", (f) => f.colors().scheme === "dark");
		await shot(page, "phone-dark-work");

		// The drawer of an item fills the phone.
		await call(page, (f) => f.click("[data-testid=team-work-row]"));
		await until(page, "drawer", (f) => (f.text("[data-testid=team-drawer-title]") ?? "") !== "");
		await until(page, "drawer in place", (f) => {
			const fit = f.fitsWidth("[data-testid=team-drawer-title]");
			return fit.found && fit.inside && !fit.scrolls;
		});
		await shot(page, "phone-dark-drawer");
		await call(page, (f) => f.click("[data-testid=team-drawer-close]"));
		await until(page, "drawer closed", (f) => f.gone(".mantine-Drawer-content"));

		// M1: the people drawer (members, onlookers; the owner's sharing panel) fits too.
		await call(page, (f) => f.click("[data-testid=team-members-button]"));
		await until(page, "members drawer", (f) => f.count("[data-testid=team-member]") >= 2);
		await until(page, "members in place", (f) => {
			const fit = f.fitsWidth("[data-testid=team-members]");
			return fit.found && fit.inside && !fit.scrolls;
		});
		await until(
			page,
			"sharing panel",
			(f) => f.count("[data-testid=team-members-manage] [role=region]") === 1,
		);
		for (const selector of [
			"[data-testid=team-member]",
			"[data-testid=team-members-manage]",
			"[data-testid=team-members-manage] .mantine-SegmentedControl-root",
		]) {
			const fit = await call(page, (f, s: string) => f.fitsWidth(s), selector);
			expect({ selector, ...fit }).toEqual({ selector, found: true, inside: true, scrolls: false });
		}
		await shot(page, "phone-dark-members");
		await page.keyboard.press("Escape");
		await until(page, "members closed", (f) => f.gone(".mantine-Drawer-content"));

		// Chinese wording (no width checks: CI has no CJK fonts).
		await call(page, (f) => f.setLanguage("zh-CN"));
		await until(page, "Chinese", () => document.body.innerText.includes("等你处理"));
		await call(page, (f) => f.click("[data-testid=team-side-switch] input[value=activity]"));
		await until(page, "activity", (f) => f.count("[data-testid=team-event]") > 0);
		await shot(page, "phone-dark-activity-zh");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.id, pending));
		pendingPermissions.delete(pending);
	}
}, 60_000);

test("where teams are not available (503), the project page shows no teams section", async () => {
	const { page, errors } = await openPage(alice, { width: 1280, height: 800 });
	try {
		await page.setRequestInterception(true);
		let refused = 0;
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.endsWith("/teams")) {
				refused++;
				void request.respond({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "Project teams", code: "POSTGRES_UNSUPPORTED" }),
				});
			} else void request.continue();
		});
		await call(page, (f, p: string) => f.openProjectTeams(p, true), projectId);
		await until(page, "the list was asked", (f) => f.idle());
		expect(refused).toBe(1);
		expect(await call(page, (f) => f.count("[data-testid=project-teams]"))).toBe(0);
		expect(await call(page, (f) => f.count("[data-testid=new-team]"))).toBe(0);
		expect(await call(page, (f) => f.count(".mantine-Alert-root"))).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("the project page's teams section creates a team", async () => {
	const { page, errors } = await openPage(alice, { width: 360, height: 780 });
	try {
		await call(page, (f, p: string) => f.openProjectTeams(p, true), projectId);
		await until(page, "list", (f) => f.count("[data-testid=project-team-card]") === 1);
		await call(page, (f) => f.click("[data-testid=new-team]"));
		await until(page, "dialog", (f) => f.count("[data-testid=create-team-name]") === 1);
		await call(page, (f) => f.type("[data-testid=create-team-name]", "Docs crew"));
		await shot(page, "phone-light-new-team");
		await call(page, (f) => f.click("[data-testid=create-team-submit]"));
		await until(page, "created", (f) => f.openedTargets().some((x) => x.startsWith("team:")));
		await until(page, "listed", (f) => f.count("[data-testid=project-team-card]") === 2);
		const created = await db.query.narrators.findFirst({
			where: eq(narrators.title, "Docs crew"),
			columns: { id: true, traits: true, contextProjectId: true },
		});
		expect(created?.traits).toContain("team");
		expect(created?.contextProjectId).toBe(projectId);
		expect(await call(page, (f) => f.openedTargets())).toContain(`team:${created?.id}`);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}

	const reader = await openPage(bob, { width: 360, height: 780 });
	try {
		await call(reader.page, (f, p: string) => f.openProjectTeams(p, false), projectId);
		await until(reader.page, "list", (f) => f.count("[data-testid=project-team-card]") === 2);
		expect(await call(reader.page, (f) => f.count("[data-testid=new-team]"))).toBe(0);
	} finally {
		await reader.page.close();
	}
}, 60_000);

test("dependencies: blocked rows say what they wait for; the drawer lists and links them", async () => {
	const plan = await createTeam(
		{ projectId, name: "Plan crew" },
		{ userId: alice, isAdmin: false },
	);
	const seed = async (title: string, state: string) => {
		const id = generateId();
		const at = tick();
		await db.insert(teamWorkItems).values({
			id,
			teamId: plan.id,
			projectId,
			title,
			state: state as "queued",
			createdAt: at,
			updatedAt: at,
		});
		return id;
	};
	const depend = (itemId: string, dependsOnItemId: string) =>
		db
			.insert(teamWorkItemDependencies)
			.values({ itemId, dependsOnItemId, teamId: plan.id, createdAt: tick() });
	const schemaId = await seed("Schema", "in_progress");
	const apiId = await seed("API", "queued");
	const oldId = await seed("Old plan", "cancelled");
	const pageId = await seed("Page", "queued");
	await depend(apiId, schemaId);
	await depend(pageId, oldId);
	const row = (id: string) => `[data-testid=team-work-row][data-item-id="${id}"]`;
	const { page, errors } = await openPage(alice, { width: 1440, height: 900 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t), projectId, plan.id);
		await until(page, "rows", (f, r: string) => f.count(r) === 1, 10_000, row(pageId));
		expect(
			await call(page, (f, r: string) => f.text(`${r} [data-testid=team-work-line]`), row(apiId)),
		).toBe("Queued · waiting for “Schema” to merge");
		expect(
			await call(
				page,
				(f, r: string) => f.attr(`${r} [data-testid=team-work-line]`, "data-line"),
				row(pageId),
			),
		).toBe("queuedBlockedCancelled");

		// The drawer of a blocked item: its dependency with its state, and when it starts.
		await call(page, (f, r: string) => f.click(r), row(apiId));
		await until(page, "API drawer", (f) => f.text("[data-testid=team-drawer-title]") === "API");
		await until(
			page,
			"dependencies",
			(f) => f.count("[data-testid=team-drawer-dependencies]") === 1,
		);
		expect(
			await call(page, (f) =>
				f.attr(
					"[data-testid=team-drawer-dependencies] [data-testid=team-dependency]",
					"data-state",
				),
			),
		).toBe("in_progress");
		expect(await call(page, (f) => f.count("[data-testid=team-dependency-cancelled]"))).toBe(0);
		await shot(page, "desktop-light-dependencies");
		// A dependency's title opens that item, which lists API under 被依赖.
		await call(page, (f) =>
			f.click("[data-testid=team-drawer-dependencies] [data-testid=team-dependency] button"),
		);
		await until(
			page,
			"Schema drawer",
			(f) => f.text("[data-testid=team-drawer-title]") === "Schema",
		);
		await until(page, "dependents", (f) => f.count("[data-testid=team-drawer-dependents]") === 1);
		expect(await call(page, (f) => f.text("[data-testid=team-drawer-dependents]"))).toContain(
			"API",
		);
		expect(await call(page, (f) => f.count("[data-testid=team-drawer-dependencies]"))).toBe(0);

		// A cancelled dependency never merges: the drawer says so, in either language.
		await call(page, (f, r: string) => f.click(r), row(pageId));
		await until(page, "Page drawer", (f) => f.text("[data-testid=team-drawer-title]") === "Page");
		await until(page, "warning", (f) => f.count("[data-testid=team-dependency-cancelled]") === 1);
		expect(await call(page, (f) => f.text("[data-testid=team-dependency-cancelled]"))).toContain(
			"“Old plan” was cancelled",
		);
		await call(page, (f) => f.setLanguage("zh-CN"));
		await until(page, "Chinese", (f) =>
			(f.text("[data-testid=team-dependency-cancelled]") ?? "").includes("「Old plan」已取消"),
		);
		expect(
			await call(page, (f, r: string) => f.text(`${r} [data-testid=team-work-line]`), row(apiId)),
		).toBe("排队 · 等「Schema」合并");
		await call(page, (f) => f.setLanguage("en"));
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);
