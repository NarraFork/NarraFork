/** Reference estimation coverage, independent of settings, pricing resolution and the database. */
export type CostStatus = "complete" | "partial" | "unknown";
export interface CostData {
	inputCost: number;
	outputCost: number;
	cacheCreationCost: number;
	cacheReadCost: number;
	totalCost: number;
}
export interface CostEstimate extends CostData {
	status: CostStatus;
	/** Sum of known components; missing prices are not asserted to be zero. */
	knownCost: number;
	missingFields: string[];
}
export function aggregateCostStatus(
	requestCount: number,
	unpricedCount: number,
	partialCount = 0,
): CostStatus {
	if (unpricedCount === 0) return "complete";
	return partialCount > 0 || requestCount > unpricedCount ? "partial" : "unknown";
}
