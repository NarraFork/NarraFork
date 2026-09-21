/**
 * Git commit-graph layout (Stage 2).
 *
 * Pure geometry + swimlane assignment for the classic Git panel graph column.
 * Log order is newest-first (as `git log` returns). Layout follows the VS Code
 * scmHistory swimlane model: each row consumes the previous row's output lanes,
 * the current commit's lane is replaced by its first parent (or closed for a
 * root), and any additional parents open new lanes with palette colors.
 *
 * No DOM access — SVG path `d` strings and circle descriptors only, so the
 * module stays unit-testable and safe to import under linkedom.
 */

export const GRAPH_ROW_HEIGHT = 22;
export const GRAPH_LANE_WIDTH = 11;
export const GRAPH_CURVE_RADIUS = 5;
export const GRAPH_CIRCLE_RADIUS = 4;
export const GRAPH_CIRCLE_STROKE = 2;
export const GRAPH_MAX_LANES = 12;
export const GRAPH_PAGE_SIZE = 50;
export const GRAPH_COMMIT_CAP = 1000;

/** Five-color rotation for non-HEAD lanes, aligned with VS Code scm graph. */
export const GRAPH_COLORS: readonly string[] = [
	"#FFB000",
	"#DC267F",
	"#994F00",
	"#40B0A6",
	"#B66DFF",
];

export const GRAPH_HEAD_COLOR = "#3794ff";

export type GitGraphCommit = {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
	/** `undefined` = topology unknown; `[]` = root commit. */
	parents?: string[];
};

export type Swimlane = { id: string; color: string };

export type GraphRow = {
	commit: GitGraphCommit;
	input: Swimlane[];
	output: Swimlane[];
	laneIndex: number;
	color: string;
	isHead: boolean;
	topologyKnown: boolean;
};

export type RowPath = { d: string; stroke: string };

export type RowCircle = {
	cx: number;
	cy: number;
	r: number;
	strokeWidth: number;
	fill: string;
	hollow?: boolean;
};

function laneX(index: number): number {
	return GRAPH_LANE_WIDTH * (index + 1);
}

function paletteColor(cursor: number): string {
	const colors = GRAPH_COLORS;
	return colors[cursor % colors.length] ?? GRAPH_HEAD_COLOR;
}

function clampLane(index: number): number {
	if (!Number.isFinite(index) || index < 0) return 0;
	return Math.min(Math.floor(index), GRAPH_MAX_LANES - 1);
}

/**
 * Vertical S-curve when a through-lane changes column mid-row.
 * Shape per spec: V6 → arc → horizontal → arc → V H.
 */
function sCurvePath(x1: number, x2: number): string {
	const H = GRAPH_ROW_HEIGHT;
	const r = GRAPH_CURVE_RADIUS;
	if (x1 === x2) {
		return `M ${x1} 0 V ${H}`;
	}
	const cy = GRAPH_LANE_WIDTH;
	if (Math.abs(x2 - x1) < r * 2 + 1) {
		return `M ${x1} 0 C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${H}`;
	}
	const dir = x2 > x1 ? 1 : -1;
	const y0 = 6;
	const midY = y0 + r;
	const y2 = midY + r;
	const sweep1 = dir > 0 ? 1 : 0;
	const sweep2 = dir > 0 ? 0 : 1;
	return (
		`M ${x1} 0 V ${y0} ` +
		`A ${r} ${r} 0 0 ${sweep1} ${x1 + dir * r} ${midY} ` +
		`H ${x2 - dir * r} ` +
		`A ${r} ${r} 0 0 ${sweep2} ${x2} ${y2} ` +
		`V ${H}`
	);
}

/** Horizontal + arc from the node midpoint toward a parent lane (\"- \\\" shape). */
function nodeToLanePath(x1: number, x2: number): string {
	const H = GRAPH_ROW_HEIGHT;
	const r = GRAPH_CURVE_RADIUS;
	const cy = GRAPH_LANE_WIDTH;
	if (x1 === x2) {
		return `M ${x1} ${cy} V ${H}`;
	}
	if (Math.abs(x2 - x1) < r + 1) {
		return `M ${x1} ${cy} C ${x1} ${cy + (H - cy) / 2}, ${x2} ${cy + (H - cy) / 2}, ${x2} ${H}`;
	}
	const dir = x2 > x1 ? 1 : -1;
	const sweep = dir > 0 ? 1 : 0;
	return (
		`M ${x1} ${cy} H ${x2 - dir * r} ` + `A ${r} ${r} 0 0 ${sweep} ${x2} ${cy + r} ` + `V ${H}`
	);
}

/**
 * Column index for this row's node circle.
 *
 * Topology-unknown rows always paint a single left column: using
 * `input.length` would place the second and later dots past the SVG width
 * (previous output is one lane, current sha is not in it), which clips the
 * circle to a crescent — the bug seen in the dock panel.
 */
function circleIndexFor(row: Pick<GraphRow, "commit" | "input" | "topologyKnown">): number {
	if (!row.topologyKnown) return 0;
	const idx = row.input.findIndex((lane) => lane.id === row.commit.sha);
	return idx !== -1 ? idx : row.input.length;
}

/**
 * Assign swimlanes for a newest-first commit list.
 * `headSha` paints that commit (and its continuing first-parent lane) with
 * `GRAPH_HEAD_COLOR`; extra parents still rotate through `GRAPH_COLORS`.
 */
export function layoutCommitGraph(commits: GitGraphCommit[], headSha?: string | null): GraphRow[] {
	const rows: GraphRow[] = [];
	let previousOutput: Swimlane[] = [];
	let colorCursor = 0;

	for (const commit of commits) {
		const input: Swimlane[] = previousOutput.map((lane) => ({ ...lane }));
		const isHead = Boolean(headSha) && commit.sha === headSha;
		const parents = commit.parents;
		const topologyKnown = parents !== undefined;

		let color: string;
		const inherited = input.find((lane) => lane.id === commit.sha);
		if (isHead) {
			color = GRAPH_HEAD_COLOR;
		} else if (inherited) {
			color = inherited.color;
		} else {
			color = paletteColor(colorCursor);
			colorCursor += 1;
		}

		const output: Swimlane[] = [];
		let laneIndex = 0;

		if (!topologyKnown) {
			// Topology unknown: single-column dot, do not invent parent edges.
			output.push({ id: commit.sha, color });
			laneIndex = 0;
		} else {
			const parentList = parents ?? [];
			const firstParent = parentList[0];
			const inputIndex = input.findIndex((lane) => lane.id === commit.sha);
			const circleIndex = inputIndex !== -1 ? inputIndex : input.length;

			let firstPlaced = false;

			for (const lane of input) {
				if (lane.id === commit.sha) {
					// Self lane: continue to first parent (inherit color), or close if root.
					// If the first parent is another input lane it will pass through below —
					// pushing here as well would duplicate the id and fork two visual lanes.
					if (firstParent) {
						const alreadyOut = output.some((l) => l.id === firstParent);
						const willPassThrough = input.some((l) => l.id === firstParent && l.id !== commit.sha);
						if (!alreadyOut && !willPassThrough) {
							const laneColor = isHead ? GRAPH_HEAD_COLOR : lane.color;
							output.push({ id: firstParent, color: laneColor });
						}
						firstPlaced = true;
					}
					continue;
				}
				output.push({ ...lane });
			}

			// Branch tip not present in input: open a lane at the end for first parent.
			if (!firstPlaced && firstParent) {
				const existing = output.findIndex((l) => l.id === firstParent);
				if (existing === -1) {
					output.push({ id: firstParent, color });
				}
				firstPlaced = true;
			}

			// Additional parents (merge/octopus): new palette colors when absent.
			const extraStart = firstPlaced ? 1 : 0;
			for (let i = extraStart; i < parentList.length; i++) {
				const parentId = parentList[i];
				if (!parentId) continue;
				if (output.some((l) => l.id === parentId)) continue;
				output.push({ id: parentId, color: paletteColor(colorCursor) });
				colorCursor += 1;
			}

			if (output.length > GRAPH_MAX_LANES) {
				output.length = GRAPH_MAX_LANES;
			}

			if (firstParent) {
				const parentLane = output.findIndex((l) => l.id === firstParent);
				if (parentLane !== -1) {
					laneIndex = parentLane;
				} else {
					laneIndex = clampLane(circleIndex);
				}
			} else {
				// Root: circle stays at the self column; no first-parent lane.
				laneIndex = clampLane(circleIndex);
			}

			if (output.length === 0) {
				laneIndex = 0;
			} else {
				laneIndex = clampLane(laneIndex);
			}
		}

		rows.push({
			commit,
			input,
			output,
			laneIndex,
			color,
			isHead,
			topologyKnown,
		});
		previousOutput = output;
	}

	return rows;
}

/**
 * SVG path segments for one row: through-lanes, node half-edges, extra parents.
 * Returns stroke-colored `d` strings only — callers own the `<svg>` element.
 */
export function buildRowSvgPaths(row: GraphRow): RowPath[] {
	const paths: RowPath[] = [];
	if (!row.topologyKnown) {
		return paths;
	}

	const { input, output, commit, color, isHead } = row;
	const parents = commit.parents ?? [];
	const H = GRAPH_ROW_HEIGHT;
	const cy = GRAPH_LANE_WIDTH;
	const circleIndex = circleIndexFor(row);
	const firstParent = parents[0];

	// Through-lanes that are not the current commit.
	for (let i = 0; i < input.length; i++) {
		const lane = input[i];
		if (lane.id === commit.sha) continue;
		const outIdx = output.findIndex((l) => l.id === lane.id);
		if (outIdx === -1) continue;
		const x1 = laneX(i);
		const x2 = laneX(outIdx);
		if (x1 === x2) {
			paths.push({ d: `M ${x1} 0 V ${H}`, stroke: lane.color });
		} else {
			paths.push({ d: sCurvePath(x1, x2), stroke: lane.color });
		}
	}

	// Node upper half: only when an input lane was feeding this commit.
	if (inputIndexExists(row) && circleIndex < GRAPH_MAX_LANES) {
		paths.push({ d: `M ${laneX(circleIndex)} 0 V ${cy}`, stroke: color });
	}

	// Node lower half toward first parent (not for roots).
	if (firstParent && circleIndex < GRAPH_MAX_LANES) {
		const parentLane = output.findIndex((l) => l.id === firstParent);
		if (parentLane !== -1) {
			const stroke = isHead ? GRAPH_HEAD_COLOR : color;
			paths.push({
				d: nodeToLanePath(laneX(circleIndex), laneX(parentLane)),
				stroke,
			});
		}
	}

	// Additional parent edges from the node midpoint.
	const extraStart = firstParent ? 1 : 0;
	for (let i = extraStart; i < parents.length; i++) {
		const parentId = parents[i];
		if (!parentId) continue;
		const parentLane = output.findIndex((l) => l.id === parentId);
		if (parentLane === -1 || circleIndex >= GRAPH_MAX_LANES) continue;
		const stroke = output[parentLane]?.color ?? paletteColor(0);
		paths.push({
			d: nodeToLanePath(laneX(circleIndex), laneX(parentLane)),
			stroke,
		});
	}

	return paths;
}

function inputIndexExists(row: Pick<GraphRow, "commit" | "input">): boolean {
	return row.input.some((lane) => lane.id === row.commit.sha);
}

/**
 * Circle descriptors for the commit node.
 * HEAD: filled outer + hollow inner; merge (parents>1): double ring; else solid.
 */
export function buildRowCircles(row: GraphRow): RowCircle[] {
	const cx = laneX(circleIndexFor(row));
	const cy = GRAPH_LANE_WIDTH;
	const { isHead, color, commit } = row;
	const parents = commit.parents ?? [];

	if (isHead) {
		return [
			{
				cx,
				cy,
				r: 7,
				strokeWidth: GRAPH_CIRCLE_STROKE,
				fill: GRAPH_HEAD_COLOR,
			},
			{
				cx,
				cy,
				r: 2,
				strokeWidth: 4,
				fill: "none",
				hollow: true,
			},
		];
	}

	if (parents.length > 1) {
		return [
			{
				cx,
				cy,
				r: 6,
				strokeWidth: GRAPH_CIRCLE_STROKE,
				fill: color,
			},
			{
				cx,
				cy,
				r: 3,
				strokeWidth: GRAPH_CIRCLE_STROKE,
				fill: "none",
				hollow: true,
			},
		];
	}

	return [
		{
			cx,
			cy,
			r: 5,
			strokeWidth: GRAPH_CIRCLE_STROKE,
			fill: color,
		},
	];
}

/**
 * Width needed to paint this row's swimlanes.
 *
 * Must cover the node column even when the circle sits at `input.length`
 * (tip not yet in any lane) and leave stroke bleed on both edges so filled
 * nodes are not clipped by the SVG viewport.
 */
export function graphRowWidth(row: GraphRow): number {
	const circleCol = circleIndexFor(row);
	const lanes = Math.max(row.input.length, row.output.length, circleCol + 1, 1);
	// +1 empty column (VS Code margin) + stroke half-width on each side.
	return GRAPH_LANE_WIDTH * (lanes + 1) + GRAPH_CIRCLE_STROKE;
}
