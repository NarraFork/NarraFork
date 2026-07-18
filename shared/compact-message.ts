export const MAX_COMPACT_ATTEMPTS = 10;
export const MAX_COMPACT_ERROR_CHARS = 2_000;

export type CompactMessageStatus = "compacting" | "compacted" | "failed";
export type CompactAttemptStatus = "running" | "completed" | "failed";
export type CompactMessageMode = "blocking" | "background";
export type CompactMessageTrigger =
	| "manual"
	| "background"
	| "context_overflow"
	| "reasoning_only"
	| "retry";

export interface CompactAttempt {
	attempt: number;
	model: string;
	status: CompactAttemptStatus;
	startedAt: string;
	finishedAt?: string;
	error?: string;
}

/**
 * Lifecycle metadata stored directly on a compact content block.
 *
 * All fields beyond `type` and `status` remain optional so messages written by
 * older NarraFork versions continue to parse and render normally.
 */
export interface CompactMessageBlock {
	type: "compact";
	status: CompactMessageStatus;
	subtype?: string;
	mode?: CompactMessageMode;
	trigger?: CompactMessageTrigger | string;
	summary?: string;
	error?: string;
	contextPercentBefore?: number;
	contextPercentAfter?: number;
	attempts?: CompactAttempt[];
	/** Successful compact boundary observed when a failed marker retry was prepared. */
	retryBaseCompactMessageId?: string | null;
	[key: string]: unknown;
}

export interface CompactMessageDetail {
	status: CompactMessageStatus;
	summary: string;
	error?: string;
	mode?: CompactMessageMode;
	trigger?: CompactMessageTrigger | string;
	contextPercentBefore?: number;
	contextPercentAfter?: number;
	attempts: CompactAttempt[];
	/** Server-authoritative retry eligibility for this marker's current history position. */
	canRetry?: boolean;
}

export function isCompactRetryableDetail(
	detail: Pick<CompactMessageDetail, "status" | "canRetry">,
): boolean {
	return detail.status === "failed" && detail.canRetry === true;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function truncateCompactError(error: unknown): string {
	const text = String(error ?? "");
	if (text.length <= MAX_COMPACT_ERROR_CHARS) return text;
	return `${text.slice(0, MAX_COMPACT_ERROR_CHARS - 1)}…`;
}

export function normalizeCompactAttempts(value: unknown): CompactAttempt[] {
	if (!Array.isArray(value)) return [];
	const attempts: CompactAttempt[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const record = raw as Record<string, unknown>;
		const attempt = optionalFiniteNumber(record.attempt);
		const model = optionalString(record.model);
		const status = record.status;
		const startedAt = optionalString(record.startedAt);
		if (
			attempt == null ||
			attempt < 1 ||
			!Number.isInteger(attempt) ||
			model == null ||
			startedAt == null ||
			(status !== "running" && status !== "completed" && status !== "failed")
		) {
			continue;
		}
		attempts.push({
			attempt,
			model,
			status,
			startedAt,
			...(optionalString(record.finishedAt)
				? { finishedAt: optionalString(record.finishedAt) }
				: {}),
			...(optionalString(record.error)
				? { error: truncateCompactError(optionalString(record.error)) }
				: {}),
		});
	}
	return attempts.slice(-MAX_COMPACT_ATTEMPTS);
}

export function parseCompactMessageBlock(value: unknown): CompactMessageBlock | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "compact") return null;
	const status = record.status;
	if (status !== "compacting" && status !== "compacted" && status !== "failed") return null;
	return {
		...record,
		type: "compact",
		status,
		...(optionalString(record.subtype) ? { subtype: optionalString(record.subtype) } : {}),
		...(record.mode === "blocking" || record.mode === "background" ? { mode: record.mode } : {}),
		...(optionalString(record.trigger) ? { trigger: optionalString(record.trigger) } : {}),
		...(optionalString(record.summary) !== undefined
			? { summary: optionalString(record.summary) }
			: {}),
		...(optionalString(record.error) !== undefined
			? { error: truncateCompactError(record.error) }
			: {}),
		...(optionalFiniteNumber(record.contextPercentBefore) != null
			? { contextPercentBefore: optionalFiniteNumber(record.contextPercentBefore) }
			: {}),
		...(optionalFiniteNumber(record.contextPercentAfter) != null
			? { contextPercentAfter: optionalFiniteNumber(record.contextPercentAfter) }
			: {}),
		...(Array.isArray(record.attempts)
			? { attempts: normalizeCompactAttempts(record.attempts) }
			: {}),
	};
}

export function startCompactAttempt(
	block: CompactMessageBlock,
	model: string,
	startedAt: string,
): CompactMessageBlock {
	const attempts = normalizeCompactAttempts(block.attempts);
	const nextAttemptNumber = (attempts.at(-1)?.attempt ?? 0) + 1;
	const nextAttempt: CompactAttempt = {
		attempt: nextAttemptNumber,
		model,
		status: "running",
		startedAt,
	};
	return {
		...block,
		status: "compacting",
		error: undefined,
		attempts: [...attempts, nextAttempt].slice(-MAX_COMPACT_ATTEMPTS),
	};
}

export function finishCompactAttempt(
	block: CompactMessageBlock,
	status: "completed" | "failed",
	finishedAt: string,
	error?: unknown,
): CompactMessageBlock {
	const attempts = normalizeCompactAttempts(block.attempts);
	const last = attempts.at(-1);
	const finishedError = status === "failed" ? truncateCompactError(error) : undefined;
	const finishedAttempts = last
		? [
				...attempts.slice(0, -1),
				{
					...last,
					status,
					finishedAt,
					...(finishedError ? { error: finishedError } : { error: undefined }),
				},
			].slice(-MAX_COMPACT_ATTEMPTS)
		: attempts;
	return {
		...block,
		status: status === "completed" ? "compacted" : "failed",
		...(finishedError ? { error: finishedError } : { error: undefined }),
		attempts: finishedAttempts,
	};
}

export function getCompactAttemptModel(block: CompactMessageBlock): string | undefined {
	return normalizeCompactAttempts(block.attempts).at(-1)?.model;
}
