import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { integrationResourceBindings, narrators, oauthGrants, remoteDevices } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { integrationAuditService } from "./integration-audit-service";

export type IntegrationResourceType = "device" | "narrator";
export type IntegrationSourceType = "oauth_client" | "plugin" | "first_party";
export type IntegrationAuthorityType = "oauth_grant" | "plugin_installation" | "user" | "system";
export type IntegrationResourceBindingState = "active" | "revoked" | "orphaned" | "deleted";
export type IntegrationResourceBinding = typeof integrationResourceBindings.$inferSelect;

type IntegrationBindingUpdateExecutor = Pick<typeof db, "select" | "update">;
type IntegrationBindingInsertExecutor = Pick<typeof db, "insert">;

const MAX_ID_CHARS = 256;
const MAX_METADATA_BYTES = 4_096;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_DEPTH = 4;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;

interface BindingIdentity {
	resourceType: IntegrationResourceType;
	resourceId: string;
}

export interface IntegrationResourceBindingTransition {
	bindingId: string;
	resourceType: IntegrationResourceType;
	resourceId: string;
	sourceType: IntegrationSourceType;
	sourceId: string;
	authorityType: IntegrationAuthorityType;
	authorityId: string;
	previousState: IntegrationResourceBindingState | null;
	state: IntegrationResourceBindingState;
	revision: number;
	provisionKey: string | null;
}

export interface CreateIntegrationResourceBindingInput extends BindingIdentity {
	sourceType: IntegrationSourceType;
	sourceId: string;
	authorityType: IntegrationAuthorityType;
	authorityId: string;
	state?: IntegrationResourceBindingState;
	provisionKey?: string | null;
	metadataJson?: Record<string, unknown> | null;
}

export interface ListIntegrationResourceBindingsOptions {
	limit?: number;
	cursor?: string;
	states?: IntegrationResourceBindingState[];
}

export interface IntegrationResourceBindingPage {
	items: IntegrationResourceBinding[];
	nextCursor: string | null;
}

export interface BackfillIntegrationResourceBindingsOptions {
	limit?: number;
	cursor?: string;
	/** Optional OAuth grant filter for targeted repair/testing. */
	authorityId?: string;
}

export interface BackfillIntegrationResourceBindingsResult {
	processed: number;
	created: number;
	skipped: number;
	nextCursor: string | null;
}

interface BackfillCursor {
	resourceType: IntegrationResourceType;
	id: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeId(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_ID_CHARS) {
		throw new ValidationError(`${name} must contain between 1 and ${MAX_ID_CHARS} characters`);
	}
	return normalized;
}

function normalizeLimit(value: number | undefined): number {
	const limit = value ?? DEFAULT_PAGE_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
		throw new ValidationError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
	}
	return limit;
}

function inspectMetadata(value: unknown, depth: number, keyCount: { value: number }): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new ValidationError("metadataJson must contain finite numbers");
		return;
	}
	if (depth >= MAX_METADATA_DEPTH || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError("metadataJson must be a bounded plain JSON object");
	}
	for (const [key, child] of Object.entries(value)) {
		keyCount.value++;
		if (keyCount.value > MAX_METADATA_KEYS || key.length > 128) {
			throw new ValidationError("metadataJson contains too many or oversized keys");
		}
		inspectMetadata(child, depth + 1, keyCount);
	}
}

function normalizeMetadata(
	metadataJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
	if (metadataJson == null) return null;
	inspectMetadata(metadataJson, 0, { value: 0 });
	let serialized: string;
	try {
		serialized = JSON.stringify(metadataJson);
	} catch {
		throw new ValidationError("metadataJson must be JSON serializable");
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
		throw new ValidationError(`metadataJson must not exceed ${MAX_METADATA_BYTES} bytes`);
	}
	return JSON.parse(serialized) as Record<string, unknown>;
}

function encodeCursor(cursor: BackfillCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): BackfillCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<BackfillCursor>;
		if (
			(parsed.resourceType !== "device" && parsed.resourceType !== "narrator") ||
			typeof parsed.id !== "string"
		) {
			throw new Error("invalid cursor");
		}
		return { resourceType: parsed.resourceType, id: parsed.id };
	} catch {
		throw new ValidationError("Integration resource binding cursor is invalid");
	}
}

async function resourceExists(
	resourceType: IntegrationResourceType,
	resourceId: string,
): Promise<boolean> {
	if (resourceType === "device") {
		return Boolean(
			await db.query.remoteDevices.findFirst({
				where: eq(remoteDevices.id, resourceId),
				columns: { id: true },
			}),
		);
	}
	return Boolean(
		await db.query.narrators.findFirst({
			where: eq(narrators.id, resourceId),
			columns: { id: true },
		}),
	);
}

async function requireResource(
	resourceType: IntegrationResourceType,
	resourceId: string,
): Promise<void> {
	if (!(await resourceExists(resourceType, resourceId))) {
		throw new NotFoundError(resourceType === "device" ? "Remote device" : "Narrator", resourceId);
	}
}

function stateTimestamps(state: IntegrationResourceBindingState, now: string) {
	return {
		revokedAt: state === "revoked" ? now : null,
		orphanedAt: state === "orphaned" ? now : null,
		deletedAt: state === "deleted" ? now : null,
	};
}

function stateAfterUpsert(
	existing: IntegrationResourceBindingState,
	requested: IntegrationResourceBindingState,
): IntegrationResourceBindingState {
	if (existing === "deleted" || requested === "deleted") return "deleted";
	if (requested === "active") return existing;
	return requested;
}

function assertSameProvenance(
	existing: IntegrationResourceBinding,
	input: Pick<
		CreateIntegrationResourceBindingInput,
		"sourceType" | "sourceId" | "authorityType" | "authorityId"
	>,
): void {
	if (
		existing.sourceType !== input.sourceType ||
		existing.sourceId !== input.sourceId ||
		existing.authorityType !== input.authorityType ||
		existing.authorityId !== input.authorityId
	) {
		throw new AppError(
			"Integration resource provenance cannot be replaced without an explicit transfer",
			409,
			"INTEGRATION_PROVENANCE_CONFLICT",
		);
	}
}

function toTransition(
	binding: IntegrationResourceBinding,
	previousState: IntegrationResourceBindingState | null,
): IntegrationResourceBindingTransition {
	return {
		bindingId: binding.id,
		resourceType: binding.resourceType,
		resourceId: binding.resourceId,
		sourceType: binding.sourceType,
		sourceId: binding.sourceId,
		authorityType: binding.authorityType,
		authorityId: binding.authorityId,
		previousState,
		state: binding.state,
		revision: binding.revision,
		provisionKey: binding.provisionKey,
	};
}

function transitionOutcome(state: IntegrationResourceBindingState): "succeeded" | "revoked" {
	return state === "active" ? "succeeded" : "revoked";
}

export class IntegrationResourceBindingService {
	async recordTransitionAudit(
		operationId: string,
		transition: IntegrationResourceBindingTransition,
	): Promise<void> {
		await integrationAuditService
			.record({
				principal: { type: "system" },
				authorityId: transition.authorityId,
				transport: "integration-kernel",
				operationId,
				resource: { type: transition.resourceType, id: transition.resourceId },
				scope: { type: "integration", id: transition.authorityId },
				outcome: transitionOutcome(transition.state),
				reasonCode: `resource_binding_${transition.state}`,
				metadata: {
					bindingId: transition.bindingId,
					sourceType: transition.sourceType,
					sourceId: transition.sourceId,
					authorityType: transition.authorityType,
					previousState: transition.previousState,
					state: transition.state,
					revision: transition.revision,
					provisionKey: transition.provisionKey,
				},
			})
			.catch((error) => {
				logger.warn("Integration resource binding audit write failed", {
					bindingId: transition.bindingId,
					operationId,
					error: String(error),
				});
			});
	}

	private async recordAggregateAudit(input: {
		operationId: string;
		authorityType: IntegrationAuthorityType;
		authorityId: string;
		state: IntegrationResourceBindingState;
		affectedCount: number;
	}): Promise<void> {
		if (input.affectedCount === 0) return;
		await integrationAuditService
			.record({
				principal: { type: "system" },
				authorityId: input.authorityId,
				transport: "integration-kernel",
				operationId: input.operationId,
				scope: { type: "integration", id: input.authorityId },
				outcome: transitionOutcome(input.state),
				reasonCode: `resource_binding_${input.state}`,
				metadata: {
					authorityType: input.authorityType,
					state: input.state,
					affectedCount: input.affectedCount,
				},
			})
			.catch((error) => {
				logger.warn("Integration resource binding aggregate audit write failed", {
					authorityId: input.authorityId,
					operationId: input.operationId,
					error: String(error),
				});
			});
	}

	createInTransaction(
		executor: IntegrationBindingInsertExecutor,
		input: CreateIntegrationResourceBindingInput,
		now = nowIso(),
	): {
		binding: IntegrationResourceBinding;
		transition: IntegrationResourceBindingTransition;
	} {
		const state = input.state ?? "active";
		const binding = executor
			.insert(integrationResourceBindings)
			.values({
				id: generateId(),
				resourceType: input.resourceType,
				resourceId: normalizeId(input.resourceId, "resourceId"),
				sourceType: input.sourceType,
				sourceId: normalizeId(input.sourceId, "sourceId"),
				authorityType: input.authorityType,
				authorityId: normalizeId(input.authorityId, "authorityId"),
				state,
				provisionKey: input.provisionKey ? normalizeId(input.provisionKey, "provisionKey") : null,
				metadataJson: normalizeMetadata(input.metadataJson),
				createdAt: now,
				updatedAt: now,
				...stateTimestamps(state, now),
			})
			.returning()
			.get();
		return { binding, transition: toTransition(binding, null) };
	}

	async create(input: CreateIntegrationResourceBindingInput): Promise<IntegrationResourceBinding> {
		const resourceId = normalizeId(input.resourceId, "resourceId");
		await requireResource(input.resourceType, resourceId);
		const result = db.transaction((tx) => this.createInTransaction(tx, { ...input, resourceId }));
		await this.recordTransitionAudit("resource_binding.create", result.transition);
		return result.binding;
	}

	async upsert(input: CreateIntegrationResourceBindingInput): Promise<IntegrationResourceBinding> {
		const resourceId = normalizeId(input.resourceId, "resourceId");
		await requireResource(input.resourceType, resourceId);
		const now = nowIso();
		const requestedState = input.state ?? "active";
		const provenance = {
			sourceType: input.sourceType,
			sourceId: normalizeId(input.sourceId, "sourceId"),
			authorityType: input.authorityType,
			authorityId: normalizeId(input.authorityId, "authorityId"),
		};
		const provisionKey = input.provisionKey
			? normalizeId(input.provisionKey, "provisionKey")
			: null;
		const metadataJson =
			input.metadataJson === undefined ? undefined : normalizeMetadata(input.metadataJson);
		const [created] = await db
			.insert(integrationResourceBindings)
			.values({
				id: generateId(),
				resourceType: input.resourceType,
				resourceId,
				...provenance,
				state: requestedState,
				provisionKey,
				metadataJson,
				createdAt: now,
				updatedAt: now,
				...stateTimestamps(requestedState, now),
			})
			.onConflictDoNothing()
			.returning();
		if (created) {
			await this.recordTransitionAudit("resource_binding.upsert", toTransition(created, null));
			return created;
		}

		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await this.get(input.resourceType, resourceId);
			if (!existing) continue;
			assertSameProvenance(existing, provenance);
			if (existing.state === "deleted") return existing;
			const state = stateAfterUpsert(existing.state, requestedState);
			const nextProvisionKey =
				input.provisionKey === undefined ? existing.provisionKey : provisionKey;
			const nextMetadataJson =
				input.metadataJson === undefined ? existing.metadataJson : (metadataJson ?? null);
			if (
				state === existing.state &&
				nextProvisionKey === existing.provisionKey &&
				JSON.stringify(nextMetadataJson) === JSON.stringify(existing.metadataJson)
			) {
				return existing;
			}
			const updatedAt = nowIso();
			const [updated] = await db
				.update(integrationResourceBindings)
				.set({
					state,
					provisionKey: nextProvisionKey,
					metadataJson: nextMetadataJson,
					revision: existing.revision + 1,
					updatedAt,
					revokedAt: state === "revoked" ? (existing.revokedAt ?? updatedAt) : existing.revokedAt,
					orphanedAt:
						state === "orphaned" ? (existing.orphanedAt ?? updatedAt) : existing.orphanedAt,
					deletedAt: state === "deleted" ? (existing.deletedAt ?? updatedAt) : existing.deletedAt,
				})
				.where(
					and(
						eq(integrationResourceBindings.id, existing.id),
						eq(integrationResourceBindings.revision, existing.revision),
						eq(integrationResourceBindings.state, existing.state),
					),
				)
				.returning();
			if (updated) {
				await this.recordTransitionAudit(
					"resource_binding.upsert",
					toTransition(updated, existing.state),
				);
				return updated;
			}
		}
		throw new AppError(
			"Integration resource provenance changed concurrently; retry the operation",
			409,
			"INTEGRATION_PROVENANCE_CONFLICT",
		);
	}

	async get(resourceType: IntegrationResourceType, resourceId: string) {
		return (
			(await db.query.integrationResourceBindings.findFirst({
				where: and(
					eq(integrationResourceBindings.resourceType, resourceType),
					eq(integrationResourceBindings.resourceId, resourceId),
				),
			})) ?? null
		);
	}

	async getByProvisionKey(input: {
		authorityType: IntegrationAuthorityType;
		authorityId: string;
		resourceType: IntegrationResourceType;
		provisionKey: string;
		state?: IntegrationResourceBindingState;
	}): Promise<IntegrationResourceBinding | null> {
		return (
			(await db.query.integrationResourceBindings.findFirst({
				where: and(
					eq(integrationResourceBindings.authorityType, input.authorityType),
					eq(
						integrationResourceBindings.authorityId,
						normalizeId(input.authorityId, "authorityId"),
					),
					eq(integrationResourceBindings.resourceType, input.resourceType),
					eq(
						integrationResourceBindings.provisionKey,
						normalizeId(input.provisionKey, "provisionKey"),
					),
					input.state ? eq(integrationResourceBindings.state, input.state) : undefined,
				),
			})) ?? null
		);
	}

	async listByAuthority(
		authorityType: IntegrationAuthorityType,
		authorityId: string,
		options: ListIntegrationResourceBindingsOptions = {},
	): Promise<IntegrationResourceBindingPage> {
		const limit = normalizeLimit(options.limit);
		const cursor = options.cursor ? normalizeId(options.cursor, "cursor") : null;
		const states = [...new Set(options.states ?? [])];
		const rows = await db.query.integrationResourceBindings.findMany({
			where: and(
				eq(integrationResourceBindings.authorityType, authorityType),
				eq(integrationResourceBindings.authorityId, normalizeId(authorityId, "authorityId")),
				cursor ? gt(integrationResourceBindings.id, cursor) : undefined,
				states.length > 0 ? inArray(integrationResourceBindings.state, states) : undefined,
			),
			orderBy: [asc(integrationResourceBindings.id)],
			limit: limit + 1,
		});
		const hasMore = rows.length > limit;
		const items = hasMore ? rows.slice(0, limit) : rows;
		return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
	}

	async markOrphaned(
		authorityType: IntegrationAuthorityType,
		authorityId: string,
	): Promise<number> {
		const normalizedAuthorityId = normalizeId(authorityId, "authorityId");
		let affectedCount = 0;
		for (;;) {
			const candidates = await db.query.integrationResourceBindings.findMany({
				where: and(
					eq(integrationResourceBindings.authorityType, authorityType),
					eq(integrationResourceBindings.authorityId, normalizedAuthorityId),
					inArray(integrationResourceBindings.state, ["active", "revoked"]),
				),
				columns: { id: true },
				orderBy: [asc(integrationResourceBindings.id)],
				limit: MAX_PAGE_LIMIT,
			});
			if (candidates.length === 0) break;
			const now = nowIso();
			const rows = await db
				.update(integrationResourceBindings)
				.set({
					state: "orphaned",
					orphanedAt: sql`coalesce(${integrationResourceBindings.orphanedAt}, ${now})`,
					revision: sql`${integrationResourceBindings.revision} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						inArray(
							integrationResourceBindings.id,
							candidates.map((candidate) => candidate.id),
						),
						inArray(integrationResourceBindings.state, ["active", "revoked"]),
					),
				)
				.returning({ id: integrationResourceBindings.id });
			affectedCount += rows.length;
			if (candidates.length < MAX_PAGE_LIMIT) break;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		await this.recordAggregateAudit({
			operationId: "resource_binding.orphan_many",
			authorityType,
			authorityId: normalizedAuthorityId,
			state: "orphaned",
			affectedCount,
		});
		return affectedCount;
	}

	async markRevoked(resourceType: IntegrationResourceType, resourceId: string): Promise<boolean> {
		const now = nowIso();
		const rows = await db
			.update(integrationResourceBindings)
			.set({
				state: "revoked",
				revokedAt: sql`coalesce(${integrationResourceBindings.revokedAt}, ${now})`,
				revision: sql`${integrationResourceBindings.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(integrationResourceBindings.resourceType, resourceType),
					eq(integrationResourceBindings.resourceId, resourceId),
					inArray(integrationResourceBindings.state, ["active", "orphaned"]),
				),
			)
			.returning();
		const revoked = rows[0];
		if (revoked) {
			await this.recordTransitionAudit(
				"resource_binding.revoke",
				toTransition(revoked, revoked.orphanedAt ? "orphaned" : "active"),
			);
		}
		return Boolean(revoked);
	}

	markDeletedInTransaction(
		executor: IntegrationBindingUpdateExecutor,
		resourceType: IntegrationResourceType,
		resourceId: string,
	): IntegrationResourceBindingTransition | null {
		const previous = executor
			.select({ state: integrationResourceBindings.state })
			.from(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.resourceType, resourceType),
					eq(integrationResourceBindings.resourceId, resourceId),
					inArray(integrationResourceBindings.state, ["active", "revoked", "orphaned"]),
				),
			)
			.limit(1)
			.all()[0];
		if (!previous) return null;
		const now = nowIso();
		const rows = executor
			.update(integrationResourceBindings)
			.set({
				state: "deleted",
				deletedAt: now,
				revision: sql`${integrationResourceBindings.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(integrationResourceBindings.resourceType, resourceType),
					eq(integrationResourceBindings.resourceId, resourceId),
					inArray(integrationResourceBindings.state, ["active", "revoked", "orphaned"]),
				),
			)
			.returning()
			.all();
		const deleted = rows[0];
		return deleted ? toTransition(deleted, previous.state) : null;
	}

	async markDeleted(resourceType: IntegrationResourceType, resourceId: string): Promise<boolean> {
		const transition = db.transaction((tx) =>
			this.markDeletedInTransaction(tx, resourceType, resourceId),
		);
		if (!transition) return false;
		await this.recordTransitionAudit("resource_binding.delete", transition);
		return true;
	}

	async backfill(
		options: BackfillIntegrationResourceBindingsOptions = {},
	): Promise<BackfillIntegrationResourceBindingsResult> {
		const limit = normalizeLimit(options.limit);
		const cursor = decodeCursor(options.cursor);
		const authorityId = options.authorityId
			? normalizeId(options.authorityId, "authorityId")
			: null;
		const candidates: Array<{
			resourceType: IntegrationResourceType;
			id: string;
			grantId: string;
			provisionKey: string | null;
			projectId: string | null;
			revoked: boolean;
		}> = [];
		let hasMore = false;

		if (!cursor || cursor.resourceType === "device") {
			const rows = await db
				.select({
					id: remoteDevices.id,
					grantId: remoteDevices.oauthOwnerGrantId,
					provisionKey: remoteDevices.oauthProvisionKey,
					projectId: remoteDevices.projectId,
					revokedAt: remoteDevices.revokedAt,
				})
				.from(remoteDevices)
				.where(
					and(
						isNotNull(remoteDevices.oauthOwnerGrantId),
						authorityId ? eq(remoteDevices.oauthOwnerGrantId, authorityId) : undefined,
						cursor?.resourceType === "device" ? gt(remoteDevices.id, cursor.id) : undefined,
					),
				)
				.orderBy(asc(remoteDevices.id))
				.limit(limit + 1);
			const oauthRows = rows.filter((row) => row.grantId !== null);
			for (const row of oauthRows.slice(0, limit)) {
				candidates.push({
					resourceType: "device",
					id: row.id,
					grantId: row.grantId as string,
					provisionKey: row.provisionKey,
					projectId: row.projectId,
					revoked: row.revokedAt !== null,
				});
			}
			hasMore = rows.length > limit;
			if (hasMore) {
				return this.backfillCandidates(
					candidates,
					encodeCursor({
						resourceType: "device",
						id: candidates.at(-1)?.id ?? cursor?.id ?? "",
					}),
				);
			}
		}

		const remaining = limit - candidates.length;
		if (remaining === 0) {
			return this.backfillCandidates(
				candidates,
				encodeCursor({ resourceType: "narrator", id: "" }),
			);
		}
		if (remaining > 0) {
			const narratorCursor = cursor?.resourceType === "narrator" ? cursor.id : null;
			const rows = await db
				.select({
					id: narrators.id,
					grantId: narrators.oauthOwnerGrantId,
					provisionKey: narrators.oauthProvisionKey,
					projectId: narrators.contextProjectId,
				})
				.from(narrators)
				.where(
					and(
						isNotNull(narrators.oauthOwnerGrantId),
						authorityId ? eq(narrators.oauthOwnerGrantId, authorityId) : undefined,
						narratorCursor ? gt(narrators.id, narratorCursor) : undefined,
					),
				)
				.orderBy(asc(narrators.id))
				.limit(remaining + 1);
			const oauthRows = rows.filter((row) => row.grantId !== null);
			for (const row of oauthRows.slice(0, remaining)) {
				candidates.push({
					resourceType: "narrator",
					id: row.id,
					grantId: row.grantId as string,
					provisionKey: row.provisionKey,
					projectId: row.projectId,
					revoked: false,
				});
			}
			hasMore = rows.length > remaining;
		}
		return this.backfillCandidates(
			candidates,
			hasMore ? encodeCursor({ resourceType: "narrator", id: candidates.at(-1)?.id ?? "" }) : null,
		);
	}

	private async backfillCandidates(
		candidates: Array<{
			resourceType: IntegrationResourceType;
			id: string;
			grantId: string;
			provisionKey: string | null;
			projectId: string | null;
			revoked: boolean;
		}>,
		nextCursor: string | null,
	): Promise<BackfillIntegrationResourceBindingsResult> {
		let created = 0;
		let skipped = 0;
		for (const candidate of candidates) {
			const grant = await db.query.oauthGrants.findFirst({
				where: eq(oauthGrants.id, candidate.grantId),
				columns: { oauthClientId: true, revokedAt: true },
			});
			if (!grant) {
				skipped++;
				continue;
			}
			const existing = await this.get(candidate.resourceType, candidate.id);
			await this.upsert({
				resourceType: candidate.resourceType,
				resourceId: candidate.id,
				sourceType: "oauth_client",
				sourceId: grant.oauthClientId,
				authorityType: "oauth_grant",
				authorityId: candidate.grantId,
				state: candidate.revoked ? "revoked" : grant.revokedAt ? "orphaned" : "active",
				provisionKey: candidate.provisionKey,
				metadataJson: {
					...(candidate.provisionKey ? { provisionKey: candidate.provisionKey } : {}),
					...(candidate.projectId ? { projectId: candidate.projectId } : {}),
				},
			});
			if (!existing) created++;
		}
		return { processed: candidates.length, created, skipped, nextCursor };
	}
}

export const integrationResourceBindingService = new IntegrationResourceBindingService();

export interface StartupIntegrationResourceBackfillOptions {
	batchSize?: number;
	maxRows?: number;
}

/**
 * Backfill legacy OAuth-owned resources after migrations without delaying HTTP startup.
 * Work is cursor-paged and yields between batches so SQLite never performs one unbounded scan.
 */
export async function backfillIntegrationResourceBindingsOnStartup(
	options: StartupIntegrationResourceBackfillOptions = {},
): Promise<BackfillIntegrationResourceBindingsResult> {
	const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), MAX_PAGE_LIMIT);
	const maxRows = Math.min(Math.max(options.maxRows ?? 10_000, batchSize), 100_000);
	let cursor: string | undefined;
	let processed = 0;
	let created = 0;
	let skipped = 0;
	let nextCursor: string | null = null;

	do {
		const remaining = maxRows - processed;
		if (remaining <= 0) break;
		const page = await integrationResourceBindingService.backfill({
			limit: Math.min(batchSize, remaining),
			cursor,
		});
		processed += page.processed;
		created += page.created;
		skipped += page.skipped;
		nextCursor = page.nextCursor;
		cursor = page.nextCursor ?? undefined;
		if (cursor) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	} while (cursor);

	if (nextCursor) {
		logger.warn("Integration resource provenance backfill reached its startup limit", {
			processed,
			created,
			skipped,
			maxRows,
		});
	} else if (processed > 0 || created > 0 || skipped > 0) {
		logger.info("Integration resource provenance backfill completed", {
			processed,
			created,
			skipped,
		});
	}

	return { processed, created, skipped, nextCursor };
}
