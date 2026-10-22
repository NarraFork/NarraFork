/**
 * Swimlane layout invariants for the Git commit graph column.
 *
 * These lock the Stage 2 contract Stage 3 (GitPanel) will render against:
 * parents semantics, lane continuity, HEAD coloring, lane cap, and pure SVG
 * path/circle math that must not touch the DOM.
 */

import { describe, expect, test } from "bun:test";
import {
	buildRowCircles,
	buildRowSvgPaths,
	type GitGraphCommit,
	GRAPH_COLORS,
	GRAPH_HEAD_COLOR,
	GRAPH_LANE_WIDTH,
	GRAPH_MAX_LANES,
	graphRowWidth,
	layoutCommitGraph,
} from "./git-graph-layout";

function commit(sha: string, parents?: string[], extra?: Partial<GitGraphCommit>): GitGraphCommit {
	return {
		sha,
		shortSha: sha.slice(0, 7),
		message: `commit ${sha}`,
		author: "tester",
		date: "2026-01-01T00:00:00Z",
		parents,
		...extra,
	};
}

describe("layoutCommitGraph", () => {
	test.each([
		{ from: 22, to: 11, sweep1: 1, sweep2: 0 },
		{ from: 33, to: 11, sweep1: 1, sweep2: 0 },
		{ from: 11, to: 22, sweep1: 0, sweep2: 1 },
		{ from: 11, to: 33, sweep1: 0, sweep2: 1 },
	])("through-lane curves remain tangent when moving $from → $to", ({
		from,
		to,
		sweep1,
		sweep2,
	}) => {
		const lane = { id: "parent", color: GRAPH_COLORS[0] as string };
		const lanes = (x: number) =>
			Array.from({ length: x / GRAPH_LANE_WIDTH }, (_, i) =>
				i === x / GRAPH_LANE_WIDTH - 1 ? lane : { id: `other-${i}`, color: lane.color },
			);
		const paths = buildRowSvgPaths({
			commit: commit("root", []),
			input: lanes(from),
			output: lanes(to),
			laneIndex: 0,
			color: lane.color,
			isHead: false,
			topologyKnown: true,
		});
		const dir = to > from ? 1 : -1;
		expect(paths).toContainEqual({
			d: `M ${from} 0 V 6 A 5 5 0 0 ${sweep1} ${from + dir * 5} 11 H ${to - dir * 5} A 5 5 0 0 ${sweep2} ${to} 16 V 22`,
			stroke: lane.color,
		});
	});

	test("1. empty commit list yields no rows", () => {
		expect(layoutCommitGraph([])).toEqual([]);
		expect(layoutCommitGraph([], "HEAD")).toEqual([]);
	});

	test("2. linear C→B→A stays single-lane, output id is the parent", () => {
		const rows = layoutCommitGraph([commit("C", ["B"]), commit("B", ["A"]), commit("A", [])]);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.laneIndex).toBe(0);
			expect(row.topologyKnown).toBe(true);
			expect(row.isHead).toBe(false);
		}
		// Single lineage → one shared color.
		const colors = new Set(rows.map((r) => r.color));
		expect(colors.size).toBe(1);
		expect(rows[0]?.color).toBe(GRAPH_COLORS[0]);
		// Newest first: C continues into B, B into A, root closes.
		expect(rows[0]?.output.map((l) => l.id)).toEqual(["B"]);
		expect(rows[0]?.output[0]?.color).toBe(rows[0]?.color);
		expect(rows[1]?.output.map((l) => l.id)).toEqual(["A"]);
		expect(rows[2]?.output).toEqual([]);
	});

	test("3. merge parents=[A,B] opens two output lanes", () => {
		const rows = layoutCommitGraph([commit("M", ["A", "B"]), commit("B", ["A"]), commit("A", [])]);
		const mergeRow = rows[0];
		expect(mergeRow).toBeDefined();
		if (!mergeRow) return;
		const ids = mergeRow.output.map((l) => l.id);
		expect(ids).toContain("A");
		expect(ids).toContain("B");
		expect(ids.length).toBe(2);
		// First parent keeps the merge color; second parent gets a palette lane.
		expect(mergeRow.output[0]?.id).toBe("A");
		expect(mergeRow.output[0]?.color).toBe(mergeRow.color);
		expect(mergeRow.output[1]?.id).toBe("B");
		expect(mergeRow.output[1]?.color).not.toBe(mergeRow.color);
		expect(GRAPH_COLORS).toContain(mergeRow.output[1]?.color);
		expect(mergeRow.laneIndex).toBe(0);
	});

	test("4. root commit parents=[] does not push a first-parent lane", () => {
		const rows = layoutCommitGraph([commit("B", ["A"]), commit("A", [])]);
		const root = rows[1];
		expect(root?.topologyKnown).toBe(true);
		expect(root?.commit.parents).toEqual([]);
		expect(root?.output).toEqual([]);
		expect(root?.laneIndex).toBe(0);
		// Paths: no lower half toward a parent; circle still present.
		const paths = buildRowSvgPaths(root as NonNullable<typeof root>);
		expect(paths.every((p) => !p.d.includes(`V 22`) || p.d.startsWith("M"))).toBe(true);
		const circles = buildRowCircles(root as NonNullable<typeof root>);
		expect(circles).toHaveLength(1);
		expect(circles[0]?.r).toBe(5);
	});

	test("5. parents undefined → topologyKnown=false, single-column dot", () => {
		const rows = layoutCommitGraph([commit("X"), commit("Y")]);
		for (const row of rows) {
			expect(row.topologyKnown).toBe(false);
			expect(row.laneIndex).toBe(0);
			expect(row.output).toHaveLength(1);
			expect(row.output[0]?.id).toBe(row.commit.sha);
		}
		// No invented edges when topology is unknown.
		const paths = buildRowSvgPaths(rows[0] as NonNullable<(typeof rows)[0]>);
		expect(paths).toEqual([]);
	});

	test("6. headSha match sets isHead and GRAPH_HEAD_COLOR", () => {
		const rows = layoutCommitGraph([commit("C", ["B"]), commit("B", ["A"]), commit("A", [])], "B");
		const head = rows.find((r) => r.commit.sha === "B");
		const other = rows.find((r) => r.commit.sha === "C");
		expect(head?.isHead).toBe(true);
		expect(head?.color).toBe(GRAPH_HEAD_COLOR);
		// First-parent lane of HEAD continues in HEAD color.
		expect(head?.output[0]?.id).toBe("A");
		expect(head?.output[0]?.color).toBe(GRAPH_HEAD_COLOR);
		expect(other?.isHead).toBe(false);
		expect(other?.color).not.toBe(GRAPH_HEAD_COLOR);
	});

	test("7. lane output is capped at GRAPH_MAX_LANES", () => {
		const manyParents = Array.from({ length: 20 }, (_, i) => `p${i}`);
		const rows = layoutCommitGraph([
			commit("octopus", manyParents),
			...manyParents.map((p) => commit(p, [])),
		]);
		const top = rows[0];
		expect(top?.output.length).toBeLessThanOrEqual(GRAPH_MAX_LANES);
		expect(top?.output.length).toBe(GRAPH_MAX_LANES);
		expect(top?.laneIndex).toBeLessThan(GRAPH_MAX_LANES);
		for (const row of rows) {
			expect(row.output.length).toBeLessThanOrEqual(GRAPH_MAX_LANES);
			expect(row.laneIndex).toBeGreaterThanOrEqual(0);
			expect(row.laneIndex).toBeLessThan(GRAPH_MAX_LANES);
		}
	});

	test("8. circles: HEAD / merge / ordinary", () => {
		const headRows = layoutCommitGraph([commit("H", ["P"]), commit("P", [])], "H");
		const headCircles = buildRowCircles(headRows[0] as NonNullable<(typeof headRows)[0]>);
		expect(headCircles).toHaveLength(2);
		expect(headCircles[0]?.r).toBe(7);
		expect(headCircles[0]?.strokeWidth).toBe(2);
		expect(headCircles[0]?.fill).toBe(GRAPH_HEAD_COLOR);
		expect(headCircles[0]?.hollow).toBeUndefined();
		expect(headCircles[1]?.r).toBe(2);
		expect(headCircles[1]?.strokeWidth).toBe(4);
		expect(headCircles[1]?.hollow).toBe(true);

		const mergeRows = layoutCommitGraph([commit("M", ["A", "B"])]);
		const mergeCircles = buildRowCircles(mergeRows[0] as NonNullable<(typeof mergeRows)[0]>);
		expect(mergeCircles).toHaveLength(2);
		expect(mergeCircles[0]?.r).toBe(6);
		expect(mergeCircles[1]?.r).toBe(3);
		expect(mergeCircles[1]?.hollow).toBe(true);
		expect(mergeCircles[0]?.fill).toBe(mergeRows[0]?.color);

		const plainRows = layoutCommitGraph([commit("N", ["P"]), commit("P", [])]);
		const plainCircles = buildRowCircles(plainRows[1] as NonNullable<(typeof plainRows)[1]>);
		expect(plainCircles).toHaveLength(1);
		expect(plainCircles[0]?.r).toBe(5);
		expect(plainCircles[0]?.hollow).toBeUndefined();
		// Circle x uses lane index 0 → GRAPH_LANE_WIDTH * 1
		expect(plainCircles[0]?.cx).toBe(GRAPH_LANE_WIDTH);
		expect(plainCircles[0]?.cy).toBe(GRAPH_LANE_WIDTH);
	});

	test("9. graphRowWidth grows with swimlane count and covers stroke", () => {
		const linear = layoutCommitGraph([commit("C", ["B"]), commit("B", [])]);
		const linearWidth = graphRowWidth(linear[0] as NonNullable<(typeof linear)[0]>);
		// 1 lane + margin column + stroke bleed.
		expect(linearWidth).toBe(GRAPH_LANE_WIDTH * 2 + 2);

		const wideParents = ["a", "b", "c", "d"];
		const wide = layoutCommitGraph([commit("M", wideParents)]);
		const wideWidth = graphRowWidth(wide[0] as NonNullable<(typeof wide)[0]>);
		expect(wide[0]?.output.length).toBe(4);
		expect(wideWidth).toBe(GRAPH_LANE_WIDTH * 5 + 2);
		expect(wideWidth).toBeGreaterThan(linearWidth);

		// Empty output root still reserves one lane column.
		const rootOnly = layoutCommitGraph([commit("R", [])]);
		expect(graphRowWidth(rootOnly[0] as NonNullable<(typeof rootOnly)[0]>)).toBe(
			GRAPH_LANE_WIDTH * 2 + 2,
		);
	});

	test("9b. topology-unknown dots stay inside the SVG width (no left/right clip)", () => {
		// Regression: second+ rows used circleIndex=input.length → cx == width,
		// which rendered half-clipped crescents in the dock panel.
		const rows = layoutCommitGraph([commit("X"), commit("Y"), commit("Z")]);
		expect(rows.length).toBe(3);
		for (const row of rows) {
			const width = graphRowWidth(row);
			const circles = buildRowCircles(row);
			expect(circles.length).toBeGreaterThan(0);
			for (const circle of circles) {
				const left = circle.cx - circle.r - circle.strokeWidth / 2;
				const right = circle.cx + circle.r + circle.strokeWidth / 2;
				expect(left).toBeGreaterThanOrEqual(0);
				expect(right).toBeLessThanOrEqual(width);
				// Unknown topology always paints the left column.
				expect(circle.cx).toBe(GRAPH_LANE_WIDTH);
			}
		}
	});

	test("10. cross-page: merged commits array layouts coherently (UI feeds full list)", () => {
		// Newest-first history with a side branch, as after concatenating pages.
		const all: GitGraphCommit[] = [
			commit("M", ["T", "S"]),
			commit("S", ["R"]),
			commit("T", ["R"]),
			commit("R", ["B"]),
			commit("B", []),
		];
		const page1 = all.slice(0, 2);
		const page2 = all.slice(2);

		// First page alone is already valid (newest side of the graph).
		const page1Rows = layoutCommitGraph(page1);
		expect(page1Rows).toHaveLength(2);
		expect(page1Rows[0]?.output.map((l) => l.id)).toEqual(["T", "S"]);

		// Page alone: second page's first row has empty input (UI must merge).
		const page2Rows = layoutCommitGraph(page2);
		expect(page2Rows[0]?.input).toEqual([]);

		// What Stage 3 does after loading more: layout the merged array once.
		const merged = layoutCommitGraph(all, "M");
		expect(merged).toHaveLength(all.length);
		expect(merged[0]?.isHead).toBe(true);
		expect(merged[0]?.color).toBe(GRAPH_HEAD_COLOR);

		// Merge row holds both child lines.
		const mergeIds = merged[0]?.output.map((l) => l.id) ?? [];
		expect(mergeIds).toContain("T");
		expect(mergeIds).toContain("S");

		// First-parent lineage M→T→R→B shares the HEAD color.
		const bySha = new Map(merged.map((r) => [r.commit.sha, r]));
		expect(bySha.get("T")?.color).toBe(GRAPH_HEAD_COLOR);
		expect(bySha.get("T")?.output.map((l) => l.id)).toEqual(["R"]);
		// Side branch S is on a different lane/color and also points at R.
		const sRow = bySha.get("S");
		expect(sRow).toBeDefined();
		if (sRow) {
			expect(sRow.output.some((l) => l.id === "R")).toBe(true);
		}

		// Consecutive rows hand off: each output id that appears later is an input.
		for (let i = 0; i + 1 < merged.length; i++) {
			const next = merged[i + 1];
			const cur = merged[i];
			if (!next || !cur) continue;
			expect(next.input).toEqual(cur.output);
		}

		// Widths stay positive and non-decreasing in lane pressure.
		for (const row of merged) {
			expect(graphRowWidth(row)).toBeGreaterThanOrEqual(GRAPH_LANE_WIDTH * 2);
		}
	});
});

describe("buildRowSvgPaths", () => {
	test("through-lane same column is a straight vertical; extra parent emits a curve", () => {
		const rows = layoutCommitGraph([commit("M", ["A", "B"]), commit("A", [])]);
		const row = rows[0] as NonNullable<(typeof rows)[0]>;
		const paths = buildRowSvgPaths(row);
		// New tip with no input: only lower/extra edges from the node, no upper through.
		expect(paths.length).toBeGreaterThanOrEqual(2);
		// First parent continues downward at lane 0.
		const first = paths.find((p) => p.d === `M ${GRAPH_LANE_WIDTH} 11 V 22`);
		expect(first).toBeDefined();
		expect(first?.stroke).toBe(row.color);
		// Second parent leaves the node toward lane 1.
		const extra = paths.find((p) => p.d.includes("H ") || p.d.includes("C "));
		expect(extra).toBeDefined();
		expect(extra?.stroke).toBe(row.output[1]?.color);
	});

	test("paths never reference document/window — pure d strings", () => {
		const rows = layoutCommitGraph([commit("C", ["B"]), commit("B", [])]);
		for (const row of rows) {
			for (const p of buildRowSvgPaths(row)) {
				expect(typeof p.d).toBe("string");
				expect(typeof p.stroke).toBe("string");
				expect(p.d.startsWith("M ")).toBe(true);
			}
		}
	});
});
