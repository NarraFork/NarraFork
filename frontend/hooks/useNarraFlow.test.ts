import { describe, expect, test } from "bun:test";
import type { ProjectGraphResponse } from "../lib/api/projects";
import {
	applyDagreLayout,
	type GraphNode,
	type GraphRuntimeStatus,
	summarizeGraphRuntimeState,
} from "./useNarraFlow";

describe("summarizeGraphRuntimeState", () => {
	test("defaults to a healthy graph runtime when metadata is absent", () => {
		const result = summarizeGraphRuntimeState(undefined);

		expect(result).toEqual<GraphRuntimeStatus>({
			degraded: false,
			fallbackMessages: [],
		});
	});

	test("surfaces fallback diagnostics with reason and error detail", () => {
		const graph: ProjectGraphResponse = {
			nodes: [],
			edges: [],
			degraded: false,
			fallbacks: [
				{
					feature: "graph.gitMetadata",
					reason: "git_metadata_refresh_failed",
					error: "writeback failed",
				},
			],
		};

		expect(summarizeGraphRuntimeState(graph)).toEqual<GraphRuntimeStatus>({
			degraded: true,
			fallbackMessages: ["graph.gitMetadata: git_metadata_refresh_failed — writeback failed"],
		});
	});

	test("surfaces message-only fallback diagnostics", () => {
		const graph: ProjectGraphResponse = {
			nodes: [],
			edges: [],
			fallbacks: [{ feature: "graph.commitSync", message: "commit sync refresh failed" }],
		};

		expect(summarizeGraphRuntimeState(graph)).toMatchObject({
			degraded: true,
			fallbackMessages: ["graph.commitSync: commit sync refresh failed"],
		} satisfies Partial<GraphRuntimeStatus>);
	});
});

/**
 * Which nodes dagre is allowed to move.
 *
 * The rule is "has the server given this node a position on THIS canvas", expressed
 * as an explicit null check. It used to be "is the node away from the origin", and
 * that had two failure modes: a node the user dragged to 0,0 was re-laid-out on the
 * next load, and (with the old shared columns) a chapter carrying ruler's tick
 * offsets counted as hand-placed, so it was exempted from the auto-layout that would
 * otherwise have rescued it from far off-screen.
 */
describe("applyDagreLayout", () => {
	const node = (id: string, position: { x: number | null; y: number | null }): GraphNode => ({
		id,
		data: { label: id, status: "active" },
		position,
	});

	test("lays out nodes the server reports as unplaced", () => {
		const laidOut = applyDagreLayout([node("a", { x: null, y: null })], []);

		expect(laidOut).toHaveLength(1);
		expect(typeof laidOut[0].position.x).toBe("number");
		expect(typeof laidOut[0].position.y).toBe("number");
	});

	test("treats the origin as a real position, not as unplaced", () => {
		const placed = node("a", { x: 0, y: 0 });
		const laidOut = applyDagreLayout([placed], []);

		expect(laidOut[0].position).toEqual({ x: 0, y: 0 });
	});

	test("leaves hand-placed nodes exactly where they are", () => {
		const laidOut = applyDagreLayout(
			[node("a", { x: 1_234, y: -567 }), node("b", { x: null, y: null })],
			[],
		);

		const a = laidOut.find((n) => n.id === "a");
		expect(a?.position).toEqual({ x: 1_234, y: -567 });
		// The unplaced sibling still got coordinates.
		const b = laidOut.find((n) => n.id === "b");
		expect(typeof b?.position.x).toBe("number");
	});

	test("returns every node with concrete coordinates", () => {
		// React Flow cannot render a null position, so the layout pass is what
		// guarantees the nulls never escape this module.
		const laidOut = applyDagreLayout(
			[
				node("a", { x: null, y: null }),
				node("b", { x: 10, y: 20 }),
				node("c", { x: null, y: null }),
			],
			[{ id: "e1", source: "a", target: "c", type: "fork" }],
		);

		expect(laidOut).toHaveLength(3);
		for (const n of laidOut) {
			expect(Number.isFinite(n.position.x)).toBe(true);
			expect(Number.isFinite(n.position.y)).toBe(true);
		}
	});
});
