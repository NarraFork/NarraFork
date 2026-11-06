/**
 * Browser fixture of the reports (P2 PR 11): the real notification drawer on its "needs you" tab
 * at `/`, the outline home's entry at `/outline`, and the real reports page at `/outline/digest`,
 * under a memory router, against the test
 * server's human-attention list and outline API (`outline-digest.browser.test.ts`). Other routes
 * are not mounted: following a link there only moves the router, which the test reads.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { Box, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useNavigate,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../../lib/api";
import {
	outlineRouterLink,
	useOutlineRouterHrefNavigate,
	useOutlineRouterNavigate,
} from "../../../lib/outline-router";
import narratorEn from "../../../locales/en/narrator.json";
import navEn from "../../../locales/en/nav.json";
import outlineEn from "../../../locales/en/outline.json";
import narratorZh from "../../../locales/zh-CN/narrator.json";
import navZh from "../../../locales/zh-CN/nav.json";
import outlineZh from "../../../locales/zh-CN/outline.json";
import { NotificationCenterDrawer } from "../../notifications/NotificationCenterDrawer";
import { OutlineNavProvider } from "../outline-nav";
import { OutlineDigestPage } from "./OutlineDigestPage";
import { OutlineReportEntry } from "./OutlineReportEntry";

api.getGlobalQuestionPage = async () => ({ items: [], nextCursor: null });

let root: Root | null = null;
let currentHref: (() => string) | null = null;
let closed = 0;

export function ready(): boolean {
	return true;
}

function DrawerHost() {
	return (
		<NotificationCenterDrawer
			opened
			initialTab="attention"
			onClose={() => {
				closed++;
			}}
		/>
	);
}

/** Mount at `path` ("/" is the drawer), in a language and a color scheme, as `userId`. */
export async function mount(options: {
	path: string;
	lang: "en" | "zh-CN";
	scheme: "light" | "dark";
	userId: string;
}): Promise<void> {
	root?.unmount();
	const i18n = createInstance();
	await i18n.init({
		lng: options.lang,
		fallbackLng: "en",
		resources: {
			en: { narrator: narratorEn, nav: navEn, outline: outlineEn },
			"zh-CN": { narrator: narratorZh, nav: navZh, outline: outlineZh },
		},
		interpolation: { escapeValue: false },
	});
	document.documentElement.lang = options.lang;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["settings"], { outline: { enabled: true } });
	client.setQueryData(["auth", "me"], { id: options.userId, username: "alice" });

	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const home = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DrawerHost });
	// The outline home's entry to the reports (the rest of the home is not under test).
	const outlineHome = createRoute({
		getParentRoute: () => rootRoute,
		path: "/outline",
		component: function EntryHost() {
			const navigateOutline = useOutlineRouterNavigate();
			const navigateHref = useOutlineRouterHrefNavigate();
			return (
				<Box px={16} py="md">
					<OutlineNavProvider
						onNavigate={navigateOutline}
						renderLink={outlineRouterLink}
						onNavigateHref={navigateHref}
					>
						<OutlineReportEntry />
					</OutlineNavProvider>
				</Box>
			);
		},
	});
	const digest = createRoute({
		getParentRoute: () => rootRoute,
		path: "/outline/digest",
		validateSearch: (search: Record<string, unknown>) => ({
			d: typeof search.d === "string" ? search.d : undefined,
			space: typeof search.space === "string" ? search.space : undefined,
		}),
		component: function PageHost() {
			const search = digest.useSearch();
			const navigate = useNavigate();
			const navigateOutline = useOutlineRouterNavigate();
			const navigateHref = useOutlineRouterHrefNavigate();
			return (
				<Box px={16} py="md">
					<OutlineNavProvider
						onNavigate={navigateOutline}
						renderLink={outlineRouterLink}
						onNavigateHref={navigateHref}
					>
						<OutlineDigestPage
							day={search.d}
							space={search.space}
							onSelect={(next) =>
								void navigate({ to: "/outline/digest", search: { d: next.d, space: next.space } })
							}
						/>
					</OutlineNavProvider>
				</Box>
			);
		},
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([home, outlineHome, digest]),
		history: createMemoryHistory({ initialEntries: [options.path] }),
	});
	currentHref = () => router.state.location.href;
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider forceColorScheme={options.scheme}>
					<Notifications />
					<RouterProvider router={router} />
				</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
}

/** Where the router is now, and how often the drawer was asked to close. */
export function location(): { href: string; closed: number } {
	return { href: currentHref?.() ?? "", closed };
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

export function exists(selector: string): boolean {
	return document.querySelector(selector) !== null;
}

/** Click the first element matching a selector. */
export function click(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	element.click();
	return true;
}

export function textOf(selector: string): string | null {
	return document.querySelector<HTMLElement>(selector)?.innerText ?? null;
}

export function texts(selector: string): string[] {
	return [...document.querySelectorAll<HTMLElement>(selector)].map((e) => e.innerText);
}

export function attrs(selector: string, name: string): string[] {
	return [...document.querySelectorAll(selector)].map((e) => e.getAttribute(name) ?? "");
}

/** The test id of what has focus (or of its nearest element that has one). */
export function focused(): string | null {
	const element = document.activeElement;
	if (!element || element === document.body) return null;
	return element.closest("[data-testid]")?.getAttribute("data-testid") ?? element.tagName;
}

/** Whether some text is on the page (a toast, say). */
export function shows(text: string): boolean {
	return document.body.innerText.includes(text);
}

/** A Select's options once it is open (Mantine renders them in a portal). */
export function options(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[role=option]")].map((e) => e.innerText);
}

/** Choose the open Select's option whose label contains `text`. */
export function choose(text: string): boolean {
	const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((e) =>
		e.innerText.includes(text),
	);
	if (!option) return false;
	option.click();
	return true;
}

/**
 * How far content reaches past the viewport: the page's own horizontal scroll, the drawer's, and
 * the elements under `scope` whose right edge is past the viewport's (by test id, for the report).
 */
export function overflow(scope: string): { page: number; drawer: number; past: string[] } {
	const width = document.documentElement.clientWidth;
	const drawer = document.querySelector<HTMLElement>(".mantine-Drawer-body");
	const past = [...document.querySelectorAll<HTMLElement>(`${scope} *`)]
		.filter((e) => {
			const box = e.getBoundingClientRect();
			return box.width > 0 && box.right > width + 1;
		})
		.slice(0, 5)
		.map((e) => `${e.tagName.toLowerCase()}.${e.className} ${e.innerText?.slice(0, 40)}`);
	return {
		page: document.documentElement.scrollWidth - width,
		drawer: drawer ? drawer.scrollWidth - drawer.clientWidth : 0,
		past,
	};
}
