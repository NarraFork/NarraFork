/**
 * Single source of truth for KnowledgeAdmin / KnowledgeReview action names and
 * their read/write classification.
 *
 * Both the tool implementations (which decide whether to require user permission)
 * and `classifyDanger` in narrator-permission.ts (which decides whether a write
 * action triggers danger reflection under bypassPermissions) import from here, so
 * the read/write split can never drift between the two call sites.
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

// ─── KnowledgeReview (review / merge / direct main write) ───
export const KNOWLEDGE_REVIEW_READ_ACTIONS = ["list_submissions", "get_submission"] as const;

export const KNOWLEDGE_REVIEW_WRITE_ACTIONS = [
	"approve",
	"request_changes",
	"comment",
	"resolve_conflict",
	"create_entry",
	"write_main",
	"update_entry_meta",
	"transfer_owner",
	"transfer_collection_owner",
] as const;

/**
 * High-severity write actions: they merge/write the globally-served main version
 * of a knowledge entry. Classified `high` for danger reflection; everything else
 * that writes is `medium`.
 */
export const KNOWLEDGE_MERGE_ACTIONS = ["approve", "resolve_conflict", "write_main"] as const;

export type KnowledgeAdminAction =
	| (typeof KNOWLEDGE_ADMIN_READ_ACTIONS)[number]
	| (typeof KNOWLEDGE_ADMIN_WRITE_ACTIONS)[number];

export type KnowledgeReviewAction =
	| (typeof KNOWLEDGE_REVIEW_READ_ACTIONS)[number]
	| (typeof KNOWLEDGE_REVIEW_WRITE_ACTIONS)[number];

/** All read actions across both tools — used by classifyDanger to skip reflection. */
export const KNOWLEDGE_READ_ACTIONS: ReadonlySet<string> = new Set<string>([
	...KNOWLEDGE_ADMIN_READ_ACTIONS,
	...KNOWLEDGE_REVIEW_READ_ACTIONS,
]);

/** Merge/main-write actions → high danger severity. */
export const KNOWLEDGE_MERGE_ACTION_SET: ReadonlySet<string> = new Set<string>(
	KNOWLEDGE_MERGE_ACTIONS,
);

/** Whether a given action on either knowledge tool is a read (no permission/reflection needed). */
export function isKnowledgeReadAction(action: string): boolean {
	return KNOWLEDGE_READ_ACTIONS.has(action);
}
