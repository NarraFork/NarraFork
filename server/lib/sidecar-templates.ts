/**
 * sidecar-templates.ts — Resolve the model-facing copy a structured side-car body
 * needs, for one locale.
 *
 * `@shared/sidecar-body`'s `renderSideCarBodyToText` owns the assembly (which lines,
 * in which order, with which separators) but deliberately holds no copy: the strings
 * are prompt text and belong with the rest of it in `./i18n`. This module is the
 * bridge — it hands the renderer a flat `{ key: template }` map.
 *
 * Its own reason to exist (rather than living in `./i18n`) is `tasksBlockedActionNote`:
 * that rule already exists as `getBlockedTaskActionInstruction` in
 * `./prompts/system-reminders`, and the Dynamic Spec digest must emit the SAME text
 * the system prompt uses. Pulling it in here keeps one copy of the rule instead of a
 * second one in the message table that could drift.
 *
 * The map is memoized per locale: a working narrator renders side-cars on most tool
 * results, and rebuilding ~30 lookups each time is pointless.
 */

import {
	renderSideCarBodyToText,
	type SideCarBody,
	type SideCarModelTemplates,
} from "@shared/sidecar-body";
import { type Locale, t } from "./i18n";
import { getBlockedTaskActionInstruction } from "./prompts/system-reminders";

/**
 * Keys resolved straight from the `sidecar.*` message table.
 *
 * Listed explicitly rather than scanned from the table so that a key the renderer
 * reads but nobody defined shows up as an obviously-missing entry here, instead of
 * silently rendering as an empty line inside a model prompt.
 */
const MESSAGE_TABLE_KEYS = [
	// notice
	"noticeSilentProgress",
	"noticeRelaxedPlan",
	"noticePipelineExit",
	// prose headings (keyed by side-car source)
	"behavior_fenceHeading",
	// tasks
	"tasksCurrentHeading",
	"tasksCurrentUpdateNote",
	"tasksEmptyHeading",
	"tasksEmptyNeverCreate",
	"tasksEmptyNeverSkip",
	"tasksEmptyDoneReorganize",
	"tasksEmptyDoneContinue",
	"tasksTooManyHeading",
	"tasksTooManyReorganize",
	"tasksTooManyProtected",
	"tasksFieldsNote",
	"tasksSemanticsNote",
	"tasksProtectedOnlyOnUserDemand",
	// knowledge
	"knowledgeHeading",
	"knowledgeReadHint",
	// tasksDone
	"bgAgentEntry",
	"bgBashEntry",
	"emptyResult",
	// messages
	"subagentMessageEntry",
	"teamMessageEntry",
	"teamBroadcast",
	"teamDirect",
	// specUpdates
	"specUpdateHeading",
	"specUpdateEntry",
	"specUpdatePreview",
] as const;

const cache = new Map<Locale, SideCarModelTemplates>();

/**
 * Build the `{ body, content }` pair for one side-car.
 *
 * Every injection point uses this, which is what keeps the two projections
 * consistent: `content` is never hand-assembled beside a `body` again, so they
 * cannot describe different things.
 */
export function sideCarBodyWithText(
	source: string,
	body: SideCarBody,
	locale: Locale,
): { body: SideCarBody; content: string } {
	return { body, content: renderSideCarBodyToText(source, body, getSideCarModelTemplates(locale)) };
}

/** The model-facing template map for `renderSideCarBodyToText`, memoized per locale. */
export function getSideCarModelTemplates(locale: Locale): SideCarModelTemplates {
	const cached = cache.get(locale);
	if (cached) return cached;
	const templates: Record<string, string> = {};
	for (const key of MESSAGE_TABLE_KEYS) {
		templates[key] = t(`sidecar.${key}`, locale);
	}
	// Shared with the system prompt — see the module header on why it is not a
	// second entry in the message table.
	templates.tasksBlockedActionNote = getBlockedTaskActionInstruction(locale);
	cache.set(locale, templates);
	return templates;
}
