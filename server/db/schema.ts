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
		status: text("status", { enum: ["active", "dormant", "merged", "abandoned"] })
			.notNull()
			.default("active"),
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

// === narrators ===
export const narrators = sqliteTable(
	"narrators",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id").references(() => chapters.id),
		apiConversationId: text("api_conversation_id"),
		// biome-ignore lint/suspicious/noExplicitAny: forward reference to narratorMessages
		forkMessageId: text("fork_message_id").references((): any => narratorMessages.id),
		type: text("type", { enum: ["primary", "secondary", "subagent"] })
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
			enum: ["default", "acceptEdits", "bypassPermissions", "dontAsk"],
		}).default("default"),
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
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_messages_narrator").on(table.narratorId, table.createdAt),
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
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_toolcalls_message").on(table.messageId),
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
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_terminals_chapter").on(table.chapterId),
		index("idx_terminals_narrator").on(table.narratorId),
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
	terminalTheme: text("terminal_theme").notNull().default("auto"),
	terminalFontSize: integer("terminal_font_size").notNull().default(14),
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
