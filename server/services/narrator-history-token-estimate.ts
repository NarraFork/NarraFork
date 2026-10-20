import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { buildHistory, resolveProviderAndModel } from "../lib/agent";
import { estimateJsonTokens } from "../lib/agent/estimate-json-tokens";
import { isPlanModeTrait } from "../lib/narrator-utils";
import { getHome } from "../lib/platform";
import type { Locale } from "../lib/prompt-i18n";
import {
	getModelContextWindow,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { isTopLevelMessage } from "./agent-runtime/history";
import { resolveNarratorSessionCwd } from "./narrator-cwd";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import { narratorService } from "./narrator-service";
import { resolveSubagentModelForRun } from "./subagent-model";

export interface NarratorHistoryTokenEstimate {
	promptTokens: number;
	contextWindow?: number;
	contextPercent?: number;
	turnUsage: {
		prompt_tokens: number;
		input_tokens: number;
		context_window?: number;
		is_estimated: true;
	};
}

async function resolvePromptCwd(narrator: {
	chapterId: string | null;
	cwd: string | null;
}): Promise<string> {
	if (!narrator.chapterId) {
		return resolveNarratorSessionCwd(narrator.cwd, null, null, getHome());
	}

	const chapter = await readQuery(
		db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true, worktreePath: true },
		}),
		{ site: "narrator-history-token-estimate.resolvePromptCwd" },
	);
	if (!chapter) {
		return resolveNarratorSessionCwd(narrator.cwd, null, null, getHome());
	}
	const project = await readQuery(
		db.query.projects.findFirst({
			where: eq(projects.id, chapter.projectId),
			columns: { gitPath: true },
		}),
		{ site: "narrator-history-token-estimate.resolvePromptCwd" },
	);
	return resolveNarratorSessionCwd(narrator.cwd, chapter.worktreePath, project?.gitPath, getHome());
}

/**
 * Estimate the prompt/history footprint that the next narrator API request will
 * carry after the current persisted message graph is rebuilt.
 *
 * This intentionally uses the same provider-specific buildHistory + system
 * prompt injection path as the main agent loop, then applies the existing
 * lightweight token estimator. It is a temporary display value until the next
 * provider response returns real usage.
 */
export async function estimateNarratorBuildHistoryTokens(
	narratorId: string,
	locale: Locale,
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<NarratorHistoryTokenEstimate | null> {
	const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + 10_000);
	options.signal?.throwIfAborted();
	const narrator = await narratorService.getById(narratorId);
	// This is compact-after display work, not a per-pass request statistic. Reuse only
	// immutable, signed source rows; never cache provider packets/current input/attachments.
	const rawMessages = await narratorService.getModelHistorySinceLastCompact(narratorId, undefined, {
		...options,
		deadline,
	});
	// Historical transcript mounting is top level even without a live delivery target.
	const { readSessionOwnTurnPlacement } = await import("./narrator-session");
	const ownPlacement = await readSessionOwnTurnPlacement(narratorId);
	const dbMessages = rawMessages.map((message) =>
		message.parentToolUseId && isTopLevelMessage(message, ownPlacement)
			? { ...message, parentToolUseId: null }
			: message,
	);

	const effectiveModel =
		narrator.model === FOLLOW_PARENT_MODEL
			? (await resolveSubagentModelForRun(narrator, narrator.ownerUserId)).model
			: resolveEffectiveModel(narrator.model, resolveProvider(narrator.model ?? undefined));
	const resolved = resolveProviderAndModel(effectiveModel, resolveProvider(effectiveModel));
	const { history } = await buildHistory(dbMessages, resolved.model, resolved.provider, narratorId);
	const cwd = await resolvePromptCwd({ chapterId: narrator.chapterId, cwd: narrator.cwd });
	const { prompt: systemPrompt } = await buildEffectiveSystemPrompt({
		basePrompt: narrator.systemPrompt,
		cwd,
		locale,
		contextSummary: narrator.contextSummary,
		planMode: isPlanModeTrait(narrator.traits),
		planFileId: narrator.planFileId ?? undefined,
		replyInUserLanguage: false,
		defaultSystemPrompt: settings.agent.defaultSystemPrompt,
	});

	const historyWithSystem = [...history];
	if (systemPrompt) {
		resolved.adapter.injectSystemPrompt(historyWithSystem, systemPrompt, resolved.model, locale);
	}

	const promptTokens = await estimateJsonTokens(historyWithSystem, { ...options, deadline });
	// Unknown is not zero or a partial estimate; keep prior real usage untouched.
	if (promptTokens == null) return null;
	const contextWindow = getModelContextWindow(resolved.model, resolved.provider) ?? undefined;
	const contextPercent = contextWindow
		? Math.min((promptTokens / contextWindow) * 100, 100)
		: undefined;

	return {
		promptTokens,
		...(contextWindow != null ? { contextWindow } : {}),
		...(contextPercent != null ? { contextPercent } : {}),
		turnUsage: {
			prompt_tokens: promptTokens,
			input_tokens: promptTokens,
			...(contextWindow != null ? { context_window: contextWindow } : {}),
			is_estimated: true,
		},
	};
}
