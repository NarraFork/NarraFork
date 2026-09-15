/**
 * The analysis modes: report / refs / calls / tree, plus the summary header and the
 * print match feedback.
 *
 * Each of these exists because it replaced a Bash/grep call that a real session had to
 * make, so the assertions are about the facts those calls were after — and about the
 * honesty qualifiers, since a count that looks authoritative but is single-file-only
 * would be worse than no count.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOutlineCache } from "../../structural";
import { ensureGrammarFixture } from "../../structural/__tests__/grammar-fixture";
import type { ToolContext } from "../../types";
import { structViewTool } from "../struct-view";

const hasTypescript = ensureGrammarFixture("typescript");
const hasTsx = ensureGrammarFixture("tsx");

const SOURCE = `import { helper } from "./helper";

/** Used a lot. */
export function busy(): number {
	return busy() + busy();
}

export function neverUsedHere(): void {}

function alsoDead(): void {}

export class Widget {
	private value = 0;

	render(): number {
		return this.value + busy();
	}
}

export function Component() {
	const [count, setCount] = useState(0);
	useEffect(() => {
		helper();
	}, [count]);
	useEffect(() => {}, []);
	return null;
}
`;

let workDir: string;
let tsFile: string;
let plainFile: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "nf-sv-analysis-"));
	tsFile = join(workDir, "sample.ts");
	writeFileSync(tsFile, SOURCE, "utf8");
	plainFile = join(workDir, "notes.log");
	writeFileSync(plainFile, "alpha\nbeta TODO\ngamma\ndelta TODO\nepsilon\n", "utf8");
});

function ctx(): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function run(args: Record<string, unknown>) {
	clearOutlineCache();
	return structViewTool.execute(args, ctx());
}

describe("summary header", () => {
	test("every mode reports line count and size up front", async () => {
		const result = await run({ file_path: tsFile, mode: "outline" });
		expect(result.output).toMatch(/\d+ lines · \d+ KB/);
	});

	// The fixture's trailing newline makes the final split produce an empty 6th line,
	// matching how Read counts lines; asserting 6 keeps the two consistent.
	test("print reports the scan denominator alongside the match count", async () => {
		const result = await run({ file_path: plainFile, mode: "print", address: "/TODO/" });
		// Without the denominator, "2 matches" cannot be told apart from a bad pattern
		// that happened to hit twice.
		expect(result.output).toContain("2 matches in 6 lines scanned");
	});

	test("a single match says 'match', not 'matches'", async () => {
		const result = await run({ file_path: plainFile, mode: "print", address: "/alpha/" });
		expect(result.output).toContain("1 match in 6 lines scanned");
	});

	test("zero matches explains the likely cause instead of dead-ending", async () => {
		const result = await run({ file_path: plainFile, mode: "print", address: "/nothing-here/" });
		expect(result.output).toContain("scanned 6 lines");
		expect(result.output).toContain("regex");
		expect(result.output).toContain("mode=outline");
	});

	test("a numeric address out of range gets a numeric hint, not a regex one", async () => {
		const result = await run({ file_path: plainFile, mode: "print", address: "900" });
		expect(result.output).toContain("1-based");
		expect(result.output).not.toContain("escaping");
	});
});

const describeWithGrammar = hasTypescript ? describe : describe.skip;

describeWithGrammar("mode=refs", () => {
	test("orders declarations by reference count, fewest first", async () => {
		const result = await run({ file_path: tsFile, mode: "refs" });
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.mode).toBe("refs");
		const lines = result.output.split("\n").filter((l) => /^\s*\d+\s+L\d+/.test(l));
		const counts = lines.map((l) => Number(l.trim().split(/\s+/)[0]));
		// Ascending: the dead code a reader is looking for is at the top.
		expect(counts).toEqual([...counts].sort((a, b) => a - b));
	});

	test("identifies the never-used declarations", async () => {
		const result = await run({ file_path: tsFile, mode: "refs" });
		expect(result.output).toContain("neverUsedHere");
		expect(result.output).toContain("alsoDead");
		expect(result.metadata?.singleReference).toBeGreaterThanOrEqual(2);
	});

	test("warns that single-file counts cannot see cross-file usage", async () => {
		const result = await run({ file_path: tsFile, mode: "refs" });
		// `neverUsedHere` is exported; deleting it on this evidence alone would be wrong.
		expect(result.output).toContain("OTHER files");
		expect(result.output).toContain("Grep");
	});

	test("a heavily used symbol is not flagged", async () => {
		const result = await run({ file_path: tsFile, mode: "refs" });
		const busyLine = result.output.split("\n").find((l) => l.includes(" busy"));
		expect(busyLine).toBeDefined();
		expect(Number(busyLine?.trim().split(/\s+/)[0])).toBeGreaterThan(1);
	});
});

describeWithGrammar("mode=calls", () => {
	test("counts calls exactly, including generic call forms", async () => {
		const genericFile = join(workDir, "generics.ts");
		writeFileSync(
			genericFile,
			"const a = useState<number>(0);\nconst b = useState<string>('');\nconst c = useState(1);\n",
			"utf8",
		);
		const result = await run({ file_path: genericFile, mode: "calls" });
		// `grep -c 'useState('` would report 1 here; the AST sees all three.
		expect(result.output).toMatch(/3\s+useState/);
	});

	test("filter narrows to a callee prefix", async () => {
		const result = await run({ file_path: tsFile, mode: "calls", filter: "use" });
		expect(result.output).toContain("useEffect");
		expect(result.output).not.toContain("helper");
	});

	test("reports when a filter matches nothing", async () => {
		const result = await run({ file_path: tsFile, mode: "calls", filter: "zzz-none" });
		expect(result.output).toContain('No calls matching "zzz-none"');
	});

	test("limit bounds the row count", async () => {
		const result = await run({ file_path: tsFile, mode: "calls", limit: 1 });
		const rows = result.output.split("\n").filter((l) => /^\s+\d+\s+\S/.test(l));
		expect(rows.length).toBe(1);
	});
});

describeWithGrammar("outline with_refs", () => {
	test("annotates entries and flags single-reference ones", async () => {
		const result = await run({ file_path: tsFile, mode: "outline", with_refs: true });
		expect(result.output).toContain("refs:1 ⚠");
		expect(result.output).toMatch(/refs:[2-9]/);
	});

	test("statement calls are not given a reference count", async () => {
		const result = await run({ file_path: tsFile, mode: "outline", with_refs: true, depth: 3 });
		const effectLine = result.output.split("\n").find((l) => l.includes("call useEffect"));
		expect(effectLine).toBeDefined();
		// A callee is not a declared symbol; counting it would answer a different question.
		expect(effectLine).not.toContain("refs:");
	});

	test("the initializer is shown so a destructure says where it came from", async () => {
		const result = await run({ file_path: tsFile, mode: "outline", depth: 3 });
		expect(result.output).toContain("useState(…)");
	});
});

describeWithGrammar("mode=report", () => {
	test("returns every section in one call", async () => {
		const result = await run({ file_path: tsFile, mode: "report" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("STRUCTURE");
		expect(result.output).toContain("LARGEST SYMBOLS");
		expect(result.output).toContain("TOP CALLS");
		expect(result.output).toContain("SINGLE-REFERENCE SYMBOLS");
		expect(result.metadata?.hasStatistics).toBe(true);
	});

	test("largest symbols are ordered by span", async () => {
		const result = await run({ file_path: tsFile, mode: "report" });
		const section = result.output.split("LARGEST SYMBOLS")[1] ?? "";
		const spans = section
			.split("\n")
			.map((l) => /^\s*(\d+) lines/.exec(l)?.[1])
			.filter((v): v is string => v != null)
			.map(Number);
		expect(spans.length).toBeGreaterThan(0);
		expect(spans).toEqual([...spans].sort((a, b) => b - a));
	});

	test("keeps the cross-file caveat where the dead-code list is", async () => {
		const result = await run({ file_path: tsFile, mode: "report" });
		expect(result.output).toContain("Cross-file usage is invisible here");
	});

	test("finds the unused half of a useState pair", async () => {
		const pairFile = join(workDir, "pair.ts");
		writeFileSync(
			pairFile,
			`export function C() {
	const [unusedValue, setValue] = useState(0);
	const [readValue, setOther] = useState(1);
	setValue(1);
	setOther(readValue);
	return null;
}
`,
			"utf8",
		);
		const result = await run({ file_path: pairFile, mode: "report" });
		// The declaration is alive (the setter is used), so a max-over-bindings count
		// hides the dead half. This section is what makes it visible.
		expect(result.output).toContain("UNUSED BINDINGS");
		expect(result.output).toContain("unusedValue");
		expect(result.output).not.toMatch(/UNUSED BINDINGS[\s\S]*\breadValue\b/);
	});
});

const describeWithTsx = hasTsx ? describe : describe.skip;

describeWithTsx("mode=tree", () => {
	test("renders the component skeleton with conditions", async () => {
		const viewFile = join(workDir, "view.tsx");
		writeFileSync(
			viewFile,
			`export function View() {
	return (
		<Shell>
			{ready && <Loaded />}
			{items.map((i) => (
				<Row key={i} />
			))}
		</Shell>
	);
}
`,
			"utf8",
		);
		const result = await run({ file_path: viewFile, mode: "tree" });
		expect(result.output).toContain("<Shell>");
		expect(result.output).toContain("{and} <Loaded>");
		expect(result.output).toContain("{map} <Row key>");
		expect(result.metadata?.mode).toBe("tree");
	});

	test("a file without JSX says so rather than erroring", async () => {
		const result = await run({ file_path: tsFile, mode: "tree" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No nested elements");
	});
});

describe("modes that require a grammar", () => {
	test("tree/refs/calls decline clearly for an unsupported language", async () => {
		const unknown = join(workDir, "thing.zzz");
		writeFileSync(unknown, "some text\n", "utf8");
		for (const mode of ["tree", "refs", "calls"]) {
			const result = await run({ file_path: unknown, mode });
			expect(result.isError).toBe(true);
			// Names the fix rather than just failing, and points at the modes that do work.
			expect(result.output).toContain("Settings → Structural Parsing");
			expect(result.output).toContain("mode=print");
		}
	});

	test("report still works without a grammar, minus the counted sections", async () => {
		const unknown = join(workDir, "other.zzz");
		writeFileSync(unknown, "function thing() {\n  return 1;\n}\n", "utf8");
		const result = await run({ file_path: unknown, mode: "report" });
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.hasStatistics).toBe(false);
		expect(result.output).toContain("were omitted");
	});
});

describeWithTsx("regression: the file that motivated these modes", () => {
	// Absolute: the tool resolves relative paths against the ToolContext cwd, which is
	// the temp dir these tests run in, not the repo root.
	const realFile = join(process.cwd(), "frontend/components/narrator/NarratorPanel.tsx");

	test("the dominant-symbol callout names the giant component", async () => {
		const result = await run({ file_path: realFile, mode: "outline", depth: 1 });
		// One function spans 92% of the file; that fact belongs at the top.
		expect(result.output).toMatch(/largest: function NarratorPanel L\d+-\d+ \(9\d% of file\)/);
	});

	test("report covers structure, calls, dead code and the render tree together", async () => {
		const result = await run({ file_path: realFile, mode: "report" });
		expect(result.output).toContain("STRUCTURE");
		expect(result.output).toContain("TOP CALLS");
		expect(result.output).toContain("RENDER TREE");
		expect(result.metadata?.hasRenderTree).toBe(true);
		// The four symbols a real session needed three Bash calls to identify. The first
		// three are whole declarations; `_messageRenderPhase` is the unused half of a
		// `useState` pair, which only the UNUSED BINDINGS section can surface.
		for (const dead of ["_startFollowing", "_detachFromFullBottom", "_resizingRef"]) {
			expect(result.output).toContain(dead);
		}
		expect(result.output).toContain("UNUSED BINDINGS");
		expect(result.output).toContain("_messageRenderPhase");
	});

	test("report output stays bounded", async () => {
		const result = await run({ file_path: realFile, mode: "report" });
		expect(result.output.split("\n").length).toBeLessThanOrEqual(810);
	});

	test("a normal-sized file gets no dominant-symbol callout", async () => {
		const result = await run({ file_path: tsFile, mode: "outline" });
		expect(result.output).not.toContain("largest:");
	});
});

test("cleanup", () => {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// Best effort.
	}
	expect(true).toBe(true);
});
