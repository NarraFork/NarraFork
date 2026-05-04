import { db } from "@server/db";
import { apiRequests } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { calculateCost, type UsageData } from "@server/lib/usage-tracking";

export type ApiRequestKind =
	| "narrator"
	| "compact"
	| "fork_summary"
	| "title"
	| "merge_summary"
	| "web_fetch_smart"
	| "reasoning_translation"
	| "settings_test"
	| "git_summary"
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
}

export function startApiRequest(options: ApiRequestStartOptions): ApiRequestHandle {
	return {
		...options,
		id: generateId(),
		kind: options.kind ?? "internal",
		startTime: Date.now(),
	};
}

export async function finishApiRequest(
	handle: ApiRequestHandle,
	options: ApiRequestFinishOptions = {},
): Promise<string> {
	const usage = options.usage ?? null;
	const cost = usage ? calculateCost(usage, handle.provider, handle.model) : null;
	const rawDump = options.rawDump ? JSON.stringify(options.rawDump) : null;

	await db.insert(apiRequests).values({
		id: handle.id,
		narratorId: handle.narratorId ?? null,
		messageId: options.messageId ?? null,
		kind: handle.kind,
		provider: handle.provider,
		credentialId: options.credentialId ?? handle.credentialId ?? null,
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
		createdAt: new Date().toISOString(),
	});

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
