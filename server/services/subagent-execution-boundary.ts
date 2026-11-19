import { readQuery } from "@server/db/worker-read";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { fileChangeExecutionSegments, narrators, narratorToolCalls } from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
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
					await readQuery(
						db.query.narrators.findFirst({
							where: eq(narrators.id, childNarratorId),
							columns: { logicalRunId: true },
						}),
						{ executionPolicy: "worker-required", maxRows: 1 },
					)
				)?.logicalRunId
			: logicalRunId;
	if (!runId) return null;
	const [segment] = await readQuery(
		db
			.select()
			.from(fileChangeExecutionSegments)
			.where(
				and(
					eq(fileChangeExecutionSegments.narratorId, childNarratorId),
					eq(fileChangeExecutionSegments.sourceInputId, runSource(runId)),
				),
			)
			.limit(1),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
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
	const [parent] = await readQuery(
		db
			.select()
			.from(fileChangeExecutionSegments)
			.where(eq(fileChangeExecutionSegments.id, segment.parentSegmentId))
			.limit(1),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!parent?.sourceToolCallId || parent.sourceExecutionAttempt === null) return null;
	const [call] = await readQuery(
		db
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
			.limit(1),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
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
	const bindingNarratorId = input.bindingNarratorId ?? input.parentNarratorId;
	if (input.binding) {
		const { narratorPersistence } = await import("./narrator-persistence");
		await narratorPersistence.validateToolCallBinding(
			bindingNarratorId,
			input.toolUseId,
			input.binding,
		);
	}
	const sourceInputId = runSource(input.logicalRunId);
	if (
		!input.logicalRunId ||
		!input.childNarratorId ||
		input.childNarratorId.length > 512 ||
		sourceInputId.length > 512
	)
		throw new Error("Subagent execution segment source is invalid");
	const segment = db.transaction((tx) => {
		// The async preflight is advisory. Establish the durable owner only from
		// the exact current binding and run receipt in this synchronous write.
		let parentSegmentId: string | null = null;
		if (input.binding) {
			const verified = tx
				.select({
					executionSegmentId: narratorToolCalls.executionSegmentId,
					executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
				})
				.from(narratorToolCalls)
				.where(
					and(
						eq(narratorToolCalls.id, input.binding.toolCallId),
						eq(narratorToolCalls.narratorId, bindingNarratorId),
						eq(narratorToolCalls.toolUseId, input.toolUseId),
						eq(narratorToolCalls.executionAttempt, input.binding.attempt),
						input.binding.executionSegmentId
							? eq(narratorToolCalls.executionSegmentId, input.binding.executionSegmentId)
							: undefined,
					),
				)
				.get();
			if (
				!verified ||
				(input.binding.executionSegmentId && verified.executionIdentityVersion !== 1)
			)
				throw new Error("Subagent execution segment binding is not verified");
			parentSegmentId =
				verified.executionIdentityVersion === 1 ? verified.executionSegmentId : null;
		}
		const existing = tx
			.select()
			.from(fileChangeExecutionSegments)
			.where(
				and(
					eq(fileChangeExecutionSegments.narratorId, input.childNarratorId),
					eq(fileChangeExecutionSegments.sourceInputId, sourceInputId),
				),
			)
			.get();
		if (existing) {
			if (input.binding && existing.parentSegmentId !== parentSegmentId)
				throw new Error("Subagent execution binding conflicts with the persisted run");
			return existing;
		}
		if (
			parentSegmentId &&
			!tx
				.select({ id: fileChangeExecutionSegments.id })
				.from(fileChangeExecutionSegments)
				.where(eq(fileChangeExecutionSegments.id, parentSegmentId))
				.get()
		)
			throw new Error("parent segment not found");
		return tx
			.insert(fileChangeExecutionSegments)
			.values({
				id: generateId(),
				narratorId: input.childNarratorId,
				sourceInputId,
				parentSegmentId,
				createdAt: new Date().toISOString(),
			})
			.returning()
			.get();
	});
	if (!segment) throw new Error("Failed to establish subagent execution segment");
	return {
		executionSegmentId: segment.id,
		executionBoundary: await readSubagentExecutionBoundary(
			input.childNarratorId,
			input.logicalRunId,
		),
	};
}
