/**
 * 块内方言（§6.8 / D23）的抽象语法树。不依赖 DOM，也不依赖 ProseMirror：
 * 服务端和浏览器共用同一份解析与序列化实现。
 *
 * 偏移约定（与 ProseMirror 节点内容偏移一致，便于做「源码偏移 ↔ 编辑器位置」映射）：
 * - 文本按 UTF-16 码元计 1；提及（atom）计 1；硬换行计 1；
 * - 表格：每行开 / 闭各计 1，每个单元格开 / 闭各计 1。
 */

export type MarkType = "strong" | "em" | "code" | "strike" | "link";

export interface Mark {
	type: MarkType;
	href?: string;
	title?: string | null;
}

export interface TextNode {
	type: "text";
	text: string;
	marks: Mark[];
}

export interface MentionNode {
	type: "mention";
	ref: string;
	label: string | null;
	marks: Mark[];
}

export interface BreakNode {
	type: "br";
}

export type Inline = TextNode | MentionNode | BreakNode;

export type Align = "left" | "center" | "right" | null;

export type Body =
	| { type: "paragraph"; content: Inline[] }
	| { type: "heading"; level: 1 | 2 | 3; content: Inline[] }
	| { type: "code"; lang: string; text: string }
	| { type: "quote"; content: Inline[] }
	| { type: "table"; align: Align[]; rows: Inline[][][] }
	| { type: "embed"; ref: string; label: string | null };

export type TaskState = " " | "/" | "x" | "-";

/** 大纲里的一个块：正文 + 子块。用于粘贴、复制、agent 写入。 */
export interface OutlineNode {
	body: Body;
	task: TaskState | null;
	children: OutlineNode[];
}

/** pmToSrc[k] = 内容偏移 k 处对应的源码偏移（单调不减）。长度 = size + 1。 */
export interface SourceMap {
	size: number;
	pmToSrc: number[];
}

export interface ParsedBlock {
	body: Body;
	map: SourceMap;
	/** 方言外的写法被拆出来的部分（列表、多段……），作为子块。 */
	extra: OutlineNode[];
	/** 规范化时做了什么（给 agent 的工具返回 / 测试用）。 */
	notes: string[];
}
