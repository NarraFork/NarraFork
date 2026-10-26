/**
 * 块外框与块体的静态渲染：大纲（BlockView）和导图节点共用（§6.10「节点和大纲共用块外框和块体渲染」）。
 * - 外框：折叠箭头、项目符号（点了聚焦）、复选框；原生 DOM，没有 React。
 *   箭头 / 项目符号的字形由容器上的 has-kids / collapsed 类决定（CSS），两种视图同一套样式。
 * - 块体：同一份 schema 的 toDOM（DOMSerializer），提及显示目标块的文字（和大纲的 MentionView 一致）。
 */
import { DOMSerializer } from "prosemirror-model";
import type { Client } from "./client";
import { parseToPM } from "./convert";
import { schema } from "./schema";

export const TASK_GLYPH: Record<string, string> = { " ": "☐", "/": "◐", x: "☑", "-": "⊘" };
export const TASK_NEXT: Record<string, string> = { " ": "/", "/": "x", x: " ", "-": " " };

export interface Gutter {
	el: HTMLElement;
	arrow: HTMLElement;
	bullet: HTMLElement;
	check: HTMLElement;
}

export interface ChromeState {
	hasKids: boolean;
	collapsed: boolean;
	task: string | null;
}

export function createGutter(): Gutter {
	const el = document.createElement("div");
	el.className = "ob-gutter";
	el.contentEditable = "false";
	const arrow = document.createElement("span");
	arrow.className = "ob-arrow";
	arrow.title = "折叠 / 展开";
	const bullet = document.createElement("span");
	bullet.className = "ob-bullet";
	bullet.title = "聚焦";
	const check = document.createElement("span");
	check.className = "ob-check";
	el.append(arrow, bullet, check);
	return { el, arrow, bullet, check };
}

/** 把外框状态写到容器（.ob-block 或 .mm-node）和外框元素上。 */
export function applyChrome(container: HTMLElement, g: Gutter, s: ChromeState) {
	container.classList.toggle("has-kids", s.hasKids);
	container.classList.toggle("collapsed", s.hasKids && s.collapsed);
	container.dataset.task = s.task ?? "";
	g.check.textContent = s.task ? TASK_GLYPH[s.task] : "";
	g.check.style.display = s.task ? "" : "none";
}

export function refTarget(ref: string): { pageId: string; blockId: string } {
	const parts = ref.split("/");
	return { pageId: parts.length > 1 ? parts[0] : "", blockId: parts[parts.length - 1] };
}

/** 提及的显示文字：有标签用标签，否则用目标块第一行（去掉标记符号），目标不在就显示地址。 */
export function mentionLabel(client: Client, ref: string, label: string | null): string {
	if (label) return label;
	const { blockId } = refTarget(ref);
	const text = client.visible.alive(blockId) ? client.textOf(blockId).split("\n")[0] : null;
	return text ? text.replace(/[#*_`~[\]>!\\]/g, "").slice(0, 40) : ref;
}

/** 块的纯文字第一行（面包屑、快速切换器的标题）：去掉标记，提及显示成目标的文字。 */
export function plainLine(client: Client, content: string): string {
	const node = parseToPM(content).node;
	const text = node.textBetween(0, node.content.size, " ", (leaf) =>
		leaf.type.name === "mention"
			? mentionLabel(client, leaf.attrs.ref, leaf.attrs.label)
			: leaf.type.name === "hard_break"
				? "\n"
				: "",
	);
	if (node.type.name === "embed") return `嵌入 ${node.attrs.ref}`;
	return text.split("\n")[0].trim();
}

let serializer: DOMSerializer | null = null;

/** 块体的静态 DOM（导图节点、只读处）：和编辑器同一份 schema 的 toDOM。 */
export function renderBody(content: string, client: Client): HTMLElement {
	serializer ??= DOMSerializer.fromSchema(schema);
	const node = parseToPM(content).node;
	const dom = serializer.serializeNode(node) as HTMLElement;
	const mentions: Array<{ ref: string; label: string | null }> = [];
	node.descendants((n) => {
		if (n.type.name === "mention") mentions.push({ ref: n.attrs.ref, label: n.attrs.label });
		return true;
	});
	if (mentions.length) {
		const els = dom.querySelectorAll<HTMLElement>(".ob-mention");
		els.forEach((el, i) => {
			const m = mentions[i];
			if (m) el.textContent = mentionLabel(client, m.ref, m.label);
		});
	}
	if (node.type.name === "embed") {
		const ref = node.attrs.ref as string;
		const { blockId } = refTarget(ref);
		dom.classList.add("mm-embed");
		const head = document.createElement("div");
		head.className = "ob-embed-head";
		head.textContent = `嵌入 ${ref}`;
		const body = document.createElement("div");
		body.className = "ob-embed-body";
		body.textContent = client.visible.alive(blockId)
			? client.textOf(blockId).split("\n")[0]
			: "（目标不存在或无权查看）";
		dom.append(head, body);
	}
	return dom;
}
