/**
 * A task's state is an icon on its background, never a character (owner: 「不要再使用符号来给
 * 任务做状态标记了」). The states are drawn from one map (`components/outline/outline-icons.ts`,
 * `OutlineStatusIcon` / `OutlineStatusChip`); this guard fails when display code or a
 * reader-facing string brings a status-like character back.
 *
 * It reads what the code of `frontend/` and `shared/` can draw (strings, templates, JSX text with
 * its entities; a diagram in a comment draws nothing), the `content:` of every stylesheet (with
 * its escapes) and every locale file. Tests and browser fixtures are not
 * display code.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Characters that read as a checkbox or a state: ballot boxes, half and full circles used as
 * state dots, ticks and crosses, hourglasses, locks, and the emoji of the same meaning.
 */
const STATUS_GLYPHS =
	/[\u2610-\u2613\u25D0-\u25D3\u2298\u2297\u2299\u2713-\u2718\u25C9\u25CE\u25CB\u25CF\u25EF\u25CC\u25A1\u25A0\u25A2\u25A3\u25FB\u25FC\u2B1C\u2B1B\u2B24\u2B55\u2705\u274C\u274E\u23F3\u231B\u{1F512}\u{1F513}\u{1F534}\u{1F7E0}-\u{1F7E2}\u{1F5F9}]/u;

/** HTML entities that name such a character (JSX text keeps entities as written). */
const NAMED_ENTITIES: Record<string, string> = {
	check: "\u2713",
	checkmark: "\u2713",
	cross: "\u2717",
	cir: "\u25CB",
	squ: "\u25A1",
	square: "\u25A1",
	bigcirc: "\u25EF",
	boxbox: "\u29C9",
};

/** Text with its HTML entities (`&#10003;`, `&#x2713;`, `&check;`) as the characters they draw. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] !== "#") return NAMED_ENTITIES[body] ?? whole;
		const code =
			body[1] === "x" || body[1] === "X"
				? Number.parseInt(body.slice(2), 16)
				: Number.parseInt(body.slice(1), 10);
		return Number.isFinite(code) && code > 0 && code <= 0x10ffff
			? String.fromCodePoint(code)
			: whole;
	});
}

/** A CSS value with its escapes (`\\2713`) as the characters they draw. */
export function decodeCssEscapes(value: string): string {
	return value.replace(/\\([0-9a-f]{1,6})\s?/gi, (whole, hex: string) => {
		const code = Number.parseInt(hex, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

/**
 * Files that use such a character for something that is not a task's state. Each is named with
 * its reason; none may be outline or task display code (asserted below), and an entry whose file
 * no longer has the character must be removed (asserted below).
 */
const ALLOWED: Record<string, string> = {
	"frontend/lib/status-registry.ts":
		"session (narrator) status entries carry a legacy `icon` character; nothing reads the field (the sidebar and the recent-tab card draw `NarratorStatusIcon` from `color` and `shape`), and sessions are not outline tasks",
	"frontend/routes/settings/plugins.$pluginId.tsx":
		"a yes/no cell of the plugin contributions table (has a schema), not a task state",
	"frontend/components/narrator/timeline/NarratorTimelinePanel.tsx":
		"a yes/no detail value (ran in the background), not a task state",
	"frontend/components/providers/CodexSection.tsx":
		"provider health counters (successes / failures), not a task state",
};

/** Where a task's state is drawn: nothing here may be allowed a character. */
const TASK_DISPLAY = [
	"frontend/components/outline/",
	"frontend/components/narrator/vlist/",
	"frontend/components/narrator/spec/",
	"shared/pretext-layout/",
	"shared/outline",
	"frontend/locales/",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__tests__", "generated"]);

function list(dir: string, match: RegExp, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) list(full, match, acc);
		else if (match.test(entry)) acc.push(full);
	}
	return acc;
}

/**
 * Where a file's code (not its comments) has such a character: only a string, a template, a
 * regular expression or JSX text can hold one, so the file is parsed and those are looked at.
 * A file without the character anywhere is not parsed.
 */
export function codeHits(source: string, fileName: string): string[] {
	// Nothing to find: no such character, and no entity or escape that could spell one.
	if (!STATUS_GLYPHS.test(source) && !/&#|&[a-z]+;|\\u/i.test(source)) return [];
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		false,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		const literal =
			ts.isStringLiteralLike(node) ||
			ts.isTemplateLiteralToken(node) ||
			ts.isJsxText(node) ||
			ts.isRegularExpressionLiteral(node);
		// A string's `.text` is already what it draws (`\u2713` cooked); JSX keeps entities.
		if (literal && STATUS_GLYPHS.test(decodeEntities(node.text))) {
			const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
			found.push(`${line + 1}: ${node.text.trim().slice(0, 120)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** `content:` declarations of a stylesheet that draw such a character (escapes decoded). */
export function cssHits(source: string): string[] {
	const found: string[] = [];
	source.split("\n").forEach((line, index) => {
		const value = /\bcontent\s*:\s*([^;]*)/.exec(line)?.[1];
		if (value && STATUS_GLYPHS.test(decodeCssEscapes(value)))
			found.push(`${index + 1}: ${line.trim().slice(0, 120)}`);
	});
	return found;
}

/** Lines of a text (a locale file: all of it is reader-facing) with such a character. */
function textHits(text: string): string[] {
	const found: string[] = [];
	text.split("\n").forEach((line, index) => {
		if (STATUS_GLYPHS.test(line)) found.push(`${index + 1}: ${line.trim().slice(0, 120)}`);
	});
	return found;
}

const rel = (path: string) => relative(REPO_ROOT, path).split("\\").join("/");

describe("task states are icons, never characters", () => {
	const code = [
		...list(join(REPO_ROOT, "frontend"), /\.(ts|tsx)$/),
		...list(join(REPO_ROOT, "shared"), /\.(ts|tsx)$/),
	].filter((path) => !/\.test\.(ts|tsx)$|browser-fixture|\.gen\.ts$|\.d\.ts$/.test(path));
	const locales = list(join(REPO_ROOT, "frontend/locales"), /\.json$/);
	const styles = list(join(REPO_ROOT, "frontend"), /\.css$/);

	test("the scan sees the code and the locale files", () => {
		expect(code.length).toBeGreaterThan(500);
		expect(locales.length).toBeGreaterThan(10);
		// It tells a comment from what is drawn: strings, templates, JSX text.
		expect(codeHits("// ☐ a diagram\n/* ✓ */ const a = 1;", "a.ts")).toEqual([]);
		expect(codeHits('const url = "http://x/y"; // it\'s ☐', "a.ts")).toEqual([]);
		expect(codeHits('const a = "☑";\nconst b = `✗ x`;', "a.ts")).toEqual(["1: ☑", "2: ✗ x"]);
		expect(codeHits("const a = <span>it's ✓{n}</span>;", "a.tsx")).toEqual(["1: it's ✓"]);
		expect(codeHits('const a = <b title="☐" />;', "a.tsx")).toEqual(["1: ☐"]);
		// Entities and escapes that spell one are seen too; a new character of the set as well.
		expect(codeHits("const a = <span>&#10003; done</span>;", "a.tsx")).toEqual([
			"1: &#10003; done",
		]);
		expect(codeHits("const a = <span>&#x2610;</span>;", "a.tsx")).toEqual(["1: &#x2610;"]);
		expect(codeHits("const a = <span>&check;</span>;", "a.tsx")).toEqual(["1: &check;"]);
		expect(codeHits("const a = <span>a &amp; b &#8594;</span>;", "a.tsx")).toEqual([]);
		expect(codeHits('const a = "\\u2713";', "a.ts")).toEqual(["1: \u2713"]);
		for (const glyph of [
			"\u274E",
			"\u2B55",
			"\u{1F7E2}",
			"\u{1F534}",
			"\u{1F7E1}",
			"\u2B24",
			"\u2613",
			"\u{1F5F9}",
		])
			expect(codeHits(`const a = "${glyph}";`, "a.ts"), glyph).toHaveLength(1);
		expect(cssHits('.a::before {\n\tcontent: "\\2713";\n}\n.b { content: "\u2610 x"; }')).toEqual([
			'2: content: "\\2713";',
			'4: .b { content: "\u2610 x"; }',
		]);
		expect(
			cssHits(".a::before { content: attr(data-label); }\n.b { color: red; /* \u2713 */ }"),
		).toEqual([]);
		expect(styles.length).toBeGreaterThan(20);
		expect(textHits('{\n\t"done": "✓ Done"\n}')).toEqual(['2: "done": "✓ Done"']);
	});

	test("no display code draws a status-like character", () => {
		const offenders: Record<string, string[]> = {};
		for (const path of code) {
			const name = rel(path);
			if (name in ALLOWED) continue;
			const found = codeHits(readFileSync(path, "utf8"), name);
			if (found.length > 0) offenders[name] = found;
		}
		expect(offenders).toEqual({});
	});

	test("no reader-facing string carries a status-like character", () => {
		const offenders: Record<string, string[]> = {};
		for (const path of locales) {
			const found = textHits(readFileSync(path, "utf8"));
			if (found.length > 0) offenders[rel(path)] = found;
		}
		expect(offenders).toEqual({});
	});

	test("no stylesheet draws a status-like character", () => {
		const offenders: Record<string, string[]> = {};
		for (const path of styles) {
			const found = cssHits(readFileSync(path, "utf8"));
			if (found.length > 0) offenders[rel(path)] = found;
		}
		expect(offenders).toEqual({});
	});

	test("the exceptions are real, and none of them is where a task's state is drawn", () => {
		for (const name of Object.keys(ALLOWED)) {
			expect(
				TASK_DISPLAY.some((prefix) => name.startsWith(prefix)),
				`${name} draws task states: it may not be an exception`,
			).toBe(false);
			const found = codeHits(readFileSync(join(REPO_ROOT, name), "utf8"), name);
			expect(found.length, `${name} no longer needs its exception`).toBeGreaterThan(0);
		}
	});
});
