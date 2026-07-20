import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import {
	type CredentialRef,
	credentialRefKey,
	type PrincipalRef,
	principalRefKey,
} from "@shared/integrations/principals";
import type { ResourceRef, ResourceScope } from "@shared/integrations/resources";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db";
import { integrationAuditEvents } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";

export const INTEGRATION_AUDIT_METADATA_MAX_BYTES = 4 * 1024;
export const INTEGRATION_AUDIT_MAX_PAGE_SIZE = 100;

export type IntegrationAuditOutcome =
	| "allowed"
	| "denied"
	| "succeeded"
	| "failed"
	| "revoked"
	| "overflow";

export interface RecordIntegrationAuditInput {
	principal: PrincipalRef;
	credential?: CredentialRef;
	authorityId?: string | null;
	transport: string;
	operationId: string;
	capabilityId?: CanonicalCapabilityId | null;
	resource?: ResourceRef | null;
	scope?: ResourceScope | null;
	outcome: IntegrationAuditOutcome;
	reasonCode?: string | null;
	durationMs?: number | null;
	requestBytes?: number;
	responseBytes?: number;
	metadata?: Record<string, unknown> | null;
	createdAt?: string;
}

function boundedText(value: string, field: string, maxLength = 128): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength || /[\0\r\n]/u.test(normalized)) {
		throw new ValidationError(`${field} is invalid`);
	}
	return normalized;
}

function boundedBytes(value: number | undefined, field: string): number {
	const normalized = value ?? 0;
	if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 64 * 1024 * 1024) {
		throw new ValidationError(`${field} is invalid`);
	}
	return normalized;
}

function boundedDuration(value: number | null | undefined): number | null {
	if (value == null) return null;
	if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60 * 1_000) {
		throw new ValidationError("durationMs is invalid");
	}
	return value;
}

function sanitizeMetadata(value: Record<string, unknown> | null | undefined) {
	if (!value) return null;
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, "utf8") > INTEGRATION_AUDIT_METADATA_MAX_BYTES) {
		throw new ValidationError("Integration audit metadata is too large");
	}
	return JSON.parse(serialized) as Record<string, unknown>;
}

function splitRef(value: string): { type: string; id: string | null } {
	const separator = value.indexOf(":");
	return separator === -1
		? { type: value, id: null }
		: { type: value.slice(0, separator), id: value.slice(separator + 1) };
}

interface AuditCursor {
	createdAt: string;
	id: string;
}

function encodeCursor(cursor: AuditCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): AuditCursor | null {
	if (!value) return null;
	if (Buffer.byteLength(value, "utf8") > 2_048) throw new ValidationError("cursor is too large");
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<AuditCursor>;
		if (
			typeof parsed.createdAt !== "string" ||
			!Number.isFinite(Date.parse(parsed.createdAt)) ||
			typeof parsed.id !== "string"
		) {
			throw new Error("invalid cursor");
		}
		return { createdAt: parsed.createdAt, id: boundedText(parsed.id, "cursor id", 256) };
	} catch (error) {
		if (error instanceof ValidationError) throw error;
		throw new ValidationError("Invalid integration audit cursor");
	}
}

export class IntegrationAuditService {
	async record(input: RecordIntegrationAuditInput) {
		const principal = splitRef(principalRefKey(input.principal));
		const credential = input.credential
			? splitRef(credentialRefKey(input.credential))
			: { type: null, id: null };
		const scope = input.scope ?? null;
		const [row] = await db
			.insert(integrationAuditEvents)
			.values({
				id: generateId(),
				principalType: principal.type,
				principalId: principal.id,
				authorityId: input.authorityId ?? null,
				credentialType: credential.type,
				credentialId: credential.id,
				transport: boundedText(input.transport, "transport", 64),
				operationId: boundedText(input.operationId, "operationId"),
				capabilityId: input.capabilityId ?? null,
				resourceType: input.resource?.type ?? null,
				resourceId: input.resource?.id ?? null,
				scopeType: scope?.type ?? null,
				scopeId: scope && scope.type !== "global" ? scope.id : null,
				outcome: input.outcome,
				reasonCode: input.reasonCode ? boundedText(input.reasonCode, "reasonCode", 128) : null,
				durationMs: boundedDuration(input.durationMs),
				requestBytes: boundedBytes(input.requestBytes, "requestBytes"),
				responseBytes: boundedBytes(input.responseBytes, "responseBytes"),
				metadataJson: sanitizeMetadata(input.metadata),
				createdAt: input.createdAt ?? new Date().toISOString(),
			})
			.returning();
		return row;
	}

	async listByAuthority(input: { authorityId: string; cursor?: string; limit?: number }) {
		const authorityId = boundedText(input.authorityId, "authorityId", 256);
		const limit = Math.min(
			INTEGRATION_AUDIT_MAX_PAGE_SIZE,
			Math.max(1, Math.trunc(input.limit ?? 50)),
		);
		const cursor = decodeCursor(input.cursor);
		const rows = await db.query.integrationAuditEvents.findMany({
			where: and(
				eq(integrationAuditEvents.authorityId, authorityId),
				cursor
					? or(
							lt(integrationAuditEvents.createdAt, cursor.createdAt),
							and(
								eq(integrationAuditEvents.createdAt, cursor.createdAt),
								lt(integrationAuditEvents.id, cursor.id),
							),
						)
					: undefined,
			),
			orderBy: [desc(integrationAuditEvents.createdAt), desc(integrationAuditEvents.id)],
			limit: limit + 1,
		});
		const hasMore = rows.length > limit;
		const items = hasMore ? rows.slice(0, limit) : rows;
		const last = items.at(-1);
		return {
			items,
			nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
		};
	}
}

export const integrationAuditService = new IntegrationAuditService();
