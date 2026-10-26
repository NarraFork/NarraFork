/**
 * 快速切换器（§6.10）：Mod-K 打开，按标题、别名（`alias:: …` / `别名:: …`）、正文找块，最近访问的排在前面；
 * 选中后在当前视图里聚焦过去。原型里是内存索引（产品里标题 / 别名走索引、正文走 FTS）。
 */
import type { Client } from "./client";
import { type EditSurface, recent } from "./surface";

export interface Entry {
	id: string;
	pageId: string;
	title: string;
	alias: string;
	body: string;
	label: string;
}

export interface Hit {
	e: Entry;
	via: "标题" | "别名" | "正文" | "最近";
	score: number;
}

const ALIAS = /^(?:alias|别名)::\s*(.+)$/m;

function plainTitle(s: string): string {
	return s
		.split("\n")[0]
		.replace(/^#{1,3}\s+/, "")
		.replace(/[*_`~[\]>!\\|]/g, "")
		.trim();
}

export class QuickSwitcher {
	el: HTMLElement;
	input: HTMLInputElement;
	list: HTMLElement;
	entries: Entry[] = [];
	byId = new Map<string, Entry>();
	results: Hit[] = [];
	idx = 0;
	surface: EditSurface | null = null;
	private dirty = new WeakSet<Client>();
	private builtFor: Client | null = null;
	stats = { buildMs: 0, queryMs: 0, chooseMs: 0, entries: 0 };

	constructor() {
		this.el = document.createElement("div");
		this.el.className = "qs";
		this.el.hidden = true;
		const box = document.createElement("div");
		box.className = "qs-box";
		this.input = document.createElement("input");
		this.input.className = "qs-input";
		this.input.placeholder = "找块：标题、别名、正文…（Enter 聚焦，Esc 关闭）";
		this.list = document.createElement("div");
		this.list.className = "qs-list";
		box.append(this.input, this.list);
		this.el.append(box);
		document.body.append(this.el);
		this.input.addEventListener("input", () => this.query(this.input.value));
		this.input.addEventListener("keydown", (e) => {
			if (e.isComposing || e.keyCode === 229) return;
			if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const n = this.results.length;
				if (n) this.idx = (this.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
				this.renderList();
			} else if (e.key === "Enter") {
				e.preventDefault();
				this.choose(this.idx);
			}
		});
		this.list.addEventListener("mousedown", (e) => {
			const row = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
			if (!row) return;
			e.preventDefault();
			this.choose(Number(row.dataset.i));
		});
		this.el.addEventListener("mousedown", (e) => {
			if (e.target === this.el) this.close();
		});
	}

	/** 存储变了：下次打开时重建索引 */
	watch(client: Client) {
		client.listeners.add((kind) => {
			if (kind === "sync") this.dirty.add(client);
		});
	}

	buildIndex(client: Client) {
		const t0 = performance.now();
		const out: Entry[] = [];
		const byId = new Map<string, Entry>();
		const v = client.visible;
		for (const b of v.blocks.values()) {
			if (b.deleted) continue;
			const isPage = b.parentId === null;
			const text = isPage ? b.content : client.textOf(b.id);
			const m = ALIAS.exec(text);
			const title = plainTitle(text);
			const e: Entry = {
				id: b.id,
				pageId: isPage ? b.id : b.pageId,
				title: title.toLowerCase(),
				alias: m ? m[1].trim().toLowerCase() : "",
				body: text.toLowerCase(),
				label: title || "（空）",
			};
			out.push(e);
			byId.set(b.id, e);
		}
		this.entries = out;
		this.byId = byId;
		this.builtFor = client;
		this.dirty.delete(client);
		this.stats.buildMs = performance.now() - t0;
		this.stats.entries = out.length;
	}

	open(surface: EditSurface) {
		this.surface = surface;
		if (this.builtFor !== surface.client || this.dirty.has(surface.client))
			this.buildIndex(surface.client);
		this.el.hidden = false;
		this.input.value = "";
		this.query("");
		this.input.focus();
	}

	close() {
		if (this.el.hidden) return;
		this.el.hidden = true;
		const s = this.surface;
		if (!s) return;
		if (s.state.view === "map") s.map.stage.focus({ preventScroll: true });
		else s.outline.pm.focus();
	}

	get isOpen() {
		return !this.el.hidden;
	}

	search(q0: string): Hit[] {
		const q = q0.trim().toLowerCase();
		const rank = new Map<string, number>();
		recent.forEach((id, i) => {
			rank.set(id, i);
		});
		if (!q) {
			const hits: Hit[] = [];
			for (const id of recent) {
				const e = this.byId.get(id);
				if (e) hits.push({ e, via: "最近", score: 0 });
				if (hits.length >= 20) break;
			}
			return hits;
		}
		const hits: Hit[] = [];
		for (const e of this.entries) {
			let score = 0;
			let via: Hit["via"] = "正文";
			if (e.title.startsWith(q)) {
				score = 100;
				via = "标题";
			} else if (e.title.includes(q)) {
				score = 80;
				via = "标题";
			} else if (e.alias?.includes(q)) {
				score = 70;
				via = "别名";
			} else if (e.body.includes(q)) score = 40;
			else continue;
			const r = rank.get(e.id);
			if (r !== undefined) score += 1000 - r;
			hits.push({ e, via, score });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, 30);
	}

	query(q: string) {
		const t0 = performance.now();
		this.results = this.search(q);
		this.idx = 0;
		this.renderList();
		this.stats.queryMs = performance.now() - t0;
	}

	private renderList() {
		const s = this.surface;
		const rows = this.results.map((h, i) => {
			const row = document.createElement("div");
			row.className = `qs-row${i === this.idx ? " on" : ""}`;
			row.dataset.i = String(i);
			row.dataset.id = h.e.id;
			const t = document.createElement("span");
			t.className = "qs-title";
			t.textContent = h.e.label;
			const via = document.createElement("span");
			via.className = "qs-via";
			via.textContent = h.via;
			const page = document.createElement("span");
			page.className = "qs-page";
			page.textContent = s?.client.visible.get(h.e.pageId)?.content ?? h.e.pageId;
			row.append(t, via, page);
			return row;
		});
		this.list.replaceChildren(...rows);
	}

	async choose(i: number) {
		const h = this.results[i];
		const s = this.surface;
		if (!h || !s) return;
		const t0 = performance.now();
		this.el.hidden = true;
		const page = s.client.pages.get(h.e.pageId);
		if (!page?.joined) await s.client.joinPage(h.e.pageId);
		s.focusBlock(h.e.id === s.pageId ? null : h.e.id);
		if (s.state.view === "map") {
			s.map.flush();
			s.map.select(h.e.id === s.pageId ? s.map.rootId : h.e.id, { reveal: false });
		} else {
			const id = h.e.id === s.pageId ? s.client.visible.children(s.pageId)[0] : h.e.id;
			if (id) s.placeCaret(id);
			s.outline.pm.focus();
		}
		this.stats.chooseMs = performance.now() - t0;
	}
}
