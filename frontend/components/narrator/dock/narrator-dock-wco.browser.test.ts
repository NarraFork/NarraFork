import { afterAll, beforeAll, expect, test } from "bun:test";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./narrator-dock-wco.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
type Snapshot = ReturnType<typeof Fixture.snapshot>;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
	const executablePath = process.env.NF_TEST_CHROMIUM_PATH;
	if (!executablePath) throw new Error("需要通过 NF_TEST_CHROMIUM_PATH 指定可启动的 Chromium");
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("./narrator-dock-wco.browser-fixture.tsx", import.meta.url)),
		],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || styles.length === 0) throw new Error("夹具没有生成脚本或生产 CSS");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/") {
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8">
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					</head><body><div id="root"></div><script type="module">
					import * as fixture from ${JSON.stringify(script)}; window.fixture = fixture;
					</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			}
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		timeout: 10_000,
		protocolTimeout: 10_000,
	});
}, 20_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

const state = (page: Page) =>
	page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
const settle = (page: Page) =>
	page.evaluate(async () => {
		for (let i = 0; i < 6; i++)
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	});

/** 溢出菜单是点到才创建的弹层，点击后要等它真的上屏再判断命中。 */
async function openOverflowMenu(page: Page) {
	await page.click(".dv-tabs-overflow-dropdown-root");
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture.snapshot().popup);
	await settle(page);
}

/** 布局宽度是小数，页签是否在可视范围内按一像素容差判断。 */
const EDGE_TOLERANCE = 1;

async function withFixture(run: (page: Page) => Promise<void>) {
	if (!browser || !server) throw new Error("浏览器夹具未初始化");
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.setDefaultTimeout(5_000);
	try {
		await page.setViewport({ width: 1400, height: 900 });
		await page.goto(server.url.href);
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture?.snapshot().ready,
		);
		await settle(page);
		await run(page);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}

test("真实 Dockview：只下移右侧标签和内容，主会话矩形及编辑状态不变", async () => {
	await withFixture(async (page) => {
		for (const height of [32, 40, 48]) {
			for (const top of [0, -height]) {
				await page.evaluate(
					({ height, top }) => {
						const fixture = (window as unknown as FixtureWindow).fixture;
						fixture.setAvoidance(false);
						fixture.configure({ height, top });
						fixture.activate("tool-0");
					},
					{ height, top },
				);
				await settle(page);
				const before = await state(page);
				await page.evaluate(() => (window as unknown as FixtureWindow).fixture.setAvoidance(true));
				await settle(page);
				const after = await state(page);
				expect(after.primary).toEqual(before.primary);
				expect(after.tool.tabs?.top).toBe(height + 1);
				expect(after.tool.tabs?.width).toBe(after.tool.group?.width);
				expect(after.tool.paddingRight).toBe("0px");
				expect(after.tool.content?.top).toBe(after.tool.tabs?.bottom);
				expect(after.tool.content?.bottom).toBe(900);
				expect(after.tool.inputValue).toBe(before.tool.inputValue);
			}
		}
		const beforeSwitch = await state(page);
		await openOverflowMenu(page);
		const popup = await state(page);
		expect(popup.popup).not.toBeNull();
		expect(popup.popupHit).toBe(true);
		await page.click(".dv-tabs-overflow-container .dv-tab");
		await settle(page);
		const switched = await state(page);
		expect(switched.popup).toBeNull();
		expect(switched.activeTool).not.toBe("tool-0");
		expect(switched.tool.tabs?.top).toBe(49);
		expect(switched.primary).toEqual(beforeSwitch.primary);
		expect(switched.ancestorScroll).toEqual(beforeSwitch.ancestorScroll);
	});
}, 20_000);

test("真实 Dockview：过渡、重挂载、拆分、缩放和退出模式不会遗留避让", async () => {
	await withFixture(async (page) => {
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.configure({ height: 32, top: -32 });
			fixture.activate("tool-0");
		});
		await settle(page);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.configure({ height: 0, visible: false, mode: true });
			fixture.setAvoidance(true);
		});
		await settle(page);
		expect((await state(page)).tool.tabs?.top).toBe(33);
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.configure({ height: 32, visible: true });
			fixture.moveTool("tool-7", "bottom");
		});
		await settle(page);
		const split = await state(page);
		expect(split.tool.marked).toBe(true);
		expect(split.otherTool.marked).toBe(false);
		expect(split.otherTool.group?.top).toBeGreaterThan(32);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.moveTool("tool-7", "center"),
		);
		await settle(page);
		for (const width of [1000, 1700]) {
			await page.setViewport({ width, height: 900 });
			await settle(page);
			const resized = await state(page);
			expect(resized.tool.tabs?.top).toBe(33);
			expect(resized.tool.tabs?.width).toBe(resized.tool.group?.width);
			expect(resized.tool.content?.bottom).toBe(900);
		}
		await page.setViewport({ width: 600, height: 900 });
		await settle(page);
		expect((await state(page)).tool.marked).toBe(false);
		await page.setViewport({ width: 1400, height: 900 });
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.configure({ visible: false, mode: false }),
		);
		await settle(page);
		expect((await state(page)).tool.marked).toBe(false);
	});
}, 20_000);

test("真实 AppShell：父容器可滚动时，普通页签及溢出选择均不得把中间标题滚出窗口", async () => {
	await withFixture(async (page) => {
		await page.evaluate(() => {
			const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="primary"]');
			if (!input) throw new Error("缺少主会话输入框");
			input.value = "保持中间编辑与滚动状态\n".repeat(60);
			input.scrollTop = 100;
		});
		for (const height of [32, 40, 48]) {
			for (const top of [0, -height]) {
				await page.evaluate(
					({ height, top }) => {
						const fixture = (window as unknown as FixtureWindow).fixture;
						fixture.configure({ height, top, ancestorOverflow: 128 });
						fixture.activate("tool-0");
					},
					{ height, top },
				);
				await settle(page);
				const before = await state(page);
				// 父容器滚动位置与中间纵向位置是这次回归真正影响的量；横向亚像素抖动是夹具噪声。
				const vertical = (snapshot: Snapshot) => ({
					headerTop: snapshot.primary.header?.top,
					contentTop: snapshot.primary.content?.top,
					inputTop: snapshot.primary.input?.top,
					inputScrollTop: snapshot.primary.inputScrollTop,
					ancestorScroll: snapshot.ancestorScroll,
				});
				const baseline = vertical(before);
				await page.click("[data-nf-wco-below-controls] .dv-tabs-container > .dv-tab:nth-child(2)");
				await settle(page);
				expect(vertical(await state(page))).toEqual(baseline);
				for (let selection = 0; selection < 3; selection++) {
					await openOverflowMenu(page);
					expect((await state(page)).popupHit).toBe(true);
					await page.click(".dv-tabs-overflow-container .dv-tab");
					await settle(page);
					const after = await state(page);
					expect(vertical(after)).toEqual(baseline);
					expect(after.tool.tabs?.top).toBe(height + 1);
					expect(after.tool.activeTab?.left ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(
						(after.tool.tabViewport?.left ?? 0) - EDGE_TOLERANCE,
					);
					expect(after.tool.activeTab?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
						(after.tool.tabViewport?.right ?? 0) + EDGE_TOLERANCE,
					);
					expect(after.popup).toBeNull();
				}
			}
		}
	});
}, 20_000);

test("释放避让绑定后内容层立即跟随恢复后的标签栏", async () => {
	await withFixture(async (page) => {
		await page.evaluate(() => {
			const fixture = (window as unknown as FixtureWindow).fixture;
			fixture.configure({ top: -32 });
			fixture.activate("tool-0");
		});
		await settle(page);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.setAvoidance(false));
		await settle(page);
		const after = await state(page);
		expect(after.tool.marked).toBe(false);
		expect(after.tool.content?.top).toBe(after.tool.tabs?.bottom);
		expect(after.tool.content?.bottom).toBe(900);
	});
});

test("退出 WCO 后工具内容紧贴标签栏，不遗留旧标题栏高度", async () => {
	await withFixture(async (page) => {
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.activate("tool-0"));
		await settle(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.configure({ visible: false, mode: false }),
		);
		await settle(page);
		const after = await state(page);
		expect(after.tool.marked).toBe(false);
		expect(after.tool.content?.top).toBe(after.tool.tabs?.bottom);
		expect(after.tool.content?.bottom).toBe(900);
	});
});

test("溢出列表不遮挡通过 Portal 打开的 Mantine 右键菜单", async () => {
	await withFixture(async (page) => {
		await openOverflowMenu(page);
		await page.click(".dv-tabs-overflow-container .dv-tab", { button: "right" });
		await page.waitForSelector("[data-fixture-context-menu]", { visible: true });
		await settle(page);
		const hit = await page.evaluate(() => {
			const menu = document.querySelector("[data-fixture-context-menu]");
			const popup = document.querySelector(".dv-tabs-overflow-container");
			if (!menu || !popup) throw new Error("菜单和溢出列表必须同时存在");
			const m = menu.getBoundingClientRect();
			const p = popup.getBoundingClientRect();
			const left = Math.max(m.left, p.left);
			const right = Math.min(m.right, p.right);
			const top = Math.max(m.top, p.top);
			const bottom = Math.min(m.bottom, p.bottom);
			return {
				overlaps: right > left && bottom > top,
				menuOnTop: menu.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)),
			};
		});
		expect(hit.overlaps).toBe(true);
		expect(hit.menuOnTop).toBe(true);
		await page.click("[data-fixture-context-menu] [role=menuitem]");
		expect(await page.evaluate(() => document.documentElement.dataset.fixtureMenuClicked)).toBe(
			"true",
		);
	});
});

test("Dockview 层级隔离不改变面板内 fixed 元素的视口坐标", async () => {
	await withFixture(async (page) => {
		const position = await page.evaluate(() => {
			const panel = document.querySelector('[data-fixture-panel="primary"]');
			if (!panel) throw new Error("缺少主会话面板");
			const marker = document.createElement("div");
			marker.style.cssText = "position:fixed;left:123px;top:77px;width:10px;height:10px";
			panel.appendChild(marker);
			const { left, top } = marker.getBoundingClientRect();
			marker.remove();
			return { left, top };
		});
		expect(position).toEqual({ left: 123, top: 77 });
	});
});
