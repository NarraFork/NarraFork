/**
 * markdown-anchor-scroll.ts — Resolve a `#heading` click INSIDE the markdown
 * body that contains it, instead of letting the browser navigate.
 *
 * Two separate defects made document-internal anchors unusable, and this module
 * is the second half of the fix (the first is `shared/pretext-layout/
 * markdown-anchor.ts`, which makes headings advertise a slug at all):
 *
 *  1. Both renderers gave every link `target="_blank"`, so `[见下文](#实现细节)`
 *     opened a NEW TAB at the current URL plus a fragment — losing the reader's
 *     place and landing on a page that scrolls nowhere.
 *  2. Even with `target` removed, native fragment navigation is wrong here. The
 *     browser scrolls the nearest scrollport of the DOCUMENT, and it also writes
 *     the fragment into the URL. In this app a markdown body normally lives
 *     inside a panel's own scroller (a Mantine `ScrollArea`, a dockview panel, a
 *     modal), and — critically — TanStack Router owns the URL: a pushed `#…`
 *     becomes a route location change, which is exactly the "page jumps" symptom
 *     that started this. So the scroll is performed manually and no history
 *     entry is created.
 *
 * SCOPE: an anchor resolves only within the markdown instance that was clicked
 * (`scopeElement`). The narrator message list renders hundreds of independent
 * markdown bodies into one document, and several of them legitimately contain the
 * same heading ("## 结论"); a document-wide lookup would send the reader to
 * whichever one happened to be first in the DOM. Unresolved means NO navigation
 * — a dead click is a smaller failure than a wrong jump, and it cannot lose the
 * reader's position.
 */

import { classifyMarkdownAnchor } from "@shared/pretext-layout/markdown-anchor";

/**
 * Attribute a rendered heading carries its slug in.
 *
 * Deliberately not the `id` attribute. Every markdown body in the message list
 * would then contribute ids into one global namespace, so two messages with the
 * same heading produce duplicate ids (invalid HTML, and `getElementById` returns
 * only the first). The attribute is scoped by construction: it is only ever read
 * relative to the clicked body's own subtree.
 */
export const MD_HEADING_SLUG_ATTR = "data-md-heading";

/** Computed `overflow-y` values that let a box be scrolled. */
const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

/**
 * The heading element `slug` names within `scope`, or null.
 *
 * `CSS.escape` is not used because the slug goes into an ATTRIBUTE VALUE, not a
 * selector identifier; it is quoted, so only `"` and `\` would need escaping and
 * `slugifyHeading` emits neither (it drops every character outside Unicode
 * letters / numbers / `-` / `_`). Escaping is therefore unnecessary rather than
 * merely inconvenient — worth stating, since the value is model-authored text.
 */
function findHeadingBySlug(scope: Element, slug: string): HTMLElement | null {
	const escaped = slug.replace(/["\\]/g, "\\$&");
	return scope.querySelector<HTMLElement>(`[${MD_HEADING_SLUG_ATTR}="${escaped}"]`);
}

/**
 * Nearest ancestor-or-self of `element` that actually scrolls vertically, or null
 * when nothing between it and the document root does.
 *
 * Mirrors `hooks/scroll-parent.ts` (`findVerticalScrollParent`) but starts at the
 * element ITSELF and stops at `document.body`: a markdown body can be its own
 * scroller (`ContentViewer`'s capped box), and walking past `body` would return
 * the root element, whose "scroll" is the page scroll this module exists to
 * avoid touching. Overflow is consulted as well as size for the same reason as
 * there: an `overflow: hidden` ancestor can overflow while being unscrollable,
 * and scrolling it silently does nothing.
 */
function findScrollContainer(element: HTMLElement): HTMLElement | null {
	let current: HTMLElement | null = element;
	while (current && current !== document.body && current !== document.documentElement) {
		if (current.clientHeight > 0 && current.scrollHeight > current.clientHeight + 1) {
			const overflowY = getComputedStyle(current).overflowY;
			if (SCROLLABLE_OVERFLOW.has(overflowY)) return current;
		}
		current = current.parentElement;
	}
	return null;
}

/** Leading gap (px) kept above the target heading so it does not hug the edge. */
const HEADING_SCROLL_LEAD = 12;

/**
 * Whether the reader has asked for reduced motion.
 *
 * A few hundred pixels of smooth scrolling is a real problem for vestibular
 * sensitivity, and this module is the only place that decides it, so the check is
 * cheap. Guarded for `matchMedia`'s absence because the same code path runs under
 * the linkedom test environment.
 */
function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Bring `heading` into view inside its own scroll container.
 *
 * `scrollIntoView` is avoided on purpose: with nested scrollports it also scrolls
 * ANCESTOR scrollports (that is specified behaviour), which in a dockview layout
 * shifts the surrounding panel — the visible "page jumped" complaint. Writing
 * `scrollTop` on exactly one resolved container cannot do that.
 *
 * With no scrollable ancestor there is nothing to scroll and nothing is done,
 * rather than falling back to a page scroll. The body is fully visible in that
 * case, so the anchor's purpose is already satisfied.
 */
function scrollHeadingIntoContainer(heading: HTMLElement): void {
	const container = findScrollContainer(heading);
	if (!container) return;
	const headingTop = heading.getBoundingClientRect().top;
	const containerTop = container.getBoundingClientRect().top;
	const delta = headingTop - containerTop - HEADING_SCROLL_LEAD;
	// Clamped to the container's real scroll range. The browser clamps anything out of
	// range anyway, but a value that cannot be reached would make this function's own
	// answer wrong for anyone reading it back.
	const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
	const target = Math.max(0, Math.min(container.scrollTop + delta, maxScrollTop));
	container.scrollTo({
		top: target,
		behavior: prefersReducedMotion() ? "auto" : "smooth",
	});
}

/**
 * Move the reading position to `heading`, the way native fragment navigation would.
 *
 * Scrolling alone moves the VIEWPORT; a screen reader's virtual cursor and the
 * keyboard focus stay where they were, so for an AT user "见下文" appeared to do
 * nothing at all — the announcement never left the paragraph they were in. The
 * browser does this itself for a real `#id` jump, and preventing the default is
 * what took it away.
 *
 * `tabIndex = -1` is required because a heading is not focusable by default; it
 * keeps the element out of the tab order while making it programmatically
 * focusable. `preventScroll` matters: without it the focus call performs its own
 * `scrollIntoView`, reintroducing the ancestor-scrolling behaviour that
 * `scrollHeadingIntoContainer` deliberately avoids.
 */
function moveReadingPositionTo(heading: HTMLElement): void {
	if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
	heading.focus?.({ preventScroll: true });
}

/**
 * Handle a click on a markdown link whose href may be a same-document anchor.
 *
 * Returns true when the click was consumed (the caller must not navigate) and
 * false when the href is a real destination that should keep its normal
 * behaviour.
 *
 * A same-document anchor is consumed EVEN WHEN IT RESOLVES TO NOTHING — whether
 * the heading is absent from this body (`#some-other-section`) or the fragment
 * names no heading at all (`#!`, `#🎉`). The alternative is letting the browser
 * push the fragment, which in this app means a router location change and a
 * full-page scroll to the top — the reader loses their place in exchange for
 * nothing. Refusing is the honest outcome for a target that is not here.
 *
 * Modified clicks (Ctrl/Cmd/Shift/Alt, middle button) are NOT consumed: those are
 * the reader's explicit "open elsewhere" / "select" gestures, and the virtual
 * list additionally uses Ctrl/Shift+Click for block multi-selection.
 */
export function handleMarkdownAnchorClick(
	event: {
		defaultPrevented: boolean;
		metaKey: boolean;
		ctrlKey: boolean;
		shiftKey: boolean;
		altKey: boolean;
		button: number;
		preventDefault: () => void;
	},
	href: string | null | undefined,
	scopeElement: Element | null,
): boolean {
	if (event.defaultPrevented) return false;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
	if (event.button !== 0) return false;
	const { sameDocument, slug } = classifyMarkdownAnchor(href);
	if (!sameDocument) return false;
	event.preventDefault();
	if (!scopeElement || slug === null) return true;
	const heading = findHeadingBySlug(scopeElement, slug);
	if (heading) {
		scrollHeadingIntoContainer(heading);
		moveReadingPositionTo(heading);
	}
	return true;
}

/**
 * Props a same-document anchor must carry, versus an external link.
 *
 * `target="_blank"` is the thing being fixed: applying it to a `#…` href is what
 * opened a blank tab. It is kept for every real destination, which is the
 * existing behaviour of both renderers and is relied on by readers who expect a
 * documentation link not to replace the panel they are reading.
 *
 * Keyed on `sameDocument` alone, NOT on whether a slug was extracted: an anchor
 * that names no heading still addresses this document, and giving it `_blank`
 * would open an empty tab — the original symptom — for exactly the fragments the
 * click handler now consumes.
 */
export function markdownLinkTargetProps(href: string | null | undefined): {
	target?: "_blank";
	rel?: "noopener noreferrer";
} {
	return classifyMarkdownAnchor(href).sameDocument
		? {}
		: { target: "_blank", rel: "noopener noreferrer" };
}
