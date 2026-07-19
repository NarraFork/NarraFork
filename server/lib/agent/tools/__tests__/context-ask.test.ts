import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../../../db";
import { narratorMessageRefs, narrators } from "../../../../db/schema";
import { contextAskService } from "../../../../services/context-ask-service";
import type { ToolContext } from "../../types";
import { contextAskTool } from "../context-ask";

const suffix = Date.now().toString(36);
const parentId = `context-parent-${suffix}`;
const childId = `context-child-${suffix}`;
const siblingId = `context-sibling-${suffix}`;
const outsideParentId = `context-outside-parent-${suffix}`;
const outsideChildId = `context-outside-child-${suffix}`;
const narratorIds = [parentId, childId, siblingId, outsideParentId, outsideChildId];
const originalAsk = contextAskService.ask;

function makeCtx(narratorId: string): ToolContext {
	return {
		narratorId,
		cwd: process.cwd(),
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{
			id: parentId,
			title: "Context parent",
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: childId,
			title: "Context child",
			type: "subagent",
			variant: "subagent:explore",
			parentNarratorId: parentId,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: siblingId,
			title: "Context sibling",
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: parentId,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: outsideParentId,
			title: "Outside parent",
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: outsideChildId,
			title: "Outside child",
			type: "subagent",
			variant: "subagent:explore",
			parentNarratorId: outsideParentId,
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterEach(() => {
	contextAskService.ask = originalAsk;
	mock.restore();
});

afterAll(async () => {
	await db.delete(narrators).where(inArray(narrators.id, narratorIds));
});

describe("ContextAsk tool", () => {
	test("queries one accessible child without modifying the target history", async () => {
		const refsBefore = await db
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, [childId]));
		contextAskService.ask = mock(async (input) => ({
			answer: "The child changed server/a.ts.",
			target: { id: input.targetNarratorId, title: "Context child", status: "working" },
			questions: input.questions ?? [],
			messageCount: 3,
			hasMore: false,
			sourceBytes: 128,
			sourceTruncated: false,
			toolCallsTruncated: false,
			chunkCount: 1,
			contextPercent: 10,
		}));

		const result = await contextAskTool.execute(
			{ id: childId, questions: ["Which files changed?"] },
			makeCtx(parentId),
		);
		const refsAfter = await db
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, [childId]));

		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("server/a.ts");
		expect(result.metadata).toMatchObject({
			kind: "context_ask",
			target: { id: childId },
			questions: ["Which files changed?"],
		});
		expect(refsAfter).toEqual(refsBefore);
		expect(contextAskService.ask).toHaveBeenCalledWith(
			expect.objectContaining({
				callerNarratorId: parentId,
				targetNarratorId: childId,
			}),
		);
	});

	test("allows a subagent to query a sibling but rejects self and cross-team targets", async () => {
		contextAskService.ask = mock(async (input) => ({
			answer: "Sibling context",
			target: { id: input.targetNarratorId, title: "Context child", status: "idle" },
			questions: input.questions ?? [],
			messageCount: 1,
			hasMore: false,
			sourceBytes: 32,
			sourceTruncated: false,
			toolCallsTruncated: false,
			chunkCount: 1,
		}));

		const sibling = await contextAskTool.execute({ id: childId }, makeCtx(siblingId));
		expect(sibling.isError).toBeFalsy();

		const self = await contextAskTool.execute({ id: siblingId }, makeCtx(siblingId));
		expect(self.isError).toBe(true);
		expect(self.output).toContain("cannot target themselves");

		const outside = await contextAskTool.execute({ id: outsideChildId }, makeCtx(parentId));
		expect(outside.isError).toBe(true);
		expect(outside.output).toContain("does not belong to this narrator's subagent team");
	});
});
