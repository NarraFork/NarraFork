import { describe, expect, test } from "bun:test";
import { hasMention } from "../mentions";

describe("hasMention (Unicode-aware existence gate)", () => {
	test("true for ASCII mentions", () => {
		expect(hasMention("ping @alice")).toBe(true);
		expect(hasMention("@bob and (@carol) please look")).toBe(true);
	});

	test("true for mixed-case mentions (must not be dropped)", () => {
		expect(hasMention("hi @Alice")).toBe(true);
		expect(hasMention("@MyBot help")).toBe(true);
	});

	test("true for CJK mentions (the head-line feature)", () => {
		expect(hasMention("@小明 帮我看看")).toBe(true);
		expect(hasMention("你好，@小明")).toBe(true);
		expect(hasMention("@小明帮忙")).toBe(true);
	});

	test("false when none", () => {
		expect(hasMention("no one here")).toBe(false);
		expect(hasMention("")).toBe(false);
	});

	test("does not treat email addresses as mentions", () => {
		expect(hasMention("email me at a@b.com")).toBe(false);
		expect(hasMention("contact user@example.com for help")).toBe(false);
	});

	test("ignores @ not preceded by a boundary", () => {
		expect(hasMention("foo@bar")).toBe(false);
	});

	test("ignores @ followed by a non-handle-start char", () => {
		expect(hasMention("@ hi")).toBe(false);
		expect(hasMention("@-nope")).toBe(false);
		expect(hasMention("@_nope")).toBe(false);
	});
});
