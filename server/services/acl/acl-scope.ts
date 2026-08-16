/**
 * Resource scopes and their ancestor chains.
 *
 * A scope is "a thing a grant can be attached to". Every scope declares its
 * ancestors, and the kernel folds along that chain.
 *
 * The chain is a GATE, not a source of authorization. Passing every ancestor is a
 * necessary condition; it never by itself grants anything. Concretely: being a
 * read member of a project only gets you through the project door — whether you
 * can open a particular narrator inside it is still decided by that narrator's own
 * owner/visibility/grants. This is why a private session stays invisible to
 * project members without needing any "private suppresses inheritance" special
 * case: inheritance never offered read in the first place.
 *
 * The knowledge base already had exactly this shape with one level
 * (`canRead` runs `canReadCollection` first, then the entry's own two axes). This
 * module generalizes it from one level to a chain.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, knowledgeCollections, knowledgeEntries, narrators } from "../../db/schema";
import { resolveNarratorProjectId } from "../narrator-project";

/**
 * Everything a grant can be scoped to.
 *
 * "global" is the scope with no ancestors and no id — how the knowledge base
 * expressed a collection-less clearance, and how an instance-wide grant is
 * expressed now.
 */
export const ACL_SCOPE_TYPES = [
	"global",
	"project",
	"chapter",
	"narrator",
	"knowledge_collection",
	"knowledge_entry",
] as const;

export type AclScopeType = (typeof ACL_SCOPE_TYPES)[number];

/** A concrete scope. `id` is null iff `type` is "global". */
export interface AclScope {
	type: AclScopeType;
	id: string | null;
}

export const GLOBAL_SCOPE: AclScope = { type: "global", id: null };

export function scopeKey(scope: AclScope): string {
	return scope.id === null ? scope.type : `${scope.type}:${scope.id}`;
}

/**
 * The ancestor chain of a scope, nearest first, always ending at "global".
 *
 * Chains can be shorter than their static shape suggests, because several links
 * are nullable in the schema:
 *
 *   narrator             → chapter? → project? → global
 *   chapter              → project  → global
 *   knowledge_entry      → knowledge_collection → project? → global
 *   knowledge_collection → project? → global
 *   project              → global
 *
 * A break in the chain (a standalone narrator with no project, a collection that
 * belongs to no project) terminates it early. That means "no gate at this level
 * applies" — NOT "unrestricted", and NOT "denied". The resource's own ACL is
 * unaffected either way.
 *
 * A dangling reference (a narrator pointing at a deleted chapter) also terminates
 * the chain rather than throwing: it is a broken link, not a verdict, and the
 * resource's own check still runs.
 */
/**
 * Whether a collection sits behind its project's membership gate.
 *
 * Read defensively rather than through the typed column so the kernel can land
 * before the migration that adds it: a row without the field reports false, which
 * is the same answer the migration writes for every pre-existing collection.
 */
function collectionInheritsProjectGate(collection: Record<string, unknown>): boolean {
	return collection.inheritProjectGate === true || collection.inheritProjectGate === 1;
}

export async function resolveAncestorChain(scope: AclScope): Promise<AclScope[]> {
	switch (scope.type) {
		case "global":
			return [];

		case "project":
			return [GLOBAL_SCOPE];

		case "chapter": {
			if (!scope.id) return [GLOBAL_SCOPE];
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, scope.id),
				columns: { projectId: true },
			});
			return chapter?.projectId
				? [{ type: "project", id: chapter.projectId }, GLOBAL_SCOPE]
				: [GLOBAL_SCOPE];
		}

		case "narrator": {
			if (!scope.id) return [GLOBAL_SCOPE];
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, scope.id),
				columns: { chapterId: true, contextProjectId: true },
			});
			if (!narrator) return [GLOBAL_SCOPE];
			const chain: AclScope[] = [];
			if (narrator.chapterId) chain.push({ type: "chapter", id: narrator.chapterId });
			// Single source of truth for "which project" — see narrator-project.ts for
			// why the chapter wins over contextProjectId.
			const projectId = await resolveNarratorProjectId(narrator);
			if (projectId) chain.push({ type: "project", id: projectId });
			chain.push(GLOBAL_SCOPE);
			return chain;
		}

		case "knowledge_collection": {
			if (!scope.id) return [GLOBAL_SCOPE];
			const collection = await db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.id, scope.id),
				columns: { projectId: true },
			});
			if (!collection?.projectId) return [GLOBAL_SCOPE];
			// The project gate is opt-in per collection. Collections created before
			// project ACLs existed were readable by anyone who could reach the project
			// (which was everyone), so switching the gate on for them during a migration
			// would silently hide content — and "content stopped appearing" is the hardest
			// kind of regression to notice. The flag column lands with the knowledge
			// migration; until then no collection inherits a project gate, which keeps
			// this step behaviour-neutral.
			return collectionInheritsProjectGate(collection)
				? [{ type: "project", id: collection.projectId }, GLOBAL_SCOPE]
				: [GLOBAL_SCOPE];
		}

		case "knowledge_entry": {
			if (!scope.id) return [GLOBAL_SCOPE];
			const entry = await db.query.knowledgeEntries.findFirst({
				where: eq(knowledgeEntries.id, scope.id),
				columns: { collectionId: true },
			});
			if (!entry?.collectionId) return [GLOBAL_SCOPE];
			const collectionScope: AclScope = {
				type: "knowledge_collection",
				id: entry.collectionId,
			};
			return [collectionScope, ...(await resolveAncestorChain(collectionScope))];
		}
	}
}

/**
 * The scope itself plus its ancestors, nearest first.
 *
 * Callers that need to look up every applicable grant in one query use this; the
 * kernel keeps the distinction between "the scope" and "its ancestors" when
 * folding, because only the former can authorize.
 */
export async function resolveScopeChain(scope: AclScope): Promise<AclScope[]> {
	if (scope.type === "global") return [GLOBAL_SCOPE];
	return [scope, ...(await resolveAncestorChain(scope))];
}
