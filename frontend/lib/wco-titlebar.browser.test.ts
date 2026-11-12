import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

async function chromePath() {
	const configured = process.env.NF_TEST_CHROMIUM_PATH;
	if (configured) return configured;
	const installed =
		Bun.which("chromium") ?? Bun.which("google-chrome") ?? Bun.which("chromium-browser");
	if (installed) return installed;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache)) {
		for await (const path of new Bun.Glob("chrome/*/**/chrome").scan({
			cwd: cache,
			absolute: true,
		}))
			return path;
	}
	return undefined;
}
const executablePath = await chromePath();

test.skipIf(!executablePath)(
	"WCO page strip stays at the viewport top inside the padded shell while scrolling",
	async () => {
		const css = await Bun.file(new URL("../styles/wco.css", import.meta.url)).text();
		const safeAreaCss = await Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text();
		const browser = await puppeteer.launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox"],
			timeout: 15_000,
		});
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 1400, height: 900 });
			await page.setContent(`
				<style>${safeAreaCss}\n${css}</style>
				<style>
					:root { --mantine-spacing-md: 16px; --mantine-color-body: white; }
					body { margin: 0; }
					.nf-app-shell-main { padding: var(--mantine-spacing-md);
						padding-left: calc(240px + var(--mantine-spacing-md)); }
					#content { height: 2400px; }
				</style>
				<div id="root"><div class="nf-app-shell"><main class="nf-app-shell-main">
					<div class="nf-wco-top-gap" aria-hidden="true"></div>
					<div class="nf-wco-main-strip" aria-hidden="true"></div>
					<div id="content">Page content</div>
				</main></div></div>
			`);
			await page.evaluate(() => {
				document.documentElement.setAttribute("data-nf-authenticated-app-shell", "true");
			});
			for (const side of ["right", "left"]) {
				for (const padding of [12, 16, 24]) {
					for (const height of [32, 40]) {
						await page.evaluate(
							({ side, padding, height }) => {
								const root = document.documentElement;
								root.setAttribute("data-nf-wco", side);
								root.style.setProperty("--mantine-spacing-md", `${padding}px`);
								root.style.setProperty("--nf-wco-strip-height", `${height}px`);
							},
							{ side, padding, height },
						);
						for (const scroll of [0, 8, 100, 500]) {
							const actual = await page.evaluate(async (scroll) => {
								const main = document.querySelector<HTMLElement>("main");
								const strip = document.querySelector<HTMLElement>(".nf-wco-main-strip");
								if (!main || !strip) throw new Error("Missing shell fixture");
								main.scrollTop = scroll;
								await new Promise(requestAnimationFrame);
								const rect = strip.getBoundingClientRect();
								return {
									top: rect.top,
									bottom: rect.bottom,
									left: rect.left,
									scroll: main.scrollTop,
									padding: getComputedStyle(main).paddingTop,
								};
							}, scroll);
							expect(actual).toEqual({
								top: 0,
								bottom: height,
								left: 240,
								scroll,
								padding: `${padding}px`,
							});
						}
					}
				}
			}
			const stripDisplay = () =>
				page.$eval(".nf-wco-main-strip", (el) => getComputedStyle(el).display);
			await page.evaluate(() => document.documentElement.removeAttribute("data-nf-wco"));
			expect(await stripDisplay()).toBe("none");
			await page.evaluate(() => {
				document.documentElement.setAttribute("data-nf-wco", "right");
				document.getElementById("content")?.setAttribute("data-nf-wco-titlebar", "");
			});
			expect(await stripDisplay()).toBe("none");
			await page.evaluate(() => {
				document.getElementById("content")?.removeAttribute("data-nf-wco-titlebar");
			});
			await page.setViewport({ width: 700, height: 900 });
			expect(await stripDisplay()).toBe("none");
		} finally {
			await browser.close();
		}
	},
	30_000,
);

test.skipIf(!executablePath)(
	"WCO top-row headers share the overlay height without changing lower rows or shell padding",
	async () => {
		const css = await Bun.file(new URL("../styles/wco.css", import.meta.url)).text();
		const dockCss = await Bun.file(
			import.meta.resolve("dockview-core/dist/styles/dockview.css").replace("file://", ""),
		).text();
		const browser = await puppeteer.launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox"],
			timeout: 15_000,
		});
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 1400, height: 900 });
			// Match the actual header structures: chat has 8px inline padding, panel header
			// has Mantine xs padding, Dockview uses its own stylesheet and height variable.
			await page.setContent(`
				<style>${dockCss}\n${css}</style>
				<style>
					:root { --mantine-spacing-md: 16px; --mantine-color-default-border: #ced4da; }
					body { margin: 0; }
					.rows { display: flex; align-items: flex-start; }
					.rows > div { width: 33.333%; }
					.header { display: flex; align-items: center; box-sizing: border-box;
						border-bottom: 1px solid #ced4da; flex-shrink: 0; }
					button { height: 22px; padding: 0; }
					.dock { --dv-tabs-and-actions-container-height: 39px; }
				</style>
				<div class="nf-app-shell">
					<nav class="mantine-AppShell-navbar" style="position:fixed;padding-top:16px"></nav>
					<div class="rows">
						<div><div id="chat" class="header" data-narrator-header-layout data-nf-titlebar-row
							style="padding:8px 12px"><button>Tools</button></div></div>
						<div class="dock"><div id="tabs" class="dv-tabs-and-actions-container" data-nf-titlebar-row data-nf-titlebar-end>
							<div class="dv-scrollable"><div class="dv-tabs-container"><div class="dv-tab">Session</div></div></div>
							<div class="dv-void-container"></div></div></div>
						<div><div id="details" class="header nf-panel-header" data-nf-titlebar-row
							style="padding:10px 16px"><button>Details</button></div></div>
					</div>
					<div id="lower" class="header nf-panel-header" style="padding:10px 16px"><button>Lower</button></div>
					<div id="workspace-toolbar" class="header" data-nf-titlebar-row data-nf-titlebar-candidate>
						<button id="workspace-title"><span>Workspace title</span></button>
						<input id="workspace-title-input" aria-label="Title" />
						<button id="workspace-title-save">Save</button>
						<div style="flex:1"></div>
					</div>
				</div>
			`);
			const measure = () =>
				page.evaluate(() => {
					const rect = (id: string) => {
						const el = document.getElementById(id);
						if (!el) throw new Error(`Missing ${id}`);
						const r = el.getBoundingClientRect();
						return { top: r.top, height: r.height, bottom: r.bottom };
					};
					return {
						rows: [rect("chat"), rect("tabs"), rect("details")],
						lower: rect("lower").height,
						navPadding: getComputedStyle(document.querySelector("nav") as HTMLElement).paddingTop,
					};
				});
			const normal = await measure();
			for (const height of [32, 40, 48, 36]) {
				await page.evaluate((value) => {
					document.documentElement.setAttribute("data-nf-wco", "right");
					// Substitute OS geometry only; all padding, border and tab sizes are real CSS.
					document.documentElement.style.setProperty("--nf-wco-strip-height", `${value}px`);
				}, height);
				const actual = await measure();
				expect(
					await page.evaluate(() =>
						[
							"workspace-toolbar",
							"workspace-title",
							"workspace-title-input",
							"workspace-title-save",
						].map((id) => {
							const el = document.getElementById(id);
							if (!el) throw new Error(`Missing ${id}`);
							return getComputedStyle(el).getPropertyValue("-webkit-app-region");
						}),
					),
				).toEqual(["drag", "no-drag", "no-drag", "no-drag"]);
				// The shared extra pixel is the separator below the native control area;
				// putting it inside `height` lets native button backgrounds cover it.
				expect(actual.rows).toEqual(
					Array.from({ length: 3 }, () => ({ top: 0, height: height + 1, bottom: height + 1 })),
				);
				expect(actual.lower).toBe(normal.lower);
				expect(actual.navPadding).toBe("16px");
			}
			// The OS-button reservation must have a divider of its own: the trailing void's
			// shadow stops before this padding. Do not put a shadow on the whole strip, which
			// would close the intentional gap under the active tab.
			for (const inset of [96, 180, 240]) {
				const line = await page.evaluate((value) => {
					document.documentElement.style.setProperty("--nf-wco-inset-right", `${value}px`);
					const tabs = document.getElementById("tabs");
					if (!tabs) throw new Error("Missing tabs");
					const style = getComputedStyle(tabs, "::after");
					return {
						width: style.width,
						height: style.height,
						right: style.right,
						bottom: style.bottom,
						color: style.backgroundColor,
						pointer: style.pointerEvents,
						stripShadow: getComputedStyle(tabs).boxShadow,
					};
				}, inset);
				expect(line).toEqual({
					width: `${inset + 8}px`,
					height: "1px",
					right: "0px",
					bottom: "0px",
					color: "rgb(206, 212, 218)",
					pointer: "none",
					stripShadow: "none",
				});
			}
			await page.evaluate(() => {
				document.documentElement.removeAttribute("data-nf-wco");
			});
			expect(await measure()).toEqual(normal);
		} finally {
			await browser.close();
		}
	},
	30_000,
);

test("real narrator header survives mobile breakpoint round trips, both native-control sides and WCO exit", async () => {
	if (!executablePath) throw new Error("Chromium is required; set NF_TEST_CHROMIUM_PATH");
	let buildTimer: ReturnType<typeof setTimeout> | undefined;
	const build = await Promise.race([
		Bun.build({
			entrypoints: [join(import.meta.dir, "wco-mobile-titlebar.browser-fixture.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		}),
		new Promise<never>((_, reject) => {
			buildTimer = setTimeout(() => reject(new Error("WCO fixture build exceeded 15s")), 15_000);
		}),
	]).finally(() => clearTimeout(buildTimer));
	if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8_000));
	if (build.outputs.reduce((bytes, output) => bytes + output.size, 0) > 16 * 1024 * 1024)
		throw new Error("WCO fixture exceeds 16MiB");
	const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${build.outputs
		.filter((output) => output.path.endsWith(".css"))
		.map((output) => `<link rel="stylesheet" href="/${basename(output.path)}">`)
		.join("")}</head><body><div id="root"></div>${build.outputs
		.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
		.map((output) => `<script type="module" src="/${basename(output.path)}"></script>`)
		.join("")}</body></html>`;
	// Independent loopback server and fresh browser profile; no running app or user data.
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024,
		idleTimeout: 5,
		fetch(request) {
			if (request.method !== "GET") return new Response(null, { status: 405 });
			const path = new URL(request.url).pathname;
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			const asset = assets.get(path);
			return new Response(asset ?? null, { status: asset ? 200 : 404 });
		},
	});
	let browser: Browser | undefined;
	try {
		browser = await puppeteer.launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
			timeout: 15_000,
			protocolTimeout: 10_000,
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.setViewport({ width: 1000, height: 600 });
		await page.goto(server.url.href, { timeout: 15_000 });
		await page.waitForSelector("[data-narrator-header-layout]", { visible: true });
		const settle = () =>
			page.evaluate(async () => {
				for (let index = 0; index < 6; index++) await new Promise(requestAnimationFrame);
			});
		for (const width of [1000, 767, 480, 768, 1000, 360, 1000]) {
			await page.setViewport({ width, height: 600 });
			for (const side of ["right", "left", "off"] as const) {
				await page.evaluate((side) => {
					const html = document.documentElement;
					if (side === "off") html.removeAttribute("data-nf-wco");
					else html.setAttribute("data-nf-wco", side);
					// Only OS-reported WCO geometry is substituted. All rects are browser layout.
					html.style.setProperty("--nf-wco-strip-height", "40px");
					html.style.setProperty("--nf-wco-inset-right", side === "right" ? "144px" : "0px");
					html.style.setProperty("--nf-wco-inset-left", side === "left" ? "128px" : "0px");
				}, side);
				await settle();
				const state = await page.evaluate(() => {
					const row = document.querySelector<HTMLElement>("[data-narrator-header-layout]");
					const title = document.getElementById("title");
					const toolbar = document.getElementById("toolbar");
					if (!row || !title || !toolbar) throw new Error("Missing real header");
					const style = getComputedStyle(row);
					const rect = row.getBoundingClientRect();
					const region = (element: Element) =>
						getComputedStyle(element).getPropertyValue("-webkit-app-region");
					// app-region is not inherited: a parent's geometric drag region still covers
					// ordinary descendants, while an explicit no-drag descendant cuts it out.
					const effectiveRegion = (element: Element): string => {
						for (let current: Element | null = element; current; current = current.parentElement) {
							const value = region(current);
							if (value && value !== "none") return value;
						}
						return "none";
					};
					const controls = Array.from(row.querySelectorAll("button"));
					return {
						top: rect.top,
						left: rect.left,
						right: rect.right,
						width: rect.width,
						height: rect.height,
						padLeft: Number.parseFloat(style.paddingLeft),
						padRight: Number.parseFloat(style.paddingRight),
						row: region(row),
						title: effectiveRegion(title),
						selection: getComputedStyle(title).userSelect,
						marks: ["row", "start", "end"].map((mark) =>
							row.hasAttribute(`data-nf-titlebar-${mark}`),
						),
						blank: region(
							document.elementFromPoint(
								rect.left + Number.parseFloat(style.paddingLeft) + 1,
								rect.top + 1,
							) ?? row,
						),
						controlRegions: controls.map(region),
						contentBounds: [...controls, title].map((element) => {
							const bounds = element.getBoundingClientRect();
							return { left: bounds.left, right: bounds.right };
						}),
						visibleTools: Number(toolbar.dataset.visibleTools),
						unmeasured: toolbar.dataset.unmeasured,
						titleWidth: title.getBoundingClientRect().width,
					};
				});
				expect(state.top).toBe(0);
				expect(state.left).toBe(width < 768 ? 0 : 80);
				expect(state.right).toBe(width);
				expect(state.unmeasured).toBe("false");
				if (side === "off") {
					expect(state.marks).toEqual([false, false, false]);
					expect(state.row).not.toBe("drag");
					expect(state.title).not.toBe("drag");
					expect(state.selection).not.toBe("none");
					expect(state.padLeft).toBe(16);
					expect(state.padRight).toBe(16);
					expect(state.height).not.toBe(41);
				} else {
					expect(state.marks).toEqual([true, true, true]);
					expect(state.height).toBe(41);
					expect(state.row).toBe("drag");
					expect(state.title).toBe("drag");
					expect(state.blank).toBe("drag");
					expect(state.selection).toBe("none");
					expect(state.controlRegions.every((region) => region === "no-drag")).toBe(true);
					if (side === "left") expect(state.padLeft).toBe(width < 768 ? 136 : 56);
					if (side === "right") expect(state.padRight).toBe(152);
				}
				// Capacity must use the CSS content box, not the reserved native-button padding.
				const usableWidth = state.width - state.padLeft - state.padRight;
				const chrome = (width < 768 ? 36 : 0) + 44 + 8 + 22;
				const titleBudget = Math.max(80, Math.min(220, usableWidth - chrome));
				expect(state.titleWidth).toBeCloseTo(titleBudget, 3);
				expect(state.visibleTools).toBe(
					Math.max(0, Math.min(8, Math.floor((usableWidth - chrome - titleBudget) / 32))),
				);
				for (const bounds of state.contentBounds) {
					expect(bounds.left).toBeGreaterThanOrEqual(state.left + state.padLeft - 1);
					expect(bounds.right).toBeLessThanOrEqual(state.right - state.padRight + 1);
					if (side === "left") expect(bounds.left).toBeGreaterThanOrEqual(128);
					if (side === "right") expect(bounds.right).toBeLessThanOrEqual(width - 144);
				}
				await page.evaluate(() => window.getSelection()?.removeAllRanges());
				await page.click("#title", { clickCount: 2 });
				const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
				if (side === "off") expect(selected.length).toBeGreaterThan(0);
				else expect(selected).toBe("");
				const clicks = Number(await page.$eval("#clicks", (el) => el.textContent));
				await page.click("#overflow");
				await page.click("#generate");
				if (width < 768) await page.click("#menu");
				expect(Number(await page.$eval("#clicks", (el) => el.textContent))).toBe(
					clicks + (width < 768 ? 3 : 2),
				);
				await page.click("#edit");
				await page.focus("#title-input");
				await page.keyboard.down("Control");
				await page.keyboard.press("a");
				await page.keyboard.up("Control");
				await page.keyboard.type("Edited title");
				await page.keyboard.down("Shift");
				await page.keyboard.press("Home");
				await page.keyboard.up("Shift");
				const input = await page.$eval("#title-input", (element) => {
					const input = element as HTMLInputElement;
					const style = getComputedStyle(input);
					return {
						value: input.value,
						start: input.selectionStart,
						end: input.selectionEnd,
						region: style.getPropertyValue("-webkit-app-region"),
						selection: style.userSelect,
						left: input.getBoundingClientRect().left,
						right: input.getBoundingClientRect().right,
					};
				});
				expect(input.left).toBeGreaterThanOrEqual(state.left + state.padLeft - 1);
				expect(input.right).toBeLessThanOrEqual(state.right - state.padRight + 1);
				expect(input.value).toBe("Edited title");
				expect([input.start, input.end]).toEqual([0, 12]);
				expect(input.selection).not.toBe("none");
				if (side !== "off") expect(input.region).toBe("no-drag");
				await page.click("#edit");
			}
		}
		expect(errors).toEqual([]);
		// Headless verifies CSS regions and DOM interaction, not OS-window movement.
	} finally {
		try {
			await browser?.close();
		} finally {
			await server.stop(true);
		}
	}
}, 90_000);
