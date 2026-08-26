import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { chapters, narratorContextDeliveries, narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { scopeContains, type ResourceScope } from "../lib/integrations/resource-scope";
import { deliverInjection } from "./narrator-injection";

export const NARRATOR_CONTEXT_KINDS = [
	"fact",
	"result",
	"decision",
	"artifact",
	"instruction",
	"status",
] as const;

export type NarratorContextKind = (typeof NARRATOR_CONTEXT_KINDS)[number];

const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const payloadSchema = z.record(z.string(), primitiveSchema).optional();

export const narratorContextRecordSchema = z.object({
	contextId: z.string().trim().min(1).max(160),
	kind: z.enum(NARRATOR_CONTEXT_KINDS),
	text: z.string().trim().min(1).max(20_000),
	sourceNarratorId: z.string().trim().min(1).optional(),
	payload: payloadSchema,
	targetNarratorIds: z.array(z.string().trim().min(1)).min(1).max(64),
});

export type NarratorContextRecord = z.infer<typeof narratorContextRecordSchema>;

export interface NarratorContextScope {
	projectId?: string;
	chapterId?: string;
	narratorId?: string;
}

export interface NarratorContextDeliveryResult {
	narratorId: string;
	status: "accepted" | "alreadyDelivered" | "skipped" | "failed";
	deliveryId?: string;
	reason?: string;
}

export interface NarratorContextDeliveryBatchResult {
	contextId: string;
	deliveries: NarratorContextDeliveryResult[];
}

interface NarratorRecord {
	id: string;
	chapterId: string | null;
	projectId: string | null;
}

const inFlightDeliveries = new Map<string, Promise<NarratorContextDeliveryResult>>();

function hashContext(record: NarratorContextRecord): string {
	const payload = record.payload
		? Object.fromEntries(Object.entries(record.payload).sort(([left], [right]) => left.localeCompare(right)))
		: undefined;
	return createHash("sha256")
		.update(
			JSON.stringify({
				contextId: record.contextId,
				kind: record.kind,
				text: record.text,
				sourceNarratorId: record.sourceNarratorId ?? null,
				payload: payload ?? null,
			}),
		)
		.digest("hex");
}

function sanitizePayload(payload: NarratorContextRecord["payload"]): Record<string, string | number | boolean | null> | undefined {
	if (!payload) return undefined;
	const sanitized: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (key.length > 80) continue;
		sanitized[key] = typeof value === "string" ? value.slice(0, 2_000) : value;
	}
	return sanitized;
}

async function getNarrator(id: string): Promise<NarratorRecord | null> {
	const row = await db
		.select({
			id: narrators.id,
			chapterId: narrators.chapterId,
			projectId: chapters.projectId,
		})
		.from(narrators)
		.leftJoin(chapters, eq(chapters.id, narrators.chapterId))
		.where(eq(narrators.id, id))
		.get();
	return row ?? null;
}

function assertTargetAllowed(scope: NarratorContextScope, source: NarratorRecord | null, target: NarratorRecord): void {
	if (scope.narratorId && !scopeContains({ type: "narrator", id: scope.narratorId }, { type: "narrator", id: target.id })) {
		throw new ValidationError(`Target narrator is outside the granted narrator scope: ${target.id}`);
	}
	if (scope.chapterId && target.chapterId !== scope.chapterId) {
		throw new ValidationError(`Target narrator is outside the granted chapter scope: ${target.id}`);
	}
	if (scope.projectId && target.projectId !== scope.projectId) {
		throw new ValidationError(`Target narrator is outside the granted project scope: ${target.id}`);
	}
	if (source && (source.projectId !== target.projectId || source.chapterId !== target.chapterId)) {
		throw new ValidationError(`Source and target narrator must belong to the same project and chapter: ${target.id}`);
	}
}

async function deliverOne(
	record: NarratorContextRecord,
	target: NarratorRecord,
	hash: string,
): Promise<NarratorContextDeliveryResult> {
	const key = `${record.contextId}:${target.id}`;
	const running = inFlightDeliveries.get(key);
	if (running) return running;

	const task: Promise<NarratorContextDeliveryResult> = (async () => {
		const existing = await db
			.select()
			.from(narratorContextDeliveries)
			.where(
				and(
					eq(narratorContextDeliveries.contextId, record.contextId),
					eq(narratorContextDeliveries.narratorId, target.id),
				),
			)
			.get();

		if (existing?.contentHash && existing.contentHash !== hash) {
			throw new ValidationError(`Context id already exists with different content: ${record.contextId}`);
		}
		if (existing?.status === "accepted") {
			return { narratorId: target.id, status: "alreadyDelivered", deliveryId: existing.id };
		}
		if (existing?.status === "skipped") {
			return { narratorId: target.id, status: "skipped", deliveryId: existing.id, reason: existing.errorMessage ?? undefined };
		}

		const now = new Date().toISOString();
		const deliveryId = existing?.id ?? `${record.contextId}:${target.id}`;
		if (existing) {
			await db
				.update(narratorContextDeliveries)
				.set({
					status: "pending",
					contentHash: hash,
					attempts: existing.attempts + 1,
					started: 1,
					errorCode: null,
					errorMessage: null,
					updatedAt: now,
				})
				.where(eq(narratorContextDeliveries.id, deliveryId))
				.run();
		} else {
			await db
				.insert(narratorContextDeliveries)
				.values({
					id: deliveryId,
					contextId: record.contextId,
					narratorId: target.id,
					sourceNarratorId: record.sourceNarratorId ?? null,
					kind: record.kind,
					source: "narratorTeam",
					status: "pending",
					contentHash: hash,
					attempts: 1,
					started: 1,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}

		try {
			const result = await deliverInjection(target.id, {
				content: record.text,
				source: "narrator_team_context",
				body: {
					kind: "narratorTeamContext",
					contextId: record.contextId,
					contextKind: record.kind,
					text: record.text,
					...(record.sourceNarratorId ? { sourceNarratorId: record.sourceNarratorId } : {}),
					...(record.payload ? { payload: sanitizePayload(record.payload) } : {}),
				},
				schedule: "onNextTurn",
				originSource: "chatGroup",
				originDetail: "narratorTeam",
				dedupeKey: `narratorTeam:${record.contextId}:${target.id}`,
			});
			const acceptedAt = new Date().toISOString();
			await db
				.update(narratorContextDeliveries)
				.set({
					status: "accepted",
					messageId: result.messageId,
					interjected: result.interjected ? 1 : 0,
					updatedAt: acceptedAt,
				})
				.where(eq(narratorContextDeliveries.id, deliveryId))
				.run();
			return { narratorId: target.id, status: "accepted", deliveryId };
		} catch (error) {
			const failedAt = new Date().toISOString();
			const errorMessage = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
			await db
				.update(narratorContextDeliveries)
				.set({
					status: "failed",
					errorCode: error instanceof ValidationError ? error.code : "DELIVERY_FAILED",
					errorMessage,
					updatedAt: failedAt,
				})
				.where(eq(narratorContextDeliveries.id, deliveryId))
				.run();
			return { narratorId: target.id, status: "failed", deliveryId, reason: errorMessage };
		}
	})();

	inFlightDeliveries.set(key, task);
	try {
		return await task;
	} finally {
		inFlightDeliveries.delete(key);
	}
}

export async function deliverNarratorContext(
	scope: NarratorContextScope,
	input: NarratorContextRecord,
): Promise<NarratorContextDeliveryBatchResult> {
	const record = narratorContextRecordSchema.parse({
		...input,
		targetNarratorIds: [...new Set(input.targetNarratorIds)],
	});
	const source = record.sourceNarratorId ? await getNarrator(record.sourceNarratorId) : null;
	if (record.sourceNarratorId && !source) {
		throw new ValidationError(`Source narrator not found: ${record.sourceNarratorId}`);
	}
	if (source) assertTargetAllowed(scope, source, source);

	const hash = hashContext(record);
	const targets = await db
		.select({
			id: narrators.id,
			chapterId: narrators.chapterId,
			projectId: chapters.projectId,
		})
		.from(narrators)
		.leftJoin(chapters, eq(chapters.id, narrators.chapterId))
		.where(inArray(narrators.id, record.targetNarratorIds));
	const targetMap = new Map(targets.map((target) => [target.id, target]));
	const results: NarratorContextDeliveryResult[] = [];

	for (const targetId of record.targetNarratorIds) {
		const target = targetMap.get(targetId);
		if (!target) {
			results.push({ narratorId: targetId, status: "skipped", reason: "Target narrator not found" });
			continue;
		}
		assertTargetAllowed(scope, source, target);
		results.push(await deliverOne(record, target, hash));
	}

	return { contextId: record.contextId, deliveries: results };
}

export async function getNarratorContextDeliveries(contextId: string, scope: NarratorContextScope) {
	const rows = await db
		.select({
			delivery: narratorContextDeliveries,
			chapterId: narrators.chapterId,
			projectId: chapters.projectId,
		})
		.from(narratorContextDeliveries)
		.leftJoin(narrators, eq(narrators.id, narratorContextDeliveries.narratorId))
		.leftJoin(chapters, eq(chapters.id, narrators.chapterId))
		.where(eq(narratorContextDeliveries.contextId, contextId));
	return rows
		.filter((row) => {
			if (scope.narratorId) return row.delivery.narratorId === scope.narratorId;
			if (scope.chapterId) return row.chapterId === scope.chapterId;
			if (scope.projectId) return row.projectId === scope.projectId;
			return true;
		})
		.map((row) => row.delivery);
}

export function resourceForNarratorContext(scope: NarratorContextScope): ResourceScope {
	if (scope.narratorId) return { type: "narrator", id: scope.narratorId };
	if (scope.chapterId) return { type: "chapter", id: scope.chapterId };
	if (scope.projectId) return { type: "project", id: scope.projectId };
	return { type: "global" };
}
