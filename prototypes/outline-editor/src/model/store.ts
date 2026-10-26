/**
 * 块存储：块模型是真相（§6.7）。id、所属页、父块、同级排序键、markdown 正文、任务状态。
 * 页本身是根块（parentId = null，pageId = 自己的 id）。
 */
import type { TaskState } from "../dialect/types";

export interface BlockRec {
	id: string;
	pageId: string;
	parentId: string | null;
	orderKey: string;
	content: string;
	task: TaskState | null;
	deleted: boolean;
	version: number;
}

export type Op =
	| {
			t: "insert";
			id: string;
			pageId: string;
			parentId: string;
			orderKey: string;
			content: string;
			task: TaskState | null;
	  }
	| { t: "move"; id: string; parentId: string; orderKey: string }
	| { t: "delete"; id: string }
	| { t: "task"; id: string; task: TaskState | null }
	/** 还没有 Y.Text 的块的正文修改：服务端以 base 为基线三方合并（§6.3 首次编辑由服务端初始化） */
	| { t: "text"; id: string; base: string; next: string };

export class Store {
	blocks = new Map<string, BlockRec>();
	private kids = new Map<string, Set<string>>();
	private sorted = new Map<string, string[]>();

	static from(recs: Iterable<BlockRec>): Store {
		const s = new Store();
		for (const r of recs) s.put({ ...r });
		return s;
	}

	clone(): Store {
		return Store.from(this.blocks.values());
	}

	get(id: string): BlockRec | undefined {
		return this.blocks.get(id);
	}

	alive(id: string): BlockRec | undefined {
		const b = this.blocks.get(id);
		return b && !b.deleted ? b : undefined;
	}

	private link(b: BlockRec) {
		if (b.parentId === null) return;
		let set = this.kids.get(b.parentId);
		if (!set) {
			set = new Set();
			this.kids.set(b.parentId, set);
		}
		set.add(b.id);
		this.sorted.delete(b.parentId);
	}

	private unlink(b: BlockRec) {
		if (b.parentId === null) return;
		this.kids.get(b.parentId)?.delete(b.id);
		this.sorted.delete(b.parentId);
	}

	put(b: BlockRec) {
		const old = this.blocks.get(b.id);
		if (old) this.unlink(old);
		this.blocks.set(b.id, b);
		this.link(b);
	}

	/** 未删除的子块 id，按排序键（相同时按 id）排序。 */
	children(parentId: string): string[] {
		let s = this.sorted.get(parentId);
		if (s) return s;
		const ids = [...(this.kids.get(parentId) ?? [])].filter((id) => !this.blocks.get(id)?.deleted);
		ids.sort((a, b) => {
			const ka = this.blocks.get(a)?.orderKey ?? "";
			const kb = this.blocks.get(b)?.orderKey ?? "";
			return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
		});
		s = ids;
		this.sorted.set(parentId, s);
		return s;
	}

	isAncestor(ancestor: string, id: string): boolean {
		let cur = this.blocks.get(id)?.parentId ?? null;
		let guard = 0;
		while (cur && guard++ < 10000) {
			if (cur === ancestor) return true;
			cur = this.blocks.get(cur)?.parentId ?? null;
		}
		return false;
	}

	subtree(id: string): string[] {
		const out: string[] = [];
		const walk = (x: string) => {
			out.push(x);
			for (const c of this.children(x)) walk(c);
		};
		walk(id);
		return out;
	}

	/**
	 * 应用一个结构操作，返回逆操作（用于撤销）。text 操作在客户端只改 content。
	 * textOf：取块的当前正文（有 Y.Text 时以 Y.Text 为准），用来生成删除的逆操作。
	 */
	apply(op: Op, textOf?: (id: string) => string): Op | null {
		switch (op.t) {
			case "insert": {
				const old = this.blocks.get(op.id);
				this.put({
					id: op.id,
					pageId: op.pageId,
					parentId: op.parentId,
					orderKey: op.orderKey,
					content: op.content,
					task: op.task,
					deleted: false,
					version: (old?.version ?? 0) + 1,
				});
				return { t: "delete", id: op.id };
			}
			case "move": {
				const b = this.blocks.get(op.id);
				if (!b) return null;
				const inv: Op = { t: "move", id: op.id, parentId: b.parentId ?? "", orderKey: b.orderKey };
				this.put({ ...b, parentId: op.parentId, orderKey: op.orderKey, version: b.version + 1 });
				return inv;
			}
			case "delete": {
				const b = this.blocks.get(op.id);
				if (!b || b.deleted) return null;
				const inv: Op = {
					t: "insert",
					id: b.id,
					pageId: b.pageId,
					parentId: b.parentId ?? "",
					orderKey: b.orderKey,
					content: textOf ? textOf(b.id) : b.content,
					task: b.task,
				};
				this.put({ ...b, deleted: true, version: b.version + 1 });
				return inv;
			}
			case "task": {
				const b = this.blocks.get(op.id);
				if (!b) return null;
				const inv: Op = { t: "task", id: op.id, task: b.task };
				this.put({ ...b, task: op.task, version: b.version + 1 });
				return inv;
			}
			case "text": {
				const b = this.blocks.get(op.id);
				if (!b) return null;
				this.put({ ...b, content: op.next, version: b.version + 1 });
				return { t: "text", id: op.id, base: op.next, next: op.base };
			}
		}
	}
}
