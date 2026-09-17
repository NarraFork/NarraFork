import { afterAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { createDiffDocument, projectDiffDocument } from "@shared/pretext-layout/diff-core";
import { parseHTML } from "linkedom";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView } from "./DiffView";

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");
const restoreCanvas = installCanvasStub();
afterAll(restoreCanvas);

function renderViewport(props: Partial<ComponentProps<typeof DiffView>>) {
	const html = renderToStaticMarkup(
		createElement(
			MantineProvider,
			{},
			createElement(DiffView, { oldStr: "old", newStr: "new", ...props }),
		),
	);
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	const viewport = document.querySelector<HTMLElement>("[data-content-scrollport]");
	if (!viewport) throw new Error("scrollport missing");
	return viewport;
}

describe("DiffView explicit viewport layout", () => {
	test("forwards declared dimensions and uses one explicit padding value", () => {
		const viewport = renderViewport({ layout: { width: 320, height: 120 }, maxHeight: 500 });
		expect(viewport.getAttribute("data-content-geometry")).toBe("layout");
		expect(viewport.style.width).toBe("320px");
		expect(viewport.style.height).toBe("120px");
		expect(viewport.style.maxHeight).toBe("120px");
		expect(viewport.style.padding).toBe("0");
		expect(viewport.querySelector("[data-content-box]")?.getAttribute("style")).toContain(
			"padding:10px 10px",
		);
	});

	test("does not invent a layout from a Git-style maxHeight", () => {
		const viewport = renderViewport({ maxHeight: 500 });
		expect(viewport.getAttribute("data-content-geometry")).toBe("dom");
		expect(viewport.style.maxHeight).toBe("500px");
		expect(viewport.style.width).toBeFalsy();
		expect(viewport.style.padding).toBe("0");
		expect(viewport.querySelector("[data-content-box]")?.getAttribute("style")).toContain(
			"padding:10px 10px",
		);
	});
});

describe("DiffView line-ending handling", () => {
	test("does not report CRLF, LF, and CR as content changes", () => {
		const lines = projectDiffDocument(
			createDiffDocument({
				oldText: "first\r\nsecond\rthird\r\n",
				newText: "first\nsecond\nthird\n",
			}),
		).lines;

		expect(lines).toHaveLength(3);
		expect(lines.every((line) => line.type === "context")).toBe(true);
		expect(lines.map((line) => line.content)).toEqual(["first", "second", "third"]);
	});

	test("still reports a real replacement when line endings differ", () => {
		const lines = projectDiffDocument(
			createDiffDocument({
				oldText: "plugins {\r\n  `java-library`\r\n}\r\n",
				newText: "plugins {\n  `maven-publish`\n}\n",
			}),
		).lines;

		expect(lines.filter((line) => line.type === "removed").map((line) => line.content)).toEqual([
			"  `java-library`",
		]);
		expect(lines.filter((line) => line.type === "added").map((line) => line.content)).toEqual([
			"  `maven-publish`",
		]);
		expect(lines.filter((line) => line.type === "context").map((line) => line.content)).toEqual([
			"plugins {",
			"}",
		]);
	});

	test("preserves ordinary whitespace changes", () => {
		const lines = projectDiffDocument(
			createDiffDocument({
				oldText: "const value = 1;\r\n",
				newText: "const value =  1;\n",
			}),
		).lines;

		expect(lines.some((line) => line.type === "removed")).toBe(true);
		expect(lines.some((line) => line.type === "added")).toBe(true);
	});
});
