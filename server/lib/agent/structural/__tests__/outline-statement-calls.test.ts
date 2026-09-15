/**
 * Statement-level bare calls in the outline.
 *
 * The gap these close: `useEffect(() => {...}, [])` is an expression statement, not a
 * declaration, so a declaration-only outline omitted it. For a React component, a test
 * file, or a route module, those calls ARE the structure — a 3479-line component
 * produced 316 outline entries and not one of its 14 effects.
 *
 * The selectivity rule is what keeps this from becoming noise: only calls that take a
 * function argument qualify.
 */
import { describe, expect, test } from "bun:test";
import type { OutlineNode, StructDocument } from "../provider";
import { clearOutlineCache, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTypescript = ensureGrammarFixture("typescript");
const hasTsx = ensureGrammarFixture("tsx");
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

async function outlineOf(text: string, languageId = "typescript"): Promise<OutlineNode[]> {
	clearOutlineCache();
	const doc: StructDocument = { filePath: `/tmp/calls.${languageId}`, languageId, text };
	return flatten(await treeSitterProvider.outline(doc));
}

describeWithGrammar("statement-level calls", () => {
	test("effects appear with their dependency array", async () => {
		const nodes = await outlineOf(`export function C() {
	useEffect(() => {
		subscribe();
	}, [narratorId, enabled]);
	return null;
}
`);
		const effect = nodes.find((n) => n.name === "useEffect");
		expect(effect).toBeDefined();
		expect(effect?.kind).toBe("call");
		expect(effect?.signature).toBe("[narratorId, enabled]");
		expect(effect?.startLine).toBe(2);
		expect(effect?.endLine).toBe(4);
	});

	test("an empty dependency array is still reported", async () => {
		const nodes = await outlineOf("useEffect(() => { once(); }, []);\n");
		expect(nodes.find((n) => n.name === "useEffect")?.signature).toBe("[]");
	});

	test("an ordinary side-effect call is NOT included", async () => {
		const nodes = await outlineOf(`export function C() {
	console.log("hello");
	obj.method(1);
	doThing();
	return null;
}
`);
		// No callback argument → not structural → stays out of the outline.
		const calls = nodes.filter((n) => n.kind === "call");
		expect(calls).toEqual([]);
	});

	test("test suites nest, so a spec file's skeleton is visible", async () => {
		const nodes = await outlineOf(`describe("payment flow", () => {
	test("charges once", () => {
		expect(1).toBe(1);
	});
	test("retries on failure", () => {});
});
`);
		const suite = nodes.find((n) => n.name === "describe");
		expect(suite?.signature).toBe('"payment flow"');
		const tests = nodes.filter((n) => n.name === "test");
		expect(tests).toHaveLength(2);
		expect(tests[0]?.signature).toBe('"charges once"');
		// Nested under the suite, not floating at top level.
		expect(suite?.depth).toBe(0);
		expect(tests[0]?.depth).toBe(1);
		expect(suite?.children?.map((c) => c.name)).toEqual(["test", "test"]);
	});

	test("route registrations with a handler are captured", async () => {
		const nodes = await outlineOf(`app.get("/health", (c) => c.json({ ok: true }));
bus.on("event", () => handle());
`);
		const names = nodes.filter((n) => n.kind === "call").map((n) => n.name);
		expect(names).toContain("app.get");
		expect(names).toContain("bus.on");
	});

	test("declarations and calls coexist in source order", async () => {
		const nodes = await outlineOf(`export function C() {
	const a = useState(0);
	useEffect(() => {}, [a]);
	const b = 2;
	return null;
}
`);
		const inner = nodes.filter((n) => n.depth === 1).map((n) => n.name);
		expect(inner).toEqual(["a", "useEffect", "b"]);
	});

	test("a hook assigned to a variable is a declaration, not a call entry", async () => {
		const nodes = await outlineOf("const cb = useCallback(() => {}, []);\n");
		// It already had a name and a home in the outline; adding a second `call` row
		// for the same line would double-count it.
		expect(nodes.filter((n) => n.kind === "call")).toEqual([]);
		expect(nodes.find((n) => n.name === "cb")?.initializer).toBe("useCallback(…)");
	});
});

const describeWithTsx = hasTsx ? describe : describe.skip;

describeWithTsx("regression: the real NarratorPanel component", () => {
	test("its 14 effects are no longer invisible", async () => {
		const text = await Bun.file("frontend/components/narrator/NarratorPanel.tsx").text();
		clearOutlineCache();
		const nodes = flatten(
			await treeSitterProvider.outline({
				filePath: "frontend/components/narrator/NarratorPanel.tsx",
				languageId: "tsx",
				text,
			}),
		);
		const effects = nodes.filter((n) => n.name === "useEffect");
		// The file contains 14 statement-level useEffect calls (a 15th mention is the
		// import). Before this change the outline reported zero.
		expect(effects.length).toBe(14);
		// Every one should carry a dependency array.
		expect(effects.every((e) => typeof e.signature === "string")).toBe(true);
	});

	test("no outline entry has a multi-line name", async () => {
		const text = await Bun.file("frontend/components/narrator/NarratorPanel.tsx").text();
		clearOutlineCache();
		const nodes = flatten(
			await treeSitterProvider.outline({
				filePath: "frontend/components/narrator/NarratorPanel.tsx",
				languageId: "tsx",
				text,
			}),
		);
		expect(nodes.filter((n) => /[\n\t]/.test(n.name)).map((n) => n.startLine)).toEqual([]);
	});

	test("the 27-field websocket destructure collapses and stays searchable", async () => {
		const text = await Bun.file("frontend/components/narrator/NarratorPanel.tsx").text();
		clearOutlineCache();
		const nodes = flatten(
			await treeSitterProvider.outline({
				filePath: "frontend/components/narrator/NarratorPanel.tsx",
				languageId: "tsx",
				text,
			}),
		);
		const node = nodes.find((n) => n.bindings?.includes("viewers"));
		expect(node).toBeDefined();
		// Was 30 lines of raw source; now one line naming the first few plus a count.
		expect(node?.name).not.toMatch(/[\n\t]/);
		expect(node?.name).toMatch(/…\+\d+ \}$/);
		expect(node?.bindings?.length).toBeGreaterThan(20);
		// `viewers` is only reachable through the retained binding list.
		const located = await treeSitterProvider.locate(
			{
				filePath: "frontend/components/narrator/NarratorPanel.tsx",
				languageId: "tsx",
				text,
			},
			{ symbol: "viewers" },
		);
		expect(located.length).toBeGreaterThan(0);
	});
});
