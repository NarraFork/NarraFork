import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { fileChangeExecutionSegments, narrators, narratorToolCalls } from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import { logger } from "../lib/logger";
import { createFileChangeExecutionSegmentsService } from "./file-change-execution-segments";
import type { SubagentExecutionBoundary } from "./subagent-file-changes";

/** Durable receipt keyed by logical run, never by creation origin or result destination. */
const runSource = (runId: string) => `subagent-run:${runId}`;

export async function resolveSubagentExecutionSegment(
	childNarratorId: string,
	logicalRunId?: string | null,
) {
	const runId =
		logicalRunId === undefined
			? (
					await db.query.narrators.findFirst({
						where: eq(narrators.id, childNarratorId),
						columns: { logicalRunId: true },
					})
				)?.logicalRunId
			: logicalRunId;
	if (!runId) return null;
	const [segment] = await db
		.select()
		.from(fileChangeExecutionSegments)
		.where(
			and(
				eq(fileChangeExecutionSegments.narratorId, childNarratorId),
				eq(fileChangeExecutionSegments.sourceInputId, runSource(runId)),
			),
		)
		.limit(1);
	return segment ?? null;
}

export async function readSubagentExecutionBoundary(
	childNarratorId: string,
	logicalRunId?: string | null,
): Promise<SubagentExecutionBoundary | null> {
	try {
		return await readVerifiedSubagentExecutionBoundary(childNarratorId, logicalRunId);
	} catch (error) {
		// A missing receipt must not swallow the actual success/error conclusion.
		logger.warn("Failed to read subagent execution receipt", {
			childNarratorId,
			error: String(error),
		});
		return null;
	}
}

async function readVerifiedSubagentExecutionBoundary(
	childNarratorId: string,
	logicalRunId?: string | null,
): Promise<SubagentExecutionBoundary | null> {
	const segment = await resolveSubagentExecutionSegment(childNarratorId, logicalRunId);
	if (!segment?.parentSegmentId) return null;
	const [parent] = await db
		.select()
		.from(fileChangeExecutionSegments)
		.where(eq(fileChangeExecutionSegments.id, segment.parentSegmentId))
		.limit(1);
	if (!parent?.sourceToolCallId || parent.sourceExecutionAttempt === null) return null;
	const [call] = await db
		.select({ id: narratorToolCalls.id })
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.id, parent.sourceToolCallId),
				eq(narratorToolCalls.executionAttempt, parent.sourceExecutionAttempt),
				eq(narratorToolCalls.executionIdentityVersion, 1),
				eq(narratorToolCalls.executionSegmentId, parent.id),
			),
		)
		.limit(1);
	return call
		? {
				sourceToolCallId: parent.sourceToolCallId,
				executionAttempt: parent.sourceExecutionAttempt,
				executionIdentityVersion: 1,
				executionSegmentId: parent.id,
			}
		: null;
}

export async function establishSubagentExecutionSegment(input: {
	childNarratorId: string;
	parentNarratorId: string;
	logicalRunId: string;
	toolUseId: string;
	binding?: ToolCallBinding;
	/** Actual initiating actor; may be a peer rather than the child's result recipient. */
	bindingNarratorId?: string;
}): Promise<{ executionSegmentId: string; executionBoundary: SubagentExecutionBoundary | null }> {
	const service = createFileChangeExecutionSegmentsService(db);
	let parentSegmentId: string | null = null;
	const bindingNarratorId = input.bindingNarratorId ?? input.parentNarratorId;
	// Only a verified live binding may establish ownership. Recovery reuses the durable run.
	if (input.binding) {
		const { narratorPersistence } = await import("./narrator-persistence");
		await narratorPersistence.validateToolCallBinding(
			bindingNarratorId,
			input.toolUseId,
			input.binding,
		);
		{
			const [verified] = await db
				.select({ executionSegmentId: narratorToolCalls.executionSegmentId })
				.from(narratorToolCalls)
				.where(
					and(
						eq(narratorToolCalls.id, input.binding.toolCallId),
						eq(narratorToolCalls.narratorId, bindingNarratorId),
						eq(narratorToolCalls.executionAttempt, input.binding.attempt),
						eq(narratorToolCalls.executionIdentityVersion, 1),
						input.binding.executionSegmentId
							? eq(narratorToolCalls.executionSegmentId, input.binding.executionSegmentId)
							: undefined,
					),
				)
				.limit(1);
			if (!verified && input.binding.executionSegmentId)
				throw new Error("Subagent execution segment binding is not verified");
			parentSegmentId = verified?.executionSegmentId ?? null;
		}
	}
	const existing = await resolveSubagentExecutionSegment(input.childNarratorId, input.logicalRunId);
	if (existing && input.binding && existing.parentSegmentId !== parentSegmentId) {
		throw new Error("Subagent execution binding conflicts with the persisted run");
	}
	const segment =
		existing ??
		(await service.create({
			narratorId: input.childNarratorId,
			sourceInputId: runSource(input.logicalRunId),
			parentSegmentId,
		}));
	return {
		executionSegmentId: segment.id,
		executionBoundary: await readSubagentExecutionBoundary(
			input.childNarratorId,
			input.logicalRunId,
		),
	};
}
