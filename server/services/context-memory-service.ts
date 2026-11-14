import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import { contextMemories, contextMemoryEvents } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	contextMemoryScopeSchema,
	decideContextMemorySchema,
	forgetContextMemorySchema,
	listContextMemorySchema,
	proposeContextMemorySchema,
	reviseContextMemorySchema,
} from "../lib/validators/context-memory";
import {
	assertMemoryScope,
	assertMemorySource,
	type ContextMemoryActor,
	memoryScopeKey,
	memoryScopeOf,
	requireMemoryActor,
} from "./context-memory-access";

export type ContextMemory = typeof contextMemories.$inferSelect;
type MemoryEventAction = typeof contextMemoryEvents.$inferInsert.action;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const MAX_RECALLED_MEMORIES = 16;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}
function validateExpiry(expiresAt: string | null): void {
	if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
		throw new ValidationError("Memory expiry must be in the future");
	}
}
function hash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
function versionConflict(): never {
	throw new AppError(
		"Memory changed; reload before confirming or editing",
		409,
		"MEMORY_VERSION_CONFLICT",
	);
}
function project<T extends { status: string; expiresAt: string | null }>(memory: T) {
	return {
		...memory,
		effectiveStatus:
			memory.status === "confirmed" &&
			memory.expiresAt !== null &&
			Date.parse(memory.expiresAt) <= Date.now()
				? "expired"
				: memory.status,
	};
}
function audit(
	tx: Transaction,
	memory: ContextMemory,
	action: MemoryEventAction,
	actor: ContextMemoryActor,
): void {
	tx.insert(contextMemoryEvents)
		.values({
			id: generateId(),
			memoryId: memory.id,
			version: memory.version,
			action,
			actorUserId: actor.userId,
			actorKind: actor.kind,
			contentHash: memory.contentHash,
			createdAt: memory.updatedAt,
		})
		.run();
}
async function owned(id: string, actor: ContextMemoryActor): Promise<ContextMemory> {
	requireMemoryActor(actor);
	const row = await db.query.contextMemories.findFirst({
		where: and(eq(contextMemories.id, id), eq(contextMemories.ownerUserId, actor.userId)),
	});
	if (!row) throw new NotFoundError("Memory", id);
	await assertMemoryScope(memoryScopeOf(row), actor);
	return row;
}
async function readable(
	row: Pick<ContextMemory, "sourceNarratorId" | "sourceMessageId">,
	actor: ContextMemoryActor,
): Promise<boolean> {
	try {
		await assertMemorySource(row, actor);
		return true;
	} catch (error) {
		if (error instanceof NotFoundError) return false;
		throw error;
	}
}

export const contextMemoryService = {
	async propose(input: unknown, actor: ContextMemoryActor) {
		requireMemoryActor(actor);
		const data = parse(proposeContextMemorySchema, input);
		validateExpiry(data.expiresAt);
		await assertMemoryScope(data.scope, actor);
		if (actor.kind === "agent" && !data.source)
			throw new ValidationError("Agent memory requires an accessible source narrator");
		const source = {
			sourceNarratorId: data.source?.narratorId ?? null,
			sourceMessageId: data.source?.messageId ?? null,
		};
		await assertMemorySource(source, actor);
		const scopeKey = memoryScopeKey(data.scope);
		const now = new Date().toISOString();
		return db.transaction((tx) => {
			const existing = tx
				.select({ id: contextMemories.id })
				.from(contextMemories)
				.where(
					and(
						eq(contextMemories.ownerUserId, actor.userId),
						eq(contextMemories.scopeKey, scopeKey),
						eq(contextMemories.key, data.key),
					),
				)
				.get();
			if (existing)
				throw new AppError(
					"A memory with this key already exists; review it before replacing",
					409,
					"MEMORY_KEY_CONFLICT",
				);
			const row = tx
				.insert(contextMemories)
				.values({
					id: generateId(),
					ownerUserId: actor.userId,
					scope: data.scope.kind,
					scopeKey,
					projectId: data.scope.kind === "project" ? data.scope.id : null,
					narratorId: data.scope.kind === "session" ? data.scope.id : null,
					key: data.key,
					content: data.content,
					contentHash: hash(data.content),
					status: "candidate",
					version: 1,
					createdByKind: actor.kind,
					...source,
					expiresAt: data.expiresAt,
					confirmedAt: null,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
				.get();
			audit(tx, row, "propose", actor);
			return project(row);
		});
	},

	async get(id: string, actor: ContextMemoryActor) {
		const row = await owned(id, actor);
		await assertMemorySource(row, actor);
		return project(row);
	},

	async list(input: unknown, actor: ContextMemoryActor) {
		const data = parse(listContextMemorySchema, input);
		await assertMemoryScope(data.scope, actor);
		const rows = await db
			.select({
				id: contextMemories.id,
				key: contextMemories.key,
				scope: contextMemories.scope,
				version: contextMemories.version,
				status: contextMemories.status,
				expiresAt: contextMemories.expiresAt,
				updatedAt: contextMemories.updatedAt,
				createdByKind: contextMemories.createdByKind,
				sourceNarratorId: contextMemories.sourceNarratorId,
				sourceMessageId: contextMemories.sourceMessageId,
				// Never fetch full memory bodies for a management list.
				excerpt: sql<string>`substr(${contextMemories.content}, 1, 160)`,
			})
			.from(contextMemories)
			.where(
				and(
					eq(contextMemories.ownerUserId, actor.userId),
					eq(contextMemories.scopeKey, memoryScopeKey(data.scope)),
					data.cursor ? gt(contextMemories.id, data.cursor) : undefined,
				),
			)
			.orderBy(asc(contextMemories.id))
			.limit(data.limit + 1);
		const page = rows.slice(0, data.limit);
		const items = [];
		for (const row of page) if (await readable(row, actor)) items.push(project(row));
		return { items, nextCursor: rows.length > data.limit ? (page.at(-1)?.id ?? null) : null };
	},

	async recall(scopeInput: unknown, actor: ContextMemoryActor) {
		const scope = parse(contextMemoryScopeSchema, scopeInput);
		await assertMemoryScope(scope, actor);
		const rows = await db
			.select()
			.from(contextMemories)
			.where(
				and(
					eq(contextMemories.ownerUserId, actor.userId),
					eq(contextMemories.scopeKey, memoryScopeKey(scope)),
					eq(contextMemories.status, "confirmed"),
					or(
						isNull(contextMemories.expiresAt),
						gt(contextMemories.expiresAt, new Date().toISOString()),
					),
				),
			)
			.orderBy(asc(contextMemories.id))
			.limit(MAX_RECALLED_MEMORIES);
		const result: ContextMemory[] = [];
		for (const row of rows) if (await readable(row, actor)) result.push(row);
		return result;
	},

	async revise(id: string, input: unknown, actor: ContextMemoryActor) {
		requireMemoryActor(actor, true);
		const data = parse(reviseContextMemorySchema, input);
		const previous = await owned(id, actor);
		await assertMemorySource(previous, actor);
		validateExpiry(data.expiresAt);
		return db.transaction((tx) => {
			const row = tx
				.update(contextMemories)
				.set({
					content: data.content,
					contentHash: hash(data.content),
					expiresAt: data.expiresAt,
					status: "candidate",
					confirmedAt: null,
					version: data.expectedVersion + 1,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(contextMemories.id, id),
						eq(contextMemories.ownerUserId, actor.userId),
						eq(contextMemories.version, data.expectedVersion),
					),
				)
				.returning()
				.get();
			if (!row) versionConflict();
			audit(tx, row, "revise", actor);
			return project(row);
		});
	},

	async decide(id: string, input: unknown, actor: ContextMemoryActor) {
		requireMemoryActor(actor, true);
		const data = parse(decideContextMemorySchema, input);
		const previous = await owned(id, actor);
		if (previous.version !== data.expectedVersion) versionConflict();
		if (data.action !== "archive" && previous.status !== "candidate") {
			throw new ValidationError("Only a candidate memory may be confirmed or rejected");
		}
		// Every decision returns the full body, so all actions require live source access.
		await assertMemorySource(previous, actor);
		if (data.action === "confirm") validateExpiry(previous.expiresAt);
		const now = new Date().toISOString();
		return db.transaction((tx) => {
			const row = tx
				.update(contextMemories)
				.set({
					status:
						data.action === "confirm"
							? "confirmed"
							: data.action === "reject"
								? "rejected"
								: "archived",
					confirmedAt: data.action === "confirm" ? now : null,
					version: data.expectedVersion + 1,
					updatedAt: now,
				})
				.where(
					and(
						eq(contextMemories.id, id),
						eq(contextMemories.ownerUserId, actor.userId),
						eq(contextMemories.version, data.expectedVersion),
					),
				)
				.returning()
				.get();
			if (!row) versionConflict();
			audit(tx, row, data.action, actor);
			return project(row);
		});
	},

	async events(id: string, actor: ContextMemoryActor) {
		await owned(id, actor);
		return db
			.select()
			.from(contextMemoryEvents)
			.where(eq(contextMemoryEvents.memoryId, id))
			.orderBy(desc(contextMemoryEvents.version))
			.limit(50);
	},

	async forget(id: string, expectedVersion: number, actor: ContextMemoryActor) {
		requireMemoryActor(actor, true);
		parse(forgetContextMemorySchema, { expectedVersion });
		await owned(id, actor);
		const rows = await db
			.delete(contextMemories)
			.where(
				and(
					eq(contextMemories.id, id),
					eq(contextMemories.ownerUserId, actor.userId),
					eq(contextMemories.version, expectedVersion),
				),
			)
			.returning({ id: contextMemories.id });
		if (!rows.length) versionConflict();
		return { deleted: true };
	},
};
