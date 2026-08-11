/**
 * Single source of truth for the knowledge tools' action names and their
 * read/write classification.
 *
 * Tool implementations (which decide whether to require user permission) and
 * `classifyDanger` in narrator-permission.ts (which decides whether a write action
 * triggers danger reflection under bypassPermissions) both import from here, so the
 * read/write split can never drift between the two call sites.
 *
 * Tool surface (post personal-library refactor):
 *  - KnowledgeCreate / KnowledgeEdit — param-based (no action enum for Create; Edit uses
 *    KNOWLEDGE_EDIT_ACTIONS). Danger is classified from their params in classifyDanger.
 *  - KnowledgeReview — pure review (approve / request_changes / comment / resolve_conflict
 *    + list/get submissions).
 *  - KnowledgeAdmin — ACL management.
 */

// ─── KnowledgeAdmin (ACL management) ───
export const KNOWLEDGE_ADMIN_READ_ACTIONS = [
	"list_collections",
	"list_levels",
	"list_tags",
	"list_tag_types",
	"list_grants",
	"get_user_acl",
] as const;

export const KNOWLEDGE_ADMIN_WRITE_ACTIONS = [
	"create_collection",
	"update_collection",
	"set_collection_acl",
	"create_level",
	"update_level",
	"delete_level",
	"create_tag",
	"update_tag",
	"delete_tag",
	"create_tag_type",
	"update_tag_type",
	"delete_tag_type",
	"create_grant",
	"delete_grant",
	"set_user_acl",
	"set_entry_acl",
] as const;

// ─── KnowledgeReview (pure review of publish requests) ───
export const KNOWLEDGE_REVIEW_READ_ACTIONS = ["list_submissions", "get_submission"] as const;

export const KNOWLEDGE_REVIEW_WRITE_ACTIONS = [
	"approve",
	"request_changes",
	// Terminal refusal (status → `rejected`), as opposed to request_changes' invitation to retry.
	"reject",
	"comment",
	"resolve_conflict",
] as const;

// ─── KnowledgeEdit (edit/maintain knowledge via personal entries + publish) ───

/**
 * Read-only KnowledgeEdit actions: no permission prompt, no danger reflection.
 *
 * `my_submissions` lives on KnowledgeEdit rather than KnowledgeReview because it is the
 * AUTHOR's view of their own publish requests, and KnowledgeReview deliberately hides
 * those (a reviewer may not review their own submission).
 */
export const KNOWLEDGE_EDIT_READ_ACTIONS = ["my_submissions"] as const;

export const KNOWLEDGE_EDIT_WRITE_ACTIONS = [
	"save", // write content to my personal entry (or, with direct + permission, to global main)
	"rebase", // rebase my drifted personal entry onto current main
	"publish", // submit my personal entry to be published into the global base
	"withdraw", // retract one of my own unmerged publish requests
	"resubmit", // re-propose after a reviewer requested changes
	"set_target", // set a standalone personal entry's target collection
	"update_meta", // update a global entry's title/tags/status (needs write permission)
	"transfer_owner",
	"transfer_collection_owner",
] as const;

export const KNOWLEDGE_EDIT_ACTIONS = [
	...KNOWLEDGE_EDIT_READ_ACTIONS,
	...KNOWLEDGE_EDIT_WRITE_ACTIONS,
] as const;

/**
 * High-severity actions: they merge/write the globally-served main version of a knowledge
 * entry. Classified `high` for danger reflection; other writes are `medium`.
 *  - KnowledgeReview: approve / resolve_conflict (merge into main).
 *  - KnowledgeEdit: handled separately in classifyDanger (a `save` with `direct:true` writes
 *    main → high; everything else personal → medium; read actions → none).
 */
export const KNOWLEDGE_MERGE_ACTIONS = ["approve", "resolve_conflict"] as const;

export type KnowledgeAdminAction =
	| (typeof KNOWLEDGE_ADMIN_READ_ACTIONS)[number]
	| (typeof KNOWLEDGE_ADMIN_WRITE_ACTIONS)[number];

export type KnowledgeReviewAction =
	| (typeof KNOWLEDGE_REVIEW_READ_ACTIONS)[number]
	| (typeof KNOWLEDGE_REVIEW_WRITE_ACTIONS)[number];

export type KnowledgeEditAction = (typeof KNOWLEDGE_EDIT_ACTIONS)[number];

/** All read actions across the action-enum tools — used by classifyDanger to skip reflection. */
export const KNOWLEDGE_READ_ACTIONS: ReadonlySet<string> = new Set<string>([
	...KNOWLEDGE_ADMIN_READ_ACTIONS,
	...KNOWLEDGE_REVIEW_READ_ACTIONS,
	...KNOWLEDGE_EDIT_READ_ACTIONS,
]);

/** Merge/main-write actions → high danger severity. */
export const KNOWLEDGE_MERGE_ACTION_SET: ReadonlySet<string> = new Set<string>(
	KNOWLEDGE_MERGE_ACTIONS,
);

/** Whether a given action on an action-enum knowledge tool is a read (no permission/reflection). */
export function isKnowledgeReadAction(action: string): boolean {
	return KNOWLEDGE_READ_ACTIONS.has(action);
}
