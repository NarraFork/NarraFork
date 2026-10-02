import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { parseStructured, type StructuredNode } from "../file-viewer/structured-parse";
import {
	buildAnchors,
	collectPreviewAnchors,
	lineForScrollTop,
	observePreviewAnchorChanges,
	scrollTopForLine,
} from "./editor-scroll-sync";

// A document where block heights are deliberately NON-linear in line count.
const anchors = buildAnchors([
	{ line: 0, top: 0, height: 100 },
	{ line: 3, top: 100, height: 150 },
	{ line: 13, top: 250, height: 300 },
	{ line: 14, top: 550, height: 50 },
	// Same as VS Code's final data-line sentinel at markdownDocument.lineCount.
	{ line: 15, top: 600, height: 1 },
]);

test("buildAnchors sorts, truncates heights to the next anchor and dedupes lines", () => {
	const built = buildAnchors([
		{ line: 4, top: 200, height: 40 },
		{ line: 0, top: 0, height: 500 }, // contains the others
		{ line: 2, top: 100, height: 40 },
		{ line: 2, top: 120, height: 40 }, // same source line as previous
	]);
	expect(built).toEqual([
		{ line: 0, top: 0, height: 100 },
		{ line: 2, top: 100, height: 40 },
		{ line: 4, top: 200, height: 40 },
	]);
});

test("scrollTopForLine is exact at anchor lines", () => {
	expect(scrollTopForLine(anchors, 0)).toBe(0);
	expect(scrollTopForLine(anchors, 3)).toBe(100);
	expect(scrollTopForLine(anchors, 13)).toBe(250);
	expect(scrollTopForLine(anchors, 14)).toBe(550);
});

test("scrollTopForLine interpolates inside a block's pixel span", () => {
	// Lines inside a multi-line block reveal the block's own midway pixels, so
	// walking the source through the block walks the preview through it.
	expect(scrollTopForLine(anchors, 8)).toBe(175);
	expect(scrollTopForLine(anchors, 4)).toBe(115);
	expect(scrollTopForLine(anchors, -5)).toBe(0);
});

test("a multi-source-line table no longer collapses to a single jump", () => {
	// Table: source lines 10..29 rendered as ONE anchored wrapper 400px tall,
	// paragraph anchors on either side. The old block-end+gap mapping pinned
	// the preview to the table's bottom edge for every line inside it.
	const tableAnchors = buildAnchors([
		{ line: 0, top: 0, height: 50 },
		{ line: 10, top: 50, height: 400 },
		{ line: 30, top: 450, height: 40 },
		{ line: 40, top: 490, height: 1 },
	]);
	expect(scrollTopForLine(tableAnchors, 10)).toBe(50);
	expect(scrollTopForLine(tableAnchors, 20)).toBe(250);
	expect(scrollTopForLine(tableAnchors, 29)).toBeCloseTo(50 + (19 / 20) * 400, 5);
});

test("scrollTopForLine and lineForScrollTop round-trip", () => {
	for (const line of [0, 1, 3, 4.5, 8, 12.9, 13, 13.5, 14]) {
		const top = scrollTopForLine(anchors, line);
		expect(top).not.toBeNull();
		expect(lineForScrollTop(anchors, top as number, 15, 10)).toBeCloseTo(line, 5);
	}
});

test("lineForScrollTop interpolates the visible block interval", () => {
	expect(lineForScrollTop(anchors, 0, 20, 10)).toBe(0);
	expect(lineForScrollTop(anchors, 100, 20, 10)).toBe(3);
	expect(lineForScrollTop(anchors, 250, 20, 10)).toBe(13);
	// Midway through the block from source line 3 to source line 13.
	expect(lineForScrollTop(anchors, 175, 20, 10)).toBe(8);
	// The sentinel bounds the tail at the document line count.
	expect(lineForScrollTop(anchors, 650, 15, 10)).toBe(15);
	expect(lineForScrollTop(anchors, 99999, 20, 10)).toBe(20);
});

test("empty anchors degrade gracefully", () => {
	expect(scrollTopForLine([], 5)).toBeNull();
	expect(lineForScrollTop([], 100, 20, 10)).toBe(0);
});

test("lines before the first source anchor interpolate from the origin, never NaN", () => {
	const leading = buildAnchors([
		{ line: 4, top: 80, height: 20 },
		{ line: 8, top: 160, height: 1 },
	]);
	for (const line of [0.1, 1, 2, 3.9, 4]) {
		const top = scrollTopForLine(leading, line) as number;
		expect(Number.isFinite(top)).toBe(true);
		expect(top).toBeCloseTo(line * 20);
		expect(lineForScrollTop(leading, top, 8)).toBeCloseTo(line);
	}
	expect(scrollTopForLine([{ line: 2, top: 0, height: 20 }], 1)).toBe(0);
});

function treeEntries(nodes: StructuredNode[]) {
	const flattened: StructuredNode[] = [];
	const walk = (rows: StructuredNode[]) => {
		for (const node of rows) {
			flattened.push(node);
			if (node.kind === "branch") walk(node.children);
		}
	};
	walk(nodes);
	return flattened.map((node, i) => ({ line: node.line ?? 0, top: i * 20, height: 20 }));
}

for (const [format, text, lines] of [
	["json", '{\n "2":"two",\n "1":"one"\n}', [2, 1]],
	["ini", "[a]\nx=one\n[b]\ny=two\n[a]\nz=three", [0, 1, 5, 2, 3]],
] as const) {
	test(`${format}: non-source-order semantic tree uses proportional fallback`, () => {
		const parsed = parseStructured(text, format);
		if ("error" in parsed) throw new Error(parsed.error);
		const entries = treeEntries(parsed.nodes);
		expect(entries.map((entry) => entry.line)).toEqual([...lines]);
		// Includes the real collector's document-end sentinel: it must not hide
		// a reversal or leave a misleading partial anchor map behind.
		const built = buildAnchors([...entries, { line: 8, top: 200, height: 1 }]);
		expect(built).toEqual([]);
		expect(scrollTopForLine(built, 1)).toBeNull();
	});
}

test("invalid anchor geometry cannot produce a non-finite target", () => {
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(scrollTopForLine(anchors, bad)).toBeNull();
		expect(lineForScrollTop(anchors, bad, 15)).toBe(0);
		for (const field of ["line", "top", "height"]) {
			expect(buildAnchors([{ line: 1, top: 20, height: 20, [field]: bad }])).toEqual([]);
		}
	}
});

test("data-line-only preview updates refresh cached mapping, debounce and cancel safely", async () => {
	const { window } = parseHTML(
		'<div id="preview"><div data-line="1"></div><div data-line="2"></div></div>',
	);
	const originals = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		HTMLElement: window.HTMLElement,
		MutationObserver: window.MutationObserver,
		ResizeObserver: undefined,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const scroller = window.document.getElementById("preview") as unknown as HTMLElement;
	const rect = (top: number, height: number) => ({ top, height }) as DOMRect;
	scroller.getBoundingClientRect = () => rect(0, 120);
	scroller.scrollTop = 0;
	Object.defineProperty(scroller, "scrollHeight", { value: 120 });
	const rows = [...scroller.querySelectorAll<HTMLElement>("[data-line]")];
	rows.forEach((row, i) => {
		row.getBoundingClientRect = () => rect(20 + i * 40, 20);
	});
	let cached = collectPreviewAnchors(scroller, 4);
	let refreshes = 0;
	const observer = observePreviewAnchorChanges(scroller, () => {
		refreshes++;
		cached = collectPreviewAnchors(scroller, 8);
		// Programmatic follower writes must not trigger another invalidation.
		scroller.scrollTop = scrollTopForLine(cached, 5) ?? 0;
		scroller.style.setProperty("height", "120px");
	});
	try {
		expect(scrollTopForLine(cached, 2)).toBe(60);
		// Same elements, geometry and text: inserting blank source lines updates
		// only these attributes, not childList or ResizeObserver.
		rows[0].setAttribute("data-line", "5");
		rows[1].setAttribute("data-line", "6");
		expect(refreshes).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(refreshes).toBe(1);
		expect(cached.map((anchor) => anchor.line)).toEqual([5, 6, 8]);
		expect(scrollTopForLine(cached, 2)).toBe(8);
		expect(lineForScrollTop(cached, 60, 8)).toBe(6);
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(refreshes).toBe(1); // no style/scroll feedback loop
		// Explicit preview commits refresh the model-dependent sentinel even
		// without a DOM mutation, and use the same coalescing path.
		observer.schedule();
		observer.schedule();
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(refreshes).toBe(2);
		observer.schedule();
		observer.dispose();
		observer.schedule(); // stale commit callback after unmount is harmless
		rows[0].setAttribute("data-line", "7");
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(refreshes).toBe(2);
	} finally {
		observer.dispose();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("anchorless preview does not acquire a misleading sentinel-only map", () => {
	const { window } = parseHTML("<div></div>");
	const scroller = window.document.querySelector("div") as unknown as HTMLElement;
	scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
	expect(collectPreviewAnchors(scroller, 50)).toEqual([]);
});
