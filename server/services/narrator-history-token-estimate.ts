import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { buildHistory, resolveProviderAndModel } from "../lib/agent";
import { estimateTokens } from "../lib/agent/estimate-tokens";
import { isPlanModeTrait, isSubagentVariant } from "../lib/narrator-utils";
import { getHome } from "../lib/platform";
import type { Locale } from "../lib/prompt-i18n";
import {
	getModelContextWindow,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import { narratorService } from "./narrator-service";

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
	if (!narrator.chapterId) return narrator.cwd || getHome();

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { id: true, projectId: true, worktreePath: true },
	});
	if (!chapter) return narrator.cwd || getHome();
	if (chapter.worktreePath) return chapter.worktreePath;

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, chapter.projectId),
		columns: { gitPath: true },
	});
	return narrator.cwd || project?.gitPath || getHome();
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
): Promise<NarratorHistoryTokenEstimate> {
	const narrator = await narratorService.getById(narratorId);
	const rawMessages = await narratorService.getMessagesSinceLastCompact(narratorId);
	const isSubagentNarrator = isSubagentVariant(narrator.variant);
	const dbMessages = isSubagentNarrator
		? rawMessages.map((message) => ({ ...message, parentToolUseId: null }))
		: rawMessages;

	const effectiveModel = resolveEffectiveModel(
		narrator.model,
		resolveProvider(narrator.model ?? undefined),
	);
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

	const promptTokens = estimateTokens(JSON.stringify(historyWithSystem));
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
