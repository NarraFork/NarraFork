export interface ChangelogEntry {
	version: string;
	date: string;
	en: string;
	"zh-CN": string;
}

export interface LearningAction {
	label: string;
	description: string;
	href: string;
}

export interface LearningSection {
	title: string;
	body: string;
}

export interface LearningDocSummary {
	id: string;
	category: string;
	tags: string[];
	title: string;
	summary: string;
	actions: LearningAction[];
}

export interface LearningDoc extends LearningDocSummary {
	sections: LearningSection[];
	workflow: string[];
	bestPractices: string[];
	pitfalls: string[];
	agentHints: string[];
}

export interface LearningCategory {
	id: string;
	label: string;
	description: string;
}

export interface LearningIndexResponse {
	categories: LearningCategory[];
	docs: LearningDocSummary[];
}

export interface LearningSearchResponse {
	results: LearningDocSummary[];
}

export interface StorageCategoryResult {
	key: string;
	sizeBytes: number;
	details?: Record<string, unknown>;
}

export interface StorageScanResult {
	categories: StorageCategoryResult[];
	totalBytes: number;
	scannedAt: number;
}

export interface DatabaseCleanupCandidateSummary {
	count: number;
	approxBytes: number;
	blockedCount: number;
	oldestAt: string | null;
	retentionDays?: number;
}

export interface DatabaseStorageBreakdown {
	mainBytes: number;
	walBytes: number;
	shmBytes: number;
	cleanupCandidates: {
		archivedSessions: DatabaseCleanupCandidateSummary;
		staleSessions: DatabaseCleanupCandidateSummary;
		apiRequestDumps: DatabaseCleanupCandidateSummary;
	};
}

export type DatabaseCleanupTarget = "archivedSessions" | "staleSessions" | "apiRequestDumps";

export type DatabaseCleanupBlockedReasonCode =
	| "chapterBound"
	| "runningTerminal"
	| "backgroundRunning"
	| "nonArchived"
	| "nonStaleStatus"
	| "recentActivity";

export type DatabaseCleanupWarningCode = "deletesUsageHistory";

export interface DatabaseCleanupPreviewCounts {
	sessions: number;
	narrators: number;
	descendantNarrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
	dumpsCleared: number;
}

export interface DatabaseCleanupNarratorSample {
	type: "narrator";
	id: string;
	title: string | null;
	status: string;
	lastActivityAt: string;
	messageCount: number;
	descendantNarratorCount: number;
	approxBytes: number;
}

export interface DatabaseCleanupApiRequestSample {
	type: "apiRequest";
	id: string;
	narratorId: string | null;
	narratorTitle: string | null;
	chapterTitle: string | null;
	createdAt: string;
	approxBytes: number;
}

export interface DatabaseCleanupBlockedItem {
	narratorId: string;
	title: string | null;
	lastActivityAt: string;
	reasonCode: DatabaseCleanupBlockedReasonCode;
	blockingNarratorId: string;
	blockingTitle: string | null;
	blockingStatus: string;
}

export interface DatabaseCleanupPreviewResult {
	target: DatabaseCleanupTarget;
	olderThanDays?: number;
	approxBytes: number;
	oldestAt: string | null;
	counts: DatabaseCleanupPreviewCounts;
	blockedCount: number;
	warningCodes: DatabaseCleanupWarningCode[];
	samples: Array<DatabaseCleanupNarratorSample | DatabaseCleanupApiRequestSample>;
	blocked: DatabaseCleanupBlockedItem[];
}

export interface DatabaseCleanupExecutionResult extends DatabaseCleanupPreviewResult {
	ok: true;
	beforeBytes: number;
	afterBytes: number;
	freedBytes: number;
	vacuumRan: boolean;
	changed: boolean;
}

export interface RuntimeScanResult {
	terminals: { running: number; exited: number; orphanSockets: number };
	containers: { running: number; stopped: number; podmanAvailable: boolean };
	browsers: { processRunning: boolean; connected: boolean; activeSessions: number };
	scannedAt: number;
}

export interface BaseContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	/** Only present on reasoning blocks when translation is enabled */
	translatedText?: string;
	name?: string;
	id?: string;
	input?: Record<string, unknown>;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	streamStartedAt?: string | null;
	permissionStartedAt?: string | null;
	executionStartedAt?: string | null;
	completedAt?: string | null;
	errorMessage?: string;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	permissionDecidedAt?: string | null;
	tcId?: string;
	tcCreatedAt?: string;
	subtype?: string;
	summary?: string;
	previewUrl?: string;
	imageId?: string;
	filename?: string;
	mediaType?: string;
	uploadNarratorId?: string;
	[key: string]: unknown;
}

export interface ToolUseContentBlock extends BaseContentBlock {
	type: "tool_use";
	id: string;
	name: string;
}

export type ContentBlock = BaseContentBlock;

export interface ToolCallRecord {
	id?: string;
	toolUseId: string;
	toolName: string;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	streamStartedAt?: string | null;
	permissionStartedAt?: string | null;
	executionStartedAt?: string | null;
	completedAt?: string | null;
	errorMessage?: string;
	permissionDecidedBy?: string | null;
	permissionDecidedAt?: string | null;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	resultMessageId?: string | null;
	createdAt?: string;
	sideCars?: SideCarRecord[];
}

export interface SideCarRecord {
	id?: string;
	target: "tool_result" | "user_message";
	source: string;
	content: string;
	toolUseId?: string | null;
	orderIndex?: number;
}

export interface WhitelistDir {
	id: string;
	narratorId: string;
	path: string;
	accessLevel: "readOnly" | "readWrite" | "full";
	enabled: boolean;
	createdAt: string;
}

export interface BlacklistDir {
	id: string;
	narratorId: string;
	path: string;
	denyLevel: "denyWrite" | "denyAll";
	enabled: boolean;
	createdAt: string;
}

export interface WhitelistCmd {
	id: string;
	narratorId: string;
	pattern: string;
	enabled: boolean;
	createdAt: string;
}

export interface BlacklistCmd {
	id: string;
	narratorId: string;
	pattern: string;
	denyPrompt: string | null;
	enabled: boolean;
	createdAt: string;
}

// biome-ignore lint/suspicious/noExplicitAny: API entity with dynamic fields
export type ApiEntity = any;

export interface HookApiRecord {
	id: string;
	projectId: string | null;
	event: string;
	matcher: string;
	type: "command" | "http";
	command: string | null;
	url: string | null;
	headers: Record<string, string> | null;
	prompt: string | null;
	model: string | null;
	timeout: number;
	enabled: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface CustomSubagentData {
	name: string;
	description: string;
	toolAccess: string;
	customTools: string[];
	defaultModel: string;
	prompt: string;
}

export interface BufferCreator {
	id: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

export interface BufferMessageSummary {
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	creator?: BufferCreator | null;
	priority?: boolean;
}

export type NarratorGoalStatus = "pending" | "active" | "paused" | "complete" | "cancelled";

export interface NarratorGoal {
	id: string;
	narratorId: string;
	objective: string;
	status: NarratorGoalStatus;
	sortOrder: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdBy: string | null;
	creator?: BufferCreator | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface TreeMessage {
	id: string;
	narratorId: string;
	parentToolUseId: string | null;
	messageUuid?: string | null;
	role: string;
	contentJson: ContentBlock[];
	contentText: string | null;
	toolCalls: ToolCallRecord[];
	sideCars?: SideCarRecord[];
	tokensIn?: number | null;
	costUsd?: number | null;
	turnUsageJson?: {
		prompt_tokens?: number;
		input_tokens?: number;
		output_tokens?: number;
		cached_input_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_creation_5m_tokens?: number;
		cache_creation_1h_tokens?: number;
		reasoning_tokens?: number;
		context_window?: number;
		is_estimated?: boolean;
		[key: string]: unknown;
	} | null;
	contextPercent?: number | null;
	meterUsage?: number | null;
	meterUnit?: string | null;
	subagentModel?: string | null;
	commandText?: string | null;
	creator?: {
		id: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	/** Stable top-level ordering from narrator_message_refs.seq. */
	seq?: number;
	createdAt: string;
	children: TreeMessage[];
	/** Maps each index in the (possibly filtered/reordered) contentJson back to its index in the original contentJson. */
	_blockOriginalIndices?: number[];
}

export interface PaginatedNarrators {
	items: ApiEntity[];
	hasMore: boolean;
	nextCursor: string | null;
	totalCount: number;
}

export interface MessagesAroundOptions {
	messageId: string;
	before?: number;
	after?: number;
}

export interface PaginatedMessages {
	messages: TreeMessage[];
	hasMore: boolean;
	nextCursor: string | null;
	hasMoreAfter?: boolean;
	prevCursor?: string | null;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
}

export type CodexPlanTier = "free" | "plus" | "team" | "prolite" | "pro" | "other";
export type PublicCodexPlanTier = Exclude<CodexPlanTier, "other">;
export type CodexLoadBalancingMode = "priority" | "balanced" | "tier-balanced";

export interface PublicCodexQuotaSegment {
	type: PublicCodexPlanTier;
	remainingAccountEquivalents: number;
	totalAccountEquivalents: number;
	averageRemainingPercent: number | null;
	nextResetAt: number | null;
}

export interface PublicCodexQuotaForecastPoint {
	timestamp: number;
	byType: Partial<Record<PublicCodexPlanTier, number>>;
}

export interface PublicCodexQuotaOverview {
	generatedAt: string;
	unit: "account_equivalent";
	totalRemainingAccountEquivalents: number;
	totalAccountEquivalents: number;
	segments: PublicCodexQuotaSegment[];
	forecast: {
		points: PublicCodexQuotaForecastPoint[];
		types: PublicCodexPlanTier[];
	};
	nextResetAt: number | null;
	usageQueueRunning: boolean;
	schedulerStarted: boolean;
}

export interface CodexUsageWindow {
	used_percent: number;
	remaining_percent: number;
	reset_at: number;
	reset_after_seconds: number;
	window_type: "5h" | "weekly" | "unknown";
}

export interface CodexUsageData {
	plan_type: string;
	primary_window?: CodexUsageWindow;
	secondary_window?: CodexUsageWindow;
	code_review?: {
		used_percent: number;
		remaining_percent: number;
		reset_at: number;
		reset_after_seconds: number;
	};
	queriedAt: string;
}

export interface CodexCredentialEntry {
	id: string;
	displayName?: string;
	accountId?: string;
	email?: string;
	priority: number;
	disabled: boolean;
	disabledReason?: string;
	successCount: number;
	failureCount: number;
	lastUsedAt?: string;
	expiresAt?: number;
	usage?: CodexUsageData;
}

export interface CodexUsageTierStats {
	tier: CodexPlanTier;
	accountCount: number;
	knownUsageCount: number;
	zeroUsageCount: number;
	scheduledAccountCount: number;
	remainingAccountEquivalents: number;
	averageRemainingPercent: number | null;
	nextResetAt?: number;
}

export interface CodexUsageSummary {
	generatedAt: string;
	totalTrackedAccounts: number;
	totalKnownUsageAccounts: number;
	missingUsageAccounts: number;
	zeroUsageAccounts: number;
	scheduledAccountCount: number;
	nextResetAt?: number;
	byTier: Record<CodexPlanTier, CodexUsageTierStats>;
}

export interface CodexUsageForecastPoint {
	timestamp: number;
	byTier: Record<CodexPlanTier, number>;
}

export interface CodexUsageForecast {
	generatedAt: string;
	points: CodexUsageForecastPoint[];
	tiers: CodexPlanTier[];
	unit: "account_equivalent";
}

export interface CodexUsageSchedulerSnapshot {
	nextRunAt?: number;
	scheduledCredentialCount: number;
	dueCredentialCount: number;
	started: boolean;
}
