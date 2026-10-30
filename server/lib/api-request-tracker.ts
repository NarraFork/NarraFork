import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { getEffectiveModelCard, withModelMetadataSnapshot } from "@server/lib/model-catalog";
import { calculateCostDetailed, type UsageData } from "@server/lib/usage-tracking";
import { sliceToUtf8Budget, withinUtf8Budget } from "@server/lib/utf8-budget";
import { recordCredentialUsage } from "@server/services/credential-usage-totals";
import { insertApiRequestWithUserUsage } from "@server/services/user-usage-totals";
import type { ReferencePricingSnapshot } from "@shared/agent-protocol/types";
import type { ContextUsageSnapshot } from "@shared/context-usage";
import { diagnosticsFromError, normalizeApiRequestDiagnostics } from "./agent/error-diagnostics";
import type { ApiRequestDiagnostics } from "./agent/types";
import { boundedContextSnapshot } from "./context-usage-snapshot";
import { captureReferencePricingSnapshot, cloneReferencePricingSnapshot } from "./model-pricing";
import { bindRecordingRequest } from "./request-recorder";

export type ApiRequestKind =
	| "narrator"
	| "modeltrace"
	| "compact"
	| "context_ask"
	| "fork_summary"
	| "title"
	| "merge_summary"
	| "web_fetch_smart"
	| "reflection"
	| "optimize"
	| "reasoning_translation"
	| "settings_test"
	| "git_summary"
	/** Summarizing a selection of human chat messages before forwarding it. */
	| "chat_summarize"
	| "external"
	| "internal";

export interface ApiRequestStartOptions {
	/** Loop attempt id, distinct from the durable api_requests row id. */
	recordingRequestId?: string;
	/** Actual initiating user; unknown/system requests remain unattributed. */
	userId?: string | null;
	narratorId?: string | null;
	provider: string;
	model: string;
	credentialId?: string | null;
	kind?: ApiRequestKind;
	/** Captured by the stream producer; absence means capture at this API boundary. */
	referencePricingSnapshot?: ReferencePricingSnapshot;
}

export interface ApiRequestHandle extends ApiRequestStartOptions {
	readonly userId: string | null;
	readonly referencePricingSnapshot: ReferencePricingSnapshot;
	id: string;
	startTime: number;
	kind: ApiRequestKind;
}

export interface ApiRequestFinishOptions {
	contextSnapshot?: ContextUsageSnapshot | null;
	messageId?: string | null;
	credentialId?: string | null;
	usage?: UsageData | null;
	ttftMs?: number | null;
	durationMs?: number | null;
	contextPercent?: number | null;
	meterUsage?: number | null;
	meterUnit?: string | null;
	errorMessage?: string | null;
	diagnostics?: ApiRequestDiagnostics | null;
}

export function startApiRequest(options: ApiRequestStartOptions): ApiRequestHandle {
	const handle: ApiRequestHandle = {
		...options,
		referencePricingSnapshot:
			options.referencePricingSnapshot === undefined
				? captureReferencePricingSnapshot(options.model)
				: cloneReferencePricingSnapshot(options.referencePricingSnapshot),
		userId: options.userId ?? null,
		id: generateId(),
		kind: options.kind ?? "internal",
		startTime: Date.now(),
	};
	if (options.recordingRequestId) bindRecordingRequest(options.recordingRequestId, handle.id);
	return handle;
}

function normalizedDiagnostics(
	options: ApiRequestFinishOptions,
): ApiRequestDiagnostics | undefined {
	return normalizeApiRequestDiagnostics(options.diagnostics ?? undefined);
}

/** Diagnostics are a bounded summary, never a dump; full evidence lives in the recorder. */
export const DIAGNOSTICS_MAX_BYTES = 16 * 1024;

export function serializeDiagnostics(options: ApiRequestFinishOptions): string | null {
	const diagnostics = normalizedDiagnostics(options);
	if (!diagnostics) return null;
	const json = JSON.stringify(diagnostics);
	if (withinUtf8Budget(json, DIAGNOSTICS_MAX_BYTES)) return json;
	// Normalized diagnostics are already field-bounded; this guards future additions.
	return JSON.stringify({
		provider: diagnostics.provider,
		model: diagnostics.model,
		message: sliceToUtf8Budget(diagnostics.message ?? "", 4096),
		recordingRequestId: diagnostics.recordingRequestId,
		diagnosticsTruncated: true,
	});
}

export async function finishApiRequest(
	handle: ApiRequestHandle,
	options: ApiRequestFinishOptions = {},
): Promise<string> {
	const usage = options.usage ?? null;
	const cost = usage
		? calculateCostDetailed(usage, handle.provider, handle.model, handle.referencePricingSnapshot)
		: null;
	const credentialId = options.credentialId ?? handle.credentialId ?? null;
	const createdAt = new Date().toISOString();

	const inserted = insertApiRequestWithUserUsage({
		id: handle.id,
		userId: handle.userId,
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
		costUsd: cost && cost.status !== "unknown" ? cost.knownCost : null,
		costStatus: cost?.status ?? "unknown",
		costMissingFields: cost?.missingFields ?? [],
		contextPercent: options.contextPercent ?? null,
		contextUsageSnapshotJson: boundedContextSnapshot(options.contextSnapshot),
		meterUsage: options.meterUsage ?? null,
		meterUnit: options.meterUnit ?? null,
		errorMessage: options.errorMessage ?? null,
		diagnosticsJson: serializeDiagnostics(options),
		recordingRequestId: handle.recordingRequestId ?? null,
		createdAt,
	});

	// Duplicate completion must not charge either rollup again.
	if (!inserted) return handle.id;

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
			costUsd: cost && cost.status !== "unknown" ? cost.knownCost : null,
			costStatus: cost?.status ?? "unknown",
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
	return withModelMetadataSnapshot(() => {
		// Capture discovered metadata as well as catalog/local revisions before any
		// adapter work. The same ALS scope survives fn's awaits through cost recording.
		getEffectiveModelCard(options.model);
		return trackApiRequestInSnapshot(options, fn);
	});
}

async function trackApiRequestInSnapshot<T>(
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
