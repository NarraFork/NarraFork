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

/**
 * Format a date string as relative time when within 24h,
 * or as a concrete date+time (YYYY-MM-DD HH:mm) when older.
 */
export function formatSmartTime(dateStr: string): string {
	const d = new Date(dateStr);
	const ts = d.getTime();
	if (Number.isNaN(ts)) return "";
	const diff = Date.now() - ts;
	if (diff < 0) return "<1m";
	if (diff < 86400000) return formatRelativeTime(dateStr);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
