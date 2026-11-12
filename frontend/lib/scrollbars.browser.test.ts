import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, launch, type Page } from "puppeteer-core";

async function chromiumPath() {
	const configured = process.env.NF_TEST_CHROMIUM_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
	if (configured) return configured;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache)) {
		for await (const path of new Bun.Glob("chrome/*/**/chrome").scan({
			cwd: cache,
			absolute: true,
		})) {
			return path;
		}
	}
	return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(
		existsSync,
	);
}

let browser: Browser;
let page: Page;
const [scrollbars, collapsedNav] = await Promise.all([
	Bun.file(new URL("../styles/scrollbars.css", import.meta.url)).text(),
	Bun.file(new URL("../styles/nav-collapsed.css", import.meta.url)).text(),
]);

beforeAll(async () => {
	const executablePath = await chromiumPath();
	if (!executablePath) throw new Error("Chromium unavailable; set NF_TEST_CHROMIUM_PATH");
	// Fresh headless browser, never the running application or its user profile.
	browser = await launch({
		executablePath,
		headless: true,
		ignoreDefaultArgs: ["--hide-scrollbars"],
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		timeout: 15_000,
	});
}, 30_000);

afterAll(async () => {
	await browser?.close();
});

beforeEach(async () => {
	await page?.close();
	page = await browser.newPage();
	page.setDefaultTimeout(5_000);
	await page.setContent(`<!doctype html><html data-mantine-color-scheme="dark"><head>
		<style>
			:root { --mantine-spacing-md: 16px; }
			body { margin: 40px; }
			.scroller { width: 200px; height: 100px; overflow: auto; margin-bottom: 20px; }
			.content { width: 400px; height: 800px; }
			#sidebar {
				box-sizing: border-box; width: 300px; height: 240px; padding: 16px;
				border-inline-end: 1px solid transparent; display: flex; flex-direction: column;
			}
			#nav { flex: 1; min-height: 0; width: auto; height: auto; margin-bottom: 0; }
			#nav .content { width: auto; }
			.nav-fixed { height: 32px; flex-shrink: 0; }
			.hidden { scrollbar-width: none; }
			.hidden::-webkit-scrollbar { display: none; }
		</style>
		<style id="scrollbar-theme">${scrollbars}</style>
		<style>${collapsedNav}</style>
		</head><body>
		<div id="native" class="scroller" tabindex="0"><div class="content">Native</div></div>
		<div id="sidebar" data-nav-hover-panel="open">
			<div id="nav-top" class="nav-fixed">Sidebar header</div>
			<div id="nav" class="scroller nf-nav-tabs"><div class="content">Recent tabs</div></div>
			<div id="nav-bottom" class="nav-fixed">Sidebar footer</div>
		</div>
		<div id="hidden" class="scroller hidden"><div class="content">Custom viewport</div></div>
		<div id="inline-hidden" class="scroller" style="scrollbar-width: none">
			<div class="content">Hidden tab strip</div>
		</div>
		</body></html>`);
});

async function nativeStyle(selector = "#native") {
	return page.$eval(selector, (element) => {
		const node = element as HTMLElement;
		const style = getComputedStyle(node);
		const bar = getComputedStyle(node, "::-webkit-scrollbar");
		const thumb = getComputedStyle(node, "::-webkit-scrollbar-thumb");
		return {
			width: bar.width,
			height: bar.height,
			display: bar.display,
			standardWidth: style.scrollbarWidth,
			standardColor: style.scrollbarColor,
			thumb: thumb.backgroundColor,
			radius: thumb.borderRadius,
			track: getComputedStyle(node, "::-webkit-scrollbar-track").backgroundColor,
			corner: getComputedStyle(node, "::-webkit-scrollbar-corner").backgroundColor,
			buttons: getComputedStyle(node, "::-webkit-scrollbar-button").display,
			verticalGutter: node.offsetWidth - node.clientWidth,
			horizontalGutter: node.offsetHeight - node.clientHeight,
		};
	});
}

test("desktop native scrollbars are 6px, rounded, transparent and arrowless on both axes", async () => {
	expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
	const style = await nativeStyle();
	expect(style.width).toBe("6px");
	expect(style.height).toBe("6px");
	// Non-auto standard values would silently disable the WebKit styling.
	expect(style.standardWidth).toBe("auto");
	expect(style.standardColor).toBe("auto");
	expect(style.radius).toBe("999px");
	expect(style.track).toBe("rgba(0, 0, 0, 0)");
	expect(style.corner).toBe("rgba(0, 0, 0, 0)");
	expect(style.buttons).toBe("none");
	// Check real layout, not only accepted CSS declarations.
	expect(style.verticalGutter).toBe(6);
	expect(style.horizontalGutter).toBe(6);
});

test("native scrollbar colors follow light/dark themes and theme token overrides", async () => {
	expect((await nativeStyle()).thumb).toBe("rgb(144, 146, 150)");
	await page.evaluate(() => {
		document.documentElement.dataset.mantineColorScheme = "light";
	});
	expect((await nativeStyle()).thumb).toBe("rgb(134, 142, 150)");
	await page.evaluate(() => {
		document.documentElement.style.setProperty("--mantine-color-gray-6", "#123456");
	});
	expect((await nativeStyle()).thumb).toBe("rgb(18, 52, 86)");
});

test("hovering the native thumb highlights it without changing the gutter", async () => {
	const scroller = await page.$("#native");
	const box = await scroller?.boundingBox();
	if (!box) throw new Error("Native scroller has no layout box");
	await page.mouse.move(box.x + box.width - 3, box.y + 8);
	const style = await nativeStyle();
	expect(style.thumb).toBe("rgb(193, 194, 197)");
	expect(style.verticalGutter).toBe(6);
});

test("collapsed navigation and component-level hidden scrollbars still win", async () => {
	expect((await nativeStyle("#nav")).verticalGutter).toBe(6);
	await page.evaluate(() => {
		document
			.querySelector("[data-nav-hover-panel]")
			?.setAttribute("data-nav-hover-panel", "closed");
	});
	for (const selector of ["#nav", "#hidden", "#inline-hidden"]) {
		const style = await nativeStyle(selector);
		expect(style.standardWidth).toBe("none");
		expect(style.verticalGutter).toBe(0);
		expect(style.horizontalGutter).toBe(0);
	}
	expect((await nativeStyle("#nav")).display).toBe("none");
	await page.evaluate(() => {
		document.querySelector("[data-nav-hover-panel]")?.setAttribute("data-nav-hover-panel", "open");
	});
	expect((await nativeStyle("#nav")).verticalGutter).toBe(6);
});

test("recent tabs keep their alignment while the scrollbar sits in the navbar gutter", async () => {
	for (const direction of ["ltr", "rtl"]) {
		for (const width of [180, 300, 480]) {
			await page.$eval(
				"#sidebar",
				(element, settings) => {
					element.setAttribute("dir", settings.direction);
					(element as HTMLElement).style.width = `${settings.width}px`;
				},
				{ direction, width },
			);
			const layout = await page.$eval("#sidebar", (element) => {
				const nav = element.querySelector<HTMLElement>("#nav");
				const row = nav?.querySelector<HTMLElement>(".content");
				const top = element.querySelector("#nav-top")?.getBoundingClientRect();
				const bottom = element.querySelector("#nav-bottom")?.getBoundingClientRect();
				if (!nav || !row || !top || !bottom) throw new Error("Missing sidebar fixture");
				const sidebar = element.getBoundingClientRect();
				const viewport = nav.getBoundingClientRect();
				const content = row.getBoundingClientRect();
				const rtl = element.getAttribute("dir") === "rtl";
				const gutter = nav.offsetWidth - nav.clientWidth;
				return {
					inset: (rtl ? viewport.left - sidebar.left : sidebar.right - viewport.right) - 1,
					leading: rtl ? sidebar.right - content.right : content.left - sidebar.left,
					gap: (rtl ? content.left - viewport.left : viewport.right - content.right) - gutter,
					rowWidth: content.width,
					referenceWidth: top.width,
					topGap: viewport.top - top.bottom,
					bottomGap: bottom.top - viewport.bottom,
					horizontalOverflow: nav.scrollWidth - nav.clientWidth,
				};
			});
			expect(layout.inset).toBe(4);
			expect(layout.leading).toBe(16);
			expect(layout.gap).toBe(12);
			// Exactly the original row width: only the scrollbar moves outward.
			expect(layout.rowWidth).toBe(layout.referenceWidth - 6);
			expect(layout.topGap).toBe(0);
			expect(layout.bottomGap).toBe(0);
			expect(layout.horizontalOverflow).toBe(0);
		}
	}
	const before = await page.$eval(
		"#nav .content",
		(element) => element.getBoundingClientRect().width,
	);
	await page.$eval("#nav .content", (element) => {
		(element as HTMLElement).style.height = "20px";
	});
	const after = await page.$eval(
		"#nav .content",
		(element) => element.getBoundingClientRect().width,
	);
	expect(after).toBe(before);
});

test("native wheel and keyboard scrolling remain functional", async () => {
	await page.hover("#native");
	await page.mouse.wheel({ deltaY: 120 });
	await page.waitForFunction(() => (document.getElementById("native")?.scrollTop ?? 0) > 0);
	await page.focus("#native");
	await page.keyboard.press("End");
	await page.waitForFunction(() => {
		const node = document.getElementById("native");
		return node != null && node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
	});
});

test("touch uses standard thin scrollbars and a themed hover color", async () => {
	// Exercise the real standards-only branch, not an emulated Firefox user agent.
	const cdp = await page.createCDPSession();
	try {
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		let style = await nativeStyle();
		expect(style.standardWidth).toBe("thin");
		expect(style.standardColor).toBe("rgb(144, 146, 150) rgba(0, 0, 0, 0)");
		await page.hover("#native");
		style = await nativeStyle();
		expect(style.standardColor).toBe("rgb(193, 194, 197) rgba(0, 0, 0, 0)");
	} finally {
		await cdp.detach();
	}
});

test("forced colors restores the system scrollbar instead of the custom theme", async () => {
	const cdp = await page.createCDPSession();
	try {
		await cdp.send("Emulation.setEmulatedMedia", {
			features: [{ name: "forced-colors", value: "active" }],
		});
		expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
		const forced = await nativeStyle();
		expect(forced.standardWidth).toBe("auto");
		expect(forced.standardColor).toBe("auto");
		await page.$eval("#scrollbar-theme", (element) => element.remove());
		// Same as having no global scrollbar styling, including system dimensions.
		expect(await nativeStyle()).toEqual(forced);
	} finally {
		await cdp.detach();
	}
});
