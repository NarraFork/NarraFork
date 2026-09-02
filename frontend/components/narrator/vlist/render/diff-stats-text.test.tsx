/**
 * diff-stats-text.test.tsx — Render contract for the `+12 -3` figure.
 *
 * The user asked for COLOURED PLAIN TEXT (not badges), and colour is the only
 * channel distinguishing added from removed — so these tests assert on the produced
 * DOM rather than on the component's props:
 *
 *   1. added is green, removed is red, and they stay distinguishable
 *   2. a zero side is omitted, and an all-zero figure renders nothing at all
 *   3. nothing structural (a badge, a box, a wrapping element) is introduced, since
 *      the figure has to ride a fixed-height row without moving it
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffStatsText, hasVisibleDiffStats } from "./diff-stats-text";

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

function render(stats: { added: number; removed: number } | null | undefined): Element {
	return parse(
		renderToStaticMarkup(
			<MantineProvider forceColorScheme="dark">
				<DiffStatsText stats={stats} />
			</MantineProvider>,
		),
	);
}

const added = (root: Element) => root.querySelector("[data-nf-diff-added]");
const removed = (root: Element) => root.querySelector("[data-nf-diff-removed]");
const container = (root: Element) => root.querySelector("[data-nf-diff-stats]");

describe("DiffStatsText", () => {
	it("renders both sides with the added/removed colours", () => {
		const root = render({ added: 12, removed: 3 });
		expect(added(root)?.textContent).toBe("+12");
		expect(removed(root)?.textContent).toBe("-3");
		// Colour is the whole point: green for added, red for removed, and never equal.
		const addedColor = added(root)?.getAttribute("style") ?? "";
		const removedColor = removed(root)?.getAttribute("style") ?? "";
		expect(addedColor).toContain("green");
		expect(removedColor).toContain("red");
		expect(addedColor).not.toBe(removedColor);
	});

	it("omits a zero side rather than printing `-0`", () => {
		// A trailing `-0` is a token the reader must parse to learn nothing.
		const pureAdd = render({ added: 240, removed: 0 });
		expect(added(pureAdd)?.textContent).toBe("+240");
		expect(removed(pureAdd)).toBeNull();

		const pureDelete = render({ added: 0, removed: 18 });
		expect(added(pureDelete)).toBeNull();
		expect(removed(pureDelete)?.textContent).toBe("-18");
	});

	it("renders nothing for an all-zero or absent figure", () => {
		// Absent means "not measured" and zero means "changed nothing". Both are silent
		// on screen; the distinction lives in the DATA (see resolveFileDiffStats).
		for (const stats of [null, undefined, { added: 0, removed: 0 }] as const) {
			const root = render(stats);
			expect(container(root)).toBeNull();
			expect(added(root)).toBeNull();
			expect(removed(root)).toBeNull();
			// No visible text either. Read past the provider's injected <style> blocks,
			// which are not rendered content — asserting on `root.textContent` alone
			// would measure Mantine's stylesheet rather than this component.
			const visibleText = [...root.childNodes]
				.filter((node) => (node as Element).tagName?.toLowerCase() !== "style")
				.map((node) => node.textContent ?? "")
				.join("");
			expect(visibleText).toBe("");
		}
	});

	/**
	 * No badge, per the requested design — and structurally it must stay a plain
	 * inline run, because it shares a row whose height is measured without it.
	 */
	it("is plain inline text: no badge, no border, no background", () => {
		const root = render({ added: 12, removed: 3 });
		const box = container(root);
		expect(box?.tagName.toLowerCase()).toBe("span");
		expect(added(root)?.tagName.toLowerCase()).toBe("span");
		const style = box?.getAttribute("style") ?? "";
		expect(style).not.toContain("border");
		expect(style).not.toContain("background");
		expect(style).not.toContain("padding");
		// Mantine's Badge class must not appear anywhere in the subtree.
		expect(root.querySelector(".mantine-Badge-root")).toBeNull();
	});

	it("cannot be wrapped or shrunk away by a long neighbouring title", () => {
		// It sits after a truncating path; a shrinkable cell would be clipped to "+1…"
		// exactly in the rows where the size of the edit matters most.
		const style = container(render({ added: 4820, removed: 3910 }))?.getAttribute("style") ?? "";
		expect(style).toContain("nowrap");
		expect(style).toMatch(/flex-shrink:\s*0/);
	});

	it("exposes the figure to assistive technology, which cannot see the colours", () => {
		const box = container(render({ added: 12, removed: 3 }));
		expect(box?.getAttribute("aria-label")).toBe("+12 -3");
		// The ROLE is load-bearing: on a roleless <span> an aria-label is ignored, so
		// dropping this would silently reduce the label to decoration.
		expect(box?.getAttribute("role")).toBe("img");
	});

	it("omits a zero side from the label too, matching what is drawn", () => {
		// A label that announces `-0` for a figure rendered as `+240` describes a number
		// the sighted reader never sees, which is exactly how a label stops being trusted.
		expect(container(render({ added: 240, removed: 0 }))?.getAttribute("aria-label")).toBe("+240");
		expect(container(render({ added: 0, removed: 7 }))?.getAttribute("aria-label")).toBe("-7");
	});
});

describe("hasVisibleDiffStats", () => {
	it("treats absent and all-zero alike, and any change as visible", () => {
		expect(hasVisibleDiffStats(null)).toBe(false);
		expect(hasVisibleDiffStats(undefined)).toBe(false);
		expect(hasVisibleDiffStats({ added: 0, removed: 0 })).toBe(false);
		expect(hasVisibleDiffStats({ added: 1, removed: 0 })).toBe(true);
		expect(hasVisibleDiffStats({ added: 0, removed: 1 })).toBe(true);
	});
});
