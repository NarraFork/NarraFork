/**
 * Backward-compatible facade for backend localization and model-facing prompts.
 *
 * User-visible messages live in `./i18n`; large model prompts are grouped by
 * domain under `./prompts` so new locales can fall back without duplicating
 * every internal instruction.
 */
export type { Locale, MergeSummaryLabelKey, ToolMessageKey } from "./i18n";
export {
	getMergeSummaryLabel,
	getToolMessage,
	getToolMessageWithParams,
	getUserLanguage,
	getUserReplyInLanguage,
} from "./i18n";
export type { PromptKey } from "./prompts/core";
export { getPrompt } from "./prompts/core";
export { buildKnowledgeStewardSystemPrompt } from "./prompts/knowledge-steward";
export {
	buildReviewSystemPrompt,
	getReviewStartMessage,
} from "./prompts/review";
export type { BuiltinSubagentType, SubagentType } from "./prompts/subagents";
export {
	getSubagentParentReportingHint,
	getSubagentPrompt,
} from "./prompts/subagents";
export {
	getBlockedTaskActionInstruction,
	getDynamicSpecSystemReminder,
	getPlanModeSystemReminder,
	getReplyLanguageInstruction,
} from "./prompts/system-reminders";
