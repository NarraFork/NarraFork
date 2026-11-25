/** Real Chromium + real panel, shared WS manager/hook, drop arbiter and HTTP client.
 * Only the server fixture is in-memory: never opens a user database or starts NarraFork.
 * Reproduce: bun test --isolate frontend/components/narrator/communication/topology.browser.test.ts
 * Screenshots: .narrafork/topology-shots (override COMMUNICATION_SHOTS).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	type CommunicationMutation,
	type CommunicationScope,
	type CommunicationTopology,
	canonicalCommunicationPair,
	diffCommunicationTopology,
} from "@shared/narrator-communication";
import type { ServerWebSocket } from "bun";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./topology.browser-fixture";
import { topologyFixture } from "./topology-fixture-data";

type Data = {
	subscriptions: Map<
		string,
		{ scope: CommunicationScope; previous: CommunicationTopology; seq: number }
	>;
	heartbeat?: ReturnType<typeof setInterval>;
};
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = resolve(process.env.COMMUNICATION_SHOTS ?? ".narrafork/topology-shots");
let browser: Browser;
let server: ReturnType<typeof Bun.serve<Data>>;
let topology = topologyFixture();
let failNext = false;
let delayNext = 0;
let receivedPongs = 0;
const mutations: { sourceId: string; mutation: CommunicationMutation }[] = [];
const communicationFrames: { type: string; subscriptionId: string }[] = [];
const frameListeners = new Set<() => void>();
function waitFrame(type: string, subscriptionId: string) {
	if (
		communicationFrames.some(
			(frame) => frame.type === type && frame.subscriptionId === subscriptionId,
		)
	)
		return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const listener = () => {
			if (
				communicationFrames.some(
					(frame) => frame.type === type && frame.subscriptionId === subscriptionId,
				)
			) {
				clearTimeout(timeout);
				frameListeners.delete(listener);
				resolve();
			}
		};
		const timeout = setTimeout(() => {
			frameListeners.delete(listener);
			reject(new Error(`Missing ${type} ${subscriptionId}`));
		}, 5000);
		frameListeners.add(listener);
	});
}
const sockets = new Set<ServerWebSocket<Data>>();
function publish() {
	for (const socket of sockets)
		for (const [id, subscription] of socket.data.subscriptions) {
			const next = { ...structuredClone(topology), scope: subscription.scope };
			socket.send(
				JSON.stringify({
					type: "communication_delta",
					subscriptionId: id,
					epoch: "fixture-epoch",
					baseSeq: subscription.seq,
					seq: ++subscription.seq,
					delta: diffCommunicationTopology(subscription.previous, next),
				}),
			);
			subscription.previous = next;
		}
}
function regroup() {
	for (const node of topology.nodes) {
		let cursor = node;
		const seen = new Set<string>();
		while (cursor.parentNarratorId && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			const parent = topology.nodes.find((n) => n.id === cursor.parentNarratorId);
			if (!parent) break;
			cursor = parent;
		}
		node.groupId = cursor.id;
	}
}

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	mkdirSync(shots, { recursive: true });
	const bundle = await Bun.build({
		entrypoints: [new URL("./topology.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("Missing fixture entry");
	server = Bun.serve<Data>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/ws/narrator")
				return srv.upgrade(request, { data: { subscriptions: new Map() } })
					? undefined
					: new Response("upgrade failed", { status: 400 });
			if (url.pathname === "/api/auth/me")
				return Response.json({ id: "fixture-user", username: "fixture", role: "user" });
			if (url.pathname.endsWith("/communication/candidates"))
				return Response.json({
					items: topology.nodes
						.filter(
							(n) =>
								n.id !== url.pathname.split("/")[3] &&
								(n.title ?? "")
									.toLowerCase()
									.includes((url.searchParams.get("q") ?? "").toLowerCase()),
						)
						.map((node) => ({
							id: node.id,
							title: node.title,
							status: node.status,
							isRecent: node.id === "external",
							canConnect: node.canConnect,
							lastActivityAt: "2026-01-15T12:00:00Z",
						})),
					hasMore: false,
				});
			if (url.pathname.endsWith("/communication") && request.method === "POST") {
				const sourceId = url.pathname.split("/")[3];
				const mutation = (await request.json()) as CommunicationMutation;
				mutations.push({ sourceId, mutation });
				if (delayNext) {
					const delay = delayNext;
					delayNext = 0;
					await Bun.sleep(delay);
				}
				if (failNext) {
					failNext = false;
					return Response.json(
						{ error: "Relationship changed; retry with current version", code: "CONFLICT" },
						{ status: 409 },
					);
				}
				const node = topology.nodes.find((n) => n.id === sourceId);
				if (!node?.canManage) return Response.json({ error: "Read only" }, { status: 403 });
				if (mutation.kind === "split" || mutation.kind === "restore") {
					if (node.version !== mutation.version)
						return Response.json({ error: "Version conflict" }, { status: 409 });
					node.parentNarratorId = mutation.kind === "split" ? null : node.restoreParentId;
					node.version++;
					regroup();
				} else if (mutation.kind === "connect") {
					if (
						!topology.peers.some(
							(p) =>
								[p.endpointLo, p.endpointHi].includes(sourceId) &&
								[p.endpointLo, p.endpointHi].includes(mutation.targetNarratorId),
						)
					) {
						const [endpointLo, endpointHi] = canonicalCommunicationPair(
							sourceId,
							mutation.targetNarratorId,
						);
						topology.peers.push({
							id: `peer-${mutations.length}`,
							endpointLo,
							endpointHi,
							createdAt: "2026-01-15T12:00:00Z",
							canDisconnect: true,
						});
					}
				} else {
					const peer = topology.peers.find((p) => p.id === mutation.peerId);
					if (!peer) return Response.json({ error: "Stale relation" }, { status: 404 });
					topology.peers = topology.peers.filter((p) => p !== peer);
				}
				publish();
				return Response.json({ changed: true });
			}
			if (url.pathname === "/")
				return new Response(
					`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${[
						...assets.keys(),
					]
						.filter((path) => path.endsWith(".css"))
						.map((path) => `<link rel="stylesheet" href="${path}">`)
						.join(
							"",
						)}<style>html,body{margin:0;background:#16171b}button{font:inherit}#root{padding:12px;box-sizing:border-box}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				socket.send(JSON.stringify({ type: "ping" }));
				socket.data.heartbeat = setInterval(
					() => socket.send(JSON.stringify({ type: "ping" })),
					250,
				);
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw));
				if (frame.type.startsWith("communication_")) {
					communicationFrames.push({ type: frame.type, subscriptionId: frame.subscriptionId });
					for (const listener of frameListeners) listener();
				}
				if (frame.type === "pong") {
					receivedPongs++;
					return;
				}
				if (frame.type === "communication_subscribe") {
					const initial = { ...structuredClone(topology), scope: frame.scope };
					socket.data.subscriptions.set(frame.subscriptionId, {
						scope: frame.scope,
						previous: initial,
						seq: 0,
					});
					socket.send(
						JSON.stringify({
							type: "communication_snapshot",
							subscriptionId: frame.subscriptionId,
							epoch: "fixture-epoch",
							seq: 0,
							topology: initial,
						}),
					);
				} else if (frame.type === "communication_unsubscribe")
					socket.data.subscriptions.delete(frame.subscriptionId);
			},
			close(socket) {
				clearInterval(socket.data.heartbeat);
				socket.data.heartbeat = undefined;
				sockets.delete(socket);
			},
		},
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
}, 60_000);
afterAll(async () => {
	for (const socket of sockets) clearInterval(socket.data.heartbeat);
	await browser?.close();
	server?.stop(true);
});
async function call<T>(page: Page, fn: (fixture: typeof Fixture) => T): Promise<T> {
	return page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;
}
async function open(
	width = 1024,
	options: {
		readOnly?: boolean;
		touch?: boolean;
		height?: number;
		team?: boolean;
		withComposer?: boolean;
	} = {},
) {
	topology = topologyFixture(options.readOnly);
	mutations.length = 0;
	communicationFrames.length = 0;
	failNext = false;
	delayNext = 0;
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	page.setDefaultTimeout(5000);
	await page.setViewport({
		width: Math.max(width + 24, options.touch ? width : 1100),
		height: (options.height ?? 820) + 24,
		isMobile: !!options.touch,
		hasTouch: !!options.touch,
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin);
	await page.waitForFunction("window.fixture?.ready()");
	await page.evaluate(
		`window.fixture.mount(${width},${options.height ?? 820},${!!options.team},${!!options.withComposer})`,
	);
	await page.waitForSelector('[data-topology-node="helper"]');
	await page.waitForFunction(
		() =>
			document.querySelector('[data-topology-node="helper"]')?.getBoundingClientRect().width &&
			document.querySelector('[data-live="true"]'),
	);
	return { page, errors, close: () => context.close() };
}
async function point(page: Page, selector: string) {
	return page.$eval(selector, (element) => {
		const r = element.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
}
async function drag(page: Page, from: string, to: string) {
	const a = await point(page, from);
	const b = await point(page, to);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(a.x + 8, a.y + 4, { steps: 2 });
	await page.waitForSelector('[data-gesture="drag"]');
	await page.mouse.move(b.x, b.y, { steps: 8 });
	await page.mouse.up();
}
const handle = (id: string) => `[data-topology-node="${id}"] [data-topology-handle="node"]`;
const body = (id: string) => `[data-topology-node="${id}"] [data-topology-select]`;
async function waitMutation(page: Page, count: number) {
	await page.waitForFunction(
		() => !document.querySelector('[role="status"]')?.textContent?.includes("Saving"),
	);
	const started = Date.now();
	while (mutations.length < count && Date.now() - started < 3000)
		await new Promise((r) => setTimeout(r, 10));
	expect(mutations.length).toBe(count);
}
async function screenshot(page: Page, name: string) {
	const frame = await page.$("#frame");
	if (!frame) throw new Error("Missing screenshot frame");
	await frame.screenshot({ path: resolve(shots, `${name}.png`) });
}

test.each([
	360, 1024,
])("%ipx cards reuse RecentTabs session/subagent icons and apply live status deltas", async (width) => {
	const { page, errors, close } = await open(width);
	try {
		const root = '[data-topology-node="root"] [data-topology-select]';
		const helper = '[data-topology-node="helper"] [data-topology-select]';
		expect(
			await page.$$eval("[data-topology-group]", (groups) =>
				groups.map((group) => group.querySelector("span")?.textContent),
			),
		).toEqual(["Release crew", "Design studio"]);
		const rows = await page.$$eval("[data-topology-node]", (cards) =>
			cards.map((card) => {
				const row = card.querySelector<HTMLElement>("[data-topology-select]");
				const icon = row?.firstElementChild?.getBoundingClientRect();
				const title = row?.lastElementChild?.getBoundingClientRect();
				if (!row || !icon || !title) throw new Error("Missing single-line card");
				const label = row.getAttribute("aria-label");
				if (!label) throw new Error("Missing accessible narrator name");
				return {
					text: row.textContent,
					title: label,
					height: card.getBoundingClientRect().height,
					singleLine:
						getComputedStyle(row).display === "flex" &&
						icon.right <= title.left &&
						Math.abs(icon.top + icon.height / 2 - title.top - title.height / 2) < 1,
				};
			}),
		);
		for (const row of rows) {
			expect(row.text).toBe(row.title);
			expect(row.height).toBe(48);
			expect(row.singleLine).toBe(true);
		}
		await call(page, (fixture) => fixture.language("zh-CN"));
		await screenshot(page, `compact-zh-${width}`);
		expect(await page.$(`${root} .tabler-icon-message-circle`)).not.toBeNull();
		expect(await page.$(`${helper} .tabler-icon-robot`)).not.toBeNull();
		const before = await page.$eval('[data-testid="topology-scene"]', (element) =>
			[...element.querySelectorAll<HTMLElement>("[data-topology-node]")].map((node) => [
				node.dataset.topologyNode,
				node.style.left,
				node.style.top,
				node.style.height,
			]),
		);
		topology.nodes[0].status = "waiting";
		topology.nodes[2].status = "working";
		topology.nodes[2].substatus = ["reasoning"];
		publish();
		await page.waitForSelector(`${root} [data-tab-shape="alert"]`);
		await page.waitForSelector(`${helper} .tabler-icon-brain`);
		expect(await page.$(`${root} .tabler-icon-message-circle-filled`)).not.toBeNull();
		expect(await page.$(`${helper} [data-tab-shape]`)).toBeNull();
		const bounds = await page.$eval(`${helper} .tabler-icon-brain`, (element) => {
			const marker = element.getBoundingClientRect();
			const card = element.closest("[data-topology-select]")?.getBoundingClientRect();
			if (!card) throw new Error("Missing icon host");
			return (
				marker.top >= card.top &&
				marker.left >= card.left &&
				marker.right <= card.right &&
				marker.bottom <= card.bottom
			);
		});
		expect(bounds).toBe(true);
		topology.nodes[0].status = "idle";
		topology.nodes[0].substatus = ["unread"];
		topology.nodes[2].status = "idle";
		topology.nodes[2].substatus = [];
		publish();
		await page.waitForSelector(`${root} [data-tab-shape="check"]`);
		await page.waitForFunction(
			(selector) => !document.querySelector(`${selector} .tabler-icon-brain`),
			{},
			helper,
		);
		const after = await page.$eval('[data-testid="topology-scene"]', (element) =>
			[...element.querySelectorAll<HTMLElement>("[data-topology-node]")].map((node) => [
				node.dataset.topologyNode,
				node.style.left,
				node.style.top,
				node.style.height,
			]),
		);
		expect(after).toEqual(before);
		expect(mutations).toHaveLength(0);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
}, 20_000);

test.each([
	"details",
	"drag",
	"undo",
])("only the Hi endpoint is writable: %s disconnect uses that endpoint", async (mode) => {
	const { page, errors, close } = await open();
	try {
		if (mode === "undo") {
			await call(page, (fixture) => fixture.sidebarDrop("worker", "external"));
			await waitMutation(page, 1);
			await page.waitForFunction(
				() => document.querySelectorAll('svg path[role="button"]').length === 2,
			);
		}
		const peer =
			mode === "undo" ? topology.peers.find((p) => p.id !== "initial-peer") : topology.peers[0];
		if (!peer) throw new Error("Missing precise relation");
		expect(peer.endpointHi).toBe("worker");
		for (const node of topology.nodes) {
			node.canManage = node.id === "worker";
			node.canConnect = node.id === "worker";
		}
		publish();
		await page.waitForFunction(
			() =>
				document
					.querySelector('[data-topology-node="reviewer"]')
					?.getAttribute("data-draggable") === "false",
		);
		if (mode === "undo") {
			await page.$$eval("button", (buttons) => {
				const undo = buttons.find((button) => button.textContent?.trim() === "Undo");
				if (!undo) throw new Error("Missing undo action");
				undo.click();
			});
		} else {
			const edge = await point(page, 'svg path[role="button"]');
			await page.mouse.click(edge.x, edge.y);
			await page.waitForSelector('[data-testid="topology-details"]');
			if (mode === "details") {
				await page.$$eval('[data-testid="topology-details"] button', (buttons) => {
					const disconnect = buttons.find((button) =>
						button.textContent?.includes("Disconnect link"),
					);
					if (!disconnect) throw new Error("Missing disconnect action");
					(disconnect as HTMLButtonElement).click();
				});
				await page.waitForSelector('[role="dialog"]');
				await page.click('[role="dialog"] button:last-child');
			} else {
				await page.click('[data-testid="topology-details"] button[aria-label="Close"]');
				const handle = await point(page, '[data-topology-handle="peer"]');
				await page.mouse.move(handle.x, handle.y);
				await page.mouse.down();
				await page.mouse.move(handle.x - 8, handle.y + 4);
				await page.waitForSelector('[data-topology-drop="disconnect"]');
				const target = await point(page, '[data-topology-drop="disconnect"]');
				await page.mouse.move(target.x, target.y, { steps: 8 });
				await page.mouse.up();
			}
		}
		await waitMutation(page, mode === "undo" ? 2 : 1);
		expect(mutations.at(-1)).toEqual({
			sourceId: "worker",
			mutation: { kind: "disconnect", peerId: peer.id },
		});
		expect(topology.peers.some((p) => p.id === peer.id)).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
}, 30_000);

test("dock visibility unsubscribes and reopens a fresh snapshot without unmounting the sibling composer", async () => {
	const { page, errors, close } = await open(720, { withComposer: true });
	await page.type('[data-testid="persistent-composer"]', " · keep while hidden");
	const draft = await page.$eval('[data-testid="persistent-composer"]', (element) => {
		(element as HTMLElement).dataset.identity = "same-composer";
		return (element as HTMLTextAreaElement).value;
	});
	const initial = communicationFrames.find((frame) => frame.type === "communication_subscribe");
	if (!initial) throw new Error("Real hook did not subscribe");
	await call(page, (fixture) => fixture.setPanelVisible(false));
	await waitFrame("communication_unsubscribe", initial.subscriptionId);
	expect([...sockets].reduce((sum, socket) => sum + socket.data.subscriptions.size, 0)).toBe(0);
	await page.waitForFunction(() => document.querySelectorAll("[data-topology-node]").length === 0);
	topology.nodes[2].title = "Fresh snapshot after hidden tab";
	publish();
	expect(await call(page, (fixture) => fixture.composerLifecycle())).toEqual({
		mounts: 1,
		unmounts: 0,
	});
	await call(page, (fixture) => fixture.setPanelVisible(true));
	await page.waitForFunction(() =>
		document
			.querySelector('[data-topology-node="helper"]')
			?.textContent?.includes("Fresh snapshot after hidden tab"),
	);
	const current = communicationFrames
		.filter((frame) => frame.type === "communication_subscribe")
		.at(-1);
	expect(current?.subscriptionId).not.toBe(initial.subscriptionId);
	expect(
		await page.$eval(
			'[data-testid="persistent-composer"]',
			(element) => (element as HTMLTextAreaElement).value,
		),
	).toBe(draft);
	expect(
		await page.$eval(
			'[data-testid="persistent-composer"]',
			(element) => (element as HTMLElement).dataset.identity,
		),
	).toBe("same-composer");
	expect(await call(page, (fixture) => fixture.composerLifecycle())).toEqual({
		mounts: 1,
		unmounts: 0,
	});
	// A projection revocation during a drag must also discard ephemeral source identities.
	const source = await point(page, handle("helper"));
	await page.mouse.move(source.x, source.y);
	await page.mouse.down();
	await page.mouse.move(source.x + 9, source.y + 3);
	await page.waitForSelector('[data-testid="topology-drag-preview"]');
	topology.nodes = topology.nodes.filter((node) => node.id !== "helper");
	publish();
	await page.waitForSelector('[data-gesture="idle"]');
	expect(await page.$('[data-testid="topology-drag-preview"]')).toBeNull();
	expect(await page.$('[data-topology-node="helper"]')).toBeNull();
	await page.mouse.up();
	expect(mutations).toHaveLength(0);
	expect(errors).toEqual([]);
	await close();
}, 30_000);

test("actual container widths 280/360/420/720/1024 retain readable cards, no overlap and exact SVG endpoints", async () => {
	const { page, errors, close } = await open();
	for (const width of [280, 360, 420, 720, 1024]) {
		await page.evaluate(
			(width) => (window as unknown as { fixture: typeof Fixture }).fixture.resize(width),
			width,
		);
		await page.waitForFunction(
			(width) =>
				Math.abs(
					(document.querySelector('[data-testid="communication-topology"]')?.getBoundingClientRect()
						.width ?? 0) - width,
				) < 1 &&
				(document.querySelector('[data-testid="topology-scene"]') as HTMLElement)?.style.width ===
					`${width}px`,
			{},
			width,
		);
		const geometry = await page.evaluate(() => ({
			width: document
				.querySelector('[data-testid="communication-topology"]')
				?.getBoundingClientRect().width,
			nodes: [...document.querySelectorAll<HTMLElement>("[data-topology-node]")].map((el) => {
				const select = el.querySelector("[data-topology-select]");
				const handle = el.querySelector("button");
				if (!select || !handle) throw new Error("Missing accessible card actions");
				return {
					id: el.dataset.topologyNode,
					x: el.offsetLeft,
					y: el.offsetTop,
					width: el.offsetWidth,
					height: el.offsetHeight,
					font: getComputedStyle(select).fontSize,
					handle: handle.getBoundingClientRect().width,
				};
			}),
			paths: [...document.querySelectorAll("svg path[role=button]")].map((el) =>
				el.getAttribute("d"),
			),
		}));
		expect(geometry.width).toBe(width);
		for (const node of geometry.nodes) {
			expect(node.width).toBeGreaterThan(160);
			expect(node.x + node.width).toBeLessThan(width);
			expect(node.font).toBe("14px");
			expect(node.handle).toBeGreaterThanOrEqual(44);
		}
		for (const a of geometry.nodes)
			for (const b of geometry.nodes)
				if (a !== b)
					expect(
						a.x + a.width <= b.x ||
							b.x + b.width <= a.x ||
							a.y + a.height <= b.y ||
							b.y + b.height <= a.y,
					).toBe(true);
		expect(geometry.paths).toHaveLength(1);
		const worker = geometry.nodes.find((node) => node.id === "worker");
		const reviewer = geometry.nodes.find((node) => node.id === "reviewer");
		if (!worker || !reviewer) throw new Error("Missing rendered exact peer endpoints");
		const path = geometry.paths[0] ?? "";
		if (width >= 720) {
			expect(path.startsWith(`M${worker.x + worker.width},${worker.y + worker.height / 2}`)).toBe(
				true,
			);
			expect(path.endsWith(`${reviewer.x},${reviewer.y + reviewer.height / 2}`)).toBe(true);
		} else {
			expect(
				path.startsWith(`M${reviewer.x + reviewer.width},${reviewer.y + reviewer.height / 2}`),
			).toBe(true);
			expect(path.endsWith(`V${worker.y + worker.height / 2} H${worker.x + worker.width}`)).toBe(
				true,
			);
		}
		await screenshot(page, `container-${width}`);
	}
	expect(errors).toEqual([]);
	await close();
}, 30_000);

test("drag creates exact peer, pending keeps geometry stable, state deltas never reset view; failed CAS restores unchanged graph", async () => {
	const { page, errors, close } = await open();
	delayNext = 250;
	await drag(page, handle("helper"), body("external"));
	await page.waitForFunction(() => document.body.textContent?.includes("Saving"));
	await screenshot(page, "desktop-pending-connect");
	await waitMutation(page, 1);
	expect(mutations[0]).toEqual({
		sourceId: "helper",
		mutation: { kind: "connect", targetNarratorId: "external" },
	});
	await page.waitForFunction(
		() => document.querySelectorAll('svg path[role="button"]').length === 2,
	);
	const before = await page.$eval('[data-testid="topology-scene"]', (el) => ({
		transform: (el as HTMLElement).style.transform,
		cards: [...el.querySelectorAll<HTMLElement>("[data-topology-node]")].map((n) => [
			n.dataset.topologyNode,
			n.style.left,
			n.style.top,
		]),
	}));
	topology.nodes[2].status = "working";
	topology.nodes[2].title = "Changed title, stable layout";
	publish();
	await page.waitForFunction(() => document.body.textContent?.includes("Changed title"));
	const after = await page.$eval('[data-testid="topology-scene"]', (el) => ({
		transform: (el as HTMLElement).style.transform,
		cards: [...el.querySelectorAll<HTMLElement>("[data-topology-node]")].map((n) => [
			n.dataset.topologyNode,
			n.style.left,
			n.style.top,
		]),
	}));
	expect(after).toEqual(before);
	failNext = true;
	await drag(page, handle("root"), body("external"));
	await page.waitForSelector('[role="alert"]');
	expect(topology.peers).toHaveLength(2);
	expect(await page.$eval('[role="alert"]', (el) => el.textContent)).toContain(
		"not been changed locally",
	);
	await screenshot(page, "desktop-failed-cas");
	expect(errors).toEqual([]);
	await close();
}, 30_000);

test("subtree split retains team and peers, designated restore wins over peer, selected-edge drag disconnects the exact relation", async () => {
	const { page, errors, close } = await open();
	const source = await point(page, handle("worker"));
	await page.mouse.move(source.x, source.y);
	await page.mouse.down();
	await page.mouse.move(source.x + 9, source.y + 3);
	await page.waitForSelector('[data-topology-drop="split"]');
	const split = await point(page, '[data-topology-drop="split"]');
	await page.mouse.move(split.x, split.y, { steps: 8 });
	await page.mouse.up();
	await waitMutation(page, 1);
	expect(mutations[0]?.mutation).toEqual({ kind: "split", version: 1 });
	expect(topology.nodes.find((n) => n.id === "helper")?.groupId).toBe("worker");
	expect(topology.nodes.find((n) => n.id === "worker")?.team?.name).toBe("Release crew");
	expect(topology.peers).toHaveLength(1);
	await page.waitForFunction(
		() => document.querySelectorAll('[data-topology-node="worker"]').length === 1,
	);
	await screenshot(page, "desktop-split-subtree");
	await drag(page, handle("worker"), body("root"));
	await waitMutation(page, 2);
	expect(mutations[1]?.mutation).toEqual({ kind: "restore", version: 2 });
	await page.waitForFunction(
		() =>
			document.querySelector('[data-topology-node="worker"]')?.getBoundingClientRect().x ===
			(document.querySelector('[data-topology-node="helper"]')?.getBoundingClientRect().x ?? -100) -
				10,
	);
	const edgePoint = await page.$eval('svg path[role="button"]', (element) => {
		const path = element as SVGPathElement;
		const point = path.getPointAtLength(path.getTotalLength() / 2);
		const matrix = path.getScreenCTM();
		if (!matrix) throw new Error("Unrendered precise peer line");
		const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
		return { x: screen.x, y: screen.y };
	});
	await page.mouse.click(edgePoint.x, edgePoint.y);
	await page.waitForSelector('[data-testid="topology-details"]');
	await page.click('[data-testid="topology-details"] button[aria-label="Close"]');
	const peerSource = await point(page, '[data-topology-handle="peer"]');
	await page.mouse.move(peerSource.x, peerSource.y);
	await page.mouse.down();
	await page.mouse.move(peerSource.x - 8, peerSource.y + 4);
	await page.waitForSelector('[data-topology-drop="disconnect"]');
	const disconnect = await point(page, '[data-topology-drop="disconnect"]');
	await page.mouse.move(disconnect.x, disconnect.y, { steps: 8 });
	await page.mouse.up();
	await waitMutation(page, 3);
	expect(mutations[2]?.mutation).toEqual({
		kind: "disconnect",
		peerId: "initial-peer",
	});
	expect(topology.peers).toHaveLength(0);
	expect(errors).toEqual([]);
	await close();
}, 30_000);

test("keyboard candidate connection, reauthorized undo, sidebar arbiter and read-only onlooker", async () => {
	let current = await open();
	let page = current.page;
	await page.focus(body("helper"));
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="topology-details"]');
	await page.click('[data-testid="topology-details"] button');
	// Close retained selection; select again via keyboard, then use visible alternative action.
	await page.focus(body("helper"));
	await page.keyboard.press("Enter");
	await page.evaluate(() =>
		[...document.querySelectorAll<HTMLButtonElement>('[data-testid="topology-details"] button')]
			.find((b) => b.textContent?.includes("Connect session"))
			?.click(),
	);
	await page.waitForSelector('input[aria-label="Search sessions…"]');
	await page.type('input[aria-label="Search sessions…"]', "Design");
	await page.waitForFunction(() =>
		document.querySelector('[role="option"]')?.textContent?.includes("Design review"),
	);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await waitMutation(page, 1);
	await page.waitForFunction(() =>
		[...document.querySelectorAll("button")].some(
			(b) => b.textContent?.includes("Undo") && !b.disabled,
		),
	);
	await page.evaluate(() =>
		[...document.querySelectorAll<HTMLButtonElement>("button")]
			.find((b) => b.textContent?.includes("Undo"))
			?.click(),
	);
	await waitMutation(page, 2);
	expect(mutations[1]?.mutation.kind).toBe("disconnect");
	// Clear overlay then sidebar drop: topology wins over lower-priority workspace/dock listeners.
	await page.click('[data-testid="topology-details"] button[aria-label="Close"]');
	await call(page, (f) => f.sidebarDrop("root", "external"));
	await waitMutation(page, 3);
	expect(await call(page, (f) => f.fallbackDrops())).toBe(0);
	await call(page, (f) => f.sidebarDrop("__spec__", "external", "tool"));
	expect(mutations).toHaveLength(3);
	expect(await call(page, (f) => f.fallbackDrops())).toBe(1);
	await current.close();
	current = await open(360, { readOnly: true, team: true });
	page = current.page;
	expect(await page.$$eval('[data-topology-handle="node"]', (els) => els.length)).toBe(0);
	await page.click(body("worker"));
	await page.waitForSelector('[data-testid="topology-details"]');
	expect(await page.$eval('[data-testid="topology-details"]', (el) => el.textContent)).toContain(
		"Ship accessible communication topology",
	);
	expect(
		await page.$$eval('[data-testid="topology-details"] button', (els) =>
			els
				.filter(
					(el) =>
						el.textContent?.includes("Move out") || el.textContent?.includes("Connect session"),
				)
				.every((el) => (el as HTMLButtonElement).disabled),
		),
	).toBe(true);
	await screenshot(page, "mobile-readonly-team");
	expect(current.errors).toEqual([]);
	await current.close();
}, 30_000);

test("native mobile touch: handle connection, pan, long-press then second-finger pinch cancellation, drawer native scroll", async () => {
	const { page, errors, close } = await open(360, { touch: true, height: 900 });
	const client = await page.createCDPSession();
	const touch = (
		type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
		points: { x: number; y: number; id: number }[],
	) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points });
	const a = await point(page, handle("helper"));
	const b = await point(page, body("external"));
	await touch("touchStart", [{ ...a, id: 1 }]);
	await touch("touchMove", [{ x: a.x + 10, y: a.y + 3, id: 1 }]);
	await page.waitForSelector('[data-gesture="drag"]');
	await touch("touchMove", [{ ...b, id: 1 }]);
	await touch("touchEnd", []);
	await waitMutation(page, 1);
	await page.waitForFunction(
		() => document.querySelectorAll('svg path[role="button"]').length === 2,
	);
	const originalTransform = await page.$eval(
		'[data-testid="topology-scene"]',
		(el) => (el as HTMLElement).style.transform,
	);
	await touch("touchStart", [{ x: 345, y: 430, id: 1 }]);
	await touch("touchMove", [{ x: 345, y: 310, id: 1 }]);
	await touch("touchEnd", []);
	expect(
		await page.$eval('[data-testid="topology-scene"]', (el) => (el as HTMLElement).style.transform),
	).not.toBe(originalTransform);
	await page.click('button[aria-label="Reset view (100%)"]');
	const bodyPoint = await point(page, body("worker"));
	await touch("touchStart", [{ ...bodyPoint, id: 1 }]);
	await page.waitForSelector('[data-gesture="drag"]');
	await touch("touchStart", [
		{ ...bodyPoint, id: 1 },
		{ x: bodyPoint.x + 70, y: bodyPoint.y, id: 2 },
	]);
	await touch("touchMove", [
		{ x: bodyPoint.x - 20, y: bodyPoint.y, id: 1 },
		{ x: bodyPoint.x + 100, y: bodyPoint.y, id: 2 },
	]);
	await touch("touchEnd", []);
	expect(mutations).toHaveLength(1);
	expect(
		await page.$eval('[data-testid="topology-scene"]', (el) => (el as HTMLElement).style.transform),
	).not.toContain("scale(1)");
	await screenshot(page, "mobile-portrait-pinch");
	await page.click('button[aria-label="Reset view (100%)"]');
	const cancelled = await point(page, handle("worker"));
	await touch("touchStart", [{ ...cancelled, id: 1 }]);
	await touch("touchMove", [{ x: cancelled.x + 20, y: cancelled.y + 10, id: 1 }]);
	await page.waitForSelector('[data-gesture="drag"]');
	await touch("touchCancel", []);
	await page.waitForSelector('[data-gesture="idle"]');
	expect(mutations).toHaveLength(1);
	await page.click(body("helper"));
	await page.waitForSelector('[data-testid="topology-details"]');
	const drawer = await page.$eval('[data-testid="topology-details"]', (el) => ({
		overflow: getComputedStyle(el).overflowY,
		touchAction: getComputedStyle(el).touchAction,
	}));
	expect(drawer.overflow).toBe("auto");
	expect(drawer.touchAction).not.toBe("none");
	await screenshot(page, "mobile-details");
	await page.evaluate(() =>
		(window as unknown as { fixture: typeof Fixture }).fixture.resize(360, 420),
	);
	await page.waitForFunction(
		() =>
			(document.querySelector('[data-testid="topology-details"]')?.getBoundingClientRect().height ??
				1000) < 350,
	);
	const sceneBeforeScroll = await page.$eval(
		'[data-testid="topology-scene"]',
		(el) => (el as HTMLElement).style.transform,
	);
	await touch("touchStart", [{ x: 180, y: 340, id: 1 }]);
	await touch("touchMove", [{ x: 180, y: 260, id: 1 }]);
	await touch("touchMove", [{ x: 180, y: 180, id: 1 }]);
	await touch("touchEnd", []);
	await page.waitForFunction(
		() => (document.querySelector('[data-testid="topology-details"]')?.scrollTop ?? 0) > 30,
	);
	expect(
		await page.$eval('[data-testid="topology-scene"]', (el) => (el as HTMLElement).style.transform),
	).toBe(sceneBeforeScroll);
	await screenshot(page, "mobile-drawer-native-scroll");
	await page.click('[data-testid="topology-details"] button[aria-label="Close"]');
	await page.setViewport({ width: 744, height: 384, isMobile: true, hasTouch: true });
	await page.evaluate(() =>
		(window as unknown as { fixture: typeof Fixture }).fixture.resize(720, 360),
	);
	await screenshot(page, "mobile-landscape");
	await page.click('button[aria-label="Accessible relationship list"]');
	await touch("touchStart", [{ x: 240, y: 280, id: 1 }]);
	await touch("touchMove", [{ x: 240, y: 210, id: 1 }]);
	await touch("touchMove", [{ x: 240, y: 140, id: 1 }]);
	await touch("touchEnd", []);
	await page.waitForFunction(
		() => (document.querySelector('[data-testid="topology-list"]')?.scrollTop ?? 0) > 20,
	);
	await screenshot(page, "mobile-list-native-scroll");
	expect(mutations).toHaveLength(1);
	expect(receivedPongs).toBeGreaterThan(0);
	await call(page, (f) => f.disconnect());
	await page.waitForFunction(() => document.body.textContent?.includes("Not synced"));
	expect(await page.$$("[data-topology-node]")).toHaveLength(0);
	expect(errors).toEqual([]);
	await close();
}, 30_000);
