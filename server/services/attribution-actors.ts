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
import type { FileChangeActor, FileChangeActorKind } from "../../shared/file-change-protocol";
import { db } from "../db";
import { narrators, users } from "../db/schema";

/** v1 can lose a narrator's subtype with its FK; never pretend it was a primary. */
export type AttributionActorKind = FileChangeActorKind | "narrator_unknown";

/** Observed actor identity, not ownership of the current diff. */
export interface AttributionActor {
	kind: AttributionActorKind;
	narratorId: string | null;
	userId: string | null;
	/** Resolved narrator title or username. Never fabricated for missing identities. */
	title: string | null;
	subagentType: string | null;
	parentTitle: string | null;
	exists: boolean;
	/** Null when a legacy null FK cannot distinguish deletion from missing identity. */
	deleted: boolean | null;
	/** Whether separate observations can be linked to one stable subject. */
	identityKnown: boolean;
	/** v2 subject remains stable after linked user/narrator deletion. */
	subjectKey?: string;
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

/** Only an external event implies an external actor; a null FK does not. */
export const EXTERNAL_ACTOR: AttributionActor = Object.freeze({
	kind: "external_unknown",
	narratorId: null,
	userId: null,
	title: null,
	subagentType: null,
	parentTitle: null,
	exists: false,
	deleted: false,
	identityKnown: false,
});

export interface AttributionActorEvent {
	action: string;
	actorSnapshot?: FileChangeActor | null;
	narratorId: string | null;
	userId: string | null;
	subagentType: string | null;
}

/** Resolve from this event alone, never from a file group's historical flags. */
export function resolveEventAttributionActor(
	event: AttributionActorEvent,
	narratorActors: ReadonlyMap<string, AttributionActor>,
	humanActors: ReadonlyMap<string, AttributionActor>,
): AttributionActor {
	const snapshot = event.actorSnapshot;
	if (snapshot) {
		if (snapshot.kind === "external_unknown") return EXTERNAL_ACTOR;
		const source =
			snapshot.kind === "human"
				? snapshot.userId
					? humanActors.get(snapshot.userId)
					: undefined
				: snapshot.narratorId
					? narratorActors.get(snapshot.narratorId)
					: undefined;
		return {
			...EXTERNAL_ACTOR,
			...source,
			kind: snapshot.kind,
			narratorId: snapshot.narratorId,
			userId: snapshot.userId,
			subjectKey: snapshot.subjectKey,
			title: source?.exists && !snapshot.deleted ? source.title : null,
			subagentType: source?.subagentType ?? event.subagentType,
			exists: !snapshot.deleted && !!source?.exists,
			deleted: snapshot.deleted || !source?.exists,
			identityKnown: !!snapshot.subjectKey,
		};
	}
	if (event.action === "external") return EXTERNAL_ACTOR;
	if (event.action === "human") {
		return (
			(event.userId ? humanActors.get(event.userId) : undefined) ?? {
				...EXTERNAL_ACTOR,
				kind: "human",
				userId: event.userId,
				deleted: event.userId ? true : null,
				identityKnown: event.userId !== null,
			}
		);
	}
	const resolved = event.narratorId ? narratorActors.get(event.narratorId) : undefined;
	if (resolved?.exists) return resolved;
	return {
		...EXTERNAL_ACTOR,
		kind: event.subagentType ? "subagent" : "narrator_unknown",
		narratorId: event.narratorId,
		subagentType: event.subagentType,
		deleted: event.narratorId ? true : null,
		identityKnown: event.narratorId !== null,
	};
}

/** Unknown identities share only a display bucket, never an exact contributor count. */
export function attributionActorKey(actor: AttributionActor): string {
	if (actor.subjectKey) return actor.subjectKey;
	if (actor.userId) return `human:${actor.userId}`;
	if (actor.narratorId) return `narrator:${actor.narratorId}`;
	return `${actor.kind}:unknown:${actor.subagentType ?? ""}`;
}

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
			resolved.set(id, {
				...EXTERNAL_ACTOR,
				kind: "narrator_unknown",
				narratorId: id,
				deleted: true,
				identityKnown: true,
			});
			continue;
		}
		// `variant` is the authoritative identity ("subagent:<type>"); the
		// `subagentType` column is a denormalized copy and is null on older rows, so
		// trusting it alone is what left subagents unlabelable.
		const variantType = row.variant.startsWith(SUBAGENT_VARIANT_PREFIX)
			? row.variant.slice(SUBAGENT_VARIANT_PREFIX.length)
			: null;
		const parent = row.parentNarratorId ? byId.get(row.parentNarratorId) : undefined;
		const subagentType = variantType || row.subagentType || null;
		resolved.set(id, {
			kind: subagentType || row.variant === "subagent" ? "subagent" : "primary",
			narratorId: id,
			userId: null,
			title: row.title ?? null,
			subagentType,
			parentTitle: parent?.title ?? null,
			exists: true,
			deleted: false,
			identityKnown: true,
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

/** A human is resolved by userId, never by the narrator that happens to own a chapter. */
export async function resolveHumanAttributionActors(
	ids: string[],
): Promise<Map<string, AttributionActor>> {
	if (ids.length === 0) return new Map();
	const rows = await db
		.select({ id: users.id, username: users.username })
		.from(users)
		.where(inArray(users.id, ids));
	const byId = new Map(rows.map((row) => [row.id, row]));
	return new Map(
		ids.map((id) => {
			const row = byId.get(id);
			return [
				id,
				{
					...EXTERNAL_ACTOR,
					kind: "human",
					userId: id,
					title: row?.username ?? null,
					exists: !!row,
					deleted: !row,
					identityKnown: true,
				},
			];
		}),
	);
}
