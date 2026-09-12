export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface Question {
	question: string;
	header: string;
	multiSelect?: boolean;
	options: QuestionOption[];
}

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

const INVALID_QUESTION_KEYS = new Set(["undefined", "null"]);

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isUsableQuestionKey(value: string): boolean {
	const normalized = value.trim();
	return normalized.length > 0 && !INVALID_QUESTION_KEYS.has(normalized.toLowerCase());
}

function uniqueQuestionKey(base: string, index: number, used: Set<string>): string {
	const fallbackBase = base.trim() || `Question ${index + 1}`;
	let candidate = fallbackBase;
	if (used.has(candidate)) candidate = `${fallbackBase} (${index + 1})`;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${fallbackBase} (${index + 1}-${suffix})`;
		suffix += 1;
	}
	used.add(candidate);
	return candidate;
}

/**
 * Coerce a possibly-stringified questions value into sanitized Question[].
 *
 * Providers occasionally omit `question` or stringify malformed values. The UI uses
 * `question` as the submitted answer key, so never allow an empty/undefined/null key
 * to leak into the answers payload.
 */
export function coerceQuestions(raw: unknown): Question[] {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];

	const usedQuestionKeys = new Set<string>();
	const questions: Question[] = [];
	value.forEach((item, index) => {
		if (!item || typeof item !== "object") return;
		const record = item as Record<string, unknown>;
		const rawQuestion = normalizeText(record.question);
		const rawHeader = normalizeText(record.header);
		const header =
			rawHeader || (isUsableQuestionKey(rawQuestion) ? rawQuestion : `Question ${index + 1}`);
		const questionBase = isUsableQuestionKey(rawQuestion) ? rawQuestion : header;
		const question = uniqueQuestionKey(questionBase, index, usedQuestionKeys);
		const rawOptions = Array.isArray(record.options) ? record.options : [];
		const options = rawOptions
			.map((option) => {
				if (!option || typeof option !== "object") return null;
				const optionRecord = option as Record<string, unknown>;
				const label = normalizeText(optionRecord.label);
				if (!label) return null;
				const description =
					typeof optionRecord.description === "string" ? optionRecord.description : "";
				const preview = typeof optionRecord.preview === "string" ? optionRecord.preview : undefined;
				return { label, description, ...(preview !== undefined ? { preview } : {}) };
			})
			.filter((option): option is QuestionOption => option !== null);

		questions.push({
			question,
			header,
			options,
			multiSelect: record.multiSelect === true,
		});
	});
	return questions;
}

function getAnswerForKey(
	savedAnswers: Record<string, string> | undefined,
	key: string,
): string | undefined {
	if (!savedAnswers || !key) return undefined;
	const value = savedAnswers[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function resolveSavedAnswer(
	question: Question,
	savedAnswers: Record<string, string> | undefined,
	options: { allowSingleAnswerFallback?: boolean } = {},
): string | undefined {
	const direct = getAnswerForKey(savedAnswers, question.question);
	if (direct) return direct;
	const byHeader = getAnswerForKey(savedAnswers, question.header);
	if (byHeader) return byHeader;

	if (options.allowSingleAnswerFallback && savedAnswers) {
		const values = Object.values(savedAnswers).filter(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		);
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

export function isAnswerOptionSelected(answer: string | undefined, optionLabel: string): boolean {
	if (!answer) return false;
	const target = optionLabel.trim();
	if (!target) return false;
	const normalizedAnswer = answer.trim();
	return normalizedAnswer === target || splitAnswerParts(normalizedAnswer).includes(target);
}

export function isSavedOptionSelected(
	question: Question,
	optionLabel: string,
	savedAnswers: Record<string, string> | undefined,
	options: { allowSingleAnswerFallback?: boolean } = {},
): boolean {
	return isAnswerOptionSelected(resolveSavedAnswer(question, savedAnswers, options), optionLabel);
}

export function getSelectedOptionValue(
	question: Question,
	savedAnswers: Record<string, string> | undefined,
	options: { allowSingleAnswerFallback?: boolean } = {},
): string {
	const answer = resolveSavedAnswer(question, savedAnswers, options);
	return (
		question.options.find((option) => isAnswerOptionSelected(answer, option.label))?.label ?? ""
	);
}

export function getCustomSavedAnswer(
	question: Question,
	savedAnswers: Record<string, string> | undefined,
	options: { allowSingleAnswerFallback?: boolean } = {},
): string | undefined {
	const answer = resolveSavedAnswer(question, savedAnswers, options);
	if (!answer) return undefined;
	const optionLabels = new Set(question.options.map((option) => option.label));
	const normalizedAnswer = answer.trim();
	if (optionLabels.has(normalizedAnswer)) return undefined;
	const parts = splitAnswerParts(normalizedAnswer);
	if (parts.length > 0 && parts.every((part) => optionLabels.has(part))) return undefined;
	return answer;
}
