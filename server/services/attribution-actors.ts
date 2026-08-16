/**
 * Resolving "who wrote this file" into something displayable.
 *
 * A worktree is shared. Subagents, standalone narrators, and narrators bound to a
 * different chapter all write to the same directory, so an attribution row can point at
 * any narrator in the instance. A client that only knows its own chapter's primary
 * narrators cannot label those rows — that gap is what made the Git panel report
 * "Unknown" for the majority of real writers.
 *
 * Resolution lives here, in one module, rather than in each consumer: this is the single
 * definition of an actor for both the attribution timeline and the workspace
 * modification view.
 */
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";

/** A resolved contributor, ready for display. */
export interface AttributionActor {
	/** Null only for changes with no narrator at all (external / terminal edits). */
	narratorId: string | null;
	/** Narrator title, or null when it has none yet. */
	title: string | null;
	/** Subagent type when the actor is a subagent, else null. */
	subagentType: string | null;
	/** Title of the spawning narrator, for subagents whose parent is known. */
	parentTitle: string | null;
	/**
	 * False when the narrator row no longer exists.
	 *
	 * A deleted session is a real answer to "who changed this" and must be
	 * distinguishable from "no idea": the former means there is no session to open, the
	 * latter would send someone looking for one.
	 */
	exists: boolean;
}

/** One narrator row, as actor resolution needs it. */
export interface NarratorActorRow {
	id: string;
	title: string | null;
	variant: string;
	subagentType: string | null;
	parentNarratorId: string | null;
}

/** Prefix of the `variant` column for subagents. */
const SUBAGENT_VARIANT_PREFIX = "subagent:";

/** The actor for a change that carried no narrator id. */
export const EXTERNAL_ACTOR: AttributionActor = Object.freeze({
	narratorId: null,
	title: null,
	subagentType: null,
	parentTitle: null,
	exists: false,
});

/**
 * Turn narrator rows into display actors.
 *
 * Pure, so the labelling rules are testable without a database. An unknown id still
 * yields an actor (with `exists: false`) rather than being dropped: omitting it would
 * make a file look untouched by a session that really wrote to it.
 *
 * @param ids   Narrator ids to resolve, in the caller's display order.
 * @param rows  Narrator rows for any subset of `ids`, plus optionally their parents.
 */
export function buildAttributionActors(
	ids: string[],
	rows: NarratorActorRow[],
): Map<string, AttributionActor> {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const resolved = new Map<string, AttributionActor>();

	for (const id of ids) {
		const row = byId.get(id);
		if (!row) {
			resolved.set(id, { ...EXTERNAL_ACTOR, narratorId: id });
			continue;
		}
		// `variant` is the authoritative identity ("subagent:<type>"); the
		// `subagentType` column is a denormalized copy and is null on older rows, so
		// trusting it alone is what left subagents unlabelable.
		const variantType = row.variant.startsWith(SUBAGENT_VARIANT_PREFIX)
			? row.variant.slice(SUBAGENT_VARIANT_PREFIX.length)
			: null;
		const parent = row.parentNarratorId ? byId.get(row.parentNarratorId) : undefined;
		resolved.set(id, {
			narratorId: id,
			title: row.title ?? null,
			subagentType: variantType || row.subagentType || null,
			parentTitle: parent?.title ?? null,
			exists: true,
		});
	}

	return resolved;
}

/** Columns needed to resolve an actor. */
const ACTOR_COLUMNS = {
	id: narrators.id,
	title: narrators.title,
	variant: narrators.variant,
	subagentType: narrators.subagentType,
	parentNarratorId: narrators.parentNarratorId,
};

/**
 * Resolve display actors for narrator ids.
 *
 * Parents are fetched in a second bounded query so a subagent can be shown as
 * "<type> of <parent>" even when the parent never wrote a file itself and therefore
 * never appears in `ids`.
 */
export async function resolveAttributionActors(
	ids: string[],
): Promise<Map<string, AttributionActor>> {
	if (ids.length === 0) return new Map();

	const rows = await db.select(ACTOR_COLUMNS).from(narrators).where(inArray(narrators.id, ids));

	// Membership via a Set, not `ids.includes`: `ids` is one entry per distinct writer in the
	// view's window, so a busy workspace passes hundreds and the linear scan ran once per
	// row — quadratic work on the request path for a lookup that is O(1).
	const requested = new Set(ids);
	const parentIds = [
		...new Set(
			rows.flatMap((row) =>
				row.parentNarratorId && !requested.has(row.parentNarratorId) ? [row.parentNarratorId] : [],
			),
		),
	];
	const parentRows =
		parentIds.length > 0
			? await db.select(ACTOR_COLUMNS).from(narrators).where(inArray(narrators.id, parentIds))
			: [];

	return buildAttributionActors(ids, [...rows, ...parentRows]);
}
