import { afterAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { createDiffDocument } from "@shared/pretext-layout/diff-core";
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContentViewportLayout } from "../AutoFollowScroll";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VListViewBody } from "./vlist-content-view-body";
import type { VListViewTarget } from "./vlist-content-view-target";

const restoreCanvas = installCanvasStub();
afterAll(restoreCanvas);
const document = createDiffDocument({ oldText: "before", newText: "after" });
const model: ToolCappedDetail = {
	kind: "capped",
	id: "edit:input.edit",
	source: "input.edit",
	cap: "diff",
	format: "diff",
	live: false,
	followTarget: { kind: "diff-row", focus: document.focus },
	diffDocument: document,
};
const target: VListViewTarget = {
	id: model.id,
	slot: model.source,
	owner: { specKey: "row" },
	kind: "diff",
	text: "",
	model,
};

function viewport(layout?: ContentViewportLayout, viewTarget = target, style?: CSSProperties) {
	const html = renderToStaticMarkup(
		<MantineProvider>
			<VListViewBody
				target={viewTarget}
				text={viewTarget.text}
				wordWrap
				showSource={false}
				layout={layout}
				style={style}
			/>
		</MantineProvider>,
	);
	const parsed = parseHTML(`<html><body>${html}</body></html>`);
	const node = parsed.document.querySelector<HTMLElement>("[data-content-scrollport]");
	if (!node) throw new Error("fullscreen body viewport missing");
	return node;
}

describe("fullscreen body layout wiring", () => {
	test("uses its own declared box and the default zero content inset", () => {
		const node = viewport({ width: 720, height: 340 });
		expect(node.getAttribute("data-content-geometry")).toBe("layout");
		expect(node.style.width).toBe("720px");
		expect(node.style.height).toBe("340px");
		expect(node.querySelector<HTMLElement>("[data-content-box]")?.style.padding).toBe("0px 0px");
	});
	test("ignores implicit CSS padding when a Diff layout is declared", () => {
		const node = viewport({ width: 720, height: 340 }, target, { padding: 27 });
		expect(node.querySelector<HTMLElement>("[data-content-box]")?.style.padding).toBe("0px 0px");
	});

	for (const kind of ["code", "markdown"] as const) {
		test(`${kind} stays DOM-owned even when layout is supplied`, () => {
			const node = viewport(
				{ width: 720, height: 340 },
				{ ...target, kind, model: undefined, text: "body" },
			);
			expect(node.getAttribute("data-content-geometry")).toBe("dom");
			expect(node.style.height).toBe("100%");
			expect(node.style.width).toBeFalsy();
		});
	}

	test("keeps existing CSS fullscreen entry explicitly on the DOM path", () => {
		const node = viewport();
		expect(node.getAttribute("data-content-geometry")).toBe("dom");
		expect(node.style.height).toBe("100%");
		expect(node.style.width).toBeFalsy();
	});
});
