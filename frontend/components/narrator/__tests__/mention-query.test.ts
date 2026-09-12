import { describe, expect, test } from "bun:test";
import { getMentionQuery } from "../composer/MentionPopover";

describe("getMentionQuery", () => {
	test("detects a mention at the start of input", () => {
		// caret right after "@al"
		expect(getMentionQuery("@al", 3)).toBe("al");
	});

	test("returns empty string right after @", () => {
		expect(getMentionQuery("hi @", 4)).toBe("");
	});

	test("detects a mention after whitespace", () => {
		expect(getMentionQuery("ping @bob", 9)).toBe("bob");
	});

	test("folds the partial handle (case-insensitive)", () => {
		expect(getMentionQuery("@Alice", 6)).toBe("alice");
		expect(getMentionQuery("@MyBot", 6)).toBe("mybot");
	});

	test("supports CJK partial handles", () => {
		expect(getMentionQuery("@小明", 3)).toBe("小明");
		expect(getMentionQuery("你好 @小明", 6)).toBe("小明");
	});

	test("detects a mention after CJK punctuation boundary", () => {
		// "你好，@小" — caret after 小
		expect(getMentionQuery("你好，@小", 5)).toBe("小");
	});

	test("returns null when @ is preceded by a non-boundary (email)", () => {
		expect(getMentionQuery("user@example", 12)).toBeNull();
	});

	test("returns null when there is no @ before the caret", () => {
		expect(getMentionQuery("hello world", 5)).toBeNull();
	});

	test("returns null when the token contains a disallowed char", () => {
		// caret after "@alice." — the '.' breaks the token
		expect(getMentionQuery("@alice.", 7)).toBeNull();
	});

	test("uses the last @ before the caret", () => {
		expect(getMentionQuery("@a @b", 5)).toBe("b");
	});

	test("only considers text up to the caret", () => {
		// caret after "@al", trailing "ice" is ignored
		expect(getMentionQuery("@alice", 3)).toBe("al");
	});

	test("supports hyphen and underscore in handles", () => {
		expect(getMentionQuery("@code-rev", 9)).toBe("code-rev");
		expect(getMentionQuery("@agent_0", 8)).toBe("agent_0");
	});

	test("returns null when the token starts with a hyphen or underscore", () => {
		// Mirrors the backend handle rule: first char must be a letter/digit.
		expect(getMentionQuery("@-foo", 5)).toBeNull();
		expect(getMentionQuery("@_foo", 5)).toBeNull();
	});
});
