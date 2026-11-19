import type { Database } from "bun:sqlite";
import { and, asc, eq, getTableColumns, gt, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integrationAuthorities, integrationCapabilityGrants } from "../db/schema";
import { DbReadError } from "../lib/db-worker/errors";

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
/** One registry-owned snapshot: revision and bounded live grants always belong together. */
export function readIntegrationAuthoritySnapshotTask(
	client: Database,
	input: IntegrationAuthoritySnapshotReadInput,
	signal?: AbortSignal,
): IntegrationAuthoritySnapshotReadResult {
	signal?.throwIfAborted();
	const database = drizzle(client);
	const storedAuthority =
		database
			.select()
			.from(integrationAuthorities)
			.where(eq(integrationAuthorities.id, input.authorityId))
			.limit(1)
			.get() ?? null;
	if (!storedAuthority) return { storedAuthority: null, grants: [] };
	const rows = database
		.select({
			...getTableColumns(integrationCapabilityGrants),
			constraintsJson: sql<
				string | null
			>`CAST(substr(CAST(${integrationCapabilityGrants.constraintsJson} AS BLOB), 1, 4097) AS TEXT)`,
			constraintsBytes: sql<number>`coalesce(octet_length(${integrationCapabilityGrants.constraintsJson}),0)`,
		})
		.from(integrationCapabilityGrants)
		.where(
			and(
				eq(integrationCapabilityGrants.authorityId, input.authorityId),
				isNull(integrationCapabilityGrants.revokedAt),
				input.includeExpired
					? undefined
					: or(
							isNull(integrationCapabilityGrants.expiresAt),
							gt(integrationCapabilityGrants.expiresAt, input.now),
						),
			),
		)
		.orderBy(
			asc(integrationCapabilityGrants.capabilityId),
			asc(integrationCapabilityGrants.scopeKey),
			asc(integrationCapabilityGrants.id),
		)
		.limit(2001)
		.all();
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
