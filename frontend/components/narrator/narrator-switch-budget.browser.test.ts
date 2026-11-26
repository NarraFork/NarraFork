import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMUNICATION_LIMITS, type CommunicationCandidates } from "@shared/narrator-communication";
import puppeteer, { type HTTPRequest, type Page } from "puppeteer-core";
import { APP_VERSION, GIT_COMMIT } from "../../../server/lib/version";
import { appVersionsMatch } from "../../lib/version-match";
import {
	bulkySentinel,
	createSwitchBudgetFixture,
	frontendDist,
	modelCount,
	type RestArrival,
} from "./narrator-switch-budget.browser-fixture";

interface BrowserTransportTimeline {
	wsOpens: Array<{ path: string; at: number }>;
}
type BudgetWindow = Window & { switchBudgetTransport: BrowserTransportTimeline };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const pathOf = (request: { path: string }) => request.path.split("?")[0];
const globalProjection = (request: { path: string }) =>
	["/api/settings/runtime", "/api/user-preferences/ui", "/api/model-catalog/runtime"].includes(
		pathOf(request),
	);
function assertClosedPanelContract(requests: Array<{ path: string }>) {
	const forbidden = requests.filter(({ path }) => {
		const pathname = path.split("?")[0];
		return (
			pathname === "/api/settings" ||
			pathname === "/api/model-catalog/auto" ||
			pathname === "/api/narrators/named" ||
			/^\/api\/narrators\/[^/]+\/communication\/candidates$/.test(pathname) ||
			/\/model-catalog\/(card|options)(\/|$)/.test(pathname) ||
			/\/terminals(\/|$)/.test(pathname) ||
			/\/git\/worktrees(\/|$)/.test(pathname) ||
			/\/chat\/.*\/(messages|read)$/.test(pathname) ||
			/\/chat\/rooms\/(narrator|bot)\//.test(pathname) ||
			/\/discussion-room$/.test(pathname) ||
			/\/permissions$/.test(pathname)
		);
	});
	expect(forbidden).toEqual([]);
}
function assertPayloadBudgets(requests: RestArrival[]) {
	for (const request of requests) {
		const pathname = pathOf(request);
		if (pathname === "/api/settings/runtime") {
			expect(request.bytes).toBeLessThanOrEqual(8192);
			expect(request.body).not.toContain(bulkySentinel);
			expect(JSON.parse(request.body ?? "{}").summaryModelAvailable).toBe(true);
		}
		if (pathname === "/api/user-preferences/ui") {
			expect(request.bytes).toBeLessThanOrEqual(65536);
			expect(request.body).not.toContain(bulkySentinel);
			for (const key of ["recentTabs", "commands", "gatewayConfig", "specTabLayout"])
				expect(Object.hasOwn(JSON.parse(request.body ?? "{}"), key)).toBe(false);
		}
		if (pathname.endsWith("/ui-summary")) expect(request.bytes).toBeLessThanOrEqual(2048);
		if (/^\/api\/narrators\/budget-[ab]-[a-f0-9]+$/.test(pathname) && request.method === "GET") {
			const summary = JSON.parse(request.body ?? "{}").modelSummary;
			expect(summary).toBeDefined();
			expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThanOrEqual(
				4096,
			);
		}
	}
}

test("production projections exclude 1200 models, huge prompts/gateway/tabs in an isolated file DB", async () => {
	const fixture = await createSwitchBudgetFixture();
	try {
		for (const path of [
			"/api/settings/runtime",
			"/api/user-preferences/ui",
			`/api/narrators/${fixture.ids[0]}`,
			`/api/narrators/${fixture.ids[0]}/ui-summary`,
		]) {
			const response = await fetch(fixture.url + path, {
				headers: { Authorization: `Bearer ${fixture.token}` },
			});
			expect(response.status).toBe(200);
			await response.text();
		}
		assertPayloadBudgets(fixture.requests);
		expect(modelCount).toBeGreaterThan(1000);
		expect(fixture.isolation.database.startsWith(fixture.isolation.home)).toBe(true);
		expect(fixture.blockedOutbound).toEqual([]);
		console.info(
			"switch-budget production payloads",
			fixture.requests.map(({ path, status, bytes }) => ({ path, status, bytes })),
		);
	} finally {
		await fixture.close();
	}
}, 60_000);

interface BrowserStart {
	path: string;
	method: string;
	startedAt: number;
	endedAt: number;
	failed: boolean;
}
function peak(rows: Array<{ startedAt: number; endedAt: number }>, from: number, until: number) {
	const events = rows.flatMap((row) =>
		row.startedAt < until && (row.endedAt || until) > from
			? [
					{ at: Math.max(row.startedAt, from), change: 1 },
					{ at: Math.min(row.endedAt || until, until), change: -1 },
				]
			: [],
	);
	events.sort((a, b) => a.at - b.at || a.change - b.change);
	let current = 0;
	let maximum = 0;
	for (const event of events) {
		current += event.change;
		maximum = Math.max(maximum, current);
	}
	return maximum;
}
async function assertMatchingFrontendBuild() {
	const index = await Bun.file(join(frontendDist, "index.html")).text();
	const entry = index.match(/<script\b[^>]*\bsrc="\.\/([^"?]+\.js)"/)?.[1];
	if (!entry) throw new Error("Frontend build has no module entry");
	const entryPath = resolve(frontendDist, entry);
	if (!entryPath.startsWith(`${resolve(frontendDist)}/`))
		throw new Error("Invalid frontend entry path");
	const file = Bun.file(entryPath);
	if (file.size > 8 * 1024 * 1024) throw new Error("Frontend entry exceeds bounded identity probe");
	const versions = [
		...new Set((await file.text()).match(/\b\d+\.\d+\.\d+\+[a-f0-9]{7,40}\b/g) ?? []),
	];
	const serverVersion = GIT_COMMIT ? `${APP_VERSION}+${GIT_COMMIT}` : APP_VERSION;
	if (!versions.some((version) => appVersionsMatch(version, serverVersion)))
		throw new Error(
			`Frontend/server build identity mismatch: entry=${entry}; embedded=${JSON.stringify(versions)}; server=${serverVersion}. Rebuild this worktree at its current HEAD; do not bypass the production version refresh.`,
		);
	return { entry, versions, serverVersion };
}
async function waitForPanel(page: Page, marker: string) {
	await page.waitForFunction(
		(tail) => document.body?.innerText.includes(tail) === true,
		{ timeout: 30_000 },
		marker,
	);
	await page.waitForSelector('[contenteditable="true"]', { visible: true, timeout: 15_000 });
}
async function clickSidebar(page: Page, id: string) {
	const selector = `.mantine-AppShell-navbar [data-tab-sort-id="narrator:${id}"] .mantine-NavLink-root`;
	await page.waitForSelector(selector, { visible: true });
	await page.click(selector);
	await page.waitForFunction((expected) => location.pathname.endsWith(expected), {}, id);
}

test("real Chromium full SPA cold A → sidebar B → warm A has bounded requests and decoded bytes", async () => {
	// CI must build in this worktree first. Missing prerequisites fail, never skip.
	if (!existsSync(executablePath)) throw new Error(`Chromium required: ${executablePath}`);
	if (!existsSync(join(frontendDist, "index.html")))
		throw new Error("Run bun run build in this worktree first");
	expect(realpathSync(frontendDist)).toBe(resolve(frontendDist));
	const buildIdentity = await assertMatchingFrontendBuild();
	const fixture = await createSwitchBudgetFixture();
	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 1000 });
	const errors: string[] = [];
	const consoleErrors: string[] = [];
	const resourceFailures: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("response", (response) => {
		if (response.status() >= 400)
			resourceFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
	});
	const outside: string[] = [];
	const starts: BrowserStart[] = [];
	const documentNavigations: string[] = [];
	const tracked = new Map<HTTPRequest, BrowserStart>();
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (request.isNavigationRequest() && request.frame() === page.mainFrame())
			documentNavigations.push(url.pathname);
		if (url.origin !== fixture.url && ["http:", "https:"].includes(url.protocol)) {
			outside.push(url.origin + url.pathname);
			void request.abort();
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			const record = {
				path: url.pathname + url.search,
				method: request.method(),
				startedAt: performance.now(),
				endedAt: 0,
				failed: false,
			};
			starts.push(record);
			tracked.set(request, record);
		}
		void request.continue();
	});
	page.on("requestfinished", (request) => {
		const record = tracked.get(request);
		if (record) record.endedAt = performance.now();
	});
	page.on("requestfailed", (request) => {
		const record = tracked.get(request);
		if (record) {
			record.endedAt = performance.now();
			record.failed = true;
		}
	});
	const client = await page.createCDPSession();
	await client.send("Network.enable");
	const wsFrames: Array<{ at: number; data: string }> = [];
	const wsConnected: number[] = [];
	const wsSent: Array<{ type: string; narratorIds?: string[] }> = [];
	client.on("Network.webSocketFrameSent", (event) => {
		try {
			wsSent.push(JSON.parse(event.response.payloadData));
		} catch {
			/* Binary frames are unrelated. */
		}
	});
	client.on("Network.webSocketHandshakeResponseReceived", () =>
		wsConnected.push(performance.now()),
	);
	client.on("Network.webSocketFrameReceived", (event) =>
		wsFrames.push({ at: performance.now(), data: event.response.payloadData }),
	);
	await page.evaluateOnNewDocument((token) => {
		localStorage.setItem("narrafork_token", token);
		localStorage.setItem("i18nextLng", "en");
		performance.setResourceTimingBufferSize(5000);
		const timeline: BrowserTransportTimeline = { wsOpens: [] };
		(window as unknown as BudgetWindow).switchBudgetTransport = timeline;
		// Construct the native socket unchanged. Register before application
		// handlers, so this is the actual browser open event (not a CDP event's
		// later delivery to Bun) in the same clock as ResourceTiming.startTime.
		window.WebSocket = new Proxy(window.WebSocket, {
			construct(target, args, newTarget) {
				const socket = Reflect.construct(target, args, newTarget) as WebSocket;
				socket.addEventListener(
					"open",
					() => {
						timeline.wsOpens.push({ path: new URL(socket.url).pathname, at: performance.now() });
					},
					{ once: true },
				);
				return socket;
			},
		});
	}, fixture.token);
	const reports: unknown[] = [];
	const budgetFailures: Array<{ phase: string; error: string }> = [];
	try {
		for (const [index, label] of ["cold A", "first B online", "warm A online"].entries()) {
			const startedAt = performance.now();
			const before = fixture.requests.length;
			const browserBefore = starts.length;
			const resourcePhaseStart = index === 0 ? 0 : await page.evaluate(() => performance.now());
			const actions =
				index === 0
					? page.goto(`${fixture.url}/narrators/${fixture.ids[0]}`, {
							waitUntil: "domcontentloaded",
							timeout: 30_000,
						})
					: clickSidebar(page, fixture.ids[index === 1 ? 1 : 0]);
			await actions;
			await waitForPanel(page, `BUDGET_BODY_${index === 1 ? "B" : "A"}_TAIL`);
			const elapsed = performance.now() - startedAt;
			if (elapsed < 3100) await new Promise((resolve) => setTimeout(resolve, 3100 - elapsed));
			await page.waitForNetworkIdle({ idleTime: 100, timeout: 10_000 });
			const arrivals = fixture.requests.slice(before);
			const browserRequests = starts.slice(browserBefore);
			const resourceRows = await page.evaluate(() =>
				performance
					.getEntriesByType("resource")
					.filter((entry) => new URL(entry.name).pathname.startsWith("/api/"))
					.map((entry) => {
						const resource = entry as PerformanceResourceTiming;
						return {
							path: new URL(resource.name).pathname + new URL(resource.name).search,
							startTime: resource.startTime,
							requestStart: resource.requestStart,
							responseEnd: resource.responseEnd,
							decodedBytes: resource.decodedBodySize,
							transferBytes: resource.transferSize,
						};
					}),
			);
			const nativeTransport = await page.evaluate(
				() => (window as unknown as BudgetWindow).switchBudgetTransport,
			);
			const phaseResources = resourceRows.filter((row) => row.startTime >= resourcePhaseStart);
			const browserLifetimes = phaseResources.map((row) => ({
				startedAt: row.startTime,
				endedAt: row.responseEnd,
			}));
			const actualTransmission = phaseResources
				.filter((row) => row.requestStart > 0)
				.map((row) => ({ startedAt: row.requestStart, endedAt: row.responseEnd }));
			for (const milliseconds of [1000, 3000]) {
				const rows = arrivals.filter((row) => row.startedAt <= startedAt + milliseconds);
				// Use browser-native timestamps, not delayed Puppeteer event delivery.
				// Bytes are the complete decoded sizes of resources STARTED in this
				// window (not a byte-arrival-rate measurement).
				const browserRows = phaseResources.filter(
					(row) => row.startTime < resourcePhaseStart + milliseconds,
				);
				reports.push({
					phase: label,
					window: `${milliseconds / 1000}s`,
					starts: browserRows.length,
					arrivals: rows.length,
					duplicateStarts: browserRows.length - new Set(browserRows.map((row) => row.path)).size,
					browserInFlightPeak: peak(
						browserLifetimes,
						resourcePhaseStart,
						resourcePhaseStart + milliseconds,
					),
					serverInFlightPeak: peak(fixture.requests, startedAt, startedAt + milliseconds),
					transmissionPeak: peak(
						actualTransmission,
						resourcePhaseStart,
						resourcePhaseStart + milliseconds,
					),
					decodedBytes: phaseResources
						.filter((row) => row.startTime < resourcePhaseStart + milliseconds)
						.reduce((sum, row) => sum + row.decodedBytes, 0),
					serverResponseBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
					bodyBytes: rows
						.filter((row) => /\/(?:pretext-document|messages)(?:[/?]|$)/.test(row.path))
						.reduce((sum, row) => sum + row.bytes, 0),
				});
			}
			console.info(
				`switch-budget ${label} endpoints`,
				arrivals.map(({ method, path, status, bytes, body }) => ({
					method,
					path,
					status,
					bytes,
					...(/^\/api\/narrators\/budget-[ab]-[a-f0-9]+$/.test(path) && body
						? {
								modelSummaryBytes: new TextEncoder().encode(
									JSON.stringify(JSON.parse(body).modelSummary),
								).byteLength,
							}
						: {}),
				})),
			);
			console.table(reports);
			try {
				assertClosedPanelContract(arrivals);
				assertPayloadBudgets(arrivals);
				expect(arrivals.filter((row) => row.status >= 400)).toEqual([]);
				if (index === 0) {
					expect(arrivals.filter((row) => pathOf(row) === "/api/settings/runtime")).toHaveLength(1);
					const preferences = arrivals.filter((row) => pathOf(row) === "/api/user-preferences/ui");
					const preferenceResources = phaseResources.filter(
						(row) => pathOf(row) === "/api/user-preferences/ui",
					);
					console.info("switch-budget cold preferences / real WS chronology", {
						browserResources: preferenceResources,
						nativeWebSocketOpens: nativeTransport.wsOpens,
						serverArrivalStartsMs: preferences.map((row) => row.startedAt - startedAt),
						cdpHandshakeDeliveryMs: wsConnected.map((at) => at - startedAt),
						gapMs:
							preferenceResources.length === 2
								? preferenceResources[1].startTime - preferenceResources[0].startTime
								: null,
						relevantFrames: wsFrames.filter((frame) =>
							/user_preferences_changed|fast_mode_changed/.test(frame.data),
						),
					});
					if (preferences.length === 2) {
						// Approved safety exception only: the first HTTP read really
						// preceded the unique connection edge, then FastMode closes
						// that HTTP→WS gap. Never forgive arbitrary duplicate reads.
						expect(nativeTransport.wsOpens).toHaveLength(1);
						expect(preferenceResources).toHaveLength(2);
						expect(preferenceResources[0].startTime).toBeLessThan(nativeTransport.wsOpens[0].at);
						expect(preferenceResources[1].startTime).toBeGreaterThanOrEqual(
							nativeTransport.wsOpens[0].at,
						);
						expect(
							arrivals.filter(
								(row) =>
									row.method === "PATCH" &&
									["/api/user-preferences", "/api/user-preferences/ui"].includes(pathOf(row)),
							),
						).toEqual([]);
					} else expect(preferences).toHaveLength(1);
				} else expect(arrivals.filter(globalProjection)).toEqual([]);
				const panel = arrivals.filter((row) => pathOf(row).endsWith("/panel-state"));
				if (index === 0 && panel.length === 2) {
					// Do not blanket-allow duplicate snapshots: prove the initial read
					// actually preceded the first real WebSocket connection edge.
					const panelResources = phaseResources.filter((row) =>
						pathOf(row).endsWith("/panel-state"),
					);
					expect(nativeTransport.wsOpens).toHaveLength(1);
					expect(panelResources).toHaveLength(2);
					expect(panelResources[0].startTime).toBeLessThan(nativeTransport.wsOpens[0].at);
					expect(panelResources[1].startTime).toBeGreaterThanOrEqual(nativeTransport.wsOpens[0].at);
				} else expect(panel).toHaveLength(1);
				expect(
					arrivals.filter((row) => pathOf(row).endsWith("/ui-summary")).length,
				).toBeLessThanOrEqual(1);
				expect(browserRequests.length).toBeLessThanOrEqual(index === 0 ? 40 : 20);
				expect(
					arrivals
						.filter((row) => !/\/(?:pretext-document|messages)(?:[/?]|$)/.test(row.path))
						.reduce((sum, row) => sum + row.bytes, 0),
				).toBeLessThanOrEqual(128 * 1024);
				expect(
					browserRequests.filter(
						(row) => row.failed && /\/(?:pretext-document|messages)(?:[/?]|$)/.test(row.path),
					),
				).toEqual([]);
			} catch (error) {
				// Keep measuring the remaining real gestures, but never forgive a
				// failed budget: aggregate it into the mandatory final assertion.
				budgetFailures.push({ phase: label, error: String(error) });
			}
		}
		// Demand uses real UI gestures after the closed-panel matrix. No direct
		// fetch is used to manufacture a supposedly lazy request.
		const beforeMenu = fixture.requests.length;
		const optionsResponse = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/model-catalog/options",
			{ timeout: 20_000 },
		);
		await page.click('select:has(option[value="budget:fixture-0000"])');
		const options = await optionsResponse;
		expect(options.status()).toBe(200);
		const optionPage = await options.json();
		expect(optionPage.items.length).toBeGreaterThan(0);
		expect(optionPage.items.length).toBeLessThanOrEqual(40);
		expect(optionPage.nextCursor).toBeTruthy();
		await page.waitForNetworkIdle({ idleTime: 200 });
		const menuRequests = fixture.requests
			.slice(beforeMenu)
			.filter((row) => pathOf(row) === "/api/model-catalog/options");
		expect(menuRequests).toHaveLength(1);
		expect(menuRequests[0].bytes).toBeLessThanOrEqual(65536);
		await page.keyboard.press("Escape");
		const beforeMention = fixture.requests.length;
		const candidatePath = `/api/narrators/${fixture.ids[0]}/communication/candidates`;
		const candidateResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "GET" && new URL(response.url()).pathname === candidatePath,
			{ timeout: 15_000 },
		);
		await page.click('[contenteditable="true"]');
		await page.keyboard.type("@");
		const candidates = await candidateResponse;
		expect(candidates.status()).toBe(200);
		const suggestions = (await candidates.json()) as CommunicationCandidates;
		expect(suggestions.items.length).toBeGreaterThan(0);
		expect(suggestions.items.length).toBeLessThanOrEqual(COMMUNICATION_LIMITS.searchMaxLimit);
		expect(suggestions.items.map(({ id, canConnect }) => ({ id, canConnect }))).toEqual([
			{ id: fixture.ids[1], canConnect: true },
		]);
		await page.waitForNetworkIdle({ idleTime: 200 });
		const candidateRequests = fixture.requests.filter((row) =>
			pathOf(row).endsWith("/communication/candidates"),
		);
		expect(candidateRequests).toHaveLength(1);
		expect(fixture.requests.slice(beforeMention)).toContain(candidateRequests[0]);
		expect(candidateRequests[0].bytes).toBeLessThanOrEqual(48 * 1024);
		const searchParams = new URL(candidates.url()).searchParams;
		expect(searchParams.get("q")).toBe("");
		expect(searchParams.get("limit")).toBe(String(COMMUNICATION_LIMITS.searchMaxLimit));
		expect(fixture.requests.filter((row) => pathOf(row) === "/api/narrators/named")).toEqual([]);
		console.info("switch-budget gesture pages", {
			options: { rows: optionPage.items.length, bytes: menuRequests[0].bytes },
			candidates: { rows: suggestions.items.length, bytes: candidateRequests[0].bytes },
		});
		expect(wsConnected).toHaveLength(1);
		expect(
			await page.evaluate(() => (window as unknown as BudgetWindow).switchBudgetTransport.wsOpens),
		).toHaveLength(1);
		for (const id of fixture.ids)
			expect(
				wsSent.some((frame) => frame.type === "subscribe" && frame.narratorIds?.includes(id)),
			).toBe(true);
		expect(wsSent.filter((frame) => frame.type === "chat_subscribe")).toEqual([]);
		expect(wsFrames.some((frame) => frame.data.includes("status_change"))).toBe(true);
		expect(errors).toEqual([]);
		expect(documentNavigations).toEqual([`/narrators/${fixture.ids[0]}`]);
		expect(outside).toEqual([]);
		expect(fixture.blockedOutbound).toEqual([]);
		expect(budgetFailures).toEqual([]);
		console.info(
			"switch-budget real WS frames",
			wsFrames.map((frame) => frame.data.slice(0, 150)),
		);
	} catch (error) {
		console.error("switch-budget failure diagnostics", {
			buildIdentity,
			documentNavigations,
			consoleErrors,
			resourceFailures,
			errors,
			outside,
			outbound: fixture.blockedOutbound,
			rests: fixture.requests.map(({ method, path, status, bytes }) => ({
				method,
				path,
				status,
				bytes,
			})),
			body: await page.evaluate(
				() => document.body?.innerText.slice(0, 3500) ?? "<document body not ready>",
			),
		});
		throw error;
	} finally {
		await browser.close();
		await fixture.close();
	}
}, 120_000);
