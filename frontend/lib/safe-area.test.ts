import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "./responsive";
import {
	APP_SHELL_CONTENT_HEIGHT,
	APP_SHELL_DESKTOP_NAVBAR_HEIGHT,
	APP_SHELL_FULL_BLEED_HEIGHT,
	APP_SHELL_HEADER_HEIGHT,
	APP_SHELL_HEADER_OFFSET,
	APP_SHELL_MAIN_PADDING_BOTTOM,
	APP_SHELL_MOBILE_NAVBAR_HEIGHT,
	APP_SHELL_SAFE_HEADER_STYLE,
	APP_VIEWPORT_BOTTOM,
	type AppViewportMeasurement,
	AUTHENTICATED_APP_SHELL_ATTRIBUTE,
	appShellNavbarBottomGutter,
	getNarratorStatusInlineStyle,
	installAppViewportTracking,
	installAuthenticatedAppShellRootLock,
	measureCssViewportHeight,
	NARRATOR_STATUS_INLINE_STYLE,
	NARRATOR_STATUS_SAFE_INLINE_STYLE,
	PHYSICAL_SAFE_AREA_INSET_BOTTOM,
	resolveAppViewportState,
	SAFE_AREA_DRAWER_BODY_STYLE,
	SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
	SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
	SAFE_AREA_INSET_BOTTOM,
	SAFE_AREA_INSET_LEFT,
	SAFE_AREA_INSET_RIGHT,
	SAFE_AREA_INSET_TOP,
	SAFE_AREA_PADDED_DRAWER_BODY_STYLE,
	safeAreaDrawerBodyHeight,
	safeAreaDrawerHeaderHeight,
	safeAreaDrawerHeaderPaddingTop,
	safeAreaFullscreenModalBodyStyle,
	snapViewportBottomForPaint,
	TOP_BANNER_SAFE_AREA_STYLE,
} from "./safe-area";

/**
 * Drop `/* … *\/` blocks so a stylesheet contract asserts on declarations only.
 *
 * These tests check that certain properties never appear. Reading the raw file made
 * them match the prose in the rationale comments instead — a false positive that also
 * discourages writing the rationale down where it belongs.
 */
function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * A `visualViewport` stand-in offering only the two listener methods the tracker uses.
 *
 * Deliberately not an `EventTarget`. Bun shares one process across test files and many
 * component tests publish linkedom's DOM classes onto `globalThis` so React can render.
 * Once `globalThis.Event` is linkedom's, a native `EventTarget` rejects `new Event(...)`
 * as foreign — so this realm owns its listeners and notifies them directly.
 */
function visualViewportStub(height: number, offsetTop: number) {
	const listeners = new Map<string, Set<() => void>>();
	return {
		height,
		offsetTop,
		addEventListener(type: string, listener: () => void) {
			const forType = listeners.get(type) ?? new Set<() => void>();
			forType.add(listener);
			listeners.set(type, forType);
		},
		removeEventListener(type: string, listener: () => void) {
			listeners.get(type)?.delete(listener);
		},
		emit(type: string) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener();
		},
		listenerCount(type: string) {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

/**
 * A resting 390x844 iPhone measurement. Defaults keep the engine's two viewport
 * units in agreement (no browser chrome retracted) so each test states only the
 * one dimension it is about.
 */
function measurement(overrides: Partial<AppViewportMeasurement> = {}): AppViewportMeasurement {
	return {
		dynamicViewportHeight: 844,
		largeViewportHeight: 844,
		visualViewportHeight: 844,
		visualViewportOffsetTop: 0,
		editableFocused: false,
		virtualKeyboardCapable: true,
		standalone: false,
		...overrides,
	};
}

/**
 * A linkedom realm wired for `installAppViewportTracking`.
 *
 * linkedom has no layout engine, so every tracker test has to hand the engine's
 * `dvh`/`lvh` answers in directly and drive `requestAnimationFrame` by hand. That
 * plumbing is identical across those tests and only the numbers differ, so it lives
 * here and each test states just the dimensions it is about.
 *
 * `matchMedia` deliberately reports every query true EXCEPT `display-mode`: the
 * tracker uses it both for touch capability (must be true, or no keyboard is ever
 * detected) and for standalone (must be false, or the browser-chrome cases under
 * test would be short-circuited).
 */
function trackerRealm(html = "<!doctype html><html><body><textarea></textarea></body></html>") {
	const { window: domWindow, document: domDocument } = parseHTML(html);
	const visualViewport = visualViewportStub(844, 0);
	let nextFrameId = 1;
	const frames = new Map<number, FrameRequestCallback>();
	let activeElement: Element | null = null;

	// linkedom's window is a Proxy over the real globalThis, so each of these also lands
	// there. `writable: true` keeps them from stranding as readonly properties and
	// breaking a later file's `Object.assign(window, …)`.
	Object.defineProperties(domWindow, {
		innerWidth: { configurable: true, writable: true, value: 390 },
		innerHeight: { configurable: true, writable: true, value: 844 },
		visualViewport: { configurable: true, writable: true, value: visualViewport },
		requestAnimationFrame: {
			configurable: true,
			writable: true,
			value: (callback: FrameRequestCallback) => {
				const id = nextFrameId++;
				frames.set(id, callback);
				return id;
			},
		},
		cancelAnimationFrame: {
			configurable: true,
			writable: true,
			value: (id: number) => frames.delete(id),
		},
		matchMedia: {
			configurable: true,
			writable: true,
			value: (query: string) => ({ matches: !query.includes("display-mode") }),
		},
	});
	Object.defineProperty(domDocument, "activeElement", {
		configurable: true,
		get: () => activeElement,
	});

	return {
		window: domWindow as unknown as Window,
		document: domDocument as unknown as Document,
		root: domDocument.documentElement,
		visualViewport,
		focus(element: Element | null) {
			activeElement = element;
		},
		flushFrames() {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback(0);
			}
		},
		/** Resize the visual viewport the way a keyboard does, then settle the frame. */
		resizeVisualViewport(height: number) {
			visualViewport.height = height;
			visualViewport.emit("resize");
			this.flushFrames();
		},
		readPublishedBottom() {
			return domDocument.documentElement.style.getPropertyValue("--app-viewport-bottom") ?? "";
		},
		readPublishedOcclusion() {
			return domDocument.documentElement.style.getPropertyValue("--app-keyboard-occlusion") ?? "";
		},
		readPublishedInset() {
			return domDocument.documentElement.style.getPropertyValue("--app-safe-area-inset-bottom");
		},
	};
}

describe("mobile safe-area layout contract", () => {
	test("AppShell header and viewport reserve the effective screen insets", () => {
		expect(APP_SHELL_HEADER_HEIGHT).toContain(SAFE_AREA_INSET_TOP);
		expect(APP_SHELL_SAFE_HEADER_STYLE).toEqual({
			boxSizing: "border-box",
			paddingTop: SAFE_AREA_INSET_TOP,
		});
		expect(SAFE_AREA_INSET_BOTTOM).toContain("--app-safe-area-inset-bottom");
		expect(SAFE_AREA_INSET_BOTTOM).toContain(PHYSICAL_SAFE_AREA_INSET_BOTTOM);
	});

	test("the header height reaches Mantine through the prop it derives Main's offset from", async () => {
		// Mantine compiles Main's `padding-top` from `--app-shell-header-offset`, its own
		// resolution of `header.height`. Measured on device: setting
		// `--app-shell-header-height` by hand left the header at 92 while Main's padding
		// stayed 116 — a 24px hole between them. So the height must arrive via the prop.
		const appShell = await Bun.file(
			new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url),
		).text();
		expect(appShell).toContain("header={{ height: APP_SHELL_HEADER_HEIGHT }}");
		expect(appShell).not.toContain("--app-shell-header-height");
		expect(appShell).not.toContain("--app-shell-header-offset:");
	});

	test("Main's bottom gutter reserves the inset once, as max() and not as a sum", () => {
		// The bottom inset must not be *added* to a spacing value: `100dvh` already reaches
		// past the home indicator, so a sum reserved the strip twice (measured 50px of dead
		// space where only 34px of indicator clearance was intended). On a device with no
		// inset the `max()` must still fall back to the ordinary `md` gutter.
		expect(APP_SHELL_MAIN_PADDING_BOTTOM).toBe(
			`max(var(--mantine-spacing-md), ${SAFE_AREA_INSET_BOTTOM})`,
		);
	});

	test("route heights derive from Main instead of re-deriving the viewport", () => {
		// Previously these were calc(viewport − header − bottom-inset), which mixed a
		// WebKit runtime measurement (visualViewport.height) with a static CSS value
		// (env()). Nothing contracts whether the former already excludes the latter, so
		// whenever that unverified assumption was wrong the subtraction ran twice and
		// left an 81–158px blank band. Deriving from the parent removes the assumption:
		// there is no viewport term and no inset term left to get wrong.
		for (const height of [APP_SHELL_CONTENT_HEIGHT, APP_SHELL_FULL_BLEED_HEIGHT]) {
			expect(height).not.toContain(APP_VIEWPORT_BOTTOM);
			expect(height).not.toContain(SAFE_AREA_INSET_BOTTOM);
			expect(height).not.toContain(PHYSICAL_SAFE_AREA_INSET_BOTTOM);
			expect(height).not.toContain(APP_SHELL_HEADER_OFFSET);
			expect(height).not.toContain("dvh");
		}
		expect(APP_SHELL_CONTENT_HEIGHT).toBe("100%");
		// Full-bleed routes cancel Main's symmetric `md` padding with negative margins, so
		// they add exactly that padding back — twice, and nothing else.
		expect(APP_SHELL_FULL_BLEED_HEIGHT).toBe("calc(100% + var(--mantine-spacing-md) * 2)");
	});

	test("ContentViewer fullscreen Modal owns dynamic viewport and each safe-area edge once", async () => {
		expect(SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE).toMatchObject({
			height: APP_VIEWPORT_BOTTOM,
			maxHeight: APP_VIEWPORT_BOTTOM,
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			paddingInlineStart: SAFE_AREA_INSET_LEFT,
			paddingInlineEnd: SAFE_AREA_INSET_RIGHT,
		});
		expect(SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE.minHeight).toContain(SAFE_AREA_INSET_TOP);
		expect(SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE.paddingTop).toBe(
			`calc(var(--mb-padding, var(--mantine-spacing-md)) + ${SAFE_AREA_INSET_TOP})`,
		);
		const mobileBody = safeAreaFullscreenModalBodyStyle(8);
		expect(mobileBody).toMatchObject({ boxSizing: "border-box", flex: 1, minHeight: 0 });
		expect(mobileBody.paddingBottom).toBe(`calc(8px + ${SAFE_AREA_INSET_BOTTOM})`);
		const desktopBody = safeAreaFullscreenModalBodyStyle();
		expect(desktopBody.paddingBottom).toBe(
			`calc(var(--mb-padding, var(--mantine-spacing-md)) + ${SAFE_AREA_INSET_BOTTOM})`,
		);
		for (const nestedStyle of [SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE, mobileBody, desktopBody]) {
			expect(nestedStyle).not.toHaveProperty("paddingInlineStart");
			expect(nestedStyle).not.toHaveProperty("paddingInlineEnd");
		}

		const source = await Bun.file(
			new URL("../components/narrator/content/ContentViewer.tsx", import.meta.url),
		).text();
		expect(source).toContain("fullScreen");
		expect(source).toContain("content: SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE");
		expect(source).toContain("header: SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE");
		expect(source).toContain("...safeAreaFullscreenModalBodyStyle(isMobile ? 8 : undefined)");
		expect(source.match(/SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE/g)).toHaveLength(2);
		expect(source).not.toContain("height: `calc(");
	});

	test("authenticated AppShell root lock follows mount lifetime without global DOM mutation", () => {
		const { document: domDocument } = parseHTML(
			'<!doctype html><html><body><div id="root"></div></body></html>',
		);
		const root = domDocument.documentElement;
		const cleanupFirst = installAuthenticatedAppShellRootLock(domDocument as unknown as Document);
		const cleanupSecond = installAuthenticatedAppShellRootLock(domDocument as unknown as Document);

		expect(root.getAttribute(AUTHENTICATED_APP_SHELL_ATTRIBUTE)).toBe("true");
		cleanupFirst();
		expect(root.getAttribute(AUTHENTICATED_APP_SHELL_ATTRIBUTE)).toBe("true");
		cleanupSecond();
		expect(root.hasAttribute(AUTHENTICATED_APP_SHELL_ATTRIBUTE)).toBe(false);
		cleanupSecond();
		expect(root.hasAttribute(AUTHENTICATED_APP_SHELL_ATTRIBUTE)).toBe(false);
	});

	test("top viewport banners preserve their desktop gap above the physical safe area", async () => {
		expect(TOP_BANNER_SAFE_AREA_STYLE.top).toBe(`calc(8px + ${SAFE_AREA_INSET_TOP})`);

		const [versionBanner, connectionAlert] = await Promise.all([
			Bun.file(new URL("../components/VersionUpdateBanner.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/WSConnectionAlert.tsx", import.meta.url)).text(),
		]);

		expect(versionBanner).toContain("...TOP_BANNER_SAFE_AREA_STYLE");
		expect(connectionAlert).toContain("...TOP_BANNER_SAFE_AREA_STYLE");
		expect(versionBanner).not.toContain("APP_SHELL_HEADER_HEIGHT");
		expect(connectionAlert).not.toContain("APP_SHELL_HEADER_HEIGHT");
	});

	test("Narrator status chrome applies horizontal safe areas only for the explicit owner", () => {
		expect(getNarratorStatusInlineStyle()).toBe(NARRATOR_STATUS_INLINE_STYLE);
		expect(getNarratorStatusInlineStyle(false)).not.toHaveProperty("paddingInlineStart");
		expect(getNarratorStatusInlineStyle(false)).not.toHaveProperty("paddingInlineEnd");
		expect(getNarratorStatusInlineStyle(true)).toBe(NARRATOR_STATUS_SAFE_INLINE_STYLE);
		expect(getNarratorStatusInlineStyle(true).paddingInlineStart).toBe(SAFE_AREA_INSET_LEFT);
		expect(getNarratorStatusInlineStyle(true).paddingInlineEnd).toBe(SAFE_AREA_INSET_RIGHT);
	});

	test("only the fullscreen mobile narrator route opts into horizontal safe-area ownership", async () => {
		const [route, workspacePanels, dockPanels, rulerFlow] = await Promise.all([
			Bun.file(new URL("../routes/narrators/$narratorId.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/narrator/workspace/panels.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/narrator/dock/panels.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/ruler/RulerFlow.tsx", import.meta.url)).text(),
		]);

		// One persistent chat now serves both layouts. Ownership must still be
		// explicitly gated on mobile, not permanently enabled on its shared host.
		expect(route).toContain("ownsHorizontalSafeArea={isMobile}");
		expect(route.match(/ownsHorizontalSafeArea/g)).toHaveLength(1);
		expect(workspacePanels).not.toContain("ownsHorizontalSafeArea");
		expect(dockPanels).not.toContain("ownsHorizontalSafeArea");
		expect(rulerFlow).not.toContain("ownsHorizontalSafeArea");
	});

	test("AppShell navbar has one top exclusion owner in each responsive layout", async () => {
		// Original intent, kept: exactly one owner of the top exclusion per breakpoint.
		// Strengthened into the invariant that makes it hold — the subtrahend must be the
		// *same token* as that breakpoint's `top`, so `top + height` collapses to the
		// visible bottom whatever those tokens resolve to. That is why the Navbar may
		// still name the viewport when the route layer no longer does: the route bug
		// needed two independently resolved terms to compound, and there is only one term
		// here. Measured 0px error across both breakpoints x both viewports x keyboard
		// open/closed x visual-viewport panning x all seven `vv.height` semantics.
		const layouts = [
			{ top: APP_SHELL_HEADER_OFFSET, height: APP_SHELL_MOBILE_NAVBAR_HEIGHT },
			{ top: SAFE_AREA_INSET_TOP, height: APP_SHELL_DESKTOP_NAVBAR_HEIGHT },
		];
		for (const layout of layouts) {
			expect(layout.height).toBe(`calc(${APP_VIEWPORT_BOTTOM} - ${layout.top})`);
			// One subtraction, and its subtrahend is the `top` the same breakpoint applies.
			expect(layout.height.match(/ - /g)).toHaveLength(1);
			// The keyboard invariant: the height must track the published visible bottom.
			// `100%` (the Navbar is position: fixed, so that is the initial containing
			// block, not the shell) and a bare `100dvh` both stop following it and overhang
			// the visible bottom by 336-443px once the keyboard is up.
			expect(layout.height).toContain(APP_VIEWPORT_BOTTOM);
			expect(layout.height.startsWith("calc(var(--app-viewport-bottom,")).toBe(true);
			expect(layout.height).not.toContain("100%");
		}
		// The two breakpoints must not share an owner: mobile clears Mantine's header
		// offset (which already carries the top inset), desktop clears the inset itself.
		expect(APP_SHELL_MOBILE_NAVBAR_HEIGHT).not.toBe(APP_SHELL_DESKTOP_NAVBAR_HEIGHT);
		expect(APP_SHELL_MOBILE_NAVBAR_HEIGHT).not.toContain(SAFE_AREA_INSET_TOP);
		expect(APP_SHELL_HEADER_OFFSET).not.toContain(SAFE_AREA_INSET_TOP);

		// The pairing only holds if AppShell.Navbar actually applies both halves as one
		// responsive pair; a `top` that drifts from the height is the failure this guards.
		const appShell = await Bun.file(
			new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url),
		).text();
		const navbarProps = appShell.slice(
			appShell.indexOf("<AppShell.Navbar"),
			appShell.indexOf("<RecentTabsWSProvider />"),
		);
		expect(navbarProps).toContain(
			"top={{ base: APP_SHELL_HEADER_OFFSET, sm: SAFE_AREA_INSET_TOP }}",
		);
		expect(navbarProps).toContain("base: APP_SHELL_MOBILE_NAVBAR_HEIGHT");
		expect(navbarProps).toContain("sm: APP_SHELL_DESKTOP_NAVBAR_HEIGHT");
		// Mantine layout="alt" forces top: 0/height: 100dvh, so dropping either override
		// is what silently reintroduces a full-viewport Navbar.
		expect(navbarProps).toMatch(/top=\{\{/);
		expect(navbarProps).toMatch(/h=\{\{/);
	});

	test("the Navbar reserves the bottom inset once, as max() and not as a sum", async () => {
		// The bug this pins: the `data-safe-area="bottom"` spacer was exactly
		// `env(safe-area-inset-bottom)` while the Navbar also had a symmetric `p`, so the
		// strip was reserved twice inside the Navbar's own box. Measured on iPhone 11 PWA
		// metrics (414x896, insets 48/34, headless Chromium with the insets overridden):
		// the last nav row ended at y=846 against a visible bottom of 896 — a 50px gutter
		// (34 spacer + 16 padding) where 34px of indicator clearance was intended. This is
		// the same additive mistake APP_SHELL_MAIN_PADDING_BOTTOM already removed from
		// Main, and it is the "PWA 外壳底部多次插入" the user reported.
		//
		// `max()` is the fix in both places: the inset wins where there is one, the
		// state's ordinary gutter wins where `env()` is 0.
		expect(appShellNavbarBottomGutter("var(--mantine-spacing-md)")).toBe(
			`max(var(--mantine-spacing-md), ${SAFE_AREA_INSET_BOTTOM})`,
		);
		// Every Navbar state keeps its own base gutter, so no-inset devices are unchanged.
		for (const basePadding of ["0px", "4px", "var(--mantine-spacing-md)"]) {
			const gutter = appShellNavbarBottomGutter(basePadding);
			expect(gutter.startsWith("max(")).toBe(true);
			expect(gutter).toContain(basePadding);
			expect(gutter).toContain(SAFE_AREA_INSET_BOTTOM);
			// A sum is the regression; there must be no `+` between the two terms.
			expect(gutter).not.toContain("+");
			expect(gutter).not.toContain("calc(");
		}
		// Same shape as Main's rule, which is what makes them one contract rather than two.
		expect(APP_SHELL_MAIN_PADDING_BOTTOM.startsWith("max(")).toBe(true);
		expect(APP_SHELL_MAIN_PADDING_BOTTOM).not.toContain("+");

		const appShell = await Bun.file(
			new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url),
		).text();
		const navbarProps = appShell.slice(
			appShell.indexOf("<AppShell.Navbar"),
			appShell.indexOf("<RecentTabsWSProvider />"),
		);
		// `p` sets all four sides, which puts padding *under* the spacer again. The
		// bottom edge must be left to the spacer, so the Navbar may only pad the others.
		expect(navbarProps).not.toMatch(/\bp=\{/);
		expect(navbarProps).not.toMatch(/\bpb=\{/);
		expect(navbarProps).not.toMatch(/\bpy=\{/);
		expect(navbarProps).toContain("px={navbarPadding}");
		expect(navbarProps).toContain("pt={navbarPadding}");
		// The spacer is the single owner, and it carries the max() value rather than the
		// bare inset it used to.
		const spacer = appShell.slice(
			appShell.indexOf('data-safe-area="bottom"'),
			appShell.indexOf("</AppShell.Navbar>"),
		);
		expect(spacer).toContain("h={navbarBottomGutter}");
		expect(spacer).toContain("mih={navbarBottomGutter}");
		expect(spacer).not.toContain("SAFE_AREA_INSET_BOTTOM");
		expect(appShell).toContain("appShellNavbarBottomGutter(");
		// The one remaining direct consumer of the raw inset constant in the shell would
		// be a second owner; there must be none left.
		expect(appShell).not.toContain("SAFE_AREA_INSET_BOTTOM");
	});

	test("the shell height is immune to every candidate visualViewport semantics", () => {
		// The bug this replaces: shell height came from `vv.height`, whose relationship
		// to `env(safe-area-inset-*)` is uncontracted. Each wrong guess about whether
		// `vv` already excludes an inset turned one subtraction into two — measured as
		// 34px of blank space when the old assumption held and 81/68/115/142px when it
		// did not. The dynamic viewport is resolved by the engine in the same coordinate
		// system as `env()`, so no reported `vv`/`innerHeight` value may move the shell
		// while no keyboard is up.
		const screen = 844;
		const top = 47;
		const bottom = 34;
		const candidates = [
			{ id: "vv includes both insets", vv: screen },
			{ id: "vv excludes top inset", vv: screen - top },
			{ id: "vv excludes bottom inset", vv: screen - bottom },
			{ id: "vv excludes both insets", vv: screen - top - bottom },
			{ id: "vv reports a stale toolbar-collapsed height", vv: screen - 57 },
			{ id: "vv reports fractional pixels", vv: screen - 0.5 },
			{ id: "vv over-reports beyond the screen", vv: screen + 12 },
		];

		for (const candidate of candidates) {
			const state = resolveAppViewportState(
				measurement({ visualViewportHeight: candidate.vv }),
				undefined,
			);
			expect(state.viewportBottom, candidate.id).toBe(screen);
			expect(state.keyboardVisible, candidate.id).toBe(false);
			expect(state.reachesPhysicalBottom, candidate.id).toBe(true);
		}
	});

	test("the bottom inset is only reserved when the viewport reaches the screen bottom", () => {
		// `env(safe-area-inset-bottom)` places the home indicator against the *physical*
		// screen. In Safari browser mode the bottom toolbar covers that strip, so it is
		// not inside the visible viewport and reserving it subtracts space that is not
		// there — measured as a 34px blank band. The engine states exactly this as
		// `100dvh` < `100lvh`.
		const behindToolbar = resolveAppViewportState(
			measurement({ dynamicViewportHeight: 761, largeViewportHeight: 844 }),
		);
		expect(behindToolbar.reachesPhysicalBottom).toBe(false);
		expect(behindToolbar.viewportBottom).toBe(761);

		// Toolbar retracted: dvh catches up with lvh, and the indicator is real again.
		const toolbarRetracted = resolveAppViewportState(
			measurement({ dynamicViewportHeight: 844, largeViewportHeight: 844 }),
		);
		expect(toolbarRetracted.reachesPhysicalBottom).toBe(true);

		// PWA/standalone has no chrome to retract, so dvh == lvh and the inset must be
		// honoured — the home indicator really does overlap an installed app.
		const standalone = resolveAppViewportState(
			measurement({ dynamicViewportHeight: 844, largeViewportHeight: 844, standalone: true }),
		);
		expect(standalone.reachesPhysicalBottom).toBe(true);

		// Standalone must win over the measurement, because the stylesheet does not consult
		// the measurement at all: `@media (display-mode: standalone)` switches `html` to
		// `100lvh` on the display mode alone, so at rest an installed PWA's shell already
		// spans the full panel and does reach the indicator. A JS verdict of "chrome is
		// covering the bottom" there would unreserve the inset under a shell that reaches
		// it, putting content beneath the home bar. This is the coupling, not a guess about
		// engine quirks — see the standalone rule in styles/safe-area.css.
		const standaloneWithBogusChrome = resolveAppViewportState(
			measurement({ dynamicViewportHeight: 761, largeViewportHeight: 844, standalone: true }),
		);
		expect(standaloneWithBogusChrome.reachesPhysicalBottom).toBe(true);

		// Sub-pixel disagreement is rounding noise, not chrome.
		const jitter = resolveAppViewportState(
			measurement({ dynamicViewportHeight: 843.5, largeViewportHeight: 844 }),
		);
		expect(jitter.reachesPhysicalBottom).toBe(true);

		// Above the keyboard the indicator is covered too, so it stays unreserved.
		const keyboard = resolveAppViewportState(
			measurement({ visualViewportHeight: 500, editableFocused: true }),
		);
		expect(keyboard.keyboardVisible).toBe(true);
		expect(keyboard.reachesPhysicalBottom).toBe(false);
	});

	test("the top inset is not mistaken for bottom browser chrome (real device numbers)", () => {
		// Both cases are verbatim from real-device reports, because the rule this pins
		// down is not derivable from either one alone.
		//
		// `100lvh` is the full screen box, top inset included; `100dvh` starts below the
		// top inset. So `lvh - dvh` is `topInset + bottomChrome`, never bottom chrome on
		// its own, and the two devices disagree about which term is non-zero.

		// iPhone 11, installed PWA, at rest. The whole 48.016px gap is the notch: there
		// is no browser chrome in an installed PWA to retract. Reading the raw gap as a
		// toolbar dropped the 34px home-indicator inset that a PWA genuinely needs.
		const iPhone11Pwa = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 847.984,
				largeViewportHeight: 896,
				topInset: 48,
				visualViewportHeight: 847.984,
				standalone: true,
			}),
		);
		expect(iPhone11Pwa.keyboardVisible).toBe(false);
		expect(iPhone11Pwa.reachesPhysicalBottom).toBe(true);

		// Same numbers with the standalone short-circuit removed: the top-inset
		// subtraction alone has to carry the verdict, otherwise this depends entirely on
		// a display-mode signal that older home-screen apps do not always report.
		const iPhone11WithoutStandaloneSignal = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 847.984,
				largeViewportHeight: 896,
				topInset: 48,
				visualViewportHeight: 847.984,
				standalone: false,
			}),
		);
		expect(iPhone11WithoutStandaloneSignal.reachesPhysicalBottom).toBe(true);

		// iPhone 8 Plus, Safari browser mode, toolbars up. No notch, so the entire
		// 76.656px gap is real chrome sitting over the bottom edge — and the same
		// subtraction must leave it intact.
		const iPhone8PlusSafari = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 617,
				largeViewportHeight: 693.656,
				topInset: 0,
				visualViewportHeight: 617,
				standalone: false,
			}),
		);
		expect(iPhone8PlusSafari.keyboardVisible).toBe(false);
		expect(iPhone8PlusSafari.reachesPhysicalBottom).toBe(false);
		expect(iPhone8PlusSafari.viewportBottom).toBe(617);

		// A notched device in Safari with the toolbar up: both terms non-zero at once,
		// which is the case neither report covers and the one where a rule that merely
		// special-cased standalone would still be wrong. 48px notch + 83px toolbar.
		const notchedWithToolbar = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 765,
				largeViewportHeight: 896,
				topInset: 48,
				visualViewportHeight: 765,
			}),
		);
		expect(notchedWithToolbar.reachesPhysicalBottom).toBe(false);

		// An absent top inset must not be read as a reason to distrust the gap; devices
		// without a notch report no inset at all and their toolbars are still real.
		const missingTopInset = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 617,
				largeViewportHeight: 693.656,
				topInset: undefined,
				visualViewportHeight: 617,
			}),
		);
		expect(missingTopInset.reachesPhysicalBottom).toBe(false);
	});

	test("an env() probe falls back to zero, not to the viewport height", () => {
		// The tracker measures `env(safe-area-inset-top)` through the same probe as the
		// viewport units. That probe assigns `height` twice so an expression the engine
		// rejects leaves a fallback behind instead of collapsing to `auto` — and the
		// viewport-unit fallback (`100vh`) is actively wrong for an inset: an engine with
		// no `env()` support has no insets, and a screen-tall "top inset" would cancel
		// the toolbar subtraction above on every page.
		const { document: domDocument } = parseHTML("<!doctype html><html><body></body></html>");
		const probeHeights: string[] = [];
		// linkedom has no layout engine, so record what the probe *declares* — which is
		// the property the fallback choice controls.
		const originalCreateElement = domDocument.createElement.bind(domDocument);
		Object.defineProperty(domDocument, "createElement", {
			configurable: true,
			value: (tagName: string) => {
				const element = originalCreateElement(tagName);
				const style = element.style;
				Object.defineProperty(element, "style", {
					configurable: true,
					get: () => ({
						set cssText(value: string) {
							style.cssText = value;
						},
						set height(value: string) {
							probeHeights.push(value);
						},
					}),
				});
				return element;
			},
		});

		measureCssViewportHeight(domDocument as unknown as Document, "100dvh");
		expect(probeHeights).toEqual(["100vh", "100dvh"]);

		probeHeights.length = 0;
		measureCssViewportHeight(domDocument as unknown as Document, "env(safe-area-inset-top, 0px)");
		expect(probeHeights).toEqual(["0px", "env(safe-area-inset-top, 0px)"]);
	});

	test("the tracker measures the top inset it subtracts", () => {
		// The subtraction above is only correct if the top inset is resolved by the same
		// engine, in the same coordinate system, as the two viewport units. A tracker
		// that read it from anywhere else (or not at all) would reintroduce exactly the
		// cross-coordinate-system assumption this module exists to remove.
		// `matchMedia` reports not-standalone here, so the verdict must come from the
		// measurement alone rather than the display-mode short-circuit.
		const realm = trackerRealm("<!doctype html><html><body></body></html>");
		realm.visualViewport.height = 848;

		const requestedUnits: string[] = [];
		// iPhone 11 PWA metrics, as a browser-mode measurement: the 48.016px lvh/dvh gap
		// is entirely the notch, so nothing may be treated as chrome.
		const cleanup = installAppViewportTracking(realm.window, realm.document, (unit) => {
			requestedUnits.push(unit);
			if (unit === "100lvh") return 896;
			if (unit === "100dvh") return 847.984;
			return 48;
		});

		expect(requestedUnits).toContain("100dvh");
		expect(requestedUnits).toContain("100lvh");
		expect(requestedUnits.some((unit) => unit.includes("safe-area-inset-top"))).toBe(true);
		// The inset survives to the CSS variable: reserved, not zeroed by a phantom toolbar.
		expect(realm.readPublishedInset()).toBe(PHYSICAL_SAFE_AREA_INSET_BOTTOM);

		cleanup();
	});

	test("keyboard closing restores the viewport and does not accumulate deductions", () => {
		const resting = resolveAppViewportState(measurement());
		const opened = resolveAppViewportState(
			measurement({ visualViewportHeight: 500, editableFocused: true }),
			resting,
		);
		// Mid-animation, focus has already left but the keyboard still occludes.
		const closing = resolveAppViewportState(measurement({ visualViewportHeight: 640 }), opened);
		const restored = resolveAppViewportState(measurement(), closing);
		const reopened = resolveAppViewportState(
			measurement({ visualViewportHeight: 500, editableFocused: true }),
			restored,
		);

		expect(closing.keyboardVisible).toBe(true);
		expect(restored).toMatchObject({ viewportBottom: 844, keyboardVisible: false });
		expect(restored.reachesPhysicalBottom).toBe(true);
		expect(reopened).toMatchObject({ viewportBottom: 500, keyboardVisible: true });
	});

	test("a missing VisualViewport falls back to the engine's dynamic viewport", () => {
		// Browsers without VisualViewport (and older PWA modes) resize the viewport
		// itself for the keyboard, which the engine reports through `100dvh`.
		const resting = resolveAppViewportState(
			measurement({ visualViewportHeight: undefined, visualViewportOffsetTop: undefined }),
		);
		const opened = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 500,
				visualViewportHeight: undefined,
				visualViewportOffsetTop: undefined,
				editableFocused: true,
			}),
			resting,
		);

		expect(resting.viewportBottom).toBe(844);
		expect(opened.viewportBottom).toBe(500);
	});

	test("keyboard updates never temporarily expand the shell while measuring viewport units", () => {
		const realm = trackerRealm();
		realm.focus(realm.document.querySelector("textarea"));
		realm.visualViewport.height = 500;
		const overridesDuringMeasurement: string[] = [];
		const cleanup = installAppViewportTracking(realm.window, realm.document, (unit) => {
			overridesDuringMeasurement.push(realm.readPublishedBottom());
			return unit.startsWith("env(") ? 0 : 844;
		});
		try {
			expect(realm.readPublishedBottom()).toBe("500px");
			overridesDuringMeasurement.length = 0;
			// A repeated visualViewport event / focus settle callback must not remove
			// the current height before synchronous layout reads: that expands the
			// message list, clamps scrollTop, then shrinks it back at the same height.
			realm.resizeVisualViewport(500);
			expect(overridesDuringMeasurement).toEqual(["500px", "500px", "500px"]);
			expect(realm.readPublishedBottom()).toBe("500px");

			overridesDuringMeasurement.length = 0;
			realm.resizeVisualViewport(420);
			expect(overridesDuringMeasurement).toEqual(["500px", "500px", "500px"]);
			expect(realm.readPublishedBottom()).toBe("420px");

			overridesDuringMeasurement.length = 0;
			realm.focus(null);
			realm.resizeVisualViewport(844);
			expect(overridesDuringMeasurement).toEqual(["420px", "420px", "420px"]);
			expect(realm.readPublishedBottom()).toBe("");
		} finally {
			cleanup();
		}
	});

	test("the root tracker never publishes a fractional shell height", () => {
		// iPhone 8 Plus (414x736, DPR 3, no safe area) reports fractional
		// visualViewport heights. Publishing them verbatim left a hairline row at
		// the bottom of the shell that only the body background covered, which read
		// as a thin light strip under the content on every page.
		//
		// The tracker only publishes a height while the keyboard is up (otherwise the
		// engine's own `100dvh` governs), so the fractional values are exercised through
		// a focused editable control — which is also the state where the old fractional
		// hairline was most visible.
		const realm = trackerRealm();
		realm.focus(realm.document.querySelector("textarea"));
		realm.visualViewport.height = 500.5;

		// iPhone 8 Plus has no safe area, and the engine reports a whole 736 for both units.
		const cleanup = installAppViewportTracking(realm.window, realm.document, () => 736);
		const readPublished = () => Number.parseFloat(realm.readPublishedBottom());

		// The keyboard is up from the first frame here (focused textarea, 500.5 visual
		// height against a 736 engine viewport), so a height is published and it is
		// already snapped to a whole pixel.
		expect(readPublished()).toBe(501);

		for (const height of [500.3333333333334, 500.6666666666666, 420.5]) {
			realm.resizeVisualViewport(height);
			const published = readPublished();
			expect(Number.isInteger(published)).toBe(true);
			// Outward only: the shell must never end above the visible bottom edge.
			expect(published).toBeGreaterThanOrEqual(height);
			expect(published - height).toBeLessThan(1);
		}

		cleanup();
	});

	test("the root tracker applies keyboard state, restores it, and cleans up listeners", () => {
		const realm = trackerRealm();
		const root = realm.root;

		// Equal dvh/lvh means no browser chrome is retracted.
		let engineViewportHeight = 844;
		const cleanup = installAppViewportTracking(
			realm.window,
			realm.document,
			() => engineViewportHeight,
		);
		// At rest the shell height is left to the engine's `100dvh`, so no override is
		// published at all — one fewer value that can disagree with `env()`.
		expect(realm.readPublishedBottom()).toBe("");
		expect(realm.readPublishedOcclusion()).toBe("");
		expect(realm.readPublishedInset()).toBe(PHYSICAL_SAFE_AREA_INSET_BOTTOM);

		realm.focus(realm.document.querySelector("textarea"));
		realm.resizeVisualViewport(500);
		// The keyboard is the one occlusion the engine does not fold into `dvh`, so it
		// is also the only time a height is published.
		expect(realm.readPublishedBottom()).toBe("500px");
		// The push-up companion: how much of the 844px dynamic viewport the keyboard
		// occludes. Surfaces that ride up over the keyboard size and shift by this.
		expect(realm.readPublishedOcclusion()).toBe("344px");
		expect(realm.readPublishedInset()).toBe("0px");
		expect(root.hasAttribute("data-virtual-keyboard-open")).toBe(true);

		realm.focus(null);
		realm.resizeVisualViewport(844);
		expect(realm.readPublishedBottom()).toBe("");
		expect(realm.readPublishedOcclusion()).toBe("");
		expect(realm.readPublishedInset()).toBe(PHYSICAL_SAFE_AREA_INSET_BOTTOM);
		expect(root.hasAttribute("data-virtual-keyboard-open")).toBe(false);

		// The same 83px lvh/dvh gap, read two ways, end to end through the tracker
		// rather than the pure resolver: with no top inset it is real browser chrome over
		// the home indicator (reserving the inset there left a 34px blank band in
		// Safari), and with a matching top inset it is a notch and nothing is occluding.
		engineViewportHeight = 761;
		for (const { topInset, expected } of [
			{ topInset: 0, expected: "0px" },
			{ topInset: 83, expected: PHYSICAL_SAFE_AREA_INSET_BOTTOM },
		]) {
			const restore = installAppViewportTracking(realm.window, realm.document, (unit) => {
				if (unit === "100lvh") return 844;
				if (unit === "100dvh") return 761;
				return topInset;
			});
			expect(realm.readPublishedInset()).toBe(expected);
			restore();
		}

		cleanup();
		expect(realm.readPublishedBottom()).toBe("");
		expect(realm.readPublishedOcclusion()).toBe("");
		expect(realm.readPublishedInset() ?? "").toBe("");
		// Cleanup must actually detach, not just stop publishing: a leaked listener
		// keeps a torn-down tracker writing to a root it no longer owns.
		expect(realm.visualViewport.listenerCount("resize")).toBe(0);
		expect(realm.visualViewport.listenerCount("scroll")).toBe(0);
		realm.resizeVisualViewport(500);
		expect(realm.readPublishedBottom()).toBe("");
	});

	test("browser chrome, window resize, and rotation do not masquerade as keyboards", () => {
		// The old implementation retained a maximum height and treated any shortfall against
		// it as occlusion. Retracting chrome, a desktop/split-view resize or a rotation all
		// inflated that maximum, so the shortfall crossed the keyboard threshold with no
		// keyboard present — which drops the home-indicator inset. Resolving each state from
		// the engine's current viewport removes the retained maximum, so there is nothing
		// left to go stale.
		const chromeChanged = resolveAppViewportState(
			measurement({ dynamicViewportHeight: 760, visualViewportHeight: 760 }),
		);
		// A window that simply got shorter while an input has focus. No occlusion, so no
		// keyboard — this is the case a retained maximum got wrong.
		const narrowedWithFocus = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 620,
				largeViewportHeight: 620,
				visualViewportHeight: 620,
				editableFocused: true,
			}),
			chromeChanged,
		);
		// Focus on a device that cannot raise a virtual keyboard at all.
		const desktopResize = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 700,
				largeViewportHeight: 700,
				visualViewportHeight: 700,
				editableFocused: true,
				virtualKeyboardCapable: false,
			}),
			chromeChanged,
		);
		const rotated = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 390,
				largeViewportHeight: 390,
				visualViewportHeight: 390,
			}),
			chromeChanged,
		);
		// A keyboard surviving a rotation is still detected, because it is read from the live
		// occlusion of the visual viewport rather than from a remembered height.
		const rotatedWithKeyboard = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 390,
				largeViewportHeight: 390,
				visualViewportHeight: 180,
				editableFocused: true,
			}),
			rotated,
		);
		const rotatedRestored = resolveAppViewportState(
			measurement({
				dynamicViewportHeight: 390,
				largeViewportHeight: 390,
				visualViewportHeight: 390,
			}),
			rotatedWithKeyboard,
		);

		expect(chromeChanged.keyboardVisible).toBe(false);
		expect(narrowedWithFocus).toMatchObject({ viewportBottom: 620, keyboardVisible: false });
		expect(narrowedWithFocus.reachesPhysicalBottom).toBe(true);
		expect(desktopResize.keyboardVisible).toBe(false);
		expect(rotated).toMatchObject({ viewportBottom: 390, keyboardVisible: false });
		expect(rotatedWithKeyboard).toMatchObject({ viewportBottom: 180, keyboardVisible: true });
		expect(rotatedRestored).toMatchObject({ viewportBottom: 390, keyboardVisible: false });
		expect(rotatedRestored.reachesPhysicalBottom).toBe(true);
	});

	test("the shell never ends above what the user can see", () => {
		// html/.nf-app-shell/.nf-app-shell-main are laid out from layout-viewport y = 0
		// with overflow-y: hidden, so any viewportBottom short of the visible bottom edge
		// is unreachable dead space. While the keyboard is up and iOS pans the visual
		// viewport, `offsetTop` is what puts that edge back in layout coordinates.
		const panned = resolveAppViewportState(
			measurement({
				visualViewportHeight: 508,
				visualViewportOffsetTop: 100,
				editableFocused: true,
			}),
		);
		expect(panned.keyboardVisible).toBe(true);
		expect(panned.viewportBottom).toBe(608);

		// A stale/disagreeing `innerHeight` used to be able to clamp this down. It is no
		// longer an input at all, so it cannot.
		const pannedFurther = resolveAppViewportState(
			measurement({
				visualViewportHeight: 600,
				visualViewportOffsetTop: 60,
				editableFocused: true,
			}),
		);
		expect(pannedFurther.keyboardVisible).toBe(true);
		expect(pannedFurther.viewportBottom).toBe(660);

		// An occlusion too small to be a keyboard is left to the engine: `dvh` already
		// describes it, so the shell keeps the full visible height instead of guessing.
		const smallOcclusion = resolveAppViewportState(
			measurement({ visualViewportHeight: 760, editableFocused: true }),
		);
		expect(smallOcclusion.keyboardVisible).toBe(false);
		expect(smallOcclusion.viewportBottom).toBe(844);
	});

	test("the published shell height is a whole pixel, rounded outward", () => {
		// Every shell layer is sized from --app-viewport-bottom and is
		// overflow-y: hidden, so a fractional height leaves a sub-pixel row that
		// only the body background paints — a hairline strip along the bottom of
		// every page on devices with no safe area at all. Whole CSS pixels are the
		// only values both engines lay out exactly (they round used heights down to
		// a 1/64px grid, so even device-pixel snapping leaves the seam behind).
		// Halves and thirds are both routine on the same device, so both must land on the
		// next whole pixel rather than the nearest one.
		expect(snapViewportBottomForPaint(735.3333333333334)).toBe(736);
		expect(snapViewportBottomForPaint(735.6666666666666)).toBe(736);

		// Whole pixels pass through untouched, and rounding is always outward: an
		// edge above the visible bottom is unreachable dead space, which is far
		// worse than a sub-pixel overhang.
		expect(snapViewportBottomForPaint(736)).toBe(736);
		for (const value of [735.5, 735.01, 627.99]) {
			expect(snapViewportBottomForPaint(value)).toBeGreaterThanOrEqual(value);
			expect(snapViewportBottomForPaint(value) - value).toBeLessThan(1);
		}

		// Non-finite input must not become NaNpx in the CSS variable.
		expect(snapViewportBottomForPaint(Number.NaN)).toBeNaN();
	});

	test("drawer chrome keeps content clear of both physical screen edges", () => {
		expect(safeAreaDrawerHeaderHeight(45)).toContain(SAFE_AREA_INSET_TOP);
		expect(safeAreaDrawerHeaderPaddingTop(8)).toContain(SAFE_AREA_INSET_TOP);
		expect(safeAreaDrawerBodyHeight(45)).toContain(SAFE_AREA_INSET_TOP);
		expect(SAFE_AREA_DRAWER_BODY_STYLE).toEqual({
			boxSizing: "border-box",
			paddingBottom: SAFE_AREA_INSET_BOTTOM,
		});
		expect(SAFE_AREA_PADDED_DRAWER_BODY_STYLE.paddingBottom).toContain(SAFE_AREA_INSET_BOTTOM);
	});

	test("the viewport opts into edge-to-edge safe-area variables", async () => {
		const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
		const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"\s*\/>/i)?.[1];

		expect(viewport).toContain("viewport-fit=cover");
	});

	test("authenticated AppShell CSS keeps Main as one vertical owner at every width", async () => {
		const css = await Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text();
		// The prohibitions below are about what the stylesheet *declares*. Matching the
		// raw file made them trip over prose in the rationale comments instead, which is
		// both a false positive and a reason to write less of the rationale down.
		const declarations = stripCssComments(css);

		expect(css).toContain('html[data-nf-authenticated-app-shell="true"]');
		expect(css).toContain('html[data-nf-authenticated-app-shell="true"] body');
		expect(css).toContain('html[data-nf-authenticated-app-shell="true"] body > #root');
		expect(css).toContain(".nf-app-shell-main");
		expect(css).toContain("min-height: 0");
		expect(css).toContain("overflow-y: auto");
		expect(css).toContain("overscroll-behavior-y: contain");
		expect(css).toContain("-webkit-overflow-scrolling: touch");
		// Two conditional blocks are allowed, and only two. The first is the
		// installed-PWA height basis: iOS resolves the viewport units differently
		// per shell — measured on an iPhone 11 (896px panel), `100dvh` is 848 in
		// standalone (the panel minus the 48px top inset, which iOS excludes from
		// the dynamic viewport) and 714 in Safari. So `dvh` leaves the shell 48px
		// short of the physical bottom in a PWA, while `lvh` would overflow
		// behind Safari's toolbar by 82px in the browser. `display-mode` is the
		// only signal that separates the two cases, so the basis has to be
		// switched rather than picked.
		//
		// The prohibition this replaces still holds in substance: no *width* media
		// query may re-derive the chain, because that is what let two breakpoints
		// disagree about who owns the height. Assert the allowed queries exactly
		// instead of banning the at-rule: the display-mode basis switch (WCO is its
		// own display-mode — the installed-PWA branch must keep matching there),
		// plus the director lift — which does not touch the chain at all, it only
		// hands the keyboard occlusion to one opt-in surface.
		expect(declarations.match(/@media[^{]*/g)).toEqual([
			"@media (display-mode: standalone), (display-mode: window-controls-overlay) ",
			`@media ${MOBILE_VIEWPORT_MEDIA_QUERY} `,
		]);
		// The shell chain itself never positions; the one `position: fixed` layer in the
		// app (Mantine's overlay inner) is Mantine's own declaration, and this stylesheet
		// only re-sizes it.
		expect(declarations).not.toContain("position: fixed");
		expect(declarations).not.toContain("touch-action");
		expect(declarations).not.toContain("overflow-x");
	});

	test("exactly one element names a viewport height; the rest derive it", async () => {
		// The failure this prevents: several layers each sized themselves from the
		// viewport variable and each subtracted insets, in two different coordinate
		// systems. One owner plus `height: 100%` derivation means a wrong assumption has
		// nowhere to compound — measured as a fixed 0px blank space across all seven
		// candidate `visualViewport` semantics, versus 34–158px before.
		const css = stripCssComments(
			await Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text(),
		);
		const viewportSized = css.match(/var\(--app-viewport-bottom/g) ?? [];

		// Two owners, each naming it as `height` and `max-height`: `html` for the in-flow
		// chain, and Mantine's overlay inner because it is `position: fixed` and so
		// resolves against the initial containing block instead of `html` — the same
		// exception the Navbar already needs. Nothing else may name it.
		//
		// Six mentions, not four: `html` states its height twice, once per display mode
		// (`100dvh` in a browser, `100lvh` in an installed PWA — see the standalone rule).
		// That is still ONE owner; the extra pair is the same owner restating the same two
		// properties under a media query, which is why the count is checked per rule below
		// rather than trusted as a bare total.
		expect(viewportSized).toHaveLength(6);
		const htmlRule = css.slice(
			css.indexOf('html[data-nf-authenticated-app-shell="true"] {'),
			css.indexOf("@media"),
		);
		expect(htmlRule).toContain("var(--app-viewport-bottom, 100dvh)");
		// The standalone override changes only the fallback basis. `--app-viewport-bottom`
		// must still win when published, because the virtual keyboard is the one occlusion
		// neither `dvh` nor `lvh` folds in, and only the tracker measures it.
		const standaloneRule = css.slice(
			css.indexOf("@media"),
			css.indexOf('html[data-nf-authenticated-app-shell="true"] body'),
		);
		expect(standaloneRule).toContain("(display-mode: standalone)");
		expect(standaloneRule.match(/var\(--app-viewport-bottom, 100lvh\)/g)).toHaveLength(2);
		expect(standaloneRule).not.toContain("100dvh");
		// Every intermediate layer is still declared, so the chain has no gap that would
		// let a descendant fall back to `auto` height.
		for (const descendant of ["body", "body > #root", ".nf-app-shell {", ".nf-app-shell-main"]) {
			expect(css).toContain(`html[data-nf-authenticated-app-shell="true"] ${descendant}`);
		}
		// No layer in the in-flow chain re-derives the viewport or an inset: between
		// `body` and the overlay rule there is pure `height: 100%` derivation.
		const inFlowChain = css.slice(
			css.indexOf('html[data-nf-authenticated-app-shell="true"] body'),
			css.indexOf(".mantine-Drawer-inner"),
		);
		expect(inFlowChain).not.toContain("--app-viewport-bottom");
		expect(inFlowChain).not.toContain("env(safe-area-inset");
		expect(inFlowChain).toContain("height: 100%");

		// The overlay exception is exactly one selector, and it cancels `bottom` rather
		// than leaving the box over-constrained between `top`, `bottom` and `height`.
		const overlayRule = css.slice(css.indexOf(".mantine-Drawer-inner"));
		expect(overlayRule).toContain("bottom: auto");
		expect(css.match(/\.mantine-\w+-inner/g)).toEqual([".mantine-Drawer-inner"]);
	});

	test("the director lift is one gated variable from tracker to surface", async () => {
		// The push-up contract has three links that must name the same two variables:
		// the tracker publishes `--app-keyboard-occlusion` and flips
		// `data-virtual-keyboard-open`; the stylesheet gates the occlusion into
		// `--nf-director-keyboard-lift` on mobile widths only; DirectorLayout grows
		// and shifts its own box by the lift. A rename in any link silently restores
		// the squeeze this exists to remove.
		const [css, tracker, surface] = await Promise.all([
			Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text(),
			Bun.file(new URL("./safe-area.ts", import.meta.url)).text(),
			Bun.file(
				new URL("../components/narrator/workspace/DirectorLayout.tsx", import.meta.url),
			).text(),
		]);
		const declarations = stripCssComments(css);

		expect(tracker).toContain('"--app-keyboard-occlusion"');
		expect(tracker).toContain('"data-virtual-keyboard-open"');
		// Gated on the open keyboard AND the mobile width — neither condition alone
		// may lift the surface (desktop keeps the squeeze, rest keeps inset: 0).
		const gate = declarations.slice(declarations.indexOf(`@media ${MOBILE_VIEWPORT_MEDIA_QUERY}`));
		expect(gate).toContain("html[data-virtual-keyboard-open] .nf-director-layout");
		expect(gate).toContain("--nf-director-keyboard-lift: var(--app-keyboard-occlusion, 0px)");
		// The surface consumes the lift and nothing else: no second guess about the
		// keyboard's height anywhere else in the tree. The full expression is
		// asserted — including the `* -1` that makes the lift a push-UP; dropping
		// the negation would silently grow the surface INTO the keyboard.
		expect(surface).toContain('className="nf-director-layout"');
		expect(surface).toContain('top: "calc(var(--nf-director-keyboard-lift, 0px) * -1)"');
		expect(surface).not.toContain("--app-keyboard-occlusion");
	});

	test("only authenticated layout conflicts use the dynamic viewport contract", async () => {
		const [
			appShell,
			contentViewer,
			chapterRoute,
			settingsRoute,
			oauthAppsRoute,
			providersRoute,
			loginRoute,
		] = await Promise.all([
			Bun.file(new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/narrator/content/ContentViewer.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/chapters/$chapterId.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/settings.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/settings/oauth-apps.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/settings/providers.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/login.tsx", import.meta.url)).text(),
		]);
		const authenticatedLayout = appShell.slice(appShell.indexOf("function AuthenticatedLayout"));

		expect(authenticatedLayout).toContain("useBrowserLayoutEffect(() => {");
		expect(authenticatedLayout).toContain("installAuthenticatedAppShellRootLock()");
		expect(authenticatedLayout.indexOf("useBrowserLayoutEffect(() => {")).toBeLessThan(
			authenticatedLayout.indexOf("installAuthenticatedAppShellRootLock()"),
		);
		expect(authenticatedLayout).not.toContain('h="100vh"');
		expect(contentViewer).not.toContain('height: "calc(100vh - 60px)"');
		expect(contentViewer).toContain("SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE");
		expect(chapterRoute).toContain("h={APP_SHELL_CONTENT_HEIGHT}");
		expect(settingsRoute).not.toContain("calc(100vh");
		expect(settingsRoute).toContain("SAFE_AREA_INSET_BOTTOM");
		expect(oauthAppsRoute).not.toContain("calc(100vh");
		expect(providersRoute).toContain("SAFE_AREA_INSET_BOTTOM");
		expect(loginRoute).toContain('h="100vh"');
	});

	test("Narrator viewport containers own the bottom exclusion zone", async () => {
		// The chat-group route used to be checked here too. It was removed with the
		// feature, so reading it now fails the whole case on ENOENT — which says nothing
		// about the safe-area contract this test exists to protect.
		const [
			appShell,
			narratorRoute,
			workspaceRoute,
			projectRoute,
			terminalPanel,
			narratorPanel,
			safeArea,
		] = await Promise.all([
			Bun.file(new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/narrators/$narratorId.tsx", import.meta.url)).text(),
			// The route file is a thin shell; the workspace surface (and its full-bleed
			// branches) lives in WorkspacePage so the standalone window route can reuse it.
			Bun.file(
				new URL("../components/narrator/workspace/WorkspacePage.tsx", import.meta.url),
			).text(),
			Bun.file(new URL("../routes/projects/$projectId.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/terminal/TerminalPanel.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/narrator/NarratorPanel.tsx", import.meta.url)).text(),
			Bun.file(new URL("./safe-area.ts", import.meta.url)).text(),
		]);
		// The status row itself was extracted out of NarratorPanel; the panel now only
		// FORWARDS the ownership flag into it. Both halves are checked, so neither the
		// forwarding nor the single owner of the inset style can be dropped silently.
		const statusBarHost = await Bun.file(
			new URL(
				"../components/narrator/interaction/NarratorInteractionStatusBar.tsx",
				import.meta.url,
			),
		).text();

		expect(appShell).toContain("installAuthenticatedAppShellRootLock()");
		expect(appShell).toContain("className={APP_SHELL_CLASSNAME}");
		expect(appShell).toContain("id={APP_SHELL_MAIN_ID}");
		expect(appShell).toContain("className={APP_SHELL_MAIN_CLASSNAME}");
		expect(appShell).not.toContain("data-scroll-restoration-id");
		expect(appShell).toContain("header={{ height: APP_SHELL_HEADER_HEIGHT }}");
		// The Header remains the sole owner of the top inset style; other props on
		// the same element (a ref for the pull-to-refresh gesture) are free to vary.
		expect(appShell).toMatch(/<AppShell\.Header[^>]*style=\{APP_SHELL_SAFE_HEADER_STYLE\}>/);
		expect(appShell).toContain("top={{ base: APP_SHELL_HEADER_OFFSET, sm: SAFE_AREA_INSET_TOP }}");
		expect(appShell).toContain("base: APP_SHELL_MOBILE_NAVBAR_HEIGHT");
		expect(appShell).toContain("sm: APP_SHELL_DESKTOP_NAVBAR_HEIGHT");
		expect(appShell).not.toContain(
			'style={{ boxSizing: "border-box", paddingTop: SAFE_AREA_INSET_TOP }}',
		);
		expect(appShell).toContain("paddingBottom: APP_SHELL_MAIN_PADDING_BOTTOM");
		expect(appShell).toContain("installAppViewportTracking()");
		expect(appShell).toContain('data-safe-area="bottom"');
		// Full-bleed routes (they cancel Main's padding with negative margins) vs routes
		// that stay inside Main's content box. Both derive from Main; neither re-derives
		// the viewport or the insets.
		// The responsive narrator keeps a single full-bleed host instead of two
		// identical mobile/desktop branches; both layouts inherit its height.
		expect(narratorRoute.match(/h=\{APP_SHELL_FULL_BLEED_HEIGHT\}/g)?.length).toBe(1);
		expect(narratorRoute).toContain("<FocusChatHost");
		// The workspace page collapsed its two identical mobile/desktop branches into
		// one shared `shellBoxProps` when the window chrome variant was added, so the
		// full-bleed height is named exactly once and both layouts inherit it.
		expect(workspaceRoute.match(/APP_SHELL_FULL_BLEED_HEIGHT/g)?.length).toBeGreaterThanOrEqual(1);
		// The compatibility page now uses natural document flow inside Main instead of a fixed canvas.
		expect(projectRoute).toContain("<ProjectCompatibilityPanel");
		expect(projectRoute).not.toContain("APP_SHELL_FULL_BLEED_HEIGHT");
		for (const route of [narratorRoute, workspaceRoute, projectRoute]) {
			expect(route).not.toContain("APP_SHELL_SAFE_VIEWPORT_HEIGHT");
			expect(route).not.toContain("APP_SHELL_PADDED_SAFE_VIEWPORT_HEIGHT");
		}
		expect(narratorRoute).not.toContain('h="calc(100dvh - 60px)"');
		expect(terminalPanel).not.toContain("kbHeight");
		expect(terminalPanel).not.toContain("window.visualViewport");
		expect(statusBarHost).toContain("<NarratorStatusBar");
		expect(statusBarHost).toContain("ownsHorizontalSafeArea={props.ownsHorizontalSafeArea}");
		expect(narratorPanel).toContain("ownsHorizontalSafeArea,");
		for (const source of [narratorPanel, statusBarHost]) {
			expect(source).not.toContain("getNarratorStatusInlineStyle");
			expect(source).not.toContain("env(safe-area-inset-left");
			expect(source).not.toContain("env(safe-area-inset-right");
		}
		expect(safeArea).toContain('visualViewport?.addEventListener("resize"');
		expect(safeArea).toContain('visualViewport?.addEventListener("scroll"');
		expect(safeArea).toContain('targetWindow.addEventListener("resize"');
		expect(safeArea).toContain('visualViewport?.removeEventListener("resize"');
		expect(safeArea).toContain('visualViewport?.removeEventListener("scroll"');
		expect(safeArea).toContain('targetWindow.removeEventListener("resize"');
	});
});
