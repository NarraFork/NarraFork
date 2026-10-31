import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ComposerDocument } from "@shared/composer-document";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./NarratorComposer.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const errors = new WeakMap<Page, string[]>();
const emptyDraft = {
	hasDraft: false,
	text: "",
	fileReferences: [],
	revision: 1,
	updatedAt: null,
	updatedBy: null,
	sourceId: null,
};
const persistentDrafts = new Map<
	string,
	{
		hasDraft: boolean;
		revision: number;
		updatedAt: string | null;
		text: string;
		fileReferences: unknown[];
		composerDocument?: ComposerDocument;
		sourceId: string | null;
	}
>();
beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./NarratorComposer.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: {
			"process.env.NODE_ENV": '"production"',
			"import.meta.env": '{"DEV":false,"PROD":true}',
		},
		plugins: [
			{
				name: "pause-native-attachment-read-delivery",
				setup(build) {
					build.onLoad({ filter: /use-composer-attachments\.ts$/ }, async ({ path }) => {
						const source = await Bun.file(path).text();
						const marker = "void loadDraftImageAttachments(currentUserId, narratorId)";
						if (!source.includes(marker)) throw new Error("Attachment read test boundary missing");
						// Keep native IndexedDB/Blob reconstruction; only delay delivery to the real hook.
						const gate = `${marker}.then(async loaded => {
						await (globalThis as typeof globalThis & { __draftAttachmentReadGate?: (user: string, narrator: string) => Promise<void> }).__draftAttachmentReadGate?.(currentUserId, narratorId);
						return loaded;
					})`;
						return {
							contents: source.replace(marker, gate),
							loader: "ts",
							resolveDir: dirname(path),
						};
					});
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || !styles.length) throw new Error("Composer/CSS bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const persistent = path.match(/^\/api\/narrators\/(persist-[^/]+)\/(draft|panel-state)$/);
			if (persistent) {
				const user =
					request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "fixture-user";
				const key = `${user}:${persistent[1]}`;
				const row = persistentDrafts.get(key) ?? emptyDraft;
				if (persistent[2] === "panel-state")
					return Response.json({
						permissions: [],
						buffer: [],
						draft: { hasDraft: row.hasDraft, revision: row.revision, updatedAt: row.updatedAt },
						hasMore: { permissions: false, buffer: false },
					});
				if (request.method === "PUT") {
					const body = await request.json();
					const next = {
						...emptyDraft,
						...body,
						ok: true,
						traits: [],
						revision: row.revision + 1,
						hasDraft:
							!!body.text ||
							!!body.fileReferences?.length ||
							!!body.composerDocument?.assets.length,
					};
					persistentDrafts.set(key, next);
					return Response.json(next);
				}
				return Response.json(row);
			}
			if (path === "/api/narrators/fixture-narrator/panel-state")
				return Response.json({
					permissions: [],
					buffer: [],
					draft: { hasDraft: false, revision: 1, updatedAt: null },
					hasMore: { permissions: false, buffer: false },
				});
			if (path === "/api/narrators/fixture-narrator/draft") {
				if (request.method === "PUT") {
					const body = await request.json();
					return Response.json({
						...emptyDraft,
						...body,
						ok: true,
						traits: [],
						revision: emptyDraft.revision + 1,
						hasDraft:
							!!body.text ||
							!!body.fileReferences?.length ||
							!!body.composerDocument?.assets.length,
					});
				}
				return Response.json(emptyDraft);
			}
			if (path.endsWith("/file-references/search"))
				return Response.json({
					entries: [
						{
							deviceId: "local",
							path: "/work/foo.ts",
							name: "foo.ts",
							relativePath: "foo.ts",
							isDirectory: false,
						},
						{
							deviceId: "local",
							path: "/work/food.ts",
							name: "food.ts",
							relativePath: "food.ts",
							isDirectory: false,
						},
					],
					truncated: false,
				});
			if (path.startsWith("/api/")) return Response.json([]);
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}<style>html,body{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
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
async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
async function waitForCaretMove(page: Page, previousHead: number) {
	// Rendering two frames does not guarantee that the browser's selectionchange
	// has reached the editor state. Wait for the observable keyboard result instead.
	await page.waitForFunction(
		(head) => (window as unknown as FixtureWindow).fixture.caretProbe().head !== head,
		{},
		previousHead,
	);
	await settle(page);
}
async function open() {
	if (!browser || !server) throw new Error("Fixture unavailable");
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
	await settle(page);
	return page;
}
async function close(page: Page) {
	await page.close();
	expect(errors.get(page)).toEqual([]);
}
async function snapshot(page: Page) {
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
}
async function geometry(page: Page) {
	return page.evaluate(() => {
		const row = document.getElementById("row")?.getBoundingClientRect();
		const messages = document.getElementById("messages");
		const viewport = messages?.getBoundingClientRect();
		return {
			rowTop: row?.top ?? 0,
			rowHeight: row?.height ?? 0,
			messagesHeight: viewport?.height ?? 0,
			scrollTop: messages?.scrollTop ?? 0,
			selection: window.getSelection()?.toString() ?? "",
		};
	});
}

test("production Row footer stays inside the editor and typing does not rerender its parent boundary", async () => {
	const page = await open();
	try {
		expect(
			await page.evaluate(() => {
				const shell = document.querySelector("[data-inline-composer]");
				const attach = document.querySelector('button[aria-label="Attach file"]');
				const send = [...document.querySelectorAll("button")].find(
					(button) => button.textContent?.trim() === "Send",
				);
				return !!shell && !!attach && !!send && shell.contains(attach) && shell.contains(send);
			}),
		).toBe(true);
		await page.click('[role="textbox"]');
		await page.keyboard.type("hello");
		await settle(page);
		const before = await snapshot(page);
		await page.keyboard.type(" world repeated typing");
		await settle(page);
		const after = await snapshot(page);
		expect(after.text).toBe("hello world repeated typing");
		expect(after.parentRenders).toBe(before.parentRenders);
		expect(after.sends).toBe(0);
	} finally {
		await close(page);
	}
}, 15_000);

test("20 real message selections keep main composer geometry, message scroll and source selection unchanged", async () => {
	const page = await open();
	try {
		await page.evaluate(() => {
			const messages = document.getElementById("messages");
			if (messages) messages.scrollTop = 12;
		});
		const initial = await geometry(page);
		expect(initial.scrollTop).toBeGreaterThan(0);
		for (let i = 0; i < 20; i++) {
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selectSource());
			await page.waitForSelector("[data-quote-candidate]", { visible: true });
			const selected = await geometry(page);
			// Floating outside the composer, beside (never over) the selected text.
			const button = await page.$eval("[data-quote-candidate]", (node) => {
				const rect = node.getBoundingClientRect();
				const source = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
				const composer = document.querySelector("[data-inline-composer]")?.getBoundingClientRect();
				return {
					inComposer: !!node.closest("[data-inline-composer]"),
					position: getComputedStyle(node).position,
					overlapsSelection: !!source && rect.bottom > source.top && rect.top < source.bottom,
					aboveComposer: !!composer && rect.bottom <= composer.top,
				};
			});
			expect(button).toEqual({
				inComposer: false,
				position: "fixed",
				overlapsSelection: false,
				aboveComposer: true,
			});
			expect((await snapshot(page)).document).toBeUndefined();
			expect(Math.abs(selected.rowTop - initial.rowTop)).toBeLessThanOrEqual(1);
			expect(Math.abs(selected.rowHeight - initial.rowHeight)).toBeLessThanOrEqual(1);
			expect(Math.abs(selected.messagesHeight - initial.messagesHeight)).toBeLessThanOrEqual(1);
			expect(selected.scrollTop).toBe(initial.scrollTop);
			expect(selected.selection).toContain("Select this source text");
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.clearSelection());
			await page.waitForSelector("[data-quote-candidate]", { hidden: true });
		}
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selectSource());
		await page.waitForSelector("[data-quote-candidate]", { visible: true });
		await page.click("[data-quote-candidate] button");
		await settle(page);
		expect(
			(await snapshot(page)).document?.paragraphs[0].children.some((node) => node.type === "quote"),
		).toBe(true);
	} finally {
		await close(page);
	}
}, 20_000);

test("real File previews survive failed sends, then successful commit releases their resource bindings", async () => {
	const page = await open();
	try {
		const doc = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.stageMixed(),
		);
		await settle(page);
		expect((await snapshot(page)).missing).toBe(false);
		await page.waitForSelector("[data-inline-composer] img");
		await page.waitForFunction(() =>
			[...document.querySelectorAll<HTMLImageElement>("[data-inline-composer] img")].every(
				(image) => image.complete && image.naturalWidth > 0,
			),
		);
		if (process.env.NF_RICH_COMPOSER_CAPTURE === "1")
			await page.screenshot({ path: ".narrafork/rich-composer-preview.png", fullPage: true });
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hide());
		await settle(page);
		await page.evaluate(
			(value) => (window as unknown as FixtureWindow).fixture.restore(value),
			doc,
		);
		await settle(page);
		expect((await snapshot(page)).missing).toBe(false);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.hide();
			fixture.commit();
		});
		await settle(page);
		await page.evaluate(
			(value) => (window as unknown as FixtureWindow).fixture.restore(value),
			doc,
		);
		await settle(page);
		expect((await snapshot(page)).missing).toBe(true);
	} finally {
		await close(page);
	}
}, 20_000);

function textDocument(text: string): ComposerDocument {
	return { version: 1, paragraphs: [{ children: [{ type: "text", text }] }], assets: [] };
}
async function loadDocument(page: Page, document: ComposerDocument) {
	await page.evaluate((doc) => (window as unknown as FixtureWindow).fixture.load(doc), document);
	await settle(page);
}
for (const key of ["Tab", "Enter"] as const) {
	test(`file completion ${key} is handled before the composer send shortcut`, async () => {
		const page = await open();
		try {
			await loadDocument(page, textDocument("#fo"));
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(4));
			await page.waitForSelector("[data-file-reference-item]");
			await page.keyboard.press(key === "Tab" ? "ArrowDown" : "ArrowUp");
			await settle(page);
			await page.keyboard.press(key);
			await settle(page);
			const state = await snapshot(page);
			expect(
				state.document?.paragraphs[0].children.find((node) => node.type === "fileReference"),
			).toMatchObject({ reference: { label: "food.ts" } });
			expect(state.sends).toBe(0);
			expect(await page.$("[data-file-reference-item]")).toBeNull();
		} finally {
			await close(page);
		}
	});
}
test("file completion Escape closes the menu without clearing the draft", async () => {
	const page = await open();
	try {
		await loadDocument(page, textDocument("#fo"));
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(4));
		await page.waitForSelector("[data-file-reference-item]");
		await page.keyboard.press("Escape");
		await settle(page);
		expect(await page.$("[data-file-reference-item]")).toBeNull();
		expect((await snapshot(page)).text).toBe("#fo");
	} finally {
		await close(page);
	}
});
test("file and mention queries stop at inline atoms instead of deleting them", async () => {
	const page = await open();
	const quote = {
		type: "quote",
		id: "q-boundary",
		label: "source",
		text: "keep this quote",
	} as const;
	try {
		await loadDocument(page, {
			version: 1,
			assets: [],
			paragraphs: [
				{ children: [{ type: "text", text: "#fo" }, quote, { type: "text", text: "o" }] },
			],
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(6));
		await settle(page);
		expect(await page.$("[data-file-reference-item]")).toBeNull();
		expect((await snapshot(page)).document?.paragraphs[0].children).toContainEqual(quote);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.namedCandidates([
				{ id: "named", handle: "foo", title: "Foo" },
			]),
		);
		await loadDocument(page, {
			version: 1,
			assets: [],
			paragraphs: [
				{ children: [{ type: "text", text: "@fo" }, quote, { type: "text", text: "o" }] },
			],
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(6));
		await settle(page);
		expect(await page.$("[data-mention-item]")).toBeNull();
		await loadDocument(page, {
			version: 1,
			assets: [],
			paragraphs: [
				{ children: [{ type: "text", text: "before" }, quote, { type: "text", text: "#fo" }] },
			],
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(11));
		await page.waitForSelector("[data-file-reference-item]");
		await page.click("[data-file-reference-item]");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children).toContainEqual(quote);
		await loadDocument(page, {
			version: 1,
			assets: [],
			paragraphs: [
				{ children: [{ type: "text", text: "before" }, quote, { type: "text", text: "@fo" }] },
			],
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(11));
		await page.waitForSelector("[data-mention-item]");
		await page.click("[data-mention-item]");
		await settle(page);
		const state = await snapshot(page);
		expect(state.document?.paragraphs[0].children).toContainEqual(quote);
		expect(state.text).toContain("@foo ");
	} finally {
		await close(page);
	}
});
test("asynchronous real image ingestion restores its mapped insertion bookmark, not a later selection", async () => {
	const page = await open();
	try {
		await loadDocument(page, textDocument("alpha beta gamma"));
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.nativeSelection(7);
			fixture.ingestImage();
			fixture.nativeSelection(12, 17);
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.awaitFiles());
		await settle(page);
		const state = await snapshot(page);
		expect(state.document?.paragraphs[0].children.map((node) => node.type)).toEqual([
			"text",
			"attachment",
			"text",
		]);
		expect(state.document?.paragraphs[0].children[0]).toEqual({ type: "text", text: "alpha " });
		expect(state.document?.paragraphs[0].children[2]).toEqual({ type: "text", text: "beta gamma" });
		expect(state.files).toEqual(["async.png"]);
	} finally {
		await close(page);
	}
});
test("switching the draft while a real image is prepared cancels insertion atomically", async () => {
	const page = await open();
	try {
		await loadDocument(page, textDocument("old draft"));
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.nativeSelection(4);
			fixture.ingestImage();
			fixture.load({
				version: 1,
				paragraphs: [{ children: [{ type: "text", text: "replacement" }] }],
				assets: [],
			});
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.awaitFiles());
		await settle(page);
		const state = await snapshot(page);
		expect(state.text).toBe("replacement");
		expect(state.document?.assets).toHaveLength(0);
		expect(state.files).toEqual([]);
	} finally {
		await close(page);
	}
});
test("adopting a remote deletion cannot resurrect the old attachments on the next upload", async () => {
	const page = await open();
	try {
		const synced = page.waitForResponse(
			(response) =>
				response.url().endsWith("/draft") && response.request().method() === "PUT" && response.ok(),
		);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.stageMixed());
		await synced;
		await settle(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.remote({
				version: 1,
				paragraphs: [{ children: [{ type: "text", text: "remote draft" }] }],
				assets: [],
			}),
		);
		await page.waitForFunction(() => {
			const state = (window as unknown as FixtureWindow).fixture.snapshot();
			return state.text === "remote draft" && state.files.length === 0;
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.ingestText("G.txt"));
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.awaitFiles());
		await settle(page);
		const state = await snapshot(page);
		expect(state.document?.assets.map((asset) => asset.name)).toEqual(["G.txt"]);
		expect(state.files).toEqual(["G.txt"]);
	} finally {
		await close(page);
	}
}, 15000);
function linesDocument(lines: string[]): ComposerDocument {
	return {
		version: 1,
		assets: [],
		paragraphs: [
			{
				children: lines.flatMap((line, index) => [
					...(index ? [{ type: "break" as const }] : []),
					{ type: "text" as const, text: line },
				]),
			},
		],
	};
}
function paragraphsDocument(lines: string[]): ComposerDocument {
	return {
		version: 1,
		assets: [],
		paragraphs: lines.map((line) => ({ children: [{ type: "text" as const, text: line }] })),
	};
}
test("arrow keys change visual lines before recalling input history", async () => {
	const page = await open();
	try {
		const draft = "line1\nline2\nline3";
		await page.evaluate(
			(history) => (window as unknown as FixtureWindow).fixture.remember(history),
			linesDocument(["older history"]),
		);
		await loadDocument(page, linesDocument(["line1", "line2", "line3"]));
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("line2", 2),
		);
		await settle(page);
		const middle = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		await page.keyboard.press("ArrowUp");
		await waitForCaretMove(page, middle.head);
		const moved = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(moved.text).toBe(draft);
		expect(moved.top).toBeLessThan(middle.top - 4);
		expect(moved.head).not.toBe(middle.head);

		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("line1", 3),
		);
		await settle(page);
		await page.keyboard.press("ArrowUp");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "older history",
		);

		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "line1\nline2\nline3",
		);

		await page.evaluate(
			(history) => (window as unknown as FixtureWindow).fixture.remember(history),
			linesDocument(["hist1", "hist2", "hist3"]),
		);
		await loadDocument(page, textDocument("draft"));
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("draft", 2),
		);
		await settle(page);
		await page.keyboard.press("ArrowUp");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "hist1\nhist2\nhist3",
		);
		await settle(page);
		const recalledEnd = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		await page.keyboard.press("ArrowUp");
		await waitForCaretMove(page, recalledEnd.head);
		const recalledUp = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(recalledUp.text).toBe("hist1\nhist2\nhist3");
		expect(recalledUp.top).toBeLessThan(recalledEnd.top - 4);
		await page.keyboard.press("ArrowDown");
		await waitForCaretMove(page, recalledUp.head);
		const recalledDown = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(recalledDown.text).toBe("hist1\nhist2\nhist3");
		expect(recalledDown.top).toBeGreaterThan(recalledUp.top + 4);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("hist3", 2),
		);
		await settle(page);
		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "draft",
		);

		await loadDocument(page, paragraphsDocument(["para1", "para2"]));
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("para2", 0),
		);
		await settle(page);
		const second = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		await page.keyboard.press("ArrowUp");
		await waitForCaretMove(page, second.head);
		const previousParagraph = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(previousParagraph.text).toBe("para1\npara2");
		expect(previousParagraph.top).toBeLessThan(second.top - 4);
	} finally {
		await close(page);
	}
}, 15000);
test("arrow keys recall history from the first or last wrapped line, not from the line below", async () => {
	const page = await open();
	try {
		const wrapped = `${"alpha beta gamma delta ".repeat(12).trim()} tail`;
		await page.evaluate(
			(history) => (window as unknown as FixtureWindow).fixture.remember(history),
			textDocument("wrapped history"),
		);
		await loadDocument(page, textDocument(wrapped));
		const secondLine = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretOnVisualLine(1),
		);
		expect(secondLine.lineCount).toBeGreaterThan(1);
		await settle(page);
		await page.keyboard.press("ArrowUp");
		await settle(page);
		const firstLine = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(firstLine.text).toBe(wrapped);
		expect(firstLine.top).toBeLessThan(secondLine.top - 4);

		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretOnVisualLine(0),
		);
		await settle(page);
		await page.keyboard.press("ArrowUp");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "wrapped history",
		);
		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(
			(expected) => (window as unknown as FixtureWindow).fixture.snapshot().text === expected,
			{},
			wrapped,
		);
		await settle(page);
		const end = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		await page.keyboard.press("ArrowUp");
		await settle(page);
		const upFromEnd = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(upFromEnd.text).toBe(wrapped);
		expect(upFromEnd.top).toBeLessThan(end.top - 4);
	} finally {
		await close(page);
	}
}, 15000);
test("boundary arrows keep the caret when history does not replace the text", async () => {
	const page = await open();
	try {
		await loadDocument(page, textDocument("only one line"));
		const start = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("only one line", 0),
		);
		await settle(page);
		await page.keyboard.press("ArrowDown");
		await settle(page);
		const afterDown = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(afterDown.text).toBe("only one line");
		expect(afterDown.head).toBe(start.head);

		const middle = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("only one line", 4),
		);
		await settle(page);
		await page.keyboard.press("ArrowUp");
		await settle(page);
		const afterUp = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(afterUp.text).toBe("only one line");
		expect(afterUp.head).toBe(middle.head);

		await loadDocument(page, linesDocument(["line1", "line2", "line3"]));
		const lastLine = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("line3", 0),
		);
		await settle(page);
		await page.keyboard.press("ArrowDown");
		await settle(page);
		const stayed = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.caretProbe(),
		);
		expect(stayed.text).toBe("line1\nline2\nline3");
		expect(stayed.head).toBe(lastLine.head);
	} finally {
		await close(page);
	}
}, 15000);
test("recalling a tall history entry scrolls its final caret into view", async () => {
	const page = await open();
	try {
		const history = linesDocument(Array.from({ length: 16 }, (_, index) => `H${index + 1}`));
		const historyText = history.paragraphs[0].children
			.map((node) => (node.type === "text" ? node.text : "\n"))
			.join("");
		await page.evaluate(
			(doc) => (window as unknown as FixtureWindow).fixture.remember(doc),
			history,
		);
		await loadDocument(page, textDocument("draft"));
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.placeCaretAt("draft", 0),
		);
		await settle(page);
		await page.keyboard.press("ArrowUp");
		await page.waitForFunction(
			(expected) => (window as unknown as FixtureWindow).fixture.snapshot().text === expected,
			{},
			historyText,
		);
		await settle(page);
		await settle(page);
		const visible = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.scrollProbe(),
		);
		expect(visible.text).toBe(historyText);
		expect(visible.scrollHeight).toBeGreaterThan(visible.clientHeight + 8);
		expect(visible.caretBottom).toBeLessThanOrEqual(visible.boxBottom + 2);
		expect(visible.caretTop).toBeGreaterThanOrEqual(visible.boxTop - 2);
		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "draft",
		);
	} finally {
		await close(page);
	}
}, 15000);
test("Down exits input history even when the recalled message has missing attachments", async () => {
	const page = await open();
	try {
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			const doc = fixture.stageMixed();
			fixture.remember(doc);
			fixture.hide();
			fixture.commit();
			fixture.restore({
				version: 1,
				paragraphs: [{ children: [{ type: "text", text: "my unsent draft" }] }],
				assets: [],
			});
		});
		await settle(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(1));
		await settle(page); // Tiptap applies DOM focus on the next animation frame.
		await page.keyboard.press("ArrowUp");
		await page.waitForFunction(
			() =>
				((window as unknown as FixtureWindow).fixture.snapshot().document?.assets.length ?? 0) > 0,
		);
		expect((await snapshot(page)).missing).toBe(true);
		await page.keyboard.press("ArrowDown");
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.snapshot().text === "my unsent draft",
		);
		expect((await snapshot(page)).document?.assets ?? []).toHaveLength(0);
	} finally {
		await close(page);
	}
}, 15000);
test("the production fullscreen scroll layer fills the actual composer dialog", async () => {
	const page = await open();
	try {
		await loadDocument(
			page,
			textDocument(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")),
		);
		await page.click("button:has(svg.tabler-icon-arrows-maximize)");
		await settle(page);
		const fullscreen = await page.evaluate(() => {
			const element = document.querySelector<HTMLElement>("[data-composer-scroll]");
			return { height: element?.clientHeight ?? 0, scroll: element?.scrollHeight ?? 0 };
		});
		expect(fullscreen.height).toBeGreaterThan(350);
		expect(fullscreen.scroll).toBeGreaterThan(fullscreen.height);
		await page.keyboard.press("Escape");
		await settle(page);
		expect(
			await page.evaluate(
				() => document.querySelector<HTMLElement>("[data-composer-scroll]")?.clientHeight ?? 0,
			),
		).toBeLessThanOrEqual(200);
	} finally {
		await close(page);
	}
});

test("fullscreen Escape dismisses completion before closing the editor", async () => {
	const page = await open();
	try {
		await loadDocument(page, textDocument("#fo"));
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(4));
		await page.waitForSelector("[data-file-reference-item]");
		await page.click("button:has(svg.tabler-icon-arrows-maximize)");
		await settle(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(4));
		await settle(page);
		await page.keyboard.press("Escape");
		await settle(page);
		expect(await page.$("[data-file-reference-item]")).toBeNull();
		expect(await page.$('[role="dialog"]')).not.toBeNull();
		await page.keyboard.press("Escape");
		await settle(page);
		expect(await page.$('[role="dialog"]')).toBeNull();
	} finally {
		await close(page);
	}
});

test("fullscreen Enter only newlines; mod+Enter sends", async () => {
	const page = await open();
	try {
		await loadDocument(page, textDocument("hello"));
		await page.click('[role="textbox"]');
		await page.keyboard.press("Enter");
		await settle(page);
		// 非全屏基线:Enter 发送。
		expect((await snapshot(page)).sends).toBe(1);
		await page.click("button:has(svg.tabler-icon-arrows-maximize)");
		await settle(page);
		await page.click('[role="textbox"]');
		// 全屏:Enter 与 Shift+Enter 都只换行。
		await page.keyboard.press("Enter");
		await settle(page);
		expect((await snapshot(page)).sends).toBe(1);
		expect((await snapshot(page)).text).toContain("\n");
		await page.keyboard.down("Shift");
		await page.keyboard.press("Enter");
		await page.keyboard.up("Shift");
		await settle(page);
		expect((await snapshot(page)).sends).toBe(1);
		// mod+Enter 仍然发送。
		await page.keyboard.down("Control");
		await page.keyboard.press("Enter");
		await page.keyboard.up("Control");
		await settle(page);
		expect((await snapshot(page)).sends).toBe(2);
	} finally {
		await close(page);
	}
}, 15_000);

test("fullscreen escapes an isolate ancestor and paints above app chrome", async () => {
	const page = await open();
	try {
		// 复刻生产结构:面板容器 isolation: isolate(AppShell Main/路由页),加上一条
		// z-index 100 的视口级 chrome(导航栏/顶栏)。困在 isolate 里的浮层 z-index 再高
		// 也画不到 chrome 上面 —— 这正是"全屏被导航挡住"的最小复现。
		await page.evaluate(() => {
			const panel = document.getElementById("panel");
			if (!panel) throw new Error("Missing fixture panel");
			panel.style.isolation = "isolate";
			const chrome = document.createElement("div");
			chrome.id = "fake-chrome";
			Object.assign(chrome.style, {
				position: "fixed",
				inset: "0 0 auto 0",
				height: "120px",
				zIndex: "100",
				background: "red",
			});
			document.body.append(chrome);
		});
		await page.click("button:has(svg.tabler-icon-arrows-maximize)");
		await settle(page);
		const open1 = await page.evaluate(() => {
			const panel = document.getElementById("panel");
			if (!panel) throw new Error("Missing fixture panel");
			const hit = document.elementFromPoint(window.innerWidth / 2, 40);
			return {
				hit: hit?.closest('[role="dialog"]') ? "dialog" : (hit?.id ?? hit?.tagName ?? null),
				isolation: getComputedStyle(panel).isolation,
			};
		});
		expect(open1.hit).toBe("dialog");
		expect(open1.isolation).toBe("auto");
		// 退出全屏后祖先样式恢复。
		await page.keyboard.press("Escape");
		await settle(page);
		expect(
			await page.evaluate(() => {
				const panel = document.getElementById("panel");
				if (!panel) throw new Error("Missing fixture panel");
				return getComputedStyle(panel).isolation;
			}),
		).toBe("isolate");
	} finally {
		await close(page);
	}
}, 15_000);

function nodeCount(doc: ComposerDocument | undefined, type: string) {
	return (
		doc?.paragraphs.flatMap((paragraph) => paragraph.children).filter((node) => node.type === type)
			.length ?? 0
	);
}
/** Where the floating quote toolbar sits, relative to the selection and composer. */
function quoteButtonLayout(page: Page) {
	return page.$eval("[data-quote-candidate]", (node) => {
		const rect = node.getBoundingClientRect();
		const composer = document.querySelector("[data-inline-composer]")?.getBoundingClientRect();
		const selection = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
		if (!composer || !selection) throw new Error("Missing composer or selection");
		return {
			placement: node.getAttribute("data-placement"),
			gapBelowSelection: Math.round(rect.top - selection.bottom),
			aboveComposer: rect.bottom <= composer.top,
			height: rect.height,
		};
	});
}
async function selectQuotableSource(page: Page) {
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selectSource());
	await page.waitForSelector("[data-quote-candidate]", { visible: true });
}

test("a live selected message is quoted once with Tab, not Alt+Q or modified Tab", async () => {
	const page = await open();
	try {
		await selectQuotableSource(page);
		expect(await page.$eval("[data-quote-candidate] kbd", (node) => node.textContent)).toBe("Tab");
		const shortcut = await page.$eval("[data-quote-candidate]", (candidate) => {
			const button = candidate.querySelector("button");
			const keycap = button?.querySelector("kbd");
			const action = button?.querySelector("[data-quote-action]");
			if (!button || !keycap || !action) throw new Error("Missing quote shortcut parts");
			const style = getComputedStyle(keycap);
			return {
				first: button.firstElementChild === keycap,
				precedesAction: !!(
					keycap.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING
				),
				label: keycap.getAttribute("aria-label"),
				shortcut: button.getAttribute("aria-keyshortcuts"),
				icon: !!keycap.querySelector("svg"),
				topBorder: Number.parseFloat(style.borderTopWidth),
				bottomBorder: Number.parseFloat(style.borderBottomWidth),
				shrink: style.flexShrink,
				height: keycap.getBoundingClientRect().height,
				chipHeight: candidate.getBoundingClientRect().height,
			};
		});
		expect(shortcut.first).toBe(true);
		expect(shortcut.precedesAction).toBe(true);
		expect(shortcut.label).toBe("Tab key");
		expect(shortcut.shortcut).toBe("Tab");
		expect(shortcut.icon).toBe(true);
		expect(shortcut.topBorder).toBeGreaterThan(0);
		expect(shortcut.bottomBorder).toBe(shortcut.topBorder);
		expect(shortcut.shrink).toBe("0");
		expect(shortcut.height).toBeLessThan(shortcut.chipHeight);
		const consumed = await page.evaluate(() =>
			[
				{ key: "q", code: "KeyQ", altKey: true },
				{ key: "Tab", code: "Tab", shiftKey: true },
				{ key: "Tab", code: "Tab", ctrlKey: true },
				{ key: "Tab", code: "Tab", metaKey: true },
				{ key: "Tab", code: "Tab", altKey: true },
				{ key: "Tab", code: "Tab", isComposing: true },
			].map((init) => {
				const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
				document.body.dispatchEvent(event);
				return event.defaultPrevented;
			}),
		);
		expect(consumed).toEqual([false, false, false, false, false, false]);
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(0);
		await page.keyboard.press("Tab");
		await settle(page);
		const state = await snapshot(page);
		expect(nodeCount(state.document, "quote")).toBe(1);
		expect(state.document?.paragraphs[0].children[0]).toMatchObject({
			type: "quote",
			anchor: "m:message-source",
		});
		expect(await page.$("[data-quote-candidate]")).toBeNull();
		expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("textbox");
		await page.keyboard.press("Tab");
		await settle(page);
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(1);
	} finally {
		await close(page);
	}
});

async function openAsk(page: Page) {
	await selectQuotableSource(page);
	await page.click("[data-quote-ask]");
	await page.waitForSelector('[data-quote-candidate][data-mode="ask"] input', { visible: true });
	expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");
}
const askedQuote = {
	label: "Select this source text to quote without changing the message…",
	text: "Select this source text to quote without changing the message layout.",
	anchor: "m:message-source",
};

test("顺便提问 from a selection forks at the source message with the excerpt quoted", async () => {
	const page = await open();
	try {
		await openAsk(page);
		// Focus left the message list; the toolbar keeps the question's selection and
		// paints it in place, since the native highlight went with the focus.
		await settle(page);
		expect(await page.$('[data-quote-candidate][data-mode="ask"]')).not.toBeNull();
		const askedHighlight = () =>
			page.evaluate(() => {
				const highlight = CSS.highlights.get("nf-ask-selection");
				const [range] = highlight ? [...highlight] : [];
				return range instanceof Range ? range.toString() : null;
			});
		expect(await askedHighlight()).toBe(askedQuote.text);
		await page.keyboard.type("Why does this matter?");
		await page.keyboard.press("Enter");
		await page.waitForSelector("[data-quote-candidate]", { hidden: true });
		expect(await askedHighlight()).toBeNull();
		const state = await snapshot(page);
		expect(state.asked).toEqual([
			{
				sourceMessageId: "message-source",
				quote: expect.objectContaining({ text: askedQuote.text, anchor: askedQuote.anchor }),
				question: "Why does this matter?",
			},
		]);
		// Asking never quotes into the main composer.
		expect(nodeCount(state.document, "quote")).toBe(0);
	} finally {
		await close(page);
	}
});

test("an empty 顺便提问 asks about the excerpt directly; Escape and failures keep the composer", async () => {
	const page = await open();
	try {
		await openAsk(page);
		await page.keyboard.press("Enter");
		await page.waitForSelector("[data-quote-candidate]", { hidden: true });
		expect((await snapshot(page)).asked.map((input) => input.question)).toEqual([
			"Explain this excerpt.",
		]);

		await openAsk(page);
		await page.keyboard.type("never sent");
		// Escape steps back to the still-live selection's actions; ✕ dismisses them.
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-quote-candidate][data-mode="actions"]', { visible: true });
		await page.click("[data-quote-dismiss]");
		await page.waitForSelector("[data-quote-candidate]", { hidden: true });
		expect((await snapshot(page)).asked).toHaveLength(1);
		// A dismissed selection is offered again only once it changed: let the clear settle.
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.clearSelection());
		await Bun.sleep(250);

		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.failAsk("boom"));
		await openAsk(page);
		await page.keyboard.type("fails");
		await page.keyboard.press("Enter");
		await settle(page);
		// The question survives a failed request for a retry.
		expect(
			await page.$eval(
				'[data-quote-candidate][data-mode="ask"] input',
				(input) => (input as HTMLInputElement).value,
			),
		).toBe("fails");
		expect((await snapshot(page)).asked).toHaveLength(2);
	} finally {
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.failAsk(null));
		await close(page);
	}
}, 15_000);

test("normal input Tab is not captured by a stale message quote candidate", async () => {
	const page = await open();
	try {
		await selectQuotableSource(page);
		await loadDocument(page, textDocument("hello"));
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(3));
		await settle(page);
		const prevented = await page.evaluate(() => {
			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				code: "Tab",
				bubbles: true,
				cancelable: true,
			});
			document.querySelector('[role="textbox"]')?.dispatchEvent(event);
			return event.defaultPrevented;
		});
		expect(prevented).toBe(false);
		expect((await snapshot(page)).text).toBe("hello");
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(0);
	} finally {
		await close(page);
	}
});

test("touch and pen selections hide shortcut hints; mouse on the same touch-capable device shows Tab", async () => {
	const page = await open();
	try {
		await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
		// Switching touch/mobile emulation reloads the page; await the new editor instance.
		await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
		await settle(page);
		const source = await page.$eval("#quote-source", (element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x + 20, y: rect.y + 12 };
		});
		await page.touchscreen.tap(source.x, source.y);
		await selectQuotableSource(page);
		expect(await page.$("[data-quote-candidate] kbd")).toBeNull();
		expect(
			await page.$eval("[data-quote-candidate]", (element) => element.getAttribute("aria-label")),
		).not.toContain("Tab");
		// Below the selection, past its handles; the platform menu owns the space above.
		expect(await quoteButtonLayout(page)).toEqual({
			placement: "touch",
			gapBelowSelection: 30,
			aboveComposer: true,
			height: 38,
		});
		await page.mouse.click(source.x, source.y);
		await selectQuotableSource(page);
		await page.waitForSelector("[data-quote-candidate] kbd");
		expect(await page.$eval("[data-quote-candidate] kbd", (element) => element.textContent)).toBe(
			"Tab",
		);
		expect((await quoteButtonLayout(page)).placement).toBe("selection");
		await page.evaluate(() =>
			document
				.getElementById("quote-source")
				?.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", bubbles: true })),
		);
		await settle(page);
		expect(await page.$("[data-quote-candidate] kbd")).toBeNull();
		await page.evaluate(() =>
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Process", isComposing: true, bubbles: true }),
			),
		);
		await settle(page);
		expect(await page.$("[data-quote-candidate] kbd")).toBeNull();
		const button = await page.$eval("[data-quote-candidate] button", (element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x + 20, y: rect.y + rect.height / 2 };
		});
		await page.touchscreen.tap(button.x, button.y);
		await settle(page);
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(1);
	} finally {
		await close(page);
	}
}, 15000);

test("a Monaco selection has no global quote popup and its Tab is never consumed", async () => {
	const page = await open();
	try {
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.publishFileSelection());
		await settle(page);
		expect(await page.$("[data-quote-candidate]")).toBeNull();
		await page.evaluate(() => {
			const source = document.getElementById("file-selection-source");
			source?.addEventListener("keydown", (event) => {
				if ((event as KeyboardEvent).key === "Tab")
					source.setAttribute("data-tab-native", String(!event.defaultPrevented));
			});
		});
		await page.keyboard.press("Tab");
		await settle(page);
		expect(
			await page.$eval("#file-selection-source", (element) =>
				element.getAttribute("data-tab-native"),
			),
		).toBe("true");
		expect(nodeCount((await snapshot(page)).document, "fileReference")).toBe(0);
	} finally {
		await close(page);
	}
});

test("a retained selection in A cannot intercept a collapsed foreign Monaco B Tab", async () => {
	const page = await open();
	try {
		await page.evaluate(() => {
			(window as unknown as FixtureWindow).fixture.publishFileSelection();
			const pane = document.createElement("section");
			pane.setAttribute("data-narrator-panel", "other-narrator");
			const monaco = document.createElement("div");
			monaco.className = "monaco-editor";
			const source = document.createElement("textarea");
			source.id = "foreign-source";
			source.value = "other file";
			source.addEventListener("keydown", (event) => {
				if (event.key === "Tab") source.dataset.tabNative = String(!event.defaultPrevented);
			});
			monaco.append(source);
			pane.append(monaco);
			document.body.append(pane);
			source.focus();
			source.setSelectionRange(0, 0);
		});
		await settle(page);
		await page.keyboard.press("Tab");
		await settle(page);
		expect(
			await page.$eval("#foreign-source", (element) => element.getAttribute("data-tab-native")),
		).toBe("true");
		expect(nodeCount((await snapshot(page)).document, "fileReference")).toBe(0);
		expect((await snapshot(page)).text).toBe("");
	} finally {
		await close(page);
	}
});

test("file selection metadata still supports explicit #selection completion without a quote popup", async () => {
	const page = await open();
	try {
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.publishFileSelection());
		await settle(page);
		expect(await page.$("[data-quote-candidate]")).toBeNull();
		await loadDocument(page, textDocument("#selection"));
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(11));
		await page.waitForSelector("[data-file-reference-item]");
		await page.keyboard.press("Tab");
		await settle(page);
		expect(nodeCount((await snapshot(page)).document, "fileReference")).toBe(1);
		expect((await snapshot(page)).text).toContain("#file:src.ts:1-1");
	} finally {
		await close(page);
	}
});

// Page boot/hydration and two completion openings share this deadline. Under four-core CPU
// contention, opening/hydrating a page can take ~4.7s; keep each UI wait bounded at 5s and allow
// the complete focus/Tab round trip the same 15s budget as the neighboring browser flows.
for (const target of ["search", "monaco"] as const) {
	test(`blurred mention completion cannot steal ${target} Tab and reopens only for its own editor`, async () => {
		const page = await open();
		try {
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.namedCandidates([
					{ id: "named", handle: "foo" },
				]),
			);
			await loadDocument(page, textDocument("@fo"));
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(4));
			await page.waitForSelector("[data-mention-item]");
			await page.evaluate((kind) => {
				const parent = document.createElement("div");
				if (kind === "monaco") parent.className = "monaco-editor";
				const input = document.createElement("input");
				input.id = "other-input";
				input.type = "search";
				input.addEventListener("keydown", (event) => {
					if (event.key === "Tab") input.dataset.tabNative = String(!event.defaultPrevented);
				});
				parent.append(input);
				document.body.append(parent);
				input.focus();
			}, target);
			await settle(page);
			expect(await page.$("[data-mention-item]")).toBeNull();
			await page.keyboard.press("Tab");
			await settle(page);
			expect(
				await page.$eval("#other-input", (element) => element.getAttribute("data-tab-native")),
			).toBe("true");
			expect((await snapshot(page)).text).toBe("@fo");
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeSelection(4));
			await page.waitForSelector("[data-mention-item]");
			await page.keyboard.press("Tab");
			await settle(page);
			expect((await snapshot(page)).text).toBe("@foo ");
		} finally {
			await close(page);
		}
	}, 15_000);
}

test("touch-to-mouse dismiss does not move the close target during pointerdown", async () => {
	const page = await open();
	try {
		await page.setViewport({ width: 1000, height: 800, hasTouch: true });
		await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
		await settle(page);
		const source = await page.$eval("#quote-source", (element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x + 20, y: rect.y + 12 };
		});
		await page.touchscreen.tap(source.x, source.y);
		await selectQuotableSource(page);
		expect(await page.$("[data-quote-candidate] kbd")).toBeNull();
		const closePoint = () =>
			page.$eval("[data-quote-candidate] > button:last-child", (element) => {
				const rect = element.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			});
		const before = await closePoint();
		await page.mouse.move(before.x, before.y);
		await page.mouse.down();
		await settle(page);
		expect(await closePoint()).toEqual(before);
		await page.mouse.up();
		await settle(page);
		expect(await page.$("[data-quote-candidate]")).toBeNull();
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(0);
	} finally {
		await close(page);
	}
}, 15000);

async function layoutSettled(page: Page) {
	await settle(page);
	await page.waitForFunction(() => {
		const root = document.querySelector("[data-inline-composer]");
		return !!root && !root.getAnimations().some((animation) => animation.playState === "running");
	});
}
async function layoutSnapshot(page: Page) {
	return page.evaluate(() => {
		const root = document.querySelector<HTMLElement>("[data-inline-composer]");
		const textbox = root?.querySelector<HTMLElement>('[role="textbox"]');
		if (!root || !textbox) throw new Error("Missing input");
		const frame = root.getBoundingClientRect();
		const controls = root.querySelector("[data-composer-controls]")?.getBoundingClientRect();
		return {
			mode: root.dataset.layout,
			height: frame.height,
			target: Number.parseFloat(root.style.height),
			width: root.clientWidth,
			scrollWidth: root.scrollWidth,
			contentHeight:
				root.querySelector("[data-composer-scroll]")?.getBoundingClientRect().height ?? 0,
			controlGapAbove: controls ? controls.top - frame.top : Number.NaN,
			controlGapBelow: controls ? frame.bottom - controls.bottom : Number.NaN,
			placeholder: getComputedStyle(textbox, "::before").content,
			focused: root.ownerDocument.activeElement === textbox,
		};
	});
}
const shortLayoutDocument: ComposerDocument = {
	version: 1,
	assets: [],
	paragraphs: [{ children: [{ type: "text", text: "Short input" }] }],
};
const longLayoutDocument: ComposerDocument = {
	version: 1,
	assets: [],
	paragraphs: [{ children: [{ type: "text", text: "long input ".repeat(200) }] }],
};

test("empty, short text and regular chips use a compact single line; long content expands", async () => {
	const page = await open();
	try {
		await layoutSettled(page);
		const empty = await layoutSnapshot(page);
		expect(empty.mode).toBe("compact");
		expect(empty.height).toBeLessThanOrEqual(54);
		// Single-line controls keep symmetric vertical gaps (8px above and below).
		expect(Math.abs(empty.controlGapAbove - empty.controlGapBelow)).toBeLessThanOrEqual(1);
		for (const doc of [
			shortLayoutDocument,
			{
				...shortLayoutDocument,
				paragraphs: [
					{
						children: [
							{ type: "quote" as const, id: "regular-chip", label: "Source", text: "quoted" },
						],
					},
				],
			},
		]) {
			await page.evaluate((doc) => (window as unknown as FixtureWindow).fixture.load(doc), doc);
			await layoutSettled(page);
			const short = await layoutSnapshot(page);
			expect(short.mode).toBe("compact");
			expect(short.height).toBe(empty.height);
			expect(short.placeholder).toBe("none");
		}
		await page.evaluate(
			(doc) => (window as unknown as FixtureWindow).fixture.load(doc),
			longLayoutDocument,
		);
		await layoutSettled(page);
		const long = await layoutSnapshot(page);
		expect(long.mode).toBe("expanded");
		expect(long.height).toBeGreaterThan(empty.height + 24);
		expect(long.contentHeight).toBeLessThanOrEqual(200);
		expect(long.scrollWidth).toBeLessThanOrEqual(long.width);
		await page.evaluate(
			(doc) => (window as unknown as FixtureWindow).fixture.load(doc),
			shortLayoutDocument,
		);
		await layoutSettled(page);
		expect((await layoutSnapshot(page)).height).toBe(empty.height);
	} finally {
		await close(page);
	}
}, 15_000);

test("height transitions reverse in flight without remounting the editor or queuing stale targets", async () => {
	const page = await open();
	try {
		await layoutSettled(page);
		const compact = (await layoutSnapshot(page)).height;
		await page.click('[role="textbox"]');
		const result = await page.evaluate(
			async ({ short, long }) => {
				const fixture = (window as unknown as FixtureWindow).fixture;
				const input = document.querySelector('[role="textbox"]');
				const root = document.querySelector<HTMLElement>("[data-inline-composer]");
				if (!root) throw new Error("No input");
				const frames: { time: number; height: number; target: number }[] = [];
				for (let index = 0; index < 48; index++) {
					if (index < 24 && index % 3 === 0) fixture.load(index % 6 === 0 ? long : short);
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					frames.push({
						time: performance.now(),
						height: root.getBoundingClientRect().height,
						target: Number.parseFloat(root.style.height),
					});
				}
				return {
					frames,
					sameElement: input === document.querySelector('[role="textbox"]'),
					focused: document.activeElement === input,
				};
			},
			{ short: shortLayoutDocument, long: longLayoutDocument },
		);
		expect(result.sameElement).toBe(true);
		expect(result.focused).toBe(true);
		const max = Math.max(...result.frames.map((frame) => frame.target));
		const span = Math.max(max - compact, 1);
		expect(max).toBeGreaterThan(compact + 24);
		expect(
			result.frames.some((frame) => frame.height > compact + 1 && frame.height < max - 1),
		).toBe(true);
		for (let index = 1; index < result.frames.length; index++) {
			const current = result.frames[index];
			const previous = result.frames[index - 1];
			expect(current.height).toBeGreaterThanOrEqual(compact - 1);
			expect(current.height).toBeLessThanOrEqual(max + 1);
			// cubic-bezier(0.2, 0, 0, 1) peaks near 4× linear over the 180ms height
			// transition. Headless CI often composites more than one vsync between two
			// close performance.now() samples, so the budget also covers a 30Hz gap.
			// It still rejects a same-frame snap of the whole travel.
			const frameMs = Math.max(current.time - previous.time, 1000 / 60);
			const step = (duration: number) => ((span * duration) / 180) * 4 + 2;
			const allowed = Math.min(
				span * 0.75,
				Math.max(step(frameMs), step(Math.max(frameMs, 1000 / 30))),
			);
			expect(Math.abs(current.height - previous.height)).toBeLessThanOrEqual(allowed);
		}
		await layoutSettled(page);
		expect((await layoutSnapshot(page)).height).toBe(compact);
		expect((await snapshot(page)).text).toBe("Short input");
	} finally {
		await close(page);
	}
}, 15_000);

test("reduced motion and viewport changes settle to a valid layout without retaining inline fullscreen heights", async () => {
	const page = await open();
	try {
		await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
		await page.evaluate(
			(doc) => (window as unknown as FixtureWindow).fixture.load(doc),
			longLayoutDocument,
		);
		await layoutSettled(page);
		expect((await layoutSnapshot(page)).mode).toBe("expanded");
		expect(
			await page.$eval(
				"[data-inline-composer]",
				(node) => getComputedStyle(node).transitionDuration,
			),
		).toBe("0s");
		await page.setViewport({ width: 390, height: 700 });
		await layoutSettled(page);
		const narrow = await layoutSnapshot(page);
		expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.width);
		await page.setViewport({ width: 1000, height: 700 });
		await page.evaluate(
			(doc) => (window as unknown as FixtureWindow).fixture.load(doc),
			shortLayoutDocument,
		);
		await layoutSettled(page);
		expect((await layoutSnapshot(page)).mode).toBe("compact");
	} finally {
		await close(page);
	}
}, 15_000);

test.each([
	[390, 400, false],
	[390, 500, false],
	[390, 500, true],
	[280, 500, true],
])(
	"short/narrow viewport reserves only visible content and keeps controls reachable (%s×%s, takeover=%s)",
	async (width, height, takeover) => {
		const page = await open();
		try {
			await page.setViewport({ width: Number(width), height: Number(height) });
			await page.evaluate(
				({ doc, takeover }) => {
					(window as unknown as FixtureWindow).fixture.takeover(Boolean(takeover));
					(window as unknown as FixtureWindow).fixture.load(doc);
				},
				{ doc: longLayoutDocument, takeover },
			);
			await layoutSettled(page);
			const result = await page.$eval("[data-inline-composer]", (root) => {
				const frame = root.getBoundingClientRect();
				const content = root.querySelector("[data-composer-scroll]")?.getBoundingClientRect();
				const controls = root.querySelector("[data-composer-controls]")?.getBoundingClientRect();
				if (!content || !controls) throw new Error("Missing layout geometry");
				return {
					height: frame.height,
					content: content.height,
					controls: controls.height,
					clipped: [...root.querySelectorAll("button")]
						.filter((button) => {
							const box = button.getBoundingClientRect();
							return (
								box.width > 0 &&
								(box.left < frame.left ||
									box.right > frame.right + 1 ||
									box.bottom > frame.bottom + 1)
							);
						})
						.map((button) => button.textContent || button.getAttribute("aria-label")),
				};
			});
			expect(result.content).toBeLessThanOrEqual(Number(height) * 0.3 + 1);
			expect(Math.abs(result.height - result.content - result.controls - 14)).toBeLessThanOrEqual(
				1,
			);
			expect(result.clipped).toEqual([]);
		} finally {
			await close(page);
		}
	},
	15_000,
);

async function openPersistentAttachments(reuse = false) {
	if (!browser || !server) throw new Error("Browser fixture unavailable");
	persistentDrafts.clear();
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	page.setDefaultTimeout(8000);
	await page.setViewport({ width: 1000, height: 700 });
	const captured: string[] = [];
	errors.set(page, captured);
	page.on("pageerror", (error) => captured.push(String(error)));
	const loaded = page.waitForResponse(
		(response) =>
			response.url().endsWith("/persist-a/draft") && response.request().method() === "GET",
	);
	await page.goto(`${server.url.origin}/?persist${reuse ? "&reuse" : ""}`);
	await loaded;
	await waitAttachmentOwner(page, "persist-a");
	return page;
}
async function closePersistentAttachments(page: Page) {
	const context = page.browserContext();
	await close(page);
	await context.close();
}
async function waitAttachmentOwner(page: Page, narratorId: string, userId = "fixture-user") {
	await page.waitForFunction(
		({ narratorId, userId }) => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			return (
				fixture?.ready() &&
				fixture.owner() === narratorId &&
				fixture.ownerUser() === userId &&
				!fixture.snapshot().hydrating
			);
		},
		{},
		{ narratorId, userId },
	);
	await settle(page);
}
async function waitImageCount(page: Page, count: number) {
	await page.waitForFunction(
		(count) => {
			const images = [
				...document.querySelectorAll<HTMLImageElement>('[data-composer-atom="attachment"] img'),
			];
			return (
				images.length === count &&
				images.every((image) => image.complete && image.naturalWidth === 1)
			);
		},
		{},
		count,
	);
}
async function waitStoredCount(page: Page, count: number) {
	await page.waitForFunction(
		async (count) =>
			(await (window as unknown as FixtureWindow).fixture.storedAttachments()).length === count,
		{},
		count,
	);
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.storedAttachments());
}
async function persistFirstImage(page: Page) {
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/persist-a/draft") &&
			response.request().method() === "PUT" &&
			response.ok(),
	);
	await page.evaluate(async () => {
		const fixture = (window as unknown as FixtureWindow).fixture;
		fixture.ingestImage();
		await fixture.awaitFiles();
	});
	await waitImageCount(page, 1);
	await saved;
	await settle(page);
	return waitStoredCount(page, 1);
}
async function returnWithAttachmentReadHeld(page: Page, expectImage = true) {
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.switchToNarrator("persist-b"),
	);
	await waitAttachmentOwner(page, "persist-b");
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.holdAttachmentReads());
	const metadata = page.waitForResponse((response) =>
		response.url().endsWith("/persist-a/panel-state"),
	);
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.switchToNarrator("persist-a"),
	);
	await metadata;
	await page.waitForFunction(() =>
		(window as unknown as FixtureWindow).fixture
			.heldAttachmentReads()
			.some((read) => read.narratorId === "persist-a"),
	);
	await settle(page);
	expect((await snapshot(page)).hydrating).toBe(true);
	if (expectImage) expect(await page.$("[data-composer-atom][data-loading]")).not.toBeNull();
	expect(await page.$("[data-composer-atom][data-missing]")).toBeNull();
}

test("real IndexedDB draft images survive narrator remounts and a page reload with stable bytes and fresh URLs", async () => {
	const page = await openPersistentAttachments();
	try {
		const stored = await persistFirstImage(page);
		const before = await snapshot(page);
		const oldURL = await page.$eval(
			'[data-composer-atom="attachment"] img',
			(image) => (image as HTMLImageElement).src,
		);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.switchToNarrator("persist-b"),
		);
		await waitAttachmentOwner(page, "persist-b");
		expect((await snapshot(page)).files).toEqual([]);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.switchToNarrator("persist-a"),
		);
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 1);
		expect((await snapshot(page)).document).toEqual(before.document);
		expect((await snapshot(page)).missing).toBe(false);
		expect(
			await page.$eval(
				'[data-composer-atom="attachment"] img',
				(image) => (image as HTMLImageElement).src,
			),
		).not.toBe(oldURL);
		expect(await waitStoredCount(page, 1)).toEqual(stored);
		await page.reload();
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 1);
		expect((await snapshot(page)).document).toEqual(before.document);
		expect(await waitStoredCount(page, 1)).toEqual(stored);
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test("a same-name new image cannot overwrite a still-restoring draft image in real IndexedDB", async () => {
	const page = await openPersistentAttachments();
	try {
		const original = await persistFirstImage(page);
		await returnWithAttachmentReadHeld(page);
		await page.evaluate(async () => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.ingestDifferentImage();
			await fixture.awaitFiles();
		});
		await settle(page);
		expect((await snapshot(page)).document?.assets).toHaveLength(2);
		const newFiles = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.activeAttachmentBytes(),
		);
		expect(newFiles).toHaveLength(1);
		// No incomplete local array may replace the old Blob before its pending read is merged.
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.storedAttachments()),
		).toEqual(original);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.releaseAttachmentReads(),
		);
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 2);
		const merged = await waitStoredCount(page, 2);
		expect(merged[0]).toEqual(original[0]);
		expect(merged[1].id).not.toBe(original[0].id);
		expect(merged[1].name).toBe(original[0].name);
		expect(merged[1].bytes).not.toEqual(original[0].bytes);
		expect(merged[1]).toEqual(newFiles[0]);
		expect((await snapshot(page)).missing).toBe(false);
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test.each([
	"none",
	"before",
	"after",
] as const)("deleting a pending image updates membership, and undo may restore its original Blob (undo=%s)", async (undo) => {
	const page = await openPersistentAttachments();
	try {
		const stored = await persistFirstImage(page);
		await returnWithAttachmentReadHeld(page);
		await page.click(
			`[data-composer-asset-id="${stored[0].id}"] button[aria-label="Remove attachment"]`,
		);
		await settle(page);
		expect((await snapshot(page)).document?.assets).toEqual([]);
		if (undo === "before") {
			await page.keyboard.down("Control");
			await page.keyboard.press("z");
			await page.keyboard.up("Control");
			await settle(page);
			expect((await snapshot(page)).document?.assets.map((asset) => asset.id)).toEqual([
				stored[0].id,
			]);
		}
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.releaseAttachmentReads(),
		);
		await waitAttachmentOwner(page, "persist-a");
		if (undo === "after") {
			// The record was already pruned: only this owner's undo resource pool can recover F.
			expect(await waitStoredCount(page, 0)).toEqual([]);
			await page.click('[role="textbox"]');
			await page.keyboard.down("Control");
			await page.keyboard.press("z");
			await page.keyboard.up("Control");
			await settle(page);
		}
		if (undo !== "none") {
			await waitImageCount(page, 1);
			expect(await waitStoredCount(page, 1)).toEqual(stored);
		} else {
			expect(await waitStoredCount(page, 0)).toEqual([]);
			expect((await snapshot(page)).document?.assets).toEqual([]);
			expect(await page.$('[data-composer-atom="attachment"]')).toBeNull();
		}
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test("a late attachment read cannot cross accounts and the original account keeps its Blob", async () => {
	const page = await openPersistentAttachments();
	try {
		const stored = await persistFirstImage(page);
		await returnWithAttachmentReadHeld(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.switchToUser("other-user"),
		);
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).fixture
				.heldAttachmentReads()
				.some((read) => read.userId === "other-user"),
		);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.releaseAttachmentReads(
				"persist-a",
				"fixture-user",
				true,
			),
		);
		await settle(page);
		expect((await snapshot(page)).files).toEqual([]);
		expect(await page.$('[data-composer-atom="attachment"]')).toBeNull();
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.releaseAttachmentReads(
				"persist-a",
				"other-user",
			),
		);
		await waitAttachmentOwner(page, "persist-a", "other-user");
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.storedAttachments("persist-a", "fixture-user"),
			),
		).toEqual(stored);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.switchToUser("fixture-user"),
		);
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 1);
		expect(await waitStoredCount(page, 1)).toEqual(stored);
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test("a genuinely evicted Blob remains visibly missing after recovery, never silently removed from the draft", async () => {
	const page = await openPersistentAttachments();
	try {
		const stored = await persistFirstImage(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.dropStoredAttachments());
		await page.reload();
		await waitAttachmentOwner(page, "persist-a");
		await page.waitForSelector("[data-composer-atom][data-missing]");
		expect(await page.$("[data-composer-atom][data-loading]")).toBeNull();
		expect((await snapshot(page)).missing).toBe(true);
		expect((await snapshot(page)).document?.assets.map((asset) => asset.id)).toEqual([
			stored[0].id,
		]);
		expect(await page.$eval("#row", (node) => node.textContent)).toContain("Reselect");
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test("explicit clearing during a held read cannot revive the old picture", async () => {
	const page = await openPersistentAttachments();
	try {
		await persistFirstImage(page);
		await returnWithAttachmentReadHeld(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.clear());
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.releaseAttachmentReads(),
		);
		await waitAttachmentOwner(page, "persist-a");
		expect(await waitStoredCount(page, 0)).toEqual([]);
		expect((await snapshot(page)).missing).toBe(false);
		expect(await page.$('[data-composer-atom="attachment"]')).toBeNull();
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test("native attachment persistence survives send hiding and failed-send restoration", async () => {
	const page = await openPersistentAttachments();
	try {
		const stored = await persistFirstImage(page);
		const draft = (await snapshot(page)).document;
		if (!draft) throw new Error("Missing image document");
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hide());
		await settle(page);
		expect(await page.$('[data-composer-atom="attachment"]')).toBeNull();
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.storedAttachments()),
		).toEqual(stored);
		await page.evaluate((doc) => (window as unknown as FixtureWindow).fixture.restore(doc), draft);
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 1);
		expect((await snapshot(page)).document).toEqual(draft);
		expect((await snapshot(page)).missing).toBe(false);
		expect(await waitStoredCount(page, 1)).toEqual(stored);
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test.each([
	"retry",
	"switch",
] as const)("legacy typing after a failed read preserves unknown stored images across %s", async (recovery) => {
	const page = await openPersistentAttachments();
	try {
		const stored = await persistFirstImage(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.seedLegacyTextDraft("legacy"),
		);
		await returnWithAttachmentReadHeld(page, false);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.rejectAttachmentReads());
		await waitAttachmentOwner(page, "persist-a");
		await page.waitForSelector("[data-attachment-restore-error] button");
		const saved = page.waitForResponse(
			(response) =>
				response.url().endsWith("/persist-a/draft") && response.request().method() === "PUT",
		);
		await page.click('[role="textbox"]');
		await page.keyboard.down("Control");
		await page.keyboard.press("End");
		await page.keyboard.up("Control");
		await page.keyboard.type(" typed");
		await settle(page);
		expect((await snapshot(page)).text).toBe("legacy typed");
		expect(
			(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.cachedDraft()))
				.composerDocument,
		).toBeUndefined();
		const response = await saved;
		expect(JSON.parse(response.request().postData() ?? "{}").composerDocument).toBeUndefined();
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.storedAttachments()),
		).toEqual(stored);
		if (recovery === "retry") {
			await page.click("[data-attachment-restore-error] button");
		} else {
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.switchToNarrator("persist-b"),
			);
			await waitAttachmentOwner(page, "persist-b");
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.switchToNarrator("persist-a"),
			);
		}
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 1);
		expect((await snapshot(page)).text).toBe("legacy typed");
		expect((await snapshot(page)).missing).toBe(false);
		expect(await waitStoredCount(page, 1)).toEqual(stored);
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

test("reusing the mounted composer never exposes the previous account's live or restored files", async () => {
	const page = await openPersistentAttachments(true);
	try {
		const stored = await persistFirstImage(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.switchToUser("other-user"),
		);
		await waitAttachmentOwner(page, "persist-a", "other-user");
		expect((await snapshot(page)).files).toEqual([]);
		expect(await page.$('[data-composer-atom="attachment"]')).toBeNull();
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.switchToUser("fixture-user"),
		);
		await waitAttachmentOwner(page, "persist-a");
		await waitImageCount(page, 1);
		expect((await snapshot(page)).missing).toBe(false);
		expect(await waitStoredCount(page, 1)).toEqual(stored);
	} finally {
		await closePersistentAttachments(page);
	}
}, 20_000);

for (const width of [1440, 390]) {
	for (const scheme of ["light", "dark"] as const) {
		test(`${width}px ${scheme}: floating quote button keeps the composer still and aligns its content`, async () => {
			const page = await open();
			try {
				await page.setViewport({ width, height: 844 });
				await page.evaluate((theme) => {
					document.documentElement.setAttribute("data-mantine-color-scheme", theme);
				}, scheme);
				const settleLayout = async () => {
					await settle(page);
					// Measure settled geometry, not an intermediate frame of the adaptive layout.
					await page.waitForFunction(() =>
						[
							...document.querySelectorAll(
								'[data-inline-composer], [data-inline-composer] [role="textbox"]',
							),
						].every((element) =>
							element.getAnimations().every((animation) => animation.playState !== "running"),
						),
					);
				};
				await settleLayout();
				const shell = () =>
					page.$eval("[data-inline-composer]", (element) => {
						const rect = element.getBoundingClientRect();
						return { top: rect.top, height: rect.height };
					});
				const idle = await shell();
				await selectQuotableSource(page);
				await settleLayout();
				expect(await shell()).toEqual(idle);
				const measure = (selector: string) =>
					page.$eval(selector, (chip) => {
						const body = chip.querySelector("button");
						const label = body?.querySelector(":scope > span:last-child");
						const icon = body?.querySelector(":scope > svg");
						if (!body || !label || !icon) throw new Error("Missing chip content");
						const box = chip.getBoundingClientRect();
						const centerOffset = (element: Element) => {
							const rect = element.getBoundingClientRect();
							return rect.y + rect.height / 2 - box.y - box.height / 2;
						};
						const kbd = chip.querySelector("kbd");
						const keyText = kbd?.querySelector("span");
						return {
							height: box.height,
							left: box.left,
							right: box.right,
							labelOffset: centerOffset(label),
							iconOffset: centerOffset(icon),
							icon: icon.getAttribute("class"),
							label: label.textContent,
							keyOffset: kbd && keyText ? centerOffset(keyText) - centerOffset(kbd) : 0,
							keyHeight: keyText?.getBoundingClientRect().height,
						};
					});
				if (process.env.NF_COMPOSER_SCREENSHOTS)
					await page.screenshot({
						path: `.narrafork/quote-${width}-${scheme}-before.png`,
						fullPage: true,
					});
				const button = await measure("[data-quote-candidate]");
				expect(button.height).toBe(30);
				expect(button.label).toBe("Quote");
				expect(button.left).toBeGreaterThanOrEqual(0);
				expect(button.right).toBeLessThanOrEqual(width);
				expect(Math.abs(button.keyOffset)).toBeLessThanOrEqual(1);
				expect(button.keyHeight).toBeLessThanOrEqual(16);
				expect(Math.abs(button.labelOffset)).toBeLessThanOrEqual(1);
				expect(Math.abs(button.iconOffset)).toBeLessThanOrEqual(1);
				await page.keyboard.press("Tab");
				await settle(page);
				if (process.env.NF_COMPOSER_SCREENSHOTS)
					await page.screenshot({
						path: `.narrafork/quote-${width}-${scheme}-after.png`,
						fullPage: true,
					});
				expect(await page.$("[data-quote-candidate]")).toBeNull();
				const chip = await measure('[data-composer-atom="quote"]');
				expect(chip.icon).toBe(button.icon);
			} finally {
				await close(page);
			}
		});
	}
}

for (const input of ["mouse", "touch"] as const)
	test(`${input}: text attachment previews stay above fullscreen and Escape closes only the preview`, async () => {
		const page = await open();
		try {
			if (input === "touch") {
				await page.setViewport({ width: 390, height: 844, hasTouch: true });
				await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
			}
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.stageMixed());
			await settle(page);
			const before = await snapshot(page);
			await page.click("button:has(svg.tabler-icon-arrows-maximize)");
			await settle(page);
			const body = '[data-composer-atom="attachment"] button[aria-label="console.log"]';
			if (input === "mouse") {
				await page.click(body);
				expect(await page.$('pre[role="region"]')).toBeNull();
				await page.click(body, { clickCount: 2 });
			} else {
				const point = await page.$eval(body, (element) => {
					const rect = element.getBoundingClientRect();
					return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
				});
				await page.touchscreen.tap(point.x, point.y);
			}
			await page.waitForSelector('pre[role="region"]', { visible: true });
			expect(
				await page.$eval('pre[role="region"]', (preview) => {
					const rect = preview.getBoundingClientRect();
					return (
						document
							.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
							?.closest('pre[role="region"]') === preview
					);
				}),
			).toBe(true);
			expect(await page.$eval('pre[role="region"]', (preview) => preview.textContent)).toBe(
				"console output",
			);
			expect((await snapshot(page)).document).toEqual(before.document);
			if (process.env.NF_COMPOSER_SCREENSHOTS)
				await page.screenshot({
					path: `.narrafork/text-attachment-preview-fullscreen-${input}.png`,
					fullPage: true,
				});
			await page.keyboard.press("Escape");
			await page.waitForSelector('pre[role="region"]', { hidden: true });
			expect(await page.$('[aria-label="Compose message"]')).not.toBeNull();
			await page.keyboard.press("Escape");
			await settle(page);
			expect(await page.$('[aria-label="Compose message"]')).toBeNull();
		} finally {
			await close(page);
		}
	});
test("a quote chip click opens its full text; the jump is an explicit button", async () => {
	const page = await open();
	const text = "Intro **bold** line\n\n```ts\nconst answer = 42;\n```";
	try {
		await loadDocument(page, {
			version: 1,
			assets: [],
			paragraphs: [
				{
					children: [
						{ type: "text", text: "Ask " },
						{
							type: "quote",
							id: "q-detail",
							label: "Intro bold line",
							text,
							anchor: "m:message-source",
						},
					],
				},
			],
		});
		await page.click('[data-composer-atom="quote"] > button');
		await page.waitForSelector("[data-quote-detail-body]", { visible: true });
		const body = await page.$eval("[data-quote-detail-body]", (node) => ({
			text: node.textContent ?? "",
			bold: node.querySelector("strong")?.textContent,
			code: !!node.querySelector("pre, code"),
		}));
		expect(body.text).toContain("const answer = 42;");
		expect(body.bold).toBe("bold");
		expect(body.code).toBe(true);
		// Opening the detail neither jumped away nor touched the draft.
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(1);
		expect(
			await page.$eval(
				"[data-quote-detail-jump]",
				(button) => (button as HTMLButtonElement).disabled,
			),
		).toBe(false);
		await page.click("[data-quote-detail-jump]");
		await page.waitForSelector("[data-quote-detail-body]", { hidden: true });
		expect(nodeCount((await snapshot(page)).document, "quote")).toBe(1);
	} finally {
		await close(page);
	}
});
