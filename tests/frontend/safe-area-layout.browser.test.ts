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

// Chromium supplies real CSS layout and root scrolling here, not iOS status-bar taps.
// UA/touch capability and keyboard viewport signals are explicit fixture substitutes.
test.skipIf(!executablePath)(
	"iOS root scroll signals preserve shell geometry and dispatch only to the active target",
	async () => {
		const safeAreaPath = new URL("../../frontend/lib/safe-area.ts", import.meta.url).pathname;
		const scrollBridgePath = new URL("../../frontend/lib/ios-scroll-to-top.ts", import.meta.url)
			.pathname;
		const bundle = await Bun.build({
			entrypoints: ["nf-safe-area-root-signal-fixture"],
			target: "browser",
			format: "esm",
			plugins: [
				{
					name: "safe-area-root-signal-fixture",
					setup(build) {
						build.onResolve({ filter: /^nf-safe-area-root-signal-fixture$/ }, () => ({
							path: "entry",
							namespace: "safe-area-root-signal-fixture",
						}));
						build.onLoad({ filter: /.*/, namespace: "safe-area-root-signal-fixture" }, () => ({
							// One module graph keeps the installer and target registry identical.
							contents: `export * from ${JSON.stringify(safeAreaPath)};
									export * from ${JSON.stringify(scrollBridgePath)};`,
							loader: "ts",
						}));
					},
				},
			],
		});
		expect(bundle.success).toBe(true);
		const source = await bundle.outputs[0].text();
		const safeAreaCss = await Bun.file(
			new URL("../../frontend/styles/safe-area.css", import.meta.url),
		).text();
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
				<!doctype html>
				<meta name="viewport" content="width=device-width,initial-scale=1">
				<style>
					/* Fixture component sizing only; root sizing/bridge CSS comes from production. */
					* { box-sizing: border-box; }
					body { margin: 0; }
					.nf-app-shell { position: relative; }
					#header { position: fixed; inset: 0 0 auto; height: 60px; z-index: 1; }
					.nf-app-shell-main { padding-top: 60px; padding-bottom: 16px; }
					#route { height: 100%; display: flex; flex-direction: column; }
					#semantic, #mantine { flex: 1; min-height: 0; overflow: auto; }
					.long-content { height: 5000px; }
					#composer { height: 80px; flex-shrink: 0; resize: none; }
					#bottom { position: absolute; inset: auto 0 0; height: 16px; }
					#hidden-list {
						position: absolute; top: 100px; width: 100px; height: 100px;
						overflow: auto; visibility: hidden;
					}
					#cover { position: fixed; inset: 0; background: white; z-index: 10; }
					[hidden] { display: none !important; }
				</style>
				<div id="root"><div class="nf-app-shell">
					<header id="header"></header>
					<main class="nf-app-shell-main" id="nf-app-main">
						<div id="main-content" class="long-content" hidden></div>
						<section id="route">
							<div id="semantic"><div class="long-content"></div></div>
							<div id="mantine" class="mantine-ScrollArea-viewport" hidden>
								<div class="long-content"></div>
							</div>
							<textarea id="composer" aria-label="Fixture composer"></textarea>
						</section>
					</main>
					<div id="bottom"></div>
					<div id="hidden-list"><div class="long-content"></div></div>
				</div></div>
				<div id="cover" role="dialog" aria-modal="true" hidden>Blocking dialog</div>
			`);
			await page.addStyleTag({ content: safeAreaCss });
			const fixture = await page.evaluateHandle(async (moduleSource) => {
				const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
				const api = (await import(url)) as typeof import("../../frontend/lib/safe-area") &
					typeof import("../../frontend/lib/ios-scroll-to-top");
				URL.revokeObjectURL(url);
				Object.defineProperties(navigator, {
					userAgent: {
						value:
							"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
							"AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
					},
					platform: { value: "iPhone" },
					maxTouchPoints: { value: 1 },
				});
				const viewport = Object.assign(new EventTarget(), {
					height: 844,
					width: 390,
					offsetTop: 0,
					offsetLeft: 0,
					pageTop: 0,
					pageLeft: 0,
					scale: 1,
				});
				Object.defineProperty(window, "visualViewport", { value: viewport });
				const element = (id: string) => {
					const value = document.getElementById(id);
					if (!value) throw new Error(`Missing fixture element: ${id}`);
					return value;
				};
				const root = document.documentElement;
				const main = element("nf-app-main");
				const route = element("route");
				const mainContent = element("main-content");
				const semantic = element("semantic");
				const mantine = element("mantine");
				const hidden = element("hidden-list");
				const composer = element("composer");
				const cover = element("cover");
				const calls = { semantic: 0, hidden: 0 };
				const unregisterSemantic = api.registerIOSScrollToTopTarget(semantic, () => {
					calls.semantic += 1;
					semantic.scrollTop = 0;
				});
				const unregisterHidden = api.registerIOSScrollToTopTarget(hidden, () => {
					calls.hidden += 1;
					hidden.scrollTop = 0;
				});
				const frames = async (count = 4) => {
					for (let frame = 0; frame < count; frame += 1) {
						await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					}
				};
				const settleTransition = async () => {
					await new Promise<void>((resolve) => setTimeout(resolve, 550));
					await frames();
				};
				const armed = async () => {
					const deadline = performance.now() + 2_000;
					while (Math.abs(window.scrollY - 1) > 0.1) {
						if (performance.now() >= deadline) {
							throw new Error(`Root bridge did not arm: scrollY=${window.scrollY}`);
						}
						await frames(1);
					}
					await frames();
				};
				const rect = (target: HTMLElement) => {
					const { top, bottom, height, left, width } = target.getBoundingClientRect();
					return { top, bottom, height, left, width };
				};
				const snapshot = () => ({
					root: {
						top: window.scrollY,
						documentTop: document.scrollingElement?.scrollTop,
						maximum: root.scrollHeight - root.clientHeight,
						cssHeight: Number.parseFloat(getComputedStyle(root).height),
						boxHeight: root.getBoundingClientRect().height,
						layoutViewportHeight: document.scrollingElement?.clientHeight,
						overflowY: getComputedStyle(root).overflowY,
						enabled: root.getAttribute(api.IOS_SCROLL_TO_TOP_ATTRIBUTE),
						authenticated: root.getAttribute(api.AUTHENTICATED_APP_SHELL_ATTRIBUTE),
					},
					geometry: {
						header: rect(element("header")),
						main: rect(main),
						composer: rect(composer),
						bottom: rect(element("bottom")),
					},
					tops: {
						main: main.scrollTop,
						mantine: mantine.scrollTop,
						semantic: semantic.scrollTop,
						hidden: hidden.scrollTop,
					},
					calls: { ...calls },
					keyboardOpen: root.hasAttribute("data-virtual-keyboard-open"),
					keyboardHeight: root.style.getPropertyValue("--app-viewport-bottom"),
				});
				// Establish the original authenticated layout before installing the bridge.
				root.setAttribute(api.AUTHENTICATED_APP_SHELL_ATTRIBUTE, "true");
				semantic.scrollTop = 900;
				hidden.scrollTop = 700;
				const stopTracking = api.installAppViewportTracking(window, document);
				let tracking = true;
				const stopViewportTracking = () => {
					if (!tracking) return;
					tracking = false;
					stopTracking();
				};
				await frames();
				const baseline = snapshot();
				let unmountFirst: (() => void) | undefined =
					api.installAuthenticatedAppShellRootLock(document);
				let unmountLast: (() => void) | undefined =
					api.installAuthenticatedAppShellRootLock(document);
				const remember = (target: HTMLElement) => {
					// Synthetic mouse interaction only records the target, not a native iOS gesture.
					const bounds = target.getBoundingClientRect();
					const pointer = {
						bubbles: true,
						pointerType: "mouse",
						clientX: bounds.left + bounds.width / 2,
						clientY: bounds.top + bounds.height / 2,
					};
					target.dispatchEvent(new PointerEvent("pointerdown", pointer));
					target.dispatchEvent(new PointerEvent("pointerup", pointer));
				};
				return {
					baseline,
					snapshot,
					async ready() {
						await armed();
						return snapshot();
					},
					async select(target: "main" | "mantine" | "semantic", fromComposer = false) {
						route.hidden = target === "main";
						mainContent.hidden = target !== "main";
						semantic.hidden = target !== "semantic";
						mantine.hidden = target !== "mantine";
						main.scrollTop = 0;
						await frames();
						const selected = { main, mantine, semantic }[target];
						selected.scrollTop = 900;
						remember(fromComposer ? composer : selected);
						await settleTransition();
						await armed();
						return snapshot();
					},
					async signal() {
						await armed();
						// This is an actual root scroll, with Chromium-generated scroll events.
						window.scrollTo(0, 0);
						const rootAtSignal = window.scrollY;
						await armed();
						return { rootAtSignal, ...snapshot() };
					},
					async cover(visible: boolean) {
						cover.hidden = !visible;
						await settleTransition();
					},
					async keyboard(open: boolean) {
						if (open) composer.focus({ preventScroll: true });
						else composer.blur();
						viewport.height = open ? 500 : window.innerHeight;
						for (const event of ["resize", "scroll", "resize"]) {
							viewport.dispatchEvent(new Event(event));
							window.scrollTo(0, 0);
							await frames(2);
						}
						await settleTransition();
						if (!open) await armed();
						return snapshot();
					},
					beginOrientationChange() {
						window.dispatchEvent(new Event("orientationchange"));
						window.scrollTo(0, 0);
					},
					async finishOrientationChange() {
						viewport.width = window.innerWidth;
						viewport.height = window.innerHeight;
						viewport.dispatchEvent(new Event("resize"));
						window.scrollTo(0, 0);
						await settleTransition();
						await armed();
						return snapshot();
					},
					async releaseOneMount() {
						unmountFirst?.();
						unmountFirst = undefined;
						await armed();
						return snapshot();
					},
					async releaseLastMount() {
						unmountLast?.();
						unmountLast = undefined;
						window.scrollTo(0, 0);
						window.dispatchEvent(new Event("scroll"));
						window.dispatchEvent(new Event("orientationchange"));
						await settleTransition();
						return snapshot();
					},
					stopViewportTracking,
					async oversizedRootContract() {
						viewport.width = window.innerWidth;
						viewport.height = window.innerHeight;
						// Chromium does not reproduce iOS's dvh/lvh split. Supply the recorded
						// 896px root-box contract through the existing production height override
						// with a real 848px layout viewport; CSS and range reads remain native.
						root.setAttribute(api.AUTHENTICATED_APP_SHELL_ATTRIBUTE, "true");
						root.style.setProperty("--app-viewport-bottom", "896px");
						semantic.scrollTop = 900;
						window.scrollTo(0, 0);
						await frames();
						const original = snapshot();
						let attributeChanges = 0;
						const observer = new MutationObserver((records) => {
							attributeChanges += records.length;
						});
						observer.observe(root, {
							attributes: true,
							attributeFilter: [api.IOS_SCROLL_TO_TOP_ATTRIBUTE],
						});
						try {
							unmountLast = api.installAuthenticatedAppShellRootLock(document);
							await settleTransition();
							const fallback = snapshot();
							const changesAtFallback = attributeChanges;
							for (const type of ["resize", "orientationchange", "pageshow"]) {
								window.dispatchEvent(new Event(type));
								window.scrollTo(0, 0);
								await frames(2);
							}
							await settleTransition();
							return {
								original,
								fallback,
								stable: snapshot(),
								attributeChangesAfterFallback: attributeChanges - changesAtFallback,
							};
						} finally {
							observer.disconnect();
						}
					},
					async restoreRootContract() {
						unmountLast?.();
						unmountLast = undefined;
						root.style.removeProperty("--app-viewport-bottom");
						root.setAttribute(api.AUTHENTICATED_APP_SHELL_ATTRIBUTE, "true");
						await frames();
						semantic.scrollTop = 900;
						const original = snapshot();
						unmountLast = api.installAuthenticatedAppShellRootLock(document);
						await armed();
						return { original, restored: snapshot() };
					},
					cleanup() {
						unmountFirst?.();
						unmountLast?.();
						unregisterSemantic();
						unregisterHidden();
						stopViewportTracking();
						root.style.removeProperty("--app-viewport-bottom");
					},
				};
			}, source);
			try {
				const baseline = await fixture.evaluate((value) => value.baseline);
				const armed = await fixture.evaluate((value) => value.ready());
				expect(baseline.root.top).toBe(0);
				expect(baseline.root.maximum).toBe(0);
				expect(baseline.geometry.header.bottom).toBe(60);
				expect(baseline.geometry.main.bottom).toBe(844);
				expect(baseline.geometry.composer.bottom).toBe(828);
				expect(baseline.geometry.bottom.bottom).toBe(844);
				expect(armed.root).toEqual({
					top: 1,
					documentTop: 1,
					maximum: 1,
					cssHeight: 844,
					boxHeight: 844,
					layoutViewportHeight: 844,
					overflowY: "auto",
					enabled: "true",
					authenticated: "true",
				});
				expect(armed.geometry).toEqual(baseline.geometry);
				expect(armed.calls).toEqual({ semantic: 0, hidden: 0 });

				const mainBefore = await fixture.evaluate((value) => value.select("main"));
				expect(mainBefore.tops.main).toBe(900);
				const mainSignal = await fixture.evaluate((value) => value.signal());
				expect(mainSignal.rootAtSignal).toBe(0);
				expect(mainSignal.root.top).toBe(1);
				expect(mainSignal.tops.main).toBe(0);
				expect(mainSignal.calls).toEqual({ semantic: 0, hidden: 0 });

				const mantineBefore = await fixture.evaluate((value) => value.select("mantine"));
				expect(mantineBefore.tops.mantine).toBe(900);
				const mantineSignal = await fixture.evaluate((value) => value.signal());
				expect(mantineSignal.rootAtSignal).toBe(0);
				expect(mantineSignal.tops.mantine).toBe(0);
				expect(mantineSignal.calls).toEqual({ semantic: 0, hidden: 0 });

				const semanticBefore = await fixture.evaluate((value) => value.select("semantic", true));
				const semanticSignal = await fixture.evaluate((value) => value.signal());
				expect(semanticBefore.tops.semantic).toBe(900);
				expect(semanticSignal.rootAtSignal).toBe(0);
				expect(semanticSignal.root.top).toBe(1);
				expect(semanticSignal.tops.semantic).toBe(0);
				expect(semanticSignal.tops.hidden).toBe(700);
				expect(semanticSignal.calls).toEqual({ semantic: 1, hidden: 0 });
				expect(semanticSignal.geometry).toEqual(baseline.geometry);
				await fixture.evaluate((value) => value.select("semantic"));
				const repeatedSignal = await fixture.evaluate((value) => value.signal());
				expect(repeatedSignal.rootAtSignal).toBe(0);
				expect(repeatedSignal.root.top).toBe(1);
				expect(repeatedSignal.tops.semantic).toBe(0);
				expect(repeatedSignal.calls).toEqual({ semantic: 2, hidden: 0 });

				await fixture.evaluate((value) => value.select("semantic"));
				await fixture.evaluate((value) => value.cover(true));
				const coveredSignal = await fixture.evaluate((value) => value.signal());
				expect(coveredSignal.rootAtSignal).toBe(0);
				expect(coveredSignal.tops.semantic).toBe(900);
				expect(coveredSignal.tops.hidden).toBe(700);
				expect(coveredSignal.calls).toEqual({ semantic: 2, hidden: 0 });
				await fixture.evaluate((value) => value.cover(false));

				const keyboardOpen = await fixture.evaluate((value) => value.keyboard(true));
				expect(keyboardOpen.keyboardOpen).toBe(true);
				expect(keyboardOpen.keyboardHeight).toBe("500px");
				expect(keyboardOpen.root.cssHeight).toBe(500);
				expect(keyboardOpen.root.boxHeight).toBe(500);
				expect(keyboardOpen.root.layoutViewportHeight).toBe(844);
				expect(keyboardOpen.root.maximum).toBe(0);
				expect(keyboardOpen.root.top).toBe(0);
				expect(keyboardOpen.root.enabled).toBeNull();
				expect(keyboardOpen.root.overflowY).toBe("hidden");
				expect(keyboardOpen.geometry.main.bottom).toBe(500);
				expect(keyboardOpen.geometry.composer.bottom).toBe(484);
				expect(keyboardOpen.geometry.bottom.bottom).toBe(500);
				expect(keyboardOpen.tops.semantic).toBe(900);
				expect(keyboardOpen.calls).toEqual({ semantic: 2, hidden: 0 });
				const keyboardClosed = await fixture.evaluate((value) => value.keyboard(false));
				expect(keyboardClosed.keyboardOpen).toBe(false);
				expect(keyboardClosed.keyboardHeight).toBe("");
				expect(keyboardClosed.root.cssHeight).toBe(844);
				expect(keyboardClosed.root.layoutViewportHeight).toBe(844);
				expect(keyboardClosed.root.maximum).toBe(1);
				expect(keyboardClosed.root.top).toBe(1);
				expect(keyboardClosed.root.enabled).toBe("true");
				expect(keyboardClosed.geometry).toEqual(baseline.geometry);
				expect(keyboardClosed.tops.semantic).toBe(900);
				expect(keyboardClosed.calls).toEqual({ semantic: 2, hidden: 0 });

				await fixture.evaluate((value) => value.beginOrientationChange());
				await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
				const landscape = await fixture.evaluate((value) => value.finishOrientationChange());
				expect(landscape.geometry.header.bottom).toBe(60);
				expect(landscape.geometry.main.bottom).toBe(390);
				expect(landscape.geometry.composer.bottom).toBe(374);
				expect(landscape.geometry.bottom.bottom).toBe(390);
				expect(landscape.tops.semantic).toBe(900);
				expect(landscape.calls).toEqual({ semantic: 2, hidden: 0 });
				await fixture.evaluate((value) => value.beginOrientationChange());
				await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
				const portrait = await fixture.evaluate((value) => value.finishOrientationChange());
				expect(portrait.geometry).toEqual(baseline.geometry);
				expect(portrait.tops.semantic).toBe(900);
				expect(portrait.calls).toEqual({ semantic: 2, hidden: 0 });

				const retained = await fixture.evaluate((value) => value.releaseOneMount());
				expect(retained.root.enabled).toBe("true");
				expect(retained.root.authenticated).toBe("true");
				expect(retained.geometry).toEqual(baseline.geometry);
				const released = await fixture.evaluate((value) => value.releaseLastMount());
				expect(released.root.enabled).toBeNull();
				expect(released.root.authenticated).toBeNull();
				expect(released.root.top).toBe(0);
				expect(released.calls).toEqual({ semantic: 2, hidden: 0 });

				await fixture.evaluate((value) => value.stopViewportTracking());
				await page.setViewport({ width: 390, height: 848, isMobile: true, hasTouch: true });
				const oversized = await fixture.evaluate((value) => value.oversizedRootContract());
				expect(oversized.original.root.cssHeight).toBe(896);
				expect(oversized.original.root.boxHeight).toBe(896);
				expect(oversized.original.root.layoutViewportHeight).toBe(848);
				expect(oversized.original.root.maximum).toBe(48);
				expect(oversized.original.geometry.main.bottom).toBe(896);
				expect(oversized.original.geometry.composer.bottom).toBe(880);
				expect(oversized.original.geometry.bottom.bottom).toBe(896);
				// An unsafe native range must retain the original locked layout, not add
				// scrollable blank space or retry the unsupported offset indefinitely.
				expect(oversized.fallback).toEqual(oversized.original);
				expect(oversized.stable).toEqual(oversized.original);
				expect(oversized.fallback.root.enabled).toBeNull();
				expect(oversized.fallback.root.overflowY).toBe("hidden");
				expect(oversized.fallback.tops.semantic).toBe(900);
				expect(oversized.fallback.calls).toEqual({ semantic: 2, hidden: 0 });
				expect(oversized.attributeChangesAfterFallback).toBe(0);

				const restored = await fixture.evaluate((value) => value.restoreRootContract());
				expect(restored.original.root.cssHeight).toBe(848);
				expect(restored.original.root.layoutViewportHeight).toBe(848);
				expect(restored.original.root.maximum).toBe(0);
				expect(restored.restored.root.top).toBe(1);
				expect(restored.restored.root.maximum).toBe(1);
				expect(restored.restored.root.enabled).toBe("true");
				expect(restored.restored.geometry).toEqual(restored.original.geometry);
				await fixture.evaluate((value) => value.select("semantic"));
				const restoredSignal = await fixture.evaluate((value) => value.signal());
				expect(restoredSignal.rootAtSignal).toBe(0);
				expect(restoredSignal.tops.semantic).toBe(0);
				expect(restoredSignal.calls).toEqual({ semantic: 3, hidden: 0 });
				const restoredReleased = await fixture.evaluate((value) => value.releaseLastMount());
				expect(restoredReleased.root.enabled).toBeNull();
				expect(restoredReleased.root.top).toBe(0);
				expect(restoredReleased.calls).toEqual({ semantic: 3, hidden: 0 });
			} finally {
				await fixture.evaluate((value) => value.cleanup());
				await fixture.dispose();
			}
		} finally {
			await browser.close();
		}
	},
	60_000,
);
