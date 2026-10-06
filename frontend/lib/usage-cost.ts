export type ReferenceCostStatus = "complete" | "partial" | "unknown";

export interface ReferenceCostSummary {
	costStatus?: ReferenceCostStatus | null;
	costIsPartial?: boolean;
	unpricedRequestCount?: number;
	costMissingFields?: string[] | null;
}

/** Absent status is historical data: do not retrospectively reinterpret it. */
export function referenceCostStatus(
	summary: ReferenceCostSummary,
	amount: number | null | undefined,
): ReferenceCostStatus {
	if (summary.costStatus) return summary.costStatus;
	if (summary.costIsPartial || (summary.unpricedRequestCount ?? 0) > 0) return "partial";
	return amount == null ? "unknown" : "complete";
}

export function formatReferenceCost(
	summary: ReferenceCostSummary,
	amount: number | null | undefined,
	labels: { unknown: string; partial: string },
	formattedAmount?: string,
): string {
	const status = referenceCostStatus(summary, amount);
	if (status === "unknown" || amount == null || !Number.isFinite(amount)) return labels.unknown;
	const formatted = formattedAmount ?? `$${amount.toFixed(6)}`;
	return status === "partial" ? `${formatted} (${labels.partial})` : formatted;
}
