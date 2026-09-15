/**
 * Parse-tree lifecycle tests.
 *
 * A `Tree` owns wasm-heap memory that JS GC cannot reclaim, so it must be freed
 * explicitly. What makes that easy to get wrong — and what these tests lock down —
 * is the failure mode: after `delete()`, retained nodes do NOT throw. They silently
 * report type `ERROR` and garbage text. So a leaked node reference corrupts results
 * instead of failing loudly, and no amount of downstream assertion would notice.
 *
 * The invariant being protected: everything the provider returns or caches is plain
 * data (strings/numbers), extracted before the tree is freed.
 */
import { describe, expect, test } from "bun:test";
import { acquireParser } from "../parser-pool";
import type { StructDocument } from "../provider";
import { clearOutlineCache, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTypescript = ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

const SOURCE = `import { A } from "./a";

export class Service {
	private state = 0;

	run(input: string): number {
		return this.state;
	}
}

export function helper(x: number): number {
	return x * 2;
}
`;

function doc(): StructDocument {
	return { filePath: "/tmp/lifecycle.ts", languageId: "typescript", text: SOURCE };
}

describeWithGrammar("parse tree lifecycle", () => {
	test("a freed tree's nodes degrade silently rather than throwing", async () => {
		const lease = await acquireParser("typescript");
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;

		const tree = lease.parser.parse(SOURCE);
		expect(tree).not.toBeNull();
		if (!tree) return;

		const root = tree.rootNode;
		const child = root.child(0);
		expect(child?.type).toBe("import_statement");

		tree.delete();

		// THIS is why extraction must finish before the free: the node still answers,
		// but with a lie. If this assertion ever starts throwing instead, the upstream
		// library became fail-loud and the strict ordering could be relaxed.
		expect(child?.type).toBe("ERROR");
	});

	test("outline results survive the tree being freed", async () => {
		clearOutlineCache();
		const nodes = await treeSitterProvider.outline(doc());
		expect(nodes.length).toBeGreaterThan(0);

		// The tree is already freed by the time outline returns. If any field were
		// lazily read off a live node, these would now be ERROR/garbage.
		const service = nodes.find((n) => n.name === "Service");
		expect(service?.kind).toBe("class");
		expect(service?.startLine).toBe(3);
		expect(service?.children?.some((c) => c.name === "run")).toBe(true);
	});

	test("cached outline nodes contain only plain data, never live nodes", async () => {
		clearOutlineCache();
		// Populate the cache, then read it back through a second call.
		await treeSitterProvider.outline(doc());
		const cached = await treeSitterProvider.outline(doc());

		const violations: string[] = [];
		const check = (value: unknown, path: string, depth = 0): void => {
			if (depth > 6 || value == null) return;
			if (Array.isArray(value)) {
				value.forEach((item, i) => {
					check(item, `${path}[${i}]`, depth + 1);
				});
				return;
			}
			if (typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			// A SyntaxNode is recognizable by these members; a plain outline node has none.
			for (const marker of ["startIndex", "walk", "childForFieldName", "tree", "typeId"]) {
				if (typeof record[marker] === "function") {
					violations.push(`${path}.${marker} is a live-node method`);
				}
			}
			for (const [key, child] of Object.entries(record)) {
				check(child, `${path}.${key}`, depth + 1);
			}
		};
		check(cached, "outline");

		expect(violations).toEqual([]);
	});

	test("repeated parses of the same content reuse the cache instead of reparsing", async () => {
		clearOutlineCache();
		const first = await treeSitterProvider.outline(doc());
		const second = await treeSitterProvider.outline(doc());
		// Same array identity proves the second call never reached the parser — and
		// therefore never allocated (or needed to free) a second tree.
		expect(second).toBe(first);
	});

	test("imports also completes before its tree is freed", async () => {
		clearOutlineCache();
		// `imports` is an optional provider method; the tree-sitter provider implements it.
		expect(treeSitterProvider.imports).toBeDefined();
		const info = await treeSitterProvider.imports?.(doc());
		expect(info?.imports.map((i) => i.module)).toContain("./a");
		expect(info?.exports.map((e) => e.name)).toContain("Service");
	});

	test("many sequential parses all succeed, so freeing never invalidates the parser", async () => {
		clearOutlineCache();
		for (let i = 0; i < 12; i++) {
			// Distinct text each round defeats the cache and forces a real parse+free.
			const nodes = await treeSitterProvider.outline({
				filePath: "/tmp/lifecycle.ts",
				languageId: "typescript",
				text: `${SOURCE}\n// round ${i}\n`,
			});
			expect(nodes.some((n) => n.name === "helper")).toBe(true);
		}
	});
});
