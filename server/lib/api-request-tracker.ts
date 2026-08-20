import { db } from "@server/db";
import { apiRequests, chapters, narrators } from "@server/db/schema";
import {
	RAW_DUMP_INLINE_MAX_BYTES,
	type RawDumpSpillMeta,
	type RawDumpSpillPointer,
	writeOrReuseSpill,
} from "@server/lib/api-request-dump-store";
import { resolveCredentialDisplayName } from "@server/lib/credential-display-name";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { settings } from "@server/lib/settings";
import { calculateCost, type UsageData } from "@server/lib/usage-tracking";
import { sliceToUtf8Budget, utf8Bytes, withinUtf8Budget } from "@server/lib/utf8-budget";
import { recordCredentialUsage } from "@server/services/credential-usage-totals";
import { eq } from "drizzle-orm";
import { diagnosticsFromError, normalizeApiRequestDiagnostics } from "./agent/error-diagnostics";
import type { ApiRequestDiagnostics } from "./agent/types";

export type ApiRequestKind =
	| "narrator"
	| "compact"
	| "context_ask"
	| "fork_summary"
	| "title"
	| "merge_summary"
	| "web_fetch_smart"
	| "reflection"
	| "reasoning_translation"
	| "settings_test"
	| "git_summary"
	/** Summarizing a selection of human chat messages before forwarding it. */
	| "chat_summarize"
	| "internal";

export interface ApiRequestStartOptions {
	narratorId?: string | null;
	provider: string;
	model: string;
	credentialId?: string | null;
	kind?: ApiRequestKind;
}

export interface ApiRequestHandle extends ApiRequestStartOptions {
	id: string;
	startTime: number;
	kind: ApiRequestKind;
}

export interface ApiRequestFinishOptions {
	messageId?: string | null;
	credentialId?: string | null;
	usage?: UsageData | null;
	ttftMs?: number | null;
	durationMs?: number | null;
	contextPercent?: number | null;
	meterUsage?: number | null;
	meterUnit?: string | null;
	rawDump?: unknown;
	errorMessage?: string | null;
	diagnostics?: ApiRequestDiagnostics | null;
	/**
	 * Force-persist the raw dump regardless of the `requestDumpErrorsOnly` setting.
	 * Used when leaked XML tool calls are detected so the raw SSE data is always
	 * downloadable for debugging, even when error-only dumping is enabled.
	 */
	forceDumpPersist?: boolean;
	/**
	 * Turn-scoped key identifying "the same request, re-sent".
	 *
	 * Every attempt of a replayed request inserts its own row with its own force-persisted
	 * dump, and the bodies are byte-identical — so without this each retry spilled another
	 * multi-MB near-duplicate and, through newest-N pruning, evicted unrelated captures to
	 * keep three copies of one request. Attempts sharing a token share one file; each row
	 * still gets a pointer to it, so no attempt looks like a failure with no evidence.
	 *
	 * Omitted means "do not share" — the safe default for anything that is not a replay.
	 */
	dumpSpillReuseToken?: string;
}

export function startApiRequest(options: ApiRequestStartOptions): ApiRequestHandle {
	return {
		...options,
		id: generateId(),
		kind: options.kind ?? "internal",
		startTime: Date.now(),
	};
}

function hasErrorMessage(errorMessage: string | null | undefined): boolean {
	return typeof errorMessage === "string" && errorMessage.trim().length > 0;
}

function normalizedDiagnostics(
	options: ApiRequestFinishOptions,
): ApiRequestDiagnostics | undefined {
	return normalizeApiRequestDiagnostics(options.diagnostics ?? undefined);
}

function allowsFullRawDump(options: ApiRequestFinishOptions): boolean {
	if (options.rawDump == null) return false;
	// Leak detection forces persistence ahead of every gate: the raw SSE must stay
	// downloadable so leaked-XML-tool diagnostics remain actionable. These dumps are
	// already bounded by the collector's *WithLimit helpers.
	if (options.forceDumpPersist) return true;
	// Master switch — never silently persist full dumps unless an admin explicitly enabled
	// them. Diagnostics are handled separately and remain bounded even when this is false.
	if (!settings.agent.requestDumpEnabled) return false;
	if (!settings.agent.requestDumpErrorsOnly) return true;
	return hasErrorMessage(options.errorMessage);
}

export function shouldPersistRawDump(options: ApiRequestFinishOptions): boolean {
	return normalizedDiagnostics(options) != null || allowsFullRawDump(options);
}

function buildPersistableRawDump(
	options: ApiRequestFinishOptions,
	spill?: RawDumpSpillPointer,
): unknown {
	const diagnostics = normalizedDiagnostics(options);
	if (options.rawDump && typeof options.rawDump === "object" && !Array.isArray(options.rawDump)) {
		return {
			...(options.rawDump as Record<string, unknown>),
			...(diagnostics ? { diagnostics } : {}),
			...(spill ? { spill } : {}),
		};
	}
	if (diagnostics || spill) {
		return {
			...(diagnostics ? { diagnostics } : {}),
			...(spill ? { spill } : {}),
		};
	}
	return options.rawDump;
}

/**
 * Absolute ceiling for force-persisted dumps, independent of the user-configurable
 * `requestDumpMaxSize`. Force-persist bypasses the configurable cap on purpose, but a
 * single SQLite row must still never grow without bound (see CLAUDE.md large-field rules).
 *
 * Kept at or above the configurable default: force-persist exists to guarantee a dump is
 * retained, so it must never end up stricter than the ceiling ordinary dumps get.
 */
export const FORCED_DUMP_HARD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Floor for the request-body text kept by {@link shrinkRawDump}, in UTF-8 bytes.
 *
 * Shrinking spends whatever budget the configured ceiling leaves (see
 * {@link shrinkRawDump}); this is only the "even a tiny ceiling keeps something
 * recognizable" minimum. A malformed content part is visible near the head of the
 * serialized body, so a small head is still a usable diagnosis.
 */
const MIN_SHRUNK_BODY_TEXT_BYTES = 32 * 1024;

/**
 * Bytes reserved for the dump's non-body fields (provider, model, url, headers,
 * diagnostics, response metadata) when computing the body budget. Generous on purpose:
 * overshooting only costs a second serialization pass, while undershooting would push
 * the shrunken dump back over the ceiling and lose the body entirely.
 */
const SHRINK_OVERHEAD_BUDGET_BYTES = 64 * 1024;

function truncateText(value: unknown, maxBytes: number): unknown {
	if (typeof value !== "string") return value;
	if (value.length * 3 <= maxBytes) return value;
	const kept = sliceToUtf8Budget(value, maxBytes);
	if (kept.length >= value.length) return value;
	return `${kept}\n\n[... truncated ${
		value.length - kept.length
	} chars to fit agent.requestDumpMaxSize]`;
}

/**
 * Reduce a too-large dump while preserving what a dump exists to answer: the request
 * that was sent and the upstream's reply to it.
 *
 * Previously an oversized dump was replaced wholesale by `{ diagnostics }`. That made
 * the dump feature silently useless in exactly the case it is turned on for: a failing
 * request always carries diagnostics (the agent loop builds them unconditionally), and a
 * request body carrying full conversation history routinely exceeds the 1MB default. The
 * user saw `request: null` / `response: null` and concluded dumping was broken — it was.
 *
 * Shedding order follows what is least useful for diagnosis: SSE events first (a failed
 * request has none worth keeping), then the response body text, then the request body.
 *
 * `maxBytes` is the ceiling the result has to fit in, and the body keeps as much of that
 * budget as the rest of the dump leaves it — a 1MB ceiling must not yield a 24KB body.
 * `maxBytes < 0` means "no ceiling", in which case only the events are shed.
 */
function shrinkRawDump(persistable: unknown, maxBytes: number): unknown {
	if (persistable == null || typeof persistable !== "object" || Array.isArray(persistable)) {
		return persistable;
	}
	const dump = { ...(persistable as Record<string, unknown>) };
	const bodyBudget =
		maxBytes < 0
			? Number.POSITIVE_INFINITY
			: Math.max(MIN_SHRUNK_BODY_TEXT_BYTES, maxBytes - SHRINK_OVERHEAD_BUDGET_BYTES);

	const response = dump.response;
	if (response != null && typeof response === "object" && !Array.isArray(response)) {
		const next = { ...(response as Record<string, unknown>) };
		// Streamed events are the bulkiest and least diagnostic part of a rejected request.
		if (next.events !== undefined) {
			const count = Array.isArray(next.events) ? next.events.length : undefined;
			next.events = { dropped: true, ...(count !== undefined ? { count } : {}) };
		}
		// The upstream's own error text is short and is the most direct statement of what
		// it rejected, so it is trimmed only against the full budget, never below it.
		next.bodyText = truncateText(next.bodyText, bodyBudget);
		dump.response = next;
	}

	const request = dump.request;
	if (request != null && typeof request === "object" && !Array.isArray(request)) {
		const next = { ...(request as Record<string, unknown>) };
		if (next.body !== undefined) {
			const bodyText = JSON.stringify(next.body) ?? "";
			if (!withinUtf8Budget(bodyText, bodyBudget)) {
				// Serialize to text rather than pruning the object graph: which key is
				// oversized varies per provider, and the head of the JSON is what shows
				// the offending content part.
				next.body = undefined;
				next.bodyChars = bodyText.length;
				next.bodyTextTruncated = true;
				next.bodyText = truncateText(bodyText, bodyBudget);
			}
		}
		dump.request = next;
	}

	return dump;
}

/**
 * Serialize a raw dump for storage, enforcing the `requestDumpMaxSize` byte ceiling.
 *
 * When full dumping is disabled but diagnostics exist, only the bounded diagnostics
 * envelope is serialized. Leak-detection dumps are exempt from the *configurable* cap
 * because their raw content is already bounded by the collector and is intentionally
 * retained, but they are still subject to {@link FORCED_DUMP_HARD_MAX_BYTES}.
 *
 * An oversized dump is shrunk (see {@link shrinkRawDump}) rather than discarded, so the
 * request that triggered an upstream rejection stays inspectable. Only when even the
 * shrunken form does not fit does the bounded diagnostics envelope remain as a fallback.
 */
export function serializeRawDump(
	options: ApiRequestFinishOptions,
	spill?: RawDumpSpillPointer,
	spillWriteFailed?: boolean,
): string | null {
	const diagnostics = normalizedDiagnostics(options);
	const persistable = buildPersistableRawDump(options, spill);
	if (persistable == null) return null;
	const json = JSON.stringify(persistable);
	if (json == null) return null;

	const serializeWithinLimit = (maxBytes: number, note: string): string => {
		if (withinUtf8Budget(json, maxBytes)) return json;

		// Keep the request/response instead of collapsing to diagnostics alone.
		const shrunk = JSON.stringify(shrinkRawDump(persistable, maxBytes));
		if (shrunk != null && withinUtf8Budget(shrunk, maxBytes)) return shrunk;

		// Never discard the bounded diagnostic summary just because the optional full dump
		// exceeded the raw-dump ceiling.
		if (diagnostics) return JSON.stringify({ diagnostics, ...(spill ? { spill } : {}) });
		return JSON.stringify({
			truncated: true,
			originalBytes: utf8Bytes(json),
			maxBytes,
			note,
			...(spill ? { spill } : {}),
		});
	};

	return serializeWithinLimit(
		inlineDumpCeiling(options, spill, spillWriteFailed),
		options.forceDumpPersist
			? "Forced raw dump exceeded the hard row ceiling and was dropped."
			: "Raw dump exceeded agent.requestDumpMaxSize and was dropped.",
	);
}

/**
 * The ceiling an operator configured for dump retention: `agent.requestDumpMaxSize`, or
 * the hard ceiling when the dump is force-persisted. `-1` means "no limit".
 */
function configuredDumpCeiling(options: ApiRequestFinishOptions): number {
	return options.forceDumpPersist ? FORCED_DUMP_HARD_MAX_BYTES : settings.agent.requestDumpMaxSize;
}

/**
 * Size above which the complete dump is written to a file instead of living in the row.
 *
 * This is {@link RAW_DUMP_INLINE_MAX_BYTES}, NOT the configured ceiling. Deciding on the
 * configured ceiling instead was the defect that made this whole store almost unreachable:
 * history — was judged "small enough" and written straight into the SQLite row, which is
 * exactly the unbounded large field the main-thread rules in CLAUDE.md forbid, and the row
 * the download route then had to serve as if it were the whole dump.
 *
 * A configured ceiling BELOW this value still wins: an operator asking for smaller rows
 * must not get larger ones. `-1` (no configured limit) means "retain everything", which the
 * file satisfies completely — so it spills too rather than growing the row without bound.
 */
export function spillThresholdBytes(options: ApiRequestFinishOptions): number {
	const configured = configuredDumpCeiling(options);
	if (configured < 0) return RAW_DUMP_INLINE_MAX_BYTES;
	return Math.min(configured, RAW_DUMP_INLINE_MAX_BYTES);
}

/**
 * Byte ceiling for the dump stored in the database row.
 *
 * Once the complete dump is on disk the row is just a preview, so it is clamped to
 * {@link RAW_DUMP_INLINE_MAX_BYTES}. Without a spill file the row is the only copy and the
 * full configured ceiling applies — but only because the dump was small enough not to need
 * a file at all, which {@link spillThresholdBytes} already bounded.
 *
 * `spillWriteFailed` is the third case and it is NOT the same as "no file needed": the dump
 * was measured as too large to keep in a row, and the file that was supposed to hold it
 * could not be written. Treating it like the small-dump case handed the configured ceiling
 * (32 MB by default) to a dump already known to exceed 512 KB, writing exactly the
 * unbounded large field the main-thread rules in CLAUDE.md forbid — the same defect
 * {@link spillThresholdBytes} documents, reintroduced through the failure path. "Keeping
 * more in the row is the better loss" justifies a bounded head, not an unbounded row, so
 * the row stays clamped and the loss is reported by the truncation note.
 */
function inlineDumpCeiling(
	options: ApiRequestFinishOptions,
	spill?: RawDumpSpillPointer,
	spillWriteFailed?: boolean,
): number {
	const configured = configuredDumpCeiling(options);
	if (!spill && !spillWriteFailed) return configured;
	if (configured < 0) return RAW_DUMP_INLINE_MAX_BYTES;
	return Math.min(configured, RAW_DUMP_INLINE_MAX_BYTES);
}

/**
 * Serialize the dump for storage, spilling the complete copy to a file whenever it does
 * not fit the row ceiling.
 *
 * This is the behavior the dump feature is judged by: a user who opens a dump has to get
 * the whole request and the whole response. Truncating to fit a row silently produced the
 * opposite — a dump that looks present and answers nothing. So the row now carries a
 * bounded head plus a pointer, and the file carries everything.
 *
 * A failed spill write is not fatal: the row keeps whatever fits within the row ceiling,
 * which is strictly better than failing the request that was being recorded. It keeps the
 * ROW ceiling rather than the configured one — see {@link inlineDumpCeiling}.
 */
export async function serializeRawDumpWithSpill(
	options: ApiRequestFinishOptions,
	meta: RawDumpSpillMeta,
): Promise<string | null> {
	// `buildPersistableRawDump` without a pointer is exactly what the file should hold:
	// the dump as collected, plus diagnostics, with nothing shed.
	const complete = buildPersistableRawDump(options);
	if (complete == null) return null;
	const completeJson = JSON.stringify(complete);
	if (completeJson == null) return null;

	// Decide on the COMPLETE dump's size, not on the serialized result: `serializeRawDump`
	// already shrinks to fit, so its output always fits and would never signal a loss.
	if (withinUtf8Budget(completeJson, spillThresholdBytes(options)))
		return serializeRawDump(options);

	// Attempts sharing a reuse token share one file: a replay re-sends an identical request, so
	// a second copy would only push someone else's capture out of the newest-N directory.
	// `completeJson` is handed over so the multi-MB graph is serialized exactly once on this
	// thread; the store splices it into its envelope rather than re-stringifying it.
	const spill = await writeOrReuseSpill(
		options.dumpSpillReuseToken,
		{ ...meta, ...(await resolveSpillIdentity(meta)) },
		complete,
		completeJson,
	);
	// `spillWriteFailed` is passed explicitly: reaching here already proved the dump does not
	// fit a row, so a missing pointer means the write failed, not that no file was needed.
	return serializeRawDump(options, spill ?? undefined, spill == null);
}

/**
 * Titles and ids that let a forwarded dump file say WHICH conversation produced it.
 *
 * Resolved only when a dump actually spills — the download route's inline path gets the same
 * fields from its own detail query, and a file is served verbatim, so the file has to carry
 * them itself or the two download paths would disagree about what a dump contains.
 *
 * Bounded and best-effort: one indexed single-row lookup on a path that is already writing a
 * multi-MB file, and a failure degrades the file's labels rather than losing the capture.
 */
async function resolveSpillIdentity(meta: RawDumpSpillMeta): Promise<Partial<RawDumpSpillMeta>> {
	const identity: Partial<RawDumpSpillMeta> = {
		credentialName: resolveCredentialDisplayName(meta.provider, meta.credentialId),
	};
	if (!meta.narratorId) return identity;
	try {
		const [row] = await db
			.select({
				narratorTitle: narrators.title,
				chapterId: narrators.chapterId,
				chapterTitle: chapters.title,
				projectId: chapters.projectId,
			})
			.from(narrators)
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.where(eq(narrators.id, meta.narratorId))
			.limit(1);
		return { ...identity, ...(row ?? {}) };
	} catch (error) {
		logger.warn("Failed to resolve dump identity for a spilled request dump", {
			requestId: meta.requestId,
			error: String(error),
		});
		return identity;
	}
}

export async function finishApiRequest(
	handle: ApiRequestHandle,
	options: ApiRequestFinishOptions = {},
): Promise<string> {
	const usage = options.usage ?? null;
	const cost = usage ? calculateCost(usage, handle.provider, handle.model) : null;
	const persistenceOptions =
		normalizedDiagnostics(options) && !allowsFullRawDump(options)
			? { ...options, rawDump: undefined }
			: options;
	const credentialId = options.credentialId ?? handle.credentialId ?? null;
	const createdAt = new Date().toISOString();
	const rawDump = shouldPersistRawDump(options)
		? await serializeRawDumpWithSpill(persistenceOptions, {
				requestId: handle.id,
				narratorId: handle.narratorId ?? null,
				kind: handle.kind,
				provider: handle.provider,
				model: handle.model,
				credentialId,
				errorMessage: options.errorMessage ?? null,
				createdAt,
			})
		: null;

	await db.insert(apiRequests).values({
		id: handle.id,
		narratorId: handle.narratorId ?? null,
		messageId: options.messageId ?? null,
		kind: handle.kind,
		provider: handle.provider,
		credentialId,
		model: handle.model,
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		cachedInputTokens: usage?.cachedInputTokens ?? 0,
		cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
		cacheCreation5mTokens: usage?.cacheCreation5mInputTokens ?? 0,
		cacheCreation1hTokens: usage?.cacheCreation1hInputTokens ?? 0,
		reasoningTokens: usage?.reasoningTokens ?? 0,
		ttftMs: options.ttftMs ?? null,
		durationMs: options.durationMs ?? Date.now() - handle.startTime,
		costUsd: cost?.totalCost ?? null,
		contextPercent: options.contextPercent ?? null,
		meterUsage: options.meterUsage ?? null,
		meterUnit: options.meterUnit ?? null,
		errorMessage: options.errorMessage ?? null,
		rawDumpJson: rawDump,
		createdAt,
	});

	// Roll the same numbers into the durable per-credential totals. This must
	// happen on the same path as the detail insert so the two cannot drift; the
	// detail row is later deleted with its narrator, the rollup is not.
	//
	// Failed requests (no usage at all) are skipped: they consumed no tokens and
	// counting them would make "requests" mean two different things.
	//
	// Requests without a credentialId are skipped too, and that is deliberate:
	// Anthropic and OpenAI direct connections have no credential management, so
	// there is nothing to attribute the usage to. Bucketing them under a shared
	// sentinel would break the table's "one row per real credential" key and give
	// several unrelated providers a single merged row. The consequence is that
	// `credential_usage_totals` is a per-credential rollup, not a deployment-wide
	// ledger — see the SCOPE note on the table in db/schema.ts. Deployment totals
	// come from `api_requests` while those rows exist.
	if (credentialId && usage) {
		recordCredentialUsage({
			provider: handle.provider,
			credentialId,
			model: handle.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			cacheCreationTokens: usage.cacheCreationInputTokens,
			reasoningTokens: usage.reasoningTokens,
			costUsd: cost?.totalCost ?? null,
			at: createdAt,
		});
	}

	return handle.id;
}

export interface TrackApiRequestOptions extends ApiRequestStartOptions {}

export async function trackApiRequest<T>(
	options: TrackApiRequestOptions,
	fn: () => Promise<T>,
): Promise<T> {
	const handle = startApiRequest(options);
	try {
		const result = await fn();
		const resultMeta = typeof result === "object" && result !== null ? result : null;
		const contextPercent =
			resultMeta && "contextPercent" in resultMeta
				? (resultMeta.contextPercent as number | undefined)
				: undefined;
		const usage =
			resultMeta && "usage" in resultMeta
				? (resultMeta.usage as UsageData | null | undefined)
				: null;
		const credentialId =
			resultMeta && "credentialId" in resultMeta
				? (resultMeta.credentialId as string | undefined)
				: undefined;
		const meterUsage =
			resultMeta && "meterUsage" in resultMeta
				? (resultMeta.meterUsage as number | undefined)
				: undefined;
		const meterUnit =
			resultMeta && "meterUnit" in resultMeta
				? (resultMeta.meterUnit as string | undefined)
				: undefined;
		try {
			await finishApiRequest(handle, {
				contextPercent: contextPercent ?? null,
				credentialId: credentialId ?? null,
				usage: usage ?? null,
				meterUsage: meterUsage ?? null,
				meterUnit: meterUnit ?? null,
			});
		} catch (error) {
			logger.warn("Failed to record API request", { requestId: handle.id, error });
		}
		return result;
	} catch (error) {
		try {
			await finishApiRequest(handle, {
				errorMessage: error instanceof Error ? error.message : String(error),
				diagnostics: diagnosticsFromError(error),
			});
		} catch (recordError) {
			logger.warn("Failed to record failed API request", {
				requestId: handle.id,
				error: recordError,
			});
		}
		throw error;
	}
}
