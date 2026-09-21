import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { NotificationListPage, NotificationUnreadCounts } from "@shared/notification-center";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { notificationQueryKeys } from "./types";
import {
	flattenNotificationPages,
	markNotificationCenterStale,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	notificationFilterFromValue,
	useNotificationCenterLive,
	useNotificationList,
	useNotificationUnreadCounts,
} from "./useNotificationCenter";

const DOM_GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"requestAnimationFrame",
	"cancelAnimationFrame",
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
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		MutationObserver: class {
			observe() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		},
		IS_REACT_ACT_ENVIRONMENT: false,
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

function unreadCounts(overrides: Partial<NotificationUnreadCounts> = {}): NotificationUnreadCounts {
	return {
		total: 3,
		chat_message: 2,
		permission_request: 1,
		...overrides,
	};
}

function listPage(ids: string[]): NotificationListPage {
	return {
		items: ids.map((id, index) => ({
			id,
			kind: index === 0 ? ("permission_request" as const) : ("chat_message" as const),
			projectId: null,
			chapterId: null,
			narratorId: index === 0 ? "nar-1" : null,
			title: `Title ${id}`,
			preview: `Preview ${id}`,
			link:
				index === 0
					? { type: "narrator" as const, narratorId: "nar-1" }
					: { type: "chat_room" as const, roomId: `room-${id}` },
			sourceKey: `src-${id}`,
			status: "unread" as const,
			displayStatus: "unread" as const,
			createdAt: Date.now() - index * 1000,
			readAt: null,
		})),
		nextCursor: null,
	};
}

const originalUnread = api.getNotificationUnreadCounts;
const originalList = api.listNotifications;
const originalMarkRead = api.markNotificationsRead;

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

let unreadCalls = 0;
let listCalls: Array<Record<string, unknown>> = [];
const wsListeners: Array<{ types?: string[]; cb: (data: Record<string, unknown>) => void }> = [];
let connectionHandlers: Array<(connected: boolean, isReconnect: boolean) => void> = [];

function UnreadHarness() {
	const query = useNotificationUnreadCounts(true);
	return createElement("div", {
		"data-total": query.data?.total ?? "",
		"data-lower": query.data?.lowerBound ? "1" : "",
	});
}

function ListHarness({ filter }: { filter: "all" | "actionable" | "messages" }) {
	const query = useNotificationList(filter, true);
	return createElement("div", {
		"data-count": String(query.items.length),
		"data-ids": query.items.map((i) => i.id).join(","),
	});
}

function LiveHarness() {
	useNotificationCenterLive(true);
	return null;
}

beforeEach(async () => {
	restoreDom = installDom();
	unreadCalls = 0;
	listCalls = [];
	wsListeners.length = 0;
	connectionHandlers = [];

	api.getNotificationUnreadCounts = async () => {
		unreadCalls++;
		return unreadCounts();
	};
	api.listNotifications = async (params) => {
		listCalls.push({ ...(params ?? {}) });
		if (params?.kind === "permission_request") return listPage(["perm-1"]);
		if (params?.kind === "chat_message") return listPage(["msg-2"]);
		return listPage(["perm-1", "msg-2"]);
	};
	api.markNotificationsRead = async (body) => ({ updated: body.ids?.length ?? 1 });

	spyOn(narratorWSManager, "addListener").mockImplementation(((
		options: { types?: string[] },
		cb: (data: Record<string, unknown>) => void,
	) => {
		wsListeners.push({ types: options?.types, cb });
		return { _id: wsListeners.length, _narratorIds: [], _kind: "list" } as never;
	}) as never);
	spyOn(narratorWSManager, "removeListener").mockImplementation((() => {}) as never);
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation(((
		handler: (connected: boolean, isReconnect: boolean) => void,
	) => {
		connectionHandlers.push(handler);
		return () => {
			connectionHandlers = connectionHandlers.filter((h) => h !== handler);
		};
	}) as never);

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
	// Let React flush scheduled work while the DOM stubs still exist.
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

describe("flatten / filter coercion", () => {
	test("flatten concatenates pages", () => {
		expect(flattenNotificationPages([listPage(["a"]), listPage(["b"])]).map((i) => i.id)).toEqual([
			"a",
			"b",
		]);
		expect(flattenNotificationPages(undefined)).toEqual([]);
	});

	test("filter coercion defaults to all", () => {
		expect(notificationFilterFromValue("messages")).toBe("messages");
		expect(notificationFilterFromValue("nope")).toBe("all");
	});
});

describe("markNotificationCenterStale", () => {
	test("invalidates the notifications root", async () => {
		const client = queryClient as QueryClient;
		client.setQueryData(notificationQueryKeys.unreadCount(), unreadCounts());
		const original = client.invalidateQueries.bind(client);
		let hits = 0;
		spyOn(client, "invalidateQueries").mockImplementation(async (args) => {
			hits++;
			expect((args as { queryKey: unknown }).queryKey).toEqual(notificationQueryKeys.root);
			return original(args as never);
		});
		markNotificationCenterStale(client);
		await settle();
		expect(hits).toBe(1);
		spyOn(client, "invalidateQueries").mockRestore?.();
	});
});

describe("useNotificationUnreadCounts + WS", () => {
	test("loads badge total and coalesces WS frames into one invalidate", async () => {
		const client = queryClient as QueryClient;
		// UnreadHarness mounts useNotificationCenterLive itself — a second LiveHarness
		// would register a second listener and double-invalidate on purpose.
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient as QueryClient },
				createElement(UnreadHarness),
			),
		);
		await settle();
		expect(unreadCalls).toBeGreaterThanOrEqual(1);
		expect(container?.querySelector("[data-total]")?.getAttribute("data-total")).toBe("3");
		expect(wsListeners.length).toBeGreaterThan(0);
		expect(wsListeners[0]?.types).toContain(NOTIFICATION_CENTER_CHANGED_WS_TYPE);

		const invalidateSpy = spyOn(client, "invalidateQueries");
		for (const l of wsListeners) {
			l.cb({ type: NOTIFICATION_CENTER_CHANGED_WS_TYPE });
			l.cb({ type: NOTIFICATION_CENTER_CHANGED_WS_TYPE });
			l.cb({ type: NOTIFICATION_CENTER_CHANGED_WS_TYPE });
		}
		await settle();
		const notificationInvalidations = invalidateSpy.mock.calls.filter(
			(call) =>
				JSON.stringify((call[0] as { queryKey?: unknown })?.queryKey) ===
				JSON.stringify(notificationQueryKeys.root),
		);
		expect(notificationInvalidations.length).toBe(1);
		invalidateSpy.mockRestore();
	});

	test("reconnect (isReconnect) marks stale", async () => {
		const client = queryClient as QueryClient;
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient as QueryClient },
				createElement(LiveHarness),
			),
		);
		await settle();
		const invalidateSpy = spyOn(client, "invalidateQueries");
		for (const handler of connectionHandlers) handler(true, true);
		await settle();
		const hits = invalidateSpy.mock.calls.filter(
			(call) =>
				JSON.stringify((call[0] as { queryKey?: unknown })?.queryKey) ===
				JSON.stringify(notificationQueryKeys.root),
		);
		expect(hits.length).toBeGreaterThanOrEqual(1);
		invalidateSpy.mockRestore();
	});
});

describe("useNotificationList filters", () => {
	test("all / messages / actionable request the right query params", async () => {
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient as QueryClient },
				createElement(ListHarness, { filter: "all" }),
			),
		);
		await settle();
		expect(listCalls.some((c) => c.kind === undefined && c.status === "all")).toBe(true);

		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient as QueryClient },
				createElement(ListHarness, { filter: "messages" }),
			),
		);
		await settle();
		expect(listCalls.some((c) => c.kind === "chat_message")).toBe(true);

		listCalls = [];
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient as QueryClient },
				createElement(ListHarness, { filter: "actionable" }),
			),
		);
		await settle();
		expect(listCalls.some((c) => c.kind === "permission_request")).toBe(true);
		const ids = container?.querySelector("[data-ids]")?.getAttribute("data-ids") ?? "";
		expect(ids.split(",").every((id) => id.startsWith("perm-") || id === "")).toBe(true);
	});
});
