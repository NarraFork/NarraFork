/**
 * Element (JSX) skeleton tests.
 *
 * The gap being closed: 851 of NarratorPanel.tsx's 3479 lines are one `return`, and the
 * outline reported nothing for them.
 */
import { describe, expect, test } from "bun:test";
import type { ElementNode, StructDocument } from "../provider";
import { clearOutlineCache, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTsx = ensureGrammarFixture("tsx");
const describeWithTsx = hasTsx ? describe : describe.skip;

async function treeOf(text: string): Promise<ElementNode[]> {
	clearOutlineCache();
	const doc: StructDocument = { filePath: "/tmp/view.tsx", languageId: "tsx", text };
	return (await treeSitterProvider.elementTree?.(doc)) ?? [];
}

function names(nodes: readonly ElementNode[]): string[] {
	const out: string[] = [];
	const walk = (list: readonly ElementNode[]): void => {
		for (const node of list) {
			out.push(node.name);
			if (node.children) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

function find(nodes: readonly ElementNode[], name: string): ElementNode | undefined {
	for (const node of nodes) {
		if (node.name === name) return node;
		const nested = node.children ? find(node.children, name) : undefined;
		if (nested) return nested;
	}
	return undefined;
}

describeWithTsx("element tree", () => {
	test("captures component nesting with line ranges", async () => {
		const tree = await treeOf(`export function View() {
	return (
		<Ctx.Provider value={v}>
			<Stack gap="sm">
				<Child />
			</Stack>
		</Ctx.Provider>
	);
}
`);
		expect(names(tree)).toEqual(["Ctx.Provider", "Stack", "Child"]);
		const provider = find(tree, "Ctx.Provider");
		expect(provider?.line).toBe(3);
		expect(provider?.endLine).toBe(7);
	});

	test("attribute values are dropped, structural names kept", async () => {
		const tree = await treeOf(
			'const x = <Group ref={rowRef} key={id} onClick={handleVeryLongCallbackName} bg="red" />;\n',
		);
		const group = find(tree, "Group");
		expect(group?.attributes).toEqual(["ref", "key"]);
		// A skeleton with props inlined would just be the source again.
		expect(JSON.stringify(tree)).not.toContain("handleVeryLongCallbackName");
	});

	test("conditional rendering is labelled", async () => {
		const tree = await treeOf(`const x = (
	<Stack>
		{ready && <Loaded />}
		{flag ? <A /> : <B />}
		{items.map((i) => (
			<Row key={i} />
		))}
	</Stack>
);
`);
		expect(find(tree, "Loaded")?.condition).toBe("and");
		expect(find(tree, "A")?.condition).toBe("ternary");
		expect(find(tree, "Row")?.condition).toBe("map");
	});

	test("fragments are represented rather than dropped", async () => {
		const tree = await treeOf("const x = <><A /><B /></>;\n");
		expect(names(tree)).toEqual(["<>", "A", "B"]);
	});

	test("html host elements are hidden but never hide their component children", async () => {
		const tree = await treeOf(`const x = (
	<div className="wrapper">
		<span>
			<RealContent />
		</span>
	</div>
);
`);
		// The two host wrappers collapse away; what matters survives.
		expect(names(tree)).toEqual(["RealContent"]);
	});

	test("an html element with several component children keeps a placeholder parent", async () => {
		const tree = await treeOf(`const x = (
	<div>
		<A />
		<B />
	</div>
);
`);
		// Flattening two siblings into one slot would lose their sibling relationship, so
		// the host element is retained rather than inventing a synthetic parent.
		expect(names(tree)).toEqual(["div", "A", "B"]);
		expect(find(tree, "div")?.html).toBe(true);
	});

	test("a file with no JSX returns an empty tree, not an error", async () => {
		clearOutlineCache();
		const tree =
			(await treeSitterProvider.elementTree?.({
				filePath: "/tmp/plain.ts",
				languageId: "typescript",
				text: "export const x = 1;\n",
			})) ?? [];
		expect(tree).toEqual([]);
	});
});

describeWithTsx("regression: the real NarratorPanel render tree", () => {
	test("stable early-return and main JSX trees preserve exact roots, nesting and ranges", async () => {
		const tree = await treeOf(`export function StablePanel({ ready }) {
	if (!ready) return <PanelSkeleton />;
	return (
		<Ctx.Provider>
			<Shell>
				{ready && <Content />}
			</Shell>
		</Ctx.Provider>
	);
}
`);
		expect(tree.map(({ name, line, endLine }) => ({ name, line, endLine }))).toEqual([
			{ name: "PanelSkeleton", line: 2, endLine: 2 },
			{ name: "Ctx.Provider", line: 4, endLine: 8 },
		]);
		expect(names(tree)).toEqual(["PanelSkeleton", "Ctx.Provider", "Shell", "Content"]);
		expect(find(tree, "Content")?.condition).toBe("and");
	});

	test("the real component render tree remains visible after its loading wrapper changes", async () => {
		const text = await Bun.file("frontend/components/narrator/NarratorPanel.tsx").text();
		clearOutlineCache();
		const tree =
			(await treeSitterProvider.elementTree?.({
				filePath: "frontend/components/narrator/NarratorPanel.tsx",
				languageId: "tsx",
				text,
			})) ?? [];
		expect(tree.length).toBeGreaterThan(0);
		const all = names(tree);
		expect(all.length).toBeGreaterThan(20);
		// Root names and absolute offsets belong to the stable fixture, not component layout.
		expect(tree.every((node) => node.line > 0 && node.endLine >= node.line)).toBe(true);
		expect(find(tree, "PermEnterHintCtx.Provider")).toBeDefined();
	});
});
