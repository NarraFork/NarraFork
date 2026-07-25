import { DEFAULT_LOCALE, type Locale } from "@shared/i18n-locales";
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
	(table) => [index("idx_exploration_groups_project").on(table.projectId)],
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
		status: text("status", {
			enum: ["active", "dormant", "merged", "abandoned", "frozen"],
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

		// 图可视化
		color: text("color"),
		groupLabel: text("group_label"),
		pinned: integer("pinned").default(0),
		// 位置坐标系：锚定到 commit + 轴上偏移 + 离轴距离
		anchorCommitSha: text("anchor_commit_sha"),
		axisOffset: real("axis_offset").default(0),
		crossOffset: real("cross_offset").default(0),
		panelExpanded: integer("panel_expanded").default(0),
		panelWidth: real("panel_width"),
		panelHeight: real("panel_height"),

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
	],
);

// === narrators ===
export const narrators = sqliteTable(
	"narrators",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id").references(() => chapters.id),
		apiConversationId: text("api_conversation_id"),
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
		contextSummary: text("context_summary"),
		model: text("model").default("claude-sonnet-4.5"),
		/** When set, the model should be restored to this value after the current turn completes.
		 *  Used by temporary model override on slash commands. Cleared after restore. */
		pendingModelRestore: text("pending_model_restore"),
		systemPrompt: text("system_prompt"),
		permissionMode: text("permission_mode", {
			enum: ["default", "acceptEdits", "bypassPermissions", "readOnly", "dontAsk"],
		}).default("default"),
		previousPermissionMode: text("previous_permission_mode"),
		/** Persistent ID for the designated .narrafork/plan-{id}.md file while in plan mode. */
		planFileId: text("plan_file_id"),
		reasoningEffort: text("reasoning_effort", {
			enum: ["none", "low", "medium", "high", "xhigh", "max"],
		}),
		fastMode: integer("fast_mode", { mode: "boolean" }).notNull().default(false),
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
		errorMessage: text("error_message"),
		pruneBoundaryMessageId: text("prune_boundary_message_id").references(
			// biome-ignore lint/suspicious/noExplicitAny: forward reference to narratorMessages
			(): any => narratorMessages.id,
		),
		prunedPercent: integer("pruned_percent"),
		pruneEnabled: integer("prune_enabled", { mode: "boolean" }).notNull().default(true),
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
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_narrators_chapter").on(table.chapterId),
		index("idx_narrators_parent").on(table.parentNarratorId),
		index("idx_narrators_variant_updated").on(table.variant, table.updatedAt, table.id),
		index("idx_narrators_handle").on(table.handle),
		uniqueIndex("idx_narrators_handle_fold").on(table.handleFold),
		index("idx_narrators_context_project").on(table.contextProjectId),
		index("idx_narrators_oauth_owner").on(table.oauthOwnerGrantId),
		uniqueIndex("idx_narrators_oauth_provision").on(
			table.oauthOwnerGrantId,
			table.oauthProvisionKey,
		),
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
		// ── Authorization scope ──
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
		createdAt: text("created_at").notNull(),
		startedAt: text("started_at"),
		updatedAt: text("updated_at").notNull(),
		completedAt: text("completed_at"),
	},
	(table) => [
		index("idx_device_transfer_tasks_device_created").on(table.deviceId, table.createdAt),
		index("idx_device_transfer_tasks_status_updated").on(table.status, table.updatedAt),
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
	],
);

// === narrator_messages ===
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
		tokensIn: integer("tokens_in"),
		costUsd: real("cost_usd"),
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
		// 斜杠命令原始文本（展示用），如 "/translate typescript some code"
		commandText: text("command_text"),
		// 发送此消息的用户 ID（仅 role="user" 时有值）
		createdBy: text("created_by").references(() => users.id),
		// 最近一次手动编辑此消息内容的时间戳（编辑后的文本会进入后续历史；本元数据不发送给 AI）
		editedAt: text("edited_at"),
		// 编辑此消息的用户 ID
		editedBy: text("edited_by").references(() => users.id),
		// 首次编辑时保存的原始 contentJson（再次编辑不覆盖），用于前端查看原文
		originalContentJson: text("original_content_json", { mode: "json" }),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_messages_narrator").on(table.narratorId, table.createdAt),
		index("idx_messages_parent_tool_use_lookup").on(table.parentToolUseId, table.createdAt),
		index("idx_messages_parent_tool_use").on(table.narratorId, table.parentToolUseId),
		index("idx_messages_toplevel").on(table.narratorId, table.parentToolUseId, table.createdAt),
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
		/** Pruned percent at the time this message was sent (inherited on fork) */
		prunedPercent: integer("pruned_percent"),
		/** Points to the segment-compact summary message that hides this ref. */
		segmentCompactId: text("segment_compact_id"),
	},
	(table) => [
		uniqueIndex("idx_narrator_refs_unique").on(table.narratorId, table.messageId),
		index("idx_narrator_refs_seq").on(table.narratorId, table.seq),
		index("idx_narrator_refs_compact_seq").on(table.narratorId, table.isCompact, table.seq),
		index("idx_narrator_refs_message").on(table.messageId),
		index("idx_narrator_refs_segment_compact").on(table.segmentCompactId),
	],
);

// === narrator_sidecars ===
export const narratorSidecars = sqliteTable(
	"narrator_sidecars",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		messageId: text("message_id").references(() => narratorMessages.id, {
			onDelete: "cascade",
		}),
		toolUseId: text("tool_use_id"),
		target: text("target", { enum: ["tool_result", "user_message"] }).notNull(),
		source: text("source").notNull(),
		content: text("content").notNull(),
		orderIndex: integer("order_index").notNull().default(0),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_sidecars_message").on(table.messageId, table.target, table.orderIndex),
		index("idx_sidecars_tool_use").on(
			table.toolUseId,
			table.target,
			table.orderIndex,
			table.createdAt,
		),
		index("idx_sidecars_narrator").on(table.narratorId, table.createdAt),
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
		/**
		 * Actual execution target frozen before permission/execution.
		 * "local" means the NarraFork server; a remote value is remote_devices.id.
		 * null is reserved for legacy rows whose target cannot be reconstructed safely.
		 */
		executionDeviceId: text("execution_device_id"),
		/** Working directory on the selected execution target at call time. */
		executionCwd: text("execution_cwd"),
		/** Resolved absolute target path for single-file tools (Write/Edit/Read), when applicable. */
		resolvedFilePath: text("resolved_file_path"),
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
		permissionStartedAt: text("permission_started_at"),
		executionStartedAt: text("execution_started_at"),
		completedAt: text("completed_at"),
		errorMessage: text("error_message"),
		permissionDecidedBy: text("permission_decided_by"),
		permissionDecidedAt: text("permission_decided_at"),
		permissionDenyMessage: text("permission_deny_message"),
		permissionDecisionReason: text("permission_decision_reason"),
		permissionSuggestions: text("permission_suggestions", { mode: "json" }),
		isBackground: integer("is_background", { mode: "boolean" }).notNull().default(false),
		/** True when this tool call is a hidden file-history checkpoint clone. */
		isFileHistoryCheckpoint: integer("is_file_history_checkpoint", { mode: "boolean" })
			.notNull()
			.default(false),
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
		// Provider and model info
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
		chapterId: text("chapter_id").references(() => chapters.id),
		narratorId: text("narrator_id").references(() => narrators.id),
		name: text("name").notNull(),
		cwd: text("cwd"),
		dtachSocket: text("dtach_socket"),
		/** Remote executor device this terminal runs on. null → local server. */
		deviceId: text("device_id"),
		status: text("status", { enum: ["running", "exited"] })
			.notNull()
			.default("running"),
		exitCode: integer("exit_code"),
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
	],
);

// === terminal_tabs ===
export const terminalTabs = sqliteTable(
	"terminal_tabs",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id").references(() => chapters.id),
		narratorId: text("narrator_id").references(() => narrators.id),
		name: text("name").notNull(),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_terminal_tabs_chapter").on(table.chapterId, table.sortOrder),
		index("idx_terminal_tabs_narrator").on(table.narratorId, table.sortOrder),
	],
);

// === terminal_view_state ===
export const terminalViewState = sqliteTable(
	"terminal_view_state",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		chapterId: text("chapter_id").references(() => chapters.id),
		narratorId: text("narrator_id").references(() => narrators.id),
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
	],
);

// === container_instances ===
export const containerInstances = sqliteTable(
	"container_instances",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id")
			.notNull()
			.references(() => chapters.id),
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
	],
);

// === port_allocations ===
export const portAllocations = sqliteTable("port_allocations", {
	port: integer("port").primaryKey(),
	chapterId: text("chapter_id").references(() => chapters.id),
	serviceName: text("service_name"),
	allocatedAt: text("allocated_at").notNull(),
});

// === user_preferences ===
export const userPreferences = sqliteTable("user_preferences", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull().unique(),
	autoLoadOlderMessages: integer("auto_load_older_messages", { mode: "boolean" })
		.notNull()
		.default(true),
	fastModeDefault: integer("fast_mode_default", { mode: "boolean" }).notNull().default(false),
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
	recentTabs: text("recent_tabs").notNull().default("[]"),
	addSubagentToRecentTabs: integer("add_subagent_to_recent_tabs", { mode: "boolean" })
		.notNull()
		.default(true),
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
export const mergeSessions = sqliteTable("merge_sessions", {
	id: text("id").primaryKey(),
	targetChapterId: text("target_chapter_id")
		.notNull()
		.references(() => chapters.id),
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
	error: text("error"),
	locale: text("locale").$type<Locale>(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// === narrator_whitelist_dirs ===
export const narratorWhitelistDirs = sqliteTable(
	"narrator_whitelist_dirs",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		accessLevel: text("access_level", {
			enum: ["readOnly", "readWrite", "full"],
		})
			.notNull()
			.default("readOnly"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_whitelist_dirs_narrator").on(table.narratorId),
		uniqueIndex("idx_whitelist_dirs_narrator_path").on(table.narratorId, table.path),
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
		denyLevel: text("deny_level", {
			enum: ["denyWrite", "denyAll"],
		})
			.notNull()
			.default("denyAll"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_blacklist_dirs_narrator").on(table.narratorId),
		uniqueIndex("idx_blacklist_dirs_narrator_path").on(table.narratorId, table.path),
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
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_whitelist_cmds_narrator").on(table.narratorId),
		uniqueIndex("idx_whitelist_cmds_narrator_pattern").on(table.narratorId, table.pattern),
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
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_blacklist_cmds_narrator").on(table.narratorId),
		uniqueIndex("idx_blacklist_cmds_narrator_pattern").on(table.narratorId, table.pattern),
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
		chapterId: text("chapter_id")
			.notNull()
			.references(() => chapters.id, { onDelete: "cascade" }),
		appliedAt: text("applied_at").notNull(),
		appliedBy: text("applied_by").references(() => users.id, { onDelete: "set null" }),
	},
	(table) => [
		index("idx_snapshot_applications_snapshot").on(table.snapshotId),
		index("idx_snapshot_applications_chapter").on(table.chapterId),
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
		tree: text("tree").notNull(), // JSON: SplitNode
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("idx_workspaces_user").on(table.userId)],
);

// === api_requests ===
// 独立记录每次 API 请求的统计信息（与 narrator_messages 解耦）
export const apiRequests = sqliteTable(
	"api_requests",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "cascade" }),
		// 关联的 assistant message ID（一个请求可能产生一个 assistant message）
		messageId: text("message_id").references(() => narratorMessages.id, { onDelete: "set null" }),
		// 请求用途：narrator / compact / title / internal 等
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
		// 上下文使用率
		contextPercent: real("context_percent"),
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
		priority: integer("priority", { mode: "boolean" }).notNull().default(false),
		seq: integer("seq").notNull(),
		bufferedAt: text("buffered_at").notNull(),
	},
	(table) => [index("idx_nbm_narrator_seq").on(table.narratorId, table.seq)],
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

export const benchmarkRuns = sqliteTable("benchmark_runs", {
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
});

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
	(table) => [index("idx_task_results_run").on(table.runId, table.status)],
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
		type: text("type", { enum: ["bash", "agent"] }).notNull(),
		status: text("status", {
			enum: ["running", "completed", "failed", "cancelled", "timeout"],
		}).notNull(),
		// Bash-specific
		command: text("command"),
		exitCode: integer("exit_code"),
		// Agent-specific
		subagentNarratorId: text("subagent_narrator_id").references(() => narrators.id, {
			onDelete: "cascade",
		}),
		subagentType: text("subagent_type"),
		// Common
		toolUseId: text("tool_use_id"),
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
		/** Subagent type if the narrator was a subagent (explore/plan/general/review/...). */
		subagentType: text("subagent_type"),
		/** How the change was made. */
		action: text("action", {
			enum: ["write", "edit", "bash", "external"],
		}).notNull(),
		/** Tool name that produced the change (Write/Edit/Bash), if any. */
		toolName: text("tool_name"),
		/** Tool-use id linking back to narrator_tool_calls, if any. */
		toolUseId: text("tool_use_id"),
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
	],
);

// === chat_groups ===
// A multi-party conversation created when a narrator/user @mentions one or more
// named narrators. Members = the originating session's narrator + the user(s) +
// the mentioned named narrator(s). Messages are the source of truth and are
// delivered into each narrator member's own session (wake if idle, sidecar if working).
export const chatGroups = sqliteTable(
	"chat_groups",
	{
		id: text("id").primaryKey(),
		title: text("title"),
		/** The narrator whose session originated this group (the "origin" member). */
		originNarratorId: text("origin_narrator_id").references(() => narrators.id, {
			onDelete: "set null",
		}),
		/** Optional project scope (inherited from the origin narrator's chapter, if any). */
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_chat_groups_origin").on(table.originNarratorId),
		index("idx_chat_groups_project").on(table.projectId),
		index("idx_chat_groups_status").on(table.status, table.updatedAt),
	],
);

// === chat_group_members ===
export const chatGroupMembers = sqliteTable(
	"chat_group_members",
	{
		id: text("id").primaryKey(),
		groupId: text("group_id")
			.notNull()
			.references(() => chatGroups.id, { onDelete: "cascade" }),
		memberType: text("member_type", { enum: ["user", "narrator"] }).notNull(),
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id").references(() => narrators.id, { onDelete: "cascade" }),
		/** Role within the group: origin (the source session), named (a mentioned narrator), or participant. */
		role: text("role", { enum: ["origin", "named", "participant"] })
			.notNull()
			.default("participant"),
		/**
		 * Whether this member can control other members' narrators (send messages,
		 * proxy-approve permission requests, interrupt). Granted to named narrators.
		 */
		canControl: integer("can_control", { mode: "boolean" }).notNull().default(false),
		joinedAt: text("joined_at").notNull(),
	},
	(table) => [
		index("idx_chat_group_members_group").on(table.groupId),
		index("idx_chat_group_members_narrator").on(table.narratorId),
		uniqueIndex("idx_chat_group_members_group_narrator").on(table.groupId, table.narratorId),
		uniqueIndex("idx_chat_group_members_group_user").on(table.groupId, table.userId),
	],
);

// === chat_group_messages ===
// Source of truth for group conversation. Each row is delivered to narrator members.
export const chatGroupMessages = sqliteTable(
	"chat_group_messages",
	{
		id: text("id").primaryKey(),
		groupId: text("group_id")
			.notNull()
			.references(() => chatGroups.id, { onDelete: "cascade" }),
		senderType: text("sender_type", { enum: ["user", "narrator", "system"] }).notNull(),
		senderUserId: text("sender_user_id").references(() => users.id, { onDelete: "set null" }),
		senderNarratorId: text("sender_narrator_id").references(() => narrators.id, {
			onDelete: "set null",
		}),
		content: text("content").notNull(),
		/** When true, delivery to working members triggers a soft interrupt instead of a passive sidecar. */
		urgent: integer("urgent", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_chat_group_messages_group").on(table.groupId, table.createdAt)],
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
		status: text("status", {
			enum: ["pending", "approved", "rejected", "changes_requested", "conflict"],
		})
			.notNull()
			.default("pending"),
		reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
		verdict: text("verdict", { enum: ["approve", "request_changes", "comment_only"] }),
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
	(table) => [uniqueIndex("idx_oauth_clients_client_id").on(table.clientId)],
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
	],
);
