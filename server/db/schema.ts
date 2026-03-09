import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// === projects ===
export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	status: text("status", { enum: ["active", "archived"] })
		.notNull()
		.default("active"),
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
		role: text("role", { enum: ["trunk", "branch", "exploration"] })
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
		positionX: real("position_x"),
		positionY: real("position_y"),
		panelExpanded: integer("panel_expanded").default(0),
		panelWidth: real("panel_width"),
		panelHeight: real("panel_height"),

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
			enum: ["fork", "merge", "dependency", "cherry_pick"],
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
		subagentType: text("subagent_type", { enum: ["explore", "plan", "general"] }),
		title: text("title"),
		inheritMode: text("inherit_mode", { enum: ["full", "compressed", "fresh"] })
			.notNull()
			.default("fresh"),
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		parentNarratorId: text("parent_narrator_id").references((): any => narrators.id),
		contextSummary: text("context_summary"),
		model: text("model").default("claude-sonnet"),
		systemPrompt: text("system_prompt"),
		permissionMode: text("permission_mode", {
			enum: ["default", "acceptEdits", "bypassPermissions", "readOnly", "plan", "dontAsk"],
		}).default("default"),
		previousPermissionMode: text("previous_permission_mode"),
		reasoningEffort: text("reasoning_effort", {
			enum: ["low", "medium", "high", "xhigh"],
		}),
		fastMode: integer("fast_mode", { mode: "boolean" }).notNull().default(false),
		relaxedPlan: integer("relaxed_plan", { mode: "boolean" }).notNull().default(false),
		messageCount: integer("message_count").default(0),
		totalCostUsd: real("total_cost_usd").default(0),
		lastMessageAt: text("last_message_at"),
		status: text("status", {
			enum: ["idle", "thinking", "waiting", "done", "archived", "error", "interrupted"],
		})
			.notNull()
			.default("idle"),
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
		// Background task fields
		isBackground: integer("is_background", { mode: "boolean" }).notNull().default(false),
		backgroundStatus: text("background_status", {
			enum: ["running", "completed", "failed", "cancelled"],
		}),
		backgroundResult: text("background_result"),
		backgroundCompletedAt: text("background_completed_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_narrators_chapter").on(table.chapterId),
		index("idx_narrators_parent").on(table.parentNarratorId),
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
		role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
		contentJson: text("content_json", { mode: "json" }).notNull(),
		contentText: text("content_text"),
		tokensIn: integer("tokens_in"),
		costUsd: real("cost_usd"),
		turnUsageJson: text("turn_usage_json", { mode: "json" }),
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
	},
	(table) => [
		uniqueIndex("idx_narrator_refs_unique").on(table.narratorId, table.messageId),
		index("idx_narrator_refs_seq").on(table.narratorId, table.seq),
		index("idx_narrator_refs_message").on(table.messageId),
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
		errorMessage: text("error_message"),
		permissionDecidedBy: text("permission_decided_by"),
		permissionDecidedAt: text("permission_decided_at"),
		permissionDenyMessage: text("permission_deny_message"),
		permissionDecisionReason: text("permission_decision_reason"),
		permissionSuggestions: text("permission_suggestions", { mode: "json" }),
		isBackground: integer("is_background", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_toolcalls_message").on(table.messageId),
		index("idx_toolcalls_tool_use_id").on(table.toolUseId),
		index("idx_toolcalls_status").on(table.narratorId, table.status),
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
	// Setup wizard
	setupWizardCompleted: integer("setup_wizard_completed", { mode: "boolean" })
		.notNull()
		.default(false),
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

// === narrator_patches (snapshot tracking) ===
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
