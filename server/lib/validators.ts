import { z } from "zod";

// Reusable: valid git branch name (no flags, no special chars)
const gitBranchName = z.string().regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name");

/** Reusable schema for whitelist directory entries (global / project level). */
export const whitelistDirEntrySchema = z.object({
	path: z.string().trim().min(1).max(4096),
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).default("readOnly"),
	enabled: z.boolean().default(true),
});

/** Reusable schema for blacklist directory entries (global / project level). */
export const blacklistDirEntrySchema = z.object({
	path: z.string().trim().min(1).max(4096),
	denyLevel: z.enum(["denyWrite", "denyAll"]).default("denyAll"),
	enabled: z.boolean().default(true),
});

/** Reusable schema for command whitelist entries (global / project level). */
export const commandWhitelistEntrySchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	enabled: z.boolean().default(true),
});

/** Reusable schema for command blacklist entries (global / project level). */
export const commandBlacklistEntrySchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	denyPrompt: z.string().max(2000).optional(),
	enabled: z.boolean().default(true),
});

// === Projects ===

export const commandSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/),
	prompt: z.string().min(1).max(400000),
	description: z.string().max(500).optional(),
	params: z
		.array(
			z.object({
				name: z.string().min(1).max(50),
				description: z.string().max(500).optional(),
				required: z.boolean().optional(),
				defaultValue: z.string().max(1000).optional(),
			}),
		)
		.max(20)
		.optional(),
});

export const createProjectSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	// Repository mode: "existing" (default), "init", "clone"
	repoMode: z.enum(["existing", "init", "clone"]),
	gitPath: z.string().min(1),
	// Clone-specific fields
	cloneUrl: z.string().min(1).optional(),
	cloneBranch: gitBranchName.optional(),
	cloneUsername: z.string().max(200).optional(),
	clonePassword: z.string().max(200).optional(),
	flowMode: z.enum(["classic", "ruler"]).default("classic"),
});

export const updateProjectSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(["active", "archived"]).optional(),
	defaultBranch: gitBranchName.optional(),
	startupScript: z.string().max(5000).nullable().optional(),
	copyFiles: z.string().max(5000).nullable().optional(),
	proxyDomain: z.string().max(200).nullable().optional(),
	chapterSettings: z
		.object({
			autoCreateNarrator: z.boolean().optional(),
			commands: z.array(commandSchema).max(100).optional(),
			routines: z
				.object({
					disabledRoutines: z.array(z.string()).optional(),
					enabledRoutines: z.array(z.string()).optional(),
				})
				.optional(),
			whitelistDirs: z.array(whitelistDirEntrySchema).max(50).optional(),
			blacklistDirs: z.array(blacklistDirEntrySchema).max(50).optional(),
			commandWhitelist: z.array(commandWhitelistEntrySchema).max(50).optional(),
			commandBlacklist: z.array(commandBlacklistEntrySchema).max(50).optional(),
			requireReviewBeforeMerge: z.boolean().optional(),
		})
		.optional(),
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
	type: z.enum(["primary"]).optional(),
	model: z.string().optional(),
	systemPrompt: z.string().max(10000).optional(),
	permissionMode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "readOnly", "plan", "dontAsk"])
		.optional(),
	cwd: z.string().min(1).max(4096).optional(),
	reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).nullable().optional(),
	fastMode: z.boolean().optional(),
	relaxedPlan: z.boolean().optional(),
});

export const sendMessageSchema = z.object({
	message: z.string().min(1),
});

export const permissionDecisionSchema = z.object({
	decision: z.enum(["allow", "deny"]),
	message: z.string().optional(),
});

export const createWhitelistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096),
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).default("readOnly"),
	enabled: z.boolean().default(true),
});

export const updateWhitelistDirSchema = z.object({
	accessLevel: z.enum(["readOnly", "readWrite", "full"]).optional(),
	enabled: z.boolean().optional(),
});

export const createBlacklistDirSchema = z.object({
	path: z.string().trim().min(1).max(4096),
	denyLevel: z.enum(["denyWrite", "denyAll"]).default("denyAll"),
	enabled: z.boolean().default(true),
});

export const updateBlacklistDirSchema = z.object({
	denyLevel: z.enum(["denyWrite", "denyAll"]).optional(),
	enabled: z.boolean().optional(),
});

// === Narrator command whitelist/blacklist ===

export const createWhitelistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	enabled: z.boolean().default(true),
});

export const updateWhitelistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
});

export const createBlacklistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200),
	denyPrompt: z.string().max(2000).optional(),
	enabled: z.boolean().default(true),
});

export const updateBlacklistCmdSchema = z.object({
	pattern: z.string().trim().min(1).max(200).optional(),
	denyPrompt: z.string().max(2000).nullable().optional(),
	enabled: z.boolean().optional(),
});

// === Overseers ===

export const overseerPolicySchema = z.object({
	handleEvents: z
		.object({
			permissionRequests: z.boolean().default(true),
			loopDone: z.boolean().default(false),
			errors: z.boolean().default(false),
		})
		.default({ permissionRequests: true, loopDone: false, errors: false }),
	decisionTimeoutSec: z.number().int().min(10).max(600).default(120),
});

export const createOverseerSchema = z.object({
	scope: z.enum(["global", "project"]),
	projectId: z.string().min(1).optional(),
	model: z.string().min(1).optional(),
	systemPrompt: z.string().max(100_000).optional(),
	policy: overseerPolicySchema.optional(),
});

export const updateOverseerSchema = z.object({
	enabled: z.boolean().optional(),
	policy: overseerPolicySchema.optional(),
	model: z.string().min(1).optional(),
	systemPrompt: z.string().max(100_000).optional(),
});

// === Buffered messages ===

export const updateBufferedMessageSchema = z.object({
	text: z.string().min(1).max(100_000),
});

export const reorderBufferSchema = z.object({
	orderedIds: z.array(z.string().min(1)).min(1),
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

export const updateTerminalGraphStateSchema = z.object({
	graphOpened: z.boolean().optional(),
	graphX: z.number().finite().optional(),
	graphY: z.number().finite().optional(),
	graphWidth: z.number().finite().optional(),
	graphHeight: z.number().finite().optional(),
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
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
	forkAtMessageUuid: z.string().optional(),
	/** Explicit commit SHA to fork from (ruler mode). Overrides forkAtMessageUuid. */
	startCommitSha: z.string().optional(),
	/** Explicit parent chapter ID (ruler mode). Defaults to root chapter. */
	parentChapterId: z.string().optional(),
	role: z.enum(["branch", "exploration"]).default("branch"),
	anchorCommitSha: z.string().optional(),
	axisOffset: z.number().optional(),
	crossOffset: z.number().min(0).optional(),
});

export const rulerMergeSchema = z.object({
	sourceChapterId: z.string().min(1),
	strategy: z.enum(["merge", "squash"]).default("merge"),
	message: z.string().max(500).optional(),
});

export const rulerAbandonSchema = z.object({
	chapterId: z.string().min(1),
});

export const rulerRebaseSchema = z.object({
	chapterId: z.string().min(1),
});

export const rulerRebaseResolveSchema = z.object({
	chapterId: z.string().min(1),
	action: z.enum(["abort", "continue"]),
});

export const updateRulerPositionsSchema = z.object({
	positions: z.array(
		z.object({
			chapterId: z.string().min(1),
			anchorCommitSha: z.string().min(1),
			axisOffset: z.number(),
			crossOffset: z.number().min(0),
			width: z.number().positive().optional(),
			height: z.number().positive().optional(),
		}),
	),
});

export const createReviewSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	locale: z.enum(["en", "zh-CN"]).optional(),
	anchorCommitSha: z.string().optional(),
	axisOffset: z.number().optional(),
	crossOffset: z.number().min(0).optional(),
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

export const batchMergeSchema = z
	.object({
		baseChapterId: z.string().min(1),
		sourceChapterIds: z.array(z.string().min(1)).min(1),
		title: z.string().max(200).default(""),
		description: z.string().max(2000).optional(),
		strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
		/** If provided, merge directly into this existing chapter instead of forking */
		targetChapterId: z.string().min(1).optional(),
	})
	.refine((data) => data.targetChapterId || (data.title && data.title.length > 0), {
		message: "title is required when not merging into an existing chapter",
		path: ["title"],
	});

// === Containers ===

export const containerRemoveSchema = z.object({
	deleteVolumes: z.boolean().optional(),
});

// === Volume Snapshots ===

export const createVolumeSnapshotSchema = z.object({
	chapterId: z.string().min(1),
	serviceName: z.string().min(1).max(200),
	containerPath: z
		.string()
		.min(1)
		.max(1000)
		.refine((p) => p.startsWith("/"), "Container path must be absolute")
		.refine((p) => !p.includes(".."), "Container path must not contain '..'"),
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
});

export const applyVolumeSnapshotSchema = z.object({
	targetChapterId: z.string().min(1),
});

export const updateVolumeSnapshotSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).nullable().optional(),
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
	role: z.enum(["admin", "user"]).optional(),
});

export const updateProfileSchema = z.object({
	gitUsername: z.string().max(100).optional(),
	gitEmail: z.string().email().max(254).optional().or(z.literal("")),
});

// === Narrator title ===

export const updateNarratorTitleSchema = z.object({
	title: z.string().min(1).max(200),
});

// === Narrator Fork (standalone narrators only) ===

export const forkNarratorSchema = z.object({
	forkMessageUuid: z.string().min(1),
	title: z.string().min(1).max(200).optional(),
	inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
});

export const updateNarratorModelSchema = z.object({
	model: z.union([
		z.literal("__default__"),
		z
			.string()
			.min(1)
			.max(200)
			.regex(/^[a-zA-Z0-9._:/-]+$/, "Invalid model identifier"),
	]),
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
	showOutputStats: z.boolean().optional(),
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
	// Slash commands
	commands: z.array(commandSchema).max(100).optional(),
	// Send mode
	sendMode: z.enum(["enter", "ctrl+enter"]).optional(),
	// Setup wizard
	setupWizardCompleted: z.boolean().optional(),
});

export const recentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "project", "workspace"]),
	id: z.string().min(1).max(50),
	narratorId: z.string().min(1).max(50).optional(),
	workspaceId: z.string().min(1).max(50).nullish(),
	title: z.string().max(200),
	subtitle: z.string().max(200).optional(),
	status: z.string().max(50).optional(),
	lastVisitedAt: z.number(),
	pinned: z.boolean().optional(),
});

export const upsertRecentTabSchema = recentTabSchema.extend({
	/** When true, only update an existing tab — skip if not already present. */
	updateOnly: z.boolean().optional(),
});

export const removeRecentTabSchema = z.object({
	type: z.enum(["chapter", "narrator", "session", "project", "workspace"]),
	id: z.string().min(1).max(50),
});

export const moveRecentTabSchema = z.object({
	/** Tab key in "type:id" format */
	key: z.string().min(1).max(100),
	/** Target index (0-based), or a named position */
	toIndex: z.number().int().min(0).max(20).optional(),
	/** Named position — mutually exclusive with toIndex */
	position: z.enum(["top", "above_idle"]).optional(),
});

export const pinRecentTabSchema = z.object({
	/** Tab key in "type:id" format */
	key: z.string().min(1).max(100),
	/** Whether to pin or unpin */
	pinned: z.boolean(),
});

export const clearRecentTabsSchema = z.object({
	scope: z.enum(["all", "projects", "inactive_narrators"]),
	/** Optional tab key ("type:id") to keep even if it would otherwise be cleared */
	keepTabKey: z.string().optional(),
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
		updatedPlan: z.string().optional(),
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
		type: z.literal("update_buffer"),
		narratorId: z.string().min(1),
		messageId: z.string().min(1),
		text: z.string().min(1).max(100_000),
	}),
	z.object({
		type: z.literal("remove_buffer"),
		narratorId: z.string().min(1),
		messageId: z.string().min(1),
	}),
	z.object({
		type: z.literal("presence_join"),
		narratorId: z.string().min(1),
	}),
	z.object({
		type: z.literal("presence_leave"),
		narratorId: z.string().min(1),
	}),
	z.object({ type: z.literal("subscribe_stats") }),
	z.object({ type: z.literal("unsubscribe_stats") }),
	z.object({
		type: z.literal("sync_check"),
		narratorId: z.string().min(1),
		version: z.number().int().min(0),
		lastMessageId: z.string().min(1).optional(),
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
				anchorCommitSha: z.string().optional(),
				axisOffset: z.number().finite(),
				crossOffset: z.number().finite().min(0),
				panelExpanded: z.boolean().optional(),
				panelWidth: z.number().finite().optional(),
				panelHeight: z.number().finite().optional(),
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
				role: z.enum(["branch", "exploration"]).default("branch"),
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

// === Project DB (backup/import) ===

export const importProjectSchema = z.object({
	gitPath: z.string().min(1),
});

// === Workspaces ===

export const createWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: z.string().min(2).max(50000), // JSON string of SplitNode
});

export const updateWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: z.string().min(2).max(50000).optional(),
});

export const batchDeleteBlocksSchema = z.object({
	blocks: z
		.array(
			z.object({
				messageId: z.string().min(1),
				blockIndex: z.number().int().min(0),
			}),
		)
		.min(1)
		.max(200),
});

export const forkFromMessagesSchema = z.object({
	messageIds: z.array(z.string().min(1)).min(1).max(500),
	title: z.string().max(200).optional(),
});
