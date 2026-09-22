/**
 * Pure, side-effect-free coercion/repair logic for AskUserQuestion input.
 *
 * Implementation lives in `@shared/ask-user-question-shape` so server and
 * frontend normalize the same way. This module must not import anything with
 * side effects beyond that shared pure helper.
 *
 * ## Advertised shape
 *
 * - `header` — SHORT title; also the model-facing answers key. Colliding
 *   headers are uniquified (` (2)`, ` (3)`, …) so answers cannot overwrite.
 * - `description` — optional FULL prompt / extra context under the header.
 *
 * `id` is an INTERNAL draft/React key only. Legacy `question` / `content` /
 * option `label` are accepted on read and mapped onto this shape.
 */

import {
	type CoercedAskQuestion,
	type CoercedAskQuestionOption,
	coerceAskQuestionShape,
	isKeyLike,
} from "@shared/ask-user-question-shape";

export type AskQuestionOption = CoercedAskQuestionOption;
export type AskQuestionInput = CoercedAskQuestion;
export { isKeyLike };

/**
 * Coerce a possibly-stringified questions value into sanitized AskQuestionInput[].
 *
 * Providers occasionally omit keys, stringify the whole array, send placeholders,
 * or bury the prompt in `question`/`content`. The UI tolerates this by repairing
 * the payload, so the backend must repair it too.
 */
export function coerceAskQuestions(raw: unknown): AskQuestionInput[] {
	return coerceAskQuestionShape(raw);
}
