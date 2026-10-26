import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ComposerDocument } from "@shared/composer-document";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./InlineComposerEditor.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const pageErrors = new WeakMap<Page, string[]>();
const empty: ComposerDocument = { version: 1, paragraphs: [{ children: [] }], assets: [] };
const quoted: ComposerDocument = {
	version: 1,
	paragraphs: [
		{
			children: [
				{ type: "text", text: "A😀" },
				{ type: "quote", id: "q1", label: "Source", text: "Quoted source" },
				{ type: "text", text: "Z" },
			],
		},
	],
	assets: [],
};
const imageAsset = {
	id: "image-1",
	kind: "image",
	name: "pixel.png",
	size: 68,
	mimeType: "image/png",
} as const;
const attached: ComposerDocument = {
	version: 1,
	paragraphs: [
		{
			children: [
				{ type: "text", text: "Before " },
				{ type: "attachment", id: "image-node", assetId: imageAsset.id },
				{ type: "text", text: " after" },
			],
		},
	],
	assets: [imageAsset],
};
beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./InlineComposerEditor.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || !styles.length) throw new Error("Editor/CSS bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/test-image") {
				return new Response(
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
						"base64",
					),
					{ headers: { "content-type": "image/png" } },
				);
			}
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
async function open(query = "") {
	if (!browser || !server) throw new Error("Fixture unavailable");
	const page = await browser.newPage();
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(server.url.origin + query);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	return page;
}
async function close(page: Page) {
	await page.close();
	expect(pageErrors.get(page)).toEqual([]);
}
async function load(page: Page, document: ComposerDocument) {
	await page.evaluate(
		(value) => (window as unknown as FixtureWindow).fixture.load(value),
		document,
	);
	await settle(page);
}
async function snapshot(page: Page) {
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
}
async function chord(page: Page, key: "z" | "Z" | "Enter", ...modifiers: ("Control" | "Shift")[]) {
	for (const modifier of modifiers) await page.keyboard.down(modifier);
	await page.keyboard.press(key);
	for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

test("empty insert deletes a selected suffix once but remains a noop for a collapsed cursor", async () => {
	const page = await open();
	try {
		const original: ComposerDocument = {
			...empty,
			paragraphs: [{ children: [{ type: "text", text: "/compactxxx" }] }],
		};
		await load(page, original);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.selection(8, 11);
			fixture.insert([]);
		});
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "/compact" },
		]);
		const after = await snapshot(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.insert([]));
		expect((await snapshot(page)).changes).toBe(after.changes);
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(original);
	} finally {
		await close(page);
	}
}, 15_000);

test("file/mention replacement preserves zero-width boundary atoms and collapsed selection keeps native affinity", async () => {
	const page = await open();
	try {
		for (const prefix of ["#foo", "@foo"]) {
			const doc: ComposerDocument = {
				...attached,
				paragraphs: [
					{
						children: [
							{ type: "quote", id: "before", label: "Before", text: "Keep this quote" },
							{ type: "text", text: prefix },
							{ type: "attachment", id: "image-node", assetId: imageAsset.id },
							{ type: "text", text: " rest" },
						],
					},
				],
			};
			await load(page, doc);
			await page.evaluate((query) => {
				const fixture = (window as unknown as FixtureWindow).fixture;
				fixture.selection(0, 4);
				fixture.insert(
					query === "#foo"
						? [
								{
									type: "fileReference",
									id: "file-node",
									reference: {
										id: "file-ref",
										deviceId: "local",
										path: "/src/file.ts",
										label: "file.ts",
									},
								},
							]
						: [{ type: "text", text: "@Alice" }],
				);
			}, prefix);
			await settle(page);
			expect(
				(await snapshot(page)).document?.paragraphs[0].children.map((node) => node.type),
			).toEqual(["quote", prefix === "#foo" ? "fileReference" : "text", "attachment", "text"]);
			expect((await snapshot(page)).document?.assets).toEqual([imageAsset]);
		}
		await load(page, {
			...attached,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "#foo" },
						{ type: "attachment", id: "image-node", assetId: imageAsset.id },
						{ type: "text", text: " rest" },
					],
				},
			],
		});
		await page.evaluate(() => {
			const editable = document.querySelector<HTMLElement>('[role="textbox"]');
			const text = editable?.querySelector("p")?.firstChild;
			if (!editable || !text) throw new Error("Missing boundary text");
			editable.focus();
			const range = document.createRange();
			range.setStart(text, 4);
			range.collapse(true);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
		});
		await settle(page);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.selection(4);
			fixture.insert([{ type: "text", text: "M" }]);
		});
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children[0]).toEqual({
			type: "text",
			text: "#fooM",
		});
		expect((await snapshot(page)).document?.paragraphs[0].children[1].type).toBe("attachment");
	} finally {
		await close(page);
	}
}, 15_000);

test("mount/editability changes never emit document updates; pre-instance restore→append is installed", async () => {
	const page = await open("?early-restore");
	try {
		await settle(page);
		const before = await snapshot(page);
		expect(before.restoredBeforeInstance).toBe(true);
		expect(before.changes).toBe(0);
		expect(before.document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "restored appended" },
		]);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.disable(true));
		await settle(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.disable(false));
		await settle(page);
		expect((await snapshot(page)).changes).toBe(0);
		expect((await snapshot(page)).document).toEqual(before.document);
	} finally {
		await close(page);
	}
}, 15_000);

test("editor drop delegates mixed files once, stops panel bubbling and resets disabled drops through empty callback", async () => {
	const page = await open();
	try {
		const drop = () =>
			page.evaluate(() => {
				const element = document.querySelector<HTMLElement>('[role="textbox"]');
				if (!element) throw new Error("Missing editor");
				const rect = element.getBoundingClientRect();
				const transfer = new DataTransfer();
				transfer.items.add(new File(["text"], "note.txt", { type: "text/plain" }));
				transfer.items.add(new File(["png"], "image.png", { type: "image/png" }));
				element.dispatchEvent(
					new DragEvent("drop", {
						dataTransfer: transfer,
						bubbles: true,
						cancelable: true,
						clientX: rect.left + 10,
						clientY: rect.top + 10,
					}),
				);
			});
		await drop();
		expect((await snapshot(page)).pasted).toEqual(["note.txt", "image.png"]);
		expect((await snapshot(page)).pasteCalls).toBe(1);
		expect((await snapshot(page)).panelDrops).toBe(0);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.disable(true));
		await settle(page);
		await drop();
		expect((await snapshot(page)).pasted).toEqual([]);
		expect((await snapshot(page)).pasteCalls).toBe(2);
		expect((await snapshot(page)).panelDrops).toBe(0);
	} finally {
		await close(page);
	}
}, 15_000);

test("UTF-16 caret mapping, atoms need two Backspaces, undo/redo survives controlled value echo", async () => {
	const page = await open();
	try {
		await load(page, quoted);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(3));
		await settle(page);
		await page.keyboard.press("Backspace");
		await settle(page);
		const selected = await snapshot(page);
		expect(selected.document).toEqual(quoted);
		expect(selected.selected).toBe(true);
		expect(selected.atoms[0].height).toBe(24);
		await page.keyboard.press("Backspace");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "A😀Z" },
		]);
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(quoted);
		await chord(page, "z", "Control", "Shift");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "A😀Z" },
		]);
		expect(selected.elementMatches).toBe(true);
	} finally {
		await close(page);
	}
}, 15_000);

test("insertion uses native bookmark on blur, adjacent atoms and text share a single undo stack", async () => {
	const page = await open();
	try {
		await load(page, { ...empty, paragraphs: [{ children: [{ type: "text", text: "ab" }] }] });
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(1));
		await page.click("#outside");
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.insert([
				{ type: "quote", id: "q1", label: "One", text: "first" },
				{ type: "quote", id: "q2", label: "Two", text: "second" },
			]),
		);
		await settle(page);
		expect(
			(await snapshot(page)).document?.paragraphs[0].children.map((node) => node.type),
		).toEqual(["text", "quote", "quote", "text"]);
		await page.keyboard.type("X");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children.at(-1)).toEqual({
			type: "text",
			text: "Xb",
		});
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children.at(-1)).toEqual({
			type: "text",
			text: "b",
		});
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "ab" },
		]);
	} finally {
		await close(page);
	}
}, 15_000);

test("plain-text paste keeps whitespace/HTML literal and Shift+Enter; composing Enter never sends", async () => {
	const page = await open();
	try {
		await page.click('[role="textbox"]');
		await page.evaluate(() => {
			const transfer = new DataTransfer();
			transfer.setData("text/plain", "<b>code</b>\n  next");
			transfer.setData("text/html", '<h1>Wrong HTML</h1><img src="https://invalid.test/x">');
			document
				.querySelector('[role="textbox"]')
				?.dispatchEvent(
					new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
				);
		});
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "<b>code</b>" },
			{ type: "break" },
			{ type: "text", text: "  next" },
		]);
		await chord(page, "Enter", "Shift");
		await page.keyboard.type("tail");
		const session = await page.createCDPSession();
		await session.send("Input.imeSetComposition", {
			text: "中文",
			selectionStart: 2,
			selectionEnd: 2,
		});
		await page.keyboard.press("Enter");
		expect((await snapshot(page)).sends).toBe(0);
		await session.send("Input.insertText", { text: "中文" });
		await settle(page);
		expect(JSON.stringify((await snapshot(page)).document)).toContain("中文");
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.pasteFiles());
		expect((await snapshot(page)).pasted).toEqual(["note.txt"]);
	} finally {
		await close(page);
	}
}, 15_000);

for (const width of [1440, 390])
	test(`${width}px: images reserve 64px before decoding, internal scrolling`, async () => {
		const page = await open();
		try {
			await page.setViewport({ width, height: 844 });
			await load(page, attached);
			const before = await snapshot(page);
			expect(before.atoms[0].height).toBe(64);
			expect(before.atoms[0].width).toBe(96);
			if (before.shellHeight === undefined || before.viewportHeight === undefined)
				throw new Error("Missing editor geometry");
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.resources([["image-1", "/api/test-image"]]),
			);
			await page.waitForFunction(() => {
				const image = document.querySelector("img");
				return image?.complete && image.naturalWidth > 0;
			});
			const decoded = await snapshot(page);
			expect(decoded.shellHeight).toBe(before.shellHeight);
			expect(decoded.viewportHeight).toBe(before.viewportHeight);
			expect(decoded.atoms[0].height).toBe(64);
			await page.click("[data-composer-atom] button");
			expect((await snapshot(page)).opened).toBe(0);
			await load(page, {
				...empty,
				paragraphs: Array.from({ length: 40 }, (_, index) => ({
					children: [{ type: "text" as const, text: `Line ${index}` }],
				})),
			});
			const scroll = await snapshot(page);
			expect(scroll.contentHeight ?? 999).toBeLessThanOrEqual(200);
			expect(scroll.scrollHeight ?? 0).toBeGreaterThan(scroll.contentHeight ?? 0);
		} finally {
			await close(page);
		}
	}, 15_000);

test("CSS fullscreen retains DOM identity, cursor and undo; quote button portal targets its owner Document", async () => {
	const page = await open();
	try {
		await page.click('[role="textbox"]');
		await page.keyboard.type("first");
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			(window as unknown as { original: Element | null }).original =
				document.querySelector('[role="textbox"]');
			fixture.expand(true);
		});
		await page.keyboard.type(" second");
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.expand(false));
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { original: Element | null }).original ===
					document.querySelector('[role="textbox"]'),
			),
		).toBe(true);
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(empty);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.frameCandidate());
		await page.waitForFunction(
			() =>
				!!document
					.querySelector<HTMLIFrameElement>("#candidate-frame")
					?.contentDocument?.querySelector("body > [data-quote-candidate]"),
		);
		expect(await page.$("[data-quote-candidate]")).toBeNull();
		const iframe = await page.$("#candidate-frame");
		const frame = await iframe?.contentFrame();
		if (!frame) throw new Error("Missing candidate frame");
		await frame.waitForSelector("[data-quote-candidate]", { visible: true });
		await frame.click("[data-quote-candidate] button");
		expect(await frame.evaluate(() => window.getSelection()?.toString())).toBe("Selected source");
		expect((await snapshot(page)).accepted).toBe(1);
	} finally {
		await close(page);
	}
}, 15_000);

test("file tokens retain real UTF-16 width; Delete selects then removes, external loads reset undo", async () => {
	const page = await open();
	try {
		const doc: ComposerDocument = {
			...empty,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "😀" },
						{ type: "quote", id: "q", label: "Source", text: "not body" },
						{
							type: "fileReference",
							id: "file-node",
							reference: { id: "file-ref", deviceId: "local", path: "/src/a.ts", label: "a.ts" },
						},
						{ type: "text", text: "Z" },
					],
				},
			],
		};
		await load(page, doc);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(2));
		await settle(page);
		expect((await snapshot(page)).selection).toEqual({ start: 2, end: 2 });
		await page.keyboard.press("Delete");
		await settle(page);
		expect((await snapshot(page)).selection).toEqual({ start: 2, end: 12 });
		expect((await snapshot(page)).document).toEqual(doc);
		await page.keyboard.press("Delete");
		await settle(page);
		expect(
			(await snapshot(page)).document?.paragraphs[0].children.some(
				(node) => node.type === "fileReference",
			),
		).toBe(false);
		await load(page, quoted);
		await page.click('[role="textbox"]');
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(quoted);
	} finally {
		await close(page);
	}
}, 15_000);

test("real File previews decode object URLs, revoke on removal/clear and regenerate on undo", async () => {
	const page = await open();
	try {
		await load(page, attached);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fileImageResource());
		await page.waitForFunction(() => {
			const image = document.querySelector("img");
			return image?.complete && image.naturalWidth > 0 && image.src.startsWith("blob:");
		});
		expect((await snapshot(page)).objectURLs).toEqual({ created: 1, revoked: 0 });
		await page.click('[data-composer-atom] button[aria-label="Remove attachment"]');
		await settle(page);
		expect((await snapshot(page)).objectURLs).toEqual({ created: 1, revoked: 1 });
		await chord(page, "z", "Control");
		await page.waitForFunction(() => {
			const image = document.querySelector("img");
			return image?.complete && image.naturalWidth > 0;
		});
		expect((await snapshot(page)).document).toEqual(attached);
		expect((await snapshot(page)).objectURLs).toEqual({ created: 2, revoked: 1 });
		await load(page, empty);
		expect((await snapshot(page)).objectURLs).toEqual({ created: 2, revoked: 2 });
	} finally {
		await close(page);
	}
}, 15_000);

test("attachment removal and undo keep resource metadata; disabled editor rejects mutations", async () => {
	const page = await open();
	try {
		await load(page, attached);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.resources([["image-1", "/api/test-image"]]),
		);
		await page.waitForSelector("img");
		await page.click('[data-composer-atom] button[aria-label="Remove attachment"]');
		await settle(page);
		expect((await snapshot(page)).document?.assets).toEqual([]);
		expect((await snapshot(page)).removed).toEqual(["image-1"]);
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(attached);
		await page.waitForSelector("img");
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.disable(true));
		await settle(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.insert([{ type: "text", text: "forbidden" }]),
		);
		expect((await snapshot(page)).document).toEqual(attached);
		expect(
			await page.$eval('[role="textbox"]', (element) => element.getAttribute("contenteditable")),
		).toBe("false");
	} finally {
		await close(page);
	}
}, 15_000);

test("imperative silent restore survives internal rerenders without a controlled value echo", async () => {
	const page = await open();
	try {
		const before = await snapshot(page);
		await page.evaluate(
			(value) => (window as unknown as FixtureWindow).fixture.restoreSilently(value),
			quoted,
		);
		await settle(page);
		expect((await snapshot(page)).document).toEqual(quoted);
		expect((await snapshot(page)).changes).toBe(before.changes);
	} finally {
		await close(page);
	}
}, 15_000);

test("optimization replaces text in one undo step while preserving node order", async () => {
	const page = await open();
	try {
		await load(page, quoted);
		const optimized: ComposerDocument = {
			...quoted,
			paragraphs: [
				{
					children: quoted.paragraphs[0].children.map((node) =>
						node.type === "text" ? { ...node, text: `optimized ${node.text}` } : node,
					),
				},
			],
		};
		const before = await snapshot(page);
		await page.evaluate(
			(value) => (window as unknown as FixtureWindow).fixture.replaceUndoable(value),
			optimized,
		);
		await settle(page);
		expect((await snapshot(page)).document).toEqual(optimized);
		expect((await snapshot(page)).changes).toBe(before.changes + 1);
		await chord(page, "z", "Control");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(quoted);
		await chord(page, "z", "Control", "Shift");
		await settle(page);
		expect((await snapshot(page)).document).toEqual(optimized);
	} finally {
		await close(page);
	}
}, 15_000);

test("arrow navigation permits typing between adjacent atoms and before first atom", async () => {
	const page = await open();
	try {
		const doc: ComposerDocument = {
			...empty,
			paragraphs: [
				{
					children: [
						{ type: "quote", id: "first", label: "First", text: "one" },
						{ type: "quote", id: "second", label: "Second", text: "two" },
					],
				},
			],
		};
		await load(page, doc);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(0));
		await settle(page);
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.type("between");
		await settle(page);
		expect(
			(await snapshot(page)).document?.paragraphs[0].children.map((node) => node.type),
		).toEqual(["quote", "text", "quote"]);
		await page.keyboard.press("Home");
		await page.keyboard.type("before");
		await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children[0]).toEqual({
			type: "text",
			text: "before",
		});
	} finally {
		await close(page);
	}
}, 15_000);

for (const kind of ["text", "nodes"] as const)
	test(`boundary benchmark: ${kind} keeps transactions and projections below 500ms`, async () => {
		const page = await open();
		try {
			const metrics = await page.evaluate(
				(mode) => (window as unknown as FixtureWindow).fixture.benchmarkBoundary(mode),
				kind,
			);
			console.info("[InlineComposerEditor boundary benchmark]", JSON.stringify(metrics));
			expect(metrics.characters).toBe(200_000);
			expect(metrics.nodes).toBe(kind === "nodes" ? 4096 : 2);
			expect(metrics.samples).toBe(20);
			expect(metrics.transactionMaxMs).toBeLessThan(500);
			expect(metrics.projectionMaxMs).toBeLessThan(500);
		} finally {
			await close(page);
		}
	}, 60_000);

test("atom selections never optimize surrounding text; text selections and empty caret retain their rules", async () => {
	const page = await open();
	try {
		for (const doc of [quoted, attached]) {
			await load(page, doc);
			await page.click("[data-composer-atom] button");
			const state = await snapshot(page);
			expect(state.selection?.start).toBe(state.selection?.end);
			expect(state.nativeSelection).toEqual({ empty: false, type: "node" });
			expect(state.textContext).toBeNull();
			expect(
				await page.evaluate(() => (window as unknown as FixtureWindow).fixture.optimize()),
			).toBeNull();
			expect((await snapshot(page)).document).toEqual(doc);
			await page.evaluate(() => {
				const paragraph = document.querySelector('[role="textbox"] p');
				if (!paragraph) throw new Error("Missing paragraph");
				const range = document.createRange();
				range.setStart(paragraph, 1);
				range.setEnd(paragraph, 2);
				window.getSelection()?.removeAllRanges();
				window.getSelection()?.addRange(range);
			});
			await settle(page);
			const domSelection = await page.evaluate(() => {
				const fixture = (window as unknown as FixtureWindow).fixture;
				return { state: fixture.snapshot(), optimized: fixture.optimize() };
			});
			expect(domSelection.state.nativeSelection.empty).toBe(false);
			expect(["text", "node"]).toContain(domSelection.state.nativeSelection.type ?? "");
			expect(domSelection.optimized).toBeNull();
			// Dispatch and observe synchronously: later DOM selection events may legally normalize
			// an atom-only range back to NodeSelection, hiding the distinct TextSelection branch.
			const textSelection = await page.evaluate(() => {
				const fixture = (window as unknown as FixtureWindow).fixture;
				fixture.selectAtomAsText();
				return { state: fixture.snapshot(), optimized: fixture.optimize() };
			});
			expect(textSelection.state.nativeSelection).toEqual({ empty: false, type: "text" });
			expect(textSelection.state.selection?.start).toBe(textSelection.state.selection?.end);
			expect(textSelection.state.textContext).toBeNull();
			expect(textSelection.optimized).toBeNull();
			expect(textSelection.state.document).toEqual(doc);
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(1));
			const whole = await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.optimize(),
			);
			expect(whole).toContain("<<<NF_");
			expect(whole).not.toContain("Quoted source");
		}
		await load(page, {
			...empty,
			paragraphs: [{ children: [{ type: "text", text: "hello world" }] }],
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(0, 5));
		expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.optimize())).toBe(
			"hello",
		);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.applyOptimization("hi"));
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "hi world" },
		]);
		await chord(page, "z", "Control");
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(4));
		expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.optimize())).toBe(
			"hello world",
		);
	} finally {
		await close(page);
	}
}, 15_000);

test("text context respects every atom, UTF-16, hard breaks and paragraph boundaries", async () => {
	const page = await open();
	try {
		await load(page, {
			...attached,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "#前😀" },
						{ type: "quote", id: "q", label: "Quote", text: "hidden" },
						{ type: "text", text: "后@人" },
						{ type: "attachment", id: "a", assetId: imageAsset.id },
						{ type: "text", text: "tail" },
						{ type: "break" },
						{ type: "text", text: "line😀" },
					],
				},
				{ children: [{ type: "text", text: "段😀" }] },
			],
		});
		for (const [caret, context] of [
			[2, { text: "#前😀", start: 0, end: 4, caret: 2 }],
			[5, { text: "后@人", start: 4, end: 7, caret: 5 }],
			[8, { text: "tail", start: 7, end: 11, caret: 8 }],
			[15, { text: "line😀", start: 12, end: 18, caret: 15 }],
			[20, { text: "段😀", start: 19, end: 22, caret: 20 }],
		] as const) {
			await page.evaluate(
				(offset) => (window as unknown as FixtureWindow).fixture.selection(offset),
				caret,
			);
			expect((await snapshot(page)).textContext).toEqual(context);
		}
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(1, 8));
		expect((await snapshot(page)).textContext).toBeNull();
	} finally {
		await close(page);
	}
}, 15_000);

test("a parent committing older onChange values late keeps the newer document and undo history", async () => {
	const page = await open();
	try {
		await load(page, quoted);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.holdEchoes();
			fixture.selection(0);
			fixture.insert([{ type: "text", text: "NEW" }]);
			fixture.selection(6);
			fixture.insert([{ type: "text", text: "FILE" }]);
		});
		// Tiptap focuses on the next frame; keys sent earlier land on <body>.
		await settle(page);
		await chord(page, "z", "Control");
		expect((await snapshot(page)).document?.paragraphs[0].children[0]).toEqual({
			type: "text",
			text: "NEWA😀",
		});
		// Every held emission lands as its own render, the inserts' only after the undo.
		while (await page.evaluate(() => (window as unknown as FixtureWindow).fixture.releaseEcho()))
			await settle(page);
		expect((await snapshot(page)).document?.paragraphs[0].children[0]).toEqual({
			type: "text",
			text: "NEWA😀",
		});
		await chord(page, "z", "Control");
		expect((await snapshot(page)).document).toEqual(quoted);
	} finally {
		await close(page);
	}
}, 15_000);

test("selection bookmarks map through transactions, preserve native atom affinity and restore once without undo effects", async () => {
	const page = await open();
	try {
		await load(page, quoted);
		// Capture immediately before the zero-body-width atom, which offsets cannot distinguish.
		await page.evaluate(() => {
			const textbox = document.querySelector<HTMLElement>('[role="textbox"]');
			const text = textbox?.querySelector("p")?.firstChild;
			if (!textbox || !text) throw new Error("Missing text");
			textbox.focus();
			const range = document.createRange();
			range.setStart(text, 3);
			range.collapse(true);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
		});
		await settle(page);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.captureBookmark("upload");
			fixture.selection(0);
			fixture.insert([{ type: "text", text: "NEW" }]);
			fixture.selection(6, 7);
		});
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("upload"),
			),
		).toBe(true);
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("upload"),
			),
		).toBe(false);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.insert([{ type: "text", text: "FILE" }]),
		);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "NEWA😀FILE" },
			quoted.paragraphs[0].children[1],
			{ type: "text", text: "Z" },
		]);
		await chord(page, "z", "Control");
		expect((await snapshot(page)).document?.paragraphs[0].children[0]).toEqual({
			type: "text",
			text: "NEWA😀",
		});
		await chord(page, "z", "Control");
		expect((await snapshot(page)).document).toEqual(quoted);
	} finally {
		await close(page);
	}
}, 15_000);

test("bookmark cancellation, bounded eviction and external draft reset invalidate pending insertions", async () => {
	const page = await open();
	try {
		await load(page, quoted);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.captureBookmark("cancel");
			fixture.cancelBookmark("cancel");
		});
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("cancel"),
			),
		).toBe(false);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			for (let i = 0; i < 65; i++) fixture.captureBookmark(String(i));
		});
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.restoreBookmark("0")),
		).toBe(false);
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.restoreBookmark("1")),
		).toBe(true);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.captureBookmark("reset");
			fixture.restoreSilently({ version: 1, paragraphs: [{ children: [] }], assets: [] });
		});
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("reset"),
			),
		).toBe(false);
		await load(page, quoted);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.captureBookmark("prop"));
		await load(page, attached);
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("prop"),
			),
		).toBe(false);
	} finally {
		await close(page);
	}
}, 15_000);

test("file token width remains absolute while completion context never crosses its atom", async () => {
	const page = await open();
	try {
		await load(page, {
			...empty,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "#start" },
						{
							type: "fileReference",
							id: "f",
							reference: { id: "f", deviceId: "local", path: "/a.ts", label: "a.ts" },
						},
						{ type: "text", text: "tail😀" },
					],
				},
			],
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(17));
		expect((await snapshot(page)).textContext).toEqual({
			text: "tail😀",
			start: 16,
			end: 22,
			caret: 17,
		});
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.selection(2));
		expect((await snapshot(page)).textContext).toEqual({
			text: "#start",
			start: 0,
			end: 6,
			caret: 2,
		});
	} finally {
		await close(page);
	}
}, 15_000);

test("real drop coordinates are captured before async file work and survive a later different selection", async () => {
	const page = await open();
	try {
		await load(page, { ...empty, paragraphs: [{ children: [{ type: "text", text: "abcdef" }] }] });
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.selection(6);
			fixture.prepareAsyncDrop();
			const textbox = document.querySelector<HTMLElement>('[role="textbox"]');
			const text = textbox?.querySelector("p")?.firstChild;
			if (!textbox || !text) throw new Error("Missing drop text");
			const range = document.createRange();
			range.setStart(text, 3);
			range.collapse(true);
			const box = range.getBoundingClientRect();
			const transfer = new DataTransfer();
			transfer.items.add(new File(["data"], "upload.txt", { type: "text/plain" }));
			textbox.dispatchEvent(
				new DragEvent("drop", {
					dataTransfer: transfer,
					clientX: box.x,
					clientY: box.y + box.height / 2,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		expect((await snapshot(page)).selection).toEqual({ start: 3, end: 3 });
		expect((await snapshot(page)).pasteCalls).toBe(1);
		expect((await snapshot(page)).panelDrops).toBe(0);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.selection(0);
			fixture.insert([{ type: "text", text: "NEW" }]);
			fixture.selection(7, 9);
		});
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("drop"),
			),
		).toBe(true);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.insert(
				[{ type: "attachment", id: "uploaded", assetId: "uploaded" }],
				[{ id: "uploaded", kind: "textFile", name: "upload.txt", size: 4, mimeType: "text/plain" }],
			),
		);
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "NEWabc" },
			{ type: "attachment", id: "uploaded", assetId: "uploaded" },
			{ type: "text", text: "def" },
		]);
		// Tiptap schedules focus in requestAnimationFrame; model updates do not imply DOM focus.
		// Wait for the keyboard target, otherwise Ctrl+Z can reach body instead of the editor.
		await page.waitForFunction(
			() => document.activeElement === document.querySelector('[role="textbox"]'),
			{ timeout: 5_000 },
		);
		await chord(page, "z", "Control");
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([
			{ type: "text", text: "NEWabcdef" },
		]);
	} finally {
		await close(page);
	}
}, 15_000);

test("bookmarks restore native node selections and cannot restore after unmount", async () => {
	const page = await open();
	try {
		await load(page, attached);
		await page.click("[data-composer-atom] button");
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.captureBookmark("atom");
			fixture.selection(0);
		});
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("atom"),
			),
		).toBe(true);
		expect((await snapshot(page)).nativeSelection).toEqual({ empty: false, type: "node" });
		expect((await snapshot(page)).document).toEqual(attached);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.captureBookmark("unmount");
			fixture.unmount();
		});
		await settle(page);
		expect(
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.restoreBookmark("unmount"),
			),
		).toBe(false);
	} finally {
		await close(page);
	}
}, 15_000);

test("production fullscreen CSS fills the remaining height and scrolls only its editing viewport", async () => {
	const page = await open();
	try {
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.expand(true));
		await settle(page);
		const expanded = await snapshot(page);
		expect(expanded.contentHeight ?? 0).toBeGreaterThan(400);
		expect(expanded.contentHeight ?? 0).toBeGreaterThan((expanded.shellHeight ?? 0) - 100);
		await load(page, {
			...empty,
			paragraphs: Array.from({ length: 100 }, () => ({
				children: [{ type: "text", text: "long line" }],
			})),
		});
		const long = await snapshot(page);
		expect(long.contentHeight).toBe(expanded.contentHeight);
		expect(long.scrollHeight ?? 0).toBeGreaterThan(long.contentHeight ?? 0);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.expand(false));
		expect((await snapshot(page)).contentHeight ?? 999).toBeLessThanOrEqual(200);
	} finally {
		await close(page);
	}
}, 15_000);

test("schema limits reject oversized paste/duplicate atoms without dirtying document", async () => {
	const page = await open();
	try {
		await load(page, quoted);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.insert([
				{ type: "quote", id: "q1", label: "Duplicate", text: "text" },
			]),
		);
		await settle(page);
		expect((await snapshot(page)).document).toEqual(quoted);
		await page.evaluate(() => {
			const transfer = new DataTransfer();
			transfer.setData("text/plain", "x".repeat(200_001));
			document
				.querySelector('[role="textbox"]')
				?.dispatchEvent(
					new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
				);
		});
		expect((await snapshot(page)).document).toEqual(quoted);
	} finally {
		await close(page);
	}
}, 15_000);

for (const width of [320, 1000]) {
	for (const fontSize of [14, 18]) {
		test(`${width}px ${fontSize}px font: ordinary chips do not increase a genuine single-line editor`, async () => {
			const page = await open();
			try {
				await page.setViewport({ width, height: 800 });
				await page.evaluate((size) => {
					document
						.querySelector<HTMLElement>("[data-inline-composer]")
						?.style.setProperty("--composer-min-height", "0px");
					const editor = document.querySelector<HTMLElement>('[role="textbox"]');
					if (editor) editor.style.fontSize = `${size}px`;
				}, fontSize);
				const geometry = () =>
					page.evaluate(() => {
						const editor = document.querySelector<HTMLElement>('[role="textbox"]');
						const shell = document.querySelector<HTMLElement>("[data-inline-composer]");
						if (!editor || !shell) throw new Error("Missing editor");
						return {
							editor: editor.getBoundingClientRect().height,
							shell: shell.getBoundingClientRect().height,
						};
					});
				await load(page, {
					...empty,
					paragraphs: [{ children: [{ type: "text", text: "Hi there" }] }],
				});
				const baseline = await geometry();
				const textAsset = {
					id: "single-file",
					kind: "textFile",
					name: "a.txt",
					size: 5,
					mimeType: "text/plain",
				} as const;
				const chips: ComposerDocument[] = [
					{
						...empty,
						paragraphs: [
							{
								children: [
									{ type: "text", text: "Hi " },
									{ type: "quote", id: "single-quote", label: "Quote", text: "Source" },
								],
							},
						],
					},
					{
						...empty,
						paragraphs: [
							{
								children: [
									{ type: "text", text: "Hi " },
									{
										type: "fileReference",
										id: "single-ref",
										reference: {
											id: "single-ref",
											deviceId: "local",
											path: "/a.ts",
											label: "a.ts",
										},
									},
								],
							},
						],
					},
					{
						...empty,
						assets: [textAsset],
						paragraphs: [
							{
								children: [
									{ type: "text", text: "Hi " },
									{ type: "attachment", id: "single-attachment", assetId: textAsset.id },
								],
							},
						],
					},
				];
				for (const doc of chips) {
					await load(page, doc);
					const added = await geometry();
					expect(Math.abs(added.editor - baseline.editor)).toBeLessThan(0.1);
					expect(Math.abs(added.shell - baseline.shell)).toBeLessThan(0.1);
					await page.click("[data-composer-atom] button");
					await settle(page);
					expect(Math.abs((await geometry()).editor - baseline.editor)).toBeLessThan(0.1);
					await page.keyboard.press("Backspace");
					await settle(page);
					expect((await snapshot(page)).atoms).toHaveLength(0);
					expect(Math.abs((await geometry()).shell - baseline.shell)).toBeLessThan(0.1);
				}
				await load(page, empty);
				expect(Math.abs((await geometry()).editor - baseline.editor)).toBeLessThan(0.1);
			} finally {
				await close(page);
			}
		}, 15000);
	}
}

test("single-line height remains content-driven for images and wrapped text", async () => {
	const page = await open();
	try {
		await page.setViewport({ width: 320, height: 800 });
		await page.evaluate(() =>
			document
				.querySelector<HTMLElement>("[data-inline-composer]")
				?.style.setProperty("--composer-min-height", "0px"),
		);
		await load(page, { ...empty, paragraphs: [{ children: [{ type: "text", text: "Hi" }] }] });
		const height = () =>
			page.evaluate(
				() => document.querySelector('[role="textbox"]')?.getBoundingClientRect().height ?? 0,
			);
		const baseline = await height();
		await load(page, attached);
		expect(await height()).toBeGreaterThan(baseline);
		expect((await snapshot(page)).atoms[0].height).toBe(64);
		await load(page, {
			...empty,
			paragraphs: [{ children: [{ type: "text", text: "words ".repeat(30) }] }],
		});
		expect(await height()).toBeGreaterThan(baseline);
		await load(page, {
			...empty,
			paragraphs: [
				{
					children: Array.from({ length: 4 }, (_, index) => ({
						type: "quote" as const,
						id: `wrap-${index}`,
						label: "Quoted source",
						text: "Source text",
					})),
				},
			],
		});
		expect(await height()).toBeGreaterThan(baseline);
		expect((await snapshot(page)).atoms.every((atom) => atom.height === 24)).toBe(true);
	} finally {
		await close(page);
	}
});

test("chips keep tappable gaps on narrow rows instead of filling the whole width", async () => {
	const page = await open();
	try {
		await page.setViewport({ width: 280, height: 800 });
		await load(page, {
			...empty,
			paragraphs: [
				{
					children: [
						{
							type: "quote",
							id: "wide",
							label: "A very long quote label that would fill a narrow row completely",
							text: "source",
						},
					],
				},
			],
		});
		const wide = await page.evaluate(() => {
			const editor = document.querySelector<HTMLElement>('[role="textbox"]');
			const atom = document.querySelector<HTMLElement>("[data-composer-atom]");
			if (!editor || !atom) throw new Error("Missing chip");
			const style = getComputedStyle(editor);
			const contentRight =
				editor.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
			const rect = atom.getBoundingClientRect();
			return {
				trailingGap: contentRight - rect.right,
				margin: Number.parseFloat(getComputedStyle(atom).marginRight),
			};
		});
		// 32px max-width reserve minus the 4px margin: the row end always stays tappable.
		expect(wide.trailingGap).toBeGreaterThanOrEqual(27);
		expect(wide.margin).toBe(4);
		// Adjacent chips keep an 8px gutter (4px margin on each side).
		await load(page, {
			...empty,
			paragraphs: [
				{
					children: [
						{ type: "quote", id: "a", label: "A", text: "a" },
						{ type: "quote", id: "b", label: "B", text: "b" },
					],
				},
			],
		});
		const gutter = await page.evaluate(() => {
			const atoms = [...document.querySelectorAll<HTMLElement>("[data-composer-atom]")];
			if (atoms.length < 2) throw new Error("Missing chips");
			const first = atoms[0].getBoundingClientRect();
			const second = atoms[1].getBoundingClientRect();
			if (Math.abs(first.top - second.top) > 1) throw new Error("Chips must share a row");
			return second.left - first.right;
		});
		expect(Math.abs(gutter - 8)).toBeLessThan(0.1);
	} finally {
		await close(page);
	}
});

test("placeholder follows the real document, including restored trailing newlines and atoms", async () => {
	const page = await open();
	try {
		for (const document of [
			{ ...empty, paragraphs: [{ children: [{ type: "text" as const, text: "restored\n" }] }] },
			{ ...empty, paragraphs: [{ children: [{ type: "text" as const, text: "one\ntwo\n" }] }] },
			quoted,
			attached,
		]) {
			await load(page, document);
			expect(
				await page.$eval('[role="textbox"]', (node) => getComputedStyle(node, "::before").content),
			).toBe("none");
		}
		await load(page, empty);
		expect(
			await page.$eval('[role="textbox"]', (node) => getComputedStyle(node, "::before").content),
		).toBe('"Message"');
	} finally {
		await close(page);
	}
});

const previewDocument: ComposerDocument = {
	...empty,
	paragraphs: [
		{
			children: [
				{ type: "quote", id: "preview-quote", label: "Quoted text", text: "Original text" },
				{
					type: "fileReference",
					id: "preview-file",
					reference: {
						id: "file-ref",
						deviceId: "local",
						path: "/project/readme.txt",
						label: "readme.txt",
					},
				},
				{ type: "attachment", id: "image-node", assetId: imageAsset.id },
				{ type: "attachment", id: "text-node", assetId: "text-1" },
			],
		},
	],
	assets: [
		imageAsset,
		{ id: "text-1", kind: "textFile", name: "notes.txt", size: 20, mimeType: "text/plain" },
	],
};
const quoteBody = '[data-composer-atom="quote"] > button';
const previewBodies = [
	quoteBody,
	'[data-composer-atom="fileReference"] > button',
	'[data-composer-asset-id="image-1"] > button',
	'[data-composer-asset-id="text-1"] > button',
];
async function loadPreviews(page: Page) {
	await load(page, previewDocument);
	await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.resources([
			["image-1", "/api/test-image"],
			["text-1", "text fixture"],
		]),
	);
	await settle(page);
}

test("chip bodies select on mouse click (quotes also open), preview once on double click or keyboard; close never opens", async () => {
	const page = await open();
	try {
		await loadPreviews(page);
		let opened = 0;
		for (const selector of previewBodies) {
			expect(
				await page.$eval(selector, (body) => body.parentElement?.querySelectorAll("button").length),
			).toBe(2);
			await page.click(selector);
			// A quote chip opens its detail on a single click; other atoms only select.
			if (selector === quoteBody) opened++;
			expect((await snapshot(page)).opened).toBe(opened);
			expect((await snapshot(page)).nativeSelection.type).toBe("node");
			await page.click(selector, { clickCount: 2 });
			expect((await snapshot(page)).opened).toBe(++opened);
			await page.focus(selector);
			await page.keyboard.press("Enter");
			expect((await snapshot(page)).opened).toBe(++opened);
			await page.keyboard.press("Space");
			expect((await snapshot(page)).opened).toBe(++opened);
			expect((await snapshot(page)).sends).toBe(0);
		}
		expect((await snapshot(page)).document).toEqual(previewDocument);
		for (const selector of previewBodies) {
			await page.click(selector.replace(" > button", " button:last-child"));
			expect((await snapshot(page)).opened).toBe(opened);
		}
		expect((await snapshot(page)).document?.paragraphs[0].children).toEqual([]);
	} finally {
		await close(page);
	}
}, 15_000);

test("touch taps preview once on a hybrid device while mouse keeps single-click selection", async () => {
	const page = await open();
	try {
		await page.setViewport({ width: 1024, height: 844, hasTouch: true });
		await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
		await loadPreviews(page);
		let opened = 0;
		for (const selector of previewBodies) {
			const point = await page.$eval(selector, (body) => {
				const rect = body.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			});
			await page.touchscreen.tap(point.x, point.y);
			expect((await snapshot(page)).opened).toBe(++opened);
			await page.click(selector);
			if (selector === quoteBody) opened++;
			expect((await snapshot(page)).opened).toBe(opened);
			await page.click(selector, { clickCount: 2 });
			expect((await snapshot(page)).opened).toBe(++opened);
		}
		const remove = await page.$eval('[data-composer-atom="quote"] button:last-child', (button) => {
			const rect = button.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		});
		await page.touchscreen.tap(remove.x, remove.y);
		expect((await snapshot(page)).opened).toBe(opened);
		expect(
			(await snapshot(page)).document?.paragraphs[0].children.some((node) => node.type === "quote"),
		).toBe(false);
	} finally {
		await close(page);
	}
}, 15_000);

test("cancelled/moved direct pointers do not preview; pen taps do and missing assets remain unavailable", async () => {
	const page = await open();
	try {
		await loadPreviews(page);
		for (const cancelled of [false, true]) {
			await page.$eval(
				previewBodies[0],
				(body, cancel) => {
					const init = { bubbles: true, pointerType: "touch", clientX: 10, clientY: 10 };
					body.dispatchEvent(new PointerEvent("pointerdown", init));
					body.dispatchEvent(
						new PointerEvent(cancel ? "pointercancel" : "pointermove", { ...init, clientY: 40 }),
					);
					body.dispatchEvent(new PointerEvent("click", init));
				},
				cancelled,
			);
			expect((await snapshot(page)).opened).toBe(0);
		}
		await page.$eval(previewBodies[0], (body) => {
			const init = { bubbles: true, pointerType: "pen" };
			body.dispatchEvent(new PointerEvent("pointerdown", init));
			body.dispatchEvent(new PointerEvent("pointerup", init));
			body.dispatchEvent(new PointerEvent("click", init));
		});
		expect((await snapshot(page)).opened).toBe(1);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.resources([]));
		await settle(page);
		for (const hydrating of [false, true]) {
			await page.evaluate(
				(value) => (window as unknown as FixtureWindow).fixture.hydrating(value),
				hydrating,
			);
			await settle(page);
			for (const selector of previewBodies.slice(2)) {
				expect(
					await page.$eval(selector, (body) => body.parentElement?.hasAttribute("data-loading")),
				).toBe(hydrating);
				await page.click(selector, { clickCount: 2 });
				expect((await snapshot(page)).opened).toBe(1);
				await page.focus(selector);
				await page.keyboard.press("Enter");
				expect((await snapshot(page)).opened).toBe(1);
			}
		}
	} finally {
		await close(page);
	}
}, 15_000);
