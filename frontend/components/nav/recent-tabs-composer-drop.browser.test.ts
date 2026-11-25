import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./recent-tabs-composer-drop.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const errors = new WeakMap<Page, string[]>();

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("./recent-tabs-composer-drop.browser-fixture.tsx", import.meta.url)),
		],
		target: "browser",
		format: "esm",
		define: {
			"process.env.NODE_ENV": '"production"',
			"import.meta.env": '{"DEV":false,"PROD":true}',
		},
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || !styles.length) throw new Error("Composer fixture assets missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/panel-state")) {
				return Response.json({
					permissions: [],
					buffer: [],
					draft: { hasDraft: false, revision: 1, updatedAt: null },
					hasMore: { permissions: false, buffer: false },
				});
			}
			if (path.endsWith("/draft")) {
				const body = request.method === "PUT" ? await request.json() : {};
				return Response.json({
					hasDraft: false,
					text: "",
					fileReferences: [],
					revision: 1,
					updatedAt: null,
					updatedBy: null,
					sourceId: null,
					...body,
					ok: true,
				});
			}
			if (path.startsWith("/api/")) return Response.json([]);
			if (path === "/") {
				return new Response(
					`<!doctype html><html><head>
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					<style>html,body{height:100%;margin:0}body{display:grid;grid-template-columns:200px minmax(0,1fr)}</style>
					</head><body><div id="sidebar"></div><div id="root"></div>
					<script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			}
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
}, 60_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

async function open() {
	if (!browser || !server) throw new Error("Drop fixture unavailable");
	const page = await browser.newPage();
	page.setDefaultTimeout(5000);
	await page.setViewport({ width: 1000, height: 700 });
	const captured: string[] = [];
	errors.set(page, captured);
	page.on("pageerror", (error) => captured.push(String(error)));
	const hydrated = page.waitForResponse(
		(response) =>
			response.url().endsWith("/draft") && response.request().method() === "GET" && response.ok(),
	);
	await page.goto(server.url.origin);
	await hydrated;
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	return page;
}
async function snapshot(page: Page) {
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
}
async function beginDrag(page: Page, key: string) {
	const row = await page.waitForSelector(`[data-tab-sort-id="${key}"]`);
	const box = await row?.boundingBox();
	if (!box) throw new Error(`Missing drag source ${key}`);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 10, y, { steps: 3 });
	expect((await snapshot(page)).sorting).toBe(true);
	return { x: x + 10, y };
}
async function overComposer(page: Page) {
	const editor = await page.waitForSelector('[role="textbox"]');
	const box = await editor?.boundingBox();
	if (!box) throw new Error("Missing composer hit rectangle");
	await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + box.height / 2, { steps: 5 });
}
async function close(page: Page) {
	await page.close();
	expect(errors.get(page)).toEqual([]);
}

for (const { key, narratorId, label } of [
	{ key: "narrator:recent-session", narratorId: "recent-session", label: "Recent session" },
	{ key: "subagent:subagent-tab-id", narratorId: "stable-subagent-id", label: "Worker session" },
	{ key: "subagent:legacy-child", narratorId: "legacy-child", label: "Legacy worker" },
]) {
	test(`real MouseSensor → RecentTabs bridge → composer inserts ${key} once`, async () => {
		const page = await open();
		try {
			await beginDrag(page, key);
			await overComposer(page);
			expect((await snapshot(page)).drag).toMatchObject({
				id: narratorId,
				subjectKind: "narrator",
			});
			await page.mouse.up();
			await page.waitForFunction(() =>
				(window as unknown as FixtureWindow).fixture
					.snapshot()
					.document?.paragraphs.some((paragraph) =>
						paragraph.children.some((node) => node.type === "narratorReference"),
					),
			);
			const state = await snapshot(page);
			const references = state.document?.paragraphs
				.flatMap((paragraph) => paragraph.children)
				.filter((node) => node.type === "narratorReference");
			expect(references).toHaveLength(1);
			expect(references?.[0]).toMatchObject({ narratorId, label });
			expect(state.fallbacks).toEqual([]);
			expect(state.moves).toEqual([]);
			expect(state.drag).toBeNull();
			expect(state.sorting).toBe(false);
			expect(state.nativeDrops).toBe(0);
		} finally {
			await close(page);
		}
	});
}

for (const key of ["project:project-id", "folder:folder-id"]) {
	test(`real ${key} drag never becomes a composer narrator reference`, async () => {
		const page = await open();
		try {
			const initial = await snapshot(page);
			await beginDrag(page, key);
			await overComposer(page);
			expect((await snapshot(page)).drag).toBeNull();
			await page.mouse.up();
			const state = await snapshot(page);
			expect(state.document).toEqual(initial.document);
			expect(state.text).toBe(initial.text);
			expect(state.fallbacks).toEqual([]);
			expect(state.moves).toEqual([]);
			expect(state.sorting).toBe(false);
			expect(state.nativeDrops).toBe(0);
		} finally {
			await close(page);
		}
	});
}

test("real in-sidebar no-op release cannot reach the composer or dock fallback", async () => {
	const page = await open();
	try {
		const initial = await snapshot(page);
		await beginDrag(page, "narrator:recent-session");
		await page.mouse.up();
		const state = await snapshot(page);
		expect(state.document).toEqual(initial.document);
		expect(state.text).toBe(initial.text);
		expect(state.fallbacks).toEqual([]);
		expect(state.moves).toEqual([]);
		expect(state.drag).toBeNull();
		expect(state.sorting).toBe(false);
		expect(state.nativeDrops).toBe(0);
	} finally {
		await close(page);
	}
});
