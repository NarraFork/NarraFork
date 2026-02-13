import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// === projects ===
export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	status: text("status", { enum: ["active", "archived"] })
		.notNull()
		.default("active"),
	defaultAgent: text("default_agent", { enum: ["claude", "opencode"] }).default("claude"),
	settings: text("settings", { mode: "json" }),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// === repositories ===
export const repositories = sqliteTable("repositories", {
	id: text("id").primaryKey(),
	projectId: text("project_id").references(() => projects.id),
	path: text("path").notNull(),
	displayName: text("display_name").notNull(),
	remoteUrl: text("remote_url"),
	defaultBranch: text("default_branch").default("main"),
	isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
	startupScript: text("startup_script"),
	copyFiles: text("copy_files"),
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
			.references(() => projects.id),
		repositoryId: text("repository_id")
			.notNull()
			.references(() => repositories.id),
		title: text("title").notNull(),
		description: text("description"),
		type: text("type", { enum: ["meanwhile", "whatif"] })
			.notNull()
			.default("meanwhile"),
		status: text("status", { enum: ["active", "dormant", "merged", "abandoned"] })
			.notNull()
			.default("active"),
		branch: text("branch").notNull(),
		worktreePath: text("worktree_path"),
		baseBranch: text("base_branch").notNull(),
		parentChapterId: text("parent_chapter_id").references((): any => chapters.id),
		forkPoint: text("fork_point", { mode: "json" }),
		mergedIntoChapterId: text("merged_into_chapter_id").references((): any => chapters.id),
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
	],
);

// === narrators ===
export const narrators = sqliteTable(
	"narrators",
	{
		id: text("id").primaryKey(),
		chapterId: text("chapter_id")
			.notNull()
			.references(() => chapters.id),
		claudeSessionId: text("claude_session_id"),
		type: text("type", { enum: ["primary", "secondary"] })
			.notNull()
			.default("primary"),
		inheritMode: text("inherit_mode", { enum: ["full", "compressed", "fresh"] })
			.notNull()
			.default("fresh"),
		parentNarratorId: text("parent_narrator_id").references((): any => narrators.id),
		contextSummary: text("context_summary"),
		model: text("model").default("claude-sonnet-4-5"),
		systemPrompt: text("system_prompt"),
		permissionMode: text("permission_mode", {
			enum: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"],
		}).default("default"),
		messageCount: integer("message_count").default(0),
		totalCostUsd: real("total_cost_usd").default(0),
		lastMessageAt: text("last_message_at"),
		status: text("status", { enum: ["active", "paused", "completed", "error"] })
			.notNull()
			.default("active"),
		errorMessage: text("error_message"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [index("idx_narrators_chapter").on(table.chapterId)],
);

// === narrator_messages ===
export const narratorMessages = sqliteTable(
	"narrator_messages",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id),
		sdkMessageUuid: text("sdk_message_uuid"),
		role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
		contentJson: text("content_json", { mode: "json" }).notNull(),
		contentText: text("content_text"),
		tokensIn: integer("tokens_in"),
		tokensOut: integer("tokens_out"),
		costUsd: real("cost_usd"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_messages_narrator").on(table.narratorId, table.createdAt)],
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
			enum: ["pending", "approved", "denied", "running", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		durationMs: integer("duration_ms"),
		errorMessage: text("error_message"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_toolcalls_message").on(table.messageId)],
);

// === permission_requests ===
export const permissionRequests = sqliteTable(
	"permission_requests",
	{
		id: text("id").primaryKey(),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id),
		toolCallId: text("tool_call_id"),
		toolName: text("tool_name").notNull(),
		inputJson: text("input_json", { mode: "json" }),
		decisionReason: text("decision_reason"),
		suggestions: text("suggestions", { mode: "json" }),
		decision: text("decision", { enum: ["pending", "allow", "deny"] })
			.notNull()
			.default("pending"),
		decidedBy: text("decided_by"),
		denyMessage: text("deny_message"),
		createdAt: text("created_at").notNull(),
		decidedAt: text("decided_at"),
	},
	(table) => [index("idx_permissions_narrator").on(table.narratorId, table.decision)],
);

// === terminals ===
export const terminals = sqliteTable("terminals", {
	id: text("id").primaryKey(),
	chapterId: text("chapter_id").references(() => chapters.id),
	name: text("name").notNull(),
	cwd: text("cwd"),
	dtachSocket: text("dtach_socket"),
	status: text("status", { enum: ["running", "exited"] })
		.notNull()
		.default("running"),
	exitCode: integer("exit_code"),
	createdAt: text("created_at").notNull(),
});

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
