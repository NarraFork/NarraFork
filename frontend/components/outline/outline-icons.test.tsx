/**
 * The outline's icons (`outline-icons.ts`): the live editor's and the mind map's frames draw the
 * read-only tree's Tabler icons as inline SVG (never text glyphs), with the frame's ARIA intact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { LIVE_STATUS_OF_TASK, type LiveTaskChar } from "@shared/outline-live-protocol";
import { OUTLINE_STATUS_KEYS, OUTLINE_STATUS_TONE } from "@shared/outline-status";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { applyChrome, chromeText, createGutter } from "./editor/chrome";
import { OutlineStatusChip, OutlineStatusIcon } from "./OutlineStatusIcon";
import {
	FOCUS_ICON,
	FOLD_ICONS,
	iconSvg,
	LOCK_CHIP_ICON,
	type OutlineIcon,
	QUESTION_ICON,
	rowMarker,
	STATUS_CLASS,
	STATUS_ICONS,
	setIcon,
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
	...Object.values(STATUS_ICONS),
	QUESTION_ICON,
	FOCUS_ICON,
	LOCK_CHIP_ICON,
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
			// A task state is drawn by `OutlineStatusIcon` (its badge); anything else by the icon.
			const element = icon.status ? (
				<OutlineStatusIcon status={icon.status} />
			) : (
				<icon.Icon size={16} />
			);
			const react = parseHTML(
				`<!doctype html><html><body>${renderToStaticMarkup(element)}</body></html>`,
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
			// A state's badge is the same element either way: its class and which state it is.
			expect(dom.getAttribute("data-status")).toBe(react?.getAttribute("data-status") ?? null);
			expect(dom.classList.contains(STATUS_CLASS)).toBe(icon.status !== undefined);
		}
	});

	test("every task state has a badge of its own: a distinct icon, its state, a known colour", () => {
		expect(Object.keys(STATUS_ICONS).sort()).toEqual([...OUTLINE_STATUS_KEYS].sort());
		// Colour is never the only signal: no two states share an icon shape.
		const names = Object.values(STATUS_ICONS).map((icon) => icon.name);
		expect(new Set(names).size).toBe(names.length);
		for (const key of OUTLINE_STATUS_KEYS) {
			expect(STATUS_ICONS[key].status).toBe(key);
			expect(OUTLINE_STATUS_TONE[key]).toBeString();
			const svg = iconSvg(STATUS_ICONS[key]);
			expect(svg.getAttribute("data-status")).toBe(key);
			// An icon, never a character.
			expect(svg.textContent).toBe("");
		}
		// A task's checkbox is its state's badge.
		for (const status of ["todo", "doing", "done", "cancelled"] as const)
			expect(TASK_ICONS[status]).toBe(STATUS_ICONS[status]);
		// A state named for assistive technology is an image with that name; unnamed, decoration.
		const named = renderToStaticMarkup(<OutlineStatusIcon status="waiting" label="Waiting" />);
		expect(named).toContain('role="img"');
		expect(named).toContain('aria-label="Waiting"');
		expect(named).not.toContain("aria-hidden");
		expect(renderToStaticMarkup(<OutlineStatusIcon status="waiting" />)).toContain(
			'aria-hidden="true"',
		);
		// In words: a chip in the state's colour with the bare icon before the words.
		const chip = parseHTML(
			`<!doctype html><html><body>${renderToStaticMarkup(
				<MantineProvider>
					<OutlineStatusChip status="locked">Locked · alice</OutlineStatusChip>
				</MantineProvider>,
			)}</body></html>`,
		).document.querySelector("[data-status-chip]");
		expect(chip?.getAttribute("data-status-chip")).toBe("locked");
		expect(chip?.textContent).toBe("Locked · alice");
		expect(chip?.querySelector("svg")?.getAttribute("class")).toContain("tabler-icon-lock");
		expect(chip?.querySelector("svg")?.classList.contains(STATUS_CLASS)).toBe(false);
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
			[" ", "false", "circle"],
			["/", "mixed", "circle-half-2"],
			["x", "true", "check"],
			["-", "false", "x"],
		];
		for (const [task, checked, name] of cases) {
			applyChrome(block, g, { hasKids: false, collapsed: false, task });
			expect(g.check.getAttribute("role")).toBe("checkbox");
			expect(g.check.getAttribute("aria-checked")).toBe(checked);
			expect(g.check.title).toBe(chromeText.task);
			expect(g.check.dataset.icon).toBe(name);
			expect(g.check.querySelector("svg")?.getAttribute("class")).toBe(
				`tabler-icon tabler-icon-${name} nf-status`,
			);
			// The badge says which state it is (its colours are CSS, by this attribute).
			expect(g.check.querySelector("svg")?.getAttribute("data-status")).toBe(
				LIVE_STATUS_OF_TASK[task],
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

	test("one marker per row: a task or a question drops the bullet and gets a focus handle", () => {
		expect(rowMarker({ task: false, question: false })).toBe("bullet");
		expect(rowMarker({ task: true, question: false })).toBe("task");
		expect(rowMarker({ task: false, question: true })).toBe("question");
		// A task that is also marked as a question is a task (the frame draws its checkbox).
		expect(rowMarker({ task: true, question: true })).toBe("task");

		const block = document.createElement("div");
		const g = createGutter();
		const shown = (el: HTMLElement) => el.style.display !== "none";
		const markers = () =>
			[shown(g.bullet) && "bullet", shown(g.check) && "check"].filter(Boolean).join("+");

		applyChrome(block, g, { hasKids: true, collapsed: false, task: null });
		expect(markers()).toBe("bullet");
		expect(block.dataset.marker).toBe("bullet");
		expect(shown(g.zoom)).toBe(false);
		// The arrow is not a marker: always there for a block with children.
		expect(g.arrow.dataset.icon).toBe("chevron-down");

		for (const task of [" ", "/", "x", "-"] as LiveTaskChar[]) {
			applyChrome(block, g, { hasKids: true, collapsed: false, task });
			expect(markers()).toBe("check");
			expect(block.dataset.marker).toBe("task");
			expect(shown(g.zoom)).toBe(true);
			expect(g.arrow.dataset.icon).toBe("chevron-down");
		}

		applyChrome(block, g, { hasKids: false, collapsed: false, task: null, question: true });
		expect(markers()).toBe("check");
		expect(block.dataset.marker).toBe("question");
		expect(shown(g.zoom)).toBe(true);

		// Back to a plain block: the bullet returns, the handle goes.
		applyChrome(block, g, { hasKids: false, collapsed: false, task: null });
		expect(markers()).toBe("bullet");
		expect(shown(g.zoom)).toBe(false);

		// The focus handle is an icon with the bullet's label, outside the gutter (its owner
		// places it at the row's end).
		expect(g.zoom.dataset.icon).toBe("focus-centered");
		expect(g.zoom.getAttribute("aria-label")).toBe(chromeText.focus);
		expect(g.zoom.textContent).toBe("");
		expect(g.el.contains(g.zoom)).toBe(false);
	});

	test("an icon is built in the document it goes into, not the first one it was built for", () => {
		const other = parseHTML("<!doctype html><html><body></body></html>")
			.document as unknown as Document;
		const here = iconSvg(TASK_ICONS.todo);
		expect(here.ownerDocument).toBe(document);
		const there = iconSvg(TASK_ICONS.todo, other);
		expect(there.ownerDocument).toBe(other);
		expect(drawing(there)).toEqual(drawing(here));
		// An element of another document shows that document's icon.
		const el = other.createElement("span");
		setIcon(el, TASK_ICONS.todo);
		expect(el.firstElementChild?.ownerDocument).toBe(other);
	});
});
