import { expect, test } from "bun:test";
import puppeteer from "puppeteer-core";

// Opt in to the real-layout regression with a locally installed Chromium.
// The always-on safe-area unit test also guards the intermediate measurement state.
const executablePath = process.env.NF_TEST_CHROMIUM_PATH;

test.skipIf(!executablePath)(
	"keyboard viewport tracking never clamps a pinned or detached list during repeated updates",
	async () => {
		const bundle = await Bun.build({
			entrypoints: [new URL("../../frontend/lib/safe-area.ts", import.meta.url).pathname],
			target: "browser",
			format: "esm",
		});
		expect(bundle.success).toBe(true);
		const source = await bundle.outputs[0].text();
		const browser = await puppeteer.launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox"],
			timeout: 15_000,
		});
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
			await page.setContent(`
				<meta name="viewport" content="width=device-width,initial-scale=1">
				<style>
					html { height: var(--app-viewport-bottom, 100dvh); overflow: hidden; }
					body { height: 100%; margin: 0; overflow: hidden; }
					#shell { height: 100%; display: flex; flex-direction: column; }
					#list { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; }
					#content { height: 5000px; }
					textarea { height: 100px; box-sizing: border-box; flex-shrink: 0; }
				</style>
				<div id="shell"><div id="list"><div id="content"></div></div><textarea></textarea></div>
			`);
			const result = await page.evaluate(async (moduleSource) => {
				const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
				const api = (await import(url)) as typeof import("../../frontend/lib/safe-area");
				URL.revokeObjectURL(url);
				// Only the OS keyboard signal is substituted. CSS viewport units, flex
				// layout, forced probe reads and scrollTop clamping use Chromium itself.
				const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
				Object.defineProperty(window, "visualViewport", { value: viewport });
				const list = document.querySelector<HTMLElement>("#list");
				const composer = document.querySelector<HTMLTextAreaElement>("textarea");
				if (!list || !composer) throw new Error("Missing fixture elements");
				const settle = () =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
				const snapshot = () => ({
					height: list.clientHeight,
					top: list.scrollTop,
					bottom: list.scrollHeight - list.clientHeight,
				});
				const cleanup = api.installAppViewportTracking();
				try {
					composer.focus({ preventScroll: true });
					viewport.height = 500;
					viewport.dispatchEvent(new Event("resize"));
					await settle();
					list.scrollTop = list.scrollHeight - list.clientHeight;
					const pinnedBefore = snapshot();
					const measuredWhileKeyboardOpen = [
						api.measureCssViewportHeight(document, "100dvh"),
						api.measureCssViewportHeight(document, "100lvh"),
					];
					for (const event of ["resize", "scroll", "resize"]) {
						viewport.dispatchEvent(new Event(event));
						await settle();
					}
					const pinnedAfter = snapshot();
					list.scrollTop -= 3;
					const detachedBefore = snapshot();
					viewport.dispatchEvent(new Event("resize"));
					await settle();
					const detachedAfter = snapshot();
					composer.blur();
					viewport.height = 844;
					viewport.dispatchEvent(new Event("resize"));
					await settle();
					return {
						pinnedBefore,
						pinnedAfter,
						detachedBefore,
						detachedAfter,
						measuredWhileKeyboardOpen,
						closedHeight: list.clientHeight,
						closedOverride:
							document.documentElement.style.getPropertyValue("--app-viewport-bottom"),
					};
				} finally {
					cleanup();
				}
			}, source);
			expect(result.measuredWhileKeyboardOpen).toEqual([844, 844]);
			expect(result.pinnedBefore).toEqual({ height: 400, top: 4600, bottom: 4600 });
			expect(result.pinnedAfter).toEqual(result.pinnedBefore);
			expect(result.detachedBefore.top).toBe(4597);
			expect(result.detachedAfter).toEqual(result.detachedBefore);
			expect(result.closedHeight).toBe(744);
			expect(result.closedOverride).toBe("");
		} finally {
			await browser.close();
		}
	},
	30_000,
);
