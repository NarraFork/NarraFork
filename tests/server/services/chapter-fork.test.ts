import { describe, expect, it } from "bun:test";
import { slugify } from "../../../server/services/chapter-fork";

describe("slugify", () => {
	it("lowercases and replaces spaces with hyphens", () => {
		expect(slugify("My Feature Branch")).toBe("my-feature-branch");
	});

	it("strips special characters", () => {
		expect(slugify("Fix: bug #123!")).toBe("fix-bug-123");
	});

	it("truncates to 30 chars", () => {
		const long = "a".repeat(50);
		expect(slugify(long)).toHaveLength(30);
	});

	it("strips leading/trailing hyphens", () => {
		expect(slugify("---hello---")).toBe("hello");
	});

	it("handles CJK by stripping them (non-ascii)", () => {
		expect(slugify("测试 feature")).toBe("feature");
	});

	it("handles empty string", () => {
		expect(slugify("")).toBe("");
	});
});

describe("branch naming", () => {
	it("follows chapter/slug-shortId pattern", () => {
		const slug = slugify("Experiment Alpha");
		const shortId = "abc123";
		const branch = `chapter/${slug}-${shortId}`;
		expect(branch).toBe("chapter/experiment-alpha-abc123");
	});

	it("another branch name", () => {
		const branch = `chapter/${slugify("Add Auth")}-xyz789`;
		expect(branch).toBe("chapter/add-auth-xyz789");
	});
});
