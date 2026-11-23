import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { fileChangeExecutionSegments, narrators, narratorToolCalls } from "../db/schema";
import { type ReadQueryOptions, readQueryFirst } from "../db/worker-read";
import type { ToolCallBinding } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";
import type { SubagentExecutionBoundary } from "./subagent-file-changes";

/** Durable receipt keyed by logical run, never by creation origin or result destination. */
const runSource = (runId: string) => `subagent-run:${runId}`;
type BoundaryReadOptions = Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs">;

export async function resolveSubagentExecutionSegment(
	childNarratorId: string,
	logicalRunId?: string | null,
	options: BoundaryReadOptions = {},
) {
	const runId =
		logicalRunId === undefined
			? (
					await readQueryFirst(
						db.query.narrators.findMany({
							limit: 1,
							where: eq(narrators.id, childNarratorId),
							columns: { logicalRunId: true },
						}),
						{ ...options, executionPolicy: "worker-required", maxRows: 1 },
					)
				)?.logicalRunId
			: logicalRunId;
	if (!runId) return null;
	const segment = await readQueryFirst(
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
		{ ...options, executionPolicy: "worker-required", maxRows: 1 },
	);
	return segment ?? null;
}

export async function readSubagentExecutionBoundary(
	childNarratorId: string,
	logicalRunId?: string | null,
	options: BoundaryReadOptions = {},
): Promise<SubagentExecutionBoundary | null> {
	try {
		return await readVerifiedSubagentExecutionBoundary(childNarratorId, logicalRunId, options);
	} catch (error) {
		logger.warn("Failed to read subagent execution receipt", {
			childNarratorId,
			error: String(error),
		});
		throw error;
	}
}

async function readVerifiedSubagentExecutionBoundary(
	childNarratorId: string,
	logicalRunId?: string | null,
	options: BoundaryReadOptions = {},
): Promise<SubagentExecutionBoundary | null> {
	const segment = await resolveSubagentExecutionSegment(childNarratorId, logicalRunId, options);
	if (!segment?.parentSegmentId) return null;
	const parent = await readQueryFirst(
		db
			.select()
			.from(fileChangeExecutionSegments)
			.where(eq(fileChangeExecutionSegments.id, segment.parentSegmentId))
			.limit(1),
		{ ...options, executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!parent?.sourceToolCallId || parent.sourceExecutionAttempt === null) return null;
	const call = await readQueryFirst(
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
		{ ...options, executionPolicy: "worker-required", maxRows: 1 },
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
	signal?: AbortSignal;
	deadlineAt?: number;
	timeoutMs?: number;
}): Promise<{ executionSegmentId: string; executionBoundary: SubagentExecutionBoundary | null }> {
	let parentSegmentId: string | null = null;
	const bindingNarratorId = input.bindingNarratorId ?? input.parentNarratorId;
	const bindingWhere = input.binding
		? and(
				eq(narratorToolCalls.id, input.binding.toolCallId),
				eq(narratorToolCalls.narratorId, bindingNarratorId),
				eq(narratorToolCalls.toolUseId, input.toolUseId),
				eq(narratorToolCalls.executionAttempt, input.binding.attempt),
			)
		: undefined;
	const bindingColumns = {
		executionSegmentId: narratorToolCalls.executionSegmentId,
		executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
	};
	let observedBinding:
		| { executionSegmentId: string | null; executionIdentityVersion: number }
		| undefined;
	// Only a verified live binding may establish ownership. Recovery reuses the durable run.
	if (input.binding) {
		const { narratorPersistence } = await import("./narrator-persistence");
		await narratorPersistence.validateToolCallBinding(
			bindingNarratorId,
			input.toolUseId,
			input.binding,
		);
		observedBinding = await readQueryFirst(
			db.select(bindingColumns).from(narratorToolCalls).where(bindingWhere).limit(1),
			{ ...input, executionPolicy: "worker-required", maxRows: 1 },
		);
		if (
			input.binding.executionSegmentId &&
			(observedBinding?.executionIdentityVersion !== 1 ||
				observedBinding.executionSegmentId !== input.binding.executionSegmentId)
		)
			throw new Error("Subagent execution segment binding is not verified");
		if (!observedBinding) throw new RuntimeReadConflictError();
		parentSegmentId =
			observedBinding.executionIdentityVersion === 1 ? observedBinding.executionSegmentId : null;
	}
	const existing = await resolveSubagentExecutionSegment(
		input.childNarratorId,
		input.logicalRunId,
		input,
	);
	if (existing && input.binding && existing.parentSegmentId !== parentSegmentId) {
		throw new Error("Subagent execution binding conflicts with the persisted run");
	}
	input.signal?.throwIfAborted();
	const segment = db.transaction((tx) => {
		if (input.binding) {
			const currentBinding = tx
				.select(bindingColumns)
				.from(narratorToolCalls)
				.where(bindingWhere)
				.get();
			if (!currentBinding || JSON.stringify(currentBinding) !== JSON.stringify(observedBinding))
				throw new RuntimeReadConflictError();
		}
		const current = tx
			.select()
			.from(fileChangeExecutionSegments)
			.where(
				and(
					eq(fileChangeExecutionSegments.narratorId, input.childNarratorId),
					eq(fileChangeExecutionSegments.sourceInputId, runSource(input.logicalRunId)),
				),
			)
			.get();
		if (JSON.stringify(current ?? null) !== JSON.stringify(existing))
			throw new RuntimeReadConflictError();
		if (current) return current;
		if (
			parentSegmentId &&
			!tx
				.select({ id: fileChangeExecutionSegments.id })
				.from(fileChangeExecutionSegments)
				.where(eq(fileChangeExecutionSegments.id, parentSegmentId))
				.get()
		)
			throw new RuntimeReadConflictError();
		const sourceInputId = runSource(input.logicalRunId);
		if (!input.childNarratorId || input.childNarratorId.length > 512)
			throw new Error("narratorId is invalid");
		if (sourceInputId.length > 512) throw new Error("sourceInputId is invalid");
		return tx
			.insert(fileChangeExecutionSegments)
			.values({
				id: generateId(),
				narratorId: input.childNarratorId,
				parentSegmentId,
				sourceInputId,
				createdAt: new Date().toISOString(),
			})
			.returning()
			.get();
	});
	return {
		executionSegmentId: segment.id,
		executionBoundary: await readSubagentExecutionBoundary(
			input.childNarratorId,
			input.logicalRunId,
			input,
		),
	};
}
