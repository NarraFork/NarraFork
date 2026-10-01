import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "../fixtures/frontend/recent-tabs-drag";

// No environment-specific binary path is imported or hard-coded. This opt-in
// suite never starts a NarraFork server and does not touch settings or SQLite.
const executablePath = process.env.NF_TEST_CHROMIUM_PATH;
let browser: Browser;
let source: string;
type FixtureWindow = Window & { fixture: typeof Fixture };

beforeAll(async () => {
	if (!executablePath) return;
	const bundle = await Bun.build({
		entrypoints: [new URL("../fixtures/frontend/recent-tabs-drag.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	source = await bundle.outputs[0].text();
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
}, 30_000);
afterAll(async () => {
	await browser?.close();
});

async function openFixture() {
	const page = await browser.newPage();
	await page.setViewport({ width: 900, height: 650, hasTouch: true });
	await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1">
		<style>
			body { margin:0; font:14px sans-serif; }
			nav { position:absolute; top:40px; left:20px; width:240px; }
			#sidebar { height:360px; overflow:auto; overflow-anchor:none; }
			.row { box-sizing:border-box; height:40px; border:1px solid #888; padding:8px; touch-action:none; }
			main { position:absolute; top:40px; left:320px; width:500px; height:500px; }
			#overlay { height:40px; background:#ddd; pointer-events:none; }
		</style><div id="root"></div>`);
	await page.evaluate(async (moduleSource) => {
		const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
		(window as unknown as FixtureWindow).fixture = await import(url);
		URL.revokeObjectURL(url);
	}, source);
	await page.waitForSelector('[data-tab-sort-id="workspace:w"]');
	return page;
}
const state = (page: Page) =>
	page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
async function point(page: Page, id: string, fraction = 0.5) {
	return page.$eval(
		`[data-tab-sort-id="${id}"]`,
		(element, f) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height * f };
		},
		fraction,
	);
}
async function begin(page: Page, id: string) {
	const origin = await point(page, id);
	await page.mouse.move(origin.x, origin.y);
	await page.mouse.down();
	await page.mouse.move(origin.x + 10, origin.y, { steps: 2 });
	await settle(page);
}
async function moveTo(page: Page, id: string, fraction = 0.8) {
	const destination = await point(page, id, fraction);
	await page.mouse.move(destination.x, destination.y, { steps: 8 });
	await settle(page);
}
async function idle(page: Page) {
	await page.waitForFunction(
		() => !(window as unknown as FixtureWindow).fixture.snapshot().pending,
	);
	await settle(page);
	const current = await state(page);
	expect(current.draggingId).toBeNull();
	expect(current.dragging).toBe(false);
	expect(current.panel).toBeNull();
	expect(current.indicator).toBeNull();
	expect(current.errors).toBe(0);
	expect(await page.$("#overlay")).toBeNull();
}
const browserTest = test.skipIf(!executablePath);
browserTest(
	"directory member drag uses directory-order transport and applies real cache delta",
	async () => {
		const page = await openFixture();
		try {
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.directoryFixture());
			await page.waitForSelector('[data-tab-sort-id="dir:/repo"]');
			await begin(page, "narrator:a");
			await moveTo(page, "narrator:b");
			await page.mouse.up();
			await idle(page);
			const current = await state(page);
			expect(current.calls).toEqual([{ method: "directory", keys: ["narrator:b", "narrator:a"] }]);
			const rendered = await page.$$eval('[data-unit="/repo"] .row', (rows) =>
				rows.map((row) => row.getAttribute("data-tab-sort-id")),
			);
			expect(rendered).toEqual(["dir:/repo", "narrator:b", "narrator:a"]);
		} finally {
			await page.close();
		}
	},
	20_000,
);

browserTest(
	"TouchSensor long press uses real browser touch events for outside delivery",
	async () => {
		const page = await openFixture();
		try {
			const origin = await point(page, "narrator:a");
			await page.touchscreen.touchStart(origin.x, origin.y);
			await page.waitForFunction(
				() => (window as unknown as FixtureWindow).fixture.snapshot().draggingId === "narrator:a",
			);
			await page.touchscreen.touchMove(500, 260);
			await settle(page);
			await page.touchscreen.touchEnd();
			await idle(page);
			const current = await state(page);
			expect(current.calls).toEqual([]);
			expect(current.deliveries).toHaveLength(1);
			expect(current.deliveries[0]).toMatchObject({ id: "a", x: 500, y: 260 });
		} finally {
			await page.close();
		}
	},
	20_000,
);
browserTest(
	"workspace drag preserves original header/children DOM and commits the complete group",
	async () => {
		const page = await openFixture();
		try {
			await page.evaluate(() => {
				for (const element of document.querySelectorAll('[data-unit="w"] .row'))
					element.setAttribute("data-original", "yes");
			});
			await begin(page, "workspace:w");
			expect((await state(page)).draggingId).toBe("workspace:w");
			await moveTo(page, "narrator:b");
			const visible = await page.$$eval('[data-unit="w"] .row', (rows) =>
				rows.map((row) => ({
					original: row.getAttribute("data-original"),
					height: row.getBoundingClientRect().height,
					display: getComputedStyle(row).display,
					visibility: getComputedStyle(row).visibility,
				})),
			);
			expect(visible).toHaveLength(3);
			for (const row of visible) {
				expect(row.original).toBe("yes");
				expect(row.height).toBe(40);
				expect(row.display).not.toBe("none");
				expect(row.visibility).toBe("visible");
			}
			await page.mouse.up();
			await idle(page);
			const current = await state(page);
			expect(current.calls).toEqual([
				{ method: "move", key: "workspace:w", target: { afterKey: "narrator:b" } },
			]);
			expect(current.order.slice(0, 6)).toEqual([
				"narrator:a",
				"narrator:b",
				"workspace:w",
				"narrator:w1",
				"narrator:w2",
				"narrator:c",
			]);
			expect(current.cacheOrder).toEqual(current.order);
		} finally {
			await page.close();
		}
	},
	20_000,
);

browserTest(
	"outside-sidebar release delivers panel drag exactly once without sorting",
	async () => {
		const page = await openFixture();
		try {
			await begin(page, "narrator:a");
			await page.mouse.move(500, 260, { steps: 10 });
			await settle(page);
			expect((await state(page)).indicator).toBeNull();
			await page.mouse.up();
			await idle(page);
			const current = await state(page);
			expect(current.calls).toEqual([]);
			expect(current.deliveries).toHaveLength(1);
			expect(current.deliveries[0]).toMatchObject({ id: "a", x: 500, y: 260 });
			expect(current.ends).toHaveLength(1);
		} finally {
			await page.close();
		}
	},
	20_000,
);

browserTest(
	"Escape cancels panel delivery and repeated drags leave no overlay or singleton",
	async () => {
		const page = await openFixture();
		try {
			for (let i = 0; i < 3; i++) {
				await begin(page, "narrator:a");
				await page.mouse.move(500, 220, { steps: 5 });
				await settle(page);
				await page.keyboard.press("Escape");
				await page.mouse.up();
				await idle(page);
			}
			let current = await state(page);
			expect(current.ends).toEqual([null, null, null]);
			expect(current.deliveries).toEqual([]);
			expect(current.calls).toEqual([]);
			await begin(page, "narrator:b");
			await page.mouse.move(520, 240, { steps: 5 });
			await page.mouse.up();
			await idle(page);
			current = await state(page);
			expect(current.deliveries).toHaveLength(1);
			expect(current.deliveries[0].id).toBe("b");
		} finally {
			await page.close();
		}
	},
	20_000,
);

browserTest(
	"pending mutation blocks a second real sensor drag then unlocks after the delta",
	async () => {
		const page = await openFixture();
		try {
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hold(true));
			await begin(page, "narrator:a");
			await moveTo(page, "narrator:c");
			await page.mouse.up();
			await page.waitForFunction(
				() => (window as unknown as FixtureWindow).fixture.snapshot().pending,
			);
			expect((await state(page)).calls).toHaveLength(1);
			await begin(page, "narrator:b");
			expect((await state(page)).draggingId).toBeNull();
			expect(await page.$("#overlay")).toBeNull();
			await page.mouse.move(500, 250);
			await page.mouse.up();
			expect((await state(page)).calls).toHaveLength(1);
			expect((await state(page)).deliveries).toHaveLength(0);
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hold(false));
			await idle(page);
			await begin(page, "narrator:b");
			expect((await state(page)).draggingId).toBe("narrator:b");
			await page.keyboard.press("Escape");
			await page.mouse.up();
			await idle(page);
		} finally {
			await page.close();
		}
	},
	20_000,
);

browserTest(
	"real scroll during mouse drag measures viewport rows rather than stale start coordinates",
	async () => {
		const page = await openFixture();
		try {
			await begin(page, "narrator:a");
			await page.$eval("#sidebar", (element) => {
				element.scrollTop = 200;
			});
			await settle(page);
			await moveTo(page, "narrator:tail4", 0.6);
			const destination = await point(page, "narrator:tail4", 0.6);
			const current = await state(page);
			expect(current.panel?.y).toBeCloseTo(destination.y, 0);
			expect(current.indicator?.target).toEqual({ kind: "after", key: "narrator:tail4" });
			const actualTop = await page.$eval(
				'[data-tab-sort-id="narrator:tail4"]',
				(element) => element.getBoundingClientRect().top,
			);
			expect(current.measured.find((row) => row.key === "narrator:tail4")?.top).toBe(actualTop);
			await page.mouse.up();
			await idle(page);
			expect((await state(page)).calls).toEqual([
				{ method: "move", key: "narrator:a", target: { afterKey: "narrator:tail4" } },
			]);
		} finally {
			await page.close();
		}
	},
	20_000,
);
