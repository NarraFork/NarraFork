/**
 * tool-progress.ts — the wire shape of a DETERMINATE tool progress measurement,
 * plus the pure derivations every consumer needs from it.
 *
 * Shared because the producer (a tool's execute) and the consumers (the WS
 * handler, the detail classifier, the progress bar) must agree field-for-field:
 * a bar drawn from numbers is only trustworthy if nobody re-interprets them on
 * the way.
 *
 * Distinct from the `tool_progress` heartbeat, which carries elapsed seconds and
 * means "still alive". This one means "N of M done", and only a tool that can
 * genuinely measure that emits it — so the presence of the payload is itself the
 * signal that a real bar (rather than a spinner) is warranted.
 */

/**
 * Human-readable byte count.
 *
 * Lives here, beside the payload, because every consumer of that payload needs
 * exactly this rendering and there is no locale in it to disagree about: a KB/MB/GB
 * boundary is arithmetic, not wording. It previously existed as four byte-identical
 * copies (the tool's formatter, the transfer runner's "mirrors the tool's wording"
 * clone, the detail classifier, the task drawer) — and a mirror maintained by
 * comment is the kind that drifts, at which point the same transfer reports two
 * different sizes depending on which surface you read.
 */
export function formatProgressBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Compact duration for an elapsed or ETA figure.
 *
 * Returns an em dash for a non-finite or negative input rather than a fabricated
 * "0s": an unmeasurable duration and an instantaneous one are different facts, and
 * the reader acts on the difference.
 */
export function formatProgressDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "—";
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = Math.round(seconds % 60);
	if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m${secs}s`;
	const hours = Math.floor(mins / 60);
	return `${hours}h${mins % 60}m`;
}

/** A determinate progress measurement from a running tool. */
export interface ToolProgressPayload {
	/**
	 * Work completed and total, in whatever unit the tool measures (bytes for a
	 * transfer). `total` of 0 or absent means the total is genuinely UNKNOWN — an
	 * upload reports no total because the sender knows only what it has sent, and
	 * an empty file has nothing to total. Consumers must render that as
	 * indeterminate rather than as 0%.
	 */
	completed: number;
	total?: number;
	/**
	 * Item counts for a multi-item operation (files in a directory transfer).
	 * Omitted for a single item.
	 */
	itemsDone?: number;
	itemsTotal?: number;
	/** The item currently being worked on (a relative path). */
	currentItem?: string;
	/** Milliseconds since the operation started; drives rate and ETA. */
	elapsedMs?: number;
	/**
	 * A short label for what the bar is doing ("upload", "download"). Render-only.
	 * Kept as a raw verb rather than a localized phrase: this crosses the wire from
	 * a server with no request locale.
	 */
	phase?: string;
}

/** The derived figures a progress bar shows. */
export interface ToolProgressView {
	/** 0–1, clamped; null when the total is unknown (indeterminate). */
	ratio: number | null;
	/** Rounded whole percent, or null when indeterminate. */
	percent: number | null;
	/** Completed units per second, or null before any rate is observable. */
	ratePerSecond: number | null;
	/** Seconds remaining, or null when either the total or the rate is unknown. */
	etaSeconds: number | null;
}

/**
 * Derive the display figures from a raw payload.
 *
 * The clamping is not defensive noise: a directory total comes from a manifest
 * taken before the walk, so a file that grew in between pushes the running sum
 * past the total. Unclamped that yields a bar wider than its track and a "104%".
 *
 * Every "unknown" case returns null rather than 0. A 0% bar and an "ETA 0s" both
 * read as measurements, and a fabricated measurement is worse than a visibly
 * absent one — the user acts on it.
 */
export function deriveToolProgress(payload: ToolProgressPayload): ToolProgressView {
	const total = typeof payload.total === "number" && payload.total > 0 ? payload.total : null;
	const completed =
		Number.isFinite(payload.completed) && payload.completed > 0 ? payload.completed : 0;

	const ratio = total !== null ? Math.min(1, Math.max(0, completed / total)) : null;
	const percent = ratio !== null ? Math.min(100, Math.round(ratio * 100)) : null;

	const seconds =
		typeof payload.elapsedMs === "number" && payload.elapsedMs > 0 ? payload.elapsedMs / 1000 : 0;
	const ratePerSecond = seconds > 0 && completed > 0 ? completed / seconds : null;

	const etaSeconds =
		total !== null && ratePerSecond !== null
			? Math.max(0, total - completed) / ratePerSecond
			: null;

	return { ratio, percent, ratePerSecond, etaSeconds };
}

/**
 * Whether a payload is worth rendering at all.
 *
 * A payload with no completed work AND no total describes nothing; drawing an
 * empty indeterminate bar for it just adds a row that never changes.
 */
export function hasRenderableProgress(payload: ToolProgressPayload | null | undefined): boolean {
	if (!payload) return false;
	const hasTotal = typeof payload.total === "number" && payload.total > 0;
	return hasTotal || payload.completed > 0;
}

/**
 * Read a payload off an untrusted object (a WS frame, persisted metadata).
 *
 * Returns null unless `completed` is a finite number — the one field every
 * consumer dereferences. Everything else is copied only when it has the right
 * type, so a malformed frame degrades to a barless card instead of `NaN%`.
 */
export function readToolProgressPayload(value: unknown): ToolProgressPayload | null {
	if (!value || typeof value !== "object") return null;
	const o = value as Record<string, unknown>;
	if (typeof o.completed !== "number" || !Number.isFinite(o.completed)) return null;
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v.length > 0 ? v : undefined;
	const out: ToolProgressPayload = { completed: o.completed };
	const total = num(o.total);
	if (total !== undefined) out.total = total;
	const itemsDone = num(o.itemsDone);
	if (itemsDone !== undefined) out.itemsDone = itemsDone;
	const itemsTotal = num(o.itemsTotal);
	if (itemsTotal !== undefined) out.itemsTotal = itemsTotal;
	const currentItem = str(o.currentItem);
	if (currentItem !== undefined) out.currentItem = currentItem;
	const elapsedMs = num(o.elapsedMs);
	if (elapsedMs !== undefined) out.elapsedMs = elapsedMs;
	const phase = str(o.phase);
	if (phase !== undefined) out.phase = phase;
	return out;
}
