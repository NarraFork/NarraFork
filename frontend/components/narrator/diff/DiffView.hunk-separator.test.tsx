/**
 * DiffView's git-patch path: the `@@` separator, and syntax colour on word-diffed
 * rows.
 *
 * The pure pieces are already covered elsewhere — `parse-unified-diff.test.ts`
 * pins the parsed `range`, and `diff-word-tokens.test.ts` pins the token/chunk
 * intersection including every degradation case. What neither can see is the
 * WIRING between them, which is where both bugs actually lived:
 *
 *   - a renderer that ignores `hunks` draws no separator at all;
 *   - `DiffView` passed `tokens={undefined}` for any row carrying `wordChanges`,
 *     so modified lines — the rows a reader looks at first — were the only ones
 *     rendered without syntax colour, while an unpaired addition beside them kept
 *     it. `RenderToolCall` had always passed both.
 *
 * So these tests assert from the real DOM, and deliberately do NOT restate the
 * palette or the gutter arithmetic: re-reading a constant back out of the source
 * catches nothing and breaks on every legitimate tweak.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearShikiTokenCache } from "@frontend/lib/shiki-token-cache";
import { MantineProvider } from "@mantine/core";
import { parseUnifiedDiff } from "@shared/pretext-layout/parse-unified-diff";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";

/**
 * Shiki cannot run here (it wants `import.meta.env` and a wasm engine), so the
 * loader is replaced with a deterministic tokeniser: one token spanning each whole
 * line. What matters is only that the tokens partition each line EXACTLY —
 * `sliceTokensByWordChanges` refuses to slice when token and chunk lengths
 * disagree, which is precisely the silent-fallback this suite must not hit.
 *
 * The stub also emulates the ONE grammar behaviour under test: a line-by-line
 * state machine. Once a line opens `/*`, every following line in that same source
 * is "inside a comment" until one closes it. Real Shiki does this; a stateless stub
 * could not show that splitting the sides is what fixes the leak.
 */
const realShikiLoader = { ...(await import("../../../lib/shiki-loader")) };

const FAKE_TOKEN_COLOR = "#ff00ff";
const FAKE_COMMENT_COLOR = "#8b949e";

function tokenizeStatefully(code: string) {
	let inComment = false;
	return code.split("\n").map((line) => {
		const opensHere = !inComment && line.includes("/*");
		const wasInComment = inComment;
		if (opensHere) inComment = true;
		if (inComment && line.includes("*/")) inComment = false;
		const color = wasInComment || opensHere ? FAKE_COMMENT_COLOR : FAKE_TOKEN_COLOR;
		return line.length === 0 ? [] : [{ content: line, color, offset: 0, fontStyle: 0 }];
	});
}

mock.module("../../../lib/shiki-loader", () => ({
	...realShikiLoader,
	loadShiki: async () => ({
		bundledLanguages: { typescript: {} },
		codeToHtml: async () => "",
		codeToTokens: async (code: string) => ({ tokens: tokenizeStatefully(code) }),
	}),
}));

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");
installCanvasStub();
const { DiffView } = await import("./DiffView");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);

	Object.assign(window, {
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

/**
 * Two hunks with a wide gap, each shaped 1-removal-then-1-addition so pairing
 * produces `wordChanges`, plus trailing context that stays unpaired.
 */
const PATCH = [
	"diff --git a/src/x.ts b/src/x.ts",
	"index 1111111..2222222 100644",
	"--- a/src/x.ts",
	"+++ b/src/x.ts",
	"@@ -12,6 +12,7 @@ export function first() {",
	" const keep = 1;",
	"-const gone = 2;",
	"+const added = 2;",
	" const tail = 3;",
	"@@ -192,7 +192,7 @@ export function second() {",
	" const far = 1;",
	"-const old = 2;",
	"+const fresh = 2;",
	"",
].join("\n");

/**
 * A diff whose removed side opens a block comment the added side does not.
 * Merged into one document, the old comment stays open over the context row.
 */
const LEAKY_PATCH = [
	"diff --git a/y.ts b/y.ts",
	"--- a/y.ts",
	"+++ b/y.ts",
	"@@ -1,4 +1,4 @@",
	"-/* legacy note",
	"+// short note",
	" const value = 1;",
	"-*/",
	"+const kept = 2;",
	"",
].join("\n");

function renderPatch(language?: string, patch: string = PATCH, onNearBottom?: () => void) {
	const parsed = parseUnifiedDiff(patch);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	root.render(
		<MantineProvider>
			<DiffView
				// This fixture owns a known box; linkedom cannot resolve CSS flex geometry.
				layout={{ width: 700, height: 400 }}
				lines={parsed.lines}
				hunks={parsed.hunks}
				maxHeight={400}
				gutterMinWidth={1}
				language={language}
				onNearBottom={onNearBottom}
			/>
		</MantineProvider>,
	);
	return parsed;
}

function separators(): HTMLElement[] {
	return Array.from(
		container?.querySelectorAll<HTMLElement>('[data-diff-hunk-separator="true"]') ?? [],
	);
}

/**
 * The content rows, in row order, separators excluded. DiffView nests the row list
 * inside a scroll Box, so find the list via a separator's parent rather than
 * hard-coding the depth.
 */
function diffRows(): HTMLElement[] {
	return Array.from(container?.querySelectorAll<HTMLElement>("[data-diff-row]") ?? []);
}

/** Row indexes that rendered at least one span in `color`. */
function rowIndexesColoured(rows: readonly HTMLElement[], color: string): number[] {
	return rows
		.map((row, index) => ({
			index,
			hit: Array.from(row.querySelectorAll("span")).some(
				(span) => (span as HTMLElement).style.color === color,
			),
		}))
		.filter(({ hit }) => hit)
		.map(({ index }) => index);
}

/** Row indexes that rendered at least one syntax-coloured span. */
function colouredRowIndexes(rows: readonly HTMLElement[]): number[] {
	return rowIndexesColoured(rows, FAKE_TOKEN_COLOR);
}

function flushRender() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the highlight to land.
 *
 * `useTokenMap` chains loadShiki → codeToTokens → setState, so a fixed number of
 * ticks is a race. Poll for the first coloured span instead and fail loudly if it
 * never appears — a silent timeout would make the colour assertions vacuous.
 */
async function waitForHighlight() {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (colouredRowIndexes(diffRows()).length > 0) return;
		await flushRender();
	}
	throw new Error("syntax highlighting never rendered; the shiki stub did not resolve");
}

describe("DiffView", () => {
	beforeEach(() => {
		installDom();
	});

	afterEach(() => {
		root?.unmount();
		container?.remove();
		root = undefined;
		container = undefined;
	});

	afterAll(() => {
		// `mock.module` is process-wide and survives `mock.restore()`, so the real
		// loader has to be handed back or every later suite gets the fake tokeniser.
		clearShikiTokenCache();
		mock.module("../../../lib/shiki-loader", () => realShikiLoader);
		mock.restore();
	});

	test("draws one `@@ range @@` band per hunk, with git's counts and heading", async () => {
		renderPatch();
		await flushRender();

		const rows = separators();
		expect(rows).toHaveLength(2);
		// Reprinting the parsed range verbatim is what keeps the counts: rebuilding
		// from oldStart/newStart would render `@@ -192 +192 @@` here.
		expect(rows[0]?.textContent).toContain("@@ -12,6 +12,7 @@ export function first()");
		expect(rows[1]?.textContent).toContain("@@ -192,7 +192,7 @@ export function second()");
	});

	test("keeps syntax colour on word-diffed rows, not only on unpaired ones", async () => {
		const parsed = renderPatch("typescript");
		await waitForHighlight();

		const paired = parsed.lines.flatMap((line, index) =>
			line.wordChanges && line.wordChanges.length > 0 ? [index] : [],
		);
		// Guard the fixture itself: pairing must produce word changes on some rows and
		// leave others unpaired, or this test would pass for the wrong reason.
		expect(paired).toEqual([1, 2, 5, 6]);

		const coloured = colouredRowIndexes(diffRows());
		for (const index of paired) {
			expect(coloured).toContain(index);
		}
	});

	test("renders the row text byte-identically when tints and tokens intersect", async () => {
		const parsed = renderPatch("typescript");
		await waitForHighlight();

		// Slicing tokens on chunk boundaries must not duplicate or drop characters.
		const rows = diffRows();
		for (const [index, line] of parsed.lines.entries()) {
			expect(rows[index]?.textContent).toContain(line.content);
		}
	});

	test("does not let a removed multi-line construct recolour untouched context", async () => {
		// The old side wraps the middle line in a block comment; the new side replaced
		// that with a line comment. Tokenizing one merged document leaves the old
		// comment open, painting the UNCHANGED `const value = 1;` comment-grey.
		const parsed = renderPatch("typescript", LEAKY_PATCH);
		await waitForHighlight();

		const rows = diffRows();
		const contextRow = parsed.lines.findIndex(
			(line) => line.type === "context" && line.content === "const value = 1;",
		);
		expect(contextRow).toBeGreaterThan(0);

		// It reads from the NEW side, where it is ordinary code.
		expect(colouredRowIndexes(rows)).toContain(contextRow);
		expect(rowIndexesColoured(rows, FAKE_COMMENT_COLOR)).not.toContain(contextRow);

		// The removed row still reads from the OLD side, where it genuinely opens a
		// comment — the fix must not flatten both sides into the new file.
		const removedRow = parsed.lines.findIndex((line) => line.type === "removed");
		expect(rowIndexesColoured(rows, FAKE_COMMENT_COLOR)).toContain(removedRow);
	});

	test("does not call a pre-computed 500-row segment truncated", async () => {
		const body = Array.from({ length: 500 }, (_, index) => ` line${index}`);
		const patch = [`@@ -1,500 +1,500 @@`, ...body].join("\n");
		renderPatch(undefined, patch);
		await flushRender();

		expect(container?.textContent).not.toContain("diff truncated at 500 lines");
	});

	test("fires near-bottom once until the reader leaves the bottom zone", async () => {
		let calls = 0;
		const body = Array.from({ length: 200 }, (_, index) => ` line${index}`);
		const patch = ["@@ -1,200 +1,200 @@", ...body].join("\n");
		renderPatch(undefined, patch, () => {
			calls++;
		});
		await flushRender();

		const scroller = container?.querySelector<HTMLElement>("[data-content-scrollport]");
		if (!scroller) throw new Error("declared scrollport missing");
		const content = scroller.querySelector<HTMLElement>("[data-content-box]");
		if (!content) throw new Error("declared content box missing");
		// These are model-owned CSS declarations, not simulated client/scroll dimensions.
		// The actual 200-row payload determines the content extent, including its hunk.
		const scrollHeight = Number.parseFloat(content.style.height);
		const viewportHeight = Number.parseFloat(scroller.style.height);
		const contentOrigin = Number.parseFloat(content.style.padding);
		expect(scroller.getAttribute("data-content-geometry")).toBe("layout");
		expect(viewportHeight).toBe(400);
		expect(scrollHeight).toBeGreaterThan(viewportHeight + 240);
		expect(contentOrigin).toBe(10);
		// DiffContent compares content-local top, so include the declared top inset.
		const zoneStart = scrollHeight - viewportHeight - 120 + contentOrigin;
		const outsideZone = zoneStart - 50;
		const insideZone = zoneStart + 1;
		scroller.scrollTop = outsideZone;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushRender();
		expect(calls).toBe(0);

		scroller.scrollTop = insideZone;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushRender();
		expect(calls).toBe(1);

		// Leaving the 120px zone resets the latch. Returning to it represents the
		// next deliberate downward scroll and may load one more segment.
		scroller.scrollTop = outsideZone;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushRender();
		scroller.scrollTop = insideZone;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushRender();
		expect(calls).toBe(2);
	});
});
