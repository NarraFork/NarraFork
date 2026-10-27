/** UI-only diagnostic result; never part of the model's conversation history. */
export interface ModelTraceResultBlock {
	type: "modeltrace_result";
	results: Array<{
		model: string;
		displayName: string;
		probability: number;
	}>;
	error?: string;
}
