import { describe, expect, it } from "bun:test";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";
import {
	MEASURE_SUBAGENT_RECOVERY_CONSTANTS as C,
	measureSubagentRecovery,
	SUBAGENT_RECOVERY_TAG,
	type SubagentRecoveryData,
	type SubagentRecoveryRow,
	subagentRecoveryPendingHeight,
} from "./measure-subagent-recovery";

const WIDTH = 640;

/** The card always produces exactly one fixed block; narrow to it for payload reads. */
function fixedBlock(measured: MeasuredElement): PreparedFixedBlock {
	const block = measured.blocks[0];
	if (!block || block.kind !== "fixed") throw new Error("expected a single fixed block");
	return block;
}

function payloadOf<T>(measured: MeasuredElement): T {
	return fixedBlock(measured).data as unknown as T;
}

function row(index: number, overrides: Partial<SubagentRecoveryRow> = {}): SubagentRecoveryRow {
	return {
		id: `sub-${index}`,
		title: `Investigate thing ${index}`,
		subagentType: "explore",
		...overrides,
	};
}

function data(count: number, overrides: Partial<SubagentRecoveryData> = {}): SubagentRecoveryData {
	return {
		kind: "pending",
		title: "Subagents stopped with an error",
		description: `${count} subagent(s) did not finish.`,
		subagents: Array.from({ length: count }, (_v, i) => row(i)),
		notifyLabel: "Resume and notify",
		waitLabel: "Resume and wait",
		backgroundBadge: "to background",
		...overrides,
	};
}

describe("subagentRecoveryPendingHeight", () => {
	it("collapses the checkbox stack entirely with zero rows", () => {
		expect(subagentRecoveryPendingHeight(0)).toBe(C.PENDING_BASE_HEIGHT);
		expect(subagentRecoveryPendingHeight(-3)).toBe(C.PENDING_BASE_HEIGHT);
	});

	it("adds one row plus the list gap for a single entry", () => {
		expect(subagentRecoveryPendingHeight(1)).toBe(
			C.PENDING_BASE_HEIGHT + C.STACK_GAP + C.ROW_HEIGHT,
		);
	});

	it("grows linearly beyond the first row", () => {
		const one = subagentRecoveryPendingHeight(1);
		const two = subagentRecoveryPendingHeight(2);
		const three = subagentRecoveryPendingHeight(3);
		expect(two - one).toBe(C.PENDING_HEIGHT_PER_ROW);
		expect(three - two).toBe(C.PENDING_HEIGHT_PER_ROW);
	});

	it("matches the explicit chrome formula", () => {
		const n = 4;
		const expected =
			C.CARD_PADDING * 2 +
			C.HEADER_HEIGHT +
			(C.STACK_GAP + n * C.ROW_HEIGHT + (n - 1) * C.ROW_GAP) +
			C.STACK_GAP +
			C.BUTTON_ROW_HEIGHT;
		expect(subagentRecoveryPendingHeight(n)).toBe(expected);
	});
});

describe("measureSubagentRecovery", () => {
	it("produces a single fixed block tagged for the renderer", () => {
		const measured = measureSubagentRecovery(data(2), WIDTH);
		expect(measured.blocks).toHaveLength(1);
		expect(fixedBlock(measured).kind).toBe("fixed");
		expect(fixedBlock(measured).tag).toBe(SUBAGENT_RECOVERY_TAG);
		expect(measured.height).toBe(subagentRecoveryPendingHeight(2));
	});

	// Every row is truncate-clamped, so neither text nor width can change the height.
	it("is independent of content width", () => {
		const narrow = measureSubagentRecovery(data(3), 240);
		const wide = measureSubagentRecovery(data(3), 1200);
		expect(narrow.height).toBe(wide.height);
		expect(narrow.usedWidth).toBe(240);
		expect(wide.usedWidth).toBe(1200);
	});

	it("is independent of label length", () => {
		const short = measureSubagentRecovery(data(2), WIDTH);
		const long = measureSubagentRecovery(
			data(2, {
				title: "A".repeat(400),
				description: "B".repeat(400),
				subagents: [row(0, { title: "C".repeat(400) }), row(1, { title: "D".repeat(400) })],
			}),
			WIDTH,
		);
		expect(long.height).toBe(short.height);
	});

	it("is independent of the render LOD", () => {
		const heights = [1, 2, 3, 4, 5].map(
			(lod) => measureSubagentRecovery(data(2), WIDTH, lod as never).height,
		);
		expect(new Set(heights).size).toBe(1);
	});

	it("keeps the height stable when the selection changes but records it in the payload", () => {
		const all = measureSubagentRecovery(data(3), WIDTH, undefined, { deselected: [] });
		const partial = measureSubagentRecovery(data(3), WIDTH, undefined, { deselected: [0, 2] });
		expect(partial.height).toBe(all.height);
		const payload = payloadOf<{ deselected: number[] }>(partial);
		expect(payload.deselected).toEqual([0, 2]);
	});

	it("defaults to nothing deselected (the card starts fully selected)", () => {
		const measured = measureSubagentRecovery(data(2), WIDTH);
		const payload = payloadOf<{ deselected: number[] }>(measured);
		expect(payload.deselected).toEqual([]);
	});

	it("carries the row payload the renderer needs", () => {
		const measured = measureSubagentRecovery(
			data(1, { subagents: [row(0, { wasForeground: true })] }),
			WIDTH,
		);
		const payload = payloadOf<{
			subagents: Array<{ id: string; title: string; subagentType: string; wasForeground: boolean }>;
		}>(measured);
		expect(payload.subagents[0]).toEqual({
			id: "sub-0",
			title: "Investigate thing 0",
			subagentType: "explore",
			wasForeground: true,
		});
	});

	it("normalizes a missing wasForeground flag to false", () => {
		const measured = measureSubagentRecovery(data(1), WIDTH);
		const payload = payloadOf<{ subagents: Array<{ wasForeground: boolean }> }>(measured);
		expect(payload.subagents[0]!.wasForeground).toBe(false);
	});

	it("uses the compact single-line height for the resolved state", () => {
		const measured = measureSubagentRecovery(
			data(5, { kind: "resolved", summary: "Restarted 5 subagent(s)." }),
			WIDTH,
		);
		expect(measured.height).toBe(C.RESOLVED_HEIGHT);
		expect(payloadOf<{ kind: string }>(measured).kind).toBe("resolved");
	});

	it("treats any non-resolved kind as pending", () => {
		const measured = measureSubagentRecovery(data(2, { kind: "weird" as never }), WIDTH);
		expect(measured.height).toBe(subagentRecoveryPendingHeight(2));
		expect(payloadOf<{ kind: string }>(measured).kind).toBe("pending");
	});

	it("tolerates a malformed subagents payload", () => {
		const measured = measureSubagentRecovery(data(0, { subagents: undefined as never }), WIDTH);
		expect(measured.height).toBe(C.PENDING_BASE_HEIGHT);
	});

	// The height is a pure linear function of the row count, so an unbounded list
	// would reserve a multi-thousand-pixel card. Other measured details cap the
	// same way (META_ROWS_MAX = 12, ENTRY_MAX = 10).
	it("caps the listed rows so the card height stays bounded", () => {
		const measured = measureSubagentRecovery(data(500), WIDTH);
		expect(measured.height).toBe(subagentRecoveryPendingHeight(C.ROWS_MAX));
		// The renderer draws `block.data.subagents`, so it must see the same slice —
		// otherwise it would paint more rows than the measured box reserves.
		expect(payloadOf<{ subagents: unknown[] }>(measured).subagents).toHaveLength(C.ROWS_MAX);
	});

	it("leaves a list at or below the cap untouched", () => {
		const measured = measureSubagentRecovery(data(C.ROWS_MAX), WIDTH);
		expect(measured.height).toBe(subagentRecoveryPendingHeight(C.ROWS_MAX));
		expect(payloadOf<{ subagents: unknown[] }>(measured).subagents).toHaveLength(C.ROWS_MAX);
	});
});

describe("chrome constants", () => {
	it("derive from the shared pretext font metrics", () => {
		expect(C.XS_LINE_HEIGHT).toBe(17); // round(12 × 1.4)
		expect(C.CARD_PADDING).toBe(12); // Paper p="sm"
		expect(C.RESOLVED_PADDING).toBe(10); // Paper p="xs"
		expect(C.STACK_GAP).toBe(10); // Stack gap="xs"
		expect(C.ROW_HEIGHT).toBe(20); // max(checkbox 20, xs line 17)
		expect(C.ROW_GAP).toBe(4);
		expect(C.BUTTON_ROW_HEIGHT).toBe(26); // Button compact-sm
		expect(C.HEADER_HEIGHT).toBe(36); // 17×2 + 2
		expect(C.PENDING_HEIGHT_PER_ROW).toBe(24); // 20 + 4
		expect(C.RESOLVED_HEIGHT).toBe(37); // 10×2 + 17
	});
});
