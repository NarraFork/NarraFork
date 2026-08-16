import { db } from "@server/db";
import { apiRequests } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { settings } from "@server/lib/settings";
import { calculateCost, type UsageData } from "@server/lib/usage-tracking";
import { recordCredentialUsage } from "@server/services/credential-usage-totals";
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

function buildPersistableRawDump(options: ApiRequestFinishOptions): unknown {
	const diagnostics = normalizedDiagnostics(options);
	if (options.rawDump && typeof options.rawDump === "object" && !Array.isArray(options.rawDump)) {
		return {
			...(options.rawDump as Record<string, unknown>),
			...(diagnostics ? { diagnostics } : {}),
		};
	}
	return diagnostics ? { diagnostics } : options.rawDump;
}

/**
 * Absolute ceiling for force-persisted dumps, independent of the user-configurable
 * `requestDumpMaxSize`. Force-persist bypasses the configurable cap on purpose, but a
 * single SQLite row must still never grow without bound (see CLAUDE.md large-field rules).
 */
export const FORCED_DUMP_HARD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Serialize a raw dump for storage, enforcing the `requestDumpMaxSize` byte ceiling.
 *
 * When full dumping is disabled but diagnostics exist, only the bounded diagnostics
 * envelope is serialized. Leak-detection dumps are exempt from the *configurable* cap
 * because their raw content is already bounded by the collector and is intentionally
 * retained, but they are still subject to {@link FORCED_DUMP_HARD_MAX_BYTES}.
 */
export function serializeRawDump(options: ApiRequestFinishOptions): string | null {
	const diagnostics = normalizedDiagnostics(options);
	const persistable = buildPersistableRawDump(options);
	if (persistable == null) return null;
	const json = JSON.stringify(persistable);
	if (json == null) return null;
	if (options.forceDumpPersist) {
		if (json.length <= FORCED_DUMP_HARD_MAX_BYTES) return json;
		if (diagnostics) return JSON.stringify({ diagnostics });
		return JSON.stringify({
			truncated: true,
			originalBytes: json.length,
			maxBytes: FORCED_DUMP_HARD_MAX_BYTES,
			note: "Forced raw dump exceeded the hard row ceiling and was dropped.",
		});
	}
	const maxSize = settings.agent.requestDumpMaxSize;
	if (maxSize >= 0 && json.length > maxSize) {
		// Never discard the bounded diagnostic summary just because the optional full dump
		// exceeded the configurable raw-dump ceiling.
		if (diagnostics) return JSON.stringify({ diagnostics });
		return JSON.stringify({
			truncated: true,
			originalBytes: json.length,
			maxBytes: maxSize,
			note: "Raw dump exceeded agent.requestDumpMaxSize and was dropped.",
		});
	}
	return json;
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
	const rawDump = shouldPersistRawDump(options) ? serializeRawDump(persistenceOptions) : null;
	const credentialId = options.credentialId ?? handle.credentialId ?? null;
	const createdAt = new Date().toISOString();

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
