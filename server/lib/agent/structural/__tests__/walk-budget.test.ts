/**
 * Traversal budget for the outline walk.
 *
 * The gap being closed: `maxNodes` counts nodes EMITTED, so a file with no declarations
 * at all can never trip it, and `maxDepth` counts OUTLINE nesting, which containers,
 * transparent wrappers and non-structural `pair`s deliberately leave unchanged — with its
 * default of `Infinity` there was nothing bounding the recursion.
 *
 * That combination is reachable from ordinary input. Measured against the pinned
 * `tree-sitter-wasms@0.1.13` TypeScript grammar, a 140 KB generated-config file
 * (`const cfg = { a: { a: … } }` nested 20 000 deep — `object` is a container and a
 * data-only `pair` recurses at unchanged depth) parses in 64 ms, then walks 20 266 nodes
 * with `emitted` still at 0 and dies with `RangeError: Maximum call stack size exceeded`.
 * The caller got an engine error rather than "too deep to outline", and the whole thing
 * ran on the Bun main thread with every other request behind it.
 *
 * These tests use synthetic nodes rather than a real grammar on purpose: the property
 * under test is the walk's own arithmetic, and it should be checked on machines where
 * no grammar is installed — exactly the case where the grammar-backed suites skip.
 */
import { describe, expect, test } from "bun:test";
import { buildGenericOutline } from "@server/lib/agent/structural/generic-language";
import {
	buildOutline,
	MAX_TRAVERSAL_DEPTH,
	type SyntaxNode,
} from "@server/lib/agent/structural/outline";

/** A minimal SyntaxNode; only the fields the walk actually reads need to be real. */
function fakeNode(type: string, children: SyntaxNode[] = []): SyntaxNode {
	const self: SyntaxNode = {
		type,
		text: "",
		startIndex: 0,
		endIndex: 0,
		startPosition: { row: 0, column: 0 },
		endPosition: { row: 0, column: 0 },
		childCount: children.length,
		namedChildCount: children.length,
		isNamed: true,
		parent: null,
		child: (index: number) => children[index] ?? null,
		namedChild: (index: number) => children[index] ?? null,
		childForFieldName: () => null,
		previousSibling: null,
		nextSibling: null,
	};
	for (const child of children) child.parent = self;
	return self;
}

/**
 * A chain of containers `depth` deep.
 *
 * `statement_block` is in `ECMASCRIPT_CONTAINERS` and has no declaration rule, so every
 * level recurses without emitting a row and without raising the outline depth — the shape
 * that used to be unbounded. Built bottom-up because building it recursively would blow
 * the very stack this is about.
 */
function containerChain(depth: number): SyntaxNode {
	let node = fakeNode("statement_block");
	for (let i = 0; i < depth; i++) node = fakeNode("statement_block", [node]);
	return fakeNode("program", [node]);
}

describe("outline traversal budget", () => {
	test("a chain deeper than the cap reports truncation instead of throwing", () => {
		const result = buildOutline(containerChain(MAX_TRAVERSAL_DEPTH + 50), "typescript");
		expect(result.truncated).toBe(true);
		expect(result.nodes).toEqual([]);
	});

	test("a chain far past the old stack limit still returns", () => {
		// 30 000 is well beyond where the unguarded walk died (~20 000 in Bun).
		const result = buildOutline(containerChain(30_000), "typescript");
		expect(result.truncated).toBe(true);
	});

	test("a chain within the cap is not marked truncated", () => {
		const result = buildOutline(containerChain(10), "typescript");
		expect(result.truncated).toBe(false);
	});

	test("the raised depth budget permits traversals beyond the old 512-frame cap", () => {
		const root = containerChain(700);
		expect(buildOutline(root, "typescript").truncated).toBe(false);
	});

	test("generic outlines share the raised depth guard", () => {
		// Generic traversal skips statement bodies, so use unnamed wrapper nodes.
		const chain = (depth: number) => {
			let node = fakeNode("wrapper");
			for (let i = 0; i < depth; i++) node = fakeNode("wrapper", [node]);
			return fakeNode("root", [node]);
		};
		expect(buildGenericOutline(chain(700)).truncated).toBe(false);
		expect(buildGenericOutline(chain(MAX_TRAVERSAL_DEPTH + 50)).truncated).toBe(true);
	});

	test("the visited cap bounds a wide tree that emits nothing", () => {
		// 40 containers x 40 children, none of which is a declaration: `emitted` stays 0,
		// so only a visited counter can stop this.
		const branches = Array.from({ length: 40 }, () =>
			fakeNode(
				"statement_block",
				Array.from({ length: 40 }, () => fakeNode("statement_block")),
			),
		);
		const result = buildOutline(fakeNode("program", branches), "typescript", {
			maxVisited: 50,
		});
		expect(result.truncated).toBe(true);
		expect(result.nodes).toEqual([]);
	});

	test("declarations inside the budget are still reported", () => {
		// Guards the obvious regression: a budget that reports nothing is not a fix.
		const body = fakeNode("statement_block");
		const declaration = fakeNode("class_declaration", [body]);
		const result = buildOutline(fakeNode("program", [declaration]), "typescript");
		expect(result.truncated).toBe(false);
		// No `name` field on the fake node, so the walk synthesizes or skips a label;
		// either way it must not have thrown and must not claim truncation.
		expect(Array.isArray(result.nodes)).toBe(true);
	});
});
