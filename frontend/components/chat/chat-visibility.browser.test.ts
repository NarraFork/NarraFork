import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { ChatMessage } from "../../lib/api/chat";
import type * as Fixture from "./chat-visibility.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const arrivals: { method: string; path: string; query: string; bytes: number }[] = [];
const unexpected: string[] = [];
let tailSeq = 100;
let edited = false;
let oversized = false;
const deletedSeqs = new Set<number>();
let releaseRecovery: (() => void) | undefined;
let recoveryGate: Promise<void> | undefined;
function message(seq: number): ChatMessage {
	return {
		id: `chat-${seq}`,
		roomId: "room-fixture",
		seq,
		kind: "text",
		contentText: deletedSeqs.has(seq)
			? ""
			: `CHAT_BODY_${seq} ${edited && seq === 79 ? "EDITED_WHILE_HIDDEN " : ""}${"This is the retained historical body. ".repeat(4)}`,
		replyToMessageId: null,
		replyToSeq: null,
		replyToSender: null,
		replyToPreview: null,
		attachments: [],
		editedAt: null,
		deletedAt: deletedSeqs.has(seq) ? "2026-11-24T09:01:00.000Z" : null,
		createdAt: "2026-11-24T09:00:00.000Z",
		sender: { id: "reader", username: "Reader", avatarColor: null, avatarImageId: null },
	};
}
beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "chat-visibility.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "chat-visibility-transport-only",
				setup(builder) {
					builder.onResolve({ filter: /lib\/narrator-ws-manager$/ }, () => ({
						path: join(import.meta.dir, "chat-visibility.browser-ws-fixture.ts"),
					}));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("Missing chat fixture entry");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const html = `<!doctype html><html><head><meta charset="utf-8">${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>html,body,#root{margin:0;min-height:100%;font-family:Arial,sans-serif}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 30,
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			const asset = assets.get(path);
			if (asset) return new Response(asset);
			const record = { method: request.method, path, query: url.search, bytes: 0 };
			arrivals.push(record);
			const json = (value: unknown) => {
				const body = JSON.stringify(value);
				record.bytes = new TextEncoder().encode(body).byteLength;
				return new Response(body, { headers: { "content-type": "application/json" } });
			};
			if (path === "/api/health")
				return json({
					status: "ok",
					platform: "linux",
					runtimeEnvironment: { android: false, proot: false, termux: false },
				});
			if (path === "/api/auth/me")
				return json({
					id: "reader",
					username: "Reader",
					role: "user",
					avatarColor: null,
					avatarImageId: null,
				});
			if (path === "/api/user-preferences/ui") return json({ autoLoadOlderMessages: false });
			if (path === "/api/chat/rooms/narrator/fixture")
				return json({
					id: "room-fixture",
					kind: "narrator",
					narratorId: "fixture",
					peer: null,
					unread: 0,
					unreadCapped: false,
					lastReadSeq: 0,
					muted: false,
					lastMessageAt: null,
					lastMessagePreview: null,
					lastMessageSenderId: null,
				});
			if (path === "/api/chat/rooms/room-fixture/read" && request.method === "POST") {
				const body = (await request.json()) as { seq?: number; lastReadSeq?: number };
				return json({ lastReadSeq: body.seq ?? body.lastReadSeq ?? 100 });
			}
			if (path === "/api/chat/rooms/room-fixture/messages") {
				const after = url.searchParams.has("afterSeq")
					? Number(url.searchParams.get("afterSeq"))
					: undefined;
				const before = url.searchParams.has("beforeSeq")
					? Number(url.searchParams.get("beforeSeq"))
					: undefined;
				const limit = Number(url.searchParams.get("limit") ?? 40);
				if (after !== undefined && recoveryGate) await recoveryGate;
				if (after !== undefined && oversized)
					return json({ padding: "x".repeat(33 * 1024 * 1024) });
				const end = Math.min(tailSeq, (before ?? tailSeq + 1) - 1);
				const start = after === undefined ? Math.max(1, end - limit + 1) : after + 1;
				const seqs = Array.from(
					{ length: Math.max(0, Math.min(limit, end - start + 1)) },
					(_, i) => start + i,
				);
				const messages = seqs.map(message);
				return json({
					messages,
					hasMore: start > 1,
					nextBeforeSeq: messages[0]?.seq ?? null,
					hasNext: after !== undefined && (messages.at(-1)?.seq ?? end) < end,
					nextAfterSeq: messages.at(-1)?.seq ?? null,
				});
			}
			unexpected.push(`${request.method} ${path}`);
			return new Response("Unexpected fixture request", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		timeout: 20_000,
		protocolTimeout: 30_000,
	});
}, 120_000);
afterAll(async () => {
	releaseRecovery?.();
	await browser?.close();
	server?.stop(true);
});
async function report(page: Page) {
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}
async function settle(page: Page) {
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settle());
}
async function visible(page: Page, value: boolean) {
	await page.evaluate(
		(next) => (window as unknown as FixtureWindow).fixture.setVisible(next),
		value,
	);
}
async function ack(page: Page) {
	await page.evaluate(
		(seq) => (window as unknown as FixtureWindow).fixture.acknowledge(seq),
		tailSeq,
	);
}
function bodyReads() {
	return arrivals.filter((item) => item.path.endsWith("/messages"));
}
async function open() {
	if (!server || !browser) throw new Error("Fixture not initialized");
	arrivals.length = 0;
	unexpected.length = 0;
	tailSeq = 100;
	edited = false;
	oversized = false;
	deletedSeqs.clear();
	recoveryGate = undefined;
	releaseRecovery = undefined;
	const page = await browser.newPage();
	page.setDefaultTimeout(15_000);
	await page.setViewport({ width: 1100, height: 900 });
	const errors: string[] = [];
	const aborted: string[] = [];
	page.on("pageerror", (error) => {
		errors.push(String(error));
		console.error("CHAT_BROWSER_ERROR", String(error));
	});
	page.on("console", (entry) => {
		if (entry.type() === "error") {
			errors.push(entry.text());
			console.error("CHAT_BROWSER_CONSOLE", entry.text());
		}
	});
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.protocol !== "data:" && url.origin !== server?.url.origin)
			errors.push(`Request escaped exclusive fixture server: ${url.href}`);
	});
	page.on("requestfailed", (request) => {
		if (request.url().includes("/messages"))
			aborted.push(`${request.url()} ${request.failure()?.errorText}`);
	});
	await page.goto(server.url.origin, { waitUntil: "networkidle0", timeout: 30_000 });
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.start());
	return { page, errors, aborted };
}
async function load(page: Page) {
	try {
		await visible(page, true);
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.reportWS().owners === 1,
		);
		expect(bodyReads()).toHaveLength(0);
		await ack(page);
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.report().ids.length >= 40,
		);
		await page.waitForFunction(() => document.querySelectorAll("[data-nf-row-key]").length > 0);
		await settle(page);
	} catch (error) {
		throw new Error(
			`Production chat did not load: ${String(error)} ${JSON.stringify({ report: await report(page), arrivals, unexpected })}`,
		);
	}
}

async function selectAndReply(page: Page) {
	const value = await report(page);
	const id = value.anchor?.id;
	if (!id) throw new Error("Visible historical row missing");
	const selector = `[data-nf-row-key][data-message-id="${id}"]`;
	await page.keyboard.down("Control");
	await page.click(selector);
	await page.keyboard.up("Control");
	await page.waitForFunction(() => document.body.textContent?.includes("1 selected"));
	await page.click(selector, { button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	for (const item of await page.$$('[role="menuitem"]')) {
		if ((await item.evaluate((element) => element.textContent))?.trim() === "Reply") {
			await item.click();
			await page.waitForFunction(() => document.body.textContent?.includes("Replying to Reader"));
			return;
		}
	}
	throw new Error("Production Reply menu action missing");
}

test("production chat initial hidden has zero resolver/messages/read/join; ACK gates first HTTP and hiding keeps its live window/draft/reply/selection", async () => {
	const { page, errors } = await open();
	try {
		expect(arrivals.filter((item) => item.path.startsWith("/api/chat/"))).toEqual([]);
		expect((await report(page)).ws).toMatchObject({ joins: 0, owners: 0, bodyListeners: 0 });
		await load(page);
		await page.type("textarea", "Draft survives a hidden dock");
		await page.evaluate(() => {
			(window as unknown as FixtureWindow).fixture.rememberViewport();
			(window as unknown as FixtureWindow).fixture.scrollHistory();
		});
		await settle(page);
		await selectAndReply(page);
		const before = await report(page);
		expect(before.body).toContain("1 selected");
		expect(before.body).toContain("Replying to Reader");
		const hiddenCount = arrivals.length;
		await visible(page, false);
		await settle(page);
		const hidden = await report(page);
		expect(hidden.ws).toMatchObject({ owners: 0, bodyListeners: 0, joins: 1, leaves: 1 });
		expect(hidden.ids).toEqual(before.ids);
		expect(hidden.draft).toBe("Draft survives a hidden dock");
		expect(hidden.viewport?.sameNode).toBe(true);
		expect(hidden.body).toContain("1 selected");
		expect(hidden.body).toContain("Replying to Reader");
		const hiddenAdditionalRequests = arrivals.length - hiddenCount;
		expect(hiddenAdditionalRequests).toBe(0);
		await visible(page, true);
		await ack(page);
		await settle(page);
		const resumed = await report(page);
		expect(resumed.draft).toBe("Draft survives a hidden dock");
		expect(resumed.body).toContain("1 selected");
		expect(resumed.body).toContain("Replying to Reader");
		expect(resumed.viewport?.sameNode).toBe(true);
		console.info(
			"CHAT_VISIBILITY_HIDDEN_EVIDENCE",
			JSON.stringify({
				initialHidden: { resolver: 0, messages: 0, read: 0, joins: 0 },
				hiddenAdditionalRequests,
				hiddenOwners: hidden.ws.owners,
				hiddenBodyListeners: hidden.ws.bodyListeners,
				retainedMessages: hidden.ids.length,
				sameViewport: hidden.viewport?.sameNode,
				requests: arrivals.map((item) => ({
					path: item.path,
					method: item.method,
					query: item.query,
					responseBytes: item.bytes,
				})),
			}),
		);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);

test("production chat resumes a fixed historical seq window; in-flight geometry has zero aborted HTTP and byte-budget failure retains the window for retry", async () => {
	const { page, errors, aborted } = await open();
	try {
		await load(page);
		await page.evaluate(() => {
			(window as unknown as FixtureWindow).fixture.rememberViewport();
			(window as unknown as FixtureWindow).fixture.scrollHistory();
		});
		await settle(page);
		const before = await report(page);
		await visible(page, false);
		tailSeq = 600;
		edited = true;
		// No WS frame while hidden: only fixed-range REST can discover this tombstone.
		deletedSeqs.add(70);
		recoveryGate = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		await visible(page, true);
		const priorReads = bodyReads().length;
		const requestReady = page.waitForRequest((request) => request.url().includes("afterSeq="));
		await ack(page);
		await requestReady;
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.setWidth(720));
		// The held HTTP still returns message 80's old body. Deletion and a newer
		// seq arrive through the transport while the canonical window is recovering.
		await page.evaluate((incoming) => {
			(window as unknown as FixtureWindow).fixture.emit({
				type: "chat:message_deleted",
				roomId: "room-fixture",
				messageId: "chat-80",
			});
			(window as unknown as FixtureWindow).fixture.emit({
				type: "chat:message",
				roomId: "room-fixture",
				message: incoming,
			});
		}, message(601));
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.setWidth(780));
		expect(aborted).toEqual([]);
		expect(bodyReads()).toHaveLength(priorReads + 1);
		releaseRecovery?.();
		recoveryGate = undefined;
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).fixture
				.report()
				.texts.some((text) => text.includes("EDITED_WHILE_HIDDEN")),
		);
		await settle(page);
		const resumed = await report(page);
		expect(resumed.ids).toEqual(before.ids);
		expect(resumed.deletedIds).toContain("chat-70");
		expect(resumed.deletedIds).toContain("chat-80");
		expect(resumed.texts.some((text) => text.includes("CHAT_BODY_70"))).toBe(false);
		expect(resumed.ids).not.toContain("chat-601");
		expect(resumed.texts.some((text) => text.includes("CHAT_BODY_80"))).toBe(false);
		expect(resumed.viewport?.sameNode).toBe(true);
		expect(resumed.anchor?.id).toBe(before.anchor?.id);
		expect(bodyReads().at(-1)?.query).toContain("afterSeq=60");
		expect(bodyReads().at(-1)?.query).toContain("beforeSeq=101");
		expect(aborted).toEqual([]);
		await visible(page, false);
		oversized = true;
		await visible(page, true);
		await ack(page);
		await page.waitForFunction(() =>
			[...document.querySelectorAll('[role="status"]')].some((node) =>
				node.textContent?.includes("Response exceeds byte budget"),
			),
		);
		const failed = await report(page);
		expect(bodyReads().at(-1)?.bytes).toBeGreaterThan(32 * 1024 * 1024);
		expect(failed.anchor?.id).toBe(resumed.anchor?.id);
		expect(failed.ids).toEqual(resumed.ids);
		expect(failed.viewport?.sameNode).toBe(true);
		oversized = false;
		const retry = await page.$('[role="status"] button');
		if (!retry) throw new Error("Recovery retry action missing");
		const retried = page.waitForResponse((response) => response.url().includes("afterSeq="));
		await retry.click();
		await retried;
		await page.waitForFunction(
			() => !document.body.textContent?.includes("Response exceeds byte budget"),
		);
		await settle(page);
		const retriedWindow = await report(page);
		expect(retriedWindow.ids).toEqual(before.ids);
		expect(retriedWindow.deletedIds).toContain("chat-70");
		expect(retriedWindow.deletedIds).toContain("chat-80");
		expect(retriedWindow.ids).not.toContain("chat-601");
		expect(bodyReads().filter((read) => !read.query.includes("afterSeq="))).toHaveLength(1);
		console.info(
			"CHAT_VISIBILITY_RECOVERY_EVIDENCE",
			JSON.stringify({
				fixedRange: bodyReads().map((read) => ({ query: read.query, responseBytes: read.bytes })),
				geometryAborts: 0,
				hiddenMissedDeletionRecovered: retriedWindow.deletedIds.includes("chat-70"),
				lateDeletionRetained: retriedWindow.deletedIds.includes("chat-80"),
				newerSeqDidNotReplaceHistory: !retriedWindow.ids.includes("chat-601"),
				retainedAnchor: (await report(page)).anchor,
				retainedMessages: before.ids.length,
			}),
		);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
	} finally {
		releaseRecovery?.();
		await page.close();
	}
}, 90_000);

test("simulated document visibilitychange (not OS backgrounding) stops room refs/body/read and rejects an immediate hidden live frame", async () => {
	const { page, errors } = await open();
	try {
		await load(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.rememberViewport());
		const before = await report(page);
		const requestCount = arrivals.length;
		await page.evaluate(
			(frame) => (window as unknown as FixtureWindow).fixture.setDocumentVisible(false, frame),
			{ type: "chat:message", roomId: "room-fixture", message: message(101) },
		);
		const hidden = await report(page);
		expect(hidden.visible).toBe(true); // Dock remains visible: only the document gate changes.
		expect(hidden.documentVisibility).toBe("hidden");
		expect(hidden.ws).toMatchObject({ owners: 0, bodyListeners: 0 });
		expect(hidden.ids).toEqual(before.ids);
		expect(hidden.ids).not.toContain("chat-101");
		expect(hidden.viewport?.sameNode).toBe(true);
		const hiddenAdditionalRequests = arrivals.length - requestCount;
		expect(hiddenAdditionalRequests).toBe(0);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.setDocumentVisible(true),
		);
		await ack(page);
		await settle(page);
		const resumed = await report(page);
		expect(resumed.ws.owners).toBe(1);
		expect(resumed.ids).toEqual(before.ids);
		expect(bodyReads()).toHaveLength(2);
		expect(bodyReads().at(-1)?.query).toContain("afterSeq=60&beforeSeq=101");
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		console.info(
			"CHAT_DOCUMENT_VISIBILITY_EVIDENCE",
			JSON.stringify({
				simulated: true,
				hiddenAdditionalRequests,
				hiddenOwners: hidden.ws.owners,
				hiddenBodyListeners: hidden.ws.bodyListeners,
				retainedMessages: hidden.ids.length,
				rejectedImmediateHiddenMessage: !hidden.ids.includes("chat-101"),
				resumeQuery: bodyReads().at(-1)?.query,
			}),
		);
	} finally {
		await page.close();
	}
}, 60_000);
