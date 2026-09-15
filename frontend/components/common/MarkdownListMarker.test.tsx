import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { preprocessCSS, resolveConfig } from "vite";
import { MarkdownContentListItem, MarkdownListMarker } from "./MarkdownListMarker";

function block(checked: boolean) {
	return {
		kind: "inline" as const,
		lineHeight: 24,
		markerText: checked ? "[x]" : "[ ]",
		markerLeft: 6,
		taskMarker: { checked, label: "确认目录" },
	};
}

describe("MarkdownListMarker", () => {
	it("preserves task marker classes through CSS Modules and excludes flowtoken overrides", async () => {
		const file = new URL("../narrator/markdown/MarkdownContent.module.css", import.meta.url);
		const config = await resolveConfig(
			{
				configFile: false,
				css: { modules: { generateScopedName: "scoped_[local]" } },
			},
			"build",
		);
		const result = await preprocessCSS(readFileSync(file, "utf8"), file.pathname, config);
		expect(result.code).toContain("li.md-task-item");
		expect(result.code).toContain("li.task-list-item");
		expect(result.code).toContain(" .md-task-item-body");
		expect(result.code).toContain("> .vlist-task-checkbox");
		expect(result.code).toContain(":not(.vlist-task-checkbox)");
		expect(result.code).not.toContain("scoped_md-task");
	});
	it("renders disabled semantic checkboxes with SVG, never text glyphs", () => {
		for (const checked of [false, true]) {
			const html = renderToStaticMarkup(<MarkdownListMarker block={block(checked)} top={10} />);
			expect(html).toContain('type="checkbox"');
			expect(html).toContain('disabled=""');
			expect(html).toMatch(/readOnly|readonly/i);
			expect(html).toContain('aria-label="确认目录"');
			expect(html.includes('checked=""')).toBe(checked);
			expect(html.includes("<path")).toBe(checked);
			expect(html).toContain("top:16px");
			expect(html).not.toMatch(/[\u2610\u2611]/u);
			expect(html).not.toContain(checked ? "[x]" : "[ ]");
		}
	});

	it("preserves ordinary list markers and skips absent markers", () => {
		const ordinary = { ...block(false), taskMarker: undefined, markerText: "3." };
		expect(renderToStaticMarkup(<MarkdownListMarker block={ordinary} top={0} />)).toContain(
			"3.</span>",
		);
		expect(
			renderToStaticMarkup(
				<MarkdownListMarker block={{ ...ordinary, markerLeft: null }} top={0} />,
			),
		).toBe("");
	});

	it("classic markdown items use the same SVG control and drop native bullets", () => {
		const html = renderToStaticMarkup(
			<MarkdownContentListItem className="task-list-item">
				<input type="checkbox" checked disabled />
				确认目录
			</MarkdownContentListItem>,
		);
		expect(html).toContain('class="task-list-item md-task-item"');
		expect(html).toContain('type="checkbox"');
		expect(html).toContain('checked=""');
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain("aria-label");
		expect(html).toContain("<path");
		expect(html).toContain("确认目录");
		expect(html).not.toMatch(/[\u2610\u2611]/u);
	});
});
