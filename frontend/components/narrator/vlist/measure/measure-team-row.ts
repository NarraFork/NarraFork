/**
 * measure-team-row.ts — The team page's two opt-in row kinds (team mode of the coordinator
 * conversation, see `team-conversation-transform.ts`):
 *
 *   ┌ team-chip ──────────────────────────────────────────────────────────────┐
 *   │  outer py 2 + pill (py 2 + max(icon 16, xs line)) = trace header band    │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *   ┌ team-event ─────────────────────────────────────────────────────────────┐
 *   │  ── 10:31 · 「修复导出 CSV 时区错误」评审通过 ──  = trace count line      │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * Both are ONE nowrap line with an ellipsis, so the height never depends on the text or the
 * width: it is the trace geometry at the reader's current typography (`traceMetrics`), the
 * same rows an activity trace header / count line use. Zero DOM, zero text measurement.
 */

import {
	accumulateFrame,
	type LineMetricsResolver,
	type MeasuredElement,
	type PreparedFixedBlock,
} from "../prepared-block";
import { traceMetrics } from "./measure-tool-run";

/** Adapter payload of a chip (`team-conversation-transform.ts`). */
export interface TeamChipData {
	/** The action's label (「创建工作项」). */
	label: string;
	/** Calls folded into the chip. */
	count: number;
	/** 「×7」, empty for one call. */
	countLabel: string;
	/** Calls that failed. */
	failed: number;
	/** Tooltip of the error mark (「1 次失败」), empty without failures. */
	failedLabel: string;
	/** Calls cancelled, denied or aborted (a grey mark, never a green check). */
	cancelled: number;
	/** Tooltip of that mark (「1 次取消」), empty without any. */
	cancelledLabel: string;
	/** The worst outcome among the calls (keys the measure cache). */
	status: "fail" | "cancelled" | "success";
	/** Everything painted, joined: keys the measure cache (`extractDataRevision`'s `text`). */
	text: string;
}

/** Adapter payload of a divider. */
export interface TeamEventData {
	/** The whole line, pre-composed: 「10:31 · 「…」评审通过」. */
	text: string;
	tone: "ok" | "warn" | "neutral";
}

export interface MeasuredTeamChip extends MeasuredElement {
	kind: "team-chip";
	data: TeamChipData;
	/** Whether the folded cards are shown below (read back by the shell's toggle). */
	expanded: boolean;
}

export interface MeasuredTeamEvent extends MeasuredElement {
	kind: "team-event";
	data: TeamEventData;
}

const NO_TEXT_MEASURE: LineMetricsResolver = () => ({ lineCount: 1, maxLineWidth: 0 });

function fixedBlock(tag: string, height: number): PreparedFixedBlock {
	return {
		kind: "fixed",
		height,
		tag,
		marginTop: 0,
		contentLeft: 0,
		quoteRailLefts: [],
		markerText: null,
		markerLeft: null,
		markerClassName: null,
	};
}

export function measureTeamChip(
	data: TeamChipData,
	contentWidth: number,
	opts?: { expanded?: boolean },
): MeasuredTeamChip {
	const block = fixedBlock("team-chip", traceMetrics().headerBandHeight);
	const frame = accumulateFrame([block], contentWidth, NO_TEXT_MEASURE);
	return {
		kind: "team-chip",
		height: frame.contentHeight,
		blocks: [block],
		frame,
		contentWidth,
		usedWidth: contentWidth,
		data,
		expanded: opts?.expanded === true,
	};
}

export function measureTeamEvent(data: TeamEventData, contentWidth: number): MeasuredTeamEvent {
	const block = fixedBlock("team-event", traceMetrics().countLineHeight);
	const frame = accumulateFrame([block], contentWidth, NO_TEXT_MEASURE);
	return {
		kind: "team-event",
		height: frame.contentHeight,
		blocks: [block],
		frame,
		contentWidth,
		usedWidth: contentWidth,
		data,
	};
}
