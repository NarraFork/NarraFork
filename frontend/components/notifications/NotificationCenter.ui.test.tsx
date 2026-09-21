import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { NotificationListPage, NotificationUnreadCounts } from "@shared/notification-center";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import navEn from "../../locales/en/nav.json";
import navZh from "../../locales/zh-CN/nav.json";
import { NotificationBell } from "./NotificationBell";
import { NotificationCenterDrawer } from "./NotificationCenterDrawer";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	initImmediate: false,
	interpolation: { escapeValue: false },
	resources: {
		en: { nav: navEn },
		"zh-CN": { nav: navZh },
	},
});

const DOM_GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Event",
	"localStorage",
	"sessionStorage",
	"matchMedia",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"ResizeObserver",
	"MutationObserver",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

function installDom(): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_GLOBAL_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const store = new Map<string, string>();
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		sessionStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		getComputedStyle: () => ({ getPropertyValue: () => "", boxSizing: "border-box" }),
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		MutationObserver: class {
			observe() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const key of DOM_GLOBAL_KEYS) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: previous.get(key)?.enumerable ?? true,
			writable: true,
			value: values[key],
		});
	}
	return () => {
		for (const key of [...DOM_GLOBAL_KEYS].reverse()) {
			const descriptor = previous.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function sampleItem(overrides: Partial<NotificationListPage["items"][number]> = {}) {
	return {
		id: "n-chat",
		kind: "chat_message" as const,
		projectId: null,
		chapterId: null,
		narratorId: null,
		title: "Alice",
		preview: "Hey there",
		link: { type: "chat_room" as const, roomId: "room-42" },
		sourceKey: "msg-42",
		status: "unread" as const,
		displayStatus: "unread" as const,
		createdAt: Date.now() - 60_000,
		readAt: null,
		...overrides,
	};
}

const originalUnread = api.getNotificationUnreadCounts;
const originalList = api.listNotifications;
const originalMarkRead = api.markNotificationsRead;

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let navigations: unknown[] = [];
let listPayload: NotificationListPage = { items: [], nextCursor: null };
let unreadPayload: NotificationUnreadCounts = {
	total: 0,
	chat_message: 0,
	permission_request: 0,
};

type TestRouter = ReturnType<typeof testRouter>;

function testRouter() {
	const rootRoute = createRootRoute({ component: () => null as never });
	return createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
}

async function renderWithProviders(ui: ReactNode) {
	if (!root || !queryClient) throw new Error("harness missing");
	const router: TestRouter = testRouter();
	const originalNavigate = router.navigate.bind(router);
	router.navigate = (async (opts: never) => {
		navigations.push(opts);
		return originalNavigate(opts);
	}) as typeof router.navigate;
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient as QueryClient}>
				<I18nextProvider i18n={i18n}>
					<RouterContextProvider router={router}>
						<MantineProvider env="test">{ui}</MantineProvider>
					</RouterContextProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
	await settle();
}

beforeEach(async () => {
	restoreDom = installDom();
	navigations = [];
	listPayload = { items: [], nextCursor: null };
	unreadPayload = { total: 0, chat_message: 0, permission_request: 0 };

	api.getNotificationUnreadCounts = async () => unreadPayload;
	api.listNotifications = async () => listPayload;
	api.markNotificationsRead = async (body) => ({ updated: body.ids?.length ?? 0 });

	spyOn(narratorWSManager, "addListener").mockImplementation((() => ({
		_id: 1,
		_narratorIds: [],
		_kind: "list",
	})) as never);
	spyOn(narratorWSManager, "removeListener").mockImplementation((() => {}) as never);
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation((() => () => {}) as never);

	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 0 },
			mutations: { retry: false },
		},
	});
	container = document.createElement("div") as HTMLDivElement;
	document.body.appendChild(container);
	root = createRoot(container);
	await settle();
});

afterEach(async () => {
	await settle();
	root?.unmount();
	await settle();
	container?.remove();
	queryClient?.clear();
	api.getNotificationUnreadCounts = originalUnread;
	api.listNotifications = originalList;
	api.markNotificationsRead = originalMarkRead;
	restoreDom?.();
	restoreDom = null;
});

function textOf(sel: string): string {
	return container?.querySelector(sel)?.textContent ?? "";
}

describe("NotificationBell badge", () => {
	test("hides numeric badge when unread is zero", async () => {
		unreadPayload = { total: 0, chat_message: 0, permission_request: 0 };
		await renderWithProviders(<NotificationBell />);
		expect(container?.querySelector('[data-testid="notification-bell"]')).not.toBeNull();
		expect(textOf('[data-testid="notification-bell-badge"]')).not.toContain("0");
	});

	test("shows numeric badge under cap", async () => {
		unreadPayload = { total: 7, chat_message: 5, permission_request: 2 };
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("7");
	});

	test("shows 99+ when lowerBound/capped", async () => {
		unreadPayload = { total: 99, chat_message: 50, permission_request: 49, lowerBound: true };
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("99+");
	});
});

describe("NotificationCenterDrawer", () => {
	test("empty state + filters + no Approve/Deny in Phase 1", async () => {
		listPayload = { items: [], nextCursor: null };
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);
		expect(textOf('[data-testid="notification-empty"]')).toContain("No notifications");
		expect(container?.querySelector('[data-testid="notification-filter-control"]')).not.toBeNull();
		expect(textOf('[data-testid="notification-mark-all-read"]')).toContain("Mark all as read");
		expect(container?.innerHTML ?? "").not.toMatch(/Approve|Deny/i);
	});

	test("gone rows gray and not navigable; chat rows navigate to /messages?room=", async () => {
		const markReadIds: string[] = [];
		api.markNotificationsRead = async (body) => {
			if (body.ids) markReadIds.push(...body.ids);
			return { updated: body.ids?.length ?? 0 };
		};
		listPayload = {
			items: [
				sampleItem({
					id: "gone-1",
					displayStatus: "gone",
					title: "Expired perm",
					kind: "permission_request",
					link: { type: "narrator", narratorId: "nar-gone" },
				}),
				sampleItem({
					id: "chat-1",
					title: "Bob",
					link: { type: "chat_room", roomId: "room-99" },
				}),
			],
			nextCursor: null,
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);

		const rows = [...(container?.querySelectorAll('[data-testid="notification-list-item"]') ?? [])];
		expect(rows.length).toBe(2);
		const goneRow = rows.find((r) => r.getAttribute("data-notification-id") === "gone-1");
		const chatRow = rows.find((r) => r.getAttribute("data-notification-id") === "chat-1");
		expect(goneRow?.getAttribute("data-notification-gone")).toBe("true");
		expect(goneRow?.textContent ?? "").toContain("Expired");

		await act(async () => {
			(goneRow as HTMLElement).click();
		});
		await settle();
		expect(navigations.length).toBe(0);
		expect(markReadIds).not.toContain("gone-1");

		await act(async () => {
			(chatRow as HTMLElement).click();
		});
		await settle();
		expect(markReadIds).toContain("chat-1");
		expect(JSON.stringify(navigations)).toContain("room-99");
		expect(JSON.stringify(navigations)).toContain("/messages");
	});

	test("permission rows navigate to narrators/:id when alive", async () => {
		listPayload = {
			items: [
				sampleItem({
					id: "perm-1",
					kind: "permission_request",
					title: "Need permission",
					link: { type: "narrator", narratorId: "nar-77" },
					displayStatus: "unread",
				}),
			],
			nextCursor: null,
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);
		const row = container?.querySelector('[data-testid="notification-list-item"]') as HTMLElement;
		await act(async () => {
			row.click();
		});
		await settle();
		expect(JSON.stringify(navigations)).toContain("nar-77");
		expect(JSON.stringify(navigations)).toContain("/narrators/");
	});
});
