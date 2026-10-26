export type TokenRecalculationProtocol = "anthropic" | "openai" | "gemini";
export interface TokenProtocolResolution {
	protocol: TokenRecalculationProtocol;
	fallback: boolean;
}
export interface TokenRecalculationRange {
	/** Inclusive UTC calendar dates. Omitted bounds include all historical dates. */
	startDate?: string;
	endDate?: string;
}
export interface TokenRecalculationJob extends TokenRecalculationRange {
	id: string;
	status: "running" | "completed" | "cancelled" | "failed";
	startedAt: string;
	finishedAt: string | null;
	scanned: number;
	processed: number;
	changed: number;
	skipped: number;
	fallback: number;
	error: string | null;
}
