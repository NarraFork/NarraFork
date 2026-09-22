/**
 * markdown-anchor.ts — Heading slugs and same-document anchor targets.
 *
 * Both markdown renderers (the react-markdown `MarkdownContent` and the
 * virtual list's `RenderMarkdown`) used to hand every link to the browser with
 * `target="_blank"`, so a document-internal `[见下文](#实现细节)` opened a new tab
 * pointing at a fragment that existed nowhere — the anchor had no matching
 * heading because neither renderer emitted one. This module supplies the missing
 * half of that contract: the slug a heading advertises, and the slug a `#…` href
 * is asking for. It is DOM-free so the prepared (measure) layer can call it.
 *
 * WHY THE SLUG IS A PURE FUNCTION OF THE HEADING TEXT — no `-1` / `-2` dedup
 * counters, unlike GitHub. A counter needs to see the whole document in one
 * pass, and neither renderer does:
 *   - the chunked path splits a streaming message into a memoised prefix tree
 *     plus an active tail tree, each parsed independently (see
 *     `StreamingSplitMarkdown`);
 *   - the exact path parses TOP-LEVEL UNITS separately and caches them by raw
 *     text (`parseMarkdownUnits` / `prepared-markdown-cache`), precisely so a
 *     resize or a stream delta does not re-parse settled blocks.
 * A counter would therefore assign a heading a different suffix depending on
 * which fragment it happened to land in, i.e. a link that resolves after a
 * reload would silently stop resolving mid-stream. Statelessness costs one
 * thing: in a document with two identical headings, `#slug` resolves to the
 * first — the same answer a browser gives for duplicate ids — and a
 * GitHub-style `#slug-1` resolves to nothing (no jump, rather than a wrong one).
 *
 * The slug rule follows GitHub's, because that is the convention a model writing
 * `[x](#dont-do-this)` for `## Don't do this` is following: lowercase, DROP
 * anything that is not a letter / number / `-` / `_` / space, then turn runs of
 * space into `-`. Two deliberate departures:
 *   - Unicode letters and numbers are kept, so `## 实现细节` slugs to `实现细节`
 *     rather than to nothing. CJK headings are the common case in this product.
 *   - Repeated hyphens COLLAPSE. GitHub leaves `## a - b` as `a---b`; since both
 *     the heading and the href are normalized through this same function,
 *     collapsing only widens what matches (`#a-b` and `#a---b` both find `a - b`)
 *     and can never narrow it.
 */

/** Characters kept verbatim: Unicode letters, Unicode numbers, `-` and `_`. */
const DROPPED_CHARS = /[^\p{L}\p{N}\-_\s]+/gu;
const WHITESPACE_RUNS = /\s+/gu;
const HYPHEN_RUNS = /-{2,}/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * The prepared layer's inline-math placeholder, removed INDEX AND ALL.
 *
 * `parse-markdown` swaps `$x$` for `\uE000<index>\uE001` before handing the text to
 * marked, so a heading's tokens carry that sentinel rather than the formula. The
 * private-use brackets are dropped by `DROPPED_CHARS` on their own, but the index
 * digits are Unicode numbers and survived: `## 收敛条件 $x_1$` slugged to
 * `收敛条件-0`, where the trailing `0` is an implementation detail of the math
 * pipeline. Removed here, in the one function both renderers pass through, because
 * a formula has no readable text to contribute to an anchor either way.
 */
const MATH_SENTINEL_ATOM = /\uE000\d+\uE001/g;

/**
 * The anchor slug a heading advertises, or "" when the heading carries no
 * sluggable characters at all (`## ***` / `## 🎉`). Callers must treat "" as
 * "this heading has no anchor" rather than emitting an empty attribute.
 */
export function slugifyHeading(text: string): string {
	return text
		.replace(MATH_SENTINEL_ATOM, " ")
		.trim()
		.toLowerCase()
		.replace(DROPPED_CHARS, "")
		.replace(WHITESPACE_RUNS, "-")
		.replace(HYPHEN_RUNS, "-")
		.replace(EDGE_HYPHENS, "");
}

/**
 * What a link's href is, as far as anchoring is concerned.
 *
 * `sameDocument` and `slug` are SEPARATE answers because they disagree for a real
 * class of hrefs, and conflating them is what let the original defect through:
 * `#!`, `#🎉`, `#***` are unmistakably same-document fragments that happen to
 * contain nothing sluggable. A single nullable-slug return had to report them as
 * "not an anchor", so the click fell through to the browser, which pushed the
 * invalid fragment into the URL — read by TanStack Router as a location change,
 * i.e. the exact page-jump this module exists to prevent.
 *
 * `slug === null` with `sameDocument: true` therefore means "an anchor that names
 * no reachable heading": consume the click, scroll nowhere.
 */
export interface MarkdownAnchorTarget {
	/** The href addresses THIS document's fragment, so the app owns the click. */
	sameDocument: boolean;
	/** The heading slug being asked for, or null when the fragment has none. */
	slug: string | null;
}

const NOT_AN_ANCHOR: MarkdownAnchorTarget = { sameDocument: false, slug: null };

/**
 * Classify a link target: is it a same-document anchor, and which heading does it
 * name?
 *
 * Only a href that BEGINS with `#` qualifies: `page#section` names another
 * document and must keep its normal navigation.
 *
 * A BARE `#` is the one same-document href deliberately left to the browser. It
 * means "top of page", which the browser does correctly and cheaply, and it is
 * also the conventional href of a link whose behaviour lives entirely in its
 * click handler — consuming it here would swallow that.
 *
 * The fragment is percent-decoded first because that is how a non-ASCII anchor
 * survives being written as a URL: `#实现细节` frequently arrives as
 * `#%E5%AE%9E%E7%8E%B0%E7%BB%86%E8%8A%82`. A malformed escape is not an error
 * here — it is simply used as written, which is what the browser would do.
 */
export function classifyMarkdownAnchor(href: string | null | undefined): MarkdownAnchorTarget {
	if (href == null) return NOT_AN_ANCHOR;
	const trimmed = href.trim();
	if (!trimmed.startsWith("#")) return NOT_AN_ANCHOR;
	const fragment = trimmed.slice(1);
	// A bare `#`: top of page, left to the browser.
	if (fragment.length === 0) return NOT_AN_ANCHOR;
	let decoded = fragment;
	if (fragment.includes("%")) {
		try {
			decoded = decodeURIComponent(fragment);
		} catch {
			// A lone `%` is legal in a fragment; keep the raw text rather than bailing.
			decoded = fragment;
		}
	}
	const slug = slugifyHeading(decoded);
	return { sameDocument: true, slug: slug.length > 0 ? slug : null };
}

/**
 * Plain text of a heading's inline tokens, for slugging.
 *
 * The heading token's own `.text` is the RAW source, so a heading containing a
 * link would slug its destination into the anchor (`## 见 [文档](https://x)` →
 * `见-文档-httpsx`). Walking the inline tokens instead yields exactly the text
 * the reader sees, which is what the slug must describe.
 *
 * Typed structurally rather than against marked's `Token` union so the prepared
 * layer and its tests can call it without importing the lexer's types.
 */
export function inlineTokensToPlainText(
	tokens: readonly { type?: string; text?: string; tokens?: readonly unknown[] }[],
): string {
	let out = "";
	for (const token of tokens) {
		if (token == null) continue;
		// A raw-HTML token's `.text` is the MARKUP, not text the reader sees, so adding it
		// would slug the tag names: `## <b>加粗</b>标题` became `b加粗b标题`. The React
		// renderer has no `rehype-raw`, so react-markdown drops these tags and slugs the
		// same heading as `加粗标题` — the two sides disagreed, which means an anchor that
		// works in one view is a dead click in the other, with no error either way.
		// Dropping the markup matches the rendered DOM, which is what the slug describes.
		if (token.type === "html") continue;
		const nested = token.tokens;
		if (Array.isArray(nested) && nested.length > 0 && token.type !== "codespan") {
			out += inlineTokensToPlainText(
				nested as readonly { type?: string; text?: string; tokens?: readonly unknown[] }[],
			);
			continue;
		}
		if (typeof token.text === "string") out += token.text;
	}
	// Drop emphasis-flank sentinels so `**注意：**标题` slugs like `注意：标题`.
	return out.replaceAll("\uE002", "");
}

/**
 * A rendered React node, structurally — enough to walk children and read the two
 * props that carry visible text without importing React into a DOM-free module.
 */
interface HeadingNodeLike {
	type?: unknown;
	props?: {
		children?: unknown;
		/** An image's visible stand-in. */
		alt?: unknown;
		className?: unknown;
	};
}

/**
 * Class names whose whole subtree contributes nothing to a heading's text.
 *
 * A KaTeX root holds the formula TWICE — a MathML twin carrying the LaTeX source
 * for assistive tech, and per-glyph visual spans — so a plain walk collects the
 * source and then the glyphs. Neither is text a reader would name a section by, and
 * the prepared path contributes nothing at all for a formula, so the entire subtree
 * is skipped rather than either half of it.
 */
const SKIPPED_SUBTREE_CLASSES = ["katex", "katex-mathml", "katex-display"];

/**
 * Whether a `className` names a skipped subtree.
 *
 * Whole-token comparison, not `includes`: a substring test on `"katex"` would also
 * match unrelated names like `katex-error-notice`, and silently erase real text.
 */
function hasSkippedClass(className: string): boolean {
	const names = className.split(/\s+/);
	return SKIPPED_SUBTREE_CLASSES.some((skipped) => names.includes(skipped));
}

/**
 * Visible text of a heading rendered as React children, for slugging.
 *
 * The counterpart to `inlineTokensToPlainText`, and it MUST agree with it: the two
 * markdown renderers (react-markdown for documents, the prepared layer for the
 * narrator/chat lists) show the same markdown, so `## 见 ![图](x.png)` has to
 * advertise one slug in both. They disagreed on two constructs, and the failure is
 * a dead click with no signal:
 *
 *   - **Images.** A naive children walk finds an `<img>` whose `children` is
 *     undefined and contributes nothing, while the token walk reads the image's
 *     `text` (its alt). `alt` is read here for the same reason it exists: it is the
 *     text a reader gets when the image does not render.
 *   - **Math.** With rehype-katex the formula becomes a subtree containing BOTH a
 *     MathML twin (the LaTeX source) and per-glyph visual spans, so a plain walk
 *     collects the formula twice in two different forms. The token path contributes
 *     nothing for a formula (see `slugifyHeading`'s sentinel handling), so the whole
 *     KaTeX subtree is skipped to match.
 *
 * Everything else is a plain recursive walk, which is what both paths already did.
 */
export function reactChildrenToHeadingText(node: unknown): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(reactChildrenToHeadingText).join("");
	if (typeof node !== "object") return "";
	const element = node as HeadingNodeLike;
	const props = element.props;
	if (!props) return "";
	if (typeof props.className === "string" && hasSkippedClass(props.className)) return "";
	if (element.type === "img" || typeof props.alt === "string") {
		return typeof props.alt === "string" ? props.alt : "";
	}
	return reactChildrenToHeadingText(props.children);
}
