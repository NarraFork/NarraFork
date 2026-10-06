import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { HumanAttentionPage } from "@shared/human-attention";
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
import narratorEn from "../../locales/en/narrator.json";
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
		en: { nav: navEn, narrator: narratorEn },
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
	await act(async () => {
		for (let turn = 0; turn < 4; turn++) {
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
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
		groupKey: overrides.id ?? "n-chat",
		notificationIds: [overrides.id ?? "n-chat"],
		groupSize: 1,
		projectTitle: null,
		chapterTitle: null,
		sourceState: "active" as const,
		createdAt: Date.now() - 60_000,
		readAt: null,
		...overrides,
	};
}

const originalAttention = api.getHumanAttention;
let attentionPayload: HumanAttentionPage = { items: [], nextCursor: null };
const originalUnread = api.getNotificationUnreadCounts;
const originalList = api.listNotifications;
const originalMarkRead = api.markNotificationsRead;

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let navigations: unknown[] = [];
let listPayload: NotificationListPage = { items: [], nextCursor: null, asOf: 1234 };
let unreadPayload: NotificationUnreadCounts = {
	unreadConversations: 0,
	unreadActivities: 0,
	conversationsLowerBound: false,
	activitiesLowerBound: false,
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
	listPayload = { items: [], nextCursor: null, asOf: 1234 };
	unreadPayload = {
		unreadConversations: 0,
		unreadActivities: 0,
		conversationsLowerBound: false,
		activitiesLowerBound: false,
	};

	attentionPayload = { items: [], nextCursor: null };
	api.getHumanAttention = async () => attentionPayload;
	api.getNotificationUnreadCounts = async () => unreadPayload;
	api.listNotifications = async () => listPayload;
	api.markNotificationsRead = async (body) => ({
		updated: body.scope === "items" ? body.ids.length : 0,
	});

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
	await act(async () => root?.unmount());
	await settle();
	container?.remove();
	queryClient?.clear();
	api.getHumanAttention = originalAttention;
	api.getNotificationUnreadCounts = originalUnread;
	api.listNotifications = originalList;
	api.markNotificationsRead = originalMarkRead;
	restoreDom?.();
	restoreDom = null;
});

function textOf(sel: string): string {
	return container?.querySelector(sel)?.textContent ?? "";
}

function pendingItem(id: string, question = false): HumanAttentionPage["items"][number] {
	return {
		id,
		kind: question ? "async_question" : "permission",
		source: question ? "question" : "permission",
		requestId: id,
		toolCallId: id,
		toolName: question ? "AskUserQuestion" : "Bash",
		narratorId: `owner-${id}`,
		narratorTitle: "Actual owner",
		parentNarratorId: null,
		rootNarratorId: null,
		chapterId: null,
		createdAt: new Date().toISOString(),
		blocking: !question,
		canAct: false,
		summary: `Review ${id}`,
	};
}

async function clickElement(selector: string) {
	const element = document.querySelector<HTMLElement>(selector);
	expect(element).not.toBeNull();
	await act(async () => element?.click());
	await settle();
}

async function clickText(text: string) {
	const element = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === text,
	);
	expect(element).toBeDefined();
	await act(async () => element?.click());
	await settle();
}

describe("new center integration", () => {
	test("pending authority wins over unread history, reuses rows and closes on actual owner navigation", async () => {
		attentionPayload = {
			items: [pendingItem("question", true), pendingItem("permission")],
			nextCursor: "more",
		};
		unreadPayload = {
			unreadConversations: 8,
			unreadActivities: 99,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		};
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("2+");
		expect(
			document.querySelector('[data-testid="notification-bell"]')?.getAttribute("aria-label"),
		).toContain("pending items");
		await clickElement('[data-testid="notification-bell"]');
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		expect(
			[...document.querySelectorAll("[data-attention-id]")].map((row) =>
				row.getAttribute("data-attention-id"),
			),
		).toEqual(["permission", "question"]);
		expect(document.querySelector('[data-testid="notification-mark-all-read"]')).toBeNull();
		expect(document.body.textContent).toContain(narratorEn.humanAttentionReadOnly);
		const owner = document.querySelector(
			'[data-attention-id="question"] button:last-child',
		) as HTMLElement;
		await act(async () => owner.click());
		await settle();
		expect(JSON.stringify(navigations)).toContain("owner-question");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	test("0+ pending lower bound opens loadable empty candidate page", async () => {
		attentionPayload = { items: [], nextCursor: "candidate-next" };
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("0+");
		await clickElement('[data-testid="notification-bell"]');
		expect(document.body.textContent).toContain(narratorEn.humanAttentionLoadMore);
		expect(document.body.textContent).not.toContain(narratorEn.humanAttentionEmpty);
	});

	test("both failed queries remain unknown and offer visible retries", async () => {
		api.getNotificationUnreadCounts = async () => {
			throw new Error("summary unavailable");
		};
		api.getHumanAttention = async () => {
			throw new Error("attention unavailable");
		};
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("?");
		await clickElement('[data-testid="notification-bell"]');
		expect(document.body.textContent).toContain(navEn.notificationCountUnknown);
		expect(document.body.textContent).toContain(narratorEn.humanAttentionLoadError);
		expect(document.body.textContent).not.toContain(narratorEn.humanAttentionEmpty);
	});

	test("activity bulk read uses server boundary/current kind, preserves pending authority and shows errors", async () => {
		attentionPayload = { items: [pendingItem("still-pending")], nextCursor: null };
		listPayload = {
			items: [sampleItem({ kind: "permission_request", sourceState: "resolved" })],
			nextCursor: null,
			asOf: 777,
		};
		const calls: unknown[] = [];
		api.markNotificationsRead = async (body) => {
			calls.push(body);
			throw new Error("read failed");
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);
		await clickElement('[data-filter="permissions"]');
		await clickElement('[data-testid="notification-mark-all-read"]');
		expect(calls).toEqual([{ scope: "all", before: 777, kind: "permission_request" }]);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			navEn.notificationMarkReadFailed,
		);
		await clickText(navEn.notificationTabAttention);
		expect(document.querySelector('[data-attention-id="still-pending"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="notification-mark-all-read"]')).toBeNull();
	});

	test("activity empty candidate page keeps load more and requests the cursor", async () => {
		const cursors: unknown[] = [];
		api.listNotifications = async (params) => {
			cursors.push(params?.cursor);
			return params?.cursor
				? { items: [sampleItem()], nextCursor: null, asOf: 1234 }
				: { items: [], nextCursor: "next", asOf: 1234 };
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);
		expect(document.querySelector('[data-testid="notification-empty"]')).toBeNull();
		await clickText(navEn.notificationLoadMore);
		expect(cursors).toEqual([null, "next"]);
		expect(document.querySelectorAll('[data-testid="notification-list-item"]')).toHaveLength(1);
	});

	test("group activation acknowledges only captured IDs, navigates and closes despite read failure", async () => {
		const calls: unknown[] = [];
		let closes = 0;
		listPayload = {
			items: [sampleItem({ notificationIds: ["old-a", "old-b"], groupSize: 2 })],
			nextCursor: null,
			asOf: 1234,
		};
		api.markNotificationsRead = async (body) => {
			calls.push(body);
			throw new Error("read failed");
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => closes++} />);
		expect(document.body.textContent).toContain("2 messages");
		await clickElement('[data-testid="notification-list-item"]');
		expect(calls).toEqual([{ scope: "items", ids: ["old-a", "old-b"] }]);
		expect(JSON.stringify(navigations)).toContain("room-42");
		expect(closes).toBe(1);
		expect(document.body.textContent).toContain(navEn.notificationMarkReadFailed);
	});

	test("read failure stays visible even after navigation unmounts the drawer", async () => {
		let rejectRead: (error: Error) => void = () => {};
		api.markNotificationsRead = () =>
			new Promise((_resolve, reject) => {
				rejectRead = reject;
			});
		listPayload = { items: [sampleItem()], nextCursor: null, asOf: 1234 };
		const toast = spyOn(notifications, "show").mockImplementation(() => "test-toast");
		try {
			await renderWithProviders(<NotificationBell />);
			await clickElement('[data-testid="notification-bell"]');
			await clickElement('[data-testid="notification-list-item"]');
			expect(document.querySelector('[role="dialog"]')).toBeNull();
			await act(async () => rejectRead(new Error("late read failure")));
			await settle();
			expect(toast).toHaveBeenCalledWith({
				color: "red",
				message: navEn.notificationMarkReadFailed,
			});
		} finally {
			toast.mockRestore();
		}
	});

	test("gone rows never reveal stale private context and remain markable without navigation", async () => {
		const calls: unknown[] = [];
		listPayload = {
			items: [
				sampleItem({
					sourceState: "gone",
					title: "secret",
					preview: "secret-body",
					projectTitle: "secret-project",
					chapterTitle: "secret-chapter",
				}),
			],
			nextCursor: null,
			asOf: 1234,
		};
		api.markNotificationsRead = async (body) => {
			calls.push(body);
			return { updated: 1 };
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);
		expect(document.body.textContent).not.toContain("secret");
		await clickText(navEn.notificationMarkRead);
		expect(calls).toEqual([{ scope: "items", ids: ["n-chat"] }]);
		expect(navigations).toHaveLength(0);
	});

	test("English and Chinese notification keys stay symmetric", () => {
		const keys = (object: Record<string, string>) =>
			Object.keys(object)
				.filter((key) => key.startsWith("notification"))
				.sort();
		expect(keys(navEn)).toEqual(keys(navZh));
	});
});

describe("NotificationBell badge", () => {
	test("hides numeric badge when unread is zero", async () => {
		unreadPayload = {
			unreadConversations: 0,
			unreadActivities: 0,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		};
		await renderWithProviders(<NotificationBell />);
		expect(container?.querySelector('[data-testid="notification-bell"]')).not.toBeNull();
		expect(textOf('[data-testid="notification-bell-badge"]')).not.toContain("0");
	});

	test("permission activity cap does not turn an exact DM count into a lower bound", async () => {
		unreadPayload = {
			unreadConversations: 3,
			unreadActivities: 99,
			conversationsLowerBound: false,
			activitiesLowerBound: true,
		};
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("3");
		expect(textOf('[data-testid="notification-bell-badge"]')).not.toContain("3+");
		expect(
			document.querySelector('[data-testid="notification-bell"]')?.getAttribute("aria-label"),
		).toContain("3 unread conversations");
	});

	test("shows numeric badge under cap", async () => {
		unreadPayload = {
			unreadConversations: 7,
			unreadActivities: 25,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		};
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("7");
	});

	test("shows 99+ when lowerBound/capped", async () => {
		unreadPayload = {
			unreadConversations: 99,
			unreadActivities: 99,
			conversationsLowerBound: true,
			activitiesLowerBound: true,
		};
		await renderWithProviders(<NotificationBell />);
		expect(textOf('[data-testid="notification-bell-badge"]')).toContain("99+");
	});
});

describe("NotificationCenterDrawer", () => {
	test("activity empty state has source filters, not duplicate approval forms", async () => {
		listPayload = { items: [], nextCursor: null, asOf: 1234 };
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);
		expect(textOf('[data-testid="notification-empty"]')).toContain("No notifications");
		expect(container?.querySelector('[data-testid="notification-filter-control"]')).not.toBeNull();
		expect(textOf('[data-testid="notification-mark-all-read"]')).toContain("Mark activity as read");
		expect(container?.innerHTML ?? "").not.toMatch(/Approve|Deny/i);
	});

	test("gone rows gray and not navigable; chat rows navigate to /messages?room=", async () => {
		const markReadIds: string[] = [];
		api.markNotificationsRead = async (body) => {
			if (body.scope === "items") markReadIds.push(...body.ids);
			return { updated: body.scope === "items" ? body.ids.length : 0 };
		};
		listPayload = {
			items: [
				sampleItem({
					id: "gone-1",
					sourceState: "gone",
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
			asOf: 1234,
		};
		await renderWithProviders(<NotificationCenterDrawer opened onClose={() => {}} />);

		const rows = [...(container?.querySelectorAll('[data-testid="notification-list-item"]') ?? [])];
		expect(rows.length).toBe(2);
		const goneRow = rows.find((r) => r.getAttribute("data-notification-id") === "gone-1");
		const chatRow = rows.find((r) => r.getAttribute("data-notification-id") === "chat-1");
		expect(goneRow?.getAttribute("data-notification-gone")).toBe("true");
		expect(goneRow?.textContent ?? "").toContain("Source unavailable");

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
					sourceState: "active",
				}),
			],
			nextCursor: null,
			asOf: 1234,
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
