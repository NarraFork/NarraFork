import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackgroundTaskListItem } from "@shared/background-task-list";
import type { RuntimeSettings } from "@shared/settings-runtime";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import type { UIPreferences } from "../../lib/api/settings";
import type * as Fixture from "./narrator-polling.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// These are HTTP arrivals at the exclusive server, never counts from an API mock.
const requests: string[] = [];
const unexpected: string[] = [];
let devices = 0;
let phase = "off";
let status = "working";
const runtimeSettings: RuntimeSettings = {
	revision: 1,
	agent: { defaultModel: "fixture-model", summaryModel: "fixture-model" },
	outline: { enabled: false },
	requestEvidence: { autoPin: "off" },
	summaryModelAvailable: null,
};
const uiPreferences: UIPreferences = {
	autoLoadOlderMessages: false,
	fastModeDefault: false,
	treatAsLocalAccess: false,
	language: "en",
	wordWrapMarkdown: true,
	wordWrapCode: false,
	wordWrapDiff: false,
	replyInUserLanguage: false,
	showTokenUsage: false,
	showOutputStats: false,
	compactAuxiliaryContent: false,
	appearancePreferences: {},
	terminalTheme: "default",
	terminalFontSize: 14,
	narratorFontScalePercent: 100,
	narratorLetterSpacingPercent: 0,
	narratorLineHeightV2Percent: 100,
	narratorParagraphScalePercent: 100,
	recentTabsShowDirectory: true,
	addSubagentToRecentTabs: true,
	recentTabsGroupMode: "flat",
	notifyOnDone: false,
	notifyOnWaiting: false,
	notifyPwaEnabled: false,
	notifySoundEnabled: false,
	notifySoundType: "builtin",
	notifySoundBuiltin: "default",
	notifySoundFileId: null,
	notifySoundVolume: 0.5,
	notifySoundMaxConcurrent: 1,
	notifyDingtalkEnabled: false,
	notifyFeishuEnabled: false,
	enterQueueMode: "turn",
	ctrlEnterQueueMode: "interrupt",
	setupWizardCompleted: true,
	navLayout: { items: [] },
	narratorToolbarLayout: { items: [] },
	hiddenPluginOverlays: [],
	gitIdentityContextMenu: false,
	gitIdentityCreateModal: false,
	gitIdentityFolderContextMenu: false,
};
const task: BackgroundTaskListItem = {
	id: "agent-task",
	type: "agent",
	backgroundKind: "task",
	status: "running",
	effectiveStatus: "running",
	currentNarratorStatus: "working",
	activeChildTaskCount: 0,
	canCancelActiveWork: true,
	command: null,
	exitCode: null,
	toolUseId: null,
	subagentNarratorId: "child",
	subagentType: "general",
	alias: null,
	title: "Active background agent",
	output: null,
	outputBytes: 0,
	outputTruncated: false,
	outputPreviewTruncated: false,
	startedAt: "2026-01-01T00:00:00Z",
	completedAt: null,
	createdAt: "2026-01-01T00:00:00Z",
	legacy: false,
};

beforeAll(async () => {
	if (!existsSync(executablePath))
		throw new Error(`Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`);
	const fixturePath = fileURLToPath(
		new URL("./narrator-polling.browser-fixture.tsx", import.meta.url),
	);
	const wsPath = fileURLToPath(
		new URL("./narrator-polling.browser-ws-fixture.ts", import.meta.url),
	);
	const bundle = await Bun.build({
		entrypoints: [fixturePath],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "polling-fixture-websocket-only",
				setup(builder) {
					builder.onResolve({ filter: /lib\/narrator-ws-manager$/ }, () => ({ path: wsPath }));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	if (!script) throw new Error("Browser fixture has no script");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			const asset = assets.get(path);
			if (asset) return new Response(asset);
			requests.push(`${request.method} ${path}`);
			if (
				request.method === "GET" &&
				request.headers.get("authorization") === "Bearer narrator-polling-fixture-token"
			) {
				if (path === "/api/auth/me")
					return Response.json({ id: "polling-fixture-user", username: "Fixture", role: "user" });
				if (path === "/api/settings/runtime") return Response.json(runtimeSettings);
				if (path === "/api/user-preferences/ui") return Response.json(uiPreferences);
				if (path === "/api/narrators/fixture/execution-devices")
					return Response.json({
						devices: Array.from({ length: devices }, (_, i) => ({ id: `device-${i}` })),
					});
				if (path === "/api/system/unattended")
					return Response.json({
						enabled: phase !== "off",
						phase,
						options: { powerOff: false },
						blockers: {},
						blocked: false,
						shutdownAt: null,
					});
				if (path === "/api/narrators/fixture/background-tasks")
					return Response.json({
						listEpoch: "fixture-epoch",
						version: 1,
						activeCount: 1,
						activeTasks: [task],
						activeTruncated: false,
						tasks: [task],
						nextCursor: null,
					});
				if (path === "/api/narrators/fixture")
					return Response.json({ id: "fixture", status, substatus: [], title: "Polling fixture" });
				if (path === "/api/narrators/fixture/panel-state")
					return Response.json({
						permissions: [],
						buffer: [],
						draft: { hasDraft: false, revision: 0, updatedAt: null },
						hasMore: { permissions: false, buffer: false },
					});
				if (path === "/api/narrators/fixture/inbox/agent-messages")
					return Response.json({
						running: status === "working" || status === "waiting",
						blockedReason: null,
						hasMore: false,
						messages: [
							{
								id: "inbox-message",
								preview: "Fixture queued message",
								truncated: false,
								sender: { id: "child", label: "Child" },
							},
						],
					});
			}
			unexpected.push(`${request.method} ${path}`);
			return new Response("Unexpected fixture request", { status: 404 });
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

function counts() {
	return Object.fromEntries(
		[...new Set(requests)]
			.sort()
			.map((path) => [path, requests.filter((item) => item === path).length]),
	);
}
const requestDrains = new WeakMap<Page, () => Promise<void>>();
function observeNetwork(page: Page, origin: string) {
	const errors: string[] = [];
	const network: string[] = [];
	const finished: string[] = [];
	const failed: Array<{ request: string; error: string | undefined }> = [];
	const cached: string[] = [];
	const outside: string[] = [];
	const pending = new Map<HTTPRequest, ReturnType<typeof Promise.withResolvers<void>>>();
	const key = (request: HTTPRequest) => `${request.method()} ${new URL(request.url()).pathname}`;
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.origin !== origin) outside.push(url.href);
		if (url.pathname.startsWith("/api/")) {
			network.push(key(request));
			pending.set(request, Promise.withResolvers<void>());
		}
	});
	const complete = (request: HTTPRequest, didFail: boolean) => {
		if (!new URL(request.url()).pathname.startsWith("/api/")) return;
		const completion = pending.get(request);
		if (!completion) {
			errors.push(`Request terminal event without a start: ${key(request)}`);
			return;
		}
		if (didFail) failed.push({ request: key(request), error: request.failure()?.errorText });
		else finished.push(key(request));
		pending.delete(request);
		completion.resolve();
	};
	page.on("requestfinished", (request) => complete(request, false));
	page.on("requestfailed", (request) => complete(request, true));
	page.on("requestservedfromcache", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/")) cached.push(key(request));
	});
	const drain = async () => {
		if (!pending.size) return;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					while (pending.size)
						await Promise.all([...pending.values()].map(({ promise }) => promise));
				})(),
				new Promise<never>((_, reject) => {
					deadline = setTimeout(
						() => reject(new Error("Browser API requests did not finish")),
						5_000,
					);
				}),
			]);
		} finally {
			clearTimeout(deadline);
		}
	};
	requestDrains.set(page, drain);
	return { network, finished, failed, cached, outside, errors, drain };
}

function assertCrossPlaneTraffic(traffic: ReturnType<typeof observeNetwork>, arrivals: string[]) {
	const { network, finished, failed, cached } = traffic;
	expect([...network].sort()).toEqual(
		[...finished, ...failed.map(({ request }) => request)].sort(),
	);
	expect(cached).toEqual([]);
	expect(failed.filter(({ error }) => error !== "net::ERR_ABORTED")).toEqual([]);
	// CDP counts logical requests, not wire attempts: Chromium can transparently
	// retry a GET on a closed keep-alive connection. An aborted read may never
	// reach the server. Keep exact endpoint coverage and require every completed,
	// non-cached GET to have a real arrival; do not equate those two multisets.
	expect([...new Set(network)].sort()).toEqual([...new Set(arrivals)].sort());
	for (const request of new Set(finished))
		expect(arrivals.filter((arrival) => arrival === request).length).toBeGreaterThanOrEqual(
			finished.filter((completed) => completed === request).length,
		);
}

async function openPage() {
	if (!server || !browser) throw new Error("Browser fixture not initialized");
	requests.length = 0;
	unexpected.length = 0;
	devices = 0;
	phase = "off";
	status = "working";
	const page = await browser.newPage();
	await page.setCacheEnabled(false);
	const traffic = observeNetwork(page, server.url.origin);
	await page.goto(server.url.origin, { waitUntil: "networkidle0", timeout: 30_000 });
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.start("fixture"));
	await page.waitForSelector('[data-ready="true"]');
	await settle(page);
	return { page, ...traffic };
}
async function settle(page: Page) {
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settle());
	// Query cancellation can settle before the real transport's aborted/completed
	// events arrive. Drain those existing events, not an additional fixed sleep.
	await requestDrains.get(page)?.();
}
async function emit(page: Page, frame: Record<string, unknown>) {
	await page.evaluate(
		(data) => (window as unknown as FixtureWindow).fixture.emit({ narratorId: "fixture", ...data }),
		frame,
	);
}

test("Chromium transparently retries a keep-alive GET without another logical request", async () => {
	if (!browser) throw new Error("Browser fixture not initialized");
	const arrivals: string[] = [];
	const ports: Array<number | undefined> = [];
	const sockets = new Set<Socket>();
	const tcp = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffered = "";
		socket.on("data", (data) => {
			buffered += data.toString();
			if (buffered.length > 8192) return socket.destroy();
			while (buffered.includes("\r\n\r\n")) {
				const end = buffered.indexOf("\r\n\r\n");
				const [line] = buffered.slice(0, end).split("\r\n");
				buffered = buffered.slice(end + 4);
				const [method, path] = line.split(" ");
				if (path.startsWith("/api/")) {
					arrivals.push(`${method} ${path}`);
					ports.push(socket.remotePort);
					// Close a reused connection after receiving GET but before headers.
					// Chromium retries this idempotent request below the CDP start layer.
					if (arrivals.length === 2) return socket.destroy();
				}
				const body = path === "/" ? "<!doctype html><body>retry fixture</body>" : "{}";
				socket.write(
					`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: ${path === "/" ? "text/html" : "application/json"}\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n${body}`,
				);
			}
		});
	});
	await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
	let page: Page | undefined;
	try {
		const address = tcp.address();
		if (!address || typeof address === "string") throw new Error("Missing retry fixture address");
		const origin = `http://127.0.0.1:${address.port}`;
		page = await browser.newPage();
		await page.setCacheEnabled(false);
		const traffic = observeNetwork(page, origin);
		await page.goto(origin, { waitUntil: "networkidle0", timeout: 5_000 });
		const values = await page.evaluate(async () => {
			const values: string[] = [];
			for (let i = 0; i < 2; i++)
				values.push(
					await (
						await fetch("/api/system/unattended", { signal: AbortSignal.timeout(5_000) })
					).text(),
				);
			return values;
		});
		await traffic.drain();
		expect(values).toEqual(["{}", "{}"]);
		expect(traffic.network).toHaveLength(2);
		expect(traffic.finished).toHaveLength(2);
		expect(traffic.failed).toEqual([]);
		expect(arrivals).toHaveLength(3);
		expect(ports[1]).not.toBe(ports[2]);
		assertCrossPlaneTraffic(traffic, arrivals);
		expect(traffic.errors).toEqual([]);
		expect(traffic.outside).toEqual([]);
		console.info("polling keep-alive retry evidence", {
			logicalStarts: traffic.network.length,
			finished: traffic.finished.length,
			wireArrivals: arrivals.length,
		});
	} finally {
		try {
			await page?.close();
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				tcp.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}
}, 15_000);

// No production hook is mocked: this includes the real panel subscription, detail
// observer, actual inbox component and two device/global observers sharing a cache.
test("online narrator has no API polling across 120s of interval time and status/reasoning noise", async () => {
	const traffic = await openPage();
	const { page, errors, network, outside } = traffic;
	try {
		const baseline = counts();
		const browserBaseline = [...network];
		expect(Object.keys(baseline).sort()).toEqual([
			"GET /api/auth/me",
			"GET /api/narrators/fixture",
			"GET /api/narrators/fixture/background-tasks",
			"GET /api/narrators/fixture/execution-devices",
			"GET /api/narrators/fixture/inbox/agent-messages",
			"GET /api/narrators/fixture/panel-state",
			"GET /api/settings/runtime",
			"GET /api/system/unattended",
			"GET /api/user-preferences/ui",
		]);
		for (const count of Object.values(baseline)) expect(count).toBeGreaterThan(0);
		const report = await page.evaluate(async () => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			for (let batch = 0; batch < 12; batch++) {
				for (let i = 0; i < 40; i++) {
					fixture.emit({
						type: "status_change",
						narratorId: "fixture",
						status: i % 2 ? "working" : "waiting",
					});
					fixture.emit({
						type: "subagent_status_changed",
						narratorId: "fixture",
						subagentNarratorId: "child",
						status: i % 2 ? "working" : "waiting",
					});
					fixture.emit({
						type: "status_change",
						narratorId: "fixture",
						status: i % 2 ? "working" : "waiting",
					});
					fixture.emit({ type: "reasoning", narratorId: "fixture", text: "Reasoning noise" });
					fixture.emit({ type: "status_change", narratorId: "another-narrator", status: "idle" });
				}
				await fixture.advanceIntervals(10_000);
			}
			return fixture.snapshot();
		});
		await settle(page);
		expect(report.clock).toBe(120_000);
		expect(report.canaries).toEqual({ fiveSeconds: 24, sixtySeconds: 2 });
		expect(counts()).toEqual(baseline);
		expect(network).toEqual(browserBaseline);
		assertCrossPlaneTraffic(traffic, requests);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(outside).toEqual([]);
		console.info(
			"polling browser stable 120s HTTP counts:",
			baseline,
			"canaries:",
			report.canaries,
			"browser:",
			{ starts: network.length, finished: traffic.finished.length, failed: traffic.failed },
		);
	} finally {
		try {
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.cleanup());
		} finally {
			await page.close();
		}
	}
}, 30_000);

test("real control-plane changes, reconnect and foreground trigger bounded HTTP reads", async () => {
	const traffic = await openPage();
	const { page, errors, network, outside } = traffic;
	try {
		const baseline = counts();
		devices = 1;
		phase = "waiting";
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			for (let i = 0; i < 30; i++) {
				fixture.emit({ type: "execution_devices_changed" });
				fixture.emit({ type: "unattended_mode_changed" });
			}
			fixture.emit({
				type: "background_task_list_delta",
				narratorId: "fixture",
				listEpoch: "fixture-epoch",
				version: 2,
				activeCount: 0,
				removeIds: ["agent-task"],
			});
		});
		await settle(page);
		expect(await page.$eval("[data-device-count]", (node) => node.textContent)).toBe("1");
		expect(await page.$eval("[data-unattended]", (node) => node.textContent)).toBe("waiting");
		expect(await page.$eval("[data-background-count]", (node) => node.textContent)).toBe("0");
		const afterChanges = counts();
		expect(afterChanges["GET /api/narrators/fixture/execution-devices"]).toBe(
			baseline["GET /api/narrators/fixture/execution-devices"] + 1,
		);
		expect(afterChanges["GET /api/system/unattended"]).toBe(
			baseline["GET /api/system/unattended"] + 1,
		);
		expect(afterChanges["GET /api/narrators/fixture/background-tasks"]).toBe(
			baseline["GET /api/narrators/fixture/background-tasks"],
		);
		status = "idle";
		await emit(page, { type: "status_change", status });
		await emit(page, { type: "agent_inbox_changed" });
		await settle(page);
		await page.waitForSelector("[data-pending-agent-messages]");
		const afterLifecycle = counts();
		for (const path of [
			"GET /api/narrators/fixture",
			"GET /api/narrators/fixture/inbox/agent-messages",
		]) {
			expect(afterLifecycle[path] - afterChanges[path]).toBeGreaterThanOrEqual(1);
			expect(afterLifecycle[path] - afterChanges[path]).toBeLessThanOrEqual(2);
		}
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.connection(false));
		await settle(page);
		const afterDisconnect = counts();
		// Offline is a safety edge: detect a missed remote arm immediately. The
		// narrator is idle here, so no waiting-panel fallback should read anything.
		expect(afterDisconnect).toEqual({
			...afterLifecycle,
			"GET /api/system/unattended": afterLifecycle["GET /api/system/unattended"] + 1,
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.connection(false));
		await settle(page);
		expect(counts()).toEqual(afterDisconnect);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.connection(true, true));
		await settle(page);
		const afterReconnect = counts();
		for (const path of [
			"GET /api/narrators/fixture/execution-devices",
			"GET /api/system/unattended",
			"GET /api/narrators/fixture/background-tasks",
			"GET /api/narrators/fixture/panel-state",
			"GET /api/narrators/fixture/inbox/agent-messages",
		]) {
			expect(afterReconnect[path] - afterDisconnect[path]).toBe(1);
		}
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.foreground());
		await settle(page);
		const afterForeground = counts();
		for (const path of [
			"GET /api/narrators/fixture/execution-devices",
			"GET /api/system/unattended",
			"GET /api/narrators/fixture/panel-state",
			"GET /api/narrators/fixture/inbox/agent-messages",
		]) {
			expect(afterForeground[path] - afterReconnect[path]).toBe(1);
		}
		const browserBeforeIdle = [...network];
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.advanceIntervals(120_000),
		);
		await settle(page);
		expect(counts()).toEqual(afterForeground);
		expect(network).toEqual(browserBeforeIdle);
		assertCrossPlaneTraffic(traffic, requests);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(outside).toEqual([]);
		console.info("polling browser recovery HTTP counts:", {
			baseline,
			afterChanges,
			afterLifecycle,
			afterDisconnect,
			afterReconnect,
			afterForeground,
		});
	} finally {
		try {
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.cleanup());
		} finally {
			await page.close();
		}
	}
}, 30_000);
