/**
 * The outline's icons, in one place: the read-only tree and its popovers render them as React
 * components, the live editor's and the mind map's frames (native DOM, `editor/chrome.ts`) as
 * inline SVG built from the same Tabler icon nodes. One map from a task's state to its icon,
 * so no two views can drift (owner: 「大纲里的任务需要停止使用字符来代替图标」, then
 * 「最好用一些合适的图标，附带背景」).
 *
 * A task's state is a BADGE: its icon on a small rounded background tinted with the state's
 * colour (`STATUS_ICONS`; the colours are `outline-icons.css`, the colour names
 * `shared/outline-status.ts`). The badge is the SVG element itself (`.nf-status`, with
 * `data-status`), so it is the same element whether React or the native frames draw it, and it
 * fills exactly the box a bare icon did: nothing measured changes. Where a task has a checkbox
 * to click, the badge is that checkbox's drawing.
 *
 * Sizes and colours are CSS (`outline-icons.css`): the SVG strokes `currentColor`, and every
 * size follows the reader's body text within the room the frames leave.
 */
import type { OutlineTaskStatus } from "@shared/outline-api";
import { LIVE_STATUS_OF_TASK, type LiveTaskChar } from "@shared/outline-live-protocol";
import type { OutlineStatusKey } from "@shared/outline-status";
import {
	IconArrowForwardUp,
	IconCheck,
	IconChecks,
	IconChevronDown,
	IconChevronRight,
	IconCircle,
	IconCircleHalf2,
	IconFocusCentered,
	IconHelpCircle,
	IconHourglass,
	IconLock,
	type IconNode,
	IconX,
	type TablerIcon,
} from "@tabler/icons-react";
// The same icons' SVG nodes (what each React component draws), for the native DOM frames.
import { __iconNode as arrowForwardUpNode } from "@tabler/icons-react/dist/esm/icons/IconArrowForwardUp.mjs";
import { __iconNode as checkNode } from "@tabler/icons-react/dist/esm/icons/IconCheck.mjs";
import { __iconNode as checksNode } from "@tabler/icons-react/dist/esm/icons/IconChecks.mjs";
import { __iconNode as chevronDownNode } from "@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs";
import { __iconNode as chevronRightNode } from "@tabler/icons-react/dist/esm/icons/IconChevronRight.mjs";
import { __iconNode as circleNode } from "@tabler/icons-react/dist/esm/icons/IconCircle.mjs";
import { __iconNode as circleHalf2Node } from "@tabler/icons-react/dist/esm/icons/IconCircleHalf2.mjs";
import { __iconNode as focusCenteredNode } from "@tabler/icons-react/dist/esm/icons/IconFocusCentered.mjs";
import { __iconNode as helpCircleNode } from "@tabler/icons-react/dist/esm/icons/IconHelpCircle.mjs";
import { __iconNode as hourglassNode } from "@tabler/icons-react/dist/esm/icons/IconHourglass.mjs";
import { __iconNode as lockNode } from "@tabler/icons-react/dist/esm/icons/IconLock.mjs";
import { __iconNode as xNode } from "@tabler/icons-react/dist/esm/icons/IconX.mjs";
import "./outline-icons.css";

export interface OutlineIcon {
	/** Tabler's name: the React component's class is `tabler-icon-<name>`, and so is the SVG's. */
	name: string;
	Icon: TablerIcon;
	node: IconNode;
	/**
	 * Set on a task state's icon: it is drawn as a badge (`.nf-status[data-status]`), the icon on
	 * the state's tinted background.
	 */
	status?: OutlineStatusKey;
}

/** The class of a state badge; with `data-status`, all `outline-icons.css` needs. */
export const STATUS_CLASS = "nf-status";
/** A badge's stroke: heavier than Tabler's 2, the icon being drawn smaller inside its background. */
export const STATUS_STROKE = 2.5;

/**
 * A task's state, as an icon on a tinted background. The shapes differ (colour is never the only
 * signal): an empty circle, a half-filled one, a check, a cross, an hourglass, an arrow handing
 * on, a lock, a double check.
 */
export const STATUS_ICONS: Record<OutlineStatusKey, OutlineIcon & { status: OutlineStatusKey }> = {
	todo: { name: "circle", Icon: IconCircle, node: circleNode, status: "todo" },
	doing: { name: "circle-half-2", Icon: IconCircleHalf2, node: circleHalf2Node, status: "doing" },
	done: { name: "check", Icon: IconCheck, node: checkNode, status: "done" },
	cancelled: { name: "x", Icon: IconX, node: xNode, status: "cancelled" },
	waiting: { name: "hourglass", Icon: IconHourglass, node: hourglassNode, status: "waiting" },
	delegated: {
		name: "arrow-forward-up",
		Icon: IconArrowForwardUp,
		node: arrowForwardUpNode,
		status: "delegated",
	},
	locked: { name: "lock", Icon: IconLock, node: lockNode, status: "locked" },
	newly_done: { name: "checks", Icon: IconChecks, node: checksNode, status: "newly_done" },
};

/**
 * The lock's icon without a background of its own: inside a chip that says who locked a task
 * (the chip is the background).
 */
export const LOCK_CHIP_ICON: OutlineIcon = { name: "lock", Icon: IconLock, node: lockNode };

/** A task's checkbox, by status: the state's badge. */
export const TASK_ICONS: Record<OutlineTaskStatus, OutlineIcon> = {
	todo: STATUS_ICONS.todo,
	doing: STATUS_ICONS.doing,
	done: STATUS_ICONS.done,
	cancelled: STATUS_ICONS.cancelled,
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
	// A state badge and a bare icon of the same name are different drawings.
	const key = icon.status ? `${icon.name}@${icon.status}` : icon.name;
	let template = built.get(key);
	if (!template) {
		template = doc.createElementNS(SVG_NS, "svg");
		for (const [name, value] of Object.entries(OUTLINE_ATTRS)) template.setAttribute(name, value);
		template.setAttribute("class", `tabler-icon tabler-icon-${icon.name}`);
		if (icon.status) {
			template.setAttribute("stroke-width", String(STATUS_STROKE));
			template.setAttribute("class", `tabler-icon tabler-icon-${icon.name} ${STATUS_CLASS}`);
			template.setAttribute("data-status", icon.status);
		}
		template.setAttribute("aria-hidden", "true");
		template.setAttribute("focusable", "false");
		for (const [tag, attrs] of icon.node) {
			const el = doc.createElementNS(SVG_NS, String(tag));
			for (const [name, value] of Object.entries(attrs)) {
				if (name !== "key") el.setAttribute(name, String(value));
			}
			template.append(el);
		}
		built.set(key, template);
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
