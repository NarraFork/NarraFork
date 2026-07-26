import { describe, expect, test } from "bun:test";
import { forkChapterSchema } from "../chapters";

describe("forkChapterSchema rejects empty-string optional ID/SHA fields", () => {
	test("forkAtMessageUuid rejects empty string", () => {
		expect(() => forkChapterSchema.parse({ forkAtMessageUuid: "" })).toThrow();
	});

	test("forkAtMessageId rejects empty string", () => {
		expect(() => forkChapterSchema.parse({ forkAtMessageId: "" })).toThrow();
	});

	test("startCommitSha rejects empty string", () => {
		expect(() => forkChapterSchema.parse({ startCommitSha: "" })).toThrow();
	});

	test("parentChapterId rejects empty string", () => {
		expect(() => forkChapterSchema.parse({ parentChapterId: "" })).toThrow();
	});

	test("anchorCommitSha rejects empty string", () => {
		expect(() => forkChapterSchema.parse({ anchorCommitSha: "" })).toThrow();
	});

	test("valid non-empty strings pass", () => {
		const result = forkChapterSchema.parse({
			forkAtMessageUuid: "abc123",
			startCommitSha: "deadbeef",
			parentChapterId: "ch_xyz",
		});
		expect(result.forkAtMessageUuid).toBe("abc123");
		expect(result.startCommitSha).toBe("deadbeef");
		expect(result.parentChapterId).toBe("ch_xyz");
	});

	test("omitted fields pass (undefined is valid)", () => {
		const result = forkChapterSchema.parse({});
		expect(result.forkAtMessageUuid).toBeUndefined();
		expect(result.forkAtMessageId).toBeUndefined();
		expect(result.startCommitSha).toBeUndefined();
		expect(result.parentChapterId).toBeUndefined();
	});
});
