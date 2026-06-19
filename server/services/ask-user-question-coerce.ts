/**
 * Pure, side-effect-free coercion/repair logic for AskUserQuestion input.
 *
 * Kept separate from `ask-user-question-reflection.ts` so that importing the
 * coercion helper (e.g. in unit tests) does not pull in the agent/db/service
 * dependency graph. This module must not import anything with side effects.
 */

export interface AskQuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface AskQuestionInput {
	question: string;
	header: string;
	options: AskQuestionOption[];
	multiSelect?: boolean;
}

const INVALID_QUESTION_KEYS = new Set(["undefined", "null"]);

function normalizeQuestionText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isUsableQuestionKey(value: string): boolean {
	return value.length > 0 && !INVALID_QUESTION_KEYS.has(value.toLowerCase());
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
 * Coerce a possibly-stringified questions value into sanitized AskQuestionInput[].
 *
 * Providers occasionally omit `question`, stringify the whole array, or send a
 * placeholder key ("undefined"/"null"). The UI tolerates this by repairing the
 * payload, so the backend must repair it too — otherwise strict validation fails
 * a call that looks perfectly fine in the UI. Missing/placeholder keys are derived
 * from the header (or a positional fallback) and de-duplicated. Only entries that
 * cannot yield a header at all are dropped.
 */
export function coerceAskQuestions(raw: unknown): AskQuestionInput[] {
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
	const questions: AskQuestionInput[] = [];
	value.forEach((item, index) => {
		if (!item || typeof item !== "object") return;
		const record = item as Record<string, unknown>;
		const rawQuestion = normalizeQuestionText(record.question);
		const rawHeader = normalizeQuestionText(record.header);
		const header =
			rawHeader || (isUsableQuestionKey(rawQuestion) ? rawQuestion : `Question ${index + 1}`);
		const questionBase = isUsableQuestionKey(rawQuestion) ? rawQuestion : header;
		const question = uniqueQuestionKey(questionBase, index, usedQuestionKeys);
		const rawOptions = Array.isArray(record.options) ? record.options : [];
		const options = rawOptions
			.map((option) => {
				if (!option || typeof option !== "object") return null;
				const optionRecord = option as Record<string, unknown>;
				const label = normalizeQuestionText(optionRecord.label);
				if (!label) return null;
				return {
					label,
					description: typeof optionRecord.description === "string" ? optionRecord.description : "",
					...(typeof optionRecord.preview === "string" ? { preview: optionRecord.preview } : {}),
				};
			})
			.filter((option): option is AskQuestionOption => option !== null);
		questions.push({
			question,
			header,
			options,
			multiSelect: record.multiSelect === true,
		});
	});
	return questions;
}
