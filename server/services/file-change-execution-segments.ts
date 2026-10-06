import type { db as applicationDb } from "@server/db";
import { fileChangeExecutionSegments, narratorToolCalls } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { and, eq, inArray } from "drizzle-orm";

export type SegmentDb = Pick<typeof applicationDb, "select" | "insert">;
export type CreateSegmentInput = {
	narratorId: string;
	parentSegmentId?: string | null;
	sourceToolCallId?: string;
	sourceExecutionAttempt?: number;
	sourceInputId?: string;
};
export type Segment = typeof fileChangeExecutionSegments.$inferSelect;
export type SegmentCollection = {
	segmentIds: string[];
	missingToolCallIds: string[];
	hasMore: boolean;
};

const MAX_TEXT = 512;
const MAX_ATTEMPT = 1_000_000;
const MAX_RESULTS = 1000;
function text(value: string, name: string) {
	if (!value || value.length > MAX_TEXT) throw new Error(`${name} is invalid`);
}

export function createFileChangeExecutionSegmentsService(db: SegmentDb) {
	async function get(id: string) {
		const rows = await db
			.select()
			.from(fileChangeExecutionSegments)
			.where(eq(fileChangeExecutionSegments.id, id))
			.limit(1);
		return rows[0] as Segment | undefined;
	}
	async function create(input: CreateSegmentInput): Promise<Segment> {
		text(input.narratorId, "narratorId");
		const sourceToolCallId = input.sourceToolCallId;
		const sourceExecutionAttempt = input.sourceExecutionAttempt;
		const hasTool = sourceToolCallId !== undefined || sourceExecutionAttempt !== undefined;
		const hasInput = input.sourceInputId !== undefined;
		if (
			hasTool === hasInput ||
			(hasTool &&
				(input.sourceToolCallId === undefined || input.sourceExecutionAttempt === undefined))
		)
			throw new Error("exactly one source is required");
		if (hasTool) {
			if (sourceToolCallId === undefined || sourceExecutionAttempt === undefined)
				throw new Error("tool source is incomplete");
			text(sourceToolCallId, "sourceToolCallId");
			if (
				!Number.isInteger(sourceExecutionAttempt) ||
				sourceExecutionAttempt < 0 ||
				sourceExecutionAttempt > MAX_ATTEMPT
			)
				throw new Error("attempt is invalid");
		}
		if (hasInput) {
			if (input.sourceInputId === undefined) throw new Error("input source is incomplete");
			text(input.sourceInputId, "sourceInputId");
		}
		if (input.parentSegmentId && !(await get(input.parentSegmentId)))
			throw new Error("parent segment not found");
		const existing = hasTool
			? await db
					.select()
					.from(fileChangeExecutionSegments)
					.where(
						and(
							eq(fileChangeExecutionSegments.narratorId, input.narratorId),
							eq(fileChangeExecutionSegments.sourceToolCallId, sourceToolCallId ?? ""),
							eq(fileChangeExecutionSegments.sourceExecutionAttempt, sourceExecutionAttempt ?? -1),
						),
					)
					.limit(1)
			: input.sourceInputId
				? await db
						.select()
						.from(fileChangeExecutionSegments)
						.where(
							and(
								eq(fileChangeExecutionSegments.narratorId, input.narratorId),
								eq(fileChangeExecutionSegments.sourceInputId, input.sourceInputId),
							),
						)
						.limit(1)
				: [];
		if (existing[0]) {
			if (existing[0].parentSegmentId !== (input.parentSegmentId ?? null))
				throw new Error("source segment parent conflicts with existing execution");
			return existing[0];
		}
		const row = {
			id: generateId(),
			narratorId: input.narratorId,
			parentSegmentId: input.parentSegmentId ?? null,
			sourceToolCallId: input.sourceToolCallId ?? null,
			sourceExecutionAttempt: input.sourceExecutionAttempt ?? null,
			sourceInputId: input.sourceInputId ?? null,
			createdAt: new Date().toISOString(),
		};
		await db.insert(fileChangeExecutionSegments).values(row);
		return row as Segment;
	}
	async function collect(toolCallIds: string[], limit = MAX_RESULTS): Promise<SegmentCollection> {
		const cap = Math.min(Math.max(1, limit), MAX_RESULTS);
		const calls = await db
			.select({ id: narratorToolCalls.id, segmentId: narratorToolCalls.executionSegmentId })
			.from(narratorToolCalls)
			.where(inArray(narratorToolCalls.id, toolCallIds));
		const found = new Set(calls.map((x) => x.id));
		const missingToolCallIds = toolCallIds.filter((id) => !found.has(id));
		const ids = new Set<string>();
		const queue = calls.flatMap((x) => (x.segmentId ? [x.segmentId] : []));
		for (const call of calls) if (call.segmentId === null) missingToolCallIds.push(call.id);
		while (queue.length && ids.size < cap) {
			const id = queue.shift();
			if (!id) break;
			if (ids.has(id)) continue;
			ids.add(id);
			const children = await db
				.select({ id: fileChangeExecutionSegments.id })
				.from(fileChangeExecutionSegments)
				.where(eq(fileChangeExecutionSegments.parentSegmentId, id))
				.limit(cap + 1);
			queue.push(...children.map((x) => x.id));
		}
		return { segmentIds: [...ids].slice(0, cap), missingToolCallIds, hasMore: queue.length > 0 };
	}
	async function descendants(segmentId: string, limit = MAX_RESULTS) {
		return collectDesc(segmentId, Math.min(Math.max(1, limit), MAX_RESULTS));
	}
	async function collectDesc(root: string, cap: number) {
		const ids = new Set<string>(),
			queue = [root];
		while (queue.length && ids.size < cap) {
			const parent = queue.shift();
			if (!parent) break;
			const rows = await db
				.select({ id: fileChangeExecutionSegments.id })
				.from(fileChangeExecutionSegments)
				.where(eq(fileChangeExecutionSegments.parentSegmentId, parent))
				.limit(cap + 1);
			for (const r of rows) {
				if (!ids.has(r.id)) {
					ids.add(r.id);
					queue.push(r.id);
				}
			}
		}
		return { segmentIds: [...ids].slice(0, cap), hasMore: queue.length > 0 };
	}
	return { create, get, collect, descendants };
}
