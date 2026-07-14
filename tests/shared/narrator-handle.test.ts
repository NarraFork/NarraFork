import { describe, expect, test } from "bun:test";
import {
	extractMentionsWithCandidates,
	foldHandle,
	handleLength,
	hasMentionLike,
	isValidHandle,
} from "../../shared/narrator-handle";

describe("foldHandle", () => {
	test("lowercases ASCII for case-insensitive matching", () => {
		expect(foldHandle("MyBot")).toBe("mybot");
		expect(foldHandle("ALICE")).toBe("alice");
	});

	test("leaves CJK unchanged (no case) but NFC-normalizes", () => {
		expect(foldHandle("小明")).toBe("小明");
		// NFC: composed and decomposed forms fold equal.
		expect(foldHandle("é")).toBe(foldHandle("e\u0301"));
	});
});

describe("handleLength (code points)", () => {
	test("counts CJK as one each", () => {
		expect(handleLength("小明")).toBe(2);
		expect(handleLength("张三丰")).toBe(3);
	});
	test("counts astral chars as one", () => {
		expect(handleLength("😀")).toBe(1);
	});
});

describe("isValidHandle", () => {
	test("accepts CJK, mixed-case ASCII, digits, _ and -", () => {
		expect(isValidHandle("小明")).toBe(true);
		expect(isValidHandle("MyBot")).toBe(true);
		expect(isValidHandle("code-rev")).toBe(true);
		expect(isValidHandle("agent_007")).toBe(true);
		expect(isValidHandle("张三-1")).toBe(true);
	});

	test("rejects too-short / too-long (code points)", () => {
		expect(isValidHandle("a")).toBe(false);
		expect(isValidHandle("小")).toBe(false);
		expect(isValidHandle("a".repeat(33))).toBe(false);
		expect(isValidHandle("字".repeat(33))).toBe(false);
	});

	test("rejects handles not starting with a letter/digit", () => {
		expect(isValidHandle("-foo")).toBe(false);
		expect(isValidHandle("_foo")).toBe(false);
	});

	test("rejects disallowed chars (punctuation, spaces, emoji)", () => {
		expect(isValidHandle("小明！")).toBe(false);
		expect(isValidHandle("a b")).toBe(false);
		expect(isValidHandle("emoji😀")).toBe(false);
		expect(isValidHandle("a.b")).toBe(false);
	});
});

describe("hasMentionLike", () => {
	test("true for ASCII, mixed-case, and CJK mentions", () => {
		expect(hasMentionLike("@alice hi")).toBe(true);
		expect(hasMentionLike("hi @Bob")).toBe(true);
		expect(hasMentionLike("@小明 帮忙")).toBe(true);
		expect(hasMentionLike("你好，@小明")).toBe(true);
	});
	test("false for emails and non-boundary @", () => {
		expect(hasMentionLike("user@example.com")).toBe(false);
		expect(hasMentionLike("foo@bar")).toBe(false);
	});
	test("false when @ is followed by non-start char or nothing", () => {
		expect(hasMentionLike("@ hi")).toBe(false);
		expect(hasMentionLike("@-x")).toBe(false);
		expect(hasMentionLike("trailing @")).toBe(false);
	});
});

describe("extractMentionsWithCandidates (case-insensitive longest-match)", () => {
	const candidates = new Set(["小明", "小明帮", "mybot", "alice", "code-rev"]);

	test("matches ASCII handles case-insensitively (returns folded)", () => {
		expect(extractMentionsWithCandidates("@MyBot @Alice", candidates)).toEqual(["mybot", "alice"]);
		expect(extractMentionsWithCandidates("@ALICE hi", candidates)).toEqual(["alice"]);
	});

	test("CJK longest-match resolves the no-separator ambiguity", () => {
		// "小明帮" registered → longest wins over "小明".
		expect(extractMentionsWithCandidates("@小明帮我看看", candidates)).toEqual(["小明帮"]);
		// A boundary after "小明" → matches "小明".
		expect(extractMentionsWithCandidates("你好 @小明 在吗", candidates)).toEqual(["小明"]);
	});

	test("matches handles with hyphens", () => {
		expect(extractMentionsWithCandidates("@code-rev 看下", candidates)).toEqual(["code-rev"]);
	});

	test("de-duplicates preserving first-seen order", () => {
		expect(extractMentionsWithCandidates("@小明 @小明帮 @小明", candidates)).toEqual([
			"小明",
			"小明帮",
		]);
	});

	test("ignores unregistered handles", () => {
		expect(extractMentionsWithCandidates("ping @unknown", candidates)).toEqual([]);
	});

	test("returns empty when candidate set is empty", () => {
		expect(extractMentionsWithCandidates("@alice", new Set())).toEqual([]);
	});

	test("does not treat emails as mentions", () => {
		expect(extractMentionsWithCandidates("mail alice@example.com", candidates)).toEqual([]);
	});
});
