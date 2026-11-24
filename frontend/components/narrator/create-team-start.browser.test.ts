/**
 * "Start as a team" in the new-session dialog, in Chromium, against a test server running the
 * real project, team and narrator routes on the isolated SQLite of `tests/preload.ts`:
 *
 *   - a directory in a git repository without a project: the option is on; choosing it shows
 *     the team fields, refuses an empty name, and creating makes the repository's project
 *     (owned by the user) and the team through the team route, then hands over the team;
 *   - a base branch the team route would refuse is stopped in the form, before any request
 *     (the directory's project is made before the team route runs, so it must not be made for a
 *     draft that cannot become a team);
 *   - a directory outside any git repository: the option stays visible but off, with why;
 *   - a project on a folder that is not a git checkout: off, with why;
 *   - a project the user cannot read: the same "not in a git repository" as a plain folder;
 *   - a project the user can only read: off, with why;
 *   - PostgreSQL (the lookup answers 503): off, with why — never silently missing.
 *
 * Set `TEAM_START_SHOTS` to a directory to keep screenshots.
 *
 * Run: bun test --isolate frontend/components/narrator/create-team-start.browser.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { aclGrants, narrators, projects, projectTeams, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { narratorRoutes } from "../../../server/routes/narrators";
import { projectTeamRoutes } from "../../../server/routes/project-teams";
import { projectRoutes } from "../../../server/routes/projects";
import type * as Fixture from "./create-team-start.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

const shots = process.env.TEAM_START_SHOTS;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let alice: string;
let bob: string;
const root = realpathSync(mkdtempSync(join(tmpdir(), "nf-team-start-")));

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "README.md"), "x");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

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

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./create-team-start.browser-fixture.tsx", import.meta.url).pathname],
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
			if (url.pathname.startsWith("/api/")) return app.fetch(request);
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
	alice = await person(`alice${Date.now()}`);
	bob = await person(`bob${Date.now()}`);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
	rmSync(root, { recursive: true, force: true });
});

async function openPage(as: string): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setViewport({ width: 1280, height: 900 });
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

const hint = (page: Page) => call(page, (f) => f.text("[data-testid=create-mode-hint]"));

test("a git repository without a project: start a team there", async () => {
	const repo = makeRepo("fresh");
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, cwd: string) => f.openDialog(cwd), repo);
		await until(page, "team option on", (f) => f.teamOptionEnabled() === true);
		expect(await hint(page)).toContain("start a team here");
		await shot(page, "session-mode");
		// Looking did not create anything.
		expect(await db.select().from(projects).where(eq(projects.gitPath, repo))).toHaveLength(0);

		expect(await call(page, (f) => f.chooseMode("team"))).toBe(true);
		await until(page, "team half", (f) => f.count("[data-testid=create-team-name]") === 1);
		expect(await call(page, (f) => f.text("[data-testid=team-start-status]"))).toContain(
			"one will be created for this repository",
		);
		expect(await call(page, (f) => f.count("[data-testid=team-start-submit]"))).toBe(1);
		await shot(page, "team-mode");

		await call(page, (f) => f.click("[data-testid=team-start-submit]"));
		await until(page, "name required", (f) =>
			(f.text("body") ?? "").includes("A team needs a name"),
		);
		expect(await call(page, (f) => f.createdTeams())).toEqual([]);

		// A base branch the route would refuse: stopped in the form, nothing sent, nothing made.
		const writes: string[] = [];
		const onRequest = (request: { method: () => string; url: () => string }) => {
			const path = new URL(request.url()).pathname;
			if (request.method() === "POST" && path.startsWith("/api/projects")) writes.push(path);
		};
		page.on("request", onRequest);
		await call(page, (f) => f.type("[data-testid=create-team-name]", "Fresh crew"));
		await call(page, (f) => f.type("[data-testid=create-team-base-branch]", "release target"));
		await call(page, (f) => f.click("[data-testid=team-start-submit]"));
		await until(page, "branch refused", (f) =>
			(f.text("body") ?? "").includes("Not a valid branch name"),
		);
		await shot(page, "invalid-branch");
		await new Promise((done) => setTimeout(done, 300));
		page.off("request", onRequest);
		expect(writes).toEqual([]);
		expect(await call(page, (f) => f.createdTeams())).toEqual([]);
		expect(await db.select().from(projects).where(eq(projects.gitPath, repo))).toHaveLength(0);

		await call(page, (f) => f.type("[data-testid=create-team-base-branch]", "main"));
		await call(page, (f) => f.type("[data-testid=create-team-brief]", "Keep main green."));
		await call(page, (f) => f.click("[data-testid=team-start-submit]"));
		await until(page, "created", (f) => f.createdTeams().length === 1);

		const [team] = await call(page, (f) => f.createdTeams());
		expect(team?.name).toBe("Fresh crew");
		expect(await call(page, (f) => f.closedCount())).toBe(1);
		const [project] = await db.select().from(projects).where(eq(projects.gitPath, repo));
		expect(project?.ownerUserId).toBe(alice);
		expect(team?.projectId).toBe(project?.id as string);
		const coordinator = await db.query.narrators.findFirst({
			where: eq(narrators.id, team?.id as string),
		});
		expect(coordinator?.cwd).toBe(repo);
		expect(coordinator?.traits).toContain("team");
		expect(coordinator?.title).toBe("Fresh crew");
		const row = await db.query.projectTeams.findFirst({
			where: eq(projectTeams.narratorId, team?.id as string),
		});
		expect(row?.baseBranch).toBe("main");
		expect(row?.brief).toBe("Keep main green.");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("a directory outside any git repository: the option is off and says why", async () => {
	const plain = join(root, "plain");
	mkdirSync(plain, { recursive: true });
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, cwd: string) => f.openDialog(cwd), plain);
		await until(page, "reason", (f) =>
			(f.text("[data-testid=create-mode-hint]") ?? "").includes("not in a git repository"),
		);
		expect(await call(page, (f) => f.teamOptionEnabled())).toBe(false);
		await shot(page, "not-git");
		expect(await call(page, (f) => f.count("[data-testid=create-team-name]"))).toBe(0);
		expect(await db.select().from(projects).where(eq(projects.gitPath, plain))).toHaveLength(0);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("a project on a folder that is not a git checkout: the option is off and says why", async () => {
	const folder = join(root, "associated-folder");
	mkdirSync(folder, { recursive: true });
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: generateId(),
		name: "Associated folder",
		gitPath: folder,
		ownerUserId: alice,
		visibility: "public",
		rootKey: folder,
		createdAt: now,
		updatedAt: now,
	});
	const { page, errors } = await openPage(alice);
	try {
		await call(page, (f, cwd: string) => f.openDialog(cwd), folder);
		await until(page, "reason", (f) =>
			(f.text("[data-testid=create-mode-hint]") ?? "").includes("not a git checkout"),
		);
		expect(await call(page, (f) => f.teamOptionEnabled())).toBe(false);
		await shot(page, "project-not-git");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("a project the user cannot read: told the same as a folder outside git", async () => {
	const repo = makeRepo("hidden");
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: generateId(),
		name: "Hidden",
		gitPath: repo,
		ownerUserId: alice,
		visibility: "private",
		rootKey: repo,
		createdAt: now,
		updatedAt: now,
	});
	const { page, errors } = await openPage(bob);
	try {
		await call(page, (f, cwd: string) => f.openDialog(cwd), repo);
		await until(page, "reason", (f) =>
			(f.text("[data-testid=create-mode-hint]") ?? "").includes("not in a git repository"),
		);
		expect(await call(page, (f) => f.teamOptionEnabled())).toBe(false);
		expect(await hint(page)).not.toContain("Hidden");
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("a project the user can only read: the option is off and says why", async () => {
	const repo = makeRepo("readonly");
	const projectId = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id: projectId,
		name: "Read only",
		gitPath: repo,
		ownerUserId: alice,
		visibility: "private",
		rootKey: repo,
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
	const { page, errors } = await openPage(bob);
	try {
		await call(page, (f, cwd: string) => f.openDialog(cwd), repo);
		await until(page, "reason", (f) =>
			(f.text("[data-testid=create-mode-hint]") ?? "").includes("only read the project"),
		);
		expect(await call(page, (f) => f.teamOptionEnabled())).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("PostgreSQL: the option is off and says so", async () => {
	const repo = makeRepo("postgres");
	const { page, errors } = await openPage(alice);
	try {
		await page.setRequestInterception(true);
		let refused = 0;
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/api/projects/resolve-directory") {
				refused++;
				void request.respond({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "Project teams", code: "POSTGRES_UNSUPPORTED" }),
				});
			} else void request.continue();
		});
		await call(page, (f, cwd: string) => f.openDialog(cwd), repo);
		await until(page, "reason", (f) =>
			(f.text("[data-testid=create-mode-hint]") ?? "").includes("not supported on PostgreSQL"),
		);
		expect(refused).toBeGreaterThan(0);
		expect(await call(page, (f) => f.teamOptionEnabled())).toBe(false);
		await call(page, (f) => f.setLanguage("zh-CN"));
		await until(page, "zh reason", (f) =>
			(f.text("[data-testid=create-mode-hint]") ?? "").includes("PostgreSQL 部署暂不支持团队"),
		);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);
