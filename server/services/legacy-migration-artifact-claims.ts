import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { normalizePathForComparison } from "../lib/platform-path";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";

export interface LegacyArtifactClaimLookup {
	deviceId?: string;
	workspacePath?: string;
	artifactPath?: string;
	shadowKey?: string;
	sourceChapterId?: string;
}

/** Test seam runs the same indexed projection against an isolated database. */
export function createLegacyArtifactClaimLookup(
	query: (lookup: LegacyArtifactClaimLookup) => Promise<boolean>,
	budgetMs = 1000,
) {
	return async (lookup: LegacyArtifactClaimLookup): Promise<boolean> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = performance.now() + budgetMs;
		try {
			if (
				!Object.values(lookup).some(Boolean) ||
				Object.values(lookup).some((value) => typeof value !== "string" || value.length > 8192)
			)
				return true;
			const result = await Promise.race([
				query(lookup),
				new Promise<boolean>((done) => {
					timer = setTimeout(() => done(true), budgetMs);
				}),
			]);
			return performance.now() > deadline ? true : result;
		} catch {
			return true;
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
}

export async function legacyArtifactClaimPredicate(
	lookup: LegacyArtifactClaimLookup,
): Promise<SQL> {
	const { legacyMigrationArtifactClaims: table } = await import("../db/schema");
	const selectors: SQL[] = [];
	if (lookup.workspacePath) {
		const normalized = normalizePathForComparison(lookup.workspacePath);
		selectors.push(inArray(table.workspacePath, [...new Set([lookup.workspacePath, normalized])]));
	}
	if (lookup.artifactPath) selectors.push(eq(table.artifactPath, lookup.artifactPath));
	if (lookup.shadowKey) selectors.push(eq(table.shadowKey, lookup.shadowKey));
	if (lookup.sourceChapterId) selectors.push(eq(table.sourceChapterId, lookup.sourceChapterId));
	if (!selectors.length) throw new Error("Artifact lookup requires a location or source chapter");
	const predicate = and(
		lookup.deviceId ? eq(table.deviceId, lookup.deviceId) : undefined,
		or(...selectors),
		or(ne(table.state, "released"), isNull(table.state), isNull(table.ownerUserId)),
	);
	if (!predicate) throw new Error("Artifact predicate unavailable");
	return predicate;
}

/** Ownership is durable independently of the narrator. No JSON or history payload is read. */
export const hasLegacyMigrationArtifactClaim = createLegacyArtifactClaimLookup(async (lookup) => {
	const { db } = await import("../db");
	const { legacyMigrationArtifactClaims: table } = await import("../db/schema");
	// Separate point lookups avoid a cross-index OR degrading to a device-wide scan.
	for (const selector of [
		"workspacePath",
		"artifactPath",
		"shadowKey",
		"sourceChapterId",
	] as const) {
		if (!lookup[selector]) continue;
		const predicate = await legacyArtifactClaimPredicate({
			deviceId: lookup.deviceId,
			[selector]: lookup[selector],
		});
		if ((await db.select({ id: table.id }).from(table).where(predicate).limit(1))[0]) return true;
	}
	if (!lookup.workspacePath && !lookup.artifactPath && !lookup.shadowKey && !lookup.sourceChapterId)
		throw new Error("Artifact identity required");
	return false;
});

/** Preserve the original archive pointer; only the live indexed pointer moves. */
export async function advanceLegacyArtifactSnapshotPointer(
	deviceId: string,
	workspacePath: string,
	commitSha: string,
): Promise<void> {
	if (!/^[a-f0-9]{40,64}$/.test(commitSha)) throw new Error("Invalid snapshot commit");
	const { db } = await import("../db");
	const { legacyMigrationArtifactClaims: table } = await import("../db/schema");
	await db
		.update(table)
		.set({ latestSnapshotCommitSha: commitSha })
		.where(
			and(
				await legacyArtifactClaimPredicate({ deviceId, workspacePath }),
				eq(table.kind, "shadow"),
			),
		);
}

/** Never infer a sharing grant from an artifact path or from an old owner. */
export async function getAuthorizedLegacyArtifactDescriptor(
	id: string,
	principal: NarratorPrincipal,
) {
	const { db } = await import("../db");
	const { legacyMigrationArtifactClaims: table, narrators } = await import("../db/schema");
	const [row] = await db
		.select({
			id: table.id,
			sourceChapterId: table.sourceChapterId,
			narratorId: table.narratorId,
			ownerUserId: table.ownerUserId,
			kind: table.kind,
			deviceId: table.deviceId,
			workspacePath: table.workspacePath,
			artifactPath: table.artifactPath,
			shadowKey: table.shadowKey,
			state: table.state,
			manifestDigest: table.manifestDigest,
			latestSnapshotCommitSha: table.latestSnapshotCommitSha,
		})
		.from(table)
		.where(eq(table.id, id))
		.limit(1);
	if (!row || row.state !== "claimed" || row.deviceId !== "local") return null;
	if (!row.ownerUserId && !principal.isAdmin) return null;
	if (row.narratorId) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, row.narratorId),
			columns: NARRATOR_ACL_COLUMNS,
		});
		if (!narrator) return null;
		await assertNarratorAccess(narrator, principal, "read");
	} else if (!principal.isAdmin && row.ownerUserId !== principal.userId) return null;
	// The bounded identity is fetched only after current ACL succeeds, never in inventories.
	const [evidence] = await db
		.select({ identity: table.identityJson })
		.from(table)
		.where(
			and(
				eq(table.id, id),
				eq(table.state, "claimed"),
				eq(table.artifactPath, row.artifactPath),
				row.narratorId ? eq(table.narratorId, row.narratorId) : isNull(table.narratorId),
				row.ownerUserId ? eq(table.ownerUserId, row.ownerUserId) : isNull(table.ownerUserId),
				sql`length(CAST(${table.identityJson} AS BLOB)) <= 8192`,
			),
		)
		.limit(1);
	if (!evidence || !(await verifyLegacyArtifactPathIdentity(row.artifactPath, evidence.identity)))
		return null;
	return row;
}

/** A descriptor is not an open file handle; readers must repeat this check at their IO boundary. */
export async function verifyLegacyArtifactPathIdentity(
	path: string,
	identity: Record<string, unknown>,
): Promise<boolean> {
	try {
		if (
			!isAbsolute(path) ||
			path.length > 4096 ||
			path.includes("\0") ||
			typeof identity.dev !== "string" ||
			typeof identity.ino !== "string"
		)
			return false;
		let current = resolve(path);
		for (let depth = 0; depth < 128; depth++) {
			const stat = await lstat(current, { bigint: true });
			if (stat.isSymbolicLink()) return false;
			if (
				current === resolve(path) &&
				(!stat.isDirectory() ||
					String(stat.dev) !== identity.dev ||
					String(stat.ino) !== identity.ino)
			)
				return false;
			const parent = dirname(current);
			if (parent === current)
				return (
					normalizePathForComparison(await realpath(path)) === normalizePathForComparison(path)
				);
			current = parent;
		}
		return false;
	} catch {
		return false;
	}
}
