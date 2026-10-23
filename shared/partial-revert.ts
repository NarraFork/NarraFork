/** Explicit best-effort coverage; unknown entries never claim that their writes were restored. */
export interface RevertConflict {
	path: string;
	reason: string;
	/** Immutable effect ids omitted from this file's execution plan. */
	effectIds?: string[];
}
export interface RevertUnknownCoverage {
	scopeId?: string;
	deviceId?: string;
	root?: string;
	activityId?: string;
	operationId?: string;
	toolCallId?: string;
	effectIds?: string[];
	reason: string;
}
export interface PartialRevertResult {
	restoredFiles: string[];
	conflicts: RevertConflict[];
	unknownCoverage: RevertUnknownCoverage[];
}
