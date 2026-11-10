import { expect, test } from "bun:test";
import puppeteer from "puppeteer-core";

const executablePath = process.env.NF_TEST_CHROMIUM_PATH;

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
