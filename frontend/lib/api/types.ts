export type {
	CompactAttempt,
	CompactMessageBlock,
	CompactMessageDetail,
} from "@shared/compact-message";

import type { TextCitation } from "@shared/citations";
import type { FileReference, FileReferenceContext } from "@shared/file-reference";
import type { LocalizedValue } from "@shared/i18n-locales";
import type { NarratorVisibility, NarratorWriteAudience } from "@shared/narrator-access";
import type { SubagentToolInputSummary } from "@shared/subagent-tool-summary";

export type { TextCitation } from "@shared/citations";
export type { SubagentToolInputSummary } from "@shared/subagent-tool-summary";

export type ChangelogEntry = {
	version: string;
	date: string;
} & LocalizedValue<string>;

/** One Kimi usage window (5-hour / weekly / monthly) as cached by the server. */
export interface KimiUsageWindow {
	used: number | null;
	limit: number | null;
	remaining: number | null;
	resetTime: string | null;
}

/**
 * Per-provider Kimi (kimi.com / kimi.ai) usage cache entry.
 *
 * `GET /api/kimi/usages` is readable by any signed-in user, but the upstream error text
 * is not: it is verbatim provider output about the deployment's own account and can
 * contain a key fragment or an internal URL, so the server sends `error` only to admins
 * and everyone else gets `hasError`. Both fields are optional here because a given
 * response carries exactly one of them — read them through `kimiUsageFailed()` rather
 * than testing `error` directly, or a non-admin's failed fetch reads as a successful one.
 */
export interface KimiUsageCache {
	fiveHour: KimiUsageWindow | null;
	weekly: KimiUsageWindow | null;
	monthly: KimiUsageWindow | null;
	extraWindows: Array<{ label: string } & KimiUsageWindow>;
	fetchedAt: number;
	/** Admin-only: the upstream failure text. Absent for non-admins. */
	error?: string | null;
	/** Non-admin substitute for `error`: that it failed, without saying how. */
	hasError?: boolean;
}

/**
 * How a third-party component reaches the user — which is what determines our
 * attribution obligations, not which `package.json` field listed it.
 */
export type LicenseEntryKind = "bundled" | "runtime" | "development";

/** Where an entry's license text came from, so the page never overstates it. */
export type LicenseTextSource = "package" | "spdx-template" | "missing";

/**
 * One third-party component, WITHOUT its license text.
 *
 * Texts are fetched individually by `textId`: the full set is ~1.1 MB against
 * ~260 KB of metadata, and the page shows one at a time.
 */
export interface LicenseSummary {
	name: string;
	version: string;
	/** The license we rely on. For dual-licensed components, the branch selected. */
	license: string;
	/** Upstream's raw disjunction, when a selection narrowed it. */
	declaredLicense?: string;
	/** Why that branch was selected. */
	selectionReason?: string;
	author: string;
	repository: string;
	kind: LicenseEntryKind;
	textId?: string;
	textSource: LicenseTextSource;
	/** Present when the component ships a NOTICE file (Apache-2.0 §4(d)). */
	noticeTextId?: string;
	/**
	 * How a bundled component reaches the user. Absent for npm packages, where
	 * `dependencies` already answers it.
	 */
	distributedVia?: string;
}

/** A defect in the manifest, surfaced rather than swallowed. */
export interface LicenseProblem {
	severity: "error" | "warn";
	name?: string;
	message: string;
}

export interface LicenseManifestResponse {
	entries: LicenseSummary[];
	problems: LicenseProblem[];
	generatedAt: number;
	/** `filesystem` in development, `embedded` in a compiled binary. */
	source: "filesystem" | "embedded" | "unavailable";
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

export interface SearchFallback {
	feature?: string;
	entity?: string;
	from?: string;
	to?: string;
	reason?: string;
	error?: string;
	message?: string;
	code?: string;
	[key: string]: unknown;
}

export interface SearchMetadata {
	degraded?: boolean;
	fallbacks?: SearchFallback[];
	mode?: string;
	ftsReady?: boolean | null;
	shortQuery?: boolean;
	requestedEntities?: string[];
	[key: string]: unknown;
}

export interface SearchResponse {
	results: ApiEntity[];
	degraded?: boolean;
	fallbacks?: SearchFallback[];
	searchMetadata?: SearchMetadata;
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

/**
 * Server-side background scan job state. The scan outlives the page that started
 * it; clients poll this to observe progress and pick up the final result.
 */
export type StorageScanJobStatus = "idle" | "running" | "complete" | "error" | "cancelled";

export interface StorageScanJobState {
	status: StorageScanJobStatus;
	progressMessage: string | null;
	progressDetail: { done: number; total: number } | null;
	categories: StorageCategoryResult[];
	result: StorageScanResult | null;
	error: string | null;
	startedAt: number | null;
	finishedAt: number | null;
}

export interface DatabaseCleanupCandidateSummary {
	count: number;
	approxBytes: number;
	blockedCount: number;
	oldestAt: string | null;
	retentionDays?: number;
}

export type DatabaseStorageCategoryKey =
	| "sessions"
	| "apiRequests"
	| "projects"
	| "runtime"
	| "users"
	| "search"
	| "gateway"
	| "benchmarks"
	| "internal"
	| "free"
	| "other";

export type DatabaseTableKind = "table" | "virtual" | "shadow" | "internal";

export interface DatabaseStorageCategorySummary {
	key: DatabaseStorageCategoryKey;
	tableCount: number;
	rowCount: number;
	approxContentBytes: number;
	diskBytes: number;
	indexBytes: number;
	totalBytes: number;
}

export interface DatabaseStorageTableSummary {
	name: string;
	category: DatabaseStorageCategoryKey;
	kind: DatabaseTableKind;
	rowCount: number | null;
	approxContentBytes: number;
	diskBytes: number;
	indexBytes: number;
	totalBytes: number;
	/** Measurement failed (usually lock contention); the zeroes here mean unknown, not empty. */
	readFailed?: boolean;
}

/** Tables the scan could not measure, so the breakdown understates real usage. */
export interface DatabaseStorageReadFailures {
	tableCount: number;
	tableNames: string[];
}

export interface DatabaseStorageBreakdown {
	mainBytes: number;
	walBytes: number;
	shmBytes: number;
	pageSize?: number;
	pageCount?: number;
	freelistBytes?: number;
	objectBytes?: number;
	scanMode?: "dbstat" | "approximate";
	categories?: DatabaseStorageCategorySummary[];
	topTables?: DatabaseStorageTableSummary[];
	readFailures?: DatabaseStorageReadFailures;
	cleanupCandidates: {
		archivedSessions: DatabaseCleanupCandidateSummary;
		staleSessions: DatabaseCleanupCandidateSummary;
		apiRequestDumps: DatabaseCleanupCandidateSummary;
		/**
		 * Aged tool-call input/output payloads. Clears the columns and KEEPS the rows —
		 * they carry the tree hashes that file-history revert depends on.
		 */
		toolCallPayloads: DatabaseCleanupCandidateSummary;
	};
}

export type DatabaseCleanupTarget =
	| "archivedSessions"
	| "staleSessions"
	| "apiRequestDumps"
	| "toolCallPayloads";

export type DatabaseCleanupBlockedReasonCode =
	| "chapterBound"
	| "runningTerminal"
	| "backgroundRunning"
	| "nonArchived"
	| "nonStaleStatus"
	| "recentActivity";

export type DatabaseCleanupWarningCode = string;

export interface FallbackDiagnostics {
	supported?: boolean;
	degraded?: boolean;
	fallback?: boolean;
	fallbacks?: unknown[];
	reason?: string;
	error?: string;
	message?: string;
	code?: string;
}

export interface DatabaseCleanupPreviewCounts {
	sessions: number;
	narrators: number;
	descendantNarrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
	dumpsCleared: number;
}

export interface DatabaseCleanupNarratorSample extends FallbackDiagnostics {
	type: "narrator";
	id: string;
	title?: string | null;
	status?: string;
	lastActivityAt?: string;
	messageCount?: number;
	descendantNarratorCount: number;
	approxBytes?: number;
}

export interface DatabaseCleanupApiRequestSample extends FallbackDiagnostics {
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

export interface DatabaseCleanupPreviewResult extends FallbackDiagnostics {
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

export interface DatabaseVacuumResult {
	ok: true;
	beforeBytes: number;
	afterBytes: number;
	freedBytes: number;
	freelistBeforeBytes: number;
	freelistAfterBytes: number;
	vacuumRan: boolean;
	checkpointRan: boolean;
	optimized: boolean;
	durationMs: number;
}

export interface RuntimeScanResult {
	terminals: {
		running: number;
		exited: number;
		orphanSockets: number;
	} & FallbackDiagnostics;
	containers: {
		running: number;
		stopped: number;
		podmanAvailable: boolean;
	} & FallbackDiagnostics;
	browsers: {
		processRunning: boolean;
		connected: boolean;
		activeSessions: number;
		memorySessions?: number;
		persistedSessions?: number;
		dbError?: string;
		runtime?: string;
		requiresChrome?: boolean;
		cleanupSupported?: boolean;
		sessionApiSupported?: boolean;
	} & FallbackDiagnostics;
	scannedAt: number;
}

export interface SubagentToolCallTiming {
	startedAt?: string | number | null;
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	durationMs?: number | null;
}

export interface SubagentToolCallHeader {
	toolCallId: string | null;
	toolUseId: string;
	toolName: string;
	status: string;
	createdAt: string | number | null;
	timing: SubagentToolCallTiming | null;
	/**
	 * Whitelisted SHORT input keys for the activity row label (Bash's
	 * `description`, a file tool's `file_path`, ...). The `input_json` blob never
	 * reaches the client on either route:
	 *  - REST fetch / reconnect catch-up: projected inside SQLite.
	 *  - Live WebSocket: projected in memory from the input the server already
	 *    holds, and attached ONLY to the reduced parent copy of `tool_started`,
	 *    `tool_use_chunk` (from the fields extracted so far, so the row is labelled
	 *    mid-stream) and `tool_completed` (only when a permission rewrote the
	 *    input). Same 10 keys and same 200-char cap as the SQL side.
	 *
	 * Absent when the tool input had none of the keys, was unparseable, or exceeded
	 * the size guard. One live gap remains: the four recovery broadcasts in
	 * `narrator-subagent-recovery.ts` re-announce a PARENT Agent/Await card on the
	 * narrator's own page (no `parentToolUseId`, full `input` included), so they
	 * feed the normal tool card rather than an activity row and need no summary.
	 * See `SubagentActivityRow`.
	 */
	inputSummary?: SubagentToolInputSummary;
}

export interface SubagentFileChanges {
	files: {
		subagentNarratorId?: string | null;
		deviceId?: string | null;
		workspacePath?: string | null;
		filePath: string;
		linesAdded: number | null;
		linesRemoved: number | null;
		editCount: number;
		unmeasuredCount?: number;
		outsideParentWorkspace?: boolean | null;
	}[];
	totalFiles: number;
	totalUnmeasured: number;
	bashTouchedCount: number;
	countsTruncated: boolean;
	attributionScope?: "legacy_unscoped";
	scope?: {
		sourceToolUseId: string | null;
		startedAt?: string | null;
		completedAt?: string | null;
	};
}

export interface SubagentActivitySummary {
	subagentNarratorId: string | null;
	model: string | null;
	/** Effective tier, already resolving a null narrator override through the global default. */
	reasoningEffort?: string | null;
	latestToolCalls: SubagentToolCallHeader[];
	/** Bounded file-change summary projected for the child activity card. */
	fileChanges?: SubagentFileChanges;
	/**
	 * The child is TAKEN OVER by the user (the parent's call is blocked until the
	 * user stops it). Carried on the snapshot because the snapshot is the reconnect
	 * catch-up channel — without it, a client reconnecting mid-takeover would keep
	 * rendering a plain "running" card.
	 */
	takenOver?: boolean;
}

export interface SubagentActivityCatchUp {
	parentToolUseId: string;
	activity: SubagentActivitySummary;
}

export interface ExecutionTargetIdentity {
	deviceId: string;
	backendKind?: "local" | "remote";
	cwd: string;
	pathFlavor?: "posix" | "windows" | "spec";
	lexicalPath?: string;
	canonicalPath?: string;
	runtimeGeneration?: number;
	resolvedFilePath?: string;
	selectionSource?: "explicit" | "session_default" | "local_default";
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
	startedAt?: string | number | null;
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
	executionTargets?: ExecutionTargetIdentity[];
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	errorMessage?: string;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	permissionDecidedAt?: string | null;
	permissionDecidedBy?: string | null;
	tcId?: string;
	tcCreatedAt?: string | number | null;
	subtype?: string;
	summary?: string;
	previewUrl?: string;
	imageId?: string;
	filename?: string;
	mediaType?: string;
	uploadNarratorId?: string;
	/** Lightweight latest activity for Agent/Task/Send subagent cards. */
	_subagentActivity?: SubagentActivitySummary;
	/**
	 * Child narrator id of a RUNNING `Await({type:"agent"})` or single-target Send,
	 * resolved server-side from the call's target selector (legacy field name).
	 *
	 * Declared explicitly (the index signature would already admit it) because it is
	 * the ONLY source of that id before the wait returns: a call in flight has no
	 * output, so neither `_metadata.subagentId` nor the `<subagent_id>` tag exists
	 * yet. See `AWAIT_AGENT_RESOLVED_FIELD` in server/services/narrator-messages.ts
	 * for why it is kept out of `_metadata`.
	 */
	_awaitAgentNarratorId?: string;
	/** Accepted/queued Send receipts; message location must confirm persistence. */
	_sendDeliveryTargets?: import("@shared/communication-tool").SendDeliveryTarget[];
	_sendDeliveryTargetCount?: number;
	/**
	 * The subagent this call is waiting on is currently TAKEN OVER by the user, so
	 * the call is blocked until the takeover is stopped.
	 *
	 * Server-DERIVED runtime state (`TAKEN_OVER_FIELD` in
	 * server/services/await-agent-resolution.ts), deliberately kept out of
	 * `_metadata`: it must not reach the detail classifier, which would turn it into
	 * an extra row and grow the card. Painted as a badge in the already-fixed header
	 * row instead. Takeover authority is in-memory server-side, so this flag simply
	 * stops appearing after a restart.
	 */
	_takenOver?: boolean;
	/** Source citations on assistant text blocks, indexed against `text`. */
	citations?: TextCitation[];
	fileReferenceContext?: FileReferenceContext;
	reference?: FileReference;
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
	executionAttempt?: number;
	_sendDeliveryTargets?: import("@shared/communication-tool").SendDeliveryTarget[];
	_sendDeliveryTargetCount?: number;
	toolUseId: string;
	toolName: string;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
	executionTargets?: ExecutionTargetIdentity[];
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	errorMessage?: string;
	permissionDecidedBy?: string | null;
	permissionDecidedAt?: string | null;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	resultMessageId?: string | null;
	createdAt?: string | number | null;
	/** Lightweight latest activity for Agent/Task/Send subagent cards. */
	_subagentActivity?: SubagentActivitySummary;
	/** See `BaseContentBlock._takenOver`. */
	_takenOver?: boolean;
}

export type PathFlavor = "posix" | "windows";
export type OAuthRuleTargetGroup = "global" | "selfRegistered";
export type RuleTargetSelector =
	| { kind: "all" }
	| { kind: "host" }
	| { kind: "device"; deviceId: string }
	| { kind: "oauthGroup"; group: OAuthRuleTargetGroup };

/** Legacy transport field retained while older servers still read `deviceScope`. */
export type RuleDeviceScope = string | null;

export interface LegacyRuleTargetFields {
	selector?: RuleTargetSelector;
	targetKind?: RuleTargetSelector["kind"] | null;
	targetValue?: string | null;
	deviceScope?: RuleDeviceScope;
}

export function normalizeRuleTargetSelector(input: LegacyRuleTargetFields): RuleTargetSelector {
	if (input.selector) return input.selector;
	if (input.targetKind === "host") return { kind: "host" };
	if (input.targetKind === "device" && input.targetValue) {
		return { kind: "device", deviceId: input.targetValue };
	}
	if (
		input.targetKind === "oauthGroup" &&
		(input.targetValue === "global" || input.targetValue === "selfRegistered")
	) {
		return { kind: "oauthGroup", group: input.targetValue };
	}
	const scope = input.deviceScope?.trim();
	if (!scope) return { kind: "all" };
	if (scope === "local" || scope === "host") return { kind: "host" };
	if (scope === "global" || scope === "selfRegistered") {
		return { kind: "oauthGroup", group: scope };
	}
	return { kind: "device", deviceId: scope };
}

export function selectorToLegacyDeviceScope(selector: RuleTargetSelector): RuleDeviceScope {
	switch (selector.kind) {
		case "all":
			return null;
		case "host":
			return "local";
		case "device":
			return selector.deviceId;
		case "oauthGroup":
			return selector.group;
	}
}

export interface WhitelistDir extends LegacyRuleTargetFields {
	id: string;
	narratorId: string;
	path: string;
	pathFlavor?: PathFlavor | null;
	pathKey?: string | null;
	accessLevel: "readOnly" | "readWrite" | "full";
	enabled: boolean;
	selector: RuleTargetSelector;
	createdAt: string;
	updatedAt?: string | null;
}

export interface BlacklistDir extends LegacyRuleTargetFields {
	id: string;
	narratorId: string;
	path: string;
	pathFlavor?: PathFlavor | null;
	pathKey?: string | null;
	denyLevel: "denyWrite" | "denyAll";
	enabled: boolean;
	selector: RuleTargetSelector;
	createdAt: string;
	updatedAt?: string | null;
}

export interface WhitelistCmd extends LegacyRuleTargetFields {
	id: string;
	narratorId: string;
	pattern: string;
	enabled: boolean;
	selector: RuleTargetSelector;
	createdAt: string;
	updatedAt?: string | null;
}

export interface BlacklistCmd extends LegacyRuleTargetFields {
	id: string;
	narratorId: string;
	pattern: string;
	denyPrompt: string | null;
	enabled: boolean;
	selector: RuleTargetSelector;
	createdAt: string;
	updatedAt?: string | null;
}

export interface DirectoryWhitelistRuleInput {
	path: string;
	pathFlavor?: PathFlavor;
	accessLevel: "readOnly" | "readWrite" | "full";
	enabled?: boolean;
	selector: RuleTargetSelector;
}

export interface DirectoryBlacklistRuleInput {
	path: string;
	pathFlavor?: PathFlavor;
	denyLevel: "denyWrite" | "denyAll";
	enabled?: boolean;
	selector: RuleTargetSelector;
}

export interface CommandWhitelistRuleInput {
	pattern: string;
	enabled?: boolean;
	selector: RuleTargetSelector;
}

export interface CommandBlacklistRuleInput {
	pattern: string;
	denyPrompt?: string | null;
	enabled?: boolean;
	selector: RuleTargetSelector;
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
	proxyMode: "default" | "direct" | "system" | "custom" | null;
	proxyUrl: string | null;
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

export interface BufferedImageSummary {
	imageId: string;
	filename: string;
	mediaType: string;
	width?: number;
	height?: number;
	/** Narrator that owns the file, for `/api/uploads/:narratorId/:imageId`. */
	uploadNarratorId?: string;
}

/**
 * Text-file attachment of a queued message.
 *
 * `index` is the identity to send back when editing: a taken-over subagent's
 * queue can hold two files with the same name, so filenames are not unique.
 */
export interface BufferedTextFileSummary {
	index: number;
	filename: string;
	size: number;
}

export interface BufferMessageSummary {
	id: string;
	state?: "queued" | "failed";
	error?: string | null;
	text: string;
	bufferedAt: string;
	imageCount: number;
	/** Optional so a snapshot from an older server still parses. */
	images?: BufferedImageSummary[];
	textFiles?: BufferedTextFileSummary[];
	fileReferences?: FileReference[];
	creator?: BufferCreator | null;
	priority?: boolean;
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
	/** Set when this assistant message's text was manually edited and persisted. */
	editedAt?: string | null;
	editedBy?: string | null;
	/** Original contentJson captured on first edit, so the UI can reveal the unedited text. */
	originalContentJson?: ContentBlock[] | null;
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
	/**
	 * Synthetic live row only: index of the text/reasoning block still being written,
	 * or -1 when the model has moved on to tool calls.
	 *
	 * Set by the streaming accumulators, which are the only place that sees the real
	 * arrival order (`buildStreamingMsg` appends tool cards after the text lanes, so
	 * array position cannot express it). Consumers read it through
	 * `@shared/pretext-layout/streaming-live-blocks`, never directly.
	 */
	liveBlockIndex?: number;
}

export interface PaginatedNarrators {
	items: ApiEntity[];
	hasMore: boolean;
	nextCursor: string | null;
	totalCount: number;
}

export interface PretextDocumentPageResult {
	messages: TreeMessage[];
	minSeq: number | null;
	maxSeq: number | null;
	/** More rows exist newer than this page (ascending `afterSeq` reads / `beforeSeq` pages). */
	hasNext: boolean;
	/** More rows exist older than this page (drives reverse infinite scroll). */
	hasPrev: boolean;
	messageVersion: number;
}

export interface MessageLocationResult {
	messageId: string;
	topLevelMessageId: string;
	seq: number;
}

export interface NarratorMessageSearchResult {
	messageId: string;
	seq: number;
	role: string;
	snippet: string;
	preview: string;
	createdAt: string;
}

export interface NarratorMessageSearchResponse {
	results: NarratorMessageSearchResult[];
}

export type CodexPlanTier = "free" | "plus" | "team" | "k12" | "prolite" | "pro" | "other";
export type PublicCodexPlanTier = Exclude<CodexPlanTier, "other">;
export type CodexLoadBalancingMode = "priority" | "balanced" | "tier-balanced";
export type CodexUsageWindowType = "5h" | "weekly" | "monthly" | "unknown";

export interface PublicCodexQuotaSegment {
	type: PublicCodexPlanTier;
	remainingAccountEquivalents: number;
	totalAccountEquivalents: number;
	averageRemainingPercent: number | null;
	nextResetAt: number | null;
	trackedAccountCount?: number;
	modeledAccountCount?: number;
	unmodeledAccountCount?: number;
}

export interface PublicCodexQuotaTrendPoint {
	timestamp: number;
	byType: Partial<Record<PublicCodexPlanTier, number>>;
}

export interface PublicCodexQuotaOverview {
	generatedAt: string;
	unit: "account_equivalent";
	totalRemainingAccountEquivalents: number;
	totalAccountEquivalents: number;
	trackedAccountCount?: number;
	modeledAccountCount?: number;
	unmodeledAccountCount?: number;
	segments: PublicCodexQuotaSegment[];
	trend: {
		generatedAt: string;
		points: PublicCodexQuotaTrendPoint[];
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
	limit_window_seconds?: number;
	window_type: CodexUsageWindowType;
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
	/** Rate-limit reset credits available for immediate window resets, when reported upstream. */
	reset_credits_available?: number;
	queriedAt: string;
}

export type CodexAuthMode = "oauth" | "personal_access_token" | "agent_identity";

export interface CodexCredentialEntry {
	id: string;
	displayName?: string;
	authMode?: CodexAuthMode;
	accountId?: string;
	email?: string;
	priority: number;
	disabled: boolean;
	disabledReason?: string;
	/** Epoch milliseconds when archived (retired from the pool, data retained). */
	archivedAt?: number;
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
	modeledUsageCount?: number;
	unmodeledUsageCount?: number;
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
	totalModeledUsageAccounts?: number;
	totalUnmodeledUsageAccounts?: number;
	missingUsageAccounts: number;
	zeroUsageAccounts: number;
	scheduledAccountCount: number;
	nextResetAt?: number;
	byTier: Record<CodexPlanTier, CodexUsageTierStats>;
}

export interface CodexUsageForecastPoint {
	timestamp: number;
	byTier: Partial<Record<CodexPlanTier, number>>;
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

// ─────────────────────────────────────────────────────────────────────────────
// Narrator access control (sharing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two narrator audiences, re-exported from the shared module that also carries the
 * nesting rule between them (`WRITE_AUDIENCE_BY_VISIBILITY`).
 *
 * Defined there rather than here so the panel greys out the write audiences a given
 * read audience forbids using the same table the server validates against — a second
 * copy of those enums would eventually disagree about which pairs are legal.
 */
export type { NarratorVisibility, NarratorWriteAudience };

/** read = follow along; write = also send messages, decide permissions, change settings. */
export type NarratorGrantAccess = "read" | "write";

export interface NarratorGrant {
	id: string;
	userId: string;
	username: string | null;
	avatarColor: string | null;
	avatarImageId: string | null;
	access: NarratorGrantAccess;
	createdAt: string;
}

export interface NarratorAccess {
	narratorId: string;
	visibility: NarratorVisibility;
	writeAudience: NarratorWriteAudience;
	/** null for narrators created before access control; only admins can manage those. */
	owner: {
		userId: string;
		username: string | null;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	grants: NarratorGrant[];
	/** Whether the current user may change visibility, grants or ownership. */
	canManage: boolean;
	/**
	 * True for a subagent: the values above describe the main session that governs its
	 * access, and nothing here can be edited in place.
	 */
	isDelegated: boolean;
	/** The narrator whose settings govern access, when that is not this one. */
	delegatesToNarratorId: string | null;
}

/** A project's three membership tiers. Ordered by increasing authority. */
export type ProjectRole = "read" | "write" | "manage";

export type ProjectVisibility = "private" | "public";

export interface ProjectMember {
	grantId: string;
	userId: string;
	username: string | null;
	avatarColor: string | null;
	avatarImageId: string | null;
	role: ProjectRole;
	createdAt: string;
}

export interface ProjectAccess {
	projectId: string;
	visibility: ProjectVisibility;
	/** null for projects created before project ACLs; only admins can manage those. */
	owner: {
		userId: string;
		username: string | null;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	members: ProjectMember[];
	/** Whether the current user may change visibility, members or ownership. */
	canManage: boolean;
}

/**
 * Per-user outcome of a batch member add, plus the resulting state.
 *
 * A batch can partly succeed (an unknown user id, or the owner, is refused while the
 * rest are added), so the panel reports what actually happened instead of assuming
 * the whole request applied.
 */
export interface ProjectMemberBatchResult {
	added: string[];
	skipped: string[];
	failed: string[];
	access: ProjectAccess;
}

export interface NarratorGrantBatchResult {
	granted: string[];
	/** Already had this exact access. */
	skipped: string[];
	/** Unknown user, or the owner (who needs no grant). */
	failed: string[];
	access: NarratorAccess;
}
