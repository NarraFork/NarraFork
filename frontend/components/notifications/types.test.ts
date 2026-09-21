import { describe, expect, test } from "bun:test";
import type { NotificationListItem } from "@shared/notification-center";
import {
	filterItemsForDisplay,
	formatUnreadBadge,
	listQueryParams,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	notificationNavigateTarget,
	notificationQueryKeys,
} from "./types";

function item(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
	return {
		id: "n1",
		kind: "chat_message",
		projectId: null,
		chapterId: null,
		narratorId: null,
		title: "Hello",
		preview: "body",
		link: { type: "chat_room", roomId: "room-1" },
		sourceKey: "msg-1",
		status: "unread",
		displayStatus: "unread",
		createdAt: 1_700_000_000_000,
		readAt: null,
		...overrides,
	};
}

describe("WS type constant", () => {
	test("stays notification_center_changed (spec §6.1)", () => {
		expect(NOTIFICATION_CENTER_CHANGED_WS_TYPE).toBe("notification_center_changed");
	});
});

describe("listQueryParams", () => {
	test("all → status=all without kind", () => {
		expect(listQueryParams("all")).toEqual({ status: "all" });
	});

	test("messages → chat_message", () => {
		expect(listQueryParams("messages")).toEqual({ kind: "chat_message", status: "all" });
	});

	test("permissions / actionable → permission_request", () => {
		expect(listQueryParams("permissions")).toEqual({ kind: "permission_request", status: "all" });
		expect(listQueryParams("actionable")).toEqual({ kind: "permission_request", status: "all" });
	});
});

describe("filterItemsForDisplay", () => {
	test("actionable keeps only live permission rows", () => {
		const rows = [
			item({
				id: "p-live",
				kind: "permission_request",
				link: { type: "narrator", narratorId: "n1" },
			}),
			item({
				id: "p-resolved",
				kind: "permission_request",
				displayStatus: "resolved",
				link: { type: "narrator", narratorId: "n1" },
			}),
			item({
				id: "p-gone",
				kind: "permission_request",
				displayStatus: "gone",
				link: { type: "narrator", narratorId: "n1" },
			}),
			item({ id: "chat", kind: "chat_message" }),
			item({
				id: "p-dead-src",
				kind: "permission_request",
				sourceAlive: false,
				link: { type: "narrator", narratorId: "n1" },
			}),
		];
		const filtered = filterItemsForDisplay("actionable", rows);
		expect(filtered.map((r) => r.id)).toEqual(["p-live"]);
	});

	test("non-actionable filters do not drop rows", () => {
		const rows = [item({ id: "a" }), item({ id: "b", displayStatus: "gone" })];
		expect(filterItemsForDisplay("all", rows)).toHaveLength(2);
		expect(filterItemsForDisplay("messages", rows)).toHaveLength(2);
	});
});

describe("notificationNavigateTarget", () => {
	test("chat_room → roomId", () => {
		expect(
			notificationNavigateTarget({
				link: { type: "chat_room", roomId: "room-9" },
				displayStatus: "unread",
			}),
		).toEqual({ type: "chat_room", roomId: "room-9" });
	});

	test("narrator → narratorId", () => {
		expect(
			notificationNavigateTarget({
				link: { type: "narrator", narratorId: "nar-3" },
				displayStatus: "read",
			}),
		).toEqual({ type: "narrator", narratorId: "nar-3" });
	});

	test("gone yields null; resolved with live link stays navigable (M1)", () => {
		expect(
			notificationNavigateTarget({
				link: { type: "narrator", narratorId: "nar-3" },
				displayStatus: "gone",
			}),
		).toBeNull();
		expect(
			notificationNavigateTarget({
				link: { type: "chat_room", roomId: "room-9" },
				displayStatus: "unread",
				sourceAlive: false,
			}),
		).toBeNull();
		// Permission already decided: still open the narrator session.
		expect(
			notificationNavigateTarget({
				link: { type: "narrator", narratorId: "nar-3" },
				displayStatus: "resolved",
				sourceAlive: true,
			}),
		).toEqual({ type: "narrator", narratorId: "nar-3" });
		expect(
			notificationNavigateTarget({
				link: { type: "narrator", narratorId: "nar-3" },
				displayStatus: "resolved",
				sourceAlive: false,
			}),
		).toEqual({ type: "narrator", narratorId: "nar-3" });
	});
});

describe("formatUnreadBadge", () => {
	test("zero/undefined → null", () => {
		expect(formatUnreadBadge(0)).toBeNull();
		expect(formatUnreadBadge(undefined)).toBeNull();
		expect(formatUnreadBadge(null)).toBeNull();
	});

	test("exact under cap renders number", () => {
		expect(formatUnreadBadge(7)).toBe("7");
		expect(formatUnreadBadge(99)).toBe("99");
	});

	test("lowerBound or over cap → 99+", () => {
		expect(formatUnreadBadge(99, true)).toBe("99+");
		expect(formatUnreadBadge(120, false)).toBe("99+");
		expect(formatUnreadBadge(100)).toBe("99+");
	});
});

describe("notificationQueryKeys", () => {
	test("list and unread-count nest under notifications root", () => {
		expect(notificationQueryKeys.unreadCount()).toEqual(["notifications", "unread-count"]);
		expect(notificationQueryKeys.list({ kind: "chat_message", status: "all" })).toEqual([
			"notifications",
			"list",
			{ kind: "chat_message", status: "all" },
		]);
		expect(notificationQueryKeys.root).toEqual(["notifications"]);
	});
});
