import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { isStandaloneWindowPath } from "../lib/standalone-window";

let token: string | null = "test-token";
let cleared = 0;
let retries = 0;
let shellMounts = 0;
let appearanceCalls = 0;
let auth = {
	data: { id: "user" } as { id: string } | undefined,
	isLoading: false,
	isError: false,
	error: null as { status: number; data: Record<string, unknown>; message: string } | null,
	fetchStatus: "idle",
};
const apiModule = await import("../lib/api");
mock.module("../lib/api", () => ({
	...apiModule,
	getToken: () => token,
	clearToken: () => {
		token = null;
		cleared++;
	},
}));
mock.module("../hooks/useAuth", () => ({
	useCurrentUser: () => ({
		...auth,
		refetch: () => {
			retries++;
		},
	}),
}));
mock.module("../hooks/useUserPreferences", () => ({
	useUserPreferences: () => ({ data: undefined }),
}));
mock.module("../hooks/useAuthenticatedAppearance", () => ({
	useAuthenticatedAppearance: () => {
		appearanceCalls++;
	},
}));
mock.module("./AuthenticatedAppLayout", () => ({
	AuthenticatedLayout: () => {
		shellMounts++;
		return (
			<div data-navigation>
				<Outlet />
			</div>
		);
	},
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { RootLayout } = await import("./AppRootLayout");
const { StandaloneWindowLayout } = await import("./StandaloneWindowLayout");

let root: Root;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const storage = new Map<string, string>();
	Object.assign(window, {
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(fn, 0),
		cancelAnimationFrame: clearTimeout,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: false,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	token = "test-token";
	cleared = retries = shellMounts = appearanceCalls = 0;
	auth = {
		data: { id: "user" },
		isLoading: false,
		isError: false,
		error: null,
		fetchStatus: "idle",
	};
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});

afterEach(async () => {
	root.unmount();
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for layout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function render(path: string) {
	const rootRoute = createRootRoute({ component: RootLayout });
	const windows = createRoute({
		getParentRoute: () => rootRoute,
		path: "windows",
		component: StandaloneWindowLayout,
	});
	const content = createRoute({
		getParentRoute: () => windows,
		path: "target",
		component: () => <div data-target>Target content</div>,
	});
	const normal = createRoute({
		getParentRoute: () => rootRoute,
		path: "normal",
		component: () => <div data-target>Normal page</div>,
	});
	const share = createRoute({
		getParentRoute: () => rootRoute,
		path: "shared/narrators/$shareId",
		component: () => <div data-public-share />,
	});
	const login = createRoute({
		getParentRoute: () => rootRoute,
		path: "login",
		component: () => <div data-login />,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([windows.addChildren([content]), normal, share, login]),
		history: createMemoryHistory({ initialEntries: [path] }),
		defaultPendingMinMs: 0,
	});
	await router.load();
	root.render(
		<MantineProvider>
			<RouterProvider router={router} />
		</MantineProvider>,
	);
	return router;
}

test("window height derives from the root and uses the tracked bottom safe area", () => {
	const css = readFileSync(new URL("./StandaloneWindowLayout.module.css", import.meta.url), "utf8");
	expect(css).toContain("height: 100%");
	expect(css).not.toContain("100dvh");
	expect(css).not.toContain("100lvh");
	expect(css).toContain("--app-safe-area-inset-bottom");
});

test("main navigation has no static import in the root layout", () => {
	const source = readFileSync(new URL("./AppRootLayout.tsx", import.meta.url), "utf8");
	expect(source).toContain('import("./AuthenticatedAppLayout")');
	expect(source).not.toMatch(/from\s+["']\.\/AuthenticatedAppLayout["']/);
	expect(source).not.toMatch(/from\s+["']\.\/nav\//);
});

test("window namespace has a segment boundary", () => {
	expect(isStandaloneWindowPath("/windows")).toBe(true);
	expect(isStandaloneWindowPath("/windows/target")).toBe(true);
	expect(isStandaloneWindowPath("/windows-other")).toBe(false);
});

test("private window renders only target and cleans up viewport ownership", async () => {
	await render("/windows/target");
	await waitFor(() => !!container.querySelector("[data-target]"));
	expect(container.querySelector("[data-navigation]")).toBeNull();
	expect(container.querySelector("[data-standalone-window]")).not.toBeNull();
	expect(shellMounts).toBe(0);
	expect(appearanceCalls).toBeGreaterThan(0);
	await waitFor(
		() => document.documentElement.getAttribute("data-nf-authenticated-app-shell") === "true",
	);
	expect(document.documentElement.getAttribute("data-nf-authenticated-app-shell")).toBe("true");
	root.unmount();
	expect(document.documentElement.hasAttribute("data-nf-authenticated-app-shell")).toBe(false);
	root = createRoot(container);
});

test("ordinary pages still mount navigation", async () => {
	await render("/normal");
	await waitFor(() => !!container.querySelector("[data-navigation]"));
	expect(container.querySelector("[data-target]")).not.toBeNull();
});

test("public shares never mount private layout even with a session", async () => {
	await render("/shared/narrators/share-one");
	await waitFor(() => !!container.querySelector("[data-public-share]"));
	expect(shellMounts).toBe(0);
	expect(appearanceCalls).toBe(0);
});

test("login preserves complete window URL and restores the target afterwards", async () => {
	token = null;
	const router = await render(
		"/windows/target?file=%E4%B8%AD%E6%96%87.txt&workspaceKey=repo#patch",
	);
	await waitFor(() => !!container.querySelector("[data-login]"));
	const redirect = router.state.location.search as { redirect?: string };
	expect(redirect.redirect).toBe(
		"/windows/target?file=%E4%B8%AD%E6%96%87.txt&workspaceKey=repo#patch",
	);
	expect(container.querySelector("[data-target]")).toBeNull();
	token = "new-token";
	await router.navigate({ href: redirect.redirect });
	await waitFor(() => !!container.querySelector("[data-target]"));
	expect(shellMounts).toBe(0);
});

test("an expired session hides content, clears credentials and redirects", async () => {
	auth = {
		...auth,
		data: undefined,
		isError: true,
		error: { status: 401, data: { code: "TOKEN_EXPIRED" }, message: "expired" },
	};
	await render("/windows/target");
	await waitFor(() => !!container.querySelector("[data-login]"));
	expect(token).toBeNull();
	expect(cleared).toBe(1);
	expect(container.querySelector("[data-target]")).toBeNull();
});

for (const [status, code] of [
	[502, "UPSTREAM_FAILED"],
	[401, "MFA_CODE_INVALID"],
] as const) {
	test(`auth lookup ${status}/${code} keeps session and offers retry without showing target`, async () => {
		auth = {
			...auth,
			data: undefined,
			isError: true,
			error: { status, data: { code }, message: "try again" },
		};
		await render("/windows/target");
		await waitFor(() => !!container.querySelector('[role="alert"]'));
		expect(token).toBe("test-token");
		expect(cleared).toBe(0);
		expect(container.querySelector("[data-target]")).toBeNull();
		(container.querySelector("button") as HTMLButtonElement).click();
		expect(retries).toBe(1);
	});
}
