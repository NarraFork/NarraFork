/**
 * Set-up of the mind map's browser tests (plan §10.2 in the product): a test server running the
 * real outline routes (`/api/outline`, view state included) and the real live sessions behind a
 * WebSocket, the fixture bundle (`outline-mindmap.browser-fixture.tsx`) with the node-measuring
 * Worker built beside it (served where `new URL("./measure.worker.ts", import.meta.url)` points),
 * and headless Chromium (puppeteer-core; `NF_TEST_CHROMIUM_PATH`).
 *
 * People: Alice (owner) opens the outline surface in a host (`page` or `panel`); Bob (writer)
 * opens the bare live editor. Seeding, waiting and the IME go through the live editor's harness.
 *
 * Named as a browser fixture so `vlist-isolation.guard.test.ts` treats it as test-only.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { db } from "../../../server/db";
import { aclGrants, projects, users } from "../../../server/db/schema";
import { AppError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { outlineRoutes } from "../../../server/routes/outline";
import { closeAllLiveSessions } from "../../../server/services/outline/live/registry";
import { OUTLINE_LIVE_TIMING } from "../../../server/services/outline/live/session";
import { ensureProjectSpace } from "../../../server/services/outline/spaces";
import type { OutlineSpaceRow } from "../../../server/services/outline/store/port";
import {
	drainOutlineLive,
	handleOutlineLiveBinary,
	type OutlineLiveWS,
	releaseOutlineLive,
} from "../../../server/websocket/outline-live-ws";
import type * as EditorFixture from "./editor/OutlineEditor.browser-fixture";
import type { Editor, Harness } from "./editor/outline-live-harness.browser-fixture";
import type * as Fixture from "./outline-mindmap.browser-fixture";

export type MapFixture = typeof Fixture;
type FixtureWindow = Window & { fixture: MapFixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-10-27T00:00:00.000Z";

export type Host = "page" | "panel";

export interface MapHarness extends Harness {
	/** Pages opened by this harness, closed by `resetMap`. */
	mapPages: Page[];
}

/** A person's page with the fixture, in the shape the live editor's helpers take. */
export interface MapEditor extends Omit<Editor, "call"> {
	errors: string[];
	host: Host | "editor";
	/**
	 * The map fixture: it has the live editor fixture's helpers that `settle` and the IME harness
	 * call (typed as both, so the editor's helpers take this editor).
	 */
	call<T>(
		fn: (fixture: MapFixture & typeof EditorFixture, ...args: never[]) => T | Promise<T>,
		...args: unknown[]
	): Promise<T>;
}

const names = new Map<string, string>();

async function user(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	names.set(id, label);
	return id;
}

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
	app.route("/api/outline", outlineRoutes);
	return app;
}

export async function startMapHarness(): Promise<MapHarness> {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const here = (path: string) => new URL(path, import.meta.url).pathname;
	const bundle = await Bun.build({
		entrypoints: [here("./outline-mindmap.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const worker = await Bun.build({
		entrypoints: [here("./mindmap/measure.worker.ts")],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!worker.success) throw new Error(worker.logs.join("\n"));
	const workerJs = worker.outputs.find((o) => o.kind === "entry-point");
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry || !workerJs) throw new Error("fixture bundle missing");
	const script = `/${basename(entry.path)}`;
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const app = api();
	const html = `<!doctype html><html><head><meta charset="utf-8"><base href="/"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0;height:100%}#root{height:100%}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`;
	const server = Bun.serve<{ userId: string; username: string; userRole: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/live") {
				const userId = url.searchParams.get("user") ?? "";
				if (
					srv.upgrade(request, {
						data: { userId, username: names.get(userId) ?? userId, userRole: "user" },
					})
				)
					return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname.startsWith("/api/")) {
				settings.outline.enabled = true;
				return app.fetch(request);
			}
			if (url.pathname.endsWith("/measure.worker.ts"))
				return new Response(workerJs, { headers: { "content-type": "text/javascript" } });
			const asset = assets.get(url.pathname);
			if (asset) return new Response(asset);
			// Every other path is the app (the outline page's route reads the URL).
			return new Response(html, { headers: { "content-type": "text/html" } });
		},
		websocket: {
			message(ws, message) {
				if (typeof message === "string") return;
				const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
				handleOutlineLiveBinary(ws as unknown as OutlineLiveWS, bytes);
			},
			drain(ws) {
				drainOutlineLive(ws as unknown as OutlineLiveWS);
			},
			close(ws) {
				releaseOutlineLive(ws as unknown as OutlineLiveWS);
			},
		},
	});
	const browser: Browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
	const owner = await user("alice");
	const writer = await user("bob");
	const reader = await user("carol");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Mind map",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const [principalId, capability] of [
		[writer, "write"],
		[reader, "read"],
	] as const) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId,
			capability,
			createdAt: NOW,
		});
	}
	const space: OutlineSpaceRow = await ensureProjectSpace(projectId);
	Object.assign(OUTLINE_LIVE_TIMING, { flushIdleMs: 150, flushMaxMs: 600, persistMs: 50 });
	return {
		browser,
		server,
		space,
		owner,
		writer,
		reader,
		pages: [],
		contexts: [],
		mapPages: [],
	};
}

export async function stopMapHarness(h: MapHarness | undefined): Promise<void> {
	if (!h) return;
	try {
		await closeAllLiveSessions("ended");
		await h.browser.close();
	} finally {
		h.server.stop(true);
	}
}

export async function resetMap(h: MapHarness): Promise<void> {
	for (const page of h.pages.splice(0)) await page.close().catch(() => {});
	for (const context of h.contexts.splice(0)) await context.close().catch(() => {});
	h.mapPages.length = 0;
	await closeAllLiveSessions("ended");
}

async function newPage(
	h: MapHarness,
	userId: string,
	options: { width?: number; height?: number; touch?: boolean },
): Promise<{ page: Page; errors: string[]; context: BrowserContext }> {
	const context = await h.browser.createBrowserContext();
	h.contexts.push(context);
	const page = await context.newPage();
	h.pages.push(page);
	await page.setViewport({
		width: options.width ?? 1280,
		height: options.height ?? 860,
		hasTouch: options.touch ?? false,
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(`${h.server.url.origin}/`);
	await page.evaluate((token) => localStorage.setItem("narrafork_token", token), userId);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	return { page, errors, context };
}

function editorOf(
	page: Page,
	userId: string,
	errors: string[],
	host: MapEditor["host"],
): MapEditor {
	return {
		page,
		userId,
		errors,
		host,
		call: (fn, ...args) =>
			page.evaluate(
				`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`,
			) as Promise<never>,
	};
}

/** Alice opens a place of the space in a host of the outline surface. */
export async function openHost(
	h: MapHarness,
	host: Host,
	blockId: string,
	options: {
		width?: number;
		height?: number;
		touch?: boolean;
		userId?: string;
		lens?: "facts" | "all";
		/** No measuring Worker (node sizes measured on the spot). */
		noWorker?: boolean;
	} = {},
): Promise<MapEditor> {
	const userId = options.userId ?? h.owner;
	const { page, errors } = await newPage(h, userId, options);
	const wsUrl = `${h.server.url.origin.replace("http", "ws")}/live?user=${encodeURIComponent(userId)}`;
	if (options.noWorker)
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.disableWorker());
	await page.evaluate((o) => (window as unknown as FixtureWindow).fixture.open(o), {
		wsUrl,
		host,
		spaceId: h.space.id,
		blockId,
		lens: options.lens ?? "all",
	});
	if (host === "panel") {
		await page.waitForFunction(
			(s, b) => (window as unknown as FixtureWindow).fixture.openPanel(s, b),
			{ timeout: 10_000, polling: 50 },
			h.space.id,
			blockId,
		);
	}
	const editor = editorOf(page, userId, errors, host);
	await waitLive(editor);
	h.mapPages.push(page);
	return editor;
}

/** Bob opens the bare live editor of a page. */
export async function openBob(h: MapHarness, pageId: string): Promise<MapEditor> {
	const { page, errors } = await newPage(h, h.writer, {});
	const wsUrl = `${h.server.url.origin.replace("http", "ws")}/live?user=${encodeURIComponent(h.writer)}`;
	await page.evaluate((o) => (window as unknown as FixtureWindow).fixture.openEditor(o), {
		wsUrl,
		pageId,
		spaceKey: h.space.key,
		canWrite: true,
	});
	const editor = editorOf(page, h.writer, errors, "editor");
	await page.waitForFunction(
		() => {
			try {
				const c = (window as unknown as FixtureWindow).fixture.client();
				return c.ready && c.status === "live";
			} catch {
				return false;
			}
		},
		{ timeout: 10_000, polling: 25 },
	);
	return editor;
}

async function waitLive(editor: MapEditor): Promise<void> {
	try {
		await editor.page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.hasSurface(),
			{ timeout: 15_000, polling: 25 },
		);
	} catch (error) {
		const text = await editor.page
			.evaluate(() => document.body.innerText.slice(0, 1200))
			.catch(() => "page gone");
		throw new Error(
			`surface did not go live: ${text} ${editor.errors.join("; ")}: ${String(error)}`,
		);
	}
}

/** Wait until the surface's transitions are over. */
export async function settled(editor: MapEditor, timeoutMs = 5000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (!(await editor.call((f) => f.animating()))) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error("the transition did not end");
}

export const pct = (a: number[], p: number): number | null => {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	return +(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number).toFixed(2);
};

export const summary = (a: number[]) => ({
	n: a.length,
	p50: pct(a, 50),
	p95: pct(a, 95),
	max: pct(a, 100),
});
