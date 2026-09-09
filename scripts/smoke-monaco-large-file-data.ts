export type FixtureLanguage = "javascript" | "typescript" | "json" | "python" | "markdown";
export interface FixtureSpec {
	id: string;
	language: FixtureLanguage;
	bytes: number;
	lines?: number;
	longLine?: boolean;
	stress?: boolean;
}
export const MiB = 1024 * 1024;
export const languages: FixtureLanguage[] = [
	"javascript",
	"typescript",
	"json",
	"python",
	"markdown",
];
export const matrix: FixtureSpec[] = [
	...languages.flatMap((language) =>
		[1, 5, 20].map((size) => ({ id: `${language}-${size}`, language, bytes: size * MiB })),
	),
	{ id: "typescript-300k", language: "typescript", bytes: 20 * MiB, lines: 300_000 },
	{ id: "javascript-longline", language: "javascript", bytes: MiB, longLine: true },
	...languages.map((language) => ({
		id: `${language}-20-stress`,
		language,
		bytes: 20 * MiB,
		stress: true,
	})),
];
const blocks: Record<FixtureLanguage, string> = {
	javascript:
		'/* multiline 中文\ncomment 😀 */\nconst answer = 42;\nconst text = `hello\n中文 😀`;\nfunction value() { return "SEARCH_TARGET"; }\n// tail comment\n\n',
	typescript:
		'/* multiline 中文\ncomment 😀 */\nconst answer: number = 42;\nconst text = `hello\n中文 😀`;\nfunction value(): string { return "SEARCH_TARGET"; }\n// tail comment\n\n',
	json: '  {"name": "中文 😀",\n   "answer": 42,\n   "active": true,\n   "target": "SEARCH_TARGET"},\n',
	python:
		'# 中文 😀\ntext = """hello\n中文 😀\nend"""\nanswer = 42\ndef value():\n    return "SEARCH_TARGET"\n\n',
	markdown:
		"# Heading 中文 😀\n\n**strong** and *emphasis*\n[SEARCH_TARGET](https://example.invalid)\n<!-- multiline\ncomment -->\n`inline code`\n\n",
};
export function createFixture(spec: FixtureSpec) {
	if (spec.longLine)
		return {
			content: `const longLine = "${"x".repeat(spec.bytes - 20 - 13)}SEARCH_TARGET";`,
			block: blocks.javascript,
			blockLines: 1,
			blockCount: 1,
			firstLine: 1,
		};
	const block = spec.stress
		? blocks[spec.language]
		: `${blocks[spec.language]
				.split("\n")
				.slice(0, -1)
				.map((line) => line.padEnd(spec.lines ? 64 : 72, " "))
				.join("\n")}\n`;
	const blockLines = block.split("\n").length - 1;
	const prefix = spec.language === "json" ? "[\n" : "";
	const suffix = spec.language === "json" ? "  null\n]\n" : "";
	const overhead = Buffer.byteLength(prefix + suffix);
	const blockCount = spec.lines
		? Math.floor((spec.lines - 1) / blockLines)
		: Math.floor((spec.bytes - overhead) / Buffer.byteLength(block));
	let content = prefix + block.repeat(blockCount) + suffix;
	if (spec.lines) content += "\n".repeat(spec.lines - content.split("\n").length);
	else {
		// Pad with short whitespace-only lines; never introduce a pathological last line.
		const remaining = spec.bytes - Buffer.byteLength(content);
		content +=
			"                                                               \n".repeat(
				Math.floor(remaining / 64),
			) + " ".repeat(remaining % 64);
	}
	return { content, block, blockLines, blockCount, firstLine: prefix ? 2 : 1 };
}
export type FixtureData = ReturnType<typeof createFixture>;
