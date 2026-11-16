/**
 * The outline has no pages, and nothing an agent is shown says otherwise (pageless outline, A1;
 * owner decision D57): not the outline tools' descriptions, parameters or results, not the
 * outline sections of the system prompt, not the notices injected into a session.
 *
 * Two checks:
 *   1. the tools as the model gets them: the description and parameter schema of EVERY tool the
 *      registry holds (core and optional: an outline session can see any of them), not a hand
 *      list; another sense of the word (a web page, a PDF's pages, a page of results) is named
 *      per tool in {@link OTHER_SENSES};
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
import { toolRegistry } from "../../agent/tool-registry";
import "../../agent/tools";
import { outlineReadTool } from "../../agent/tools/outline";
import type { ToolDefinition } from "../../agent/types";

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
	// Tasks and the team (A2): the task brief, delegation, team activity and events, hand-out,
	// transfer, the person's tasks, questions, plans, pending changes and their decisions.
	"server/services/outline/delegation-text.ts",
	"server/services/outline/delegation.ts",
	"server/services/outline/task-session.ts",
	"server/services/outline/task-board.ts",
	"server/services/outline/team-activity.ts",
	"server/services/outline/team-events.ts",
	"server/services/outline/team-wake.ts",
	"server/services/outline/person-tasks.ts",
	"server/services/outline/hand-out.ts",
	"server/services/outline/handoff.ts",
	"server/services/outline/release.ts",
	"server/services/outline/transfer.ts",
	"server/services/outline/questions.ts",
	"server/services/outline/inbox.ts",
	"server/services/outline/plans.ts",
	"server/services/outline/plan-diff.ts",
	"server/services/outline/pending.ts",
	"server/services/outline/pending-hold.ts",
	"server/services/outline/subtree-copy.ts",
	"server/services/outline/block-tree.ts",
	"server/services/outline-plan-mode.ts",
] as const;

const PAGE = /page|页/i;

/**
 * Strings that hold the word and never reach an agent, by file: the exact literal and why.
 * Keep it short; a new entry needs a reason a reviewer accepts.
 */
const ALLOWED: Record<string, ReadonlyArray<{ text: string; why: string }>> = {};

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

/**
 * Phrases of registered tools that use the word in another sense than the outline's, by tool:
 * taken out of the tool's text before the check. Exact text, so a new outline "page" next to
 * them still fails.
 */
const LIST_PAGING = ["Page size", "the previous page", "the current page"] as const;

const OTHER_SENSES: Record<string, { phrases: readonly (string | RegExp)[]; why: string }> = {
	Read: {
		phrases: [
			"page through large files",
			"offset, limit and pages",
			"more than 10 pages",
			"the pages parameter",
			"specific page ranges",
			'pages: "1-5"',
			"Maximum 20 pages per request",
			'"pages"',
			"Page range for PDF files",
		],
		why: "a PDF's pages and paging through a file",
	},
	WebFetch: {
		phrases: ["web page", "long pages", "static pages", "(page image)"],
		why: "web pages",
	},
	LearningGuide: { phrases: ["/learn page"], why: "the app's learning page" },
	ListWorktrees: { phrases: LIST_PAGING, why: "a page of list results" },
	Worktree: { phrases: LIST_PAGING, why: "a page of list results" },
	Browser: {
		phrases: [
			"page-target memory",
			"page interactions",
			"the page viewport",
			"Scroll the page",
			"the page context",
			"with pages that",
			"of the page or",
			"the page in place",
			"page errors",
			"disturb the page",
			"reloads the page",
			"the active page",
			"the current page",
			"page-load requests",
			"page text",
			"with the page and",
		],
		why: "web pages in a browser",
	},
};

/** The tool's description and its parameters as the provider gets them. */
function toolTexts(tool: ToolDefinition): Array<{ where: string; text: string }> {
	const schema = tool.rawJsonSchema ?? z.toJSONSchema(tool.parameters as z.ZodType);
	return [
		{ where: "description", text: tool.description },
		{ where: "parameters", text: JSON.stringify(schema) },
	];
}

function withoutOtherSenses(tool: string, text: string): string {
	let out = text;
	for (const phrase of OTHER_SENSES[tool]?.phrases ?? []) {
		out = typeof phrase === "string" ? out.split(phrase).join(" ") : out.replace(phrase, " ");
	}
	return out;
}

describe("nothing an agent reads about the outline names pages", () => {
	const tools = toolRegistry.all();

	test("the registry holds every tool an outline session can see, the outline ones included", () => {
		const names = new Set(tools.map((tool) => tool.name));
		for (const name of ["OutlineRead", "OutlineSearch", "OutlineEdit", "Ask", "EnterPlanMode"])
			expect(names.has(name)).toBe(true);
		expect(tools.length).toBeGreaterThan(40);
	});

	test("every registered tool: description and parameters", () => {
		const hits: string[] = [];
		for (const tool of tools) {
			for (const { where, text } of toolTexts(tool)) {
				const rest = withoutOtherSenses(tool.name, text);
				for (const match of rest.matchAll(/.{0,40}(?:page|页).{0,40}/gi))
					hits.push(`${tool.name} ${where}: ${match[0]}`);
			}
		}
		expect(hits).toEqual([]);
	});

	test("every other sense named is still in its tool's text", () => {
		for (const [name, { phrases }] of Object.entries(OTHER_SENSES)) {
			const tool = tools.find((candidate) => candidate.name === name);
			expect({ name, registered: !!tool }).toEqual({ name, registered: true });
			if (!tool) continue;
			const all = toolTexts(tool)
				.map((entry) => entry.text)
				.join("\n");
			for (const phrase of phrases) {
				const present =
					typeof phrase === "string" ? all.includes(phrase) : new RegExp(phrase).test(all);
				expect({ name, phrase: String(phrase), present }).toEqual({
					name,
					phrase: String(phrase),
					present: true,
				});
			}
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
