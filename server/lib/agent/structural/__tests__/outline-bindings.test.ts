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

/**
 * `collectImports` recorded each import's module and line but never its NAMES, even
 * though the interface declared the field. Every alias was therefore invisible, which is
 * what made cross-file usage tracing miss `import { x as y }` entirely.
 */
describeWithGrammar("import name extraction", () => {
	async function importsOf(text: string) {
		clearOutlineCache();
		// `imports` is optional on the provider contract; the tree-sitter one implements it,
		// and a regression that dropped it should fail loudly here rather than skip.
		const read = treeSitterProvider.imports;
		if (!read) throw new Error("tree-sitter provider no longer implements imports()");
		const info = await read.call(treeSitterProvider, {
			filePath: "/tmp/imports.ts",
			languageId: "typescript",
			text,
		});
		return info.imports;
	}

	test("records the local name, and the original when renamed", async () => {
		const imports = await importsOf(
			'import { a, b as c } from "./m";\nimport def from "./d";\nimport * as ns from "./n";\n',
		);
		const byModule = new Map(imports.map((i) => [i.module, i.names ?? []]));
		expect(byModule.get("./m")).toEqual([{ local: "a" }, { local: "c", original: "b" }]);
		// A default and a namespace import each bind exactly one name.
		expect(byModule.get("./d")).toEqual([{ local: "def" }]);
		expect(byModule.get("./n")).toEqual([{ local: "ns" }]);
	});

	test("a type-only import binds a name like any other", async () => {
		const imports = await importsOf('import type { T as U } from "./t";\n');
		expect(imports[0]?.names).toEqual([{ local: "U", original: "T" }]);
	});

	test("the module specifier is never reported as a bound name", async () => {
		// It is a string, not an identifier; listing it would make `./m` look imported.
		const imports = await importsOf('import { a } from "./m";\n');
		expect(imports[0]?.names?.map((n) => n.local)).toEqual(["a"]);
	});
});

/**
 * Re-exports were invisible to the provider: neither an import statement nor an outline
 * declaration, so a symbol reached through a barrel could not be tied back to the module
 * declaring it. That made the normal way a codebase imports things — via `index.ts` —
 * report every usage as unverifiable.
 */
describeWithGrammar("re-export collection", () => {
	async function exportsOf(text: string) {
		clearOutlineCache();
		const read = treeSitterProvider.imports;
		if (!read) throw new Error("tree-sitter provider no longer implements imports()");
		const info = await read.call(treeSitterProvider, {
			filePath: "/tmp/barrel.ts",
			languageId: "typescript",
			text,
		});
		return info.exports;
	}

	test("a named re-export records the name and its source module", async () => {
		const found = await exportsOf('export { target } from "./def";\n');
		expect(found).toEqual([{ name: "target", kind: "unknown", line: 1, from: "./def" }]);
	});

	test("a renamed re-export records the name as re-exported", async () => {
		// `export { a as b }` publishes `b`; a consumer imports that, not `a`.
		const found = await exportsOf('export { a as b } from "./c";\n');
		expect(found[0]).toMatchObject({ name: "b", from: "./c" });
	});

	test("a star re-export says everything, rather than inventing a name list", async () => {
		// Which names this covers cannot be known without reading the other module.
		const found = await exportsOf('export * from "./other";\n');
		expect(found).toEqual([{ name: "*", kind: "unknown", line: 1, from: "./other" }]);
	});

	test("a plain export is a declaration, not a pass-through", async () => {
		// No source module, so it must not gain a `from` — that field is what distinguishes
		// "this file re-exports it" from "this file declares it".
		const found = await exportsOf("export function own() {\n\treturn 1;\n}\n");
		expect(found).toHaveLength(1);
		expect(found[0]?.from).toBeUndefined();
		expect(found[0]?.kind).toBe("function");
	});

	test("declarations and re-exports coexist in one file", async () => {
		const found = await exportsOf(
			'export { a } from "./m";\nexport const own = 1;\nexport * from "./n";\n',
		);
		expect(found.filter((e) => e.from !== undefined)).toHaveLength(2);
		expect(found.filter((e) => e.from === undefined)).toHaveLength(1);
	});

	test("a re-export does not appear as an import", async () => {
		// It binds no local name, so listing it as an import would claim this file uses the
		// symbol when it only forwards it.
		clearOutlineCache();
		const read = treeSitterProvider.imports;
		if (!read) throw new Error("imports() missing");
		const info = await read.call(treeSitterProvider, {
			filePath: "/tmp/barrel.ts",
			languageId: "typescript",
			text: 'export { a } from "./m";\n',
		});
		expect(info.imports).toHaveLength(0);
	});
});
