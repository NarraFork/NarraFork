/**
 * Format a date string as a compact relative time, e.g. "<1m", "5m", "3h", "2d".
 */
export function formatRelativeTime(dateStr: string): string {
	const ts = new Date(dateStr).getTime();
	if (Number.isNaN(ts)) return "";
	const diff = Date.now() - ts;
	if (diff < 0) return "<1m";
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
