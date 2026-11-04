/**
 * An outline plan's approval card and its diff (outline P2 PR 8, D48 Q5), in Chromium, against a
 * test server running the real outline routes, the plan service behind the decision route and the
 * page's change hints (the isolated SQLite of `tests/preload.ts`):
 *
 *   - the card's summary counts the version's changes; "View changes" lists them block by block;
 *     a person editing the plan meanwhile is shown in the open diff without any refresh;
 *   - "Execute as draft" after someone else changed the plan is refused (409): the card says so,
 *     and the diff as of now is shown; deciding again approves it;
 *   - "Lock and execute…" names a session to confirm on the person's behalf;
 *   - "Return" with feedback sends it back and writes the feedback under the plan;
 *   - with feedback typed, Enter returns the plan (without, it executes it as a draft);
 *   - at a phone's width nothing scrolls sideways.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../../server/db";
import { narrators, projects, users } from "../../../../server/db/schema";
import { AppError } from "../../../../server/lib/errors";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { outlineRoutes } from "../../../../server/routes/outline";
import { pendingPermissions } from "../../../../server/services/narrator-session-state";
import { findPlanningRoot } from "../../../../server/services/outline/plans";
import { ensureSessionSpace } from "../../../../server/services/outline/spaces";
import { outlineStore } from "../../../../server/services/outline/store";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	decideOutlinePlanRequest,
	enterOutlinePlanMode,
	resolveOutlineExitPlanInput,
} from "../../../../server/services/outline-plan-mode";
import {
	handleOutlinePageMessage,
	type OutlinePageSocket,
	releaseOutlinePageSubscriptions,
} from "../../../../server/websocket/outline-page-ws";
import type * as Fixture from "./outline-plan-approval.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-11-04T00:00:00.000Z";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let owner: string;
let colleague: string;
let projectId: string;
let lead: string;
const subscribedPages = new Set<string>();

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
	// What the lock's delegate picker reads: the session's project, then its sessions.
	app.get("/api/narrators/:id", (c) => c.json({ id: c.req.param("id"), projectId }));
	app.get("/api/narrators", (c) =>
		c.json({
			items: [{ id: lead, title: "Lead session", type: "primary" }],
			hasMore: false,
			nextCursor: null,
			totalCount: 1,
		}),
	);
	// The decision route: the same service the app's route calls.
	app.post("/api/narrators/permissions/:requestId/plan", async (c) => {
		const user = c.get("user") as { sub: string };
		const result = await decideOutlinePlanRequest({
			requestId: c.req.param("requestId"),
			principal: { userId: user.sub, isAdmin: false },
			body: await c.req.json(),
		});
		return c.json({ ok: true, commit: result.commit });
	});
	app.route("/api/outline", outlineRoutes);
	return app;
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./outline-plan-approval.browser-fixture.tsx", import.meta.url).pathname],
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
	server = Bun.serve<{ userId: string; username: string; userRole: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/ws/narrator") {
				const userId = url.searchParams.get("token") ?? "";
				if (srv.upgrade(request, { data: { userId, username: "alice", userRole: "user" } }))
					return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
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
		websocket: {
			message(ws, message) {
				if (typeof message !== "string") return;
				const frame = JSON.parse(message) as { type?: string; pageId?: string };
				if (frame.type === "outline_page_subscribe" || frame.type === "outline_page_unsubscribe")
					void handleOutlinePageMessage(
						ws as unknown as OutlinePageSocket,
						frame as Parameters<typeof handleOutlinePageMessage>[1],
					).then(() => {
						if (frame.type === "outline_page_subscribe" && frame.pageId)
							subscribedPages.add(frame.pageId);
					});
			},
			close(ws) {
				releaseOutlinePageSubscriptions(ws as unknown as OutlinePageSocket);
			},
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
	owner = generateId();
	colleague = generateId();
	for (const [id, name] of [
		[owner, "alice"],
		[colleague, "bob"],
	] as const) {
		await db
			.insert(users)
			.values({ id, username: `${name}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	}
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Plans",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	lead = await newSession("Lead session");
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function newSession(title: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		taskBackend: "outline",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A session with a submitted plan waiting for a decision; its outcome is captured. */
async function waitingPlan() {
	// The test preload restores settings after every test.
	settings.outline.enabled = true;
	const id = await newSession("Planner");
	await enterOutlinePlanMode({ narratorId: id, userId: owner, input: {}, locale: "en" });
	const root = await findPlanningRoot(id);
	const space = await ensureSessionSpace(id);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "update", block: { id: root?.blockId as string }, content: "Ship the importer" },
			{
				op: "insert",
				parent: { id: root?.blockId as string },
				content: "Step A",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { id: root?.blockId as string },
				content: "Step B",
				task: { status: "todo" },
			},
		],
		actor: { kind: "agent", id },
		responsibleUserId: owner,
		narratorId: id,
	});
	const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
	if (!resolved?.ok) throw new Error("not submitted");
	const requestId = generateId();
	let outcome: { behavior: string; message?: string } | null = null;
	pendingPermissions.set(requestId, {
		resolve: (result) => {
			outcome = result as { behavior: string; message?: string };
		},
		cleanup: () => {},
		input: resolved.input,
		narratorId: id,
		toolName: "ExitPlanMode",
		toolUseId: `toolu_${requestId}`,
		broadcastTargetId: id,
		cwd: "/",
		locale: "en",
		signal: new AbortController().signal,
	});
	return {
		id,
		requestId,
		space,
		root: root?.blockId as string,
		pageId: (await outlineStore.getBlock(root?.blockId as string))?.pageId as string,
		steps: [written.results[1]?.blockId as string, written.results[2]?.blockId as string],
		permission: {
			id: requestId,
			toolName: "ExitPlanMode",
			toolUseId: `toolu_${requestId}`,
			ownerNarratorId: id,
			inputJson: resolved.input,
		},
		outcome: () => outcome as { behavior: string; message?: string } | null,
	};
}

async function openCard(
	permission: Record<string, unknown>,
	viewport = { width: 1000, height: 800 },
	options: { keyboard?: boolean } = {},
): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport(viewport);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), owner);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate(
		(p, o) => (window as unknown as FixtureWindow).fixture.open(p as never, o),
		permission,
		options,
	);
	await page.waitForSelector("[data-testid=outline-plan-approval]", { timeout: 15_000 });
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
		const body = await page.evaluate(() => document.body.innerText.slice(0, 2000));
		throw new Error(`timed out waiting for ${what}: ${String(error)}\n${body}`);
	}
}

async function waitFor<T>(
	what: string,
	fn: () => T | null | undefined | Promise<T | null | undefined>,
) {
	const until = Date.now() + 10_000;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(30);
	}
}

test("the card's summary and diff; an edit by the person shows live; a change by someone else is a 409, then approved", async () => {
	const plan = await waitingPlan();
	const { page, errors } = await openCard(plan.permission);
	expect(await call(page, (f) => f.text("[data-testid=outline-plan-summary]"))).toBe(
		"Version 1 · a new plan of 3 blocks",
	);
	expect(await call(page, (f) => f.clickButton("View changes"))).toBe(true);
	await until(page, "the diff", (f) => f.count("[data-testid=outline-plan-diff-entry]") === 3);
	const shown = await call(page, (f) => f.entries());
	expect(shown[0]).toContain("Ship the importer");
	expect(shown[1]).toContain("Step A");
	await waitFor("the page subscription", () => subscribedPages.has(plan.pageId));

	// The person rewrites a step in the outline beside the session: the open diff follows.
	await writeOutline({
		spaceId: plan.space.id,
		ops: [{ op: "update", block: { id: plan.steps[0] as string }, content: "Step A, with tests" }],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	await until(page, "the edit in the diff", (f) =>
		f.entries().some((e) => e.includes("Step A, with tests")),
	);

	// A colleague changes it too, after the version on screen: the decision is refused.
	await writeOutline({
		spaceId: plan.space.id,
		ops: [{ op: "update", block: { id: plan.steps[1] as string }, content: "Step B, by Bob" }],
		actor: { kind: "human", id: colleague },
		responsibleUserId: colleague,
	});
	// Decide before the hint can refresh the diff (the version on screen is the older one).
	await call(page, (f) => f.click("[data-testid=outline-plan-draft-modal]"));
	await until(page, "the 409", (f) =>
		(f.text("[data-testid=outline-plan-error]") ?? "").includes("changed since you looked"),
	);
	expect(plan.outcome()).toBeNull();
	await until(page, "the colleague's change in the diff", (f) =>
		f.entries().some((e) => e.includes("Step B, by Bob")),
	);
	await call(page, (f) => f.click("[data-testid=outline-plan-draft-modal]"));
	await waitFor("the approval", () => plan.outcome());
	expect(plan.outcome()?.behavior).toBe("allow");
	expect((await outlineStore.getBlock(plan.root))?.taskJson?.plan?.state).toBe("approved");
	expect(errors).toEqual([]);
	await page.close();
});

test("lock and execute names a session to confirm on the person's behalf", async () => {
	const plan = await waitingPlan();
	const { page, errors } = await openCard(plan.permission);
	expect(await call(page, (f) => f.clickButton("Lock and execute…"))).toBe(true);
	await page.waitForSelector("[data-testid=outline-plan-lock-modal]");
	await page.click("[data-testid=outline-plan-delegate]");
	await until(page, "the sessions", (f) => f.options().includes("Lead session"));
	expect(await call(page, (f) => f.chooseOption("Lead session"))).toBe(true);
	await call(page, (f) => f.click("[data-testid=outline-plan-lock-confirm]"));
	await waitFor("the approval", () => plan.outcome());
	expect(plan.outcome()?.behavior).toBe("allow");
	const root = await outlineStore.getBlock(plan.root);
	expect(root?.taskJson?.lock).toMatchObject({ by: { kind: "human", id: owner }, delegate: lead });
	expect(errors).toEqual([]);
	await page.close();
});

test("return sends the feedback back and records it under the plan; nothing scrolls sideways on a phone", async () => {
	const plan = await waitingPlan();
	const { page, errors } = await openCard(plan.permission, { width: 375, height: 740 });
	expect(await call(page, (f) => f.overflowsX())).toBe(false);
	await call(page, (f) => f.type("[data-testid=outline-plan-feedback]", "Add a rollback step"));
	expect(await call(page, (f) => f.clickButton("Return"))).toBe(true);
	await waitFor("the return", () => plan.outcome());
	expect(plan.outcome()?.behavior).toBe("deny");
	expect(plan.outcome()?.message).toContain("Add a rollback step");
	const children = await outlineStore.listChildren(plan.space.id, plan.root, 10);
	expect(children.at(-1)?.content).toBe("Returned (version 1): Add a rollback step");
	expect((await outlineStore.getBlock(plan.root))?.taskJson?.plan?.state).toBe("planning");
	expect(errors).toEqual([]);
	await page.close();
});

test("with feedback typed, Enter returns the plan (review round 1 S5)", async () => {
	const plan = await waitingPlan();
	const { page, errors } = await openCard(plan.permission, undefined, { keyboard: true });
	// Nothing typed: Enter would execute it as a draft.
	await until(page, "the keyboard default", (f) => f.enterTarget() === "Execute as draft");
	await call(page, (f) => f.type("[data-testid=outline-plan-feedback]", "Split step B"));
	await until(page, "Return as the default", (f) => f.enterTarget() === "Return");
	await call(page, (f) => f.blur());
	await page.keyboard.press("Enter");
	await waitFor("the return", () => plan.outcome());
	expect(plan.outcome()?.behavior).toBe("deny");
	expect(plan.outcome()?.message).toContain("Split step B");
	expect((await outlineStore.getBlock(plan.root))?.taskJson?.plan?.state).toBe("planning");
	expect(errors).toEqual([]);
	await page.close();
});
