import { describe, expect, test } from "bun:test";
import {
	anchorMatches,
	indexAnchors,
	isNodeFile,
	isSourceFile,
	type KnowledgeNode,
	knowledgeGaps,
} from "../../shared/knowledge-tree";

function node(file: string, anchors: string[]): KnowledgeNode {
	return {
		file,
		id: file,
		title: "",
		summary: "",
		status: "draft",
		anchors,
		keywords: [],
		body: "",
	};
}

const nodes = [
	node("knowledge/a.md", ["server/a.ts#run", "shared/types/"]),
	node("knowledge/b.md", ["frontend/**/*.{ts,tsx}", "server/a.ts"]),
	node("knowledge/c.md", []),
];

describe("shared knowledge tree rules", () => {
	test("source files and node files", () => {
		expect(isSourceFile("server/x.ts")).toBe(true);
		expect(isSourceFile("frontend/x.tsx")).toBe(true);
		expect(isSourceFile("server/__tests__/x.ts")).toBe(false);
		expect(isSourceFile("server/x.test.ts")).toBe(false);
		expect(isSourceFile("scripts/x.ts")).toBe(false);
		expect(isSourceFile("server/x.md")).toBe(false);
		expect(isNodeFile("knowledge/x/index.md")).toBe(true);
		expect(isNodeFile("knowledge/README.md")).toBe(false);
		expect(isNodeFile("docs/x.md")).toBe(false);
	});

	test("the anchor index agrees with anchorMatches", () => {
		const index = indexAnchors(nodes);
		expect(index.patternAnchors).toBe(2);
		for (const path of ["server/a.ts", "shared/types/x.ts", "frontend/p/q.tsx", "server/b.ts"]) {
			const expected = nodes
				.map((n, i) => (n.anchors.some((a) => anchorMatches(a, path)) ? i : -1))
				.filter((i) => i >= 0);
			expect(index.nodesMatching(path).sort()).toEqual(expected);
		}
	});

	test("gaps: stale nodes unless touched, and added source files no node anchors", () => {
		expect(knowledgeGaps(nodes, ["server/a.ts", "frontend/x.ts"], [])).toEqual({
			nodes: [
				{ file: "knowledge/a.md", files: ["server/a.ts"] },
				{ file: "knowledge/b.md", files: ["frontend/x.ts", "server/a.ts"] },
			],
			uncovered: [],
		});
		expect(
			knowledgeGaps(
				nodes,
				["server/a.ts", "knowledge/a.md", "knowledge/b.md", "server/new.ts", "scripts/s.ts"],
				["server/new.ts", "scripts/s.ts", "shared/types/new.ts"],
			),
		).toEqual({ nodes: [], uncovered: ["server/new.ts"] });
	});
});
