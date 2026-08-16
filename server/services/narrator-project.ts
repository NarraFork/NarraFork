/**
 * Which project a narrator belongs to — the single answer to that question.
 *
 * There were three separate implementations of this before, and they disagreed:
 *
 *  - `trait-layer-service.ts` preferred `contextProjectId` over the chapter
 *  - `narrator-session.ts` preferred the chapter over `contextProjectId`
 *  - `snapshot-revert.ts` ignored `contextProjectId` entirely, so a standalone
 *    externally provisioned narrator always resolved to "no project"
 *
 * Three behaviours for one question is tolerable while the answer only selects a
 * trait layer. It stops being tolerable once project membership gates access:
 * every divergent copy is a place where a check can be bypassed, and the one that
 * silently returns null is the worst kind — it reads as "no project, nothing to
 * enforce".
 *
 * The chapter wins. `contextProjectId` is documented as the project context *for
 * standalone externally provisioned narrators* (see the column comment in
 * `schema.ts`), i.e. precisely the case where there is no chapter to follow. The
 * two are not meant to coexist, and in the live database they never do.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators } from "../db/schema";

/** The narrator columns this resolution needs — nothing else is read. */
export interface NarratorProjectRef {
	chapterId?: string | null;
	contextProjectId?: string | null;
}

/**
 * Resolve the project from an already-loaded narrator row.
 *
 * Returns null when the narrator genuinely belongs to no project (a standalone
 * session with no explicit context). Callers gating on membership must treat null
 * as "no project gate applies", NOT as "no restrictions" — the resource's own ACL
 * still decides.
 *
 * A missing chapter row also yields null. That is a dangling reference rather than
 * a permission decision, so it is reported as "unknown project" and left to the
 * caller; every access path pairs this with the resource's own check.
 */
export async function resolveNarratorProjectId(
	narrator: NarratorProjectRef,
): Promise<string | null> {
	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true },
		});
		return chapter?.projectId ?? null;
	}
	return narrator.contextProjectId ?? null;
}

/**
 * Same resolution, starting from a narrator id.
 *
 * Returns null when the narrator does not exist, matching the row-based variant's
 * "unknown project" contract instead of throwing: callers are gating or layering,
 * not asserting existence.
 */
export async function resolveProjectIdForNarratorId(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, contextProjectId: true },
	});
	if (!narrator) return null;
	return await resolveNarratorProjectId(narrator);
}
