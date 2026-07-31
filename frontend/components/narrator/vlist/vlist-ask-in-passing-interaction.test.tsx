/**
 * vlist-ask-in-passing-interaction.test.tsx — "ask in passing" must be USABLE in
 * the virtual list, not just painted.
 *
 * The bug this locks down: with the virtual list on, picking 顺便提问 from a row
 * menu inserted the pending card correctly, but the card was a zero-DOM COPY — its
 * TextInput was `readOnly` and its two buttons had no handlers. Nothing could be
 * typed and nothing could be submitted or cancelled, so the whole feature was dead
 * on that path. The resolved card had the mirror problem: its measured payload
 * carried no target narrator, so the arrow led nowhere, and the question text was
 * read from `text` while the server writes `question` — leaving the card blank.
 *
 * Three layers are covered:
 *   1. the PURE target resolution (which rows are cards, in which state, and where
 *      a resolved one points) — `resolveVListAskInPassingTarget`;
 *   2. the adapter's question field (server writes `question`, not `text`);
 *   3. the render chain adapter → measure → render → DOM, so a dropped prop in the
 *      dispatch fails here: the injected form must replace the readOnly copy, and a
 *      resolved card's click must reach the navigation callback.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import {
	isVListAskInPassingPending,
	readAskInPassingTargetNarratorId,
	resolveVListAskInPassingTarget,
} from "./vlist-ask-in-passing-target";

const CONTENT_WIDTH = 800;

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
	// linkedom may not ship KeyboardEvent; provide a minimal polyfill that carries
	// `key` and supports `preventDefault()` — enough for React's synthetic events.
	if (typeof g.KeyboardEvent !== "function") {
		const EventCtor = (win as unknown as { Event: typeof Event }).Event;
		g.KeyboardEvent = class KeyboardEvent extends (EventCtor as unknown as typeof Event) {
			key: string;
			constructor(type: string, init?: KeyboardEventInit & { bubbles?: boolean }) {
				super(type, { bubbles: init?.bubbles ?? true, cancelable: init?.cancelable ?? true });
				this.key = init?.key ?? "";
			}
		} as unknown as typeof KeyboardEvent;
	}
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
});

/** Adapt one system message carrying a single ask_in_passing block. */
function adaptAskInPassing(block: Record<string, unknown>) {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "aip-msg", role: "system", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5 })[0];
	if (!spec) throw new Error("no spec produced");
	return spec;
}

interface RenderedCard {
	root: Element;
	unmount: () => void;
	height: number;
}

/**
 * Drive one ask_in_passing block through adapter → measure → render into a live
 * DOM with the injected slot / callback, exactly as the shell's ExactRow does.
 */
function renderCard(
	block: Record<string, unknown>,
	injected: { formSlot?: React.ReactNode; onOpen?: () => void } = {},
): RenderedCard {
	const spec = adaptAskInPassing(block);
	expect(spec.kind).toBe("ask-in-passing");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (injected.formSlot !== undefined) extra.askInPassingFormSlot = injected.formSlot;
	if (injected.onOpen) extra.onOpenAskInPassingTarget = injected.onOpen;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>,
		);
	});
	return {
		root: container as unknown as Element,
		height: measured.height,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

const PENDING_BLOCK = { type: "ask_in_passing", status: "pending", sourceMessageId: "src-1" };
const RESOLVED_BLOCK = {
	type: "ask_in_passing",
	status: "resolved",
	question: "Why does the build fail?",
	targetNarratorId: "nar-answer",
};

describe("resolveVListAskInPassingTarget — which rows get which wiring", () => {
	it("a pending card binds to its own message and has no navigation target", () => {
		expect(
			resolveVListAskInPassingTarget("ask-in-passing", { kind: "pending" }, ["m1"], []),
		).toEqual({
			kind: "pending",
			messageId: "m1",
			targetNarratorId: null,
		});
	});

	it("a resolved card reads its target narrator back from the message blocks", () => {
		const messages = [{ id: "m1", contentJson: [RESOLVED_BLOCK] }];
		expect(
			resolveVListAskInPassingTarget(
				"ask-in-passing",
				{ kind: "resolved", question: RESOLVED_BLOCK.question },
				["m1"],
				messages,
			),
		).toEqual({
			kind: "resolved",
			messageId: "m1",
			targetNarratorId: "nar-answer",
		});
	});

	it("a legacy resolved card with no target stays non-navigable instead of routing nowhere", () => {
		const messages = [
			{ id: "m1", contentJson: [{ type: "ask_in_passing", status: "resolved", question: "q?" }] },
		];
		expect(
			resolveVListAskInPassingTarget("ask-in-passing", { kind: "resolved" }, ["m1"], messages),
		).toMatchObject({ kind: "resolved", targetNarratorId: null });
	});

	it("any non-pending status resolves to the resolved card (adapter parity)", () => {
		for (const kind of ["resolved", "answered", undefined]) {
			expect(resolveVListAskInPassingTarget("ask-in-passing", { kind }, ["m1"], [])).toMatchObject({
				kind: "resolved",
			});
		}
	});

	it("other kinds and rows with no owning message are not ask-in-passing rows", () => {
		expect(
			resolveVListAskInPassingTarget("system-simple", { kind: "pending" }, ["m1"], []),
		).toBeNull();
		expect(resolveVListAskInPassingTarget("markdown", { kind: "pending" }, ["m1"], [])).toBeNull();
		// No owning message id → neither the form binding nor the lookup can work.
		expect(
			resolveVListAskInPassingTarget("ask-in-passing", { kind: "pending" }, [], []),
		).toBeNull();
	});

	it("readAskInPassingTargetNarratorId ignores unrelated messages and blocks", () => {
		const messages = [
			{ id: "other", contentJson: [RESOLVED_BLOCK] },
			{ id: "m1", contentJson: [{ type: "text", text: "hi" }] },
		];
		expect(readAskInPassingTargetNarratorId(messages, "m1")).toBeNull();
		expect(readAskInPassingTargetNarratorId(messages, "missing")).toBeNull();
		expect(readAskInPassingTargetNarratorId(messages, "other")).toBe("nar-answer");
	});

	it("isVListAskInPassingPending marks exactly the rows the shell must measure after paint", () => {
		// The shell needs this decision BEFORE it has the manifest source ids, so it
		// must agree with the full resolver on the spec data alone.
		expect(isVListAskInPassingPending("ask-in-passing", { kind: "pending" })).toBe(true);
		expect(isVListAskInPassingPending("ask-in-passing", { kind: "resolved" })).toBe(false);
		expect(isVListAskInPassingPending("system-simple", { kind: "pending" })).toBe(false);
		expect(isVListAskInPassingPending("ask-in-passing", null)).toBe(false);
	});
});

describe("adapter — the resolved question comes from the block's `question` field", () => {
	it("carries the question the server persisted (not the never-set `text`)", () => {
		const spec = adaptAskInPassing(RESOLVED_BLOCK);
		expect(spec.data).toMatchObject({ kind: "resolved", question: "Why does the build fail?" });
	});

	it("still falls back to `text` for any block written that way", () => {
		const spec = adaptAskInPassing({
			type: "ask_in_passing",
			status: "resolved",
			text: "legacy question",
		});
		expect(spec.data).toMatchObject({ question: "legacy question" });
	});
});

describe("ask-in-passing row — the injected slot / callback actually work", () => {
	it("the pending row mounts the LIVE form and drops the inert copy", () => {
		const card = renderCard(PENDING_BLOCK, {
			formSlot: <input data-testid="live-form" placeholder="live" />,
		});
		const live = card.root.querySelector("[data-testid='live-form']");
		expect(live).not.toBeNull();
		// The copy must be GONE, not merely accompanied: two inputs would leave the
		// reader typing into the readOnly one that submits nothing (the reported
		// symptom). The copy is identified by its own placeholder.
		expect(card.root.querySelectorAll("input")).toHaveLength(1);
		expect(copyPlaceholderCount(card.root)).toBe(0);
		card.unmount();
	});

	it("without a slot only the inert copy is drawn (harness / no bridge)", () => {
		const card = renderCard(PENDING_BLOCK);
		expect(card.root.querySelectorAll("input")).toHaveLength(1);
		expect(copyPlaceholderCount(card.root)).toBe(1);
		card.unmount();
	});

	it("clicking a resolved card opens the narrator that answered", () => {
		let opened = 0;
		const card = renderCard(RESOLVED_BLOCK, { onOpen: () => opened++ });
		expect(card.root.textContent ?? "").toContain("Why does the build fail?");
		act(() => resolvedCardOf(card.root).click());
		expect(opened).toBe(1);
		card.unmount();
	});

	it("a resolved card with no target stays inert rather than throwing on click", () => {
		const card = renderCard({
			type: "ask_in_passing",
			status: "resolved",
			question: "orphaned question",
		});
		act(() => resolvedCardOf(card.root).click());
		card.unmount();
	});
});

describe("resolved card keyboard accessibility", () => {
	it("a resolved card with onOpen has role=button and tabIndex=0", () => {
		const card = renderCard(RESOLVED_BLOCK, { onOpen: () => {} });
		const paper = resolvedCardOf(card.root);
		expect(paper.getAttribute("role")).toBe("button");
		expect(paper.getAttribute("tabindex")).toBe("0");
		card.unmount();
	});

	it("a resolved card without onOpen has no role/tabIndex (not focusable)", () => {
		const card = renderCard({
			type: "ask_in_passing",
			status: "resolved",
			question: "orphaned question",
		});
		const paper = resolvedCardOf(card.root);
		expect(paper.getAttribute("role")).toBeNull();
		expect(paper.getAttribute("tabindex")).toBeNull();
		card.unmount();
	});

	it("Enter key triggers onOpen on a resolved card", () => {
		let opened = 0;
		const card = renderCard(RESOLVED_BLOCK, { onOpen: () => opened++ });
		const paper = resolvedCardOf(card.root);
		act(() => {
			paper.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});
		expect(opened).toBe(1);
		card.unmount();
	});

	it("Space key triggers onOpen and prevents default scroll", () => {
		let opened = 0;
		const card = renderCard(RESOLVED_BLOCK, { onOpen: () => opened++ });
		const paper = resolvedCardOf(card.root);
		let defaultPrevented = false;
		act(() => {
			const event = new KeyboardEvent("keydown", {
				key: " ",
				bubbles: true,
				cancelable: true,
			});
			// linkedom KeyboardEvent supports preventDefault
			const origPreventDefault = event.preventDefault.bind(event);
			event.preventDefault = () => {
				defaultPrevented = true;
				origPreventDefault();
			};
			paper.dispatchEvent(event);
		});
		expect(opened).toBe(1);
		expect(defaultPrevented).toBe(true);
		card.unmount();
	});

	it("other keys do not trigger onOpen", () => {
		let opened = 0;
		const card = renderCard(RESOLVED_BLOCK, { onOpen: () => opened++ });
		const paper = resolvedCardOf(card.root);
		act(() => {
			paper.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
			);
			paper.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(opened).toBe(0);
		card.unmount();
	});
});

/**
 * The resolved card's clickable surface. MantineProvider injects its `<style>`
 * elements first, so the card is NOT `firstElementChild` — it is the Paper root.
 */
function resolvedCardOf(root: Element): HTMLElement {
	const paper = root.querySelector(".mantine-Paper-root");
	if (!paper) throw new Error("resolved card not rendered");
	return paper as unknown as HTMLElement;
}

/**
 * Count the zero-DOM COPY's inputs, identified by the placeholder the render layer
 * draws (`RenderAskInPassing`'s DEFAULT_LABELS). Its `readOnly` is set as a React
 * PROPERTY, which linkedom does not mirror into an attribute — so keying on
 * readOnly (attribute or property) would match nothing here and make the "the copy
 * is gone" assertion vacuously true.
 */
function copyPlaceholderCount(root: Element): number {
	let count = 0;
	for (const input of root.querySelectorAll("input")) {
		if (input.getAttribute("placeholder") === "Type your question…") count++;
	}
	return count;
}
