import { describe, expect, test } from "bun:test";
import { NOTIFICATION_CENTER_CHANGED_WS_TYPE as SHARED_WS_TYPE } from "@shared/notification-center";
import {
	formatUnreadBadge,
	listQueryParams,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	notificationNavigateTarget,
	notificationQueryKeys,
} from "./types";

describe("notification contracts", () => {
	test("uses the shared WS constant", () =>
		expect(NOTIFICATION_CENTER_CHANGED_WS_TYPE).toBe(SHARED_WS_TYPE));
	test("activity filters select only source kind, never a pending proxy", () => {
		expect(listQueryParams("all")).toEqual({ status: "all" });
		expect(listQueryParams("messages")).toEqual({ kind: "chat_message", status: "all" });
		expect(listQueryParams("permissions")).toEqual({ kind: "permission_request", status: "all" });
	});
	test("resolved navigates, gone and unavailable do not", () => {
		expect(
			notificationNavigateTarget({
				sourceState: "active",
				link: { type: "chat_room", roomId: "r" },
			}),
		).toEqual({ type: "chat_room", roomId: "r" });
		expect(
			notificationNavigateTarget({
				sourceState: "resolved",
				link: { type: "narrator", narratorId: "n" },
			}),
		).toEqual({ type: "narrator", narratorId: "n" });
		expect(
			notificationNavigateTarget({
				sourceState: "gone",
				link: { type: "narrator", narratorId: "n" },
			}),
		).toBeNull();
		expect(
			notificationNavigateTarget({ sourceState: "active", link: { type: "unavailable" } }),
		).toBeNull();
	});
	test("badge uses actual loaded lower bounds, including zero with more candidates", () => {
		expect(formatUnreadBadge(0)).toBeNull();
		expect(formatUnreadBadge(undefined)).toBeNull();
		expect(formatUnreadBadge(7)).toBe("7");
		expect(formatUnreadBadge(50, true)).toBe("50+");
		expect(formatUnreadBadge(0, true)).toBe("0+");
		expect(formatUnreadBadge(120)).toBe("120");
	});
	test("query keys retain independent activity sources", () => {
		expect(notificationQueryKeys.list(listQueryParams("messages"))).toEqual([
			"notifications",
			"list",
			{ kind: "chat_message", status: "all" },
		]);
		expect(notificationQueryKeys.unreadCount()).toEqual(["notifications", "unread-count"]);
	});
});
