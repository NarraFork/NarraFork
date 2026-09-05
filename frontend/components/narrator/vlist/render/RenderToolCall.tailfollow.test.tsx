/**
 * RenderToolCall.tailfollow.test.tsx — which capped bodies get the
 * output-tail follow wrapper (AutoFollowScroll) and which must not.
 *
 * The follow is for bodies whose NEWEST content is at the BOTTOM while they
 * GROW — bash/terminal output, a streaming Write preview, a streaming Edit
 * diff — so such a body scrolls itself (and pins on MOUNT: its first frame may
 * already overflow). The gates:
 *
 *  - sections path: a literal `output` label AND a terminal-style cap
 *    (`detail-term` / `detail-streaming-bash`), OR a `detail-streaming` body
 *    (that cap only comes out of classifyStreamingInput), OR a `detail-diff`
 *    body while the card is still streaming;
 *  - single-block path (a lone unlabelled section collapses into it): the same
 *    tag rules minus the label — this is where a streaming Write/Edit preview
 *    lands before its path row exists;
 *  - a streaming command box (`detail-streaming-bash` WITHOUT the output label)
 *    and every settled code/diff body stay head-anchored: they read from the
 *    head.
 *
 * Structure only: SSR paints no scroll handlers, so the assertion is whether
 * the scroll box's parent is AutoFollowScroll's `position:relative; min-width:0`
 * wrapper. The follow BEHAVIOUR is pinned in AutoFollowScroll.test.tsx.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import narratorLocale from "../../../../locales/en/narrator.json";

// A REAL i18n instance, not a module mock: bun shares one module registry
// across every file of an invocation, so a `mock.module("react-i18next")`
// leaks into later files that expect the real thing.
let testI18n: i18n;

const { measureToolCall } = await import("../measure/measure-tool-call");
const { installCanvasStub } = await import("../measure/test-canvas-stub");
const { RenderToolCall } = await import("./RenderToolCall");

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let parse: (html: string) => Element;

beforeAll(async () => {
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		ns: ["narrator"],
		resources: { en: { narrator: narratorLocale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const WIDTH = 700;
const LONG_BODY = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");

/** One sections-kind card with a single capped body section. */
function cardWithSection(opts: {
	label?: "command" | "output";
	cap: "bash-cmd" | "term" | "streaming-bash" | "streaming" | "code" | "diff";
	text: string;
	isStreaming?: boolean;
}) {
	return measureToolCall(
		{
			toolName: "Bash",
			summary: "cmd",
			category: "bash",
			status: "success",
			toolUseId: "tu_1",
			...(opts.isStreaming ? { isStreaming: true } : {}),
			detail: {
				kind: "sections",
				sections: [
					{
						...(opts.label !== undefined ? { label: opts.label } : {}),
						body: {
							kind: "capped",
							cap: opts.cap,
							contentLines: 80,
							hasLabel: false,
							text: opts.text,
						},
					},
				],
			},
		},
		WIDTH,
		5,
		{ opened: true },
	);
}

/**
 * One SINGLE-BLOCK capped card — what `sections()` collapses a lone unlabelled
 * section into (tool-detail.ts). A streaming Write/Edit preview whose path row
 * has not arrived yet renders through this branch.
 */
function cardWithSingleCap(opts: {
	cap: "streaming-bash" | "streaming" | "diff" | "code";
	text: string;
	isStreaming?: boolean;
}) {
	return measureToolCall(
		{
			toolName: "Write",
			summary: "file",
			category: "file",
			status: "success",
			toolUseId: "tu_1",
			...(opts.isStreaming ? { isStreaming: true } : {}),
			detail: {
				kind: "capped",
				cap: opts.cap,
				contentLines: 80,
				hasLabel: false,
				text: opts.text,
			},
		},
		WIDTH,
		5,
		{ opened: true },
	);
}

function renderCard(measured: ReturnType<typeof measureToolCall>): Element {
	return parse(
		renderToStaticMarkup(
			<MantineProvider>
				<I18nextProvider i18n={testI18n}>
					<RenderToolCall measured={measured} />
				</I18nextProvider>
			</MantineProvider>,
		),
	);
}

/** The ONE capped scroll box carrying `needle`. */
function scrollBoxContaining(root: Element, needle: string): Element {
	const boxes = [...root.querySelectorAll("div")].filter((el) =>
		(el.getAttribute("style") ?? "").replaceAll(" ", "").includes("overflow-y:auto"),
	);
	const hits = boxes.filter((el) => el.textContent?.includes(needle));
	if (hits.length !== 1)
		throw new Error(`expected one scroll box with ${needle}, got ${hits.length}`);
	const box = hits[0];
	if (!box) throw new Error("unreachable");
	return box;
}

/** Is the box wrapped in AutoFollowScroll's relative shell (its only marker in SSR)? */
function isFollowWrapped(box: Element): boolean {
	const style = (box.parentElement?.getAttribute("style") ?? "").replaceAll(" ", "");
	return style.includes("position:relative") && style.includes("min-width:0");
}

describe("RenderToolCall — output-tail follow wrapper", () => {
	it("wraps a bash OUTPUT box (term cap)", () => {
		const root = renderCard(cardWithSection({ label: "output", cap: "term", text: LONG_BODY }));
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(true);
	});

	it("wraps a streaming bash OUTPUT box (streaming-bash cap)", () => {
		const root = renderCard(
			cardWithSection({ label: "output", cap: "streaming-bash", text: LONG_BODY }),
		);
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(true);
	});

	it("does NOT wrap the command box — a command reads from the head", () => {
		const root = renderCard(cardWithSection({ label: "command", cap: "bash-cmd", text: "$ top" }));
		expect(isFollowWrapped(scrollBoxContaining(root, "$ top"))).toBe(false);
	});

	it("does NOT wrap an output-labelled CODE box — code reads from the head", () => {
		const root = renderCard(cardWithSection({ label: "output", cap: "code", text: LONG_BODY }));
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(false);
	});

	it("does NOT wrap a term box without the output label (input previews)", () => {
		const root = renderCard(cardWithSection({ cap: "term", text: LONG_BODY }));
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(false);
	});

	it("wraps a streaming Write preview (streaming cap, no label)", () => {
		const root = renderCard(
			cardWithSection({ cap: "streaming", text: LONG_BODY, isStreaming: true }),
		);
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(true);
	});

	it("wraps a streaming Edit diff (diff cap while streaming)", () => {
		const root = renderCard(cardWithSection({ cap: "diff", text: LONG_BODY, isStreaming: true }));
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(true);
	});

	it("does NOT wrap a settled diff — a finished edit reads from the head", () => {
		const root = renderCard(cardWithSection({ cap: "diff", text: LONG_BODY }));
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(false);
	});

	it("wraps a streaming Write preview on the SINGLE-BLOCK path (no path row yet)", () => {
		const root = renderCard(
			cardWithSingleCap({ cap: "streaming", text: LONG_BODY, isStreaming: true }),
		);
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(true);
	});

	it("wraps a streaming Edit diff on the SINGLE-BLOCK path", () => {
		const root = renderCard(cardWithSingleCap({ cap: "diff", text: LONG_BODY, isStreaming: true }));
		expect(isFollowWrapped(scrollBoxContaining(root, "line 42"))).toBe(true);
	});

	it("does NOT wrap a single-block streaming-bash box — the command preview reads from the head", () => {
		const root = renderCard(
			cardWithSingleCap({ cap: "streaming-bash", text: "$ npm test", isStreaming: true }),
		);
		expect(isFollowWrapped(scrollBoxContaining(root, "$ npm test"))).toBe(false);
	});
});
