/**
 * A block's frame (folding arrow, bullet, checkbox, presence marker) and static body rendering,
 * as native DOM (no React root per block, design §6.7). Shared with the mind map later (§6.10):
 * the arrow and bullet glyphs come from `has-kids` / `collapsed` classes on the container.
 */
import { titleOf } from "@shared/outline";
import type { LiveTaskChar } from "@shared/outline-live-protocol";
import { DOMSerializer } from "prosemirror-model";
import { parseToPM } from "./convert";
import { schema } from "./schema";

export const TASK_GLYPH: Record<LiveTaskChar, string> = { " ": "☐", "/": "◐", x: "☑", "-": "⊘" };
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
	/** The hint on a block whose tasks the facts view leaves out. */
	hidden: (count: number) => `+${count}`,
};

export interface Gutter {
	el: HTMLElement;
	arrow: HTMLElement;
	bullet: HTMLElement;
	check: HTMLElement;
	peers: HTMLElement;
}

export interface ChromeState {
	hasKids: boolean;
	collapsed: boolean;
	task: LiveTaskChar | null;
}

export function createGutter(): Gutter {
	const el = document.createElement("div");
	el.className = "ob-gutter";
	el.contentEditable = "false";
	const arrow = document.createElement("span");
	arrow.className = "ob-arrow";
	arrow.title = chromeText.fold;
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
	return { el, arrow, bullet, check, peers };
}

/** Write the frame's state onto the container and the frame. */
export function applyChrome(container: HTMLElement, g: Gutter, s: ChromeState): void {
	container.classList.toggle("has-kids", s.hasKids);
	container.classList.toggle("collapsed", s.hasKids && s.collapsed);
	container.dataset.task = s.task ?? "";
	g.check.textContent = s.task ? TASK_GLYPH[s.task] : "";
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
