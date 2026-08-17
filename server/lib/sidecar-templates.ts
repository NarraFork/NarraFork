/**
 * sidecar-templates.ts — Resolve the model-facing copy a structured side-car body
 * needs, for one locale.
 *
 * `@shared/sidecar-body`'s `renderSideCarBodyToText` owns the assembly (which lines,
 * in which order, with which separators) but deliberately holds no copy: the strings
 * are prompt text and belong with the rest of it in `./i18n`. This module is the
 * bridge — it hands the renderer a flat `{ key: template }` map.
 *
 * It used to also splice in `getBlockedTaskActionInstruction` from
 * `./prompts/system-reminders`, so the Dynamic Spec digest could repeat the
 * blocked-task rule the system prompt already carries. That repetition is gone: the
 * digest is a mid-turn injection on a tool-call cadence, and the rule is in the system
 * prompt of every request anyway. The keys below are now resolved from one place.
 *
 * The map is memoized per locale: a working narrator renders side-cars on most tool
 * results, and rebuilding ~25 lookups each time is pointless.
 */

import {
	renderSideCarBodyToText,
	type SideCarBody,
	type SideCarModelTemplates,
} from "@shared/sidecar-body";
import { type Locale, t } from "./i18n";

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
	cache.set(locale, templates);
	return templates;
}
