import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import { createDiffDocument, MAX_DIFF_LINES } from "@shared/pretext-layout/diff-core";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffContent } from "../../diff/DiffContent";
import { AutoFollowScroll } from "../../scroll/AutoFollowScroll";
import { measureToolCall } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolCall } from "./RenderToolCall";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);

function parse(html: string): HTMLElement {
	const { document } = parseHTML(`<!doctype html><html><body><main>${html}</main></body></html>`);
	return document.querySelector("main") as unknown as HTMLElement;
}
function projection(live: boolean, size: number) {
	const text = Array.from({ length: size }, (_, i) => `line ${i}`).join("\n");
	const document = createDiffDocument({ oldText: "", newText: text, focusSide: "new" });
	const root = parse(
		renderToStaticMarkup(
			<MantineProvider>
				<AutoFollowScroll
					bodyId="edit"
					live={live}
					followTarget="row"
					layout={{ width: 600, height: 200 }}
					viewportStyle={{ height: 200 }}
				>
					<DiffContent document={document} contentWidth={600} />
				</AutoFollowScroll>
			</MantineProvider>,
		),
	);
	const painter = root.querySelector("[data-diff-content]");
	if (!painter) throw new Error("diff painter not found");
	return { root, document, painter };
}

describe("source projection replaces the old prefix reveal chain", () => {
	it("selects a live focus beyond row 500 without expanding the document", () => {
		const { painter, document } = projection(true, 2_000);
		const start = Number(painter.getAttribute("data-diff-projection-start"));
		const count = Number(painter.getAttribute("data-diff-projection-count"));
		expect(start).toBeGreaterThan(500);
		expect(count).toBeLessThanOrEqual(MAX_DIFF_LINES);
		expect(start + count).toBe(document.totalRows);
	});
	it("a static reader starts at the first source row, not the latest focus", () => {
		const { painter } = projection(false, 2_000);
		expect(Number(painter.getAttribute("data-diff-projection-start"))).toBe(0);
	});
	it("two viewports of the same immutable source choose different projections", () => {
		const text = "a\n".repeat(1_000);
		const document = createDiffDocument({ oldText: text, newText: `${text}tail` });
		const root = parse(
			renderToStaticMarkup(
				<MantineProvider>
					<AutoFollowScroll
						bodyId="edit"
						live
						followTarget="row"
						layout={{ width: 600, height: 200 }}
					>
						<DiffContent document={document} />
					</AutoFollowScroll>
					<AutoFollowScroll bodyId="edit" followTarget="row" layout={{ width: 600, height: 200 }}>
						<DiffContent document={document} />
					</AutoFollowScroll>
				</MantineProvider>,
			),
		);
		const painters = [...root.querySelectorAll("[data-diff-content]")];
		expect(painters).toHaveLength(2);
		expect(painters[0]?.getAttribute("data-diff-document-revision")).toBe(
			painters[1]?.getAttribute("data-diff-document-revision"),
		);
		expect(painters[0]?.getAttribute("data-diff-projection-start")).not.toBe(
			painters[1]?.getAttribute("data-diff-projection-start"),
		);
	});
	it("keeps a small diff completely painted", () => {
		const { root } = projection(false, 3);
		expect(root.querySelectorAll("[data-diff-row]")).toHaveLength(3);
	});
	it("the real tool renderer uses the same source document and painter", () => {
		const detail = classifyToolDetail({
			toolUseId: "edit",
			toolName: "Edit",
			category: "file",
			status: "running",
			isStreaming: true,
			inputJson: {
				old_string: "old",
				_streamingFieldName: "new_string",
				_streamingFieldValue: "new\n".repeat(700),
			},
		});
		const measured = measureToolCall(
			{
				toolUseId: "edit",
				toolName: "Edit",
				category: "file",
				status: "running",
				isStreaming: true,
				summary: "edit",
				detail,
			},
			620,
			5,
		);
		const root = parse(
			renderToStaticMarkup(
				<MantineProvider>
					<RenderToolCall measured={measured} />
				</MantineProvider>,
			),
		);
		expect(root.querySelectorAll("[data-content-scrollport]")).toHaveLength(1);
		expect(root.querySelectorAll("[data-diff-content]")).toHaveLength(1);
		expect(
			Number(root.querySelector("[data-diff-content]")?.getAttribute("data-diff-projection-start")),
		).toBeGreaterThan(0);
	});
	it("does not retain a second painter or IntersectionObserver reveal implementation", () => {
		const tool = readFileSync(join(import.meta.dir, "RenderToolCall.tsx"), "utf8");
		const diff = readFileSync(join(import.meta.dir, "../../diff/DiffContent.tsx"), "utf8");
		for (const name of [
			"__TEST__DiffLines",
			"function DiffBody",
			"useDiffRowReveal",
			"IntersectionObserver",
			"slice(0, rowLimit)",
		]) {
			expect(tool).not.toContain(name);
			expect(diff).not.toContain(name);
		}
	});
});
