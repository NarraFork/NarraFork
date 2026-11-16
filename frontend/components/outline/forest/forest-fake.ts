/**
 * An in-memory outline behind {@link ForestIO}, for the forest's unit and component tests: a
 * tree of blocks read the way the server's routes read it (levels with cursors, a folded
 * subtree read with the same default folding, marks, the reader's fold state). Test support
 * only; nothing in the app imports it.
 */
import { foldDefaultOpen } from "@shared/outline-fold";
import { isOutlineReportBlockId } from "@shared/outline-report-line";
import type {
	OutlineLevelsResponse,
	OutlineSubtreeMarks,
	OutlineSubtreeResponse,
	OutlineTreeBlock,
	OutlineTreeLevel,
} from "@shared/outline-subtree-api";
import type { ForestIO } from "./forest-model";

export interface FakeBlock {
	id: string;
	parentId: string | null;
	content: string;
	task?: "todo" | "doing" | "done" | "cancelled";
	question?: "open" | "answered";
	alias?: string;
	locked?: boolean;
}

export class FakeOutline implements ForestIO {
	readonly spaceId: string;
	seq = 1;
	readonly blocks = new Map<string, FakeBlock>();
	private readonly kids = new Map<string | null, string[]>();
	expanded = new Set<string>();
	collapsed = new Set<string>();
	/** Every request made, in order. */
	readonly calls: Array<{ kind: string; detail: string }> = [];
	failNext: number | null = null;
	/** Fold writes (puts and resets) that fail before one succeeds again. */
	foldFails = 0;
	/** The last write applied, by writer. */
	readonly lastWrite = new Map<string, number>();
	/** What fold writes were sent with `keepalive`. */
	readonly keepalive: string[] = [];

	constructor(spaceId = "space") {
		this.spaceId = spaceId;
	}

	add(block: FakeBlock, at?: number): void {
		this.blocks.set(block.id, block);
		const list = this.kids.get(block.parentId) ?? [];
		if (at === undefined) list.push(block.id);
		else list.splice(at, 0, block.id);
		this.kids.set(block.parentId, list);
		this.seq++;
	}

	/** `count` children `prefix-0…` under a parent. */
	fill(parentId: string | null, prefix: string, count: number): void {
		for (let i = 0; i < count; i++)
			this.add({ id: `${prefix}-${i}`, parentId, content: `${prefix} ${i}` });
	}

	edit(id: string, patch: Partial<FakeBlock>): void {
		Object.assign(this.blocks.get(id) as FakeBlock, patch);
		this.seq++;
	}

	remove(id: string): void {
		const block = this.blocks.get(id);
		if (!block) return;
		this.kids.set(
			block.parentId,
			(this.kids.get(block.parentId) ?? []).filter((kid) => kid !== id),
		);
		this.blocks.delete(id);
		this.seq++;
	}

	childrenOf(parentId: string | null): string[] {
		return this.kids.get(parentId) ?? [];
	}

	private isProcess(block: FakeBlock): boolean {
		return !!block.task || !!block.question;
	}

	private wire(id: string): OutlineTreeBlock {
		const block = this.blocks.get(id) as FakeBlock;
		return {
			id,
			sid: id.slice(0, 6),
			parentId: block.parentId,
			orderKey: String(this.childrenOf(block.parentId).indexOf(id)).padStart(6, "0"),
			content: block.content,
			task: block.task ? { status: block.task, assignee: null, due: null, depends: [] } : null,
			question: block.question ? { state: block.question, proceed: false } : null,
			alias: block.alias ?? null,
			tags: [],
			versionSeq: 1,
			hasChildren: this.childrenOf(id).length > 0,
			lock: null,
			pending: [],
		};
	}

	/** One level from a cursor (the index to start at, as text), at most `limit` rows read. */
	private level(
		parentId: string | null,
		cursor: string | null,
		limit: number,
		view: "facts" | "all",
	): { level: OutlineTreeLevel; blocks: OutlineTreeBlock[] } {
		const all = this.childrenOf(parentId);
		const from = cursor ? Number(cursor) : 0;
		const read = all.slice(from, from + limit);
		const shown = read.filter(
			(id) => view === "all" || !this.isProcess(this.blocks.get(id) as FakeBlock),
		);
		const more = from + read.length < all.length;
		return {
			level: {
				parentId,
				childIds: shown,
				more,
				nextCursor: more ? String(from + read.length) : null,
				processHidden: read.length - shown.length,
			},
			blocks: shown.map((id) => this.wire(id)),
		};
	}

	private fail(): void {
		if (this.failNext === null) return;
		const status = this.failNext;
		this.failNext = null;
		throw Object.assign(new Error(`HTTP ${status}`), { status });
	}

	private under(id: string): string[] {
		const out: string[] = [];
		const stack = [...this.childrenOf(id)];
		while (stack.length > 0) {
			const at = stack.pop() as string;
			out.push(at);
			stack.push(...this.childrenOf(at));
		}
		return out;
	}

	private attention(id: string): boolean {
		return this.under(id).some((kid) => {
			const block = this.blocks.get(kid) as FakeBlock;
			return block.question === "open" || block.locked === true;
		});
	}

	async subtree(
		_spaceId: string,
		rootId: string | null,
		params: {
			view?: "facts" | "all";
			blocks?: number;
			fold?: "default";
			top?: "closed";
			asOf?: number;
		},
	): Promise<OutlineSubtreeResponse> {
		this.calls.push({
			kind: "subtree",
			detail: `${rootId ?? "space"}${params.fold ? ":fold" : ""}`,
		});
		this.fail();
		if (rootId !== null && !this.blocks.has(rootId))
			throw Object.assign(new Error("404"), { status: 404 });
		const view = params.view ?? "facts";
		let room = params.blocks ?? 400;
		const blocks: OutlineTreeBlock[] = [];
		const levels: OutlineTreeLevel[] = [];
		const closed: string[] = [];
		if (rootId !== null) {
			blocks.push(this.wire(rootId));
			room--;
		}
		const path: OutlineSubtreeResponse["path"] = [];
		let inTask = false;
		for (let at = rootId ? (this.blocks.get(rootId)?.parentId ?? null) : null; at; ) {
			const block = this.blocks.get(at) as FakeBlock;
			path.unshift({ id: at, sid: at.slice(0, 6), title: block.content });
			if (this.isProcess(block) || isOutlineReportBlockId(at)) inTask = true;
			at = block.parentId;
		}
		const rootBlock = rootId ? this.blocks.get(rootId) : undefined;
		let frontier: Array<{ id: string | null; depth: number; over: boolean }> = [
			{
				id: rootId,
				depth: 0,
				over:
					inTask ||
					(!!rootBlock && (this.isProcess(rootBlock) || isOutlineReportBlockId(rootBlock.id))),
			},
		];
		let truncated = false;
		while (frontier.length > 0) {
			const next: typeof frontier = [];
			for (const parent of frontier) {
				if (room <= 0) {
					levels.push({
						parentId: parent.id,
						childIds: [],
						more: true,
						nextCursor: null,
						processHidden: 0,
					});
					truncated = true;
					continue;
				}
				const got = this.level(parent.id, null, room, view);
				room -= got.blocks.length;
				levels.push(got.level);
				blocks.push(...got.blocks);
				if (got.level.more) truncated = true;
				for (const id of got.level.childIds) {
					if (this.childrenOf(id).length === 0) continue;
					const block = this.blocks.get(id) as FakeBlock;
					let open = true;
					if (params.fold) {
						if (this.expanded.has(id)) open = true;
						else if (params.top === "closed" && rootId === null && parent.depth === 0) open = false;
						else if (this.collapsed.has(id)) open = false;
						else if (this.attention(id)) open = true;
						else
							open = foldDefaultOpen({
								root: false,
								task: block.task ?? null,
								report: isOutlineReportBlockId(id),
								detail: parent.over,
							});
					}
					if (open)
						next.push({
							id,
							depth: parent.depth + 1,
							over: parent.over || this.isProcess(block) || isOutlineReportBlockId(id),
						});
					else closed.push(id);
				}
			}
			frontier = next;
		}
		if (params.fold) {
			for (const id of closed.slice(0, 50)) {
				if (room <= 0) break;
				const got = this.level(id, null, 1, view);
				room -= got.blocks.length;
				levels.push(got.level);
				blocks.push(...got.blocks);
			}
		}
		return {
			spaceId: this.spaceId,
			rootId,
			seq: this.seq,
			current: params.asOf === undefined,
			view,
			path,
			pathTruncated: false,
			rootInTask: inTask,
			blocks,
			levels,
			truncated,
			...(params.fold ? { closed } : {}),
		};
	}

	async children(
		_spaceId: string,
		params: {
			parents: ReadonlyArray<string | null>;
			cursor?: string | null;
			limit?: number;
			perParent?: number;
			view?: "facts" | "all";
		},
	): Promise<OutlineLevelsResponse> {
		this.calls.push({
			kind: "children",
			detail: `${params.parents.map((p) => p ?? "top").join(",")}${params.cursor ? `@${params.cursor}` : ""}`,
		});
		this.fail();
		let room = params.limit ?? 200;
		const blocks: OutlineTreeBlock[] = [];
		const levels: OutlineTreeLevel[] = [];
		for (const parentId of params.parents) {
			const take = Math.min(room, params.perParent ?? room);
			if (take <= 0) {
				levels.push({
					parentId,
					childIds: [],
					more: true,
					nextCursor: params.cursor ?? null,
					processHidden: 0,
				});
				continue;
			}
			const got = this.level(parentId, params.cursor ?? null, take, params.view ?? "all");
			room -= got.blocks.length;
			levels.push(got.level);
			blocks.push(...got.blocks);
		}
		return {
			spaceId: this.spaceId,
			seq: this.seq,
			current: true,
			view: params.view ?? "all",
			blocks,
			levels,
		};
	}

	async marks(_spaceId: string, keys: readonly string[], since?: number) {
		this.calls.push({
			kind: "marks",
			detail: `${keys.length}${since !== undefined ? `since${since}` : ""}`,
		});
		const marks: OutlineSubtreeMarks[] = keys
			.filter((key) => this.blocks.has(key))
			.map((key) => {
				const under = this.under(key).map((id) => this.blocks.get(id) as FakeBlock);
				return {
					key,
					questions: under.filter((b) => b.question === "open").length,
					tasks: {
						todo: under.filter((b) => b.task === "todo").length,
						doing: under.filter((b) => b.task === "doing").length,
					},
					locked: under.filter((b) => b.locked).length,
					pending: 0,
				};
			});
		return { spaceId: this.spaceId, seq: this.seq, marks, atLeast: false };
	}

	async getFold() {
		this.calls.push({ kind: "getFold", detail: "" });
		return { spaceId: this.spaceId, expanded: [...this.expanded], collapsed: [...this.collapsed] };
	}

	async putFold(
		_spaceId: string,
		body: {
			changes?: Array<{ blockId: string; open: boolean | null }>;
			reset?: Array<string | null>;
			writer?: string;
			n?: number;
		},
		keepalive?: boolean,
	) {
		const changes = body.changes ?? [];
		for (const under of body.reset ?? [])
			this.calls.push({ kind: "resetFold", detail: under ?? "all" });
		if (changes.length > 0)
			this.calls.push({
				kind: "putFold",
				detail: changes.map((c) => `${c.blockId}=${c.open}`).join(","),
			});
		if (keepalive) this.keepalive.push(JSON.stringify(body));
		if (
			changes.length > 500 ||
			(body.reset?.length ?? 0) > 50 ||
			JSON.stringify(body).length > 64 * 1024
		)
			throw Object.assign(new Error("too large"), { status: 400 });
		if (this.foldFails > 0) {
			this.foldFails--;
			throw Object.assign(new Error("HTTP 503"), { status: 503 });
		}
		const state = () => ({
			spaceId: this.spaceId,
			expanded: [...this.expanded],
			collapsed: [...this.collapsed],
		});
		// Older than a write already applied for the writer: ignored (the server's rule).
		if (body.writer !== undefined && body.n !== undefined) {
			const last = this.lastWrite.get(body.writer);
			if (last !== undefined && body.n <= last) return { ...state(), ignored: true as const };
			this.lastWrite.set(body.writer, body.n);
		}
		for (const under of body.reset ?? []) {
			const gone = (id: string) =>
				under === null || under === this.spaceId || id === under || this.isUnderBlock(id, under);
			for (const id of [...this.expanded]) if (gone(id)) this.expanded.delete(id);
			for (const id of [...this.collapsed]) if (gone(id)) this.collapsed.delete(id);
		}
		for (const change of changes) {
			this.expanded.delete(change.blockId);
			this.collapsed.delete(change.blockId);
			if (change.open === true) this.expanded.add(change.blockId);
			if (change.open === false) this.collapsed.add(change.blockId);
		}
		return state();
	}

	private isUnderBlock(id: string, ancestor: string): boolean {
		for (
			let at = this.blocks.get(id)?.parentId ?? null;
			at;
			at = this.blocks.get(at)?.parentId ?? null
		)
			if (at === ancestor) return true;
		return false;
	}

	async openTasks(_spaceId: string, under: string, cursor?: string | null) {
		this.calls.push({ kind: "openTasks", detail: `${under}${cursor ? `@${cursor}` : ""}` });
		const all = (under === this.spaceId ? [...this.blocks.keys()] : this.under(under))
			.map((id) => ({ id, block: this.blocks.get(id) as FakeBlock }))
			.filter(({ block }) => block.task === "todo" || block.task === "doing")
			.sort((a, b) =>
				a.block.task === b.block.task ? (a.id < b.id ? -1 : 1) : a.block.task === "doing" ? -1 : 1,
			);
		const from = cursor ? Number(cursor) : 0;
		const page = all.slice(from, from + 20);
		return {
			under,
			items: page.map(({ id, block }) => ({
				id,
				title: block.content,
				status: block.task as "todo" | "doing",
				assignee: null,
			})),
			nextCursor: from + 20 < all.length ? String(from + 20) : null,
			atLeast: false,
		};
	}
}
