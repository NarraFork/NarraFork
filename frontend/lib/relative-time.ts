/** Format an ISO timestamp as relative time (e.g. "5m ago"). */
export function relativeTime(iso: string | undefined): string {
	if (!iso) return "-";
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 60_000) return "<1m ago";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
	return `${Math.floor(diff / 86400_000)}d ago`;
}
