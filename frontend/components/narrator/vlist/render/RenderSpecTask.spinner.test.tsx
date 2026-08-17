/**
 * RenderSpecTask.spinner.test.tsx — the animation gate on a Dynamic Spec task row.
 *
 * A task's status is RECORDED, not live: every digest ever injected keeps whatever was
 * `doing` when it was written. Animating on the status alone therefore set the entire
 * scrollback spinning, with a dozen bubbles each claiming to be working right now.
 *
 * Two properties are locked here:
 *   1. a `doing` row does NOT animate unless the bubble is marked `live`;
 *   2. a live row animates as a LOADER, not as a spinning "play" triangle — a play
 *      glyph reads as a control being operated rather than as work in flight.
 *
 * Read off the produced DOM (the spin class + the rendered svg), so a change that keeps
 * the prop but drops either half of the behaviour still fails.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

let measureSpecTask: typeof import("../measure/measure-spec-task").measureSpecTask;
let RenderSpecTask: typeof import("./RenderSpecTask").RenderSpecTask;

beforeAll(async () => {
	// Task rows are pretext-measured inline blocks (canvas measureText).
	installCanvasStub();
	measureSpecTask = (await import("../measure/measure-spec-task")).measureSpecTask;
	RenderSpecTask = (await import("./RenderSpecTask")).RenderSpecTask;
});

const WIDTH = 600;

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

/** Render a one-row digest at the shared width, live or not. */
function renderRow(role: string, live: boolean): Element {
	const data = { text: "run the affected tests", tasks: [{ text: "run tests", role }] };
	const measured = measureSpecTask(data, WIDTH);
	return render(<RenderSpecTask measured={measured} data={data} live={live} />);
}

function spinCount(root: Element): number {
	return root.querySelectorAll(".vlist-spin").length;
}

/** Tabler renders its icon name onto the svg class list (`tabler-icon-<name>`). */
function iconNames(root: Element): string[] {
	return Array.from(root.querySelectorAll("svg")).flatMap((svg) =>
		(svg.getAttribute("class") ?? "")
			.split(/\s+/)
			.filter((cls) => cls.startsWith("tabler-icon-") && cls !== "tabler-icon"),
	);
}

describe("RenderSpecTask — the spinner is gated on `live`", () => {
	it("does not animate a recorded `doing` row", () => {
		const root = renderRow("doing", false);
		expect(spinCount(root)).toBe(0);
	});

	it("animates the live `doing` row", () => {
		const root = renderRow("doing", true);
		expect(spinCount(root)).toBe(1);
	});

	it("never animates a non-`doing` row, even on the live bubble", () => {
		for (const role of ["todo", "next", "done", "blocked"]) {
			expect(spinCount(renderRow(role, true))).toBe(0);
		}
	});

	it("a blocked row stays still even when its role says doing", () => {
		const data = { text: "blocked", protected: false, blocked: true };
		const measured = measureSpecTask(data, WIDTH);
		const root = render(<RenderSpecTask measured={measured} data={data} live />);
		expect(spinCount(root)).toBe(0);
	});
});

describe("RenderSpecTask — a live row is a LOADER, not a spinning play glyph", () => {
	it("swaps the play triangle for the loader while live", () => {
		expect(iconNames(renderRow("doing", true))).toContain("tabler-icon-loader-2");
		expect(iconNames(renderRow("doing", true))).not.toContain("tabler-icon-player-play");
	});

	it("keeps the static play glyph for a recorded `doing` row", () => {
		expect(iconNames(renderRow("doing", false))).toContain("tabler-icon-player-play");
		expect(iconNames(renderRow("doing", false))).not.toContain("tabler-icon-loader-2");
	});
});
