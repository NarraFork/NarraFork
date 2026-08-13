import type { ExecutionTargetIdentity } from "@frontend/lib/api/types";

export type ExecutionLogStatus = "initializing" | "pending" | "running" | "success" | "fail";

export interface ExecutionLogRecord {
	id: string;
	narratorId: string;
	toolUseId: string;
	toolName: string;
	status: ExecutionLogStatus;
	/** Indexed execution-start moment: execution → permission → stream → created. */
	startedAt: string;
	createdAt: string;
	streamStartedAt: string | null;
	permissionStartedAt: string | null;
	executionStartedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	executionDeviceId: string | null;
	executionCwd: string | null;
	isBackground: boolean;
	errorMessage: string | null;
	provider: string | null;
	model: string | null;
	permissionDecidedBy: string | null;
	permissionDecidedAt: string | null;
	/** Small one-line description built server-side from bounded input fields. */
	summary: string | null;
	narratorTitle: string | null;
	narratorType: string | null;
	subagentType: string | null;
	chapterId: string | null;
	chapterTitle: string | null;
	projectId: string | null;
	projectName: string | null;
}

export interface ExecutionLogDetail extends ExecutionLogRecord {
	messageId: string;
	inputJson: unknown;
	outputJson: unknown;
	/** True when the payload exceeded the server's byte cap and is a preview. */
	inputTruncated: boolean;
	outputTruncated: boolean;
	inputBytes: number | null;
	outputBytes: number | null;
	permissionDenyMessage: string | null;
	permissionDecisionReason: string | null;
	isFileHistoryCheckpoint: boolean;
	treeHashBefore: string | null;
	treeHashAfter: string | null;
	resolvedFilePath: string | null;
	canonicalFilePath: string | null;
	deviceSelectionSource: "explicit" | "session_default" | "local_default" | null;
	executionPathFlavor: "posix" | "windows" | "spec" | null;
	executionTarget: ExecutionTargetIdentity | null;
	executionTargets: ExecutionTargetIdentity[];
	executionPlan: Record<string, unknown> | null;
}

export interface ExecutionLogFilters {
	narratorId?: string;
	includeSubagents?: boolean;
	chapterId?: string;
	projectId?: string;
	toolName?: string;
	status?: ExecutionLogStatus;
	executionDeviceId?: string;
	provider?: string;
	model?: string;
	onlyErrors?: boolean;
	isBackground?: boolean;
	/** Defaults to true server-side; false reveals internal snapshot checkpoints. */
	hideFileHistoryCheckpoints?: boolean;
	startDate?: string;
	endDate?: string;
	q?: string;
	/** Extends `q` into input/output JSON, within the server's bounded window. */
	searchPayload?: boolean;
}

export interface ExecutionLogListResponse {
	records: ExecutionLogRecord[];
	hasMore: boolean;
	nextCursor: string | null;
	limit: number;
	/**
	 * True when a payload search could only read the newest slice of the table.
	 * Surface it: the result is deliberately partial, not empty-because-no-match.
	 */
	payloadSearchTruncated: boolean;
	payloadSearchWindowStart: string | null;
}

export interface ExecutionLogFacets {
	toolNames: string[];
	statuses: ExecutionLogStatus[];
	providers: string[];
	toolNamesSampled: boolean;
}
