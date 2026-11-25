/**
 * The row menu (a left swipe on touch) reads its tab from the live list by key, so the details
 * it shows follow runtime patches that arrive while it is open, and a row that leaves the list
 * closes it. The bug this pins: the menu captured the tab object when it opened, and the
 * project details its own read brought in (`refreshProjectTabDetails`) never appeared.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
	skipToken,
	useQuery,
} from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import {
	type RecentTabsInfiniteData,
	recentTabsFlatQueryKey,
	recentTabsSectionQueryKey,
} from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import { clearToken, confirmAuthUser, setToken } from "../../lib/api/client";
import { getRecentTabsScope } from "../../lib/recent-tabs-owner";
import commonEn from "../../locales/en/common.json";
import { RecentTabDetails } from "./RecentTabDetailCard";
import { recentTabMenuKey, useRecentTabMenuTarget } from "./recent-tab-menu-target";

type RuntimeResult = Awaited<ReturnType<typeof api.getRecentTabsRuntime>>;

const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { common: commonEn } } });

let root: Root;
let host: HTMLElement;
let client: QueryClient;
let restoreDom: () => void;
let requests: Array<{ keys: string[]; resolve: (result: RuntimeResult) => void }>;
let open: (tab: RecentTab) => void = () => {};
function scope() {
	const current = getRecentTabsScope();
	if (!current) throw new Error("Missing test scope");
	return current;
}

function setTabs(tabs: RecentTab[]) {
	client.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope(), "work"), {
		pages: [{ items: tabs, revision: 0, hasMore: false, nextCursor: undefined }],
		pageParams: [undefined],
	});
	client.setQueryData(recentTabsFlatQueryKey(scope()), tabs);
}

/** The list's menu state, rendering what the touch menu shows at its top: the row's details. */
function MenuHarness() {
	const { data: tabs = [] } = useQuery<RecentTab[]>({
		queryKey: recentTabsFlatQueryKey(scope()),
		queryFn: skipToken,
	});
	const [menu, tab, setMenu] = useRecentTabMenuTarget(tabs);
	open = (row) => setMenu({ x: 0, y: 0, key: recentTabMenuKey(row) });
	return menu && tab ? (
		<div data-testid="row-menu">
			<RecentTabDetails tab={tab} compact />
		</div>
	) : null;
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const storage = new Map<string, string>();
	const globals = {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	Object.assign(globalThis, globals);
	restoreDom = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	confirmAuthUser(setToken("test-menu-token"), "test-menu-user");
	notifyManager.setScheduler(queueMicrotask);
	requests = [];
	spyOn(api, "getRecentTabsRuntime").mockImplementation(
		(keys) =>
			new Promise<RuntimeResult>((resolve) => {
				requests.push({ keys, resolve });
			}),
	);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	host = window.document.createElement("div");
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider>
						<MenuHarness />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	mock.restore();
	clearToken();
	restoreDom();
});

const project: RecentTab = { type: "project", id: "p1", title: "Acme App", lastVisitedAt: 1 };

test("an open swipe menu shows the project details its own read brings in", async () => {
	await act(async () => setTabs([project]));
	await act(async () => open(project));
	expect(host.querySelector('[data-testid="row-menu"]')).not.toBeNull();
	expect(host.textContent).not.toContain("running");
	// Opening the details read that one key; it answers while the menu stays open.
	const read = requests.at(-1);
	expect(read?.keys).toEqual(["project:p1"]);
	await act(async () =>
		read?.resolve({
			revision: 0,
			patches: [
				{
					key: "project:p1",
					patch: {
						projectPath: "/repos/acme-app",
						activeSessionCount: 2,
						waitingSessionCount: 1,
						teamCount: 1,
					},
				},
			],
		}),
	);
	expect(host.textContent).toContain("/repos/acme-app");
	expect(host.textContent).toContain("2 session(s) running");
	expect(host.textContent).toContain("1 waiting for input or approval");
});

test("a row that leaves the list closes its menu", async () => {
	const session: RecentTab = { type: "narrator", id: "n1", title: "Session", lastVisitedAt: 1 };
	await act(async () => setTabs([session]));
	await act(async () => open(session));
	expect(host.querySelector('[data-testid="row-menu"]')).not.toBeNull();
	await act(async () => setTabs([]));
	expect(host.querySelector('[data-testid="row-menu"]')).toBeNull();
	// Back in the list, it does not reopen by itself.
	await act(async () => setTabs([session]));
	expect(host.querySelector('[data-testid="row-menu"]')).toBeNull();
});
