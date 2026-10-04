/**
 * What the portable archive contains, and in what order it must be applied.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * The archive format is the FIXED POINT of this design. Files already exist on users' disks;
 * their column sets cannot be renegotiated, only extended. Both directions therefore have to
 * agree on the same list, and until now they did so by accident: the export enumerated columns
 * inline in ten positional `INSERT` statements, the import re-derived them at runtime from
 * `PRAGMA table_info` on both databases. Neither could be read as a statement of the format.
 *
 * This file states it once, in the archive's own spelling. It intentionally names NO Drizzle
 * table and no main-database column, so it stays valid if the main schema is renamed or moves
 * to another engine.
 *
 * ORDER IS PART OF THE FORMAT
 * ---------------------------
 * The archive file has no foreign keys (deliberately — it must be readable and writable in any
 * state), but the MAIN database does, and it enforces them per statement. So an import applies
 * tables parent-first. This is the pre-existing `IMPORT_ORDER` unchanged, and changing it is not
 * a refactor: a wrong order surfaces as `FOREIGN KEY constraint failed` on a real user's
 * import, which is verified to be a hard throw rather than a silently skipped row (an
 * `INSERT OR IGNORE` ignores UNIQUE conflicts, NOT foreign-key failures).
 *
 * THE COLUMN LISTS ARE A CEILING, NOT A REQUIREMENT
 * -------------------------------------------------
 * Every list below is intersected at runtime with what the archive file actually has and what
 * the main database can actually supply. An older archive missing a column is normal and must
 * import fine; a main database that no longer has a column must not block the rest of the row.
 * The lists exist so the intersection has a stable, reviewable third input rather than being
 * whatever two `PRAGMA` calls happen to return.
 */

/**
 * Tables in the archive, parent-first.
 *
 * `narrator_patches` is in the list and has no writer in the export today — the same as before
 * this port. It is kept because archives written by older versions DO contain rows, and
 * dropping the table from the import would silently discard them.
 */
export const ARCHIVE_TABLE_ORDER = [
	"projects",
	"exploration_groups",
	"chapters",
	"chapter_edges",
	"narrators",
	"narrator_messages",
	"narrator_message_refs",
	"narrator_tool_calls",
	"narrator_patches",
	"chapter_commits",
	"merge_sessions",
] as const;

export type ArchiveTable = (typeof ARCHIVE_TABLE_ORDER)[number];

/**
 * Columns the CURRENT archive schema defines per table, in `project.db`'s own DDL order.
 *
 * Kept in DDL order rather than alphabetically so a diff against `server/lib/project-db.ts`
 * reads as a diff. `__tests__/manifest-format.test.ts` compares this to a real file created by
 * the real module, so the two cannot drift.
 *
 * DELIBERATE ABSENCES, because "not listed" and "forgotten" must be distinguishable:
 *
 *   - `chapters.parked_snapshot_commit_sha` / `parked_snapshot_base_tree` — commits in THIS
 *     machine's shadow repository for a rebase still in flight. Imported elsewhere, the next
 *     rebase settles them, resolves nothing, and reports work lost that was never on that
 *     machine.
 *   - `narrator_messages.credential_id` — names a credential record in the exporting install.
 *   - the main database's ACL columns (`owner_user_id`, `visibility`, `write_audience`, …) —
 *     they name accounts that do not exist in the importing install. Their absence means an
 *     imported project takes the importing install's defaults, which is the only safe answer.
 *   - `projects.flow_mode`, `proxy_domain`, `traits`, and the chapters' UI geometry
 *     (`graph_x`, `panel_*`, `dock_layout_json`, …) — never carried by this format. Listing
 *     them now would be a format change, which Phase 2 explicitly is not.
 */
export const ARCHIVE_COLUMNS: Readonly<Record<ArchiveTable, readonly string[]>> = {
	projects: [
		"id",
		"name",
		"description",
		"status",
		"git_path",
		"remote_url",
		"default_branch",
		"startup_script",
		"copy_files",
		"chapter_settings",
		"created_at",
		"updated_at",
	],
	exploration_groups: [
		"id",
		"project_id",
		"title",
		"description",
		"base_chapter_id",
		"status",
		"decided_chapter_id",
		"created_at",
		"updated_at",
	],
	chapters: [
		"id",
		"project_id",
		"title",
		"description",
		"status",
		"role",
		"branch",
		"worktree_path",
		"base_branch",
		"parent_chapter_id",
		"fork_point",
		"merged_into_chapter_id",
		"merge_commit_sha",
		"merge_strategy",
		"container_config",
		"exploration_group_id",
		"is_root",
		"head_commit_sha",
		"start_commit_sha",
		"commit_count",
		"color",
		"group_label",
		"pinned",
		"anchor_commit_sha",
		"axis_offset",
		"cross_offset",
		"last_accessed_at",
		"created_at",
		"updated_at",
		// Snapshot-space coordinates. A commit-free merge records nothing in the user's git
		// history, so these are the ONLY description of what happened — without them a
		// re-imported chapter reads as "merged with no merge commit", which `unmerge` and
		// `wake` both reject, and the merged-away uncommitted work becomes unreachable.
		"snapshot_commit_sha",
		"snapshot_shadow_key",
		"dormant_snapshot_commit_sha",
		"pre_merge_target_sha",
		"merge_snapshot_commit_sha",
		"pre_merge_target_snapshot_sha",
		"merged_source_snapshot_sha",
	],
	chapter_edges: ["id", "project_id", "source_id", "target_id", "type", "metadata", "created_at"],
	narrators: [
		"id",
		"chapter_id",
		"api_conversation_id",
		"fork_message_id",
		"type",
		"subagent_type",
		"title",
		"inherit_mode",
		"parent_narrator_id",
		"context_summary",
		"model",
		"system_prompt",
		"permission_mode",
		"message_count",
		"total_cost_usd",
		"last_message_at",
		"status",
		"plan_mode",
		"cwd",
		"error_message",
		"created_at",
		"substatus",
		"variant",
		"traits",
		"is_background",
		"background_status",
		"background_result",
		"background_completed_at",
		"is_ask_in_passing",
		"turn_started_at",
		"message_version",
		"fast_mode",
		"fast_mode_override",
		"relaxed_plan",
		"reasoning_effort",
		"previous_permission_mode",
		"plan_file_id",
		"context_summary_chars",
		"context_system_chars",
		"context_tools_chars",
		"context_char_revision",
		"updated_at",
	],
	narrator_messages: [
		"id",
		"narrator_id",
		"sdk_message_uuid",
		"parent_tool_use_id",
		"role",
		"content_json",
		"content_text",
		"tokens_in",
		"cost_usd",
		"cost_status",
		"cost_missing_fields",
		"turn_usage_json",
		"provider",
		"model",
		"output_tokens",
		"cached_input_tokens",
		"cache_creation_input_tokens",
		"cache_creation_5m_tokens",
		"cache_creation_1h_tokens",
		"reasoning_tokens",
		"ttft_ms",
		"duration_ms",
		"context_percent",
		"meter_usage",
		"meter_unit",
		"commit_sha",
		"context_chars_json",
		"created_at",
	],
	narrator_message_refs: ["id", "narrator_id", "message_id", "seq", "is_compact"],
	narrator_tool_calls: [
		"id",
		"narrator_id",
		"message_id",
		"tool_use_id",
		"tool_name",
		"input_json",
		"output_json",
		"input_chars",
		"output_chars",
		"execution_device_id",
		"execution_cwd",
		"resolved_file_path",
		"device_selection_source",
		"status",
		"duration_ms",
		"error_message",
		"permission_decided_by",
		"permission_decided_at",
		"permission_deny_message",
		"permission_decision_reason",
		"permission_suggestions",
		"created_at",
		// Added by `ensureProjectToolCallTargetColumns` rather than by the base DDL, so an
		// archive written before that patch existed lacks them. Listed here because the
		// current format has them; the runtime intersection handles the older files.
		"execution_path_flavor",
		"canonical_file_path",
		"runtime_generation",
		"execution_targets_json",
	],
	narrator_patches: [
		"id",
		"narrator_id",
		"message_id",
		"tool_use_id",
		"before_hash",
		"after_hash",
		"files_json",
		"created_at",
	],
	chapter_commits: [
		"id",
		"chapter_id",
		"sha",
		"message",
		"full_message",
		"author_name",
		"author_email",
		"authored_at",
		"source",
		"narrator_id",
		"narrator_message_id",
		"files_changed",
		"lines_added",
		"lines_removed",
		"created_at",
	],
	merge_sessions: [
		"id",
		"target_chapter_id",
		"source_chapter_ids",
		"strategy",
		"status",
		"current_index",
		"merged_count",
		"current_source_chapter_id",
		"conflict_files",
		"error",
		"locale",
		"created_at",
		"updated_at",
	],
};

const ARCHIVE_TABLE_SET: ReadonlySet<string> = new Set(ARCHIVE_TABLE_ORDER);

export function isArchiveTable(table: string): table is ArchiveTable {
	return ARCHIVE_TABLE_SET.has(table);
}
