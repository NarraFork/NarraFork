/**
 * A block's frame (folding arrow, one marker, presence marker) and static body rendering, as
 * native DOM (no React root per block, design §6.7), shared with the mind map (§6.10). The arrow
 * and the checkbox are the read-only tree's Tabler icons as inline SVG (`../outline-icons.ts`);
 * the bullet is a dot drawn by CSS from the `has-kids` / `collapsed` classes on the container.
 *
 * One marker per row (`rowMarker`): a task shows its checkbox, a question its mark, anything else
 * the bullet. The arrow is always drawn for a block with children. The bullet is also how a block
 * is focused; a row without one carries a focus handle (`Gutter.zoom`) that its owner places at
 * the row's end and wires to the same action.
 */
import { titleOf } from "@shared/outline";
import type { OutlineTaskStatus } from "@shared/outline-api";
import type { FoldMarkKey } from "@shared/outline-fold";
import type { LiveTaskChar } from "@shared/outline-live-protocol";
import { DOMSerializer } from "prosemirror-model";
import {
	FOCUS_ICON,
	FOLD_ICONS,
	QUESTION_ICON,
	rowMarker,
	setIcon,
	taskIconOf,
} from "../outline-icons";
import { parseToPM } from "./convert";
import { schema } from "./schema";

/** Clicking a checkbox: todo → doing → done → todo; cancelled → todo. */
export const TASK_NEXT: Record<LiveTaskChar, LiveTaskChar> = {
	" ": "/",
	"/": "x",
	x: " ",
	"-": " ",
};

/** Tooltips of the frame (set from the page's i18n once). */
export const chromeText = {
	fold: "Collapse / expand",
	focus: "Focus",
	task: "Change status",
	/** The "in progress" marker on a block whose tasks the facts view leaves out (design §3.1). */
	hidden: (count: number) => `In progress · ${count}`,
	/** Its tooltip. */
	hiddenHint: "Open tasks under this block",
	/** On a block whose hidden tasks are all done or cancelled: how many blocks are left out. */
	hiddenUnder: (count: number) => `+${count}`,
	/** A task in the marker's list waiting for confirmation. */
	waiting: "waiting for confirmation",
	/** On a locked task: who locked it. */
	locked: (name: string) => `Locked · ${name}`,
	/** On a block a pending change touches. */
	pending: "Waiting for confirmation",
	/** The mark of a question put to a person (`Ask`), where a task has its checkbox. */
	question: "A question for a person: answered in the inbox. Deleting it withdraws it.",
	/**
	 * A subagent report's container line as a person reads it (their language and time zone), or
	 * `null` for any other text (`lib/outline-report-line.ts`; set from the page's i18n).
	 */
	reportLine: ((_content: string, _blockId?: string) => null) as (
		content: string,
		blockId?: string,
	) => string | null,
	/** The folding arrow of a row, by what it does now. */
	foldExpand: "Expand",
	foldCollapse: "Collapse",
	/** The arrow's hint: Alt does everything inside. */
	foldAltHint: "Alt+click: everything inside",
	/** The row's quick control: its accessible name (the row's title), and what it does. */
	foldSubtree: (title: string) => `Expand/collapse everything in “${title}”`,
	foldSubtreeExpand: "Expand everything inside",
	foldSubtreeCollapse: "Collapse everything inside",
	/** A preview line's labels: how much more is behind it. */
	foldMore: (count: number) => `${count} more ▸`,
	foldOpen: "Expand ▸",
	foldReportAll: (count: number) => `Show all (${count} blocks) ▸`,
	/** A preview line's accessible name starts with this. */
	foldShowInside: "Show everything inside this item",
	/** A block without a title, in an accessible name. */
	foldUntitled: "Untitled block",
	/** What a closed row hides, said by its count chips. */
	foldHidden: {
		question: (count: number) => `${count} questions waiting for an answer inside`,
		pending: (count: number) => `${count} changes waiting for confirmation inside`,
		locked: (count: number) => `${count} locked tasks inside`,
		fresh: (count: number) => `${count} newly finished tasks inside`,
	} satisfies Record<FoldMarkKey, (count: number) => string>,
	/** A task's status, said by its icon in the "in progress" list. */
	status: {
		todo: "To do",
		doing: "In progress",
		done: "Done",
		cancelled: "Cancelled",
	} satisfies Record<OutlineTaskStatus, string>,
};

/** What a block shows besides its content: its lock, changes to it waiting for confirmation. */
export interface BlockMark {
	/** Who locked the task (a locked plan's root). */
	lockedBy?: string;
	/** Labels of the open changes that touch it. */
	pending?: string[];
	/** It is a question put to a person that nobody answered yet. */
	openQuestion?: boolean;
}

export interface Gutter {
	el: HTMLElement;
	arrow: HTMLElement;
	bullet: HTMLElement;
	check: HTMLElement;
	peers: HTMLElement;
	/**
	 * The focus handle of a row without a bullet. Not inside `el`: the owner appends it where the
	 * row ends (the outline floats it right, the mind map puts it after the body).
	 */
	zoom: HTMLElement;
}

export interface ChromeState {
	hasKids: boolean;
	collapsed: boolean;
	/** The row's title, for the arrow's accessible name (the arrow says what it folds). */
	title?: string;
	task: LiveTaskChar | null;
	/** A question put to a person: marked where a task has its checkbox (it has none). */
	question?: boolean;
}

export function createGutter(): Gutter {
	const el = document.createElement("div");
	el.className = "ob-gutter";
	el.contentEditable = "false";
	const arrow = document.createElement("span");
	arrow.className = "ob-arrow";
	arrow.title = chromeText.fold;
	// A control for assistive technology too; not a tab stop (a page has hundreds, and Tab is
	// the editor's own key): the keyboard folds from the cursor's block (`view.ts`).
	arrow.setAttribute("role", "button");
	arrow.tabIndex = -1;
	const bullet = document.createElement("span");
	bullet.className = "ob-bullet";
	bullet.title = chromeText.focus;
	const check = document.createElement("span");
	check.className = "ob-check";
	check.title = chromeText.task;
	check.setAttribute("role", "checkbox");
	const peers = document.createElement("span");
	peers.className = "ob-peers";
	el.append(arrow, bullet, check, peers);
	const zoom = document.createElement("span");
	zoom.className = "ob-zoom";
	zoom.contentEditable = "false";
	zoom.title = chromeText.focus;
	zoom.setAttribute("role", "button");
	zoom.setAttribute("aria-label", chromeText.focus);
	setIcon(zoom, FOCUS_ICON);
	return { el, arrow, bullet, check, peers, zoom };
}

/** Write the frame's state onto the container and the frame. */
export function applyChrome(container: HTMLElement, g: Gutter, s: ChromeState): void {
	container.classList.toggle("has-kids", s.hasKids);
	container.classList.toggle("collapsed", s.hasKids && s.collapsed);
	setIcon(g.arrow, s.hasKids ? FOLD_ICONS[s.collapsed ? "collapsed" : "expanded"] : null);
	if (s.hasKids) {
		const action = s.collapsed ? chromeText.foldExpand : chromeText.foldCollapse;
		const label = s.title ? `${action} · ${s.title}` : action;
		const hint = `${action} · ${chromeText.foldAltHint}`;
		if (g.arrow.getAttribute("aria-label") !== label) g.arrow.setAttribute("aria-label", label);
		if (g.arrow.title !== hint) g.arrow.title = hint;
		g.arrow.setAttribute("aria-expanded", String(!s.collapsed));
		g.arrow.removeAttribute("aria-hidden");
	} else {
		g.arrow.removeAttribute("aria-expanded");
		g.arrow.removeAttribute("aria-label");
		g.arrow.setAttribute("aria-hidden", "true");
	}
	container.dataset.task = s.task ?? "";
	const question = !s.task && s.question === true;
	container.dataset.question = question ? "1" : "";
	// One marker: the bullet only where there is no checkbox or question mark, and then the
	// focus handle stands in for it.
	const marker = rowMarker({ task: !!s.task, question });
	container.dataset.marker = marker;
	g.bullet.style.display = marker === "bullet" ? "" : "none";
	g.zoom.style.display = marker === "bullet" ? "none" : "";
	// Said in the language of the moment (a frame outlives a change of language).
	if (g.zoom.title !== chromeText.focus) {
		g.zoom.title = chromeText.focus;
		g.zoom.setAttribute("aria-label", chromeText.focus);
	}
	g.check.classList.toggle("is-question", question);
	if (question) {
		setIcon(g.check, QUESTION_ICON);
		g.check.style.display = "";
		g.check.setAttribute("role", "img");
		g.check.removeAttribute("aria-checked");
		g.check.title = chromeText.question;
		g.check.setAttribute("aria-label", chromeText.question);
		g.check.dataset.testid = "outline-question-mark";
		return;
	}
	g.check.setAttribute("role", "checkbox");
	g.check.title = chromeText.task;
	g.check.removeAttribute("aria-label");
	delete g.check.dataset.testid;
	setIcon(g.check, s.task ? taskIconOf(s.task) : null);
	g.check.style.display = s.task ? "" : "none";
	g.check.setAttribute(
		"aria-checked",
		s.task === "x" ? "true" : s.task === "/" ? "mixed" : "false",
	);
}

/** Resolves a mention's target to the text shown for it (a block of this page, or nothing). */
export type MentionResolver = (ref: string) => string | null;

/** What a mention shows: its own label, the target's first line, or the address as written. */
export function mentionLabel(resolve: MentionResolver, ref: string, label: string | null): string {
	if (label) return label;
	const text = resolve(ref);
	return text ? titleOf(text).slice(0, 60) || ref : ref;
}

let serializer: DOMSerializer | null = null;

/** A block body as static DOM, with the same schema `toDOM` the editor uses. */
export function renderBody(content: string, resolve: MentionResolver): HTMLElement {
	serializer ??= DOMSerializer.fromSchema(schema);
	const node = parseToPM(content).node;
	const dom = serializer.serializeNode(node) as HTMLElement;
	const mentions: Array<{ ref: string; label: string | null }> = [];
	node.descendants((n) => {
		if (n.type.name === "mention") mentions.push({ ref: n.attrs.ref, label: n.attrs.label });
		return true;
	});
	if (mentions.length) {
		dom.querySelectorAll<HTMLElement>(".ob-mention").forEach((el, i) => {
			const m = mentions[i];
			if (m) el.textContent = mentionLabel(resolve, m.ref, m.label);
		});
	}
	return dom;
}
