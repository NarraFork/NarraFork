import { afterAll, describe, expect, test } from "bun:test";
import {
	APP_SHELL_CLASSNAME,
	APP_SHELL_HEADER_HEIGHT,
	APP_SHELL_MAIN_CLASSNAME,
	APP_SHELL_MAIN_ID,
	APP_SHELL_MAIN_PADDING_BOTTOM,
	APP_VIEWPORT_BOTTOM,
} from "@frontend/lib/safe-area";
import { Route as SettingsRoute } from "@frontend/routes/settings";
import { AppShell, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";

/**
 * The desktop settings sidebar's sticky inset, pinned against the real route.
 *
 * The bug: the sidebar declared `top: 76` (Mantine's 60px header + the `md`
 * gutter). A sticky inset resolves against its scroll container's *padded*
 * content edge, and `AppShell.Main` already spends exactly that offset as
 * `padding-top` (`calc(var(--app-shell-header-offset) + var(--app-shell-padding))`).
 * So the same offset was reserved twice and the sidebar sat 76px below the first
 * nav row — but only once a settings route grew tall enough to make Main scroll,
 * which is why short pages looked fine and `/settings/models` did not.
 *
 * `top: 0` is the fix: Main owns the header gutter, the sidebar owns a zero inset.
 *
 * This file lives under `tests/frontend/` rather than next to the route on
 * purpose: `frontend/routes/` is TanStack's `routesDirectory`, and the generator
 * turns every `.tsx` there into a route — a `settings.sidebar-offset.test.tsx`
 * would be emitted as a real `/settings/sidebar-offset/test` route.
 */

const SETTINGS_SIDEBAR_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - 92px)`;

/** Keys this file publishes on `globalThis`, and their pre-existing descriptors. */
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installBrowserDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	class ResizeObserverMock {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	Object.defineProperties(window, {
		requestAnimationFrame: {
			configurable: true,
			writable: true,
			value: (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number,
		},
		cancelAnimationFrame: {
			configurable: true,
			writable: true,
			value: (handle: number) => clearTimeout(handle),
		},
		matchMedia: {
			configurable: true,
			writable: true,
			value: () => ({
				matches: false,
				media: "",
				onchange: null,
				addEventListener: () => {},
				removeEventListener: () => {},
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => false,
			}),
		},
	});
	// `lib/api/client` reads the token from localStorage during the first render.
	const storage = new Map<string, string>();
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: ResizeObserverMock,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
			removeItem: (key: string) => void storage.delete(key),
			clear: () => storage.clear(),
			key: () => null,
			length: 0,
		},
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

/**
 * This linkedom realm must not outlive the file: `parseHTML()` mints a fresh
 * `Event` class per call, and a leaked one fails any later dispatch on a plain
 * EventTarget. Bun runs every file in one process, so restoring is this file's own
 * responsibility.
 */
afterAll(() => {
	for (const [key, descriptor] of savedGlobals) {
		const current = Object.getOwnPropertyDescriptor(globalThis, key);
		if (current && !current.configurable) continue;
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
});

/**
 * Mount the real `/settings` layout inside a real Mantine AppShell.
 *
 * Both halves have to be genuine: the inset is only wrong *relative to* what
 * Mantine's own `AppShell.Main` already pads, so a hand-rolled stand-in for
 * either side would assert against a layout nobody ships.
 */
async function renderSettingsRoute() {
	const document = installBrowserDom();
	const i18n = i18next.createInstance();
	await i18n.use(initReactI18next).init({ lng: "en", resources: { en: {} } });
	// No token is stored, so every settings query stays idle; the layout chrome
	// (which is what this test is about) renders regardless.
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

	const rootRoute = createRootRoute({
		component: () => (
			<MantineProvider env="test">
				<AppShell
					className={APP_SHELL_CLASSNAME}
					layout="alt"
					header={{ height: APP_SHELL_HEADER_HEIGHT }}
					padding="md"
				>
					<AppShell.Main
						id={APP_SHELL_MAIN_ID}
						className={APP_SHELL_MAIN_CLASSNAME}
						style={{ paddingBottom: APP_SHELL_MAIN_PADDING_BOTTOM }}
					>
						<Outlet />
					</AppShell.Main>
				</AppShell>
			</MantineProvider>
		),
	});
	const settingsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/settings",
		component: SettingsRoute.options.component,
	});
	const profileRoute = createRoute({
		getParentRoute: () => settingsRoute,
		path: "profile",
		component: () => <div data-route="profile">short settings page</div>,
	});
	// The four routes that actually overflow Main in the app; overflow is the
	// trigger that made the doubled offset visible.
	const overflowingRoutes = (["models", "providers", "oauth-apps", "usage"] as const).map((path) =>
		createRoute({
			getParentRoute: () => settingsRoute,
			path,
			component: () => (
				<div data-route={path} style={{ height: 2000 }}>
					overflowing {path} page
				</div>
			),
		}),
	);
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/settings/profile"] }),
		routeTree: rootRoute.addChildren([
			settingsRoute.addChildren([profileRoute, ...overflowingRoutes]),
		]),
	});

	const container = document.createElement("div") as HTMLDivElement;
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	await router.load();
	await act(async () =>
		reactRoot.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</I18nextProvider>,
		),
	);

	return {
		document,
		router,
		sidebar: () => document.querySelector<HTMLElement>("[data-settings-desktop-sidebar]"),
		async dispose() {
			await act(async () => reactRoot.unmount());
			container.remove();
			queryClient.clear();
		},
	};
}

describe("desktop settings sidebar layout contract", () => {
	test("the real route's sidebar owns a zero sticky inset, not Main's header gutter", async () => {
		const harness = await renderSettingsRoute();
		try {
			const main = harness.document.getElementById(APP_SHELL_MAIN_ID);
			const sidebar = harness.sidebar();

			expect(main?.classList.contains(APP_SHELL_MAIN_CLASSNAME)).toBe(true);
			expect(sidebar).not.toBeNull();
			expect(sidebar?.style.position).toBe("sticky");
			// The core contract: 0, never 76 or any other repeat of the header offset.
			expect(Number.parseFloat(sidebar?.style.top ?? "NaN")).toBe(0);
			expect(sidebar?.style.maxHeight).toBe(SETTINGS_SIDEBAR_HEIGHT);
			expect(harness.document.querySelector('[data-route="profile"]')).not.toBeNull();
		} finally {
			await harness.dispose();
		}
	});

	test("route overflow changes do not add AppShell.Main's top padding twice", async () => {
		const harness = await renderSettingsRoute();
		try {
			const sidebarBefore = harness.sidebar();
			expect(Number.parseFloat(sidebarBefore?.style.top ?? "NaN")).toBe(0);

			for (const route of ["models", "providers", "oauth-apps", "usage"] as const) {
				await act(async () => harness.router.navigate({ to: `/settings/${route}` }));

				const sidebarAfter = harness.sidebar();
				expect(harness.document.querySelector(`[data-route="${route}"]`)).not.toBeNull();
				// Same element across navigations: no remount could reset the inset either.
				expect(sidebarAfter).toBe(sidebarBefore);
				expect(Number.parseFloat(sidebarAfter?.style.top ?? "NaN")).toBe(0);
			}
		} finally {
			await harness.dispose();
		}
	});

	test("Mantine spends the header offset as Main's padding, which the inset resolves against", async () => {
		// node_modules is hoisted to the repository root, so a worktree-relative URL
		// would miss it.
		const appShellCssPath = Bun.resolveSync("@mantine/core/styles/AppShell.css", import.meta.dir);
		const appShellCss = await Bun.file(appShellCssPath).text();

		// This declaration is the whole reason `top: 0` is right: Main's padded content
		// edge already sits below the header, and that edge is where a sticky inset
		// starts measuring.
		expect(appShellCss).toContain(
			"padding-top: calc(var(--app-shell-header-offset, 0rem) + var(--app-shell-padding))",
		);
	});
});
