import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./workspace-resource.browser-fixture";

// This suite owns only an ephemeral server/browser. It never starts or restarts
// NarraFork, and requires no settings, database, backend requests or WS sessions.
const cachedChromium =
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const executablePath = process.env.NF_TEST_CHROMIUM_PATH ?? cachedChromium;
const browserAvailable = existsSync(executablePath);
if (!browserAvailable)
	console.warn(
		`workspace-resource browser regression skipped: Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`,
	);
const browserTest = test.skipIf(!browserAvailable);
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
type FixtureWindow = Window & { fixture: typeof Fixture };
type Snapshot = ReturnType<typeof Fixture.snapshot>;

beforeAll(async () => {
	if (!browserAvailable) return;
	mkdirSync("artifacts", { recursive: true });
	const bundle = await Bun.build({
		entrypoints: [new URL("./workspace-resource.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	if (!script) throw new Error("Browser fixture bundle has no JavaScript output");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (styles.length === 0) throw new Error("Production workspace resource CSS was not bundled");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head>
					<meta name="viewport" content="width=device-width,initial-scale=1">
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					<style>html,body { margin:0; height:100%; } button { cursor:pointer; }</style>
					</head><body><div id="root"></div><script type="module">
					window.fixture = await import(${JSON.stringify(script)});
					</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
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

const state = (page: Page) =>
	page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
const panelState = (snapshot: Snapshot, id: string) => {
	const panel = snapshot.panels.find((entry) => entry.id === id);
	if (!panel) throw new Error(`Missing Dockview panel ${id}`);
	return panel;
};
async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
}
async function withFixture(
	run: (page: Page) => Promise<void>,
	width = 1200,
	height = 800,
	slots = 2,
) {
	if (!browser || !server) throw new Error("Browser fixture not initialized");
	const page = await browser.newPage();
	const errors: string[] = [];
	const unexpectedRequests: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	const origin = server.url.origin;
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.origin !== origin || url.pathname.startsWith("/api/"))
			unexpectedRequests.push(url.href);
	});
	try {
		await page.setViewport({ width, height });
		await page.goto(`${origin}/?slots=${slots}`, { waitUntil: "networkidle0" });
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture?.snapshot().ready,
		);
		await settle(page);
		const initial = await state(page);
		expect(initial.grid).toHaveLength(slots);
		for (const group of initial.grid) {
			expect(group.width).toBeGreaterThan(0);
			expect(group.height).toBeGreaterThan(0);
		}
		await run(page);
		expect(errors).toEqual([]);
		expect(unexpectedRequests).toEqual([]);
	} finally {
		await page.close();
	}
}

function expectSameGrid(before: Snapshot, after: Snapshot) {
	expect(after.grid).toHaveLength(before.grid.length);
	for (const [index, group] of before.grid.entries()) {
		const next = after.grid[index];
		expect(next.id).toBe(group.id);
		for (const key of ["left", "top", "width", "height"] as const)
			expect(Math.abs(next[key] - group[key])).toBeLessThanOrEqual(1);
	}
}
async function idFor(page: Page, kind: Fixture.ResourceKind) {
	return page.evaluate(
		(value) => (window as unknown as FixtureWindow).fixture.resourceId(value),
		kind,
	);
}
const headerSelector = (id: string) => `[data-panel="${id}"] .nf-panel-header`;
const titleSelector = (id: string) => `${headerSelector(id)} > p`;
const pinSelector = (id: string) => `${headerSelector(id)} [data-workspace-resource-pin="${id}"]`;
const bodySelector = (id: string) => `[data-body="${id}"]`;
async function clickHitTested(page: Page, selector: string) {
	const point = await page.$eval(selector, (element) => {
		const rect = element.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		const hit = document.elementFromPoint(x, y);
		return {
			x,
			y,
			visible: element.checkVisibility({ checkVisibilityCSS: true }),
			hit: !!hit && (hit === element || element.contains(hit)),
		};
	});
	expect(point.visible).toBe(true);
	expect(point.hit).toBe(true);
	await page.mouse.click(point.x, point.y);
	await settle(page);
}

async function expectTemporaryChrome(page: Page, id: string) {
	const chrome = await page.evaluate((resourceId) => {
		const panel = (window as unknown as FixtureWindow).fixture
			.nativeDockviewApi()
			.getPanel(resourceId);
		const header = document.querySelector(`[data-panel="${resourceId}"] .nf-panel-header`);
		if (!panel || !header) throw new Error("Resource header not mounted");
		const floating = panel.group.element.closest(".dv-resize-container");
		const visible = (element: Element) => element.checkVisibility({ checkVisibilityCSS: true });
		const pin = header.querySelector("button[data-workspace-resource-pin]");
		const buttons = [...header.querySelectorAll("button")];
		const close = buttons.at(-1);
		if (!pin || !close) throw new Error("Real resource header pin/close missing");
		const pinBounds = pin.getBoundingClientRect();
		const closeBounds = close.getBoundingClientRect();
		return {
			headerCount: [
				...document.querySelectorAll(`[data-panel="${resourceId}"] .nf-panel-header`),
			].filter(visible).length,
			nativeTitlebarCount: [...(floating?.querySelectorAll(".dv-floating-titlebar") ?? [])].filter(
				visible,
			).length,
			nativeTabCount: [
				...panel.group.element.querySelectorAll(".dv-tab, .dv-tabs-and-actions-container"),
			].filter(visible).length,
			headerTop: header.getBoundingClientRect().top,
			floatingTop: floating?.getBoundingClientRect().top,
			floatingBottom: floating?.getBoundingClientRect().bottom,
			contentBottom: document.querySelector(`[data-panel="${resourceId}"]`)?.getBoundingClientRect()
				.bottom,
			pinWidth: pinBounds.width,
			pinHeight: pinBounds.height,
			pinImmediatelyBeforeClose: buttons.at(-2) === pin,
			gapBeforeClose: closeBounds.left - pinBounds.right,
		};
	}, id);
	expect(chrome.headerCount).toBe(1);
	expect(chrome.nativeTitlebarCount).toBe(0);
	expect(chrome.nativeTabCount).toBe(0);
	expect(chrome.floatingTop).toBeDefined();
	expect(Math.abs(chrome.headerTop - (chrome.floatingTop ?? 0))).toBeLessThanOrEqual(3);
	expect(chrome.contentBottom).toBeDefined();
	expect(Math.abs((chrome.contentBottom ?? 0) - (chrome.floatingBottom ?? 0))).toBeLessThanOrEqual(
		3,
	);
	expect(chrome.pinWidth).toBeGreaterThanOrEqual(28);
	expect(chrome.pinHeight).toBeGreaterThanOrEqual(28);
	expect(chrome.pinImmediatelyBeforeClose).toBe(true);
	expect(chrome.gapBeforeClose).toBeGreaterThanOrEqual(0);
	expect(chrome.gapBeforeClose).toBeLessThanOrEqual(12);
}

async function expectRightDrawer(page: Page) {
	const bounds = await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.nativeFloatingBounds(),
	);
	expect(bounds.floating).toHaveLength(1);
	const floating = bounds.floating[0];
	expect(Math.abs(floating.top - bounds.workspace.top)).toBeLessThanOrEqual(1);
	expect(Math.abs(floating.height - bounds.workspace.height)).toBeLessThanOrEqual(1);
	expect(
		Math.abs(floating.left + floating.width - bounds.workspace.left - bounds.workspace.width),
	).toBeLessThanOrEqual(1);
	expect(floating.width).toBeGreaterThan(0);
	expect(floating.width).toBeLessThanOrEqual(bounds.workspace.width + 1);
	return bounds;
}

async function dragSelector(page: Page, selector: string, dx: number, dy: number) {
	const point = await page.$eval(selector, (element) => {
		const rect = element.getBoundingClientRect();
		return { x: rect.left + Math.min(70, rect.width / 3), y: rect.top + rect.height / 2 };
	});
	await page.mouse.move(point.x, point.y);
	await page.mouse.down();
	// Native Dockview starts its movement baseline at the first pointermove.
	// Prime that baseline separately, then measure an exact dx/dy from it.
	const primedX = point.x + Math.sign(dx) * 8;
	await page.mouse.move(primedX, point.y);
	await page.mouse.move(primedX + dx, point.y + dy, { steps: 12 });
	await page.mouse.up();
	await settle(page);
}

for (const kind of ["terminal", "browser", "subagent"] as const) {
	browserTest(
		`Grid ${kind}: native float leaves both narrator groups unchanged; pin preserves instance and source`,
		async () => {
			await withFixture(async (page) => {
				const id = await idFor(page, kind);
				const before = await state(page);
				await page.click(`[data-open="grid-${kind}"]`);
				await page.waitForSelector(titleSelector(id));
				await settle(page);
				const floating = await state(page);
				expectSameGrid(before, floating);
				expect(floating.temporary).toEqual([id]);
				expect(panelState(floating, id)).toMatchObject({
					location: "floating",
					mounts: 1,
					cleanups: 0,
					visible: true,
				});
				expect(panelState(floating, "source-a").visible).toBe(true);
				expect(panelState(floating, "source-b").visible).toBe(true);
				// The visible title is the resource body's real shared ToolPanelHeader,
				// not a mocked Dockview tab or a native floating titlebar.
				expect(await page.$eval(titleSelector(id), (element) => element.textContent)).toBe(kind);
				await expectTemporaryChrome(page, id);
				await expectRightDrawer(page);
				await page.screenshot({
					path: `artifacts/workspace-resource-grid-${kind}-temporary.png`,
				});
				await dragSelector(page, titleSelector(id), -110, 55);
				const moved = await state(page);
				expectSameGrid(before, moved);
				expect(moved.temporary).toEqual([id]);
				expect(moved.normalDragMoves).toBe(0);
				expect(moved.normalDragDrops).toBe(0);
				const beforeBounds = panelState(floating, id).groupBounds;
				const movedBounds = panelState(moved, id).groupBounds;
				expect(movedBounds.left - beforeBounds.left).toBeCloseTo(-110, 0);
				expect(moved.rootGrid).toEqual(before.rootGrid);
				expect(movedBounds.top - beforeBounds.top).toBeCloseTo(0, 0);
				expect(movedBounds.width).toBe(beforeBounds.width);
				expect(movedBounds.height).toBe(beforeBounds.height);
				expect(panelState(moved, id).instance).toBe(panelState(floating, id).instance);
				// Body/buttons must not arm either native floating movement or normal split drag.
				for (const selector of [
					bodySelector(id),
					pinSelector(id),
					`${headerSelector(id)} > button:last-child`,
				]) {
					await dragSelector(page, selector, 35, 22);
					const unchanged = await state(page);
					expectSameGrid(before, unchanged);
					expect(panelState(unchanged, id).groupBounds).toEqual(movedBounds);
					expect(unchanged.normalDragMoves).toBe(0);
					expect(unchanged.normalDragDrops).toBe(0);
				}
				await clickHitTested(page, bodySelector(id));
				await page.click(`[data-open="grid-${kind}"]`);
				await settle(page);
				const repeated = await state(page);
				expect(repeated.panels).toHaveLength(3);
				expect(panelState(repeated, id).instance).toBe(panelState(floating, id).instance);
				expectSameGrid(before, repeated);
				await clickHitTested(page, pinSelector(id));
				const pinned = await state(page);
				expectSameGrid(before, pinned);
				expect(pinned.temporary).toEqual([]);
				expect(pinned.reveals).toBe(1);
				expect(await page.$(pinSelector(id))).toBeNull();
				expect(panelState(pinned, id).headerHidden).toBe(false);
				expect(panelState(pinned, id)).toMatchObject({
					location: "grid",
					mounts: 1,
					cleanups: 0,
					visible: true,
					bodyClicks: 1,
				});
				expect(panelState(pinned, id).instance).toBe(panelState(floating, id).instance);
				expect(panelState(pinned, id).group).toBe(panelState(before, "source-b").group);
				expect(panelState(pinned, id).group).not.toBe(panelState(pinned, "source-a").group);
				expect(panelState(pinned, "source-a").visible).toBe(true);
				expect(
					await page.$eval(`[data-resource-tab="${id}"]`, (element) => element.textContent),
				).toContain("Alice");
				await page.screenshot({
					path: `artifacts/workspace-resource-grid-${kind}-pinned.png`,
				});
				expect(
					await page.$$eval(".dv-default-tab-content", (elements) =>
						elements.some(
							(element) =>
								element.textContent === "Bob" &&
								element.checkVisibility({ checkVisibilityCSS: true }),
						),
					),
				).toBe(true);
				await clickHitTested(page, bodySelector(id));
				await page.click(`[data-open="grid-${kind}"]`);
				await settle(page);
				const reopened = await state(page);
				expect(reopened.panels).toHaveLength(3);
				expect(reopened.temporary).toEqual([]);
				// activateResource deliberately reveals an existing fixed tab too.
				expect(reopened.reveals).toBe(pinned.reveals + 1);
				expect(panelState(reopened, id)).toMatchObject({
					location: "grid",
					mounts: 1,
					cleanups: 0,
					bodyClicks: 2,
				});
				expect(panelState(reopened, id).instance).toBe(panelState(floating, id).instance);
				expectSameGrid(before, reopened);
			});
		},
		30_000,
	);
}

for (const director of [false, true]) {
	browserTest(
		`${director ? "Director" : "Grid"} drawer: right/top/bottom anchor follows real viewport resize without remount`,
		async () => {
			await withFixture(async (page) => {
				const id = await idFor(page, "browser");
				if (director) {
					await page.click("[data-director-toggle]");
					await page.waitForSelector("[data-director-overlay]");
				}
				await page.click(`[data-open="${director ? "director" : "grid"}-browser"]`);
				await page.waitForSelector(titleSelector(id));
				await settle(page);
				const opened = await state(page);
				for (const [width, height] of [
					[1200, 800],
					[1000, 700],
					[420, 520],
					[1200, 800],
				]) {
					await page.setViewport({ width, height });
					await settle(page);
					await page.screenshot({
						path: `artifacts/workspace-resource-${director ? "director" : "grid"}-drawer-${width}x${height}.png`,
					});
					await expectRightDrawer(page);
					await expectTemporaryChrome(page, id);
					const resized = await state(page);
					expect(resized.grid).toHaveLength(2);
					expect(resized.temporary).toEqual([id]);
					expect(resized.director).toBe(director);
					expect(panelState(resized, id)).toMatchObject({
						location: "floating",
						mounts: 1,
						cleanups: 0,
						visible: true,
					});
					expect(panelState(resized, id).instance).toBe(panelState(opened, id).instance);
				}
				const beforeClose = await state(page);
				await clickHitTested(page, `${headerSelector(id)} > button:last-child`);
				const closed = await state(page);
				expect(closed.temporary).toEqual([]);
				expect(closed.panels.some((panel) => panel.id === id)).toBe(false);
				expect(closed.normalDragMoves).toBe(0);
				expect(closed.normalDragDrops).toBe(0);
				expect(closed.rootGrid).toEqual(beforeClose.rootGrid);
				expectSameGrid(beforeClose, closed);
				expect(await page.$(".dv-floating-overlay-host > .dv-resize-container")).toBeNull();
			});
		},
		30_000,
	);
	browserTest(
		`${director ? "Director" : "Grid"} single slot: enabled pin directly creates right split without dropdown`,
		async () => {
			await withFixture(
				async (page) => {
					const id = await idFor(page, "terminal");
					const before = await state(page);
					expect(before.singleGridSlot).toBe(true);
					if (director) {
						await page.click("[data-director-toggle]");
						await page.waitForSelector("[data-director-overlay]");
					}
					await page.click(`[data-open="${director ? "director" : "grid"}-terminal"]`);
					await page.waitForSelector(titleSelector(id));
					await settle(page);
					const floating = await state(page);
					expectSameGrid(before, floating);
					await expectTemporaryChrome(page, id);
					expect(
						await page.$eval(pinSelector(id), (button) => button.hasAttribute("disabled")),
					).toBe(false);
					expect(await page.$$(`${headerSelector(id)} button`)).toHaveLength(2);
					expect(await page.$(".mantine-Menu-dropdown")).toBeNull();
					await page.screenshot({
						path: `artifacts/workspace-resource-single-${director ? "director" : "grid"}-temporary.png`,
					});
					await clickHitTested(page, pinSelector(id));
					const pinned = await state(page);
					expect(pinned.grid).toHaveLength(2);
					expect(pinned.singleGridSlot).toBe(false);
					expect(pinned.temporary).toEqual([]);
					expect(pinned.director).toBe(false);
					expect(pinned.reveals).toBe(1);
					expect(pinned.normalDragMoves).toBe(0);
					expect(pinned.normalDragDrops).toBe(0);
					expect(await page.$(".mantine-Menu-dropdown")).toBeNull();
					expect(await page.$(pinSelector(id))).toBeNull();
					const resource = panelState(pinned, id);
					const source = panelState(pinned, "source-a");
					expect(resource).toMatchObject({
						location: "grid",
						headerHidden: false,
						mounts: 1,
						cleanups: 0,
						visible: true,
					});
					expect(resource.instance).toBe(panelState(floating, id).instance);
					expect(resource.group).not.toBe(source.group);
					expect(resource.groupBounds.left).toBeGreaterThan(source.groupBounds.left);
					expect(source.visible).toBe(true);
					expect(
						await page.$$eval(
							".dv-tab",
							(tabs) =>
								tabs.filter((tab) => tab.checkVisibility({ checkVisibilityCSS: true })).length,
						),
					).toBe(2);
					await page.screenshot({
						path: `artifacts/workspace-resource-single-${director ? "director" : "grid"}-pinned-right.png`,
					});
				},
				1200,
				800,
				1,
			);
		},
		30_000,
	);
}

for (const director of [false, true]) {
	for (const action of ["pin", "close"] as const) {
		browserTest(
			`${director ? "Director" : "Grid"} A→B ${action} B: A stays hidden/inert until explicit reopen`,
			async () => {
				await withFixture(async (page) => {
					const a = await idFor(page, "terminal");
					const b = await idFor(page, "browser");
					const initial = await state(page);
					if (director) {
						await page.click("[data-director-toggle]");
						await page.waitForSelector("[data-director-overlay]");
					}
					const openPrefix = director ? "director" : "grid";
					await page.click(`[data-open="${openPrefix}-terminal"]`);
					await page.waitForSelector(titleSelector(a));
					await settle(page);
					const first = await state(page);
					await page.click(`[data-open="${openPrefix}-browser"]`);
					await page.waitForSelector(titleSelector(b));
					await settle(page);
					const switched = await state(page);
					expectSameGrid(initial, switched);
					expect(switched.rootGrid).toEqual(initial.rootGrid);
					expect(panelState(switched, a)).toMatchObject({
						visible: false,
						providerVisible: false,
						nativeHostInert: true,
						bodyOverlayInert: true,
						mounts: 1,
						cleanups: 0,
					});
					expect(panelState(switched, b)).toMatchObject({
						visible: true,
						providerVisible: true,
						nativeHostInert: false,
						bodyOverlayInert: false,
					});
					expect(panelState(switched, a).group).not.toBe(panelState(switched, b).group);
					expect(
						await page.$eval(bodySelector(a), (body) => {
							(body as HTMLElement).focus();
							return document.activeElement === body;
						}),
					).toBe(false);
					await clickHitTested(
						page,
						action === "pin" ? pinSelector(b) : `${headerSelector(b)} > button:last-child`,
					);
					const dismissed = await state(page);
					expect(panelState(dismissed, a)).toMatchObject({
						visible: false,
						providerVisible: false,
						nativeHostInert: true,
						bodyOverlayInert: true,
						mounts: 1,
						cleanups: 0,
					});
					expect(panelState(dismissed, a).instance).toBe(panelState(first, a).instance);
					if (action === "pin") {
						expect(panelState(dismissed, b).location).toBe("grid");
						await clickHitTested(page, bodySelector(b));
					} else expect(dismissed.panels.some((panel) => panel.id === b)).toBe(false);
					await page.screenshot({
						path: `artifacts/workspace-resource-${director ? "director" : "grid"}-preview-${action}-b.png`,
					});
					await page.click(
						`[${action === "close" ? "data-toggle" : "data-open"}="${director && action === "close" ? "director" : "grid"}-terminal"]`,
					);
					await settle(page);
					const reopened = await state(page);
					expect(panelState(reopened, a)).toMatchObject({
						visible: true,
						providerVisible: true,
						nativeHostInert: false,
						bodyOverlayInert: false,
						mounts: 1,
						cleanups: 0,
					});
					expect(panelState(reopened, a).instance).toBe(panelState(first, a).instance);
					expect(reopened.normalDragMoves).toBe(0);
					expect(reopened.normalDragDrops).toBe(0);
					await expectTemporaryChrome(page, a);
					await clickHitTested(page, bodySelector(a));
				});
			},
			30_000,
		);
	}
}

browserTest(
	"Mixed native floating group: durable + temporary retain visible tabs and saved header",
	async () => {
		await withFixture(async (page) => {
			const id = await idFor(page, "browser");
			await page.click('[data-open="grid-browser"]');
			await page.waitForSelector(titleSelector(id));
			await settle(page);
			const floating = await state(page);
			await page.evaluate((resourceId) => {
				const api = (window as unknown as FixtureWindow).fixture.nativeDockviewApi();
				const temporary = api.getPanel(resourceId);
				const durable = api.getPanel("source-b");
				if (!temporary || !durable) throw new Error("Native mixed-group panels missing");
				durable.api.moveTo({ group: temporary.group, position: "center" });
			}, id);
			await settle(page);
			const mixed = await state(page);
			expect(panelState(mixed, id)).toMatchObject({
				headerHidden: false,
				managedPreview: false,
				nativeHostInert: false,
			});
			expect(panelState(mixed, id).group).toBe(panelState(mixed, "source-b").group);
			expect(panelState(mixed, id).instance).toBe(panelState(floating, id).instance);
			const tab = `[data-resource-tab="${id}"] .dv-default-tab-content`;
			await clickHitTested(page, tab);
			const selected = await state(page);
			expect(panelState(selected, id)).toMatchObject({ visible: true, providerVisible: true });
			const saved = await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.durableLayout(),
			);
			expect(saved.panels[id]).toBeUndefined();
			const group = saved.floatingGroups?.find((entry) => entry.data?.views.includes("source-b"));
			expect(group).toBeDefined();
			expect(group?.data?.hideHeader ?? false).toBe(false);
			expect(group?.data?.views).toEqual(["source-b"]);
			await page.evaluate(
				(layout) =>
					(window as unknown as FixtureWindow).fixture.nativeDockviewApi().fromJSON(layout),
				saved,
			);
			await settle(page);
			const restored = await state(page);
			expect(panelState(restored, "source-b")).toMatchObject({
				headerHidden: false,
				visible: true,
				location: "floating",
			});
			await page.screenshot({ path: "artifacts/workspace-resource-mixed-durable-tabs.png" });
		});
	},
	30_000,
);

browserTest(
	"Header pointerdown consumers: prevented drag stays still; Shift uses only shared singleton drag",
	async () => {
		await withFixture(async (page) => {
			const id = await idFor(page, "terminal");
			const grid = await state(page);
			await page.click('[data-open="grid-terminal"]');
			await page.waitForSelector(titleSelector(id));
			await settle(page);
			const floating = await state(page);
			await page.evaluate(
				(resourceId) =>
					(window as unknown as FixtureWindow).fixture.consumeHeaderPointerDown(resourceId, true),
				id,
			);
			await dragSelector(page, titleSelector(id), -110, 55);
			const consumed = await state(page);
			expect(panelState(consumed, id).groupBounds).toEqual(panelState(floating, id).groupBounds);
			expect(consumed.normalDragMoves).toBe(0);
			expect(consumed.normalDragDrops).toBe(0);
			await page.evaluate(
				(resourceId) =>
					(window as unknown as FixtureWindow).fixture.consumeHeaderPointerDown(resourceId, false),
				id,
			);
			await page.keyboard.down("Shift");
			try {
				await dragSelector(page, titleSelector(id), -110, 55);
			} finally {
				await page.keyboard.up("Shift");
			}
			const shifted = await state(page);
			expect(shifted.normalDragMoves).toBeGreaterThan(0);
			expect(shifted.normalDragDrops).toBe(1);
			expect(panelState(shifted, id).groupBounds).toEqual(panelState(floating, id).groupBounds);
			expect(panelState(shifted, id).location).toBe("floating");
			expect(panelState(shifted, id).instance).toBe(panelState(floating, id).instance);
			expectSameGrid(grid, shifted);
			expect(shifted.rootGrid).toEqual(grid.rootGrid);
		});
	},
	30_000,
);

browserTest(
	"Director CSS harness: independent resource instances switch one visible preview; pin exits overlay",
	async () => {
		await withFixture(async (page) => {
			const terminal = await idFor(page, "terminal");
			const browserId = await idFor(page, "browser");
			const before = await state(page);
			await page.click("[data-director-toggle]");
			await page.waitForSelector("[data-director-overlay]");
			await page.click('[data-open="director-terminal"]');
			await page.waitForSelector(titleSelector(terminal));
			await page.click('[data-open="director-browser"]');
			await page.waitForSelector(titleSelector(browserId));
			await settle(page);
			const opened = await state(page);
			expectSameGrid(before, opened);
			expect(opened.director).toBe(true);
			expect(opened.panels).toHaveLength(4);
			expect(panelState(opened, "source-a").visible).toBe(false);
			expect(panelState(opened, "source-b").visible).toBe(false);
			expect(panelState(opened, terminal).group).not.toBe(panelState(opened, browserId).group);
			expect(panelState(opened, terminal)).toMatchObject({
				visible: false,
				nativeHostInert: true,
				bodyOverlayInert: true,
				providerVisible: false,
			});
			expect(panelState(opened, browserId).visible).toBe(true);
			await expectTemporaryChrome(page, browserId);
			// Repeat open activates this independent native float, not a shared tab.
			await page.click('[data-open="director-terminal"]');
			await settle(page);
			const overlayClicks = (await state(page)).overlayClicks;
			await expectTemporaryChrome(page, terminal);
			await dragSelector(page, titleSelector(terminal), -110, 55);
			await clickHitTested(page, titleSelector(terminal));
			await clickHitTested(page, bodySelector(terminal));
			const terminalActive = await state(page);
			expect(terminalActive.activePanel).toBe(terminal);
			expect(panelState(terminalActive, terminal).headerPointerDowns).toBeGreaterThan(0);
			expect(panelState(terminalActive, terminal).bodyClicks).toBe(1);
			expect(panelState(terminalActive, browserId).visible).toBe(false);
			await page.click('[data-open="director-browser"]');
			await settle(page);
			await expectTemporaryChrome(page, browserId);
			await dragSelector(page, titleSelector(browserId), -90, 60);
			await clickHitTested(page, titleSelector(browserId));
			await clickHitTested(page, bodySelector(browserId));
			const switched = await state(page);
			expectSameGrid(before, switched);
			expect(switched.normalDragMoves).toBe(0);
			expect(switched.normalDragDrops).toBe(0);
			await page.screenshot({
				path: "artifacts/workspace-resource-director-current-preview.png",
			});
			expect(switched.overlayClicks).toBe(overlayClicks + 1);
			expect(panelState(switched, terminal).visible).toBe(false);
			expect(panelState(switched, browserId).bodyClicks).toBe(1);
			expect(panelState(switched, browserId).mounts).toBe(1);
			await clickHitTested(page, pinSelector(browserId));
			const pinned = await state(page);
			expect(pinned.director).toBe(false);
			expect(await page.$("[data-director-overlay]")).toBeNull();
			expect(pinned.reveals).toBe(1);
			expect(pinned.temporary).toEqual([terminal]);
			expect(panelState(pinned, "source-a").visible).toBe(true);
			expect(panelState(pinned, browserId)).toMatchObject({
				location: "grid",
				visible: true,
				mounts: 1,
				cleanups: 0,
				bodyClicks: 1,
			});
			expect(panelState(pinned, browserId).instance).toBe(panelState(opened, browserId).instance);
			expectSameGrid(before, pinned);

			expect(panelState(pinned, terminal)).toMatchObject({
				visible: false,
				providerVisible: false,
				nativeHostInert: true,
				bodyOverlayInert: true,
			});
			// Opening an already-fixed resource from Director must reveal its saved
			// grid tab, rather than creating a new temporary panel over the overlay.
			await page.click("[data-director-toggle]");
			await page.waitForSelector("[data-director-overlay]");
			await page.click('[data-open="director-browser"]');
			await settle(page);
			const reopened = await state(page);
			expect(reopened.director).toBe(false);
			expect(await page.$("[data-director-overlay]")).toBeNull();
			expect(reopened.reveals).toBe(pinned.reveals + 1);
			expect(reopened.panels).toHaveLength(4);
			expect(reopened.temporary).toEqual([terminal]);
			expect(reopened.activePanel).toBe(browserId);
			expect(panelState(reopened, browserId)).toMatchObject({
				location: "grid",
				visible: true,
				mounts: 1,
				cleanups: 0,
				bodyClicks: 1,
			});
			expect(panelState(reopened, browserId).instance).toBe(panelState(opened, browserId).instance);
			expect(panelState(reopened, "source-a").visible).toBe(true);
			expectSameGrid(before, reopened);
		});
	},
	30_000,
);

browserTest(
	"Narrow viewport: native float remains inside offset workspace in Grid and Director",
	async () => {
		await withFixture(
			async (page) => {
				const id = await idFor(page, "terminal");
				const before = await state(page);
				await page.click('[data-open="grid-terminal"]');
				await page.waitForSelector(titleSelector(id));
				await settle(page);
				for (const director of [false, true]) {
					if (director) {
						await page.click("[data-director-toggle]");
						await settle(page);
					}
					const bounds = await page.evaluate(() =>
						(window as unknown as FixtureWindow).fixture.nativeFloatingBounds(),
					);
					expect(bounds.floating).toHaveLength(1);
					expect(bounds.workspace.left).toBeGreaterThan(0);
					for (const floating of bounds.floating) {
						expect(floating.left).toBeGreaterThanOrEqual(bounds.workspace.left - 1);
						expect(floating.top).toBeGreaterThanOrEqual(bounds.workspace.top - 1);
						expect(floating.left + floating.width).toBeLessThanOrEqual(
							bounds.workspace.left + bounds.workspace.width + 1,
						);
						expect(floating.top + floating.height).toBeLessThanOrEqual(
							bounds.workspace.top + bounds.workspace.height + 1,
						);
					}
					await clickHitTested(page, titleSelector(id));
					await clickHitTested(page, bodySelector(id));
					expectSameGrid(before, await state(page));
				}
			},
			420,
			520,
		);
	},
	30_000,
);

for (const director of [false, true]) {
	browserTest(
		`${director ? "Director" : "Grid"} native Escape: body/header close, editors/consumed/outer/fixed targets stay open`,
		async () => {
			await withFixture(async (page) => {
				const id = await idFor(page, "terminal");
				const before = await state(page);
				if (director) {
					await page.click("[data-director-toggle]");
					await page.waitForSelector("[data-director-overlay]");
				}
				const opener = `[data-open="${director ? "director" : "grid"}-terminal"]`;
				await page.click(opener);
				await page.waitForSelector(titleSelector(id));
				await settle(page);
				for (const editor of [
					"input",
					"textarea",
					"select",
					"contenteditable",
					"xterm",
					"monaco",
					"menu",
					"dialog",
					"consumed",
				]) {
					await page.focus(`[data-panel="${id}"] [data-editor="${editor}"]`);
					await page.keyboard.press("Escape");
					await settle(page);
					const current = await state(page);
					expect(current.temporary).toEqual([id]);
					expect(panelState(current, id)).toMatchObject({
						location: "floating",
						mounts: 1,
						cleanups: 0,
					});
					expect(current.escapeDecisions.at(-1)).toMatchObject({ closed: false, target: editor });
					if (editor === "consumed") expect(current.escapeDecisions.at(-1)?.prevented).toBe(true);
				}
				// Modifiers do not turn an ordinary focused resource button into a close.
				for (const modifier of ["Alt", "Control", "Meta"] as const) {
					await page.focus(bodySelector(id));
					await page.keyboard.down(modifier);
					try {
						await page.keyboard.press("Escape");
					} finally {
						await page.keyboard.up(modifier);
					}
					await settle(page);
					const current = await state(page);
					expect(current.temporary).toEqual([id]);
					expect(current.escapeDecisions.at(-1)?.closed).toBe(false);
				}
				// Inside the same workspace but outside the native floating group/content.
				await page.focus(director ? opener : bodySelector("source-a"));
				await page.keyboard.press("Escape");
				await settle(page);
				const background = await state(page);
				expect(background.temporary).toEqual([id]);
				expect(background.escapeDecisions.at(-1)?.closed).toBe(false);
				// Entirely outside the workspace: its native listener must not see the key.
				await page.focus("[data-director-toggle]");
				await page.keyboard.press("Escape");
				await settle(page);
				const outside = await state(page);
				expect(outside.temporary).toEqual([id]);
				expect(outside.escapeDecisions).toHaveLength(background.escapeDecisions.length);
				await page.focus(bodySelector(id));
				await page.keyboard.press("Escape");
				await settle(page);
				const closed = await state(page);
				expect(closed.temporary).toEqual([]);
				expect(closed.panels.some((panel) => panel.id === id)).toBe(false);
				expect(closed.escapeDecisions.at(-1)).toMatchObject({ closed: true, prevented: false });
				expect(await page.$(".dv-floating-overlay-host > .dv-resize-container")).toBeNull();
				expect(await page.$eval(opener, (element) => document.activeElement === element)).toBe(
					true,
				);
				expectSameGrid(before, closed);

				// A production header action is focusable, but has no React Escape
				// handler: dismissal must come from the same native ancestor listener.
				await page.click(opener);
				await page.waitForSelector(titleSelector(id));
				await page.focus(pinSelector(id));
				await page.keyboard.press("Escape");
				await settle(page);
				const titleClosed = await state(page);
				expect(titleClosed.temporary).toEqual([]);
				expect(titleClosed.panels.some((panel) => panel.id === id)).toBe(false);
				expect(titleClosed.escapeDecisions.at(-1)).toMatchObject({
					closed: true,
					prevented: false,
				});
				expectSameGrid(before, titleClosed);

				await page.click(opener);
				await page.waitForSelector(titleSelector(id));
				await page.click(pinSelector(id));
				await settle(page);
				await page.focus(bodySelector(id));
				await page.keyboard.press("Escape");
				await settle(page);
				const fixed = await state(page);
				expect(fixed.temporary).toEqual([]);
				expect(panelState(fixed, id).location).toBe("grid");
				expect(fixed.escapeDecisions.at(-1)?.closed).toBe(false);
				expectSameGrid(before, fixed);
			});
		},
		30_000,
	);
}
