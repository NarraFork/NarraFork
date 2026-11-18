/**
 * The team page in Chromium (docs/PROJECT_TEAMS-PLAN.md §二.11, §二.12; P4), against a test
 * server running the real team, project and narrator routes on the isolated SQLite of
 * `tests/preload.ts`:
 *
 *   - the board reflects work item state changes: a queued item moves to "in progress" with its
 *     worker after the change, picked up through the coordinator's narrator socket;
 *   - a member opens the pending approvals and approves one through the ordinary permission
 *     route; an onlooker sees no approvals and no "pause all";
 *   - "pause all" stops the tree's running sessions through the ordinary Stop route;
 *   - at 360 px the page is conversation / board / activity tabs without sideways scrolling, in
 *     light and dark; the project page's teams section creates a team.
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
import { createTeam } from "../../../server/services/teams/team-service";
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
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

	alice = await person(`alice${Date.now()}`);
	bob = await person(`bob${Date.now()}`);
	const repo = mkdtempSync(join(tmpdir(), "nf-team-page-"));
	mkdirSync(repo, { recursive: true });
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

async function seedApproval(command: string) {
	const requestId = generateId();
	const messageId = generateId();
	const at = tick();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: workerId,
		role: "assistant",
		contentJson: [],
		createdAt: at,
	});
	const input = { command };
	await db.insert(narratorToolCalls).values({
		id: requestId,
		narratorId: workerId,
		messageId,
		toolUseId: `use-${requestId}`,
		toolName: "Bash",
		status: "pending",
		inputJson: input,
		permissionStartedAt: at,
		createdAt: at,
	});
	pendingPermissions.set(requestId, {
		narratorId: workerId,
		broadcastTargetId: teamId,
		toolName: "Bash",
		toolUseId: `use-${requestId}`,
		input,
		cwd: "/work",
		locale: "en",
		signal: new AbortController().signal,
		resolve: (result) => decisions.push(`${requestId}:${result.behavior}`),
		cleanup: () => {
			pendingPermissions.delete(requestId);
		},
	});
	return requestId;
}

let movingId: string;
let readyId: string;

test("the board reflects work item state changes", async () => {
	movingId = await seedItem("Wire the board", "queued", { branchName: "team/wire-the-board-1a2b" });
	readyId = await seedItem("Write the docs", "ready", {
		branchName: "team/write-the-docs-9f9f",
		reviewRounds: 2,
		lastReview: "clear",
		exclusiveKey: "docs",
	});
	const { page, errors } = await openPage(alice, { width: 1280, height: 860 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t, true), projectId, teamId);
		await until(page, "the board", (f) => f.count("[data-testid=team-card]") === 2);
		expect(await call(page, (f) => f.attr("[data-testid=team-workspace]", "data-layout"))).toBe(
			"columns",
		);
		expect(await call(page, (f, id: string) => f.columnOf(id), movingId)).toBe("queued");
		expect(await call(page, (f, id: string) => f.columnOf(id), readyId)).toBe("review");
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
			"the card moved",
			(f, id: string) => f.columnOf(id) === "in_progress",
			10_000,
			movingId,
		);
		await until(
			page,
			"the worker shows",
			(f) => f.attr("[data-testid=team-card-worker]", "data-status") === "working",
		);
		expect(
			await call(page, (f) =>
				f.attr("[data-testid=team-column][data-column=queued]", "data-count"),
			),
		).toBe("0");
		await until(
			page,
			"running count",
			(f) => f.attr("[data-testid=team-running-button]", "data-count") === "1",
		);
		await shot(page, "desktop-light-board");

		// The activity tab lists the change.
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
		await call(page, (f) => f.click("[data-testid=team-side-switch] input[value=board]"));
		await until(page, "board again", (f) => f.count("[data-testid=team-card]") === 2);
		await shot(page, "desktop-dark-board");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("a member approves a pending tool call; an onlooker sees no approvals", async () => {
	const requestId = await seedApproval("bun test --isolate server/routes");
	const { page, errors } = await openPage(alice, { width: 1280, height: 860 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t, true), projectId, teamId);
		await until(
			page,
			"approvals count",
			(f) => f.attr("[data-testid=team-approvals-button]", "data-count") === "1",
		);
		await call(page, (f) => f.click("[data-testid=team-approvals-button]"));
		await until(page, "approval row", (f) => f.count("[data-testid=team-approval]") === 1);
		expect(await call(page, (f) => f.text("[data-testid=team-approval-preview]"))).toBe(
			"bun test --isolate server/routes",
		);
		await until(page, "drawer in place", (f) => {
			const fit = f.fitsWidth("[data-testid=team-approval]");
			return fit.found && fit.inside;
		});
		await shot(page, "desktop-light-approvals");
		await call(page, (f) => f.click("[data-testid=team-approval-approve]"));
		await until(page, "approved", (f) => f.count("[data-testid=team-approvals-empty]") === 1);
		expect(decisions).toEqual([`${requestId}:allow`]);
		expect(pendingPermissions.has(requestId)).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}

	// An onlooker: the board, but no approvals and no pause.
	await seedApproval("echo hidden");
	const reader = await openPage(bob, { width: 1280, height: 860 });
	try {
		await call(
			reader.page,
			(f, p: string, t: string) => f.openTeam(p, t, false),
			projectId,
			teamId,
		);
		await until(reader.page, "board", (f) => f.count("[data-testid=team-card]") === 2);
		await until(reader.page, "top bar", (f) => f.count("[data-testid=team-running-button]") === 1);
		expect(await call(reader.page, (f) => f.count("[data-testid=team-approvals-button]"))).toBe(0);
		expect(await call(reader.page, (f) => f.count("[data-testid=team-pause-all]"))).toBe(0);
		expect(await call(reader.page, (f) => f.count("[data-testid=new-team]"))).toBe(0);
		expect(reader.errors).toEqual([]);
	} finally {
		await reader.page.close();
	}
}, 60_000);

test("pause all stops the running sessions of the tree", async () => {
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, workerId));
	const { page, errors } = await openPage(alice, { width: 1280, height: 860 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t, true), projectId, teamId);
		await until(
			page,
			"running",
			(f) => f.attr("[data-testid=team-running-button]", "data-count") === "1",
		);
		await call(page, (f) => f.click("[data-testid=team-pause-all]"));
		await until(page, "confirm", (f) => f.count("[data-testid=team-pause-confirm]") === 1);
		await call(page, (f) => f.click("[data-testid=team-pause-confirm]"));
		await until(
			page,
			"nothing running",
			(f) => f.attr("[data-testid=team-running-button]", "data-count") === "0",
		);
		const worker = await db.query.narrators.findFirst({
			where: eq(narrators.id, workerId),
			columns: { status: true },
		});
		expect(worker?.status).toBe("idle");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("360 px: tabs without sideways scrolling, light and dark, English and Chinese", async () => {
	const { page, errors } = await openPage(alice, { width: 360, height: 780 });
	try {
		await call(page, (f, p: string, t: string) => f.openTeam(p, t, true), projectId, teamId);
		await until(
			page,
			"tabs",
			(f) => f.attr("[data-testid=team-workspace]", "data-layout") === "tabs",
		);
		await until(page, "title", (f) => f.text("[data-testid=team-title]") === "Release crew");
		for (const selector of [
			"[data-testid=team-top-bar]",
			"[data-testid=team-tab-board]",
			"[data-testid=conversation-stand-in]",
		]) {
			const fit = await call(page, (f, s: string) => f.fitsWidth(s), selector);
			expect({ selector, ...fit }).toEqual({ selector, found: true, inside: true, scrolls: false });
		}
		await shot(page, "phone-light-conversation");
		await call(page, (f) => f.click("[data-testid=team-tab-board]"));
		await until(page, "cards", (f) => f.count("[data-testid=team-card]") === 2);
		for (const selector of ["[data-testid=team-card]", "[data-testid=team-card-branch]"]) {
			const fit = await call(page, (f, s: string) => f.fitsWidth(s), selector);
			expect({ selector, ...fit }).toEqual({ selector, found: true, inside: true, scrolls: false });
		}
		await shot(page, "phone-light-board");

		await call(page, (f) => f.setScheme("dark"));
		await until(page, "dark", (f) => f.colors().scheme === "dark");
		const dark = await call(page, (f) => f.colors());
		await call(page, (f) => f.setScheme("light"));
		await until(page, "light", (f) => f.colors().scheme === "light");
		const light = await call(page, (f) => f.colors());
		expect(dark.background).not.toBe(light.background);
		await call(page, (f) => f.setScheme("dark"));
		await until(page, "dark again", (f) => f.colors().scheme === "dark");
		await shot(page, "phone-dark-board");

		await call(page, (f) => f.click("[data-testid=team-approvals-button]"));
		await until(page, "approvals drawer", (f) => f.count("[data-testid=team-approval]") === 1);
		// Once the drawer has slid in, the approval lies inside the 360 px viewport.
		await until(page, "drawer in place", (f) => {
			const fit = f.fitsWidth("[data-testid=team-approval]");
			return fit.found && fit.inside && !fit.scrolls;
		});
		await shot(page, "phone-dark-approvals");
		await page.keyboard.press("Escape");
		await until(page, "drawer closed", (f) => f.gone(".mantine-Drawer-content"));

		// Chinese wording (no width checks: CI has no CJK fonts).
		await call(page, (f) => f.setLanguage("zh-CN"));
		await until(page, "Chinese", (f) => f.text("[data-testid=team-tab-board]") === "看板");
		await call(page, (f) => f.click("[data-testid=team-tab-activity]"));
		await until(page, "activity", (f) => f.count("[data-testid=team-event]") > 0);
		await shot(page, "phone-dark-activity-zh");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("the project page's teams section creates a team", async () => {
	const { page, errors } = await openPage(alice, { width: 360, height: 780 });
	try {
		await call(page, (f, p: string) => f.openProjectTeams(p, true), projectId);
		await until(page, "list", (f) => f.count("[data-testid=project-team-row]") === 1);
		await call(page, (f) => f.click("[data-testid=new-team]"));
		await until(page, "dialog", (f) => f.count("[data-testid=create-team-name]") === 1);
		await call(page, (f) => f.type("[data-testid=create-team-name]", "Docs crew"));
		await shot(page, "phone-light-new-team");
		await call(page, (f) => f.click("[data-testid=create-team-submit]"));
		await until(page, "created", (f) => f.openedTargets().some((x) => x.startsWith("team:")));
		await until(page, "listed", (f) => f.count("[data-testid=project-team-row]") === 2);
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
		await until(reader.page, "list", (f) => f.count("[data-testid=project-team-row]") === 2);
		expect(await call(reader.page, (f) => f.count("[data-testid=new-team]"))).toBe(0);
	} finally {
		await reader.page.close();
	}
}, 60_000);
