/**
 * The outline has no pages, and nothing an agent is shown says otherwise (pageless outline, A1;
 * owner decision D57): not the outline tools' descriptions, parameters or results, not the
 * outline sections of the system prompt, not the notices injected into a session.
 *
 * Two checks:
 *   1. the tools as the model gets them: their descriptions and their parameter schemas;
 *   2. every string literal and template text of the files that word what an agent reads
 *      ({@link SOURCES}), found by the TypeScript parser, so comments and identifiers do not
 *      count and no wording can hide in a helper.
 *
 * A file that still has to speak of pages in a string an agent never sees lists that string in
 * {@link ALLOWED} with the reason. Wording about reading on is "more" / "continue", never
 * "next page".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod/v4";
import {
	askTool,
	outlineEditTool,
	outlineReadTool,
	outlineSearchTool,
} from "../../agent/tools/outline";

const ROOT = join(import.meta.dir, "../../../..");

/** Files whose strings reach an agent: tool text, tool results, prompt sections, notices. */
const SOURCES = [
	"server/lib/agent/tools/outline.ts",
	"server/services/outline/messages.ts",
	"server/services/outline/agent-read.ts",
	"server/services/outline/agent-edit.ts",
	"server/services/outline/agent-merge.ts",
	"server/services/outline/agent-scope.ts",
	"server/services/outline/render.ts",
	"server/services/outline/note-rules.ts",
	"server/services/outline/pending-overlay.ts",
	"server/services/outline/well-known.ts",
	"server/services/task-source/outline-views.ts",
	"server/services/task-source/outline-read.ts",
	"server/services/task-source/outline.ts",
	"server/services/task-source/outline-behavior.ts",
	"server/services/task-source/outline-plugin-rules.ts",
	"server/lib/prompts/outline-tasks.ts",
	"server/lib/prompts/outline-team.ts",
	"server/lib/prompts/outline-plan.ts",
] as const;

const PAGE = /page|页/i;

/**
 * Strings that hold the word and never reach an agent, by file: the exact literal and why.
 * Keep it short; a new entry needs a reason a reviewer accepts.
 */
const ALLOWED: Record<string, ReadonlyArray<{ text: string; why: string }>> = {
	"server/lib/prompts/outline-team.ts": [
		{
			text: "page",
			why: "a discriminator of an internal line type (`where`), never rendered; the team notes move to blocks in A2",
		},
	],
};

function literals(file: string): Array<{ text: string; line: number }> {
	const source = ts.createSourceFile(
		file,
		readFileSync(join(ROOT, file), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const out: Array<{ text: string; line: number }> = [];
	const visit = (node: ts.Node) => {
		// Module specifiers are paths, not wording.
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
		) {
			out.push({
				text: node.text,
				line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

describe("nothing an agent reads about the outline names pages", () => {
	const tools = [outlineReadTool, outlineSearchTool, outlineEditTool, askTool];

	test("tool descriptions", () => {
		for (const tool of tools) {
			expect({ tool: tool.name, hit: PAGE.exec(tool.description)?.[0] ?? null }).toEqual({
				tool: tool.name,
				hit: null,
			});
		}
	});

	test("tool parameters: names and descriptions", () => {
		for (const tool of tools) {
			const schema = JSON.stringify(z.toJSONSchema(tool.parameters as z.ZodType));
			expect({ tool: tool.name, hit: PAGE.exec(schema)?.[0] ?? null }).toEqual({
				tool: tool.name,
				hit: null,
			});
		}
	});

	test("the parameters an agent addresses blocks with", () => {
		const read = z.toJSONSchema(outlineReadTool.parameters as z.ZodType) as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(read.properties).sort()).toEqual([
			"address",
			"after",
			"asOf",
			"budget",
			"view",
		]);
	});

	for (const file of SOURCES) {
		test(`strings of ${file}`, () => {
			const allowed = new Set((ALLOWED[file] ?? []).map((entry) => entry.text));
			const hits = literals(file)
				.filter((literal) => PAGE.test(literal.text) && !allowed.has(literal.text))
				.map((literal) => `${file}:${literal.line}: ${literal.text.slice(0, 120)}`);
			expect(hits).toEqual([]);
		});
	}

	test("the allow-list names only strings that are still there", () => {
		for (const [file, entries] of Object.entries(ALLOWED)) {
			const present = new Set(literals(file).map((literal) => literal.text));
			for (const entry of entries) expect(present.has(entry.text)).toBe(true);
		}
	});
});
