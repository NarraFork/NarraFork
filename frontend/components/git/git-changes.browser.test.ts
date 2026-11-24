import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import puppeteer, { type Browser, type Page, type WebWorker } from "puppeteer-core";
import type {
	GitStagingObservationState,
	GitWorkspaceEventIdentity,
} from "../../../shared/git-workspace-events";
import type { fixture } from "./git-changes.browser-fixture";
import { serveGitChangesBrowserAssets } from "./git-changes.browser-fixture.assets";
import {
	GIT_BROWSER_STAGING_PATHS,
	type GitBrowserBlockScenario,
} from "./git-changes.browser-network";
import type {
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";

type FixtureWindow = Window & {
	gitChangesFixture: typeof fixture;
	blockPreview?: Element | null;
	blockPatch?: Element | null;
	blockScroll?: Element | null;
};
type FixtureSnapshot = ReturnType<typeof fixture.snapshot>;
interface WorkerProbe {
	requests: Array<{ type: string; generation: string; appendedFiles: number; durationMs: number }>;
	counts: Record<string, number>;
	maxDurationMs: number;
	responses: Array<{
		type: string;
		generation: string;
		rows: number;
		totalRows: number;
		loadedFiles: number;
	}>;
}
interface ConfigureGate {
	holding: boolean;
	held: GitChangesWorkerResponse[];
	configureIds: number[];
	commands: Array<{ type: string; generation: string; epoch: string | null }>;
	release: (latestOnly?: boolean) => void;
}
type WorkerScope = {
	__gitBrowserProbe?: WorkerProbe;
	__gitConfigureGate?: ConfigureGate;
	onmessage: unknown;
	postMessage: (message: unknown, transfer?: Transferable[]) => void;
	document?: unknown;
};
const root = resolve(import.meta.dir, "../../..");
let isolation: string | undefined;
let chromiumTemporary: string | undefined;
let server: ReturnType<typeof Bun.serve<{ fixtureId: string }>> | undefined;
let assetServer: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let nextFixtureId = 0;
type FixtureSocket = ServerWebSocket<{ fixtureId: string }>;
interface ObservationSession {
	sockets: Set<FixtureSocket>;
	subscriptions: Map<string, { socket: FixtureSocket; identity: GitWorkspaceEventIdentity }>;
	states: Map<string, GitStagingObservationState>;
	requests: string[];
	messages: Array<{ workspaceKey: string; status: string; sequence: number; generation: number }>;
	holdSync: boolean;
}
const observationSessions = new Map<string, ObservationSession>();
function observationSession(id: string) {
	let session = observationSessions.get(id);
	if (!session) {
		session = {
			sockets: new Set(),
			subscriptions: new Map(),
			states: new Map(),
			requests: [],
			messages: [],
			holdSync: false,
		};
		observationSessions.set(id, session);
	}
	return session;
}
function observationState(session: ObservationSession, workspaceKey: string) {
	let state = session.states.get(workspaceKey);
	if (!state) {
		state = {
			instanceId: "fixture-instance-1",
			stateSequence: 1,
			epoch: 0,
			completedEpoch: 0,
			round: 0,
			status: "settled",
			generation: 1,
			observationId: "fixture-o1",
		};
		session.states.set(workspaceKey, state);
	}
	return state;
}
function broadcastObservation(
	session: ObservationSession,
	workspaceKey: string,
	state: GitStagingObservationState,
	save = true,
) {
	if (save) session.states.set(workspaceKey, state);
	for (const { socket, identity } of session.subscriptions.values()) {
		if (identity.workspaceKey !== workspaceKey || socket.readyState !== 1) continue;
		identity.version++;
		socket.send(
			JSON.stringify({
				type: "git_workspace_staging_observation",
				...identity,
				observation: state,
			}),
		);
	}
	session.messages.push({
		workspaceKey,
		status: state.status,
		sequence: state.stateSequence,
		generation: state.generation,
	});
}
async function observationControl(request: Request) {
	const input = (await request.json()) as {
		fixtureId: string;
		command: string;
		workspaceKey?: string;
		status?: GitStagingObservationState["status"];
		generation?: number;
		observationId?: string;
		affectedListIds?: string[];
		overrides?: Partial<GitStagingObservationState>;
	};
	const session = observationSession(input.fixtureId);
	const workspace = input.workspaceKey ?? "workspace-a";
	const previous = observationState(session, workspace);
	if (input.command === "hold-sync") session.holdSync = true;
	if (input.command === "sync") {
		session.requests.push("http-sync");
		const pending = {
			...previous,
			stateSequence: previous.stateSequence + 1,
			epoch: previous.epoch + 1,
			status: "pending" as const,
		};
		broadcastObservation(session, workspace, pending);
		broadcastObservation(session, workspace, {
			...pending,
			stateSequence: pending.stateSequence + 1,
			round: pending.round + 1,
			status: "observing",
		});
		if (!session.holdSync) {
			const observing = observationState(session, workspace);
			broadcastObservation(session, workspace, {
				...observing,
				stateSequence: observing.stateSequence + 1,
				completedEpoch: observing.epoch,
				status: "settled",
			});
		}
		session.holdSync = false;
	}
	if (input.command === "state" || input.command === "publish" || input.command === "inject") {
		const state = {
			...previous,
			stateSequence: previous.stateSequence + 1,
			...(input.status ? { status: input.status } : {}),
			...(input.status === "pending" ? { epoch: previous.epoch + 1 } : {}),
			...(input.status === "observing" ? { round: previous.round + 1 } : {}),
			...(input.status === "settled" || input.command === "publish"
				? { status: "settled" as const, completedEpoch: previous.epoch }
				: {}),
			...(input.generation === undefined
				? {}
				: {
						generation: input.generation,
						observationId: input.observationId ?? `fixture-o${input.generation}`,
					}),
			...input.overrides,
		};
		if (input.command === "publish") {
			for (const subscription of session.subscriptions.values()) {
				if (
					subscription.identity.workspaceKey !== workspace ||
					subscription.socket.readyState !== 1
				)
					continue;
				subscription.identity.version++;
				subscription.socket.send(
					JSON.stringify({
						type: "git_workspace_staging_lists_changed",
						...subscription.identity,
						generation: state.generation,
						observationId: state.observationId,
						affectedListIds: input.affectedListIds ?? [],
					}),
				);
			}
		}
		broadcastObservation(session, workspace, state, input.command !== "inject");
	}
	if (input.command === "old-change") {
		for (const subscription of session.subscriptions.values()) {
			if (subscription.identity.workspaceKey !== workspace || subscription.socket.readyState !== 1)
				continue;
			subscription.identity.version++;
			subscription.socket.send(
				JSON.stringify({
					type: "git_workspace_staging_lists_changed",
					...subscription.identity,
					generation: input.generation ?? 1,
					observationId: input.observationId ?? "fixture-o1",
					affectedListIds: input.affectedListIds ?? ["A"],
				}),
			);
		}
	}
	if (input.command === "inject-cross-workspace") {
		for (const { socket, identity } of session.subscriptions.values())
			if (socket.readyState === 1)
				socket.send(
					JSON.stringify({
						type: "git_workspace_staging_observation",
						...identity,
						workspaceKey: workspace,
						observation: {
							...previous,
							status: "settled",
							stateSequence: 999,
							completedEpoch: previous.epoch,
						},
					}),
				);
	}
	if (input.command === "disconnect") {
		broadcastObservation(session, workspace, {
			...previous,
			stateSequence: previous.stateSequence + 1,
			epoch: previous.epoch + 1,
			status: "pending",
		});
		for (const socket of session.sockets) socket.close(1012, "Fixture transport restart");
	}
	return Response.json({
		observation: observationState(session, workspace),
		requests: session.requests,
		messages: session.messages,
		subscriptions: [...session.subscriptions.values()].filter(
			(entry) => entry.socket.readyState === 1,
		).length,
	});
}
async function serveObservationFixture(assets: ReturnType<typeof Bun.serve>) {
	return Bun.serve<{ fixtureId: string }>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 30,
		async fetch(request, fixtureServer) {
			const url = new URL(request.url);
			if (url.pathname === "/ws/narrator") {
				const fixtureId = url.searchParams.get("token") ?? "";
				if (!fixtureId.startsWith("git-browser-"))
					return new Response("Fixture credential required", { status: 401 });
				if (fixtureServer.upgrade(request, { data: { fixtureId } })) return;
				return new Response("Upgrade failed", { status: 400 });
			}
			if (url.pathname === "/__git-observation-fixture" && request.method === "POST")
				return observationControl(request);
			return fetch(`http://127.0.0.1:${assets.port}${url.pathname}${url.search}`, {
				headers: request.headers,
			});
		},
		websocket: {
			open(socket) {
				observationSession(socket.data.fixtureId).sockets.add(socket);
			},
			message(socket, raw) {
				const message = JSON.parse(String(raw)) as Record<string, unknown>;
				const session = observationSession(socket.data.fixtureId);
				if (typeof message.subscriptionId !== "string") return;
				if (message.type === "git_workspace_unsubscribe") {
					session.subscriptions.delete(message.subscriptionId);
					return;
				}
				if (message.type === "git_workspace_refresh") {
					session.requests.push("ws-refresh");
					return;
				}
				if (message.type !== "git_workspace_subscribe") return;
				const workspaceKey =
					typeof message.workspaceKey === "string" ? message.workspaceKey : "workspace-a";
				const identity: GitWorkspaceEventIdentity = {
					subscriptionId: message.subscriptionId,
					version: 1,
					workspaceKey,
					repositoryKey: `fixture-repository:${workspaceKey}`,
					narratorId: typeof message.narratorId === "string" ? message.narratorId : undefined,
				};
				session.subscriptions.set(identity.subscriptionId, { socket, identity });
				session.requests.push("subscribe");
				socket.send(JSON.stringify({ type: "git_workspace_subscribed", ...identity }));
				broadcastObservation(session, workspaceKey, observationState(session, workspaceKey));
			},
			close(socket) {
				const session = observationSession(socket.data.fixtureId);
				session.sockets.delete(socket);
				for (const [id, value] of session.subscriptions)
					if (value.socket === socket) session.subscriptions.delete(id);
			},
		},
	});
}
let origin = "";
const activePageProgress = new Map<
	Page,
	{ phase: string; at: number; state?: FixtureSnapshot; worker?: unknown }
>();

function pagePhase(page: Page, phase: string) {
	activePageProgress.set(page, { ...activePageProgress.get(page), phase, at: Date.now() });
}
function compactSnapshot(state: FixtureSnapshot | undefined) {
	if (!state) return null;
	return {
		runtime: state.runtime,
		loaded: state.loaded,
		pageCount: state.pageCount,
		hasMore: state.hasMore,
		mounted: state.mounted,
		visibleCapacity: state.visibleCapacity,
		scrollTop: state.scrollTop,
		scrollHeight: state.scrollHeight,
		visibility: state.visibility,
		react: state.react,
		sampling: state.sampling,
		requestCount: state.network.requests.length,
		statsRequestCount: state.network.statsRequestCount,
		requests: state.network.requests.slice(-6).map((request) => ({
			id: request.id,
			offset: request.offset,
			count: request.count,
			aborted: request.aborted,
			settled: request.settled,
			durationMs: request.settledAt === null ? null : request.settledAt - request.startedAt,
		})),
	};
}

async function closeFixture() {
	if (activePageProgress.size) {
		console.error(
			"Git changes active operation before shutdown",
			JSON.stringify(
				[...activePageProgress.values()].slice(0, 2).map((progress) => ({
					phase: progress.phase,
					at: progress.at,
					state: compactSnapshot(progress.state),
					worker: progress.worker,
				})),
			).slice(0, 12_000),
		);
	}

	const ownedBrowser = browser;
	const ownedServer = server;
	const ownedAssetServer = assetServer;
	const ownedIsolation = isolation;
	const ownedChromiumTemporary = chromiumTemporary;
	browser = undefined;
	server = undefined;
	assetServer = undefined;
	isolation = undefined;
	chromiumTemporary = undefined;
	try {
		await ownedBrowser?.close();
	} finally {
		try {
			await ownedServer?.stop(true);
			await ownedAssetServer?.stop(true);
			observationSessions.clear();
		} finally {
			try {
				if (ownedIsolation) await rm(ownedIsolation, { recursive: true, force: true });
			} finally {
				if (ownedChromiumTemporary)
					await rm(ownedChromiumTemporary, { recursive: true, force: true });
			}
		}
	}
}

beforeAll(async () => {
	try {
		const executablePath =
			process.env.NF_TEST_CHROMIUM_PATH ??
			process.env.PUPPETEER_EXECUTABLE_PATH ??
			"/usr/bin/chromium";
		if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
		isolation = await mkdtemp(resolve(tmpdir(), "nf-git-changes-browser-"));
		const home = resolve(isolation, "home");
		// Chromium's Unix IPC sockets need a short path, including under nested runner sandboxes.
		const workspaceTemporaryRoot = resolve(root, ".narrafork");
		const workspacePathFits = Buffer.byteLength(resolve(workspaceTemporaryRoot, "c.XXXXXX")) <= 60;
		const chromiumTempRoot = workspacePathFits
			? workspaceTemporaryRoot
			: process.platform === "win32"
				? tmpdir()
				: "/tmp";
		await mkdir(chromiumTempRoot, { recursive: true });
		chromiumTemporary = await mkdtemp(resolve(chromiumTempRoot, "c."));
		const temporary = chromiumTemporary;
		await mkdir(home, { recursive: true });
		// Only this fixture is built and served; no app config, database or existing instance.
		assetServer = await serveGitChangesBrowserAssets(isolation);
		server = await serveObservationFixture(assetServer);
		origin = `http://127.0.0.1:${server.port}`;
		browser = await puppeteer.launch({
			executablePath,
			headless: true,
			timeout: 20_000,
			userDataDir: resolve(isolation, "chromium-profile"),
			env: {
				...process.env,
				HOME: home,
				NARRAFORK_HOME: resolve(home, ".narrafork"),
				NARRAFORK_ALLOW_MULTIPLE: "1",
				TMPDIR: temporary,
				TMP: temporary,
				TEMP: temporary,
			},
			args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
		});
	} catch (error) {
		try {
			await closeFixture();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Git browser fixture startup and cleanup failed",
			);
		}
		throw error;
	}
}, 60_000);

afterAll(closeFixture);

async function snapshot(page: Page) {
	const state = await page.evaluate(() =>
		(window as unknown as FixtureWindow).gitChangesFixture.snapshot(),
	);
	const previous = activePageProgress.get(page);
	activePageProgress.set(page, {
		...previous,
		phase: previous?.phase ?? "snapshot",
		at: Date.now(),
		state,
	});
	return state;
}
async function frames(page: Page, count = 3) {
	await page.evaluate(
		(n) => (window as unknown as FixtureWindow).gitChangesFixture.frames(n),
		count,
	);
}
async function withPage(
	run: (page: Page, workers: WebWorker[]) => Promise<void>,
	mode = "flat",
	options: {
		total?: number;
		canWrite?: boolean;
		holdNextPage?: boolean;
		directorySize?: number;
		branchingDirectories?: boolean;
		staging?: boolean;
		stagingPaths?: boolean;
		blockMove?: GitBrowserBlockScenario;
		width?: number;
	} = {},
) {
	if (!browser) throw new Error("Browser unavailable");
	const page = await browser.newPage();
	const openedAt = performance.now();
	pagePhase(page, "navigation");
	const workers: WebWorker[] = [];
	const errors: string[] = [];
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	const failedResponses: string[] = [];
	const pendingRequests = new Set<string>();
	page.on("workercreated", (worker) => {
		workers.push(worker);
	});
	page.on("pageerror", (error) => {
		if (errors.length < 12) errors.push(String(error).slice(0, 700));
	});
	page.on("console", (message) => {
		if (message.type() === "error" && consoleErrors.length < 12) {
			consoleErrors.push(message.text().slice(0, 700));
		}
	});
	page.on("request", (request) => {
		if (pendingRequests.size < 24) pendingRequests.add(request.url());
	});
	page.on("requestfinished", (request) => {
		pendingRequests.delete(request.url());
	});
	page.on("requestfailed", (request) => {
		pendingRequests.delete(request.url());
		if (failedRequests.length < 12) {
			failedRequests.push(
				`${request.url().slice(0, 500)}: ${request.failure()?.errorText ?? "unknown"}`,
			);
		}
	});
	page.on("response", (response) => {
		if (response.status() >= 400 && failedResponses.length < 12) {
			failedResponses.push(`${response.status()} ${response.url().slice(0, 500)}`);
		}
	});
	page.setDefaultTimeout(15_000);
	try {
		await page.setViewport({ width: options.width ?? 1100, height: 760 });
		const parameters = new URLSearchParams({
			total: String(options.total ?? 10_000),
			mode,
			fixtureId: `git-browser-${++nextFixtureId}`,
		});
		if (options.canWrite) parameters.set("canWrite", "1");
		if (options.staging) parameters.set("staging", "1");
		if (options.stagingPaths) parameters.set("stagingPaths", "1");
		if (options.blockMove) parameters.set("blockMove", options.blockMove);
		if (options.holdNextPage) parameters.set("holdNextPage", "1");
		if (options.directorySize) parameters.set("directorySize", String(options.directorySize));
		if (options.branchingDirectories) parameters.set("branchingDirectories", "1");
		await page.goto(`${origin}/?${parameters}`);
		pagePhase(page, "ready");
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).gitChangesFixture?.ready(),
		);
		await page.waitForFunction(
			(held) => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return held
					? state.pageCount === 1 && state.network.pending.length === 1
					: (!state.hasMore || state.pageCount === 10) &&
							state.network.requests.every((request) => request.settled);
			},
			{},
			options.holdNextPage ?? false,
		);
		await frames(page);
		console.info(
			"Git changes browser ready",
			JSON.stringify({
				elapsedMs: performance.now() - openedAt,
				state: compactSnapshot(await snapshot(page)),
			}),
		);
		await run(page, workers);
		expect((await snapshot(page)).network.unexpected).toEqual([]);
		expect(errors).toEqual([]);
	} catch (error) {
		let documentState: unknown;
		try {
			documentState = await page.evaluate(() => {
				const controlled = (window as unknown as Partial<FixtureWindow>).gitChangesFixture;
				let details: unknown;
				try {
					details = controlled?.diagnostics();
				} catch (diagnosticError) {
					details = { error: String(diagnosticError).slice(0, 500) };
				}
				return {
					url: location.href,
					documentReadyState: document.readyState,
					body: document.body?.innerText.slice(0, 2_000),
					fixtureDefined: !!controlled,
					moduleScripts: [...document.querySelectorAll<HTMLScriptElement>('script[type="module"]')]
						.slice(0, 6)
						.map((script) => script.src.slice(0, 500)),
					details,
				};
			});
		} catch (diagnosticError) {
			documentState = { error: String(diagnosticError).slice(0, 500) };
		}
		console.error(
			"Git changes browser failure diagnostics",
			JSON.stringify({
				error: String(error).slice(0, 700),
				pageErrors: errors,
				consoleErrors,
				failedRequests,
				failedResponses,
				pendingRequests: [...pendingRequests].slice(0, 12).map((url) => url.slice(0, 500)),
				workers: workers.slice(0, 6).map((worker) => worker.url().slice(0, 500)),
				documentState,
				lastKnown: {
					phase: activePageProgress.get(page)?.phase,
					at: activePageProgress.get(page)?.at,
					state: compactSnapshot(activePageProgress.get(page)?.state),
					worker: activePageProgress.get(page)?.worker,
				},
			}).slice(0, 16_000),
		);
		throw error;
	} finally {
		try {
			await page.close();
		} finally {
			activePageProgress.delete(page);
		}
	}
}
function expectBounded(state: FixtureSnapshot) {
	expect(state.viewportHeight).toBeGreaterThan(0);
	expect(state.mounted).toBeGreaterThan(0);
	expect(state.mounted).toBeLessThanOrEqual(state.visibleCapacity + 2 * state.overscan + 2);
	expect(new Set(state.rowKeys).size).toBe(state.rowKeys.length);
}
const BLOCK_SCROLL = "[data-git-staging-preview] [data-content-scrollport]";
async function openBlockPreview(page: Page, metadataOnly = false, openOtherGroup = false) {
	await page.click("aria/ChangeLists");
	await page.waitForSelector('[data-git-staging-observation="settled"]');
	await page.waitForSelector('[data-git-staging-toggle="A"]');
	await page.click('[data-git-staging-toggle="A"]');
	await page.waitForSelector('[data-git-staging-directory="src"]');
	await page.click('[data-git-staging-directory="src"]');
	await page.waitForSelector('[data-git-staging-file="src/blocks.ts"]');
	if (openOtherGroup) {
		await page.click('[data-git-staging-toggle="B"]');
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).gitChangesFixture
				.snapshot()
				.network.stagingReads.includes("B"),
		);
	}
	await page.click('[data-git-staging-file="src/blocks.ts"]');
	await page.waitForSelector("[data-git-staging-preview-writable]");
	if (!metadataOnly) await page.waitForSelector("[data-git-staging-preview] [data-diff-row]");
	await page.evaluate(() => {
		const target = window as unknown as FixtureWindow;
		target.blockPreview = document.querySelector("[data-git-staging-preview]");
		target.blockPatch = target.blockPreview?.querySelector("[data-git-patch-view]");
		target.blockScroll = target.blockPreview?.querySelector("[data-content-scrollport]");
	});
}
async function expectBlockPreviewRetained(page: Page) {
	expect(
		await page.evaluate(() => {
			const target = window as unknown as FixtureWindow;
			return {
				preview:
					!!target.blockPreview?.isConnected &&
					target.blockPreview === document.querySelector("[data-git-staging-preview]"),
				patch:
					!!target.blockPatch?.isConnected &&
					target.blockPatch ===
						document.querySelector("[data-git-staging-preview] [data-git-patch-view]"),
				scroll:
					target.blockScroll ===
					document.querySelector("[data-git-staging-preview] [data-content-scrollport]"),
			};
		}),
	).toEqual({ preview: true, patch: true, scroll: true });
}
async function scrollBlockToUnit(page: Page, id: string) {
	await page.evaluate((unitId) => {
		const data = (window as unknown as FixtureWindow).gitChangesFixture
			.snapshot()
			.network.stagingDiffReads.at(-1);
		const start = data?.unitMappings?.find((mapping) => mapping.unitId === unitId)?.lineRanges[0]
			?.start;
		const viewport = document.querySelector<HTMLElement>(
			"[data-git-staging-preview] [data-content-scrollport]",
		);
		const row = document.querySelector<HTMLElement>("[data-git-staging-preview] [data-diff-row]");
		if (start === undefined || !viewport || !row)
			throw new Error(`Missing mapped preview unit: ${unitId}`);
		viewport.scrollTop = Math.max(0, start - 3) * row.getBoundingClientRect().height;
		viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
	}, id);
	await page.waitForSelector(`[data-git-staging-unit="${id}"][data-inline]`);
	await frames(page);
}
async function waitBlockUnits(page: Page, ids: string[]) {
	await page.waitForFunction(
		(expected) => {
			const last = (window as unknown as FixtureWindow).gitChangesFixture
				.snapshot()
				.network.stagingDiffReads.at(-1);
			return (
				!!document.querySelector("[data-git-staging-preview-writable]") &&
				last?.status === 200 &&
				last.units.map((unit) => unit.id).join() === expected.join()
			);
		},
		{},
		ids,
	);
}
async function expectBlockSelection(page: Page, ids: string[]) {
	await page.waitForFunction(
		(expected) => {
			const selected = [
				...document.querySelectorAll<HTMLInputElement>(
					"[data-git-staging-preview] input[data-git-staging-unit-select]:checked",
				),
			]
				.map((input) => input.dataset.gitStagingUnitSelect)
				.sort();
			return selected.join() === [...expected].sort().join();
		},
		{},
		ids,
	);
	const data = (await snapshot(page)).network.stagingDiffReads.at(-1);
	const expected =
		data?.unitMappings
			?.filter((mapping) => ids.includes(mapping.unitId))
			.flatMap((mapping) =>
				mapping.lineRanges.flatMap(({ start, end }) =>
					Array.from({ length: end - start }, (_, index) => start + index),
				),
			)
			.sort((a, b) => a - b) ?? [];
	expect(
		await page.$$eval("[data-git-staging-preview] [data-diff-selected]", (rows) =>
			rows.map((row) => Number(row.getAttribute("data-diff-line-index"))).sort((a, b) => a - b),
		),
	).toEqual(expected);
}
async function expectBlockDiffBounded(page: Page) {
	const layout = await page.evaluate(() => {
		const preview = document.querySelector("[data-git-staging-preview]");
		const viewport = preview?.querySelector<HTMLElement>("[data-content-scrollport]");
		const rows = [...(preview?.querySelectorAll<HTMLElement>("[data-diff-row]") ?? [])];
		return {
			height: viewport?.clientHeight ?? 0,
			rowHeight: rows[0]?.getBoundingClientRect().height ?? 0,
			rows: rows.length,
			inline: preview?.querySelectorAll("[data-git-staging-unit][data-inline]").length ?? 0,
			fallback:
				preview?.querySelectorAll("[data-git-staging-unit-fallback] [data-git-staging-unit]")
					.length ?? 0,
		};
	});
	expect(layout.height).toBeGreaterThan(0);
	expect(layout.rowHeight).toBeGreaterThan(0);
	expect(layout.rows).toBeLessThanOrEqual(2 * Math.ceil(layout.height / layout.rowHeight) + 12);
	expect(layout.inline).toBeLessThanOrEqual(layout.rows);
	expect(layout.fallback).toBeLessThanOrEqual(12);
}
async function expectStagingBounded(page: Page) {
	const layout = await page.evaluate(() => {
		const list = document.querySelector("[data-git-changelists]");
		const viewport = list?.closest("[data-scrollarea-viewport]");
		return {
			height: viewport?.clientHeight ?? 0,
			mounted: list?.querySelectorAll("[data-git-row-type]").length ?? 0,
		};
	});
	const state = await snapshot(page);
	expect(layout.height).toBeGreaterThan(0);
	expect(layout.mounted).toBeGreaterThan(0);
	expect(layout.mounted).toBeLessThanOrEqual(
		Math.ceil(layout.height / state.rowHeight) + 2 * state.overscan + 2,
	);
}
async function scroll(page: Page, fraction: number) {
	await page.evaluate(
		(position) => (window as unknown as FixtureWindow).gitChangesFixture.scrollTo(position),
		fraction,
	);
	await frames(page);
}
async function loadToEnd(page: Page, worker: WebWorker) {
	const startedAt = performance.now();
	let batchStartedAt = startedAt;
	let stages = { snapshotMs: 0, advanceFramesMs: 0, queryWaitMs: 0, domSnapshotMs: 0 };
	const initial = await snapshot(page);
	const remainingPages = Math.ceil(initial.filteredTotal / 100) - initial.pageCount;
	await page.evaluate(() => (window as unknown as FixtureWindow).gitChangesFixture.startSampling());
	// Automatic pages already count toward the chain; advance the remaining pages through the UI.
	for (let attempt = 0; attempt <= remainingPages; attempt++) {
		pagePhase(page, `pagination:${attempt + 1}:snapshot`);
		let stageStartedAt = performance.now();
		const before = await snapshot(page);
		stages.snapshotMs += performance.now() - stageStartedAt;
		if (!before.hasMore) {
			pagePhase(page, "pagination:stop-sampling");
			const pagingSample = await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.stopSampling(),
			);
			console.info(
				"Git changes pagination complete",
				JSON.stringify({
					elapsedMs: performance.now() - startedAt,
					state: compactSnapshot(before),
					frames: pagingSample.frames.length,
					maxFrameGapMs: pagingSample.maxFrameGapMs,
					longTaskCount: pagingSample.longTasks.length,
					longTasks: pagingSample.longTasks.slice(-12),
				}),
			);
			return;
		}
		pagePhase(page, `pagination:${attempt + 1}:advance-frames`);
		stageStartedAt = performance.now();
		await page.evaluate(() => (window as unknown as FixtureWindow).gitChangesFixture.advance());
		stages.advanceFramesMs += performance.now() - stageStartedAt;
		pagePhase(page, `pagination:${attempt + 1}:query-wait`);
		stageStartedAt = performance.now();
		await page.waitForFunction(
			(loaded) => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.loaded > loaded || !state.hasMore;
			},
			{},
			before.loaded,
		);
		stages.queryWaitMs += performance.now() - stageStartedAt;
		pagePhase(page, `pagination:${attempt + 1}:dom-snapshot`);
		stageStartedAt = performance.now();
		const after = await snapshot(page);
		stages.domSnapshotMs += performance.now() - stageStartedAt;
		expectBounded(after);
		if ((attempt + 1) % 10 === 0 || !after.hasMore) {
			pagePhase(page, `pagination:${attempt + 1}:worker-diagnostics`);
			const workerState = await worker.evaluate(() => {
				const probe = (self as unknown as WorkerScope).__gitBrowserProbe;
				return probe
					? {
							counts: probe.counts,
							maxDurationMs: probe.maxDurationMs,
							recentRequests: probe.requests.slice(-8),
							lastResponse: probe.responses.at(-1),
						}
					: null;
			});
			const progress = activePageProgress.get(page);
			if (progress) progress.worker = workerState;
			console.info(
				"Git changes pagination progress",
				JSON.stringify({
					iteration: attempt + 1,
					elapsedMs: performance.now() - startedAt,
					batchElapsedMs: performance.now() - batchStartedAt,
					stages,
					state: compactSnapshot(after),
					worker: workerState,
				}).slice(0, 10_000),
			);
			batchStartedAt = performance.now();
			stages = { snapshotMs: 0, advanceFramesMs: 0, queryWaitMs: 0, domSnapshotMs: 0 };
		}
	}
	throw new Error(
		`Git changes pagination did not reach its final page within ${remainingPages} remaining pages`,
	);
}
async function instrumentWorker(worker: WebWorker) {
	return worker.evaluate(() => {
		const scope = self as unknown as WorkerScope;
		const probe: WorkerProbe = { requests: [], responses: [], counts: {}, maxDurationMs: 0 };
		scope.__gitBrowserProbe = probe;
		const nativeHandler = scope.onmessage;
		if (typeof nativeHandler !== "function") throw new Error("Git Worker handler is unavailable");
		scope.onmessage = (event: MessageEvent) => {
			const data = event.data as {
				type: string;
				generation: string;
				pages?: Array<{ files: unknown[] }>;
			};
			const startedAt = performance.now();
			try {
				nativeHandler.call(self, event);
			} finally {
				const durationMs = performance.now() - startedAt;
				probe.counts[data.type] = (probe.counts[data.type] ?? 0) + 1;
				probe.maxDurationMs = Math.max(probe.maxDurationMs, durationMs);
				probe.requests.push({
					type: data.type,
					generation: data.generation,
					appendedFiles: data.pages?.reduce((count, page) => count + page.files.length, 0) ?? 0,
					durationMs,
				});
				if (probe.requests.length > 512) probe.requests.shift();
			}
		};
		const nativePostMessage = scope.postMessage.bind(scope);
		scope.postMessage = (message, transfer) => {
			const data = message as {
				type: string;
				generation: string;
				window?: { rows: unknown[]; totalRows: number; loadedFiles: number };
			};
			const responseType = `response:${data.type}`;
			probe.counts[responseType] = (probe.counts[responseType] ?? 0) + 1;
			probe.responses.push({
				type: data.type,
				generation: data.generation,
				rows: data.window?.rows.length ?? 0,
				totalRows: data.window?.totalRows ?? 0,
				loadedFiles: data.window?.loadedFiles ?? 0,
			});
			if (probe.responses.length > 512) probe.responses.shift();
			if (transfer) nativePostMessage(message, transfer);
			else nativePostMessage(message);
		};
		return { handler: typeof scope.onmessage, document: typeof scope.document };
	});
}

async function gateConfigureResponses(worker: WebWorker) {
	await worker.evaluate(() => {
		const scope = self as unknown as WorkerScope;
		const nativeHandler = scope.onmessage;
		if (typeof nativeHandler !== "function") throw new Error("Git Worker handler is unavailable");
		const nativePostMessage = scope.postMessage.bind(scope);
		const gate: ConfigureGate = {
			holding: false,
			held: [],
			configureIds: [],
			commands: [],
			release(latestOnly = false) {
				if (latestOnly) {
					const response = gate.held.pop();
					if (!response) throw new Error("Missing latest configure response");
					nativePostMessage(response);
					return;
				}
				gate.holding = false;
				for (const response of gate.held.splice(0)) nativePostMessage(response);
			},
		};
		scope.__gitConfigureGate = gate;
		scope.onmessage = (event: MessageEvent<GitChangesWorkerRequest>) => {
			const request = event.data;
			if (request.type === "configure") {
				gate.holding = true;
				gate.configureIds.push(request.id);
			}
			if (gate.commands.length >= 512) throw new Error("Git configure probe exceeded its budget");
			gate.commands.push({
				type: request.type,
				generation: request.generation,
				epoch: "source" in request ? request.source.epoch : null,
			});
			nativeHandler.call(self, event);
		};
		scope.postMessage = (message, transfer) => {
			const response = message as GitChangesWorkerResponse;
			if (gate.holding && response.type === "window") {
				if (gate.held.length >= 64)
					throw new Error("Git configure response gate exceeded its budget");
				gate.held.push(response);
				return;
			}
			if (transfer) nativePostMessage(message, transfer);
			else nativePostMessage(message);
		};
	});
}

async function waitForConfigure(worker: WebWorker, count: number) {
	await worker.evaluate(async (expected) => {
		const deadline = performance.now() + 5_000;
		for (;;) {
			const gate = (self as unknown as WorkerScope).__gitConfigureGate;
			if (gate && gate.configureIds.length >= expected && gate.held.length > 0) return;
			if (performance.now() >= deadline) throw new Error("Missing gated Git configure response");
			await new Promise((done) => setTimeout(done, 5));
		}
	}, count);
}

async function releaseConfigure(worker: WebWorker, latestOnly = false) {
	await worker.evaluate((latest) => {
		const gate = (self as unknown as WorkerScope).__gitConfigureGate;
		if (!gate) throw new Error("Missing Git configure gate");
		gate.release(latest);
	}, latestOnly);
}

async function toggleDirectory(page: Page, path: string) {
	await page.evaluate((directory) => {
		const row = [...document.querySelectorAll<HTMLElement>('[data-git-row-type="directory"]')].find(
			(element) => element.dataset.gitRowPath === directory,
		);
		const toggle = row?.querySelector<HTMLElement>("[aria-expanded]");
		if (!toggle) throw new Error(`Missing mounted Git directory: ${directory}`);
		toggle.click();
	}, path);
}

async function visibleTreeAnchor(page: Page) {
	return page.evaluate(() => {
		const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
		if (!viewport) throw new Error("Missing Git tree viewport");
		const bounds = viewport.getBoundingClientRect();
		const row = [...document.querySelectorAll<HTMLElement>("[data-git-change-row]")].find(
			(element) =>
				element.getBoundingClientRect().bottom > bounds.top &&
				element.getBoundingClientRect().top < bounds.bottom,
		);
		if (!row) throw new Error("Missing visible Git tree anchor");
		return { key: row.dataset.gitChangeRow, top: row.getBoundingClientRect().top - bounds.top };
	});
}

async function expectConfigureHeld(page: Page, before: FixtureSnapshot) {
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).gitChangesFixture.startContinuity(),
	);
	await frames(page, 12);
	const samples = await page.evaluate(() =>
		(window as unknown as FixtureWindow).gitChangesFixture.stopContinuity(),
	);
	expect(samples.filter((sample) => sample.kind === "frame").length).toBeGreaterThanOrEqual(12);
	for (const sample of samples) {
		expect(sample.rows).toEqual(before.display.rows);
		expect(sample.scrollTop).toBe(before.scrollTop);
		expect(sample.scrollHeight).toBe(before.scrollHeight);
		expect(sample.refreshing).toBe(false);
	}
	const state = await snapshot(page);
	expect(state.snapshotIds).toEqual(before.snapshotIds);
	expect(state.network.requests).toEqual(before.network.requests);
	expect(state.network.statsRequestCount).toBe(before.network.statsRequestCount);
	expect(state.display.actions.length).toBeGreaterThan(0);
	expect(state.display.actions.every((action) => action.disabled)).toBe(true);
	const attempted = await page.evaluate(() =>
		(window as unknown as FixtureWindow).gitChangesFixture.attemptListActions(),
	);
	expect(attempted.allDisabled).toBe(true);
	expect((await snapshot(page)).network.mutations).toEqual([]);
}

async function holdNextPage(page: Page) {
	await page.evaluate(async () => {
		const current = (window as unknown as FixtureWindow).gitChangesFixture;
		current.holdNextPage();
		await current.advance();
	});
	await page.waitForFunction(
		() =>
			(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pending.length ===
			1,
	);
	const state = await snapshot(page);
	expect(state.hasMore).toBe(true);
	return state.network.pending[0];
}
async function releaseHeld(page: Page, id: number) {
	await page.evaluate(() => (window as unknown as FixtureWindow).gitChangesFixture.releaseHeld());
	await page.waitForFunction(
		(requestId) => {
			const request = (window as unknown as FixtureWindow).gitChangesFixture
				.snapshot()
				.network.requests.find((entry) => entry.id === requestId);
			return request?.settled === true;
		},
		{},
		id,
	);
	await frames(page, 5);
	const request = (await snapshot(page)).network.requests.find((entry) => entry.id === id);
	expect(request?.aborted).toBe(true);
}

async function waitForMeasuredRows(page: Page) {
	await page.waitForFunction(() => {
		const display = (window as unknown as FixtureWindow).gitChangesFixture.snapshot().display;
		return display.rows.length > 0 && display.rows.every((row) => row.measurements.length === 2);
	});
}

async function refreshPresentation(page: Page) {
	return page.evaluate(() => {
		const button = document.querySelector<HTMLElement>('[data-testid="git-changes-refresh"]');
		const icon = button?.querySelector("svg");
		const header = button?.parentElement;
		const filter = document.querySelector("[data-git-status-filter]")?.closest('[role="group"]');
		if (!button || !icon || !header || !filter) throw new Error("Missing Git refresh controls");
		const style = getComputedStyle(icon);
		const buttonRect = button.getBoundingClientRect();
		return {
			refreshing: button.dataset.refreshing,
			button: {
				x: buttonRect.x,
				y: buttonRect.y,
				width: buttonRect.width,
				height: buttonRect.height,
			},
			buttonAnimation: getComputedStyle(button).animationName,
			animationName: style.animationName,
			animationDuration: style.animationDuration,
			animationTiming: style.animationTimingFunction,
			animationIterations: style.animationIterationCount,
			transform: style.transform,
			animations: icon.getAnimations().map((animation) => ({
				playState: animation.playState,
				currentTime: Number(animation.currentTime),
			})),
			headerBottom: header.getBoundingClientRect().bottom,
			filterTop: filter.getBoundingClientRect().top,
			statuses: [...document.querySelectorAll<HTMLElement>('[role="status"]')]
				.filter((element) => element.textContent === "Updating…")
				.map((element) => {
					const rect = element.getBoundingClientRect();
					const statusStyle = getComputedStyle(element);
					return {
						text: element.textContent,
						width: rect.width,
						height: rect.height,
						position: statusStyle.position,
						overflow: statusStyle.overflow,
						hidden: element.getAttribute("aria-hidden"),
					};
				}),
		};
	});
}

async function rangeLayout(page: Page) {
	return page.evaluate(() => {
		const panel = document.querySelector<HTMLElement>("[data-git-native-view]");
		const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
		if (!panel || !viewport) throw new Error("Missing Git panel viewport");
		const controls = panel.querySelector<HTMLElement>('[data-testid="git-changes-range-controls"]');
		let scrollRoot: HTMLElement | null = viewport;
		while (scrollRoot && scrollRoot.parentElement !== panel) scrollRoot = scrollRoot.parentElement;
		if (!scrollRoot) throw new Error("Git ScrollArea is not a direct panel child");
		const panelRect = panel.getBoundingClientRect();
		const viewportRect = viewport.getBoundingClientRect();
		const footerRect = controls?.getBoundingClientRect();
		const button = controls?.querySelector("button");
		const buttonRect = button?.getBoundingClientRect();
		return {
			panelBottom: panelRect.bottom,
			viewportBottom: viewportRect.bottom,
			viewportHeight: viewportRect.height,
			scrollTop: viewport.scrollTop,
			footer:
				controls && footerRect && button && buttonRect
					? {
							label: button.textContent,
							top: footerRect.top,
							bottom: footerRect.bottom,
							height: footerRect.height,
							centerOffset:
								buttonRect.x + buttonRect.width / 2 - (panelRect.x + panelRect.width / 2),
							outsideViewport: !viewport.contains(controls),
							afterScrollArea: scrollRoot.nextElementSibling === controls,
							directChild: controls.parentElement === panel,
							buttonHeight: buttonRect.height,
						}
					: null,
		};
	});
}

async function expectRangeFooter(page: Page, label: string) {
	const layout = await rangeLayout(page);
	if (!layout.footer) throw new Error(`Missing Git range footer: ${label}`);
	expect(layout.footer.label).toBe(label);
	expect(layout.footer.outsideViewport).toBe(true);
	expect(layout.footer.afterScrollArea).toBe(true);
	expect(layout.footer.directChild).toBe(true);
	expect(Math.abs(layout.footer.centerOffset)).toBeLessThanOrEqual(1);
	expect(layout.footer.buttonHeight).toBeGreaterThan(0);
	expect(layout.footer.top).toBeGreaterThanOrEqual(layout.viewportBottom - 1);
	expect(Math.abs(layout.footer.bottom - layout.panelBottom)).toBeLessThanOrEqual(1);
	return layout;
}

async function expectHeldDisplay(page: Page, before: FixtureSnapshot["display"]) {
	await frames(page, 12);
	const state = await snapshot(page);
	expectBounded(state);
	expect(state.display.rows).toEqual(before.rows);
	expect(state.display.sectionCounts).toEqual(before.sectionCounts);
	expect(state.display.busy).toBe(true);
	expect(state.display.refreshing).toBe(true);
	expect(state.display.actions.length).toBeGreaterThan(0);
	expect(state.display.actions.every((action) => action.disabled)).toBe(true);
	const attempted = await page.evaluate(() =>
		(window as unknown as FixtureWindow).gitChangesFixture.attemptListActions(),
	);
	expect(attempted.attempted).toBeGreaterThan(0);
	expect(attempted.allDisabled).toBe(true);
	await frames(page);
	expect((await snapshot(page)).network.mutations).toEqual([]);
}

async function expectNoPriorPaths(page: Page) {
	await frames(page, 12);
	expect(
		await page.evaluate(() =>
			document.querySelector("[data-git-browser-fixture]")?.innerHTML.includes("revision-0"),
		),
	).toBe(false);
	expect((await snapshot(page)).network.mutations).toEqual([]);
}

async function waitForCurrentTree(page: Page) {
	await page.waitForFunction(() => {
		const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
		return (
			!state.display.busy &&
			state.display.rows.length > 0 &&
			state.display.rows.every((row) => row.measurements.length === 2) &&
			state.network.statsRequests.every((request) => request.settled)
		);
	});
	await frames(page, 3);
}

async function expectTreeRange(page: Page, complete: boolean) {
	if (complete) expect((await rangeLayout(page)).footer).toBeNull();
	else await expectRangeFooter(page, "Load complete range");
}

async function stagingRefreshPresentation(page: Page) {
	return page.evaluate(() => {
		const button = document.querySelector<HTMLButtonElement>("[data-git-staging-refresh]");
		const icon = button?.querySelector("svg");
		if (!button || !icon) throw new Error("Missing staging refresh control");
		const rect = button.getBoundingClientRect();
		return {
			disabled: button.disabled,
			loading: button.hasAttribute("data-loading"),
			button: {
				x: button.offsetLeft,
				y: button.offsetTop,
				width: button.offsetWidth,
				height: button.offsetHeight,
			},
			bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			buttonAnimation: getComputedStyle(button).animationName,
			buttonTransform: getComputedStyle(button).transform,
			iconAnimation: getComputedStyle(icon).animationName,
			iconTransform: getComputedStyle(icon).transform,
			iconAnimations: icon.getAnimations().map((animation) => ({
				currentTime: Number(animation.currentTime),
				playState: animation.playState,
			})),
		};
	});
}

test.each([
	false,
	true,
])("staging layout refresh rotates only its icon with reduced motion %s", async (reducedMotion) => {
	await withPage(
		async (page) => {
			await page.emulateMediaFeatures([
				{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
			]);
			await page.click("aria/ChangeLists");
			await page.waitForSelector('[data-git-staging-observation="settled"]');
			const before = await stagingRefreshPresentation(page);
			await page.evaluate(async () => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdStagingSync();
				await current.observationControl("hold-sync");
			});
			await page.click("[data-git-staging-refresh]");
			await page.waitForSelector('[data-git-staging-observation="observing"]');
			await page.waitForSelector("[data-git-staging-refresh][data-loading]");
			const busy = await stagingRefreshPresentation(page);
			await page.evaluate(() => {
				const button = document.querySelector<HTMLButtonElement>("[data-git-staging-refresh]");
				button?.click();
				button?.click();
				(window as unknown as FixtureWindow).gitChangesFixture.releaseStagingSync();
			});
			await page.waitForSelector("[data-git-staging-refresh][data-loading]", { hidden: true });
			await frames(page, 4);
			const observing = await stagingRefreshPresentation(page);
			await frames(page, 6);
			const advanced = await stagingRefreshPresentation(page);
			if (reducedMotion) {
				await page.emulateMediaFeatures([
					{ name: "prefers-reduced-motion", value: "no-preference" },
				]);
				await frames(page, 4);
				const resumed = await stagingRefreshPresentation(page);
				expect(resumed.iconAnimation).not.toBe("none");
				expect(resumed.iconAnimations).toHaveLength(1);
				expect(resumed.buttonAnimation).toBe("none");
				expect(resumed.bounds).toEqual(before.bounds);
				await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
				await frames(page, 4);
				expect((await stagingRefreshPresentation(page)).iconAnimations).toEqual([]);
			}
			const requests = (await snapshot(page)).network;
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
					status: "settled",
				}),
			);
			await page.waitForSelector('[data-git-staging-observation="settled"]');
			await frames(page, 4);
			const finished = await stagingRefreshPresentation(page);
			console.info(
				"Staging refresh geometry",
				JSON.stringify({
					reducedMotion,
					before,
					busy,
					observing,
					advanced,
					finished,
					requests: requests.stagingActionRequests.map((action) => action.action),
				}),
			);
			expect(busy.disabled).toBe(true);
			expect(busy.loading).toBe(true);
			expect(observing.disabled).toBe(false);
			expect(observing.loading).toBe(false);
			expect(observing.button).toEqual(before.button);
			expect(finished.button).toEqual(before.button);
			expect(requests.stagingActionRequests.map((action) => action.action)).toEqual(["sync"]);
			expect(observing.buttonAnimation).toBe("none");
			expect(observing.buttonTransform).toBe("none");
			expect(observing.bounds).toEqual(before.bounds);
			if (reducedMotion) {
				expect(observing.iconAnimation).toBe("none");
				expect(observing.iconAnimations).toEqual([]);
			} else {
				expect(observing.iconAnimation).not.toBe("none");
				expect(observing.iconAnimations).toHaveLength(1);
				expect(advanced.iconTransform).not.toBe(observing.iconTransform);
			}
			expect(finished.disabled).toBe(false);
			expect(finished.buttonAnimation).toBe("none");
			expect(finished.iconAnimation).toBe("none");
			expect(finished.iconAnimations).toEqual([]);
		},
		"flat",
		{ total: 12, staging: true, canWrite: true, width: 460 },
	);
}, 40_000);

test("staging layout paths preserve visible filenames across panel widths and view modes", async () => {
	const measurements: Array<{
		width: number;
		mode: string;
		rows: Array<{
			path: string;
			text: string;
			title: string | null;
			width: number;
			lineClamp: string;
			whiteSpace: string;
			visible: string;
			unused: number;
			height: number;
			actionsVisible: boolean;
			stats: string[];
			overflow: boolean;
		}>;
	}> = [];
	for (const width of [390, 460, 760]) {
		await withPage(
			async (page) => {
				await page.click("aria/ChangeLists");
				await page.waitForSelector('[data-git-staging-observation="settled"]');
				await page.waitForSelector('[data-git-staging-toggle="A"]');
				await page.click('[data-git-staging-toggle="A"]');
				await page.click("aria/List");
				await page.waitForFunction(
					() => document.querySelectorAll("[data-git-staging-file]").length === 4,
				);
				for (const mode of ["flat", "tree"]) {
					if (mode === "tree") {
						await page.click("aria/Tree");
						for (const path of [
							"remote-executor/internal/handlers",
							"remoteexecutor/internal/handlers",
							"服务端/变更分组/处理程序",
							"src",
						]) {
							await page.waitForSelector(`[data-git-staging-directory="${path}"]`);
							await page.click(`[data-git-staging-directory="${path}"]`);
						}
						await page.waitForFunction(
							() => document.querySelectorAll("[data-git-staging-file]").length === 4,
						);
					}
					await frames(page);
					const rows = await page.$$eval("[data-git-staging-file]", (elements) =>
						elements.map((row) => {
							const path = row.getAttribute("data-git-staging-file") ?? "";
							const text = [...row.querySelectorAll<HTMLElement>("[title]")].find((element) =>
								element.getAttribute("title")?.endsWith(path),
							);
							if (!text) throw new Error(`Missing path text: ${path}`);
							const rect = text.getBoundingClientRect();
							const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
							let visible = "";
							let lastRight = rect.left;
							for (let node = walker.nextNode(); node; node = walker.nextNode()) {
								for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
									const range = document.createRange();
									range.setStart(node, index);
									range.setEnd(node, index + 1);
									const glyph = range.getBoundingClientRect();
									if (
										glyph.top >= rect.top - 1 &&
										glyph.bottom <= rect.bottom + 1 &&
										glyph.left >= rect.left - 1 &&
										glyph.right <= rect.right + 1
									) {
										visible += node.textContent?.[index] ?? "";
										lastRight = Math.max(lastRight, glyph.right);
									}
								}
							}
							const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
							return {
								path,
								text: text.textContent ?? "",
								title: text.title,
								width: rect.width,
								lineClamp: getComputedStyle(text).webkitLineClamp,
								whiteSpace: getComputedStyle(text).whiteSpace,
								visible,
								unused: rect.right - lastRight,
								height: row.getBoundingClientRect().height,
								actionsVisible: buttons.every((button) => {
									const bounds = button.getBoundingClientRect();
									return bounds.width > 0 && bounds.right <= innerWidth && bounds.left >= 0;
								}),
								stats: [...row.querySelectorAll("p")]
									.map((element) => element.textContent ?? "")
									.filter((value) => /^[+-]\d+$/.test(value)),
								overflow: document.documentElement.scrollWidth > innerWidth,
							};
						}),
					);
					measurements.push({ width, mode, rows });
				}
			},
			"flat",
			{ total: 12, staging: true, stagingPaths: true, canWrite: true, width },
		);
	}
	console.info("Staging path geometry", JSON.stringify(measurements));
	for (const measurement of measurements) {
		expect(measurement.rows.map((row) => row.path).sort()).toEqual(
			[...GIT_BROWSER_STAGING_PATHS].sort(),
		);
		for (const row of measurement.rows) {
			expect(row.height).toBe(30);
			expect(row.actionsVisible).toBe(true);
			expect(row.overflow).toBe(false);
			expect(row.stats).toEqual(["+17", "-9"]);
			expect(row.title).toBe(
				row.path.startsWith("服务端/") ? `旧目录/原文件名.go → ${row.path}` : row.path,
			);
			expect(row.visible).toContain(row.path.split("/").at(-1) ?? "");
			expect(row.whiteSpace).toBe("nowrap");
		}
	}
}, 90_000);

test.each([
	[460, 1, false],
	[760, 1, false],
	[390, 1.25, false],
	[460, 1, true],
] as const)(
	"staging layout diff matches ordinary code geometry at %ipx and %s zoom with changed typography %s",
	async (width, zoom, changedTypography) => {
		await withPage(
			async (page) => {
				await page.evaluate((scale) => {
					document.documentElement.style.zoom = String(scale);
				}, zoom);
				await openBlockPreview(page);
				if (changedTypography) {
					await page.evaluate(() =>
						(window as unknown as FixtureWindow).gitChangesFixture.setTypography({
							fontScalePercent: 125,
							lineHeightScalePercent: 125,
						}),
					);
					await page.waitForFunction(() => {
						const row = document.querySelector("[data-git-staging-preview] [data-diff-row]");
						return (
							row &&
							Number.parseFloat(getComputedStyle(row).fontSize) > 11 &&
							Number.parseFloat(getComputedStyle(row).lineHeight) > 18
						);
					});
				}
				await page.evaluate(() => {
					const patch = document.querySelector<HTMLElement>(
						"[data-git-staging-preview] [data-git-patch-view]",
					);
					if (!patch) throw new Error("Missing staging patch geometry");
					(window as unknown as FixtureWindow).gitChangesFixture.showOrdinaryPatch(
						patch.getBoundingClientRect().width / Number(document.documentElement.style.zoom || 1),
					);
				});
				await page.waitForSelector("[data-git-ordinary-comparison] [data-diff-row]");
				await frames(page, 8);
				const geometry = await page.evaluate(() => {
					function read(selector: string) {
						return [...document.querySelectorAll<HTMLElement>(`${selector} [data-diff-row]`)].map(
							(row) => {
								const rect = row.getBoundingClientRect();
								const visuals = [...row.querySelectorAll<HTMLElement>("[data-diff-visual-line]")];
								return {
									index: Number(row.dataset.diffLineIndex),
									type: row.dataset.diffRow,
									height: rect.height,
									top: rect.top,
									text: visuals.map((line) => line.textContent).join(""),
									visualHeights: visuals.map((line) => line.getBoundingClientRect().height),
									font: getComputedStyle(row).font,
									lineHeight: getComputedStyle(row).lineHeight,
									anchor: !!row.querySelector("[data-git-staging-unit]"),
									controls: [
										...row.querySelectorAll<HTMLElement>(
											"[data-git-staging-unit], [data-git-staging-unit] button, [data-git-staging-unit] input",
										),
									].map((control) => ({
										height: control.getBoundingClientRect().height,
										top: control.getBoundingClientRect().top - rect.top,
										bottom: control.getBoundingClientRect().bottom - rect.bottom,
									})),
								};
							},
						);
					}
					return {
						scale: window.devicePixelRatio,
						stagingWidth: document
							.querySelector("[data-git-staging-preview] [data-git-patch-view]")
							?.getBoundingClientRect().width,
						ordinaryWidth: document
							.querySelector("[data-git-ordinary-comparison] [data-git-patch-view]")
							?.getBoundingClientRect().width,
						staging: read("[data-git-staging-preview]"),
						ordinary: read("[data-git-ordinary-comparison]"),
					};
				});
				console.info(
					"Staging diff geometry",
					JSON.stringify({
						width,
						zoom,
						scale: geometry.scale,
						stagingWidth: geometry.stagingWidth,
						ordinaryWidth: geometry.ordinaryWidth,
						font: geometry.staging[0]?.font,
						staging: geometry.staging.map(({ index, type, height, anchor, controls }) => ({
							index,
							type,
							height,
							anchor,
							controls,
						})),
						ordinary: geometry.ordinary.map(({ index, height }) => ({ index, height })),
					}),
				);
				expect(geometry.stagingWidth).toBe(geometry.ordinaryWidth);
				expect(geometry.staging.length).toBe(14);
				expect(geometry.ordinary.length).toBe(14);
				expect(geometry.staging.filter((row) => row.anchor).map((row) => row.index)).toEqual([
					1, 5, 7, 8,
				]);
				expect(geometry.staging.slice(9, 12).map((row) => row.text)).toEqual(["", " ", "\t"]);
				expect(geometry.staging.map((row) => row.text)).toEqual(
					geometry.ordinary.map((row) => row.text),
				);
				for (const row of geometry.staging) {
					const ordinary = geometry.ordinary.find((candidate) => candidate.index === row.index);
					if (!ordinary) throw new Error(`Missing ordinary diff row ${row.index}`);
					expect(row.text).toBe(ordinary.text);
					expect(row.font).toBe(ordinary.font);
					expect(row.lineHeight).toBe(ordinary.lineHeight);
					expect(row.visualHeights).toHaveLength(ordinary.visualHeights.length);
					for (let index = 0; index < row.visualHeights.length; index++)
						expect(row.visualHeights[index]).toBeCloseTo(ordinary.visualHeights[index], 3);
					expect(row.height).toBeCloseTo(ordinary.height, 3);
					for (const control of row.controls) {
						expect(control.top).toBeGreaterThanOrEqual(-0.5);
						expect(control.bottom).toBeLessThanOrEqual(0.5);
					}
				}
			},
			"tree",
			{ total: 12, staging: true, canWrite: true, blockMove: "geometry", width },
		);
	},
	40_000,
);

test.each([
	false,
	true,
])("staging layout inline actions keep adjacent rows independent with touch %s", async (touch) => {
	await withPage(
		async (page) => {
			if (touch) await page.setViewport({ width: 390, height: 760, hasTouch: true });
			await openBlockPreview(page);
			await page.waitForFunction(() => {
				const dialog = document
					.querySelector("[data-git-staging-preview]")
					?.closest('[role="dialog"]');
				if (!dialog) return false;
				const style = getComputedStyle(dialog);
				return style.opacity === "1" && new DOMMatrixReadOnly(style.transform).isIdentity;
			});
			await page.waitForSelector('[data-git-staging-unit="block-3"][data-inline]', {
				visible: true,
			});
			const targets = await page.evaluate(() =>
				[...document.querySelectorAll<HTMLElement>("[data-git-staging-unit][data-inline]")].map(
					(unit) => {
						const row = unit.closest<HTMLElement>("[data-diff-row]");
						if (!row) throw new Error("Missing unit row");
						const bounds = row.getBoundingClientRect();
						return {
							id: unit.dataset.gitStagingUnit,
							height: bounds.height,
							hits: [...unit.querySelectorAll<HTMLElement>("input, button")].flatMap((control) => {
								const rect = control.getBoundingClientRect();
								return [rect.top + 1, rect.bottom - 1].map(
									(y) =>
										document
											.elementFromPoint(rect.x + rect.width / 2, y)
											?.closest<HTMLElement>("[data-git-staging-unit]")?.dataset.gitStagingUnit ??
										null,
								);
							}),
						};
					},
				),
			);
			console.info("Staging inline action hit geometry", JSON.stringify({ touch, targets }));
			expect(targets).toHaveLength(4);
			for (const target of targets) {
				expect(target.height).toBe(18);
				expect(target.hits).toHaveLength(6);
				expect(target.hits.every((id) => id === target.id)).toBe(true);
			}
			const select = 'input[data-git-staging-unit-select="block-2"]';
			const adjacent = 'input[data-git-staging-unit-select="block-3"]';
			if (touch) await page.tap(select);
			else {
				await page.focus(select);
				await page.keyboard.press("Space");
			}
			await expectBlockSelection(page, ["block-2"]);
			if (touch) await page.tap(adjacent);
			else await page.click(adjacent);
			await expectBlockSelection(page, ["block-2", "block-3"]);
			const menu = '[data-git-staging-unit="block-2"][data-inline] [data-git-staging-unit-menu]';
			if (touch) await page.tap(menu);
			else {
				await page.focus(menu);
				await page.keyboard.press("Enter");
			}
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="C"]');
			// Mantine's focus trap moves focus into the dropdown on a timer; an Escape that lands
			// before it closes the menu with focus lost to <body>, so the next Enter does nothing.
			await page.waitForFunction(() =>
				document.activeElement?.closest("[data-git-staging-unit-targets]"),
			);
			await page.keyboard.press("Escape");
			await page.waitForSelector("[data-git-staging-unit-targets]", { hidden: true });
			await page.waitForFunction((trigger) => document.activeElement?.matches(trigger), {}, menu);
			expect((await snapshot(page)).network.stagingActionRequests).toEqual([]);
			if (touch) await page.tap(menu);
			else await page.keyboard.press("Enter");
			const destination = '[data-git-staging-unit-targets] [data-git-staging-target="C"]';
			await page.waitForSelector(destination);
			if (touch) await page.tap(destination);
			else {
				await page.focus(destination);
				await page.keyboard.press("Enter");
			}
			await waitBlockUnits(page, ["block-0", "block-1", "block-3"]);
			await expectBlockSelection(page, ["block-3"]);
			await expectBlockPreviewRetained(page);
			const direct = 'button[data-git-staging-unit-active="block-1"]';
			if (touch) await page.tap(direct);
			else {
				await page.focus(direct);
				await page.keyboard.press("Enter");
			}
			await waitBlockUnits(page, ["block-0", "block-3"]);
			await expectBlockSelection(page, ["block-3"]);
			const requests = (await snapshot(page)).network.stagingActionRequests;
			expect(
				requests
					.filter((action) => action.action === "move")
					.map((action) =>
						action.action === "move" ? { ids: action.unitIds, destination: action.toListId } : null,
					),
			).toEqual([
				{ ids: ["block-2"], destination: "C" },
				{ ids: ["block-1"], destination: "B" },
			]);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "geometry", width: touch ? 390 : 460 },
	);
}, 40_000);

test.each([
	120, 2_300,
])("directory count badges stay stable on every natural and held configure frame for %i files", async (total) => {
	await withPage(
		async (page, workers) => {
			const worker = workers.find((entry) => entry.url().includes("git-changes-list.worker"));
			if (!worker) throw new Error("Directory counts require the real Git module Worker");
			await waitForCurrentTree(page);
			const initial = await snapshot(page);
			const complete = !initial.hasMore;
			expect(initial.loaded).toBe(complete ? total : 1_000);
			const rootPath = initial.directories[0];
			if (!rootPath) throw new Error("Missing root directory");
			expect(initial.display.directoryCounts.find((row) => row.path === rootPath)?.count).toBe(
				complete ? "120" : "1000+",
			);
			let configureCount = 0;
			const observations: Array<{
				path: string;
				expanded: boolean;
				held: boolean;
				expected: string;
				heldAt: number | undefined;
				releaseAt: number | undefined;
				samples: ReturnType<typeof fixture.stopContinuity>;
			}> = [];
			async function observeToggle(path: string, expanded: boolean, held = false) {
				const before = await snapshot(page);
				const expected = before.display.directoryCounts.find((row) => row.path === path)?.count;
				if (!expected) throw new Error(`Missing count badge: ${path}`);
				expect(expected.endsWith("+")).toBe(!complete);
				await page.evaluate(() =>
					(window as unknown as FixtureWindow).gitChangesFixture.startContinuity(),
				);
				await toggleDirectory(page, path);
				let heldAt: number | undefined;
				let releaseAt: number | undefined;
				if (held) {
					await waitForConfigure(worker as WebWorker, ++configureCount);
					const pending = await snapshot(page);
					heldAt = pending.display.at;
					expect(pending.display.actions.length).toBeGreaterThan(0);
					expect(pending.display.actions.every((action) => action.disabled)).toBe(true);
					const attempted = await page.evaluate(() =>
						(window as unknown as FixtureWindow).gitChangesFixture.attemptListActions(),
					);
					expect(attempted.allDisabled).toBe(true);
					await frames(page, 6);
					releaseAt = (await snapshot(page)).display.at;
					await releaseConfigure(worker as WebWorker);
				}
				await page.waitForFunction(
					({ path, expanded }) =>
						[...document.querySelectorAll<HTMLElement>('[data-git-row-type="directory"]')]
							.find((row) => row.dataset.gitRowPath === path)
							?.querySelector("[aria-expanded]")
							?.getAttribute("aria-expanded") === String(expanded),
					{},
					{ path, expanded },
				);
				await waitForCurrentTree(page);
				const samples = await page.evaluate(() =>
					(window as unknown as FixtureWindow).gitChangesFixture.stopContinuity(),
				);
				expect(samples.some((sample) => sample.kind === "mutation")).toBe(true);
				expect(samples.some((sample) => sample.kind === "frame")).toBe(true);
				for (const sample of samples) {
					expect(sample.directoryCounts.find((row) => row.path === path)?.count).toBe(expected);
					expect(sample.directoryCounts.every((row) => row.count.endsWith("+") === !complete)).toBe(
						true,
					);
					if (complete)
						expect(sample.directoryCounts.every((row) => row.title === null)).toBe(true);
					expect(sample.sectionCounts).toEqual(before.display.sectionCounts);
					expect(sample.sectionNodeIds).toEqual(before.display.sectionNodeIds);
					expect(sample.pageRequests).toBe(before.network.requests.length);
					expect(sample.snapshotIds).toEqual(before.snapshotIds);
				}
				if (heldAt !== undefined && releaseAt !== undefined) {
					const pendingFrames = samples.filter(
						(sample) => sample.kind === "frame" && sample.at >= heldAt && sample.at <= releaseAt,
					);
					expect(pendingFrames.length).toBeGreaterThanOrEqual(5);
					expect(
						pendingFrames.every(
							(sample) =>
								sample.actions.length > 0 && sample.actions.every((action) => action.disabled),
						),
					).toBe(true);
				}
				const after = await snapshot(page);
				expect(after.network.requests).toEqual(before.network.requests);
				expect(after.network.mutations).toEqual([]);
				expect(after.display.directoryCounts.length).toBeGreaterThan(0);
				expect(after.display.directoryCounts.every((row) => row.actionDisabled === !complete)).toBe(
					true,
				);
				observations.push({ path, expanded, held, expected, heldAt, releaseAt, samples });
			}
			await observeToggle(rootPath, true);
			await observeToggle(rootPath, false);
			await toggleDirectory(page, rootPath);
			await page.waitForFunction(
				() => document.querySelectorAll('[data-git-row-type="directory"]').length > 1,
			);
			await waitForCurrentTree(page);
			const child = (await snapshot(page)).directories.find((path) => path.endsWith("group-000"));
			if (!child) throw new Error("Missing ten-file child directory");
			expect(
				(await snapshot(page)).display.directoryCounts.find((row) => row.path === child)?.count,
			).toBe(complete ? "10" : "10+");
			await gateConfigureResponses(worker);
			await observeToggle(child, true, true);
			await observeToggle(child, false, true);
			const final = await snapshot(page);
			expect(final.network.requests).toEqual(initial.network.requests);
			expect(final.snapshotIds).toEqual(initial.snapshotIds);
			expect(final.network.mutations).toEqual([]);
			const commands = await worker.evaluate(
				() => (self as unknown as WorkerScope).__gitConfigureGate?.commands,
			);
			expect(
				commands?.filter((command) => command.type === "reset" || command.type === "append"),
			).toEqual([]);
			if (process.env.NF_GIT_DIRECTORY_COUNT_EVIDENCE) {
				await Bun.write(
					resolve(
						process.env.NF_GIT_DIRECTORY_COUNT_EVIDENCE,
						`directory-count-fixed-${total}-${Date.now()}.json`,
					),
					JSON.stringify(
						{ bun: Bun.version, total, complete, initial, observations, final, commands },
						null,
						2,
					),
				);
			}
			console.info(
				"Directory count frame observations",
				JSON.stringify(
					observations.map(({ path, expanded, held, expected, samples }) => ({
						path,
						expanded,
						held,
						expected,
						samples: samples.length,
						frames: samples.filter((sample) => sample.kind === "frame").length,
						mutations: samples.filter((sample) => sample.kind === "mutation").length,
					})),
				),
			);
		},
		"tree",
		{ total, canWrite: true, directorySize: 10 },
	);
}, 60_000);

test.each([
	612, 2_300,
])("local expansion preserves nonzero scroll, statistics epochs and the %i-file page chain across delayed and reordered Worker replies", async (total) => {
	await withPage(
		async (page, workers) => {
			const worker = workers.find((entry) => entry.url().includes("git-changes-list.worker"));
			if (!worker) throw new Error("Directory acceptance requires the real Git module Worker");
			await page.click('[data-git-row-type="directory"] [aria-expanded="false"]');
			await page.waitForFunction(
				() => document.querySelectorAll('[data-git-row-type="directory"]').length > 10,
			);
			await scroll(page, 0.45);
			await waitForCurrentTree(page);
			const before = await snapshot(page);
			const complete = !before.hasMore;
			expect(before.loaded).toBe(total === 612 ? 612 : 1_000);
			expect(before.pageCount).toBe(total === 612 ? 7 : 10);
			expect(before.scrollTop).toBeGreaterThan(0);
			await expectTreeRange(page, complete);
			const anchor = await visibleTreeAnchor(page);
			const target = await page.evaluate(() => {
				const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
				if (!viewport) throw new Error("Missing Git viewport");
				const top = viewport.getBoundingClientRect().top;
				// Activate a mounted overscan folder before the visible anchor so added rows
				// exercise an actual positive scroll adjustment against the new DOM height.
				const row = [...document.querySelectorAll<HTMLElement>('[data-git-row-type="directory"]')]
					.filter(
						(element) =>
							element.getBoundingClientRect().bottom <= top &&
							element.getBoundingClientRect().top >= top - 90,
					)
					.at(-1);
				if (!row?.dataset.gitRowPath)
					throw new Error("Missing folder before the nonzero tree anchor");
				return {
					path: row.dataset.gitRowPath,
					key: row.dataset.gitChangeRow,
					offset: row.getBoundingClientRect().top - top + viewport.scrollTop,
				};
			});
			await gateConfigureResponses(worker);
			await toggleDirectory(page, target.path);
			await waitForConfigure(worker, 1);
			await expectConfigureHeld(page, before);
			await expectTreeRange(page, complete);
			await releaseConfigure(worker);
			await page.waitForFunction(
				(directory) =>
					[...document.querySelectorAll<HTMLElement>('[data-git-row-type="file"]')].some((row) =>
						row.dataset.gitRowPath?.startsWith(`${directory}/`),
					),
				{},
				target.path,
			);
			await waitForCurrentTree(page);
			const expanded = await snapshot(page);
			expect(expanded.scrollHeight).toBe(before.scrollHeight + 10 * before.rowHeight);
			expect(
				Math.abs(expanded.scrollTop - before.scrollTop - 10 * before.rowHeight),
			).toBeLessThanOrEqual(1);
			const afterAnchor = await visibleTreeAnchor(page);
			expect(afterAnchor.key).toBe(anchor.key);
			expect(Math.abs(afterAnchor.top - anchor.top)).toBeLessThanOrEqual(1);
			await expectTreeRange(page, complete);

			// Put the first visible row inside that folder, then collapse its mounted parent.
			await page.evaluate(
				(top) => {
					const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
					if (!viewport) throw new Error("Missing Git viewport");
					viewport.scrollTop = top;
					viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
				},
				target.offset + 3 * before.rowHeight,
			);
			await frames(page, 6);
			await waitForCurrentTree(page);
			const beforeCollapse = await snapshot(page);
			expect(beforeCollapse.scrollTop).toBeGreaterThan(0);
			await toggleDirectory(page, target.path);
			await waitForConfigure(worker, 2);
			await expectConfigureHeld(page, beforeCollapse);
			await expectTreeRange(page, complete);
			await releaseConfigure(worker);
			await page.waitForFunction(
				(directory) =>
					[...document.querySelectorAll<HTMLElement>('[data-git-row-type="directory"]')]
						.find((row) => row.dataset.gitRowPath === directory)
						?.querySelector("[aria-expanded]")
						?.getAttribute("aria-expanded") === "false",
				{},
				target.path,
			);
			await waitForCurrentTree(page);
			const collapsed = await snapshot(page);
			expect(collapsed.scrollHeight).toBe(before.scrollHeight);
			expect(collapsed.scrollTop).toBeGreaterThan(0);
			expect(Math.abs(collapsed.scrollTop - target.offset)).toBeLessThanOrEqual(1);
			expect((await visibleTreeAnchor(page)).key).toBe(target.key);
			await expectTreeRange(page, complete);

			await toggleDirectory(page, target.path);
			await waitForConfigure(worker, 3);
			await toggleDirectory(page, target.path);
			await waitForConfigure(worker, 4);
			await expectConfigureHeld(page, collapsed);
			// Deliver the final collapsed frame first, then its obsolete expanded predecessor.
			await releaseConfigure(worker, true);
			await frames(page, 6);
			const newest = await snapshot(page);
			expect(newest.scrollHeight).toBe(collapsed.scrollHeight);
			expect(newest.scrollTop).toBe(collapsed.scrollTop);
			expect(newest.filePaths.some((path) => path.startsWith(`${target.path}/`))).toBe(false);
			await releaseConfigure(worker);
			await frames(page, 12);
			await waitForCurrentTree(page);
			const final = await snapshot(page);
			expect(final.scrollTop).toBe(collapsed.scrollTop);
			expect(final.scrollHeight).toBe(collapsed.scrollHeight);
			expect(final.snapshotIds).toEqual(before.snapshotIds);
			expect(final.network.requests).toEqual(before.network.requests);
			expect(final.loaded).toBe(before.loaded);
			expect(final.network.mutations).toEqual([]);
			expect(final.network.statsRequests.some((request) => request.aborted)).toBe(false);
			expect(final.display.actions.some((action) => !action.disabled)).toBe(complete);
			await expectTreeRange(page, complete);
			const commands = await worker.evaluate(
				() => (self as unknown as WorkerScope).__gitConfigureGate?.commands,
			);
			if (!commands) throw new Error("Missing configure command probe");
			expect(
				commands.filter(
					(command) =>
						command.type === "reset" ||
						command.type === "append" ||
						command.type === "stats-source",
				),
			).toEqual([]);
			expect(new Set(commands.map((command) => command.generation)).size).toBe(1);
			const measured = new Set(
				before.network.statsRequests.flatMap((request) =>
					request.rows.map((row) => JSON.stringify([row.type, row.section, row.path])),
				),
			);
			const previousRequest = before.network.statsRequests.at(-1)?.id ?? 0;
			for (const request of final.network.statsRequests.filter(
				(entry) => entry.id > previousRequest,
			)) {
				for (const row of request.rows) {
					expect(measured.has(JSON.stringify([row.type, row.section, row.path]))).toBe(false);
				}
			}
			expectBounded(final);
		},
		"tree",
		{ total, canWrite: true, directorySize: 10 },
	);
}, 60_000);

test.each([
	840, 60,
])("pending expansion preserves the latest user scroll at %i and renders its viewport after the ACK", async (nextTop) => {
	await withPage(
		async (page, workers) => {
			const worker = workers.find((entry) => entry.url().includes("git-changes-list.worker"));
			if (!worker) throw new Error("Scrolling acceptance requires the real Git module Worker");
			await page.click('[data-git-row-type="directory"] [aria-expanded="false"]');
			await page.waitForFunction(
				() => document.querySelectorAll('[data-git-row-type="directory"]').length > 10,
			);
			await page.evaluate(() => {
				const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
				if (!viewport) throw new Error("Missing Git viewport");
				viewport.scrollTop = 900;
				viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			await frames(page, 6);
			await waitForCurrentTree(page);
			const before = await snapshot(page);
			expect(before.scrollTop).toBe(900);
			expect(before.hasMore).toBe(false);
			const target = await page.evaluate(() => {
				const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
				if (!viewport) throw new Error("Missing Git viewport");
				const top = viewport.getBoundingClientRect().top;
				const row = [
					...document.querySelectorAll<HTMLElement>('[data-git-row-type="directory"]'),
				].find((element) => element.getBoundingClientRect().top >= top + 60);
				if (!row?.dataset.gitRowPath)
					throw new Error("Missing visible folder after the scroll anchor");
				return row.dataset.gitRowPath;
			});
			await gateConfigureResponses(worker);
			await toggleDirectory(page, target);
			await waitForConfigure(worker, 1);
			await expectConfigureHeld(page, before);
			await page.evaluate((top) => {
				const viewport = document.querySelector<HTMLElement>("[data-git-changes-list]");
				if (!viewport) throw new Error("Missing Git viewport");
				viewport.scrollTop = top;
				viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
			}, nextTop);
			await frames(page, 12);
			const waiting = await snapshot(page);
			expect(waiting.scrollTop).toBe(nextTop);
			expect(waiting.scrollHeight).toBe(before.scrollHeight);
			expect(waiting.display.rows).toEqual(before.display.rows);
			expect(waiting.display.refreshing).toBe(false);
			expect(waiting.network.requests).toEqual(before.network.requests);
			await releaseConfigure(worker);
			const expectedPath = `workspace-a/revision-0/files/group-${String(nextTop / before.rowHeight - 2).padStart(3, "0")}`;
			await page.waitForFunction(
				(path) => {
					const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
					return (
						!state.display.busy &&
						state.directories.includes(path) &&
						state.display.actions.some((action) => !action.disabled)
					);
				},
				{},
				expectedPath,
			);
			await waitForCurrentTree(page);
			const final = await snapshot(page);
			expect(final.scrollTop).toBe(nextTop);
			expect(final.scrollHeight).toBe(before.scrollHeight + 10 * before.rowHeight);
			expect((await visibleTreeAnchor(page)).key).toBe(`unstaged:directory:${expectedPath}`);
			expect(final.snapshotIds).toEqual(before.snapshotIds);
			expect(final.network.requests).toEqual(before.network.requests);
			expect(final.network.statsRequests.some((request) => request.aborted)).toBe(false);
			await expectTreeRange(page, true);
			const commands = await worker.evaluate(
				() => (self as unknown as WorkerScope).__gitConfigureGate?.commands,
			);
			expect(
				commands?.filter(
					(command) =>
						command.type === "reset" ||
						command.type === "append" ||
						command.type === "stats-source",
				),
			).toEqual([]);
			expectBounded(final);
		},
		"tree",
		{ total: 612, canWrite: true, directorySize: 10 },
	);
}, 40_000);

test.each([
	false,
	true,
])("refresh icon uses real animation and preserves header layout with reduced motion %s", async (reducedMotion) => {
	await withPage(
		async (page) => {
			await page.emulateMediaFeatures([
				{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
			]);
			await waitForMeasuredRows(page);
			const before = await refreshPresentation(page);
			expect(before.refreshing).toBe("false");
			expect(before.animationName).toBe("none");
			expect(before.animations).toEqual([]);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdFirstPage();
				current.holdStatistics();
				current.revise(83);
			});
			await page.click('[data-testid="git-changes-refresh"]');
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.display.refreshing && state.network.pending.length === 1;
			});
			const updating = await refreshPresentation(page);
			expect((await snapshot(page)).display.busy).toBe(true);
			expect(updating.refreshing).toBe("true");
			expect(updating.button).toEqual(before.button);
			expect(updating.buttonAnimation).toBe("none");
			expect(updating.headerBottom).toBe(before.headerBottom);
			expect(updating.filterTop).toBe(before.filterTop);
			expect(Math.abs(updating.filterTop - updating.headerBottom)).toBeLessThanOrEqual(1);
			expect(updating.statuses).toHaveLength(1);
			for (const status of updating.statuses) {
				expect(status.width).toBeLessThanOrEqual(1);
				expect(status.height).toBeLessThanOrEqual(1);
				expect(status.position).toBe("absolute");
				expect(status.overflow).toBe("hidden");
				expect(status.hidden).not.toBe("true");
			}
			if (reducedMotion) {
				expect(updating.animationName).toBe("none");
				expect(updating.animations).toEqual([]);
			} else {
				expect(updating.animationName).not.toBe("none");
				expect(Number.parseFloat(updating.animationDuration)).toBeGreaterThan(0);
				expect(updating.animationTiming).toBe("linear");
				expect(updating.animationIterations).toBe("infinite");
				expect(updating.animations).toHaveLength(1);
				expect(updating.animations[0]?.playState).toBe("running");
				await frames(page, 6);
				const advanced = await refreshPresentation(page);
				expect(advanced.transform).not.toBe(updating.transform);
				expect(advanced.animations[0]?.currentTime).toBeGreaterThan(
					updating.animations[0]?.currentTime ?? 0,
				);
			}
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
			);
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pendingStats
						.length > 0,
			);
			expect((await refreshPresentation(page)).refreshing).toBe("true");
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseStatistics(),
			);
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return !state.display.busy && !state.display.refreshing && state.loaded === 83;
			});
			const finished = await refreshPresentation(page);
			expect(finished.button).toEqual(before.button);
			expect(finished.animationName).toBe("none");
			expect(finished.animations).toEqual([]);
			expect(finished.statuses).toEqual([]);
			await frames(page, 6);
			expect((await refreshPresentation(page)).transform).toBe(finished.transform);
		},
		"flat",
		{ total: 161, canWrite: true },
	);
}, 40_000);

test("complete-range load and cancel stay centered outside the scrolling list and release footer height when complete", async () => {
	await withPage(
		async (page) => {
			await page.click('[data-git-row-type="directory"] [aria-expanded="false"]');
			await page.waitForSelector('[data-git-row-type="file"]');
			await waitForMeasuredRows(page);
			const initial = await expectRangeFooter(page, "Load complete range");
			const before = await snapshot(page);
			expect(before.hasMore).toBe(true);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.holdNextPage(),
			);
			await page.click('[data-testid="git-changes-range-controls"] button');
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pending
						.length === 1,
			);
			const held = (await snapshot(page)).network.pending[0];
			if (held === undefined) throw new Error("Missing complete-range request");
			const loading = await expectRangeFooter(page, "Cancel loading");
			await scroll(page, 0.5);
			const scrolled = await expectRangeFooter(page, "Cancel loading");
			expect(scrolled.scrollTop).toBeGreaterThan(0);
			expect(scrolled.footer?.top).toBe(loading.footer?.top);
			expect(scrolled.footer?.bottom).toBe(loading.footer?.bottom);
			await page.click('[data-testid="git-changes-range-controls"] button');
			await expectRangeFooter(page, "Load complete range");
			await releaseHeld(page, held);
			const cancelled = await snapshot(page);
			expect(cancelled.loaded).toBe(before.loaded);
			expect(cancelled.snapshotIds).toEqual(before.snapshotIds);
			expect(cancelled.network.requests).toHaveLength(before.network.requests.length + 1);
			await page.click('[data-testid="git-changes-range-controls"] button');
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					state.loaded === 2_300 &&
					!state.hasMore &&
					!document.querySelector('[data-testid="git-changes-range-controls"]')
				);
			});
			const complete = await rangeLayout(page);
			expect(complete.footer).toBeNull();
			expect(Math.abs(complete.viewportBottom - complete.panelBottom)).toBeLessThanOrEqual(1);
			expect(complete.viewportHeight).toBeGreaterThanOrEqual(
				initial.viewportHeight + (initial.footer?.height ?? 0) - 1,
			);
			expect((await snapshot(page)).snapshotIds).toEqual(before.snapshotIds);
		},
		"tree",
		{ total: 2_300, canWrite: true },
	);
}, 40_000);

test("expired complete snapshots expose a centered footer refresh that restores the current range", async () => {
	await withPage(
		async (page) => {
			expect((await rangeLayout(page)).footer).toBeNull();
			const before = await snapshot(page);
			expect(before.hasMore).toBe(false);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.expireSnapshot(),
			);
			await page.waitForSelector('[data-testid="git-changes-range-controls"] button');
			await expectRangeFooter(page, "Refresh");
			expect(
				(await snapshot(page)).network.requests.filter((request) => request.expired),
			).toHaveLength(1);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdFirstPage();
				current.revise(83);
			});
			await page.click('[data-testid="git-changes-range-controls"] button');
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pending
						.length === 1,
			);
			expect((await snapshot(page)).display.refreshing).toBe(true);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
			);
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					state.loaded === 83 &&
					!state.display.busy &&
					!document.querySelector('[data-testid="git-changes-range-controls"]')
				);
			});
			expect((await snapshot(page)).snapshotIds).not.toEqual(before.snapshotIds);
			expect((await rangeLayout(page)).footer).toBeNull();
		},
		"tree",
		{ total: 161, canWrite: true },
	);
}, 40_000);

test.each([
	["tree", false],
	["flat", true],
] as const)(
	"%s view with canWrite %s reserves no footer when full-range actions are unnecessary",
	async (mode, canWrite) => {
		await withPage(
			async (page) => {
				expect((await snapshot(page)).hasMore).toBe(true);
				const layout = await rangeLayout(page);
				expect(layout.footer).toBeNull();
				expect(Math.abs(layout.viewportBottom - layout.panelBottom)).toBeLessThanOrEqual(1);
			},
			mode,
			{ canWrite },
		);
	},
	40_000,
);

test.each([
	"flat",
	"tree",
	"filtered",
] as const)("%s refresh preserves measured rows on every frame until page and statistics handoff", async (scenario) => {
	const mode = scenario === "filtered" ? "flat" : scenario;
	await withPage(
		async (page, workers) => {
			const worker = workers.find((entry) => entry.url().includes("git-changes-list.worker"));
			if (!worker) throw new Error("Continuity acceptance requires the real Git module Worker");
			expect(await instrumentWorker(worker)).toEqual({
				handler: "function",
				document: "undefined",
			});
			if (scenario === "filtered") {
				await page.click('button[aria-label^="Modified ("]');
				await page.waitForFunction(() => {
					const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
					return (
						state.filteredTotal === 81 &&
						!state.hasMore &&
						state.display.rows.length > 0 &&
						state.display.actions.some((action) => !action.disabled)
					);
				});
			}
			if (mode === "tree") {
				await page.click('[data-git-row-type="directory"] [aria-expanded="false"]');
				await page.waitForSelector('[data-git-row-type="file"]');
			}
			await waitForMeasuredRows(page);
			const before = await snapshot(page);
			expect(before.display.actions.some((action) => !action.disabled)).toBe(true);
			expectBounded(before);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdFirstPage();
				current.holdStatistics();
				current.revise(83);
				current.startContinuity();
			});
			await page.click('button[aria-label="Refresh"]');
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.network.pending.length === 1 && state.network.requests.at(-1)?.offset === 0;
			});
			const pageHeld = await snapshot(page);
			await expectHeldDisplay(page, before.display);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
			);
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pendingStats
						.length > 0,
			);
			const statsHeld = await snapshot(page);
			expect(statsHeld.snapshotIds).not.toEqual(before.snapshotIds);
			const requestedPaths =
				statsHeld.network.statsRequests.at(-1)?.rows.map((row) => row.path) ?? [];
			expect(requestedPaths.length).toBeGreaterThan(0);
			expect(statsHeld.network.statsRequests.at(-1)?.snapshotId).toBe(statsHeld.snapshotIds[0]);
			if (mode === "tree")
				expect(requestedPaths).toEqual(["workspace-a", "workspace-a/revision-1/files"]);
			else expect(requestedPaths.every((path) => path.includes("revision-1/"))).toBe(true);
			await expectHeldDisplay(page, before.display);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseStatistics(),
			);
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					!state.display.busy &&
					state.display.rows.some((row) => row.path.includes("revision-1/")) &&
					state.display.rows.every(
						(row) =>
							(row.path.includes("revision-1/") ||
								(row.type === "directory" && row.path === "workspace-a")) &&
							row.measurements.length === 2,
					)
				);
			});
			await frames(page, 5);
			const samples = await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.stopContinuity(),
			);
			const final = await snapshot(page);
			expectBounded(final);
			expect(final.loaded).toBe(scenario === "filtered" ? 42 : 83);
			expect(final.display.refreshing).toBe(false);
			expect(final.display.actions.some((action) => !action.disabled)).toBe(true);
			expect(final.network.mutations).toEqual([]);
			const firstNew = samples.findIndex((sample) =>
				sample.rows.some((row) => row.path.includes("revision-1/")),
			);
			expect(firstNew).toBeGreaterThan(0);
			const oldSamples = samples.slice(0, firstNew);
			for (const sample of oldSamples) {
				expect(sample.rows, JSON.stringify(sample)).toEqual(before.display.rows);
				expect(sample.sectionCounts).toEqual(before.display.sectionCounts);
			}
			for (const sample of samples.slice(firstNew)) {
				expect(sample.rows.length).toBeGreaterThan(0);
				expect(sample.rows.some((row) => row.path.includes("revision-1/"))).toBe(true);
				expect(
					sample.rows.every(
						(row) =>
							row.path.includes("revision-1/") ||
							(row.type === "directory" && row.path === "workspace-a"),
					),
				).toBe(true);
				expect(sample.rows.every((row) => row.measurements.length === 2)).toBe(true);
			}
			const firstPageRequest = pageHeld.network.requests.at(-1);
			const statisticsRequest = statsHeld.network.statsRequests.at(-1);
			if (!firstPageRequest || !statisticsRequest)
				throw new Error("Missing delayed refresh requests");
			const releasedPage = final.network.requests.find(
				(request) => request.id === firstPageRequest.id,
			);
			const releasedStats = final.network.statsRequests.find(
				(request) => request.id === statisticsRequest.id,
			);
			const pageDelayFrames = samples.filter(
				(sample) =>
					sample.kind === "frame" &&
					sample.at >= firstPageRequest.startedAt &&
					sample.at < (releasedPage?.settledAt ?? 0),
			);
			const statsDelayFrames = samples.filter(
				(sample) =>
					sample.kind === "frame" &&
					sample.at >= statisticsRequest.startedAt &&
					sample.at < (releasedStats?.settledAt ?? 0),
			);
			expect(pageDelayFrames.length).toBeGreaterThanOrEqual(12);
			expect(statsDelayFrames.length).toBeGreaterThanOrEqual(12);
			for (const sample of [...pageDelayFrames, ...statsDelayFrames]) {
				expect(sample.busy).toBe(true);
				expect(sample.refreshing).toBe(true);
				expect(sample.actions.every((action) => action.disabled)).toBe(true);
			}
			for (const sample of samples) {
				expect(sample.mounted).toBeLessThanOrEqual(sample.visibleCapacity + 2 * final.overscan + 2);
			}
			console.info(
				"Git refresh continuity sample",
				JSON.stringify({
					scenario,
					mode,
					samples: samples.length,
					frames: samples.filter((sample) => sample.kind === "frame").length,
					mutations: samples.filter((sample) => sample.kind === "mutation").length,
					pageDelayFrames: pageDelayFrames.length,
					statsDelayFrames: statsDelayFrames.length,
					oldRows: before.display.rows.length,
					newRows: final.display.rows.length,
					maxMounted: Math.max(...samples.map((sample) => sample.mounted)),
					rowTransitions: 1,
					mutationRequests: final.network.mutations.length,
					pageDelayMs: (releasedPage?.settledAt ?? 0) - firstPageRequest.startedAt,
					statsDelayMs: (releasedStats?.settledAt ?? 0) - statisticsRequest.startedAt,
				}),
			);
		},
		mode,
		{ total: 161, canWrite: true },
	);
}, 40_000);

test("a delayed legitimate zero-file snapshot replaces retained rows with the real empty state", async () => {
	await withPage(
		async (page) => {
			await waitForMeasuredRows(page);
			const before = await snapshot(page);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdFirstPage();
				current.revise(0);
				current.startContinuity();
			});
			await page.click('button[aria-label="Refresh"]');
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pending
						.length === 1,
			);
			await expectHeldDisplay(page, before.display);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
			);
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					!state.display.busy && state.display.empty && state.pageCount === 1 && state.loaded === 0
				);
			});
			const samples = await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.stopContinuity(),
			);
			expect(samples.every((sample) => sample.rows.length > 0 || sample.empty)).toBe(true);
			const state = await snapshot(page);
			expect(state.filteredTotal).toBe(0);
			expect(state.display.rows).toEqual([]);
			expect(state.display.sectionCounts).toEqual([]);
			expect(state.snapshotIds).toHaveLength(1);
			await expectNoPriorPaths(page);
		},
		"flat",
		{ total: 61, canWrite: true },
	);
}, 40_000);

test.each([
	"workspace",
	"filter",
] as const)("changing %s clears prior paths while the next first page is still delayed", async (identity) => {
	await withPage(
		async (page) => {
			await waitForMeasuredRows(page);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdFirstPage();
				current.revise();
				current.startContinuity();
			});
			if (identity === "workspace") {
				await page.evaluate(() =>
					(window as unknown as FixtureWindow).gitChangesFixture.switchWorkspace("workspace-b"),
				);
			} else await page.click('button[aria-label^="Modified ("]');
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pending
						.length === 1,
			);
			const held = await snapshot(page);
			const request = held.network.requests.at(-1);
			if (!request) throw new Error("Missing identity first-page request");
			expect(held.display.rows).toEqual([]);
			expect(held.display.sectionCounts).toEqual([]);
			await expectNoPriorPaths(page);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
			);
			await waitForMeasuredRows(page);
			const samples = await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.stopContinuity(),
			);
			expect(
				samples
					.filter((sample) => sample.at >= request.startedAt)
					.every((sample) => sample.rows.every((row) => !row.path.includes("revision-0/"))),
			).toBe(true);
			expectBounded(await snapshot(page));
			await expectNoPriorPaths(page);
		},
		"flat",
		{ total: 61, canWrite: true },
	);
}, 40_000);

test.each([
	["page", 401],
	["page", 403],
	["page", 404],
	["stats", 401],
	["stats", 403],
	["stats", 404],
] as const)(
	"%s HTTP %i removes retained paths and rejects late display resurrection",
	async (endpoint, status) => {
		await withPage(
			async (page) => {
				await waitForMeasuredRows(page);
				await page.evaluate(
					({ endpoint, status }) => {
						const current = (window as unknown as FixtureWindow).gitChangesFixture;
						current.holdFirstPage();
						current.holdStatistics();
						current.revise();
						current.denyNext(endpoint, status);
					},
					{ endpoint, status },
				);
				await page.click('button[aria-label="Refresh"]');
				await page.waitForFunction(
					() =>
						(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pending
							.length === 1,
				);
				await frames(page, 5);
				expect((await snapshot(page)).display.rows.length).toBeGreaterThan(0);
				await page.evaluate(() =>
					(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
				);
				if (endpoint === "stats") {
					await page.waitForFunction(
						() =>
							(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.pendingStats
								.length > 0,
					);
					await page.evaluate(() =>
						(window as unknown as FixtureWindow).gitChangesFixture.releaseStatistics(),
					);
				}
				await page.waitForFunction(
					() =>
						(window as unknown as FixtureWindow).gitChangesFixture.snapshot().display.rows
							.length === 0,
				);
				await expectNoPriorPaths(page);
				await page.evaluate(() => {
					const current = (window as unknown as FixtureWindow).gitChangesFixture;
					current.releaseHeld();
					current.releaseStatistics();
				});
				await expectNoPriorPaths(page);
				expect((await snapshot(page)).display.sectionCounts).toEqual([]);
			},
			"flat",
			{ total: 61, canWrite: true },
		);
	},
	40_000,
);

test("10,000 files use a live module Worker and viewport-bounded DOM in flat and expanded tree views", async () => {
	await withPage(async (page, workers) => {
		const initial = await snapshot(page);
		expect(initial.runtime).toEqual({ production: true, development: false, mode: "production" });
		expectBounded(initial);
		expect(initial.loaded).toBe(1_000);
		expect(initial.pageCount).toBe(10);
		expect(initial.network.requests).toHaveLength(10);
		const worker = workers.find((entry) => entry.url().includes("git-changes-list.worker"));
		if (!worker) throw new Error("Git changes production module Worker was not created");
		expect(new URL(worker.url()).origin).toBe(origin);
		expect(new URL(worker.url()).pathname).toMatch(/\/assets\/git-changes-list\.worker[^/]*\.js$/);
		expect(await instrumentWorker(worker)).toEqual({ handler: "function", document: "undefined" });
		await loadToEnd(page, worker);
		const integrity = await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.integrity(),
		);
		expect(integrity.loaded).toBe(10_000);
		expect(integrity.unique).toBe(10_000);
		expect(integrity.first).toBe("workspace-a/revision-0/files/file-00000.ts");
		expect(integrity.last).toBe("workspace-a/revision-0/files/file-09999.ts");
		const loaded = await snapshot(page);
		expect(loaded.snapshotIds).toHaveLength(1);
		expect(loaded.pageCount).toBe(100);
		expect(loaded.network.requests).toHaveLength(100);
		expect(loaded.network.requests.map((request) => request.offset)).toEqual(
			Array.from({ length: 100 }, (_, index) => index * 100),
		);
		expect(loaded.network.requests.every((request) => request.count <= 200)).toBe(true);
		await scroll(page, 1);
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).gitChangesFixture
				.snapshot()
				.filePaths.some((path) => path.endsWith("file-09999.ts")),
		);
		expectBounded(await snapshot(page));

		// Data construction, dependency loading and all pagination are outside this window.
		await scroll(page, 0);
		await frames(page, 12);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.startSampling(),
		);
		for (const fraction of [0.2, 0.45, 0.7, 1, 0]) {
			await scroll(page, fraction);
			expectBounded(await snapshot(page));
		}
		await page.click("aria/Tree");
		await page.waitForSelector('[data-git-row-type="directory"]');
		expectBounded(await snapshot(page));
		const collapsed = await snapshot(page);
		expect(collapsed.filePaths).toHaveLength(0);
		await page.click('[data-git-row-type="directory"] [aria-expanded="false"]');
		await page.waitForSelector('[data-git-row-type="file"]');
		for (const fraction of [0.3, 0.6, 1, 0]) {
			await scroll(page, fraction);
			expectBounded(await snapshot(page));
		}
		await page.click('[data-git-row-type="directory"] [aria-expanded="true"]');
		await page.waitForFunction(
			() =>
				(window as unknown as FixtureWindow).gitChangesFixture.snapshot().filePaths.length === 0,
		);
		const sample = await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.stopSampling(),
		);
		expect(sample.supported).toBe(true);
		expect(sample.frames.length).toBeGreaterThan(10);
		expect(sample.operations.every((operation) => operation.frames >= 2)).toBe(true);
		expect(sample.maxMounted).toBeLessThanOrEqual(loaded.visibleCapacity + 2 * loaded.overscan + 2);
		// Guard sustained interaction stalls, not a machine-dependent 16ms rendering benchmark.
		expect(
			sample.longTasks.filter((task) => task.duration >= 250),
			JSON.stringify(sample),
		).toEqual([]);
		const frameGaps = sample.frames.slice(1).map((time, index) => time - sample.frames[index]);
		console.info(
			"Git changes browser interaction sample",
			JSON.stringify({
				loadedFiles: integrity.loaded,
				pages: loaded.pageCount,
				maxMounted: sample.maxMounted,
				visibleCapacity: loaded.visibleCapacity,
				overscan: loaded.overscan,
				frames: sample.frames.length,
				maxFrameGapMs: Math.max(0, ...frameGaps),
				longTasks: sample.longTasks,
				operations: sample.operations,
			}),
		);
		expect(Math.max(0, ...frameGaps), JSON.stringify(sample)).toBeLessThan(1_000);

		const probe = await worker.evaluate(() => (self as unknown as WorkerScope).__gitBrowserProbe);
		if (!probe) throw new Error("Worker computation probe is unavailable");
		expect(
			probe.requests.some((request) => request.type === "append" && request.appendedFiles > 0),
		).toBe(true);
		expect(probe.requests.some((request) => request.type === "configure")).toBe(true);
		expect(probe.requests.some((request) => request.type === "window")).toBe(true);
		expect(
			probe.responses.some(
				(response) => response.loadedFiles === 10_000 && response.totalRows >= 10_000,
			),
		).toBe(true);
		expect(
			probe.responses.every(
				(response) => response.rows <= loaded.visibleCapacity + 2 * loaded.overscan + 2,
			),
		).toBe(true);
	});
}, 120_000);

test("refresh cancels the prior cursor chain and rejects a deliberately late page", async () => {
	await withPage(async (page) => {
		const held = await holdNextPage(page);
		const previous = (await snapshot(page)).snapshotIds[0];
		await page.evaluate(() => (window as unknown as FixtureWindow).gitChangesFixture.revise());
		await page.click('button[aria-label="Refresh"]');
		await page.waitForFunction(
			(oldSnapshot) => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					state.snapshotIds.length === 1 && state.snapshotIds[0] !== oldSnapshot && state.loaded > 0
				);
			},
			{},
			previous,
		);
		await releaseHeld(page, held);
		const integrity = await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.integrity(),
		);
		expect(integrity.revisions).toEqual(["revision-1"]);
		expect(integrity.workspaces).toEqual(["workspace-a"]);
		expect((await snapshot(page)).snapshotIds).toHaveLength(1);
		expectBounded(await snapshot(page));
	});
}, 40_000);

test("status filtering ignores old unfiltered pages and uses the filtered pagination total", async () => {
	await withPage(async (page) => {
		const held = await holdNextPage(page);
		await page.click('button[aria-label^="Modified ("]');
		await page.waitForFunction(() => {
			const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
			return state.filteredTotal === 5_000 && state.loaded > 0;
		});
		await releaseHeld(page, held);
		const integrity = await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.integrity(),
		);
		expect(integrity.statuses).toEqual([" M"]);
		expect((await snapshot(page)).filteredTotal).toBe(5_000);
		expect((await snapshot(page)).hasMore).toBe(true);
		expectBounded(await snapshot(page));
	});
}, 40_000);

test("workspace changes cancel old requests without merging their eventual pages", async () => {
	await withPage(async (page, workers) => {
		const previousWorker = workers.find((worker) =>
			worker.url().includes("git-changes-list.worker"),
		);
		if (!previousWorker) throw new Error("Missing previous workspace Worker");
		const destroyed = new Set<WebWorker>();
		page.on("workerdestroyed", (worker) => {
			destroyed.add(worker);
		});
		const held = await holdNextPage(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.switchWorkspace("workspace-b"),
		);
		await page.waitForFunction(() => {
			const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
			return state.loaded > 0 && state.filePaths.some((path) => path.startsWith("workspace-b/"));
		});
		expect(destroyed.has(previousWorker)).toBe(true);
		expect(
			workers.filter((worker) => worker.url().includes("git-changes-list.worker")).length,
		).toBeGreaterThan(1);
		await releaseHeld(page, held);
		const integrity = await page.evaluate(() =>
			(window as unknown as FixtureWindow).gitChangesFixture.integrity(),
		);
		expect(integrity.workspaces).toEqual(["workspace-b"]);
		expect((await snapshot(page)).filePaths.every((path) => path.startsWith("workspace-b/"))).toBe(
			true,
		);
		expectBounded(await snapshot(page));
	});
}, 40_000);

test("561-file directory statistics cover the whole snapshot before paging and include files after 200", async () => {
	await withPage(
		async (page, workers) => {
			const directory = "workspace-a/revision-0/files";
			const laterFile = `${directory}/file-00200.ts`;
			await page.waitForFunction(
				(path) => {
					const row = (window as unknown as FixtureWindow).gitChangesFixture.rowStats(
						path,
						"directory",
					);
					return row?.measurements.includes("+2241") && row.measurements.includes("-1681");
				},
				{},
				directory,
			);
			const first = await snapshot(page);
			expect(first.loaded).toBe(100);
			expect(first.hasMore).toBe(true);
			expect(first.network.requests).toHaveLength(2);
			expect(first.network.requests.filter((request) => request.settled)).toHaveLength(1);
			expect(first.network.pending).toHaveLength(1);
			expect(first.network.statsRequestCount).toBeGreaterThan(0);
			expect(
				first.network.statsRequests.some((request) =>
					request.rows.some(
						(row) =>
							row.type === "directory" && row.section === "unstaged" && row.path === directory,
					),
				),
			).toBe(true);
			const directoryRow = await page.evaluate(
				(path) =>
					(window as unknown as FixtureWindow).gitChangesFixture.rowStats(path, "directory"),
				directory,
			);
			expect(directoryRow?.measurements).toEqual(["+2241", "-1681"]);
			expect(directoryRow?.stageDisabled).toBe(true);
			expect(
				workers.some((worker) => worker.url().includes("/assets/git-changes-list.worker")),
			).toBe(true);
			expectBounded(first);
			await frames(page, 12);
			const stable = await snapshot(page);
			expect(stable.loaded).toBe(100);
			expect(stable.network.requests).toHaveLength(2);
			expect(stable.network.statsRequestCount).toBe(first.network.statsRequestCount);

			for (const expected of [200, 300]) {
				await page.evaluate(() => {
					const current = (window as unknown as FixtureWindow).gitChangesFixture;
					current.holdNextPage();
					current.releaseHeld();
				});
				await page.waitForFunction(
					(loaded) => {
						const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
						return state.loaded === loaded && state.network.pending.length === 1;
					},
					{},
					expected,
				);
				await frames(page);
			}
			await page.click("aria/List");
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.filePaths.length > 0;
			});
			await scroll(page, 0.7);
			await page.waitForFunction(
				(path) => {
					const row = (window as unknown as FixtureWindow).gitChangesFixture.rowStats(path, "file");
					return row?.measurements.includes("+5") && row.measurements.includes("-1");
				},
				{},
				laterFile,
			);
			const fileRow = await page.evaluate(
				(path) => (window as unknown as FixtureWindow).gitChangesFixture.rowStats(path, "file"),
				laterFile,
			);
			expect(fileRow?.measurements).toEqual(["+5", "-1"]);
			const after = await snapshot(page);
			expect(after.loaded).toBe(300);
			expect(after.hasMore).toBe(true);
			expect(after.network.requests).toHaveLength(4);
			expect(after.network.requests.filter((request) => request.settled)).toHaveLength(3);
			expect(after.network.pending).toHaveLength(1);
			expect(after.network.statsRequestCount).toBeGreaterThan(first.network.statsRequestCount);
			expect(
				after.network.statsRequests.some((request) =>
					request.rows.some(
						(row) => row.type === "file" && row.path === laterFile && row.section === "unstaged",
					),
				),
			).toBe(true);
			expectBounded(after);
		},
		"tree",
		{ total: 561, canWrite: true, holdNextPage: true },
	);
}, 40_000);

test("612 files in a collapsed tree automatically complete seven pages without interaction", async () => {
	await withPage(
		async (page, workers) => {
			const loaded = await snapshot(page);
			expect(loaded.loaded).toBe(612);
			expect(loaded.pageCount).toBe(7);
			expect(loaded.hasMore).toBe(false);
			expect(loaded.filePaths).toHaveLength(0);
			expect(loaded.directories).toHaveLength(1);
			expect(loaded.network.requests.map((request) => request.offset)).toEqual([
				0, 100, 200, 300, 400, 500, 600,
			]);
			expect(loaded.network.requests.at(-1)?.count).toBe(12);
			expect(workers.some((worker) => worker.url().includes("git-changes-list.worker"))).toBe(true);
			expect(await page.$('[data-testid="git-changes-load-more"]')).toBeNull();
			expectBounded(loaded);
			await frames(page, 12);
			expect((await snapshot(page)).network.requests).toHaveLength(7);
		},
		"tree",
		{ total: 612 },
	);
}, 40_000);

test.each([
	"button",
	"scroll",
] as const)("large collapsed trees stop at ten automatic pages and %s continues page eleven", async (continuation) => {
	await withPage(async (page) => {
		const before = await snapshot(page);
		expect(before.loaded).toBe(1_000);
		expect(before.pageCount).toBe(10);
		expect(before.network.requests).toHaveLength(10);
		await frames(page, 12);
		await page.click("aria/List");
		await page.click("aria/Tree");
		await frames(page, 12);
		const stable = await snapshot(page);
		expect(stable.loaded).toBe(1_000);
		expect(stable.network.requests).toHaveLength(10);
		expect(stable.filePaths).toHaveLength(0);
		expectBounded(stable);
		if (continuation === "button") {
			await page.click('[data-testid="git-changes-load-more"]');
		} else {
			await page.click("aria/List");
			await frames(page);
			await scroll(page, 1);
		}
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).gitChangesFixture.snapshot().loaded === 1_100,
		);
		await frames(page, 12);
		const after = await snapshot(page);
		expect(after.loaded).toBe(1_100);
		expect(after.pageCount).toBe(11);
		expect(after.network.requests).toHaveLength(11);
		expect(after.network.requests.at(-1)?.offset).toBe(1_000);
		expect(after.hasMore).toBe(true);
		expectBounded(after);
	}, "tree");
}, 40_000);

test("delayed sibling pages preserve expanded directories through compression and explicit folding", async () => {
	await withPage(
		async (page, workers) => {
			const original = "src/a/file-00000.ts";
			expect((await snapshot(page)).directories).toEqual(["src/a"]);
			await toggleDirectory(page, "src/a");
			await page.waitForSelector(`[data-git-row-path="${original}"]`);
			expectBounded(await snapshot(page));
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseHeld(),
			);
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.loaded === 200 && state.directories.includes("src");
			});
			await frames(page);
			const branched = await snapshot(page);
			expect(branched.directories).toContain("src/a");
			expect(branched.filePaths).toContain(original);
			for (const path of ["src", "src/a"])
				expect(
					await page.$eval(`[data-git-row-path="${path}"] [aria-expanded]`, (toggle) =>
						toggle.getAttribute("aria-expanded"),
					),
				).toBe("true");
			expect(
				await page.$eval(`[data-git-row-path="${original}"]`, (row) => {
					const viewport = document.querySelector("[data-git-changes-list]");
					const bounds = viewport?.getBoundingClientRect();
					const file = row.getBoundingClientRect();
					return !!bounds && file.top >= bounds.top && file.bottom <= bounds.bottom;
				}),
			).toBe(true);
			expectBounded(branched);
			await scroll(page, 1);
			await page.waitForSelector('[data-git-row-path="src/b"]');
			expectBounded(await snapshot(page));
			await scroll(page, 0);
			await page.evaluate(() => (window as unknown as FixtureWindow).gitChangesFixture.revise(100));
			await page.click('[data-testid="git-changes-refresh"]');
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					state.loaded === 100 &&
					state.directories.length === 1 &&
					state.directories[0] === "src/a" &&
					state.filePaths.includes("src/a/file-00000.ts")
				);
			});
			await frames(page);
			const compressed = await snapshot(page);
			expect(compressed.directories).toEqual(["src/a"]);
			expect(compressed.filePaths).toContain(original);
			expectBounded(compressed);
			await toggleDirectory(page, "src/a");
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().filePaths.length === 0,
			);
			await page.evaluate(() => (window as unknown as FixtureWindow).gitChangesFixture.revise(200));
			await page.click('[data-testid="git-changes-refresh"]');
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.loaded === 200 && state.directories.includes("src/b");
			});
			await frames(page);
			const folded = await snapshot(page);
			expect(folded.directories).toEqual(["src", "src/a", "src/b"]);
			expect(folded.filePaths).toEqual([]);
			expect(
				await page.$eval('[data-git-row-path="src/a"] [aria-expanded]', (toggle) =>
					toggle.getAttribute("aria-expanded"),
				),
			).toBe("false");
			expectBounded(folded);
			await toggleDirectory(page, "src/a");
			await page.waitForSelector(`[data-git-row-path="${original}"]`);
			expectBounded(await snapshot(page));
			expect(workers.some((worker) => worker.url().includes("git-changes-list.worker"))).toBe(true);
		},
		"tree",
		{ total: 200, holdNextPage: true, branchingDirectories: true },
	);
}, 40_000);

test("829 files automatically finish nine recovered pages after a single cursor expiry", async () => {
	await withPage(
		async (page, workers) => {
			const initial = await snapshot(page);
			expect(initial.loaded).toBe(100);
			expect(initial.network.requests.map((request) => request.offset)).toEqual([0, 100]);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.expireNextCursor();
				current.releaseHeld();
			});
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return state.loaded === 829 && !state.hasMore;
			});
			await frames(page, 12);
			const recovered = await snapshot(page);
			expect(recovered.pageCount).toBe(9);
			expect(recovered.snapshotIds).toHaveLength(1);
			expect(recovered.snapshotIds).not.toEqual(initial.snapshotIds);
			const successful = recovered.network.requests.filter(
				(request) => request.snapshotId === recovered.snapshotIds[0],
			);
			expect(successful.map((request) => request.offset)).toEqual([
				0, 100, 200, 300, 400, 500, 600, 700, 800,
			]);
			expect(successful.at(-1)?.count).toBe(29);
			expect(recovered.network.requests.filter((request) => request.expired)).toHaveLength(1);
			expect(recovered.network.requests).toHaveLength(11);
			expect(recovered.network.requests.every((request) => request.settled)).toBe(true);
			expect(recovered.network.pending).toEqual([]);
			expect(
				await page.evaluate(() =>
					(window as unknown as FixtureWindow).gitChangesFixture.integrity(),
				),
			).toMatchObject({ loaded: 829, unique: 829 });
			expect(await page.$('[data-testid="git-changes-load-more"]')).toBeNull();
			expectBounded(recovered);
			await frames(page, 12);
			expect((await snapshot(page)).network.requests).toHaveLength(11);
			expect(workers.some((worker) => worker.url().includes("git-changes-list.worker"))).toBe(true);
		},
		"tree",
		{ total: 829, holdNextPage: true },
	);
}, 40_000);

test.each([
	390, 1100,
])("staging rows share native geometry and safe deletion at %ipx", async (width) => {
	await withPage(
		async (page) => {
			expect((await snapshot(page)).network.stagingReads).toEqual([]);
			await page.click("aria/ChangeLists");
			await page.waitForSelector('[data-git-staging-observation="settled"]');
			await page.waitForSelector('[data-git-staging-toggle="A"]');
			await page.focus('[data-git-staging-toggle="A"]');
			await page.keyboard.press("Enter");
			await page.waitForSelector('[data-git-staging-directory="src"]');
			const first = await page.$eval(
				'[data-git-staging-directory="src"]',
				(row) => row.textContent,
			);
			expect(first).toContain("3");
			expect(first).toContain("+17");
			expect(first).toContain("-9");
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network.stagingReads
						.length === 2,
			);
			expect((await snapshot(page)).network.stagingReads).toEqual(["A", "A"]);
			await page.click('[data-git-staging-directory="src"]');
			await page.waitForFunction(
				() => document.querySelectorAll("[data-git-staging-file]").length === 3,
			);
			expect(await page.$('[data-git-staging-load-more="A"]')).toBeNull();
			const layout = await page.evaluate(() => {
				const selected = [
					...document.querySelectorAll<HTMLElement>(
						"[data-git-staging-toggle], [data-git-staging-directory], [data-git-staging-file]",
					),
				];
				const native = document.querySelector<HTMLElement>(
					'[data-git-change-row^="unstaged:directory:"] [role="button"]',
				);
				const file = document.querySelector<HTMLElement>(
					'[data-git-staging-file*="long-file-name"]',
				);
				const stats = file
					? [...file.querySelectorAll<HTMLElement>("p")].filter((item) =>
							/^[+-]\d+$/.test(item.textContent ?? ""),
						)
					: [];
				return {
					heights: selected.map((row) => row.getBoundingClientRect().height),
					nativeHeight: native?.getBoundingClientRect().height,
					overflow: document.documentElement.scrollWidth > innerWidth,
					actionsVisible: selected
						.flatMap((row) => [...row.querySelectorAll<HTMLButtonElement>("button")])
						.every((button) => {
							const rect = button.getBoundingClientRect();
							return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
						}),
					colors: stats.map((item) => getComputedStyle(item).color),
					binary: document.querySelector('[data-git-staging-file="src/image.bin"]')?.textContent,
					gitlink: document.querySelector('[data-git-staging-file="src/vendor"]')?.textContent,
					annotation: !!document.querySelector(
						'[aria-label="Includes 1 binary files and 1 submodule links; line counts cover text files only"]',
					),
				};
			});
			expect(layout.heights.every((height) => height === 30)).toBe(true);
			expect(layout.nativeHeight).toBeUndefined();
			expect(layout.overflow).toBe(false);
			expect(layout.actionsVisible).toBe(true);
			expect(layout.colors).toHaveLength(2);
			expect(layout.colors[0]).not.toBe(layout.colors[1]);
			expect(layout.binary).not.toContain("+0");
			expect(layout.gitlink).not.toContain("-0");
			expect(layout.annotation).toBe(true);
			if (process.env.NF_GIT_STAGING_SCREENSHOT_DIR)
				await page.screenshot({
					path: resolve(process.env.NF_GIT_STAGING_SCREENSHOT_DIR, `git-staging-${width}.png`),
					fullPage: true,
				});
			await page.click("[data-git-staging-file] button");
			await page.waitForSelector('[data-git-staging-target="B"]');
			await page.click('[data-git-staging-target="B"]');
			await frames(page);
			expect((await snapshot(page)).network.stagingActions.map((action) => action.action)).toEqual([
				"move",
			]);
			await page.waitForSelector('[role="dialog"]', { hidden: true });
			expect(await page.$('[role="dialog"]')).toBeNull();
			await page.waitForFunction(
				() => document.querySelectorAll("[data-git-staging-file]").length === 2,
			);
			const readsAfterMove = (await snapshot(page)).network.stagingReads;
			expect(readsAfterMove).toEqual(["A", "A", "A", "A"]);
			await page.click('[data-git-staging-toggle="A"]');
			await page.click('[data-git-staging-toggle="A"]');
			await frames(page, 12);
			expect((await snapshot(page)).network.stagingReads).toEqual(readsAfterMove);
			await expectStagingBounded(page);
			await page.click('[data-git-staging-more="B"]');
			await page.click("aria/Delete ChangeList");
			await page.waitForSelector("[data-git-staging-confirm-delete]");
			expect(await page.$eval('[role="dialog"]', (dialog) => dialog.textContent)).toContain(
				"active ChangeList Feature changes",
			);
			await page.click("aria/Cancel");
			await page.waitForSelector('[role="dialog"]', { hidden: true });
			await page.click('[data-git-staging-more="B"]');
			await page.click("aria/Delete ChangeList");
			await page.waitForSelector("[data-git-staging-confirm-delete]", { visible: true });
			await page.click("[data-git-staging-confirm-delete]");
			await page.waitForFunction(() => !document.querySelector('[data-git-staging-toggle="B"]'));
			const final = (await snapshot(page)).network;
			expect(final.stagingActions.map((action) => action.action)).toEqual(["move", "delete"]);
			expect(final.stagingReads).not.toContain("B");
			expect(final.mutations).toEqual([]);
		},
		"tree",
		{ total: 12, canWrite: true, staging: true, width },
	);
}, 40_000);

test("ChangeLists browser preserves native filtering and stable pages while moving shared-file units", async () => {
	await withPage(
		async (page) => {
			await page.click('[data-git-status-filter="M"]');
			await page.waitForFunction(
				() => (window as unknown as FixtureWindow).gitChangesFixture.snapshot().filteredTotal === 6,
			);
			expect((await snapshot(page)).network.requests.at(-1)?.filter).toBe("M");
			await page.click('[data-git-status-filter="M"]');
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().filteredTotal === 12,
			);
			await page.click("aria/ChangeLists");
			await page.waitForSelector('[data-git-staging-observation="settled"]');
			await page.waitForSelector('[data-git-staging-toggle="A"]');
			await page.click('[data-git-staging-toggle="A"]');
			await page.waitForSelector('[data-git-staging-directory="src"]');
			await page.click('[data-git-staging-directory="src"]');
			await page.waitForFunction(
				() => document.querySelectorAll("[data-git-staging-file]").length === 3,
			);
			expect((await snapshot(page)).network.stagingReads).toEqual(["A", "A"]);
			expect(await page.$('[data-git-staging-load-more="A"]')).toBeNull();
			await page.click("aria/M 2");
			await page.waitForFunction(
				() => document.querySelectorAll("[data-git-staging-file]").length === 2,
			);
			expect(await page.$('[data-git-staging-file="src/image.bin"]')).toBeNull();
			expect((await snapshot(page)).network.stagingReads).not.toContain("B");
			await page.click("aria/M 2");
			await page.waitForFunction(
				() => document.querySelectorAll("[data-git-staging-file]").length === 3,
			);
			await expectStagingBounded(page);
			const before = (await snapshot(page)).network.stagingReads.filter((id) => id === "A").length;
			await page.click('[data-git-staging-more="B"]');
			await page.click("aria/Set active");
			await page.waitForFunction(() =>
				/active/i.test(document.querySelector('[data-git-staging-toggle="B"]')?.textContent ?? ""),
			);
			await page.waitForSelector('[data-git-staging-file*="long-file-name"]');
			expect((await snapshot(page)).network.stagingReads.filter((id) => id === "A")).toHaveLength(
				before,
			);
			await page.click('[data-git-staging-file*="long-file-name"]');
			await page.waitForSelector(
				'[data-git-staging-preview-ready] input[data-git-staging-unit-select="a-0"]',
			);
			await page.click('input[data-git-staging-unit-select="a-0"]');
			await page.click("[data-git-staging-batch-menu]");
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="B"]');
			await page.click('[data-git-staging-unit-targets] [data-git-staging-target="B"]');
			await page.waitForSelector('[role="dialog"]', { hidden: true });
			await page.click('[data-git-staging-toggle="B"]');
			await page.waitForSelector('[data-git-staging-toggle="B"]');
			// Open B's directory by its list-scoped row, independently of A's open folder.
			await page.waitForFunction(() => {
				const section = document
					.querySelector('[data-git-staging-toggle="B"]')
					?.closest("[data-git-row-type]");
				let row = section?.nextElementSibling;
				while (row && row.getAttribute("data-git-row-type") !== "staging-section") {
					const directory = row.querySelector<HTMLElement>('[data-git-staging-directory="src"]');
					if (directory) {
						if (directory.getAttribute("aria-expanded") !== "true") directory.click();
						return true;
					}
					row = row.nextElementSibling;
				}
				return false;
			});
			await page.waitForSelector('[data-git-staging-file*="long-file-name"]');
			await page.click('[data-git-staging-file*="long-file-name"]');
			await page.waitForFunction(
				() =>
					document.querySelectorAll(
						"[data-git-staging-preview-ready] input[data-git-staging-unit-select]",
					).length === 2,
			);
			const moved = (await snapshot(page)).network.stagingActions.find(
				(action) => action.action === "move",
			);
			expect(moved).toMatchObject({
				action: "move",
				fromListId: "A",
				toListId: "B",
				unitIds: ["a-0"],
				expectedGeneration: 2,
				observationId: "fixture-o2",
			});
			await page.click('[role="dialog"] button[aria-label="Close"]');
			await page.waitForSelector('[role="dialog"]', { hidden: true });
			await page.click('[data-git-staging-more="B"]');
			await page.waitForSelector('[role="menu"]', { visible: true });
			expect(
				await page.$eval(
					'[role="menu"]',
					(menu) =>
						[...menu.querySelectorAll<HTMLButtonElement>("button")].find(
							(button) => button.textContent?.trim() === "Delete ChangeList",
						)?.disabled,
				),
			).toBe(true);
			await page.click('[data-git-staging-more="B"]');
			await page.waitForSelector('[role="menu"]', { hidden: true });
			await page.click('[data-git-staging-more="A"]');
			await page.waitForSelector('[role="menu"]', { visible: true });
			await page.click("aria/Delete ChangeList");
			await page.waitForSelector("[data-git-staging-confirm-delete]");
			expect(await page.$eval('[role="dialog"]', (dialog) => dialog.textContent)).toContain(
				"active ChangeList Additional changes",
			);
			await page.click("[data-git-staging-confirm-delete]");
			await page.waitForFunction(() => !document.querySelector('[data-git-staging-toggle="A"]'));
			await page.waitForFunction(() =>
				document.querySelector('[data-git-staging-toggle="B"]')?.textContent?.includes("+22"),
			);
			const result = (await snapshot(page)).network;
			expect(result.stagingActions.map((action) => action.action)).toEqual([
				"activate",
				"move",
				"delete",
			]);
			expect(result.mutations).toEqual([]);
			await page.waitForSelector('[role="dialog"]', { hidden: true });
			await page.click("aria/Git staging area");
			await page.waitForSelector('[data-git-change-row="unstaged:section"]');
			expect(await page.$("[data-git-staging-toggle]")).toBeNull();
		},
		"flat",
		{ total: 12, canWrite: true, staging: true, width: 1100 },
	);
}, 40_000);

test.each([
	1100, 390,
])("block move keeps exact selection and the live preview across inline, menu and batch writes at %ipx", async (width) => {
	await withPage(
		async (page, workers) => {
			await openBlockPreview(page);
			const initial = (await snapshot(page)).network.stagingDiffReads.at(-1);
			expect(initial?.units.map((unit) => [unit.id, unit.added, unit.removed])).toEqual([
				["block-0", 1, 1],
				["block-1", 2, 1],
				["block-2", 0, 1],
				["block-3", 1, 1],
			]);
			expect(initial?.hunks).toBe(1);
			expect(initial?.unitMappings).toHaveLength(4);
			expect(await page.$("[data-git-staging-unit-fallback]")).toBeNull();
			await scrollBlockToUnit(page, "block-0");
			await page.focus('input[data-git-staging-unit-select="block-1"]');
			await page.keyboard.press("Space");
			await page.click('input[data-git-staging-unit-select="block-2"]');
			await expectBlockSelection(page, ["block-1", "block-2"]);
			expect(
				await page.$$eval("[data-git-staging-preview] [data-diff-selected]", (rows) =>
					rows.map((row) => row.getAttribute("data-diff-row")),
				),
			).toEqual(["removed", "added", "added", "removed"]);
			const geometry = await page.$$eval(
				"[data-git-staging-unit][data-inline] input, [data-git-staging-unit][data-inline] button",
				(controls) =>
					controls.map((control) => {
						const bounds = control.getBoundingClientRect();
						return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth;
					}),
			);
			expect(geometry.length).toBeGreaterThan(0);
			expect(geometry.every(Boolean)).toBe(true);
			const beforeTop = await page.$eval(BLOCK_SCROLL, (node) => node.scrollTop);
			await page.focus('[data-git-staging-unit="block-0"] button[data-git-staging-unit-menu]');
			await page.keyboard.press("Enter");
			await page.waitForSelector("[data-git-staging-unit-targets]", { visible: true });
			// Mantine focuses the dropdown asynchronously. Wait for its focus and
			// opening transition before explicitly testing Escape on the trigger.
			await page.waitForFunction(() => {
				const menu = document.querySelector("[data-git-staging-unit-targets]");
				return menu?.contains(document.activeElement) && getComputedStyle(menu).opacity === "1";
			});
			await page.focus('[data-git-staging-unit="block-0"] button[data-git-staging-unit-menu]');
			expect(
				await page.evaluate(() => document.activeElement?.matches("[data-git-staging-unit-menu]")),
			).toBe(true);
			await page.keyboard.press("Escape");
			await page.waitForSelector("[data-git-staging-unit-targets]", { hidden: true });
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, ["block-1", "block-2"]);
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.failNextStagingMove(500);
				current.holdStagingMove();
			});
			await page.click('[data-git-staging-unit="block-0"] button[data-git-staging-unit-menu]');
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="C"]', {
				visible: true,
			});
			await page.click('[data-git-staging-unit-targets] [data-git-staging-target="C"]');
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network
						.stagingMovePending,
			);
			await page.waitForFunction(() =>
				[
					...document.querySelectorAll<HTMLInputElement>(
						"[data-git-staging-preview] input[data-git-staging-unit-select]",
					),
				].every((input) => input.disabled),
			);
			expect(
				await page.$$eval(
					"[data-git-staging-preview] input[data-git-staging-unit-select]",
					(inputs) => inputs.every((input) => (input as HTMLInputElement).disabled),
				),
			).toBe(true);
			await page.$eval('button[data-git-staging-unit-active="block-0"]', (button) =>
				(button as HTMLButtonElement).click(),
			);
			expect((await snapshot(page)).network.stagingActionRequests).toHaveLength(1);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseStagingMove(),
			);
			await page.waitForSelector("[data-git-staging-preview] [role=alert]");
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, ["block-1", "block-2"]);
			expect(
				Math.abs((await page.$eval(BLOCK_SCROLL, (node) => node.scrollTop)) - beforeTop),
			).toBeLessThanOrEqual(1);
			await page.keyboard.press("Escape");
			await page.click('button[data-git-staging-unit-active="block-0"]');
			await waitBlockUnits(page, ["block-1", "block-2", "block-3"]);
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, ["block-1", "block-2"]);
			expect(
				Math.abs((await page.$eval(BLOCK_SCROLL, (node) => node.scrollTop)) - beforeTop),
			).toBeLessThanOrEqual(30);
			await page.click('[data-git-staging-unit="block-3"] button[data-git-staging-unit-menu]');
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="C"]', {
				visible: true,
			});
			await page.focus('[data-git-staging-unit-targets] [data-git-staging-target="C"]');
			await page.keyboard.press("Enter");
			await waitBlockUnits(page, ["block-1", "block-2"]);
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, ["block-1", "block-2"]);
			await expectBlockDiffBounded(page);
			await page.waitForSelector("[data-git-staging-unit-targets]", { hidden: true });
			await page.click("[data-git-staging-batch-menu]");
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="B"]', {
				visible: true,
			});
			await page.click('[data-git-staging-unit-targets] [data-git-staging-target="B"]');
			await page.waitForSelector("[data-git-staging-preview]", { hidden: true });
			const result = (await snapshot(page)).network;
			expect(
				result.stagingActionRequests.map((action) =>
					action.action === "move"
						? [action.fromListId, action.toListId, action.unitIds]
						: action.action,
				),
			).toEqual([
				["A", "C", ["block-0"]],
				["A", "B", ["block-0"]],
				["A", "C", ["block-3"]],
				["A", "B", ["block-1", "block-2"]],
			]);
			expect(result.stagingActions).toHaveLength(3);
			expect(
				result.stagingActionRequests.every(
					(action) => !("paths" in action) && !("scope" in action) && !("all" in action),
				),
			).toBe(true);
			expect(
				result.stagingDiffReads.some((read) => read.listId === "A" && read.status === 404),
			).toBe(true);
			expect(result.mutations).toEqual([]);
			expect(workers.some((worker) => worker.url().includes("git-changes-list.worker"))).toBe(true);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "mapped", width },
	);
}, 60_000);

test("block move offers other groups while retaining the active source and current selection", async () => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			await scrollBlockToUnit(page, "block-3");
			expect(await page.$('button[data-git-staging-unit-active="block-0"]')).toBeNull();
			expect(await page.$('button[data-git-staging-unit-active="block-3"]')).toBeNull();
			await page.click('input[data-git-staging-unit-select="block-0"]');
			await page.click('[data-git-staging-unit="block-3"] button[data-git-staging-unit-menu]');
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="A"]', {
				visible: true,
			});
			expect(
				await page.$eval(
					'[data-git-staging-unit-targets] [data-git-staging-target="A"]',
					(target) => (target as HTMLButtonElement).disabled,
				),
			).toBe(true);
			expect((await snapshot(page)).network.stagingActionRequests).toEqual([]);
			await page.focus('[data-git-staging-unit-targets] [data-git-staging-target="B"]');
			await page.keyboard.press("Enter");
			await waitBlockUnits(page, ["block-0", "block-1", "block-2"]);
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, ["block-0"]);
			await page.waitForSelector("[data-git-staging-unit-targets]", { hidden: true });
			await page.click("[data-git-staging-batch-menu]");
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="A"]', {
				visible: true,
			});
			expect(
				await page.$eval(
					'[data-git-staging-unit-targets] [data-git-staging-target="A"]',
					(target) => (target as HTMLButtonElement).disabled,
				),
			).toBe(true);
			await page.keyboard.press("Escape");
			await expectBlockSelection(page, ["block-0"]);
			expect((await snapshot(page)).network.stagingActions).toMatchObject([
				{
					action: "move",
					fromListId: "A",
					toListId: "B",
					unitIds: ["block-3"],
					expectedGeneration: 1,
					observationId: "fixture-o1",
				},
			]);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "source-active", width: 390 },
	);
}, 40_000);

test.each([
	"missing",
	"truncated",
	"structural",
] as const)("block move %s projections use explicit complete-unit fallback without guessed line selection", async (scenario) => {
	await withPage(
		async (page) => {
			await openBlockPreview(page, scenario === "structural");
			await page.waitForSelector("[data-git-staging-unit-fallback]");
			expect(
				await page.$eval("[data-git-staging-unit-fallback]", (list) =>
					Number(list.getAttribute("data-total")),
				),
			).toBe(scenario === "structural" ? 1 : 4);
			expect(await page.$("[data-git-staging-unit][data-inline]")).toBeNull();
			const unitId = scenario === "structural" ? "block-mode" : "block-0";
			await page.focus(`input[data-git-staging-unit-select="${unitId}"]`);
			await page.keyboard.press("Space");
			await expectBlockSelection(page, [unitId]);
			if (scenario === "structural")
				expect(
					await page.$eval("[data-git-patch-metadata]", (metadata) => metadata.textContent),
				).toContain("new mode 100755");
			await page.click("[data-git-staging-batch-menu]");
			await page.waitForSelector('[data-git-staging-unit-targets] [data-git-staging-target="B"]', {
				visible: true,
			});
			await page.click('[data-git-staging-unit-targets] [data-git-staging-target="B"]');
			if (scenario === "structural")
				await page.waitForSelector("[data-git-staging-preview]", { hidden: true });
			else {
				await waitBlockUnits(page, ["block-1", "block-2", "block-3"]);
				await expectBlockPreviewRetained(page);
			}
			expect((await snapshot(page)).network.stagingActions).toMatchObject([
				{ action: "move", fromListId: "A", toListId: "B", unitIds: [unitId] },
			]);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: scenario, width: 390 },
	);
}, 40_000);

test.each([
	"observation",
	"permission",
] as const)("block move clears obsolete selection and rejects a retained menu after %s changes", async (reason) => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			await scrollBlockToUnit(page, "block-0");
			await page.click('input[data-git-staging-unit-select="block-1"]');
			await page.click('[data-git-staging-unit="block-0"] button[data-git-staging-unit-menu]');
			const target = await page.waitForSelector(
				'[data-git-staging-unit-targets] [data-git-staging-target="C"]',
			);
			if (!target) throw new Error("Missing ownership destination");
			await page.evaluate(async (change) => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				if (change === "permission") current.setCanWrite(false);
				else await current.advanceStagingObservation();
			}, reason);
			await frames(page, 5);
			await target.evaluate((button) => (button as HTMLButtonElement).click());
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, []);
			expect((await snapshot(page)).network.stagingActionRequests).toEqual([]);
			if (reason === "permission") {
				expect(
					await page.$$eval(
						"[data-git-staging-preview] input[data-git-staging-unit-select], [data-git-staging-preview] button[data-git-staging-unit-active]",
						(controls) => controls.every((control) => (control as HTMLInputElement).disabled),
					),
				).toBe(true);
				await page.evaluate(() =>
					(window as unknown as FixtureWindow).gitChangesFixture.setCanWrite(true),
				);
				await frames(page);
				await expectBlockSelection(page, []);
			}
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "mapped", width: 390 },
	);
}, 40_000);

test("block move server conflict retains the preview and requires a fresh selection", async () => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			await scrollBlockToUnit(page, "block-0");
			await page.click('input[data-git-staging-unit-select="block-1"]');
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.failNextStagingMove(409),
			);
			await page.click('button[data-git-staging-unit-active="block-0"]');
			await page.waitForSelector("[data-git-staging-preview] [role=alert]");
			await frames(page, 5);
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, []);
			expect((await snapshot(page)).network.stagingActionRequests).toHaveLength(1);
			expect((await snapshot(page)).network.stagingActions).toEqual([]);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "mapped", width: 1100 },
	);
}, 40_000);

test("block move progressively loads 500-row segments while inline controls and the complete-unit list stay viewport bounded", async () => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			const initial = (await snapshot(page)).network.stagingDiffReads.at(-1);
			expect(initial?.units).toHaveLength(400);
			expect(initial?.unitMappings).toHaveLength(400);
			expect(initial?.rows).toBe(1201);
			expect(
				await page.$eval("[data-diff-content]", (content) =>
					Number(content.getAttribute("data-diff-projection-count")),
				),
			).toBe(500);
			expect(
				await page.$eval("[data-git-staging-unit-fallback]", (list) =>
					Number(list.getAttribute("data-total")),
				),
			).toBe(234);
			await expectBlockDiffBounded(page);
			for (const loaded of [1000, 1201]) {
				await page.$eval(BLOCK_SCROLL, (viewport) => {
					viewport.scrollTop = Math.max(0, viewport.scrollHeight - 3 * viewport.clientHeight);
					viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
				});
				await frames(page);
				const priorHeight = await page.$eval(BLOCK_SCROLL, (viewport) => viewport.scrollHeight);
				await page.$eval(BLOCK_SCROLL, (viewport) => {
					viewport.scrollTop = viewport.scrollHeight;
					viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
				});
				await page.waitForFunction(
					(count) => {
						const patch = document.querySelector(
							"[data-git-staging-preview] [data-git-patch-view]",
						);
						const fallback = patch?.querySelector("[data-git-staging-unit-fallback]");
						return count === 1000
							? patch?.textContent?.includes("Showing 1000 of 1201 lines") &&
									fallback?.getAttribute("data-total") === "67"
							: !!patch && !patch.textContent?.includes("scroll down to load more") && !fallback;
					},
					{},
					loaded,
				);
				await page.waitForFunction(
					(height) => {
						const viewport = document.querySelector<HTMLElement>(
							"[data-git-staging-preview] [data-content-scrollport]",
						);
						return !!viewport && viewport.scrollHeight > height + viewport.clientHeight;
					},
					{},
					priorHeight,
				);
				await frames(page);
				await expectBlockDiffBounded(page);
			}
			expect(await page.$("[data-git-staging-unit-fallback]")).toBeNull();
			await page.click("[data-git-staging-show-units]");
			await page.waitForSelector('[data-git-staging-unit-fallback][data-total="400"]');
			await page.$eval("[data-git-staging-unit-fallback]", (list) => {
				list.scrollTop = list.scrollHeight;
				list.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			await page.waitForSelector(
				'[data-git-staging-unit-fallback] input[data-git-staging-unit-select="block-399"]',
			);
			await page.focus(
				'[data-git-staging-unit-fallback] input[data-git-staging-unit-select="block-399"]',
			);
			await page.keyboard.press("Space");
			await expectBlockDiffBounded(page);
			expect(
				await page.$$eval(
					"[data-git-staging-unit-fallback] input[data-git-staging-unit-select]:checked",
					(inputs) => inputs.map((input) => input.getAttribute("data-git-staging-unit-select")),
				),
			).toEqual(["block-399"]);
			expect((await snapshot(page)).network.stagingActionRequests).toEqual([]);
			await expectBlockPreviewRetained(page);
			await page.click("[data-git-staging-show-units]");
			await page.waitForSelector("[data-git-staging-unit-fallback]", { hidden: true });
			await scrollBlockToUnit(page, "block-350");
			async function readingAnchor() {
				return page.evaluate(() => {
					const viewport = document.querySelector<HTMLElement>(
						"[data-git-staging-preview] [data-content-scrollport]",
					);
					if (!viewport) throw new Error("Missing diff scrollport");
					const top = viewport.getBoundingClientRect().top;
					const row = [...viewport.querySelectorAll<HTMLElement>("[data-diff-row]")].find(
						(candidate) => candidate.getBoundingClientRect().bottom > top + 1,
					);
					if (!row) throw new Error("Missing visible diff reading anchor");
					return {
						index: Number(row.dataset.diffLineIndex),
						text: [...row.querySelectorAll("[data-diff-visual-line]")]
							.map((line) => line.textContent ?? "")
							.join(""),
						gutter: row.querySelector("[data-diff-gutter]")?.textContent ?? "",
						y: row.getBoundingClientRect().top - top,
						scrollTop: viewport.scrollTop,
					};
				});
			}
			const beforeMove = await readingAnchor();
			expect(beforeMove.scrollTop).toBeGreaterThan(18_000);
			expect(beforeMove.index).toBeGreaterThan(1_000);
			expect(beforeMove.text.length).toBeGreaterThan(0);
			expect(beforeMove.gutter.length).toBeGreaterThan(0);
			await page.click('button[data-git-staging-unit-active="block-350"]');
			await page.waitForFunction(() => {
				const latest = (window as unknown as FixtureWindow).gitChangesFixture
					.snapshot()
					.network.stagingDiffReads.at(-1);
				return (
					latest?.units.length === 399 && latest.units.every((unit) => unit.id !== "block-350")
				);
			});
			await frames(page, 8);
			const afterMove = await readingAnchor();
			console.info("Staging distant reading anchor", JSON.stringify({ beforeMove, afterMove }));
			expect(afterMove.index).toBe(beforeMove.index);
			expect(afterMove.text).toBe(beforeMove.text);
			expect(afterMove.gutter).toBe(beforeMove.gutter);
			expect(Math.abs(afterMove.y - beforeMove.y)).toBeLessThanOrEqual(1);
			expect(Math.abs(afterMove.scrollTop - beforeMove.scrollTop)).toBeLessThanOrEqual(1);
			await expectBlockPreviewRetained(page);
			await scrollBlockToUnit(page, "block-399");
			expect(
				await page.$eval(
					'[data-git-staging-unit][data-inline] input[data-git-staging-unit-select="block-399"]',
					(input) => (input as HTMLInputElement).checked,
				),
			).toBe(true);
			await expectBlockDiffBounded(page);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "large", width: 390 },
	);
}, 60_000);

test.each([
	1100, 390,
])("observation messages retain the preview, retire old writes and make one shared refresh at %ipx", async (width) => {
	await withPage(
		async (page) => {
			await openBlockPreview(page, false, true);
			await scrollBlockToUnit(page, "block-0");
			const before = (await snapshot(page)).network;
			const top = await page.$eval(BLOCK_SCROLL, (viewport) => viewport.scrollTop);
			const transport = await page.evaluate(async () => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				const before = await current.observationControl("snapshot");
				current.setExtraStagingReader(true);
				return before;
			});
			await frames(page, 5);
			const shared = await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("snapshot"),
			);
			expect(shared?.requests.filter((request) => request === "subscribe")).toHaveLength(
				transport?.requests.filter((request) => request === "subscribe").length ?? 0,
			);
			expect(shared?.subscriptions).toBe(1);
			await page.click('input[data-git-staging-unit-select="block-1"]');
			await page.click('[data-git-staging-unit="block-0"] button[data-git-staging-unit-menu]');
			const retiredTarget = await page.waitForSelector(
				'[data-git-staging-unit-targets] [data-git-staging-target="C"]',
			);
			if (!retiredTarget) throw new Error("Missing retained menu destination");
			for (const status of ["pending", "observing", "failed"] as const) {
				await page.evaluate(
					(next) =>
						(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
							status: next,
							...(next === "failed" ? { overrides: { errorCode: "GIT_STAGING_GIT_FAILED" } } : {}),
						}),
					status,
				);
				await page.waitForSelector(`[data-git-staging-observation="${status}"]`);
				await page.waitForSelector("[data-git-staging-preview-writable]", { hidden: true });
				await expectBlockPreviewRetained(page);
				await expectBlockSelection(page, []);
				expect(
					Math.abs((await page.$eval(BLOCK_SCROLL, (viewport) => viewport.scrollTop)) - top),
				).toBeLessThanOrEqual(1);
				expect(
					await page.$$eval(
						"[data-git-staging-preview] input[data-git-staging-unit-select]",
						(inputs) => inputs.every((input) => (input as HTMLInputElement).disabled),
					),
				).toBe(true);
			}
			await retiredTarget.evaluate((button) => (button as HTMLButtonElement).click());
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("inject", {
					status: "settled",
					overrides: { stateSequence: 1, epoch: 0, completedEpoch: 0 },
				}),
			);
			await frames(page, 5);
			expect(await page.$('[data-git-staging-observation="failed"]')).not.toBeNull();
			expect((await snapshot(page)).network.stagingActionRequests).toEqual([]);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
					status: "settled",
				}),
			);
			await page.waitForSelector("[data-git-staging-preview-writable]");
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, []);
			const unchanged = (await snapshot(page)).network;
			expect(unchanged.stagingReads).toEqual(before.stagingReads);
			expect(unchanged.stagingDiffReads).toEqual(before.stagingDiffReads);
			await page.click('[role="dialog"] button[aria-label="Close"]');
			await page.waitForSelector("[data-git-staging-preview]", { hidden: true });
			await page.waitForSelector('[role="dialog"]', { hidden: true });
			await frames(page, 12);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("hold-sync"),
			);
			await page.click("[data-git-staging-refresh]");
			await page.waitForSelector('[data-git-staging-observation="observing"]');
			const refreshing = (await snapshot(page)).network;
			expect(refreshing.stagingActionRequests.map((action) => action.action)).toEqual(["sync"]);
			expect(
				refreshing.observationTransport?.requests.filter((request) => request === "http-sync"),
			).toHaveLength(1);
			expect(
				refreshing.observationTransport?.requests.filter((request) => request === "ws-refresh"),
			).toHaveLength(0);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
					status: "settled",
				}),
			);
			await page.waitForSelector('[data-git-staging-observation="settled"]');
			await frames(page, 5);
			expect((await snapshot(page)).network.stagingReads).toEqual(before.stagingReads);
			expect((await snapshot(page)).network.stagingDiffReads).toEqual(before.stagingDiffReads);
			await expectStagingBounded(page);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "mapped", width },
	);
}, 60_000);

test.each([
	1100, 390,
])("observation updates only the changed group and preserves unmodified ownership at %ipx", async (width) => {
	await withPage(
		async (page) => {
			await openBlockPreview(page, false, true);
			await scrollBlockToUnit(page, "block-0");
			await page.click('input[data-git-staging-unit-select="block-1"]');
			const before = (await snapshot(page)).network;
			const top = await page.$eval(BLOCK_SCROLL, (viewport) => viewport.scrollTop);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.editStagingGroup("A"),
			);
			await page.waitForFunction(() => {
				const read = (window as unknown as FixtureWindow).gitChangesFixture
					.snapshot()
					.network.stagingDiffReads.at(-1);
				return (
					read?.generation === 2 && !!document.querySelector("[data-git-staging-preview-writable]")
				);
			});
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, []);
			const after = (await snapshot(page)).network;
			expect(after.stagingReads.filter((id) => id === "B")).toHaveLength(
				before.stagingReads.filter((id) => id === "B").length,
			);
			expect(after.stagingReads.filter((id) => id === "A")).toHaveLength(
				before.stagingReads.filter((id) => id === "A").length + 1,
			);
			expect(after.stagingDiffReads).toHaveLength(before.stagingDiffReads.length + 1);
			expect(
				after.stagingDiffReads
					.at(-1)
					?.units.map((unit) => [unit.id, unit.listId, unit.needsReview]),
			).toEqual([
				["block-0", "A", false],
				["block-1", "A", false],
				["block-2", "A", false],
				["block-3", "A", false],
			]);
			expect(
				Math.abs((await page.$eval(BLOCK_SCROLL, (viewport) => viewport.scrollTop)) - top),
			).toBeLessThanOrEqual(30);
			expect(
				await page.$eval(
					"[data-git-staging-preview] [data-git-patch-view]",
					(patch) => patch.textContent,
				),
			).toContain("new-one-edited-1");
			await page.evaluate(async () => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				await current.observationControl("state", { status: "pending" });
				await current.observationControl("state", { status: "settled" });
			});
			await page.waitForSelector("[data-git-staging-preview-writable]");
			await frames(page, 5);
			expect((await snapshot(page)).network.stagingReads).toEqual(after.stagingReads);
			expect((await snapshot(page)).network.stagingDiffReads).toEqual(after.stagingDiffReads);
			await expectBlockDiffBounded(page);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "source-active", width },
	);
}, 60_000);

test("observation transport restarts and cross-workspace late messages never restore obsolete preview writes", async () => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			await scrollBlockToUnit(page, "block-0");
			await page.click('input[data-git-staging-unit-select="block-1"]');
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("disconnect"),
			);
			await page.waitForSelector("[data-git-staging-preview-writable]", { hidden: true });
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, []);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
					status: "pending",
					overrides: {
						instanceId: "fixture-instance-2",
						stateSequence: 1,
						epoch: 1,
						completedEpoch: 0,
					},
				}),
			);
			await page.waitForSelector('[data-git-staging-observation="pending"]');
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("inject", {
					status: "settled",
					overrides: {
						instanceId: "fixture-instance-1",
						stateSequence: 999,
						epoch: 0,
						completedEpoch: 0,
					},
				}),
			);
			await frames(page, 5);
			expect(await page.$("[data-git-staging-preview-writable]")).toBeNull();
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
					status: "settled",
				}),
			);
			await page.waitForSelector("[data-git-staging-preview-writable]");
			await expectBlockPreviewRetained(page);
			await page.click('input[data-git-staging-unit-select="block-1"]');
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.setCanWrite(false),
			);
			await page.waitForSelector("[data-git-staging-preview-writable]", { hidden: true });
			await expectBlockSelection(page, []);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.switchWorkspace("workspace-b"),
			);
			await page.waitForSelector("[data-git-staging-preview]", { hidden: true });
			await page.click("aria/ChangeLists");
			await page.waitForSelector('[data-git-staging-observation="settled"]');
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("state", {
					workspaceKey: "workspace-b",
					status: "pending",
				}),
			);
			await page.waitForSelector('[data-git-staging-observation="pending"]');
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl(
					"inject-cross-workspace",
					{ workspaceKey: "workspace-a" },
				),
			);
			await frames(page, 5);
			expect(await page.$('[data-git-staging-observation="pending"]')).not.toBeNull();
			expect((await snapshot(page)).network.stagingActionRequests).toEqual([]);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "mapped", width: 390 },
	);
}, 60_000);

test("observation completion verifies a delayed older summary once before restoring preview writes", async () => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			await scrollBlockToUnit(page, "block-0");
			const before = (await snapshot(page)).network;
			await page.evaluate(() => {
				const current = (window as unknown as FixtureWindow).gitChangesFixture;
				current.holdStagingSummary();
				current.startStagingSummaryRead();
			});
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).gitChangesFixture.snapshot().network
						.stagingSummaryPending,
			);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.editStagingGroup("A"),
			);
			await page.waitForSelector("[data-git-staging-preview-writable]", { hidden: true });
			await expectBlockPreviewRetained(page);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.releaseStagingSummary(),
			);
			await page.waitForFunction(() => {
				const state = (window as unknown as FixtureWindow).gitChangesFixture.snapshot();
				return (
					state.network.stagingDiffReads.at(-1)?.generation === 2 &&
					!!document.querySelector("[data-git-staging-preview-writable]")
				);
			});
			await expectBlockPreviewRetained(page);
			const result = (await snapshot(page)).network;
			expect(
				result.stagingSummaryReads
					.slice(before.stagingSummaryReads.length)
					.map((read) => read.generation),
			).toEqual([1, 2]);
			await frames(page, 12);
			expect((await snapshot(page)).network.stagingSummaryReads).toEqual(
				result.stagingSummaryReads,
			);
			expect(result.stagingActionRequests).toEqual([]);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "source-active", width: 1100 },
	);
}, 60_000);

test("observation ignores an older ownership announcement after a newer HTTP result without requiring another state message", async () => {
	await withPage(
		async (page) => {
			await openBlockPreview(page);
			await scrollBlockToUnit(page, "block-0");
			await page.click('input[data-git-staging-unit-select="block-1"]');
			await page.click('button[data-git-staging-unit-active="block-0"]');
			await waitBlockUnits(page, ["block-1", "block-2", "block-3"]);
			await expectBlockSelection(page, ["block-1"]);
			const before = (await snapshot(page)).network;
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).gitChangesFixture.observationControl("old-change", {
					generation: 1,
					observationId: "fixture-o1",
					affectedListIds: ["A"],
				}),
			);
			await frames(page, 12);
			expect(await page.$("[data-git-staging-preview-writable]")).not.toBeNull();
			await expectBlockPreviewRetained(page);
			await expectBlockSelection(page, ["block-1"]);
			const after = (await snapshot(page)).network;
			expect(after.stagingReads).toEqual(before.stagingReads);
			expect(after.stagingDiffReads).toEqual(before.stagingDiffReads);
			expect(after.stagingSummaryReads).toEqual(before.stagingSummaryReads);
			expect(after.stagingActionRequests).toHaveLength(1);
		},
		"tree",
		{ total: 12, staging: true, canWrite: true, blockMove: "mapped", width: 390 },
	);
}, 60_000);
