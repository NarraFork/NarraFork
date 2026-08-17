import { describe, expect, test } from "bun:test";
import {
	CHAPTER_DETACHED_PANELS_MAX_BYTES,
	CHAPTER_DOCK_LAYOUT_MAX_BYTES,
	forkChapterSchema,
	updateChapterDetachedPanelsSchema,
	updateChapterDockLayoutSchema,
} from "../chapters";

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
			startCommitSha: "deadbeef",
			worktreeSource: "commit",
			parentChapterId: "ch_xyz",
		});
		expect(result.startCommitSha).toBe("deadbeef");
		expect(result.worktreeSource).toBe("commit");
		expect(result.parentChapterId).toBe("ch_xyz");
	});

	test("omitted fields pass (undefined is valid)", () => {
		const result = forkChapterSchema.parse({});
		expect(result.forkAtMessageUuid).toBeUndefined();
		expect(result.forkAtMessageId).toBeUndefined();
		expect(result.startCommitSha).toBeUndefined();
		expect(result.worktreeSource).toBeUndefined();
		expect(result.parentChapterId).toBeUndefined();
	});
});

describe("forkChapterSchema coordinate conflicts", () => {
	test("rejects both message coordinates", () => {
		expect(
			forkChapterSchema.safeParse({
				forkAtMessageId: "msg-1",
				forkAtMessageUuid: "uuid-1",
			}).success,
		).toBe(false);
	});

	test("rejects a message coordinate with startCommitSha", () => {
		expect(
			forkChapterSchema.safeParse({
				forkAtMessageId: "msg-1",
				startCommitSha: "deadbeef",
				worktreeSource: "commit",
			}).success,
		).toBe(false);
	});

	test("rejects workspace with startCommitSha", () => {
		expect(
			forkChapterSchema.safeParse({
				startCommitSha: "deadbeef",
				worktreeSource: "workspace",
			}).success,
		).toBe(false);
	});
});

describe("updateChapterDockLayoutSchema", () => {
	test("accepts a serialized layout string", () => {
		const parsed = updateChapterDockLayoutSchema.safeParse({
			layout: JSON.stringify({ version: 1, layout: { panels: { chat: {} } } }),
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts null to reset a node to its default layout", () => {
		expect(updateChapterDockLayoutSchema.safeParse({ layout: null }).success).toBe(true);
	});

	test("rejects a layout past the size cap", () => {
		// The payload is client-supplied and grows with every open panel, so the
		// ceiling is what keeps one chapter row from holding an unbounded blob.
		expect(
			updateChapterDockLayoutSchema.safeParse({
				layout: "x".repeat(CHAPTER_DOCK_LAYOUT_MAX_BYTES + 1),
			}).success,
		).toBe(false);
	});

	test("accepts a layout exactly at the cap", () => {
		expect(
			updateChapterDockLayoutSchema.safeParse({
				layout: "x".repeat(CHAPTER_DOCK_LAYOUT_MAX_BYTES),
			}).success,
		).toBe(true);
	});

	test("rejects a missing or non-string layout field", () => {
		expect(updateChapterDockLayoutSchema.safeParse({}).success).toBe(false);
		expect(updateChapterDockLayoutSchema.safeParse({ layout: 42 }).success).toBe(false);
		expect(updateChapterDockLayoutSchema.safeParse({ layout: { a: 1 } }).success).toBe(false);
	});
});

describe("updateChapterDetachedPanelsSchema", () => {
	test("accepts a serialized panel list", () => {
		const parsed = updateChapterDetachedPanelsSchema.safeParse({
			panels: JSON.stringify({
				version: 1,
				panels: [{ id: "p1", kind: "terminal", x: 0, y: 0, w: 480, h: 360 }],
			}),
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts null when nothing is detached", () => {
		expect(updateChapterDetachedPanelsSchema.safeParse({ panels: null }).success).toBe(true);
	});

	test("rejects a payload past the size cap", () => {
		expect(
			updateChapterDetachedPanelsSchema.safeParse({
				panels: "x".repeat(CHAPTER_DETACHED_PANELS_MAX_BYTES + 1),
			}).success,
		).toBe(false);
	});

	test("accepts a payload exactly at the cap", () => {
		expect(
			updateChapterDetachedPanelsSchema.safeParse({
				panels: "x".repeat(CHAPTER_DETACHED_PANELS_MAX_BYTES),
			}).success,
		).toBe(true);
	});

	test("rejects a missing or non-string panels field", () => {
		expect(updateChapterDetachedPanelsSchema.safeParse({}).success).toBe(false);
		expect(updateChapterDetachedPanelsSchema.safeParse({ panels: 1 }).success).toBe(false);
		expect(updateChapterDetachedPanelsSchema.safeParse({ panels: [] }).success).toBe(false);
	});
});
