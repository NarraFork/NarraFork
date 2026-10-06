/** Byte budgets shared by tools, routes and persisted question projections. */
export const QUESTION_CONTEXT_MAX_BYTES = 2 * 1024;
export const QUESTION_SNAPSHOT_MAX_BYTES = 64 * 1024;
export const QUESTION_ANSWER_MAX_BYTES = 16 * 1024;
export const QUESTION_RECEIPT_MAX_BYTES = 80 * 1024;
export const QUESTION_NOTE_MAX_BYTES = 2 * 1024;
export const QUESTION_HINT_MAX_BYTES = 4 * 1024;
export type QuestionFilter = "open" | "pending" | "history" | "all";
export interface QuestionResolution {
	answerMessageId: string;
	note: string;
	resolvedAt: string;
	actor: string;
}
export function questionBytes(value: unknown): number {
	return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}
export function assertQuestionBudget(value: unknown, max: number, label: string): void {
	// A UTF-16 code-unit count is a cheap lower bound on UTF-8 bytes; reject giant
	// strings before TextEncoder would allocate a second giant buffer.
	if ((typeof value === "string" && value.length > max) || questionBytes(value) > max)
		throw new Error(`${label} exceeds ${max} UTF-8 bytes.`);
}
/** ID is canonical; legacy titles are accepted only when exactly one question matches. */
export function normalizeQuestionKeys<T>(
	questions: { id: string; header: string }[],
	values: Record<string, T>,
): Record<string, T> {
	const result: Record<string, T> = {};
	const mapped = new Map<string, T>();
	for (const [key, value] of Object.entries(values)) {
		const exactIds = questions.filter((question) => question.id === key);
		const matches = exactIds.length
			? exactIds
			: questions.filter((question) => question.header === key);
		if (matches.length !== 1) throw new Error(`Unknown or ambiguous question answer key: ${key}`);
		const id = matches[0].id;
		if (mapped.has(id)) throw new Error(`Duplicate question answer key: ${key}`);
		mapped.set(id, value);
	}
	for (const question of questions) {
		if (mapped.has(question.id))
			Object.defineProperty(result, question.id, {
				value: mapped.get(question.id),
				enumerable: true,
				configurable: true,
				writable: true,
			});
	}
	return result;
}
