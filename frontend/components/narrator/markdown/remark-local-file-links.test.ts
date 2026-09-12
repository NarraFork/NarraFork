import { describe, expect, test } from "bun:test";
import { fileTargetFromHref, isLocalFileHref } from "@shared/markdown-file-path";
import type { Link, Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkLocalFileLinks } from "./remark-local-file-links";

const context = { deviceId: "DeviceCase", cwd: "/workspace" };

function parse(source: string): Root {
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkMath)
		.use(remarkLocalFileLinks);
	// All plugins retain mdast; unified infers the transform output as generic Node.
	return processor.runSync(processor.parse(source)) as Root;
}

function links(node: Nodes): Link[] {
	if (node.type === "link") return [node];
	return "children" in node ? node.children.flatMap(links) : [];
}

describe("remark local file links", () => {
	test("retains location and device in authored links, code labels, lists and table cells", () => {
		const tree = parse(
			[
				"See [src/a.ts](src/a.ts:2:3-4:5) and [`docs/my notes.md`](docs/my%20notes.md#L6-L8).",
				"- [file](file:///tmp/a.ts#L9)",
				"| File |\n|---|\n| [remote](nf-file://open?device=RemoteABC&path=%2Fapp%2Fb.ts#L10) |",
			].join("\n\n"),
		);
		const found = links(tree);
		expect(found).toHaveLength(4);
		expect(found.filter((link) => isLocalFileHref(link.url))).toHaveLength(2);
		expect(found.map((link) => fileTargetFromHref(link.url, context))).toEqual([
			{
				deviceId: "DeviceCase",
				path: "/workspace/src/a.ts",
				selection: { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 5 },
			},
			{
				deviceId: "DeviceCase",
				path: "/workspace/docs/my notes.md",
				selection: { startLineNumber: 6, startColumn: 1, endLineNumber: 9, endColumn: 1 },
			},
			{
				deviceId: "DeviceCase",
				path: "/tmp/a.ts",
				selection: { startLineNumber: 9, startColumn: 1, endLineNumber: 10, endColumn: 1 },
			},
			{
				deviceId: "RemoteABC",
				path: "/app/b.ts",
				selection: { startLineNumber: 10, startColumn: 1, endLineNumber: 11, endColumn: 1 },
			},
		]);
		expect(found[1]?.children[0]?.type).toBe("inlineCode");
	});

	test("leaves prose and code nodes untouched even when their text resembles filenames", () => {
		const prose = "核对：实际调用只剩diff-core.test.ts、中文文件.ts。";
		const tree = parse(
			`${prose}\n\n\`中文diff-core.test.ts\`\n\n- src/a.ts#L2\n\n| File |\n|---|\n| src/b.ts |`,
		);
		expect(links(tree)).toEqual([]);
		const paragraph = tree.children[0];
		expect(paragraph?.type).toBe("paragraph");
		if (paragraph?.type !== "paragraph") throw new Error("missing paragraph");
		expect(paragraph.children).toMatchObject([{ type: "text", value: prose }]);
	});

	test("converts special explicit and reference destinations before the URL sanitizer", () => {
		const tree = parse(
			[
				"[file](file:///tmp/a.ts#L2) [windows](C:/repo/b.ts#L3)",
				"[remote](nf-file://open?device=RemoteABC&path=%2Frepo%2Fc.ts#L4)",
				"[src/label.ts][ref]\n\n[ref]: file:///tmp/d.ts#L5-L6",
			].join("\n\n"),
		);
		expect(links(tree).map((link) => fileTargetFromHref(link.url, context)?.path)).toEqual([
			"/tmp/a.ts",
			"C:/repo/b.ts",
			"/repo/c.ts",
		]);
		const definition = tree.children.find((node) => node.type === "definition");
		expect(definition?.type).toBe("definition");
		if (definition?.type !== "definition") throw new Error("missing definition");
		expect(fileTargetFromHref(definition.url, context)).toEqual({
			deviceId: "DeviceCase",
			path: "/tmp/d.ts",
			selection: { startLineNumber: 5, startColumn: 1, endLineNumber: 7, endColumn: 1 },
		});
	});

	test("does not relink existing labels, partial code, fences, HTML or math", () => {
		const tree = parse(
			[
				"[src/a.ts **`src/b.ts`**](https://example.com)",
				"[src/c.ts](javascript:alert(1))",
				"[src/d.ts][ref]\n\n[ref]: https://example.com/ref",
				"`cat src/e.ts --flag`",
				"Before <span>src/inline.ts</span> after.",
				"```ts\nsrc/f.ts\n```",
				'<div title="src/g.ts">src/h.ts</div>',
				"$x + \\text{src/i.ts}$\n\n$$\n\\text{src/j.ts}\n$$",
			].join("\n\n"),
		);
		const found = links(tree);
		expect(found.map((link) => link.url)).toEqual(["https://example.com", "javascript:alert(1)"]);
		for (const link of found) expect(link.children.flatMap(links)).toEqual([]);
	});

	test("leaves ordinary and rejected destinations to the existing sanitizer", () => {
		const destinations = [
			"src/a.ts#L2",
			"/knowledge/e1",
			"#fragment",
			"https://example.com/a.ts",
			"javascript:alert(1)",
			"data:text/plain,src/a.ts",
			"nf-file://other?device=local&path=%2Ftmp%2Fa.ts",
			"file://untrusted/tmp/a.ts",
		];
		expect(
			links(parse(destinations.map((href) => `[label](${href})`).join(" "))).map(
				(link) => link.url,
			),
		).toEqual(destinations);
	});
});
