import { getToolMessageWithParams, type Locale } from "../../lib/prompt-i18n";
import {
	currentCompactMessageId,
	optionalToolDescription,
	PrefixContextChangedError,
	type ReconciledEpoch,
	type ReconcileEpochInput,
	reconcileEpoch,
} from "../narrator-epochs";
import { narratorService } from "../narrator-service";
import type { RuntimeHistoryOptions } from "./history";

export type RequestPrefixPrompt = NonNullable<ReconcileEpochInput["prompt"]>;
export interface RequestModelIdentity {
	readonly model: string;
	readonly provider: string;
}
type SourceMessages = Awaited<ReturnType<typeof narratorService.getModelHistorySinceLastCompact>>;

export interface PreparePrefixRequestOptions<
	Prompt extends RequestPrefixPrompt = RequestPrefixPrompt,
> {
	narratorId: string;
	locale: Locale;
	getModel: () => string;
	getProvider: () => string;
	signal?: AbortSignal;
	getToolLoading?: (identity: RequestModelIdentity) => RuntimeHistoryOptions["toolLoading"];
	refreshToolLoading?: (identity: RequestModelIdentity) => Promise<void>;
	/** Runs after tool refresh under the existing /load serialization queue. */
	buildPrefixPrompt?: (identity: RequestModelIdentity) => Promise<Prompt>;
}

export interface PreparedPrefixRequest<Prompt extends RequestPrefixPrompt = RequestPrefixPrompt>
	extends RequestModelIdentity {
	/** Exact builder result used for reconciliation, including caller-owned summary metadata. */
	prompt?: Prompt;
	reconciled?: ReconciledEpoch;
	toolLoading?: RuntimeHistoryOptions["toolLoading"];
	sourceMessages: SourceMessages;
}

/**
 * Prepare the same authoritative prefix for first requests, later turns and retries.
 * Snapshot construction and prompt collection have no fixed total wall-clock budget:
 * they remain cancellable while progressing. Each source read gets its own query budget.
 */
export async function preparePrefixRequest<Prompt extends RequestPrefixPrompt>(
	options: PreparePrefixRequestOptions<Prompt>,
): Promise<PreparedPrefixRequest<Prompt>> {
	const { narratorId, locale, signal } = options;
	// A UI selection change is consumed by the loop's next model-switch boundary,
	// not by a queued prepare or a compact retry within this request.
	const identity: RequestModelIdentity = {
		model: options.getModel(),
		provider: options.getProvider(),
	};
	const readHistory = () => {
		signal?.throwIfAborted();
		return narratorService.getModelHistorySinceLastCompact(narratorId, undefined, {
			signal,
			deadline: Date.now() + 10_000,
		});
	};
	for (;;) {
		signal?.throwIfAborted();
		const capturedLoading = options.getToolLoading?.(identity);
		if (!capturedLoading) {
			// Compatibility for standalone callers without loading-aware prefix epochs.
			const sourceMessages = await readHistory();
			const prompt = await options.buildPrefixPrompt?.(identity);
			signal?.throwIfAborted();
			return { ...identity, sourceMessages, prompt };
		}
		// Production reconciliation reads its own authoritative source under the queue.
		// Only the older tool-only API needs a caller-supplied history view.
		let sourceMessages = options.buildPrefixPrompt ? undefined : await readHistory();
		let prompt: Prompt | undefined;
		try {
			const reconciled = await reconcileEpoch({
				narratorId,
				messages: sourceMessages ?? [],
				...capturedLoading,
				signal,
				...identity,
				refreshTools: async () => {
					await options.refreshToolLoading?.(identity);
					signal?.throwIfAborted();
					prompt = await options.buildPrefixPrompt?.(identity);
					return { ...(options.getToolLoading?.(identity) ?? capturedLoading), prompt };
				},
				noticeText: (kind, toolName) =>
					kind === "tool_loaded"
						? getToolMessageWithParams("toolLoaded", locale, {
								toolName,
								toolDescription: optionalToolDescription(toolName, locale),
							})
						: getToolMessageWithParams("toolUnloaded", locale, { toolName }),
			});
			signal?.throwIfAborted();
			if (reconciled.changed) sourceMessages = await readHistory();
			else sourceMessages = reconciled.sourceMessages ?? sourceMessages ?? (await readHistory());
			if (
				prompt?.compactMessageId !== undefined &&
				prompt.compactMessageId !== (await currentCompactMessageId(narratorId))
			)
				throw new PrefixContextChangedError();
			signal?.throwIfAborted();
			return {
				...identity,
				prompt,
				reconciled,
				toolLoading: { ...capturedLoading, ...reconciled.loading, epoch: reconciled.epoch },
				sourceMessages,
			};
		} catch (error) {
			if (!(error instanceof PrefixContextChangedError)) throw error;
			// The next reconciliation reloads the new compact view. An eager read here
			// would be thrown away before it could guard or build the next request.
		}
	}
}
