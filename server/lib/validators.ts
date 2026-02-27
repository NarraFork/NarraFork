import { z } from "zod";

// Reusable: valid git branch name (no flags, no special chars)
const gitBranchName = z.string().regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name");

// === Projects ===

export const createProjectSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	// Repository mode: "existing" (default), "init", "clone", or omitted for no repo
	repoMode: z.enum(["existing", "init", "clone"]).optional(),
	gitPath: z.string().min(1).optional(),
	defaultBranch: gitBranchName.optional(),
	// Clone-specific fields
	cloneUrl: z.string().min(1).optional(),
	cloneBranch: gitBranchName.optional(),
});

export const updateProjectSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "archived"]).optional(),
	defaultBranch: gitBranchName.optional(),
	startupScript: z.string().max(5000).nullable().optional(),
	copyFiles: z.string().max(5000).nullable().optional(),
});

// === Chapters ===

export const createChapterSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	baseBranch: gitBranchName.optional(),
});

export const containerConfigSchema = z.object({
	composeFile: z.string().max(500).optional(),
	services: z.array(z.string().min(1)).optional(),
	ports: z
		.array(
			z.object({
				containerPort: z.number().int().min(1).max(65535),
				serviceName: z.string().min(1),
			}),
		)
		.optional(),
	env: z.record(z.string(), z.string()).optional(),
});

export const updateChapterSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "dormant", "merged", "abandoned", "frozen"]).optional(),
	role: z.enum(["trunk", "branch", "exploration"]).optional(),
	color: z.string().max(20).nullable().optional(),
	groupLabel: z.string().max(100).nullable().optional(),
	containerConfig: containerConfigSchema.nullable().optional(),
});

// === Narrators ===

export const createNarratorSchema = z.object({
	chapterId: z.string().min(1).nullish(),
	type: z.enum(["primary", "secondary"]).optional(),
	model: z.string().optional(),
	systemPrompt: z.string().max(10000).optional(),
	permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "dontAsk"]).optional(),
	cwd: z.string().min(1).max(4096).optional(),
	planMode: z.boolean().optional(),
});

export const sendMessageSchema = z.object({
	message: z.string().min(1),
});

export const permissionDecisionSchema = z.object({
	decision: z.enum(["allow", "deny"]),
	message: z.string().optional(),
});

// === Terminals ===

export const createTerminalSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().max(100).optional(),
		cols: z.number().int().min(10).max(500).optional(),
		rows: z.number().int().min(2).max(200).optional(),
	})
	.refine((d) => (d.chapterId || d.narratorId) && !(d.chapterId && d.narratorId), {
		message: "Exactly one of chapterId or narratorId is required",
	});

// === Terminal Tabs ===

export const createTerminalTabSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().min(1).max(100),
	})
	.refine((d) => (d.chapterId || d.narratorId) && !(d.chapterId && d.narratorId), {
		message: "Exactly one of chapterId or narratorId is required",
	});

export const updateTerminalTabSchema = z.object({
	name: z.string().min(1).max(100).optional(),
});

export const reorderTerminalTabsSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
});

// === Terminal View State ===

export const updateTerminalViewStateSchema = z
	.object({
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		layout: z.enum(["single", "split-h", "split-v", "triple", "quad"]).optional(),
		activeTabId: z.string().nullable().optional(),
		panelAssignments: z.record(z.string(), z.string()).nullable().optional(),
	})
	.refine((d) => d.chapterId || d.narratorId, {
		message: "Either chapterId or narratorId is required",
	});

// === Fork / Merge / Cleanup ===

export const forkChapterSchema = z.object({
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
	forkAtMessageUuid: z.string().optional(),
	role: z.enum(["trunk", "branch", "exploration"]).default("branch"),
});

export const mergeChapterSchema = z.object({
	targetChapterId: z.string().min(1),
	strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
	message: z.string().max(500).optional(),
});

export const mergeCheckSchema = z.object({
	targetChapterId: z.string().min(1),
});

export const batchCleanupSchema = z.object({
	chapterIds: z.array(z.string().min(1)).min(1),
	force: z.boolean().optional(),
	deleteBranch: z.boolean().optional(),
});

export const batchMergeSchema = z.object({
	baseChapterId: z.string().min(1),
	sourceChapterIds: z.array(z.string().min(1)).min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
});

// === Containers ===

export const containerRemoveSchema = z.object({
	deleteVolumes: z.boolean().optional(),
});

// === Auth ===

export const registerSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, hyphens, underscores only"),
	password: z.string().min(8).max(128),
	language: z.string().min(1).max(10).optional(),
});

export const loginSchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});

export const adminUpdateSettingsSchema = z.object({
	registrationOpen: z.boolean(),
});

export const adminUpdateUserSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/, "Alphanumeric, hyphens, underscores only")
		.optional(),
	password: z.string().min(8).max(128).optional(),
});

// === Narrator title ===

export const updateNarratorTitleSchema = z.object({
	title: z.string().min(1).max(200),
});

// === Narrator Fork ===

export const forkNarratorSchema = z.object({
	forkMessageId: z.string().min(1),
	title: z.string().min(1).max(200).optional(),
});

export const updateNarratorModelSchema = z.object({
	model: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-zA-Z0-9._:/-]+$/, "Invalid model identifier"),
});

// === Favorite Directories ===

export const createFavoriteDirectorySchema = z.object({
	path: z.string().min(1).max(4096),
	label: z.string().max(200).optional(),
});

export const updateFavoriteDirectorySchema = z.object({
	path: z.string().min(1).max(4096).optional(),
	label: z.string().max(200).nullable().optional(),
	sortOrder: z.number().int().min(0).optional(),
});

export const reorderFavoriteDirectoriesSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
});

// === User Preferences ===

export const updateUserPreferencesSchema = z.object({
	autoLoadOlderMessages: z.boolean().optional(),
	language: z.enum(["en", "zh-CN"]).optional(),
	wordWrapMarkdown: z.boolean().optional(),
	wordWrapCode: z.boolean().optional(),
	wordWrapDiff: z.boolean().optional(),
	replyInUserLanguage: z.boolean().optional(),
	showTokenUsage: z.boolean().optional(),
	terminalTheme: z.string().min(1).max(50).optional(),
	terminalFontSize: z.number().int().min(8).max(32).optional(),
	// Notification preferences
	notifyOnDone: z.boolean().optional(),
	notifyOnWaiting: z.boolean().optional(),
	notifyPwaEnabled: z.boolean().optional(),
	notifySoundEnabled: z.boolean().optional(),
	notifySoundType: z.enum(["builtin", "custom"]).optional(),
	notifySoundBuiltin: z.string().max(50).optional(),
	notifySoundFileId: z.string().max(50).nullable().optional(),
	notifyDingtalkEnabled: z.boolean().optional(),
	notifyDingtalkWebhook: z
		.string()
		.max(500)
		.refine((v) => !v || v.startsWith("https://"), {
			message: "Webhook URL must start with https://",
		})
		.optional(),
	notifyDingtalkSecret: z.string().max(500).optional(),
	notifyFeishuEnabled: z.boolean().optional(),
	notifyFeishuWebhook: z
		.string()
		.max(500)
		.refine((v) => !v || v.startsWith("https://"), {
			message: "Webhook URL must start with https://",
		})
		.optional(),
	notifyFeishuSecret: z.string().max(500).optional(),
});

export const recentTabSchema = z.object({
	type: z.enum(["chapter", "session", "project"]),
	id: z.string().min(1).max(50),
	narratorId: z.string().min(1).max(50).optional(),
	title: z.string().max(200),
	subtitle: z.string().max(200).optional(),
	status: z.string().max(50).optional(),
	lastVisitedAt: z.number(),
});

export const upsertRecentTabSchema = recentTabSchema;

export const removeRecentTabSchema = z.object({
	type: z.enum(["chapter", "session", "project"]),
	id: z.string().min(1).max(50),
});

// === WebSocket Messages ===

// Narrator client → server
export const narratorWsMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pong") }),
	z.object({
		type: z.literal("subscribe"),
		narratorIds: z.array(z.string().min(1)),
		lastMessageId: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal("unsubscribe"),
		narratorIds: z.array(z.string().min(1)),
	}),
	z.object({
		type: z.literal("permission_decision"),
		requestId: z.string().min(1),
		decision: z.enum(["allow", "deny"]),
		message: z.string().optional(),
		answers: z.record(z.string(), z.string()).optional(),
		feedbackText: z.string().optional(),
		compactAfter: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("merge_decision"),
		mergeSessionId: z.string().min(1),
		decision: z.enum(["continue", "cancel"]),
	}),
	z.object({
		type: z.literal("buffer_message"),
		narratorId: z.string().min(1),
		text: z.string().min(1).max(100_000),
	}),
	z.object({
		type: z.literal("cancel_buffer"),
		narratorId: z.string().min(1),
	}),
	z.object({
		type: z.literal("presence_join"),
		narratorId: z.string().min(1),
	}),
	z.object({
		type: z.literal("presence_leave"),
		narratorId: z.string().min(1),
	}),
]);

// Terminal client → server
export const terminalWsMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pong") }),
	z.object({
		type: z.literal("subscribe"),
		terminalIds: z.array(z.string().min(1)),
	}),
	z.object({
		type: z.literal("unsubscribe"),
		terminalIds: z.array(z.string().min(1)),
	}),
	z.object({
		type: z.literal("input"),
		terminalId: z.string().min(1),
		data: z.string(),
	}),
	z.object({
		type: z.literal("resize"),
		terminalId: z.string().min(1),
		cols: z.number().int().min(10).max(500),
		rows: z.number().int().min(2).max(200),
	}),
	z.object({
		type: z.literal("create"),
		requestId: z.string().min(1),
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().max(100).optional(),
		cols: z.number().int().min(10).max(500).optional(),
		rows: z.number().int().min(2).max(200).optional(),
	}),
	z.object({
		type: z.literal("kill"),
		terminalId: z.string().min(1),
	}),
	z.object({
		type: z.literal("rename"),
		terminalId: z.string().min(1),
		name: z.string().min(1).max(100),
	}),
]);

// === Narrator suggest answers ===

export const suggestAnswersSchema = z.object({
	questions: z
		.array(
			z.object({
				question: z.string().min(1),
				header: z.string().min(1),
				options: z.array(
					z.object({
						label: z.string(),
						description: z.string(),
					}),
				),
				multiSelect: z.boolean().optional(),
			}),
		)
		.min(1),
});

// === chapter edges ===
export const createChapterEdgeSchema = z.object({
	sourceId: z.string().min(1),
	targetId: z.string().min(1),
	type: z.enum(["dependency"]),
	metadata: z
		.object({
			description: z.string().max(500).optional(),
		})
		.optional(),
});

// === graph positions ===
export const updateGraphPositionsSchema = z.object({
	positions: z
		.array(
			z.object({
				chapterId: z.string().min(1),
				x: z.number().finite(),
				y: z.number().finite(),
			}),
		)
		.max(500),
});

// === chapter split ===
export const splitChapterSchema = z.object({
	commitSha: z.string().min(1),
	newFork: z.object({
		title: z.string().min(1).max(200),
		description: z.string().max(2000).optional(),
		inheritMode: z.enum(["full", "compressed", "fresh"]).default("full"),
	}),
});

// === batch fork ===
export const batchForkSchema = z.object({
	forks: z
		.array(
			z.object({
				title: z.string().min(1).max(200),
				description: z.string().max(2000).optional(),
				inheritMode: z.enum(["full", "compressed", "fresh"]).default("full"),
				role: z.enum(["trunk", "branch", "exploration"]).default("branch"),
			}),
		)
		.min(1)
		.max(10),
});

// === exploration groups ===
export const createExplorationGroupSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	baseChapterId: z.string().min(1),
	branches: z
		.array(
			z.object({
				title: z.string().min(1).max(200),
				description: z.string().max(2000).optional(),
				inheritMode: z.enum(["full", "compressed", "fresh"]).default("full"),
			}),
		)
		.min(2)
		.max(10),
});

export const updateExplorationGroupSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
});

// === cherry-pick ===
export const cherryPickSchema = z.object({
	sourceChapterId: z.string().min(1),
	commitShas: z.array(z.string().min(1)).min(1),
});

// === commits list ===
export const listCommitsSchema = z.object({
	since: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

// === Git operations ===

const filePathArray = z.array(z.string().min(1)).min(1);

export const gitStageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitUnstageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitCommitSchema = z.object({
	message: z.string().min(1).max(500),
});

export const gitDiscardSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitStashSchema = z.object({
	action: z.enum(["push", "pop", "drop"]),
	message: z.string().max(200).optional(),
	index: z.number().int().min(0).optional(),
});

export const gitResetSchema = z.object({
	target: z.string().min(1).max(100),
	mode: z.enum(["soft", "hard"]),
});

export const gitLogQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	skip: z.coerce.number().int().min(0).default(0),
});

export const gitDiffQuerySchema = z.object({
	file: z.string().min(1),
	staged: z
		.string()
		.optional()
		.transform((v) => v === "true"),
});
