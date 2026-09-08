import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { AppError } from "../lib/errors";
import { PUBLIC_SHARE_LIMITS as L } from "./public-narrator-share-limits";

export interface PublicReadScope {
	narratorId: string;
	upper: number;
	version: number;
}
export function publicTranscriptChanged(): AppError {
	return new AppError("Transcript changed; refresh the shared session", 409, "PUBLIC_SHARE_RESET");
}

/** Virtual lazy lineage only. No backfill, ref materialization or read-side mutations. */
export function publicReadLineage(narratorId: string): PublicReadScope[] {
	const scopes: PublicReadScope[] = [];
	const seen = new Set<string>();
	let current: string | null = narratorId;
	let upper = Number.MAX_SAFE_INTEGER;
	while (current) {
		if (seen.has(current) || scopes.length >= L.lineageDepth) throw publicTranscriptChanged();
		seen.add(current);
		const row = db
			.select({
				parent: narrators.refsInheritedFrom,
				cursor: narrators.refsBackfillCursor,
				version: narrators.messageVersion,
			})
			.from(narrators)
			.where(eq(narrators.id, current))
			.limit(1)
			.get();
		if (!row) throw publicTranscriptChanged();
		scopes.push({ narratorId: current, upper, version: row.version });
		if (!row.parent || row.cursor === null) break;
		upper = Math.min(upper, row.cursor);
		if (upper <= 0) break;
		current = row.parent;
	}
	return scopes;
}

/** Lazy ancestors can compact/edit independently: their versions must affect paging. */
export function publicLineageVersion(scopes: PublicReadScope[]): number {
	if (scopes.length === 1) return scopes[0].version;
	const digest = createHash("sha256").update(JSON.stringify(scopes)).digest();
	// A positive 49-bit integer survives JSON/JS exactly and is not an internal ID.
	return 2 ** 48 + digest.readUIntBE(0, 6);
}

export function assertPublicLineageVersions(scopes: PublicReadScope[]): void {
	const rows = db
		.select({ id: narrators.id, version: narrators.messageVersion })
		.from(narrators)
		.where(
			inArray(
				narrators.id,
				scopes.map((scope) => scope.narratorId),
			),
		)
		.limit(L.lineageDepth)
		.all();
	const versions = new Map(rows.map((row) => [row.id, row.version]));
	if (scopes.some((scope) => versions.get(scope.narratorId) !== scope.version))
		throw publicTranscriptChanged();
}
