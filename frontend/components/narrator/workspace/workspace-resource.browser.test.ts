import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
async function withFixture(run: (page: Page) => Promise<void>, width = 1200, height = 800) {
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
		await page.goto(origin, { waitUntil: "networkidle0" });
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture?.snapshot().ready,
		);
		await settle(page);
		const initial = await state(page);
		expect(initial.grid).toHaveLength(2);
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
const titleSelector = (id: string) => `[data-resource-tab="${id}"] .dv-default-tab-content`;
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
				// Real production header gets the narrator title from the real query hook.
				expect(
					await page.$eval(`[data-resource-tab="${id}"]`, (element) => element.textContent),
				).toContain("Alice");
				await clickHitTested(page, bodySelector(id));
				await page.click(`[data-open="grid-${kind}"]`);
				await settle(page);
				const repeated = await state(page);
				expect(repeated.panels).toHaveLength(3);
				expect(panelState(repeated, id).instance).toBe(panelState(floating, id).instance);
				expectSameGrid(before, repeated);
				await clickHitTested(
					page,
					`[data-resource-tab="${id}"] button[aria-label="Pin as a tab in Bob"]`,
				);
				const pinned = await state(page);
				expectSameGrid(before, pinned);
				expect(pinned.temporary).toEqual([]);
				expect(pinned.reveals).toBe(1);
				expect(await page.$(`[data-resource-tab="${id}"] button[aria-label^="Pin as"]`)).toBeNull();
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

browserTest(
	"Director CSS harness: native floating title/body win hit testing, inactive resource stays hidden, pin exits overlay",
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
			expect(panelState(opened, terminal).group).toBe(panelState(opened, browserId).group);
			expect(panelState(opened, terminal).visible).toBe(false);
			expect(panelState(opened, browserId).visible).toBe(true);
			const overlayClicks = opened.overlayClicks;
			await clickHitTested(page, titleSelector(terminal));
			await clickHitTested(page, bodySelector(terminal));
			const terminalActive = await state(page);
			expect(terminalActive.activePanel).toBe(terminal);
			expect(panelState(terminalActive, terminal).titleClicks).toBeGreaterThan(0);
			expect(panelState(terminalActive, terminal).bodyClicks).toBe(1);
			expect(panelState(terminalActive, browserId).visible).toBe(false);
			await clickHitTested(page, titleSelector(browserId));
			await clickHitTested(page, bodySelector(browserId));
			const switched = await state(page);
			expect(switched.overlayClicks).toBe(overlayClicks);
			expect(panelState(switched, terminal).visible).toBe(false);
			expect(panelState(switched, browserId).bodyClicks).toBe(1);
			expect(panelState(switched, browserId).mounts).toBe(1);
			await clickHitTested(
				page,
				`[data-resource-tab="${browserId}"] button[aria-label="Pin in Bob and switch to grid"]`,
			);
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
				await page.focus(
					`[data-resource-tab="${id}"] button[aria-label^="Pin ${director ? "in" : "as"}"]`,
				);
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
				await page.click(
					`[data-resource-tab="${id}"] button[aria-label^="Pin ${director ? "in" : "as"}"]`,
				);
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
