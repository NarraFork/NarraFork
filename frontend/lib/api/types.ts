export interface ChangelogEntry {
	version: string;
	date: string;
	en: string;
	"zh-CN": string;
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
	errorMessage?: string;
	permissionDecidedBy?: string | null;
	permissionDecidedAt?: string | null;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	resultMessageId?: string | null;
	createdAt?: string;
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
	tokensIn?: number | null;
	costUsd?: number | null;
	turnUsageJson?: {
		input_tokens?: number;
		output_tokens?: number;
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
