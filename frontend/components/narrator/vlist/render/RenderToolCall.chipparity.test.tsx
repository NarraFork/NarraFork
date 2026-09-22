/**
 * RenderToolCall.chipparity.test.tsx — an expanded tool card header and a folded
 * trace row paint the SAME category chip for the same call.
 *
 * The two surfaces used to differ in implementation: folded rows used Mantine
 * `ThemeIcon variant="light"`, while the card header hand-rolled
 * `--mantine-color-*-light` + shade-6. Same category colour name, different
 * resolved tint — drilling in a Bash call made the chip jump colour.
 *
 * Both now go through `CategoryChip`. This suite renders the real measure →
 * render chain for both forms and compares the chip's observable identity
 * (size, variant path, colour token, glyph), not a hard-coded list of Mantine
 * class hashes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallData } from "../measure/measure-tool-call";
import { measureActivityTrace } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolCall } from "./RenderToolCall";
import { RenderToolRun } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let measureToolCall: typeof import("../measure/measure-tool-call").measureToolCall;

beforeAll(async () => {
	measureToolCall = (await import("../measure/measure-tool-call")).measureToolCall;
});

const WIDTH = 600;
const LOD = 5;

const CALLS = [
	{ toolName: "Bash", summary: "bun test", category: "bash", status: "success" },
	{ toolName: "Read", summary: "loop.ts", category: "read", status: "success" },
	{ toolName: "Grep", summary: "pattern", category: "search", status: "success" },
] as const;

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

function foldedChipRoot(call: (typeof CALLS)[number]): Element {
	const measured = measureActivityTrace(
		[
			{
				title: `${call.toolName} · ${call.summary}`,
				hasIcon: true,
				category: call.category,
				toolName: call.toolName,
				key: call.toolName,
				status: call.status,
			},
		],
		WIDTH,
	);
	return render(<RenderToolRun measured={measured} />);
}

function cardHeaderChipRoot(call: (typeof CALLS)[number]): Element {
	const measured = measureToolCall({ ...call } as ToolCallData, WIDTH, LOD);
	return render(<RenderToolCall measured={measured} />);
}

function firstChip(root: Element, selector: string): HTMLElement {
	const el = root.querySelector(selector);
	if (!el) throw new Error(`chip not found: ${selector}`);
	return el as unknown as HTMLElement;
}

/**
 * Observable chip identity: Mantine size/variant/color attributes plus the
 * Tabler glyph. `class` is a build artefact and test ids differ by call site.
 */
function chipSignature(chip: HTMLElement): string {
	const glyph = chip.querySelector("svg");
	const attributes = chip
		.getAttributeNames()
		.filter(
			(name) =>
				name !== "class" &&
				!name.startsWith("data-testid") &&
				!name.startsWith("data-trace") &&
				!name.startsWith("data-nf-card"),
		)
		.sort()
		.map((name) => `${name}=${chip.getAttribute(name) ?? ""}`)
		.join(";");
	const glyphName =
		/tabler-icon-([a-z0-9-]+)/.exec(String(glyph?.getAttribute("class") ?? ""))?.[1] ?? "";
	const width = glyph?.getAttribute("width") ?? "";
	return `${attributes}|${width}|${glyphName}`;
}

describe("category chip parity — card header vs folded trace row", () => {
	it("paints the same chip identity for each tool category", () => {
		for (const call of CALLS) {
			const folded = chipSignature(firstChip(foldedChipRoot(call), "[data-trace-row-chip]"));
			const card = chipSignature(firstChip(cardHeaderChipRoot(call), "[data-nf-card-header-chip]"));
			expect(card, `${call.toolName} card header chip`).toBe(folded);
		}
	});

	it("marks both lanes with their own stable data attribute", () => {
		const call = CALLS[0];
		const foldedRoot = foldedChipRoot(call);
		const cardRoot = cardHeaderChipRoot(call);
		expect(foldedRoot.querySelectorAll("[data-trace-row-chip]").length).toBe(1);
		expect(cardRoot.querySelectorAll("[data-nf-card-header-chip]").length).toBe(1);
		// The card header must not also claim the folded-row marker (and vice versa).
		expect(cardRoot.querySelector("[data-trace-row-chip]")).toBeNull();
		expect(foldedRoot.querySelector("[data-nf-card-header-chip]")).toBeNull();
	});

	it("resolves Bash chips to orange on both surfaces", () => {
		const folded = firstChip(foldedChipRoot(CALLS[0]), "[data-trace-row-chip]");
		const card = firstChip(cardHeaderChipRoot(CALLS[0]), "[data-nf-card-header-chip]");
		// ThemeIcon light injects --ti-bg / --ti-color from the colour prop; both
		// components pass the same CATEGORY_COLOR value, so the colour attribute
		// (or the CSS var it maps to) must match and name orange.
		const foldedColor =
			folded.getAttribute("color") ?? folded.getAttribute("style") ?? String(folded);
		const cardColor = card.getAttribute("color") ?? card.getAttribute("style") ?? String(card);
		expect(foldedColor).toContain("orange");
		expect(cardColor).toContain("orange");
		expect(foldedColor).toBe(cardColor);
	});
});
