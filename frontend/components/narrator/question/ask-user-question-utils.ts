import {
	type CoercedAskQuestion,
	type CoercedAskQuestionOption,
	coerceAskQuestionShape,
} from "@shared/ask-user-question-shape";

export type QuestionOption = CoercedAskQuestionOption;

/**
 * Normalized AskUserQuestion shape used by the UI.
 *
 * Advertised to models as header + description only. `id` is an internal
 * draft/React key; model-facing answers are keyed by the uniquified `header`.
 */
export type Question = CoercedAskQuestion;

/**
 * Format a millisecond duration as HH:MM:SS (clamped at 0).
 */
export function formatHMS(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Coerce a possibly-stringified questions value into sanitized Question[].
 *
 * Delegates to `@shared/ask-user-question-shape` so the inbox, banner, and
 * server store one normalization (including colliding-header uniquify).
 */
export function coerceQuestions(raw: unknown): Question[] {
	return coerceAskQuestionShape(raw);
}

function getAnswerForKey(
	savedAnswers: Record<string, string> | undefined,
	key: string,
): string | undefined {
	if (!savedAnswers || !key) return undefined;
	const value = savedAnswers[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

type SavedAnswerOptions = {
	allowSingleAnswerFallback?: boolean;
	answerKey?: "id" | "header";
	canonicalQuestionIds?: ReadonlySet<string>;
};

export function resolveSavedAnswer(
	question: Question,
	savedAnswers: Record<string, string> | undefined,
	options: SavedAnswerOptions = {},
): string | undefined {
	const byId = getAnswerForKey(savedAnswers, question.id);
	if (options.answerKey === "id") {
		if (byId) return byId;
		// A legacy header cannot claim another question's canonical ID.
		if (!options.canonicalQuestionIds?.has(question.header)) {
			const byHeader = getAnswerForKey(savedAnswers, question.header);
			if (byHeader) return byHeader;
		}
	} else {
		// Synchronous model-facing answers retain the existing header protocol.
		const byHeader = getAnswerForKey(savedAnswers, question.header);
		if (byHeader) return byHeader;
		if (byId) return byId;
	}

	if (options.allowSingleAnswerFallback && savedAnswers) {
		const values = Object.entries(savedAnswers)
			.filter(
				([key]) =>
					options.answerKey !== "id" ||
					key === question.id ||
					!options.canonicalQuestionIds?.has(key),
			)
			.map(([, value]) => value)
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (values.length === 1) return values[0];
	}
	return undefined;
}

function splitAnswerParts(answer: string): string[] {
	return answer
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function isAnswerOptionSelected(answer: string | undefined, optionHeader: string): boolean {
	if (!answer) return false;
	const target = optionHeader.trim();
	if (!target) return false;
	const normalizedAnswer = answer.trim();
	return normalizedAnswer === target || splitAnswerParts(normalizedAnswer).includes(target);
}

export function isSavedOptionSelected(
	question: Question,
	optionHeader: string,
	savedAnswers: Record<string, string> | undefined,
	options: SavedAnswerOptions = {},
): boolean {
	return isAnswerOptionSelected(resolveSavedAnswer(question, savedAnswers, options), optionHeader);
}

export function getSelectedOptionValue(
	question: Question,
	savedAnswers: Record<string, string> | undefined,
	options: SavedAnswerOptions = {},
): string {
	const answer = resolveSavedAnswer(question, savedAnswers, options);
	return (
		question.options.find((option) => isAnswerOptionSelected(answer, option.header))?.header ?? ""
	);
}

export function getCustomSavedAnswer(
	question: Question,
	savedAnswers: Record<string, string> | undefined,
	options: SavedAnswerOptions = {},
): string | undefined {
	const answer = resolveSavedAnswer(question, savedAnswers, options);
	if (!answer) return undefined;
	const optionHeaders = new Set(question.options.map((option) => option.header));
	const normalizedAnswer = answer.trim();
	if (optionHeaders.has(normalizedAnswer)) return undefined;
	const parts = splitAnswerParts(normalizedAnswer);
	if (parts.length > 0 && parts.every((part) => optionHeaders.has(part))) return undefined;
	return answer;
}
