/**
 * Shared set-up of the live editor's browser tests: a test server running the real live
 * sessions (registry, sessions, write path, the isolated SQLite of `tests/preload.ts`) behind a
 * WebSocket, the editor fixture bundle, and headless Chromium (puppeteer-core, the binary CI
 * installs; `NF_TEST_CHROMIUM_PATH` points at it).
 *
 * Named as a browser fixture so `vlist-isolation.guard.test.ts` treats it as test-only and
 * flags any production module that imports it.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { compareOrderKeys } from "@shared/outline";
import puppeteer, {
	type Browser,
	type BrowserContext,
	type CDPSession,
	type Page,
} from "puppeteer-core";
import { db } from "../../../../server/db";
import { aclGrants, projects, users } from "../../../../server/db/schema";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import { taskCharOf } from "../../../../server/services/outline/live/mirror";
import {
	closeAllLiveSessions,
	liveSessionOf,
	outlineLiveQuiet,
	outlineLiveStats,
} from "../../../../server/services/outline/live/registry";
import { OUTLINE_LIVE_TIMING } from "../../../../server/services/outline/live/session";
import { ensureProjectSpace } from "../../../../server/services/outline/spaces";
import { outlineStore } from "../../../../server/services/outline/store";
import type { OutlineSpaceRow } from "../../../../server/services/outline/store/port";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	drainOutlineLive,
	handleOutlineLiveBinary,
	type OutlineLiveWS,
	releaseOutlineLive,
} from "../../../../server/websocket/outline-live-ws";
import type * as Fixture from "./OutlineEditor.browser-fixture";

export type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const NOW = "2026-10-27T00:00:00.000Z";

export interface Harness {
	browser: Browser;
	server: ReturnType<typeof Bun.serve>;
	space: OutlineSpaceRow;
	owner: string;
	writer: string;
	reader: string;
	pages: Page[];
	contexts: BrowserContext[];
}

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

const names = new Map<string, string>();

export async function startHarness(): Promise<Harness> {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	settings.outline.enabled = true;
	const bundle = await Bun.build({
		entrypoints: [new URL("./OutlineEditor.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script) throw new Error("fixture bundle missing");
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
			if (url.pathname === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}#root{padding:16px;font:15px/1.5 system-ui,sans-serif}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			const asset = assets.get(url.pathname);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
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
	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
	const owner = await user("alice");
	const writer = await user("bob");
	const reader = await user("carol");
	names.set(owner, "alice");
	names.set(writer, "bob");
	names.set(reader, "carol");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Live editor",
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
	const space = await ensureProjectSpace(projectId);
	// Commits of typed text come quickly in tests.
	Object.assign(OUTLINE_LIVE_TIMING, { flushIdleMs: 150, flushMaxMs: 600, persistMs: 50 });
	return { browser, server, space, owner, writer, reader, pages: [], contexts: [] };
}

export async function stopHarness(h: Harness | undefined): Promise<void> {
	if (!h) return;
	try {
		await closeAllLiveSessions("ended");
		await h.browser.close();
	} finally {
		h.server.stop(true);
	}
}

/** Close every page of the test and end the sessions. */
export async function resetHarness(h: Harness): Promise<void> {
	for (const page of h.pages.splice(0)) await page.close().catch(() => {});
	for (const context of h.contexts.splice(0)) await context.close().catch(() => {});
	await closeAllLiveSessions("ended");
}

/** A page with blocks under it (nested by leading "  " per level, "[ ] " for a task). */
export async function seedPage(
	h: Harness,
	title: string,
	lines: string[],
): Promise<{ pageId: string; ids: string[] }> {
	// The test preload resets settings after every test.
	settings.outline.enabled = true;
	const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [
		{ op: "insert", tempId: "p", parent: null, content: title },
	];
	const stack: string[] = ["p"];
	lines.forEach((line, i) => {
		const depth = (line.length - line.trimStart().length) / 2;
		let content = line.trim();
		let task: { status: "todo" | "done" } | null = null;
		if (content.startsWith("[ ] ")) {
			task = { status: "todo" };
			content = content.slice(4);
		} else if (content.startsWith("[x] ")) {
			task = { status: "done" };
			content = content.slice(4);
		}
		stack.length = depth + 1;
		ops.push({
			op: "insert",
			tempId: `b${i}`,
			parent: { tempId: stack[depth] as string },
			content,
			task,
		});
		stack.push(`b${i}`);
	});
	const ids: string[] = [];
	const known = new Map<string, string>();
	for (let at = 0; at < ops.length; at += 200) {
		const chunk = ops.slice(at, at + 200).map((op) => {
			// Blocks of earlier chunks are named by id.
			if (op.op !== "insert" || !op.parent || !("tempId" in op.parent)) return op;
			const id = known.get(op.parent.tempId);
			return id ? { ...op, parent: { id } } : op;
		});
		const r = await writeOutline({
			spaceId: h.space.id,
			ops: chunk,
			actor: { kind: "human", id: h.owner },
			responsibleUserId: h.owner,
		});
		r.results.forEach((x, i) => {
			const op = chunk[i];
			if (op?.op === "insert" && op.tempId) known.set(op.tempId, x.blockId);
			ids.push(x.blockId);
		});
	}
	const [pageId, ...rest] = ids;
	return { pageId: pageId as string, ids: rest };
}

export interface Editor {
	page: Page;
	userId: string;
	call<T>(
		fn: (fixture: typeof Fixture, ...args: never[]) => T | Promise<T>,
		...args: unknown[]
	): Promise<T>;
}

/** Open the editor as `userId` on `pageId` in a fresh browser context. */
export async function openEditor(
	h: Harness,
	userId: string,
	pageId: string,
	options: { canWrite?: boolean; focusId?: string; lens?: "facts" | "all"; width?: number } = {},
): Promise<Editor> {
	const context = await h.browser.createBrowserContext();
	h.contexts.push(context);
	await context.overridePermissions(h.server.url.origin, [
		"clipboard-read",
		"clipboard-write",
		"clipboard-sanitized-write",
	]);
	const page = await context.newPage();
	h.pages.push(page);
	if (options.width) await page.setViewport({ width: options.width, height: 800 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(h.server.url.origin);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	const wsUrl = `${h.server.url.origin.replace("http", "ws")}/live?user=${encodeURIComponent(userId)}`;
	await page.evaluate((o) => (window as unknown as FixtureWindow).fixture.open(o), {
		wsUrl,
		pageId,
		spaceKey: h.space.key,
		canWrite: options.canWrite ?? true,
		...(options.focusId ? { focusId: options.focusId } : {}),
		...(options.lens ? { lens: options.lens } : {}),
		...(options.width ? { width: options.width - 32 } : {}),
	});
	try {
		await page.waitForFunction(
			() => {
				const f = (window as unknown as FixtureWindow).fixture;
				try {
					return f.client().ready && f.client().status === "live";
				} catch {
					return false;
				}
			},
			{ timeout: 10_000 },
		);
	} catch (error) {
		const state = await page
			.evaluate(() => {
				const f = (window as unknown as FixtureWindow).fixture;
				try {
					const c = f.client();
					return {
						status: c.status,
						ready: c.ready,
						close: c.closeCode,
						log: c.log,
						net: f.net().connected,
					};
				} catch (e) {
					return String(e);
				}
			})
			.catch(() => "page gone");
		throw new Error(
			`editor did not join: ${JSON.stringify(state)} server ${JSON.stringify(outlineLiveStats())} quiet ${outlineLiveQuiet()} errors ${errors.join("; ")}: ${String(error)}`,
		);
	}
	const editor: Editor = {
		page,
		userId,
		call: (fn, ...args) =>
			page.evaluate(
				`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`,
			) as Promise<never>,
	};
	(editor as unknown as { errors: string[] }).errors = errors;
	return editor;
}

export function errorsOf(editor: Editor): string[] {
	return (editor as unknown as { errors: string[] }).errors;
}

/**
 * Wait for a condition in the page. The function runs in the page: it sees only the fixture and
 * `args` (JSON), not the test's variables.
 */
export async function until(
	editor: Editor,
	fn: (fixture: typeof Fixture, ...args: never[]) => boolean,
	args: unknown[] = [],
	timeoutMs = 5000,
): Promise<void> {
	try {
		await editor.page.waitForFunction(
			`(${fn.toString()})(window.fixture, ...${JSON.stringify(args)})`,
			{ timeout: timeoutMs, polling: 20 },
		);
	} catch (error) {
		throw new Error(`until ${fn.toString()} ${JSON.stringify(args)}: ${String(error)}`);
	}
}

/** Wait for a condition in the test process. */
export async function eventually(
	fn: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 5000,
): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`timed out: ${label}`);
}

/** A block's text in the server's live session (what everyone converges to). */
export function serverText(pageId: string, blockId: string): string | undefined {
	return liveSessionOf(pageId)?.textOf(blockId);
}

function outlineText(
	children: (id: string) => string[],
	text: (id: string) => string,
	task: (id: string) => string | null,
	rootId: string,
): string {
	const lines: string[] = [];
	const walk = (id: string, depth: number) => {
		for (const c of children(id)) {
			const t = task(c);
			lines.push(
				`${"  ".repeat(depth)}- ${t ? `[${t}] ` : ""}${text(c)
					.split("\n")
					.join(`\n${"  ".repeat(depth + 1)}`)}`,
			);
			walk(c, depth + 1);
		}
	};
	walk(rootId, 0);
	return lines.join("\n");
}

/** The page as the server's live session has it, in the editor's outline format. */
export function serverOutline(pageId: string): string {
	const s = liveSessionOf(pageId);
	if (!s) return "<no session>";
	return outlineText(
		(id) => s.mirror.children(id),
		(id) => s.textOf(id),
		(id) => taskCharOf(s.mirror.get(id)?.taskJson ?? null),
		pageId,
	);
}

/** The page as committed, in the same format. */
export async function dbOutline(pageId: string): Promise<string> {
	const { blocks } = await outlineStore.listPageBlocks(pageId, 5000);
	const byParent = new Map<string, typeof blocks>();
	for (const b of blocks) {
		if (b.deleted || !b.parentId) continue;
		const list = byParent.get(b.parentId) ?? [];
		list.push(b);
		byParent.set(b.parentId, list);
	}
	const byId = new Map(blocks.map((b) => [b.id, b]));
	return outlineText(
		(id) =>
			(byParent.get(id) ?? [])
				.sort((a, b) => compareOrderKeys(a.orderKey, b.orderKey) || (a.id < b.id ? -1 : 1))
				.map((b) => b.id),
		(id) => byId.get(id)?.content ?? "",
		(id) => taskCharOf(byId.get(id)?.taskJson ?? null),
		pageId,
	);
}

/** A block's committed content. */
export async function dbText(blockId: string): Promise<string | undefined> {
	return (await outlineStore.getBlock(blockId))?.content;
}

/** Wait until the page's live text is committed (and the session idle). */
export async function flushed(pageId: string, timeoutMs = 5000): Promise<void> {
	await eventually(
		() => outlineLiveQuiet() && !liveSessionOf(pageId)?.hasUnflushed,
		`page ${pageId} flushed`,
		timeoutMs,
	);
}

/**
 * Chinese input through the DevTools protocol, as an input method sends it: compositions, the
 * committed text, and keys pressed while composing (keyCode 229, handled by the input method).
 */
export function ime(editor: Editor) {
	let cdp: Promise<CDPSession> | null = null;
	const session = () => {
		cdp ??= editor.page.createCDPSession();
		return cdp;
	};
	return {
		set: async (text: string) =>
			(await session()).send("Input.imeSetComposition", {
				text,
				selectionStart: text.length,
				selectionEnd: text.length,
			}),
		commit: async (text: string) => {
			await (await session()).send("Input.insertText", { text });
			await frame(editor.page);
		},
		key: async (code: string, key = "Process") => {
			const c = await session();
			await c.send("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				windowsVirtualKeyCode: 229,
				nativeVirtualKeyCode: 229,
				key,
				code,
			});
			await c.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				windowsVirtualKeyCode: 229,
				key,
				code,
			});
		},
	};
}

/**
 * Wait until every editor sent everything and got it acknowledged, the server broadcast
 * everything, and the broadcasts arrived (twice in a row, as an acknowledgement can trigger
 * more). Editors whose network is held are not waited for.
 */
export async function settle(...editors: Editor[]): Promise<void> {
	let calm = 0;
	const end = Date.now() + 10_000;
	while (calm < 2 && Date.now() < end) {
		let busy = false;
		for (const e of editors) {
			const idle = await e.call((f) => {
				const c = f.client();
				return f.net().held || (c.status === "live" && c.pending.length === 0 && c.quiet);
			});
			if (!idle) busy = true;
		}
		if (!outlineLiveQuiet()) busy = true;
		calm = busy ? 0 : calm + 1;
		await new Promise((r) => setTimeout(r, busy ? 10 : 25));
	}
}

export async function frame(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
