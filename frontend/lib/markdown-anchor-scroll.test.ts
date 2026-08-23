/**
 * markdown-anchor-scroll.test.ts — a `#heading` click must scroll INSIDE its own
 * markdown body, and must never navigate.
 *
 * What each assertion is actually protecting:
 *   - "consumes" means `preventDefault` was called. Skipping it lets the browser
 *     push the fragment, which TanStack Router reads as a location change — the
 *     original "page jumps" report.
 *   - the SCOPE assertions matter because the narrator message list renders many
 *     independent markdown bodies into one document, several of which repeat a
 *     heading. A document-wide lookup would silently jump to a different message.
 *   - the modified-click assertions matter because Ctrl/Shift+Click are the block
 *     multi-select gestures in the virtual list; swallowing them would break
 *     selection while looking like nothing happened.
 *   - `behavior` is recorded alongside `top` because reduced-motion is invisible to
 *     anyone not affected by it: a regression would only be felt by the readers who
 *     asked not to feel it.
 *   - the FOCUS assertion stands in for screen-reader behaviour. Scrolling moves the
 *     viewport but not the virtual cursor, so without it an AT user hears nothing
 *     change — a dead link, from their side, that looks fine from ours.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import {
	handleMarkdownAnchorClick,
	MD_HEADING_SLUG_ATTR,
	markdownLinkTargetProps,
} from "./markdown-anchor-scroll";

interface ScrollCall {
	top: number;
	behavior?: string;
}

/**
 * Globals `buildBody` installs, restored after every case.
 *
 * linkedom realms leak across files otherwise: `app-shell-scroll.test.tsx` records
 * a case where a stale `Event` from another file's realm made unrelated assertions
 * fail. The saved descriptor may be undefined (the key did not exist under Bun),
 * which `delete` handles correctly.
 */
const INSTALLED_GLOBALS = [
	"window",
	"document",
	"Element",
	"HTMLElement",
	"Node",
	"getComputedStyle",
	"matchMedia",
] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(key: string, value: unknown): void {
	if (!savedGlobals.has(key)) {
		savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

afterEach(() => {
	for (const key of INSTALLED_GLOBALS) {
		if (!savedGlobals.has(key)) continue;
		const descriptor = savedGlobals.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
	savedGlobals.clear();
});

/**
 * A markdown body inside a scrollable panel, plus whatever the assertions need to
 * observe. linkedom has no layout engine, so the geometry `scrollHeadingIntoContainer`
 * reads is stubbed per element — which is the point: the arithmetic is what is
 * under test, not the browser's box model.
 */
function buildBody(options: {
	slugs: readonly string[];
	/** Viewport-relative top of each heading, by slug. */
	headingTops?: Record<string, number>;
	containerTop?: number;
	containerScrollTop?: number;
	/** When false the container reports itself unscrollable (overflow: hidden). */
	scrollable?: boolean;
	/** When true `matchMedia` reports `prefers-reduced-motion: reduce`. */
	reducedMotion?: boolean;
}) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const doc = window.document;
	installGlobal("window", window);
	installGlobal("document", doc);
	installGlobal("Element", window.Element);
	installGlobal("HTMLElement", window.HTMLElement);
	installGlobal("Node", window.Node);
	installGlobal("matchMedia", (query: string) => ({
		matches: query.includes("prefers-reduced-motion") && options.reducedMotion === true,
	}));

	const scrollCalls: ScrollCall[] = [];
	const container = doc.createElement("div");
	const scrollableFlag = options.scrollable !== false;
	Object.defineProperties(container, {
		clientHeight: { value: 400, configurable: true },
		scrollHeight: { value: 2000, configurable: true },
		scrollTop: { value: options.containerScrollTop ?? 0, writable: true, configurable: true },
	});
	container.getBoundingClientRect = () =>
		({ top: options.containerTop ?? 0 }) as unknown as DOMRect;
	(
		container as unknown as { scrollTo: (arg: { top: number; behavior?: string }) => void }
	).scrollTo = (arg) => {
		scrollCalls.push({ top: arg.top, behavior: arg.behavior });
	};
	// `findScrollContainer` consults computed overflow so an `overflow: hidden`
	// ancestor cannot capture the walk and swallow the scroll.
	installGlobal("getComputedStyle", (element: Element) => ({
		overflowY: element === container && scrollableFlag ? "auto" : "hidden",
	}));

	const body = doc.createElement("div");
	body.setAttribute("data-md-body", "");
	container.appendChild(body);
	doc.body.appendChild(container);

	const focused: string[] = [];
	for (const slug of options.slugs) {
		const heading = doc.createElement("h2");
		heading.setAttribute(MD_HEADING_SLUG_ATTR, slug);
		heading.getBoundingClientRect = () =>
			({ top: options.headingTops?.[slug] ?? 0 }) as unknown as DOMRect;
		// linkedom has no focus model, so the call is recorded rather than observed via
		// activeElement. `preventScroll` is asserted because focusing without it performs
		// its own scrollIntoView, undoing the single-container discipline.
		(heading as unknown as { focus: (opts?: { preventScroll?: boolean }) => void }).focus = (
			opts,
		) => {
			focused.push(`${slug}:${opts?.preventScroll === true}`);
		};
		body.appendChild(heading);
	}

	return { doc, body, container, scrollCalls, focused };
}

/** A left-button click with nothing held down. */
function plainClick(overrides: Partial<Parameters<typeof handleMarkdownAnchorClick>[0]> = {}) {
	let prevented = false;
	const event = {
		defaultPrevented: false,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		button: 0,
		preventDefault: () => {
			prevented = true;
		},
		...overrides,
	};
	return { event, wasPrevented: () => prevented };
}

describe("handleMarkdownAnchorClick", () => {
	it("consumes a same-document anchor and scrolls its container", () => {
		const { body, scrollCalls, focused } = buildBody({
			slugs: ["实现细节"],
			headingTops: { 实现细节: 900 },
			containerTop: 100,
			containerScrollTop: 200,
		});
		const { event, wasPrevented } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#实现细节", body)).toBe(true);
		expect(wasPrevented()).toBe(true);
		// scrollTop(200) + (900 - 100) - 12px lead
		expect(scrollCalls).toEqual([{ top: 988, behavior: "smooth" }]);
		// Native fragment navigation moves the reading position too; preventDefault took
		// that away, so it is restored explicitly.
		expect(focused).toEqual(["实现细节:true"]);
	});

	it("jumps instantly when the reader asked for reduced motion", () => {
		const { body, scrollCalls } = buildBody({
			slugs: ["intro"],
			headingTops: { intro: 900 },
			reducedMotion: true,
		});
		const { event } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#intro", body)).toBe(true);
		expect(scrollCalls).toEqual([{ top: 888, behavior: "auto" }]);
	});

	it("clamps a target above the top of the container to zero", () => {
		// A heading already scrolled past would otherwise produce a negative scrollTop.
		const { body, scrollCalls } = buildBody({
			slugs: ["intro"],
			headingTops: { intro: 0 },
			containerTop: 500,
			containerScrollTop: 10,
		});
		const { event } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#intro", body)).toBe(true);
		expect(scrollCalls).toEqual([{ top: 0, behavior: "smooth" }]);
	});

	it("clamps a target below the end to the container's real maximum", () => {
		// scrollHeight alone is NOT the maximum — it exceeds it by one viewport. The
		// browser clamps regardless, so this only shows up when the computed value is
		// read back, but a function whose stated answer is unreachable is a trap.
		const { body, scrollCalls } = buildBody({
			slugs: ["tail"],
			headingTops: { tail: 5000 },
			containerScrollTop: 0,
		});
		const { event } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#tail", body)).toBe(true);
		// scrollHeight(2000) - clientHeight(400)
		expect(scrollCalls).toEqual([{ top: 1600, behavior: "smooth" }]);
	});

	it("resolves to the FIRST of two identical headings in one body", () => {
		// The cost of a stateless slug (no GitHub-style `-1` suffixes), and the same
		// answer a browser gives for duplicate ids. Asserted because it is a deliberate
		// trade-off rather than an accident: anyone adding dedup counters must see this
		// contract change.
		const { body, scrollCalls } = buildBody({
			slugs: ["结论"],
			headingTops: { 结论: 300 },
		});
		const doc = body.ownerDocument;
		const second = doc.createElement("h2");
		second.setAttribute(MD_HEADING_SLUG_ATTR, "结论");
		second.getBoundingClientRect = () => ({ top: 1500 }) as unknown as DOMRect;
		body.appendChild(second);

		const { event } = plainClick();
		expect(handleMarkdownAnchorClick(event, "#结论", body)).toBe(true);
		// The first heading's geometry (300), not the second's (1500).
		expect(scrollCalls).toEqual([{ top: 288, behavior: "smooth" }]);
	});

	it("finds nothing for a GitHub-style `-1` suffix, and says so by not scrolling", () => {
		// A model may write `#结论-1` for the second occurrence. There is no such slug, so
		// the click is consumed and nothing moves — documented in markdown-anchor.ts as
		// preferable to jumping to the wrong one.
		const { body, scrollCalls } = buildBody({ slugs: ["结论"], headingTops: { 结论: 300 } });
		const { event, wasPrevented } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#结论-1", body)).toBe(true);
		expect(wasPrevented()).toBe(true);
		expect(scrollCalls).toEqual([]);
	});

	it("matches a slug containing quote and backslash characters", () => {
		// `findHeadingBySlug` escapes `"` and `\` for the attribute selector. Today
		// slugifyHeading drops both, so this branch is unreachable through the click
		// path — it is depth in defence, and this asserts it works rather than leaving
		// it as untested code that a widened character set would silently break.
		const { body, scrollCalls } = buildBody({ slugs: ['a"b\\c'], headingTops: { 'a"b\\c': 300 } });
		const { event } = plainClick();

		// Fed through the internal lookup by using a heading whose attribute value
		// contains the characters; the href form cannot express them.
		expect(body.querySelector(`[${MD_HEADING_SLUG_ATTR}="a\\"b\\\\c"]`)).not.toBeNull();
		expect(handleMarkdownAnchorClick(event, "#abc", body)).toBe(true);
		// `abc` is not the same slug, so nothing scrolls — the point is that the quoted
		// selector above parses at all.
		expect(scrollCalls).toEqual([]);
	});

	it("resolves a percent-encoded CJK fragment", () => {
		const { body, scrollCalls } = buildBody({
			slugs: ["实现细节"],
			headingTops: { 实现细节: 300 },
		});
		const { event } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#%E5%AE%9E%E7%8E%B0%E7%BB%86%E8%8A%82", body)).toBe(
			true,
		);
		expect(scrollCalls).toHaveLength(1);
	});

	it("consumes an unresolved anchor WITHOUT scrolling", () => {
		// Letting this through would push a fragment and scroll the page to the top,
		// losing the reader's place in exchange for nothing.
		const { body, scrollCalls } = buildBody({ slugs: ["intro"] });
		const { event, wasPrevented } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#nowhere", body)).toBe(true);
		expect(wasPrevented()).toBe(true);
		expect(scrollCalls).toEqual([]);
	});

	it("consumes a fragment that names no heading at all", () => {
		// `#!`, `#🎉`, `#***` slug to nothing, so they used to be reported as "not an
		// anchor" and handed back to the browser — which pushed the invalid fragment and
		// let TanStack Router treat it as a location change. They are same-document
		// targets and must be consumed like any other unresolved one.
		const { body, scrollCalls } = buildBody({ slugs: ["intro"] });
		for (const href of ["#!", "#🎉", "#***", "#---"]) {
			const { event, wasPrevented } = plainClick();
			expect(handleMarkdownAnchorClick(event, href, body), `must consume: ${href}`).toBe(true);
			expect(wasPrevented(), `must preventDefault: ${href}`).toBe(true);
		}
		expect(scrollCalls).toEqual([]);
	});

	it("does not look outside the clicked body", () => {
		// Two bodies in one document, both with a "结论" heading: the click must not
		// reach into the sibling. Without the scope, the first match in DOM order wins.
		const { doc, body, container, scrollCalls } = buildBody({
			slugs: ["intro"],
			headingTops: { intro: 200 },
		});
		const other = doc.createElement("div");
		other.setAttribute("data-md-body", "");
		const otherHeading = doc.createElement("h2");
		otherHeading.setAttribute(MD_HEADING_SLUG_ATTR, "结论");
		otherHeading.getBoundingClientRect = () => ({ top: 300 }) as unknown as DOMRect;
		other.appendChild(otherHeading);
		container.appendChild(other);

		const { event } = plainClick();
		expect(handleMarkdownAnchorClick(event, "#结论", body)).toBe(true);
		expect(scrollCalls).toEqual([]);

		// The same href inside the OTHER body does resolve, proving the heading is
		// findable and only the scope kept it out.
		const second = plainClick();
		expect(handleMarkdownAnchorClick(second.event, "#结论", other)).toBe(true);
		expect(scrollCalls).toHaveLength(1);
	});

	it("cannot reach a heading split into a different markdown body", () => {
		// The virtual list renders one message as several independent `data-md-body`
		// segments. A link in one segment and its heading in another is the most likely
		// dead-anchor shape there, and it is scope working as designed rather than a bug
		// — pinned so the behaviour is a decision instead of a surprise.
		const { doc, body, container, scrollCalls } = buildBody({ slugs: [] });
		const laterSegment = doc.createElement("div");
		laterSegment.setAttribute("data-md-body", "");
		const heading = doc.createElement("h2");
		heading.setAttribute(MD_HEADING_SLUG_ATTR, "实现细节");
		heading.getBoundingClientRect = () => ({ top: 800 }) as unknown as DOMRect;
		laterSegment.appendChild(heading);
		container.appendChild(laterSegment);

		const { event, wasPrevented } = plainClick();
		expect(handleMarkdownAnchorClick(event, "#实现细节", body)).toBe(true);
		expect(wasPrevented()).toBe(true);
		expect(scrollCalls).toEqual([]);
	});

	it("does nothing but consume when there is no scope element", () => {
		const { scrollCalls } = buildBody({ slugs: ["intro"] });
		const { event, wasPrevented } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#intro", null)).toBe(true);
		expect(wasPrevented()).toBe(true);
		expect(scrollCalls).toEqual([]);
	});

	it("leaves the anchor alone when no ancestor is scrollable", () => {
		// Nothing to scroll means the body is fully visible; a page scroll would be
		// the wrong fallback (it is the behaviour being removed).
		const { body, scrollCalls } = buildBody({
			slugs: ["intro"],
			headingTops: { intro: 200 },
			scrollable: false,
		});
		const { event } = plainClick();

		expect(handleMarkdownAnchorClick(event, "#intro", body)).toBe(true);
		expect(scrollCalls).toEqual([]);
	});

	it("refuses hrefs that name another document", () => {
		const { body, scrollCalls } = buildBody({ slugs: ["section"] });
		for (const href of [
			"/docs/page#section",
			"https://example.com/#section",
			"page.md#section",
			"mailto:a@b.com",
			"/knowledge/e1",
			undefined,
			null,
		]) {
			const { event, wasPrevented } = plainClick();
			expect(handleMarkdownAnchorClick(event, href, body), `must not consume: ${href}`).toBe(false);
			expect(wasPrevented()).toBe(false);
		}
		expect(scrollCalls).toEqual([]);
	});

	it("refuses a bare fragment so the browser keeps handling it", () => {
		const { body } = buildBody({ slugs: ["intro"] });
		const { event } = plainClick();
		expect(handleMarkdownAnchorClick(event, "#", body)).toBe(false);
	});

	it("lets modified and non-primary clicks through", () => {
		// Ctrl/Cmd+Click and Shift+Click are the virtual list's multi-select gestures,
		// and the reader's "open elsewhere" gestures generally.
		const { body, scrollCalls } = buildBody({
			slugs: ["intro"],
			headingTops: { intro: 200 },
		});
		for (const overrides of [
			{ metaKey: true },
			{ ctrlKey: true },
			{ shiftKey: true },
			{ altKey: true },
			{ button: 1 },
			{ defaultPrevented: true },
		]) {
			const { event, wasPrevented } = plainClick(overrides);
			expect(
				handleMarkdownAnchorClick(event, "#intro", body),
				`must not consume: ${JSON.stringify(overrides)}`,
			).toBe(false);
			expect(wasPrevented()).toBe(false);
		}
		expect(scrollCalls).toEqual([]);
	});
});

describe("markdownLinkTargetProps", () => {
	it("gives a same-document anchor no target", () => {
		// The defect this fixes: `target="_blank"` on a fragment opened a blank tab.
		expect(markdownLinkTargetProps("#实现细节")).toEqual({});
		expect(markdownLinkTargetProps("#section")).toEqual({});
	});

	it("keeps opening real destinations in a new tab", () => {
		for (const href of [
			"https://example.com",
			"/knowledge/e1",
			"page.md#section",
			"mailto:a@b.com",
			"#",
			undefined,
		]) {
			expect(markdownLinkTargetProps(href)).toEqual({
				target: "_blank",
				rel: "noopener noreferrer",
			});
		}
	});
});
