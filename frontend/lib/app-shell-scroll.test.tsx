import { describe, expect, test } from "bun:test";
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
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	return window.document;
}

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

	test("TanStack global restoration is disabled because 1.168.23 captures every scroll target", async () => {
		const [mainSource, routerOptionsSource, restorationSource] = await Promise.all([
			Bun.file(new URL("../main.tsx", import.meta.url)).text(),
			Bun.file(
				new URL("../../node_modules/@tanstack/router-core/src/router.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL(
					"../../node_modules/@tanstack/router-core/src/scroll-restoration.ts",
					import.meta.url,
				),
			).text(),
		]);

		expect(routerOptionsSource).toContain("scrollRestoration?:");
		expect(routerOptionsSource).toContain("scrollToTopSelectors?:");
		expect(routerOptionsSource).not.toContain("ignoreScrollSelectors");
		expect(restorationSource).toContain("document.addEventListener('scroll', onScroll, true)");
		expect(restorationSource).toContain(
			"setTrackedScrollEntry(target, target.scrollLeft, target.scrollTop)",
		);
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
		const css = await Bun.file(new URL("../styles/safe-area.css", import.meta.url)).text();
		const mainRuleStart = css.indexOf(
			'html[data-nf-authenticated-app-shell="true"] .nf-app-shell-main',
		);
		const mainRuleEnd = css.indexOf("}", mainRuleStart);
		const mainRule = css.slice(mainRuleStart, mainRuleEnd);

		expect(mainRuleStart).toBeGreaterThan(-1);
		expect(mainRule).toContain("overflow-y: auto");
		expect(css.slice(0, mainRuleStart)).not.toContain("@media");
		expect(css).not.toContain("position: fixed");
		expect(css).not.toContain("touch-action");
		expect(css).not.toContain("overflow-x");
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
