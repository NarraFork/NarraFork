import type { AsyncQuestion } from "@frontend/types/narrator";
import type { Question } from "./ask-user-question-utils";

/**
 * Normalize a stored async question into the banner's shape.
 *
 * The two shapes differ in exactly one way, and it is deliberate on both sides: the
 * STORED form leaves `options` and each option's `description` optional, because a
 * free-form question legitimately has neither, while the BANNER's type requires both
 * so its render path never has to branch on absence.
 *
 * Filling the defaults here — rather than loosening `Question` — keeps that guarantee
 * for the banner's other callers (the blocking permission path), which never see a
 * missing description.
 *
 * Shared by the inbox drawer and the panel's inline slots so a question cannot render
 * differently in the two places.
 */
export function toBannerQuestions(questions: AsyncQuestion["questions"]): Question[] {
	return questions.map((q) => ({
		question: q.question,
		header: q.header,
		...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
		options: (q.options ?? []).map((option) => ({
			label: option.label,
			description: option.description ?? "",
			...(option.preview !== undefined ? { preview: option.preview } : {}),
		})),
	}));
}
