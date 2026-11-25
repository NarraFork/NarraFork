import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommunicationCandidates } from "@shared/narrator-communication";
import type { RuntimeSettings } from "@shared/settings-runtime";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import type { UIPreferences } from "../../lib/api/settings";
import type * as Fixture from "./recent-tabs-composer-drop.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const errors = new WeakMap<Page, string[]>();
const candidateRequests = new WeakMap<Page, Array<string | null>>();
const candidatesPath = "/api/narrators/fixture-narrator/communication/candidates";
const allowedDrops = [
	{ key: "narrator:recent-session", narratorId: "recent-session", label: "Recent session" },
	{ key: "subagent:subagent-tab-id", narratorId: "stable-subagent-id", label: "Worker session" },
	{ key: "subagent:legacy-child", narratorId: "legacy-child", label: "Legacy worker" },
];
const candidates = new Map(
	[
		...allowedDrops.map(({ narratorId, label }) => ({ narratorId, label, canConnect: true })),
		{ narratorId: "read-only-session", label: "Read-only session", canConnect: false },
	].map(({ narratorId, label, canConnect }) => [narratorId, { label, canConnect }]),
);
let heldExact: { id: string; release(): void; promise: Promise<void> } | undefined;

function holdExact(id: string) {
	const { promise, resolve } = Promise.withResolvers<void>();
	const release = () => {
		if (heldExact?.release === release) heldExact = undefined;
		resolve();
	};
	heldExact = { id, release, promise };
	return release;
}

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
			const url = new URL(request.url);
			const path = url.pathname;
			if (path === candidatesPath && request.method === "GET") {
				const id = url.searchParams.get("targetId");
				const candidate = id && candidates.get(id);
				const held = heldExact;
				if (held?.id === id) await held.promise;
				return Response.json({
					items:
						id && candidate
							? [
									{
										id,
										title: candidate.label,
										status: "idle",
										lastActivityAt: null,
										isRecent: true,
										canConnect: candidate.canConnect,
									},
								]
							: [],
					hasMore: false,
				} satisfies CommunicationCandidates);
			}
			if (path === "/api/settings/runtime") {
				return Response.json({
					revision: 1,
					agent: { defaultModel: "", summaryModel: "" },
					outline: { enabled: false },
					requestEvidence: { autoPin: "off" },
					summaryModelAvailable: false,
				} satisfies RuntimeSettings);
			}
			if (path === "/api/auth/me") {
				return Response.json({ id: "fixture-user" });
			}
			if (path === "/api/user-preferences/ui") {
				return Response.json({ appearancePreferences: {} } satisfies Partial<UIPreferences>);
			}
			if (path === "/api/narrators/fixture-narrator/panel-state") {
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
	heldExact?.release();
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
	const targets: Array<string | null> = [];
	errors.set(page, captured);
	candidateRequests.set(page, targets);
	page.on("pageerror", (error) => captured.push(String(error)));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname === candidatesPath) targets.push(url.searchParams.get("targetId"));
	});
	try {
		// Empty draft metadata is authoritative; the composer does not fetch the draft body.
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().endsWith("/fixture-narrator/panel-state") &&
					response.request().method() === "GET" &&
					response.ok(),
			),
			page.goto(server.url.origin),
		]);
		await page.waitForFunction(() => {
			const editor = document.querySelector<HTMLElement>('[role="textbox"]');
			return (
				(window as unknown as FixtureWindow).fixture?.ready() &&
				editor?.isContentEditable &&
				editor.getAttribute("aria-disabled") !== "true"
			);
		});
		return page;
	} catch (error) {
		await page.close();
		if (!captured.length) throw error;
		throw new Error(`Composer drop fixture did not initialize: ${captured.join("; ")}`, {
			cause: error,
		});
	}
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
async function overComposer(page: Page, textOffset?: number) {
	if (textOffset !== undefined) {
		const { x, y } = await page.evaluate(
			(offset) => (window as unknown as FixtureWindow).fixture.composerDropPoint(offset),
			textOffset,
		);
		await page.mouse.move(x, y, { steps: 5 });
		return;
	}
	const editor = await page.waitForSelector('[role="textbox"]');
	const box = await editor?.boundingBox();
	if (!box) throw new Error("Missing composer hit rectangle");
	await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + box.height / 2, { steps: 5 });
}
function isExact(request: HTTPRequest, id: string) {
	const url = new URL(request.url());
	return (
		request.method() === "GET" &&
		url.pathname === candidatesPath &&
		url.searchParams.get("q") === "" &&
		url.searchParams.get("targetId") === id
	);
}
async function releaseDrag(page: Page, id: string) {
	const [request] = await Promise.all([
		page.waitForRequest((request) => isExact(request, id)),
		page.mouse.up(),
	]);
	return request;
}
async function waitForNarratorReference(page: Page) {
	await page.waitForFunction(() =>
		(window as unknown as FixtureWindow).fixture
			.snapshot()
			.document?.paragraphs.some((paragraph) =>
				paragraph.children.some((node) => node.type === "narratorReference"),
			),
	);
}
async function writeDraft(page: Page) {
	await page.click('[role="textbox"]');
	await page.keyboard.type("LEFTtail");
	const state = await snapshot(page);
	expect(state.document?.paragraphs[0]?.children).toEqual([{ type: "text", text: "LEFTtail" }]);
	return state;
}
async function close(page: Page) {
	await page.close();
	expect(errors.get(page)).toEqual([]);
}

for (const { key, narratorId, label } of allowedDrops) {
	test(`real MouseSensor → RecentTabs bridge → composer inserts ${key} once`, async () => {
		const page = await open();
		try {
			await beginDrag(page, key);
			await overComposer(page);
			expect((await snapshot(page)).drag).toMatchObject({
				id: narratorId,
				subjectKind: "narrator",
			});
			await releaseDrag(page, narratorId);
			await waitForNarratorReference(page);
			const state = await snapshot(page);
			const references = state.document?.paragraphs
				.flatMap((paragraph) => paragraph.children)
				.filter((node) => node.type === "narratorReference");
			expect(references).toHaveLength(1);
			expect(references?.[0]).toMatchObject({ narratorId, label });
			expect(candidateRequests.get(page)).toEqual([narratorId]);
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

test("a readable but not connectable recent tab leaves the original draft intact", async () => {
	const page = await open();
	try {
		const initial = await writeDraft(page);
		await beginDrag(page, "narrator:read-only-session");
		await overComposer(page, 4);
		await releaseDrag(page, "read-only-session");
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).fixture
				.snapshot()
				.notices.includes("This session cannot be connected from the current session."),
		);
		const state = await snapshot(page);
		expect(state.document).toEqual(initial.document);
		expect(state.text).toBe(initial.text);
		expect(state.fallbacks).toEqual([]);
		expect(state.moves).toEqual([]);
		expect(state.nativeDrops).toBe(0);
		expect(candidateRequests.get(page)).toEqual(["read-only-session"]);
	} finally {
		await close(page);
	}
});

test("delayed exact verification inserts once at the original mouse drop point", async () => {
	const page = await open();
	const release = holdExact("recent-session");
	try {
		const initial = await writeDraft(page);
		await beginDrag(page, "narrator:recent-session");
		await overComposer(page, 4);
		await releaseDrag(page, "recent-session");
		expect((await snapshot(page)).document).toEqual(initial.document);
		release();
		await waitForNarratorReference(page);
		const state = await snapshot(page);
		expect(state.document?.paragraphs[0]?.children).toEqual([
			{ type: "text", text: "LEFT" },
			expect.objectContaining({ type: "narratorReference", narratorId: "recent-session" }),
			{ type: "text", text: " tail" },
		]);
		expect(candidateRequests.get(page)).toEqual(["recent-session"]);
	} finally {
		release();
		await close(page);
	}
});

test("changing focus cancels the pending exact drop without modifying the draft", async () => {
	const page = await open();
	const release = holdExact("recent-session");
	try {
		const initial = await writeDraft(page);
		await beginDrag(page, "narrator:recent-session");
		await overComposer(page, 4);
		const pending = await releaseDrag(page, "recent-session");
		expect((await snapshot(page)).document).toEqual(initial.document);
		// The MouseSensor's source may still have focus: click a different focusable row.
		await page.click('[data-tab-sort-id="project:project-id"]');
		// The server is still holding the response, so only cancellation can settle the request.
		await page.waitForNetworkIdle({ idleTime: 1, timeout: 2000 });
		expect(pending.failure()?.errorText).toBe("net::ERR_ABORTED");
		release();
		const state = await snapshot(page);
		expect(state.document).toEqual(initial.document);
		expect(state.notices).toEqual([]);
		expect(candidateRequests.get(page)).toEqual(["recent-session"]);
	} finally {
		release();
		await close(page);
	}
});

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
			expect(candidateRequests.get(page)).toEqual([]);
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
		expect(candidateRequests.get(page)).toEqual([]);
		expect(state.fallbacks).toEqual([]);
		expect(state.moves).toEqual([]);
		expect(state.drag).toBeNull();
		expect(state.sorting).toBe(false);
		expect(state.nativeDrops).toBe(0);
	} finally {
		await close(page);
	}
});
