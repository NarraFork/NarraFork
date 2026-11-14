import { renderPrefixPrompt } from "@shared/prefix-context";
import { parseReplyContext, type ReplyContext } from "@shared/reply-context";
import { getToolMessageWithParams, type Locale } from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { ContextEvidenceBudget, projectKnowledgeEvidence } from "../context-evidence-budget";
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
	getReplyContext?: () => ReplyContext;
	/** Persist upstream identity before any prepared request can leave the runtime. */
	ensureRequestIdentity?: () => Promise<void>;
	getModel: () => string;
	getProvider: () => string;
	signal?: AbortSignal;
	getToolLoading?: (identity: RequestModelIdentity) => RuntimeHistoryOptions["toolLoading"];
	refreshToolLoading?: (identity: RequestModelIdentity) => Promise<void>;
	/** Runs after tool refresh under the existing /load serialization queue. */
	buildPrefixPrompt?: (
		identity: RequestModelIdentity,
		replyContext: ReplyContext,
	) => Promise<Prompt>;
	/** Revocable observations collected after reconciliation; never stored in an epoch. */
	getRequestContext?: (allowance: { byteBudget: number }) => Promise<string>;
	/** Shared with user-message injection and concurrent tool-output scans. */
	evidenceBudget?: ContextEvidenceBudget;
}

export interface PreparedPrefixRequest<Prompt extends RequestPrefixPrompt = RequestPrefixPrompt>
	extends RequestModelIdentity {
	/** Exact builder result used for reconciliation, including caller-owned summary metadata. */
	prompt?: Prompt;
	/** Effective request prompt, including freshly checked nonpersistent observations. */
	systemPrompt?: string;
	reconciled?: ReconciledEpoch;
	toolLoading?: RuntimeHistoryOptions["toolLoading"];
	sourceMessages: SourceMessages;
	/** Do not re-add these optional rows from a live pending-input queue. */
	omittedOptionalMessageIds: readonly string[];
}

/**
 * Prepare the same authoritative prefix for first requests, later turns and retries.
 * Snapshot construction and prompt collection have no fixed total wall-clock budget:
 * source reads also remain cancellable while progressing, without a fixed time cutoff.
 */
export async function preparePrefixRequest<Prompt extends RequestPrefixPrompt>(
	options: PreparePrefixRequestOptions<Prompt>,
): Promise<PreparedPrefixRequest<Prompt>> {
	const { narratorId, signal } = options;
	const replyContext = parseReplyContext(options.getReplyContext?.()) ?? {
		locale: options.locale,
		replyInUserLanguage: false,
	};
	const { locale } = replyContext;
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
		});
	};
	const evidenceBudget =
		options.evidenceBudget ??
		new ContextEvidenceBudget(() => settings.agent.contextEvidenceBudgetBytes);
	let omittedOptionalMessageIds: readonly string[] = [];
	const projectHistory = (source: SourceMessages) => {
		evidenceBudget.reset();
		const projected = projectKnowledgeEvidence(source, evidenceBudget.knowledgeAllowance);
		evidenceBudget.reset(projected.bytes);
		omittedOptionalMessageIds = projected.omittedMessageIds;
		return projected.messages;
	};
	const requestPrompt = async (base: string | undefined) => {
		if (base === undefined || !options.getRequestContext) return base;
		const heading = "\n\n## Request-local observations\n\n";
		const reservation = evidenceBudget.reserve("memory", evidenceBudget.remaining);
		try {
			const byteBudget = reservation.byteBudget - Buffer.byteLength(heading, "utf8");
			if (byteBudget <= 0) return base;
			signal?.throwIfAborted();
			const context = await options.getRequestContext({ byteBudget });
			signal?.throwIfAborted();
			return context && reservation.commit(heading + context) ? base + heading + context : base;
		} finally {
			reservation.release();
		}
	};
	for (;;) {
		signal?.throwIfAborted();
		const capturedLoading = options.getToolLoading?.(identity);
		if (!capturedLoading) {
			// Compatibility for standalone callers without loading-aware prefix epochs.
			const sourceMessages = projectHistory(await readHistory());
			const prompt = await options.buildPrefixPrompt?.(identity, replyContext);
			await options.ensureRequestIdentity?.();
			signal?.throwIfAborted();
			const systemPrompt = await requestPrompt(
				prompt ? renderPrefixPrompt(prompt.contract, prompt.parts) : undefined,
			);
			return { ...identity, sourceMessages, prompt, systemPrompt, omittedOptionalMessageIds };
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
					prompt = await options.buildPrefixPrompt?.(identity, replyContext);
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
			sourceMessages = projectHistory(sourceMessages);
			await options.ensureRequestIdentity?.();
			const systemPrompt = await requestPrompt(reconciled.systemPrompt);
			if (
				prompt?.compactMessageId !== undefined &&
				prompt.compactMessageId !== (await currentCompactMessageId(narratorId))
			)
				throw new PrefixContextChangedError();
			signal?.throwIfAborted();
			return {
				...identity,
				prompt,
				systemPrompt,
				reconciled,
				toolLoading: { ...capturedLoading, ...reconciled.loading, epoch: reconciled.epoch },
				sourceMessages,
				omittedOptionalMessageIds,
			};
		} catch (error) {
			if (!(error instanceof PrefixContextChangedError)) throw error;
			// The next reconciliation reloads the new compact view. An eager read here
			// would be thrown away before it could guard or build the next request.
		}
	}
}
