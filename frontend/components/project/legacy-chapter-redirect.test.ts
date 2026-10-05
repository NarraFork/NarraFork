import { describe, expect, test } from "bun:test";
import {
	canOperateLegacyResources,
	legacyRouteErrorKey,
	resolveLegacyChapterTarget,
} from "./legacy-chapter-redirect";

describe("legacy chapter deep links", () => {
	test("recovery fails closed without verified ACL and preserves write-member operations", () => {
		expect(canOperateLegacyResources(undefined, "user")).toBe(false);
		expect(
			canOperateLegacyResources(
				{ canManage: false, members: [{ userId: "user", role: "read" }] },
				"user",
			),
		).toBe(false);
		expect(
			canOperateLegacyResources(
				{ canManage: false, members: [{ userId: "other", role: "write" }] },
				"user",
			),
		).toBe(false);
		expect(
			canOperateLegacyResources(
				{ canManage: false, members: [{ userId: "user", role: "write" }] },
				"user",
			),
		).toBe(true);
		expect(canOperateLegacyResources({ canManage: true, members: [] }, undefined)).toBe(true);
	});
	test("locates primary session, preserving the message hash and origin", () => {
		expect(
			resolveLegacyChapterTarget(
				[
					{ id: "subagent", variant: "subagent:explore" },
					{ id: "session", variant: "primary" },
				],
				"search",
				"msg-old-message",
			),
		).toEqual({
			to: "/narrators/$narratorId",
			params: { narratorId: "session" },
			search: { from: "search" },
			hash: "msg-old-message",
			replace: true,
		});
	});
	test("does not choose a subagent or manufacture a primary for empty resources", () => {
		expect(resolveLegacyChapterTarget([])).toBeNull();
		expect(resolveLegacyChapterTarget([{ id: "sub", variant: "subagent:general" }])).toBeNull();
	});
	test("omits absent navigation state", () => {
		expect(resolveLegacyChapterTarget([{ id: "primary", variant: "primary" }])).toMatchObject({
			search: {},
			hash: undefined,
		});
	});
	test.each([401, 403])("permission %i has a terminal denied state", (status) => {
		expect(legacyRouteErrorKey({ status })).toBe("denied");
	});
	test("missing and failed loads have distinct terminal states", () => {
		expect(legacyRouteErrorKey({ status: 404 })).toBe("missing");
		expect(legacyRouteErrorKey(new Error("offline"))).toBe("error");
		expect(legacyRouteErrorKey(null)).toBe("error");
	});
});
