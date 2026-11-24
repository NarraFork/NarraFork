import type { ModelTraceResultBlock } from "@shared/modeltrace-result";

export const MODELTRACE_MAX_TEXT_LENGTH = 10_000;
export const MODELTRACE_RESULT_LIMIT = 5;
export type ModelTraceOutput = { text: string; expected_count: number };
export type Ranking = Required<Pick<ModelTraceResultBlock, "decision" | "results">>;
export type WorkerReply = { type: "ranked"; ranking: Ranking } | { type: "unavailable" };

export function validOutputs(outputs: ModelTraceOutput[]): boolean {
	return (
		Array.isArray(outputs) &&
		outputs.length <= 3 &&
		outputs.every(
			(output) =>
				output &&
				typeof output.text === "string" &&
				output.text.length <= MODELTRACE_MAX_TEXT_LENGTH &&
				Number.isInteger(output.expected_count) &&
				output.expected_count >= 292 &&
				output.expected_count <= 332,
		)
	);
}

export function isRanking(value: unknown): value is Ranking {
	if (!value || typeof value !== "object") return false;
	const { decision, results } = value as Partial<Ranking>;
	if (!Array.isArray(results)) return false;
	if (decision === "unscorable" || decision === "not_model") return results.length === 0;
	return (
		(decision === "scored" || decision === "partial") &&
		results.length > 0 &&
		results.length <= MODELTRACE_RESULT_LIMIT &&
		results.every(
			(row) =>
				row &&
				typeof row.model === "string" &&
				row.model.length <= 256 &&
				typeof row.displayName === "string" &&
				row.displayName.length <= 256 &&
				((decision === "scored" && row.probability === null) ||
					(typeof row.probability === "number" &&
						Number.isFinite(row.probability) &&
						row.probability >= 0 &&
						row.probability <= 1)),
		)
	);
}
