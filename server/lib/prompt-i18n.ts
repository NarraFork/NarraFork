/**
 * Backward-compatible facade for backend localization and model-facing prompts.
 *
 * User-visible messages live in `./i18n`; large model prompts are grouped by
 * domain under `./prompts` so new locales can fall back without duplicating
 * every internal instruction.
 */
export type { Locale, ToolMessageKey } from "./i18n";
export {
	getToolMessage,
	getToolMessageWithParams,
	getUserLanguage,
	getUserReplyInLanguage,
} from "./i18n";
export { getBotModePrompt } from "./prompts/bot";
export type { PromptKey } from "./prompts/core";
export { getPrompt } from "./prompts/core";
export { buildKnowledgeStewardSystemPrompt } from "./prompts/knowledge-steward";
export type {
	OutlinePlanPromptReview,
	OutlinePlanPromptRoot,
	OutlinePlanStructureProblem,
	OutlinePlanSubmitProblem,
} from "./prompts/outline-plan";
export {
	getOutlinePlanApprovedPrompt,
	getOutlinePlanEnterOutput,
	getOutlinePlanModeSystemReminder,
	getOutlinePlanRelaxedReminder,
	getOutlinePlanReturnedMessage,
	getOutlinePlanReturnedNote,
	getOutlinePlanReviewPrompt,
	getOutlinePlanReviewTitle,
	getOutlinePlanSubmitProblem,
} from "./prompts/outline-plan";
export type {
	OutlineCompactNote,
	OutlineTaskEdit,
	OutlineTaskEditChange,
	OutlineTaskEditGroup,
	OutlineTaskFinishedEntry,
	OutlineTaskPromptTask,
	OutlineTasksViewSection,
	OutlineTaskWaitText,
	OutlineTeamAssignedEntry,
	OutlineTeamUnblockedEntry,
	OutlineViewAgent,
	OutlineViewTask,
	SpecImportNoticePage,
} from "./prompts/outline-tasks";
export {
	getOutlineBehaviorFenceTruncated,
	getOutlineBehaviorForkCutNote,
	getOutlineBehaviorPageTitle,
	getOutlineBehaviorViewFence,
	getOutlineBehaviorViewHeading,
	getOutlineBehaviorViewPage,
	getOutlineBehaviorViewSop,
	getOutlineBehaviorViewTruncated,
	getOutlineBoundedContinuationPrompt,
	getOutlineCompactContext,
	getOutlineCompactNoteLine,
	getOutlineCompactTaskLine,
	getOutlineContinuationPrompt,
	getOutlineInterruptNote,
	getOutlineSpecMovedHint,
	getOutlineSpecUnavailableHint,
	getOutlineTaskEditNote,
	getOutlineTaskFinishedNote,
	getOutlineTaskSystemReminder,
	getOutlineTasksViewHeading,
	getOutlineTasksViewMore,
	getOutlineTasksViewSection,
	getOutlineTeamEventsNote,
	getOutlineTurnEndNote,
	getOutlineViewDelegatedLine,
	getOutlineViewTaskLine,
	getSpecImportNotice,
} from "./prompts/outline-tasks";
export type {
	SetupAuthorization,
	SetupAuthorizationResolution,
	SetupBriefingDependency,
	SetupBriefingInput,
} from "./prompts/setup-assistant";
export {
	buildSetupAssistantSystemPrompt,
	formatDependencyBriefing,
	getSetupAssistantStartMessage,
	getSetupAssistantTitle,
	resolveSetupAuthorization,
	SETUP_AUTHORIZATION_VALUES,
	selectActionableDependencies,
} from "./prompts/setup-assistant";
export type { BuiltinSubagentType, SubagentType } from "./prompts/subagents";
export {
	getRunDeliveryHint,
	getSubagentPrompt,
} from "./prompts/subagents";
export {
	getBlockedTaskActionInstruction,
	getDynamicSpecSystemReminder,
	getPlanModeSystemReminder,
	getReplyLanguageInstruction,
} from "./prompts/system-reminders";
