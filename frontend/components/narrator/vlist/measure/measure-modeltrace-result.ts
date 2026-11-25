import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { accumulateFrame, type MeasuredElement, type PreparedFixedBlock } from "../prepared-block";

/** Explicit pixel lanes shared with render; every label is single-line ellipsis. */
export const MODELTRACE_LAYOUT = {
	padding: 12,
	gap: 10,
	name: 20,
	winnerName: 26,
	barGap: 4,
	bar: 6,
	winnerBar: 8,
	footnote: 16,
	calibration: 30,
	maxResults: 5,
	maxSamples: 3,
} as const;

export function modelTraceRowHeight(winner: boolean): number {
	const c = MODELTRACE_LAYOUT;
	return (winner ? c.winnerName : c.name) + c.barGap + (winner ? c.winnerBar : c.bar);
}

export function modelTraceResultHeight(rowCount: number): number {
	const c = MODELTRACE_LAYOUT;
	const chrome = 2 * c.padding;
	if (rowCount === 0) return chrome + c.name;
	return (
		chrome +
		modelTraceRowHeight(true) +
		(rowCount - 1) * (modelTraceRowHeight(false) + c.gap) +
		c.gap +
		c.footnote
	);
}

type SampleProgress = NonNullable<ModelTraceResultBlock["sampleProgress"]>[number];
const SAMPLE_STATES = new Set<SampleProgress["state"]>([
	"pending",
	"running",
	"retrying",
	"complete",
	"failed",
	"cancelled",
]);

export function hasIncompleteCalibration(data: ModelTraceResultBlock): boolean {
	return !data.progressOnly && data.calibrationRequested === true && data.decision !== "scored";
}

/** Project exactly the bounded payload that will be painted, including historical cards. */
export function prepareModelTraceResult(data: ModelTraceResultBlock): ModelTraceResultBlock {
	const results: ModelTraceResultBlock["results"] = [];
	if (!data.error && !data.progressOnly && Array.isArray(data.results)) {
		for (const row of data.results) {
			if (
				row &&
				typeof row.model === "string" &&
				typeof row.displayName === "string" &&
				(row.probability === null ||
					(typeof row.probability === "number" && row.probability >= 0 && row.probability <= 1))
			) {
				results.push({
					model: row.model,
					displayName: row.displayName,
					probability: row.probability,
				});
				if (results.length === MODELTRACE_LAYOUT.maxResults) break;
			}
		}
	}
	if (data.decision === "partial") {
		const weightSum = results.reduce((sum, row) => sum + (row.probability ?? 0), 0);
		for (const row of results) {
			if (row.probability !== null && weightSum > 0) row.probability /= weightSum;
		}
	}
	const sampleProgress = Array.isArray(data.sampleProgress)
		? data.sampleProgress.slice(0, MODELTRACE_LAYOUT.maxSamples).map(
				(slot): SampleProgress => ({
					state: slot && SAMPLE_STATES.has(slot.state) ? slot.state : "pending",
					attempt:
						typeof slot?.attempt === "number" &&
						Number.isSafeInteger(slot.attempt) &&
						slot.attempt > 0
							? slot.attempt
							: undefined,
					text: typeof slot?.text === "string" ? slot.text.slice(0, 500) : undefined,
				}),
			)
		: undefined;
	return {
		type: "modeltrace_result",
		results,
		decision: data.decision,
		error: data.error,
		progressOnly: data.progressOnly === true,
		calibrationRequested: data.calibrationRequested === true,
		calibrationId:
			!data.progressOnly && typeof data.calibrationId === "string" && data.calibrationId.trim()
				? data.calibrationId
				: undefined,
		sampleProgress,
		cacheReadTokens: Array.isArray(data.cacheReadTokens)
			? data.cacheReadTokens
					.slice(0, MODELTRACE_LAYOUT.maxSamples)
					.map((tokens) =>
						typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
							? tokens
							: null,
					)
			: undefined,
	};
}

export function measureModelTraceResult(
	data: ModelTraceResultBlock,
	contentWidth: number,
): MeasuredElement {
	const modelTrace = prepareModelTraceResult(data);
	const { footnote, gap, calibration } = MODELTRACE_LAYOUT;
	const extraRows =
		Number(Boolean(modelTrace.cacheReadTokens?.length)) +
		Number(hasIncompleteCalibration(modelTrace)) +
		(modelTrace.sampleProgress?.length ?? 0);
	const block: PreparedFixedBlock = {
		kind: "fixed",
		tag: "modeltrace_result",
		height:
			modelTraceResultHeight(modelTrace.results.length) +
			extraRows * (footnote + gap) +
			(modelTrace.calibrationId ? calibration + gap : 0),
		data: { ...modelTrace },
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
	const blocks = [block];
	const frame = accumulateFrame(blocks, contentWidth, () => ({ lineCount: 1, maxLineWidth: 0 }));
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
	};
}
