/**
 * Destructuring declarations in the outline.
 *
 * The bug these lock down: the `name` field used to be the destructuring pattern's
 * raw source text. A 27-field hook destructure therefore produced one node whose
 * "name" was 30 lines of source with embedded newlines and tabs — unmatchable by
 * `extract`/`locate`, and it polluted the symbolPath of everything nested below.
 */
import { describe, expect, test } from "bun:test";
import type { OutlineNode, StructDocument } from "../provider";
import { clearOutlineCache, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTypescript = ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

const SOURCE = `export function Component() {
	const [count, setCount] = useState(0);
	const { alpha, beta } = useSmall();
	const {
		one,
		two,
		three,
		four,
		five,
		six,
	} = useBig(argument);
	const { renamed: localName } = useRenaming();
	const { withDefault = 7 } = useDefaults();
	const { kept, ...rest } = useRest();
	const plain = compute();
	return null;
}
`;

function doc(text = SOURCE): StructDocument {
	return { filePath: "/tmp/bindings.ts", languageId: "typescript", text };
}

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

async function outlineOf(text = SOURCE): Promise<OutlineNode[]> {
	clearOutlineCache();
	return flatten(await treeSitterProvider.outline(doc(text)));
}

describeWithGrammar("destructuring declarations", () => {
	test("no outline name ever contains a newline or tab", async () => {
		const nodes = await outlineOf();
		const offenders = nodes.filter((n) => /[\n\t]/.test(n.name));
		expect(offenders.map((n) => `L${n.startLine}`)).toEqual([]);
	});

	test("a small object pattern lists its bindings inline", async () => {
		const nodes = await outlineOf();
		const node = nodes.find((n) => n.bindings?.includes("alpha"));
		expect(node?.name).toBe("{ alpha, beta }");
		expect(node?.bindings).toEqual(["alpha", "beta"]);
	});

	test("an array pattern uses bracket notation", async () => {
		const nodes = await outlineOf();
		const node = nodes.find((n) => n.bindings?.includes("setCount"));
		expect(node?.name).toBe("[ count, setCount ]");
	});

	test("a large pattern collapses to a count but keeps every binding searchable", async () => {
		const nodes = await outlineOf();
		const node = nodes.find((n) => n.bindings?.includes("one"));
		// Collapsed label: readable in a dense outline.
		expect(node?.name).toBe("{ one, two, three, four, …+2 }");
		// Full list retained: a search for `six` must still reach this line.
		expect(node?.bindings).toEqual(["one", "two", "three", "four", "five", "six"]);
	});

	test("the initializer says where the bindings came from", async () => {
		const nodes = await outlineOf();
		expect(nodes.find((n) => n.bindings?.includes("one"))?.initializer).toBe("useBig(…)");
		expect(nodes.find((n) => n.name === "plain")?.initializer).toBe("compute(…)");
	});

	test("a renamed binding reports the local name, not the source key", async () => {
		const nodes = await outlineOf();
		// `{ renamed: localName }` binds localName; that is what a reader greps for.
		const node = nodes.find((n) => n.initializer === "useRenaming(…)");
		expect(node?.bindings).toEqual(["localName"]);
	});

	test("defaults and rest elements are reported as their bound names", async () => {
		const nodes = await outlineOf();
		expect(nodes.find((n) => n.initializer === "useDefaults(…)")?.bindings).toEqual([
			"withDefault",
		]);
		expect(nodes.find((n) => n.initializer === "useRest(…)")?.bindings).toEqual([
			"kept",
			"...rest",
		]);
	});

	test("nested patterns are flattened into leaf bindings", async () => {
		const nodes = await outlineOf("const { outer: { inner, deeper } } = useNested();\n");
		const node = nodes.find((n) => n.initializer === "useNested(…)");
		expect(node?.bindings).toEqual(["inner", "deeper"]);
	});

	test("a plain identifier declaration has no bindings field", async () => {
		const nodes = await outlineOf();
		const plain = nodes.find((n) => n.name === "plain");
		expect(plain).toBeDefined();
		expect(plain?.bindings).toBeUndefined();
	});

	test("symbol paths stay dot-addressable and free of pattern punctuation noise", async () => {
		clearOutlineCache();
		const located = await treeSitterProvider.locate(doc(), { symbol: "plain" });
		expect(located).toHaveLength(1);
		expect(located[0]?.symbolPath).toBe("Component.plain");
	});
});
