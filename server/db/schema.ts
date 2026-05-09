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

// === exploration_groups ===
export const explorationGroups = sqliteTable("exploration_groups", {
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
});

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
			enum: ["none", "low", "medium", "high", "xhigh"],
		}),
		fastMode: integer("fast_mode", { mode: "boolean" }).notNull().default(false),
		relaxedPlan: integer("relaxed_plan", { mode: "boolean" }).notNull().default(false),
		planReflectionAutoApproveOverride: text("plan_reflection_auto_approve_override", {
			enum: ["inherit", "on", "off"],
		})
			.notNull()
			.default("inherit"),
		dangerReflectionOverride: text("danger_reflection_override", {
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
		/** JSON array of substatus tags (e.g. ["reasoning","compacting"]) */
		substatus: text("substatus").notNull().default("[]"),
		planMode: integer("plan_mode", { mode: "boolean" }).notNull().default(false),
		cwd: text("cwd"),
		errorMessage: text("error_message"),
		todosJson: text("todos_json", { mode: "json" }),
		todosToolUseId: text("todos_tool_use_id"),
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
		 * Possible values: "standalone", "ask-in-passing", "background"
		 */
		traits: text("traits", { mode: "json" }).$type<string[]>().notNull().default([]),
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
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_narrators_chapter").on(table.chapterId),
		index("idx_narrators_parent").on(table.parentNarratorId),
	],
);

// === narrator_goals ===
export const narratorGoals = sqliteTable(
	"narrator_goals",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		objective: text("objective").notNull(),
		status: text("status", {
			enum: ["pending", "active", "paused", "complete", "cancelled"],
		})
			.notNull()
			.default("pending"),
		sortOrder: integer("sort_order").notNull().default(0),
		tokensUsed: integer("tokens_used").notNull().default(0),
		timeUsedSeconds: integer("time_used_seconds").notNull().default(0),
		createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
		completedAt: text("completed_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_narrator_goals_narrator_order").on(table.narratorId, table.sortOrder),
		index("idx_narrator_goals_status").on(table.narratorId, table.status),
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
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_messages_narrator").on(table.narratorId, table.createdAt),
		index("idx_messages_parent_tool_use_lookup").on(table.parentToolUseId),
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
		index("idx_sidecars_tool_use").on(table.toolUseId, table.target, table.orderIndex),
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
		index("idx_toolcalls_status").on(table.narratorId, table.status),
		index("idx_toolcalls_created").on(table.narratorId, table.createdAt),
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
		index("idx_terminals_chapter").on(table.chapterId),
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
export const containerInstances = sqliteTable("container_instances", {
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
});

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
	language: text("language").notNull().default("en"),
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
	// Send mode: "enter" = Enter sends, "ctrl+enter" = Ctrl+Enter sends
	sendMode: text("send_mode", { enum: ["enter", "ctrl+enter"] })
		.notNull()
		.default("enter"),
	// Setup wizard
	setupWizardCompleted: integer("setup_wizard_completed", { mode: "boolean" })
		.notNull()
		.default(false),
	// Gateway configuration (JSON: per-user IM gateway settings)
	gatewayConfig: text("gateway_config").notNull().default("{}"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

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
	createdAt: text("created_at").notNull(),
});

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
		filePath: text("file_path").notNull(),
		originalContent: text("original_content"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_file_snapshots_narrator").on(table.narratorId),
		uniqueIndex("idx_file_snapshots_narrator_file").on(table.narratorId, table.filePath),
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
	locale: text("locale"),
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
		index("idx_api_requests_created").on(table.createdAt),
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
			enum: ["PreToolUse", "PostToolUse"],
		}).notNull(),
		matcher: text("matcher").notNull().default(""),
		type: text("type", { enum: ["command", "http"] }).notNull(),
		// command type
		command: text("command"),
		// http type
		url: text("url"),
		headers: text("headers", { mode: "json" }).$type<Record<string, string>>(),
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
