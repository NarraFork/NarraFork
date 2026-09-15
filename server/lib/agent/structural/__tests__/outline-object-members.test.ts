/**
 * Object-literal members in the outline.
 *
 * The blind spot these close: `object` was not a container type, so
 * `export default { handler() {…} }` reported the object and nothing inside it, while
 * the walk fell through to the method BODIES and reported their locals as if they were
 * siblings of the object. Running outline on tree-sitter-provider.ts showed
 * `withParsedTree.lease` but none of `supports` / `outline` / `locate` — and that file
 * is mostly one object literal.
 *
 * Whole categories of module are written this way: Hono handler maps, Pinia stores,
 * Vue options components, and the provider objects in this very codebase.
 */
import { describe, expect, test } from "bun:test";
import type { OutlineNode, StructDocument } from "../provider";
import { clearOutlineCache, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTypescript = ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

function flatten(nodes: readonly OutlineNode[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	const walk = (list: readonly OutlineNode[]): void => {
		for (const node of list) {
			out.push(node);
			if (node.children) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

async function outlineOf(text: string): Promise<OutlineNode[]> {
	clearOutlineCache();
	const doc: StructDocument = { filePath: "/tmp/obj.ts", languageId: "typescript", text };
	return treeSitterProvider.outline(doc) as Promise<OutlineNode[]>;
}

describeWithGrammar("object literal members", () => {
	test("shorthand methods are reported as members of the object", async () => {
		const nodes = await outlineOf(`export const provider = {
	id: "tree-sitter",
	async supports(doc: Doc): Promise<string> {
		const local = 1;
		return String(local);
	},
	outline(doc: Doc) {
		return [];
	},
};
`);
		const provider = nodes.find((n) => n.name === "provider");
		expect(provider).toBeDefined();
		const memberNames = provider?.children?.map((c) => c.name) ?? [];
		expect(memberNames).toContain("supports");
		expect(memberNames).toContain("outline");
		expect(memberNames).toContain("id");
	});

	test("a method's locals nest under the method, not beside the object", async () => {
		const nodes = await outlineOf(`export const obj = {
	run() {
		const leaked = 1;
		return leaked;
	},
};
`);
		// The bug: `leaked` used to surface as a sibling of `obj`, reading as a
		// module-level declaration that does not exist.
		expect(nodes.map((n) => n.name)).toEqual(["obj"]);
		const run = nodes[0]?.children?.find((c) => c.name === "run");
		expect(run?.children?.map((c) => c.name)).toEqual(["leaked"]);
	});

	test("a function-valued key reads as a method, a data key as a property", async () => {
		const nodes = flatten(
			await outlineOf(`const config = {
	handler: (req: Request) => respond(req),
	fallback: function named() {},
	retries: 3,
	label: "x",
};
`),
		);
		expect(nodes.find((n) => n.name === "handler")?.kind).toBe("method");
		expect(nodes.find((n) => n.name === "fallback")?.kind).toBe("method");
		expect(nodes.find((n) => n.name === "retries")?.kind).toBe("property");
		expect(nodes.find((n) => n.name === "label")?.kind).toBe("property");
	});

	test("a function-valued key shows the value's signature, not the pair's", async () => {
		const nodes = flatten(
			await outlineOf("const c = { handler: (req: Request): Response => respond(req) };\n"),
		);
		const handler = nodes.find((n) => n.name === "handler");
		expect(handler?.signature).toContain("req: Request");
	});

	test("nested object literals nest in the outline", async () => {
		const nodes = await outlineOf(`const routes = {
	api: {
		health() {},
	},
};
`);
		const api = nodes[0]?.children?.find((c) => c.name === "api");
		expect(api).toBeDefined();
		expect(api?.children?.map((c) => c.name)).toEqual(["health"]);
	});

	test("regression: the provider object's own methods are now visible", async () => {
		const text = await Bun.file("server/lib/agent/structural/tree-sitter-provider.ts").text();
		clearOutlineCache();
		const nodes = flatten(
			(await treeSitterProvider.outline({
				filePath: "server/lib/agent/structural/tree-sitter-provider.ts",
				languageId: "typescript",
				text,
			})) as OutlineNode[],
		);
		const names = nodes.map((n) => n.name);
		// These are the provider contract methods; before the fix none appeared.
		for (const method of ["supports", "outline", "locate", "enclosing", "imports"]) {
			expect(names).toContain(method);
		}
		// And the locals that used to masquerade as top-level entries are now nested.
		const lease = nodes.find((n) => n.name === "lease");
		expect(lease?.depth ?? 0).toBeGreaterThan(0);
	});
});
