import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackgroundTaskListItem, BackgroundTaskListPage } from "@shared/background-task-list";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./background-task-list.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const responses = new Map<string, BackgroundTaskListPage>();
const requests: { narratorId: string; cursor: string | null }[] = [];

function item(overrides: Partial<BackgroundTaskListItem> = {}): BackgroundTaskListItem {
	return {
		id: "agent",
		type: "agent",
		backgroundKind: "task",
		status: "completed",
		effectiveStatus: "continued",
		currentNarratorStatus: "working",
		activeChildTaskCount: 0,
		canCancelActiveWork: true,
		command: null,
		exitCode: null,
		toolUseId: null,
		subagentNarratorId: "child",
		subagentType: "general",
		alias: null,
		title: "Background agent",
		output: null,
		outputBytes: 0,
		outputTruncated: false,
		outputPreviewTruncated: false,
		startedAt: "2026-01-01T00:00:00Z",
		completedAt: "2026-01-01T00:01:00Z",
		createdAt: "2026-01-01T00:00:00Z",
		legacy: false,
		...overrides,
	};
}
function firstPage(overrides: Partial<BackgroundTaskListPage> = {}): BackgroundTaskListPage {
	return {
		listEpoch: "epoch-a",
		version: 1,
		activeCount: 1,
		activeWorkCount: 1,
		activeServiceCount: 0,
		activeTasks: [item()],
		activeTruncated: false,
		tasks: [item()],
		nextCursor: "older",
		...overrides,
	};
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const fixturePath = fileURLToPath(
		new URL("./background-task-list.browser-fixture.tsx", import.meta.url),
	);
	const bundle = await Bun.build({
		entrypoints: [fixturePath],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "controlled-list-websocket-transport",
				setup(builder) {
					builder.onResolve({ filter: /lib\/narrator-ws-manager$/ }, () => ({
						path: "controlled-ws",
						namespace: "list-fixture",
					}));
					builder.onLoad({ filter: /.*/, namespace: "list-fixture" }, () => ({
						contents: `export { controlledWS as narratorWSManager } from ${JSON.stringify(fixturePath)};`,
						loader: "js",
						resolveDir: import.meta.dir,
					}));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	if (!script) throw new Error("Hook bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/") {
				return new Response(
					`<!doctype html><html><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			}
			const match = /^\/api\/narrators\/([^/]+)\/background-tasks$/.exec(url.pathname);
			if (match) {
				const narratorId = match[1];
				const cursor = url.searchParams.get("cursor");
				requests.push({ narratorId, cursor });
				const response = responses.get(narratorId);
				if (!response) return new Response("Unknown test narrator", { status: 404 });
				return Response.json(
					cursor
						? {
								...response,
								tasks: [
									item({ id: "old", effectiveStatus: "completed", canCancelActiveWork: false }),
								],
								activeTasks: undefined,
								nextCursor: null,
							}
						: response,
				);
			}
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		env:
			process.platform === "win32" && process.env.NARRAFORK_ORIGINAL_HOME
				? { ...process.env, USERPROFILE: process.env.NARRAFORK_ORIGINAL_HOME }
				: process.env,
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

async function snapshot(page: Page) {
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
}
async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
async function loaded(page: Page, version = 1, pages = 1) {
	await page.waitForFunction(
		({ version, pages }) => {
			const state = (window as unknown as FixtureWindow).fixture.snapshot();
			return (
				!state.isLoading &&
				state.isFetching === 0 &&
				state.version === version &&
				state.pages === pages
			);
		},
		{},
		{ version, pages },
	);
	await settle(page);
}
async function start(narratorId: string, run: (page: Page) => Promise<void>) {
	if (!browser || !server) throw new Error("Fixture unavailable");
	responses.set(narratorId, firstPage());
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	try {
		await page.goto(server.url.origin, { waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
		await page.evaluate((id) => (window as unknown as FixtureWindow).fixture.start(id), narratorId);
		await loaded(page);
		await run(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.unmount());
		expect(await snapshot(page)).toMatchObject({ subscriptions: 0, connections: 0, listeners: [] });
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}
function reads(narratorId: string) {
	return requests.filter((request) => request.narratorId === narratorId);
}

// A real >5s browser window catches the removed fallback, including when loaded
// history pages exist. No fake reducer/QueryClient or source-string assertions.
test("subagent reasoning/reflecting/status noise never refetches or discards loaded pages", async () => {
	const id = "noise";
	await start(id, async (page) => {
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fetchNextPage());
		await loaded(page, 1, 2);
		expect(reads(id).map((request) => request.cursor)).toEqual([null, "older"]);
		await page.evaluate(async () => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			for (let index = 0; index < 40; index++) {
				fixture.emit({
					type: "subagent_status_changed",
					subagentNarratorId: "child",
					status: index % 2 ? "waiting" : "working",
					substatus: index % 2 ? "reflecting" : "reasoning",
				});
			}
			await new Promise((resolve) => setTimeout(resolve, 6_200));
		});
		await settle(page);
		expect(reads(id)).toHaveLength(2);
		expect(await snapshot(page)).toMatchObject({
			pages: 2,
			version: 1,
			listeners: [["background_task_list_delta", "background_task_progress"]],
		});
	});
}, 15_000);

test("precise delta and progress update production cache without GET", async () => {
	const id = "delta";
	await start(id, async (page) => {
		const service = item({
			backgroundKind: "service",
			effectiveStatus: "child_running",
			activeChildTaskCount: 2,
		});
		await page.evaluate((upsert) => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.emit({
				type: "background_task_list_delta",
				listEpoch: "epoch-a",
				version: 2,
				activeCount: 1,
				activeWorkCount: 0,
				activeServiceCount: 1,
				upsert,
			});
			fixture.emit({
				type: "background_task_progress",
				listEpoch: "epoch-a",
				taskId: "agent",
				progress: { completed: 42, total: 100 },
			});
		}, service);
		await loaded(page, 2);
		expect(await snapshot(page)).toMatchObject({
			activeCount: 1,
			activeWorkCount: 0,
			activeServiceCount: 1,
			tasks: [
				{
					effectiveStatus: "child_running",
					activeChildTaskCount: 2,
					progress: { completed: 42, total: 100 },
				},
			],
		});
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.emit({
				type: "background_task_progress",
				listEpoch: "wrong-epoch",
				taskId: "agent",
				progress: { completed: 99 },
			});
		});
		await settle(page);
		expect((await snapshot(page)).tasks[0]?.progress?.completed).toBe(42);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.emit({
				type: "background_task_list_delta",
				listEpoch: "epoch-a",
				version: 3,
				activeCount: 0,
				activeWorkCount: 0,
				activeServiceCount: 0,
				removeIds: ["agent"],
			}),
		);
		await loaded(page, 3);
		expect((await snapshot(page)).tasks).toEqual([]);
		expect(reads(id)).toHaveLength(1);
	});
}, 15_000);

for (const reason of ["invalidate", "gap", "epoch", "reconnect", "refresh"] as const) {
	test(`${reason} still recovers once from page zero`, async () => {
		const id = `recover-${reason}`;
		await start(id, async (page) => {
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fetchNextPage());
			await loaded(page, 1, 2);
			const version = reason === "gap" ? 4 : 2;
			const listEpoch = reason === "epoch" ? "epoch-b" : "epoch-a";
			const task = item({ effectiveStatus: "child_running", activeChildTaskCount: 3 });
			responses.set(id, firstPage({ version, listEpoch, tasks: [task], activeTasks: [task] }));
			await page.evaluate(
				({ reason, version, listEpoch }) => {
					const fixture = (window as unknown as FixtureWindow).fixture;
					if (reason === "reconnect") {
						fixture.connection(false);
						fixture.connection(true, true);
					} else if (reason === "refresh") fixture.refresh();
					else
						fixture.emit({
							type: "background_task_list_delta",
							listEpoch,
							version,
							activeCount: 1,
							invalidate: reason === "invalidate",
						});
				},
				{ reason, version, listEpoch },
			);
			await loaded(page, version);
			expect(reads(id).map((request) => request.cursor)).toEqual([null, "older", null]);
			expect(await snapshot(page)).toMatchObject({
				listEpoch,
				pages: 1,
				tasks: [{ effectiveStatus: "child_running", activeChildTaskCount: 3 }],
			});
		});
	}, 15_000);
}
