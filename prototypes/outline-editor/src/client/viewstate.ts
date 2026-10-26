/**
 * 视图状态（§6.10）：一个编辑面的两种视图（大纲、导图）共用。
 * - 聚焦的块、折叠集合、选中（光标所在的块，或块选择模式里的一组）、视口锚点、导图的布局方向。
 * - 折叠和方向是每个人自己的：不进块模型、不产生提交，别人看不到。产品里按（用户，页）存在服务端
 *   （`outline_view_state`）；原型里只在内存里，一个编辑面一份。
 */
import type { Dir } from "../mindmap/layout";

export type ViewKind = "outline" | "map";

export interface Caret {
	blockId: string;
	/** 块体内的偏移（编辑器坐标）；-1 表示整块选中 */
	anchor: number;
	head: number;
}

/** 视口锚点：离视口中心最近的块，和它的块体左上角相对视口的屏幕位置。 */
export interface Anchor {
	blockId: string;
	x: number;
	y: number;
}

export class ViewState {
	view: ViewKind = "outline";
	focus: string | null = null;
	collapsed = new Set<string>();
	caret: Caret | null = null;
	/** 块选择模式里选中的一组块（空 = 不在块选择模式） */
	blocks: string[] = [];
	anchor: Anchor | null = null;
	layout: Dir = "right";
	private listeners = new Set<(what: string) => void>();

	on(fn: (what: string) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emit(what: string) {
		for (const f of this.listeners) f(what);
	}

	/** 测试用：可序列化的快照 */
	snapshot() {
		return {
			view: this.view,
			focus: this.focus,
			collapsed: [...this.collapsed].sort(),
			caret: this.caret ? { ...this.caret } : null,
			blocks: [...this.blocks],
			anchor: this.anchor ? { ...this.anchor } : null,
			layout: this.layout,
		};
	}
}
