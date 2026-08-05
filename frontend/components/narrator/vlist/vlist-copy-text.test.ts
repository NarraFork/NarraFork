/**
 * vlist-copy-text.test.ts — the copied text must be the SOURCE text, not the
 * browser's reading of the absolute-positioned layout — and it must be ALL of it.
 *
 * Three symptoms this pins down. The first two came from a real paste and were
 * reproduced in Chrome 146 before the fix:
 *   1. a soft-wrapped paragraph gained a newline at every visual line break;
 *   2. a paragraph boundary came out as TWO newlines, because the caret filler
 *      covering the margin strip serialized as its own line (carrying a U+200B).
 * The third was introduced BY the fix for those two and found in review:
 *   3. the collector only looked at `[data-vlist-line]` /
 *      `[data-vlist-code-line]` / `.vlist-math-display`, which ONLY
 *      render/RenderMarkdown.tsx emits. A selection spanning a markdown paragraph
 *      and a user bubble (or a system card, tool-card body, sidecar body — none of
 *      which carry those markers) returned the markdown alone and DROPPED the rest
 *      in silence. Losing content is worse than the formatting noise the module
 *      exists to remove, so an unmarked body is now reconstructed instead.
 *
 * The DOM fixtures here mirror what the render layer emits: `RenderMarkdown` gives
 * an `[data-vlist-inline-block]` per logical block with `[data-vlist-line]` per
 * VISUAL line inside it, `[data-vlist-caret-filler]` over blank strips, and
 * `[data-vlist-code-line]` for fenced code (whose newlines ARE in the source);
 * `RenderMessageBubble` / `RenderSystemText` / `RenderSidecar` paint one bare
 * `position:absolute; white-space:pre` div per visual line; `RenderToolCall`'s
 * `CappedBodyBox` is ONE `white-space:pre-wrap` box whose newlines are real
 * characters.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";

let doc: Document;

beforeAll(() => {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.Range = (win as unknown as { Range: typeof Range }).Range;
	g.Node = win.Node;
	doc = win.document as unknown as Document;
});

/** One visual line holding pre-split fragment texts. */
const line = (frags: string[]) =>
	`<div data-vlist-line><span data-vlist-line-frags>${frags
		.map((t) => `<span>${t}</span>`)
		.join("")}</span></div>`;

/** One logical inline block wrapping its visual lines. */
const block = (lines: string[]) => `<div data-vlist-inline-block>${lines.join("")}</div>`;

/** The blank-strip filler the render layer puts between blocks. */
const filler = `<div data-vlist-caret-filler>\u200b</div>`;

/**
 * A list row. Everything the shell paints sits inside one of these
 * (`data-nf-row-key`), which is also the scope the unmarked fallback works in.
 */
const row = (inner: string, key = "r1") => `<div data-nf-row-key="${key}">${inner}</div>`;

/**
 * One visual line of an UNMARKED body, exactly as RenderMessageBubble /
 * RenderSystemText / RenderSidecar paint it: absolutely positioned, `white-space:
 * pre`, no vlist marker of any kind.
 */
const rawLine = (text: string) =>
	`<div style="position:absolute;top:0;left:0;white-space:pre">${text}</div>`;

/** A user bubble body: the positioned host plus its per-visual-line boxes. */
const bubbleBody = (lines: string[]) =>
	`<div style="position:absolute;top:0;left:0">${lines.map(rawLine).join("")}</div>`;

/**
 * RenderToolCall's `CappedBodyBox`: ONE `pre-wrap` box. Its newlines are real
 * characters and its children are colour-only Shiki spans (render/TokenLines.tsx),
 * so it must NOT be split per child.
 */
const cappedBody = (inner: string) =>
	`<div style="white-space:pre-wrap;word-break:break-word">${inner}</div>`;

function mount(html: string): Element {
	const root = doc.createElement("div");
	root.innerHTML = html;
	doc.body.appendChild(root);
	return root as unknown as Element;
}

/** Select everything in `root` and rebuild the copy text. */
async function copyAll(root: Element): Promise<string | null> {
	const { buildSelectionCopyText } = await import("./vlist-copy-text");
	const range = doc.createRange();
	range.selectNodeContents(root as unknown as Node);
	return buildSelectionCopyText(range as unknown as Range, root);
}

/**
 * Rebuild the copy text for a PARTIAL selection.
 *
 * linkedom's Range has no `setStart` / `setEnd` (only `selectNode*`), so the
 * boundaries are supplied directly — the same four properties a real
 * `Selection.getRangeAt(0)` exposes, which is all the module reads.
 */
async function copyPartial(
	root: Element,
	start: { node: Node; offset: number },
	end: { node: Node; offset: number },
): Promise<string | null> {
	const { buildSelectionCopyText } = await import("./vlist-copy-text");
	const range = {
		startContainer: start.node,
		startOffset: start.offset,
		endContainer: end.node,
		endOffset: end.offset,
		commonAncestorContainer: root as unknown as Node,
	} as unknown as Range;
	return buildSelectionCopyText(range, root);
}

/** The text node inside the nth `[style]` line box of a subtree. */
function rawTextNode(root: Element, index: number): Node {
	const boxes = [...root.querySelectorAll("div[style*='white-space']")];
	const node = boxes[index]?.firstChild;
	if (!node) throw new Error(`no raw line #${index}`);
	return node as unknown as Node;
}

describe("soft wraps are not source newlines", () => {
	it("joins the visual lines of one paragraph with nothing", async () => {
		// pretext KEEPS the trailing space at a wrap point, so concatenation reproduces
		// the source. That is what makes this exact rather than a guess.
		const root = mount(
			block([line(["The quick brown fox "]), line(["jumps over the lazy dog "]), line(["fast"])]),
		);
		expect(await copyAll(root)).toBe("The quick brown fox jumps over the lazy dog fast");
	});

	it("joins CJK visual lines with nothing", async () => {
		const root = mount(block([line(["这是一个很长的中文段落它会被"]), line(["按宽度拆成两行"])]));
		expect(await copyAll(root)).toBe("这是一个很长的中文段落它会被按宽度拆成两行");
	});

	it("keeps the inter-fragment gap spaces that FragmentGap rendered", async () => {
		// The space around inline code lives in `gapBefore` px; FragmentGap emits it as a
		// real zero-advance space, so it is ordinary text here.
		const root = mount(block([line(["Firefox: ", "clipboardData.files", " is empty."])]));
		expect(await copyAll(root)).toBe("Firefox: clipboardData.files is empty.");
	});
});

describe("paragraph boundaries are exactly one newline", () => {
	it("emits a single newline between blocks and drops the filler", async () => {
		const root = mount(block([line(["第一段。"])]) + filler + block([line(["第二段。"])]));
		const out = await copyAll(root);
		expect(out).toBe("第一段。\n第二段。");
		// The filler's zero-width space must never reach the clipboard.
		expect(out).not.toContain("\u200b");
	});

	it("does not double the newline when several fillers stack up", async () => {
		const root = mount(
			block([line(["一"])]) +
				filler +
				filler +
				block([line(["二"])]) +
				filler +
				block([line(["三"])]),
		);
		expect(await copyAll(root)).toBe("一\n二\n三");
	});

	it("separates a wrapped paragraph from the next one correctly", async () => {
		// The combination that produced the reported paste: wrap inside block 1, real
		// break to block 2.
		const root = mount(
			block([line(["长段落第一视觉行"]), line(["第二视觉行"])]) +
				filler +
				block([line(["下一段"])]),
		);
		expect(await copyAll(root)).toBe("长段落第一视觉行第二视觉行\n下一段");
	});
});

describe("fenced code keeps its real newlines", () => {
	it("joins code lines with newlines", async () => {
		const root = mount(
			`<div><div data-vlist-code-line>const a = 1;</div><div data-vlist-code-line>const b = 2;</div></div>`,
		);
		expect(await copyAll(root)).toBe("const a = 1;\nconst b = 2;");
	});

	it("keeps a blank code line as an empty line", async () => {
		const root = mount(
			`<div><div data-vlist-code-line>a</div><div data-vlist-code-line></div><div data-vlist-code-line>b</div></div>`,
		);
		expect(await copyAll(root)).toBe("a\n\nb");
	});

	it("separates prose from a following code block", async () => {
		const root = mount(
			block([line(["Run this:"])]) + filler + `<div><div data-vlist-code-line>ls -la</div></div>`,
		);
		expect(await copyAll(root)).toBe("Run this:\nls -la");
	});
});

describe("LaTeX copies as source, not as flattened glyphs", () => {
	/**
	 * KaTeX is rendered with `output: "html"` (katex-geometry), so the formula subtree
	 * is presentation spans with NO MathML annotation. Its text serializes to broken
	 * maths — in Chrome 146 `$E = mc^2$` copied as "E=mc \n2", turning the exponent
	 * into a factor. `MathSourceForCopy` puts the real LaTeX beside the visual markup;
	 * the extractor drops `.katex` / `.katex-display` and keeps the source.
	 */
	const inlineMath = (tex: string) =>
		`<span data-vlist-math="inline"><span data-vlist-math-source>$${tex}$</span>` +
		`<span><span class="katex"><span class="katex-html">FLATTENED</span></span></span></span>`;

	it("copies an inline formula's LaTeX with delimiters", async () => {
		const root = mount(
			block([
				`<div data-vlist-line><span data-vlist-line-frags><span>质能方程 </span>${inlineMath("E = mc^2")}<span> 很有名。</span></span></div>`,
			]),
		);
		const out = await copyAll(root);
		expect(out).toBe("质能方程 $E = mc^2$ 很有名。");
		// The visual layer's text must never appear.
		expect(out).not.toContain("FLATTENED");
	});

	it("keeps several formulas on one line distinct", async () => {
		const root = mount(
			block([
				`<div data-vlist-line><span data-vlist-line-frags><span>设 </span>${inlineMath("x_1")}<span> 与 </span>${inlineMath("x_2")}</span></div>`,
			]),
		);
		expect(await copyAll(root)).toBe("设 $x_1$ 与 $x_2$");
	});

	it("copies display math as its own block with $$ delimiters", async () => {
		// Display math is an unpredictable block OUTSIDE any data-vlist-line, so the
		// collector must pick it up in its own right or it vanishes from the copy.
		const root = mount(
			block([line(["推导："])]) +
				filler +
				`<div class="vlist-math-display"><span data-vlist-math-source>$$\\sum_{i=1}^{n} i$$</span>` +
				`<span><span class="katex-display"><span class="katex">FLATTENED</span></span></span></div>`,
		);
		const out = await copyAll(root);
		expect(out).toBe("推导：\n$$\\sum_{i=1}^{n} i$$");
		expect(out).not.toContain("FLATTENED");
	});

	it("does not merge a display formula into an adjacent paragraph", async () => {
		// A standalone block gets its own owner, so it never looks like a soft wrap.
		const root = mount(
			block([line(["前文"])]) +
				`<div class="vlist-math-display"><span data-vlist-math-source>$$a+b$$</span></div>` +
				block([line(["后文"])]),
		);
		expect(await copyAll(root)).toBe("前文\n$$a+b$$\n后文");
	});
});

describe("declines selections it does not own", () => {
	it("returns null when no vlist line and no message row is intersected", async () => {
		const root = mount(`<div><p>plain mantine chrome</p></div>`);
		expect(await copyAll(root)).toBeNull();
	});

	it("returns null for a row that paints only geometry", async () => {
		// A row whose intersected part is a background fill / quote rail has no text to
		// rebuild, so the native payload (also empty) is left alone rather than an
		// empty string being forced onto the clipboard.
		const root = mount(row(`<div style="position:absolute;background:red;width:3px"></div>`));
		expect(await copyAll(root)).toBeNull();
	});
});

describe("unmarked bodies are reconstructed, never dropped", () => {
	it("copies a user bubble that carries no vlist markers at all", async () => {
		// RenderMessageBubble runs layoutWithLines itself and paints bare positioned
		// divs. With the marker-only collector this selection produced null and the
		// browser's own (newline-per-line) serialization stood in; the point here is
		// that the text is present and each painted line is one line.
		const root = mount(row(bubbleBody(["用户第一行", "用户第二行"])));
		expect(await copyAll(root)).toBe("用户第一行\n用户第二行");
	});

	it("keeps BOTH halves of a bubble + markdown selection (the reported loss)", async () => {
		// The exact repro from review: one markdown line anywhere in the selection made
		// `units.length > 0`, so the unmarked bubble above it was silently discarded and
		// the paste contained the assistant paragraph only.
		const root = mount(
			row(bubbleBody(["用户第一行", "用户第二行"]), "r1") + row(block([line(["助手段落"])]), "r2"),
		);
		expect(await copyAll(root)).toBe("用户第一行\n用户第二行\n助手段落");
	});

	it("preserves a blank line inside a user message", async () => {
		// The empty box is a line the reader sees; dropping empty runs unconditionally
		// would collapse a deliberate blank line in a pasted user prompt.
		const root = mount(row(bubbleBody(["a", "", "b"])));
		expect(await copyAll(root)).toBe("a\n\nb");
	});

	it("ignores the geometry-only boxes a body sits among", async () => {
		// Blockquote rails / background fills are positioned divs with no white-space
		// declaration; treating them as lines would inject blank lines into the paste.
		const root = mount(
			row(
				`<div style="position:absolute;background:red;width:3px"></div>` +
					rawLine("正文") +
					`<div style="position:absolute;background:blue;width:3px"></div>`,
			),
		);
		expect(await copyAll(root)).toBe("正文");
	});

	it("copies a system card body (RenderSystemText's positioned lines)", async () => {
		const root = mount(row(bubbleBody(["系统提示第一行", "系统提示第二行"]), "sys"));
		expect(await copyAll(root)).toBe("系统提示第一行\n系统提示第二行");
	});
});

describe("a tool card's pre body keeps its own newlines and is not re-split", () => {
	it("does not split a CappedBodyBox per Shiki colour span", async () => {
		// `CappedBodyBox` is ONE pre-wrap box; its children are colour-only spans
		// (TokenLines.tsx tokenSpans). Breaking a line at every element boundary would
		// turn a highlighted body into one line per token.
		const root = mount(
			row(
				cappedBody(
					`<span style="color:#569cd6">const</span><span> a = 1;</span>\nline two\nline three`,
				),
				"tool",
			),
		);
		expect(await copyAll(root)).toBe("const a = 1;\nline two\nline three");
	});

	it("drops the diff gutter marker the renderer marked unselectable", async () => {
		// DiffTextFallback paints the +/- marker with `user-select: none`, so Chrome
		// leaves it out of a native copy. Our own extraction must agree, or every
		// pasted diff line gains a leading sign the reader did not select.
		const root = mount(
			row(
				cappedBody(
					`<span style="white-space:pre;user-select:none;opacity:0.6">+</span>` +
						`<span>added line</span>`,
				),
				"diff",
			),
		);
		expect(await copyAll(root)).toBe("added line");
	});

	it("keeps a tool body and a markdown paragraph together", async () => {
		// The mixed shape a "read the plan, then the tool output" copy produces: the
		// markdown body is marked, the capped box is not, and both must survive.
		const root = mount(
			row(
				`<div style="white-space:pre">Read src/a.ts</div>` +
					block([line(["计划正文"])]) +
					cappedBody("尾部 pre 正文\n第二行"),
				"tc",
			),
		);
		expect(await copyAll(root)).toBe("Read src/a.ts\n计划正文\n尾部 pre 正文\n第二行");
	});
});

describe("a sidecar body survives a mixed selection", () => {
	it("copies the sidecar's positioned lines alongside markdown", async () => {
		// RenderSidecar's SidecarBody paints one absolute div per pretext line with no
		// marker, so the marker-only collector dropped the whole card whenever the
		// selection also reached an assistant paragraph.
		const root = mount(
			row(block([line(["助手说明"])]), "a") +
				row(bubbleBody(["sidecar 第一行", "sidecar 第二行"]), "sc"),
		);
		expect(await copyAll(root)).toBe("助手说明\nsidecar 第一行\nsidecar 第二行");
	});

	it("keeps the sidecar header chrome in reading order", async () => {
		// Badges / labels are ordinary inline Mantine content inside the row. They are
		// part of what the reader highlighted, so they belong in the paste — above the
		// body, which is where the header is painted.
		const root = mount(
			row(
				`<div><span>system</span><span> · </span><span>spec</span></div>` +
					bubbleBody(["注入正文"]),
				"sc",
			),
		);
		expect(await copyAll(root)).toBe("system · spec\n注入正文");
	});
});

describe("a partial selection copies only what was highlighted", () => {
	it("clips a marked markdown line to the selected half", async () => {
		const root = mount(row(block([line(["助手段落文本"])]), "a"));
		const text = root.querySelector("[data-vlist-line-frags] span")?.firstChild as unknown as Node;
		expect(await copyPartial(root, { node: text, offset: 1 }, { node: text, offset: 3 })).toBe(
			"手段",
		);
	});

	it("clips an unmarked bubble line to the selected half", async () => {
		// The fallback reads live text nodes, so it has to apply the same boundary
		// offsets the marked path does — otherwise dragging over half a user message
		// pastes the whole line.
		const root = mount(row(bubbleBody(["用户第二行"])));
		const text = rawTextNode(root, 0);
		expect(await copyPartial(root, { node: text, offset: 2 }, { node: text, offset: 4 })).toBe(
			"第二",
		);
	});

	it("clips both ends of a selection that spans a bubble and a paragraph", async () => {
		// Start mid-way through the bubble's second line, end mid-way through the
		// assistant paragraph: the first bubble line is entirely before the start and
		// must not appear at all.
		const root = mount(
			row(bubbleBody(["用户第一行", "用户第二行"]), "r1") +
				row(block([line(["助手段落文本"])]), "r2"),
		);
		const bubbleText = rawTextNode(root, 1);
		const markdownText = root.querySelector("[data-vlist-line-frags] span")
			?.firstChild as unknown as Node;
		expect(
			await copyPartial(root, { node: bubbleText, offset: 1 }, { node: markdownText, offset: 4 }),
		).toBe("户第二行\n助手段落");
	});
});
