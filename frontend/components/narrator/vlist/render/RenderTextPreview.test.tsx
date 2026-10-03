import { afterAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

const dispose = installCanvasStub();
afterAll(dispose);
const { measureTextPreview } = await import("../measure/measure-text-preview");
const { RenderTextPreview } = await import("./RenderTextPreview");
const { RenderToolRun } = await import("./RenderToolRun");
const { measureCollapsibleTrace } = await import("../measure/measure-tool-run");

function paint(
	source: string,
	opts: { expanded?: boolean; showSource?: boolean; tail?: boolean } = {},
) {
	const measured = measureTextPreview(source, 400, {
		textExpanded: opts.expanded,
		direction: opts.tail ? "tail" : "head",
	});
	const markup = renderToStaticMarkup(
		<MantineProvider>
			<RenderTextPreview
				measured={measured}
				showSource={opts.showSource}
				sourceText={source}
				onToggleTextExpanded={() => {}}
				textPreviewLabels={{ expand: "展开", collapse: "收起" }}
			/>
		</MantineProvider>,
	);
	return { measured, doc: parseHTML(`<html><body>${markup}</body></html>`).document };
}

function find(
	node: ReactNode,
	attribute: string,
): ReactElement<Record<string, unknown>> | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = find(child, attribute);
			if (found) return found;
		}
		return undefined;
	}
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (attribute in node.props) return node;
	return find(node.props.children as ReactNode, attribute);
}

describe("bounded DOM text preview", () => {
	test("huge paragraph mounts only visible lines; expanded mounts its full final text", () => {
		const source = `${"word ".repeat(5000)}FINAL_MARKER`;
		const preview = paint(source);
		expect(preview.doc.querySelectorAll("[data-vlist-line]").length).toBeLessThanOrEqual(12);
		expect(preview.doc.body.textContent).not.toContain("FINAL_MARKER");
		expect(preview.doc.querySelector("[data-vlist-text-preview-toggle]")?.textContent).toBe("展开");
		const full = paint(source, { expanded: true });
		expect(full.doc.body.textContent).toContain("FINAL_MARKER");
		expect(
			full.doc.querySelector("[data-vlist-text-preview-toggle]")?.getAttribute("aria-expanded"),
		).toBe("true");
	});
	test("large code only materializes the visible rows and never offers truncated copy", () => {
		const source = `\`\`\`ts\n${"const value = 1;\n".repeat(1000)}CODE_END\n\`\`\``;
		const result = paint(source);
		expect(result.doc.querySelectorAll("[data-vlist-code-line]").length).toBeLessThan(20);
		expect(result.doc.body.textContent).not.toContain("CODE_END");
		expect(result.doc.querySelector("[data-vlist-code-copy]")).toBeNull();
	});
	test("a tall table row materializes only visible cell lines, not its hidden huge body", () => {
		const source = `| head |\n| --- |\n| ${"word ".repeat(2500)}CELL_END |`;
		const result = paint(source);
		expect(result.doc.querySelectorAll("[data-vlist-line]").length).toBeLessThan(20);
		expect(result.doc.body.textContent).not.toContain("CELL_END");
	});
	test("many table rows do not mount below the viewport", () => {
		const source = `| head |\n| --- |\n${"| body |\n".repeat(500)}| ROW_END |`;
		const result = paint(source);
		expect(result.doc.querySelectorAll("[data-vlist-table-row]").length).toBeLessThan(12);
		expect(result.doc.body.textContent).not.toContain("ROW_END");
	});
	test("source mode is bounded too, even when passed the full original", () => {
		const source = `${"**word** ".repeat(3000)}SOURCE_END`;
		const result = paint(source, { showSource: true });
		expect(result.doc.body.textContent).not.toContain("SOURCE_END");
		expect(result.doc.querySelectorAll("[data-vlist-source-line]").length).toBeLessThan(20);
		const full = paint(source, { expanded: true, showSource: true });
		expect(full.doc.body.textContent).toContain("SOURCE_END");
	});
	test("unclipped Markdown keeps the complete source scrollable without a disclosure button", () => {
		// Soft breaks occupy little rendered height, but many pre-wrap source rows.
		const source = `${"word\n".repeat(20)}LAST`;
		const result = paint(source, { showSource: true });
		expect(result.measured.textPreview?.clipped).toBe(false);
		expect(result.doc.querySelector("[data-vlist-text-preview-toggle]")).toBeNull();
		const sourceBody = result.doc.querySelector("[data-vlist-markdown-source]");
		expect(sourceBody?.textContent).toBe(source);
		expect(sourceBody?.getAttribute("style")).toContain("overflow-y:auto");
		expect(sourceBody?.getAttribute("style")).toContain(
			`height:${result.measured.frame.contentHeight}px`,
		);
	});

	test("live tail shows literal newest text with top disclosure", () => {
		const source = `${"old line\n".repeat(2000)}**NEWEST**`;
		const result = paint(source, { tail: true });
		expect(result.doc.body.textContent).toContain("**NEWEST**");
		expect(result.doc.querySelectorAll("[data-vlist-line]").length).toBeLessThanOrEqual(12);
		expect(
			result.doc.querySelector("[data-vlist-text-preview-toggle]")?.getAttribute("style"),
		).toContain("top:0");
	});
	test("plain live tails preserve indentation rather than collapsing whitespace", () => {
		const result = paint(`${"old text\n".repeat(1500)}    newest  text`, { tail: true });
		expect(result.doc.body.textContent).toContain("    newest  text");
		expect(result.doc.querySelector("[data-vlist-plain-text]")).not.toBeNull();
	});
	test("short text reserves no control or blank footer", () => {
		const result = paint("short");
		expect(result.doc.querySelector("[data-vlist-text-preview-toggle]")).toBeNull();
		expect(result.measured.height).toBe(result.measured.frame.contentHeight);
	});
	test("native disclosure stops ancestor selection and sends the right body key", () => {
		const measured = measureTextPreview("text ".repeat(3000), 400);
		const calls: unknown[][] = [];
		let stopped = false;
		for (const bodyKey of [undefined, "stable-step"] as const) {
			const node = RenderTextPreview({
				measured,
				bodyKey,
				onToggleTextExpanded: (...args) => calls.push(args),
			});
			const button = find(node, "data-vlist-text-preview-toggle");
			(button?.props.onClick as (event: { stopPropagation: () => void }) => void)({
				stopPropagation: () => {
					stopped = true;
				},
			});
		}
		expect(stopped).toBe(true);
		expect(calls).toEqual([[], ["stable-step"]]);
	});
	test("tool-run row body forwards the same fallback key used by measurement", () => {
		const measured = measureCollapsibleTrace(
			{ variant: "reasoning-steps", items: [{ title: "Step", bodyText: "word ".repeat(4000) }] },
			400,
			{ expandedIndices: [0] },
		);
		const markup = renderToStaticMarkup(
			<MantineProvider>
				<RenderToolRun measured={measured} onToggleTextExpanded={() => {}} />
			</MantineProvider>,
		);
		expect(markup).toContain("data-vlist-text-preview-toggle");
		expect(measured.rows[0]?.key).toBe("0");
	});
});
