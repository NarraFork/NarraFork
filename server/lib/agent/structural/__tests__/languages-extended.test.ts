/**
 * Declaration tables for the languages added beyond the original seven, plus the
 * generic-tier fallback.
 *
 * The measurement that shaped this: reading only the `name` FIELD returns **zero
 * declarations for Kotlin**, whose node types (`class_declaration`,
 * `function_declaration`) are exactly what you would expect but expose the identifier
 * positionally with no field. Nothing errors — the outline is just empty. Swift has the
 * same shape, and C/C++ hide the function name inside `function_declarator`. Each of
 * those is asserted here so a future refactor cannot quietly reintroduce the silence.
 *
 * Grammars are only present when the host machine has installed them, so every block
 * skips rather than fails when its grammar is missing.
 */
import { describe, expect, test } from "bun:test";
import type { OutlineNode, StructDocument } from "../provider";
import { clearOutlineCache, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

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

async function outlineOf(languageId: string, text: string): Promise<OutlineNode[]> {
	clearOutlineCache();
	const doc: StructDocument = { filePath: `/tmp/sample.${languageId}`, languageId, text };
	return flatten((await treeSitterProvider.outline(doc)) as OutlineNode[]);
}

/** Build a describe block that skips unless the grammar is installed locally. */
function describeLanguage(languageId: string, body: () => void): void {
	const available = ensureGrammarFixture(languageId);
	(available ? describe : describe.skip)(`${languageId} declarations`, body);
}

describeLanguage("kotlin", () => {
	test("declarations are found despite the grammar having no name field", async () => {
		const nodes = await outlineOf(
			"kotlin",
			`package p

class Foo(val x: Int) : Bar() {
	fun run(a: Int): String = ""
	val prop = 1
}

fun top(a: Int) {}
interface I { fun m() }
object O
`,
		);
		const names = nodes.map((n) => n.name);
		// Before the positional fallback this list was EMPTY.
		expect(names).toContain("Foo");
		expect(names).toContain("run");
		expect(names).toContain("top");
		expect(names).toContain("O");
		expect(nodes.find((n) => n.name === "Foo")?.kind).toBe("class");
		expect(nodes.find((n) => n.name === "run")?.kind).toBe("function");
	});

	test("class members nest under the class", async () => {
		const nodes = await outlineOf("kotlin", "class A {\n\tfun m() {}\n}\n");
		const cls = nodes.find((n) => n.name === "A");
		expect(cls?.depth).toBe(0);
		expect(nodes.find((n) => n.name === "m")?.depth).toBe(1);
	});
});

describeLanguage("swift", () => {
	test("declarations are found despite the grammar having no name field", async () => {
		const nodes = await outlineOf(
			"swift",
			`import Foundation

class Service {
	func run(a: Int) -> String { return "" }
}

func top(a: Int) {}
protocol P { func m() }
`,
		);
		const names = nodes.map((n) => n.name);
		expect(names).toContain("Service");
		expect(names).toContain("top");
		expect(names).toContain("P");
	});
});

describeLanguage("c", () => {
	test("function names are read through the declarator", async () => {
		const nodes = await outlineOf(
			"c",
			`#include <stdio.h>

struct Bar { int b; };
enum E { X };

int top(int a) { return a; }
static void helper(void) {}
char *dup(const char *s) { return NULL; }
`,
		);
		const names = nodes.map((n) => n.name);
		// The name lives inside function_declarator, not a `name` field.
		expect(names).toContain("top");
		expect(names).toContain("helper");
		// And through a pointer declarator.
		expect(names).toContain("dup");
		expect(names).toContain("Bar");
		expect(names).toContain("E");
	});
});

describeLanguage("cpp", () => {
	test("classes, namespaces and methods are reported", async () => {
		const nodes = await outlineOf(
			"cpp",
			`namespace app {
class Widget {
public:
	int run(int a) { return a; }
};
}
void top() {}
`,
		);
		const names = nodes.map((n) => n.name);
		expect(names).toContain("app");
		expect(names).toContain("Widget");
		expect(names).toContain("top");
	});
});

describeLanguage("ruby", () => {
	test("suffix-less node types are still recognised", async () => {
		const nodes = await outlineOf(
			"ruby",
			`module M
	class Foo < Bar
		def initialize(a)
			@a = a
		end
		def self.build; end
	end
end

def top(x); x; end
`,
		);
		const names = nodes.map((n) => n.name);
		// Ruby's nodes are `module` / `class` / `method`, with no `_declaration` suffix.
		expect(names).toContain("M");
		expect(names).toContain("Foo");
		expect(names).toContain("initialize");
		expect(names).toContain("top");
		expect(nodes.find((n) => n.name === "Foo")?.kind).toBe("class");
	});
});

describeLanguage("php", () => {
	test("classes and functions are reported", async () => {
		const nodes = await outlineOf(
			"php",
			`<?php
namespace App;

class Foo extends Bar {
	public function run(int $a): string { return ""; }
}

function top($a) { return $a; }
`,
		);
		const names = nodes.map((n) => n.name);
		expect(names).toContain("Foo");
		expect(names).toContain("run");
		expect(names).toContain("top");
	});
});

describeLanguage("c_sharp", () => {
	test("namespaces, classes and methods are reported", async () => {
		const nodes = await outlineOf(
			"c_sharp",
			`namespace App {
	public class Widget {
		public int Run(int a) { return a; }
		private int field = 1;
	}
}
`,
		);
		const names = nodes.map((n) => n.name);
		expect(names).toContain("App");
		expect(names).toContain("Widget");
		expect(names).toContain("Run");
	});
});

// ── generic tier ─────────────────────────────────────────────────────

describeLanguage("zig", () => {
	test("the generic heuristics produce declarations without a hand-written table", async () => {
		const nodes = await outlineOf(
			"zig",
			'const std = @import("std");\npub fn main() void {}\nfn helper() void {}\n',
		);
		const names = nodes.map((n) => n.name);
		expect(names).toContain("main");
		expect(names).toContain("helper");
	});

	test("the result is labelled as rule-based rather than exact", async () => {
		const note = await treeSitterProvider.explainLimitation?.({
			filePath: "/tmp/a.zig",
			languageId: "zig",
			text: "pub fn main() void {}\n",
		});
		// Silence here would let a heuristic outline read as authoritative.
		expect(String(note)).toContain("generic");
	});
});

describeLanguage("scala", () => {
	test("generic heuristics find classes and defs", async () => {
		const nodes = await outlineOf("scala", "class A {\n  def m: Int = 1\n}\nobject O\n");
		const names = nodes.map((n) => n.name);
		expect(names).toContain("A");
		expect(names).toContain("m");
	});
});

describeLanguage("lua", () => {
	test("a language the generic rules cannot read is empty, and says so", async () => {
		const nodes = await outlineOf("lua", "local function helper() end\n");
		// Honest emptiness: this grammar's node names do not follow the conventions the
		// generic rules rely on. The manifest note is what keeps that from looking broken.
		expect(nodes.length).toBe(0);
		const note = await treeSitterProvider.explainLimitation?.({
			filePath: "/tmp/a.lua",
			languageId: "lua",
			text: "local function helper() end\n",
		});
		expect(String(note)).toContain("near-empty");
	});
});
