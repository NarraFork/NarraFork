import { afterEach, describe, expect, it } from "bun:test";
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import {
	getTypographyRevision,
	resetTypographyForTest,
	setTypography,
} from "@shared/pretext-layout/typography";
import { parseHTML } from "linkedom";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FragmentGap } from "./line-fragments";
import {
	type StaticInlineFragment,
	type StaticInlineLine,
	StaticInlineMarkupCache,
	staticInlineMarkupCache,
} from "./static-inline-markup";

const LINE_LIMIT = 256 * 1024;
const fragment = (overrides: Partial<StaticInlineFragment> = {}): StaticInlineFragment => ({
	text: "中文 body",
	font: "14px sans-serif",
	className: "vlist-frag",
	gapBefore: 0,
	...overrides,
});
const line = (...fragments: StaticInlineFragment[]): StaticInlineLine => ({ fragments });
const get = (lines: readonly StaticInlineLine[]) =>
	new StaticInlineMarkupCache().get({}, 640, lines, getTypographyRevision());

function host(markup: string) {
	const { document } = parseHTML("<html><body><div></div></body></html>");
	const container = document.querySelector("div");
	if (!container) throw new Error("missing test host");
	container.innerHTML = markup;
	return container;
}

function oldMarkup(fragments: readonly StaticInlineFragment[]): string {
	return renderToStaticMarkup(
		createElement(
			Fragment,
			null,
			...fragments.map((item, index) =>
				createElement(
					Fragment,
					{ key: index },
					createElement(FragmentGap, { gapBefore: item.gapBefore }),
					createElement(
						"span",
						{
							className: item.className,
							style: fragmentTextStyle({
								font: item.font,
								gapBefore: item.gapBefore,
								letterSpacing: letterSpacingForFont(item.font),
							}),
						},
						item.text,
					),
				),
			),
		),
	);
}

/** Compare parsed DOM strictly, except for equivalent CSS zero units. */
function domShape(markup: string) {
	const container = host(markup);
	return {
		text: container.textContent,
		children: [...container.children].map((element) => ({
			tag: element.tagName,
			text: element.textContent,
			children: element.children.length,
			attributes: [...element.attributes].map((attribute) => [
				attribute.name,
				attribute.name === "style"
					? attribute.value.replace(/:0(?=;|$)/g, ":0px")
					: attribute.value,
			]),
		})),
	};
}

afterEach(() => {
	resetTypographyForTest();
	staticInlineMarkupCache.clear();
});

describe("static inline markup DOM parity", () => {
	it("preserves SSR text, gap siblings, classes and fixed styles", () => {
		const fragments = [
			fragment({ text: "before & <", gapBefore: 0 }),
			fragment({
				text: "bold ' \" &amp; 中文😀",
				font: "bold 14px \"Quoted Family\", 'Other Family'",
				className: 'bold " data-fake="x\' &< >',
				gapBefore: 3.25,
			}),
			fragment({ text: "after", gapBefore: -2 }),
		];
		const [markup] = get([line(...fragments)]);
		expect(markup).not.toBeNull();
		expect(domShape(markup ?? "")).toEqual(domShape(oldMarkup(fragments)));
		const container = host(markup ?? "");
		expect(container.children.length).toBe(4);
		const gap = container.querySelector("[data-vlist-frag-gap]");
		expect(gap?.textContent).toBe(" ");
		expect(gap?.getAttribute("aria-hidden")).toBe("true");
		expect(gap?.getAttribute("data-vlist-frag-gap")).toBe("true");
		expect(gap?.getAttribute("style")).toBe("font-size:0");
		expect(gap?.nextElementSibling?.textContent).toBe(fragments[1]?.text ?? "");
	});

	it("escapes entities, both attribute quotes and apparent executable HTML", () => {
		const text = '<script>alert("x")</script><img src=x onerror=alert(1)> &lt; & \' "';
		const className = "\" onclick=\"alert(1)' data-x='x & < >";
		const font = '14px "Family\' & < >"';
		const [markup] = get([line(fragment({ text, className, font }))]);
		const container = host(markup ?? "");
		expect(container.querySelector("script,img,[onclick],[onerror],[data-x]")).toBeNull();
		expect(container.children.length).toBe(1);
		expect(container.firstElementChild?.textContent).toBe(text);
		expect(container.firstElementChild?.getAttribute("class")).toBe(className);
		expect(container.firstElementChild?.getAttribute("style")).toContain(`font:${font};`);
		expect(markup).toContain("&quot;");
		expect(markup).toContain("&#x27;");
		expect(markup).toContain("&amp;lt;");
		expect(domShape(markup ?? "")).toEqual(
			domShape(oldMarkup([fragment({ text, className, font })])),
		);
	});

	it("preserves balanced quoted font families and paired Unicode verbatim", () => {
		const fragments = [
			fragment({
				font: '14px "JetBrains Mono", monospace',
				text: "emoji 😀𝄞",
				className: "emoji-😀",
				gapBefore: 3,
			}),
			fragment({ font: "bold 14px 'Single Family', serif", gapBefore: 2 }),
			fragment({ font: '14px "Family\' 😀", serif', gapBefore: 1 }),
		];
		const [markup] = get([line(...fragments)]);
		expect(markup).not.toBeNull();
		expect(domShape(markup ?? "")).toEqual(domShape(oldMarkup(fragments)));
		const container = host(markup ?? "");
		expect(container.children.length).toBe(6);
		expect(container.children[1]?.textContent).toBe("emoji 😀𝄞");
		expect(container.children[1]?.getAttribute("class")).toBe("emoji-😀");
		expect(container.children[1]?.getAttribute("style")).toContain(
			'font:14px "JetBrains Mono", monospace;margin-left:3px;white-space:pre;display:inline-block',
		);
	});

	it("preserves empty lines/text and adds no gap for zero or negative margins", () => {
		const fragments = [fragment({ text: "" }), fragment({ text: "x", gapBefore: -3 })];
		const result = get([line(), line(...fragments)]);
		expect(result[0]).toBe("");
		const container = host(result[1] ?? "");
		expect(container.children.length).toBe(2);
		expect(container.querySelector("[data-vlist-frag-gap]")).toBeNull();
		expect(container.lastElementChild?.getAttribute("style")).toContain("margin-left:-3px");
		expect(domShape(result[1] ?? "")).toEqual(domShape(oldMarkup(fragments)));
	});

	it("uses measured letter spacing and cancelling negative margin-right", () => {
		setTypography({ letterSpacingPercent: 10 });
		const fragments = [fragment(), fragment({ font: "12px monospace", gapBefore: 4 })];
		const [markup] = get([line(...fragments)]);
		expect(markup).toContain("letter-spacing:1.4px;margin-right:-1.4px");
		expect(markup).toContain("letter-spacing:1.2px;margin-right:-1.2px");
		expect(domShape(markup ?? "")).toEqual(domShape(oldMarkup(fragments)));
	});

	it("also preserves tightening's positive cancelling margin and omits zero spacing", () => {
		expect(get([line(fragment())])[0]).not.toContain("letter-spacing");
		setTypography({ letterSpacingPercent: -5 });
		const fragments = [fragment()];
		const [markup] = get([line(...fragments)]);
		expect(markup).toContain("letter-spacing:-0.7px;margin-right:0.7px");
		expect(domShape(markup ?? "")).toEqual(domShape(oldMarkup(fragments)));
	});
});

describe("whole-line fallback", () => {
	it("refuses href/math including falsy non-null values, but accepts null/undefined", () => {
		for (const overrides of [
			{ href: "" },
			{ href: "/x" },
			{ math: {} },
			{ math: false },
			{ math: 0 },
		]) {
			expect(get([line(fragment(), fragment(overrides))])).toEqual([null]);
		}
		expect(get([line(fragment({ href: null, math: null })), line(fragment())])).not.toContain(null);
	});

	it("refuses CSS declarations/braces and every font control", () => {
		for (const font of [
			"14px serif;color:red",
			"14px serif}body{display:none",
			"14px serif\u0000",
			"14px serif\r",
			"14px serif\n",
			"14px serif\t",
			"14px serif\u007f",
			"14px serif\u0085",
		]) {
			expect(get([line(fragment(), fragment({ font }))])).toEqual([null]);
		}
	});

	it("refuses CSS comments, unbalanced strings and every font escape", () => {
		for (const font of [
			"14px serif/*",
			"14px serif*/",
			"14px serif/*closed*/",
			'14px "Family/*Name"',
			'14px "Unclosed Family',
			"14px 'Unclosed Family",
			'14px "First", \'Unclosed Second',
			"14px serif\\",
			'14px "Escaped\\" Family"',
			"14px serif\\3b color:red",
		]) {
			const result = get([
				line(fragment(), fragment({ font, gapBefore: 4 })),
				line(fragment({ text: "still rendered" })),
			]);
			expect(result[0]).toBeNull();
			expect(host(result[1] ?? "").textContent).toBe("still rendered");
		}
	});

	it("refuses lone UTF-16 surrogates in text, class and font without partial markup", () => {
		for (const invalid of [
			"\ud800",
			"\udc00",
			"a\ud800b",
			"a\udc00b",
			"\ud800\ud800",
			"\udc00\ud800",
			"😀\ud800",
		]) {
			for (const overrides of [
				{ text: invalid },
				{ className: invalid },
				{ font: `14px "${invalid}"` },
			]) {
				expect(get([line(fragment(), fragment(overrides)), line()])).toEqual([null, ""]);
			}
		}
	});

	it("refuses HTML-unfriendly controls but preserves ordinary tab/newline", () => {
		for (const code of [0, 1, 8, 11, 12, 13, 14, 31, 127, 133, 159]) {
			expect(get([line(fragment({ text: `a${String.fromCharCode(code)}b` }))])).toEqual([null]);
		}
		const item = fragment({ text: "a\tb\nc" });
		const [markup] = get([line(item)]);
		expect(host(markup ?? "").textContent).toBe(item.text);
		expect(domShape(markup ?? "")).toEqual(domShape(oldMarkup([item])));
	});

	it("refuses invalid gaps including null instead of silently coercing", () => {
		for (const gapBefore of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			null,
			undefined,
			"3",
		]) {
			expect(get([line(fragment({ gapBefore: gapBefore as number }))])).toEqual([null]);
		}
	});

	it("enforces the exact UTF-8 boundary without truncating", () => {
		const shell = get([line(fragment({ text: "" }))])[0] ?? "";
		const overhead = new TextEncoder().encode(shell).length;
		const text = "x".repeat(LINE_LIMIT - overhead);
		const [exact, tooLarge] = get([line(fragment({ text })), line(fragment({ text: `${text}x` }))]);
		expect(new TextEncoder().encode(exact ?? "").length).toBe(LINE_LIMIT);
		expect(host(exact ?? "").textContent).toBe(text);
		expect(tooLarge).toBeNull();
	});

	it("counts escaping and multibyte Unicode, including paired astral characters", () => {
		for (const text of ["&".repeat(60_000), "中".repeat(90_000), "😀".repeat(70_000)]) {
			expect(text.length).toBeLessThan(LINE_LIMIT);
			expect(get([line(fragment(), fragment({ text }))])).toEqual([null]);
		}
	});

	it("rejects huge inputs and aggregate lines, preserving every other line", () => {
		const huge = "x".repeat(LINE_LIMIT + 1);
		expect(get([line(fragment({ text: huge }))])).toEqual([null]);
		expect(get([line(fragment({ font: huge }))])).toEqual([null]);
		expect(get([line(fragment({ className: huge }))])).toEqual([null]);
		const many = Array.from({ length: 3_000 }, () => fragment({ text: "" }));
		const result = get([line(fragment()), line(...many), line(), line(fragment({ text: "last" }))]);
		expect(result.length).toBe(4);
		expect(result[0]).not.toBeNull();
		expect(result[1]).toBeNull();
		expect(result[2]).toBe("");
		expect(host(result[3] ?? "").textContent).toBe("last");
	});
});

describe("bounded weak-owner markup LRU", () => {
	it("reuses only the same immutable block/width/revision", () => {
		const cache = new StaticInlineMarkupCache();
		const block = {};
		const lines = [line(fragment())];
		const first = cache.get(block, 640, lines, getTypographyRevision());
		expect(cache.get(block, 640, lines, getTypographyRevision())).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(cache.get(block, 641, lines, getTypographyRevision())).not.toBe(first);
		expect(cache.get({}, 640, lines, getTypographyRevision())).not.toBe(first);
		setTypography({ letterSpacingPercent: 10 });
		const revised = cache.get(block, 640, lines, getTypographyRevision());
		expect(revised).not.toBe(first);
		expect(revised[0]).toContain("letter-spacing:1.4px");
		expect(cache.get(block, 640, lines, getTypographyRevision())).toBe(revised);
		expect(cache.inspect().entries).toBe(4);
	});

	it("evicts least recently used entries, including stale width/revision mappings", () => {
		const cache = new StaticInlineMarkupCache({ maxEntries: 2 });
		const block = {};
		const lines = [line(fragment())];
		const first = cache.get(block, 640, lines, 0);
		const second = cache.get(block, 641, lines, 0);
		expect(cache.get(block, 640, lines, 0)).toBe(first);
		cache.get(block, 640, lines, 1);
		expect(cache.inspect().entries).toBe(2);
		expect(cache.get(block, 640, lines, 0)).toBe(first);
		expect(cache.get(block, 641, lines, 0)).not.toBe(second);
	});

	it("accounts UTF-16 retained strings and result slots, evicting at byte budget", () => {
		const lines = [line(fragment({ text: "中文😀" }))];
		const sample = get(lines);
		const bytes = 16 + 8 + (sample[0]?.length ?? 0) * 2;
		const cache = new StaticInlineMarkupCache({ maxBytes: bytes });
		const a = {};
		const b = {};
		const first = cache.get(a, 640, lines, 0);
		expect(cache.inspect()).toEqual({ entries: 1, bytes });
		cache.get(b, 640, lines, 0);
		expect(cache.inspect()).toEqual({ entries: 1, bytes });
		expect(cache.get(a, 640, lines, 0)).not.toBe(first);
	});

	it("returns every line of an oversized entry without caching or evicting a good entry", () => {
		const cache = new StaticInlineMarkupCache({ maxBytes: 1_000 });
		const smallBlock = {};
		const smallLines = [line(fragment())];
		const small = cache.get(smallBlock, 640, smallLines, 0);
		const before = cache.inspect();
		const bigBlock = {};
		const bigLines = [
			line(fragment({ text: "long".repeat(1_000) })),
			line(fragment({ href: "/old-path" })),
			line(),
			line(fragment({ text: "last" })),
		];
		const first = cache.get(bigBlock, 640, bigLines, 0);
		expect(first.length).toBe(4);
		expect(host(first[0] ?? "").textContent).toBe("long".repeat(1_000));
		expect(first[1]).toBeNull();
		expect(first[2]).toBe("");
		expect(host(first[3] ?? "").textContent).toBe("last");
		expect(cache.inspect()).toEqual(before);
		expect(cache.get(bigBlock, 640, bigLines, 0)).not.toBe(first);
		expect(cache.get(smallBlock, 640, smallLines, 0)).toBe(small);
	});

	it("bounds null/empty-only histories and supports disabling cache", () => {
		const cache = new StaticInlineMarkupCache({ maxBytes: 128 });
		const emptyHistory = Array.from({ length: 100 }, () => line());
		const nullHistory = Array.from({ length: 100 }, () => line(fragment({ math: {} })));
		expect(cache.get({}, 640, emptyHistory, 0).length).toBe(100);
		expect(cache.get({}, 640, nullHistory, 0)).toEqual(Array(100).fill(null));
		expect(cache.inspect()).toEqual({ entries: 0, bytes: 0 });
		for (const options of [{ maxBytes: 0 }, { maxEntries: 0 }]) {
			const disabled = new StaticInlineMarkupCache(options);
			expect(disabled.get({}, 640, [line(fragment())], 0)[0]).not.toBeNull();
			expect(disabled.inspect()).toEqual({ entries: 0, bytes: 0 });
		}
	});

	it("never exceeds entry/byte ceilings even with many variants or enlarged options", () => {
		const cache = new StaticInlineMarkupCache({ maxBytes: 100_000_000, maxEntries: 10_000 });
		const owner = {};
		const lines = [line(fragment({ text: "x".repeat(40_000) }))];
		for (let index = 0; index < 200; index++) {
			cache.get(owner, index, lines, index);
			expect(cache.inspect().entries).toBeLessThanOrEqual(128);
			expect(cache.inspect().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
		}
		const small = new StaticInlineMarkupCache();
		for (let index = 0; index < 200; index++) small.get({}, index, [line()], 0);
		expect(small.inspect().entries).toBe(128);
	});

	it("clear drops all mappings/bytes and the exported singleton behaves identically", () => {
		const block = {};
		const lines = [line(fragment())];
		const first = staticInlineMarkupCache.get(block, 640, lines, 0);
		expect(staticInlineMarkupCache.inspect().entries).toBe(1);
		staticInlineMarkupCache.clear();
		expect(staticInlineMarkupCache.inspect()).toEqual({ entries: 0, bytes: 0 });
		expect(staticInlineMarkupCache.get(block, 640, lines, 0)).not.toBe(first);
	});
});
