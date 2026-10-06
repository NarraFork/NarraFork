/** Format an ISO timestamp as relative time (e.g. "5m ago" or "in 5m"). */
export function relativeTime(iso: string | undefined): string {
	if (!iso) return "-";
	const timestamp = new Date(iso).getTime();
	if (!Number.isFinite(timestamp)) return "-";

	const diff = Date.now() - timestamp;
	const absDiff = Math.abs(diff);
	const future = diff < 0;
	const suffix = future ? "" : " ago";
	const prefix = future ? "in " : "";

	if (absDiff < 60_000) return future ? "in <1m" : "<1m ago";
	if (absDiff < 3600_000) return `${prefix}${Math.floor(absDiff / 60_000)}m${suffix}`;
	if (absDiff < 86400_000) return `${prefix}${Math.floor(absDiff / 3600_000)}h${suffix}`;
	return `${prefix}${Math.floor(absDiff / 86400_000)}d${suffix}`;
}
