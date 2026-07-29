import { afterAll, describe, expect, test } from "bun:test";
import { AppShell, MantineProvider } from "@mantine/core";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useRouterState,
} from "@tanstack/react-router";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppShellMainScrollRestoration } from "./app-shell-scroll";
import {
	isMobileViewportWidth,
	MANTINE_SM_BREAKPOINT_PX,
	MOBILE_VIEWPORT_MEDIA_QUERY,
} from "./responsive";
import { APP_SHELL_CLASSNAME, APP_SHELL_MAIN_CLASSNAME, APP_SHELL_MAIN_ID } from "./safe-area";

/**
 * Keys this file publishes on `globalThis`, and their pre-existing descriptors.
 *
 * This linkedom realm must not outlive the file: `parseHTML()` mints a fresh
 * `Event` class per call, and a leaked one makes a later file's
 * `target.dispatchEvent(new Event(…))` fail the instance check on a plain
 * EventTarget. Bun runs every test file in one process, so restoring is the
 * file's own responsibility.
 */
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installBrowserDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (!savedGlobals.has(key)) savedGlobals.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	return window.document;
}

afterAll(() => {
	for (const [key, descriptor] of savedGlobals) {
		const current = Object.getOwnPropertyDescriptor(globalThis, key);
		if (current && !current.configurable) continue;
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
});

function RouterScrollHarness() {
	const locationKey = useRouterState({
		select: (state) => state.location.state.__TSR_key ?? state.location.href,
	});
	useAppShellMainScrollRestoration(locationKey);
	return (
		<main id={APP_SHELL_MAIN_ID}>
			<div id="chunked-message-scroller" />
			<Outlet />
		</main>
	);
}

describe("authenticated AppShell scroll contract", () => {
	test("real Mantine AppShell/Main DOM exposes one stable global scroll target", () => {
		const markup = renderToStaticMarkup(
			<MantineProvider env="test">
				<AppShell className={APP_SHELL_CLASSNAME} padding="md">
					<AppShell.Main id={APP_SHELL_MAIN_ID} className={APP_SHELL_MAIN_CLASSNAME}>
						<div>page</div>
					</AppShell.Main>
				</AppShell>
			</MantineProvider>,
		);
		const { document } = parseHTML(markup);
		const shell = document.querySelector(`.${APP_SHELL_CLASSNAME}`);
		const main = document.getElementById(APP_SHELL_MAIN_ID);

		expect(shell).not.toBeNull();
		expect(main).not.toBeNull();
		expect(main?.classList.contains(APP_SHELL_MAIN_CLASSNAME)).toBe(true);
		expect(main?.hasAttribute("data-scroll-restoration-id")).toBe(false);
		expect(main?.textContent).toContain("page");
	});

	test("global scroll restoration stays off, because enabling it would capture every scroller", async () => {
		// Why this store exists at all: TanStack's global restoration attaches ONE
		// capturing `scroll` listener on `document` and records whatever bubbles through
		// it, with no per-element opt-out. Enabling it would therefore also snapshot and
		// rewrite the narrator message scroller, the terminal, and every ScrollArea —
		// each of which owns its own scroll position. So AppShell.Main gets a private
		// store instead, and the router-level feature must stay disabled.
		//
		// Asserted against the built `dist` entry that is actually imported, resolved the
		// way the app resolves it, rather than the package's unpublished `src/`:
		//  - `src/` is absent from the `exports` map, so it is not guaranteed to ship.
		//  - `@tanstack/react-router` carries its OWN nested `router-core`, so resolving
		//    from this test file reads a *different copy* than the app runs. Measured in
		//    this worktree: the app loads router-core 1.168.15 via react-router, while a
		//    test-relative resolve finds a hoisted 1.171.13. Two of the five source-text
		//    assertions this replaced only matched the hoisted copy — they were green
		//    while describing code the app never executes.
		const routerCoreEntry = import.meta.resolve(
			"@tanstack/router-core",
			Bun.pathToFileURL(Bun.resolveSync("@tanstack/react-router", import.meta.dir)).href,
		);
		const [mainSource, restorationBundle] = await Promise.all([
			Bun.file(new URL("../main.tsx", import.meta.url)).text(),
			Bun.file(new URL("./scroll-restoration.js", routerCoreEntry)).text(),
		]);

		// The capture-phase document listener is the mechanism: one listener, every
		// scrollable descendant, and the handler stores the target's own scrollTop.
		expect(restorationBundle).toContain('document.addEventListener("scroll", onScroll, true)');
		expect(restorationBundle).toMatch(/scrollY?\s*:\s*(?:target\.scrollTop|scrollY)/);
		// No selector-level exclusion exists, which is what makes "just enable it" unsafe.
		expect(restorationBundle).not.toContain("ignoreScrollSelectors");
		// Therefore the router must never opt in.
		expect(mainSource).not.toContain("scrollRestoration:");
		expect(mainSource).not.toContain("scrollToTopSelectors:");
	});

	test("real Router PUSH resets only Main and POP restores it without touching narrator scroll", async () => {
		const document = installBrowserDom();
		const rootRoute = createRootRoute({ component: RouterScrollHarness });
		const narratorARoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			component: () => <div data-route="narrator-a" />,
		});
		const narratorBRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/narrators",
			component: () => <div data-route="narrator-b" />,
		});
		const history = createMemoryHistory({ initialEntries: ["/"] });
		const router = createRouter({
			history,
			routeTree: rootRoute.addChildren([narratorARoute, narratorBRoute]),
		});
		const container = document.createElement("div") as HTMLDivElement;
		document.body.appendChild(container);
		const reactRoot = createRoot(container);

		await router.load();
		await act(async () => reactRoot.render(<RouterProvider router={router} />));

		const main = document.getElementById(APP_SHELL_MAIN_ID) as HTMLElement;
		const messageScroller = document.getElementById("chunked-message-scroller") as HTMLElement;
		let messageScrollTop = 880;
		let messageScrollWrites = 0;
		Object.defineProperty(messageScroller, "scrollTop", {
			configurable: true,
			get: () => messageScrollTop,
			set: (value: number) => {
				messageScrollWrites++;
				messageScrollTop = value;
			},
		});

		main.scrollLeft = 9;
		main.scrollTop = 340;
		await act(async () => router.navigate({ to: "/narrators" }));

		// A real Router PUSH creates a fresh __TSR_key, so Main starts at the top.
		expect(router.state.location.pathname).toBe("/narrators");
		expect({ left: main.scrollLeft, top: main.scrollTop }).toEqual({ left: 9, top: 0 });
		expect(messageScroller.scrollTop).toBe(880);
		expect(messageScrollWrites).toBe(0);

		main.scrollTop = 125;
		await act(async () => router.history.back());

		// Real POP returns to A's history key. The ChunkedMessageList scroller keeps
		// sole ownership of its scrollTop and receives no competing global write.
		expect(router.state.location.pathname).toBe("/");
		expect({ left: main.scrollLeft, top: main.scrollTop }).toEqual({ left: 9, top: 340 });
		expect(messageScroller.scrollTop).toBe(880);
		expect(messageScrollWrites).toBe(0);

		await act(async () => reactRoot.unmount());
		container.remove();
	});

	test("mobile query is the exact complement of Mantine sm at boundary widths", () => {
		expect(MOBILE_VIEWPORT_MEDIA_QUERY).toBe("not all and (min-width: 48em)");
		expect(MANTINE_SM_BREAKPOINT_PX).toBe(768);
		expect(isMobileViewportWidth(767.9)).toBe(true);
		expect(isMobileViewportWidth(768)).toBe(false);
		expect(isMobileViewportWidth(768.1)).toBe(false);
	});

	test("Main remains the scroll owner across the Mantine sm breakpoint", async () => {
		const raw = await Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text();
		// Assert on declarations, not on prose: the rationale comments in this stylesheet
		// name the properties they explain, which matched the prohibitions below.
		const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
		const mainRuleStart = css.indexOf(
			'html[data-nf-authenticated-app-shell="true"] .nf-app-shell-main',
		);
		const mainRuleEnd = css.indexOf("}", mainRuleStart);
		const mainRule = css.slice(mainRuleStart, mainRuleEnd);

		expect(mainRuleStart).toBeGreaterThan(-1);
		expect(mainRule).toContain("overflow-y: auto");
		// The one media query above Main is the installed-PWA height basis on `html`
		// (`100lvh` instead of `100dvh`; see the rationale in safe-area.css). It changes
		// which unit the single height owner resolves, never who scrolls — so what this
		// assertion has to protect is that no conditional rule reassigns the scroll owner.
		// Checked by shape rather than by banning `@media`, which the basis switch needs.
		// (The stylesheet-wide prohibitions those rules rest on — no `position: fixed`,
		// `touch-action` or `overflow-x` anywhere in the chain — are asserted in
		// safe-area.test.ts; this test is only about who owns the scroll.)
		const queriesAboveMain = css.slice(0, mainRuleStart).match(/@media[^{]*/g) ?? [];
		expect(queriesAboveMain).toEqual(["@media (display-mode: standalone) "]);
		expect(css.slice(0, mainRuleStart)).not.toContain("overflow-y: auto");
		// Main stays the only scroll container: the overlay rule must not introduce one.
		expect(css.slice(mainRuleEnd).match(/overflow-y: auto/g)).toBe(null);
	});

	test("the real message scroller contains only mobile vertical overscroll", async () => {
		const source = await Bun.file(
			new URL("../components/narrator/ChunkedMessageList.tsx", import.meta.url),
		).text();
		const scrollerStart = source.indexOf("ref={setScrollerNode}");
		const scrollerEnd = source.indexOf("<div ref={setContentNode}", scrollerStart);
		const scroller = source.slice(scrollerStart, scrollerEnd);

		expect(scrollerStart).toBeGreaterThan(-1);
		expect(scroller).toContain(
			"overscrollBehaviorY: resolveMessageScrollerOverscrollBehavior(isMobileViewport)",
		);
		expect(scroller).not.toContain("touchAction");
		expect(scroller).toContain('overflowY: "auto"');
		expect(scroller).toContain('overflowX: "hidden"');
	});
});
