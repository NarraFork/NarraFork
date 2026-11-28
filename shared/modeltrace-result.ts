export interface ModelTraceOptions {
	fork?: boolean;
	calibrate?: boolean;
}

export interface ModelTraceSampleProgress {
	state: "pending" | "running" | "retrying" | "complete" | "failed" | "cancelled";
	attempt?: number;
	text?: string;
}

/** UI-only diagnostic result; never part of the model's conversation history. */
export interface ModelTraceResultBlock {
	type: "modeltrace_result";
	results: Array<{
		model: string;
		displayName: string;
		/** For partial results, an uncalibrated relative weight. Null when no value is available. */
		probability: number | null;
	}>;
	/** Absent for legacy ModelTrace results. */
	decision?: "scored" | "partial" | "unscorable" | "not_model";
	calibrationRequested?: boolean;
	/** One-use, server-issued capability for the latest eligible result in this narrator. */
	calibrationId?: string;
	sampleProgress?: ModelTraceSampleProgress[];
	/** The calibration card is reporting progress and not yet a final result. */
	progressOnly?: boolean;
	/** Fork only: per-request cache reads; null means not reported or not sent. */
	cacheReadTokens?: (number | null)[];
	error?: string;
}
