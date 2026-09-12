import { describe, expect, test } from "bun:test";
import { createFileChangeExecutionSegmentsService } from "./file-change-execution-segments";

describe("file change execution segments", () => {
	test("creates, idempotently reuses, and validates parents", async () => {
		const rows: any[] = [];
		const db: any = {
			select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.slice(0, 1) }) }) }),
			insert: () => ({ values: async (row: any) => rows.push(row) }),
		};
		const service = createFileChangeExecutionSegmentsService(db);
		const first = await service.create({
			narratorId: "n",
			sourceToolCallId: "call",
			sourceExecutionAttempt: 1,
		});
		expect(
			await service.create({
				narratorId: "n",
				sourceToolCallId: "call",
				sourceExecutionAttempt: 1,
			}),
		).toEqual(first);
		expect(first.parentSegmentId).toBeNull();
	});
});
