/**
 * The outline's icons (`outline-icons.ts`): the live editor's and the mind map's frames draw the
 * read-only tree's Tabler icons as inline SVG (never text glyphs), with the frame's ARIA intact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LiveTaskChar } from "@shared/outline-live-protocol";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { applyChrome, chromeText, createGutter } from "./editor/chrome";
import {
	FOLD_ICONS,
	iconSvg,
	type OutlineIcon,
	QUESTION_ICON,
	TASK_ICONS,
	taskIconOf,
} from "./outline-icons";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const saved = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeAll(() => {
	Object.defineProperty(globalThis, "document", {
		value: document,
		configurable: true,
		writable: true,
	});
});

afterAll(() => {
	if (saved) Object.defineProperty(globalThis, "document", saved);
	else Reflect.deleteProperty(globalThis, "document");
});

const ICONS: OutlineIcon[] = [
	...Object.values(TASK_ICONS),
	QUESTION_ICON,
	...Object.values(FOLD_ICONS),
];

/** What an SVG draws: each shape's tag and attributes, in order. */
function drawing(svg: Element | null | undefined) {
	return [...(svg?.children ?? [])].map((el) => [
		el.tagName.toLowerCase(),
		Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
	]);
}

describe("outline icons", () => {
	test("the frames draw exactly what the tree's React icons draw", () => {
		for (const icon of ICONS) {
			const react = parseHTML(
				`<!doctype html><html><body>${renderToStaticMarkup(<icon.Icon size={16} />)}</body></html>`,
			).document.querySelector("svg");
			const dom = iconSvg(icon);
			expect(drawing(dom).length).toBeGreaterThan(0);
			expect(drawing(dom)).toEqual(drawing(react));
			for (const name of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"])
				expect(`${icon.name} ${name}=${dom.getAttribute(name)}`).toBe(
					`${icon.name} ${name}=${react?.getAttribute(name)}`,
				);
			// The same Tabler icon by name: the component's class is `tabler-icon-<name>`.
			expect(dom.getAttribute("class")).toBe(react?.getAttribute("class")?.trim() ?? "");
			expect(dom.getAttribute("aria-hidden")).toBe("true");
		}
	});

	test("one map from a task's status to its icon, for the live page's task characters too", () => {
		const chars: Record<LiveTaskChar, OutlineIcon> = {
			" ": TASK_ICONS.todo,
			"/": TASK_ICONS.doing,
			x: TASK_ICONS.done,
			"-": TASK_ICONS.cancelled,
		};
		for (const [char, icon] of Object.entries(chars))
			expect(taskIconOf(char as LiveTaskChar)).toBe(icon);
	});

	test("a frame shows tasks, questions and folding as icons, with its ARIA unchanged", () => {
		const block = document.createElement("div");
		const g = createGutter();
		const cases: Array<[LiveTaskChar, string, string]> = [
			[" ", "false", "square"],
			["/", "mixed", "square-half"],
			["x", "true", "square-check"],
			["-", "false", "square-x"],
		];
		for (const [task, checked, name] of cases) {
			applyChrome(block, g, { hasKids: false, collapsed: false, task });
			expect(g.check.getAttribute("role")).toBe("checkbox");
			expect(g.check.getAttribute("aria-checked")).toBe(checked);
			expect(g.check.title).toBe(chromeText.task);
			expect(g.check.dataset.icon).toBe(name);
			expect(g.check.querySelector("svg")?.getAttribute("class")).toBe(
				`tabler-icon tabler-icon-${name}`,
			);
			// No text glyph: nothing for IME, copy or the caret to land on.
			expect(g.check.textContent).toBe("");
			expect(g.check.style.display).toBe("");
		}
		// An unchanged state keeps its SVG (frames re-render on every edit of their block).
		const svg = g.check.firstElementChild;
		applyChrome(block, g, { hasKids: false, collapsed: false, task: "-" });
		expect(g.check.firstElementChild).toBe(svg);

		applyChrome(block, g, { hasKids: false, collapsed: false, task: null, question: true });
		expect(g.check.getAttribute("role")).toBe("img");
		expect(g.check.getAttribute("aria-checked")).toBeNull();
		expect(g.check.getAttribute("aria-label")).toBe(chromeText.question);
		expect(g.check.title).toBe(chromeText.question);
		expect(g.check.dataset.testid).toBe("outline-question-mark");
		expect(g.check.dataset.icon).toBe("help-circle");
		expect(g.check.textContent).toBe("");

		applyChrome(block, g, { hasKids: false, collapsed: false, task: null });
		expect(g.check.childElementCount).toBe(0);
		expect(g.check.style.display).toBe("none");
		expect(g.check.dataset.testid).toBeUndefined();

		// Folding: a chevron on a block with children, pointing right when folded; none otherwise.
		expect(g.arrow.childElementCount).toBe(0);
		applyChrome(block, g, { hasKids: true, collapsed: false, task: null });
		expect(g.arrow.dataset.icon).toBe("chevron-down");
		applyChrome(block, g, { hasKids: true, collapsed: true, task: null });
		expect(g.arrow.dataset.icon).toBe("chevron-right");
		expect(block.classList.contains("collapsed")).toBe(true);
		applyChrome(block, g, { hasKids: false, collapsed: true, task: null });
		expect(g.arrow.childElementCount).toBe(0);
		expect(block.classList.contains("collapsed")).toBe(false);
		// The bullet is drawn by CSS: no glyph in the DOM.
		expect(g.bullet.textContent).toBe("");
		expect(g.el.textContent).toBe("");
	});
});
