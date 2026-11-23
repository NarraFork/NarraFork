import type { Database } from "bun:sqlite";
import type { integrationAuthorities, integrationCapabilityGrants } from "../../db/schema";
import { DbReadError } from "./errors";

export interface IntegrationAuthoritySnapshotReadInput {
	authorityId: string;
	includeExpired: boolean;
	now: string;
}
export interface IntegrationAuthoritySnapshotReadResult {
	storedAuthority: typeof integrationAuthorities.$inferSelect | null;
	grants: Array<
		Omit<typeof integrationCapabilityGrants.$inferSelect, "constraintsJson"> & {
			constraintsJson: string | null;
		}
	>;
}
type StoredAuthority = NonNullable<IntegrationAuthoritySnapshotReadResult["storedAuthority"]>;
type AuthorityRow = Omit<StoredAuthority, "policyJson" | "metadataJson"> & {
	policyJson: string | null;
	metadataJson: string | null;
	policyBytes: number;
	metadataBytes: number;
};
type GrantRow = IntegrationAuthoritySnapshotReadResult["grants"][number] & {
	constraintsBytes: number;
};
/** One registry-owned snapshot: revision and bounded live grants always belong together. */
export function readIntegrationAuthoritySnapshotTask(
	client: Database,
	input: IntegrationAuthoritySnapshotReadInput,
	signal?: AbortSignal,
): IntegrationAuthoritySnapshotReadResult {
	signal?.throwIfAborted();
	const row = client
		.query<AuthorityRow, [string]>(`
		SELECT id, kind, integration_type AS integrationType, integration_id AS integrationId,
			owner_user_id AS ownerUserId, source_grant_id AS sourceGrantId, state, revision,
			CAST(substr(CAST(policy_json AS BLOB), 1, 8193) AS TEXT) AS policyJson,
			CAST(substr(CAST(metadata_json AS BLOB), 1, 8193) AS TEXT) AS metadataJson,
			coalesce(octet_length(policy_json), 0) AS policyBytes,
			coalesce(octet_length(metadata_json), 0) AS metadataBytes,
			expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt,
			revoked_at AS revokedAt, revoked_reason AS revokedReason
		FROM integration_authorities WHERE id = ? LIMIT 1
	`)
		.get(input.authorityId);
	if (!row) return { storedAuthority: null, grants: [] };
	const { policyBytes, metadataBytes, policyJson, metadataJson, ...authority } = row;
	if (policyBytes > 8192 || metadataBytes > 8192)
		throw new DbReadError("DB_READ_BUDGET", "Integration authority exceeds its source byte budget");
	const storedAuthority: StoredAuthority = {
		...authority,
		policyJson: policyJson === null ? null : JSON.parse(policyJson),
		metadataJson: metadataJson === null ? null : JSON.parse(metadataJson),
	};
	const rows = client
		.query<GrantRow, [string, number, string]>(`
		SELECT id, authority_id AS authorityId, capability_id AS capabilityId,
			scope_type AS scopeType, scope_id AS scopeId, scope_key AS scopeKey,
			CAST(substr(CAST(constraints_json AS BLOB), 1, 4097) AS TEXT) AS constraintsJson,
			coalesce(octet_length(constraints_json), 0) AS constraintsBytes,
			expires_at AS expiresAt, revoked_at AS revokedAt, created_by_type AS createdByType,
			created_by_id AS createdById, created_at AS createdAt, updated_at AS updatedAt
		FROM integration_capability_grants
		WHERE authority_id = ? AND revoked_at IS NULL AND (? = 1 OR expires_at IS NULL OR expires_at > ?)
		ORDER BY capability_id, scope_key, id LIMIT 2001
	`)
		.all(input.authorityId, input.includeExpired ? 1 : 0, input.now);
	const grants = rows.map(({ constraintsBytes, ...row }) => {
		if (constraintsBytes > 4096)
			throw new DbReadError(
				"DB_READ_BUDGET",
				"Integration constraints exceed their source byte budget",
			);
		return row;
	});
	signal?.throwIfAborted();
	return { storedAuthority, grants };
}
