/**
 * vlist-copy-text.ts — Rebuild the SOURCE text of a selection over the exact list.
 *
 * ## Why the browser cannot do this
 *
 * The zero-DOM height model paints every markdown block, every visual line and every
 * text fragment as an absolutely positioned box. The plain-text serializer only knows
 * computed styles, so it reads that geometry as document structure and inserts a line
 * break at every block boundary. Two of those boundaries are pure layout artifacts:
 *
 *   1. **Soft wraps.** pretext splits ONE paragraph into N visual lines, each its own
 *      `<div data-vlist-line>`. The source had no newline there, but the serializer
 *      emits N-1 of them. (Reproduced in Chrome 146.)
 *   2. **Caret fillers.** Every blank strip — paragraph margins, inter-line gaps, the
 *      empty tail of a clamped code box — is covered by a `<div>` holding a U+200B so
 *      a drag-selection can resolve a caret there (see render/caret-filler.tsx).
 *      Each one serializes as its own line, so a paragraph break came out as TWO
 *      newlines with an invisible zero-width space between them.
 *
 * Both are invisible on screen and both corrupt what the reader pastes. No CSS fixes
 * them: the earlier attempt to un-blockify the lines (a plain block line instead of a
 * flex line) removed the newline between visual lines but also removed it between
 * real paragraphs, because at the DOM level those look identical without the
 * `data-vlist-inline-block` boundary this module reads.
 *
 * ## The reconstruction
 *
 * A single fact makes this exact rather than heuristic: **pretext keeps the trailing
 * space at a soft-wrap point** — laying out "…brown fox jumps…" yields a line whose
 * text ends `"…brown fox "`. So visual lines of the same logical block concatenate
 * with NO separator and reproduce the source, for English and CJK alike. The only
 * missing character is the inter-fragment space pretext encodes as `gapBefore`
 * pixels, which `FragmentGap` already renders as a real (zero-advance) space, so it
 * is present in the DOM text.
 *
 * Therefore:
 *   - fragments within a line  → concatenate (the gap spaces are real text nodes)
 *   - visual lines within one `data-vlist-inline-block` → concatenate
 *   - separate inline blocks / rows → join with "\n"
 *   - caret fillers → skipped entirely
 *   - code lines (`data-vlist-code-line`) → joined with "\n" (a fenced block's
 *     newlines ARE in the source)
 *
 * ## Bodies that carry no line markers
 *
 * Only render/RenderMarkdown.tsx (with render/line-fragments.tsx) emits those
 * markers. Four other renderers paint prose as bare absolutely-positioned boxes:
 * `RenderMessageBubble` (user bubble body + slash-command expansion),
 * `RenderSystemText`, `RenderSidecar` and `RenderToolCall`'s detail bodies.
 *
 * Collecting ONLY marked nodes therefore silently DROPPED all of them the moment a
 * selection also touched one markdown line — a cross-message copy pasted the
 * assistant's paragraph and nothing else. That is strictly worse than the layout
 * artifacts this module exists to fix: dirty formatting with complete text beats
 * clean formatting with missing text. So the walk covers the whole subtree and
 * anything unmarked is reconstructed from its box structure:
 *
 *   - **Block boundary = line break.** Those renderers paint one absolutely
 *     positioned box per VISUAL line, so "one box, one line" is what a reader sees
 *     and what the native serializer would produce. It cannot tell a soft wrap from a
 *     hard one there (no `data-vlist-inline-block` equivalent exists), so it does not
 *     try — see the limitation note below.
 *   - **Inline children stay on their line.** `RenderToolCall`'s `CappedBodyBox` is
 *     ONE `white-space: pre-wrap` box whose newlines are real characters and whose
 *     children are colour-only Shiki `<span>`s (render/TokenLines.tsx). Splitting per
 *     span would shred it into one line per token, so only BLOCK-level tags break a
 *     line; everything inline is appended to the current run.
 *   - **An empty text box still counts as a line.** All four renderers put
 *     `white-space: pre*` on their text boxes, so a blank line in a user message
 *     survives, while the geometry-only boxes that carry no white-space declaration
 *     (blockquote rails, background fills) contribute nothing.
 *
 * Reconstructed (as opposed to marked) text only counts inside a
 * `[data-nf-row-key]` subtree — the list's message rows. A selection that touches
 * neither a marker nor a row is left to the browser, which is what "decline the
 * selection" has always meant here (plain Mantine chrome, an input, the tail footer).
 *
 * ### Known limitation (would need the render layer)
 *
 * Inside an unmarked body a soft wrap and a real newline are indistinguishable, so a
 * wrapped user message pastes with a newline at each wrap point — same as the native
 * result, and no longer a dropped message. The complete fix is for every renderer to
 * emit `data-vlist-line` inside a `data-vlist-inline-block`, which is a change to
 * four render modules rather than to this one.
 *
 * ## Scope
 *
 * This runs on `copy` (and `cut`) over the list container and rewrites
 * `clipboardData`. `copy` + `setData` needs no secure context, unlike
 * `navigator.clipboard.*`, so it works over plain HTTP — which matters because the
 * list is served that way in self-hosted deployments.
 */

/** Marks one logical inline block (paragraph / heading / list item). */
const BLOCK_ATTR = "data-vlist-inline-block";
/** Marks one VISUAL line inside a block — a soft wrap, not a source newline. */
const LINE_ATTR = "data-vlist-line";
/** Marks one line of a fenced code block, where newlines ARE in the source. */
const CODE_LINE_ATTR = "data-vlist-code-line";
/** Invisible caret-resolution filler; never part of the text. */
const FILLER_ATTR = "data-vlist-caret-filler";
/** A row of the list shell (one message / tool card / etc). */
const ROW_ATTR = "data-nf-row-key";
/**
 * A DISPLAY formula's block. It is not inside any `data-vlist-line` (display math is
 * an "unpredictable block" with its own frame), so it has to be collected in its own
 * right or it is dropped from the copy entirely.
 */
const MATH_DISPLAY_CLASS = "vlist-math-display";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * How a unit relates to its neighbours.
 *
 *   line       — a marked VISUAL line; merges with the next one of the same owner
 *                (that boundary is a soft wrap, absent from the source).
 *   code       — a fenced-code line; its newline IS in the source.
 *   standalone — a display formula: its own block, never a soft wrap.
 *   raw        — reconstructed from an unmarked body; one box, one line.
 */
type UnitKind = "line" | "code" | "standalone" | "raw";

/**
 * A unit of reconstructed text plus the structure it came from, so the caller can
 * decide whether a newline belongs between two units.
 */
interface TextUnit {
	text: string;
	/** The logical container this unit belongs to; different owners → newline. */
	owner: Element | null;
	kind: UnitKind;
}

/** One end of the selection: a node plus an offset into it. */
interface Boundary {
	node: Node;
	offset: number;
}

/**
 * The selection's position, advanced as the walk moves through the document.
 *
 * Why a cursor instead of comparing positions: the boundaries have to be resolved
 * against DOCUMENT ORDER, and `compareDocumentPosition` cannot be trusted to supply
 * it. `linkedom` (which the tests run on) answers PRECEDING for a node that plainly
 * follows, as long as the two sit in different subtrees. A walk that already visits
 * every node in document order does not need the comparison at all: it just notes
 * when it passes each boundary. That is exact on every DOM, browser included.
 */
interface Cursor {
	/** Selection start, or null when it lies at/before the root (nothing to skip). */
	start: Boundary | null;
	/** Selection end, or null when it lies at/after the root. */
	end: Boundary | null;
	/** The start boundary has not been passed yet. */
	pending: boolean;
	/** The end boundary has been passed; everything after it is out. */
	done: boolean;
}

interface WalkCtx {
	cursor: Cursor;
	units: TextUnit[];
	/** The in-progress inline run of the unmarked fallback. */
	buf: string;
	/** The box `buf` is accumulating in — it decides whether spacing is content. */
	box: Element | null;
}

/** What a subtree is allowed to contribute. */
interface Scope {
	/**
	 * Unmarked text here is content worth rebuilding.
	 *
	 * True inside a `[data-nf-row-key]` (a message row) and inside a marked
	 * terminal. False elsewhere, which is how a selection over plain Mantine chrome
	 * still declines and leaves the native payload alone.
	 */
	keepText: boolean;
	/**
	 * The subtree contributes nothing. Its text is still consumed so the cursor
	 * keeps advancing — a selection may well start inside an excluded span.
	 */
	muted: boolean;
}

/** The nearest ancestor that groups visual lines into one logical block. */
function ownerOf(node: Element): Element | null {
	return node.closest(`[${BLOCK_ATTR}]`) ?? node.closest(`[${ROW_ATTR}]`);
}

/**
 * Walk the selection and collect its text, respecting the vlist's structure rather
 * than the browser's reading of it.
 *
 * Returns null when the range intersects nothing this module can reconstruct — no
 * marked line and no message row — which is the signal to leave the native
 * clipboard payload alone.
 */
export function buildSelectionCopyText(range: Range, root: Element): string | null {
	const ctx: WalkCtx = {
		cursor: openCursor(range, root),
		units: [],
		buf: "",
		box: null,
	};
	// One pass in document order, which is also reading order — the absolute `top`
	// offsets follow it by construction (accumulateFrame). Marked lines, display
	// formulas and unmarked bodies therefore interleave in the right places.
	visitElement(root, { keepText: hasRowAncestor(root), muted: false }, ctx);
	flushRun(ctx);

	const units = ctx.units;
	if (units.length === 0) return null;

	let out = "";
	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		if (i > 0) {
			const prev = units[i - 1];
			// Same logical block AND both marked visual lines → a soft wrap, which the
			// source had no newline for. Everything else is a real boundary.
			const softWrap = unit.kind === "line" && prev.kind === "line" && unit.owner === prev.owner;
			if (!softWrap) out += "\n";
		}
		out += unit.text;
	}
	return out;
}

/** Is `root` itself inside a message row (a row mounted as the walk root)? */
function hasRowAncestor(root: Element): boolean {
	return typeof root.closest === "function" && root.closest(`[${ROW_ATTR}]`) != null;
}

/**
 * Read the range's endpoints, dropping any that lies outside `root`.
 *
 * A selection can start above the list and end inside it (or the reverse). Keeping
 * an unreachable boundary would leave the cursor pending for the whole walk and
 * produce an empty result, so an out-of-root endpoint means "the selection already
 * covers this edge of the subtree".
 */
function openCursor(range: Range, root: Element): Cursor {
	const start = boundaryWithin(root, range.startContainer, range.startOffset);
	const end = boundaryWithin(root, range.endContainer, range.endOffset);
	return { start, end, pending: start != null, done: false };
}

function boundaryWithin(
	root: Element,
	node: Node | undefined | null,
	offset: number | undefined,
): Boundary | null {
	if (node == null || typeof offset !== "number") return null;
	if (node !== root && !(typeof root.contains === "function" && root.contains(node))) return null;
	return { node, offset };
}

/** Is the walk currently between the two boundaries? */
function insideSelection(cursor: Cursor): boolean {
	return !cursor.pending && !cursor.done;
}

/**
 * Note the boundaries that point at `parent`'s child slot `index`.
 *
 * An element-anchored boundary sits BETWEEN children (`childNodes[offset - 1]` and
 * `childNodes[offset]`), so it is crossed exactly here — including at
 * `index === childNodes.length`, which is "after the last child".
 */
function passSlot(parent: Node, index: number, cursor: Cursor): void {
	const { start, end } = cursor;
	if (cursor.pending && start != null && start.node === parent && start.offset === index) {
		cursor.pending = false;
	}
	if (!cursor.done && end != null && end.node === parent && end.offset === index) {
		cursor.done = true;
	}
}

/**
 * The selected slice of one text node, advancing the cursor across it.
 *
 * Returns "" for text before the start boundary or after the end one; the cursor
 * flips as each boundary is met, so no position comparison is needed.
 */
function takeText(node: Node, cursor: Cursor): string {
	if (cursor.done) return "";
	const data = (node as Text).data ?? "";
	let from = 0;
	if (cursor.pending) {
		if (cursor.start?.node !== node) return "";
		cursor.pending = false;
		from = cursor.start.offset;
	}
	let to = data.length;
	if (cursor.end != null && cursor.end.node === node) {
		to = cursor.end.offset;
		cursor.done = true;
	}
	return from >= to ? "" : data.slice(from, to);
}

/**
 * Visit one element in document order.
 *
 * The dispatch is deliberately flat — a marked line, a code line and a display
 * formula are TERMINALS whose text is exact; everything else is structure, where a
 * block-level tag ends a line and an inline one does not.
 */
function visitElement(el: Element, scope: Scope, ctx: WalkCtx): void {
	if (ctx.cursor.done) return;
	const muted = scope.muted || isExcluded(el);
	const keepText = scope.keepText || el.hasAttribute(ROW_ATTR);
	const inner: Scope = { keepText, muted };

	if (!muted) {
		// A marked terminal is exact wherever it sits, row or not: its own text is
		// always content (`keepText: true` below).
		if (el.hasAttribute(LINE_ATTR)) {
			emitTerminal(el, ctx, "line", ownerOf(el));
			return;
		}
		if (el.hasAttribute(CODE_LINE_ATTR)) {
			emitTerminal(el, ctx, "code", el.parentElement);
			return;
		}
		if (el.classList?.contains(MATH_DISPLAY_CLASS)) {
			emitTerminal(el, ctx, "standalone", el);
			return;
		}
		if (keepText && tagOf(el) === "br") {
			ctx.buf += "\n";
			return;
		}
	}

	const block = isBlockElement(el);
	if (block) flushRun(ctx);
	const mark = ctx.units.length;
	const wasInside = insideSelection(ctx.cursor);
	visitChildren(el, inner, ctx);
	if (!block) return;

	flushRun(ctx);
	// A text box that produced nothing is still a line the reader sees (a blank line
	// in a user message). Boxes with no `white-space` declaration are geometry only
	// (blockquote rails, background fills) and must stay silent — and so must a box
	// the selection never reached.
	if (
		!muted &&
		keepText &&
		ctx.units.length === mark &&
		isPreTextBox(el) &&
		(wasInside || insideSelection(ctx.cursor))
	) {
		ctx.units.push({ text: "", owner: null, kind: "raw" });
	}
}

/** Iterate children in document order, crossing the boundaries between them. */
function visitChildren(el: Element, scope: Scope, ctx: WalkCtx): void {
	const kids = childNodes(el);
	for (let i = 0; i < kids.length; i++) {
		passSlot(el, i, ctx.cursor);
		if (ctx.cursor.done) return;
		const child = kids[i];
		if (child.nodeType === TEXT_NODE) {
			const text = takeText(child, ctx.cursor);
			// Muted / out-of-scope text is still CONSUMED above, so the cursor keeps
			// advancing; it just never reaches the output.
			if (!scope.muted && scope.keepText && text.length > 0) {
				ctx.buf += text;
				ctx.box ??= el;
			}
			continue;
		}
		if (child.nodeType === ELEMENT_NODE) visitElement(child as Element, scope, ctx);
	}
	passSlot(el, kids.length, ctx.cursor);
}

/**
 * Emit one exactly-reconstructable unit (a marked visual line, a fenced-code line or
 * a display formula), keeping it out of the unmarked fallback's inline run.
 *
 * The text is harvested through the same cursor, so a partial selection copies only
 * the highlighted part of the line.
 */
function emitTerminal(el: Element, ctx: WalkCtx, kind: UnitKind, owner: Element | null): void {
	// Closes (and empties) any pending inline run, so the buffer below collects this
	// terminal's text alone.
	flushRun(ctx);
	const wasInside = insideSelection(ctx.cursor);
	visitChildren(el, { keepText: true, muted: false }, ctx);
	const text = stripZeroWidth(ctx.buf);
	ctx.buf = "";
	ctx.box = null;
	// An intentionally blank code line keeps its newline, but only when the selection
	// actually covers it.
	const keepEmpty = kind === "code" && (wasInside || insideSelection(ctx.cursor));
	if (text.length === 0 && !keepEmpty) return;
	ctx.units.push({ text, owner, kind });
}

/** Close the current inline run as one line. */
function flushRun(ctx: WalkCtx): void {
	const text = stripZeroWidth(ctx.buf);
	const box = ctx.box;
	ctx.buf = "";
	ctx.box = null;
	if (text.length === 0) return;
	// Indentation between element tags is source formatting, not content — unless the
	// box declares `white-space: pre*`, where spacing is exactly what it renders.
	if (text.trim().length === 0 && !(box != null && isPreTextBox(box))) return;
	ctx.units.push({ text, owner: null, kind: "raw" });
}

/**
 * Subtrees that must never contribute their own text.
 *
 * 1. **Caret fillers** — their U+200B exists so a blank strip can resolve a caret.
 * 2. **KaTeX visual markup** — `katex-geometry` renders with `output: "html"`, so the
 *    formula subtree is presentation spans with no MathML annotation. Its text
 *    serializes to broken maths (`E = mc^2` → `"E=mc 2"`, the exponent flattened into
 *    a factor). `MathSourceForCopy` puts the real LaTeX beside it (OUTSIDE `.katex`),
 *    so dropping the visual half leaves only the source.
 * 3. **`user-select: none`** — the renderers' own "not text" marker (diff gutters,
 *    the KaTeX layer, fold chrome). Chrome honours it in a native copy; honour it
 *    here too, or every pasted diff line gains a leading +/- nobody selected.
 * 4. **The legacy `clip: rect(...)` screen-reader idiom** — `RenderToolCall`'s link
 *    overlay hides a duplicate of the visible label that way, so keeping it would
 *    paste the URL twice. `MathSourceForCopy` uses `clip-path` instead precisely
 *    because its text MUST be copyable, so the two idioms do not collide.
 */
function isExcluded(el: Element): boolean {
	if (el.hasAttribute?.(FILLER_ATTR)) return true;
	const classes = el.classList;
	if (classes?.contains("katex") || classes?.contains("katex-display")) return true;
	const style = styleOf(el);
	if (style == null) return false;
	if (style.userSelect === "none" || style.webkitUserSelect === "none") return true;
	return typeof style.clip === "string" && style.clip.startsWith("rect");
}

/** Does this box paint text, or is it pure geometry? See `visitElement`. */
function isPreTextBox(el: Element): boolean {
	const whiteSpace = styleOf(el)?.whiteSpace;
	return typeof whiteSpace === "string" && whiteSpace.startsWith("pre");
}

function styleOf(el: Element): (CSSStyleDeclaration & { webkitUserSelect?: string }) | null {
	const styled = el as Element & {
		style?: CSSStyleDeclaration & { webkitUserSelect?: string };
	};
	return styled.style ?? null;
}

function tagOf(el: Element): string {
	return el.tagName?.toLowerCase?.() ?? "";
}

/**
 * Tags whose boundary is a line break in the unmarked fallback.
 *
 * Deliberately a tag list rather than a computed `display` lookup: the render layer
 * paints its text boxes as `<div>`s and its inline runs as `<span>`s, and a tag list
 * is the one rule that behaves identically in a browser and in the layout-free DOM
 * the tests run against.
 */
const BLOCK_TAGS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"button",
	"caption",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"legend",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);

function isBlockElement(el: Element): boolean {
	return BLOCK_TAGS.has(tagOf(el));
}

function childNodes(node: Node): Node[] {
	return Array.from(node.childNodes ?? []);
}

/** Zero-width spaces exist only to make blank strips caret-resolvable. */
function stripZeroWidth(text: string): string {
	return text.replace(/\u200b/g, "");
}

/**
 * Install the copy/cut interceptor on the list's scroll container.
 *
 * Returns a disposer. Safe to call when `root` is null (no-op), so callers can wire it
 * straight into a ref effect.
 */
export function installVListCopyHandler(root: Element | null): () => void {
	if (!root) return () => {};
	const doc = root.ownerDocument;
	const onCopy = (event: Event) => {
		const clipboardEvent = event as ClipboardEvent;
		const data = clipboardEvent.clipboardData;
		if (!data) return;
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);
		// Only touch selections that actually live in this list.
		const anchor = range.commonAncestorContainer;
		const anchorEl = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
		if (!anchorEl || !root.contains(anchorEl)) return;

		const text = buildSelectionCopyText(range, root);
		if (text == null) return;
		data.setData("text/plain", text);
		// Keep the rich flavour consistent with the plain one instead of leaving the
		// browser's structurally-wrong HTML behind.
		data.setData("text/html", escapeHtml(text));
		event.preventDefault();
	};
	root.addEventListener("copy", onCopy);
	root.addEventListener("cut", onCopy);
	return () => {
		root.removeEventListener("copy", onCopy);
		root.removeEventListener("cut", onCopy);
	};
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
}
