import type {
	ContextCharCache,
	ContextCharStats,
	ContextSegment,
} from "@shared/context-composition";
import type {
	FileChangeActor,
	FileChangeExecutionBinding,
	FileChangeExecutionReceipt,
	FileChangeIdentity,
	FileChangeRecoveryDecision,
	FileChangeRevertMutationJournal,
	FileChangeState,
} from "@shared/file-change-protocol";
import { DEFAULT_LOCALE, type Locale } from "@shared/i18n-locales";
import type { NotificationLink } from "@shared/notification-center";
import type { ScheduledTaskCleanupPolicy } from "@shared/scheduled-task-cleanup";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	foreignKey,
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ToolExecutionPlan, ToolExecutionTarget } from "../lib/agent/types";

/** Attempt-bound permission proposals; authorization is consumed only after a valid decision. */
export const permissionRuleRequests = sqliteTable(
	"permission_rule_requests",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		toolCallId: text("tool_call_id")
			.notNull()
			.references(() => narratorToolCalls.id, { onDelete: "cascade" }),
		toolUseId: text("tool_use_id").notNull(),
		attempt: integer("attempt").notNull(),
		proposalJson: text("proposal_json", { mode: "json" })
			.$type<{ input: Record<string, unknown>; rule: Record<string, unknown> }>()
			.notNull(),
		proposalHash: text("proposal_hash").notNull(),
		reason: text("reason").notNull(),
		scope: text("scope", { enum: ["narrator"] })
			.notNull()
			.default("narrator"),
		deviceId: text("device_id").notNull(),
		contextRevision: text("context_revision").notNull(),
		status: text("status", {
			enum: ["pending", "approved", "denied", "applied", "alreadyExists", "failed", "cancelled"],
		})
			.notNull()
			.default("pending"),
		ruleId: text("rule_id"),
		approvalSource: text("approval_source", { enum: ["user", "reflection"] }),
		approvalUserId: text("approval_user_id"),
		reflectionConclusion: text("reflection_conclusion"),
		error: text("error"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("uq_permission_rule_request_attempt").on(table.toolCallId, table.attempt),
		index("idx_permission_rule_request_narrator_created").on(
			table.narratorId,
			table.createdAt,
			table.id,
		),
	],
);

/** Durable resource inventory, retained even after its owning narrator is deleted. */
export const narratorWorktreeResources = sqliteTable(
	"narrator_worktree_resources",
	{
		id: text("id").primaryKey(),
		ownerNarratorId: text("owner_narrator_id").references(() => narrators.id, {
			onDelete: "set null",
		}),
		/** Historical rows remain unknown; deletion of evidence never broadens this scope. */
		scopeKind: text("scope_kind", { enum: ["unknown", "standalone", "project"] })
			.notNull()
			.default("unknown"),
		scopeProjectId: text("scope_project_id").references(() => projects.id, {
			onDelete: "set null",
		}),
		scopeOwnerUserId: text("scope_owner_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		ownershipRevision: integer("ownership_revision").notNull().default(0),
		containerConfig: text("container_config", { mode: "json" }).$type<{
			composeFile: string;
			projectName?: string;
			proxyDomain?: string;
		}>(),
		deviceId: text("device_id").notNull(),
		repositoryKey: text("repository_key").notNull(),
		/** Canonical backend path; never derive cleanup ownership from chapters alone. */
		worktreePath: text("worktree_path").notNull(),
		state: text("state", { enum: ["preparing", "ready", "unknown"] }).notNull(),
		createRequestId: text("create_request_id").notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("uq_narrator_worktree_resource_path").on(table.deviceId, table.worktreePath),
		index("idx_narrator_worktree_resource_owner").on(table.ownerNarratorId),
		index("idx_worktree_resource_scope_project").on(table.scopeProjectId),
		index("idx_worktree_resource_scope_owner").on(table.scopeOwnerUserId),
		check(
			"ck_worktree_resource_scope_kind",
			sql`${table.scopeKind} in ('unknown', 'standalone', 'project')`,
		),
		// Project SET NULL is intentional: project scope with missing evidence must deny, not downgrade.
		check(
			"ck_worktree_resource_scope_project",
			sql`${table.scopeProjectId} is null or ${table.scopeKind} = 'project'`,
		),
		check("ck_worktree_resource_revision", sql`${table.ownershipRevision} >= 0`),
		check(
			"ck_worktree_resource_config_bytes",
			sql`${table.containerConfig} is null or length(cast(${table.containerConfig} as blob)) <= 16384`,
		),
	],
);

// === projects ===
export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	status: text("status", { enum: ["active", "archived"] })
		.notNull()
		.default("active"),
	flowMode: text("flow_mode", { enum: ["classic", "ruler"] })
		.notNull()
		.default("classic"),
	gitPath: text("git_path"),
	remoteUrl: text("remote_url"),
	defaultBranch: text("default_branch").default("main"),
	startupScript: text("startup_script"),
	copyFiles: text("copy_files"),
	chapterSettings: text("chapter_settings", { mode: "json" }),
	proxyDomain: text("proxy_domain"),
	/**
	 * Project layer of the layered trait system, same encoding as
	 * `narrators.traits` so one encode/decode implementation serves both.
	 * Resolution order is user → project → narrator (see lib/trait-layers.ts).
	 */
	traits: text("traits", { mode: "json" }).$type<string[]>().notNull().default([]),
	/**
	 * The user who created the project, and the only non-admin principal that may
	 * change its membership without holding an explicit `manage` grant.
	 *
	 * `set null` rather than cascade: deleting an account must never delete the
	 * project (and, through it, every chapter, worktree and conversation). A null
	 * owner is therefore a real, permanent state — it also covers every project that
	 * predates project ACLs, which the migration marks `public`. Those are
	 * admin-managed until someone is handed ownership.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: forward reference to users
	ownerUserId: text("owner_user_id").references((): any => users.id, { onDelete: "set null" }),
	/**
	 * Who may reach the project at all — the outermost gate in the ACL chain.
	 *
	 * - "private" — owner, admins, and principals holding an `acl_grants` row
	 * - "public"  — every signed-in user. What the migration assigns to existing
	 *               projects so an upgrade hides nothing.
	 *
	 * Passing this gate is necessary, never sufficient: a narrator or knowledge
	 * entry inside a reachable project is still governed by its own ACL, which is
	 * why a private session stays invisible to project members.
	 */
	visibility: text("visibility", { enum: ["private", "public"] })
		.notNull()
		.default("private"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// === skill_directory_caches ===
export const skillDirectoryCaches = sqliteTable(
	"skill_directory_caches",
	{
		id: text("id").primaryKey(),
		rootKind: text("root_kind", { enum: ["global", "project", "workspace"] }).notNull(),
		normalizedRootPath: text("normalized_root_path").notNull(),
		skillsJson: text("skills_json", { mode: "json" }).notNull(),
		signatureJson: text("signature_json", { mode: "json" }).notNull(),
		scannedAt: text("scanned_at").notNull(),
		lastAccessedAt: text("last_accessed_at").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_skill_dir_cache_root").on(table.rootKind, table.normalizedRootPath),
		index("idx_skill_dir_cache_last_accessed").on(table.lastAccessedAt),
		index("idx_skill_dir_cache_expires").on(table.expiresAt),
	],
);

// === exploration_groups ===
export const explorationGroups = sqliteTable(
	"exploration_groups",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		description: text("description"),
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to chapters
		baseChapterId: text("base_chapter_id").references((): any => chapters.id, {
			onDelete: "set null",
		}),
		status: text("status", { enum: ["active", "decided", "abandoned"] })
			.notNull()
			.default("active"),
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to chapters
		decidedChapterId: text("decided_chapter_id").references((): any => chapters.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_exploration_groups_project").on(table.projectId),
		// FK covering indexes so deleting a chapter does not scan this table per row.
		index("idx_exploration_groups_base_chapter").on(table.baseChapterId),
		index("idx_exploration_groups_decided_chapter").on(table.decidedChapterId),
	],
);

// === chapters ===
export const chapters = sqliteTable(
	"chapters",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		description: text("description"),
		/**
		 * `frozen` was removed rather than implemented.
		 *
		 * It was declared here and accepted by the validator, but no code path ever
		 * wrote it, and every operation that matters rejected it: `fork` and `review`
		 * require active/dormant, `wake` accepts only dormant, `dormant` requires
		 * active. A chapter that reached `frozen` could therefore never be forked,
		 * woken, merged or reviewed again — a state with no exit. The one observable
		 * symptom was `GET /api/chapters?status=frozen` silently returning *every*
		 * chapter, because the filter's own allowlist omitted it too.
		 *
		 * Dropping it needs no migration: Drizzle's `enum` is a TypeScript-level
		 * constraint, and the SQLite column is a plain `text` with no CHECK (verified
		 * against the live schema). No row has ever held the value.
		 *
		 * The idea it served — "merged chapters freeze on the ruler timeline" — is
		 * better expressed by `merged`, which already means exactly that and has a
		 * real exit (`unmerge`).
		 */
		status: text("status", {
			enum: ["active", "dormant", "merged", "abandoned"],
		})
			.notNull()
			.default("active"),

		// 角色（视觉和语义标签，不限制操作能力）
		role: text("role", { enum: ["trunk", "branch", "exploration", "review"] })
			.notNull()
			.default("branch"),

		branch: text("branch").notNull(),
		worktreePath: text("worktree_path"),
		baseBranch: text("base_branch").notNull(),
		// biome-ignore lint/suspicious/noExplicitAny: self-referencing FK
		parentChapterId: text("parent_chapter_id").references((): any => chapters.id, {
			onDelete: "set null",
		}),
		forkPoint: text("fork_point", { mode: "json" }),
		mergedIntoChapterId: text("merged_into_chapter_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: self-referencing FK
			(): any => chapters.id,
			{ onDelete: "set null" },
		),
		mergeCommitSha: text("merge_commit_sha"),
		mergeStrategy: text("merge_strategy", { enum: ["merge", "squash", "cherry-pick"] }),
		preMergeTargetSha: text("pre_merge_target_sha"),

		/**
		 * Snapshot commit produced by a commit-free merge.
		 *
		 * The snapshot-space counterpart of `mergeCommitSha`, and the flag that routes
		 * an unmerge: present means the merge happened in the shadow DAG and has to be
		 * reversed there, absent means it produced a real git commit. Deliberately a
		 * separate column rather than reusing `mergeCommitSha`, which nine backend and
		 * five frontend readers interpret as a genuine git commit — a snapshot id put
		 * there would be a lie they cannot detect.
		 */
		mergeSnapshotCommitSha: text("merge_snapshot_commit_sha"),
		/**
		 * Target's snapshot immediately before a commit-free merge.
		 *
		 * The snapshot-space counterpart of `preMergeTargetSha`, used to undo the merge
		 * and to abort a conflicted one.
		 */
		preMergeTargetSnapshotSha: text("pre_merge_target_snapshot_sha"),
		/**
		 * The source snapshot that was merged in.
		 *
		 * Serves two purposes, both load-bearing. It is the merge base for the reverse
		 * three-way merge that undoes the merge; and it is the only remaining record of
		 * the source's uncommitted work, since a commit-free merge leaves the source
		 * branch tip untouched while its worktree is removed. Waking or unmerging the
		 * source restores this tree, without which the user would get back a chapter
		 * holding only its last commit.
		 */
		mergedSourceSnapshotSha: text("merged_source_snapshot_sha"),
		containerConfig: text("container_config", { mode: "json" }),

		// 探索组
		explorationGroupId: text("exploration_group_id").references(() => explorationGroups.id, {
			onDelete: "set null",
		}),

		// Root chapter — represents the project's own git directory, not a worktree
		isRoot: integer("is_root").default(0),

		// Commit 范围边界（精确定义章节的 commit "窗口"）
		headCommitSha: text("head_commit_sha"),
		startCommitSha: text("start_commit_sha"),
		commitCount: integer("commit_count").default(0),

		/**
		 * Latest snapshot commit for this chapter's workspace — its narrative state
		 * independent of whether the user has committed anything.
		 *
		 * The chapter's identity used to be defined purely by commits, which is why
		 * forking and merging required one: there was no other name for "the state
		 * this chapter is in". This is that name. It advances as the workspace
		 * changes and needs no cooperation from the user's git history.
		 */
		snapshotCommitSha: text("snapshot_commit_sha"),
		/**
		 * Canonical key of the shadow repository holding this chapter's snapshots.
		 *
		 * Recorded separately from `worktreePath` because it must outlive it. Going
		 * dormant nulls `worktreePath` while the lineage stays valuable (waking
		 * rebuilds the identical path), so without this the orphan sweep cannot tell
		 * a dormant chapter's shadow repository from a genuinely abandoned one, and
		 * would delete the chapter's entire snapshot history.
		 */
		snapshotShadowKey: text("snapshot_shadow_key"),
		/**
		 * Snapshot holding work the branch tip does NOT carry, recorded when going
		 * dormant.
		 *
		 * Written only when the pre-dormant auto-commit failed — which `dormant`
		 * deliberately tolerates before deleting the worktree, so at that moment the
		 * snapshot becomes the only copy of the user's uncommitted work. Waking
		 * restores it.
		 *
		 * Deliberately not written after a successful commit, so its presence carries
		 * one unambiguous meaning: "the branch is missing this chapter's state". A value
		 * set unconditionally would make every wake overwrite a worktree that git had
		 * already restored correctly. Distinct from `snapshotCommitSha`, which tracks
		 * the latest state regardless of whether it is also committed.
		 */
		dormantSnapshotCommitSha: text("dormant_snapshot_commit_sha"),
		/**
		 * Uncommitted work parked so a rebase could run, awaiting reapplication.
		 *
		 * Rebase and cherry-pick genuinely require commits — they replay a commit
		 * sequence — but git also refuses to start either one over a dirty workspace,
		 * which is what made a chapter with uncommitted work unrebasable at all. The
		 * work is moved into the DAG first and put back afterwards.
		 *
		 * Persisted rather than held in memory because a conflicted rebase deliberately
		 * *stops* with the worktree mid-rebase, so the reapply happens in a later
		 * request (resolve, or abort) that has no other way to learn where the work went.
		 * Non-null therefore means "this chapter owes itself a reapply"; it is cleared at
		 * every terminal outcome, since a stale value would later restore an old
		 * workspace over current work.
		 */
		parkedSnapshotCommitSha: text("parked_snapshot_commit_sha"),
		/** Base tree of {@link parkedSnapshotCommitSha}, i.e. the clean state git was handed. */
		parkedSnapshotBaseTree: text("parked_snapshot_base_tree"),

		// 图可视化
		color: text("color"),
		groupLabel: text("group_label"),
		pinned: integer("pinned").default(0),
		/**
		 * Ruler 坐标系：锚定到 commit + 轴上偏移 + 离轴距离。
		 *
		 * 这三列**只属于 ruler**：`axisOffset`/`crossOffset` 是相对 `anchorCommitSha`
		 * 对应刻度的偏移，绝对位置是 `tickPosition(anchorCommitSha) + axisOffset`。
		 * 脱离锚点它们没有意义 —— ruler 的刻度间距是每个 commit 240px，历史较长的
		 * 章节其刻度坐标轻易上万，直接当世界坐标读会把节点丢到视口外极远处。
		 *
		 * classic 画布不要读写这三列，用下面的 `graphX`/`graphY`。
		 */
		anchorCommitSha: text("anchor_commit_sha"),
		axisOffset: real("axis_offset").default(0),
		crossOffset: real("cross_offset").default(0),
		/**
		 * Classic 画布的绝对世界坐标（React Flow 的 x/y），与 ruler 的锚定偏移分列存放。
		 *
		 * 两套坐标必须分开，因为它们语义不同且不可互换：ruler 存的是相对刻度的偏移，
		 * classic 存的是绝对坐标。历史上两者共用 `axisOffset`/`crossOffset`，导致在
		 * ruler 里拖过卡片的项目切回 classic 后，节点被按绝对坐标丢到极远处 —— 表现为
		 * `fitView` 把缩放压到极小、画布看起来整个空白（节点其实在渲染，只是小到看不见），
		 * 并且缩放低于 `MIN_EFFECTIVE_ZOOM` 还会让展开节点的 dock 反复挂载卸载。
		 *
		 * null = 该章节在 classic 中还没有被手动摆放过，交给 dagre 自动布局。这与 0 有
		 * 实质区别：0 是一个用户真的可以拖到的位置（原点），若用 0 表示"未摆放"，任何
		 * 拖到原点附近的节点都会在下次加载时被自动布局重新弹走。
		 */
		graphX: real("graph_x"),
		graphY: real("graph_y"),
		panelExpanded: integer("panel_expanded").default(0),
		panelWidth: real("panel_width"),
		panelHeight: real("panel_height"),
		/**
		 * 展开节点内嵌 dockview 表面的布局（序列化 envelope）；null = 用默认布局（仅 chat 面板）。
		 *
		 * 大字段：列表/图查询的 columns 白名单里不要加它（图接口一次返回全项目章节），
		 * 只有 `GET /api/chapters/:id/dock-layout` 读取。写入上限见 updateChapterDockLayoutSchema。
		 */
		dockLayoutJson: text("dock_layout_json"),
		/**
		 * 从该章节 dock 中拖出、以独立节点形式留在画布上的工具面板（序列化 envelope）；null = 没有。
		 *
		 * 与 dockLayoutJson 分列存放：后者是 dockview 自己的 SerializedDockview，
		 * 把自定义条目混进去会破坏 fromJSON。同样是大字段，列表/图查询不要读。
		 */
		detachedPanelsJson: text("detached_panels_json"),

		// Review 相关
		// biome-ignore lint/suspicious/noExplicitAny: self-referencing FK
		reviewSourceChapterId: text("review_source_chapter_id").references((): any => chapters.id, {
			onDelete: "set null",
		}),
		reviewStatus: text("review_status", {
			enum: ["reviewing", "concluded", "converted", "dismissed"],
		}),

		lastAccessedAt: text("last_accessed_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_chapters_project").on(table.projectId, table.status),
		index("idx_chapters_parent").on(table.parentChapterId),
		uniqueIndex("idx_chapters_project_branch").on(table.projectId, table.branch),
		// FK covering indexes. chapters is deleted in several places (chapter-service,
		// projects routes), and the two self-references plus the exploration-group link
		// would otherwise be enforced with a full table scan per deleted row.
		index("idx_chapters_merged_into").on(table.mergedIntoChapterId),
		index("idx_chapters_review_source").on(table.reviewSourceChapterId),
		index("idx_chapters_exploration_group").on(table.explorationGroupId),
		// Looked up on every shadow-repo destroy to decide whether a chapter still
		// claims it; without an index that is a full table scan per orphan swept.
		index("idx_chapters_snapshot_shadow_key").on(table.snapshotShadowKey),
		/**
		 * Matched on every snapshot-pointer advance, which is the hottest write in the
		 * system: the workspace watcher polls each active chapter and a narrator's every
		 * file-mutating tool call crosses two boundaries. `advanceChapterSnapshot` updates
		 * by workspace path rather than by chapter id — a workspace can back several
		 * narrators, so the position belongs to the path — and without this index each of
		 * those updates scanned the whole table.
		 */
		index("idx_chapters_worktree_path").on(table.worktreePath),
	],
);

// === chapter_edges ===
export const chapterEdges = sqliteTable(
	"chapter_edges",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		sourceId: text("source_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		targetId: text("target_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		type: text("type", {
			enum: ["fork", "merge", "dependency", "cherry_pick", "review"],
		}).notNull(),
		metadata: text("metadata", { mode: "json" }),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_chapter_edges_src_tgt_type").on(table.sourceId, table.targetId, table.type),
		index("idx_chapter_edges_project").on(table.projectId),
		index("idx_chapter_edges_source").on(table.sourceId),
		index("idx_chapter_edges_target").on(table.targetId),
	],
);

// === chapter_commits ===
export const chapterCommits = sqliteTable(
	"chapter_commits",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		sha: text("sha").notNull(),
		message: text("message").notNull(),
		fullMessage: text("full_message"),
		authorName: text("author_name"),
		authorEmail: text("author_email"),
		authoredAt: text("authored_at").notNull(),

		// 来源追踪
		source: text("source", {
			enum: ["manual", "auto", "merge", "cherry_pick", "initial"],
		})
			.notNull()
			.default("manual"),

		// narrator 关联
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "set null" }),
		narratorMessageId: text("narrator_message_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: forward reference to narratorMessages
			(): any => narratorMessages.id,
			{ onDelete: "set null" },
		),

		// diff 统计缓存
		filesChanged: integer("files_changed"),
		linesAdded: integer("lines_added"),
		linesRemoved: integer("lines_removed"),

		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_chapter_commits_sha").on(table.chapterId, table.sha),
		index("idx_chapter_commits_chapter").on(table.chapterId, table.authoredAt),
		index("idx_chapter_commits_narrator").on(table.narratorId),
		// FK covering index: without it every narrator_messages row deletion triggers a
		// full scan of this table to enforce the ON DELETE SET NULL constraint.
		index("idx_chapter_commits_narrator_message").on(table.narratorMessageId),
	],
);

// === narrators ===
export const narrators = sqliteTable(
	"narrators",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id").references(() => chapters.id),
		/** Creation provenance, never attached when a scheduled task reuses a session. */
		scheduledTaskId: text("scheduled_task_id").references(
			(): AnySQLiteColumn => scheduledTasks.id,
			{ onDelete: "set null" },
		),
		apiConversationId: text("api_conversation_id"),
		/** Durable logical run identity; recovery keeps it, a genuine new start replaces it. */
		logicalRunId: text("logical_run_id"),
		/** Mailbox arrival counter; capacity reservations never increment it. */
		inboxSequence: integer("inbox_sequence").notNull().default(0),
		/**
		 * Allocation counter for narrator_message_refs.seq: the next claimable seq, claimed by
		 * `next_seq = next_seq + 1 … RETURNING` (which doubles as the per-narrator row lock).
		 * Startup does NOT scan all narrators to repair this counter. On process-lifetime first
		 * write, choke points raise the floor to at least MAX(refs.seq)+1 inside the write
		 * transaction (one-way ratchet) and mark the narrator healed only after that transaction
		 * commits. Project import raises floors for imported ids after import commits.
		 */
		nextSeq: integer("next_seq").notNull().default(0),
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to narratorMessages
		forkMessageId: text("fork_message_id").references((): any => narratorMessages.id),
		type: text("type", { enum: ["primary", "subagent"] })
			.notNull()
			.default("primary"),
		subagentType: text("subagent_type"),
		title: text("title"),
		inheritMode: text("inherit_mode", { enum: ["full", "compressed", "fresh"] })
			.notNull()
			.default("fresh"),
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		parentNarratorId: text("parent_narrator_id").references((): any => narrators.id),
		/** Immutable actual Agent tool-call PK; retained even if its history is deleted. */
		originToolCallId: text("origin_tool_call_id"),
		/** Explicit creation provenance; NULL means unknown legacy origin. */
		subagentOriginKind: text("subagent_origin_kind", { enum: ["tool", "standalone"] }),
		contextSummary: text("context_summary"),
		contextSummaryChars: integer("context_summary_chars").notNull().default(0),
		contextSystemChars: integer("context_system_chars").notNull().default(0),
		contextToolsChars: integer("context_tools_chars").notNull().default(0),
		contextCharRevision: integer("context_char_revision").notNull().default(0),
		contextCharCacheJson: text("context_char_cache_json", {
			mode: "json",
		}).$type<ContextCharCache>(),
		model: text("model").default("claude-sonnet-4.5"),
		/** When set, the model should be restored to this value after the current turn completes.
		 *  Used by temporary model override on slash commands. Cleared after restore. */
		pendingModelRestore: text("pending_model_restore"),
		systemPrompt: text("system_prompt"),
		permissionMode: text("permission_mode", {
			enum: ["default", "acceptEdits", "bypassPermissions", "readOnly", "dontAsk"],
		}).default("default"),
		previousPermissionMode: text("previous_permission_mode"),
		/** Persistent ID for the designated .narrafork/plans/plan-{id}.md file while in plan mode. */
		planFileId: text("plan_file_id"),
		reasoningEffort: text("reasoning_effort", {
			enum: ["none", "low", "medium", "high", "xhigh", "max"],
		}),
		/**
		 * @deprecated Legacy resolved boolean. Kept only so older rows/readers keep
		 * working; the runtime source of truth is `fastModeOverride`. Written on
		 * every override change to mirror the value that was in effect at that time.
		 */
		fastMode: integer("fast_mode", { mode: "boolean" }).notNull().default(false),
		/**
		 * Priority-tier (fast mode)三态：inherit = 跟随用户偏好 fastModeDefault，
		 * on/off = 本会话显式覆盖。inherit 让默认值的变更对已有叙述者立即生效。
		 */
		fastModeOverride: text("fast_mode_override", { enum: ["inherit", "on", "off"] })
			.notNull()
			.default("inherit"),
		relaxedPlan: integer("relaxed_plan", { mode: "boolean" }).notNull().default(false),
		planReflectionAutoApproveOverride: text("plan_reflection_auto_approve_override", {
			enum: ["inherit", "on", "off"],
		})
			.notNull()
			.default("inherit"),
		dangerReflectionOverride: text("danger_reflection_override", {
			enum: ["inherit", "on", "off", "light", "standard", "strict"],
		})
			.notNull()
			.default("inherit"),
		autoContinuationOverride: text("auto_continuation_override", {
			enum: ["inherit", "always", "blockStop", "protectedOnly", "off"],
		})
			.notNull()
			.default("inherit"),
		/** Behavior fence periodic-injection interval override. null = follow global default;
		 *  -1 = disabled; >0 = inject the behavior-fence sidecar every N completed tool calls. */
		behaviorFenceIntervalOverride: integer("behavior_fence_interval_override"),
		/** Tasks.json reminder periodic-injection interval override. null = follow global default;
		 *  -1 = disabled; >0 = inject the tasks.json reminder every N completed tool calls. */
		tasksReminderIntervalOverride: integer("tasks_reminder_interval_override"),
		/** Whether the behavior fence rides along with the tasks.json reminder. inherit = follow default. */
		behaviorFenceAttachOverride: text("behavior_fence_attach_override", {
			enum: ["inherit", "on", "off"],
		})
			.notNull()
			.default("inherit"),
		messageCount: integer("message_count").default(0),
		totalCostUsd: real("total_cost_usd").default(0),
		lastMessageAt: text("last_message_at"),
		status: text("status", {
			enum: ["idle", "working", "waiting", "archived"],
		})
			.notNull()
			.default("idle"),
		/** JSON array of substatus tags (e.g. ["reasoning","compacting","background_compacting"]) */
		substatus: text("substatus").notNull().default("[]"),
		planMode: integer("plan_mode", { mode: "boolean" }).notNull().default(false),
		cwd: text("cwd"),
		/** Monotonic CAS identity of the narrator's execution workspace (not layout workspace). */
		workspaceRevision: integer("workspace_revision").notNull().default(0),
		/** Prepared identity committed atomically with cwd; used to recover failed runtime installation. */
		workspaceContext: text("workspace_context", { mode: "json" }).$type<
			import("@shared/workspace-context").WorkspaceContext
		>(),
		errorMessage: text("error_message"),
		/**
		 * Whether the last failure is worth retrying, when the provider diagnostics said so.
		 * null means unknown. Persisted so it can be reported to clients that only see the
		 * narrator row (external API), which otherwise cannot tell a transient 429 from a
		 * permanent context-length failure.
		 */
		errorRetryable: integer("error_retryable", { mode: "boolean" }),
		/**
		 * Parent narrator this one still borrows older refs from (lazy fork).
		 *
		 * A fork only materializes the refs the model actually needs — those after
		 * the parent's last history compact. Everything older stays in the parent
		 * and is copied in on demand when the user scrolls up. null means this
		 * narrator owns every ref it can show (a non-lazy fork, a fully
		 * backfilled one, or pre-feature data).
		 *
		 * Distinct from `parentNarratorId`, which records provenance forever;
		 * this column is cleared once the backfill completes.
		 */
		// biome-ignore lint/suspicious/noExplicitAny: self-reference
		refsInheritedFrom: text("refs_inherited_from").references((): any => narrators.id),
		/**
		 * Lowest seq this narrator has materialized from the parent. Refs with
		 * `seq >= refsBackfillCursor` are local; anything below still lives only in
		 * `refsInheritedFrom` and must be backfilled before it can be shown.
		 * null means there is nothing left to backfill.
		 */
		refsBackfillCursor: integer("refs_backfill_cursor"),
		/** JSON array of optional tool names explicitly enabled for this narrator */
		enabledTools: text("enabled_tools", { mode: "json" }).$type<string[]>(),
		/**
		 * Mutually exclusive narrator identity (immutable after creation).
		 * - "primary"           — regular narrator
		 * - "subagent:<type>"   — subagent (explore/plan/general/review/<custom>)
		 */
		variant: text("variant").notNull().default("primary"),
		/**
		 * Stackable permanent attribute tags (JSON string[]).
		 * Possible values: "standalone", "ask-in-passing", "background", "named"
		 */
		traits: text("traits", { mode: "json" }).$type<string[]>().notNull().default([]),
		/**
		 * Globally-unique, human-friendly handle for "named narrators".
		 * Only set when traits includes "named". Used for @handle mentions across
		 * any session. Stores the ORIGINAL case the user typed (may contain Unicode
		 * letters incl. CJK, digits, `_`, `-`). Null for regular narrators. See
		 * `handleFold` for the case-insensitive uniqueness/match key.
		 */
		handle: text("handle"),
		/**
		 * Case-insensitive canonical form of `handle` (NFC-normalized + lowercased).
		 * This is the real uniqueness + @mention match key so "MyBot"/"mybot" are
		 * the same narrator. Null when `handle` is null. Kept in sync in the service
		 * layer via `foldHandle()`.
		 */
		handleFold: text("handle_fold"),
		// Background task fields
		isBackground: integer("is_background", { mode: "boolean" }).notNull().default(false),
		backgroundStatus: text("background_status", {
			enum: ["running", "completed", "failed", "cancelled"],
		}),
		backgroundResult: text("background_result"),
		backgroundCompletedAt: text("background_completed_at"),
		/** Whether this narrator was created via "ask in passing" (locked to readOnly until promoted) */
		isAskInPassing: integer("is_ask_in_passing", { mode: "boolean" }).notNull().default(false),
		/** ISO timestamp when the current (or last) turn started */
		turnStartedAt: text("turn_started_at"),
		/** Monotonically increasing counter bumped on every message add/delete/update */
		messageVersion: integer("message_version").notNull().default(0),
		/** Monotonically increasing counter bumped when the visible timeline structure changes. */
		messageStructureVersion: integer("message_structure_version").notNull().default(0),
		/**
		 * Default execution device for this session's file/command tools.
		 * null → local server. When set to a remote_devices.id, Read/Write/Edit/
		 * Glob/Grep/Bash route their IO to that device unless a per-call `device`
		 * parameter overrides it. Set via the SwitchDevice tool.
		 */
		defaultDeviceId: text("default_device_id"),
		/** @deprecated Migration-only OAuth ownership shadow; use integration_resource_bindings. */
		oauthOwnerGrantId: text("oauth_owner_grant_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: forward reference to oauthGrants
			(): any => oauthGrants.id,
			{ onDelete: "set null" },
		),
		/** @deprecated Migration-only idempotency shadow; use binding.provisionKey. */
		oauthProvisionKey: text("oauth_provision_key"),
		/** Explicit project context for standalone externally provisioned narrators. */
		contextProjectId: text("context_project_id").references(() => projects.id, {
			onDelete: "set null",
		}),
		/** Frozen client policy applied when this narrator was provisioned. */
		oauthPolicySnapshotJson: text("oauth_policy_snapshot_json", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		/**
		 * Custom bitmap avatar for this narrator, keyed into the avatars upload dir by
		 * narrator id (same scheme as users.avatarImageId). Null → the UI falls back to
		 * the deterministic identicon derived from the narrator id. Only a custom upload
		 * is stored; the procedural glyph needs no column.
		 */
		avatarImageId: text("avatar_image_id"),
		/**
		 * The user who created this narrator, and the only non-admin principal that may
		 * change its visibility or share it (see `canManageNarratorAcl`).
		 *
		 * `set null` rather than `cascade`: deleting a user must never take an entire
		 * conversation history with it. A null owner is therefore a real, permanent state
		 * — it also covers every row that predates this column, which the one-time
		 * backfill marks `public`. Such rows are manageable by admins only, who can hand
		 * one over with `POST /api/narrators/:id/transfer-owner`.
		 */
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to users
		ownerUserId: text("owner_user_id").references((): any => users.id, {
			onDelete: "set null",
		}),
		/**
		 * The READ audience. One of the two independent audience axes; the other is
		 * `writeAudience` below. Read access never confers the right to drive.
		 *
		 * - "private" — owner (+ granted users) only. Default for standalone narrators.
		 * - "project" — visible to the members of the owning project, resolved the same
		 *               way every other check resolves it (chapter first, then
		 *               `contextProjectId`). Default for chapter-bound narrators, so
		 *               forking or merging someone else's chapter does not leave an
		 *               unopenable node on the story graph.
		 * - "public"  — every authenticated user. Also what the one-time backfill assigns
		 *               to pre-ACL rows so an upgrade never silently hides existing work.
		 *
		 * "public" here is deliberately NOT behind the project gate: its audience is
		 * meant to be wider than any project. "project" is, and is resolved through
		 * the owning chapter (see `narrator-acl.ts`).
		 */
		visibility: text("visibility", { enum: ["private", "project", "public"] })
			.notNull()
			.default("private"),
		/**
		 * The WRITE audience: who may drive this narrator — send messages, decide
		 * permission requests, change models, roll back history, open terminals.
		 *
		 * Separate from `visibility` on purpose. Making a session readable shares a view
		 * of the work; handing over the ability to approve a Bash call or a file write is
		 * a different decision, so it gets its own axis instead of being implied by the
		 * read audience.
		 *
		 * - "owner"   — owner, admins, and holders of an explicit write grant. The
		 *               default, and what every pre-existing row is backfilled to: an
		 *               upgrade must never widen who can drive someone's session.
		 * - "project" — additionally, project members holding write/manage. Members with
		 *               only `read` are excluded: a project read member is defined as
		 *               "cannot change the project", and driving a session inside it
		 *               (running commands, editing files) would go around that line.
		 *               Grants nothing when the narrator resolves to no project.
		 * - "public"  — additionally, any authenticated user who can pass the project
		 *               gate. Wider than "project members who may write", but still
		 *               bounded by the gate: a session inside a private project stays
		 *               undrivable by people who cannot reach that project.
		 *
		 * Both non-owner tiers require the project gate's READ first, so removing someone
		 * from a project immediately stops them driving its sessions even if an older
		 * narrator grant survives. Unknown values fail closed.
		 */
		writeAudience: text("write_audience", { enum: ["owner", "project", "public"] })
			.notNull()
			.default("owner"),
		/**
		 * The root narrator a subagent delegates its access decisions to, and the single
		 * authority for those decisions: both the row-level checks and the SQL list
		 * predicate read only this column, never the `parentNarratorId` chain.
		 *
		 * Null for primary narrators (they are judged on their own columns). For a
		 * subagent, null — or a value pointing at a row that no longer exists — means the
		 * ownership is undeterminable and access FAILS CLOSED (owner/admin only). It must
		 * never fall back to judging the subagent by its own columns: those are frozen at
		 * their strictest values and do not follow the root.
		 *
		 * `set null` rather than cascade: deleting a root must not delete the subagent's
		 * transcript, and the resulting null degrades to "denied", which is the safe
		 * direction. The chain is used only for the migration backfill and an offline
		 * consistency check — never on a decision path, because a second source of truth
		 * is what lets the list predicate and the row check disagree.
		 */
		// biome-ignore lint/suspicious/noExplicitAny: self-module forward reference
		aclRootNarratorId: text("acl_root_narrator_id").references((): any => narrators.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		// NOTE: the "write audience is nested inside the read audience" rule is enforced
		// ONLY in the service layer (`@shared/narrator-access` holds the single
		// definition; `narrator-sharing.ts` and the creation path apply it). There is
		// deliberately NO database CHECK constraint.
		//
		// A `check()` here was tried and reverted. SQLite cannot attach a table-level
		// constraint to an existing table, so Drizzle generates the 12-step rebuild
		// (create `__new_narrators`, copy every row, DROP TABLE `narrators`, rename).
		// Dropping this table takes the `narrators_fts_*` triggers with it — they are
		// created outside the migration system by `db/fts.ts`, so the rebuild would
		// silently leave full-text search un-indexed for every subsequent write. Paying
		// that for a rule the service layer already enforces is the wrong trade.
		//
		// The consequence to know: a future code path that writes these columns without
		// going through the service layer can create an illegal pair, and nothing will
		// stop it. `narrator-access-nesting.test.ts` covers the paths that exist today.
		index("idx_narrators_scheduled_task_created").on(
			table.scheduledTaskId,
			table.createdAt,
			table.id,
		),
		index("idx_narrators_chapter").on(table.chapterId),
		index("idx_narrators_parent").on(table.parentNarratorId),
		index("idx_narrators_origin_tool_call").on(table.originToolCallId),
		// FK covering index for user deletion, and the lookup behind "my narrators".
		index("idx_narrators_owner").on(table.ownerUserId),
		// Leads the visibility predicate pushed down into the paginated list query.
		index("idx_narrators_visibility").on(table.visibility),
		// Same role for the write-audience branches of that predicate.
		index("idx_narrators_write_audience").on(table.writeAudience),
		// Join key for the subagent -> root delegation in the readable predicate, and the
		// FK covering index for root deletion (ON DELETE SET NULL).
		index("idx_narrators_acl_root").on(table.aclRootNarratorId),
		index("idx_narrators_variant_updated").on(table.variant, table.updatedAt, table.id),
		index("idx_narrators_handle").on(table.handle),
		uniqueIndex("idx_narrators_handle_fold").on(table.handleFold),
		index("idx_narrators_context_project").on(table.contextProjectId),
		index("idx_narrators_oauth_owner").on(table.oauthOwnerGrantId),
		uniqueIndex("idx_narrators_oauth_provision").on(
			table.oauthOwnerGrantId,
			table.oauthProvisionKey,
		),
		// FK covering indexes: message deletion (rollback / edit-and-regenerate) enforces
		// these constraints per deleted row, which degrades to a full narrators scan without
		// an index and dominates the whole delete transaction.
		index("idx_narrators_fork_message").on(table.forkMessageId),
		// Partial index over the lazily-forked narrators only. Deleting a narrator has
		// to check this self-FK per row, and the search lineage CTE walks it; in both
		// cases the set of interest is the small "still borrowing refs" subset.
		index("idx_narrators_refs_inherited_from")
			.on(table.refsInheritedFrom)
			.where(sql`"refs_inherited_from" IS NOT NULL`),
		// Cursor paging for the LEGACY half of the background-task list (subagents
		// recorded before `background_tasks` existed). Partial because the set of
		// interest is a small slice of a large table, and the list always filters on
		// it. `idx_narrators_parent` alone cannot serve the `createdAt desc` order.
		index("idx_narrators_background_parent_created")
			.on(table.parentNarratorId, table.createdAt, table.id)
			.where(sql`"is_background" = 1`),
	],
);

// === narrator_grants ===
/**
 * Explicit per-user share list for a narrator, the "shared with specific people"
 * half of narrator access control. The other half lives on the narrator itself:
 * `owner_user_id` (always allowed) and `visibility` (the broad audience).
 *
 * Deliberately NOT folded into `knowledge_grants`: that table's FKs point at
 * knowledge collections/tags and its two-axis clearance+compartment semantics do
 * not apply here. Deliberately NOT folded into `integration_resource_bindings`
 * either — that table answers "which integration may drive this narrator", is
 * unique per resource, and so cannot express a list of N human viewers.
 *
 * All three identity columns are NOT NULL, so a single composite unique index is
 * enough; the four-partial-index dance in `knowledge_grants` exists only because
 * SQLite treats NULLs as distinct.
 */
export const narratorGrants = sqliteTable(
	"narrator_grants",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			// biome-ignore lint/suspicious/noExplicitAny: self-module forward reference
			.references((): any => narrators.id, { onDelete: "cascade" }),
		/**
		 * "user" — principalId is a users.id.
		 * "role" — principalId is a role name. Reserved: "everyone" is expressed by
		 *          `narrators.visibility = 'public'`, which needs no join.
		 */
		principalType: text("principal_type", { enum: ["user", "role"] }).notNull(),
		principalId: text("principal_id").notNull(),
		/**
		 * "read"  — view the timeline, tool calls and the discussion room.
		 * "write" — additionally send messages, decide permission requests and change
		 *           session settings. Never implies the right to re-share: that stays
		 *           with the owner and admins (see `canManageNarratorAcl`).
		 */
		access: text("access", { enum: ["read", "write"] })
			.notNull()
			.default("read"),
		/** Who issued the grant. `set null` keeps the row auditable after user deletion. */
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to users
		grantedBy: text("granted_by").references((): any => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_narrator_grant_unique").on(
			table.narratorId,
			table.principalType,
			table.principalId,
		),
		// The hot path: "does this user hold a grant on this narrator" (point lookup),
		// and the EXISTS subquery in the list predicate.
		index("idx_narrator_grant_principal").on(table.principalType, table.principalId),
		// FK covering index for narrator deletion (ON DELETE CASCADE).
		index("idx_narrator_grant_narrator").on(table.narratorId),
		// FK covering index for user deletion.
		index("idx_narrator_grant_granted_by").on(table.grantedBy),
	],
);

// === acl_grants ===
/**
 * The unified grant table: one shape for project, chapter, narrator and knowledge
 * authorization.
 *
 * Supersedes `knowledge_grants` and `narrator_grants`, which expressed the same
 * idea three different ways. Those tables are kept (deprecated, unread) for one
 * release so a bad migration can be rolled back as code rather than as data.
 *
 * A row is one of exactly two shapes, never both:
 *
 *  A. CAPABILITY row — `capability` set, `domain_kind`/`domain_value` NULL.
 *     "This principal may read / write / manage this scope." Projects and
 *     narrators only ever produce these.
 *
 *  B. DOMAIN CREDENTIAL row — `domain_kind` + `domain_value` set, `capability`
 *     pinned to 'read'. "This principal holds a clearance / compartment tag /
 *     review tag." The pinned capability is a placeholder that keeps the unique
 *     index single-valued; it does NOT mean the principal can read anything. The
 *     knowledge layer still decides readability by comparing rank and tag sets.
 *     Reading shape B as an authorization would promote a holder of one low
 *     clearance into "can read everything" — an escalation, which is why the
 *     kernel only ever unions these into an uninterpreted credential set.
 *
 * `scope_id` is NULL only for `scope_type = 'global'` (an instance-wide grant,
 * which is how a collection-less clearance used to be expressed).
 */
export const aclGrants = sqliteTable(
	"acl_grants",
	{
		id: text("id").primaryKey(),
		/**
		 * What the grant is attached to. Intentionally not a foreign key: the column is
		 * polymorphic, and a grant row surviving its resource is preferable to a
		 * cascade that quietly widens someone's access by deleting a narrowing scope.
		 * Orphans are cleaned up by the same paths that delete the resource.
		 */
		scopeType: text("scope_type", {
			enum: ["global", "project", "chapter", "narrator", "knowledge_collection", "knowledge_entry"],
		}).notNull(),
		scopeId: text("scope_id"),
		/** "user" → users.id; "role" → a users.role value ("admin" | "user"). */
		principalType: text("principal_type", { enum: ["user", "role"] }).notNull(),
		principalId: text("principal_id").notNull(),
		/**
		 * read   — see it
		 * write  — act in/on it
		 * manage — change who else may. Never implied by write, and never inherited
		 *          from an ancestor scope.
		 * On shape B rows this is pinned to 'read' as a placeholder (see above).
		 */
		capability: text("capability", { enum: ["read", "write", "manage"] }).notNull(),
		/** Shape B only. NULL on capability rows. */
		domainKind: text("domain_kind", { enum: ["clearance", "tag", "review"] }),
		/** Shape B only: a clearance level name or a tag id. NULL on capability rows. */
		domainValue: text("domain_value"),
		/** Who issued it. `set null` keeps the row auditable after user deletion. */
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to users
		grantedBy: text("granted_by").references((): any => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		// Business uniqueness, split across four partial indexes because SQLite treats
		// NULLs as distinct (so one composite index would admit duplicates for every
		// NULL combination) and drizzle-kit mis-generates COALESCE expression indexes.
		// Same technique as knowledge_grants; see its comment for the history.
		//
		// 1. scoped domain credential (e.g. a tag on one collection)
		uniqueIndex("idx_acl_grant_unique_scoped_domain")
			.on(
				table.scopeType,
				table.scopeId,
				table.principalType,
				table.principalId,
				table.capability,
				table.domainKind,
				table.domainValue,
			)
			.where(sql`${table.scopeId} is not null and ${table.domainValue} is not null`),
		// 2. scoped capability row — the common case (project / narrator grants)
		uniqueIndex("idx_acl_grant_unique_scoped_capability")
			.on(table.scopeType, table.scopeId, table.principalType, table.principalId, table.capability)
			.where(sql`${table.scopeId} is not null and ${table.domainValue} is null`),
		// 3. global domain credential (a clearance with no collection scope)
		uniqueIndex("idx_acl_grant_unique_global_domain")
			.on(
				table.scopeType,
				table.principalType,
				table.principalId,
				table.capability,
				table.domainKind,
				table.domainValue,
			)
			.where(sql`${table.scopeId} is null and ${table.domainValue} is not null`),
		// 4. global capability row
		uniqueIndex("idx_acl_grant_unique_global_capability")
			.on(table.scopeType, table.principalType, table.principalId, table.capability)
			.where(sql`${table.scopeId} is null and ${table.domainValue} is null`),
		// The judgement hot path: "what does this principal hold" across a scope chain.
		index("idx_acl_grant_principal").on(table.principalType, table.principalId),
		// Reverse lookup: "who can reach this resource", and the EXISTS push-down.
		index("idx_acl_grant_scope").on(table.scopeType, table.scopeId),
		// FK covering index for user deletion.
		index("idx_acl_grant_granted_by").on(table.grantedBy),
	],
);

// === acl_events ===
/**
 * Append-only audit of AUTHORIZATION changes across every resource type.
 *
 * Unifies `knowledge_acl_events` and follows the wider shape of
 * `integration_audit_events` (principal × resource × scope × outcome), so the two
 * can eventually be read together.
 *
 * Deliberately has NO foreign keys: an audit row must outlive the grant, user and
 * resource it describes, otherwise the record of "who removed whose access" is
 * destroyed by the very deletion it documents.
 *
 * `detailJson` is redacted by construction — ids, booleans and level names only,
 * never titles or content. An audit log that carried content would become a way to
 * read what the reader was never allowed to see.
 */
export const aclEvents = sqliteTable(
	"acl_events",
	{
		id: text("id").primaryKey(),
		/** Who performed the change. Null for system-initiated changes (migrations). */
		actorUserId: text("actor_user_id"),
		actorRole: text("actor_role"),
		/**
		 * Free text rather than an enum on purpose: a new surface must be able to record
		 * its own event kind without a schema migration. Known values are listed in
		 * `acl-audit.ts`.
		 */
		eventType: text("event_type").notNull(),
		/** Whose access changed. */
		subjectType: text("subject_type", { enum: ["user", "role"] }),
		subjectId: text("subject_id"),
		/** What the change applied to. */
		scopeType: text("scope_type").notNull(),
		scopeId: text("scope_id"),
		outcome: text("outcome", {
			enum: ["granted", "revoked", "replaced", "transferred", "updated"],
		}).notNull(),
		detailJson: text("detail_json", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		// Keyset pagination reads newest-first over (createdAt, id).
		index("idx_acl_event_created").on(table.createdAt, table.id),
		index("idx_acl_event_scope").on(table.scopeType, table.scopeId),
		index("idx_acl_event_subject").on(table.subjectType, table.subjectId),
		index("idx_acl_event_actor").on(table.actorUserId),
	],
);

// === remote_devices ===
/**
 * A registered remote executor device. A lightweight Go agent runs on the
 * device, connects back to NarraFork (reverse dial) or is dialed by the server
 * (direct), and executes file/command/git operations forwarded over RPC.
 */
export const remoteDevices = sqliteTable(
	"remote_devices",
	{
		id: text("id").primaryKey(),
		/** Display name (user-editable). */
		name: text("name").notNull(),
		/** Unique slug the model can reference (stable, [a-z0-9_-]). */
		slug: text("slug").notNull(),
		/** Optional usage description injected into the narrator prompt. */
		description: text("description"),
		// ── Authentication ──
		/** Hash of the registration key (never stored in plaintext). */
		tokenHash: text("token_hash").notNull(),
		/** Non-secret key prefix shown in the UI (e.g. "rdev_ab12"). */
		tokenPrefix: text("token_prefix").notNull(),
		// ── Connection mode ──
		connectionMode: text("connection_mode", { enum: ["reverse", "direct"] })
			.notNull()
			.default("reverse"),
		/** For direct mode: the ws(s):// URL the server dials to reach the executor. */
		directUrl: text("direct_url"),
		// ── Runtime state (updated by the connection manager) ──
		status: text("status", { enum: ["online", "offline"] })
			.notNull()
			.default("offline"),
		lastSeenAt: text("last_seen_at"),
		// ── Device self-reported capabilities (from handshake) ──
		platformOs: text("platform_os"),
		platformArch: text("platform_arch"),
		shellPath: text("shell_path"),
		/** Default working directory on the device. */
		defaultCwd: text("default_cwd"),
		agentVersion: text("agent_version"),
		/** JSON: { git, ripgrep, pty, ... } capability flags reported at handshake. */
		capabilitiesJson: text("capabilities_json", { mode: "json" }).$type<Record<string, unknown>>(),
		/**
		 * Desired ordered path guard rules, as `[{ action, path }]`.
		 *
		 * A record of intent, NOT an enforcement point. The executor enforces the
		 * rules in its own config file on the target machine, precisely so that a
		 * compromised server cannot widen its own access. This column exists to let
		 * the UI show what the operator configured, diff it against what the device
		 * reports at handshake, and regenerate the config snippet.
		 */
		pathRulesJson: text("path_rules_json", { mode: "json" }).$type<
			Array<{ action: "allow" | "deny"; path: string }>
		>(),
		/** Ordered rules the device reported enforcing at its last handshake. */
		reportedPathRulesJson: text("reported_path_rules_json", { mode: "json" }).$type<
			Array<{ action: "allow" | "deny"; path: string }>
		>(),
		// ── Authorization scope ──
		//
		// Two independent axes. `scope`/`projectId` is the project axis and keeps its
		// original meaning. `ownerScope` is the user axis: "private" restricts the
		// device to its `createdBy` user (a personal dev box), "shared" leaves it
		// available to everyone the project axis allows (a project deploy target or a
		// communal build machine). Defaults to "shared" so existing rows behave
		// exactly as before.
		ownerScope: text("owner_scope", { enum: ["private", "shared"] })
			.notNull()
			.default("shared"),
		scope: text("scope", { enum: ["global", "project"] })
			.notNull()
			.default("global"),
		projectId: text("project_id").references(() => projects.id),
		// ── Audit / external ownership ──
		createdBy: text("created_by").notNull(),
		/** @deprecated Migration-only OAuth ownership shadow; use integration_resource_bindings. */
		oauthOwnerGrantId: text("oauth_owner_grant_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: forward reference to oauthGrants
			(): any => oauthGrants.id,
			{ onDelete: "set null" },
		),
		/** @deprecated Migration-only idempotency shadow; use binding.provisionKey. */
		oauthProvisionKey: text("oauth_provision_key"),
		// ── Automated enrollment provenance ──
		//
		// Set when a machine exchanged an enrollment ticket for this device's key via
		// the public bootstrap endpoint (the copy-paste install one-liner), instead of
		// an operator pasting the key by hand.
		//
		// Recorded because that exchange is the one moment the key crosses the wire in
		// plaintext: if a ticket leaks, these columns are the only evidence of who
		// actually redeemed it. Deliberately NOT used to authorize anything — the
		// enrollment IP is not a stable identity (NAT, roaming, IPv6 rotation), so
		// treating it as one would break legitimate re-enrollment far more often than
		// it would stop an attacker.
		enrolledAt: text("enrolled_at"),
		enrolledFromIp: text("enrolled_from_ip"),
		enrolledUserAgent: text("enrolled_user_agent"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		/** Soft-delete / revocation timestamp. Revoked devices reject connections. */
		revokedAt: text("revoked_at"),
	},
	(table) => [
		uniqueIndex("idx_remote_devices_slug").on(table.slug),
		index("idx_remote_devices_status").on(table.status),
		index("idx_remote_devices_project").on(table.projectId),
		index("idx_remote_devices_oauth_owner").on(table.oauthOwnerGrantId),
		uniqueIndex("idx_remote_devices_oauth_provision").on(
			table.oauthOwnerGrantId,
			table.oauthProvisionKey,
		),
	],
);

// === device_transfer_tasks ===
export const deviceTransferTasks = sqliteTable(
	"device_transfer_tasks",
	{
		id: text("id").primaryKey(),
		deviceId: text("device_id")
			.notNull()
			.references(() => remoteDevices.id, { onDelete: "cascade" }),
		direction: text("direction", { enum: ["download", "upload"] }).notNull(),
		remotePath: text("remote_path").notNull(),
		localPath: text("local_path").notNull(),
		recursive: integer("recursive", { mode: "boolean" }).notNull().default(false),
		runGeneration: integer("run_generation").notNull().default(0),
		status: text("status", {
			enum: ["queued", "running", "paused", "completed", "failed", "cancelled"],
		})
			.notNull()
			.default("queued"),
		filesTransferred: integer("files_transferred").notNull().default(0),
		bytesTransferred: integer("bytes_transferred").notNull().default(0),
		totalFiles: integer("total_files"),
		totalBytes: integer("total_bytes"),
		currentFile: text("current_file"),
		error: text("error"),
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		/**
		 * The narrator that started this transfer, when a narrator did.
		 *
		 * NULL for an admin transfer started from the devices page: that transfer
		 * belongs to no conversation, and it deliberately gets no `background_tasks`
		 * projection — a card in some narrator's drawer for work it never requested
		 * would be worse than no card.
		 *
		 * `set null` rather than `cascade`: deleting a narrator must not abort or erase
		 * a transfer that is moving real bytes to a device.
		 */
		parentNarratorId: text("parent_narrator_id").references(() => narrators.id, {
			onDelete: "set null",
		}),
		/** The TransferFile tool call that started it, for card ↔ task correlation. */
		toolUseId: text("tool_use_id"),
		/**
		 * The readable handle the TransferFile tool gave the model (`upload-app-apk`).
		 *
		 * Stored on the OWNING row, not only in the in-memory alias registry, because
		 * the registry does not survive a restart — and a transfer is the one background
		 * kind that does. Its projection row is created by the runner (after `claim`),
		 * which is a different process lifetime than the turn that minted the alias, so
		 * this column is how the handle reaches it. NULL for an admin transfer, which
		 * has no model to address it.
		 */
		alias: text("alias"),
		createdAt: text("created_at").notNull(),
		startedAt: text("started_at"),
		updatedAt: text("updated_at").notNull(),
		completedAt: text("completed_at"),
	},
	(table) => [
		index("idx_device_transfer_tasks_device_created").on(table.deviceId, table.createdAt),
		index("idx_device_transfer_tasks_status_updated").on(table.status, table.updatedAt),
		// FK covering index for user deletion.
		index("idx_device_transfer_tasks_created_by").on(table.createdBy),
		// FK covering index for narrator deletion (the `set null` above).
		index("idx_device_transfer_tasks_parent_narrator").on(table.parentNarratorId),
	],
);

// === spec_namespaces ===
export const specNamespaces = sqliteTable(
	"spec_namespaces",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		forkedFromNamespaceId: text("forked_from_namespace_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: self reference
			(): any => specNamespaces.id,
			{ onDelete: "set null" },
		),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_spec_namespaces_narrator").on(table.narratorId),
		index("idx_spec_namespaces_forked_from").on(table.forkedFromNamespaceId),
	],
);

// === spec_file_revisions ===
export const specFileRevisions = sqliteTable(
	"spec_file_revisions",
	{
		id: text("id").primaryKey(),
		namespaceId: text("namespace_id")
			.notNull()
			.references(() => specNamespaces.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		content: text("content").notNull(),
		contentHash: text("content_hash").notNull(),
		parentRevisionId: text("parent_revision_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: self reference
			(): any => specFileRevisions.id,
			{ onDelete: "set null" },
		),
		sourceToolUseId: text("source_tool_use_id"),
		sourceMessageId: text("source_message_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: forward reference to narratorMessages
			(): any => narratorMessages.id,
			{ onDelete: "set null" },
		),
		createdBy: text("created_by", { enum: ["system", "user", "assistant"] })
			.notNull()
			.default("assistant"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_spec_file_revisions_namespace_path").on(table.namespaceId, table.path),
		index("idx_spec_file_revisions_parent").on(table.parentRevisionId),
		// FK covering index for narrator_messages deletion (ON DELETE SET NULL).
		index("idx_spec_file_revisions_source_message").on(table.sourceMessageId),
	],
);

// === spec_namespace_files ===
export const specNamespaceFiles = sqliteTable(
	"spec_namespace_files",
	{
		id: text("id").primaryKey(),
		namespaceId: text("namespace_id")
			.notNull()
			.references(() => specNamespaces.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		revisionId: text("revision_id").references(() => specFileRevisions.id, {
			onDelete: "set null",
		}),
		deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_spec_namespace_files_namespace_path").on(table.namespaceId, table.path),
		index("idx_spec_namespace_files_revision").on(table.revisionId),
	],
);

// === spec_protected_tasks ===
export const specProtectedTasks = sqliteTable(
	"spec_protected_tasks",
	{
		id: text("id").primaryKey(),
		namespaceId: text("namespace_id")
			.notNull()
			.references(() => specNamespaces.id, { onDelete: "cascade" }),
		textHash: text("text_hash").notNull(),
		text: text("text").notNull(),
		status: text("status", { enum: ["todo", "doing", "done", "blocked", "deleted"] })
			.notNull()
			.default("todo"),
		firstRevisionId: text("first_revision_id").references(() => specFileRevisions.id, {
			onDelete: "set null",
		}),
		lastRevisionId: text("last_revision_id").references(() => specFileRevisions.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		completedAt: text("completed_at"),
		deletedAt: text("deleted_at"),
	},
	(table) => [
		uniqueIndex("idx_spec_protected_tasks_namespace_hash").on(table.namespaceId, table.textHash),
		index("idx_spec_protected_tasks_namespace_status").on(table.namespaceId, table.status),
		// FK covering indexes for spec-file-revision deletion.
		index("idx_spec_protected_tasks_first_revision").on(table.firstRevisionId),
		index("idx_spec_protected_tasks_last_revision").on(table.lastRevisionId),
	],
);

// === narrator_messages ===
export const narratorContextCharPages = sqliteTable(
	"narrator_context_char_pages",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		generation: text("generation").notNull(),
		page: integer("page").notNull(),
		segmentsJson: text("segments_json", { mode: "json" }).$type<ContextSegment[]>().notNull(),
	},
	(t) => [
		uniqueIndex("context_char_pages_generation_page_idx").on(t.narratorId, t.generation, t.page),
	],
);

export const narratorMessages = sqliteTable(
	"narrator_messages",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id),
		messageUuid: text("sdk_message_uuid"),
		parentToolUseId: text("parent_tool_use_id"),
		role: text("role", { enum: ["user", "assistant", "system", "sys", "disp"] }).notNull(),
		contentJson: text("content_json", { mode: "json" }).notNull(),
		contentText: text("content_text"),
		contextCharsJson: text("context_chars_json", { mode: "json" }).$type<ContextCharStats>(),
		tokensIn: integer("tokens_in"),
		costUsd: real("cost_usd"),
		/** Null marks an untouched historical record. */
		costStatus: text("cost_status", { enum: ["complete", "partial", "unknown"] }),
		costMissingFields: text("cost_missing_fields", { mode: "json" }).$type<string[]>(),
		turnUsageJson: text("turn_usage_json", { mode: "json" }),
		provider: text("provider"),
		credentialId: text("credential_id"),
		model: text("model"),
		outputTokens: integer("output_tokens"),
		cachedInputTokens: integer("cached_input_tokens"),
		cacheCreationInputTokens: integer("cache_creation_input_tokens"),
		cacheCreation5mTokens: integer("cache_creation_5m_tokens"),
		cacheCreation1hTokens: integer("cache_creation_1h_tokens"),
		reasoningTokens: integer("reasoning_tokens"),
		ttftMs: integer("ttft_ms"),
		durationMs: integer("duration_ms"),
		contextPercent: real("context_percent"),
		meterUsage: real("meter_usage"),
		meterUnit: text("meter_unit"),
		// 关联的 commit SHA（auto-commit 时标记在最近的 assistant 消息上）
		commitSha: text("commit_sha"),
		/**
		 * Worktree tree hash at this message boundary — the state to restore when
		 * rolling back to "just after this message". null means no snapshot exists
		 * for this boundary and callers fall back to the per-file replay path.
		 */
		treeHashAfter: text("tree_hash_after"),
		/**
		 * Snapshot commit for {@link treeHashAfter}, i.e. this boundary's position in
		 * the shadow DAG.
		 *
		 * Kept alongside the tree hash rather than replacing it: rolling back only
		 * needs the bytes, and every existing row has them. Forking from this message
		 * needs the ancestry, which only the commit carries — it is what lets the new
		 * chapter's later work still find a merge base with this one.
		 */
		snapshotCommitSha: text("snapshot_commit_sha"),
		// 斜杠命令原始文本（展示用），如 "/translate typescript some code"
		commandText: text("command_text"),
		// 触发此消息的人类用户 ID。与 origin 正交：系统代发的消息也可以带触发者
		// （如定时任务带任务创建者），用于"系统 · 代 alice"这类归属展示。
		createdBy: text("created_by").references(() => users.id),
		// 消息内容的实际作者类型，与 role 正交（role 决定协议/调度语义，origin 决定归属展示）：
		//   user      — 人类写的（含 IM 网关真人、OAuth 代发的授权用户）
		//   system    — NarraFork 自己生成（自动续跑、review 启动、rebase prompt 等）
		//   assistant — AI 发起（ForkNarrator、群聊注入）
		// null 视为 "user"，兼容本列引入前的老数据。
		origin: text("origin", { enum: ["user", "system", "assistant"] }),
		// 展示用来源标识，如 "Telegram @foo" / "OAuth: my-bot" / "定时任务: nightly"。
		// 纯展示元数据，不发送给 AI。
		originLabel: text("origin_label"),
		// 最近一次手动编辑此消息内容的时间戳（编辑后的文本会进入后续历史；本元数据不发送给 AI）
		editedAt: text("edited_at"),
		// 编辑此消息的用户 ID
		editedBy: text("edited_by").references(() => users.id),
		// 首次编辑时保存的原始 contentJson（再次编辑不覆盖），用于前端查看原文
		originalContentJson: text("original_content_json", { mode: "json" }),
		/**
		 * 1 表示本消息带一个仍在进行中的 history compact 标记（`type=compact` 且
		 * status 为 compacting/running，或最后一次 attempt 仍 running）。fork 不能
		 * 与子叙述者共享这样的行：父叙述者的 finalizer 随后会 COW 它，子叙述者会
		 * 留下一个永远无法完成的标记。
		 *
		 * 这是 contentJson 的**虚拟生成列**（不占存储，由 SQLite 现算），配合下面
		 * 的部分索引，让 fork 能在常数时间内枚举这些行。此前 fork 在前缀的每一行
		 * 上展开 `json_each(content_json)`：为了找出通常为 0 条的进行中标记，一次
		 * 3 万条消息的 fork 要读约 149 MB 消息正文。
		 *
		 * 用生成列而非普通列，是因为它由 SQLite 从 contentJson 推导，不可能与正文
		 * 漂移，也不需要在任何 compact 写入点维护。compact 标记块恒为 contentJson
		 * 数组的首元素（见 narrator-persistence 的 compact 生命周期），所以这里用
		 * `$[0]` 定位而不必展开整个数组。
		 */
		compactPending: integer("compact_pending").generatedAlwaysAs(
			sql`(CASE WHEN json_extract("content_json", '$[0].type') = 'compact' AND (json_extract("content_json", '$[0].status') IN ('compacting', 'running') OR json_extract("content_json", '$[0].attempts[#-1].status') = 'running') THEN 1 ELSE 0 END)`,
			{ mode: "virtual" },
		),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_messages_narrator").on(table.narratorId, table.createdAt),
		index("idx_messages_parent_tool_use_lookup").on(table.parentToolUseId, table.createdAt),
		index("idx_messages_parent_tool_use").on(table.narratorId, table.parentToolUseId),
		index("idx_messages_toplevel").on(table.narratorId, table.parentToolUseId, table.createdAt),
		// FK covering indexes for the users parent: deleting a user would otherwise scan
		// this (largest) table once per removed row.
		index("idx_messages_created_by").on(table.createdBy),
		index("idx_messages_edited_by").on(table.editedBy),
		// Partial index: only the pending-compact rows are indexed, which in practice
		// means a handful of rows (usually zero). This is what lets fork enumerate the
		// unstable messages without touching message bodies.
		index("idx_messages_compact_pending")
			.on(table.compactPending)
			.where(sql`"compact_pending" = 1`),
	],
);

// === narrator_message_refs (junction table) ===
export const narratorMessageRefs = sqliteTable(
	"narrator_message_refs",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id),
		messageId: text("message_id")
			.notNull()
			.references(() => narratorMessages.id),
		seq: integer("seq").notNull(),
		isCompact: integer("is_compact").notNull().default(0),
		/** Points to the segment-compact summary message that hides this ref. */
		segmentCompactId: text("segment_compact_id"),
		/** Set only when the recipient loop adopts this injection into model input. */
		injectionConsumedAt: integer("injection_consumed_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("idx_narrator_refs_unique").on(table.narratorId, table.messageId),
		index("idx_narrator_refs_seq").on(table.narratorId, table.seq),
		index("idx_narrator_refs_compact_seq").on(table.narratorId, table.isCompact, table.seq),
		index("idx_narrator_refs_message").on(table.messageId),
		index("idx_narrator_refs_segment_compact").on(table.segmentCompactId),
		// Keyset paging of one narrator's refs by primary key (project archive export/import).
		// Without it `WHERE narrator_id IN (…) AND id > ? ORDER BY id LIMIT n` re-sorts the
		// narrator's entire ref set in a temp B-tree for every page.
		index("idx_narrator_refs_narrator_id").on(table.narratorId, table.id),
	],
);

// === narrator_tool_calls ===
export const narratorToolCalls = sqliteTable(
	"narrator_tool_calls",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id),
		messageId: text("message_id")
			.notNull()
			.references(() => narratorMessages.id),
		toolUseId: text("tool_use_id").notNull(),
		toolName: text("tool_name").notNull(),
		inputJson: text("input_json", { mode: "json" }),
		outputJson: text("output_json", { mode: "json" }),
		inputChars: integer("input_chars").notNull().default(0),
		outputChars: integer("output_chars").notNull().default(0),
		/**
		 * Actual execution target frozen before permission/execution.
		 * "local" means the NarraFork server; a remote value is remote_devices.id.
		 * null is reserved for legacy rows whose target cannot be reconstructed safely.
		 */
		executionDeviceId: text("execution_device_id"),
		/** Working directory on the selected execution target at call time. */
		executionCwd: text("execution_cwd"),
		/** Target path grammar frozen with cwd/path resolution. */
		executionPathFlavor: text("execution_path_flavor", {
			enum: ["posix", "windows", "spec"],
		}),
		/** Lexical compatibility projection for legacy callers and portable backups. */
		resolvedFilePath: text("resolved_file_path"),
		/** Canonical filesystem identity, including canonical create paths for missing files. */
		canonicalFilePath: text("canonical_file_path"),
		/** Backend runtime generation that produced the canonical identity. */
		runtimeGeneration: integer("runtime_generation"),
		/** Complete execution plan; legacy arrays remain readable during the compatibility window. */
		executionTargetsJson: text("execution_targets_json", { mode: "json" }).$type<
			ToolExecutionPlan | ToolExecutionTarget[]
		>(),
		/** How the target was selected, retained for audit and historical UI. */
		deviceSelectionSource: text("device_selection_source", {
			enum: ["explicit", "session_default", "local_default"],
		}),
		status: text("status", {
			enum: ["initializing", "pending", "running", "success", "fail"],
		})
			.notNull()
			.default("initializing"),
		durationMs: integer("duration_ms"),
		streamStartedAt: text("stream_started_at"),
		/** Wall-clock moment when the provider finished streaming this tool's input. */
		streamCompletedAt: text("stream_completed_at"),
		permissionStartedAt: text("permission_started_at"),
		executionStartedAt: text("execution_started_at"),
		completedAt: text("completed_at"),
		/**
		 * Wall-clock moment this call actually began, as ONE indexable value.
		 *
		 * The four timestamps above are written by different lifecycle stages, so no
		 * single one of them can order a global execution log: on a production database
		 * only ~38% of recent rows carry `execution_started_at`, and every row older than
		 * migration 0034 has all four NULL. This mirrors the fallback chain
		 * `subagent-activity.selectActivityTimestamp` already uses for display.
		 *
		 * VIRTUAL rather than STORED for two reasons: SQLite outright refuses
		 * `ALTER TABLE ... ADD` of a stored column, and a virtual one needs no table
		 * rewrite over the existing rows (measured: 561k rows, 6.6 GB database).
		 * Generated columns are omitted from every INSERT/UPDATE Drizzle builds, so no
		 * write path changes; `idx_toolcalls_started_at` is what makes it cheap to read.
		 */
		startedAt: text("started_at").generatedAlwaysAs(
			sql`coalesce("execution_started_at", "permission_started_at", "stream_started_at", "created_at")`,
			{ mode: "virtual" },
		),
		errorMessage: text("error_message"),
		permissionDecidedBy: text("permission_decided_by"),
		permissionDecidedAt: text("permission_decided_at"),
		permissionDenyMessage: text("permission_deny_message"),
		permissionDecisionReason: text("permission_decision_reason"),
		permissionSuggestions: text("permission_suggestions", { mode: "json" }),
		isBackground: integer("is_background", { mode: "boolean" }).notNull().default(false),
		/** Zero is legacy/unverified, not permission to claim a migrated row as a fresh call. */
		executionIdentityVersion: integer("execution_identity_version").notNull().default(0),
		/** A COW history clone retains its origin but is never an executable attempt. */
		executionOriginToolCallId: text("execution_origin_tool_call_id"),
		/** Zero means no durable execution attempt was allocated (including legacy rows). */
		executionAttempt: integer("execution_attempt").notNull().default(0),
		/** Actual operation reference; COW copies it without creating new evidence. */
		executionSegmentId: text("execution_segment_id"),
		fileChangeOperationId: text("file_change_operation_id").references(
			(): AnySQLiteColumn => fileChangeOperations.id,
			{ onDelete: "set null" },
		),
		/** True when this tool call is a hidden file-history checkpoint clone. */
		isFileHistoryCheckpoint: integer("is_file_history_checkpoint", { mode: "boolean" })
			.notNull()
			.default(false),
		/**
		 * Worktree tree hash captured immediately before this tool ran, and again
		 * after it completed. Reverting to `treeHashBefore` restores the exact
		 * workspace bytes without replaying recorded edits. null means no snapshot
		 * was taken (non-git workspace, remote device, or a pre-feature row), in
		 * which case callers fall back to the per-file replay path.
		 */
		treeHashBefore: text("tree_hash_before"),
		treeHashAfter: text("tree_hash_after"),
		/**
		 * Worktree-relative paths this call was proven to have changed itself.
		 *
		 * The tree hashes above cover the whole workspace, and a worktree is shared:
		 * between `before` and `after` other narrators, terminals and build scripts
		 * write to it too. A rollback must only touch what this call did, so the
		 * boundary pair alone is not enough — the owned set records which paths
		 * inside that window are attributable to this call.
		 *
		 * null means the row predates this mechanism (rollback derives the set from
		 * recorded inputs and attributions instead). An empty array is a positive
		 * result: this call changed nothing on disk, even when the boundary hashes
		 * differ because a neighbour wrote during the window.
		 */
		ownedPathsJson: text("owned_paths_json", { mode: "json" }).$type<string[]>(),
		// Token usage fields
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
		cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
		cacheCreation5mTokens: integer("cache_creation_5m_tokens").notNull().default(0),
		cacheCreation1hTokens: integer("cache_creation_1h_tokens").notNull().default(0),
		// Cost fields (in USD)
		inputCost: real("input_cost").notNull().default(0),
		outputCost: real("output_cost").notNull().default(0),
		cacheCreationCost: real("cache_creation_cost").notNull().default(0),
		cacheReadCost: real("cache_read_cost").notNull().default(0),
		totalCost: real("total_cost").notNull().default(0),
		costStatus: text("cost_status", { enum: ["complete", "partial", "unknown"] }),
		costMissingFields: text("cost_missing_fields", { mode: "json" }).$type<string[]>(),
		// Provider and model info
		provider: text("provider"), // anthropic, openai, codex, nug, gemini
		model: text("model"), // claude-3-5-sonnet-20241022, gpt-4o, etc.
		// Subagent result binding: points to the subagent's assistant message that produced the result
		resultMessageId: text("result_message_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_toolcalls_message").on(table.messageId),
		index("idx_toolcalls_tool_use_id").on(table.toolUseId),
		index("idx_toolcalls_execution_device").on(table.executionDeviceId, table.createdAt),
		index("idx_toolcalls_status").on(table.narratorId, table.status),
		index("idx_toolcalls_status_narrator_created").on(
			table.status,
			table.narratorId,
			table.createdAt,
		),
		index("idx_toolcalls_created").on(table.narratorId, table.createdAt),
		index("idx_toolcalls_attempt").on(
			table.narratorId,
			table.toolUseId,
			table.messageId,
			table.executionAttempt,
		),
		index("idx_toolcalls_file_change_operation").on(table.fileChangeOperationId),
		/**
		 * Global execution-log ordering. `(startedAt, id)` so the admin page can seek a
		 * keyset cursor with a row-value comparison — measured 0.07ms per page against
		 * 3.8s for an unindexed `ORDER BY ... LIMIT 51` on the same data.
		 */
		index("idx_toolcalls_started_at").on(table.startedAt, table.id),
	],
);

// === narrator_questions ===
/**
 * Asynchronous AskUserQuestion records — questions the agent asked WITHOUT stopping.
 *
 * ## Why a table and not `narrator_tool_calls`
 *
 * A synchronous AskUserQuestion never needs storage: the whole interaction lives
 * inside one suspended promise in `pendingPermissions`, and the answer arrives before
 * the tool has even executed. An asynchronous one inverts that — the tool call is
 * already `success` and long gone by the time the user answers, so "this question is
 * still open" has to survive independently. `narrator_tool_calls.status` cannot carry
 * it: that enum belongs to the agent-loop lifecycle, where `success` means the call
 * finished, which is exactly what happened.
 *
 * Being a row rather than in-memory state is also what makes the async path restart-safe
 * for free: nothing about answering reads process memory, so no
 * `narrator_tool_continuations` entry and no recovery path is needed.
 *
 * ## Grain
 *
 * One row per tool CALL, not per question — a single call carries 1-4 questions and
 * `questions_json` holds them all, mirroring the tool's own input shape (and the
 * `answers` map keyed by each question's `question` key). The unique index on
 * `tool_call_id` is what makes creation idempotent: a retried or replayed tool
 * execution cannot produce a second row for the same call.
 */
export const narratorQuestions = sqliteTable(
	"narrator_questions",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		/** Idempotency anchor — see the unique index below. */
		toolCallId: text("tool_call_id")
			.notNull()
			.references(() => narratorToolCalls.id, { onDelete: "cascade" }),
		toolUseId: text("tool_use_id").notNull(),
		/** Question definitions, same shape as AskUserQuestion's `questions` input. */
		questionsJson: text("questions_json", { mode: "json" }).notNull(),
		/** Trusted execution principal at creation; NULL means unknown legacy provenance. */
		executionPrincipalJson: text("execution_principal_json", { mode: "json" }).$type<{
			version: 1;
			userId: string | null;
		}>(),
		/** null while unanswered. Same shape as the synchronous path's `answers`. */
		answersJson: text("answers_json", { mode: "json" }),
		annotationsJson: text("annotations_json", { mode: "json" }),
		status: text("status", {
			enum: ["open", "answered", "dismissed", "withdrawn"],
		})
			.notNull()
			.default("open"),
		/**
		 * `agent_async` — the agent chose to ask without blocking.
		 * `user_deferred` — the user turned a blocking prompt into a deferred one.
		 */
		origin: text("origin", { enum: ["agent_async", "user_deferred"] })
			.notNull()
			.default("agent_async"),
		/** The injected message row carrying the answer back, for provenance. */
		answerMessageId: text("answer_message_id"),
		decidedBy: text("decided_by"),
		decidedAt: text("decided_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_narrator_questions_tool_call").on(table.toolCallId),
		index("idx_narrator_questions_narrator_status").on(table.narratorId, table.status),
	],
);

// === narrator_tool_continuations ===
export const narratorToolContinuations = sqliteTable(
	"narrator_tool_continuations",
	{
		id: text("id").primaryKey(),
		toolCallId: text("tool_call_id")
			.notNull()
			.references(() => narratorToolCalls.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		updateEpoch: text("update_epoch").notNull(),
		kind: text("kind", {
			enum: [
				"deferred_tool",
				"pending_permission",
				"foreground_agent",
				"background_agent",
				"await_agent",
				"send_await",
			],
		}).notNull(),
		state: text("state", {
			enum: ["paused", "waiting", "resuming", "completed", "failed", "cancelled"],
		})
			.notNull()
			.default("paused"),
		payloadJson: text("payload_json", { mode: "json" }).$type<Record<string, unknown>>(),
		deadlineAt: text("deadline_at"),
		claimToken: text("claim_token"),
		claimedAt: text("claimed_at"),
		errorMessage: text("error_message"),
		completedAt: text("completed_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_tool_continuations_tool_call").on(table.toolCallId),
		index("idx_tool_continuations_epoch_state").on(table.updateEpoch, table.state),
		index("idx_tool_continuations_narrator_state").on(table.narratorId, table.state),
	],
);

// === terminals ===
export const terminals = sqliteTable(
	"terminals",
	{
		id: text("id").primaryKey(),
		/**
		 * Cascaded rather than left to explicit clean-up, because the default
		 * (`NO ACTION`) actively *blocked* deleting a chapter: SQLite refuses the parent
		 * row while any terminal still references it, so one missed clean-up step turned
		 * into "FOREIGN KEY constraint failed" and the entire delete failed. A terminal is
		 * a derived resource with no meaning once its chapter is gone, so cascading is
		 * both correct and the safer default. `chapter-service` still deletes these rows
		 * explicitly — that is now defence in depth rather than the only line.
		 */
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id").references(() => narrators.id),
		worktreeResourceId: text("worktree_resource_id").references(
			() => narratorWorktreeResources.id,
			{ onDelete: "restrict" },
		),
		name: text("name").notNull(),
		cwd: text("cwd"),
		dtachSocket: text("dtach_socket"),
		/** Remote executor device this terminal runs on. null → local server. */
		deviceId: text("device_id"),
		status: text("status", { enum: ["running", "exited"] })
			.notNull()
			.default("running"),
		exitCode: integer("exit_code"),
		/**
		 * 已停用（不再读写）：这五列服务于"把某个终端作为画布上的专用节点显示"，
		 * 该节点类型已删除 —— 章节的终端现在都在其 dock 的终端面板里（自带多标签）。
		 *
		 * 保留而不删列：删列需要迁移，而它们不影响任何查询正确性，留着只是几个无人读取的
		 * 字段；一旦删错则数据不可恢复。后续可单独做一次纯清理迁移，届时连带
		 * `idx_terminals_chapter` 里的 `graphOpened` 一起处理。
		 */
		graphOpened: integer("graph_opened").notNull().default(0),
		graphX: real("graph_x"),
		graphY: real("graph_y"),
		graphWidth: real("graph_width"),
		graphHeight: real("graph_height"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_terminals_chapter").on(table.chapterId, table.status, table.graphOpened),
		index("idx_terminals_narrator").on(table.narratorId),
		index("idx_terminals_status").on(table.status),
		index("idx_terminals_resource_status").on(table.worktreeResourceId, table.status, table.id),
		check(
			"ck_terminals_resource_owner",
			sql`${table.worktreeResourceId} is null or (${table.chapterId} is null and ${table.narratorId} is null)`,
		),
	],
);

// === terminal_tabs: removed ===
//
// A `terminal_tabs` table used to sit here, with a service, five `/terminals/tabs` routes,
// three validators, five API clients, a hook and a component. None of it had a consumer:
// every client had zero call sites and the hook/component had zero importers, so no row was
// ever written. The live terminal UI (`NarratorTerminal.tsx`) derives tabs from the running
// terminals and persists only their order, which is why a separate tab entity was never
// needed. Do not confuse it with `terminal_view_state` below, which is in active use — its
// `activeTabId` holds a *terminal* id, not a tab id, and never referenced this table.

// === terminal_view_state ===
export const terminalViewState = sqliteTable(
	"terminal_view_state",
	{
		id: text("id").primaryKey(),
		// All three parents cascade. View state is pure per-user UI bookkeeping (which tabs were
		// open in which panel), so it has no meaning once its owner is gone and must never be the
		// reason a parent cannot be deleted. Without the cascade, `DELETE FROM users` fails
		// outright with FOREIGN KEY constraint failed for anyone who ever opened a terminal tab —
		// admin user deletion (routes/admin.ts) deletes the row directly and has no companion
		// cleanup. Migration 0091 established these cascades; 0092 silently reverted them to
		// "no action" by rebuilding the table from a schema that had dropped the onDelete.
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "cascade" }),
		worktreeResourceId: text("worktree_resource_id").references(
			() => narratorWorktreeResources.id,
			{ onDelete: "restrict" },
		),
		layout: text("layout", {
			enum: ["single", "split-h", "split-v", "triple", "quad"],
		})
			.notNull()
			.default("single"),
		activeTabId: text("active_tab_id"),
		panelAssignments: text("panel_assignments", { mode: "json" }),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_view_state_user_chapter").on(table.userId, table.chapterId),
		uniqueIndex("idx_view_state_user_narrator").on(table.userId, table.narratorId),
		// The unique indexes above lead with userId, so they cannot serve lookups keyed only
		// on chapterId/narratorId. Those columns are used both by FK enforcement when a
		// chapter/narrator row is deleted and by the bulk cleanup deletes in
		// chapter-service / narrator-service / projects routes, which would otherwise scan.
		index("idx_view_state_chapter").on(table.chapterId),
		index("idx_view_state_narrator").on(table.narratorId),
		uniqueIndex("idx_view_state_user_resource").on(table.userId, table.worktreeResourceId),
		index("idx_view_state_resource").on(table.worktreeResourceId),
		check(
			"ck_view_state_resource_owner",
			sql`${table.worktreeResourceId} is null or (${table.chapterId} is null and ${table.narratorId} is null)`,
		),
	],
);

// === container_instances ===
export const containerInstances = sqliteTable(
	"container_instances",
	{
		id: text("id").primaryKey(),
		/** Legacy chapters still cascade; new resource-domain containers are independent. */
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
		worktreeResourceId: text("worktree_resource_id").references(
			() => narratorWorktreeResources.id,
			{ onDelete: "restrict" },
		),
		containerId: text("container_id"),
		serviceName: text("service_name").notNull(),
		status: text("status", {
			enum: ["created", "running", "paused", "stopped", "removed"],
		})
			.notNull()
			.default("created"),
		hostPort: integer("host_port"),
		containerPort: integer("container_port"),
		proxyLabel: text("proxy_label"),
		containerIp: text("container_ip"),
		volumeName: text("volume_name"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_container_instances_chapter").on(table.chapterId),
		index("idx_container_instances_chapter_service").on(table.chapterId, table.serviceName),
		index("idx_container_instances_container").on(table.containerId),
		index("idx_container_instances_status").on(table.chapterId, table.status),
		index("idx_container_instances_resource_service_status").on(
			table.worktreeResourceId,
			table.serviceName,
			table.status,
		),
		check(
			"ck_container_instances_owner",
			sql`(${table.chapterId} is null) <> (${table.worktreeResourceId} is null)`,
		),
	],
);

// === port_allocations ===
export const portAllocations = sqliteTable(
	"port_allocations",
	{
		port: integer("port").primaryKey(),
		/**
		 * Cascaded for the same reason as `terminals.chapterId`, and this table was the
		 * most likely one to block a delete: a port stays allocated in proxy mode even
		 * after the container is removed, so `removeChapterContainers` could return
		 * successfully while leaving a row that then refused the chapter's deletion.
		 */
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
		worktreeResourceId: text("worktree_resource_id").references(
			() => narratorWorktreeResources.id,
			{ onDelete: "restrict" },
		),
		serviceName: text("service_name"),
		allocatedAt: text("allocated_at").notNull(),
	},
	// FK covering index for chapter deletion.
	(table) => [
		index("idx_port_allocations_chapter").on(table.chapterId),
		index("idx_port_allocations_resource").on(table.worktreeResourceId),
		check(
			"ck_port_allocations_owner",
			sql`${table.chapterId} is null or ${table.worktreeResourceId} is null`,
		),
	],
);

// === user_preferences ===
export const userPreferences = sqliteTable("user_preferences", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull().unique(),
	autoLoadOlderMessages: integer("auto_load_older_messages", { mode: "boolean" })
		.notNull()
		.default(true),
	fastModeDefault: integer("fast_mode_default", { mode: "boolean" }).notNull().default(false),
	/** Explicit user override for server-desktop file manager menus. */
	treatAsLocalAccess: integer("treat_as_local_access", { mode: "boolean" })
		.notNull()
		.default(false),
	language: text("language").$type<Locale>().notNull().default(DEFAULT_LOCALE),
	wordWrapMarkdown: integer("word_wrap_markdown", { mode: "boolean" }).notNull().default(true),
	wordWrapCode: integer("word_wrap_code", { mode: "boolean" }).notNull().default(true),
	wordWrapDiff: integer("word_wrap_diff", { mode: "boolean" }).notNull().default(true),
	replyInUserLanguage: integer("reply_in_user_language", { mode: "boolean" })
		.notNull()
		.default(true),
	showTokenUsage: integer("show_token_usage", { mode: "boolean" }).notNull().default(false),
	showOutputStats: integer("show_output_stats", { mode: "boolean" }).notNull().default(true),
	terminalTheme: text("terminal_theme").notNull().default("auto"),
	terminalFontSize: integer("terminal_font_size").notNull().default(14),
	/**
	 * Narrator transcript typography, as PERCENTAGES of the built-in defaults.
	 *
	 * Percentages rather than px because these are measurement inputs consumed by the
	 * exact height model (`shared/pretext-layout/typography.ts`), which scales a whole
	 * family of roles (body, xs, headings, code) from one factor. Storing an absolute
	 * size would fix only one role and leave the rest to drift.
	 *
	 * Defaults are the neutral setting: 100 / 0 / 100 measures byte-identically to a
	 * build without this feature, so existing rows and fresh installs are unaffected.
	 * Ranges are enforced in `TYPOGRAPHY_RANGE` and clamped on read as well as write —
	 * a value outside them makes scaled text collide with unscalable card chrome.
	 */
	narratorFontScalePercent: integer("narrator_font_scale_percent").notNull().default(100),
	/** Letter spacing as a percentage OF the font size (an em fraction ×100). */
	narratorLetterSpacingPercent: integer("narrator_letter_spacing_percent").notNull().default(0),
	/** Intra-paragraph line-height (leading) multiplier; distinct from block spacing. */
	narratorLineHeightScalePercent: integer("narrator_line_height_scale_percent")
		.notNull()
		.default(100),
	/** Block spacing (markdown block margins + transcript item gaps) multiplier. */
	narratorParagraphScalePercent: integer("narrator_paragraph_scale_percent").notNull().default(100),
	recentTabs: text("recent_tabs").notNull().default("[]"),
	addSubagentToRecentTabs: integer("add_subagent_to_recent_tabs", { mode: "boolean" })
		.notNull()
		.default(true),
	// How the sidebar renders the recent-tab work section. "flat" is the historical
	// behaviour (one row per tab, manually sortable); "directory" merges narrators
	// that share a working directory into collapsible groups so the path is shown once.
	recentTabsGroupMode: text("recent_tabs_group_mode", { enum: ["flat", "directory"] })
		.notNull()
		.default("flat"),
	// Notification preferences
	notifyOnDone: integer("notify_on_done", { mode: "boolean" }).notNull().default(true),
	notifyOnWaiting: integer("notify_on_waiting", { mode: "boolean" }).notNull().default(true),
	notifyPwaEnabled: integer("notify_pwa_enabled", { mode: "boolean" }).notNull().default(false),
	notifySoundEnabled: integer("notify_sound_enabled", { mode: "boolean" }).notNull().default(true),
	notifySoundType: text("notify_sound_type", { enum: ["builtin", "custom"] })
		.notNull()
		.default("builtin"),
	notifySoundBuiltin: text("notify_sound_builtin").notNull().default("gentle"),
	notifySoundFileId: text("notify_sound_file_id"),
	// Master playback volume as a percentage (0-100). 100 keeps the historical
	// per-source base gain (built-in 0.3, custom file 0.5).
	notifySoundVolume: integer("notify_sound_volume").notNull().default(100),
	// Upper bound on sounds playing at the same time. Extra notifications that
	// arrive while the limit is reached are dropped instead of stacking up.
	notifySoundMaxConcurrent: integer("notify_sound_max_concurrent").notNull().default(2),
	notifyDingtalkEnabled: integer("notify_dingtalk_enabled", { mode: "boolean" })
		.notNull()
		.default(false),
	notifyDingtalkWebhook: text("notify_dingtalk_webhook").notNull().default(""),
	notifyDingtalkSecret: text("notify_dingtalk_secret").notNull().default(""),
	notifyFeishuEnabled: integer("notify_feishu_enabled", { mode: "boolean" })
		.notNull()
		.default(false),
	notifyFeishuWebhook: text("notify_feishu_webhook").notNull().default(""),
	notifyFeishuSecret: text("notify_feishu_secret").notNull().default(""),
	// Slash commands (JSON array of {name, prompt, description?})
	commands: text("commands").notNull().default("[]"),
	// Graph viewport positions per project (JSON: { [projectId]: { x, y, zoom } })
	graphViewports: text("graph_viewports").notNull().default("{}"),
	// Queue behavior bound to the Enter key (and the send button click).
	// "turn" = wait for the current turn to finish (normal queue),
	// "tool" = cut in after the current tool call completes (priority soft-stop),
	// "interrupt" = interrupt immediately and insert (priority + interrupt).
	// NOTE: the DB column is still named `queue_mode` (repurposed from the old
	// default-queue-behavior preference) to avoid a rename migration.
	enterQueueMode: text("queue_mode", { enum: ["turn", "tool", "interrupt"] })
		.notNull()
		.default("turn"),
	// Queue behavior bound to the Ctrl/Cmd+Enter key (same three modes as above).
	ctrlEnterQueueMode: text("ctrl_enter_queue_mode", { enum: ["turn", "tool", "interrupt"] })
		.notNull()
		.default("tool"),
	// Setup wizard
	setupWizardCompleted: integer("setup_wizard_completed", { mode: "boolean" })
		.notNull()
		.default(false),
	// Gateway configuration (JSON: per-user IM gateway settings)
	gatewayConfig: text("gateway_config").notNull().default("{}"),
	// Sidebar navigation layout (JSON: { items: [{ id, hidden }] } — order = display order,
	// hidden:true items live in the "More" overflow menu)
	navLayout: text("nav_layout").notNull().default("{}"),
	// Narrator header toolbar layout (JSON: { items: [{ id }] } — a flat ordered list where
	// "__divider__" marks the boundary: ids before it may be surfaced in the header, ids after
	// it always live in the overflow menu). Order is the user's priority and is shared across
	// desktop and mobile; how many actually fit is decided per host at render time.
	narratorToolbarLayout: text("narrator_toolbar_layout").notNull().default("{}"),
	/**
	 * User layer of the layered trait system — the lowest-priority layer, applied
	 * to every narrator the user acts on. Same encoding as `narrators.traits`.
	 * Resolved per acting user at request time, mirroring how `fastModeDefault`
	 * feeds `narrators.fastModeOverride: "inherit"`, so narrators need no owner
	 * column for this to work.
	 */
	traits: text("traits", { mode: "json" }).$type<string[]>().notNull().default([]),
	/**
	 * Interactive tutorial progress, keyed by lesson id:
	 * `{ "<lessonId>": { completedStepIds: string[], completedAt?: string } }`
	 *
	 * Per user rather than global because the tutorial is a personal learning
	 * record, and stored as one JSON blob rather than a table because it is only
	 * ever read and written whole, for one user, on a page nobody hot-loops.
	 *
	 * Unknown lesson ids are tolerated on read: lessons are code, not data, so a
	 * renamed or retired lesson would otherwise make a stored row invalid. Progress
	 * for a lesson that no longer exists is simply not shown.
	 */
	tutorialProgress: text("tutorial_progress").notNull().default("{}"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// === user_plugin_themes ===
// Per-user enablement of theme-only plugin contributions. The plugin package is
// installed globally (shared), but which themes a user has enabled — and thus
// which compiled CSS is delivered to that user — is isolated per user. A row
// exists only for a user who has explicitly enabled a given (pluginId, themeId).
export const userPluginThemes = sqliteTable(
	"user_plugin_themes",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		pluginId: text("plugin_id").notNull(),
		themeId: text("theme_id").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_user_plugin_themes_unique").on(table.userId, table.pluginId, table.themeId),
		index("idx_user_plugin_themes_user").on(table.userId),
	],
);

// === users ===
export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	username: text("username").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	role: text("role", { enum: ["admin", "user"] })
		.notNull()
		.default("user"),
	/**
	 * Generation counter for this user's session tokens. Every issued JWT carries the value that
	 * was current at signing time; verification rejects a token whose value is behind.
	 *
	 * This is the only mechanism that can end a session before its `exp`. Session JWTs are
	 * self-contained, so without it a password change could not evict an already-stolen token and
	 * "sign out everywhere" was impossible — the credential simply stayed valid for up to its full
	 * lifetime. Bumping this column invalidates every outstanding token for the user at once,
	 * across every device, on their next request.
	 */
	tokenVersion: integer("token_version").notNull().default(0),
	avatarColor: text("avatar_color"),
	avatarImageId: text("avatar_image_id"),
	gitUsername: text("git_username"),
	gitEmail: text("git_email"),
	/**
	 * Whether a second factor is REQUIRED at password login. Independent of
	 * whether the user has any factor enrolled: registering a passkey or TOTP
	 * does NOT flip this on — the user (or an explicit setup toggle) must opt in.
	 * When off, an enrolled passkey still works as a passwordless login method
	 * and TOTP simply stays dormant.
	 */
	mfaEnabled: integer("mfa_enabled", { mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at").notNull(),
});

// === user_recent_tabs ===
// Authoritative, bounded recent-tab storage. user_preferences.recent_tabs is retained only as a
// legacy shadow containing the first RECENT_TABS_LEGACY_LIMIT entries.
export const userRecentTabs = sqliteTable(
	"user_recent_tabs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tabKey: text("tab_key").notNull(),
		section: text("section", { enum: ["projects", "work"] }).notNull(),
		type: text("type", {
			enum: ["chapter", "narrator", "project", "workspace", "subagent", "group"],
		}).notNull(),
		entityId: text("entity_id").notNull(),
		narratorId: text("narrator_id"),
		representedNarratorId: text("represented_narrator_id"),
		parentNarratorId: text("parent_narrator_id"),
		workspaceId: text("workspace_id"),
		title: text("title").notNull(),
		subtitle: text("subtitle"),
		status: text("status"),
		lastVisitedAt: integer("last_visited_at").notNull(),
		pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
		isScheduled: integer("is_scheduled", { mode: "boolean" }).notNull().default(false),
		sortOrder: integer("sort_order").notNull(),
		/**
		 * The member position the user arranged by hand inside a directory group
		 * (sidebar directory-aggregation mode).
		 *
		 * MUST stay separate from `sort_order`. That column carries recency and is
		 * rewritten by the `above_idle` auto-promote every time a narrator starts
		 * working, so a hand-ordered position stored there is wiped by the next status
		 * change — that was the actual reason drag-to-reorder never stuck in this mode.
		 *
		 * NULL means "never hand-ordered" and sorts BEFORE the ordered members, in
		 * recency order. A newly visited narrator is the newest thing in the group, so
		 * burying it under older hand-placed rows would contradict the recency promise
		 * the rest of the list makes.
		 *
		 * Cleared when the tab's cwd changes, otherwise a stale index from the previous
		 * directory would interleave with the new group's members.
		 */
		dirSortOrder: integer("dir_sort_order"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_user_recent_tabs_user_key").on(table.userId, table.tabKey),
		index("idx_user_recent_tabs_user_section_order").on(
			table.userId,
			table.section,
			table.sortOrder,
			table.tabKey,
		),
		index("idx_user_recent_tabs_user_workspace").on(
			table.userId,
			table.workspaceId,
			table.sortOrder,
		),
		index("idx_user_recent_tabs_narrator").on(table.representedNarratorId, table.userId),
		index("idx_user_recent_tabs_entity").on(table.type, table.entityId, table.userId),
	],
);

// === user_recent_tabs_meta ===
// One row per migrated user. revision advances only when the authoritative tab state changes.
export const userRecentTabsMeta = sqliteTable("user_recent_tabs_meta", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	revision: integer("revision").notNull().default(0),
	migratedAt: text("migrated_at").notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// === registration_codes ===
// Single-use invitations an administrator hands out so someone can self-register
// while public registration stays closed.
//
// Only the SHA-256 hash of a code is stored: the plaintext exists once, in the
// creation response. That means a database read (backup, support dump) cannot be
// turned into a usable invitation, and lookup stays an indexed hash probe rather
// than a scan-and-compare.
//
// Rows are kept after redemption instead of being deleted so an administrator can
// answer "who used which invitation, and who issued it". `used_by_user_id` /
// `created_by_user_id` are SET NULL rather than CASCADE for the same reason: the
// audit line must survive the account being removed.
export const registrationCodes = sqliteTable(
	"registration_codes",
	{
		id: text("id").primaryKey(),
		codeHash: text("code_hash").notNull(),
		/** Free-form administrator label, e.g. the name of the intended recipient. */
		note: text("note"),
		/** Role granted to the account created with this code. */
		role: text("role", { enum: ["admin", "user"] })
			.notNull()
			.default("user"),
		/** When set, the code only works for this exact username. */
		boundUsername: text("bound_username"),
		/** Mandatory expiry: an invitation that never dies is a standing signup hole. */
		expiresAt: text("expires_at").notNull(),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		usedAt: text("used_at"),
		usedByUserId: text("used_by_user_id").references(() => users.id, { onDelete: "set null" }),
		revokedAt: text("revoked_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_registration_codes_code_hash").on(table.codeHash),
		index("idx_registration_codes_created_by").on(table.createdByUserId),
		index("idx_registration_codes_used_by").on(table.usedByUserId),
	],
);

// === narrator_public_shares ===
// Bearer capabilities for one session's public transcript and discussion, never login tokens.
export const narratorPublicShares = sqliteTable(
	"narrator_public_shares",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		guestName: text("guest_name").notNull(),
		label: text("label"),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		uniqueIndex("idx_narrator_public_shares_token_hash").on(table.tokenHash),
		index("idx_narrator_public_shares_narrator_created").on(
			table.narratorId,
			table.createdAt,
			table.id,
		),
		index("idx_narrator_public_shares_created_by").on(table.createdByUserId),
	],
);

// === chat_rooms ===
// Human-to-human conversation, deliberately disjoint from `narrator_messages`:
// nothing written here ever reaches a model's context unless a person explicitly
// forwards it (see `submitToNarrator` on the client).
//
// Two kinds, and they differ in what membership MEANS:
//   - `dm`       — a closed 1:1 conversation. `chat_room_members` is the ACCESS
//                  CONTROL list: not a member ⇒ cannot read.
//   - `narrator` — the discussion room beside one narrator. Membership is NOT
//                  access control (read access follows narrator visibility, see
//                  `assertCanRead` in chat-service); the row only holds that
//                  user's read watermark and is created lazily on first visit.
export const chatRooms = sqliteTable(
	"chat_rooms",
	{
		id: text("id").primaryKey(),
		kind: text("kind", { enum: ["dm", "narrator"] }).notNull(),
		/**
		 * Canonical identity of a DM: both user ids sorted ascending and joined
		 * with ":". The unique index makes (A,B) and (B,A) collapse onto one row,
		 * so two people opening the conversation simultaneously cannot create two
		 * rooms. Null for narrator rooms.
		 */
		dmKey: text("dm_key"),
		/** The narrator this room belongs to; null for DMs. Unique. */
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "cascade" }),
		/**
		 * Per-room sequence allocator. `postMessage` claims a number inside the
		 * write transaction (`next_seq = next_seq + 1`) rather than reading
		 * `MAX(seq)`: that would be a scan that grows with the room, and two
		 * concurrent senders would claim the same number.
		 */
		nextSeq: integer("next_seq").notNull().default(1),
		/** Room-list ordering, and a cheap "is there anything new" probe. */
		lastMessageAt: text("last_message_at"),
		/**
		 * Server-truncated summary for the room list (CHAT_PREVIEW_MAX_CHARS).
		 * Exists so the list endpoint never reads `chat_messages.content_text`.
		 */
		lastMessagePreview: text("last_message_preview"),
		lastMessageSenderId: text("last_message_sender_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_chat_rooms_dm_key").on(table.dmKey),
		uniqueIndex("idx_chat_rooms_narrator").on(table.narratorId),
		index("idx_chat_rooms_kind_last").on(table.kind, table.lastMessageAt),
	],
);

// === chat_room_members ===
// See the note on `chat_rooms.kind`: for a DM this row grants access, for a
// narrator room it only stores the read watermark.
export const chatRoomMembers = sqliteTable(
	"chat_room_members",
	{
		id: text("id").primaryKey(),
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Highest seq this user has read (inclusive). Unread = count(seq > this). */
		lastReadSeq: integer("last_read_seq").notNull().default(0),
		lastReadAt: text("last_read_at"),
		muted: integer("muted", { mode: "boolean" }).notNull().default(false),
		joinedAt: text("joined_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_chat_room_members_room_user").on(table.roomId, table.userId),
		index("idx_chat_room_members_user_room").on(table.userId, table.roomId),
	],
);

// === chat_messages ===
// `seq` is the pagination cursor, so numbers are never recycled: a deletion is a
// soft delete (`deleted_at` set, body emptied) and the row stays to keep the
// cursor sequence contiguous.
export const chatMessages = sqliteTable(
	"chat_messages",
	{
		id: text("id").primaryKey(),
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		/** Monotonic within the room, claimed from `chat_rooms.next_seq`. */
		seq: integer("seq").notNull(),
		senderUserId: text("sender_user_id").references(() => users.id, { onDelete: "set null" }),
		/** A share is not a user. The name snapshot survives link deletion/revocation. */
		senderShareId: text("sender_share_id"),
		senderGuestName: text("sender_guest_name"),
		/** `text` = written by a person; `system` = a room event (e.g. DM created). */
		kind: text("kind", { enum: ["text", "system"] })
			.notNull()
			.default("text"),
		contentText: text("content_text").notNull(),
		/** Quoted message in the same room. */
		replyToMessageId: text("reply_to_message_id"),
		/**
		 * Denormalized snapshot of the quoted message, captured at post time.
		 *
		 * Deliberately NOT resolved by joining the target row. The quote strip has to
		 * render even when the target is outside the loaded page window — a room is
		 * paginated by `seq`, so a reply to something 300 messages back has nothing to
		 * resolve against locally, and the previous behaviour reported that as "this
		 * message was deleted". Joining instead would put an extra lookup on every
		 * page fetch and still read the target's `content_text`, which the read paths
		 * are built to avoid.
		 *
		 * `reply_to_seq` is the jump target: `seq` is the pagination cursor, so it is
		 * what tells the client whether it must keep fetching older pages to reach the
		 * quoted message.
		 *
		 * The AUTHOR is stored as a user id, not a username: a rename must not leave a
		 * stale name frozen in every quote. The preview text is the one thing that IS
		 * frozen, because "what they said when I quoted them" is the point of a quote.
		 * Truncated to CHAT_REPLY_PREVIEW_SNAPSHOT_MAX_CHARS on write.
		 *
		 * All three are null for rows written before this existed; the client falls
		 * back to resolving within the loaded window for those.
		 */
		replyToSeq: integer("reply_to_seq"),
		replyToSenderUserId: text("reply_to_sender_user_id"),
		replyToGuestName: text("reply_to_guest_name"),
		replyToPreview: text("reply_to_preview"),
		editedAt: text("edited_at"),
		deletedAt: text("deleted_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_chat_messages_room_seq").on(table.roomId, table.seq),
		index("idx_chat_messages_sender").on(table.senderUserId),
		index("idx_chat_messages_sender_share").on(table.senderShareId),
		// Explicitly named so migration generation rebuilds the FK rather than losing
		// ON DELETE SET NULL in SQLite's ADD COLUMN path.
		foreignKey({
			name: "fk_chat_messages_sender_share",
			columns: [table.senderShareId],
			foreignColumns: [narratorPublicShares.id],
		}).onDelete("set null"),
	],
);

// === chat_attachments ===
// Images and files posted into a chat room.
//
// ## Two-phase (upload, then claim)
//
// A row is created by the UPLOAD, with `message_id` null, and claimed by the send.
// The composer has to show a thumbnail before the message exists, so the file must
// be persisted first; the alternative (holding bytes in memory until send) loses
// them on a reload and cannot survive a multi-file selection.
//
// `claimed_at` distinguishes "draft" from "posted" for the cleanup path: an
// unclaimed row older than a grace window is an abandoned upload and is reclaimed.
//
// ## Storage lives OUTSIDE any worktree
//
// Files go to `~/.narrafork/chat-attachments/<roomId>/`, never into a narrator's
// worktree. A worktree is subject to tree-snapshot rollback, which deletes whatever
// the target tree does not contain — an attachment written there would silently
// vanish from chat history when someone reverted a narrator turn. Forwarding to a
// narrator COPIES into `<cwd>/.narrafork/attached/` instead, so a rollback can only
// affect the copy.
export const chatAttachments = sqliteTable(
	"chat_attachments",
	{
		id: text("id").primaryKey(),
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		/**
		 * Owning message; null while the upload is still a draft.
		 *
		 * No FK: the row is created before the message exists, and a soft delete keeps
		 * the message row anyway, so cascade semantics would add nothing. Orphan rows
		 * are handled by the cleanup path instead.
		 */
		messageId: text("message_id"),
		uploaderUserId: text("uploader_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		kind: text("kind", { enum: ["image", "file"] }).notNull(),
		filename: text("filename").notNull(),
		mediaType: text("media_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		/**
		 * Pixel dimensions, images only, parsed at upload time.
		 *
		 * Stored rather than measured in the browser because the chat list's height
		 * contract is zero-DOM: the row height must be pure arithmetic, so the layer
		 * that reserves space for a thumbnail needs the aspect ratio without loading
		 * the image.
		 */
		width: integer("width"),
		height: integer("height"),
		/** On-disk filename (`<id><ext>`), relative to the room directory. */
		storedName: text("stored_name").notNull(),
		createdAt: text("created_at").notNull(),
		claimedAt: text("claimed_at"),
	},
	(table) => [
		index("idx_chat_attachments_message").on(table.messageId),
		index("idx_chat_attachments_room_unclaimed").on(table.roomId, table.claimedAt),
		index("idx_chat_attachments_uploader").on(table.uploaderUserId),
	],
);

// === narrator_drafts ===
// Private per-user composer state. Empty text rows are retained as clear tombstones so
// another tab/device can distinguish a newer clear from an older local draft.
export const narratorDrafts = sqliteTable(
	"narrator_drafts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		text: text("text").notNull().default(""),
		fileReferencesJson: text("file_references_json"), // bounded FileReference[]; no file contents
		sourceId: text("source_id"),
		revision: integer("revision").notNull().default(1),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_narrator_drafts_user_narrator").on(table.userId, table.narratorId),
		index("idx_narrator_drafts_narrator").on(table.narratorId),
	],
);

// === user_totp (TOTP two-factor authenticator secrets) ===
// One row per user. status="pending" while the user is mid-enrollment (secret
// generated but not yet verified); status="active" once a valid code confirms
// the authenticator. A pending row is overwritten when setup restarts.
export const userTotp = sqliteTable(
	"user_totp",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Base32 TOTP shared secret. */
		secret: text("secret").notNull(),
		status: text("status", { enum: ["pending", "active"] })
			.notNull()
			.default("pending"),
		activatedAt: text("activated_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [uniqueIndex("idx_user_totp_user").on(table.userId)],
);

// === user_mfa_backup_codes (one-time recovery codes) ===
// Generated when TOTP is activated. Stored only as bcrypt hashes; the plaintext
// is shown to the user exactly once at activation. usedAt is set when a code is
// redeemed (each code is single-use).
export const userMfaBackupCodes = sqliteTable(
	"user_mfa_backup_codes",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		codeHash: text("code_hash").notNull(),
		usedAt: text("used_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_mfa_backup_codes_user").on(table.userId)],
);

// === user_passkeys (WebAuthn credentials) ===
// One row per registered authenticator (passkey/security key). A user may have
// many. credentialId is the base64url credential ID (unique); publicKey is the
// base64url-encoded COSE public key; counter is the signature counter used to
// detect cloned authenticators.
export const userPasskeys = sqliteTable(
	"user_passkeys",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** base64url credential ID returned by the authenticator. */
		credentialId: text("credential_id").notNull(),
		/** base64url-encoded COSE public key. */
		publicKey: text("public_key").notNull(),
		/** Signature counter (clone-detection). */
		counter: integer("counter").notNull().default(0),
		/** JSON string[] of transports (e.g. ["internal","hybrid"]). */
		transports: text("transports", { mode: "json" }).$type<string[]>(),
		/** "singleDevice" | "multiDevice" — whether the credential is backed up/syncable. */
		deviceType: text("device_type"),
		backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
		/** User-friendly label (e.g. "MacBook Touch ID"). */
		name: text("name"),
		lastUsedAt: text("last_used_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_passkeys_credential").on(table.credentialId),
		index("idx_passkeys_user").on(table.userId),
	],
);

// === webauthn_challenges (short-lived registration/authentication challenges) ===
// A WebAuthn ceremony is two round-trips: the server issues options (with a
// random challenge) and later verifies the authenticator's response against
// that exact challenge. We persist the pending challenge here between the two
// calls. userId is null for usernameless (discoverable-credential) login, where
// the user is only known after verification. Rows are single-use and expire.
export const webauthnChallenges = sqliteTable(
	"webauthn_challenges",
	{
		id: text("id").primaryKey(),
		/** The base64url challenge string echoed back by the authenticator. */
		challenge: text("challenge").notNull(),
		/** "registration" | "authentication". */
		type: text("type", { enum: ["registration", "authentication"] }).notNull(),
		/** Known user for registration / 2FA; null for usernameless login. */
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		/** Epoch ms after which the challenge is invalid. */
		expiresAt: integer("expires_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_webauthn_challenge").on(table.challenge),
		index("idx_webauthn_challenge_expires").on(table.expiresAt),
		// FK covering index for user deletion (ON DELETE CASCADE).
		index("idx_webauthn_challenge_user").on(table.userId),
	],
);

// === user_identities (federated SSO / OIDC identity links) ===
// Maps an external identity provider's subject to a local user. A user may link
// several providers; each (provider, subject) pair maps to exactly one user.
// `provider` is the configured OIDC provider id (settings.auth.oidcProviders[].id).
export const userIdentities = sqliteTable(
	"user_identities",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Configured provider id (settings.auth.oidcProviders[].id). */
		provider: text("provider").notNull(),
		/** Stable subject claim ("sub") from the provider's id_token. */
		subject: text("subject").notNull(),
		/** Email claim at link time (informational; not an identity key). */
		email: text("email"),
		/** Display name claim at link time. */
		displayName: text("display_name"),
		lastLoginAt: text("last_login_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_user_identities_provider_subject").on(table.provider, table.subject),
		index("idx_user_identities_user").on(table.userId),
	],
);

// === user_favorite_directories ===
export const userFavoriteDirectories = sqliteTable(
	"user_favorite_directories",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		label: text("label"),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_fav_dirs_user").on(table.userId, table.sortOrder)],
);

// === narrator_file_snapshots (per-file original content tracking) ===
export const narratorFileSnapshots = sqliteTable(
	"narrator_file_snapshots",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		/** "local" or the remote_devices.id that owns this path. */
		deviceId: text("device_id").notNull().default("local"),
		/** Normalized absolute path on the target device. */
		filePath: text("file_path").notNull(),
		originalContent: text("original_content"),
		/**
		 * Charset the bytes were decoded with when this snapshot was taken.
		 * Restoring must re-encode with the same charset, otherwise a legacy-encoded
		 * file (GBK, Shift_JIS, …) silently becomes UTF-8 on rollback. null means the
		 * row predates this column and is assumed UTF-8.
		 */
		originalEncoding: text("original_encoding"),
		/**
		 * True when the original bytes could not be represented losslessly as text.
		 * Such files must never be rebuilt from `originalContent`, because the
		 * decode/encode round trip would corrupt them.
		 */
		isBinary: integer("is_binary", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_file_snapshots_narrator").on(table.narratorId),
		index("idx_file_snapshots_device").on(table.deviceId),
		uniqueIndex("idx_file_snapshots_narrator_device_file").on(
			table.narratorId,
			table.deviceId,
			table.filePath,
		),
	],
);

// === worktree_tree_snapshots (content-addressed workspace state) ===
// A git tree object hash captured for one worktree at a point in time. Unlike
// narrator_file_snapshots (per-file decoded text, replayed forward), a tree hash
// is the hash of the actual bytes: it is binary-safe, encoding-agnostic, captures
// changes made by any actor (Bash, external editors, build scripts), and restores
// in a single read-tree + checkout-index instead of replaying recorded edits.
//
// Not related to the `workspaces` table, which stores per-user UI split layouts.
export const worktreeTreeSnapshots = sqliteTable(
	"worktree_tree_snapshots",
	{
		id: text("id").primaryKey(),
		/** "local" or the remote_devices.id that owns this worktree. */
		deviceId: text("device_id").notNull().default("local"),
		/** Normalized absolute worktree path — the canonical workspace key. */
		worktreePath: text("worktree_path").notNull(),
		/** Git tree object hash inside the shadow repository for this worktree. */
		treeHash: text("tree_hash").notNull(),
		/**
		 * Snapshot commit that records this tree in the shadow repository's DAG.
		 *
		 * A tree alone has no ancestry, so two diverging lines of uncommitted work
		 * have no computable merge base. Wrapping each capture in a commit whose
		 * parent is the previous capture supplies that ancestry, which is what lets
		 * fork and merge operate on uncommitted state. It also makes the snapshot
		 * reachable from a ref, so `git gc` stops being entitled to delete it.
		 *
		 * null for rows written before the DAG existed; those still have a usable
		 * `treeHash` and remain revertable, they just cannot be a merge endpoint.
		 */
		snapshotCommitSha: text("snapshot_commit_sha"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		// Identical trees are recorded once per worktree; writers upsert on this key.
		uniqueIndex("idx_worktree_tree_snapshots_unique").on(
			table.deviceId,
			table.worktreePath,
			table.treeHash,
		),
		index("idx_worktree_tree_snapshots_path").on(
			table.deviceId,
			table.worktreePath,
			table.createdAt,
		),
	],
);

// === narrator_patches (DEPRECATED — replaced by narrator_file_snapshots) ===
// Kept for backward compatibility with existing databases. No longer written to.
export const narratorPatches = sqliteTable(
	"narrator_patches",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		messageId: text("message_id")
			.notNull()
			.references(() => narratorMessages.id, { onDelete: "cascade" }),
		toolUseId: text("tool_use_id").notNull(),
		beforeHash: text("before_hash").notNull(),
		afterHash: text("after_hash").notNull(),
		filesJson: text("files_json", { mode: "json" }).notNull().$type<string[]>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_patches_narrator").on(table.narratorId, table.createdAt),
		index("idx_patches_message").on(table.messageId),
		index("idx_patches_tool_use").on(table.toolUseId),
	],
);

// === merge_sessions ===
export const mergeSessions = sqliteTable(
	"merge_sessions",
	{
		id: text("id").primaryKey(),
		/**
		 * Cascaded for the same reason as `terminals.chapterId`. A merge session describes
		 * work in progress against this target; once the target is gone the session can
		 * never be resumed, and leaving the row behind both blocked the delete and left
		 * the startup sweep trying to restore a worktree that no longer exists.
		 */
		targetChapterId: text("target_chapter_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		sourceChapterIds: text("source_chapter_ids", { mode: "json" }).notNull().$type<string[]>(),
		strategy: text("strategy", { enum: ["merge", "squash", "cherry-pick"] })
			.notNull()
			.default("merge"),
		status: text("status", {
			enum: ["running", "waiting_decision", "ai_resolving", "completed", "cancelled", "error"],
		}).notNull(),
		currentIndex: integer("current_index").notNull().default(0),
		mergedCount: integer("merged_count").notNull().default(0),
		currentSourceChapterId: text("current_source_chapter_id"),
		conflictFiles: text("conflict_files", { mode: "json" }).$type<string[]>(),
		/**
		 * Target's workspace snapshot before the in-flight merge was applied.
		 *
		 * A git-based interactive merge keeps its own half-finished state on disk, so
		 * `git merge --abort` knows what to return to. A snapshot merge has no such
		 * state: the conflicted tree is simply written into the worktree, so the way
		 * back has to be recorded explicitly. Persisted rather than held in memory
		 * because the two halves of an interactive merge are separate requests and a
		 * restart between them must not strand the worktree in a conflicted state.
		 */
		preMergeTree: text("pre_merge_tree"),
		/** The conflicted tree written to the worktree, kept for diagnosis and replay. */
		conflictTree: text("conflict_tree"),
		/**
		 * The two snapshot commits being merged, recorded so the resolution can be
		 * committed with both parents.
		 *
		 * Not re-derived at completion time: the target's head ref can legitimately
		 * advance while the conflict is being resolved (the workspace watcher records
		 * the narrator's edits), so reading it later would name a conflicted state
		 * instead of the merge's actual parents — and a wrong parent makes the *next*
		 * merge recompute a stale base and report already-resolved conflicts.
		 */
		preMergeTargetSnapshot: text("pre_merge_target_snapshot"),
		mergeSourceSnapshot: text("merge_source_snapshot"),
		/** Target's git HEAD before the merge, for parity with the commit path. */
		preMergeTargetSha: text("pre_merge_target_sha"),
		error: text("error"),
		locale: text("locale").$type<Locale>(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	// FK covering index for chapter deletion.
	(table) => [index("idx_merge_sessions_target_chapter").on(table.targetChapterId)],
);

// === narrator_whitelist_dirs ===
export const narratorWhitelistDirs = sqliteTable(
	"narrator_whitelist_dirs",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		pathFlavor: text("path_flavor", { enum: ["posix", "windows"] }),
		pathKey: text("path_key"),
		accessLevel: text("access_level", {
			enum: ["readOnly", "readWrite", "full"],
		})
			.notNull()
			.default("readOnly"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		targetKind: text("target_kind", {
			enum: ["all", "host", "device", "oauthGroup"],
		}),
		targetValue: text("target_value"),
		/** Legacy compatibility mirror; canonical writes also populate targetKind/targetValue. */
		deviceScope: text("device_scope"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
	},
	(table) => [
		index("idx_whitelist_dirs_narrator").on(table.narratorId),
		// SQLite treats NULLs as distinct in a unique index, so a single composite index
		// on (narratorId, path, deviceScope) would silently allow duplicate NULL-scope
		// rows for the same path. Two partial unique indexes preserve the original
		// "one rule per path" invariant for unscoped rows while still preventing
		// duplicate device-scoped rows for the same path.
		uniqueIndex("idx_whitelist_dirs_narrator_path_unscoped")
			.on(table.narratorId, table.path)
			.where(sql`${table.deviceScope} is null`),
		uniqueIndex("idx_whitelist_dirs_narrator_path_scoped")
			.on(table.narratorId, table.path, table.deviceScope)
			.where(sql`${table.deviceScope} is not null`),
	],
);

// === narrator_blacklist_dirs ===
export const narratorBlacklistDirs = sqliteTable(
	"narrator_blacklist_dirs",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		pathFlavor: text("path_flavor", { enum: ["posix", "windows"] }),
		pathKey: text("path_key"),
		denyLevel: text("deny_level", {
			enum: ["denyWrite", "denyAll"],
		})
			.notNull()
			.default("denyAll"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		targetKind: text("target_kind", {
			enum: ["all", "host", "device", "oauthGroup"],
		}),
		targetValue: text("target_value"),
		/** See narratorWhitelistDirs.deviceScope. */
		deviceScope: text("device_scope"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
	},
	(table) => [
		index("idx_blacklist_dirs_narrator").on(table.narratorId),
		// See narratorWhitelistDirs for why this is split into two partial indexes.
		uniqueIndex("idx_blacklist_dirs_narrator_path_unscoped")
			.on(table.narratorId, table.path)
			.where(sql`${table.deviceScope} is null`),
		uniqueIndex("idx_blacklist_dirs_narrator_path_scoped")
			.on(table.narratorId, table.path, table.deviceScope)
			.where(sql`${table.deviceScope} is not null`),
	],
);

// === narrator_whitelist_cmds ===
export const narratorWhitelistCmds = sqliteTable(
	"narrator_whitelist_cmds",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		pattern: text("pattern").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		targetKind: text("target_kind", {
			enum: ["all", "host", "device", "oauthGroup"],
		}),
		targetValue: text("target_value"),
		/** See narratorWhitelistDirs.deviceScope. */
		deviceScope: text("device_scope"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
	},
	(table) => [
		index("idx_whitelist_cmds_narrator").on(table.narratorId),
		// See narratorWhitelistDirs for why this is split into two partial indexes.
		uniqueIndex("idx_whitelist_cmds_narrator_pattern_unscoped")
			.on(table.narratorId, table.pattern)
			.where(sql`${table.deviceScope} is null`),
		uniqueIndex("idx_whitelist_cmds_narrator_pattern_scoped")
			.on(table.narratorId, table.pattern, table.deviceScope)
			.where(sql`${table.deviceScope} is not null`),
	],
);

// === narrator_blacklist_cmds ===
export const narratorBlacklistCmds = sqliteTable(
	"narrator_blacklist_cmds",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		pattern: text("pattern").notNull(),
		denyPrompt: text("deny_prompt"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		targetKind: text("target_kind", {
			enum: ["all", "host", "device", "oauthGroup"],
		}),
		targetValue: text("target_value"),
		/** See narratorWhitelistDirs.deviceScope. */
		deviceScope: text("device_scope"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
	},
	(table) => [
		index("idx_blacklist_cmds_narrator").on(table.narratorId),
		// See narratorWhitelistDirs for why this is split into two partial indexes.
		uniqueIndex("idx_blacklist_cmds_narrator_pattern_unscoped")
			.on(table.narratorId, table.pattern)
			.where(sql`${table.deviceScope} is null`),
		uniqueIndex("idx_blacklist_cmds_narrator_pattern_scoped")
			.on(table.narratorId, table.pattern, table.deviceScope)
			.where(sql`${table.deviceScope} is not null`),
	],
);

// === volume_snapshots ===
export const volumeSnapshots = sqliteTable(
	"volume_snapshots",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		sourceChapterId: text("source_chapter_id").references(() => chapters.id, {
			onDelete: "set null",
		}),
		// Provenance only: the existing non-null project FK and its cascade remain unchanged.
		sourceWorktreeResourceId: text("source_worktree_resource_id").references(
			() => narratorWorktreeResources.id,
			{ onDelete: "restrict" },
		),
		serviceName: text("service_name").notNull(),
		containerPath: text("container_path").notNull(),
		sizeBytes: integer("size_bytes"),
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_volume_snapshots_project").on(table.projectId),
		index("idx_volume_snapshots_source_chapter").on(table.sourceChapterId),
		index("idx_volume_snapshots_source_resource").on(table.sourceWorktreeResourceId),
	],
);

// === volume_snapshot_applications ===
export const volumeSnapshotApplications = sqliteTable(
	"volume_snapshot_applications",
	{
		id: text("id").primaryKey(),
		snapshotId: text("snapshot_id")
			.notNull()
			.references(() => volumeSnapshots.id, { onDelete: "cascade" }),
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
		targetWorktreeResourceId: text("target_worktree_resource_id").references(
			() => narratorWorktreeResources.id,
			{ onDelete: "restrict" },
		),
		appliedAt: text("applied_at").notNull(),
		appliedBy: text("applied_by").references(() => users.id, { onDelete: "set null" }),
	},
	(table) => [
		index("idx_snapshot_applications_snapshot").on(table.snapshotId),
		index("idx_snapshot_applications_chapter").on(table.chapterId),
		index("idx_snapshot_applications_target_resource").on(table.targetWorktreeResourceId),
		check(
			"ck_snapshot_applications_owner",
			sql`(${table.chapterId} is null) <> (${table.targetWorktreeResourceId} is null)`,
		),
	],
);

// === review_conclusions ===
export const reviewConclusions = sqliteTable(
	"review_conclusions",
	{
		id: text("id").primaryKey(),
		reviewChapterId: text("review_chapter_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		sourceChapterId: text("source_chapter_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		verdict: text("verdict", {
			enum: ["approve", "request_changes", "comment_only"],
		}).notNull(),
		findingsJson: text("findings_json", { mode: "json" }).$type<
			Array<{
				severity: "critical" | "major" | "minor" | "suggestion";
				file?: string;
				line?: number;
				message: string;
			}>
		>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_review_conclusions_review").on(table.reviewChapterId),
		index("idx_review_conclusions_source").on(table.sourceChapterId),
	],
);

// === workspaces ===
export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		/**
		 * Serialized dockview layout — ARRANGEMENT ONLY.
		 *
		 * This column used to be the authoritative answer to "which narrators are in
		 * this workspace", while `user_recent_tabs.workspace_id` held the same answer
		 * independently. Two sources written by two separate client requests, with no
		 * atomicity between them, is what produced the "the sidebar lists a narrator
		 * but no panel renders" class of bug: the tab row was persisted while the
		 * panel only ever existed in a client-side pending queue.
		 *
		 * Membership now lives in `workspace_panels`. This blob is read for POSITIONS
		 * only: entries naming a panel that is not a member are discarded, and members
		 * the blob does not mention are appended at a default position. Losing this
		 * column therefore costs the arrangement, never a panel.
		 *
		 * The column name stays `tree` (a rename migration would buy nothing); the API
		 * exposes it as `layout` to reflect the narrowed role.
		 */
		tree: text("tree").notNull(),
		/**
		 * Optimistic-concurrency token for layout writes.
		 *
		 * Layout is saved as one whole blob, so two tabs open on the same workspace
		 * would otherwise silently overwrite each other's arrangement on every drag.
		 * A mismatched `expectedRevision` is rejected with 409 so the client can
		 * re-read and retry instead of last-write-wins. Membership does not need this
		 * — `workspace_panels` is row-per-panel, so concurrent edits to different
		 * panels cannot collide at all.
		 */
		layoutRevision: integer("layout_revision").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("idx_workspaces_user").on(table.userId)],
);

// === workspace_panels ===
// The authoritative membership of a workspace: one row per TOP-LEVEL panel.
//
// Rows, not a blob, for two reasons that the previous blob-only design could not
// satisfy:
//   - Adding or removing one panel touches one row, so two clients editing
//     different panels never overwrite each other (a whole-blob write does).
//   - Membership can be written in the SAME transaction as its
//     `user_recent_tabs.workspace_id` projection, so a client can no longer end
//     up with a persisted sidebar tab and a panel that exists nowhere.
//
// Scope is deliberately limited to panels that can stand on their own and are
// rendered as top-level cells by BOTH presentation modes — the same set as
// `isDirectorRenderablePanel`. Dependent panels (narrator-tool / subagent /
// file / knowledge) stay in the layout blob: they only exist as a resource OF a
// member (`hostNarratorId`), the sidebar never lists them, so they cannot
// produce the "listed but invisible" shape, and reopening one is a single click.
export const workspacePanels = sqliteTable(
	"workspace_panels",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		/**
		 * Membership kinds only.
		 *
		 * `plugin` was briefly included and is deliberately absent: a workspace plugin
		 * panel binds to an owning narrator (`binding.kind === "workspace-narrator"`), so
		 * it is that narrator's resource, not a standalone member. No code ever wrote such
		 * a row, so narrowing this needs no data migration — and SQLite does not enforce
		 * the enum anyway; it is a TypeScript-level constraint that keeps a non-membership
		 * kind from being inserted.
		 */
		kind: text("kind", { enum: ["narrator", "terminal", "webview"] }).notNull(),
		/**
		 * Set only when `kind = "narrator"`.
		 *
		 * CASCADE rather than SET NULL: a narrator panel whose narrator is gone has
		 * nothing left to render, so keeping the row would leave an empty cell the
		 * user cannot open or meaningfully close.
		 */
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "cascade" }),
		/**
		 * Panel params for terminal / webview / plugin kinds (including a plugin's
		 * `viewState`). Bounded per row by the service, which is also why moving
		 * plugin panels out of the blob shrinks the layout back to a skeleton.
		 */
		configJson: text("config_json"),
		/** Stable member order, used to place members the layout does not mention. */
		sortOrder: integer("sort_order").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("idx_workspace_panels_workspace").on(table.workspaceId, table.sortOrder),
		/**
		 * One cell per narrator per workspace, enforced by the database.
		 *
		 * The previous design checked this by scanning `api.panels` on the client
		 * before adding, which cannot hold under concurrency — two tabs (or a drop
		 * racing a pending-panel drain) could both pass the check and create
		 * duplicates.
		 */
		uniqueIndex("idx_workspace_panels_narrator").on(table.workspaceId, table.narratorId),
		index("idx_workspace_panels_narrator_lookup").on(table.narratorId),
	],
);

// === api_requests ===
// 独立记录每次 API 请求的统计信息（与 narrator_messages 解耦）
export const apiRequests = sqliteTable(
	"api_requests",
	{
		id: text("id").primaryKey(),
		/** Request initiator, frozen at start; null for unknown legacy/system usage.
		 * No FK: removing a user must not rewrite the accounting identity. */
		userId: text("user_id"),
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "cascade" }),
		// 外部 Agent 写入时可自带的叙述者文本（无 narrator 关联时用于占位显示）
		agentLabel: text("agent_label"),
		// 关联的 assistant message ID（一个请求可能产生一个 assistant message）
		messageId: text("message_id").references(() => narratorMessages.id, { onDelete: "set null" }),
		// 请求用途：narrator / compact / title / external / internal 等
		kind: text("kind").notNull().default("narrator"),
		// 提供商和模型信息
		provider: text("provider"),
		credentialId: text("credential_id"),
		model: text("model"),
		// Token 使用统计
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
		cacheCreation5mTokens: integer("cache_creation_5m_tokens").notNull().default(0),
		cacheCreation1hTokens: integer("cache_creation_1h_tokens").notNull().default(0),
		reasoningTokens: integer("reasoning_tokens").notNull().default(0),
		// 性能指标
		ttftMs: integer("ttft_ms"), // Time to first token
		durationMs: integer("duration_ms"), // 总耗时
		// 成本
		costUsd: real("cost_usd"),
		/** Null marks an untouched historical record. */
		costStatus: text("cost_status", { enum: ["complete", "partial", "unknown"] }),
		costMissingFields: text("cost_missing_fields", { mode: "json" }).$type<string[]>(),
		// 上下文使用率
		contextPercent: real("context_percent"),
		// Metering（NUG）
		meterUsage: real("meter_usage"),
		meterUnit: text("meter_unit"),
		// 错误信息（请求失败时记录）
		errorMessage: text("error_message"),
		// 原始请求/响应 dump（调试用）
		rawDumpJson: text("raw_dump_json"),
		// 时间戳
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_api_requests_narrator").on(table.narratorId, table.createdAt),
		index("idx_api_requests_message").on(table.messageId),
		index("idx_api_requests_provider").on(table.provider, table.createdAt),
		index("idx_api_requests_kind").on(table.kind, table.createdAt),
		index("idx_api_requests_created").on(table.createdAt, table.id),
		index("idx_api_requests_user_created").on(table.userId, table.createdAt, table.id),
		// Per-credential filtering would otherwise scan the whole table.
		index("idx_api_requests_credential").on(table.credentialId, table.createdAt),
	],
);

// === user_usage_totals ===
// One bounded lifetime rollup per user, independent of request/narrator cleanup.
// No user FK: deletion keeps the original accounting ID; labels resolve at read time.
// Legacy requests are deliberately not backfilled: their initiator is unknown.
export const userUsageTotals = sqliteTable("user_usage_totals", {
	userId: text("user_id").primaryKey(),
	requestCount: integer("request_count").notNull().default(0),
	inputTokens: integer("input_tokens").notNull().default(0),
	outputTokens: integer("output_tokens").notNull().default(0),
	cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
	cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
	reasoningTokens: integer("reasoning_tokens").notNull().default(0),
	costUsd: real("cost_usd").notNull().default(0),
	unpricedRequestCount: integer("unpriced_request_count").notNull().default(0),
	partialRequestCount: integer("partial_request_count").notNull().default(0),
	firstUsedAt: text("first_used_at").notNull(),
	lastUsedAt: text("last_used_at").notNull(),
});

// === credential_usage_totals ===
// Lifetime token/cost rollup per (provider, credential, model).
//
// `api_requests` holds the per-request detail but is deleted along with its
// narrator, and the cleanup UI even flags that as "deletesUsageHistory". That
// makes it unusable as the source of truth for "how much has this credential
// consumed in total". This table is the durable counterpart: it is written on
// the same path as the detail row, is never touched by narrator cleanup, and is
// only cleared when the credential itself is deleted.
//
// Costs are USD at the vendors' official reference prices (see
// server/lib/model-pricing.ts). For subscription-based access that is an
// equivalent-consumption figure, not an amount actually billed.
//
// SCOPE — this is NOT a full ledger of the deployment's spend. Rows only exist
// for providers that have credential management (codex). Anthropic and
// OpenAI direct connections carry credentialId = null (see
// usage-history-service.getCredentialName) and are deliberately not rolled up
// here: a synthetic bucket would give every unrelated keyless provider one
// shared row, and the natural key would stop meaning "one credential".
// "How much has this deployment spent in total" is answered from `api_requests`
// for as long as those rows live. Do not read a sum over this table as the
// deployment total.
export const credentialUsageTotals = sqliteTable(
	"credential_usage_totals",
	{
		id: text("id").primaryKey(),
		provider: text("provider").notNull(),
		credentialId: text("credential_id").notNull(),
		model: text("model").notNull(),
		requestCount: integer("request_count").notNull().default(0),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
		reasoningTokens: integer("reasoning_tokens").notNull().default(0),
		/** Summed USD cost of the requests that had a known price. */
		costUsd: real("cost_usd").notNull().default(0),
		/**
		 * Requests whose model had no reference price. Kept so the UI can say
		 * "cost covers N of M requests" instead of presenting a silent undercount.
		 */
		unpricedRequestCount: integer("unpriced_request_count").notNull().default(0),
		partialRequestCount: integer("partial_request_count").notNull().default(0),
		firstSeenAt: text("first_seen_at").notNull(),
		lastSeenAt: text("last_seen_at").notNull(),
	},
	(table) => [
		// The natural key. A unique index (rather than a composite primary key)
		// keeps the row addressable by a single id, matching every other table.
		uniqueIndex("idx_credential_usage_totals_key").on(
			table.provider,
			table.credentialId,
			table.model,
		),
		// Serves both queries in getCredentialUsageTotals (SQL aggregate + capped
		// per-model breakdown) and the provider-wide group-by, all of which lead
		// with an equality on provider.
		//
		// No index on lastSeenAt alone: every read path already filters by
		// provider (+ credentialId) first, so the composite above covers the
		// ORDER BY and a lastSeenAt index would only add write amplification to a
		// table written once per API request.
		index("idx_credential_usage_totals_credential").on(table.provider, table.credentialId),
	],
);

// === narrator_buffered_messages ===
// Persisted queue of user messages waiting to be processed by a running narrator.
// Acts as the durable backing store for the in-memory bufferedMessages Map.
export const narratorBufferedMessages = sqliteTable(
	"narrator_buffered_messages",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id").notNull(),
		text: text("text").notNull(),
		imagesJson: text("images_json"), // JSON: ImageRef[] | null
		commandText: text("command_text"),
		bashCommand: text("bash_command"), // runBashFirst command to execute before the prompt
		createdBy: text("created_by"),
		creatorJson: text("creator_json"), // JSON: BufferCreator | null
		textFilePathsJson: text("text_file_paths_json"), // JSON: SavedBufferedFile[] | null
		fileReferencesJson: text("file_references_json"), // bounded FileReferenceSnapshot[] | null
		priority: integer("priority", { mode: "boolean" }).notNull().default(false),
		seq: integer("seq").notNull(),
		bufferedAt: text("buffered_at").notNull(),
		kind: text("kind", { enum: ["user_input", "agent_message", "task_notice"] })
			.notNull()
			.default("user_input"),
		noticeKind: text("notice_kind", { enum: ["agent", "bash"] }),
		envelopeVersion: integer("envelope_version").notNull().default(1),
		metadataJson: text("metadata_json"),
		sourceNarratorId: text("source_narrator_id"),
		sourceToolCallId: text("source_tool_call_id"),
		sourceAttempt: integer("source_attempt"),
		sourceKey: text("source_key"),
		dedupeKey: text("dedupe_key"),
		deliveryId: text("delivery_id"),
		recipientMessageId: text("recipient_message_id"),
		recipientRefId: text("recipient_ref_id"),
		currentMessageId: text("current_message_id"),
		contentRevision: integer("content_revision").notNull().default(1),
		adoptedRevision: integer("adopted_revision"),
		adoptedAt: text("adopted_at"),
		/** Receiver-side semantic edits have adoption facts separate from the original delivery. */
		currentRevision: integer("current_revision").notNull().default(1),
		currentAdoptedRevision: integer("current_adopted_revision"),
		currentAdoptedAt: text("current_adopted_at"),
		receiptDisposition: text("receipt_disposition", {
			enum: ["active", "superseded", "recipient_deleted"],
		})
			.notNull()
			.default("active"),
		arrivalSeq: integer("arrival_seq"),
		state: text("state", { enum: ["queued", "claimed", "materialized", "failed", "cancelled"] })
			.notNull()
			.default("queued"),
		claimToken: text("claim_token"),
		claimEpoch: text("claim_epoch"),
		claimedAt: text("claimed_at"),
		claimAttempts: integer("claim_attempts").notNull().default(0),
		lastError: text("last_error"),
		byteSize: integer("byte_size").notNull().default(0),
		projectedByteSize: integer("projected_byte_size").notNull().default(0),
		payloadRefJson: text("payload_ref_json"),
		dedupeExpiresAt: text("dedupe_expires_at"),
		updatedAt: text("updated_at"),
	},
	(table) => [
		index("idx_nbm_narrator_seq").on(table.narratorId, table.seq),
		index("idx_nbm_state_arrival").on(table.narratorId, table.state, table.arrivalSeq),
		index("idx_nbm_claim_recovery").on(table.state, table.id),
		index("idx_nbm_quota").on(table.narratorId, table.kind, table.noticeKind, table.state),
		index("idx_nbm_legacy").on(table.narratorId, table.arrivalSeq, table.seq),
		uniqueIndex("idx_nbm_dedupe").on(table.narratorId, table.dedupeKey),
		uniqueIndex("idx_nbm_delivery").on(table.deliveryId),
		index("idx_nbm_ref").on(table.narratorId, table.recipientRefId),
		index("idx_nbm_reserved").on(table.narratorId, table.recipientMessageId),
		index("idx_nbm_source").on(table.sourceNarratorId, table.sourceToolCallId, table.sourceAttempt),
	],
);

/** Bounded notification slots: reserved rows have no arrival sequence or content. */
export const runtimePublicationOutbox = sqliteTable(
	"runtime_publication_outbox",
	{
		id: text("id").primaryKey(),
		producerKind: text("producer_kind", { enum: ["agent", "bash"] }).notNull(),
		taskId: text("task_id").notNull(),
		logicalRunId: text("logical_run_id").notNull(),
		eventKind: text("event_kind", {
			enum: ["started", "completed", "failed", "timed_out", "cancelled", "terminal"],
		}).notNull(),
		recipientId: text("recipient_id").notNull(),
		state: text("state", { enum: ["reserved", "pending", "failed"] })
			.notNull()
			.default("reserved"),
		arrivalSeq: integer("arrival_seq"),
		resultRef: text("result_ref"),
		summary: text("summary"),
		deliveryId: text("delivery_id").notNull(),
		dedupeKey: text("dedupe_key").notNull(),
		lastError: text("last_error"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_runtime_outbox_event").on(
			table.producerKind,
			table.taskId,
			table.logicalRunId,
			table.eventKind,
			table.recipientId,
		),
		index("idx_runtime_outbox_order").on(
			table.recipientId,
			table.producerKind,
			table.state,
			table.arrivalSeq,
		),
		index("idx_runtime_outbox_recipient").on(table.recipientId),
		index("idx_runtime_outbox_state").on(table.state, table.id),
	],
);

/** Await is a durable terminal-consumption authority, independent of mailbox GC and task cleanup.
 * No task FK: agent task ids may be reused for later logical runs. Recipient deletion is
 * the only safe lifetime boundary (late publishers then have no recipient to notify).
 */
export const runtimeAwaitedTerminalConsumptions = sqliteTable(
	"runtime_awaited_terminal_consumptions",
	{
		producerKind: text("producer_kind", { enum: ["agent", "bash"] }).notNull(),
		taskId: text("task_id").notNull(),
		logicalRunId: text("logical_run_id").notNull(),
		recipientId: text("recipient_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		consumedAt: text("consumed_at").notNull(),
		/** Exact source already read by Await; never recomputed from a later actor run. Max 512B. */
		sourceResultRef: text("source_result_ref"),
	},
	(table) => [
		uniqueIndex("idx_runtime_awaited_terminal_run").on(
			table.producerKind,
			table.taskId,
			table.logicalRunId,
			table.recipientId,
		),
		index("idx_runtime_awaited_terminal_recipient").on(table.recipientId),
	],
);

// === hooks ===
export const hooks = sqliteTable(
	"hooks",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		event: text("event", {
			enum: ["PreToolUse", "PostToolUse", "Stop", "Attention", "AttentionResolved"],
		}).notNull(),
		matcher: text("matcher").notNull().default(""),
		type: text("type", { enum: ["command", "http"] }).notNull(),
		// command type
		command: text("command"),
		// http type
		url: text("url"),
		headers: text("headers", { mode: "json" }).$type<Record<string, string>>(),
		// http type: optional per-hook proxy override (null/"default" = follow global policy)
		proxyMode: text("proxy_mode", { enum: ["default", "direct", "system", "custom"] }),
		proxyUrl: text("proxy_url"),
		// reserved for future prompt hook type
		prompt: text("prompt"),
		model: text("model"),
		// common
		timeout: integer("timeout").notNull().default(30),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_hooks_project").on(table.projectId),
		index("idx_hooks_event").on(table.event, table.enabled),
	],
);

// === IM gateway ===

export const gatewaySessionMappings = sqliteTable(
	"gateway_session_mappings",
	{
		id: text("id").primaryKey(),
		platform: text("platform").notNull(),
		/** Platform-specific chat / channel ID */
		chatId: text("chat_id").notNull(),
		/** Platform-specific user ID */
		userId: text("user_id").notNull(),
		/** Display name of the IM user */
		username: text("username"),
		/** The narrator this IM session is bound to */
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		/** NarraFork user this IM session belongs to (for recentTabs / notifications) */
		appUserId: text("app_user_id").references(() => users.id, { onDelete: "set null" }),
		/** Optional project binding */
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		/** Optional chapter binding */
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
		lastMessageAt: text("last_message_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_gsm_platform_chat_user").on(table.platform, table.chatId, table.userId),
		index("idx_gsm_narrator").on(table.narratorId),
		index("idx_gsm_app_user").on(table.appUserId),
		// FK covering indexes for chapter / project deletion.
		index("idx_gsm_chapter").on(table.chapterId),
		index("idx_gsm_project").on(table.projectId),
	],
);

// === benchmarks ===

export const benchmarkSuites = sqliteTable("benchmark_suites", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	version: text("version"),
	description: text("description"),
	tasksJson: text("tasks_json", { mode: "json" }),
	createdAt: text("created_at").notNull(),
});

export const benchmarkRuns = sqliteTable(
	"benchmark_runs",
	{
		id: text("id").primaryKey(),
		suiteId: text("suite_id")
			.notNull()
			.references(() => benchmarkSuites.id),
		name: text("name").notNull(),
		model: text("model").notNull(),
		systemPrompt: text("system_prompt"),
		permissionMode: text("permission_mode").default("bypassPermissions"),
		status: text("status", {
			enum: ["pending", "running", "completed", "failed", "cancelled"],
		})
			.notNull()
			.default("pending"),
		config: text("config", { mode: "json" }),
		totalTasks: integer("total_tasks").default(0),
		completedTasks: integer("completed_tasks").default(0),
		passedTasks: integer("passed_tasks").default(0),
		failedTasks: integer("failed_tasks").default(0),
		totalCostUsd: real("total_cost_usd").default(0),
		totalTokensIn: integer("total_tokens_in").default(0),
		totalTokensOut: integer("total_tokens_out").default(0),
		totalDurationMs: integer("total_duration_ms").default(0),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		createdAt: text("created_at").notNull(),
	},
	// FK covering index for benchmark-suite deletion.
	(table) => [index("idx_benchmark_runs_suite").on(table.suiteId)],
);

export const benchmarkTaskResults = sqliteTable(
	"benchmark_task_results",
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => benchmarkRuns.id, { onDelete: "cascade" }),
		taskId: text("task_id").notNull(),
		taskName: text("task_name").notNull(),
		narratorId: text("narrator_id").references(() => narrators.id),
		status: text("status", {
			enum: ["pending", "running", "passed", "failed", "error", "timeout"],
		})
			.notNull()
			.default("pending"),
		score: real("score"),
		maxScore: real("max_score"),
		output: text("output"),
		evalOutput: text("eval_output"),
		errorMessage: text("error_message"),
		tokensIn: integer("tokens_in").default(0),
		tokensOut: integer("tokens_out").default(0),
		costUsd: real("cost_usd").default(0),
		durationMs: integer("duration_ms").default(0),
		toolCallCount: integer("tool_call_count").default(0),
		messageCount: integer("message_count").default(0),
		metadata: text("metadata", { mode: "json" }),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_task_results_run").on(table.runId, table.status),
		// FK covering index for narrator deletion (ON DELETE SET NULL).
		index("idx_task_results_narrator").on(table.narratorId),
	],
);

// === background_tasks ===
// Unified background task tracking for both bash commands and agent subagents.
// Replaces the in-memory-only bash background task map and provides a single
// source of truth alongside the narrators table's background fields.
export const backgroundTasks = sqliteTable(
	"background_tasks",
	{
		id: text("id").primaryKey(),
		parentNarratorId: text("parent_narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		type: text("type", { enum: ["bash", "agent", "transfer"] }).notNull(),
		/** Durable publication run identity. NULL marks legacy tasks awaiting explicit registration. */
		logicalRunId: text("logical_run_id"),
		status: text("status", {
			/**
			 * `paused` exists only for `transfer` rows: a device transfer keeps a resume
			 * checkpoint, so being stopped is a RESUMABLE intermediate state rather than
			 * an ending. Bash and agent tasks have no equivalent — a killed process
			 * cannot be continued — so they never take this value.
			 *
			 * Consumers must treat it as ACTIVE, not terminal (see
			 * isBackgroundTaskActiveStatus and drainCompletedNotifications): a paused
			 * transfer still occupies a slot and still needs the user to act on it.
			 */
			enum: ["running", "paused", "completed", "failed", "cancelled", "timeout"],
		}).notNull(),
		// Bash-specific
		command: text("command"),
		exitCode: integer("exit_code"),
		// Agent-specific
		subagentNarratorId: text("subagent_narrator_id").references(() => narrators.id, {
			onDelete: "cascade",
		}),
		subagentType: text("subagent_type"),
		/**
		 * Transfer-specific: the `device_transfer_tasks` row that OWNS this transfer.
		 *
		 * This table holds only a status projection. The transfer's durable state —
		 * resume checkpoint, run generation, and above all its byte PROGRESS — lives
		 * in the owning row and is never mirrored here: progress changes every 500ms,
		 * and duplicating it would make two tables that must agree on a fast-moving
		 * value. The list layer joins it at read time instead.
		 */
		transferTaskId: text("transfer_task_id").references(() => deviceTransferTasks.id, {
			onDelete: "cascade",
		}),
		// Common
		toolUseId: text("tool_use_id"),
		/** Actual initiating call, retained when its history is removed; NULL is legacy. */
		toolCallId: text("tool_call_id"),
		executionAttempt: integer("execution_attempt"),
		alias: text("alias"),
		title: text("title"),
		output: text("output"),
		outputBytes: integer("output_bytes").notNull().default(0),
		outputTruncated: integer("output_truncated", { mode: "boolean" }).notNull().default(false),
		/** Whether the parent narrator has been notified about this task's completion */
		notified: integer("notified", { mode: "boolean" }).notNull().default(false),
		startedAt: text("started_at").notNull(),
		completedAt: text("completed_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_bg_tasks_parent").on(table.parentNarratorId, table.status),
		index("idx_bg_tasks_subagent").on(table.subagentNarratorId),
		uniqueIndex("idx_bg_tasks_tool_attempt").on(table.toolCallId, table.executionAttempt),
		// The transfer runner reaches the projection by the OWNING row's id (it never
		// holds the projection id), and it does so at every lifecycle transition.
		// Doubles as the FK covering index for transfer-row deletion.
		index("idx_bg_tasks_transfer").on(table.transferTaskId),
		// Cursor paging order for the task list: `(parent, createdAt desc, id desc)`.
		// Without it a parent with hundreds of tasks sorts its whole history on every
		// page request.
		index("idx_bg_tasks_parent_created").on(table.parentNarratorId, table.createdAt, table.id),
	],
);

// === file_attributions ===
// Records every file modification attributed to a narrator/subagent (or an
// external/terminal change). Keyed by normalized workspace path so it works
// for chapters AND standalone narrators sharing the same directory. Powers the
// "who changed this file" timeline in the Git panel.
export const fileAttributions = sqliteTable(
	"file_attributions",
	{
		id: text("id").primaryKey(),
		/** "local" or the remote_devices.id where the modification occurred. */
		deviceId: text("device_id").notNull().default("local"),
		/** Normalized absolute workspace path (forward slashes, platform-folded). */
		workspacePath: text("workspace_path").notNull(),
		/** Repo-relative file path as reported by git / the tool input. */
		filePath: text("file_path").notNull(),
		/** Narrator that performed the change. Null for purely external edits. */
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "set null" }),
		/**
		 * User who performed the change, for `action: "human"`.
		 *
		 * Null for every agent and external action — those have no human author, and
		 * `narratorId` already identifies the session. Set ONLY for an edit a person made
		 * through NarraFork's own editor, which is the one case where "who did this" is a
		 * user rather than a narrator. Without it a shared worktree cannot tell two
		 * people's edits apart, since a human edit carries no narratorId either.
		 *
		 * `set null` on delete, like `narratorId`: losing the author is preferable to
		 * losing the record that the file changed at all.
		 */
		userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
		/** Subagent type if the narrator was a subagent (explore/plan/general/review/...). */
		subagentType: text("subagent_type"),
		/**
		 * How the change was made.
		 *
		 * `human` is a person editing through NarraFork's own editor. It is deliberately
		 * NOT `external`: external means "something outside this platform wrote here, and
		 * we only inferred it from a tree diff", whereas a human edit is a request this
		 * server served, with a known author, a known path and a known window. Collapsing
		 * the two would render a user's own save as an anonymous foreign change.
		 */
		action: text("action", {
			enum: ["write", "edit", "bash", "external", "human"],
		}).notNull(),
		/** Tool name that produced the change (Write/Edit/Bash), if any. */
		toolName: text("tool_name"),
		/** Tool-use id linking back to narrator_tool_calls, if any. */
		toolUseId: text("tool_use_id"),
		/** v2 projection links; NULL keeps legacy observations explicitly unverified. */
		operationId: text("operation_id").references(() => fileChangeOperations.id, {
			onDelete: "set null",
		}),
		effectId: text("effect_id").references(() => fileChangeEffects.id, { onDelete: "set null" }),
		scopeId: text("scope_id").references(() => fileChangeScopes.id, { onDelete: "set null" }),
		fileKey: text("file_key"),
		actorSubjectKey: text("actor_subject_key"),
		actorSnapshotJson: text("actor_snapshot_json", { mode: "json" }).$type<FileChangeActor>(),
		attributionGrade: text("attribution_grade", {
			enum: ["measured", "observed_ambiguous", "unknown"],
		}),
		/**
		 * Lines added / removed by THIS modification.
		 *
		 * ⚠️ NULL means UNMEASURED, never zero. Four sources of NULL:
		 *   - the diff exceeded its compute budget (see `countDiffLineStats`)
		 *   - the file is binary
		 *   - the change came from Bash (a shell command's per-file line delta is
		 *     not knowable from the tool input)
		 *   - the row predates this column (~54.6k existing write/edit rows)
		 *
		 * Readers MUST count the NULLs and say so, rather than letting `SUM` quietly
		 * skip them: a total that omits half its inputs looks exactly like a complete
		 * one. `0` is reserved for a real measurement of "changed no lines".
		 *
		 * The figures are CUMULATIVE per row; summing rows for one file yields churn
		 * across edits, not the net difference from the original content.
		 */
		linesAdded: integer("lines_added"),
		linesRemoved: integer("lines_removed"),
		changedAt: text("changed_at").notNull(),
	},
	(table) => [
		index("idx_file_attr_workspace_file").on(table.workspacePath, table.filePath, table.changedAt),
		index("idx_file_attr_device_workspace_file").on(
			table.deviceId,
			table.workspacePath,
			table.filePath,
			table.changedAt,
		),
		index("idx_file_attr_narrator").on(table.narratorId),
		index("idx_file_attr_workspace").on(table.workspacePath, table.changedAt),
		uniqueIndex("idx_file_attr_effect").on(table.effectId),
		index("idx_file_attr_operation").on(table.operationId),
		index("idx_file_attr_scope_file").on(table.scopeId, table.fileKey, table.changedAt, table.id),
		check(
			"ck_file_attr_line_counts",
			sql`
			(${table.linesAdded} IS NULL OR (typeof(${table.linesAdded}) = 'integer' AND ${table.linesAdded} >= 0))
			AND (${table.linesRemoved} IS NULL OR (typeof(${table.linesRemoved}) = 'integer' AND ${table.linesRemoved} >= 0))
		`,
		),
	],
);

// === file change evidence v2 ===
// Scope identity survives reconnects; execution generations belong to individual
// operation bindings. Never cascade-delete evidence with a narrator or worktree.
export const fileChangeScopes = sqliteTable(
	"file_change_scopes",
	{
		id: text("id").primaryKey(),
		sourceInstanceId: text("source_instance_id").notNull(),
		deviceId: text("device_id").notNull(),
		workspaceInstanceId: text("workspace_instance_id").notNull(),
		canonicalRoot: text("canonical_root").notNull(),
		displayRoot: text("display_root").notNull(),
		pathFlavor: text("path_flavor", { enum: ["posix", "windows"] }).notNull(),
		status: text("status", { enum: ["active", "retired", "needs_verification"] })
			.notNull()
			.default("needs_verification"),
		rootIdentityJson: text("root_identity_json", { mode: "json" }).$type<Record<string, string>>(),
		revision: integer("revision").notNull().default(0),
		fencingToken: integer("fencing_token").notNull().default(0),
		/** Durable admission barrier, separate from root identity verification. */
		activeLeaseId: text("active_lease_id"),
		activeLeaseEpoch: text("active_lease_epoch"),
		activeLeaseStartedAt: text("active_lease_started_at"),
		activeMutationCount: integer("active_mutation_count").notNull().default(0),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_fc_scope_instance").on(
			table.sourceInstanceId,
			table.deviceId,
			table.workspaceInstanceId,
		),
		index("idx_fc_scope_root").on(table.sourceInstanceId, table.deviceId, table.canonicalRoot),
		index("idx_fc_scope_status").on(table.status, table.updatedAt),
		index("idx_fc_scope_active_lease").on(table.deviceId, table.activeLeaseId, table.canonicalRoot),
	],
);

// Immutable process identity registered once per newly-created execution owner epoch.
// Missing/unknown identities are deliberately not backfilled from a later process.
export const workspaceExecutionOwners = sqliteTable("workspace_execution_owners", {
	ownerEpoch: text("owner_epoch").primaryKey(),
	identityJson: text("identity_json", { mode: "json" }).$type<unknown>(),
	createdAt: text("created_at").notNull(),
});

// A scope is stable identity; each execution retains its own immutable physical ranges.
// No TTL can release executing/quarantined work. Settled records are pruned in bounded batches.
export const workspaceWriteLeases = sqliteTable(
	"workspace_write_leases",
	{
		leaseId: text("lease_id").primaryKey(),
		scopeId: text("scope_id")
			.notNull()
			.references(() => fileChangeScopes.id),
		deviceId: text("device_id").notNull(),
		ownerEpoch: text("owner_epoch").notNull(),
		executionClass: text("execution_class", { enum: ["local_file_io", "unknown"] })
			.notNull()
			.default("unknown"),
		runtimeEpoch: text("runtime_epoch").notNull(),
		runtimeGeneration: integer("runtime_generation").notNull(),
		fencingToken: integer("fencing_token").notNull(),
		scopeRevision: integer("scope_revision").notNull(),
		pathFlavor: text("path_flavor", { enum: ["posix", "windows"] }).notNull(),
		status: text("status", {
			enum: ["executing", "quarantined", "settled", "recovered"],
		}).notNull(),
		rangesJson: text("ranges_json", { mode: "json" })
			.$type<{
				version: 1;
				ranges: readonly { kind: "file" | "subtree"; canonicalPath: string }[];
			}>()
			.notNull(),
		mutationManifestJson: text("mutation_manifest_json", { mode: "json" })
			.$type<{
				version: 1;
				mutations: readonly {
					mutationId: string;
					effectId?: string;
					operationId?: string;
					outcome: "pending" | "applied" | "not_applied" | "unknown";
				}[];
			}>()
			.notNull(),
		executionEndedAt: text("execution_ended_at"),
		terminationEvidenceJson: text("termination_evidence_json", { mode: "json" }).$type<{
			version: 1;
			kind: "owner_ended";
			ownerEpoch: string;
			reason: string;
			observedAt: string;
		}>(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_workspace_lease_device_status").on(table.deviceId, table.status, table.leaseId),
		index("idx_workspace_lease_scope").on(table.scopeId, table.status, table.leaseId),
		index("idx_workspace_lease_cleanup").on(table.status, table.updatedAt, table.leaseId),
		index("idx_workspace_lease_owner").on(table.ownerEpoch, table.leaseId),
	],
);

// Human-driven external recovery of a quarantined scope: one row per recovery,
// recording WHO accepted WHICH re-observed physical state to close the books.
// Audit only; it never rewrites the frozen execution receipts it refers to.
export const fileChangeScopeRecoveries = sqliteTable(
	"file_change_scope_recoveries",
	{
		id: text("id").primaryKey(),
		/** Immutable audit reference; terminal lease pruning must not delete the audit. */
		workspaceLeaseId: text("workspace_lease_id"),
		resolutionAuthority: text("resolution_authority", {
			enum: ["execution_proven", "administrator_attested", "system_reconciled"],
		})
			.notNull()
			.default("execution_proven"),
		/** Explicit maintenance evidence; never interpreted as OS process-death proof. */
		maintenanceEvidenceJson: text("maintenance_evidence_json", { mode: "json" }).$type<{
			version: 1;
			mode: "legacy_owner_offline";
			oldOwnerEpoch: string | null;
			operatorReason: string;
			maintenanceAuthority: "exclusive_instance_lock";
			generation: string;
			attestedAt: string;
		}>(),
		scopeId: text("scope_id")
			.notNull()
			.references(() => fileChangeScopes.id),
		deviceId: text("device_id").notNull(),
		canonicalRoot: text("canonical_root").notNull(),
		pathFlavor: text("path_flavor", { enum: ["posix", "windows"] }).notNull(),
		recoveredByUserId: text("recovered_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		effectDecisionsJson: text("effect_decisions_json", { mode: "json" })
			.$type<FileChangeRecoveryDecision[]>()
			.notNull(),
		scopeRevisionBefore: integer("scope_revision_before").notNull(),
		fencingTokenBefore: integer("fencing_token_before").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_fc_scope_recovery_scope").on(table.scopeId, table.createdAt)],
);

// Metadata only. Raw bodies live in file-change-blobs; expired rows remain as
// tombstones so a missing object cannot be mistaken for an absent user file.
export const fileChangeBlobs = sqliteTable(
	"file_change_blobs",
	{
		id: text("id").primaryKey(),
		digest: text("digest").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		storageKey: text("storage_key").notNull(),
		status: text("status", { enum: ["staging", "ready", "expired", "missing"] })
			.notNull()
			.default("staging"),
		leaseUntil: text("lease_until"),
		gcGeneration: integer("gc_generation").notNull().default(0),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_fc_blob_digest").on(table.digest),
		index("idx_fc_blob_gc").on(table.status, table.leaseUntil, table.updatedAt),
	],
);

// Scalar admission counters avoid SUM over the whole blob catalog in a write
// request. Startup reconciliation owns the transition from unverified to ready.
export const fileChangeStorageBudgets = sqliteTable(
	"file_change_storage_budgets",
	{
		id: text("id").primaryKey(),
		namespaceKey: text("namespace_key").notNull(),
		status: text("status", { enum: ["unverified", "reconciling", "ready"] })
			.notNull()
			.default("unverified"),
		usedBytes: integer("used_bytes").notNull().default(0),
		reservedBytes: integer("reserved_bytes").notNull().default(0),
		quotaBytes: integer("quota_bytes").notNull(),
		generation: integer("generation").notNull().default(0),
		reconciledAt: text("reconciled_at"),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [uniqueIndex("idx_fc_storage_namespace").on(table.namespaceKey)],
);

export const fileChangeBlobReservations = sqliteTable(
	"file_change_blob_reservations",
	{
		id: text("id").primaryKey(),
		budgetId: text("budget_id")
			.notNull()
			.references(() => fileChangeStorageBudgets.id),
		ownerEpoch: text("owner_epoch").notNull(),
		generation: integer("generation").notNull().default(0),
		expectedSize: integer("expected_size").notNull(),
		status: text("status", { enum: ["reserved", "settled", "reconcile_required"] })
			.notNull()
			.default("reserved"),
		blobDigest: text("blob_digest").references(() => fileChangeBlobs.digest),
		published: integer("published", { mode: "boolean" }),
		createdAt: text("created_at").notNull(),
		settledAt: text("settled_at"),
	},
	(table) => [
		index("idx_fc_reservation_budget").on(table.budgetId, table.status, table.createdAt, table.id),
		index("idx_fc_reservation_owner").on(table.ownerEpoch, table.status),
		index("idx_fc_reservation_blob").on(table.blobDigest),
	],
);

// Global logical order; allocating a number never holds a transaction across file IO.
export const fileHistoryClock = sqliteTable("file_history_clock", {
	id: integer("id").primaryKey(),
	lastSeq: integer("last_seq").notNull().default(0),
});

// Invocation provenance survives removal of its displayed messages.
export const fileChangeExecutionSegments = sqliteTable(
	"file_change_execution_segments",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id").notNull(),
		parentSegmentId: text("parent_segment_id"),
		sourceToolCallId: text("source_tool_call_id"),
		sourceExecutionAttempt: integer("source_execution_attempt"),
		sourceInputId: text("source_input_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_fc_segment_source").on(table.sourceToolCallId, table.sourceExecutionAttempt),
		index("idx_fc_segment_parent").on(table.parentSegmentId),
		index("idx_fc_segment_narrator").on(table.narratorId),
		index("idx_fc_segment_input").on(table.narratorId, table.sourceInputId),
	],
);

export const fileChangeOperations = sqliteTable(
	"file_change_operations",
	{
		id: text("id").primaryKey(),
		journalSeq: integer("journal_seq"),
		executionSegmentId: text("execution_segment_id"),
		evidenceVersion: integer("evidence_version").notNull().default(2),
		sourceInstanceId: text("source_instance_id").notNull(),
		sourceKind: text("source_kind", {
			enum: ["tool", "editor", "background_task", "external", "git", "revert", "import"],
		}).notNull(),
		/** Immutable origin key, not a FK that disappears when history is removed. */
		sourceId: text("source_id").notNull(),
		attempt: integer("attempt").notNull(),
		/** Nullable only for pre-journal rows, which cannot authorize execution. */
		requestDigest: text("request_digest"),
		expectedEffectCount: integer("expected_effect_count"),
		preparedEffectCount: integer("prepared_effect_count").notNull().default(0),
		evidenceBytes: integer("evidence_bytes").notNull().default(0),
		settledEffectCount: integer("settled_effect_count").notNull().default(0),
		unresolvedEffectCount: integer("unresolved_effect_count").notNull().default(0),
		toolCallId: text("tool_call_id"),
		toolUseId: text("tool_use_id"),
		backgroundTaskId: text("background_task_id"),
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "set null" }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		actorSubjectKey: text("actor_subject_key").notNull(),
		actorJson: text("actor_json", { mode: "json" }).$type<FileChangeActor>().notNull(),
		initiatorSubjectKey: text("initiator_subject_key"),
		executionBindingJson: text("execution_binding_json", {
			mode: "json",
		}).$type<FileChangeExecutionBinding>(),
		executionOutcome: text("execution_outcome", {
			enum: ["running", "succeeded", "failed", "interrupted"],
		})
			.notNull()
			.default("running"),
		effectOutcome: text("effect_outcome", { enum: ["pending", "no_change", "changed", "unknown"] })
			.notNull()
			.default("pending"),
		settlement: text("settlement", {
			enum: ["preparing", "intent_durable", "applying", "settled", "reconcile_required"],
		})
			.notNull()
			.default("preparing"),
		attributionGrade: text("attribution_grade", {
			enum: ["measured", "observed_ambiguous", "unknown"],
		})
			.notNull()
			.default("unknown"),
		coverage: text("coverage", { enum: ["complete", "partial", "unavailable", "legacy_unknown"] })
			.notNull()
			.default("unavailable"),
		parentOperationId: text("parent_operation_id"),
		reason: text("reason"),
		leaseUntil: text("lease_until"),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_fc_operation_attempt").on(
			table.sourceInstanceId,
			table.sourceKind,
			table.sourceId,
			table.attempt,
		),
		index("idx_fc_operation_sequence").on(table.sourceInstanceId, table.journalSeq),
		index("idx_fc_operation_segment").on(table.executionSegmentId, table.journalSeq),
		index("idx_fc_operation_narrator").on(table.narratorId, table.startedAt, table.id),
		index("idx_fc_operation_actor").on(table.actorSubjectKey, table.startedAt, table.id),
		index("idx_fc_operation_pending").on(table.settlement, table.updatedAt, table.id),
		index("idx_fc_operation_task").on(table.backgroundTaskId, table.attempt),
		index("idx_fc_operation_parent").on(table.parentOperationId),
	],
);

export const fileChangeEffects = sqliteTable(
	"file_change_effects",
	{
		id: text("id").primaryKey(),
		operationId: text("operation_id")
			.notNull()
			.references(() => fileChangeOperations.id),
		journalSeq: integer("journal_seq"),
		scopeId: text("scope_id")
			.notNull()
			.references(() => fileChangeScopes.id),
		fileKey: text("file_key").notNull(),
		identityJson: text("identity_json", { mode: "json" }).$type<FileChangeIdentity>().notNull(),
		scopeRevision: integer("scope_revision").notNull(),
		mutationId: text("mutation_id").notNull(),
		requestDigest: text("request_digest").notNull(),
		phase: text("phase", { enum: ["apply", "compensate"] }).notNull(),
		beforeStateJson: text("before_state_json", { mode: "json" }).$type<FileChangeState>().notNull(),
		intendedAfterStateJson: text("intended_after_state_json", { mode: "json" })
			.$type<FileChangeState>()
			.notNull(),
		observedAfterStateJson: text("observed_after_state_json", { mode: "json" })
			.$type<FileChangeState>()
			.notNull(),
		/** Reverse indexes for marking; these must agree with the typed state refs. */
		beforeBlobDigest: text("before_blob_digest").references(() => fileChangeBlobs.digest),
		intendedAfterBlobDigest: text("intended_after_blob_digest").references(
			() => fileChangeBlobs.digest,
		),
		observedAfterBlobDigest: text("observed_after_blob_digest").references(
			() => fileChangeBlobs.digest,
		),
		outcome: text("outcome", { enum: ["pending", "no_change", "changed", "unknown"] })
			.notNull()
			.default("pending"),
		settlement: text("settlement", {
			enum: ["preparing", "intent_durable", "applying", "settled", "reconcile_required"],
		})
			.notNull()
			.default("preparing"),
		attributionGrade: text("attribution_grade", {
			enum: ["measured", "observed_ambiguous", "unknown"],
		})
			.notNull()
			.default("unknown"),
		/** Durable confidence cap across receipt reconciliation; null means not recorded. */
		attributionCeiling: text("attribution_ceiling", {
			enum: ["measured", "observed_ambiguous", "unknown"],
		}),
		executionConfirmed: integer("execution_confirmed", { mode: "boolean" })
			.notNull()
			.default(false),
		executionReceiptJson: text("execution_receipt_json", {
			mode: "json",
		}).$type<FileChangeExecutionReceipt>(),
		executionReceiptDigest: text("execution_receipt_digest"),
		linesAdded: integer("lines_added"),
		linesRemoved: integer("lines_removed"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_fc_effect_mutation").on(table.mutationId),
		uniqueIndex("idx_fc_effect_operation_file").on(table.operationId, table.fileKey, table.phase),
		index("idx_fc_effect_file").on(table.scopeId, table.fileKey, table.scopeRevision, table.id),
		index("idx_fc_effect_pending").on(table.settlement, table.updatedAt),
		index("idx_fc_effect_before_blob").on(table.beforeBlobDigest),
		index("idx_fc_effect_intended_blob").on(table.intendedAfterBlobDigest),
		index("idx_fc_effect_observed_blob").on(table.observedAfterBlobDigest),
	],
);

// A scan receipt is NOT deduplicated by treeHash: identical trees can come from
// different scopes, policies, interrupted scans, or uncoordinated observations.
export const snapshotCaptures = sqliteTable(
	"snapshot_captures",
	{
		id: text("id").primaryKey(),
		scopeId: text("scope_id")
			.notNull()
			.references(() => fileChangeScopes.id),
		operationId: text("operation_id").references(() => fileChangeOperations.id),
		treeHash: text("tree_hash"),
		snapshotCommitSha: text("snapshot_commit_sha"),
		coverage: text("coverage", { enum: ["complete", "partial", "unavailable", "legacy_unknown"] })
			.notNull()
			.default("unavailable"),
		temporalConsistency: text("temporal_consistency", {
			enum: ["platform_quiescent", "concurrent_observation", "unknown"],
		})
			.notNull()
			.default("unknown"),
		policyVersion: integer("policy_version").notNull(),
		ignorePolicyDigest: text("ignore_policy_digest"),
		manifestBlobDigest: text("manifest_blob_digest").references(() => fileChangeBlobs.digest),
		omittedCount: integer("omitted_count"),
		reason: text("reason"),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
	},
	(table) => [
		index("idx_snapshot_capture_scope").on(table.scopeId, table.startedAt, table.id),
		index("idx_snapshot_capture_tree").on(table.scopeId, table.treeHash),
		index("idx_snapshot_capture_operation").on(table.operationId),
		index("idx_snapshot_capture_manifest").on(table.manifestBlobDigest),
	],
);

export const revertOperations = sqliteTable(
	"revert_operations",
	{
		id: text("id").primaryKey(),
		protocolVersion: integer("protocol_version").notNull().default(2),
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "set null" }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		requestedBySubjectKey: text("requested_by_subject_key").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestDigest: text("request_digest").notNull(),
		kind: text("kind", {
			enum: ["revert", "unrevert", "history_delete", "rollback_to_block", "edit_regenerate"],
		}).notNull(),
		scope: text("scope", { enum: ["narrator", "workspace"] }).notNull(),
		selectorKind: text("selector_kind", {
			enum: ["all", "from_seq", "messages", "tool_calls", "after_block"],
		}).notNull(),
		selectorBlobDigest: text("selector_blob_digest").references(() => fileChangeBlobs.digest),
		planBlobDigest: text("plan_blob_digest").references(() => fileChangeBlobs.digest),
		historyManifestBlobDigest: text("history_manifest_blob_digest").references(
			() => fileChangeBlobs.digest,
		),
		planHash: text("plan_hash"),
		expectedMessageVersion: integer("expected_message_version"),
		parentRevertId: text("parent_revert_id"),
		status: text("status", {
			enum: [
				"planned",
				"prepared",
				"applying",
				"files_verified",
				"committed",
				"compensating",
				"compensated",
				"recovery_required",
				"cancelled",
				"expired",
			],
		})
			.notNull()
			.default("planned"),
		fileCount: integer("file_count").notNull().default(0),
		appliedFileCount: integer("applied_file_count").notNull().default(0),
		coverageComplete: integer("coverage_complete", { mode: "boolean" }).notNull().default(false),
		reason: text("reason"),
		expiresAt: text("expires_at").notNull(),
		leaseUntil: text("lease_until"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_revert_operation_request").on(
			table.requestedBySubjectKey,
			table.idempotencyKey,
		),
		index("idx_revert_operation_narrator").on(table.narratorId, table.createdAt, table.id),
		index("idx_revert_operation_pending").on(table.status, table.updatedAt, table.id),
		index("idx_revert_operation_owner_pending").on(
			table.requestedBySubjectKey,
			table.narratorId,
			table.projectId,
			table.status,
			table.updatedAt,
			table.id,
		),
		index("idx_revert_operation_parent").on(table.parentRevertId),
		index("idx_revert_operation_plan_blob").on(table.planBlobDigest),
		index("idx_revert_operation_selector_blob").on(table.selectorBlobDigest),
		index("idx_revert_operation_history_blob").on(table.historyManifestBlobDigest),
	],
);

export const revertOperationFiles = sqliteTable(
	"revert_operation_files",
	{
		id: text("id").primaryKey(),
		revertOperationId: text("revert_operation_id")
			.notNull()
			.references(() => revertOperations.id),
		scopeId: text("scope_id")
			.notNull()
			.references(() => fileChangeScopes.id),
		fileKey: text("file_key").notNull(),
		identityJson: text("identity_json", { mode: "json" }).$type<FileChangeIdentity>().notNull(),
		sequence: integer("sequence").notNull(),
		expectedStateJson: text("expected_state_json", { mode: "json" })
			.$type<FileChangeState>()
			.notNull(),
		desiredStateJson: text("desired_state_json", { mode: "json" })
			.$type<FileChangeState>()
			.notNull(),
		observedAfterStateJson: text("observed_after_state_json", {
			mode: "json",
		}).$type<FileChangeState>(),
		beforeBlobDigest: text("before_blob_digest").references(() => fileChangeBlobs.digest),
		desiredBlobDigest: text("desired_blob_digest").references(() => fileChangeBlobs.digest),
		observedAfterBlobDigest: text("observed_after_blob_digest").references(
			() => fileChangeBlobs.digest,
		),
		/** Compensation cannot replace or unpin the original apply observation. */
		compensationAfterStateJson: text("compensation_after_state_json", {
			mode: "json",
		}).$type<FileChangeState>(),
		compensationAfterBlobDigest: text("compensation_after_blob_digest").references(
			() => fileChangeBlobs.digest,
		),
		applyMutationId: text("apply_mutation_id").notNull(),
		applyRequestDigest: text("apply_request_digest").notNull(),
		compensateMutationId: text("compensate_mutation_id").notNull(),
		compensateRequestDigest: text("compensate_request_digest").notNull(),
		status: text("status", {
			enum: [
				"prepared",
				"applying",
				"applied",
				"verified",
				"compensating",
				"compensated",
				"unknown",
			],
		})
			.notNull()
			.default("prepared"),
		receiptJson: text("receipt_json", { mode: "json" }).$type<
			FileChangeRevertMutationJournal | Record<string, string | number | boolean | null>
		>(),
		reason: text("reason"),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_revert_file_identity").on(table.revertOperationId, table.fileKey),
		uniqueIndex("idx_revert_file_apply").on(table.applyMutationId),
		uniqueIndex("idx_revert_file_compensate").on(table.compensateMutationId),
		index("idx_revert_file_pending").on(table.revertOperationId, table.status, table.sequence),
		index("idx_revert_file_before_blob").on(table.beforeBlobDigest),
		index("idx_revert_file_desired_blob").on(table.desiredBlobDigest),
		index("idx_revert_file_observed_blob").on(table.observedAfterBlobDigest),
		index("idx_revert_file_compensation_blob").on(table.compensationAfterBlobDigest),
	],
);

// Rebuildable query projections. Completeness is explicit; a limited sample does
// not authorize a precise count, author claim, or automatic file rollback.
export const fileChangeRollups = sqliteTable(
	"file_change_rollups",
	{
		id: text("id").primaryKey(),
		scopeId: text("scope_id")
			.notNull()
			.references(() => fileChangeScopes.id),
		fileKey: text("file_key").notNull(),
		actorSubjectKey: text("actor_subject_key").notNull(),
		projectionKind: text("projection_kind", { enum: ["history", "current", "attempt"] }).notNull(),
		attemptKey: text("attempt_key").notNull().default(""),
		changeCount: integer("change_count").notNull().default(0),
		linesAdded: integer("lines_added").notNull().default(0),
		linesRemoved: integer("lines_removed").notNull().default(0),
		unmeasuredCount: integer("unmeasured_count").notNull().default(0),
		hasExternalChange: integer("has_external_change", { mode: "boolean" }).notNull().default(false),
		hasImpreciseAttribution: integer("has_imprecise_attribution", { mode: "boolean" })
			.notNull()
			.default(true),
		complete: integer("complete", { mode: "boolean" }).notNull().default(false),
		asOfRevision: integer("as_of_revision"),
		lastEffectId: text("last_effect_id").references(() => fileChangeEffects.id),
		headFingerprint: text("head_fingerprint"),
		indexFingerprint: text("index_fingerprint"),
		worktreeFingerprint: text("worktree_fingerprint"),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_fc_rollup_dimension").on(
			table.scopeId,
			table.fileKey,
			table.actorSubjectKey,
			table.projectionKind,
			table.attemptKey,
		),
		index("idx_fc_rollup_actor").on(
			table.actorSubjectKey,
			table.projectionKind,
			table.updatedAt,
			table.id,
		),
		index("idx_fc_rollup_effect").on(table.lastEffectId),
	],
);

// === knowledge_collections ===
// Knowledge base namespace/grouping. Project-scoped (projectId set) or global (null).
export const knowledgeCollections = sqliteTable(
	"knowledge_collections",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		/**
		 * Whether reaching this collection additionally requires membership of its
		 * project.
		 *
		 * Opt-in, and false for every collection that predates project ACLs: those were
		 * created when any signed-in user could reach any project, so switching the gate
		 * on during a migration would silently hide readable content — and "content
		 * stopped appearing" is the hardest kind of regression to notice. New
		 * project-scoped collections default to true. Meaningless when projectId is null.
		 */
		inheritProjectGate: integer("inherit_project_gate", { mode: "boolean" })
			.notNull()
			.default(true),
		// Default classification level (knowledge_levels.name) inherited by entries; public = no clearance gate.
		defaultLevel: text("default_level").notNull().default("public"),
		// Classification level (knowledge_levels.name) gating access to the COLLECTION itself;
		// null = public (no clearance gate). Distinct from defaultLevel: defaultLevel is the
		// fallback an entry inherits when it has no own level, while classificationLevel is the
		// gate to read/enter the collection at all.
		classificationLevel: text("classification_level"),
		// Controlled tag ids (knowledge_tags where controlled=true) required to access the collection
		// (compartment axis). A principal must hold every one of these to read the collection.
		controlledTagsJson: text("controlled_tags_json", { mode: "json" }),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kc_project_slug").on(table.projectId, table.slug),
		index("idx_kc_project").on(table.projectId),
		// FK covering index for user deletion.
		index("idx_kc_owner_user").on(table.ownerUserId),
	],
);

// === knowledge_entries ===
// A stable knowledge item: metadata + pointer to current revision + redundant current content (for FTS).
export const knowledgeEntries = sqliteTable(
	"knowledge_entries",
	{
		id: text("id").primaryKey(),
		collectionId: text("collection_id")
			.notNull()
			.references(() => knowledgeCollections.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		slug: text("slug").notNull(),
		// Points to the latest revision (copy-on-write history lives in knowledge_revisions).
		currentRevisionId: text("current_revision_id"),
		// Redundant copy of the current revision's body, maintained by the service layer on addRevision.
		// FTS triggers read this column so they don't need to join the revisions table.
		currentContent: text("current_content"),
		// Space-joined mirror of keywordsJson, maintained by the service layer alongside the entry.
		// FTS triggers read this column to index the `keywords` column without touching the JSON.
		currentKeywords: text("current_keywords"),
		// MVP: tags stored as a JSON string[] on the entry (no separate tag table yet).
		tagsJson: text("tags_json", { mode: "json" }),
		// Author-declared keywords (string[]) that drive PASSIVE auto-injection: an entry is
		// surfaced only when one of these keywords appears in the user message / tool output.
		// Empty/absent → never auto-injected (still findable via the KnowledgeSearch tool).
		keywordsJson: text("keywords_json", { mode: "json" }),
		metadataJson: text("metadata_json", { mode: "json" }),
		// Classification level (knowledge_levels.name); null = inherit collection.defaultLevel.
		classificationLevel: text("classification_level"),
		// Controlled tag ids (knowledge_tags where controlled=true) required to read this entry (compartment axis).
		controlledTagsJson: text("controlled_tags_json", { mode: "json" }),
		// Tag ids a reviewer must hold (via review grant) to review changes to this entry.
		reviewTagsJson: text("review_tags_json", { mode: "json" }),
		// Entry owner — may write to main directly and may review.
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_ke_collection_slug").on(table.collectionId, table.slug),
		index("idx_ke_collection").on(table.collectionId),
		index("idx_ke_status").on(table.status),
		// Covers listEntries: filter by collection_id, sort by updated_at DESC.
		index("idx_ke_collection_updated").on(table.collectionId, table.updatedAt),
		// FK covering index for user deletion.
		index("idx_ke_owner_user").on(table.ownerUserId),
	],
);

// === knowledge_revisions ===
// Immutable copy-on-write body snapshots. Each edit appends a new revision.
export const knowledgeRevisions = sqliteTable(
	"knowledge_revisions",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		// Monotonically increasing per-entry version (service computes max+1 in a transaction).
		version: integer("version").notNull(),
		format: text("format", { enum: ["markdown", "text", "json"] })
			.notNull()
			.default("markdown"),
		content: text("content").notNull(),
		contentHash: text("content_hash").notNull(),
		changeNote: text("change_note"),
		authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
		// When this revision was produced by merging a reviewed draft, the draft's fork point
		// (the main revision it was based on). null = direct main write.
		baseRevisionId: text("base_revision_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kr_entry_version").on(table.entryId, table.version),
		index("idx_kr_entry").on(table.entryId),
		// FK covering index for user deletion.
		index("idx_kr_author_user").on(table.authorUserId),
	],
);

// === knowledge_injection_events ===
// Persistent ledger for passive knowledge hints injected into narrator context. The unique
// key enforces compact-cycle de-dup across process restarts; compact_seq is the latest compact
// marker seq at injection time, or -1 before the first compact.
export const knowledgeInjectionEvents = sqliteTable(
	"knowledge_injection_events",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		compactSeq: integer("compact_seq").notNull(),
		entryId: text("entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		entryRevisionId: text("entry_revision_id").references(() => knowledgeRevisions.id, {
			onDelete: "set null",
		}),
		source: text("source", {
			enum: ["user_message", "tool_output", "system_continuation"],
		}).notNull(),
		triggerMessageId: text("trigger_message_id").references(() => narratorMessages.id, {
			onDelete: "set null",
		}),
		triggerToolCallId: text("trigger_tool_call_id").references(() => narratorToolCalls.id, {
			onDelete: "set null",
		}),
		summary: text("summary"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kie_cycle_entry").on(table.narratorId, table.compactSeq, table.entryId),
		index("idx_kie_narrator_cycle").on(table.narratorId, table.compactSeq),
		index("idx_kie_entry").on(table.entryId),
		// FK covering indexes: both parents (narrator_messages / narrator_tool_calls) are
		// deleted in bulk during rollback, and each deleted row would otherwise scan this table.
		index("idx_kie_trigger_message").on(table.triggerMessageId),
		index("idx_kie_trigger_tool_call").on(table.triggerToolCallId),
		// FK covering index for knowledge-revision deletion.
		index("idx_kie_entry_revision").on(table.entryRevisionId),
	],
);

// === knowledge_drafts ===
// Per-user working copy forked from an entry's current revision. Edited privately; the
// global (main) revision is untouched until a submission is reviewed and merged.
export const knowledgeDrafts = sqliteTable(
	"knowledge_drafts",
	{
		id: text("id").primaryKey(),
		// Linked personal entry → references a global entry (the user's personal version of it,
		// drift applies). NULL → a STANDALONE personal entry (no global counterpart yet).
		entryId: text("entry_id").references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		authorUserId: text("author_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name"),
		// Own title for a standalone entry; NULL for a linked entry (inherits the global entry title).
		title: text("title"),
		// Standalone-only: which collection this entry is published into. Optional at create time,
		// required before publish. NULL for linked entries (they target their existing entry).
		targetCollectionId: text("target_collection_id").references(() => knowledgeCollections.id, {
			onDelete: "set null",
		}),
		// The main revision this draft was forked from (three-way merge base). Linked entries only.
		baseRevisionId: text("base_revision_id"),
		// Author-declared keywords for a STANDALONE personal entry (string[]). Carried through to
		// the global entry on publish (approveStandalone). Linked entries inherit the global
		// entry's keywords, so this stays null for them.
		keywordsJson: text("keywords_json", { mode: "json" }),
		content: text("content").notNull(),
		contentHash: text("content_hash").notNull(),
		format: text("format", { enum: ["markdown", "text", "json"] })
			.notNull()
			.default("markdown"),
		// Personal-entry lifecycle (the "draft" concept is retired): the publish-request
		// lifecycle now lives on knowledge_submissions. `active` = in use (participates in
		// shadow/drift/search); `archived` = retired (e.g. after a successful publish), kept
		// for the record but no longer shadows.
		status: text("status", {
			enum: ["active", "archived"],
		})
			.notNull()
			.default("active"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_kd_entry_author").on(table.entryId, table.authorUserId),
		index("idx_kd_entry").on(table.entryId),
		index("idx_kd_author").on(table.authorUserId),
		// FK covering index for knowledge-collection deletion.
		index("idx_kd_target_collection").on(table.targetCollectionId),
	],
);

// === knowledge_submissions ===
// A personal entry submitted to be PUBLISHED into the global knowledge base. Carries the
// proposed content + reviewer verdict + merge result. This is the publish-request lifecycle.
export const knowledgeSubmissions = sqliteTable(
	"knowledge_submissions",
	{
		id: text("id").primaryKey(),
		draftId: text("draft_id")
			.notNull()
			.references(() => knowledgeDrafts.id, { onDelete: "cascade" }),
		// Target global entry for a LINKED personal entry (publish = merge into it). NULL when
		// publishing a STANDALONE personal entry — a new global entry is created on approve.
		entryId: text("entry_id").references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		// Standalone publish target: collection + title for the new global entry to be created.
		collectionId: text("collection_id").references(() => knowledgeCollections.id, {
			onDelete: "cascade",
		}),
		title: text("title"),
		submitterUserId: text("submitter_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "set null" }),
		baseRevisionId: text("base_revision_id"),
		proposedContent: text("proposed_content").notNull(),
		// Standalone publish only: keywords proposed for the new global entry, copied from the
		// draft at submit time and applied to the created entry on approveStandalone.
		keywordsJson: text("keywords_json", { mode: "json" }),
		changeNote: text("change_note"),
		// The submission this one re-submits after a `changes_requested` verdict. Lets a
		// reviewer see the revision round (`round` = 1 + rounds behind) instead of treating
		// each re-submit as an unrelated first proposal. NULL for a first-round submission.
		previousSubmissionId: text("previous_submission_id"),
		// 1 for a first submission; N for the Nth attempt in a resubmit chain.
		round: integer("round").notNull().default(1),
		// Lifecycle:
		//  - pending           → awaiting review
		//  - approved          → merged / published
		//  - rejected          → reviewer refused it for good (verdict `reject`). TERMINAL: no
		//                        resubmit, which is exactly what separates it from
		//                        changes_requested. The author's personal entry survives, so a
		//                        fresh proposal is still possible.
		//  - changes_requested → bounced back to the author (resubmit closes the loop)
		//  - conflict          → approve hit an unmergeable three-way merge; needs resolve
		//  - withdrawn         → the SUBMITTER pulled it back before a verdict
		//  - superseded        → auto-closed because the author edited/rebased the draft, so
		//                        the proposed content no longer matches (NOT a reviewer verdict)
		status: text("status", {
			enum: [
				"pending",
				"approved",
				"rejected",
				"changes_requested",
				"conflict",
				"withdrawn",
				"superseded",
			],
		})
			.notNull()
			.default("pending"),
		reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
		// `reject` is the terminal refusal, distinct from `request_changes` (which invites a
		// resubmit). See the `rejected` status above.
		verdict: text("verdict", { enum: ["approve", "request_changes", "reject", "comment_only"] }),
		findingsJson: text("findings_json", { mode: "json" }),
		reviewedAt: text("reviewed_at"),
		// The main revision produced when this submission was merged.
		mergedRevisionId: text("merged_revision_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_ks_entry").on(table.entryId),
		index("idx_ks_status").on(table.status),
		index("idx_ks_submitter").on(table.submitterUserId),
		// Covers listSubmissions sort (created_at DESC) under entry/status filters.
		index("idx_ks_entry_created").on(table.entryId, table.createdAt),
		index("idx_ks_status_created").on(table.status, table.createdAt),
		// FK covering indexes for user / collection / draft deletion.
		index("idx_ks_reviewer_user").on(table.reviewerUserId),
		index("idx_ks_collection").on(table.collectionId),
		index("idx_ks_draft").on(table.draftId),
	],
);

// === knowledge_levels ===
// Classification level ladder (etag axis). Higher rank = higher secrecy.
export const knowledgeLevels = sqliteTable(
	"knowledge_levels",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull().unique(),
		rank: integer("rank").notNull(),
		label: text("label"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [uniqueIndex("idx_klevel_rank").on(table.rank)],
);

// === knowledge_tag_types ===
// Categories for tags (e.g. organization / position / permission / other). Global, editable.
// Builtin types are seeded on startup and cannot be deleted.
export const knowledgeTagTypes = sqliteTable(
	"knowledge_tag_types",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull().unique(),
		builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_ktagtype_sort").on(table.sortOrder)],
);

// === knowledge_tags ===
// Tags. controlled=true tags act as access compartments (horizontal axis).
export const knowledgeTags = sqliteTable(
	"knowledge_tags",
	{
		id: text("id").primaryKey(),
		collectionId: text("collection_id").references(() => knowledgeCollections.id, {
			onDelete: "cascade",
		}),
		// Optional category (knowledge_tag_types.id). null = uncategorized.
		typeId: text("type_id").references(() => knowledgeTagTypes.id, { onDelete: "set null" }),
		name: text("name").notNull(),
		controlled: integer("controlled", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_ktag_collection_name").on(table.collectionId, table.name),
		index("idx_ktag_controlled").on(table.controlled),
		index("idx_ktag_type").on(table.typeId),
	],
);

// === knowledge_grants ===
// Credentials granted to a principal: clearance (level), tag (compartment), or review (per tag).
export const knowledgeGrants = sqliteTable(
	"knowledge_grants",
	{
		id: text("id").primaryKey(),
		collectionId: text("collection_id").references(() => knowledgeCollections.id, {
			onDelete: "cascade",
		}),
		principalType: text("principal_type", { enum: ["user", "role"] }).notNull(),
		principalId: text("principal_id").notNull(),
		grantType: text("grant_type", { enum: ["clearance", "tag", "review"] }).notNull(),
		// grantType=clearance → knowledge_levels.name (max readable rank)
		clearanceLevel: text("clearance_level"),
		// grantType=tag|review → knowledge_tags.id
		tagId: text("tag_id").references(() => knowledgeTags.id, { onDelete: "cascade" }),
		canWrite: integer("can_write", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_kgrant_principal").on(table.principalType, table.principalId),
		index("idx_kgrant_tag").on(table.tagId),
		// FK covering index for knowledge-collection deletion (ON DELETE CASCADE).
		index("idx_kgrant_collection").on(table.collectionId),
		// Business-level uniqueness: a principal cannot hold two identical grants.
		//
		// SQLite treats NULLs as distinct in a unique index, so one composite index over
		// (collectionId, principalType, principalId, grantType, tagId) would still admit
		// duplicates whenever either nullable column is NULL — which is exactly the common
		// case (global grants have no collectionId; clearance grants have no tagId). A
		// COALESCE expression index would express this in one line, but drizzle-kit
		// mis-generates the DDL for it, so the invariant is split across four partial
		// indexes covering each NULL combination. See narratorWhitelistDirs for the same
		// pattern applied to a single nullable column.
		uniqueIndex("idx_kgrant_unique_scoped_tagged")
			.on(table.collectionId, table.principalType, table.principalId, table.grantType, table.tagId)
			.where(sql`${table.collectionId} is not null and ${table.tagId} is not null`),
		uniqueIndex("idx_kgrant_unique_scoped_untagged")
			.on(table.collectionId, table.principalType, table.principalId, table.grantType)
			.where(sql`${table.collectionId} is not null and ${table.tagId} is null`),
		uniqueIndex("idx_kgrant_unique_global_tagged")
			.on(table.principalType, table.principalId, table.grantType, table.tagId)
			.where(sql`${table.collectionId} is null and ${table.tagId} is not null`),
		uniqueIndex("idx_kgrant_unique_global_untagged")
			.on(table.principalType, table.principalId, table.grantType)
			.where(sql`${table.collectionId} is null and ${table.tagId} is null`),
	],
);

// === knowledge_acl_events ===
// Append-only audit of knowledge AUTHORIZATION changes: who granted/revoked what, to whom, when.
//
// Why this exists: the knowledge base gates content by classification level + controlled tags, but
// every mutation of that gate (grants, per-user ACL replacement, entry/collection ACL edits,
// ownership transfers) used to leave no trace at all — "who gave this account access to the
// confidential compartment?" was unanswerable after the fact.
//
// Shape follows oauth_grant_events (the existing security-audit precedent): actor + target +
// event type + a small redacted detail blob. Deliberately NOT stored: entry titles, bodies, or
// anything that would turn the audit log into a way to read content you cannot access.
//
// No foreign keys on the actor/target ids: audit rows must survive deletion of the user, entry or
// collection they describe, which is the whole point of an audit trail.
export const knowledgeAclEvents = sqliteTable(
	"knowledge_acl_events",
	{
		id: text("id").primaryKey(),
		// Who performed the change (null = system/automated path).
		actorUserId: text("actor_user_id"),
		actorRole: text("actor_role"),
		// What kind of change. Kept as free text rather than an enum so a new ACL surface can be
		// audited without a migration; the writers use a fixed vocabulary
		// (grant_added / grant_removed / user_acl_replaced / entry_acl_updated /
		//  collection_acl_updated / entry_owner_transferred / collection_owner_transferred).
		eventType: text("event_type").notNull(),
		// Whom the change was ABOUT (the principal whose authority moved), when applicable.
		subjectType: text("subject_type", { enum: ["user", "role"] }),
		subjectId: text("subject_id"),
		// What the change was ON (an entry / collection / grant row), when applicable.
		targetType: text("target_type", { enum: ["entry", "collection", "grant"] }),
		targetId: text("target_id"),
		// Redacted detail: level NAMES and tag IDS only, never content. e.g.
		// { grantType, clearanceLevel, tagId, canWrite } or { before: {...}, after: {...} }.
		detailJson: text("detail_json", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		// Primary read pattern: newest first, optionally filtered. `id` breaks createdAt ties so
		// cursor pagination is stable.
		index("idx_kacl_events_created").on(table.createdAt, table.id),
		index("idx_kacl_events_subject").on(table.subjectType, table.subjectId, table.createdAt),
		index("idx_kacl_events_target").on(table.targetType, table.targetId, table.createdAt),
		index("idx_kacl_events_actor").on(table.actorUserId, table.createdAt),
		index("idx_kacl_events_type").on(table.eventType, table.createdAt),
	],
);

// === knowledge_entry_links ===
// Directed, typed associations between entries (the knowledge graph). This table models the
// entry-level scope only (A↔B whole-entry relations, declared by a human/agent). Inline (body
// position) references — scope=inline in the design — are not implemented yet.
export const knowledgeEntryLinks = sqliteTable(
	"knowledge_entry_links",
	{
		id: text("id").primaryKey(),
		// Source entry → target entry (directed).
		fromEntryId: text("from_entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		toEntryId: text("to_entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		// Relation type (generic, domain-agnostic):
		//   related     — see also / related (weak association)
		//   expands     — expands / details (from is overview, to is detail)
		//   supersedes  — from supersedes to (marks the old entry stale)
		//   depends_on  — depends on (understanding from needs to first)
		//   parent      — parent / belongs-to (from's parent is to)
		//   mention     — mention (reserved; inline default type, unused at entry scope)
		//   custom      — other, paired with label
		linkType: text("link_type", {
			enum: ["related", "expands", "supersedes", "depends_on", "parent", "mention", "custom"],
		}).notNull(),
		// Custom relation name (when linkType=custom) or supplementary note.
		label: text("label"),
		// Optional: pin the link to a specific target revision (stable reference); null = follow current.
		toRevisionId: text("to_revision_id").references(() => knowledgeRevisions.id, {
			onDelete: "set null",
		}),
		// Creator (user or programmatic agent).
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		// Entry scope: the same (from, to, type) triple is not duplicated.
		uniqueIndex("idx_kelink_entry_from_to_type").on(
			table.fromEntryId,
			table.toEntryId,
			table.linkType,
		),
		index("idx_kelink_from").on(table.fromEntryId), // forward: from's out-links
		index("idx_kelink_to").on(table.toEntryId), // reverse: to's in-links ("who links to me")
		// FK covering indexes for user / revision deletion.
		index("idx_kelink_created_by_user").on(table.createdByUserId),
		index("idx_kelink_to_revision").on(table.toRevisionId),
	],
);

// === knowledge_packs ===
// A pack is an archive (tar.gz/zip) bundling data, media, scripts and executables that an
// agent extracts into an isolated temp dir (granted via narrator_whitelist_dirs) to run a
// fixed-procedure operation alongside the knowledge base. A pack optionally links to a
// knowledge entry — when linked, its access/activation ACL is inherited from that entry's
// dual-axis attributes; otherwise the pack's own classificationLevel + controlledTags apply.
export const knowledgePacks = sqliteTable(
	"knowledge_packs",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		// Ownership: project-scoped (projectId set) or global (null), like knowledge_collections.
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		// Optional link to a knowledge entry — when set, the pack inherits that entry's dual-axis
		// ACL (classificationLevel + controlledTags). null → use the pack's own ACL fields below.
		entryId: text("entry_id").references(() => knowledgeEntries.id, { onDelete: "set null" }),
		// === Pack's own ACL (only used when entryId is null; semantics mirror knowledge_entries) ===
		classificationLevel: text("classification_level"), // null = public
		controlledTagsJson: text("controlled_tags_json", { mode: "json" }),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		// === Archive file metadata ===
		archiveFormat: text("archive_format", { enum: ["tar.gz", "zip"] }).notNull(),
		// Stored as <id>.<ext> under ~/.narrafork/pack-archives/. Service derives the path; the
		// absolute path is never persisted.
		archiveSize: integer("archive_size").notNull(),
		archiveHash: text("archive_hash").notNull(), // sha256: integrity / dedup / extract cache
		// Total uncompressed size for zip-bomb guard; probed at upload. null = unknown.
		uncompressedSize: integer("uncompressed_size"),
		// Optional PACK.md-style manifest returned to the agent on activation as usage notes.
		// { entrypoint?, files?, notes? }
		manifestJson: text("manifest_json", { mode: "json" }),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kpack_project_slug").on(table.projectId, table.slug),
		index("idx_kpack_project").on(table.projectId),
		index("idx_kpack_entry").on(table.entryId),
		index("idx_kpack_status").on(table.status),
		// FK covering index for user deletion.
		index("idx_kpack_owner_user").on(table.ownerUserId),
	],
);

// === knowledge_pack_activations ===
// An extraction instance: which narrator activated which pack, where it was extracted, and the
// whitelist row that grants access. Used for idempotent activation, cleanup and audit. The
// "at most one active activation per (narrator, pack)" rule is enforced in the service layer
// (mirrors how knowledge_drafts enforces one active draft per entry/author).
export const knowledgePackActivations = sqliteTable(
	"knowledge_pack_activations",
	{
		id: text("id").primaryKey(),
		packId: text("pack_id")
			.notNull()
			.references(() => knowledgePacks.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		// Absolute extraction dir (~/.narrafork/packs/<narratorId>/<packId>/).
		extractDir: text("extract_dir").notNull(),
		// The narrator_whitelist_dirs.id inserted for this activation, for precise removal.
		whitelistDirId: text("whitelist_dir_id"),
		// Archive hash at activation time — lets us detect a stale extract after the pack's
		// archive is replaced (prompt re-activation).
		archiveHash: text("archive_hash").notNull(),
		status: text("status", { enum: ["active", "released"] })
			.notNull()
			.default("active"),
		createdAt: text("created_at").notNull(),
		releasedAt: text("released_at"),
	},
	(table) => [
		index("idx_kpackact_narrator").on(table.narratorId),
		index("idx_kpackact_pack").on(table.packId),
		index("idx_kpackact_narrator_pack_status").on(table.narratorId, table.packId, table.status),
	],
);

// === scheduled tasks ===
// A scheduled task periodically starts a narrator with a preset prompt. The schedule is
// always stored as a cron expression (the UI may generate it from friendly presets). At
// each fire the scheduler either spawns a fresh standalone/chapter narrator or reuses an
// existing one, then injects `prompt` to auto-start its agent loop (unattended).
export const scheduledTasks = sqliteTable(
	"scheduled_tasks",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		// Cron expression (5 or 6 fields). Friendly UI presets are compiled to cron client-side.
		cronExpr: text("cron_expr").notNull(),
		// IANA timezone (e.g. "Asia/Shanghai"); null = server local time.
		timezone: text("timezone"),
		// The prompt injected into the narrator on each run.
		prompt: text("prompt").notNull(),
		// Optional system prompt for the spawned narrator.
		systemPrompt: text("system_prompt"),
		// Model id; null → follow default model.
		model: text("model"),
		// Permission mode for unattended execution; defaults to bypassPermissions.
		permissionMode: text("permission_mode").notNull().default("bypassPermissions"),
		locale: text("locale").$type<Locale>().notNull().default(DEFAULT_LOCALE),
		// Run environment: standalone (no chapter/git) or bound to a chapter's worktree.
		runContext: text("run_context", { enum: ["standalone", "chapter"] })
			.notNull()
			.default("standalone"),
		// standalone: working directory (null → home dir).
		cwd: text("cwd"),
		// chapter mode: target project + chapter.
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
		// Whether to spawn a fresh narrator each run or reuse the same one.
		narratorMode: text("narrator_mode", { enum: ["new", "reuse"] })
			.notNull()
			.default("new"),
		/** Opt-in, task-scoped destructive retention. Existing tasks remain unchanged. */
		cleanupPolicy: text("cleanup_policy", { mode: "json" })
			.$type<ScheduledTaskCleanupPolicy>()
			.notNull()
			.default({ mode: "none" }),
		// reuse mode: the narrator remembered across runs.
		reuseNarratorId: text("reuse_narrator_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: forward reference to narrators
			(): any => narrators.id,
			{ onDelete: "set null" },
		),
		// User who created the task (used as sendMessage userId + ACL provenance).
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		// Scheduling state.
		lastRunAt: text("last_run_at"),
		nextRunAt: text("next_run_at"),
		lastNarratorId: text("last_narrator_id"),
		lastStatus: text("last_status", { enum: ["success", "failed", "skipped"] }),
		lastError: text("last_error"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_scheduled_tasks_enabled").on(table.enabled),
		index("idx_scheduled_tasks_next_run").on(table.enabled, table.nextRunAt),
		index("idx_scheduled_tasks_project").on(table.projectId),
		// FK covering indexes for user / narrator / chapter deletion.
		index("idx_scheduled_tasks_created_by").on(table.createdBy),
		index("idx_scheduled_tasks_reuse_narrator").on(table.reuseNarratorId),
		index("idx_scheduled_tasks_last_narrator").on(table.lastNarratorId),
		index("idx_scheduled_tasks_chapter").on(table.chapterId),
	],
);

// === scheduled_task_runs (per-run history) ===
// One row per task execution (scheduled tick or manual trigger). Enables the task
// detail page to list every run with its outcome and the narrator it dispatched.
export const scheduledTaskRuns = sqliteTable(
	"scheduled_task_runs",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => scheduledTasks.id, { onDelete: "cascade" }),
		// The narrator this run created/used. Plain text (no FK) so archiving/deleting a
		// narrator never cascades into run history; the UI tolerates a missing narrator.
		narratorId: text("narrator_id"),
		status: text("status", { enum: ["success", "failed", "skipped"] }).notNull(),
		error: text("error"),
		// Run environment snapshot at dispatch time.
		runContext: text("run_context", { enum: ["standalone", "chapter"] }).notNull(),
		// Whether this run was triggered manually ("Run now") vs the cron schedule.
		manual: integer("manual", { mode: "boolean" }).notNull().default(false),
		startedAt: text("started_at"),
		finishedAt: text("finished_at"),
		durationMs: integer("duration_ms"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_scheduled_task_runs_task").on(table.taskId, table.createdAt),
		index("idx_scheduled_task_runs_narrator").on(table.narratorId),
	],
);

// === oauth_clients (NarraFork as an OAuth 2.0 authorization server) ===
/**
 * A registered third-party OAuth client (e.g. the robot assistant app) that
 * NarraFork users can grant access to. NarraFork is the provider here — this
 * table has nothing to do with the login-via-SSO (OIDC) feature.
 */
export const oauthClients = sqliteTable(
	"oauth_clients",
	{
		id: text("id").primaryKey(),
		/** Public client identifier sent as `client_id`. */
		clientId: text("client_id").notNull(),
		/** Display name shown on the consent screen. */
		name: text("name").notNull(),
		/** Registered redirect URI allow-list (JSON string array, exact match). */
		redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull().default([]),
		/** Scopes this client may request (JSON string array). */
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
		/** Grant types this client may use (JSON string array). */
		grantTypes: text("grant_types", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(["authorization_code", "refresh_token"]),
		/** Public clients hold no secret; they authenticate with PKCE. */
		publicClient: integer("public_client", { mode: "boolean" }).notNull().default(true),
		/** Client-wide authorization policy interpreted by the OAuth service. */
		policyJson: text("policy_json", { mode: "json" }).$type<Record<string, unknown>>(),
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		lastUsedAt: text("last_used_at"),
		/** Soft-revocation metadata; revoked clients reject every flow. */
		revokedAt: text("revoked_at"),
		revokedByUserId: text("revoked_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		revokedReason: text("revoked_reason"),
	},
	(table) => [
		uniqueIndex("idx_oauth_clients_client_id").on(table.clientId),
		// FK covering indexes for user deletion.
		index("idx_oauth_clients_created_by").on(table.createdBy),
		index("idx_oauth_clients_revoked_by_user").on(table.revokedByUserId),
	],
);

// === integration_authorities ===
// Durable authorization root shared by OAuth grants and plugin installations. The authority id
// is intentionally the OAuth grant id / plugin installation id so resource provenance can use one
// stable identifier without transport-specific ownership columns.
export const integrationAuthorities = sqliteTable(
	"integration_authorities",
	{
		id: text("id").primaryKey(),
		kind: text("kind", { enum: ["oauth_grant", "plugin_installation"] }).notNull(),
		integrationType: text("integration_type", { enum: ["oauth_client", "plugin"] }).notNull(),
		integrationId: text("integration_id").notNull(),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		sourceGrantId: text("source_grant_id"),
		state: text("state", { enum: ["active", "suspended", "revoked", "expired"] })
			.notNull()
			.default("active"),
		revision: integer("revision").notNull().default(1),
		policyJson: text("policy_json", { mode: "json" }).$type<Record<string, unknown>>(),
		metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
		expiresAt: text("expires_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		revokedAt: text("revoked_at"),
		revokedReason: text("revoked_reason"),
	},
	(table) => [
		index("idx_integration_authorities_integration").on(
			table.integrationType,
			table.integrationId,
			table.state,
			table.id,
		),
		index("idx_integration_authorities_owner").on(table.ownerUserId, table.state, table.id),
		index("idx_integration_authorities_expiry").on(table.state, table.expiresAt, table.id),
		uniqueIndex("idx_integration_authorities_source_grant")
			.on(table.sourceGrantId)
			.where(sql`${table.sourceGrantId} is not null`),
	],
);

// === integration_capability_grants ===
// Canonical capability + scope grants. OAuth scopes and plugin installation permissions both
// compile into these rows; authority revision invalidates every cached decision atomically.
export const integrationCapabilityGrants = sqliteTable(
	"integration_capability_grants",
	{
		id: text("id").primaryKey(),
		authorityId: text("authority_id")
			.notNull()
			.references(() => integrationAuthorities.id, { onDelete: "cascade" }),
		capabilityId: text("capability_id").notNull(),
		scopeType: text("scope_type").notNull(),
		scopeId: text("scope_id"),
		scopeKey: text("scope_key").notNull(),
		constraintsJson: text("constraints_json", { mode: "json" }).$type<Record<string, unknown>>(),
		expiresAt: text("expires_at"),
		revokedAt: text("revoked_at"),
		createdByType: text("created_by_type", { enum: ["user", "system"] }).notNull(),
		createdById: text("created_by_id"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_integration_capability_grants_active_scope")
			.on(table.authorityId, table.capabilityId, table.scopeKey)
			.where(sql`${table.revokedAt} is null`),
		index("idx_integration_capability_grants_authority").on(
			table.authorityId,
			table.capabilityId,
			table.revokedAt,
			table.expiresAt,
			table.id,
		),
	],
);

// === integration_audit_events ===
// Bounded, redacted integration security/operation audit. High-frequency delivery success is
// aggregated in memory; only control, denial, failure and bounded operation summaries are stored.
export const integrationAuditEvents = sqliteTable(
	"integration_audit_events",
	{
		id: text("id").primaryKey(),
		principalType: text("principal_type").notNull(),
		principalId: text("principal_id"),
		authorityId: text("authority_id"),
		credentialType: text("credential_type"),
		credentialId: text("credential_id"),
		transport: text("transport").notNull(),
		operationId: text("operation_id").notNull(),
		capabilityId: text("capability_id"),
		resourceType: text("resource_type"),
		resourceId: text("resource_id"),
		scopeType: text("scope_type"),
		scopeId: text("scope_id"),
		outcome: text("outcome", {
			enum: ["allowed", "denied", "succeeded", "failed", "revoked", "overflow"],
		}).notNull(),
		reasonCode: text("reason_code"),
		durationMs: integer("duration_ms"),
		requestBytes: integer("request_bytes").notNull().default(0),
		responseBytes: integer("response_bytes").notNull().default(0),
		metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_integration_audit_created").on(table.createdAt, table.id),
		index("idx_integration_audit_authority").on(table.authorityId, table.createdAt, table.id),
		index("idx_integration_audit_operation").on(table.operationId, table.outcome, table.createdAt),
	],
);

// === oauth_grants ===
// Durable OAuth consent/telemetry lifecycle. Canonical scopes and policy live in
// integration_authorities; legacy shadow columns remain only for bounded startup migration.
export const oauthGrants = sqliteTable(
	"oauth_grants",
	{
		id: text("id").primaryKey(),
		oauthClientId: text("oauth_client_id")
			.notNull()
			.references(() => oauthClients.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** @deprecated Migration-only scope shadow; never use for authorization. */
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
		/** @deprecated Migration-only policy shadow; canonical policy lives on the authority. */
		policyJson: text("policy_json", { mode: "json" }).$type<Record<string, unknown>>(),
		legacyUnscoped: integer("legacy_unscoped", { mode: "boolean" }).notNull().default(false),
		consentedAt: text("consented_at"),
		lastTokenIssuedAt: text("last_token_issued_at"),
		lastUsedAt: text("last_used_at"),
		revokedAt: text("revoked_at"),
		revokedByUserId: text("revoked_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		revokedByType: text("revoked_by_type", {
			enum: ["user", "admin", "client", "system"],
		}),
		revokedReason: text("revoked_reason"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_oauth_grants_active_user_client")
			.on(table.userId, table.oauthClientId)
			.where(sql`${table.revokedAt} is null`),
		index("idx_oauth_grants_client_revoked").on(table.oauthClientId, table.revokedAt),
		index("idx_oauth_grants_user_revoked").on(table.userId, table.revokedAt),
		// FK covering index for user deletion.
		index("idx_oauth_grants_revoked_by_user").on(table.revokedByUserId),
	],
);

// === integration_resource_bindings ===
// Stable provenance for polymorphic integration-owned resources. Source and authority ids
// intentionally have no foreign keys so audit identity survives grant/user/plugin deletion.
export const integrationResourceBindings = sqliteTable(
	"integration_resource_bindings",
	{
		id: text("id").primaryKey(),
		resourceType: text("resource_type", { enum: ["device", "narrator"] }).notNull(),
		resourceId: text("resource_id").notNull(),
		sourceType: text("source_type", {
			enum: ["oauth_client", "plugin", "first_party"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		authorityType: text("authority_type", {
			enum: ["oauth_grant", "plugin_installation", "user", "system"],
		}).notNull(),
		authorityId: text("authority_id").notNull(),
		state: text("state", { enum: ["active", "revoked", "orphaned", "deleted"] })
			.notNull()
			.default("active"),
		revision: integer("revision").notNull().default(1),
		provisionKey: text("provision_key"),
		metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		revokedAt: text("revoked_at"),
		orphanedAt: text("orphaned_at"),
		deletedAt: text("deleted_at"),
	},
	(table) => [
		uniqueIndex("idx_integration_resource_binding_resource").on(
			table.resourceType,
			table.resourceId,
		),
		uniqueIndex("idx_integration_resource_binding_provision").on(
			table.authorityId,
			table.resourceType,
			table.provisionKey,
		),
		index("idx_integration_resource_binding_authority").on(
			table.authorityType,
			table.authorityId,
			table.state,
			table.id,
		),
		index("idx_integration_resource_binding_source").on(
			table.sourceType,
			table.sourceId,
			table.state,
		),
		index("idx_integration_resource_binding_state_updated").on(table.state, table.updatedAt),
	],
);

// === oauth_grant_projects ===
// @deprecated Migration-only project allow-list shadow. Canonical project scopes live in
// integration_capability_grants; no production authorization path reads this table.
export const oauthGrantProjects = sqliteTable(
	"oauth_grant_projects",
	{
		id: text("id").primaryKey(),
		grantId: text("grant_id")
			.notNull()
			.references(() => oauthGrants.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_oauth_grant_projects_grant_project").on(table.grantId, table.projectId),
		index("idx_oauth_grant_projects_project").on(table.projectId),
	],
);

// === oauth_grant_events ===
// Append-only security audit events. grantId is nullable so denied consent and
// other pre-grant failures can still be recorded against the client and user.
export const oauthGrantEvents = sqliteTable(
	"oauth_grant_events",
	{
		id: text("id").primaryKey(),
		grantId: text("grant_id").references(() => oauthGrants.id, { onDelete: "set null" }),
		oauthClientId: text("oauth_client_id")
			.notNull()
			.references(() => oauthClients.id, { onDelete: "cascade" }),
		userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
		actorType: text("actor_type", {
			enum: ["user", "admin", "client", "system"],
		}).notNull(),
		actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		eventType: text("event_type").notNull(),
		requestedScopes: text("requested_scopes", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		grantedScopes: text("granted_scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
		projectIds: text("project_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
		reason: text("reason"),
		metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		requestId: text("request_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_oauth_grant_events_grant_created").on(table.grantId, table.createdAt),
		index("idx_oauth_grant_events_client_created").on(table.oauthClientId, table.createdAt),
		index("idx_oauth_grant_events_user_created").on(table.userId, table.createdAt),
		index("idx_oauth_grant_events_request").on(table.requestId),
		// FK covering index for user deletion (the index above leads with userId but
		// actorUserId is a separate column).
		index("idx_oauth_grant_events_actor_user").on(table.actorUserId),
	],
);

// === oauth_authorization_codes ===
// Short-lived (10 min) authorization codes from the consent step. Only the
// SHA-256 hash of the code is stored; the plaintext is returned to the client
// exactly once via the authorize redirect.
// === oauth_security_events ===
// Low-volume, append-only operational security events that may occur before a
// client/grant is authenticated. Never stores IPs, bearer material or request bodies.
export const oauthSecurityEvents = sqliteTable(
	"oauth_security_events",
	{
		id: text("id").primaryKey(),
		eventType: text("event_type").notNull(),
		endpoint: text("endpoint").notNull(),
		bucketType: text("bucket_type").notNull(),
		clientId: text("client_id"),
		grantId: text("grant_id").references(() => oauthGrants.id, { onDelete: "set null" }),
		userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
		retryAfterSeconds: integer("retry_after_seconds").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_oauth_security_events_created").on(table.createdAt),
		index("idx_oauth_security_events_type_created").on(table.eventType, table.createdAt),
		// FK covering indexes for user / grant deletion.
		index("idx_oauth_security_events_user").on(table.userId),
		index("idx_oauth_security_events_grant").on(table.grantId),
	],
);

export const oauthAuthorizationCodes = sqliteTable(
	"oauth_authorization_codes",
	{
		id: text("id").primaryKey(),
		codeHash: text("code_hash").notNull(),
		clientId: text("client_id").notNull(),
		/** Nullable during the phase-1 compatibility window for existing issuers. */
		oauthClientId: text("oauth_client_id").references(() => oauthClients.id, {
			onDelete: "cascade",
		}),
		grantId: text("grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		redirectUri: text("redirect_uri").notNull(),
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
		codeChallenge: text("code_challenge").notNull(),
		codeChallengeMethod: text("code_challenge_method", { enum: ["S256"] })
			.notNull()
			.default("S256"),
		expiresAt: text("expires_at").notNull(),
		/** Set once the code has been exchanged; codes are single-use. */
		consumedAt: text("consumed_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_oauth_authorization_codes_code_hash").on(table.codeHash),
		index("idx_oauth_authorization_codes_client").on(table.clientId),
		index("idx_oauth_authorization_codes_oauth_client").on(table.oauthClientId),
		index("idx_oauth_authorization_codes_grant").on(table.grantId),
		index("idx_oauth_authorization_codes_user").on(table.userId),
	],
);

// === oauth_access_tokens ===
// Access tokens (1 h) and their paired refresh tokens (30 d). Only SHA-256
// hashes are stored. Rotating a refresh token revokes the old row and inserts a
// new one; refresh families are intentionally deferred to phase 4.
export const oauthAccessTokens = sqliteTable(
	"oauth_access_tokens",
	{
		id: text("id").primaryKey(),
		tokenHash: text("token_hash").notNull(),
		clientId: text("client_id").notNull(),
		/** Nullable during the phase-1 compatibility window for existing issuers. */
		oauthClientId: text("oauth_client_id").references(() => oauthClients.id, {
			onDelete: "cascade",
		}),
		grantId: text("grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
		expiresAt: text("expires_at").notNull(),
		/** Hash of the refresh token that can mint a new row for this grant. */
		refreshTokenHash: text("refresh_token_hash"),
		/** Refresh token expiry (the grant itself lives 30 days). */
		refreshExpiresAt: text("refresh_expires_at"),
		/** Stable identifier shared by every rotated token in one refresh family. */
		refreshFamilyId: text("refresh_family_id"),
		/** Absolute family expiry inherited by every rotation; never slides forward. */
		refreshFamilyExpiresAt: text("refresh_family_expires_at"),
		/** Compromise/revocation marker stored on the family root row. */
		refreshFamilyRevokedAt: text("refresh_family_revoked_at"),
		/** Previous token row in the rotation chain. */
		refreshParentTokenId: text("refresh_parent_token_id"),
		/** Child row that replaced this refresh token. */
		refreshReplacedByTokenId: text("refresh_replaced_by_token_id"),
		/** First successful refresh consumption timestamp. */
		refreshUsedAt: text("refresh_used_at"),
		/** Reuse detection timestamp for compromised refresh families. */
		refreshReuseDetectedAt: text("refresh_reuse_detected_at"),
		lastUsedAt: text("last_used_at"),
		revokedAt: text("revoked_at"),
		revokedByUserId: text("revoked_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		revokedByType: text("revoked_by_type", {
			enum: ["user", "admin", "client", "system"],
		}),
		revokedReason: text("revoked_reason"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_oauth_access_tokens_token_hash").on(table.tokenHash),
		uniqueIndex("idx_oauth_access_tokens_refresh_hash").on(table.refreshTokenHash),
		index("idx_oauth_access_tokens_client").on(table.clientId),
		index("idx_oauth_access_tokens_oauth_client").on(table.oauthClientId),
		index("idx_oauth_access_tokens_grant_revoked").on(table.grantId, table.revokedAt),
		index("idx_oauth_access_tokens_refresh_family").on(table.refreshFamilyId, table.revokedAt),
		uniqueIndex("idx_oauth_access_tokens_refresh_parent").on(table.refreshParentTokenId),
		index("idx_oauth_access_tokens_user").on(table.userId),
		// FK covering index for user deletion.
		index("idx_oauth_access_tokens_revoked_by_user").on(table.revokedByUserId),
	],
);

// === notifications ===
// Activity history and acknowledgement. Human Attention owns actionable state;
// sourceState and effective readAt are derived against current source/ACL data.
// Dedup key: unique (user_id, kind, source_key) so reconnects/WS resubscribe
// never create a second row for the same source event.
export const notifications = sqliteTable(
	"notifications",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["chat_message", "permission_request"] }).notNull(),
		/** Best-effort denormalized filters; null when the source has no project/chapter. */
		projectId: text("project_id"),
		chapterId: text("chapter_id"),
		/** Required for permission_request; chat_message may leave this null. */
		narratorId: text("narrator_id"),
		title: text("title").notNull(),
		preview: text("preview").notNull().default(""),
		/** Deep link snapshot; lists must not recompute it by joining source tables. */
		linkJson: text("link_json", { mode: "json" }).$type<NotificationLink>().notNull(),
		/** chat_message → chat_messages.id; permission_request → narrator_tool_calls.id */
		sourceKey: text("source_key").notNull(),
		status: text("status", { enum: ["unread", "read"] })
			.notNull()
			.default("unread"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		readAt: integer("read_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("idx_notifications_user_kind_source").on(table.userId, table.kind, table.sourceKey),
		index("idx_notifications_user_created").on(table.userId, table.createdAt, table.id),
		index("idx_notifications_user_status_created").on(
			table.userId,
			table.status,
			table.createdAt,
			table.id,
		),
	],
);
