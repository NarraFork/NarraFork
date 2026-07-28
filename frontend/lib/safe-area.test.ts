import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	APP_SHELL_DESKTOP_NAVBAR_HEIGHT,
	APP_SHELL_HEADER_HEIGHT,
	APP_SHELL_HEADER_OFFSET,
	APP_SHELL_MAIN_PADDING_BOTTOM,
	APP_SHELL_MOBILE_NAVBAR_HEIGHT,
	APP_SHELL_PADDED_SAFE_VIEWPORT_HEIGHT,
	APP_SHELL_SAFE_HEADER_STYLE,
	APP_SHELL_SAFE_VIEWPORT_HEIGHT,
	APP_VIEWPORT_BOTTOM,
	AUTHENTICATED_APP_SHELL_ATTRIBUTE,
	getNarratorStatusInlineStyle,
	installAppViewportTracking,
	installAuthenticatedAppShellRootLock,
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
	TOP_BANNER_SAFE_AREA_STYLE,
} from "./safe-area";

describe("mobile safe-area layout contract", () => {
	test("AppShell header and viewport reserve the effective screen insets", () => {
		expect(APP_SHELL_HEADER_HEIGHT).toContain(SAFE_AREA_INSET_TOP);
		expect(APP_SHELL_SAFE_HEADER_STYLE).toEqual({
			boxSizing: "border-box",
			paddingTop: SAFE_AREA_INSET_TOP,
		});
		expect(SAFE_AREA_INSET_BOTTOM).toContain("--app-safe-area-inset-bottom");
		expect(SAFE_AREA_INSET_BOTTOM).toContain(PHYSICAL_SAFE_AREA_INSET_BOTTOM);
		expect(APP_SHELL_MAIN_PADDING_BOTTOM).toContain(SAFE_AREA_INSET_BOTTOM);
		expect(APP_SHELL_SAFE_VIEWPORT_HEIGHT).toContain(APP_SHELL_HEADER_OFFSET);
		expect(APP_SHELL_SAFE_VIEWPORT_HEIGHT).toContain(APP_VIEWPORT_BOTTOM);
		expect(APP_SHELL_SAFE_VIEWPORT_HEIGHT).toContain(SAFE_AREA_INSET_BOTTOM);
		expect(APP_SHELL_PADDED_SAFE_VIEWPORT_HEIGHT).toContain(SAFE_AREA_INSET_BOTTOM);
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
			new URL("../components/narrator/ContentViewer.tsx", import.meta.url),
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

		const mobileBranch = route.slice(
			route.indexOf("// Mobile layout"),
			route.indexOf("// Desktop"),
		);
		expect(mobileBranch).toContain("ownsHorizontalSafeArea");
		expect(route.match(/ownsHorizontalSafeArea/g)).toHaveLength(1);
		expect(workspacePanels).not.toContain("ownsHorizontalSafeArea");
		expect(dockPanels).not.toContain("ownsHorizontalSafeArea");
		expect(rulerFlow).not.toContain("ownsHorizontalSafeArea");
	});

	test("AppShell navbar has one top exclusion owner in each responsive layout", () => {
		expect(APP_SHELL_MOBILE_NAVBAR_HEIGHT).toContain(APP_VIEWPORT_BOTTOM);
		expect(APP_SHELL_MOBILE_NAVBAR_HEIGHT).toContain(APP_SHELL_HEADER_OFFSET);
		expect(APP_SHELL_DESKTOP_NAVBAR_HEIGHT).toContain(APP_VIEWPORT_BOTTOM);
		expect(APP_SHELL_DESKTOP_NAVBAR_HEIGHT).toContain(SAFE_AREA_INSET_TOP);
		expect(APP_SHELL_HEADER_OFFSET).not.toContain(SAFE_AREA_INSET_TOP);
	});

	test("keyboard opening uses the visual bottom and remains stable while Safari pans it", () => {
		const resting = resolveAppViewportState({
			layoutWidth: 390,
			layoutHeight: 844,
			visualViewportHeight: 844,
			visualViewportOffsetTop: 0,
			editableFocused: false,
			virtualKeyboardCapable: true,
		});
		const opened = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				visualViewportHeight: 500,
				visualViewportOffsetTop: 0,
				editableFocused: true,
				virtualKeyboardCapable: true,
			},
			resting,
		);
		const panned = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				visualViewportHeight: 420,
				visualViewportOffsetTop: 80,
				editableFocused: true,
				virtualKeyboardCapable: true,
			},
			opened,
		);

		expect(opened.keyboardVisible).toBe(true);
		expect(opened.viewportBottom).toBe(500);
		expect(panned.keyboardVisible).toBe(true);
		expect(panned.viewportBottom).toBe(500);
		expect(panned.stableViewportBottom).toBe(844);
	});

	test("keyboard closing restores the viewport and does not accumulate deductions", () => {
		const resting = resolveAppViewportState({
			layoutWidth: 390,
			layoutHeight: 844,
			visualViewportHeight: 844,
			editableFocused: false,
			virtualKeyboardCapable: true,
		});
		const opened = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				visualViewportHeight: 500,
				editableFocused: true,
				virtualKeyboardCapable: true,
			},
			resting,
		);
		const closing = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				visualViewportHeight: 640,
				editableFocused: false,
				virtualKeyboardCapable: true,
			},
			opened,
		);
		const restored = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				visualViewportHeight: 844,
				editableFocused: false,
				virtualKeyboardCapable: true,
			},
			closing,
		);
		const reopened = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				visualViewportHeight: 500,
				editableFocused: true,
				virtualKeyboardCapable: true,
			},
			restored,
		);

		expect(closing.keyboardVisible).toBe(true);
		expect(restored).toMatchObject({
			viewportBottom: 844,
			stableViewportBottom: 844,
			keyboardVisible: false,
		});
		expect(reopened).toMatchObject({
			viewportBottom: 500,
			stableViewportBottom: 844,
			keyboardVisible: true,
		});
	});

	test("innerHeight fallback handles PWA keyboards without VisualViewport", () => {
		const resting = resolveAppViewportState({
			layoutWidth: 390,
			layoutHeight: 844,
			editableFocused: false,
			virtualKeyboardCapable: true,
		});
		const opened = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 500,
				editableFocused: true,
				virtualKeyboardCapable: true,
			},
			resting,
		);
		const restored = resolveAppViewportState(
			{
				layoutWidth: 390,
				layoutHeight: 844,
				editableFocused: false,
				virtualKeyboardCapable: true,
			},
			opened,
		);

		expect(opened.keyboardVisible).toBe(true);
		expect(opened.viewportBottom).toBe(500);
		expect(restored.keyboardVisible).toBe(false);
		expect(restored.viewportBottom).toBe(844);
	});

	test("the root tracker applies keyboard state, restores it, and cleans up listeners", () => {
		const { window: domWindow, document: domDocument } = parseHTML(
			"<!doctype html><html><body><textarea></textarea></body></html>",
		);
		const visualViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
		let activeElement: Element | null = null;
		let nextFrameId = 1;
		const frames = new Map<number, FrameRequestCallback>();
		const flushFrames = () => {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback(0);
			}
		};

		Object.defineProperties(domWindow, {
			innerWidth: { configurable: true, value: 390, writable: true },
			innerHeight: { configurable: true, value: 844, writable: true },
			visualViewport: { configurable: true, value: visualViewport },
			requestAnimationFrame: {
				configurable: true,
				value: (callback: FrameRequestCallback) => {
					const id = nextFrameId++;
					frames.set(id, callback);
					return id;
				},
			},
			cancelAnimationFrame: {
				configurable: true,
				value: (id: number) => frames.delete(id),
			},
			matchMedia: {
				configurable: true,
				value: () => ({ matches: true }),
			},
		});
		Object.defineProperty(domDocument, "activeElement", {
			configurable: true,
			get: () => activeElement,
		});

		const cleanup = installAppViewportTracking(
			domWindow as unknown as Window,
			domDocument as unknown as Document,
		);
		const root = domDocument.documentElement;
		expect(root.style.getPropertyValue("--app-viewport-bottom")).toBe("844px");
		expect(root.style.getPropertyValue("--app-safe-area-inset-bottom")).toBe(
			PHYSICAL_SAFE_AREA_INSET_BOTTOM,
		);

		activeElement = domDocument.querySelector("textarea");
		visualViewport.height = 500;
		visualViewport.dispatchEvent(new Event("resize"));
		flushFrames();
		expect(root.style.getPropertyValue("--app-viewport-bottom")).toBe("500px");
		expect(root.style.getPropertyValue("--app-safe-area-inset-bottom")).toBe("0px");
		expect(root.hasAttribute("data-virtual-keyboard-open")).toBe(true);

		activeElement = null;
		visualViewport.height = 844;
		visualViewport.dispatchEvent(new Event("resize"));
		flushFrames();
		expect(root.style.getPropertyValue("--app-viewport-bottom")).toBe("844px");
		expect(root.style.getPropertyValue("--app-safe-area-inset-bottom")).toBe(
			PHYSICAL_SAFE_AREA_INSET_BOTTOM,
		);
		expect(root.hasAttribute("data-virtual-keyboard-open")).toBe(false);

		cleanup();
		expect(root.style.getPropertyValue("--app-viewport-bottom") ?? "").toBe("");
		expect(root.style.getPropertyValue("--app-safe-area-inset-bottom") ?? "").toBe("");
		visualViewport.height = 500;
		visualViewport.dispatchEvent(new Event("resize"));
		flushFrames();
		expect(root.style.getPropertyValue("--app-viewport-bottom") ?? "").toBe("");
	});

	test("browser chrome, desktop resize, and rotation do not masquerade as keyboards", () => {
		const chromeChanged = resolveAppViewportState({
			layoutWidth: 390,
			layoutHeight: 844,
			visualViewportHeight: 760,
			editableFocused: false,
			virtualKeyboardCapable: true,
		});
		const desktopResize = resolveAppViewportState(
			{
				layoutWidth: 1200,
				layoutHeight: 700,
				visualViewportHeight: 700,
				editableFocused: true,
				virtualKeyboardCapable: false,
			},
			chromeChanged,
		);
		const rotated = resolveAppViewportState(
			{
				layoutWidth: 844,
				layoutHeight: 390,
				visualViewportHeight: 390,
				editableFocused: false,
				virtualKeyboardCapable: true,
			},
			chromeChanged,
		);
		const rotatedWithKeyboard = resolveAppViewportState(
			{
				layoutWidth: 844,
				layoutHeight: 180,
				visualViewportHeight: 180,
				editableFocused: true,
				virtualKeyboardCapable: true,
			},
			chromeChanged,
		);
		const rotatedRestored = resolveAppViewportState(
			{
				layoutWidth: 844,
				layoutHeight: 390,
				visualViewportHeight: 390,
				editableFocused: false,
				virtualKeyboardCapable: true,
			},
			rotatedWithKeyboard,
		);

		expect(chromeChanged.keyboardVisible).toBe(false);
		expect(desktopResize.keyboardVisible).toBe(false);
		expect(rotated).toMatchObject({
			viewportBottom: 390,
			stableViewportBottom: 390,
			keyboardVisible: false,
		});
		expect(rotatedWithKeyboard).toMatchObject({
			viewportBottom: 180,
			stableViewportBottom: 390,
			keyboardVisible: true,
		});
		expect(rotatedRestored).toMatchObject({
			viewportBottom: 390,
			stableViewportBottom: 390,
			keyboardVisible: false,
		});
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

		expect(css).toContain('html[data-nf-authenticated-app-shell="true"]');
		expect(css).toContain('html[data-nf-authenticated-app-shell="true"] body');
		expect(css).toContain('html[data-nf-authenticated-app-shell="true"] body > #root');
		expect(css).toContain("height: var(--app-viewport-bottom, 100dvh)");
		expect(css).toContain(".nf-app-shell-main");
		expect(css).toContain("min-height: 0");
		expect(css).toContain("overflow-y: auto");
		expect(css).toContain("overscroll-behavior-y: contain");
		expect(css).toContain("-webkit-overflow-scrolling: touch");
		expect(css).not.toContain("@media");
		expect(css).not.toContain("position: fixed");
		expect(css).not.toContain("touch-action");
		expect(css).not.toContain("overflow-x");
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
			Bun.file(new URL("../components/AppRootLayout.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/narrator/ContentViewer.tsx", import.meta.url)).text(),
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
		expect(chapterRoute).toContain("h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}");
		expect(settingsRoute).not.toContain("calc(100vh");
		expect(settingsRoute).toContain("SAFE_AREA_INSET_BOTTOM");
		expect(oauthAppsRoute).not.toContain("calc(100vh");
		expect(providersRoute).toContain("SAFE_AREA_INSET_BOTTOM");
		expect(loginRoute).toContain('h="100vh"');
	});

	test("Narrator viewport containers own the bottom exclusion zone", async () => {
		const [
			appShell,
			narratorRoute,
			workspaceRoute,
			projectRoute,
			terminalPanel,
			narratorPanel,
			safeArea,
		] = await Promise.all([
			Bun.file(new URL("../components/AppRootLayout.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/narrators/$narratorId.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/narrators/workspace/$workspaceId.tsx", import.meta.url)).text(),
			Bun.file(new URL("../routes/projects/$projectId.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/terminal/TerminalPanel.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/narrator/NarratorPanel.tsx", import.meta.url)).text(),
			Bun.file(new URL("./safe-area.ts", import.meta.url)).text(),
		]);

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
		expect(narratorRoute.match(/h=\{APP_SHELL_SAFE_VIEWPORT_HEIGHT\}/g)?.length).toBe(2);
		expect(workspaceRoute.match(/h=\{APP_SHELL_SAFE_VIEWPORT_HEIGHT\}/g)?.length).toBe(2);
		expect(projectRoute).toContain("height: APP_SHELL_PADDED_SAFE_VIEWPORT_HEIGHT");
		expect(narratorRoute).not.toContain('h="calc(100dvh - 60px)"');
		expect(terminalPanel).not.toContain("kbHeight");
		expect(terminalPanel).not.toContain("window.visualViewport");
		expect(narratorPanel).toContain("<NarratorStatusBar");
		expect(narratorPanel).toContain("ownsHorizontalSafeArea={ownsHorizontalSafeArea}");
		expect(narratorPanel).not.toContain("getNarratorStatusInlineStyle");
		expect(narratorPanel).not.toContain("env(safe-area-inset-left");
		expect(narratorPanel).not.toContain("env(safe-area-inset-right");
		expect(safeArea).toContain('visualViewport?.addEventListener("resize"');
		expect(safeArea).toContain('visualViewport?.addEventListener("scroll"');
		expect(safeArea).toContain('targetWindow.addEventListener("resize"');
		expect(safeArea).toContain('visualViewport?.removeEventListener("resize"');
		expect(safeArea).toContain('visualViewport?.removeEventListener("scroll"');
		expect(safeArea).toContain('targetWindow.removeEventListener("resize"');
	});
});
