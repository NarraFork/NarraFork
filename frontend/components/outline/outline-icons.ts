/**
 * The outline's icons, in one place: the read-only tree and its popovers render them as React
 * components, the live editor's and the mind map's frames (native DOM, `editor/chrome.ts`) as
 * inline SVG built from the same Tabler icon nodes. One map from a task's status to its icon,
 * so the tree and the frames cannot drift (owner: 「大纲里的任务需要停止使用字符来代替图标」).
 *
 * Sizes and colours are CSS (`outline-icons.css`): the SVG strokes `currentColor`, and every
 * size follows the reader's body text within the room the frames leave.
 */
import type { OutlineTaskStatus } from "@shared/outline-api";
import { LIVE_STATUS_OF_TASK, type LiveTaskChar } from "@shared/outline-live-protocol";
import {
	IconChevronDown,
	IconChevronRight,
	IconFocusCentered,
	IconHelpCircle,
	type IconNode,
	IconSquare,
	IconSquareCheck,
	IconSquareHalf,
	IconSquareX,
	type TablerIcon,
} from "@tabler/icons-react";
// The same icons' SVG nodes (what each React component draws), for the native DOM frames.
import { __iconNode as chevronDownNode } from "@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs";
import { __iconNode as chevronRightNode } from "@tabler/icons-react/dist/esm/icons/IconChevronRight.mjs";
import { __iconNode as focusCenteredNode } from "@tabler/icons-react/dist/esm/icons/IconFocusCentered.mjs";
import { __iconNode as helpCircleNode } from "@tabler/icons-react/dist/esm/icons/IconHelpCircle.mjs";
import { __iconNode as squareNode } from "@tabler/icons-react/dist/esm/icons/IconSquare.mjs";
import { __iconNode as squareCheckNode } from "@tabler/icons-react/dist/esm/icons/IconSquareCheck.mjs";
import { __iconNode as squareHalfNode } from "@tabler/icons-react/dist/esm/icons/IconSquareHalf.mjs";
import { __iconNode as squareXNode } from "@tabler/icons-react/dist/esm/icons/IconSquareX.mjs";
import "./outline-icons.css";

export interface OutlineIcon {
	/** Tabler's name: the React component's class is `tabler-icon-<name>`, and so is the SVG's. */
	name: string;
	Icon: TablerIcon;
	node: IconNode;
}

/** A task's checkbox, by status. */
export const TASK_ICONS: Record<OutlineTaskStatus, OutlineIcon> = {
	todo: { name: "square", Icon: IconSquare, node: squareNode },
	doing: { name: "square-half", Icon: IconSquareHalf, node: squareHalfNode },
	done: { name: "square-check", Icon: IconSquareCheck, node: squareCheckNode },
	cancelled: { name: "square-x", Icon: IconSquareX, node: squareXNode },
};

/** The mark of a question put to a person (`Ask`), where a task has its checkbox. */
export const QUESTION_ICON: OutlineIcon = {
	name: "help-circle",
	Icon: IconHelpCircle,
	node: helpCircleNode,
};

/** The folding arrow of a block with children. */
export const FOLD_ICONS: Record<"expanded" | "collapsed", OutlineIcon> = {
	expanded: { name: "chevron-down", Icon: IconChevronDown, node: chevronDownNode },
	collapsed: { name: "chevron-right", Icon: IconChevronRight, node: chevronRightNode },
};

/**
 * The focus handle at the end of a row that has no bullet (a task, a question): the bullet is how
 * a block is focused, and those rows show their checkbox or mark in its place.
 */
export const FOCUS_ICON: OutlineIcon = {
	name: "focus-centered",
	Icon: IconFocusCentered,
	node: focusCenteredNode,
};

/** What a row shows where its text starts: exactly one of these, after the folding arrow. */
export type OutlineRowMarker = "task" | "question" | "bullet";

/**
 * One marker per row (the read-only tree, the live editor's frame, the mind map's nodes): a
 * task's checkbox, else a question's mark, else the bullet. The folding arrow is not a marker:
 * it is always drawn for a block with children.
 */
export function rowMarker(row: { task: boolean; question: boolean }): OutlineRowMarker {
	return row.task ? "task" : row.question ? "question" : "bullet";
}

/** The checkbox of a task as the live page writes it (`[ ]`, `[/]`, `[x]`, `[-]`). */
export function taskIconOf(task: LiveTaskChar): OutlineIcon {
	return TASK_ICONS[LIVE_STATUS_OF_TASK[task]];
}

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * Tabler's outline icon attributes (what its React components set). The size is CSS's
 * (`outline-icons.css`); the attributes only stand in should a stylesheet be missing.
 */
const OUTLINE_ATTRS: Record<string, string> = {
	width: "16",
	height: "16",
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	"stroke-width": "2",
	"stroke-linecap": "round",
	"stroke-linejoin": "round",
};
/** Built icons, by document (a clone belongs to its template's) and then by name. */
const templates = new WeakMap<Document, Map<string, SVGSVGElement>>();

/**
 * An icon as inline SVG for native DOM: decorative (the element around it carries the role and
 * label), sized by CSS, stroked in `currentColor`. Built once per icon and document (pass the
 * document of the element it goes into), then cloned.
 */
export function iconSvg(icon: OutlineIcon, doc: Document = document): SVGSVGElement {
	let built = templates.get(doc);
	if (!built) {
		built = new Map();
		templates.set(doc, built);
	}
	let template = built.get(icon.name);
	if (!template) {
		template = doc.createElementNS(SVG_NS, "svg");
		for (const [name, value] of Object.entries(OUTLINE_ATTRS)) template.setAttribute(name, value);
		template.setAttribute("class", `tabler-icon tabler-icon-${icon.name}`);
		template.setAttribute("aria-hidden", "true");
		template.setAttribute("focusable", "false");
		for (const [tag, attrs] of icon.node) {
			const el = doc.createElementNS(SVG_NS, String(tag));
			for (const [name, value] of Object.entries(attrs)) {
				if (name !== "key") el.setAttribute(name, String(value));
			}
			template.append(el);
		}
		built.set(icon.name, template);
	}
	return template.cloneNode(true) as SVGSVGElement;
}

/**
 * Show `icon` in `el` (or nothing), replacing what it showed only when the icon changes: frames
 * re-render on every edit of their block. `el.dataset.icon` names what it shows.
 */
export function setIcon(el: HTMLElement, icon: OutlineIcon | null): void {
	const name = icon?.name ?? "";
	if ((el.dataset.icon ?? "") === name && el.childElementCount === (icon ? 1 : 0)) return;
	if (icon) {
		el.dataset.icon = name;
		el.replaceChildren(iconSvg(icon, el.ownerDocument));
	} else {
		delete el.dataset.icon;
		el.replaceChildren();
	}
}
