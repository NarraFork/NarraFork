/**
 * RenderInjectionBubble.test.tsx — measure/render parity for the framed markdown bubble.
 *
 * The properties asserted here are the ones a "harmless cleanup" would break:
 *
 *   1. the body is painted at `measured.contentWidth` — the width the LINE BREAKING
 *      used — and not at the frame's inner width. Those differ on every shrink-wrapped
 *      bubble, and painting at the narrower one re-wraps the text under a height
 *      predicted for the wider box (the last line gets clipped).
 *   2. the frame paints exactly `measured.usedWidth` × `measured.height`. The list
 *      positions rows from the measured height, so a frame that decided its own size
 *      would overlap its neighbour.
 *   3. the header only paints when the measure pass reserved space for it.
 *   4. the bubble is LEFT-aligned — it is somebody else's voice; the right-hand side
 *      is reserved for the reader's own turns.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const realReactI18nextModule = { ...(await import("react-i18next")) };
mock.module("react-i18next", () => ({
	...realReactI18nextModule,
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const { RenderInjectionBubble } = await import("./RenderInjectionBubble");
const { measureInjectionBubble, INJECTION_BUBBLE_PADDING } = await import(
	"../measure/measure-injection-bubble"
);

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

function setupDom() {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
		g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as Timer);
	}
	return win.document;
}

const WIDTH = 800;

type Rendered = {
	wrapperJustify: string;
	frameWidth: string;
	frameHeight: string;
	bodyWidth: string;
	bodyTop: string;
	headerCount: number;
	noteCount: number;
	text: string;
};

function render(
	measured: ReturnType<typeof measureInjectionBubble>,
	props: { header?: React.ReactNode; noteText?: string } = {},
): Rendered {
	const doc = setupDom();
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<MantineProvider>
				<RenderInjectionBubble measured={measured} {...props} />
			</MantineProvider>,
		);
	});
	// Addressed by the render layer's stable `data-vlist-*` markers rather than by
	// walking `div > div` or matching inline styles: a structural query would silently
	// start reading a different element the moment a wrapper is added.
	const wrapper = currentContainer.querySelector(
		"[data-vlist-injection-row]",
	) as HTMLElement | null;
	const frame = currentContainer.querySelector(
		"[data-vlist-injection-frame]",
	) as HTMLElement | null;
	if (!wrapper || !frame) throw new Error("expected the bubble frame to render");
	const bodyEl = frame.querySelector("[data-vlist-injection-body]") as HTMLElement | null;
	return {
		wrapperJustify: wrapper.style.justifyContent,
		frameWidth: frame.style.width,
		frameHeight: frame.style.height,
		bodyWidth: bodyEl?.style.width ?? "",
		bodyTop: bodyEl?.style.top ?? "",
		headerCount: frame.querySelectorAll("[data-vlist-injection-header]").length,
		noteCount: frame.querySelectorAll("[data-vlist-injection-note]").length,
		text: frame.textContent ?? "",
	};
}

/** The frame element, for assertions about the surface itself rather than its geometry. */
function renderFrameEl(measured: ReturnType<typeof measureInjectionBubble>): HTMLElement {
	const doc = setupDom();
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<MantineProvider>
				<RenderInjectionBubble measured={measured} />
			</MantineProvider>,
		);
	});
	const frame = currentContainer.querySelector("[data-vlist-injection-frame]");
	if (!frame) throw new Error("expected the bubble frame to render");
	return frame as HTMLElement;
}

afterEach(() => {
	if (currentRoot) {
		const root = currentRoot;
		act(() => root.unmount());
		currentRoot = null;
	}
	currentContainer?.remove();
	currentContainer = null;
});

afterAll(() => {
	mock.restore();
});

describe("RenderInjectionBubble — paints the measured geometry", () => {
	test("the frame is exactly the measured box", () => {
		const m = measureInjectionBubble({ markdown: "hello there", speaker: "explorer" }, WIDTH);
		const r = render(m);
		expect(r.frameWidth).toBe(`${m.usedWidth}px`);
		expect(r.frameHeight).toBe(`${m.height}px`);
	});

	test("the body is painted at the MEASURED wrap width, not the frame's inner width", () => {
		// A short body shrink-wraps the frame, so the two differ — this is the case that
		// would silently clip text if the render copy derived the width itself.
		const m = measureInjectionBubble({ markdown: "ok", hasHeader: false }, WIDTH);
		const frameInner = m.usedWidth - INJECTION_BUBBLE_PADDING * 2;
		expect(frameInner).toBeLessThan(m.contentWidth);

		const r = render(m);
		expect(r.bodyWidth).toBe(`${m.contentWidth}px`);
		expect(r.bodyWidth).not.toBe(`${frameInner}px`);
	});

	test("the body sits at the measured bodyTop", () => {
		const m = measureInjectionBubble({ markdown: "hello", speaker: "s" }, WIDTH);
		const r = render(m);
		expect(r.bodyTop).toBe(`${m.bodyTop}px`);
	});

	test("is left-aligned — an injection is somebody else's voice", () => {
		const m = measureInjectionBubble({ markdown: "hi" }, WIDTH);
		expect(render(m).wrapperJustify).toBe("flex-start");
	});
});

describe("RenderInjectionBubble — card body (option A)", () => {
	// The real shape `adaptSystemBlock` produces: the adapter pre-composes `text`, and
	// the card paints THAT. An earlier version of this fixture passed raw branch fields,
	// which the card never reads — so it rendered empty and the test was asserting
	// against a data contract that does not exist.
	const MERGE_DATA = {
		kind: "merge_summary",
		text: "Merged feature-x into trunk (squash) by alice",
		color: "indigo",
		hasAvatar: true,
	};

	test("paints the nested card, keeping its content inside the frame", () => {
		// The whole point of framing an existing card rather than flattening it: the
		// branch names / strategy the reader could act on are still there.
		const m = measureInjectionBubble(
			{ payload: { kind: "merge_summary", data: MERGE_DATA }, speaker: "alice" },
			WIDTH,
		);
		expect(m.bodyForm).toBe("payload");
		const r = render(m);
		expect(r.text).toContain("Merged feature-x into trunk");
		// And the frame still paints exactly the measured box.
		expect(r.frameHeight).toBe(`${m.height}px`);
	});

	test("paints nothing for an unrecognized payload, matching the reserved zero height", () => {
		// Measure reserved no body height for it; drawing something would overflow the
		// fixed-height clip box.
		const m = measureInjectionBubble({ payload: { kind: "future_xyz", data: {} } }, WIDTH);
		expect(m.frame.contentHeight).toBe(0);
		const r = render(m);
		expect(r.frameHeight).toBe(`${m.height}px`);
	});

	test("still honours the header and note rows around a card body", () => {
		const m = measureInjectionBubble(
			{ payload: { kind: "merge_summary", data: MERGE_DATA }, speaker: "alice", hasNote: true },
			WIDTH,
		);
		const r = render(m, { header: <span data-test-hdr>alice</span>, noteText: "truncated" });
		expect(r.headerCount).toBe(1);
		expect(r.text).toContain("truncated");
	});

	test("a markdown body is unaffected by the payload branch", () => {
		const m = measureInjectionBubble({ markdown: "plain body" }, WIDTH);
		expect(m.bodyForm).toBe("markdown");
		expect(render(m).text).toContain("plain body");
	});
});

describe("RenderInjectionBubble — no per-producer skin", () => {
	test("paints no left accent rail", () => {
		// The previous redesign removed exactly this (a coloured Paper + 2px coloured left
		// rail, six hues) because it wrapped the list's least important content in its
		// heaviest skin. Two concrete defects on top of the aesthetics: the border gets
		// clipped into arcs by the corner radius, and under `border-box` it steals content
		// width the measure pass never accounted for.
		const m = measureInjectionBubble({ markdown: "hi", speaker: "explorer" }, WIDTH);
		const frame = renderFrameEl(m);
		// linkedom reports an unset style property as undefined rather than "", so assert
		// falsiness; both spellings mean "no border was written".
		expect(frame.style.borderLeft).toBeFalsy();
		expect(frame.style.borderLeftWidth).toBeFalsy();
		expect(frame.style.border).toBeFalsy();
		// The radius IS expected — it is what makes this read as a message bubble. Pinned
		// so the assertions above cannot pass merely because the whole style object is
		// empty (which would make this test vacuous).
		expect(frame.style.borderRadius).toBeTruthy();
	});

	test("every producer gets the same surface", () => {
		// Identity is carried by the side + the speaker row, not by a tint. Two different
		// producers must be indistinguishable at the frame level.
		const a = measureInjectionBubble({ markdown: "x", speaker: "alice" }, WIDTH);
		const b = measureInjectionBubble({ markdown: "x", speaker: "run-tests" }, WIDTH);
		expect(renderFrameEl(a).style.background).toBe(renderFrameEl(b).style.background);
	});
});

describe("RenderInjectionBubble — header slot", () => {
	test("paints the injected header when the measure pass reserved one", () => {
		const m = measureInjectionBubble({ markdown: "body", speaker: "explorer" }, WIDTH);
		expect(m.hasHeader).toBe(true);
		const r = render(m, { header: <span data-test-header>explorer</span> });
		expect(r.headerCount).toBe(1);
		expect(r.text).toContain("explorer");
	});

	test("does not paint a header when none was measured", () => {
		// Painting one anyway would overlap the body: the height reserved no room for it.
		const m = measureInjectionBubble({ markdown: "body", hasHeader: false }, WIDTH);
		const r = render(m, { header: <span data-test-header>ghost</span> });
		expect(r.headerCount).toBe(0);
	});
});

describe("RenderInjectionBubble — trailing note", () => {
	test("paints the note only when the measure pass reserved a row for it", () => {
		const withNote = measureInjectionBubble({ markdown: "out", hasNote: true }, WIDTH);
		expect(render(withNote, { noteText: "result truncated" }).text).toContain("result truncated");

		const without = measureInjectionBubble({ markdown: "out" }, WIDTH);
		expect(without.noteTop).toBe(-1);
		expect(render(without, { noteText: "result truncated" }).text).not.toContain(
			"result truncated",
		);
	});

	test("a reserved note row is drawn even when no label arrived", () => {
		// One-way consistency (CONTRACT §4): measure reserved the row, so the row exists.
		// Gating the paint on the label instead would leave a hole of exactly the note's
		// height whenever the i18n key is missing or resolves empty — a "reserved but
		// unpainted" gap, which is the shape the contract forbids.
		const m = measureInjectionBubble({ markdown: "out", hasNote: true }, WIDTH);
		const noteless = render(m, {});
		const labelled = render(m, { noteText: "result truncated" });
		expect(noteless.frameHeight).toBe(labelled.frameHeight);
		expect(noteless.noteCount).toBe(1);
	});
});
