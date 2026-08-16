/**
 * Seed knowledge grants in tests.
 *
 * Knowledge authorization moved from `knowledge_grants` to the unified `acl_grants`
 * table. Fixtures that insert into the old table now grant nothing — the ACL layer
 * does not read it — so they must go through here instead.
 *
 * The input keeps the knowledge vocabulary (a clearance name, a tag id, a `canWrite`
 * flag) and this translates it, because that is what the tests are expressing. One
 * logical grant can become two rows: a domain credential row, plus a separate `write`
 * capability row when `canWrite` is set.
 *
 * Note what a credential row is NOT: its `capability` column holds a placeholder
 * `read`, which does not authorize reading. Knowledge readability comes from
 * comparing clearance rank and compartment tags, so a fixture that wanted "this user
 * can read everything" has to say so through the levels, not by adding a grant.
 */

import type { Database } from "bun:sqlite";

export interface KnowledgeGrantSeed {
	/**
	 * Accepted and ignored. Existing fixtures were written against
	 * `knowledge_grants` rows and pass an `id`; the unified rows generate their own,
	 * and a credential + write pair needs two anyway. Tolerated so the migration did
	 * not require rewriting every fixture literal.
	 */
	id?: string;
	/** null / omitted = a global grant, as a collection-less clearance was. */
	collectionId?: string | null;
	principalType?: "user" | "role";
	principalId: string;
	grantType: "clearance" | "tag" | "review";
	/** For grantType="clearance": the level NAME (levels are referenced by name). */
	clearanceLevel?: string | null;
	/** For grantType="tag" | "review": the tag id. */
	tagId?: string | null;
	canWrite?: boolean;
	createdAt?: string;
}

let seq = 0;
function seedId(prefix: string): string {
	seq += 1;
	return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** The `acl_grants` rows one knowledge grant seed becomes. */
export function knowledgeGrantRows(seed: KnowledgeGrantSeed): Array<{
	id: string;
	scopeType: string;
	scopeId: string | null;
	principalType: string;
	principalId: string;
	capability: string;
	domainKind: string | null;
	domainValue: string | null;
	createdAt: string;
}> {
	const scopeType = seed.collectionId ? "knowledge_collection" : "global";
	const scopeId = seed.collectionId ?? null;
	const principalType = seed.principalType ?? "user";
	const createdAt = seed.createdAt ?? new Date().toISOString();
	const domainValue =
		seed.grantType === "clearance" ? (seed.clearanceLevel ?? null) : (seed.tagId ?? null);

	const rows = [];
	if (domainValue) {
		rows.push({
			id: seedId("aclg"),
			scopeType,
			scopeId,
			principalType,
			principalId: seed.principalId,
			capability: "read",
			domainKind: seed.grantType,
			domainValue,
			createdAt,
		});
	}
	if (seed.canWrite) {
		rows.push({
			id: seedId("aclw"),
			scopeType,
			scopeId,
			principalType,
			principalId: seed.principalId,
			capability: "write",
			domainKind: null,
			domainValue: null,
			createdAt,
		});
	}
	return rows;
}

/**
 * Insert knowledge grants through a raw `bun:sqlite` handle.
 *
 * Raw SQL rather than Drizzle so this works from fixtures that hold only the sqlite
 * handle, and so it stays usable in tests that mock the db module.
 */
export function seedKnowledgeGrantsSqlite(
	sqlite: Database,
	seeds: KnowledgeGrantSeed | KnowledgeGrantSeed[],
): void {
	const list = Array.isArray(seeds) ? seeds : [seeds];
	const stmt = sqlite.prepare(
		`INSERT OR IGNORE INTO acl_grants
		   (id, scope_type, scope_id, principal_type, principal_id,
		    capability, domain_kind, domain_value, granted_by, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
	);
	for (const seed of list) {
		for (const row of knowledgeGrantRows(seed)) {
			stmt.run(
				row.id,
				row.scopeType,
				row.scopeId,
				row.principalType,
				row.principalId,
				row.capability,
				row.domainKind,
				row.domainValue,
				row.createdAt,
			);
		}
	}
}
