/** Lifecycle and measured-operation timing shared by every tool surface. */

/** Old records retain their total without inventing a lock wait. */
export function resolveToolDisplayDurationMs(source: ToolTimingSource): number | null {
	return resolveToolCallTiming(source).executionMs ?? duration(source.durationMs);
}
export interface FileChangeTiming {
	waitMs: number;
	executionMs: number;
	totalMs: number;
}

export interface ToolTimingSource {
	category?: string | null;
	startedAt?: string | number | null;
	createdAt?: string | number | null;
	streamStartedAt?: string | number | null;
	streamCompletedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	durationMs?: number | null;
	execDurationMs?: number | null;
	fileChangeTiming?: FileChangeTiming | null;
	outputJson?: unknown;
}

export function parseToolTime(value: string | number | null | undefined): number | null {
	if (value == null) return null;
	const time = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

function record(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function duration(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function span(start: number | null, end: number | null): number | null {
	return start != null && end != null && end >= start ? end - start : null;
}

export function resolveToolCallTiming(source: ToolTimingSource) {
	const metadata = record(record(source.outputJson)._metadata);
	const fileTiming = record(source.fileChangeTiming ?? metadata.fileChangeTiming);
	const fileWaitMs = duration(fileTiming.waitMs);
	const fileExecutionMs = duration(fileTiming.executionMs);
	const streamStarted = parseToolTime(source.streamStartedAt);
	const streamCompleted = parseToolTime(source.streamCompletedAt);
	const permissionStarted = parseToolTime(source.permissionStartedAt);
	const executionStarted = parseToolTime(source.executionStartedAt);
	const completed = parseToolTime(source.completedAt);
	const starts = [
		streamStarted,
		parseToolTime(source.createdAt),
		parseToolTime(source.startedAt),
		permissionStarted,
		executionStarted,
	].filter((value): value is number => value != null);
	const started = starts.length ? Math.min(...starts) : null;
	const executionSpanMs = span(executionStarted, completed);
	const knownExecutionSpanMs =
		executionSpanMs ?? duration(source.execDurationMs) ?? duration(metadata.execDurationMs);
	// Invalid receipts (including waits longer than the real execution span) must
	// not manufacture a zero-duration operation or an impossible phase breakdown.
	const hasFileTiming =
		fileWaitMs != null &&
		fileExecutionMs != null &&
		duration(fileTiming.totalMs) != null &&
		(knownExecutionSpanMs == null || fileWaitMs <= knownExecutionSpanMs);
	const executionMs = hasFileTiming
		? knownExecutionSpanMs != null
			? knownExecutionSpanMs - fileWaitMs
			: fileExecutionMs
		: knownExecutionSpanMs;
	const preExecutionWaitMs = span(streamCompleted ?? permissionStarted, executionStarted);
	return {
		started,
		streamStarted,
		streamCompleted,
		permissionStarted,
		executionStarted,
		// Never invent a completion stamp from durationMs: it may include streaming
		// and may have had preceding tools' execution time subtracted by the loop.
		completed,
		streamingMs: span(streamStarted, streamCompleted),
		permissionWaitMs: span(permissionStarted, executionStarted),
		preExecutionWaitMs,
		waitMs:
			preExecutionWaitMs != null || hasFileTiming
				? (preExecutionWaitMs ?? 0) + (hasFileTiming ? fileWaitMs : 0)
				: null,
		executionSpanMs,
		executionMs,
		fileWaitMs: hasFileTiming ? fileWaitMs : null,
		totalMs: duration(source.durationMs) ?? span(started, completed),
	};
}
