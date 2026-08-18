/**
 * RenderReviewCard.test.tsx — a review conclusion must reach the DOM as rendered
 * MARKDOWN inside a scrolling box.
 *
 * The card went through three shapes, and each one failed on screen while every unit test
 * around it passed:
 *
 *   1. `system-simple` — one clamped line, so the findings could not fit.
 *   2. `system-text` in an `injection-bubble` — a card inside a bubble, with the body
 *      painted line-by-line as PLAIN text: `##`, `**` and backticks reached the reader as
 *      literal characters, code was not highlighted, and the box could not scroll.
 *   3. this one.
 *
 * Adapter-level and measure-level tests could not catch (2): the measured blocks were
 * genuine markdown blocks either way, and the geometry was self-consistent. Only driving
 * the whole chain into a live DOM shows whether the reader actually sees rendered
 * markdown, which is why this test exists at all.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import type { ReviewCardActions } from "./RenderReviewCard";

const CONTENT_WIDTH = 800;

beforeAll(() => {
	// The body is measured with pretext (canvas measureText).
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

const CONCLUSION_MD = [
	"## Code Review: Changes Requested",
	"",
	"- **[critical]** `server/db/schema.ts` — the index has no migration",
	"",
	"```ts",
	"const stmt = sqlite.prepare(SELECT_ROSTER);",
	"```",
].join("\n");

/**
 * Drive one conclusion row through adapter → measure → render into a live DOM.
 *
 * The FULL chain on purpose: the routing (which element kind the row becomes), the
 * measurement and the paint have each been the broken link at some point, and only an
 * end-to-end drive covers all three.
 */
function renderConclusion(
	block: Record<string, unknown>,
	actions?: ReviewCardActions,
): {
	container: HTMLElement;
	html: string;
	buttons: HTMLButtonElement[];
	unmount: () => void;
} {
	const seg: AdapterSegment = {
		kind: "message",
		msg: {
			id: "review-msg",
			role: "user",
			origin: "system",
			originLabel: "review",
			contentJson: [{ type: "text", text: String(block.text ?? "") } as never, block as never],
		},
	};
	const spec = adaptSegment(seg, { lod: 5 })[0];
	if (!spec) throw new Error("no spec produced");
	// Its own element: neither nested in a bubble nor flattened into a notice.
	expect(spec.kind).toBe("review-card");

	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (actions) extra.reviewFeedbackActions = actions;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>);
	});
	return {
		container,
		html: container.innerHTML,
		buttons: Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[],
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const REVIEW_BLOCK = {
	type: "review_feedback",
	verdict: "request_changes",
	findings: [{ severity: "critical", message: "the index has no migration" }],
	text: CONCLUSION_MD,
} as const;

describe("review card — the body is RENDERED markdown", () => {
	it("paints the prose without leaking markdown syntax", () => {
		const { html, unmount } = renderConclusion({ ...REVIEW_BLOCK });
		// The words arrive…
		expect(html).toContain("Code Review");
		expect(html).toContain("the index has no migration");
		// …and the syntax that produced them does NOT. This is the exact failure of the
		// plain-text card: the reader saw the `##` and `**` characters.
		expect(html).not.toContain("## Code Review");
		expect(html).not.toContain("**[critical]**");
		unmount();
	});

	it("renders a fenced code block as a code panel, not as literal backticks", () => {
		const { html, unmount } = renderConclusion({ ...REVIEW_BLOCK });
		expect(html).toContain("sqlite.prepare");
		expect(html).not.toContain("```ts");
		unmount();
	});

	it("emits real markdown block hosts, so highlighting and insets apply", () => {
		// `RenderMarkdown` paints each prepared block as its own positioned box. Their
		// presence is what distinguishes "markdown pipeline ran" from "one pre-wrap string".
		const { container, unmount } = renderConclusion({ ...REVIEW_BLOCK });
		const body = container.querySelector("[data-vlist-review-body]");
		expect(body).toBeTruthy();
		expect((body?.innerHTML ?? "").length).toBeGreaterThan(0);
		// A code panel carries the copy affordance the markdown renderer adds; a plain-text
		// body has no such structure.
		expect(container.querySelectorAll("[data-vlist-review-body] div").length).toBeGreaterThan(1);
		unmount();
	});
});

describe("review card — the body scrolls instead of growing the row", () => {
	it("puts the body in an overflow box at the measured height", () => {
		const { container, unmount } = renderConclusion({ ...REVIEW_BLOCK });
		const body = container.querySelector(
			"[data-vlist-review-body]",
		) as unknown as HTMLElement | null;
		expect(body).toBeTruthy();
		// Matched without whitespace assumptions: the serialized inline style has no space
		// after the colon.
		const style = (body?.getAttribute("style") ?? "").replace(/\s+/g, "");
		expect(style).toContain("overflow:auto");
		expect(style).toMatch(/height:\d/);
		expect(style).toMatch(/max-height:\d/);
		unmount();
	});

	it("a very long conclusion keeps the card at the capped height", async () => {
		const { REVIEW_BODY_CAP, reviewCardChrome } = await import("../measure/measure-review-card");
		const longText = [
			"## Code Review: Changes Requested",
			"",
			...Array.from({ length: 300 }, (_, i) => `- **[major]** \`file-${i}.ts\` — finding ${i}`),
		].join("\n");
		const { container, unmount } = renderConclusion({ ...REVIEW_BLOCK, text: longText });
		// The body box is the thing the cap applies to; asserting on it rather than on the
		// card root keeps this independent of how Mantine composes the Paper's own styles.
		const body = container.querySelector(
			"[data-vlist-review-body]",
		) as unknown as HTMLElement | null;
		const style = (body?.getAttribute("style") ?? "").replace(/\s+/g, "");
		// The body stops at the cap — it is not the height of 300 findings.
		expect(style).toContain(`height:${REVIEW_BODY_CAP}px`);
		// And the row as a whole is that plus its fixed chrome.
		expect(container.textContent ?? "").toContain("finding 0");
		expect(reviewCardChrome()).toBeGreaterThan(0);
		unmount();
	});
});

describe("review card — the header and its action", () => {
	it("shows the verdict and calls the injected handler", () => {
		let clicked = 0;
		const { container, buttons, unmount } = renderConclusion(
			{ ...REVIEW_BLOCK },
			{ onApply: () => clicked++ },
		);
		expect(container.textContent ?? "").toContain("Changes Requested");
		// More than one button is present, and that is itself evidence the markdown
		// pipeline ran: the fenced block contributes a copy button. The action is the one
		// carrying the adapter's label.
		const action = buttons.find((b) => (b.textContent ?? "").includes("Handle"));
		expect(action).toBeTruthy();
		act(() => action?.click());
		expect(clicked).toBe(1);
		unmount();
	});

	it("disables the action once a turn has been started for the conclusion", () => {
		// `applied` is terminal: a second click would start a second turn for the same
		// findings, so the button must be inert even with a live handler attached.
		let clicked = 0;
		const { buttons, unmount } = renderConclusion(
			{ ...REVIEW_BLOCK, applied: true },
			{ onApply: () => clicked++ },
		);
		// Found by label rather than by position: the markdown body's code panel contributes
		// its own copy button, so an index would silently assert about the wrong control.
		const action = buttons.find((b) => (b.textContent ?? "").includes("Handled"));
		expect(action?.hasAttribute("disabled")).toBe(true);
		act(() => action?.click());
		expect(clicked).toBe(0);
		unmount();
	});

	it("renders the action disabled when no handler was injected", () => {
		const { buttons, unmount } = renderConclusion({ ...REVIEW_BLOCK });
		const action = buttons.find((b) => (b.textContent ?? "").includes("Handle"));
		expect(action?.hasAttribute("disabled")).toBe(true);
		unmount();
	});

	it("composes the body for a historical row that carries no text", () => {
		// Rows already in the database hold only `verdict` and `findings`.
		const { html, unmount } = renderConclusion({
			type: "review_feedback",
			verdict: "approve",
			findings: [{ severity: "minor", message: "nit about naming" }],
		});
		expect(html).toContain("nit about naming");
		// The composed body must itself be MARKDOWN, or the syntax the adapter emits reaches
		// the reader literally — the run-on-blob failure on historical rows.
		expect(html).not.toContain("- **[minor]**");
		expect(html).not.toContain("## ");
		unmount();
	});

	it("a composed body with several findings renders as separate list rows", () => {
		// `\n`-joined lines fold into ONE markdown paragraph, so this is what proves the
		// composed form uses real list syntax rather than bare newlines.
		const { container, unmount } = renderConclusion({
			type: "review_feedback",
			verdict: "request_changes",
			findings: [
				{ severity: "critical", file: "a.ts", line: 1, message: "first finding" },
				{ severity: "major", message: "second finding" },
				{ severity: "minor", message: "third finding" },
			],
		});
		const body = container.querySelector("[data-vlist-review-body]");
		const markers = (body?.textContent ?? "").match(/finding/g) ?? [];
		expect(markers).toHaveLength(3);
		// Each item is its own positioned block, not three sentences in one box.
		expect((body?.querySelectorAll("[class*='vlist-frag'], div") ?? []).length).toBeGreaterThan(3);
		unmount();
	});
});
