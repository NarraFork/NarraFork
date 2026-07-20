import {
	CANONICAL_CAPABILITY_DESCRIPTORS,
	type CanonicalCapabilityId,
} from "@shared/integrations/capabilities";
import { type ResourceScope, resourceScopeSchema } from "@shared/integrations/resources";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { integrationAuthorities, integrationCapabilityGrants } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { integrationAuditService } from "./integration-audit-service";
import { emitIntegrationAuthorityInvalidation } from "./integration-authority-invalidation";

const MAX_GRANTS_PER_AUTHORITY = 2_000;
const MAX_POLICY_BYTES = 8 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_CONSTRAINTS_BYTES = 4 * 1024;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 128;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_BYTES = 4 * 1024;

const constraintStringSchema = z.string().trim().min(1).max(4_096);
export const integrationGrantConstraintsSchema = z
	.object({
		topics: z.array(constraintStringSchema.max(200)).max(100).optional(),
		methods: z.array(constraintStringSchema.max(200)).max(100).optional(),
		paths: z.array(constraintStringSchema).max(100).optional(),
		fields: z.array(constraintStringSchema.max(200)).max(100).optional(),
		providerIds: z.array(constraintStringSchema.max(128)).max(100).optional(),
		resourceIds: z.array(constraintStringSchema.max(128)).max(100).optional(),
		maxBytes: z
			.number()
			.int()
			.positive()
			.max(64 * 1024 * 1024)
			.optional(),
		maxRatePerSecond: z.number().finite().positive().max(10_000).optional(),
	})
	.strict();
export type IntegrationGrantConstraints = z.infer<typeof integrationGrantConstraintsSchema>;

export type IntegrationAuthorityKind = "oauth_grant" | "plugin_installation";
export type IntegrationAuthorityState = "active" | "suspended" | "revoked" | "expired";
export type IntegrationAuthority = typeof integrationAuthorities.$inferSelect;
export type IntegrationCapabilityGrant = typeof integrationCapabilityGrants.$inferSelect;
export type IntegrationAuthorityTransaction = Pick<typeof db, "insert" | "select" | "update">;

export interface IntegrationCapabilityGrantInput {
	id?: string;
	capabilityId: CanonicalCapabilityId;
	scope: ResourceScope;
	constraints?: IntegrationGrantConstraints;
	expiresAt?: string;
	createdBy: { type: "user"; id: string } | { type: "system" };
}

export interface CreateIntegrationAuthorityInput {
	id?: string;
	kind: IntegrationAuthorityKind;
	integrationType?: "oauth_client" | "plugin";
	integrationId: string;
	sourceGrantId?: string;
	ownerUserId?: string | null;
	policyJson?: Record<string, unknown> | null;
	metadataJson?: Record<string, unknown> | null;
	expiresAt?: string | null;
	grants: IntegrationCapabilityGrantInput[];
	initialRevision?: number;
}

export interface ApplyIntegrationAuthorityInput extends CreateIntegrationAuthorityInput {
	id: string;
	expectedRevision?: number;
}

export interface IntegrationAuthoritySnapshot {
	authority: IntegrationAuthority;
	grants: IntegrationCapabilityGrant[];
}

export class IntegrationAuthorityConflictError extends AppError {
	constructor(message: string) {
		super(message, 409, "INTEGRATION_AUTHORITY_CONFLICT");
		this.name = "IntegrationAuthorityConflictError";
	}
}

function normalizeId(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256 || /[\0\r\n]/u.test(normalized)) {
		throw new ValidationError(`${field} is invalid`);
	}
	return normalized;
}

function assertCanonicalCapability(value: string): asserts value is CanonicalCapabilityId {
	if (!(value in CANONICAL_CAPABILITY_DESCRIPTORS)) {
		throw new ValidationError(`Unknown canonical capability: ${value}`);
	}
}

function normalizeInitialRevision(value: number | undefined): number {
	const revision = value ?? 1;
	if (!Number.isSafeInteger(revision) || revision < 1) {
		throw new ValidationError("initialRevision must be a positive integer");
	}
	return revision;
}

function normalizeOptionalTimestamp(value: string | null | undefined, field: string) {
	if (value == null) return value;
	if (!Number.isFinite(Date.parse(value)))
		throw new ValidationError(`${field} must be an ISO timestamp`);
	return new Date(value).toISOString();
}

function integrationTypeFor(
	kind: IntegrationAuthorityKind,
	explicit?: "oauth_client" | "plugin",
): "oauth_client" | "plugin" {
	const expected = kind === "oauth_grant" ? "oauth_client" : "plugin";
	if (explicit !== undefined && explicit !== expected) {
		throw new ValidationError("integrationType does not match authority kind");
	}
	return expected;
}

function inspectBoundedJson(
	value: unknown,
	maxBytes: number,
	field: string,
): Record<string, unknown> | null {
	if (value == null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${field} must be a JSON object`);
	}
	let keys = 0;
	const visit = (current: unknown, depth: number): void => {
		if (depth > MAX_JSON_DEPTH) throw new ValidationError(`${field} exceeds maximum depth`);
		if (typeof current === "string") {
			if (Buffer.byteLength(current, "utf8") > MAX_STRING_BYTES) {
				throw new ValidationError(`${field} contains an oversized string`);
			}
			return;
		}
		if (
			current === null ||
			typeof current === "boolean" ||
			(typeof current === "number" && Number.isFinite(current))
		) {
			return;
		}
		if (Array.isArray(current)) {
			if (current.length > MAX_ARRAY_ITEMS) {
				throw new ValidationError(`${field} contains an oversized array`);
			}
			for (const item of current) visit(item, depth + 1);
			return;
		}
		if (typeof current !== "object") throw new ValidationError(`${field} is not JSON-safe`);
		for (const [key, child] of Object.entries(current)) {
			keys++;
			if (keys > MAX_JSON_KEYS || key.length > 128) {
				throw new ValidationError(`${field} contains too many or oversized keys`);
			}
			if (["__proto__", "prototype", "constructor"].includes(key)) {
				throw new ValidationError(`${field} contains a forbidden key`);
			}
			visit(child, depth + 1);
		}
	};
	visit(value, 0);
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		throw new ValidationError(`${field} exceeds ${maxBytes} bytes`);
	}
	return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeScope(scope: ResourceScope): ResourceScope {
	return resourceScopeSchema.parse(scope);
}

function scopeKey(scope: ResourceScope): string {
	return scope.type === "global" ? "global" : `${scope.type}:${scope.id}`;
}

function normalizeGrant(input: IntegrationCapabilityGrantInput) {
	assertCanonicalCapability(input.capabilityId);
	const scope = normalizeScope(input.scope);
	const constraints = input.constraints
		? integrationGrantConstraintsSchema.parse(input.constraints)
		: undefined;
	const constraintsJson = inspectBoundedJson(
		constraints,
		MAX_CONSTRAINTS_BYTES,
		"grant constraints",
	);
	if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
		throw new ValidationError("grant expiresAt must be an ISO timestamp");
	}
	return {
		id: input.id === undefined ? undefined : normalizeId(input.id, "grant id"),
		capabilityId: input.capabilityId,
		scope,
		scopeKey: scopeKey(scope),
		constraintsJson,
		expiresAt: input.expiresAt,
		createdByType: input.createdBy.type,
		createdById:
			input.createdBy.type === "user" ? normalizeId(input.createdBy.id, "createdBy.id") : null,
	};
}

function normalizeGrants(inputs: IntegrationCapabilityGrantInput[]) {
	if (inputs.length > MAX_GRANTS_PER_AUTHORITY) {
		throw new ValidationError(`An authority may have at most ${MAX_GRANTS_PER_AUTHORITY} grants`);
	}
	const grants = inputs.map(normalizeGrant);
	const fingerprints = grants.map((grant) => `${grant.capabilityId}\0${grant.scopeKey}`);
	if (new Set(fingerprints).size !== fingerprints.length) {
		throw new ValidationError("Authority grants must be unique by capability and scope");
	}
	const explicitIds = grants.flatMap((grant) => (grant.id ? [grant.id] : []));
	if (new Set(explicitIds).size !== explicitIds.length) {
		throw new ValidationError("Authority grant ids must be unique");
	}
	return grants;
}

function insertGrantRows(
	executor: Pick<typeof db, "insert">,
	authorityId: string,
	grants: ReturnType<typeof normalizeGrants>,
	now: string,
): void {
	if (grants.length === 0) return;
	executor
		.insert(integrationCapabilityGrants)
		.values(
			grants.map((grant) => ({
				id: grant.id ?? generateId(),
				authorityId,
				capabilityId: grant.capabilityId,
				scopeType: grant.scope.type,
				scopeId: grant.scope.type === "global" ? null : grant.scope.id,
				scopeKey: grant.scopeKey,
				constraintsJson: grant.constraintsJson,
				expiresAt: grant.expiresAt ?? null,
				revokedAt: null,
				createdByType: grant.createdByType,
				createdById: grant.createdById,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.run();
}

function recordAuthorityAudit(
	snapshot: IntegrationAuthoritySnapshot,
	operationId: string,
	outcome: "succeeded" | "revoked",
	reasonCode?: string,
): void {
	const authority = snapshot.authority;
	const oauth = authority.kind === "oauth_grant";
	void integrationAuditService
		.record({
			principal: oauth
				? { type: "oauth_client", id: authority.integrationId }
				: { type: "plugin_installation", id: authority.id },
			credential: oauth
				? { type: "oauth_token", id: authority.id }
				: { type: "plugin_credential", id: authority.id },
			authorityId: authority.id,
			transport: "integration-kernel",
			operationId,
			resource: { type: "integration", id: authority.integrationId },
			scope: { type: "integration", id: authority.id },
			outcome,
			reasonCode,
			metadata: {
				kind: authority.kind,
				state: authority.state,
				revision: authority.revision,
				grantCount: snapshot.grants.length,
			},
		})
		.catch((error) => {
			logger.warn("Integration authority audit write failed", {
				authorityId: authority.id,
				operationId,
				error: String(error),
			});
		});
}

export class IntegrationAuthorityService {
	applyInTransaction(
		executor: IntegrationAuthorityTransaction,
		input: ApplyIntegrationAuthorityInput,
		now = new Date().toISOString(),
	): { created: boolean; revision: number } {
		const id = normalizeId(input.id, "authority id");
		if (
			input.sourceGrantId !== undefined &&
			normalizeId(input.sourceGrantId, "sourceGrantId") !== id
		) {
			throw new ValidationError("sourceGrantId must match the authority id");
		}
		const integrationId = normalizeId(input.integrationId, "integrationId");
		const integrationType = integrationTypeFor(input.kind, input.integrationType);
		const sourceGrantId =
			input.sourceGrantId === undefined
				? input.kind === "oauth_grant"
					? id
					: null
				: normalizeId(input.sourceGrantId, "sourceGrantId");
		const ownerUserId = input.ownerUserId ? normalizeId(input.ownerUserId, "ownerUserId") : null;
		const policyJson =
			input.policyJson === undefined
				? undefined
				: inspectBoundedJson(input.policyJson, MAX_POLICY_BYTES, "authority policy");
		const metadataJson =
			input.metadataJson === undefined
				? undefined
				: inspectBoundedJson(input.metadataJson, MAX_METADATA_BYTES, "authority metadata");
		const expiresAt = normalizeOptionalTimestamp(input.expiresAt, "authority expiresAt");
		const grants = normalizeGrants(input.grants);
		const initialRevision = normalizeInitialRevision(input.initialRevision);
		const existing = executor
			.select()
			.from(integrationAuthorities)
			.where(eq(integrationAuthorities.id, id))
			.limit(1)
			.get();

		if (!existing) {
			if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
				throw new IntegrationAuthorityConflictError(
					`Authority revision mismatch: expected ${input.expectedRevision}, authority does not exist`,
				);
			}
			executor
				.insert(integrationAuthorities)
				.values({
					id,
					kind: input.kind,
					integrationType,
					integrationId,
					ownerUserId,
					sourceGrantId,
					state: "active",
					revision: initialRevision,
					policyJson: policyJson ?? null,
					metadataJson: metadataJson ?? null,
					expiresAt: expiresAt ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			insertGrantRows(executor, id, grants, now);
			return { created: true, revision: initialRevision };
		}

		const repairsMissingOAuthSourceGrant =
			input.kind === "oauth_grant" &&
			existing.sourceGrantId === null &&
			sourceGrantId === existing.id;
		if (
			existing.kind !== input.kind ||
			existing.integrationType !== integrationType ||
			existing.integrationId !== integrationId ||
			existing.ownerUserId !== ownerUserId ||
			(existing.sourceGrantId !== sourceGrantId && !repairsMissingOAuthSourceGrant)
		) {
			throw new IntegrationAuthorityConflictError(
				"Integration authority identity cannot be replaced",
			);
		}
		if (existing.state !== "active") {
			throw new IntegrationAuthorityConflictError("Inactive authorities cannot be modified");
		}
		if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
			throw new IntegrationAuthorityConflictError(
				`Authority revision mismatch: expected ${input.expectedRevision}, current ${existing.revision}`,
			);
		}

		executor
			.update(integrationCapabilityGrants)
			.set({ revokedAt: now, updatedAt: now })
			.where(
				and(
					eq(integrationCapabilityGrants.authorityId, id),
					isNull(integrationCapabilityGrants.revokedAt),
				),
			)
			.run();
		insertGrantRows(executor, id, grants, now);
		const nextRevision = existing.revision + 1;
		const updated = executor
			.update(integrationAuthorities)
			.set({
				revision: nextRevision,
				sourceGrantId: repairsMissingOAuthSourceGrant ? existing.id : existing.sourceGrantId,
				policyJson: policyJson === undefined ? existing.policyJson : policyJson,
				metadataJson: metadataJson === undefined ? existing.metadataJson : metadataJson,
				expiresAt: expiresAt === undefined ? existing.expiresAt : expiresAt,
				updatedAt: now,
			})
			.where(
				and(
					eq(integrationAuthorities.id, id),
					eq(integrationAuthorities.revision, existing.revision),
					eq(integrationAuthorities.state, "active"),
				),
			)
			.returning({ id: integrationAuthorities.id })
			.all();
		if (updated.length !== 1) {
			throw new IntegrationAuthorityConflictError("Authority changed concurrently");
		}
		return { created: false, revision: nextRevision };
	}

	revokeInTransaction(
		executor: IntegrationAuthorityTransaction,
		input: { authorityId: string; reason: string; expectedRevision?: number },
		now = new Date().toISOString(),
	): { changed: boolean; revision: number } {
		const authorityId = normalizeId(input.authorityId, "authorityId");
		const reason = normalizeId(input.reason, "reason");
		const authority = executor
			.select()
			.from(integrationAuthorities)
			.where(eq(integrationAuthorities.id, authorityId))
			.limit(1)
			.get();
		if (!authority) throw new NotFoundError("Integration authority", authorityId);
		if (authority.state === "revoked") {
			return { changed: false, revision: authority.revision };
		}
		if (input.expectedRevision !== undefined && authority.revision !== input.expectedRevision) {
			throw new IntegrationAuthorityConflictError(
				`Authority revision mismatch: expected ${input.expectedRevision}, current ${authority.revision}`,
			);
		}
		executor
			.update(integrationCapabilityGrants)
			.set({
				revokedAt: sql`coalesce(${integrationCapabilityGrants.revokedAt}, ${now})`,
				updatedAt: now,
			})
			.where(
				and(
					eq(integrationCapabilityGrants.authorityId, authorityId),
					isNull(integrationCapabilityGrants.revokedAt),
				),
			)
			.run();
		const nextRevision = authority.revision + 1;
		const updated = executor
			.update(integrationAuthorities)
			.set({
				state: "revoked",
				revision: nextRevision,
				revokedAt: now,
				revokedReason: reason,
				updatedAt: now,
			})
			.where(
				and(
					eq(integrationAuthorities.id, authorityId),
					eq(integrationAuthorities.revision, authority.revision),
					inArray(integrationAuthorities.state, ["active", "suspended", "expired"]),
				),
			)
			.returning({ id: integrationAuthorities.id })
			.all();
		if (updated.length !== 1) {
			throw new IntegrationAuthorityConflictError("Authority changed concurrently");
		}
		return { changed: true, revision: nextRevision };
	}

	async create(input: CreateIntegrationAuthorityInput): Promise<IntegrationAuthoritySnapshot> {
		const id = normalizeId(input.id ?? generateId(), "authority id");
		if (
			input.sourceGrantId !== undefined &&
			normalizeId(input.sourceGrantId, "sourceGrantId") !== id
		) {
			throw new ValidationError("sourceGrantId must match the authority id");
		}
		const integrationId = normalizeId(input.integrationId, "integrationId");
		const integrationType = integrationTypeFor(input.kind, input.integrationType);
		const sourceGrantId =
			input.sourceGrantId === undefined
				? input.kind === "oauth_grant"
					? id
					: null
				: normalizeId(input.sourceGrantId, "sourceGrantId");
		const ownerUserId = input.ownerUserId ? normalizeId(input.ownerUserId, "ownerUserId") : null;
		const policyJson =
			input.policyJson === undefined
				? undefined
				: inspectBoundedJson(input.policyJson, MAX_POLICY_BYTES, "authority policy");
		const metadataJson =
			input.metadataJson === undefined
				? undefined
				: inspectBoundedJson(input.metadataJson, MAX_METADATA_BYTES, "authority metadata");
		const expiresAt = normalizeOptionalTimestamp(input.expiresAt, "authority expiresAt");
		const grants = normalizeGrants(input.grants);
		const initialRevision = normalizeInitialRevision(input.initialRevision);
		const now = new Date().toISOString();

		try {
			db.transaction((tx) => {
				tx.insert(integrationAuthorities)
					.values({
						id,
						kind: input.kind,
						integrationType,
						integrationId,
						ownerUserId,
						sourceGrantId,
						state: "active",
						revision: initialRevision,
						policyJson: policyJson ?? null,
						metadataJson: metadataJson ?? null,
						expiresAt: expiresAt ?? null,
						createdAt: now,
						updatedAt: now,
					})
					.run();
				insertGrantRows(tx, id, grants, now);
			});
		} catch (error) {
			if (/unique constraint|UNIQUE constraint|SQLITE_CONSTRAINT/i.test(String(error))) {
				throw new IntegrationAuthorityConflictError(`Integration authority already exists: ${id}`);
			}
			throw error;
		}
		const snapshot = await this.requireSnapshot(id);
		emitIntegrationAuthorityInvalidation({
			authorityId: id,
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			reason: "authority-created",
		});
		recordAuthorityAudit(snapshot, "integration.authority.create", "succeeded");
		return snapshot;
	}

	async getSnapshot(
		authorityId: string,
		options: { includeExpired?: boolean } = {},
	): Promise<IntegrationAuthoritySnapshot | null> {
		const id = normalizeId(authorityId, "authorityId");
		const storedAuthority = await db.query.integrationAuthorities.findFirst({
			where: eq(integrationAuthorities.id, id),
		});
		if (!storedAuthority) return null;
		const now = new Date().toISOString();
		const authority =
			storedAuthority.state === "active" &&
			storedAuthority.expiresAt !== null &&
			storedAuthority.expiresAt <= now
				? { ...storedAuthority, state: "expired" as const }
				: storedAuthority;
		const grants = await db.query.integrationCapabilityGrants.findMany({
			where: options.includeExpired
				? and(
						eq(integrationCapabilityGrants.authorityId, id),
						isNull(integrationCapabilityGrants.revokedAt),
					)
				: and(
						eq(integrationCapabilityGrants.authorityId, id),
						isNull(integrationCapabilityGrants.revokedAt),
						or(
							isNull(integrationCapabilityGrants.expiresAt),
							gt(integrationCapabilityGrants.expiresAt, now),
						),
					),
			orderBy: [
				asc(integrationCapabilityGrants.capabilityId),
				asc(integrationCapabilityGrants.scopeKey),
				asc(integrationCapabilityGrants.id),
			],
			limit: MAX_GRANTS_PER_AUTHORITY + 1,
		});
		if (grants.length > MAX_GRANTS_PER_AUTHORITY) {
			throw new AppError(
				"Integration authority grant limit was exceeded",
				500,
				"INTEGRATION_GRANT_LIMIT_EXCEEDED",
			);
		}
		return { authority, grants };
	}

	async requireSnapshot(
		authorityId: string,
		options: { includeExpired?: boolean } = {},
	): Promise<IntegrationAuthoritySnapshot> {
		const snapshot = await this.getSnapshot(authorityId, options);
		if (!snapshot) throw new NotFoundError("Integration authority", authorityId);
		return snapshot;
	}

	async replaceGrants(input: {
		authorityId: string;
		expectedRevision: number;
		grants: IntegrationCapabilityGrantInput[];
		policyJson?: Record<string, unknown> | null;
		metadataJson?: Record<string, unknown> | null;
		expiresAt?: string | null;
	}): Promise<IntegrationAuthoritySnapshot> {
		const authorityId = normalizeId(input.authorityId, "authorityId");
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
			throw new ValidationError("expectedRevision must be a positive integer");
		}
		const grants = normalizeGrants(input.grants);
		const policyJson =
			input.policyJson === undefined
				? undefined
				: inspectBoundedJson(input.policyJson, MAX_POLICY_BYTES, "authority policy");
		const metadataJson =
			input.metadataJson === undefined
				? undefined
				: inspectBoundedJson(input.metadataJson, MAX_METADATA_BYTES, "authority metadata");
		const expiresAt = normalizeOptionalTimestamp(input.expiresAt, "authority expiresAt");
		const now = new Date().toISOString();

		db.transaction((tx) => {
			const authority = tx
				.select()
				.from(integrationAuthorities)
				.where(eq(integrationAuthorities.id, authorityId))
				.limit(1)
				.get();
			if (!authority) throw new NotFoundError("Integration authority", authorityId);
			if (authority.state !== "active") {
				throw new IntegrationAuthorityConflictError("Inactive authorities cannot be modified");
			}
			if (authority.revision !== input.expectedRevision) {
				throw new IntegrationAuthorityConflictError(
					`Authority revision mismatch: expected ${input.expectedRevision}, current ${authority.revision}`,
				);
			}
			tx.update(integrationCapabilityGrants)
				.set({ revokedAt: now, updatedAt: now })
				.where(
					and(
						eq(integrationCapabilityGrants.authorityId, authorityId),
						isNull(integrationCapabilityGrants.revokedAt),
					),
				)
				.run();
			insertGrantRows(tx, authorityId, grants, now);
			const updated = tx
				.update(integrationAuthorities)
				.set({
					revision: authority.revision + 1,
					policyJson: policyJson === undefined ? authority.policyJson : policyJson,
					metadataJson: metadataJson === undefined ? authority.metadataJson : metadataJson,
					expiresAt: expiresAt === undefined ? authority.expiresAt : expiresAt,
					updatedAt: now,
				})
				.where(
					and(
						eq(integrationAuthorities.id, authorityId),
						eq(integrationAuthorities.revision, authority.revision),
						eq(integrationAuthorities.state, "active"),
					),
				)
				.returning({ id: integrationAuthorities.id })
				.all();
			if (updated.length !== 1) {
				throw new IntegrationAuthorityConflictError("Authority changed concurrently");
			}
		});
		const snapshot = await this.requireSnapshot(authorityId);
		emitIntegrationAuthorityInvalidation({
			authorityId,
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			reason: "grants-replaced",
		});
		recordAuthorityAudit(snapshot, "integration.grants.replace", "succeeded");
		return snapshot;
	}

	async revokeGrants(input: {
		authorityId: string;
		expectedRevision: number;
		grantIds: string[];
	}): Promise<IntegrationAuthoritySnapshot> {
		const authorityId = normalizeId(input.authorityId, "authorityId");
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
			throw new ValidationError("expectedRevision must be a positive integer");
		}
		const grantIds = [...new Set(input.grantIds.map((id) => normalizeId(id, "grant id")))];
		if (grantIds.length > MAX_GRANTS_PER_AUTHORITY) {
			throw new ValidationError("Too many integration grants were selected for revocation");
		}
		const now = new Date().toISOString();
		db.transaction((tx) => {
			const authority = tx
				.select()
				.from(integrationAuthorities)
				.where(eq(integrationAuthorities.id, authorityId))
				.limit(1)
				.get();
			if (!authority) throw new NotFoundError("Integration authority", authorityId);
			if (authority.state !== "active") {
				throw new IntegrationAuthorityConflictError("Inactive authorities cannot be modified");
			}
			if (authority.revision !== input.expectedRevision) {
				throw new IntegrationAuthorityConflictError(
					`Authority revision mismatch: expected ${input.expectedRevision}, current ${authority.revision}`,
				);
			}
			if (grantIds.length === 0) return;
			const grants = tx
				.select({ id: integrationCapabilityGrants.id })
				.from(integrationCapabilityGrants)
				.where(
					and(
						eq(integrationCapabilityGrants.authorityId, authorityId),
						inArray(integrationCapabilityGrants.id, grantIds),
						isNull(integrationCapabilityGrants.revokedAt),
					),
				)
				.all();
			if (grants.length !== grantIds.length) {
				throw new ValidationError("One or more integration grants were not found");
			}
			tx.update(integrationCapabilityGrants)
				.set({ revokedAt: now, updatedAt: now })
				.where(
					and(
						eq(integrationCapabilityGrants.authorityId, authorityId),
						inArray(integrationCapabilityGrants.id, grantIds),
						isNull(integrationCapabilityGrants.revokedAt),
					),
				)
				.run();
			const updated = tx
				.update(integrationAuthorities)
				.set({ revision: authority.revision + 1, updatedAt: now })
				.where(
					and(
						eq(integrationAuthorities.id, authorityId),
						eq(integrationAuthorities.revision, authority.revision),
						eq(integrationAuthorities.state, "active"),
					),
				)
				.returning({ id: integrationAuthorities.id })
				.all();
			if (updated.length !== 1) {
				throw new IntegrationAuthorityConflictError("Authority changed concurrently");
			}
		});
		const snapshot = await this.requireSnapshot(authorityId, { includeExpired: true });
		emitIntegrationAuthorityInvalidation({
			authorityId,
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			reason: "grants-revoked",
		});
		recordAuthorityAudit(snapshot, "integration.grants.revoke", "succeeded");
		return snapshot;
	}

	async setState(input: {
		authorityId: string;
		expectedRevision: number;
		state: Exclude<IntegrationAuthorityState, "revoked">;
	}): Promise<IntegrationAuthoritySnapshot> {
		const authorityId = normalizeId(input.authorityId, "authorityId");
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
			throw new ValidationError("expectedRevision must be a positive integer");
		}
		const now = new Date().toISOString();
		db.transaction((tx) => {
			const authority = tx
				.select()
				.from(integrationAuthorities)
				.where(eq(integrationAuthorities.id, authorityId))
				.limit(1)
				.get();
			if (!authority) throw new NotFoundError("Integration authority", authorityId);
			if (authority.state === "revoked") {
				throw new IntegrationAuthorityConflictError("Revoked authorities cannot be reactivated");
			}
			if (authority.revision !== input.expectedRevision) {
				throw new IntegrationAuthorityConflictError(
					`Authority revision mismatch: expected ${input.expectedRevision}, current ${authority.revision}`,
				);
			}
			if (input.state === "active" && authority.expiresAt !== null && authority.expiresAt <= now) {
				throw new IntegrationAuthorityConflictError(
					"Expired authorities require a future expiresAt before reactivation",
				);
			}
			if (authority.state === input.state) return;
			const updated = tx
				.update(integrationAuthorities)
				.set({ state: input.state, revision: authority.revision + 1, updatedAt: now })
				.where(
					and(
						eq(integrationAuthorities.id, authorityId),
						eq(integrationAuthorities.revision, authority.revision),
					),
				)
				.returning({ id: integrationAuthorities.id })
				.all();
			if (updated.length !== 1) {
				throw new IntegrationAuthorityConflictError("Authority changed concurrently");
			}
		});
		const snapshot = await this.requireSnapshot(authorityId, { includeExpired: true });
		emitIntegrationAuthorityInvalidation({
			authorityId,
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			reason: `authority-${input.state}`,
		});
		recordAuthorityAudit(snapshot, "integration.authority.state", "succeeded", input.state);
		return snapshot;
	}

	async repairOAuthSourceGrantId(input: {
		authorityId: string;
		expectedRevision?: number;
	}): Promise<IntegrationAuthoritySnapshot> {
		const authorityId = normalizeId(input.authorityId, "authorityId");
		if (
			input.expectedRevision !== undefined &&
			(!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
		) {
			throw new ValidationError("expectedRevision must be a positive integer");
		}
		let changed = false;
		const now = new Date().toISOString();
		db.transaction((tx) => {
			const authority = tx
				.select()
				.from(integrationAuthorities)
				.where(eq(integrationAuthorities.id, authorityId))
				.limit(1)
				.get();
			if (!authority) throw new NotFoundError("Integration authority", authorityId);
			if (authority.kind !== "oauth_grant" || authority.integrationType !== "oauth_client") {
				throw new IntegrationAuthorityConflictError(
					"Only OAuth grant authorities may repair sourceGrantId",
				);
			}
			if (input.expectedRevision !== undefined && authority.revision !== input.expectedRevision) {
				throw new IntegrationAuthorityConflictError(
					`Authority revision mismatch: expected ${input.expectedRevision}, current ${authority.revision}`,
				);
			}
			if (authority.sourceGrantId === authority.id) return;
			if (authority.sourceGrantId !== null) {
				throw new IntegrationAuthorityConflictError("OAuth authority sourceGrantId is immutable");
			}
			const updated = tx
				.update(integrationAuthorities)
				.set({ sourceGrantId: authority.id, revision: authority.revision + 1, updatedAt: now })
				.where(
					and(
						eq(integrationAuthorities.id, authority.id),
						eq(integrationAuthorities.revision, authority.revision),
						isNull(integrationAuthorities.sourceGrantId),
					),
				)
				.returning({ id: integrationAuthorities.id })
				.all();
			if (updated.length !== 1) {
				throw new IntegrationAuthorityConflictError("Authority changed concurrently");
			}
			changed = true;
		});
		const snapshot = await this.requireSnapshot(authorityId, { includeExpired: true });
		if (changed) {
			emitIntegrationAuthorityInvalidation({
				authorityId,
				revision: snapshot.authority.revision,
				state: snapshot.authority.state,
				reason: "authority-source-grant-repaired",
			});
			recordAuthorityAudit(snapshot, "integration.authority.repair_source_grant", "succeeded");
		}
		return snapshot;
	}

	async listForIntegration(input: {
		kind: IntegrationAuthorityKind;
		integrationId: string;
		includeRevoked?: boolean;
		includeExpired?: boolean;
	}): Promise<IntegrationAuthoritySnapshot[]> {
		const integrationId = normalizeId(input.integrationId, "integrationId");
		const integrationType = integrationTypeFor(input.kind);
		const authorities = await db.query.integrationAuthorities.findMany({
			where: input.includeRevoked
				? and(
						eq(integrationAuthorities.kind, input.kind),
						eq(integrationAuthorities.integrationType, integrationType),
						eq(integrationAuthorities.integrationId, integrationId),
					)
				: and(
						eq(integrationAuthorities.kind, input.kind),
						eq(integrationAuthorities.integrationType, integrationType),
						eq(integrationAuthorities.integrationId, integrationId),
						eq(integrationAuthorities.state, "active"),
					),
			orderBy: [asc(integrationAuthorities.createdAt), asc(integrationAuthorities.id)],
			limit: MAX_GRANTS_PER_AUTHORITY + 1,
		});
		if (authorities.length > MAX_GRANTS_PER_AUTHORITY) {
			throw new AppError(
				"Integration authority limit was exceeded",
				500,
				"INTEGRATION_AUTHORITY_LIMIT_EXCEEDED",
			);
		}
		const snapshots = await Promise.all(
			authorities.map((authority) =>
				this.requireSnapshot(authority.id, { includeExpired: input.includeExpired }),
			),
		);
		return input.includeRevoked
			? snapshots
			: snapshots.filter((snapshot) => snapshot.authority.state === "active");
	}

	async revoke(input: {
		authorityId: string;
		reason: string;
		expectedRevision?: number;
	}): Promise<IntegrationAuthoritySnapshot> {
		const authorityId = normalizeId(input.authorityId, "authorityId");
		const reason = normalizeId(input.reason, "reason");
		const now = new Date().toISOString();
		db.transaction((tx) => {
			const authority = tx
				.select()
				.from(integrationAuthorities)
				.where(eq(integrationAuthorities.id, authorityId))
				.limit(1)
				.get();
			if (!authority) throw new NotFoundError("Integration authority", authorityId);
			if (authority.state === "revoked") return;
			if (input.expectedRevision !== undefined && authority.revision !== input.expectedRevision) {
				throw new IntegrationAuthorityConflictError(
					`Authority revision mismatch: expected ${input.expectedRevision}, current ${authority.revision}`,
				);
			}
			tx.update(integrationCapabilityGrants)
				.set({
					revokedAt: sql`coalesce(${integrationCapabilityGrants.revokedAt}, ${now})`,
					updatedAt: now,
				})
				.where(
					and(
						eq(integrationCapabilityGrants.authorityId, authorityId),
						isNull(integrationCapabilityGrants.revokedAt),
					),
				)
				.run();
			tx.update(integrationAuthorities)
				.set({
					state: "revoked",
					revision: authority.revision + 1,
					revokedAt: now,
					revokedReason: reason,
					updatedAt: now,
				})
				.where(
					and(
						eq(integrationAuthorities.id, authorityId),
						eq(integrationAuthorities.revision, authority.revision),
					),
				)
				.run();
		});
		const snapshot = await this.requireSnapshot(authorityId);
		emitIntegrationAuthorityInvalidation({
			authorityId,
			revision: snapshot.authority.revision,
			state: snapshot.authority.state,
			reason: "authority-revoked",
		});
		recordAuthorityAudit(snapshot, "integration.authority.revoke", "revoked", input.reason);
		return snapshot;
	}
}

export const integrationAuthorityService = new IntegrationAuthorityService();
