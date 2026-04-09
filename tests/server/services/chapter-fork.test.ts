import { describe, expect, it } from "bun:test";
import { slugify } from "../../../server/lib/slug";

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

	it("preserves CJK characters (Unicode support)", () => {
		expect(slugify("测试 feature")).toBe("测试-feature");
	});

	it("handles empty string with fallback", () => {
		expect(slugify("")).toBe("chapter");
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
