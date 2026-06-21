import { describe, expect, test } from "bun:test";
import { extractMentions, hasMention } from "../mentions";

describe("extractMentions", () => {
	test("extracts a single mention at the start", () => {
		expect(extractMentions("@alice can you review this?")).toEqual(["alice"]);
	});

	test("extracts mentions after whitespace and punctuation", () => {
		expect(extractMentions("hey @bob and (@carol) please look")).toEqual(["bob", "carol"]);
	});

	test("normalizes to lowercase and de-duplicates preserving order", () => {
		expect(extractMentions("@Alice @BOB @alice @bob")).toEqual(["alice", "bob"]);
	});

	test("supports digits, underscores and hyphens", () => {
		expect(extractMentions("@code-reviewer @agent_007 @a1")).toEqual([
			"code-reviewer",
			"agent_007",
			"a1",
		]);
	});

	test("does not treat email addresses as mentions", () => {
		expect(extractMentions("contact user@example.com for help")).toEqual([]);
	});

	test("ignores @ not preceded by a boundary", () => {
		expect(extractMentions("foo@bar")).toEqual([]);
	});

	test("ignores too-short handles (single char)", () => {
		expect(extractMentions("@a")).toEqual([]);
	});

	test("ignores handles that start with a hyphen or underscore", () => {
		expect(extractMentions("@-nope @_nope")).toEqual([]);
	});

	test("returns empty for text without @", () => {
		expect(extractMentions("no mentions here")).toEqual([]);
		expect(extractMentions("")).toEqual([]);
	});

	test("stops the handle at disallowed characters", () => {
		expect(extractMentions("@alice.bob")).toEqual(["alice"]);
		expect(extractMentions("@alice!")).toEqual(["alice"]);
	});
});

describe("hasMention", () => {
	test("true when a mention exists", () => {
		expect(hasMention("ping @alice")).toBe(true);
	});
	test("false when none", () => {
		expect(hasMention("no one here")).toBe(false);
		expect(hasMention("email me at a@b.com")).toBe(false);
	});
});
