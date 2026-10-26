/**
 * 原型页面：一个内存「服务端」+ 两个客户端（Alice、Bob）+ 一个模拟 agent。
 * 默认模式：两人并排编辑同一页；下方是 Alice 的拼接视图（三页的块混排）和 Bob 看第二页。
 * 性能模式（?mode=perf&n=2000）：一个客户端、一页 n 个块。
 */

import { type EditorState, TextSelection, type Transaction } from "prosemirror-state";
import * as Y from "yjs";
import { Client } from "../client/client";
import { indent, joinBackward, moveBlock, outdent, splitBlock } from "../client/commands";
import { fragmentToOutline, parseStats } from "../client/convert";
import { findBlockPos, OutlineView } from "../client/view";
import { parseOutline } from "../dialect/parse";
import { serializeBody, serializeOutline } from "../dialect/serialize";
import type { OutlineNode } from "../dialect/types";
import { keyBetween } from "../model/orderkey";
import { Net } from "../net";
import { type AgentEdit, Server } from "../server/server";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "default";

const net = new Net();
net.latency = Number(params.get("latency") ?? 0);
const server = new Server(net);

function seedPage(pageId: string, title: string, md: string): string[] {
	server.store.put({
		id: pageId,
		pageId,
		parentId: null,
		orderKey: "V",
		content: title,
		task: null,
		deleted: false,
		version: 1,
	});
	const ids: string[] = [];
	const add = (parentId: string, nodes: OutlineNode[], prefix: string) => {
		let key: string | null = null;
		nodes.forEach((n, i) => {
			const id = `${prefix}${i + 1}`;
			key = keyBetween(key, null);
			server.store.put({
				id,
				pageId,
				parentId,
				orderKey: key,
				content: serializeBody(n.body),
				task: n.task,
				deleted: false,
				version: 1,
			});
			ids.push(id);
			add(id, n.children, `${id}_`);
		});
	};
	add(pageId, parseOutline(md).nodes, `${pageId}b`);
	return ids;
}

function seedDefault() {
	seedPage(
		"P2",
		"任务",
		[
			"- [ ] 写编辑器原型 @alice",
			"  - 先做块模型和投影",
			"- [/] 方言往返测试",
			"- 被嵌入的块：在 P1 里也能就地编辑",
			"  - 它的子块",
		].join("\n"),
	);
	seedPage(
		"P3",
		"会议记录",
		["- 10 月 26 日：确认 D23", "  - 表格用 GFM", "- 下次：看原型数据"].join("\n"),
	);
	seedPage(
		"P1",
		"设计文档",
		[
			"- # 大纲编辑器",
			"- 块模型是真相，编辑器文档只是投影。参见 [[P2/P2b1|任务一]]",
			"  - 每个块节点带块 id",
			"  - **粗体**、*斜体*、`代码`、~~删除~~ 和 [链接](https://example.com)",
			"- 第三块：拼接视图里也会出现",
			"- ```ts",
			"  const outline = 'block+';",
			"  ```",
			"- > 引用：远端修改按块重新解析",
			"- | 键位 | 动作 |",
			"  | --- | --- |",
			"  | Enter | 拆块 |",
			"  | Tab | 缩进 |",
			"- ![[P2/P2b3]]",
			"- ![[P1/P1b3]]",
			"- 最后一块",
		].join("\n"),
	);
}

function seedPerf(n: number) {
	const lines: string[] = [];
	const words = "块 模型 是 真相 编辑器 文档 只是 投影 outline block children body".split(" ");
	for (let i = 0; i < n; i++) {
		const depth = i % 10 === 0 ? 0 : i % 3 === 0 ? 2 : 1;
		const w = Array.from({ length: 8 + (i % 7) }, (_, k) => words[(i + k) % words.length]).join(
			" ",
		);
		let text = `${i}. ${w}`;
		if (i % 13 === 0) text = `**${i}** ${w} \`code\` [[P1/P1b1]]`;
		if (i % 50 === 0) text = `## 小节 ${i}`;
		lines.push(`${"  ".repeat(depth)}- ${text.replace(/^(\d+)\./, "$1\\.")}`);
	}
	seedPage("P1", "性能页", lines.join("\n"));
}

const app = document.getElementById("app") as HTMLElement;

function panel(title: string, cls = ""): HTMLElement {
	const p = document.createElement("section");
	p.className = `panel ${cls}`;
	const h = document.createElement("h2");
	h.textContent = title;
	const body = document.createElement("div");
	body.className = "editor-host";
	p.append(h, body);
	app.append(p);
	return body;
}

const clients: Record<string, Client> = {};
const views: Record<string, OutlineView> = {};

async function setup() {
	if (mode === "perf") {
		const n = Number(params.get("n") ?? 2000);
		seedPerf(n);
		const A = new Client("A", "Alice", "#d6336c", net);
		server.connect("A", "Alice");
		clients.A = A;
		await A.joinPage("P1");
		const t0 = performance.now();
		views.A = new OutlineView(
			A,
			{ kind: "page", pageId: "P1" },
			panel(`性能页 · ${n} 块`, "wide"),
			{ label: "A" },
		);
		const t1 = performance.now();
		(window as unknown as Record<string, unknown>).initialRenderMs = t1 - t0;
	} else {
		seedDefault();
		const A = new Client("A", "Alice", "#d6336c", net);
		const B = new Client("B", "Bob", "#1c7ed6", net);
		server.connect("A", "Alice");
		server.connect("B", "Bob");
		clients.A = A;
		clients.B = B;
		await Promise.all([
			A.joinPage("P1"),
			B.joinPage("P1"),
			A.joinPage("P2"),
			A.joinPage("P3"),
			B.joinPage("P2"),
		]);
		views.A = new OutlineView(A, { kind: "page", pageId: "P1" }, panel("Alice · 设计文档 (P1)"), {
			label: "A",
		});
		views.B = new OutlineView(B, { kind: "page", pageId: "P1" }, panel("Bob · 设计文档 (P1)"), {
			label: "B",
		});
		views.AS = new OutlineView(
			A,
			{ kind: "stitch", roots: ["P1b3", "P2b1", "P3b1"] },
			panel("Alice · 拼接视图（P1 / P2 / P3 的块混排）"),
			{ label: "AS" },
		);
		views.B2 = new OutlineView(B, { kind: "page", pageId: "P2" }, panel("Bob · 任务 (P2)"), {
			label: "B2",
		});
	}
	renderDebug();
	for (const c of Object.values(clients)) c.onChange = scheduleDebug;
	document.body.dataset.ready = "1";
}

// ---------- 调试面板 ----------
const debug = document.getElementById("debug") as HTMLElement;
let debugTimer = 0;
function scheduleDebug() {
	if (debugTimer) return;
	debugTimer = window.setTimeout(() => {
		debugTimer = 0;
		renderDebug();
	}, 200);
}
function renderDebug() {
	if (mode === "perf") return;
	debug.textContent = [
		`服务端 seq=${server.seq}  提交=${server.commits.length}`,
		"── 服务端 P1 ──",
		server.outlineOf("P1"),
		"── 服务端 P2 ──",
		server.outlineOf("P2"),
		"── 日志 ──",
		...server.log.slice(-5),
		...Object.values(clients).flatMap((c) => c.log.slice(-3).map((l) => `${c.user}: ${l}`)),
	].join("\n");
}

// ---------- 工具栏 ----------
document.getElementById("latency")?.addEventListener("change", (e) => {
	net.latency = Number((e.target as HTMLInputElement).value);
});
for (const id of ["A", "B"]) {
	document.getElementById(`hold${id}`)?.addEventListener("change", (e) => {
		net.hold(id, (e.target as HTMLInputElement).checked);
	});
}
document.getElementById("agentRead")?.addEventListener("click", () => {
	const r = server.agentRead("demo", "P1");
	(document.getElementById("agentOut") as HTMLElement).textContent = r.outline;
});
document.getElementById("agentWrite")?.addEventListener("click", () => {
	const r = server.agentRead("demo", "P1");
	const target = r.blocks.find((b) => b.id === "P1b5") ?? r.blocks[0];
	const res = server.agentWrite("demo", "P1", [
		{ t: "text", id: target.id, content: `${target.content}（agent 补充）` },
	]);
	(document.getElementById("agentOut") as HTMLElement).textContent = JSON.stringify(res, null, 2);
	scheduleDebug();
});

// ---------- 测试接口 ----------
const proto = {
	server,
	net,
	clients,
	views,
	mode,
	parseStats,
	agentRead: (agent: string, pageId: string) => server.agentRead(agent, pageId),
	agentWrite: (agent: string, pageId: string, edits: AgentEdit[]) =>
		server.agentWrite(agent, pageId, edits),
	idle: () => net.idle(),
	outline: (clientId: string, pageId: string) => clients[clientId].outlineOf(pageId),
	serverOutline: (pageId: string) => server.outlineOf(pageId),
	text: (clientId: string, blockId: string) => clients[clientId].textOf(blockId),
	serverText: (blockId: string) => server.textOf(blockId),
	/** 把光标放到某个视图里某块的块体偏移处，并聚焦。 */
	focus: (
		viewKey: string,
		blockId: string,
		offset: number,
		headOffset?: number,
		headBlock?: string,
	) => {
		const v = views[viewKey] ?? findView(viewKey);
		v.pm.focus();
		v.restoreSelection({
			anchor: { blockId, offset },
			head: { blockId: headBlock ?? blockId, offset: headOffset ?? offset },
			view: v,
		});
	},
	/** 编辑器当前显示的内容（把编辑器文档序列化成大纲）。 */
	viewOutline: (viewKey: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		return serializeOutline(fragmentToOutline(v.pm.state.doc.content));
	},
	viewBlockText: (viewKey: string, blockId: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		const pos = findBlockPos(v.pm.state.doc, blockId);
		return pos == null ? null : (v.pm.state.doc.nodeAt(pos)?.child(0).textContent ?? null);
	},
	selection: (viewKey: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		const s = v.captureSel();
		return s ? { anchor: s.anchor, head: s.head } : null;
	},
	/** 光标所在块里、光标前的文字（提及记作 @）。 */
	textBeforeCursor: (viewKey: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		const { $head } = v.pm.state.selection;
		return $head.parent.textBetween(0, $head.parentOffset, null, "@");
	},
	blockIds: (viewKey: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		const ids: string[] = [];
		v.pm.state.doc.descendants((n) => {
			if (n.type.name === "block") ids.push(n.attrs.id);
			return n.type.name === "block" || n.type.name === "children" || n.type.name === "outline";
		});
		return ids;
	},
	/** 通过某个视图程序化地插入文字（不抢焦点，模拟对方在打字）。 */
	insertVia: (viewKey: string, blockId: string, offset: number, text: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		const pos = findBlockPos(v.pm.state.doc, blockId);
		if (pos == null) throw new Error(`no block ${blockId} in ${viewKey}`);
		v.pm.dispatch(v.pm.state.tr.insertText(text, pos + 2 + offset));
	},
	/** 在某个视图里程序化地执行大纲命令（不抢焦点：模拟另一个人的操作）。 */
	cmd: (viewKey: string, name: string, blockId: string, offset = 0) => {
		const v = views[viewKey] ?? findView(viewKey);
		const pos = findBlockPos(v.pm.state.doc, blockId);
		if (pos == null) throw new Error(`no block ${blockId} in ${viewKey}`);
		const doc = v.pm.state.doc;
		const sel = TextSelection.create(doc, pos + 2 + offset);
		v.pm.updateState(v.pm.state.apply(v.pm.state.tr.setSelection(sel).setMeta("remote", true)));
		const cmds: Record<string, (s: EditorState, d: (tr: Transaction) => void) => boolean> = {
			moveUp: moveBlock(v, -1),
			moveDown: moveBlock(v, 1),
			indent: indent(v),
			outdent: outdent(v),
			split: splitBlock(v),
			join: joinBackward(v),
		};
		return cmds[name](v.pm.state, (tr) => v.pm.dispatch(tr));
	},
	/** 删除一个块（连同子块），模拟别人删掉正在编辑的块。 */
	deleteBlock: (viewKey: string, blockId: string) => {
		const v = views[viewKey] ?? findView(viewKey);
		const pos = findBlockPos(v.pm.state.doc, blockId);
		if (pos == null) throw new Error(`no block ${blockId}`);
		const node = v.pm.state.doc.nodeAt(pos);
		v.pm.dispatch(v.pm.state.tr.delete(pos, pos + (node?.nodeSize ?? 0)));
	},
	/** 直接发一个移动操作（模拟拖拽：可以把块拖到任意位置）。 */
	move: (clientId: string, id: string, parentId: string) => {
		const c = clients[clientId];
		const kids = c.visible.children(parentId).filter((x) => x !== id);
		const last = kids.length ? (c.visible.get(kids[kids.length - 1])?.orderKey ?? null) : null;
		c.commit({
			ops: [{ t: "move", id, parentId, orderKey: keyBetween(last, null) }],
			bodies: [],
			kind: "struct",
			blockId: id,
			selBefore: null,
			selAfter: null,
			view: null,
		});
	},
	/** 设计问题：页实时会话开始时就给所有块建 Y.Text（而不是首次编辑时）要多少代价。 */
	measureEagerInit: (pageId: string) => {
		const ids = server.store.subtree(pageId).filter((x) => x !== pageId);
		const t0 = performance.now();
		const doc = new Y.Doc();
		const texts = doc.getMap<Y.Text>("texts");
		doc.transact(() => {
			for (const id of ids) texts.set(id, new Y.Text(server.textOf(id)));
		});
		const ms = performance.now() - t0;
		const bytes = Y.encodeStateAsUpdate(doc).length;
		const contentBytes = ids.reduce(
			(n, id) => n + new TextEncoder().encode(server.textOf(id)).length,
			0,
		);
		(window as unknown as { __eager: Y.Doc }).__eager = doc;
		const live = server.pages.get(pageId);
		return {
			blocks: ids.length,
			initMs: +ms.toFixed(1),
			updateBytes: bytes,
			contentBytes,
			lazyTexts: live ? live.texts.size : 0,
			lazyUpdateBytes: live ? Y.encodeStateAsUpdate(live.doc).length : 0,
		};
	},
	undo: (clientId: string) => clients[clientId].undo(),
	redo: (clientId: string) => clients[clientId].redo(),
	stats: () =>
		Object.fromEntries(
			Object.entries(views).map(([k, v]) => [k, { ...v.stats, client: v.client.stats }]),
		),
	embedViews: (viewKey: string) => {
		const v = views[viewKey];
		return [...v.client.views]
			.filter((x) => x.opts.parent === v)
			.map((x) => (x.surface as { blockId: string }).blockId);
	},
};
function findView(key: string): OutlineView {
	// "A>embed:P2b3" 这样的键：某个视图下嵌入的子视图
	const [parentKey, rest] = key.split(">");
	const parent = views[parentKey];
	const target = rest?.replace("embed:", "");
	for (const v of parent?.client.views ?? []) {
		if (v.opts.parent === parent && (v.surface as { blockId?: string }).blockId === target)
			return v;
	}
	throw new Error(`no view ${key}`);
}
(window as unknown as { proto: typeof proto }).proto = proto;

setup();
