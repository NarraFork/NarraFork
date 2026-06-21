import { describe, expect, test } from "bun:test";
import { buildGroupTitle } from "../chat-group-title";

describe("buildGroupTitle", () => {
	test("single handle", () => {
		expect(buildGroupTitle(["alice"])).toBe("@alice");
	});

	test("two handles joined with comma", () => {
		expect(buildGroupTitle(["alice", "bob"])).toBe("@alice, @bob");
	});

	test("three handles shown fully", () => {
		expect(buildGroupTitle(["alice", "bob", "carol"])).toBe("@alice, @bob, @carol");
	});

	test("more than three collapses with +N", () => {
		expect(buildGroupTitle(["alice", "bob", "carol", "dave"])).toBe("@alice, @bob, @carol +1");
		expect(buildGroupTitle(["a", "b", "c", "d", "e"])).toBe("@a, @b, @c +2");
	});

	test("trims and skips blank handles", () => {
		expect(buildGroupTitle([" alice ", "", "  "])).toBe("@alice");
	});

	test("empty list falls back to a default title", () => {
		expect(buildGroupTitle([])).toBe("Group chat");
		expect(buildGroupTitle(["", "   "])).toBe("Group chat");
	});
});
