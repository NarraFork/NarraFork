/**
 * Durable OAuth consent (grant) lifecycle.
 *
 * A grant is the durable intersection between a user and an OAuth client.  A
 * revoked grant is never re-used: re-consent creates a new row so the audit
 * history remains intact.  This module deliberately exposes small DTOs and
 * cursor-paginated queries so HTTP routes do not need to know the storage
 * layout or return secrets.
 */
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../db";
import {
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	projects,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { OAUTH_SUPPORTED_SCOPES } from "../lib/oauth-provider";
import {
	propagateOAuthGrantRestriction,
	propagateOAuthGrantRevocation,
} from "./oauth-runtime-revocation";

export const OAUTH_GRANT_MAX_PROJECTS = 100;
export const OAUTH_GRANT_DEFAULT_PAGE_LIMIT = 50;
export const OAUTH_GRANT_MAX_PAGE_LIMIT = 100;
export const OAUTH_GRANT_MAX_CURSOR_BYTES = 2048;

const SUPPORTED_GRANT_SCOPES = new Set<string>(OAUTH_SUPPORTED_SCOPES);

export type OAuthGrantActorType = "user" | "admin" | "client" | "system";
export type OAuthGrantEventType = "approved" | "denied" | "revoked" | (string & {});

export interface OAuthGrantView {
	id: string;
	userId: string;
	oauthClientId: string;
	clientId: string;
	clientName: string;
	scopes: string[];
	projectIds: string[];
	policyJson: Record<string, unknown> | null;
	legacyUnscoped: boolean;
	consentedAt: string | null;
	lastTokenIssuedAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
	revokedByUserId: string | null;
	revokedByType: OAuthGrantActorType | null;
	revokedReason: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface OAuthGrantPage {
	items: OAuthGrantView[];
	nextCursor: string | null;
}

interface GrantCursor {
	createdAt: string;
	id: string;
}

export interface CreateOAuthGrantInput {
	userId: string;
	/** Public OAuth client_id. */
	clientId?: string;
	/** Internal oauth_clients.id.  One of clientId/oauthClientId is required. */
	oauthClientId?: string;
	scopes: string[];
	projectIds?: string[];
	policyJson?: Record<string, unknown> | null;
	legacyUnscoped?: boolean;
	actorType?: OAuthGrantActorType;
	actorUserId?: string | null;
	requestId?: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
}

export interface RecordOAuthGrantEventInput {
	eventType: OAuthGrantEventType;
	grantId?: string | null;
	userId?: string | null;
	clientId?: string;
	oauthClientId?: string;
	actorType?: OAuthGrantActorType;
	actorUserId?: string | null;
	requestedScopes?: string[];
	grantedScopes?: string[];
	projectIds?: string[];
	reason?: string | null;
	metadata?: Record<string, unknown> | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	requestId?: string | null;
}

export interface RevokeOAuthGrantInput {
	grantId: string;
	userId: string;
	reason?: string;
	actorType?: Extract<OAuthGrantActorType, "user" | "admin" | "system">;
	actorUserId?: string | null;
}

export interface RevokeOAuthGrantsInput {
	grantIds: string[];
	userId: string;
	reason?: string;
	actorType?: Extract<OAuthGrantActorType, "user" | "admin" | "system">;
	actorUserId?: string | null;
}

export interface OAuthGrantIdPage {
	ids: string[];
	hasMore: boolean;
}

function nowIso(): string {
	return new Date().toISOString();
}

function uniqueStrings(values: string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function encodeCursor(cursor: GrantCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): GrantCursor | null {
	if (!cursor) return null;
	if (Buffer.byteLength(cursor, "utf8") > OAUTH_GRANT_MAX_CURSOR_BYTES) {
		throw new ValidationError("OAuth grant cursor is too large");
	}
	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		) as Partial<GrantCursor>;
		if (
			typeof parsed.createdAt !== "string" ||
			!parsed.createdAt ||
			typeof parsed.id !== "string" ||
			!parsed.id
		) {
			throw new Error("invalid cursor shape");
		}
		return { createdAt: parsed.createdAt, id: parsed.id };
	} catch {
		throw new ValidationError("OAuth grant cursor is invalid");
	}
}

function isUniqueConstraintError(error: unknown): boolean {
	return /unique constraint|UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error));
}

async function resolveClient(input: {
	clientId?: string;
	oauthClientId?: string;
	allowRevoked?: boolean;
}) {
	if (!input.clientId && !input.oauthClientId) {
		throw new ValidationError("clientId or oauthClientId is required");
	}
	const row = await db.query.oauthClients.findFirst({
		where: input.oauthClientId
			? eq(oauthClients.id, input.oauthClientId)
			: eq(oauthClients.clientId, input.clientId as string),
	});
	if (!row) throw new NotFoundError("OAuth client", input.oauthClientId ?? input.clientId ?? "");
	if (input.clientId && row.clientId !== input.clientId) {
		throw new ValidationError("clientId does not match oauthClientId");
	}
	if (!input.allowRevoked && row.revokedAt) {
		throw new ValidationError("OAuth client is revoked");
	}
	return row;
}

async function getProjectIds(grantId: string): Promise<string[]> {
	const rows = await db.query.oauthGrantProjects.findMany({
		where: eq(oauthGrantProjects.grantId, grantId),
		columns: { projectId: true },
		orderBy: (table, { asc }) => [asc(table.projectId)],
		limit: OAUTH_GRANT_MAX_PROJECTS,
	});
	return rows.map((row) => row.projectId);
}

async function toGrantView(row: typeof oauthGrants.$inferSelect): Promise<OAuthGrantView> {
	const [client, projectIds] = await Promise.all([
		db.query.oauthClients.findFirst({
			where: eq(oauthClients.id, row.oauthClientId),
			columns: { clientId: true, name: true },
		}),
		getProjectIds(row.id),
	]);
	if (!client) throw new NotFoundError("OAuth client", row.oauthClientId);
	return {
		id: row.id,
		userId: row.userId,
		oauthClientId: row.oauthClientId,
		clientId: client.clientId,
		clientName: client.name,
		scopes: row.scopes,
		projectIds,
		policyJson: row.policyJson ?? null,
		legacyUnscoped: row.legacyUnscoped,
		consentedAt: row.consentedAt,
		lastTokenIssuedAt: row.lastTokenIssuedAt,
		lastUsedAt: row.lastUsedAt,
		revokedAt: row.revokedAt,
		revokedByUserId: row.revokedByUserId,
		revokedByType: row.revokedByType,
		revokedReason: row.revokedReason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function validateGrantInput(
	input: CreateOAuthGrantInput,
	client: typeof oauthClients.$inferSelect,
): Promise<{ scopes: string[]; projectIds: string[] }> {
	if (!input.userId) throw new ValidationError("userId is required");
	const scopes = uniqueStrings(input.scopes);
	for (const scope of scopes) {
		if (!SUPPORTED_GRANT_SCOPES.has(scope)) {
			throw new ValidationError(`Unknown OAuth grant scope: ${scope}`);
		}
		if (!client.scopes.includes(scope)) {
			throw new ValidationError(`Scope not allowed for this client: ${scope}`);
		}
	}
	const projectIds = uniqueStrings(input.projectIds);
	if (projectIds.length > OAUTH_GRANT_MAX_PROJECTS) {
		throw new ValidationError(
			`OAuth grant project allow-list cannot exceed ${OAUTH_GRANT_MAX_PROJECTS} projects`,
		);
	}
	if (projectIds.length > 0) {
		const existing = await db.query.projects.findMany({
			where: inArray(projects.id, projectIds),
			columns: { id: true },
			limit: OAUTH_GRANT_MAX_PROJECTS,
		});
		const existingIds = new Set(existing.map((project) => project.id));
		const missing = projectIds.filter((projectId) => !existingIds.has(projectId));
		if (missing.length > 0) {
			throw new ValidationError(`Unknown project in OAuth grant: ${missing[0]}`);
		}
	}
	return { scopes, projectIds };
}

/**
 * Record an append-only grant event.  `denied` events intentionally accept a
 * null grantId so a consent denial before row creation is still auditable.
 */
export async function recordOAuthGrantEvent(input: RecordOAuthGrantEventInput) {
	let client =
		input.oauthClientId || input.clientId
			? await resolveClient({
					clientId: input.clientId,
					oauthClientId: input.oauthClientId,
					allowRevoked: true,
				})
			: null;
	let grant: typeof oauthGrants.$inferSelect | undefined;
	if (input.grantId) {
		grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, input.grantId) });
		if (!grant) throw new NotFoundError("OAuth grant", input.grantId);
		if (client && client.id !== grant.oauthClientId) {
			throw new ValidationError("OAuth grant does not belong to the OAuth client");
		}
		client ??= await resolveClient({ oauthClientId: grant.oauthClientId, allowRevoked: true });
	}
	if (!client) throw new ValidationError("clientId or oauthClientId is required");
	const now = nowIso();
	const [event] = await db
		.insert(oauthGrantEvents)
		.values({
			id: generateId(),
			grantId: input.grantId ?? null,
			oauthClientId: client.id,
			userId: input.userId ?? grant?.userId ?? null,
			actorType: input.actorType ?? "system",
			actorUserId: input.actorUserId ?? null,
			eventType: input.eventType,
			requestedScopes: uniqueStrings(input.requestedScopes),
			grantedScopes: uniqueStrings(input.grantedScopes),
			projectIds: uniqueStrings(input.projectIds),
			reason: input.reason ?? null,
			metadata: input.metadata ?? null,
			ipAddress: input.ipAddress ?? null,
			userAgent: input.userAgent ?? null,
			requestId: input.requestId ?? null,
			createdAt: now,
		})
		.returning();
	return event;
}

/**
 * Create or atomically re-consent an active grant, never reviving a revoked row.
 *
 * The active-grant lookup is inside the write transaction.  This makes a
 * repeated consent authoritative: the same grant id is retained, but its exact
 * scopes, project mappings, policy snapshot, and audit event are replaced as one
 * unit.  A concurrent first consent retries once after the unique active-grant
 * index reports the winner.
 */
export async function createOAuthGrant(input: CreateOAuthGrantInput): Promise<OAuthGrantView> {
	return createOAuthGrantInternal(input, true);
}

async function createOAuthGrantInternal(
	input: CreateOAuthGrantInput,
	retryOnConflict: boolean,
): Promise<OAuthGrantView> {
	const client = await resolveClient({
		clientId: input.clientId,
		oauthClientId: input.oauthClientId,
	});
	const { scopes, projectIds } = await validateGrantInput(input, client);
	const now = nowIso();
	const legacyUnscoped = input.legacyUnscoped ?? false;
	let grantId = "";
	let removedScopes: string[] = [];
	let removedProjectIds: string[] = [];

	try {
		db.transaction((tx) => {
			const active = tx
				.select()
				.from(oauthGrants)
				.where(
					and(
						eq(oauthGrants.userId, input.userId),
						eq(oauthGrants.oauthClientId, client.id),
						isNull(oauthGrants.revokedAt),
					),
				)
				.limit(1)
				.get();
			grantId = active?.id ?? generateId();
			const previousProjectIds = active
				? tx
						.select({ projectId: oauthGrantProjects.projectId })
						.from(oauthGrantProjects)
						.where(eq(oauthGrantProjects.grantId, active.id))
						.orderBy(oauthGrantProjects.projectId)
						.all()
						.map((row) => row.projectId)
				: [];
			if (active) {
				removedScopes = active.scopes.filter((scope) => !scopes.includes(scope));
				removedProjectIds = previousProjectIds.filter(
					(projectId) => !projectIds.includes(projectId),
				);
			}

			if (active) {
				tx.update(oauthGrants)
					.set({
						scopes,
						policyJson: input.policyJson ?? null,
						legacyUnscoped,
						consentedAt: now,
						updatedAt: now,
					})
					.where(and(eq(oauthGrants.id, active.id), isNull(oauthGrants.revokedAt)))
					.run();
				tx.delete(oauthGrantProjects).where(eq(oauthGrantProjects.grantId, active.id)).run();
			} else {
				tx.insert(oauthGrants)
					.values({
						id: grantId,
						oauthClientId: client.id,
						userId: input.userId,
						scopes,
						policyJson: input.policyJson ?? null,
						legacyUnscoped,
						consentedAt: now,
						createdAt: now,
						updatedAt: now,
					})
					.run();
			}

			for (const projectId of projectIds) {
				tx.insert(oauthGrantProjects)
					.values({ id: generateId(), grantId, projectId, createdAt: now })
					.run();
			}
			tx.insert(oauthGrantEvents)
				.values({
					id: generateId(),
					grantId,
					oauthClientId: client.id,
					userId: input.userId,
					actorType: input.actorType ?? "user",
					actorUserId: input.actorUserId ?? input.userId,
					eventType: "approved",
					requestedScopes: scopes,
					grantedScopes: scopes,
					projectIds,
					metadata: {
						action: active ? "reconsent" : "consent",
						policySnapshot: input.policyJson ?? null,
						...(active
							? {
									previousScopes: active.scopes,
									previousProjectIds,
									previousPolicySnapshot: active.policyJson ?? null,
								}
							: {}),
					},
					requestId: input.requestId ?? null,
					ipAddress: input.ipAddress ?? null,
					userAgent: input.userAgent ?? null,
					createdAt: now,
				})
				.run();
		});
	} catch (error) {
		if (!isUniqueConstraintError(error) || !retryOnConflict) throw error;
		// Another first-consent transaction won the partial unique index. Retry
		// through the same update path; a revoked row is never selected.
		return createOAuthGrantInternal(input, false);
	}

	if (removedScopes.length > 0 || removedProjectIds.length > 0) {
		eventBus.emit({
			type: "oauth:grant_changed",
			grantId,
			change: "restricted",
			reasonCode: "grant_scope_or_project_restricted",
		});
		await propagateOAuthGrantRestriction({ grantId, removedScopes, removedProjectIds });
	}

	const saved = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, grantId) });
	if (!saved) throw new NotFoundError("OAuth grant", grantId);
	return toGrantView(saved);
}

/** Alias kept short for route handlers and callers that use the domain name. */
export const createGrant = createOAuthGrant;

export async function getUserOAuthGrant(
	userId: string,
	grantId: string,
): Promise<OAuthGrantView | null> {
	const row = await db.query.oauthGrants.findFirst({
		where: and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)),
	});
	return row ? toGrantView(row) : null;
}

export const getUserGrant = getUserOAuthGrant;
export type OAuthGrantDTO = OAuthGrantView;

export async function listUserOAuthGrants(
	userId: string,
	options: { limit?: number; cursor?: string; includeRevoked?: boolean } = {},
): Promise<OAuthGrantPage> {
	const requestedLimit = options.limit ?? OAUTH_GRANT_DEFAULT_PAGE_LIMIT;
	if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
		throw new ValidationError("OAuth grant limit must be a positive integer");
	}
	const limit = Math.min(requestedLimit, OAUTH_GRANT_MAX_PAGE_LIMIT);
	const cursor = decodeCursor(options.cursor);
	const conditions = [eq(oauthGrants.userId, userId)];
	if (!options.includeRevoked) conditions.push(isNull(oauthGrants.revokedAt));
	if (cursor) {
		conditions.push(
			or(
				lt(oauthGrants.createdAt, cursor.createdAt),
				and(eq(oauthGrants.createdAt, cursor.createdAt), lt(oauthGrants.id, cursor.id)),
			) as never,
		);
	}
	const rows = await db.query.oauthGrants.findMany({
		where: and(...conditions),
		orderBy: (table) => [desc(table.createdAt), desc(table.id)],
		limit: limit + 1,
	});
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	return {
		items: await Promise.all(pageRows.map(toGrantView)),
		nextCursor: hasMore
			? encodeCursor({
					createdAt: pageRows[pageRows.length - 1].createdAt,
					id: pageRows[pageRows.length - 1].id,
				})
			: null,
	};
}

export const listUserGrants = listUserOAuthGrants;

/**
 * Select one bounded page of active grant ids without loading client/project
 * details. Used by revoke-all so the request path never scans or materializes
 * more than LIMIT + 1 rows.
 */
export async function listActiveUserOAuthGrantIds(
	userId: string,
	limit = OAUTH_GRANT_MAX_PAGE_LIMIT,
): Promise<OAuthGrantIdPage> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > OAUTH_GRANT_MAX_PAGE_LIMIT) {
		throw new ValidationError(
			`OAuth grant id page limit must be between 1 and ${OAUTH_GRANT_MAX_PAGE_LIMIT}`,
		);
	}
	const rows = await db.query.oauthGrants.findMany({
		where: and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)),
		columns: { id: true },
		orderBy: (table) => [desc(table.createdAt), desc(table.id)],
		limit: limit + 1,
	});
	return {
		ids: rows.slice(0, limit).map((row) => row.id),
		hasMore: rows.length > limit,
	};
}

/** Return the project allow-list, enforcing user ownership when requested. */
export async function getGrantProjectIds(grantId: string, userId?: string): Promise<string[]> {
	const grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, grantId) });
	if (!grant || (userId !== undefined && grant.userId !== userId)) return [];
	return getProjectIds(grantId);
}

/** The project list is an explicit allow-list; an empty list grants no project access. */
export async function isOAuthGrantProjectAllowed(
	grantId: string,
	projectId: string,
	userId?: string,
): Promise<boolean> {
	const grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, grantId) });
	if (!grant || grant.revokedAt || (userId !== undefined && grant.userId !== userId)) return false;
	const allowed = await getProjectIds(grantId);
	return allowed.includes(projectId);
}

export const isGrantProjectAllowed = isOAuthGrantProjectAllowed;
export const isProjectAllowed = isOAuthGrantProjectAllowed;
export const getGrantProjects = getGrantProjectIds;

/**
 * Revoke a bounded set of grants owned by one user. Ownership is resolved before
 * mutation, and the grant state plus one event per newly revoked row are written
 * in the same transaction. Already-revoked owned rows are idempotent.
 */
export async function revokeOAuthGrantsForUser(
	input: RevokeOAuthGrantsInput,
): Promise<{ revokedCount: number }> {
	const grantIds = uniqueStrings(input.grantIds);
	if (grantIds.length < 1 || grantIds.length > OAUTH_GRANT_MAX_PAGE_LIMIT) {
		throw new ValidationError(
			`OAuth grant revoke batch must contain between 1 and ${OAUTH_GRANT_MAX_PAGE_LIMIT} ids`,
		);
	}
	const ownedRows = await db.query.oauthGrants.findMany({
		where: and(eq(oauthGrants.userId, input.userId), inArray(oauthGrants.id, grantIds)),
		columns: { id: true },
		limit: OAUTH_GRANT_MAX_PAGE_LIMIT,
	});
	const ownedIds = new Set(ownedRows.map((row) => row.id));
	const missingId = grantIds.find((grantId) => !ownedIds.has(grantId));
	if (missingId) throw new NotFoundError("OAuth grant", missingId);

	const now = nowIso();
	const actorType = input.actorType ?? "user";
	const actorUserId = input.actorUserId ?? input.userId;
	const revokedRows = db.transaction((tx) => {
		const rows = tx
			.update(oauthGrants)
			.set({
				revokedAt: now,
				revokedByUserId: actorUserId,
				revokedByType: actorType,
				revokedReason: input.reason ?? null,
				updatedAt: now,
			})
			.where(
				and(
					eq(oauthGrants.userId, input.userId),
					inArray(oauthGrants.id, grantIds),
					isNull(oauthGrants.revokedAt),
				),
			)
			.returning({
				id: oauthGrants.id,
				oauthClientId: oauthGrants.oauthClientId,
				userId: oauthGrants.userId,
			})
			.all();
		if (rows.length > 0) {
			tx.insert(oauthGrantEvents)
				.values(
					rows.map((row) => ({
						id: generateId(),
						grantId: row.id,
						oauthClientId: row.oauthClientId,
						userId: row.userId,
						actorType,
						actorUserId,
						eventType: "revoked",
						reason: input.reason ?? null,
						createdAt: now,
					})),
				)
				.run();
		}
		return rows;
	});
	if (revokedRows.length > 0) {
		for (const row of revokedRows) {
			eventBus.emit({
				type: "oauth:grant_changed",
				grantId: row.id,
				change: "revoked",
				reasonCode: "grant_revoked",
			});
		}
		await propagateOAuthGrantRevocation(
			revokedRows.map((row) => row.id),
			input.reason ?? "OAuth grant revoked",
		);
	}
	return { revokedCount: revokedRows.length };
}

/** Revoke only a grant owned by the supplied user; revoked rows are idempotent. */
export async function revokeOAuthGrantForUser(
	input: RevokeOAuthGrantInput,
): Promise<OAuthGrantView | null> {
	const existing = await db.query.oauthGrants.findFirst({
		where: and(eq(oauthGrants.id, input.grantId), eq(oauthGrants.userId, input.userId)),
	});
	if (!existing) return null;
	if (!existing.revokedAt) {
		await revokeOAuthGrantsForUser({
			grantIds: [input.grantId],
			userId: input.userId,
			reason: input.reason,
			actorType: input.actorType,
			actorUserId: input.actorUserId,
		});
	}
	const current = await db.query.oauthGrants.findFirst({
		where: and(eq(oauthGrants.id, input.grantId), eq(oauthGrants.userId, input.userId)),
	});
	return current ? toGrantView(current) : null;
}

export const revokeGrantForUser = revokeOAuthGrantForUser;
export const revokeGrantsForUser = revokeOAuthGrantsForUser;

export async function recordApprovedGrantEvent(
	input: Omit<RecordOAuthGrantEventInput, "eventType">,
) {
	return recordOAuthGrantEvent({ ...input, eventType: "approved" });
}

export async function recordDeniedGrantEvent(input: Omit<RecordOAuthGrantEventInput, "eventType">) {
	return recordOAuthGrantEvent({ ...input, eventType: "denied" });
}

export async function recordRevokedGrantEvent(
	input: Omit<RecordOAuthGrantEventInput, "eventType">,
) {
	return recordOAuthGrantEvent({ ...input, eventType: "revoked" });
}

export const recordGrantEvent = recordOAuthGrantEvent;
export const recordApproved = recordApprovedGrantEvent;
export const recordDenied = recordDeniedGrantEvent;
export const recordRevoked = recordRevokedGrantEvent;

export const oauthGrantService = {
	createGrant: createOAuthGrant,
	getUserGrant: getUserOAuthGrant,
	listUserGrants: listUserOAuthGrants,
	listActiveUserGrantIds: listActiveUserOAuthGrantIds,
	getGrantProjectIds,
	isGrantProjectAllowed: isOAuthGrantProjectAllowed,
	revokeGrantForUser: revokeOAuthGrantForUser,
	revokeGrantsForUser: revokeOAuthGrantsForUser,
	recordEvent: recordOAuthGrantEvent,
	recordApproved: recordApprovedGrantEvent,
	recordDenied: recordDeniedGrantEvent,
	recordRevoked: recordRevokedGrantEvent,
};
