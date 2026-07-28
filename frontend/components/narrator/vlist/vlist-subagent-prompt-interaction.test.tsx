/**
 * vlist-subagent-prompt-interaction.test.tsx — a subagent card's PROMPT must be
 * OPERABLE in the virtual list, not just painted.
 *
 * The bug this locks down: in Virtual-list mode the subagent card drew the
 * "Prompt" toggle row with its chevron, but nothing supplied `onTogglePrompt` and
 * no interaction channel tracked `promptOpen` — so clicking the row did nothing
 * and the prompt could never be read. The chunked SubagentCard has always kept
 * its own `showPrompt` state, independent of the card's own fold.
 *
 * Three layers are covered:
 *   1. the interaction STATE channel (`promptOpen` is its own set, so opening a
 *      card does not unfold its prompt and vice versa);
 *   2. the adapter → measure chain (the prompt body is reserved ONLY when the
 *      reader opened it, so a card the reader scrolled past measures nothing);
 *   3. the render → DOM click, so a dropped prop in the dispatch fails here.
 *
 * Plus the on-demand contract: a truncated prompt reserves the whole cap while it
 * is still a preview (so the fetched body cannot resize a committed row), and the
 * fetch is gated on the prompt being OPEN — never on mere card expansion.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import {
	createVListInteractionState,
	isPromptOpenRow,
	resetVListInteractionStateForLod,
	setVListExpanded,
	toggleVListPromptOpen,
} from "./vlist-interaction-state";

const CONTENT_WIDTH = 800;
const DESCRIPTION = "look into the auth regression";
const PROMPT = "Investigate the failing auth test\nand report the root cause.";

beforeAll(() => {
	installCanvasStub();
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
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
});

/** Adapt one Agent tool call to its subagent-card spec, at the given prompt state. */
function adaptSubagent(
	opts: { promptOpen?: boolean; expanded?: boolean; inputJson?: Record<string, unknown> } = {},
) {
	// An explicit `description` matters: without one the adapter derives it FROM the
	// prompt, so the prompt text would appear in the header too and a "is the prompt
	// body painted" assertion could not tell the two apart.
	const inputJson = opts.inputJson ?? {
		subagent_type: "explore",
		description: DESCRIPTION,
		prompt: PROMPT,
	};
	const seg: AdapterSegment = {
		kind: "tool-run",
		sourceMessages: [],
		items: [
			{
				blockIndex: 0,
				isSubagent: true,
				// biome-ignore lint/suspicious/noExplicitAny: structural tool-call mirror
				tc: { toolUseId: "tu-agent", toolName: "Agent", status: "success", inputJson } as any,
			},
		],
	};
	const spec = adaptSegment(seg, {
		lod: 5,
		// The card must be OPEN for its prompt block to exist at all (the block lives
		// inside the LazyCollapse body), so default to opened unless a case says else.
		isExpanded: () => opts.expanded ?? true,
		isPromptOpen: () => opts.promptOpen === true,
	})[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("subagent-card");
	return spec;
}

function measureSpec(spec: ReturnType<typeof adaptSubagent>): MeasuredSubagent {
	return VLIST_REGISTRY[spec.kind].measure(
		spec.data,
		CONTENT_WIDTH,
		5,
		spec.opts,
	) as MeasuredSubagent;
}

interface RenderedCard {
	container: Element;
	unmount: () => void;
}

/** Drive one spec through render into a live DOM, as the shell's ExactRow does. */
function renderCard(
	spec: ReturnType<typeof adaptSubagent>,
	measured: MeasuredSubagent,
	callbacks: { onTogglePrompt?: () => void } = {},
): RenderedCard {
	const extra = resolveRenderExtra(spec);
	if (callbacks.onTogglePrompt) extra.onTogglePrompt = callbacks.onTogglePrompt;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>,
		);
	});
	return {
		container: container as unknown as Element,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

/** The prompt toggle row — the element RenderSubagent binds the handler on. */
function findPromptToggle(container: Element): Element {
	const toggle = container.querySelector('[data-testid="subagent-prompt-toggle"]');
	if (!toggle) throw new Error("prompt toggle row not rendered");
	return toggle;
}

function click(node: Element): void {
	act(() => (node as unknown as HTMLElement).click());
}

describe("promptOpen is its own interaction channel", () => {
	it("toggles independently of the card's own expand state", () => {
		const base = createVListInteractionState(5);
		const expanded = setVListExpanded(base, "tool-tu-agent", true);
		// Expanding the CARD must not unfold its prompt.
		expect(isPromptOpenRow(expanded, "tool-tu-agent")).toBe(false);
		const opened = toggleVListPromptOpen(expanded, "tool-tu-agent");
		expect(isPromptOpenRow(opened, "tool-tu-agent")).toBe(true);
		// And folding the prompt must not collapse the card.
		const closed = toggleVListPromptOpen(opened, "tool-tu-agent");
		expect(isPromptOpenRow(closed, "tool-tu-agent")).toBe(false);
		expect(closed.expanded.get("tool-tu-agent")).toBe(true);
	});

	it("survives an LOD change like every other content preference", () => {
		const opened = toggleVListPromptOpen(createVListInteractionState(5), "tool-tu-agent");
		const afterZoom = resetVListInteractionStateForLod(opened, 6);
		// Re-folding a prompt the reader deliberately opened (and, for a truncated
		// one, already paid a fetch for) on every zoom step would be a regression.
		expect(isPromptOpenRow(afterZoom, "tool-tu-agent")).toBe(true);
	});
});

describe("adapter → measure: the prompt body is reserved only when opened", () => {
	it("measures NO prompt body while the prompt is folded", () => {
		const measured = measureSpec(adaptSubagent({ promptOpen: false }));
		// The toggle ROW is always there (the affordance), the body is not.
		expect(measured.promptBlockHeight).toBeGreaterThan(0);
		expect(measured.promptMeasured).toBeNull();
	});

	it("measures the prompt body once the reader opened it, growing the card", () => {
		const folded = measureSpec(adaptSubagent({ promptOpen: false }));
		const opened = measureSpec(adaptSubagent({ promptOpen: true }));
		expect(opened.promptMeasured).not.toBeNull();
		expect(opened.promptBlockHeight).toBeGreaterThan(folded.promptBlockHeight);
		expect(opened.height).toBeGreaterThan(folded.height);
	});

	it("carries the owning toolUseId so the shell can bind the on-demand fetch", () => {
		expect(measureSpec(adaptSubagent({ promptOpen: true })).toolUseId).toBe("tu-agent");
	});
});

describe("truncated prompts: on-demand, and height-stable", () => {
	/** A prompt the server had to project into a `{_truncated, preview}` leaf. */
	const truncatedInput = {
		subagent_type: "explore",
		description: DESCRIPTION,
		prompt: { _truncated: true, preview: PROMPT, fullLength: 40_000 },
	};

	it("still shows the prompt (as its preview) instead of dropping the block", () => {
		// A plain `typeof === "string"` check fails on the wrapper, which would make
		// the whole prompt block vanish for exactly the longest prompts.
		const spec = adaptSubagent({ promptOpen: true, inputJson: truncatedInput });
		const data = spec.data as { prompt?: string; promptTruncated?: boolean };
		expect(data.prompt).toBe(PROMPT);
		expect(data.promptTruncated).toBe(true);
	});

	it("reserves the FULL cap while truncated, so the fetched body cannot resize the row", () => {
		const truncated = measureSpec(adaptSubagent({ promptOpen: true, inputJson: truncatedInput }));
		const complete = measureSpec(adaptSubagent({ promptOpen: true }));
		// Same preview text, but the truncated one reserves the whole scrollable cap.
		expect(truncated.promptBlockHeight).toBeGreaterThan(complete.promptBlockHeight);
		expect(truncated.promptTruncated).toBe(true);
	});

	it("reports NO fetch need while the prompt is folded (the on-demand gate)", () => {
		// This is the property the shell's fetch list reads: a card the reader merely
		// scrolled past — or expanded — must not pull a 40KB prompt.
		const folded = measureSpec(adaptSubagent({ promptOpen: false, inputJson: truncatedInput }));
		expect(folded.promptTruncated).toBe(false);
		const opened = measureSpec(adaptSubagent({ promptOpen: true, inputJson: truncatedInput }));
		expect(opened.promptTruncated).toBe(true);
	});

	it("re-measures to the exact height once the full prompt is substituted", () => {
		const { extractDataRevision } = require("./measure-cache") as {
			extractDataRevision: (data: unknown) => string | undefined;
		};
		const truncated = adaptSubagent({ promptOpen: true, inputJson: truncatedInput });
		const resolved = adaptSubagent({ promptOpen: true });
		// The spec.key is identical across the fetch, so only the data revision can
		// invalidate the stale (full-cap) height.
		expect(truncated.key).toBe(resolved.key);
		expect(extractDataRevision(truncated.data)).not.toBe(extractDataRevision(resolved.data));
	});
});

describe("render → DOM: clicking the prompt row actually toggles it", () => {
	it("invokes the injected onTogglePrompt (the whole chain)", () => {
		const spec = adaptSubagent({ promptOpen: false });
		const measured = measureSpec(spec);
		let clicks = 0;
		const card = renderCard(spec, measured, { onTogglePrompt: () => clicks++ });
		click(findPromptToggle(card.container));
		expect(clicks).toBe(1);
		card.unmount();
	});

	it("paints the prompt text once open", () => {
		const spec = adaptSubagent({ promptOpen: true });
		const card = renderCard(spec, measureSpec(spec));
		expect(card.container.textContent).toContain("Investigate the failing auth test");
		card.unmount();
	});

	it("does NOT paint the prompt text while folded (only the toggle)", () => {
		const spec = adaptSubagent({ promptOpen: false });
		const card = renderCard(spec, measureSpec(spec));
		expect(card.container.textContent).toContain("Prompt");
		expect(card.container.textContent).not.toContain("report the root cause");
		card.unmount();
	});
});
