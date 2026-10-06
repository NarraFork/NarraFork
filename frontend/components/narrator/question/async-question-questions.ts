import type { AsyncQuestion } from "@frontend/types/narrator";
import { coerceQuestions, type Question } from "./ask-user-question-utils";

/**
 * Normalize a stored async question into the banner's shape.
 *
 * Delegates to `coerceQuestions` so stored legacy payloads (`question`/`label`)
 * and the advertised header/description shape both land on one type. Filling
 * option defaults here — rather than loosening `Question` — keeps the banner's
 * guarantee that `options` and each option's `header` always exist.
 *
 * Shared by the inbox drawer and the panel's inline slots so a question cannot
 * render differently in the two places.
 */
export function toBannerQuestions(questions: AsyncQuestion["questions"]): Question[] {
	return coerceQuestions(questions);
}
